import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { LeanProofRuntimeIdentity } from "../proof/lean-proof-verification.js";

export const LEAN_PROOF_QUALIFICATION_KIND = "lean-proof-qualification-v1" as const;
export const LEAN_PROOF_QUALIFICATION_REPORT_KIND = "lean-proof-qualification-report-v1" as const;
export const MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES = 1_048_576;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ociDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const reasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const metricSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtimeIdentitySchema = z
  .object({
    version: z.literal(1),
    platform: z.literal("linux"),
    architecture: z.literal("x64"),
    imageDigest: ociDigestSchema,
    buildAttestationDigest: sha256Schema,
    dependencyManifestDigest: sha256Schema,
    leanVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
    mathlibRevision: sha256Schema,
    safeVerifyRevision: sha256Schema,
    nanodaRevision: sha256Schema,
    profileDigest: sha256Schema,
  })
  .strict();
const taskSchema = z
  .object({
    id: identifierSchema,
    requestDigest: sha256Schema,
    specificationDigest: sha256Schema,
    statementDigest: sha256Schema,
  })
  .strict();
const proofSchema = z
  .object({
    verdict: z.enum(["accepted", "rejected", "inconclusive"]),
    reasonCode: reasonCodeSchema,
    compiler: z.enum(["accepted", "rejected", "unavailable"]),
    safeVerify: z.enum(["accepted", "rejected", "unavailable", "not_run"]),
    nanoda: z.enum(["accepted", "rejected", "unavailable", "not_run"]),
  })
  .strict();
const faithfulnessSchema = z
  .object({
    authority: z.enum(["human", "model"]),
    status: z.enum(["approved", "rejected"]),
    specificationDigest: sha256Schema,
    statementDigest: sha256Schema,
  })
  .strict();
const ordinaryTestsSchema = z
  .object({
    status: z.enum(["passed", "failed", "missing"]),
    suiteDigest: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "missing") !== (value.suiteDigest === null)) {
      context.addIssue({
        code: "custom",
        path: ["suiteDigest"],
        message: "must be null exactly when ordinary-test evidence is missing",
      });
    }
  });
const trialSchema = z
  .object({
    taskId: identifierSchema,
    requestDigest: sha256Schema,
    runtime: runtimeIdentitySchema,
    proof: proofSchema.nullable(),
    faithfulness: faithfulnessSchema.nullable(),
    ordinaryTests: ordinaryTestsSchema,
    costUsdMicros: metricSchema.nullable(),
    latencyMs: metricSchema.nullable(),
    policyFailures: z.array(reasonCodeSchema).max(64),
    cleanup: z.enum(["confirmed", "unconfirmed", "missing"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.policyFailures).size !== value.policyFailures.length) {
      context.addIssue({
        code: "custom",
        path: ["policyFailures"],
        message: "policy failure reason codes must be unique",
      });
    }
  });
const inputSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal(LEAN_PROOF_QUALIFICATION_KIND),
    qualificationId: identifierSchema,
    profile: z
      .object({
        profileDigest: sha256Schema,
        runtime: runtimeIdentitySchema,
      })
      .strict()
      .superRefine((value, context) => {
        if (value.profileDigest !== value.runtime.profileDigest) {
          context.addIssue({
            code: "custom",
            path: ["profileDigest"],
            message: "selected profile and runtime profile digests must match",
          });
        }
      }),
    tasks: z.array(taskSchema).min(1).max(256),
    trials: z.array(trialSchema).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const taskIds = value.tasks.map((task) => task.id);
    const requestDigests = value.tasks.map((task) => task.requestDigest);
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "declared task ids must be unique",
      });
    }
    if (new Set(requestDigests).size !== requestDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "declared request digests must be unique",
      });
    }
    const trialIds = value.trials.map((trial) => trial.taskId);
    if (
      trialIds.length !== taskIds.length ||
      new Set(trialIds).size !== trialIds.length ||
      taskIds.some((taskId) => !trialIds.includes(taskId)) ||
      trialIds.some((taskId) => !taskIds.includes(taskId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["trials"],
        message: "qualification requires exactly one trial per declared task",
      });
    }
  });

export type LeanProofQualificationInput = z.infer<typeof inputSchema>;

export type LeanProofQualificationMissingField =
  | "proof"
  | "statement_faithfulness"
  | "ordinary_tests"
  | "cost_usd_micros"
  | "latency_ms"
  | "cleanup";

export interface LeanProofQualificationFailure {
  readonly taskId: string;
  readonly reasonCode: string;
}

export interface LeanProofQualificationReport {
  readonly version: 1;
  readonly kind: typeof LEAN_PROOF_QUALIFICATION_REPORT_KIND;
  readonly qualificationId: string;
  readonly qualificationInputDigest: string;
  readonly profile: {
    readonly profileDigest: string;
    readonly runtime: LeanProofRuntimeIdentity;
  };
  readonly verdict: "qualified" | "not_qualified" | "insufficient_evidence";
  readonly coverage: {
    readonly tasks: number;
    readonly proofAccepted: number;
    readonly statementFaithfulnessApproved: number;
    readonly ordinaryTestsPassed: number;
    readonly costObserved: number;
    readonly latencyObserved: number;
  };
  readonly measurements: {
    readonly totalCostUsdMicros: number | null;
    readonly totalLatencyMs: number | null;
    readonly maximumLatencyMs: number | null;
  };
  readonly failures: {
    readonly proof: readonly LeanProofQualificationFailure[];
    readonly statementFaithfulness: readonly LeanProofQualificationFailure[];
    readonly ordinaryTests: readonly LeanProofQualificationFailure[];
    readonly policy: readonly LeanProofQualificationFailure[];
    readonly cleanup: readonly LeanProofQualificationFailure[];
  };
  readonly missing: readonly {
    readonly taskId: string;
    readonly field: LeanProofQualificationMissingField;
  }[];
  readonly taskResults: readonly {
    readonly taskId: string;
    readonly requestDigest: string;
    readonly specificationDigest: string;
    readonly statementDigest: string;
    readonly ordinaryTestSuiteDigest: string | null;
    readonly proof: "accepted" | "failed" | "missing";
    readonly statementFaithfulness: "approved" | "failed" | "missing";
    readonly ordinaryTests: "passed" | "failed" | "missing";
    readonly policy: "passed" | "failed";
    readonly cleanup: "confirmed" | "failed" | "missing";
    readonly costUsdMicros: number | null;
    readonly latencyMs: number | null;
  }[];
  readonly reportDigest: string;
}

export class LeanProofQualificationError extends Error {
  override readonly name = "LeanProofQualificationError";
}

export function parseLeanProofQualificationInput(input: unknown): LeanProofQualificationInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LeanProofQualificationError(
      `Lean proof qualification input is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function qualifyLeanProofProfile(input: unknown): LeanProofQualificationReport {
  const admitted = parseLeanProofQualificationInput(input);
  const proofFailures: LeanProofQualificationFailure[] = [];
  const faithfulnessFailures: LeanProofQualificationFailure[] = [];
  const ordinaryTestFailures: LeanProofQualificationFailure[] = [];
  const policyFailures: LeanProofQualificationFailure[] = [];
  const cleanupFailures: LeanProofQualificationFailure[] = [];
  const missing: Array<{
    taskId: string;
    field: LeanProofQualificationMissingField;
  }> = [];
  const taskResults: Array<LeanProofQualificationReport["taskResults"][number]> = [];

  for (const task of admitted.tasks) {
    const trial = admitted.trials.find((candidate) => candidate.taskId === task.id);
    if (trial === undefined) {
      throw new LeanProofQualificationError(
        "Lean proof qualification input is invalid: qualification requires exactly one trial per declared task",
      );
    }

    const requestIdentityMatches = trial.requestDigest === task.requestDigest;
    const runtimeIdentityMatches = isDeepStrictEqual(trial.runtime, admitted.profile.runtime);
    if (!requestIdentityMatches) {
      proofFailures.push(failure(task.id, "request_identity_mismatch"));
    }
    if (!runtimeIdentityMatches) {
      proofFailures.push(failure(task.id, "runtime_identity_mismatch"));
    }

    const evaluatedProofState = evaluateProof(task.id, trial.proof, proofFailures, missing);
    const proofState =
      requestIdentityMatches && runtimeIdentityMatches ? evaluatedProofState : "failed";
    const faithfulnessState = evaluateFaithfulness(
      task,
      trial.faithfulness,
      faithfulnessFailures,
      missing,
    );
    const ordinaryTestsState = evaluateOrdinaryTests(
      task.id,
      trial.ordinaryTests.status,
      ordinaryTestFailures,
      missing,
    );
    for (const reasonCode of trial.policyFailures) {
      policyFailures.push(failure(task.id, reasonCode));
    }
    if (trial.costUsdMicros === null) missing.push(missingField(task.id, "cost_usd_micros"));
    if (trial.latencyMs === null) missing.push(missingField(task.id, "latency_ms"));
    if (trial.cleanup === "unconfirmed") {
      cleanupFailures.push(failure(task.id, "cleanup_unconfirmed"));
    } else if (trial.cleanup === "missing") {
      missing.push(missingField(task.id, "cleanup"));
    }

    taskResults.push(
      Object.freeze({
        taskId: task.id,
        requestDigest: task.requestDigest,
        specificationDigest: task.specificationDigest,
        statementDigest: task.statementDigest,
        ordinaryTestSuiteDigest: trial.ordinaryTests.suiteDigest,
        proof: proofState,
        statementFaithfulness: faithfulnessState,
        ordinaryTests: ordinaryTestsState,
        policy: trial.policyFailures.length === 0 ? "passed" : "failed",
        cleanup:
          trial.cleanup === "confirmed"
            ? "confirmed"
            : trial.cleanup === "missing"
              ? "missing"
              : "failed",
        costUsdMicros: trial.costUsdMicros,
        latencyMs: trial.latencyMs,
      }),
    );
  }

  const costs = admitted.trials.flatMap((trial) =>
    trial.costUsdMicros === null ? [] : [trial.costUsdMicros],
  );
  const latencies = admitted.trials.flatMap((trial) =>
    trial.latencyMs === null ? [] : [trial.latencyMs],
  );
  const hasFailures =
    proofFailures.length > 0 ||
    faithfulnessFailures.length > 0 ||
    ordinaryTestFailures.length > 0 ||
    policyFailures.length > 0 ||
    cleanupFailures.length > 0;
  const content = {
    version: 1 as const,
    kind: LEAN_PROOF_QUALIFICATION_REPORT_KIND,
    qualificationId: admitted.qualificationId,
    qualificationInputDigest: sha256(canonicalize(admitted)),
    profile: structuredClone(admitted.profile),
    verdict: hasFailures
      ? ("not_qualified" as const)
      : missing.length > 0
        ? ("insufficient_evidence" as const)
        : ("qualified" as const),
    coverage: {
      tasks: admitted.tasks.length,
      proofAccepted: taskResults.filter((result) => result.proof === "accepted").length,
      statementFaithfulnessApproved: taskResults.filter(
        (result) => result.statementFaithfulness === "approved",
      ).length,
      ordinaryTestsPassed: taskResults.filter((result) => result.ordinaryTests === "passed").length,
      costObserved: costs.length,
      latencyObserved: latencies.length,
    },
    measurements: {
      totalCostUsdMicros:
        costs.length === admitted.tasks.length ? checkedTotal(costs, "cost") : null,
      totalLatencyMs:
        latencies.length === admitted.tasks.length ? checkedTotal(latencies, "latency") : null,
      maximumLatencyMs: latencies.length === admitted.tasks.length ? Math.max(...latencies) : null,
    },
    failures: {
      proof: proofFailures,
      statementFaithfulness: faithfulnessFailures,
      ordinaryTests: ordinaryTestFailures,
      policy: policyFailures,
      cleanup: cleanupFailures,
    },
    missing,
    taskResults,
  };
  return deepFreeze({ ...content, reportDigest: sha256(canonicalize(content)) });
}

function evaluateProof(
  taskId: string,
  proof: LeanProofQualificationInput["trials"][number]["proof"],
  failures: LeanProofQualificationFailure[],
  missing: Array<{ taskId: string; field: LeanProofQualificationMissingField }>,
): "accepted" | "failed" | "missing" {
  if (proof === null) {
    missing.push(missingField(taskId, "proof"));
    return "missing";
  }
  if (
    proof.verdict !== "accepted" ||
    proof.reasonCode !== "proof_accepted" ||
    proof.compiler !== "accepted" ||
    proof.safeVerify !== "accepted" ||
    proof.nanoda !== "accepted"
  ) {
    failures.push(
      failure(
        taskId,
        proof.verdict === "accepted" ? "proof_evidence_inconsistent" : proof.reasonCode,
      ),
    );
    return "failed";
  }
  return "accepted";
}

function evaluateFaithfulness(
  task: LeanProofQualificationInput["tasks"][number],
  faithfulness: LeanProofQualificationInput["trials"][number]["faithfulness"],
  failures: LeanProofQualificationFailure[],
  missing: Array<{ taskId: string; field: LeanProofQualificationMissingField }>,
): "approved" | "failed" | "missing" {
  if (faithfulness === null) {
    missing.push(missingField(task.id, "statement_faithfulness"));
    return "missing";
  }
  if (faithfulness.authority !== "human") {
    failures.push(failure(task.id, "human_approval_required"));
    return "failed";
  }
  if (faithfulness.status !== "approved") {
    failures.push(failure(task.id, "statement_faithfulness_rejected"));
    return "failed";
  }
  if (
    faithfulness.specificationDigest !== task.specificationDigest ||
    faithfulness.statementDigest !== task.statementDigest
  ) {
    failures.push(failure(task.id, "faithfulness_identity_mismatch"));
    return "failed";
  }
  return "approved";
}

function evaluateOrdinaryTests(
  taskId: string,
  status: LeanProofQualificationInput["trials"][number]["ordinaryTests"]["status"],
  failures: LeanProofQualificationFailure[],
  missing: Array<{ taskId: string; field: LeanProofQualificationMissingField }>,
): "passed" | "failed" | "missing" {
  if (status === "missing") {
    missing.push(missingField(taskId, "ordinary_tests"));
    return "missing";
  }
  if (status === "failed") {
    failures.push(failure(taskId, "tests_failed"));
    return "failed";
  }
  return "passed";
}

function failure(taskId: string, reasonCode: string): LeanProofQualificationFailure {
  return Object.freeze({ taskId, reasonCode });
}

function missingField(
  taskId: string,
  field: LeanProofQualificationMissingField,
): { readonly taskId: string; readonly field: LeanProofQualificationMissingField } {
  return Object.freeze({ taskId, field });
}

function checkedTotal(values: readonly number[], name: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new LeanProofQualificationError(`${name} total exceeds the safe integer limit`);
    }
  }
  return total;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new LeanProofQualificationError(
        "Lean proof qualification contains a non-canonical number",
      );
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
  throw new LeanProofQualificationError("Lean proof qualification contains a non-canonical value");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
