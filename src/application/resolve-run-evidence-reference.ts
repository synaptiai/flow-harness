import { createHash } from "node:crypto";

import {
  compareRunEvidenceReferences,
  type RunEvidenceLocator,
  type RunEvidenceReference,
  runEvidenceLocatorKey,
  runEvidenceLocatorSchema,
} from "../domain/evidence/run-evidence-reference.js";
import { parseRunEvent, type RunEvent } from "../domain/run/events.js";

export interface RunEvidenceReader {
  read(runId: string): Promise<readonly RunEvent[]>;
}

export interface ResolveRunEvidenceOptions {
  readonly signal?: AbortSignal;
  readonly acceptEvent?: (event: RunEvent, locator: RunEvidenceLocator) => boolean;
}

export type RunEvidenceAdmissionErrorCode = "evidence_unavailable";

export class RunEvidenceAdmissionError extends Error {
  override readonly name = "RunEvidenceAdmissionError";

  constructor(readonly code: RunEvidenceAdmissionErrorCode) {
    super("run evidence is unavailable");
  }
}

export async function resolveRunEvidenceReferences(
  input: readonly RunEvidenceLocator[],
  runReader: RunEvidenceReader,
  options: ResolveRunEvidenceOptions = {},
): Promise<readonly RunEvidenceReference[]> {
  options.signal?.throwIfAborted();
  const locators = new Map<string, RunEvidenceLocator>();
  try {
    for (const item of input) {
      const locator = runEvidenceLocatorSchema.parse(item);
      locators.set(runEvidenceLocatorKey(locator), locator);
    }
  } catch {
    throw new RunEvidenceAdmissionError("evidence_unavailable");
  }

  const byRun = new Map<string, RunEvidenceLocator[]>();
  for (const locator of locators.values()) {
    const current = byRun.get(locator.runId) ?? [];
    current.push(locator);
    byRun.set(locator.runId, current);
  }

  const references: RunEvidenceReference[] = [];
  for (const [runId, runLocators] of byRun) {
    options.signal?.throwIfAborted();
    let events: readonly RunEvent[];
    try {
      events = (await runReader.read(runId)).map((event) => parseRunEvent(event));
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      throw new RunEvidenceAdmissionError("evidence_unavailable");
    }

    for (const locator of runLocators) {
      options.signal?.throwIfAborted();
      let matches: readonly RunEvent[];
      try {
        matches = events.filter(
          (event) =>
            event.runId === locator.runId &&
            (event.type === "node_succeeded" || event.type === "node_failed") &&
            event.nodeId === locator.nodeId &&
            event.attempt === locator.attempt &&
            event.evidence !== null &&
            (options.acceptEvent?.(event, locator) ?? true),
        );
      } catch {
        throw new RunEvidenceAdmissionError("evidence_unavailable");
      }
      if (matches.length !== 1) {
        throw new RunEvidenceAdmissionError("evidence_unavailable");
      }
      const event = matches[0];
      if (event === undefined) {
        throw new RunEvidenceAdmissionError("evidence_unavailable");
      }
      references.push({
        runId: locator.runId,
        nodeId: locator.nodeId,
        attempt: locator.attempt,
        sequence: event.sequence,
        eventDigest: calculateRunEvidenceEventDigest(event),
      });
    }
  }

  options.signal?.throwIfAborted();
  return Object.freeze(
    references.sort(compareRunEvidenceReferences).map((item) => Object.freeze(item)),
  );
}

export function calculateRunEvidenceEventDigest(event: RunEvent): string {
  return createHash("sha256")
    .update(canonicalize(parseRunEvent(event)))
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new RunEvidenceAdmissionError("evidence_unavailable");
}
