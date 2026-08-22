import { createHash } from "node:crypto";

import { z } from "zod";

import {
  type ArtifactReference,
  artifactReferenceSchema,
  validateArtifactReference,
} from "../artifact/reference.js";

export const CONTEXT_COMPACTION_MODES = ["none", "references", "references-and-summary"] as const;
export const MIN_REFERENCE_TOOL_RESULT_BYTES = 4 * 1024;

export type ContextCompactionMode = (typeof CONTEXT_COMPACTION_MODES)[number];

export interface ReferenceProjectionIdentity {
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface ReferenceArtifactInspection {
  readonly reference: ArtifactReference;
  readonly retention: "retained" | "released";
  readonly availability: "available" | "missing" | "changed" | "pruned";
}

export type ReferenceProjectionReason =
  | "reference_projection"
  | "below_threshold"
  | "structured_details_invalid"
  | "artifact_invalid"
  | "artifact_unavailable"
  | "no_artifact_reference"
  | "not_smaller";

export interface ReferenceFirstToolResultProjection {
  readonly status: "projected" | "retained";
  readonly reason: ReferenceProjectionReason;
  readonly text: string;
  readonly originalBytes: number;
  readonly projectedBytes: number;
  readonly artifactReferences: readonly ArtifactReference[];
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedTextSchema = z.string().max(32_768);
const streamEvidenceSchema = {
  stdout: boundedTextSchema,
  stderr: boundedTextSchema,
  stdoutHash: sha256Schema,
  stderrHash: sha256Schema,
  stdoutRetainedHash: sha256Schema,
  stderrRetainedHash: sha256Schema,
  stdoutRetainedBytes: z.number().int().nonnegative().max(32_768),
  stderrRetainedBytes: z.number().int().nonnegative().max(32_768),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  stdoutArtifact: artifactReferenceSchema.optional(),
  stderrArtifact: artifactReferenceSchema.optional(),
};
const commandEvidenceSchema = z
  .object({
    kind: z.literal("command"),
    executable: z.string().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(64),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(256).nullable(),
    ...streamEvidenceSchema,
    timedOut: z.boolean(),
    aborted: z.boolean(),
    durationMs: z.number().nonnegative().safe(),
    processContainment: z.literal("linux-pid-namespace"),
    terminationStatus: z.enum(["confirmed", "not-required", "unconfirmed"]),
    sandbox: z
      .object({
        backend: z.string().min(1).max(256),
        backendVersion: z.string().min(1).max(256),
        profile: z.string().min(1).max(256),
        policyDigest: sha256Schema,
      })
      .strict(),
  })
  .strict();
const commandFailureSchema = z
  .object({
    code: z.string().min(1).max(256),
    message: z.string().max(4_096),
    retryable: z.boolean(),
    sideEffectStatus: z.enum(["none", "committed", "uncertain"]),
  })
  .strict();
const commandOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), evidence: commandEvidenceSchema }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: commandFailureSchema,
      evidence: commandEvidenceSchema.nullable(),
    })
    .strict(),
]);

export async function projectReferenceFirstToolResult(input: {
  readonly text: string;
  readonly details: unknown;
  readonly identity: ReferenceProjectionIdentity;
  readonly inspectArtifact: (reference: string) => Promise<ReferenceArtifactInspection>;
  readonly minimumOriginalBytes?: number;
}): Promise<ReferenceFirstToolResultProjection> {
  const originalBytes = Buffer.byteLength(input.text, "utf8");
  const minimumOriginalBytes = input.minimumOriginalBytes ?? MIN_REFERENCE_TOOL_RESULT_BYTES;
  if (!Number.isSafeInteger(minimumOriginalBytes) || minimumOriginalBytes <= 0) {
    throw new RangeError("reference projection threshold must be a positive safe integer");
  }
  if (originalBytes < minimumOriginalBytes) {
    return retained("below_threshold", input.text, originalBytes, originalBytes);
  }

  const parsed = commandOutcomeSchema.safeParse(input.details);
  if (!parsed.success) {
    return retained("structured_details_invalid", input.text, originalBytes, originalBytes);
  }
  const outcome = parsed.data;
  const evidence = outcome.evidence;
  if (evidence === null) {
    return retained("structured_details_invalid", input.text, originalBytes, originalBytes);
  }
  if (!hasValidStreamIntegrity(evidence)) {
    return retained("artifact_invalid", input.text, originalBytes, originalBytes);
  }

  const candidates: ArtifactReference[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const truncated = evidence[`${stream}Truncated`];
    const candidate = evidence[`${stream}Artifact`];
    if (!truncated) {
      if (candidate !== undefined) {
        return retained("artifact_invalid", input.text, originalBytes, originalBytes);
      }
      continue;
    }
    if (candidate === undefined || !isValidCandidate(candidate, stream, evidence, input.identity)) {
      return retained("artifact_invalid", input.text, originalBytes, originalBytes);
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    return retained("no_artifact_reference", input.text, originalBytes, originalBytes);
  }

  for (const candidate of candidates) {
    let inspection: ReferenceArtifactInspection;
    try {
      inspection = await input.inspectArtifact(candidate.reference);
    } catch {
      return retained("artifact_unavailable", input.text, originalBytes, originalBytes);
    }
    if (!isAvailableInspection(inspection, candidate)) {
      return retained("artifact_unavailable", input.text, originalBytes, originalBytes);
    }
  }

  const text = JSON.stringify({
    version: 1,
    kind: "flow.reference-tool-result",
    status: outcome.status,
    ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    evidence: {
      executable: evidence.executable,
      args: evidence.args,
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      timedOut: evidence.timedOut,
      aborted: evidence.aborted,
      durationMs: evidence.durationMs,
      processContainment: evidence.processContainment,
      terminationStatus: evidence.terminationStatus,
      sandbox: evidence.sandbox,
      stdout: projectStream(evidence, "stdout"),
      stderr: projectStream(evidence, "stderr"),
    },
  });
  const projectedBytes = Buffer.byteLength(text, "utf8");
  if (projectedBytes >= originalBytes) {
    return retained("not_smaller", input.text, originalBytes, projectedBytes);
  }
  return Object.freeze({
    status: "projected",
    reason: "reference_projection",
    text,
    originalBytes,
    projectedBytes,
    artifactReferences: Object.freeze([...candidates]),
  });
}

function hasValidStreamIntegrity(evidence: z.infer<typeof commandEvidenceSchema>): boolean {
  for (const stream of ["stdout", "stderr"] as const) {
    const text = evidence[stream];
    const fullHash = evidence[`${stream}Hash`];
    const retainedHash = evidence[`${stream}RetainedHash`];
    const retainedBytes = evidence[`${stream}RetainedBytes`];
    const truncated = evidence[`${stream}Truncated`];
    if (
      sha256(text) !== retainedHash ||
      Buffer.byteLength(text, "utf8") !== retainedBytes ||
      truncated === (fullHash === retainedHash)
    ) {
      return false;
    }
  }
  return true;
}

function isValidCandidate(
  input: ArtifactReference,
  stream: "stdout" | "stderr",
  evidence: z.infer<typeof commandEvidenceSchema>,
  identity: ReferenceProjectionIdentity,
): boolean {
  let candidate: ArtifactReference;
  try {
    candidate = validateArtifactReference(input);
  } catch {
    return false;
  }
  const producer = candidate.producer;
  return (
    candidate.descriptor.digest === `sha256:${evidence[`${stream}Hash`]}` &&
    candidate.descriptor.size > evidence[`${stream}RetainedBytes`] &&
    candidate.descriptor.mediaType === "application/octet-stream" &&
    producer.runId === identity.runId &&
    producer.workflowId === identity.workflowId &&
    producer.nodeId === identity.nodeId &&
    producer.attempt === identity.attempt &&
    producer.stream === stream
  );
}

function isAvailableInspection(
  inspection: ReferenceArtifactInspection,
  candidate: ArtifactReference,
): boolean {
  try {
    const inspected = validateArtifactReference(inspection.reference);
    return (
      inspection.retention === "retained" &&
      inspection.availability === "available" &&
      inspected.reference === candidate.reference &&
      inspected.referenceDigest === candidate.referenceDigest
    );
  } catch {
    return false;
  }
}

function projectStream(
  evidence: z.infer<typeof commandEvidenceSchema>,
  stream: "stdout" | "stderr",
): Record<string, unknown> {
  const truncated = evidence[`${stream}Truncated`];
  const base = {
    truncated,
    sha256: evidence[`${stream}Hash`],
    retainedSha256: evidence[`${stream}RetainedHash`],
    retainedBytes: evidence[`${stream}RetainedBytes`],
  };
  if (!truncated) {
    return { ...base, text: evidence[stream] };
  }
  const reference = evidence[`${stream}Artifact`];
  if (reference === undefined) {
    throw new TypeError("validated truncated command stream is missing its artifact");
  }
  return {
    ...base,
    artifact: {
      reference: reference.reference,
      digest: reference.descriptor.digest,
      size: reference.descriptor.size,
      mediaType: reference.descriptor.mediaType,
    },
  };
}

function retained(
  reason: Exclude<ReferenceProjectionReason, "reference_projection">,
  text: string,
  originalBytes: number,
  projectedBytes: number,
): ReferenceFirstToolResultProjection {
  return Object.freeze({
    status: "retained",
    reason,
    text,
    originalBytes,
    projectedBytes,
    artifactReferences: Object.freeze([]),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
