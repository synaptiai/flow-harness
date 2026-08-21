import { createHash } from "node:crypto";

import {
  createGoalWorkspaceRevision,
  type GoalWorkspaceEvidenceLocator,
  type GoalWorkspaceEvidenceReference,
  type GoalWorkspaceRevision,
  type GoalWorkspaceSource,
} from "../domain/goal/workspace.js";
import { parseRunEvent, type RunEvent } from "../domain/run/events.js";

export interface GoalWorkspaceRunReader {
  read(runId: string): Promise<readonly RunEvent[]>;
}

export interface GoalWorkspaceExpectedRevision {
  readonly revision: number;
  readonly digest: string;
}

export type GoalWorkspaceAdmissionErrorCode = "evidence_unavailable";

export class GoalWorkspaceAdmissionError extends Error {
  override readonly name = "GoalWorkspaceAdmissionError";

  constructor(readonly code: GoalWorkspaceAdmissionErrorCode) {
    super("goal workspace evidence is unavailable");
  }
}

export async function resolveGoalWorkspaceEvidence(
  source: GoalWorkspaceSource,
  runReader: GoalWorkspaceRunReader,
  signal?: AbortSignal,
): Promise<readonly GoalWorkspaceEvidenceReference[]> {
  signal?.throwIfAborted();
  const locators = new Map<string, GoalWorkspaceEvidenceLocator>();
  for (const locator of source.verifiedFacts.flatMap((fact) => fact.evidence)) {
    locators.set(locatorKey(locator), locator);
  }
  const byRun = new Map<string, GoalWorkspaceEvidenceLocator[]>();
  for (const locator of locators.values()) {
    const current = byRun.get(locator.runId) ?? [];
    current.push(locator);
    byRun.set(locator.runId, current);
  }

  const references: GoalWorkspaceEvidenceReference[] = [];
  for (const [runId, runLocators] of byRun) {
    signal?.throwIfAborted();
    let events: readonly RunEvent[];
    try {
      events = await runReader.read(runId);
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      throw new GoalWorkspaceAdmissionError("evidence_unavailable");
    }
    for (const locator of runLocators) {
      signal?.throwIfAborted();
      const matches = events.filter(
        (event) =>
          event.runId === locator.runId &&
          (event.type === "node_succeeded" || event.type === "node_failed") &&
          event.nodeId === locator.nodeId &&
          event.attempt === locator.attempt &&
          event.evidence !== null,
      );
      if (matches.length !== 1) {
        throw new GoalWorkspaceAdmissionError("evidence_unavailable");
      }
      const event = matches[0];
      if (event === undefined) {
        throw new GoalWorkspaceAdmissionError("evidence_unavailable");
      }
      references.push({
        runId: locator.runId,
        nodeId: locator.nodeId,
        attempt: locator.attempt,
        sequence: event.sequence,
        eventDigest: calculateGoalWorkspaceRunEventDigest(event),
      });
    }
  }
  signal?.throwIfAborted();
  return Object.freeze(references.sort(compareReference).map((item) => Object.freeze(item)));
}

export async function prepareGoalWorkspaceRevision(input: {
  readonly source: GoalWorkspaceSource;
  readonly expected: GoalWorkspaceExpectedRevision | null;
  readonly at: string;
  readonly runReader: GoalWorkspaceRunReader;
  readonly signal?: AbortSignal;
}): Promise<GoalWorkspaceRevision> {
  input.signal?.throwIfAborted();
  const evidence = await resolveGoalWorkspaceEvidence(input.source, input.runReader, input.signal);
  input.signal?.throwIfAborted();
  return createGoalWorkspaceRevision(input.source, evidence, {
    revision: (input.expected?.revision ?? 0) + 1,
    previousDigest: input.expected?.digest ?? null,
    at: input.at,
  });
}

export function calculateGoalWorkspaceRunEventDigest(event: RunEvent): string {
  return createHash("sha256")
    .update(canonicalize(parseRunEvent(event)))
    .digest("hex");
}

function compareReference(
  left: GoalWorkspaceEvidenceReference,
  right: GoalWorkspaceEvidenceReference,
): number {
  return compareStrings(locatorKey(left), locatorKey(right));
}

function locatorKey(locator: GoalWorkspaceEvidenceLocator): string {
  return `${locator.runId}\0${locator.nodeId}\0${locator.attempt}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new GoalWorkspaceAdmissionError("evidence_unavailable");
}
