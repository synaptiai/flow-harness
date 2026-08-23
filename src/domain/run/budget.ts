import { z } from "zod";

import type { CompiledRunBudget } from "../workflow/types.js";

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = nonNegativeSafeIntegerSchema.positive();

export const runBudgetLimitsSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema.optional(),
    maxModelTokens: positiveSafeIntegerSchema.optional(),
    maxCostUsdMicros: positiveSafeIntegerSchema.optional(),
    maxExecutionMs: positiveSafeIntegerSchema.optional(),
    maxArtifactBytes: positiveSafeIntegerSchema.optional(),
  })
  .strict()
  .refine((budget) => Object.values(budget).some((value) => value !== undefined), {
    message: "budget must declare at least one limit",
  });

export const agentModelUsageSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema,
    outputTokens: nonNegativeSafeIntegerSchema,
    cacheReadTokens: nonNegativeSafeIntegerSchema,
    cacheWriteTokens: nonNegativeSafeIntegerSchema,
    costUsdMicros: nonNegativeSafeIntegerSchema,
  })
  .strict();

const agentModelTokenBreakdownSchema = z
  .object({
    inputTokens: nonNegativeSafeIntegerSchema,
    outputTokens: nonNegativeSafeIntegerSchema,
    cacheReadTokens: nonNegativeSafeIntegerSchema,
    cacheWriteTokens: nonNegativeSafeIntegerSchema,
  })
  .strict();

const completeModelTokenObservationSchema = z
  .object({
    status: z.literal("complete"),
    totalTokens: nonNegativeSafeIntegerSchema,
    breakdown: agentModelTokenBreakdownSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.breakdown === undefined) {
      return;
    }
    try {
      if (
        checkedAdd(
          checkedAdd(
            observation.breakdown.inputTokens,
            observation.breakdown.outputTokens,
            "modelTokens",
          ),
          checkedAdd(
            observation.breakdown.cacheReadTokens,
            observation.breakdown.cacheWriteTokens,
            "modelTokens",
          ),
          "modelTokens",
        ) !== observation.totalTokens
      ) {
        context.addIssue({ code: "custom", message: "token breakdown must equal total tokens" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "token breakdown exceeds a safe integer" });
    }
  });

const unavailableObservationSchema = z.object({ status: z.literal("unavailable") }).strict();

export const modelUsageObservationSchema = z
  .object({
    modelTokens: z.union([completeModelTokenObservationSchema, unavailableObservationSchema]),
    costUsd: z.union([
      z
        .object({
          status: z.literal("complete"),
          costUsdMicros: nonNegativeSafeIntegerSchema,
        })
        .strict(),
      unavailableObservationSchema,
    ]),
  })
  .strict();

export const RUN_BUDGET_DIMENSIONS = Object.freeze([
  "nodeStarts",
  "modelTokens",
  "modelCostUsdMicros",
  "executionMs",
  "artifactBytes",
] as const);

export type RunBudgetDimension = (typeof RUN_BUDGET_DIMENSIONS)[number];

export interface AgentModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsdMicros: number;
}

export interface AgentModelTokenBreakdown {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ModelUsageObservation {
  readonly modelTokens:
    | {
        readonly status: "complete";
        readonly totalTokens: number;
        readonly breakdown?: AgentModelTokenBreakdown | undefined;
      }
    | { readonly status: "unavailable" };
  readonly costUsd:
    | { readonly status: "complete"; readonly costUsdMicros: number }
    | { readonly status: "unavailable" };
}

export interface RunResourceAvailability {
  readonly modelTokens: "complete" | "unavailable";
  readonly modelCostUsdMicros: "complete" | "unavailable";
}

export interface RunResourceConsumption {
  readonly nodeStarts: number;
  readonly modelTokens: number;
  readonly modelCostUsdMicros: number;
  readonly executionMs: number;
  readonly artifactBytes: number;
}

export interface RunBudgetRemaining {
  readonly nodeStarts?: number;
  readonly modelTokens?: number;
  readonly modelCostUsdMicros?: number;
  readonly executionMs?: number;
  readonly artifactBytes?: number;
}

export interface RunBudgetExhaustion {
  readonly dimension: RunBudgetDimension;
  readonly limit: number;
  readonly consumed: number;
}

export interface RunBudgetState {
  readonly limits: CompiledRunBudget;
  readonly remaining: RunBudgetRemaining;
  readonly exhausted: readonly RunBudgetExhaustion[];
}

export const runBudgetExhaustionSchema = z
  .object({
    dimension: z.enum(RUN_BUDGET_DIMENSIONS),
    limit: positiveSafeIntegerSchema,
    consumed: nonNegativeSafeIntegerSchema,
  })
  .strict();

export function emptyRunResources(): RunResourceConsumption {
  return Object.freeze({
    nodeStarts: 0,
    modelTokens: 0,
    modelCostUsdMicros: 0,
    executionMs: 0,
    artifactBytes: 0,
  });
}

export function addRunResources(
  current: RunResourceConsumption,
  delta: Partial<RunResourceConsumption>,
): RunResourceConsumption {
  return Object.freeze({
    nodeStarts: checkedAdd(current.nodeStarts, delta.nodeStarts ?? 0, "nodeStarts"),
    modelTokens: checkedAdd(current.modelTokens, delta.modelTokens ?? 0, "modelTokens"),
    modelCostUsdMicros: checkedAdd(
      current.modelCostUsdMicros,
      delta.modelCostUsdMicros ?? 0,
      "modelCostUsdMicros",
    ),
    executionMs: checkedAdd(current.executionMs, delta.executionMs ?? 0, "executionMs"),
    artifactBytes: checkedAdd(current.artifactBytes, delta.artifactBytes ?? 0, "artifactBytes"),
  });
}

export function totalModelTokens(usage: AgentModelUsage): number {
  return checkedAdd(
    checkedAdd(usage.inputTokens, usage.outputTokens, "modelTokens"),
    checkedAdd(usage.cacheReadTokens, usage.cacheWriteTokens, "modelTokens"),
    "modelTokens",
  );
}

export function modelUsageObservationFromLegacy(usage: AgentModelUsage): ModelUsageObservation {
  return Object.freeze({
    modelTokens: Object.freeze({
      status: "complete" as const,
      totalTokens: totalModelTokens(usage),
      breakdown: Object.freeze({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
    }),
    costUsd: Object.freeze({
      status: "complete" as const,
      costUsdMicros: usage.costUsdMicros,
    }),
  });
}

export function committedDurationMs(durationMs: number): number {
  const rounded = Math.ceil(durationMs);
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new RangeError("executionMs must remain a non-negative safe integer");
  }
  return rounded;
}

export function retainedArtifactBytes(values: readonly string[]): number {
  return values.reduce(
    (total, value) => checkedAdd(total, Buffer.byteLength(value, "utf8"), "artifactBytes"),
    0,
  );
}

export function calculateRunBudgetState(
  limits: CompiledRunBudget | undefined,
  resources: RunResourceConsumption,
): RunBudgetState | null {
  if (limits === undefined) {
    return null;
  }

  const remaining: RunBudgetRemaining = Object.freeze({
    ...(limits.maxNodeStarts === undefined
      ? {}
      : { nodeStarts: available(limits.maxNodeStarts, resources.nodeStarts) }),
    ...(limits.maxModelTokens === undefined
      ? {}
      : { modelTokens: available(limits.maxModelTokens, resources.modelTokens) }),
    ...(limits.maxCostUsdMicros === undefined
      ? {}
      : {
          modelCostUsdMicros: available(limits.maxCostUsdMicros, resources.modelCostUsdMicros),
        }),
    ...(limits.maxExecutionMs === undefined
      ? {}
      : { executionMs: available(limits.maxExecutionMs, resources.executionMs) }),
    ...(limits.maxArtifactBytes === undefined
      ? {}
      : { artifactBytes: available(limits.maxArtifactBytes, resources.artifactBytes) }),
  });
  const exhausted = Object.freeze(
    dimensionValues(limits, resources)
      .filter(({ limit, consumed }) => consumed >= limit)
      .map((value) => Object.freeze(value)),
  );

  return Object.freeze({
    limits: Object.freeze({ ...limits }),
    remaining,
    exhausted,
  });
}

export function sameBudgetExhaustions(
  left: readonly RunBudgetExhaustion[],
  right: readonly RunBudgetExhaustion[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.dimension === right[index]?.dimension &&
        item.limit === right[index]?.limit &&
        item.consumed === right[index]?.consumed,
    )
  );
}

export function budgetExhaustionReason(exhausted: readonly RunBudgetExhaustion[]): string {
  return `run budget exhausted: ${exhausted
    .map((item) => `${item.dimension} consumed ${item.consumed} of ${item.limit}`)
    .join(", ")}`;
}

function checkedAdd(left: number, right: number, dimension: RunBudgetDimension): number {
  const result = left + right;
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(result)
  ) {
    throw new RangeError(`${dimension} accounting overflowed a safe integer`);
  }
  if (left < 0 || right < 0 || result < 0) {
    throw new RangeError(`${dimension} accounting must remain non-negative`);
  }
  return result;
}

function available(limit: number, consumed: number): number {
  return Math.max(0, limit - consumed);
}

function dimensionValues(
  limits: CompiledRunBudget,
  resources: RunResourceConsumption,
): RunBudgetExhaustion[] {
  return [
    ...(limits.maxNodeStarts === undefined
      ? []
      : [
          {
            dimension: "nodeStarts" as const,
            limit: limits.maxNodeStarts,
            consumed: resources.nodeStarts,
          },
        ]),
    ...(limits.maxModelTokens === undefined
      ? []
      : [
          {
            dimension: "modelTokens" as const,
            limit: limits.maxModelTokens,
            consumed: resources.modelTokens,
          },
        ]),
    ...(limits.maxCostUsdMicros === undefined
      ? []
      : [
          {
            dimension: "modelCostUsdMicros" as const,
            limit: limits.maxCostUsdMicros,
            consumed: resources.modelCostUsdMicros,
          },
        ]),
    ...(limits.maxExecutionMs === undefined
      ? []
      : [
          {
            dimension: "executionMs" as const,
            limit: limits.maxExecutionMs,
            consumed: resources.executionMs,
          },
        ]),
    ...(limits.maxArtifactBytes === undefined
      ? []
      : [
          {
            dimension: "artifactBytes" as const,
            limit: limits.maxArtifactBytes,
            consumed: resources.artifactBytes,
          },
        ]),
  ];
}
