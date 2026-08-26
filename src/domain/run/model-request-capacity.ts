import {
  MAX_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT,
  MIN_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT,
} from "./context-compaction.js";

export const MODEL_REQUEST_SAFETY_RESERVE_TOKENS = 16_384;

export type ModelRequestCapacityDecision = "admitted" | "reduction_required" | "over_capacity";

export interface ModelRequestCapacityEvaluation {
  readonly contextWindowTokens: number;
  readonly outputAllowanceTokens: number;
  readonly safetyReserveTokens: number;
  readonly usableInputTokens: number;
  readonly pressureThresholdPercent: number;
  readonly measuredInputTokens: number;
  readonly absoluteSafe: boolean;
  readonly underPressure: boolean;
  readonly decision: ModelRequestCapacityDecision;
}

export function evaluateModelRequestCapacity(input: {
  readonly contextWindowTokens: number;
  readonly outputAllowanceTokens: number;
  readonly safetyReserveTokens: number;
  readonly pressureThresholdPercent: number;
  readonly measuredInputTokens: number;
}): ModelRequestCapacityEvaluation {
  const contextWindowTokens = positiveSafeInteger(
    input.contextWindowTokens,
    "context window tokens",
  );
  const outputAllowanceTokens = positiveSafeInteger(
    input.outputAllowanceTokens,
    "output allowance tokens",
  );
  const safetyReserveTokens = nonNegativeSafeInteger(
    input.safetyReserveTokens,
    "safety reserve tokens",
  );
  const measuredInputTokens = nonNegativeSafeInteger(
    input.measuredInputTokens,
    "measured input tokens",
  );
  const pressureThresholdPercent = input.pressureThresholdPercent;
  if (
    !Number.isSafeInteger(pressureThresholdPercent) ||
    pressureThresholdPercent < MIN_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT ||
    pressureThresholdPercent > MAX_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT
  ) {
    throw new RangeError(
      `pressure threshold must be an integer between ${MIN_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT} and ${MAX_ROLLING_CONTEXT_PRESSURE_THRESHOLD_PERCENT}`,
    );
  }
  const usableInputTokens = contextWindowTokens - outputAllowanceTokens - safetyReserveTokens;
  if (!Number.isSafeInteger(usableInputTokens) || usableInputTokens <= 0) {
    throw new RangeError("selected model has no usable input capacity after required reserves");
  }
  const absoluteSafe = measuredInputTokens <= usableInputTokens;
  const underPressure =
    BigInt(measuredInputTokens) * 100n >=
    BigInt(usableInputTokens) * BigInt(pressureThresholdPercent);
  return Object.freeze({
    contextWindowTokens,
    outputAllowanceTokens,
    safetyReserveTokens,
    usableInputTokens,
    pressureThresholdPercent,
    measuredInputTokens,
    absoluteSafe,
    underPressure,
    decision: !absoluteSafe ? "over_capacity" : underPressure ? "reduction_required" : "admitted",
  });
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
