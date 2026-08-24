import { createHash } from "node:crypto";
import { z } from "zod";

import type { EvaluationTrialScheduleItem } from "./plan.js";
import { modelUsageObservationSchema } from "../run/budget.js";

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
  readonly contextCompaction?: ContextCompactionEvaluationMetrics | undefined;
}

export interface ContextCompactionEvaluationMetrics {
  readonly mode: "none" | "references" | "references-and-summary";
  readonly providerRequestBytes: number;
  readonly providerRequestEstimatedTokens: number;
  readonly attempts: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly interrupted: number;
  readonly summaryInputTokens: number | null;
  readonly summaryOutputTokens: number | null;
  readonly summaryCostUsdMicros: number | null;
  readonly artifactReopenAttempts: number;
  readonly artifactReopenSuccesses: number;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(64);
const trialIdSchema = z.string().regex(/^trial-[a-f0-9]{48}$/);
const boundedTextSchema = z.string().max(4_096);
const acpAgentNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const optionalMetricSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const contextCompactionMetricsSchema = z
  .object({
    mode: z.enum(["none", "references", "references-and-summary"]),
    providerRequestBytes: nonNegativeMetricSchema(),
    providerRequestEstimatedTokens: nonNegativeMetricSchema(),
    attempts: nonNegativeMetricSchema(),
    accepted: nonNegativeMetricSchema(),
    rejected: nonNegativeMetricSchema(),
    interrupted: nonNegativeMetricSchema(),
    summaryInputTokens: optionalMetricSchema,
    summaryOutputTokens: optionalMetricSchema,
    summaryCostUsdMicros: optionalMetricSchema,
    artifactReopenAttempts: nonNegativeMetricSchema(),
    artifactReopenSuccesses: nonNegativeMetricSchema(),
  })
  .strict()
  .superRefine((metrics, context) => {
    const summaryUsage = [
      metrics.summaryInputTokens,
      metrics.summaryOutputTokens,
      metrics.summaryCostUsdMicros,
    ];
    if (
      summaryUsage.some((value) => value === null) &&
      !summaryUsage.every((value) => value === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["summaryInputTokens"],
        message: "summary usage metrics must be entirely available or unavailable",
      });
    }
    if (metrics.accepted + metrics.rejected + metrics.interrupted > metrics.attempts) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "settled compaction outcomes cannot exceed attempts",
      });
    }
    if (metrics.artifactReopenSuccesses > metrics.artifactReopenAttempts) {
      context.addIssue({
        code: "custom",
        path: ["artifactReopenSuccesses"],
        message: "artifact reopen successes cannot exceed attempts",
      });
    }
    if (
      metrics.mode !== "references-and-summary" &&
      (metrics.attempts !== 0 ||
        metrics.accepted !== 0 ||
        metrics.rejected !== 0 ||
        metrics.interrupted !== 0 ||
        summaryUsage.some((value) => value !== 0))
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "summary evidence requires references-and-summary mode",
      });
    }
    if (metrics.attempts === 0 && summaryUsage.some((value) => value !== 0)) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "zero summary attempts require measured zero summary usage",
      });
    }
  });

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
    contextCompaction: contextCompactionMetricsSchema.optional(),
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

function nonNegativeMetricSchema() {
  return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
}

const filesystemAssertionEvidenceSchema = z
  .object({
    kind: z.enum(["exists", "absent", "sha256"]),
    path: z.string().min(1).max(1_024),
    outcome: z.boolean(),
    observedSha256: sha256Schema.optional(),
    reason: boundedTextSchema.optional(),
  })
  .strict();

const agentResultAssertionEvidenceSchema = z
  .object({
    kind: z.literal("agent-result"),
    outcome: z.boolean(),
    observedSha256: sha256Schema.optional(),
    observedBytes: z.number().int().positive().max(262_144).optional(),
    reason: boundedTextSchema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const hasObservation =
      evidence.observedSha256 !== undefined && evidence.observedBytes !== undefined;
    if (evidence.outcome && !hasObservation) {
      context.addIssue({
        code: "custom",
        message: "accepted agent-result evidence requires its observed digest and byte count",
      });
    }
    if ((evidence.observedSha256 === undefined) !== (evidence.observedBytes === undefined)) {
      context.addIssue({
        code: "custom",
        message: "agent-result digest and byte count must be observed together",
      });
    }
  });

const assertionEvidenceSchema = z.union([
  filesystemAssertionEvidenceSchema,
  agentResultAssertionEvidenceSchema,
]);

const processRuntimeEvidenceSchema = z
  .object({
    adapter: z.enum(["pi-native-v1", "omp-native-v1"]),
    containment: z.enum(["linux-pid-namespace", "process-group"]),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    treeTermination: z.enum(["confirmed", "unconfirmed"]),
  })
  .strict();

const primeRuntimeEvidenceSchema = z
  .object({
    adapter: z.literal("prime-agent-native-v1"),
    containment: z.literal("docker-oci-v1"),
    engineStatus: z.literal("verified"),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    policyDigest: sha256Schema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    recoveryOutcome: z.enum(["not_attempted", "succeeded", "failed"]),
    removal: z.enum(["confirmed", "unconfirmed"]),
  })
  .strict();

const externalRuntimeEvidenceSchema = z
  .discriminatedUnion("adapter", [processRuntimeEvidenceSchema, primeRuntimeEvidenceSchema])
  .superRefine((runtime, context) => {
    if (runtime.adapter === "prime-agent-native-v1") {
      if (runtime.timedOut && runtime.aborted) {
        context.addIssue({
          code: "custom",
          path: ["aborted"],
          message: "external OCI evidence cannot be both timed out and aborted",
        });
      }
      return;
    }
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
    if (runtime.adapter === "prime-agent-native-v1") {
      if (
        runtime.engineStatus !== "verified" ||
        runtime.exitCode !== 0 ||
        runtime.timedOut ||
        runtime.aborted ||
        runtime.recoveryOutcome === "failed" ||
        runtime.removal !== "confirmed"
      ) {
        context.addIssue({
          code: "custom",
          path: ["runtime"],
          message: "completed Prime OCI evidence requires verified exit and removal",
        });
      }
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

const acpQualificationObservationSchema = z
  .object({
    version: z.literal(1),
    workflowDigest: sha256Schema,
    capabilitySnapshotDigest: sha256Schema,
    agent: z
      .object({
        name: acpAgentNameSchema,
        digest: sha256Schema,
      })
      .strict(),
    result: z
      .object({
        sha256: sha256Schema,
        bytes: z.number().int().positive().max(262_144),
      })
      .strict(),
    durationMs: nonNegativeMetricSchema(),
    activity: z
      .object({
        turns: nonNegativeMetricSchema(),
        toolCalls: nonNegativeMetricSchema(),
        toolErrors: nonNegativeMetricSchema(),
      })
      .strict()
      .refine((activity) => activity.toolErrors <= activity.toolCalls, {
        message: "ACP qualification tool errors cannot exceed tool calls",
      }),
    policyViolations: nonNegativeMetricSchema(),
    terminationStatus: z.enum(["confirmed", "unconfirmed"]),
    processContainment: z.enum(["linux-pid-namespace", "process-group"]),
    sandbox: z
      .object({
        backend: z.string().min(1).max(128),
        backendVersion: z.string().min(1).max(128),
        profile: z.string().min(1).max(128),
        policyDigest: sha256Schema,
      })
      .strict(),
    usage: modelUsageObservationSchema,
    usageProvenance: z
      .object({
        modelTokens: z.enum(["prompt-response", "declared-unavailable", "not-observed"]),
        costUsd: z.enum(["session-usage-update", "declared-unavailable", "not-observed"]),
      })
      .strict(),
    authorityViolation: z
      .enum([
        "permission",
        "filesystem",
        "terminal",
        "elicitation",
        "mcp",
        "tool",
        "extension",
        "undeclared_client_method",
      ])
      .optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    const tokenComplete = observation.usage.modelTokens.status === "complete";
    const costComplete = observation.usage.costUsd.status === "complete";
    if (tokenComplete !== (observation.usageProvenance.modelTokens === "prompt-response")) {
      context.addIssue({
        code: "custom",
        path: ["usageProvenance", "modelTokens"],
        message: "ACP qualification token provenance contradicts its usage observation",
      });
    }
    if (costComplete !== (observation.usageProvenance.costUsd === "session-usage-update")) {
      context.addIssue({
        code: "custom",
        path: ["usageProvenance", "costUsd"],
        message: "ACP qualification cost provenance contradicts its usage observation",
      });
    }
    if (observation.sandbox.profile !== "acp-prompt-only-v1") {
      context.addIssue({
        code: "custom",
        path: ["sandbox", "profile"],
        message: "ACP qualification requires the prompt-only sandbox profile",
      });
    }
  });

const phaseRoutingObservationSchema = z
  .object({
    version: z.literal(1),
    profileDigest: sha256Schema,
    requestCount: z.number().int().positive().max(1_024),
    settledRequestCount: z.number().int().nonnegative().max(1_024),
    decisionDigests: z.array(sha256Schema).min(1).max(1_024),
    costUsdMicros: optionalMetricSchema,
    latencyMs: optionalMetricSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.settledRequestCount > observation.requestCount) {
      context.addIssue({
        code: "custom",
        path: ["settledRequestCount"],
        message: "settled requests cannot exceed prepared requests",
      });
    }
    if (observation.decisionDigests.length !== observation.requestCount) {
      context.addIssue({
        code: "custom",
        path: ["decisionDigests"],
        message: "every prepared request requires one phase-routing decision digest",
      });
    }
    if (
      observation.latencyMs !== null &&
      observation.settledRequestCount !== observation.requestCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["latencyMs"],
        message: "complete latency requires every prepared request to settle",
      });
    }
  });

const delegationResourceSchema = z
  .object({
    nodeStarts: nonNegativeMetricSchema(),
    modelTokens: nonNegativeMetricSchema(),
    modelCostUsdMicros: nonNegativeMetricSchema(),
    executionMs: nonNegativeMetricSchema(),
    artifactBytes: nonNegativeMetricSchema(),
  })
  .strict();

const delegationObservationSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["baseline", "candidate"]),
    workflowDigest: sha256Schema,
    packageClosureDigest: sha256Schema,
    manager: z
      .object({
        nodeId: identifierSchema,
        attempt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        outcome: z.enum(["pending", "running", "succeeded", "failed", "omitted"]),
      })
      .strict(),
    authority: z
      .object({
        candidateDigest: sha256Schema,
        snapshotDigest: sha256Schema,
        executorIdentityDigest: sha256Schema,
        maxDepth: z.literal(1),
        maxCalls: z.literal(1),
      })
      .strict()
      .nullable(),
    invocation: z
      .object({
        count: z.union([z.literal(0), z.literal(1)]),
        prepared: z.boolean(),
        settled: z.boolean(),
        receipt: z.boolean(),
        child: z
          .object({
            runId: identifierSchema,
            workflowId: identifierSchema,
            workflowDigest: sha256Schema,
            resultNodeId: identifierSchema.nullable(),
            resultSchemaDigest: sha256Schema.nullable(),
            resultValueHash: sha256Schema.nullable(),
            terminalSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            outcome: z.enum(["succeeded", "failed", "cancelled", "resource_exhausted"]),
            resources: delegationResourceSchema,
            resourceAvailability: z
              .object({
                modelTokens: z.enum(["complete", "unavailable"]),
                modelCostUsdMicros: z.enum(["complete", "unavailable"]),
              })
              .strict()
              .optional(),
            durationMs: nonNegativeMetricSchema(),
            workspaceDisposition: z.enum(["discarded", "retained"]),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    constraints: z
      .object({
        complete: z.boolean(),
        violations: z
          .array(
            z.enum([
              "manager_target",
              "call_limit",
              "settlement",
              "receipt",
              "child_identity",
              "child_outcome",
              "typed_result",
              "workspace_cleanup",
              "resource_accounting",
              "authority_attenuation",
            ]),
          )
          .max(10)
          .refine((items) => new Set(items).size === items.length),
      })
      .strict(),
  })
  .strict()
  .superRefine((observation, context) => {
    const invoked = observation.invocation.count === 1;
    if (
      invoked !== observation.invocation.prepared ||
      observation.invocation.settled !== (observation.invocation.child !== null) ||
      observation.invocation.receipt !== observation.invocation.settled ||
      (!invoked &&
        (observation.invocation.settled ||
          observation.invocation.receipt ||
          observation.invocation.child !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "delegation lifecycle observation is contradictory",
      });
    }
    if ((observation.mode === "baseline") !== (observation.authority === null)) {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "delegation authority contradicts the evaluation mode",
      });
    }
    if (observation.mode === "baseline" && invoked) {
      context.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "baseline delegation observation cannot report an invocation",
      });
    }
    const availability = observation.invocation.child?.resourceAvailability;
    const resourceAccountingComplete =
      availability === undefined ||
      (availability.modelTokens === "complete" && availability.modelCostUsdMicros === "complete");
    if (
      observation.constraints.complete &&
      ((invoked && !observation.invocation.settled) || !resourceAccountingComplete)
    ) {
      context.addIssue({
        code: "custom",
        path: ["constraints", "complete"],
        message:
          "delegation evidence cannot be complete with an open lifecycle or unavailable resource accounting",
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
    qualification: acpQualificationObservationSchema.optional(),
    phaseRouting: phaseRoutingObservationSchema.optional(),
    delegation: delegationObservationSchema.optional(),
    previousDigest: sha256Schema.nullable(),
    recordDigest: sha256Schema,
  })
  .strict();

export type EvaluationTrialRecord = z.infer<typeof trialRecordSchema>;
export type EvaluationHarnessOutcome = EvaluationTrialRecord["harness"];
export type EvaluationVerificationOutcome = EvaluationTrialRecord["verification"];
export type EvaluationEnvironment = EvaluationTrialRecord["environment"];
export type AcpQualificationObservation = z.infer<typeof acpQualificationObservationSchema>;
export type PhaseRoutingObservation = z.infer<typeof phaseRoutingObservationSchema>;
export type DelegationEvaluationObservation = z.infer<typeof delegationObservationSchema>;

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
  readonly qualification?: AcpQualificationObservation;
  readonly phaseRouting?: PhaseRoutingObservation;
  readonly delegation?: DelegationEvaluationObservation;
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

export function parseAcpQualificationObservation(input: unknown): AcpQualificationObservation {
  return parseEvidence(acpQualificationObservationSchema, input, "ACP qualification observation");
}

export function parsePhaseRoutingObservation(input: unknown): PhaseRoutingObservation {
  return parseEvidence(phaseRoutingObservationSchema, input, "phase-routing observation");
}

export function parseDelegationEvaluationObservation(
  input: unknown,
): DelegationEvaluationObservation {
  return parseEvidence(delegationObservationSchema, input, "delegation observation");
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
    ...(input.qualification === undefined ? {} : { qualification: input.qualification }),
    ...(input.phaseRouting === undefined ? {} : { phaseRouting: input.phaseRouting }),
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
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
  if (
    parsed.data.phaseRouting !== undefined &&
    parsed.data.phaseRouting.costUsdMicros !== parsed.data.metrics.costUsdMicros
  ) {
    throw new EvaluationRecordError("phase-routing accounting contradicts the trial cost metrics");
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
