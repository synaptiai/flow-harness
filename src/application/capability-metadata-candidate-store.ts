import type { CapabilityMetadataCandidate } from "./capability-metadata-candidate.js";

export const MAX_STAGED_CAPABILITY_METADATA_CANDIDATES = 4;

export type CapabilityMetadataCandidateStoreStage =
  | "validate candidate store input"
  | "acquire candidate store lock"
  | "inspect candidate store"
  | "enforce candidate capacity"
  | "publish candidate"
  | "publish latest check"
  | "read candidate"
  | "remove candidate"
  | "release candidate store lock"
  | "settle candidate commit";

export class CapabilityMetadataCandidateStoreError extends Error {
  override readonly name = "CapabilityMetadataCandidateStoreError";
  readonly code = "capability_metadata_candidate_store_failed" as const;

  constructor(readonly stage: CapabilityMetadataCandidateStoreStage) {
    super(`Capability metadata candidate store failed during ${stage}`);
  }
}

export interface CapabilityMetadataCheckObservation {
  readonly apiVersion: "flow.synapti.ai/v1alpha1";
  readonly kind: "CapabilityMetadataCheckObservation";
  readonly checkedAt: string;
  readonly channel: string;
  readonly envelopeBytes: number;
  readonly envelopeDigest: string;
  readonly candidateDigest: string;
}

export interface StageCapabilityMetadataCandidateInput {
  readonly candidate: CapabilityMetadataCandidate;
  readonly metadata: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
  readonly observation: Omit<CapabilityMetadataCheckObservation, "candidateDigest">;
  readonly signal?: AbortSignal;
}

export interface StageCapabilityMetadataCandidateResult {
  readonly status: "staged" | "already_staged";
  readonly candidate: CapabilityMetadataCandidate;
  readonly observation: CapabilityMetadataCheckObservation;
}

export class StoredCapabilityMetadataCandidate {
  readonly candidate: CapabilityMetadataCandidate;
  readonly #metadata: Buffer;
  readonly #sigstoreBundle: Buffer;

  constructor(input: {
    readonly candidate: CapabilityMetadataCandidate;
    readonly metadata: Uint8Array;
    readonly sigstoreBundle: Uint8Array;
  }) {
    this.candidate = input.candidate;
    this.#metadata = Buffer.from(input.metadata);
    this.#sigstoreBundle = Buffer.from(input.sigstoreBundle);
    Object.freeze(this);
  }

  metadataBytes(): Buffer {
    return Buffer.from(this.#metadata);
  }

  sigstoreBundleBytes(): Buffer {
    return Buffer.from(this.#sigstoreBundle);
  }
}

export interface CapabilityMetadataCandidateStore {
  stage(
    input: StageCapabilityMetadataCandidateInput,
  ): Promise<StageCapabilityMetadataCandidateResult>;
  list(signal?: AbortSignal): Promise<readonly CapabilityMetadataCandidate[]>;
  read(candidateDigest: string, signal?: AbortSignal): Promise<StoredCapabilityMetadataCandidate>;
  remove(candidateDigest: string, signal?: AbortSignal): Promise<void>;
  latestCheck(signal?: AbortSignal): Promise<CapabilityMetadataCheckObservation | null>;
}
