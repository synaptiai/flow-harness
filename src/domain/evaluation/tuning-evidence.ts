import { createHash } from "node:crypto";

import { z } from "zod";
import { type EvaluationTrialScheduleItem, MAX_EVALUATION_TASKS } from "./plan.js";
import {
  EVALUATION_NUMERIC_METRICS,
  type EvaluationMetrics,
  type EvaluationTrialRecord,
  parseEvaluationTrialRecord,
} from "./records.js";

export const TUNING_EVIDENCE_KIND = "flow.tuning-evidence/v1" as const;
export const MAX_TUNING_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_TUNING_EVIDENCE_TASKS = 64;
export const MAX_TUNING_EVIDENCE_TRIALS = 4_096;
export const MAX_TUNING_EVIDENCE_REASON_BYTES = 512;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedReasonSchema = z
  .string()
  .max(MAX_TUNING_EVIDENCE_REASON_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_TUNING_EVIDENCE_REASON_BYTES,
    `reason cannot exceed ${MAX_TUNING_EVIDENCE_REASON_BYTES} UTF-8 bytes`,
  );
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

const profileSchema = z
  .object({
    id: identifierSchema,
    adapter: z.literal("flow-workflow-v1"),
    workflowDigest: sha256Schema,
    candidateDigest: sha256Schema.optional(),
  })
  .strict();

const trialSchema = z
  .object({
    profileId: identifierSchema,
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    repetition: z.number().int().positive().max(32),
    classification: z.enum([
      "verified_success",
      "false_completion",
      "harness_failure",
      "verifier_error",
    ]),
    harness: z
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
        reason: boundedReasonSchema.nullable(),
        reasonTruncated: z.boolean(),
      })
      .strict()
      .refine(
        (harness) => harness.reason !== null || !harness.reasonTruncated,
        "a missing reason cannot be truncated",
      ),
    verification: z
      .object({ outcome: z.enum(["accepted", "rejected", "error", "not_run"]) })
      .strict(),
    metrics: metricsSchema,
  })
  .strict()
  .superRefine((trial, context) => {
    const expected = expectedClassification(trial.harness.outcome, trial.verification.outcome);
    if (expected === null || trial.classification !== expected) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "trial classification contradicts its harness or verification outcome",
      });
    }
  });

const taskSchema = z
  .object({
    id: identifierSchema,
    trials: z.array(trialSchema).min(1).max(MAX_TUNING_EVIDENCE_TRIALS),
  })
  .strict();

const packetSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal(TUNING_EVIDENCE_KIND),
    evaluation: z
      .object({
        id: identifierSchema,
        planDigest: sha256Schema,
        terminalRecordDigest: sha256Schema,
        completedTrials: z.number().int().positive().max(MAX_TUNING_EVIDENCE_TRIALS),
        scheduledTrials: z.number().int().positive().max(MAX_TUNING_EVIDENCE_TRIALS),
      })
      .strict()
      .refine(
        (value) => value.completedTrials === value.scheduledTrials,
        "tuning evidence requires a complete evaluation",
      ),
    suite: z
      .object({
        id: identifierSchema,
        version: z
          .string()
          .regex(
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
          ),
      })
      .strict(),
    profiles: z
      .array(profileSchema)
      .length(2)
      .refine(
        (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
        "tuning evidence profile ids must be unique",
      ),
    tasks: z
      .array(taskSchema)
      .min(1)
      .max(MAX_TUNING_EVIDENCE_TASKS)
      .refine(
        (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
        "tuning evidence task ids must be unique",
      ),
    evidenceDigest: sha256Schema,
  })
  .strict()
  .superRefine((packet, context) => {
    const profileIds = new Set(packet.profiles.map((profile) => profile.id));
    let expectedRepetitions: Set<string> | undefined;
    const trialCount = packet.tasks.reduce((total, task) => total + task.trials.length, 0);
    if (trialCount > MAX_TUNING_EVIDENCE_TRIALS) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: `tuning evidence cannot exceed ${MAX_TUNING_EVIDENCE_TRIALS} trials`,
      });
    }
    for (const [taskIndex, task] of packet.tasks.entries()) {
      const trialIdentities = new Set<string>();
      const repetitions = new Map<string, Set<string>>();
      const seedToRepetition = new Map<number, number>();
      const repetitionToSeed = new Map<number, number>();
      for (const [trialIndex, trial] of task.trials.entries()) {
        if (!profileIds.has(trial.profileId)) {
          context.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "trials", trialIndex, "profileId"],
            message: "tuning trial must reference a declared profile",
          });
        }
        const repetition = `${trial.seed}\0${trial.repetition}`;
        const identity = `${repetition}\0${trial.profileId}`;
        if (trialIdentities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "trials", trialIndex],
            message: "tuning trial identities must be unique",
          });
        }
        trialIdentities.add(identity);
        const coveredProfiles = repetitions.get(repetition) ?? new Set<string>();
        coveredProfiles.add(trial.profileId);
        repetitions.set(repetition, coveredProfiles);
        const knownRepetition = seedToRepetition.get(trial.seed);
        const knownSeed = repetitionToSeed.get(trial.repetition);
        if (
          (knownRepetition !== undefined && knownRepetition !== trial.repetition) ||
          (knownSeed !== undefined && knownSeed !== trial.seed)
        ) {
          context.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "trials", trialIndex],
            message: "tuning seeds and repetitions must have a one-to-one schedule mapping",
          });
        }
        seedToRepetition.set(trial.seed, trial.repetition);
        repetitionToSeed.set(trial.repetition, trial.seed);
      }
      for (const [repetition, coveredProfiles] of repetitions) {
        if (coveredProfiles.size !== profileIds.size) {
          context.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "trials"],
            message: `tuning repetition ${repetition.replace("\0", "/")} must cover every profile`,
          });
        }
      }
      const actualRepetitions = new Set(repetitions.keys());
      if (
        seedToRepetition.size !== actualRepetitions.size ||
        repetitionToSeed.size !== actualRepetitions.size ||
        ![...Array(actualRepetitions.size)].every((_, index) => repetitionToSeed.has(index + 1))
      ) {
        context.addIssue({
          code: "custom",
          path: ["tasks", taskIndex, "trials"],
          message: "tuning repetitions must be contiguous and use unique seeds",
        });
      }
      if (expectedRepetitions === undefined) {
        expectedRepetitions = actualRepetitions;
      } else if (!sameStrings(expectedRepetitions, actualRepetitions)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", taskIndex, "trials"],
          message: "every tuning task must cover the same seed and repetition schedule",
        });
      }
    }
    if (expectedRepetitions !== undefined) {
      const trialsPerSourceTask = profileIds.size * expectedRepetitions.size;
      const inferredSourceTasks = packet.evaluation.scheduledTrials / trialsPerSourceTask;
      if (
        !Number.isInteger(inferredSourceTasks) ||
        inferredSourceTasks < packet.tasks.length ||
        inferredSourceTasks > MAX_EVALUATION_TASKS
      ) {
        context.addIssue({
          code: "custom",
          path: ["evaluation", "scheduledTrials"],
          message: "declared evaluation total contradicts the retained tuning schedule",
        });
      }
    }
  });

export type TuningEvidencePacket = z.infer<typeof packetSchema>;

export interface TuningEvidenceSource {
  readonly evaluationId: string;
  readonly planDigest: string;
  readonly suite: { readonly id: string; readonly version: string };
  readonly tasks: readonly {
    readonly id: string;
    readonly partition: "tuning" | "regression" | "holdout";
  }[];
  readonly profiles: readonly {
    readonly id: string;
    readonly adapter: "flow-workflow-v1";
    readonly workflowDigest: string;
    readonly candidateDigest?: string;
  }[];
  readonly schedule: readonly EvaluationTrialScheduleItem[];
  readonly records: readonly EvaluationTrialRecord[];
}

export class TuningEvidenceError extends Error {
  override readonly name = "TuningEvidenceError";
}

export function createTuningEvidencePacket(source: TuningEvidenceSource): TuningEvidencePacket {
  if (source.schedule.length !== source.records.length) {
    throw new TuningEvidenceError(
      "evaluation must be complete before tuning evidence can be exported",
    );
  }
  const tuningTaskIds = new Set(
    source.tasks.filter((task) => task.partition === "tuning").map((task) => task.id),
  );
  if (tuningTaskIds.size === 0) {
    throw new TuningEvidenceError("evaluation does not contain a tuning task");
  }

  const records: EvaluationTrialRecord[] = [];
  for (const [index, rawRecord] of source.records.entries()) {
    const scheduled = source.schedule[index];
    if (
      scheduled === undefined ||
      rawRecord.planDigest !== source.planDigest ||
      rawRecord.position !== scheduled.position ||
      rawRecord.trialId !== scheduled.trialId ||
      rawRecord.taskId !== scheduled.taskId ||
      rawRecord.profileId !== scheduled.profileId ||
      rawRecord.seed !== scheduled.seed ||
      rawRecord.repetition !== scheduled.repetition
    ) {
      throw new TuningEvidenceError(`record ${index + 1} contradicts the evaluation schedule`);
    }
    records.push(parseEvaluationTrialRecord(rawRecord));
  }

  const terminal = records.at(-1);
  if (terminal === undefined) {
    throw new TuningEvidenceError("evaluation must contain a terminal trial record");
  }
  const content = {
    version: 1 as const,
    kind: TUNING_EVIDENCE_KIND,
    evaluation: {
      id: source.evaluationId,
      planDigest: source.planDigest,
      terminalRecordDigest: terminal.recordDigest,
      completedTrials: records.length,
      scheduledTrials: source.schedule.length,
    },
    suite: { id: source.suite.id, version: source.suite.version },
    profiles: source.profiles.map((profile) => ({
      id: profile.id,
      adapter: profile.adapter,
      workflowDigest: profile.workflowDigest,
      ...(profile.candidateDigest === undefined
        ? {}
        : { candidateDigest: profile.candidateDigest }),
    })),
    tasks: source.tasks
      .filter((task) => tuningTaskIds.has(task.id))
      .map((task) => ({
        id: task.id,
        trials: records
          .filter((record) => record.taskId === task.id)
          .map((record) => projectTrial(record)),
      })),
  };
  return parseTuningEvidencePacket({
    ...content,
    evidenceDigest: sha256(canonicalize(content)),
  });
}

export function parseTuningEvidencePacket(input: unknown): TuningEvidencePacket {
  const parsed = packetSchema.safeParse(input);
  if (!parsed.success) {
    throw new TuningEvidenceError(`invalid tuning evidence: ${boundedZodError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  const serializedBytes = Buffer.byteLength(canonicalize(parsed.data), "utf8") + 1;
  if (serializedBytes > MAX_TUNING_EVIDENCE_BYTES) {
    throw new TuningEvidenceError(
      `tuning evidence exceeds ${MAX_TUNING_EVIDENCE_BYTES} canonical UTF-8 bytes`,
    );
  }
  const { evidenceDigest, ...content } = parsed.data;
  if (evidenceDigest !== sha256(canonicalize(content))) {
    throw new TuningEvidenceError("tuning evidence digest does not match its content");
  }
  return deepFreeze(parsed.data);
}

function projectTrial(record: EvaluationTrialRecord): {
  readonly profileId: string;
  readonly seed: number;
  readonly repetition: number;
  readonly classification: EvaluationTrialRecord["classification"];
  readonly harness: {
    readonly outcome: EvaluationTrialRecord["harness"]["outcome"];
    readonly reason: string | null;
    readonly reasonTruncated: boolean;
  };
  readonly verification: {
    readonly outcome: EvaluationTrialRecord["verification"]["outcome"];
  };
  readonly metrics: EvaluationMetrics;
} {
  const metrics = Object.fromEntries(
    EVALUATION_NUMERIC_METRICS.map((name) => [name, record.metrics[name]]),
  ) as unknown as Omit<EvaluationMetrics, "recoveryOutcome">;
  const reason = boundedUtf8(record.harness.reason, MAX_TUNING_EVIDENCE_REASON_BYTES);
  return {
    profileId: record.profileId,
    seed: record.seed,
    repetition: record.repetition,
    classification: record.classification,
    harness: {
      outcome: record.harness.outcome,
      reason: reason.value,
      reasonTruncated: reason.truncated,
    },
    verification: { outcome: record.verification.outcome },
    metrics: { ...metrics, recoveryOutcome: record.metrics.recoveryOutcome },
  };
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
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
  throw new TuningEvidenceError("tuning evidence contains a non-canonical value");
}

function expectedClassification(
  harness:
    | "completed"
    | "failed"
    | "timed_out"
    | "crashed"
    | "cancelled"
    | "malformed_output"
    | "missing_output",
  verification: "accepted" | "rejected" | "error" | "not_run",
): "verified_success" | "false_completion" | "harness_failure" | "verifier_error" | null {
  if (harness !== "completed") {
    return verification === "not_run" ? "harness_failure" : null;
  }
  switch (verification) {
    case "accepted":
      return "verified_success";
    case "rejected":
      return "false_completion";
    case "error":
      return "verifier_error";
    case "not_run":
      return null;
  }
}

function sameStrings(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function boundedUtf8(
  value: string | null,
  maxBytes: number,
): { readonly value: string | null; readonly truncated: boolean } {
  if (value === null || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  const bytes = Buffer.from(value, "utf8");
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return {
        value: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        truncated: true,
      };
    } catch {
      // Continue until the bounded prefix ends at a complete UTF-8 code point.
    }
  }
  throw new TuningEvidenceError("tuning evidence reason cannot be truncated safely");
}

function boundedZodError(error: z.ZodError): string {
  const retained = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length === 0 ? "$" : issue.path.join(".");
    return `${path}: ${boundedText(issue.message, 512)}`;
  });
  return `${retained.join("; ")}${error.issues.length > retained.length ? "; additional diagnostics omitted" : ""}`;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
