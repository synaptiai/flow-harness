import type {
  CapabilityRepositoryCandidate,
  CapabilityRepositoryCandidateIdentity,
  CapabilityRepositoryMetadataDescriptor,
  PublicCapabilityRepositoryCandidate,
} from "./capability-repository-candidate.js";

export const MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES = 4;
export const MAX_CAPABILITY_REPOSITORY_GENERATIONS = 2;

export type CapabilityRepositoryStoreStage =
  | "validate repository store input"
  | "acquire repository store lock"
  | "inspect repository store"
  | "enforce repository store capacity"
  | "publish repository generation"
  | "publish repository current state"
  | "read repository generation"
  | "read repository candidate"
  | "remove repository candidate"
  | "release repository store lock"
  | "settle repository store commit";

export class CapabilityRepositoryStoreError extends Error {
  override readonly name = "CapabilityRepositoryStoreError";
  readonly code = "capability_repository_store_failed" as const;

  constructor(readonly stage: CapabilityRepositoryStoreStage) {
    super(`Capability repository store failed during ${stage}`);
  }
}

export interface CapabilityRepositoryStoredFile extends CapabilityRepositoryMetadataDescriptor {
  bytes(): Buffer;
}

export interface CapabilityRepositoryStoredIndex {
  readonly path: "flow/capability-index.json";
  readonly length: number;
  readonly hashes: Readonly<{ readonly sha256: string }>;
  bytes(): Buffer;
}

export interface AuthenticateCapabilityRepositoryGenerationInput {
  readonly repositoryBaseUrl: string;
  readonly initializedAt: string;
  readonly checkedAt?: string;
  readonly trustedRoot: CapabilityRepositoryStoredFile;
  readonly metadata: readonly CapabilityRepositoryStoredFile[];
  readonly index?: CapabilityRepositoryStoredIndex;
  readonly candidates: readonly StoredCapabilityRepositoryCandidate[];
  readonly signal?: AbortSignal;
}

export interface CapabilityRepositoryGenerationAuthenticator {
  authenticate(input: AuthenticateCapabilityRepositoryGenerationInput): Promise<void>;
}

export interface InitializeCapabilityRepositoryInput {
  readonly repositoryBaseUrl: string;
  readonly initializedAt: string;
  readonly trustedRoot: CapabilityRepositoryStoredFile;
  readonly signal?: AbortSignal;
}

export interface PublishCapabilityRepositoryCheckInput {
  readonly checkedAt: string;
  readonly metadata: readonly CapabilityRepositoryStoredFile[];
  readonly index: CapabilityRepositoryStoredIndex;
  readonly candidates: readonly CapabilityRepositoryCandidate[];
  readonly signal: AbortSignal;
}

export interface CapabilityRepositoryCheckPublication {
  readonly status: "staged" | "already_current";
  readonly checkedAt: string;
  readonly candidates: readonly PublicCapabilityRepositoryCandidate[];
}

export interface CapabilityRepositoryCheckPublisher {
  publish(
    input: PublishCapabilityRepositoryCheckInput,
  ): Promise<CapabilityRepositoryCheckPublication>;
}

export interface PublicCapabilityRepositoryState {
  readonly apiVersion: "flow.synapti.ai/v1alpha1";
  readonly kind: "CapabilityRepositoryState";
  readonly status: "initialized" | "checked";
  readonly generationDigest: `sha256:${string}`;
  readonly repositoryStateDigest: `sha256:${string}`;
  readonly initializedAt: string;
  readonly checkedAt?: string;
  readonly metadata: readonly CapabilityRepositoryMetadataDescriptor[];
  readonly candidates: readonly PublicCapabilityRepositoryCandidate[];
}

export interface StoredCapabilityRepositoryCandidate {
  readonly identity: CapabilityRepositoryCandidateIdentity;
  envelopeBytes(): Buffer;
}

export interface CapabilityRepositoryTrustedState {
  readonly repositoryBaseUrl: string;
  readonly metadata: readonly CapabilityRepositoryStoredFile[];
}

export interface CapabilityRepositoryTrustedStateReader {
  readTrustedState(signal?: AbortSignal): Promise<CapabilityRepositoryTrustedState>;
}

export interface CapabilityRepositoryStore
  extends CapabilityRepositoryCheckPublisher,
    CapabilityRepositoryTrustedStateReader {
  initialize(input: InitializeCapabilityRepositoryInput): Promise<PublicCapabilityRepositoryState>;
  status(signal?: AbortSignal): Promise<PublicCapabilityRepositoryState | undefined>;
  listCandidates(signal?: AbortSignal): Promise<readonly PublicCapabilityRepositoryCandidate[]>;
  readCandidate(
    candidateDigest: string,
    signal?: AbortSignal,
  ): Promise<StoredCapabilityRepositoryCandidate>;
  removeCandidate(
    candidateDigest: string,
    signal?: AbortSignal,
  ): Promise<PublicCapabilityRepositoryState>;
}
