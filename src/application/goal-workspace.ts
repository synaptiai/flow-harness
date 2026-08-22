import {
  createGoalWorkspaceRevision,
  type GoalWorkspaceEvidenceReference,
  type GoalWorkspaceRevision,
  type GoalWorkspaceSource,
} from "../domain/goal/workspace.js";
import type { RunEvent } from "../domain/run/events.js";
import {
  calculateRunEvidenceEventDigest,
  resolveRunEvidenceReferences,
  type RunEvidenceReader,
} from "./resolve-run-evidence-reference.js";

export interface GoalWorkspaceRunReader extends RunEvidenceReader {}

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
  try {
    return await resolveRunEvidenceReferences(
      source.verifiedFacts.flatMap((fact) => fact.evidence),
      runReader,
      { ...(signal === undefined ? {} : { signal }) },
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GoalWorkspaceAdmissionError) throw error;
    throw new GoalWorkspaceAdmissionError("evidence_unavailable");
  }
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
  return calculateRunEvidenceEventDigest(event);
}
