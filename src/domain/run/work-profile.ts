import type { WorkProfile } from "../workflow/types.js";
import type { RunBudgetState } from "./budget.js";

export const WORK_PROFILE_UNBOUNDED = "unbounded" as const;
export const MAX_MODEL_WORK_PROFILE_PROMPT_BYTES = 2_048;

export type ModelWorkProfileRemainingValue = number | typeof WORK_PROFILE_UNBOUNDED;

export interface ModelWorkProfileRemaining {
  readonly nodeStarts: ModelWorkProfileRemainingValue;
  readonly modelTokens: ModelWorkProfileRemainingValue;
  readonly modelCostUsdMicros: ModelWorkProfileRemainingValue;
  readonly executionMs: ModelWorkProfileRemainingValue;
  readonly artifactBytes: ModelWorkProfileRemainingValue;
}

export interface ModelWorkProfileContext {
  readonly profile: WorkProfile;
  readonly remaining: ModelWorkProfileRemaining;
}

export function createModelWorkProfileContext(
  profile: WorkProfile,
  budget: RunBudgetState | null,
): ModelWorkProfileContext {
  const remaining = Object.freeze({
    nodeStarts: budget?.remaining.nodeStarts ?? WORK_PROFILE_UNBOUNDED,
    modelTokens: budget?.remaining.modelTokens ?? WORK_PROFILE_UNBOUNDED,
    modelCostUsdMicros: budget?.remaining.modelCostUsdMicros ?? WORK_PROFILE_UNBOUNDED,
    executionMs: budget?.remaining.executionMs ?? WORK_PROFILE_UNBOUNDED,
    artifactBytes: budget?.remaining.artifactBytes ?? WORK_PROFILE_UNBOUNDED,
  });
  return Object.freeze({ profile, remaining });
}
