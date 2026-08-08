import type { CompiledResultSchema } from "../workflow/types.js";
import { evaluateTypedResult } from "./typed-result.js";

export type OptimizationResultErrorCode =
  | "optimization_baseline_invariant_failed"
  | "optimization_invariant_not_scalar"
  | "optimization_metric_not_numeric"
  | "optimization_pointer_invalid"
  | "optimization_pointer_unresolved"
  | "optimization_state_invalid";

export class OptimizationResultError extends Error {
  override readonly name = "OptimizationResultError";

  constructor(
    readonly code: OptimizationResultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type OptimizationDirection = "minimize" | "maximize";
export type OptimizationScalar = null | boolean | number | string;

export interface OptimizationMetric {
  readonly pointer: string;
  readonly direction: OptimizationDirection;
}

export interface OptimizationInvariant {
  readonly pointer: string;
  readonly equals: OptimizationScalar;
}

export interface OptimizationInvariantObservation {
  readonly pointer: string;
  readonly expected: OptimizationScalar;
  readonly actual: OptimizationScalar;
  readonly passed: boolean;
}

export interface OptimizationBaselineObservation {
  readonly canonicalValue: string;
  readonly valueHash: string;
  readonly metric: number;
  readonly invariants: readonly OptimizationInvariantObservation[];
}

export interface OptimizationCandidateObservation extends OptimizationBaselineObservation {
  readonly decision: "accepted" | "rejected";
  readonly reason: "improved" | "not_improved" | "invariant_failed";
  readonly stagnation: number;
  readonly stop: boolean;
}

interface EvaluationInput {
  readonly source: string;
  readonly schema: CompiledResultSchema;
  readonly metric: OptimizationMetric;
  readonly invariants: readonly OptimizationInvariant[];
}

export function evaluateOptimizationBaseline(
  input: EvaluationInput,
): OptimizationBaselineObservation {
  const observation = observeResult(input);
  const failed = observation.invariants.find((invariant) => !invariant.passed);
  if (failed !== undefined) {
    throw new OptimizationResultError(
      "optimization_baseline_invariant_failed",
      `baseline invariant at JSON Pointer ${JSON.stringify(failed.pointer)} does not equal its declared value`,
    );
  }
  return observation;
}

export function evaluateOptimizationCandidate(
  input: EvaluationInput & {
    readonly bestMetric: number;
    readonly priorStagnation: number;
    readonly maxConsecutiveNonImproving: number;
  },
): OptimizationCandidateObservation {
  requireOptimizationState(input);
  const observation = observeResult(input);
  const invariantFailed = observation.invariants.some((invariant) => !invariant.passed);
  const improved =
    !invariantFailed &&
    (input.metric.direction === "minimize"
      ? observation.metric < input.bestMetric
      : observation.metric > input.bestMetric);
  const stagnation = improved ? 0 : input.priorStagnation + 1;
  const decision = improved ? "accepted" : "rejected";
  const reason = invariantFailed ? "invariant_failed" : improved ? "improved" : "not_improved";

  return Object.freeze({
    ...observation,
    decision,
    reason,
    stagnation,
    stop: stagnation >= input.maxConsecutiveNonImproving,
  });
}

export function resolveOptimizationPointerSchema(
  schema: CompiledResultSchema,
  pointer: string,
): CompiledResultSchema {
  let current = schema;
  for (const token of parseJsonPointer(pointer)) {
    if (current.type === "object") {
      const next = current.properties[token];
      if (next === undefined) {
        unresolved(pointer, token);
      }
      current = next;
      continue;
    }
    if (current.type === "array") {
      requireArrayIndex(token, pointer);
      current = current.items;
      continue;
    }
    unresolved(pointer, token);
  }
  return current;
}

function observeResult(input: EvaluationInput): OptimizationBaselineObservation {
  const metricSchema = resolveOptimizationPointerSchema(input.schema, input.metric.pointer);
  if (metricSchema.type !== "number" && metricSchema.type !== "integer") {
    throw new OptimizationResultError(
      "optimization_metric_not_numeric",
      `metric JSON Pointer ${JSON.stringify(input.metric.pointer)} must resolve to a number or integer schema`,
    );
  }
  for (const invariant of input.invariants) {
    const invariantSchema = resolveOptimizationPointerSchema(input.schema, invariant.pointer);
    if (invariantSchema.type === "array" || invariantSchema.type === "object") {
      throw new OptimizationResultError(
        "optimization_invariant_not_scalar",
        `invariant JSON Pointer ${JSON.stringify(invariant.pointer)} must resolve to a scalar schema`,
      );
    }
  }

  const evaluated = evaluateTypedResult(input.source, input.schema);
  const value = JSON.parse(evaluated.canonicalValue) as unknown;
  const metric = resolveJsonPointer(value, input.metric.pointer);
  if (typeof metric !== "number" || !Number.isFinite(metric)) {
    throw new OptimizationResultError(
      "optimization_metric_not_numeric",
      `metric JSON Pointer ${JSON.stringify(input.metric.pointer)} must resolve to a finite number`,
    );
  }
  const invariants = Object.freeze(
    input.invariants.map((invariant) => {
      const actual = resolveJsonPointer(value, invariant.pointer);
      if (!isOptimizationScalar(actual)) {
        throw new OptimizationResultError(
          "optimization_invariant_not_scalar",
          `invariant JSON Pointer ${JSON.stringify(invariant.pointer)} must resolve to a scalar value`,
        );
      }
      return Object.freeze({
        pointer: invariant.pointer,
        expected: invariant.equals,
        actual,
        passed: actual === invariant.equals,
      });
    }),
  );

  return Object.freeze({ ...evaluated, metric, invariants });
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of parseJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      const index = requireArrayIndex(token, pointer);
      if (index >= current.length) {
        unresolved(pointer, token);
      }
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, token)) {
        unresolved(pointer, token);
      }
      current = (current as Record<string, unknown>)[token];
      continue;
    }
    unresolved(pointer, token);
  }
  return current;
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return Object.freeze([]);
  }
  if (!pointer.startsWith("/")) {
    invalidPointer(pointer, "must be empty or start with '/'");
  }
  return Object.freeze(
    pointer
      .slice(1)
      .split("/")
      .map((token) => {
        if (/~(?:[^01]|$)/.test(token)) {
          invalidPointer(pointer, "contains an invalid '~' escape");
        }
        return token.replaceAll("~1", "/").replaceAll("~0", "~");
      }),
  );
}

function requireArrayIndex(token: string, pointer: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
    invalidPointer(pointer, `array token ${JSON.stringify(token)} is not a canonical index`);
  }
  const index = Number(token);
  if (!Number.isSafeInteger(index)) {
    invalidPointer(pointer, `array token ${JSON.stringify(token)} exceeds the safe index range`);
  }
  return index;
}

function requireOptimizationState(input: {
  readonly bestMetric: number;
  readonly priorStagnation: number;
  readonly maxConsecutiveNonImproving: number;
}): void {
  if (!Number.isFinite(input.bestMetric)) {
    invalidState("best metric must be finite");
  }
  if (!Number.isSafeInteger(input.priorStagnation) || input.priorStagnation < 0) {
    invalidState("prior stagnation must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(input.maxConsecutiveNonImproving) ||
    input.maxConsecutiveNonImproving < 1
  ) {
    invalidState("maximum consecutive non-improving candidates must be a positive safe integer");
  }
  if (input.priorStagnation >= input.maxConsecutiveNonImproving) {
    invalidState("a candidate cannot be evaluated after the stagnation bound has been reached");
  }
}

function isOptimizationScalar(value: unknown): value is OptimizationScalar {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function invalidPointer(pointer: string, detail: string): never {
  throw new OptimizationResultError(
    "optimization_pointer_invalid",
    `invalid JSON Pointer ${JSON.stringify(pointer)}: ${detail}`,
  );
}

function unresolved(pointer: string, token: string): never {
  throw new OptimizationResultError(
    "optimization_pointer_unresolved",
    `JSON Pointer ${JSON.stringify(pointer)} cannot resolve token ${JSON.stringify(token)}`,
  );
}

function invalidState(message: string): never {
  throw new OptimizationResultError("optimization_state_invalid", message);
}
