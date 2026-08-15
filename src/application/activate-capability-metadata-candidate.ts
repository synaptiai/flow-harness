import type { SigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import { createCapabilityMetadataCandidate } from "./capability-metadata-candidate.js";
import type { CapabilityMetadataCandidateStore } from "./capability-metadata-candidate-store.js";
import type {
  RefreshCapabilityMetadataInput,
  RefreshCapabilityMetadataResult,
} from "./capability-package-store.js";
import type { SignedCapabilityMetadataVerifier } from "./verify-signed-capability-metadata.js";

export type CapabilityMetadataActivationStage = "validate candidate identity";

export class CapabilityMetadataActivationError extends Error {
  override readonly name = "CapabilityMetadataActivationError";
  readonly code = "capability_metadata_activation_failed" as const;

  constructor(readonly stage: CapabilityMetadataActivationStage) {
    super(`Capability metadata activation failed during ${stage}`);
  }
}

export interface CapabilityMetadataActivationStore {
  refreshMetadata(input: RefreshCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult>;
}

export interface ActivateCapabilityMetadataCandidateDependencies {
  readonly candidates: Pick<CapabilityMetadataCandidateStore, "read">;
  readonly verifier: SignedCapabilityMetadataVerifier;
  readonly activeMetadata: CapabilityMetadataActivationStore;
  readonly now: () => Date;
}

export interface ActivateCapabilityMetadataCandidateInput
  extends SigstoreCapabilityPublisherPolicy {
  readonly candidateDigest: string;
  readonly signal?: AbortSignal;
}

export async function activateCapabilityMetadataCandidate(
  dependencies: ActivateCapabilityMetadataCandidateDependencies,
  input: ActivateCapabilityMetadataCandidateInput,
): Promise<RefreshCapabilityMetadataResult> {
  throwIfAborted(input.signal);
  const stored = await dependencies.candidates.read(input.candidateDigest, input.signal);
  throwIfAborted(input.signal);
  const verified = await dependencies.verifier.verify({
    metadata: stored.metadataBytes(),
    sigstoreBundle: stored.sigstoreBundleBytes(),
    certificateIssuer: input.certificateIssuer,
    certificateIdentity: input.certificateIdentity,
    now: new Date(dependencies.now().getTime()),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  throwIfAborted(input.signal);
  const reconstructed = createCapabilityMetadataCandidate({
    metadata: verified.metadata,
    metadataBytes: verified.metadataBytes(),
    sigstoreBundle: verified.sigstoreBundleBytes(),
    authority: verified.authority,
  });
  if (
    reconstructed.candidateDigest !== input.candidateDigest ||
    reconstructed.candidateDigest !== stored.candidate.candidateDigest
  ) {
    throw new CapabilityMetadataActivationError("validate candidate identity");
  }
  return await dependencies.activeMetadata.refreshMetadata({
    metadata: verified.metadata,
    authority: verified.authority,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
