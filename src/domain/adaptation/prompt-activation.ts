import { createHash } from "node:crypto";

import { z } from "zod";
import { compileWorkflowText, WorkflowCompilationError } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";
import { type PromptCandidateIdentity, parsePromptCandidateIdentity } from "./prompt-candidate.js";

export const MAX_PROMPT_ACTIVATION_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_ACTIVATION_ERROR_BYTES = 16 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rateSchema = z.number().min(0).max(1);
const signedRateSchema = z.number().min(-1).max(1);

const criteriaSchema = z
  .object({
    minimumPairedTrials: positiveSafeIntegerSchema,
    confidenceLevel: z.literal(0.95),
    minimumEffect: rateSchema,
    maxFalseCompletionRate: rateSchema,
    maxPolicyViolations: nonNegativeSafeIntegerSchema,
    maxVerifiedSuccessRegression: rateSchema,
  })
  .strict();

const comparisonSchema = z
  .object({
    verdict: z.literal("superior"),
    scheduledPairs: positiveSafeIntegerSchema,
    completePairs: positiveSafeIntegerSchema,
    comparablePairs: positiveSafeIntegerSchema,
    pairedSuccessDelta: signedRateSchema,
    confidenceInterval: z
      .object({ lower: signedRateSchema, upper: signedRateSchema, level: z.literal(0.95) })
      .strict(),
    constraints: z
      .object({
        falseCompletionRate: z.literal(true),
        policyViolations: z.literal(true),
        verifiedSuccessRegression: z.literal(true),
      })
      .strict(),
  })
  .strict();

const evaluationProofSchema = z
  .object({
    evaluationId: identifierSchema,
    planDigest: sha256Schema,
    terminalRecordDigest: sha256Schema,
    reportDigest: sha256Schema,
    baselineProfileId: identifierSchema,
    candidateProfileId: identifierSchema,
    scheduledTrials: positiveSafeIntegerSchema,
    committedTrials: positiveSafeIntegerSchema,
    criteria: criteriaSchema,
    comparison: comparisonSchema,
  })
  .strict()
  .superRefine((proof, context) => {
    if (proof.baselineProfileId === proof.candidateProfileId) {
      context.addIssue({ code: "custom", message: "evaluation profile ids must differ" });
    }
    if (proof.committedTrials !== proof.scheduledTrials) {
      context.addIssue({ code: "custom", message: "evaluation must be complete" });
    }
    if (
      proof.comparison.completePairs !== proof.comparison.scheduledPairs ||
      proof.comparison.comparablePairs !== proof.comparison.scheduledPairs
    ) {
      context.addIssue({ code: "custom", message: "evaluation pairs must be complete" });
    }
    if (proof.comparison.comparablePairs < proof.criteria.minimumPairedTrials) {
      context.addIssue({ code: "custom", message: "evaluation has too few comparable pairs" });
    }
    if (proof.comparison.scheduledPairs > Math.floor(proof.scheduledTrials / 2)) {
      context.addIssue({ code: "custom", message: "evaluation pair count exceeds trial count" });
    }
    if (
      proof.comparison.confidenceInterval.lower <= proof.criteria.minimumEffect ||
      proof.comparison.confidenceInterval.lower > proof.comparison.confidenceInterval.upper
    ) {
      context.addIssue({ code: "custom", message: "evaluation confidence interval is invalid" });
    }
  });

export interface PromptActivationEvaluationProof {
  readonly evaluationId: string;
  readonly planDigest: string;
  readonly terminalRecordDigest: string;
  readonly reportDigest: string;
  readonly baselineProfileId: string;
  readonly candidateProfileId: string;
  readonly scheduledTrials: number;
  readonly committedTrials: number;
  readonly criteria: {
    readonly minimumPairedTrials: number;
    readonly confidenceLevel: 0.95;
    readonly minimumEffect: number;
    readonly maxFalseCompletionRate: number;
    readonly maxPolicyViolations: number;
    readonly maxVerifiedSuccessRegression: number;
  };
  readonly comparison: {
    readonly verdict: "superior";
    readonly scheduledPairs: number;
    readonly completePairs: number;
    readonly comparablePairs: number;
    readonly pairedSuccessDelta: number;
    readonly confidenceInterval: {
      readonly lower: number;
      readonly upper: number;
      readonly level: 0.95;
    };
    readonly constraints: {
      readonly falseCompletionRate: true;
      readonly policyViolations: true;
      readonly verifiedSuccessRegression: true;
    };
  };
}

export interface PromptActivationSnapshot {
  readonly version: 1;
  readonly kind: "prompt-activation";
  readonly selection: "baseline" | "candidate";
  readonly workflowId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly candidate: PromptCandidateIdentity;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly source: {
    readonly bytes: number;
    readonly sha256: string;
    readonly contentBase64: string;
  };
  readonly activationDigest: string;
}

export interface PromptActivationLocator {
  readonly workflowId: string;
}

export function parsePromptActivationLocator(value: string): PromptActivationLocator | null {
  if (!value.startsWith("activation:")) {
    return null;
  }
  const workflowId = /^activation:([^:]+)$/.exec(value)?.[1];
  if (workflowId === undefined || !identifierSchema.safeParse(workflowId).success) {
    throw new Error('activation locators must use "activation:<workflow-id>"');
  }
  return Object.freeze({ workflowId });
}

export interface CreatePromptActivationSnapshotInput {
  readonly selection: "baseline" | "candidate";
  readonly candidate: PromptCandidateIdentity;
  readonly evaluation: PromptActivationEvaluationProof;
  readonly source: string;
}

export type PromptActivationErrorCode =
  | "identity_mismatch"
  | "invalid_schema"
  | "invalid_source"
  | "limit_exceeded";

export class PromptActivationError extends Error {
  override readonly name = "PromptActivationError";

  constructor(
    readonly code: PromptActivationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedMessage(message)}`, options);
  }
}

const promptActivationSnapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("prompt-activation"),
    selection: z.enum(["baseline", "candidate"]),
    workflowId: identifierSchema,
    candidateId: identifierSchema,
    candidateVersion: semverSchema,
    candidate: z.unknown(),
    evaluation: evaluationProofSchema,
    source: z
      .object({
        bytes: z.number().int().positive().max(MAX_PROMPT_ACTIVATION_SOURCE_BYTES),
        sha256: sha256Schema,
        contentBase64: z.string().max(Math.ceil((MAX_PROMPT_ACTIVATION_SOURCE_BYTES * 4) / 3) + 4),
      })
      .strict(),
    activationDigest: sha256Schema,
  })
  .strict();

export function createPromptActivationSnapshot(
  input: CreatePromptActivationSnapshotInput,
): PromptActivationSnapshot {
  const candidate = parsePromptCandidateIdentity(input.candidate);
  const evaluation = parseEvaluationProof(input.evaluation);
  const content = Buffer.from(input.source, "utf8");
  if (content.byteLength > MAX_PROMPT_ACTIVATION_SOURCE_BYTES) {
    throw new PromptActivationError(
      "limit_exceeded",
      `activation source exceeds ${MAX_PROMPT_ACTIVATION_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  const sourceSha256 = sha256(content);
  let workflowDigest: string;
  let workflowId: string;
  try {
    const compiled = compileWorkflowText(input.source, "prompt activation source");
    workflowDigest = calculateWorkflowDigest(compiled);
    workflowId = compiled.id;
  } catch (error) {
    throw new PromptActivationError(
      "invalid_source",
      error instanceof WorkflowCompilationError
        ? "activation source is not a valid workflow"
        : error instanceof Error
          ? error.message
          : String(error),
      { cause: error },
    );
  }
  const expectedSource =
    input.selection === "candidate" ? candidate.projectedWorkflow : candidate.baseline;
  if (
    candidate.scope.workflowId !== workflowId ||
    expectedSource.sourceSha256 !== sourceSha256 ||
    expectedSource.workflowDigest !== workflowDigest
  ) {
    throw new PromptActivationError(
      "identity_mismatch",
      `activation source does not match the evaluated ${input.selection} workflow`,
    );
  }
  const snapshotWithoutDigest = {
    version: 1 as const,
    kind: "prompt-activation" as const,
    selection: input.selection,
    workflowId,
    candidateId: candidate.id,
    candidateVersion: candidate.candidateVersion,
    candidate,
    evaluation,
    source: {
      bytes: content.byteLength,
      sha256: sourceSha256,
      contentBase64: content.toString("base64"),
    },
  };
  return parsePromptActivationSnapshot({
    ...snapshotWithoutDigest,
    activationDigest: calculatePromptActivationDigest(snapshotWithoutDigest),
  });
}

export function parsePromptActivationSnapshot(input: unknown): PromptActivationSnapshot {
  const parsed = promptActivationSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new PromptActivationError(
      "invalid_schema",
      `activation snapshot is invalid: ${boundedIssues(parsed.error.issues)}`,
      { cause: parsed.error },
    );
  }
  const candidate = parsePromptCandidateIdentity(parsed.data.candidate);
  const expectedSource =
    parsed.data.selection === "candidate" ? candidate.projectedWorkflow : candidate.baseline;
  const content = decodeCanonicalBase64(parsed.data.source.contentBase64);
  if (
    content.byteLength !== parsed.data.source.bytes ||
    sha256(content) !== parsed.data.source.sha256
  ) {
    throw new PromptActivationError(
      "identity_mismatch",
      "activation source byte count or digest does not match",
    );
  }
  if (
    parsed.data.workflowId !== candidate.scope.workflowId ||
    parsed.data.candidateId !== candidate.id ||
    parsed.data.candidateVersion !== candidate.candidateVersion ||
    parsed.data.source.sha256 !== expectedSource.sourceSha256
  ) {
    throw new PromptActivationError(
      "identity_mismatch",
      "activation snapshot does not match its candidate identity",
    );
  }
  let compiledWorkflowId: string;
  let compiledWorkflowDigest: string;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const compiled = compileWorkflowText(source, "saved prompt activation source");
    compiledWorkflowId = compiled.id;
    compiledWorkflowDigest = calculateWorkflowDigest(compiled);
  } catch (error) {
    throw new PromptActivationError(
      "invalid_source",
      "saved activation source is not a valid UTF-8 workflow",
      { cause: error },
    );
  }
  if (
    compiledWorkflowId !== parsed.data.workflowId ||
    compiledWorkflowDigest !== expectedSource.workflowDigest
  ) {
    throw new PromptActivationError(
      "identity_mismatch",
      `activation source workflow digest does not match the evaluated ${parsed.data.selection} selection`,
    );
  }
  const snapshot: PromptActivationSnapshot = {
    ...parsed.data,
    candidate,
    evaluation: parseEvaluationProof(parsed.data.evaluation),
  };
  if (calculatePromptActivationDigest(snapshot) !== snapshot.activationDigest) {
    throw new PromptActivationError(
      "identity_mismatch",
      "activation snapshot digest does not match",
    );
  }
  return deepFreeze(snapshot);
}

export function calculatePromptActivationDigest(
  snapshot: Omit<PromptActivationSnapshot, "activationDigest"> | PromptActivationSnapshot,
): string {
  return sha256(
    canonicalize({
      version: snapshot.version,
      kind: snapshot.kind,
      selection: snapshot.selection,
      workflowId: snapshot.workflowId,
      candidateId: snapshot.candidateId,
      candidateVersion: snapshot.candidateVersion,
      candidate: snapshot.candidate,
      evaluation: snapshot.evaluation,
      source: { bytes: snapshot.source.bytes, sha256: snapshot.source.sha256 },
    }),
  );
}

export function promptActivationSource(snapshot: PromptActivationSnapshot): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    decodeCanonicalBase64(snapshot.source.contentBase64),
  );
}

function parseEvaluationProof(input: unknown): PromptActivationEvaluationProof {
  const parsed = evaluationProofSchema.safeParse(input);
  if (!parsed.success) {
    throw new PromptActivationError(
      "invalid_schema",
      `activation evaluation proof is invalid: ${boundedIssues(parsed.error.issues)}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new PromptActivationError("invalid_source", "activation source is not canonical base64");
  }
  return content;
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
  throw new PromptActivationError("invalid_schema", "activation value is not canonical JSON");
}

function boundedIssues(issues: readonly z.core.$ZodIssue[]): string {
  return boundedMessage(
    issues
      .slice(0, 16)
      .map(
        (issue) =>
          `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${boundedText(issue.message, 512)}`,
      )
      .join("; "),
  );
}

function boundedMessage(value: string): string {
  return boundedText(value, MAX_PROMPT_ACTIVATION_ERROR_BYTES);
}

function boundedText(value: string, bytes: number): string {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength <= bytes) {
    return value;
  }
  return `${content.subarray(0, Math.max(0, bytes - 3)).toString("utf8")}...`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
