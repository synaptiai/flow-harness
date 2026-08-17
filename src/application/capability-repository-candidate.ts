import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import {
  type CapabilityBundle,
  parseCapabilityBundle,
} from "../domain/capability/capability-bundles.js";
import {
  CAPABILITY_REPOSITORY_API_VERSION,
  type CapabilityRepositoryIndex,
  type CapabilityRepositoryIndexEntry,
  parseCapabilityPackageTargetCustom,
} from "../domain/capability/capability-repository.js";
import { parseSignedCapabilityBundleEnvelope } from "../domain/capability/signed-capability-bundle-envelope.js";
import { validateSigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import { parseStrictJson } from "../domain/strict-json.js";
import type { CapabilityPublisherVerification } from "./capability-package-store.js";

export const CAPABILITY_REPOSITORY_CANDIDATE_KIND = "CapabilityRepositoryCandidate" as const;
export const CAPABILITY_REPOSITORY_INDEX_TARGET_PATH = "flow/capability-index.json" as const;
export const MAX_CAPABILITY_REPOSITORY_METADATA_FILES = 34;
export const MAX_CAPABILITY_REPOSITORY_CANDIDATE_RECORD_BYTES = 256 * 1024;

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform((value): `sha256:${string}` => value as `sha256:${string}`);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const metadataFileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?\.json$/),
    length: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024),
    digest: sha256DigestSchema,
  })
  .strict();
const identitySchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_REPOSITORY_API_VERSION),
    kind: z.literal(CAPABILITY_REPOSITORY_CANDIDATE_KIND),
    candidateDigest: sha256DigestSchema,
    repository: z
      .object({
        stateDigest: sha256DigestSchema,
        metadata: z.array(metadataFileSchema).min(1).max(MAX_CAPABILITY_REPOSITORY_METADATA_FILES),
      })
      .strict(),
    index: z
      .object({
        path: z.literal(CAPABILITY_REPOSITORY_INDEX_TARGET_PATH),
        bytes: z.number().int().positive(),
        digest: sha256DigestSchema,
      })
      .strict(),
    target: z
      .object({
        path: z.string().min(1).max(1_024),
        source: z.string().min(1).max(4_096),
        length: z.number().int().positive(),
        hashes: z.object({ sha256: sha256HexSchema }).strict(),
      })
      .strict(),
    envelope: z
      .object({
        bytes: z.number().int().positive(),
        digest: sha256DigestSchema,
        capabilityBundleBytes: z.number().int().positive(),
        sigstoreBundleBytes: z.number().int().positive(),
      })
      .strict(),
    bundle: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128),
        bytes: z.number().int().positive(),
        digest: sha256DigestSchema,
      })
      .strict(),
    publisher: z
      .object({
        kind: z.literal("sigstore-keyless-v0.3"),
        certificateIssuer: z.string().min(1).max(2_048),
        certificateIdentity: z.string().min(1).max(4_096),
        signatureBundleDigest: sha256DigestSchema,
      })
      .strict(),
  })
  .strict();

export type CapabilityRepositoryCandidateStage =
  | "validate candidate evidence"
  | "validate candidate identity";

export class CapabilityRepositoryCandidateError extends Error {
  override readonly name = "CapabilityRepositoryCandidateError";
  readonly code = "capability_repository_candidate_failed" as const;

  constructor(readonly stage: CapabilityRepositoryCandidateStage) {
    super(`Capability repository candidate failed during ${stage}`);
  }
}

export interface CapabilityRepositoryMetadataDescriptor {
  readonly name: string;
  readonly length: number;
  readonly digest: `sha256:${string}`;
}

export interface CapabilityRepositoryTargetEvidence {
  readonly path: string;
  readonly source: string;
  readonly length: number;
  readonly hashes: Readonly<Record<string, string>>;
  readonly custom: Readonly<Record<string, unknown>>;
  readonly content: Uint8Array;
}

export type CapabilityRepositoryCandidateIdentity = z.infer<typeof identitySchema>;

export interface CreateCapabilityRepositoryCandidateInput {
  readonly repositoryMetadata: readonly CapabilityRepositoryMetadataDescriptor[];
  readonly index: CapabilityRepositoryIndex;
  readonly entry: CapabilityRepositoryIndexEntry;
  readonly target: CapabilityRepositoryTargetEvidence;
  readonly authority: CapabilityPublisherVerification;
}

export class CapabilityRepositoryCandidate {
  readonly identity: CapabilityRepositoryCandidateIdentity;
  readonly bundle: CapabilityBundle;

  readonly #envelope: Buffer;
  readonly #capabilityBundle: Buffer;
  readonly #sigstoreBundle: Buffer;

  constructor(input: {
    readonly identity: CapabilityRepositoryCandidateIdentity;
    readonly bundle: CapabilityBundle;
    readonly envelope: Buffer;
    readonly capabilityBundle: Buffer;
    readonly sigstoreBundle: Buffer;
  }) {
    this.identity = input.identity;
    this.bundle = input.bundle;
    this.#envelope = Buffer.from(input.envelope);
    this.#capabilityBundle = Buffer.from(input.capabilityBundle);
    this.#sigstoreBundle = Buffer.from(input.sigstoreBundle);
    Object.freeze(this);
  }

  envelopeBytes(): Buffer {
    return Buffer.from(this.#envelope);
  }

  capabilityBundleBytes(): Buffer {
    return Buffer.from(this.#capabilityBundle);
  }

  sigstoreBundleBytes(): Buffer {
    return Buffer.from(this.#sigstoreBundle);
  }
}

export interface PublicCapabilityRepositoryCandidate
  extends Omit<CapabilityRepositoryCandidateIdentity, "target"> {
  readonly target: Omit<CapabilityRepositoryCandidateIdentity["target"], "source">;
}

export function createCapabilityRepositoryCandidate(
  input: CreateCapabilityRepositoryCandidateInput,
): CapabilityRepositoryCandidate {
  try {
    const metadata = input.repositoryMetadata.map((entry) => metadataFileSchema.parse(entry));
    assertSortedMetadata(metadata);
    const matchingIndexEntry = input.index.packages.find(
      (entry) =>
        entry.name === input.entry.name &&
        entry.version === input.entry.version &&
        entry.targetPath === input.entry.targetPath,
    );
    if (matchingIndexEntry === undefined || !isDeepStrictEqual(matchingIndexEntry, input.entry)) {
      throw new Error("index entry is not selected by the verified index");
    }

    const targetContent = Buffer.from(input.target.content);
    const targetCustom = parseCapabilityPackageTargetCustom(input.target.custom);
    const envelope = parseSignedCapabilityBundleEnvelope(targetContent);
    const capabilityBundle = envelope.capabilityBundle();
    const sigstoreBundle = envelope.sigstoreBundle();
    const bundle = parseCapabilityBundle(capabilityBundle);
    const authorityPolicy = validateSigstoreCapabilityPublisherPolicy(input.authority);
    const hashes = canonicalTargetHashes(input.target.hashes);

    if (
      input.target.path !== input.entry.targetPath ||
      !isCanonicalHttpsTargetSource(input.target.source) ||
      input.target.length !== targetContent.byteLength ||
      hashes.sha256 !== sha256Hex(targetContent) ||
      targetCustom.name !== input.entry.name ||
      targetCustom.version !== input.entry.version ||
      targetCustom.name !== bundle.name ||
      targetCustom.version !== bundle.version ||
      targetCustom.publisher.certificateIssuer !== authorityPolicy.certificateIssuer ||
      targetCustom.publisher.certificateIdentity !== authorityPolicy.certificateIdentity ||
      input.authority.kind !== "sigstore-keyless-v0.3" ||
      input.authority.signatureBundleDigest !== sha256(sigstoreBundle) ||
      bundle.bytes !== capabilityBundle.byteLength ||
      bundle.digest !== sha256(capabilityBundle)
    ) {
      throw new Error("candidate evidence is inconsistent");
    }

    const repository = {
      stateDigest: calculateCapabilityRepositoryStateDigest(metadata),
      metadata: metadata.map((entry) => ({ ...entry })),
    };
    const content = {
      apiVersion: CAPABILITY_REPOSITORY_API_VERSION,
      kind: CAPABILITY_REPOSITORY_CANDIDATE_KIND,
      repository,
      index: {
        path: CAPABILITY_REPOSITORY_INDEX_TARGET_PATH,
        bytes: input.index.bytes,
        digest: input.index.digest,
      },
      target: {
        path: input.target.path,
        source: input.target.source,
        length: input.target.length,
        hashes,
      },
      envelope: {
        bytes: envelope.bytes,
        digest: envelope.digest,
        capabilityBundleBytes: envelope.capabilityBundleBytes,
        sigstoreBundleBytes: envelope.sigstoreBundleBytes,
      },
      bundle: {
        name: bundle.name,
        version: bundle.version,
        bytes: bundle.bytes,
        digest: bundle.digest,
      },
      publisher: {
        kind: input.authority.kind,
        certificateIssuer: authorityPolicy.certificateIssuer,
        certificateIdentity: authorityPolicy.certificateIdentity,
        signatureBundleDigest: input.authority.signatureBundleDigest,
      },
    } as const;
    const identity = deepFreeze(
      identitySchema.parse({
        ...content,
        candidateDigest: sha256(canonicalCandidateIdentityBytes(content)),
      }),
    );
    requireValidIdentity(identity);

    return new CapabilityRepositoryCandidate({
      identity,
      bundle,
      envelope: targetContent,
      capabilityBundle,
      sigstoreBundle,
    });
  } catch {
    throw new CapabilityRepositoryCandidateError("validate candidate evidence");
  }
}

export function parseCapabilityRepositoryCandidateIdentity(
  input: unknown,
): CapabilityRepositoryCandidateIdentity {
  try {
    const identity = identitySchema.parse(input);
    requireValidIdentity(identity);
    return deepFreeze(canonicalIdentity(identity));
  } catch {
    throw new CapabilityRepositoryCandidateError("validate candidate identity");
  }
}

export function encodeCapabilityRepositoryCandidateIdentity(
  input: CapabilityRepositoryCandidateIdentity,
): Buffer {
  try {
    const identity = identitySchema.parse(input);
    requireValidIdentity(identity);
    const content = canonicalCandidateRecordBytes(identity);
    if (content.byteLength > MAX_CAPABILITY_REPOSITORY_CANDIDATE_RECORD_BYTES) {
      throw new Error("candidate identity record exceeds its byte bound");
    }
    return content;
  } catch {
    throw new CapabilityRepositoryCandidateError("validate candidate identity");
  }
}

export function parseCapabilityRepositoryCandidateIdentityRecord(
  source: Uint8Array,
): CapabilityRepositoryCandidateIdentity {
  const content = Buffer.from(source);
  if (
    content.byteLength < 1 ||
    content.byteLength > MAX_CAPABILITY_REPOSITORY_CANDIDATE_RECORD_BYTES
  ) {
    throw new CapabilityRepositoryCandidateError("validate candidate identity");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const input = parseStrictJson(text, {
      maxDepth: 12,
      maxNodes: 4_096,
      valueLabel: "capability repository candidate identity",
    });
    const identity = identitySchema.parse(input);
    requireValidIdentity(identity);
    if (!content.equals(canonicalCandidateRecordBytes(identity))) {
      throw new Error("candidate identity record is not canonical");
    }
    return deepFreeze(canonicalIdentity(identity));
  } catch {
    throw new CapabilityRepositoryCandidateError("validate candidate identity");
  }
}

export function toPublicCapabilityRepositoryCandidate(
  candidate: Pick<CapabilityRepositoryCandidate, "identity">,
): PublicCapabilityRepositoryCandidate {
  const { source: _source, ...target } = candidate.identity.target;
  return deepFreeze({
    ...candidate.identity,
    repository: {
      ...candidate.identity.repository,
      metadata: candidate.identity.repository.metadata.map((entry) => ({ ...entry })),
    },
    target: { ...target, hashes: { ...target.hashes } },
  });
}

export function calculateCapabilityRepositoryStateDigest(
  metadata: readonly CapabilityRepositoryMetadataDescriptor[],
): `sha256:${string}` {
  return sha256(canonicalRepositoryStateBytes(metadata));
}

function requireValidIdentity(identity: CapabilityRepositoryCandidateIdentity): void {
  assertSortedMetadata(identity.repository.metadata);
  validateSigstoreCapabilityPublisherPolicy(identity.publisher);
  if (
    identity.repository.stateDigest !==
      calculateCapabilityRepositoryStateDigest(identity.repository.metadata) ||
    identity.candidateDigest !==
      sha256(
        canonicalCandidateIdentityBytes({
          repository: identity.repository,
          index: identity.index,
          target: identity.target,
          envelope: identity.envelope,
          bundle: identity.bundle,
          publisher: identity.publisher,
        }),
      ) ||
    identity.target.length !== identity.envelope.bytes ||
    identity.target.hashes.sha256 !== identity.envelope.digest.slice("sha256:".length) ||
    identity.envelope.capabilityBundleBytes !== identity.bundle.bytes
  ) {
    throw new Error("candidate identity is inconsistent");
  }
}

function canonicalIdentity(
  identity: CapabilityRepositoryCandidateIdentity,
): CapabilityRepositoryCandidateIdentity {
  return {
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    candidateDigest: identity.candidateDigest,
    repository: {
      stateDigest: identity.repository.stateDigest,
      metadata: identity.repository.metadata.map((entry) => ({ ...entry })),
    },
    index: { ...identity.index },
    target: { ...identity.target, hashes: { ...identity.target.hashes } },
    envelope: { ...identity.envelope },
    bundle: { ...identity.bundle },
    publisher: { ...identity.publisher },
  };
}

function canonicalCandidateIdentityBytes(
  content: Omit<CapabilityRepositoryCandidateIdentity, "candidateDigest" | "apiVersion" | "kind">,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: CAPABILITY_REPOSITORY_API_VERSION,
      kind: "CapabilityRepositoryCandidateIdentity",
      repository: content.repository,
      index: content.index,
      target: content.target,
      envelope: content.envelope,
      bundle: content.bundle,
      publisher: content.publisher,
    }),
  );
}

function canonicalCandidateRecordBytes(identity: CapabilityRepositoryCandidateIdentity): Buffer {
  return Buffer.from(JSON.stringify(canonicalIdentity(identity)));
}

function canonicalRepositoryStateBytes(
  metadata: readonly CapabilityRepositoryMetadataDescriptor[],
): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: CAPABILITY_REPOSITORY_API_VERSION,
      kind: "CapabilityRepositoryStateIdentity",
      metadata,
    }),
  );
}

function canonicalTargetHashes(hashes: Readonly<Record<string, string>>): {
  readonly sha256: string;
} {
  if (Object.keys(hashes).length !== 1 || !Object.hasOwn(hashes, "sha256")) {
    throw new Error("target hash set is unsupported");
  }
  return Object.freeze({ sha256: sha256HexSchema.parse(hashes.sha256) });
}

function assertSortedMetadata(metadata: readonly CapabilityRepositoryMetadataDescriptor[]): void {
  for (let index = 0; index < metadata.length; index += 1) {
    const current = metadata[index];
    const previous = metadata[index - 1];
    if (current === undefined || (previous !== undefined && previous.name >= current.name)) {
      throw new Error("repository metadata is not strictly sorted and unique");
    }
  }
}

function isCanonicalHttpsTargetSource(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname === url.hostname.toLowerCase() &&
      url.toString() === source
    );
  } catch {
    return false;
  }
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
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
