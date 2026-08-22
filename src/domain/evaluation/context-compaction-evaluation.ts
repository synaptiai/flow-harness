import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { CONTEXT_COMPACTION_MODES } from "../run/context-compaction.js";
import type { EvaluationFilesystemAssertion, EvaluationTrialScheduleItem } from "./plan.js";

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
): readonly EvaluationTrialScheduleItem[] {
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
  const schedule: EvaluationTrialScheduleItem[] = [];
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
