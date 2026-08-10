import { createHash } from "node:crypto";
import { z } from "zod";

import type { EvaluationTrialScheduleItem } from "./plan.js";

export const EVALUATION_NUMERIC_METRICS = Object.freeze([
  "costUsdMicros",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "turns",
  "toolCalls",
  "toolErrors",
  "wallTimeMs",
  "activeTimeMs",
  "interventions",
  "policyViolations",
  "recoveryAttempts",
] as const);

export type EvaluationNumericMetric = (typeof EVALUATION_NUMERIC_METRICS)[number];
export type EvaluationTrialClassification =
  | "verified_success"
  | "false_completion"
  | "harness_failure"
  | "verifier_error";

export interface EvaluationMetrics {
  readonly costUsdMicros: number | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly turns: number | null;
  readonly toolCalls: number | null;
  readonly toolErrors: number | null;
  readonly wallTimeMs: number | null;
  readonly activeTimeMs: number | null;
  readonly interventions: number | null;
  readonly policyViolations: number | null;
  readonly recoveryAttempts: number | null;
  readonly recoveryOutcome: "not_attempted" | "succeeded" | "failed" | null;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
const trialIdSchema = z.string().regex(/^trial-[a-f0-9]{48}$/);
const boundedTextSchema = z.string().max(4_096);
const optionalMetricSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

const metricsSchema = z
  .object({
    costUsdMicros: optionalMetricSchema,
    inputTokens: optionalMetricSchema,
    cacheReadTokens: optionalMetricSchema,
    cacheWriteTokens: optionalMetricSchema,
    outputTokens: optionalMetricSchema,
    turns: optionalMetricSchema,
    toolCalls: optionalMetricSchema,
    toolErrors: optionalMetricSchema,
    wallTimeMs: optionalMetricSchema,
    activeTimeMs: optionalMetricSchema,
    interventions: optionalMetricSchema,
    policyViolations: optionalMetricSchema,
    recoveryAttempts: optionalMetricSchema,
    recoveryOutcome: z.enum(["not_attempted", "succeeded", "failed"]).nullable(),
  })
  .strict()
  .refine(
    (metrics) =>
      metrics.toolCalls === null ||
      metrics.toolErrors === null ||
      metrics.toolErrors <= metrics.toolCalls,
    "tool errors cannot exceed tool calls",
  )
  .superRefine((metrics, context) => {
    if (metrics.recoveryAttempts === null || metrics.recoveryOutcome === null) {
      return;
    }
    if (
      (metrics.recoveryAttempts === 0 && metrics.recoveryOutcome !== "not_attempted") ||
      (metrics.recoveryAttempts > 0 && metrics.recoveryOutcome === "not_attempted")
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoveryOutcome"],
        message: "recovery outcome contradicts the available recovery attempt count",
      });
    }
  });

const assertionEvidenceSchema = z
  .object({
    kind: z.enum(["exists", "absent", "sha256"]),
    path: z.string().min(1).max(1_024),
    outcome: z.boolean(),
    observedSha256: sha256Schema.optional(),
    reason: boundedTextSchema.optional(),
  })
  .strict();

const externalRuntimeEvidenceSchema = z
  .object({
    adapter: z.literal("pi-native-v1"),
    containment: z.enum(["linux-pid-namespace", "process-group"]),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    treeTermination: z.enum(["confirmed", "unconfirmed"]),
  })
  .strict()
  .superRefine((runtime, context) => {
    if (runtime.exitCode !== null && runtime.signal !== null) {
      context.addIssue({
        code: "custom",
        path: ["signal"],
        message: "external process evidence cannot contain both an exit code and a signal",
      });
    }
    if (runtime.timedOut && runtime.aborted) {
      context.addIssue({
        code: "custom",
        path: ["aborted"],
        message: "external process evidence cannot be both timed out and aborted",
      });
    }
  });

const harnessOutcomeSchema = z
  .object({
    outcome: z.enum([
      "completed",
      "failed",
      "timed_out",
      "crashed",
      "cancelled",
      "malformed_output",
      "missing_output",
    ]),
    runId: z.string().min(1).max(128).nullable(),
    reason: boundedTextSchema.nullable(),
    runtime: externalRuntimeEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((harness, context) => {
    const runtime = harness.runtime;
    if (runtime === undefined || harness.outcome !== "completed") {
      return;
    }
    if (
      runtime.exitCode !== 0 ||
      runtime.signal !== null ||
      runtime.timedOut ||
      runtime.aborted ||
      runtime.treeTermination !== "confirmed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtime"],
        message: "completed harness evidence requires a confirmed successful external process",
      });
    }
  });

const verificationOutcomeSchema = z
  .object({
    outcome: z.enum(["accepted", "rejected", "error", "not_run"]),
    verifierDigest: sha256Schema,
    assertions: z.array(assertionEvidenceSchema).max(16),
    reason: boundedTextSchema.optional(),
  })
  .strict()
  .superRefine((verification, context) => {
    if (verification.outcome === "accepted") {
      if (verification.assertions.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "accepted verification requires assertion evidence",
        });
      } else if (verification.assertions.some((assertion) => !assertion.outcome)) {
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "accepted verification requires every assertion to pass",
        });
      }
    } else if (verification.outcome === "rejected") {
      if (verification.assertions.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "rejected verification requires assertion evidence",
        });
      } else if (verification.assertions.every((assertion) => assertion.outcome)) {
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "rejected verification requires at least one failed assertion",
        });
      }
    } else if (verification.outcome === "not_run" && verification.assertions.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "not-run verification cannot contain assertion evidence",
      });
    }
    if (verification.outcome === "error" && verification.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "verifier error requires an actionable reason",
      });
    } else if (verification.outcome !== "error" && verification.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only verifier errors can contain a reason",
      });
    }
  });

const trialRecordSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive().max(4_096),
    position: z.number().int().positive().max(4_096),
    trialId: trialIdSchema,
    planDigest: sha256Schema,
    taskId: identifierSchema,
    profileId: identifierSchema,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    repetition: z.number().int().positive().max(32),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    environment: z
      .object({
        platform: z.enum(["linux", "darwin"]),
        architecture: z.string().min(1).max(64),
        nodeVersion: z.string().min(1).max(64),
        flowVersion: z.string().min(1).max(64),
        workspaceBackend: z.literal("reflink-copy-v1"),
        workspaceSnapshotDigest: sha256Schema.nullable(),
      })
      .strict(),
    harness: harnessOutcomeSchema,
    verification: verificationOutcomeSchema,
    classification: z.enum([
      "verified_success",
      "false_completion",
      "harness_failure",
      "verifier_error",
    ]),
    metrics: metricsSchema,
    previousDigest: sha256Schema.nullable(),
    recordDigest: sha256Schema,
  })
  .strict();

export type EvaluationTrialRecord = z.infer<typeof trialRecordSchema>;
export type EvaluationHarnessOutcome = EvaluationTrialRecord["harness"];
export type EvaluationVerificationOutcome = EvaluationTrialRecord["verification"];
export type EvaluationEnvironment = EvaluationTrialRecord["environment"];

export interface CreateEvaluationTrialRecordInput {
  readonly schedule: EvaluationTrialScheduleItem;
  readonly planDigest: string;
  readonly previousDigest: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly environment: EvaluationEnvironment;
  readonly harness: EvaluationHarnessOutcome;
  readonly verification: EvaluationVerificationOutcome;
  readonly metrics: EvaluationMetrics;
}

export class EvaluationRecordError extends Error {
  override readonly name = "EvaluationRecordError";
}

export function unavailableEvaluationMetrics(): EvaluationMetrics {
  return Object.freeze({
    costUsdMicros: null,
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    turns: null,
    toolCalls: null,
    toolErrors: null,
    wallTimeMs: null,
    activeTimeMs: null,
    interventions: null,
    policyViolations: null,
    recoveryAttempts: null,
    recoveryOutcome: null,
  });
}

export function parseEvaluationHarnessOutcome(input: unknown): EvaluationHarnessOutcome {
  return parseEvidence(harnessOutcomeSchema, input, "harness outcome");
}

export function parseEvaluationMetrics(input: unknown): EvaluationMetrics {
  return parseEvidence(metricsSchema, input, "metrics");
}

export function parseEvaluationVerificationOutcome(input: unknown): EvaluationVerificationOutcome {
  return parseEvidence(verificationOutcomeSchema, input, "verification outcome");
}

export function createEvaluationTrialRecord(
  input: CreateEvaluationTrialRecordInput,
): EvaluationTrialRecord {
  const classification = classifyTrial(input.harness, input.verification);
  const content = {
    version: 1 as const,
    sequence: input.schedule.position,
    position: input.schedule.position,
    trialId: input.schedule.trialId,
    planDigest: input.planDigest,
    taskId: input.schedule.taskId,
    profileId: input.schedule.profileId,
    seed: input.schedule.seed,
    repetition: input.schedule.repetition,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    environment: input.environment,
    harness: input.harness,
    verification: input.verification,
    classification,
    metrics: input.metrics,
    previousDigest: input.previousDigest,
  };
  const record = {
    ...content,
    recordDigest: sha256(canonicalize(content)),
  };
  return parseEvaluationTrialRecord(record);
}

export function parseEvaluationTrialRecord(input: unknown): EvaluationTrialRecord {
  const parsed = trialRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvaluationRecordError(`invalid evaluation trial record: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  const { recordDigest, ...content } = parsed.data;
  if (recordDigest !== sha256(canonicalize(content))) {
    throw new EvaluationRecordError("evaluation trial record digest does not match its content");
  }
  if (parsed.data.sequence !== parsed.data.position) {
    throw new EvaluationRecordError("evaluation trial sequence must match scheduled position");
  }
  if (Date.parse(parsed.data.completedAt) < Date.parse(parsed.data.startedAt)) {
    throw new EvaluationRecordError("evaluation trial completion precedes its start");
  }
  if (
    parsed.data.harness.outcome === "completed" &&
    parsed.data.environment.workspaceSnapshotDigest === null
  ) {
    throw new EvaluationRecordError(
      "completed evaluation trials require a workspace snapshot digest",
    );
  }
  const classification = classifyTrial(parsed.data.harness, parsed.data.verification);
  if (classification !== parsed.data.classification) {
    throw new EvaluationRecordError("evaluation trial classification contradicts its outcomes");
  }
  return deepFreeze(parsed.data);
}

function classifyTrial(
  harness: EvaluationHarnessOutcome,
  verification: EvaluationVerificationOutcome,
): EvaluationTrialClassification {
  if (harness.outcome !== "completed") {
    if (verification.outcome !== "not_run") {
      throw new EvaluationRecordError(
        "failed harness trials must retain an explicit not-run verifier outcome",
      );
    }
    return "harness_failure";
  }
  if (harness.runId === null) {
    throw new EvaluationRecordError("completed harness trials require a durable run id");
  }
  switch (verification.outcome) {
    case "accepted":
      return "verified_success";
    case "rejected":
      return "false_completion";
    case "error":
      return "verifier_error";
    case "not_run":
      throw new EvaluationRecordError("completed harness trials require post-run verification");
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new EvaluationRecordError("canonical evaluation numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new EvaluationRecordError("evaluation record contains a non-canonical value");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseEvidence<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new EvaluationRecordError(`invalid evaluation ${label}: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
