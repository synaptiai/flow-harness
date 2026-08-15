import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  CAPABILITY_METADATA_API_VERSION,
  type CapabilityMetadata,
  type CapabilityMetadataTarget,
  MAX_CAPABILITY_METADATA_BYTES,
  MAX_CAPABILITY_METADATA_TARGETS,
  parseCapabilityMetadata,
} from "../domain/capability/capability-metadata.js";
import { validateSigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../domain/capability/verifier-packages.js";
import { parseStrictJson } from "../domain/strict-json.js";
import type { CapabilityPublisherVerification } from "./capability-package-store.js";

export const CAPABILITY_METADATA_CANDIDATE_KIND = "CapabilityMetadataCandidate" as const;
export const MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES = 1024 * 1024;
const MAX_SIGSTORE_BUNDLE_BYTES = 1024 * 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const canonicalInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const instant = new Date(value);
    return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
  });
const publisherSchema = z
  .object({
    certificateIssuer: z.string().min(1).max(2_048),
    certificateIdentity: z.string().min(1).max(4_096),
  })
  .strict();
const targetSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    digest: digestSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    source: z.string().min(1).max(4_096),
    status: z.enum(["active", "revoked"]),
    publisher: publisherSchema.optional(),
  })
  .strict();
const candidateSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_METADATA_API_VERSION),
    kind: z.literal(CAPABILITY_METADATA_CANDIDATE_KIND),
    candidateDigest: digestSchema,
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expiresAt: canonicalInstantSchema,
        bytes: z.number().int().positive().max(MAX_CAPABILITY_METADATA_BYTES),
        digest: digestSchema,
        targets: z.array(targetSchema).max(MAX_CAPABILITY_METADATA_TARGETS),
      })
      .strict(),
    sigstoreBundle: z
      .object({
        bytes: z.number().int().positive().max(MAX_SIGSTORE_BUNDLE_BYTES),
        digest: digestSchema,
      })
      .strict(),
    authority: z
      .object({
        kind: z.literal("sigstore-keyless-v0.3"),
        certificateIssuer: z.string().min(1).max(2_048),
        certificateIdentity: z.string().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();

export type CapabilityMetadataCandidateStage =
  | "validate candidate input"
  | "parse candidate record"
  | "validate candidate record";

export class CapabilityMetadataCandidateError extends Error {
  override readonly name = "CapabilityMetadataCandidateError";
  readonly code = "capability_metadata_candidate_failed" as const;

  constructor(readonly stage: CapabilityMetadataCandidateStage) {
    super(`Capability metadata candidate failed during ${stage}`);
  }
}

export interface CapabilityMetadataCandidate {
  readonly apiVersion: typeof CAPABILITY_METADATA_API_VERSION;
  readonly kind: typeof CAPABILITY_METADATA_CANDIDATE_KIND;
  readonly candidateDigest: string;
  readonly metadata: {
    readonly name: string;
    readonly version: number;
    readonly expiresAt: string;
    readonly bytes: number;
    readonly digest: string;
    readonly targets: readonly CapabilityMetadataTarget[];
  };
  readonly sigstoreBundle: {
    readonly bytes: number;
    readonly digest: string;
  };
  readonly authority: {
    readonly kind: "sigstore-keyless-v0.3";
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
  };
}

export interface CreateCapabilityMetadataCandidateInput {
  readonly metadata: CapabilityMetadata;
  readonly metadataBytes: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
  readonly authority: CapabilityPublisherVerification;
}

export function createCapabilityMetadataCandidate(
  input: CreateCapabilityMetadataCandidateInput,
): CapabilityMetadataCandidate {
  try {
    const metadataBytes = Buffer.from(input.metadataBytes);
    const sigstoreBundle = Buffer.from(input.sigstoreBundle);
    const policy = validateSigstoreCapabilityPublisherPolicy(input.authority);
    const metadataFromBytes = parseCapabilityMetadata(
      metadataBytes,
      new Date(Date.parse(input.metadata.expiresAt) - 1),
    );
    if (
      input.metadata.apiVersion !== CAPABILITY_METADATA_API_VERSION ||
      input.metadata.kind !== "CapabilityMetadata" ||
      !isDeepStrictEqual(metadataFromBytes, input.metadata) ||
      metadataBytes.byteLength !== input.metadata.bytes ||
      sha256(metadataBytes) !== input.metadata.digest ||
      sigstoreBundle.byteLength < 1 ||
      sigstoreBundle.byteLength > MAX_SIGSTORE_BUNDLE_BYTES ||
      sha256(sigstoreBundle) !== input.authority.signatureBundleDigest
    ) {
      throw new Error("candidate input contradicts verified evidence");
    }
    const identity = canonicalIdentity({
      metadata: {
        name: input.metadata.name,
        version: input.metadata.version,
        expiresAt: input.metadata.expiresAt,
        bytes: input.metadata.bytes,
        digest: input.metadata.digest,
        targets: input.metadata.targets.map(canonicalTarget),
      },
      sigstoreBundle: {
        bytes: sigstoreBundle.byteLength,
        digest: input.authority.signatureBundleDigest,
      },
      authority: {
        kind: input.authority.kind,
        certificateIssuer: policy.certificateIssuer,
        certificateIdentity: policy.certificateIdentity,
      },
    });
    return canonicalCandidate(
      candidateSchema.parse({
        apiVersion: CAPABILITY_METADATA_API_VERSION,
        kind: CAPABILITY_METADATA_CANDIDATE_KIND,
        candidateDigest: sha256(canonicalIdentityBytes(identity)),
        ...identity,
      }),
    );
  } catch {
    throw new CapabilityMetadataCandidateError("validate candidate input");
  }
}

export function encodeCapabilityMetadataCandidate(candidate: CapabilityMetadataCandidate): Buffer {
  try {
    const parsed = candidateSchema.parse(candidate);
    requireValidCandidate(parsed);
    const content = canonicalCandidateBytes(parsed);
    if (content.byteLength > MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES) {
      throw new Error("candidate record exceeds its byte bound");
    }
    return content;
  } catch {
    throw new CapabilityMetadataCandidateError("validate candidate record");
  }
}

export function parseCapabilityMetadataCandidate(source: Uint8Array): CapabilityMetadataCandidate {
  const content = Buffer.from(source);
  if (
    content.byteLength < 1 ||
    content.byteLength > MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES
  ) {
    throw new CapabilityMetadataCandidateError("parse candidate record");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new CapabilityMetadataCandidateError("parse candidate record");
  }
  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 10,
      maxNodes: 16_384,
      valueLabel: "capability metadata candidate",
    });
  } catch {
    throw new CapabilityMetadataCandidateError("parse candidate record");
  }
  try {
    const parsed = candidateSchema.parse(input);
    if (!content.equals(canonicalCandidateBytes(parsed))) {
      throw new Error("candidate record is not canonical");
    }
    requireValidCandidate(parsed);
    return canonicalCandidate(parsed);
  } catch {
    throw new CapabilityMetadataCandidateError("validate candidate record");
  }
}

type ParsedCandidate = z.infer<typeof candidateSchema>;
interface CandidateIdentityInput {
  readonly metadata: {
    readonly name: string;
    readonly version: number;
    readonly expiresAt: string;
    readonly bytes: number;
    readonly digest: string;
    readonly targets: readonly {
      readonly name: string;
      readonly version: string;
      readonly digest: string;
      readonly bytes: number;
      readonly source: string;
      readonly status: "active" | "revoked";
      readonly publisher?:
        | {
            readonly certificateIssuer: string;
            readonly certificateIdentity: string;
          }
        | undefined;
    }[];
  };
  readonly sigstoreBundle: {
    readonly bytes: number;
    readonly digest: string;
  };
  readonly authority: {
    readonly kind: "sigstore-keyless-v0.3";
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
  };
}

interface CanonicalCandidateIdentity {
  readonly metadata: CapabilityMetadataCandidate["metadata"];
  readonly sigstoreBundle: CapabilityMetadataCandidate["sigstoreBundle"];
  readonly authority: CapabilityMetadataCandidate["authority"];
}

function requireValidCandidate(candidate: ParsedCandidate): void {
  validateSigstoreCapabilityPublisherPolicy(candidate.authority);
  assertCanonicalTargets(candidate.metadata.targets);
  if (candidate.candidateDigest !== sha256(canonicalIdentityBytes(canonicalIdentity(candidate)))) {
    throw new Error("candidate digest mismatch");
  }
}

function canonicalIdentity(candidate: CandidateIdentityInput): CanonicalCandidateIdentity {
  return {
    metadata: {
      name: candidate.metadata.name,
      version: candidate.metadata.version,
      expiresAt: candidate.metadata.expiresAt,
      bytes: candidate.metadata.bytes,
      digest: candidate.metadata.digest,
      targets: candidate.metadata.targets.map(canonicalTarget),
    },
    sigstoreBundle: {
      bytes: candidate.sigstoreBundle.bytes,
      digest: candidate.sigstoreBundle.digest,
    },
    authority: {
      kind: candidate.authority.kind,
      certificateIssuer: candidate.authority.certificateIssuer,
      certificateIdentity: candidate.authority.certificateIdentity,
    },
  };
}

function canonicalIdentityBytes(candidate: CandidateIdentityInput): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: CAPABILITY_METADATA_API_VERSION,
      kind: "CapabilityMetadataCandidateIdentity",
      ...canonicalIdentity(candidate),
    }),
  );
}

function canonicalCandidateBytes(candidate: ParsedCandidate): Buffer {
  const canonical = canonicalCandidate(candidate);
  return Buffer.from(JSON.stringify(canonical));
}

function canonicalCandidate(candidate: ParsedCandidate): CapabilityMetadataCandidate {
  return deepFreeze({
    apiVersion: candidate.apiVersion,
    kind: candidate.kind,
    candidateDigest: candidate.candidateDigest,
    ...canonicalIdentity(candidate),
  });
}

function canonicalTarget(
  target: CandidateIdentityInput["metadata"]["targets"][number],
): CapabilityMetadataTarget {
  return {
    name: target.name,
    version: target.version,
    digest: target.digest,
    bytes: target.bytes,
    source: target.source,
    status: target.status,
    ...(target.publisher === undefined
      ? {}
      : {
          publisher: {
            certificateIssuer: target.publisher.certificateIssuer,
            certificateIdentity: target.publisher.certificateIdentity,
          },
        }),
  };
}

function assertCanonicalTargets(targets: readonly z.infer<typeof targetSchema>[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (
      previous === undefined ||
      current === undefined ||
      `${previous.name}\0${previous.version}` >= `${current.name}\0${current.version}`
    ) {
      throw new Error("candidate targets are not strictly sorted and unique");
    }
  }
}

function sha256(source: Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
