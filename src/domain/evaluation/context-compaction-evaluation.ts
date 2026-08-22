import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { CONTEXT_COMPACTION_MODES, type ContextCompactionMode } from "../run/context-compaction.js";
import type { EvaluationFilesystemAssertion, EvaluationTrialScheduleItem } from "./plan.js";
import {
  type ContextCompactionEvaluationMetrics,
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "./records.js";

export const CONTEXT_COMPACTION_EVALUATION_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const CONTEXT_COMPACTION_EVALUATION_MODES = CONTEXT_COMPACTION_MODES;
export const MAX_CONTEXT_COMPACTION_EVALUATION_PLAN_BYTES = 1_048_576;
export const MAX_CONTEXT_COMPACTION_EVALUATION_SEEDS = 30;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "must be a canonical lowercase identifier");
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be an exact semantic version",
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const canonicalRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(isCanonicalRelativePath, "must be a canonical portable relative path");
const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), path: canonicalRelativePathSchema }).strict(),
  z.object({ kind: z.literal("absent"), path: canonicalRelativePathSchema }).strict(),
  z
    .object({ kind: z.literal("sha256"), path: canonicalRelativePathSchema, value: sha256Schema })
    .strict(),
]);
const protectedConstraintsSchema = z
  .array(z.string().min(1).max(4_096))
  .min(1)
  .max(32)
  .refine((items) => new Set(items).size === items.length, "must be unique")
  .refine(
    (items) => items.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0) <= 65_536,
    "exceed the 65536-byte limit",
  );
const taskSchema = z
  .object({
    id: identifierSchema,
    partition: z.literal("holdout"),
    fixture: canonicalRelativePathSchema,
    instruction: canonicalRelativePathSchema,
    verifier: z
      .object({
        kind: z.literal("filesystem-v1"),
        assertions: z.array(assertionSchema).min(1).max(16),
      })
      .strict(),
    protectedConstraints: protectedConstraintsSchema,
    constraintAssertionIndexes: z.array(z.number().int().nonnegative().max(15)).min(1).max(16),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.constraintAssertionIndexes.length !== task.protectedConstraints.length) {
      context.addIssue({
        code: "custom",
        path: ["constraintAssertionIndexes"],
        message: "must map one assertion to each protected constraint",
      });
    }
    if (new Set(task.constraintAssertionIndexes).size !== task.constraintAssertionIndexes.length) {
      context.addIssue({
        code: "custom",
        path: ["constraintAssertionIndexes"],
        message: "must be unique",
      });
    }
    if (task.constraintAssertionIndexes.some((index) => index >= task.verifier.assertions.length)) {
      context.addIssue({
        code: "custom",
        path: ["constraintAssertionIndexes"],
        message: "must reference declared verifier assertions",
      });
    }
  });
const modelSchema = z
  .object({
    provider: z.string().min(1).max(96),
    id: z.string().min(1).max(256),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
  })
  .strict();
const budgetSchema = z
  .object({
    maxNodeStarts: positiveSafeIntegerSchema,
    maxModelTokens: positiveSafeIntegerSchema,
    maxCostUsdMicros: positiveSafeIntegerSchema,
    maxExecutionMs: positiveSafeIntegerSchema,
    maxArtifactBytes: positiveSafeIntegerSchema,
  })
  .strict();
const sourceSchema = z
  .object({
    apiVersion: z.literal(CONTEXT_COMPACTION_EVALUATION_API_VERSION),
    kind: z.literal("ContextCompactionEvaluationPlan"),
    metadata: z.object({ id: identifierSchema }).strict(),
    suite: z
      .object({
        id: identifierSchema,
        version: semverSchema,
        tasks: z.array(taskSchema).min(1).max(64),
      })
      .strict(),
    profile: z
      .object({
        adapter: z.literal("flow-workflow-v1"),
        workflow: canonicalRelativePathSchema,
      })
      .strict(),
    controls: z
      .object({
        model: modelSchema,
        budget: budgetSchema,
        network: z.literal("deny"),
        retry: z.object({ providerRetries: z.literal(0), harnessRetries: z.literal(0) }).strict(),
        compaction: z
          .object({
            minimumReductionBytes: positiveSafeIntegerSchema.max(1_048_576),
            summaryOutputTokenLimits: z
              .tuple([positiveSafeIntegerSchema, positiveSafeIntegerSchema])
              .readonly(),
          })
          .strict()
          .refine(
            (value) => value.summaryOutputTokenLimits[0] > value.summaryOutputTokenLimits[1],
            "second summary output-token limit must be smaller",
          ),
      })
      .strict(),
    seeds: z
      .array(nonNegativeSafeIntegerSchema)
      .min(6)
      .max(MAX_CONTEXT_COMPACTION_EVALUATION_SEEDS),
    modes: z.tuple([
      z.literal("none"),
      z.literal("references"),
      z.literal("references-and-summary"),
    ]),
    order: z.literal("six-order-balanced-v1"),
    comparison: z
      .object({
        minimumPairedTrials: positiveSafeIntegerSchema,
        maxVerifiedSuccessRegression: z.number().min(0).max(1),
        maxTotalTokenIncreaseRate: z.number().min(0).max(10),
        maxConstraintLosses: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    refineUnique(
      plan.suite.tasks.map((task) => task.id),
      ["suite", "tasks"],
      "task ids",
      context,
    );
    refineUnique(plan.seeds, ["seeds"], "seeds", context);
    if (plan.seeds.length % 6 !== 0) {
      context.addIssue({
        code: "custom",
        path: ["seeds"],
        message: "seed count must be a positive multiple of six",
      });
    }
    const pairedTrials = plan.suite.tasks.length * plan.seeds.length;
    const scheduledTrials = pairedTrials * CONTEXT_COMPACTION_EVALUATION_MODES.length;
    if (!Number.isSafeInteger(scheduledTrials) || scheduledTrials > 4_096) {
      context.addIssue({
        code: "custom",
        path: ["seeds"],
        message: "context compaction schedule must not exceed 4096 trials",
      });
    }
    if (plan.comparison.minimumPairedTrials > pairedTrials) {
      context.addIssue({
        code: "custom",
        path: ["comparison", "minimumPairedTrials"],
        message: "cannot exceed the holdout task and seed pairs",
      });
    }
  });

export type ContextCompactionEvaluationPlanSource = z.infer<typeof sourceSchema>;
export type ContextCompactionEvaluationTaskSource =
  ContextCompactionEvaluationPlanSource["suite"]["tasks"][number];
export interface ContextCompactionEvaluationScheduleItem
  extends Omit<EvaluationTrialScheduleItem, "profileId"> {
  readonly profileId: ContextCompactionMode;
}

export type ContextCompactionEvaluationPlanErrorCode =
  | "invalid_schema"
  | "invalid_yaml"
  | "limit_exceeded";

export class ContextCompactionEvaluationPlanError extends Error {
  override readonly name = "ContextCompactionEvaluationPlanError";

  constructor(
    readonly code: ContextCompactionEvaluationPlanErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export function parseContextCompactionEvaluationPlanText(
  source: string,
  sourceName = "context compaction evaluation plan",
): ContextCompactionEvaluationPlanSource {
  if (Buffer.byteLength(source, "utf8") > MAX_CONTEXT_COMPACTION_EVALUATION_PLAN_BYTES) {
    throw new ContextCompactionEvaluationPlanError(
      "limit_exceeded",
      `${sourceName} exceeds ${MAX_CONTEXT_COMPACTION_EVALUATION_PLAN_BYTES} UTF-8 bytes`,
    );
  }
  let input: unknown;
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new ContextCompactionEvaluationPlanError(
        "invalid_yaml",
        `${sourceName}: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ContextCompactionEvaluationPlanError) throw error;
    throw new ContextCompactionEvaluationPlanError(
      "invalid_yaml",
      `${sourceName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = sourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContextCompactionEvaluationPlanError(
      "invalid_schema",
      `${sourceName}: ${parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

const SIX_MODE_ORDERS = Object.freeze([
  ["none", "references", "references-and-summary"],
  ["none", "references-and-summary", "references"],
  ["references", "none", "references-and-summary"],
  ["references", "references-and-summary", "none"],
  ["references-and-summary", "none", "references"],
  ["references-and-summary", "references", "none"],
] as const);

export function createContextCompactionEvaluationSchedule(
  planDigest: string,
  taskIds: readonly string[],
  seeds: readonly number[],
): readonly ContextCompactionEvaluationScheduleItem[] {
  if (!sha256Schema.safeParse(planDigest).success) {
    throw new ContextCompactionEvaluationPlanError(
      "invalid_schema",
      "plan digest must be a SHA-256 digest",
    );
  }
  if (taskIds.length === 0 || taskIds.length > 64 || new Set(taskIds).size !== taskIds.length) {
    throw new ContextCompactionEvaluationPlanError(
      "invalid_schema",
      "task ids are missing, duplicate, or excessive",
    );
  }
  if (
    seeds.length < 6 ||
    seeds.length > MAX_CONTEXT_COMPACTION_EVALUATION_SEEDS ||
    seeds.length % 6 !== 0 ||
    new Set(seeds).size !== seeds.length
  ) {
    throw new ContextCompactionEvaluationPlanError(
      "invalid_schema",
      "seeds must be unique and have a count that is a positive multiple of six",
    );
  }
  const scheduledTrials =
    taskIds.length * seeds.length * CONTEXT_COMPACTION_EVALUATION_MODES.length;
  if (!Number.isSafeInteger(scheduledTrials) || scheduledTrials > 4_096) {
    throw new ContextCompactionEvaluationPlanError(
      "limit_exceeded",
      "context compaction schedule must not exceed 4096 trials",
    );
  }
  const schedule: ContextCompactionEvaluationScheduleItem[] = [];
  for (const taskId of taskIds) {
    identifierSchema.parse(taskId);
    for (const [seedIndex, seed] of seeds.entries()) {
      nonNegativeSafeIntegerSchema.parse(seed);
      const order = SIX_MODE_ORDERS[seedIndex % SIX_MODE_ORDERS.length];
      if (order === undefined) {
        throw new ContextCompactionEvaluationPlanError(
          "invalid_schema",
          "balanced mode order is incomplete",
        );
      }
      for (const profileId of order) {
        const position = schedule.length + 1;
        const repetition = seedIndex + 1;
        const identity = `${planDigest}\0${taskId}\0${profileId}\0${seed}\0${repetition}\0${position}`;
        schedule.push(
          Object.freeze({
            version: 1,
            position,
            trialId: `trial-${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`,
            taskId,
            profileId,
            seed,
            repetition,
          }),
        );
      }
    }
  }
  return Object.freeze(schedule);
}

export function calculateContextCompactionEvaluationPlanDigest(identity: unknown): string {
  return createHash("sha256").update(canonicalValue(identity)).digest("hex");
}

export function calculateContextCompactionEvaluationVerifierDigest(
  assertions: readonly EvaluationFilesystemAssertion[],
): string {
  return createHash("sha256")
    .update(canonicalValue({ kind: "filesystem-v1", assertions }))
    .digest("hex");
}

export interface ContextCompactionEvaluationReportInput {
  readonly planDigest: string;
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly tasks: readonly {
    readonly id: string;
    readonly verifierDigest: string;
    readonly assertionCount: number;
    readonly constraintAssertionIndexes: readonly number[];
  }[];
  readonly comparison: ContextCompactionEvaluationPlanSource["comparison"];
}

export interface ContextCompactionModeReport {
  readonly scheduled: number;
  readonly committed: number;
  readonly missing: number;
  readonly verifiedSuccess: number;
  readonly verifiedSuccessRate: number;
  readonly falseCompletion: number;
  readonly harnessFailure: number;
  readonly verifierError: number;
  readonly constraintRetention: {
    readonly checked: number;
    readonly retained: number;
    readonly losses: number;
    readonly unavailable: number;
  };
  readonly totals: {
    readonly tokens: number | null;
    readonly costUsdMicros: number | null;
    readonly latencyMs: number | null;
  };
  readonly compaction: ContextCompactionEvidenceTotals | null;
}

export interface ContextCompactionEvidenceTotals
  extends Omit<ContextCompactionEvaluationMetrics, "mode"> {}

export type ContextCompactionComparison =
  | {
      readonly verdict:
        | "passes"
        | "performance_failed"
        | "constraint_failed"
        | "insufficient_evidence";
      readonly scheduledPairs: number;
      readonly completePairs: number;
      readonly comparablePairs: number;
      readonly verifiedSuccessDelta: number | null;
      readonly totalTokenChangeRate: number | null;
      readonly constraints: {
        readonly retained: boolean | null;
        readonly successRegression: boolean | null;
        readonly tokenIncrease: boolean | null;
      };
    }
  | {
      readonly verdict: "not_evaluated";
      readonly reason: "references_vs_none_gate_failed";
    };

export interface ContextCompactionEvaluationReport {
  readonly version: 1;
  readonly planDigest: string;
  readonly scheduledTrials: number;
  readonly committedTrials: number;
  readonly productionActivation: "not_authorized";
  readonly modes: Readonly<Record<ContextCompactionMode, ContextCompactionModeReport>>;
  readonly comparisons: {
    readonly referencesVsNone: Exclude<
      ContextCompactionComparison,
      { readonly verdict: "not_evaluated" }
    >;
    readonly summaryVsReferences: ContextCompactionComparison;
  };
}

export class ContextCompactionEvaluationAggregationError extends Error {
  override readonly name = "ContextCompactionEvaluationAggregationError";
}

export function aggregateContextCompactionEvaluation(
  input: ContextCompactionEvaluationReportInput,
  rawRecords: readonly EvaluationTrialRecord[],
): ContextCompactionEvaluationReport {
  const records = validateContextCompactionEvaluationRecords(input, rawRecords);
  const modes = Object.fromEntries(
    CONTEXT_COMPACTION_EVALUATION_MODES.map((mode) => [
      mode,
      contextCompactionModeReport(input, records, mode),
    ]),
  ) as Record<ContextCompactionMode, ContextCompactionModeReport>;
  const referencesVsNone = compareContextCompactionModes(
    input,
    records,
    modes,
    "none",
    "references",
  );
  const summaryVsReferences: ContextCompactionComparison =
    referencesVsNone.verdict === "passes"
      ? compareContextCompactionModes(input, records, modes, "references", "references-and-summary")
      : { verdict: "not_evaluated", reason: "references_vs_none_gate_failed" };
  return deepFreeze({
    version: 1,
    planDigest: input.planDigest,
    scheduledTrials: input.schedule.length,
    committedTrials: records.length,
    productionActivation: "not_authorized",
    modes,
    comparisons: { referencesVsNone, summaryVsReferences },
  });
}

function validateContextCompactionEvaluationRecords(
  input: ContextCompactionEvaluationReportInput,
  rawRecords: readonly EvaluationTrialRecord[],
): readonly EvaluationTrialRecord[] {
  if (!sha256Schema.safeParse(input.planDigest).success) {
    throw new ContextCompactionEvaluationAggregationError("plan digest is invalid");
  }
  if (rawRecords.length > input.schedule.length) {
    throw new ContextCompactionEvaluationAggregationError(
      "record count exceeds the admitted schedule",
    );
  }
  let previousDigest: string | null = null;
  const records: EvaluationTrialRecord[] = [];
  for (const [index, raw] of rawRecords.entries()) {
    const record = parseEvaluationTrialRecord(raw);
    const scheduled = input.schedule[index];
    const task = input.tasks.find((item) => item.id === record.taskId);
    if (
      scheduled === undefined ||
      record.planDigest !== input.planDigest ||
      record.sequence !== index + 1 ||
      record.position !== scheduled.position ||
      record.trialId !== scheduled.trialId ||
      record.taskId !== scheduled.taskId ||
      record.profileId !== scheduled.profileId ||
      record.seed !== scheduled.seed ||
      record.repetition !== scheduled.repetition ||
      record.previousDigest !== previousDigest
    ) {
      throw new ContextCompactionEvaluationAggregationError(
        `trial record ${index + 1} contradicts the admitted schedule`,
      );
    }
    if (
      task === undefined ||
      record.verification.verifierDigest !== task.verifierDigest ||
      record.verification.assertions.length > task.assertionCount
    ) {
      throw new ContextCompactionEvaluationAggregationError(
        `trial record ${index + 1} contradicts its verifier`,
      );
    }
    const compaction = record.metrics.contextCompaction;
    if (compaction === undefined || compaction.mode !== record.profileId) {
      throw new ContextCompactionEvaluationAggregationError(
        `trial record ${index + 1} lacks matching compaction evidence`,
      );
    }
    records.push(record);
    previousDigest = record.recordDigest;
  }
  return Object.freeze(records);
}

function contextCompactionModeReport(
  input: ContextCompactionEvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
  mode: ContextCompactionMode,
): ContextCompactionModeReport {
  const scheduled = input.schedule.filter((trial) => trial.profileId === mode).length;
  const modeRecords = records.filter((record) => record.profileId === mode);
  const classificationCount = (classification: EvaluationTrialRecord["classification"]) =>
    modeRecords.filter((record) => record.classification === classification).length;
  let checked = 0;
  let retained = 0;
  let unavailable = 0;
  for (const record of modeRecords) {
    const task = input.tasks.find((item) => item.id === record.taskId);
    if (task === undefined) continue;
    for (const assertionIndex of task.constraintAssertionIndexes) {
      const assertion = record.verification.assertions[assertionIndex];
      if (
        (record.verification.outcome !== "accepted" &&
          record.verification.outcome !== "rejected") ||
        assertion === undefined
      ) {
        unavailable += 1;
        continue;
      }
      checked += 1;
      retained += Number(assertion.outcome);
    }
  }
  const verifiedSuccess = classificationCount("verified_success");
  return Object.freeze({
    scheduled,
    committed: modeRecords.length,
    missing: scheduled - modeRecords.length,
    verifiedSuccess,
    verifiedSuccessRate: scheduled === 0 ? 0 : verifiedSuccess / scheduled,
    falseCompletion: classificationCount("false_completion"),
    harnessFailure: classificationCount("harness_failure"),
    verifierError: classificationCount("verifier_error"),
    constraintRetention: Object.freeze({
      checked,
      retained,
      losses: checked - retained,
      unavailable,
    }),
    totals: Object.freeze({
      tokens: sumTotalTokens(modeRecords),
      costUsdMicros: sumOptionalMetric(modeRecords, "costUsdMicros"),
      latencyMs: sumOptionalMetric(modeRecords, "wallTimeMs"),
    }),
    compaction: sumCompactionEvidence(modeRecords),
  });
}

function compareContextCompactionModes(
  input: ContextCompactionEvaluationReportInput,
  records: readonly EvaluationTrialRecord[],
  modes: Readonly<Record<ContextCompactionMode, ContextCompactionModeReport>>,
  baselineMode: ContextCompactionMode,
  candidateMode: ContextCompactionMode,
): Exclude<ContextCompactionComparison, { readonly verdict: "not_evaluated" }> {
  const recordByKey = new Map(
    records.map((record) => [trialBlockKey(record.taskId, record.seed, record.profileId), record]),
  );
  const blocks = input.schedule
    .filter((trial) => trial.profileId === baselineMode)
    .map((trial) => ({
      baseline: recordByKey.get(trialBlockKey(trial.taskId, trial.seed, baselineMode)),
      candidate: recordByKey.get(trialBlockKey(trial.taskId, trial.seed, candidateMode)),
    }));
  const complete = blocks.filter(
    (block): block is { baseline: EvaluationTrialRecord; candidate: EvaluationTrialRecord } =>
      block.baseline !== undefined && block.candidate !== undefined,
  );
  const comparable = complete.filter((block) => sameEnvironment(block.baseline, block.candidate));
  const verifiedSuccessDelta =
    comparable.length === 0
      ? null
      : successRate(comparable.map((block) => block.candidate)) -
        successRate(comparable.map((block) => block.baseline));
  const tokenPairs = comparable.flatMap((block) => {
    const baseline = recordTotalTokens(block.baseline);
    const candidate = recordTotalTokens(block.candidate);
    return baseline === null || candidate === null ? [] : [{ baseline, candidate }];
  });
  const baselineTokens = sumNumbers(tokenPairs.map((pair) => pair.baseline));
  const candidateTokens = sumNumbers(tokenPairs.map((pair) => pair.candidate));
  const totalTokenChangeRate =
    tokenPairs.length !== comparable.length || baselineTokens === 0
      ? null
      : (candidateTokens - baselineTokens) / baselineTokens;
  const candidate = modes[candidateMode];
  const retained =
    candidate.constraintRetention.unavailable === 0 && candidate.committed === candidate.scheduled
      ? candidate.constraintRetention.losses <= input.comparison.maxConstraintLosses
      : null;
  const successRegression =
    verifiedSuccessDelta === null
      ? null
      : -verifiedSuccessDelta <= input.comparison.maxVerifiedSuccessRegression;
  const tokenIncrease =
    totalTokenChangeRate === null
      ? null
      : totalTokenChangeRate <= input.comparison.maxTotalTokenIncreaseRate;
  const constraints = Object.freeze({ retained, successRegression, tokenIncrease });
  let verdict: "passes" | "performance_failed" | "constraint_failed" | "insufficient_evidence";
  if (retained === false) {
    verdict = "constraint_failed";
  } else if (
    complete.length !== blocks.length ||
    comparable.length !== blocks.length ||
    comparable.length < input.comparison.minimumPairedTrials ||
    Object.values(constraints).some((value) => value === null)
  ) {
    verdict = "insufficient_evidence";
  } else if (successRegression === false || tokenIncrease === false) {
    verdict = "performance_failed";
  } else {
    verdict = "passes";
  }
  return Object.freeze({
    verdict,
    scheduledPairs: blocks.length,
    completePairs: complete.length,
    comparablePairs: comparable.length,
    verifiedSuccessDelta,
    totalTokenChangeRate,
    constraints,
  });
}

function sumCompactionEvidence(
  records: readonly EvaluationTrialRecord[],
): ContextCompactionEvidenceTotals | null {
  const evidence = records.flatMap((record) =>
    record.metrics.contextCompaction === undefined ? [] : [record.metrics.contextCompaction],
  );
  if (evidence.length !== records.length) return null;
  const sum = (key: keyof Omit<ContextCompactionEvaluationMetrics, "mode">) =>
    sumNumbers(evidence.map((item) => item[key]));
  return Object.freeze({
    providerRequestBytes: sum("providerRequestBytes"),
    providerRequestEstimatedTokens: sum("providerRequestEstimatedTokens"),
    attempts: sum("attempts"),
    accepted: sum("accepted"),
    rejected: sum("rejected"),
    interrupted: sum("interrupted"),
    summaryInputTokens: sum("summaryInputTokens"),
    summaryOutputTokens: sum("summaryOutputTokens"),
    summaryCostUsdMicros: sum("summaryCostUsdMicros"),
    artifactReopenAttempts: sum("artifactReopenAttempts"),
    artifactReopenSuccesses: sum("artifactReopenSuccesses"),
  });
}

function sumTotalTokens(records: readonly EvaluationTrialRecord[]): number | null {
  const totals = records.map(recordTotalTokens);
  return totals.some((value) => value === null)
    ? null
    : sumNumbers(totals.filter((value): value is number => value !== null));
}

function recordTotalTokens(record: EvaluationTrialRecord): number | null {
  const input = record.metrics.inputTokens;
  const output = record.metrics.outputTokens;
  return input === null || output === null ? null : safeSum(input, output);
}

function sumOptionalMetric(
  records: readonly EvaluationTrialRecord[],
  metric: "costUsdMicros" | "wallTimeMs",
): number | null {
  const values = records.map((record) => record.metrics[metric]);
  return values.some((value) => value === null)
    ? null
    : sumNumbers(values.filter((value): value is number => value !== null));
}

function successRate(records: readonly EvaluationTrialRecord[]): number {
  return (
    records.filter((record) => record.classification === "verified_success").length / records.length
  );
}

function sameEnvironment(left: EvaluationTrialRecord, right: EvaluationTrialRecord): boolean {
  return JSON.stringify(left.environment) === JSON.stringify(right.environment);
}

function trialBlockKey(taskId: string, seed: number, mode: string): string {
  return `${taskId}\0${seed}\0${mode}`;
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => safeSum(total, value), 0);
}

function safeSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ContextCompactionEvaluationAggregationError(
      "evaluation metric total exceeds a non-negative safe integer",
    );
  }
  return total;
}

function refineUnique(
  values: readonly unknown[],
  path: PropertyKey[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `${label} must be unique` });
  }
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function canonicalValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new ContextCompactionEvaluationPlanError(
    "invalid_schema",
    "plan identity is not canonical JSON",
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
