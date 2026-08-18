import type {
  SigstoreCapabilityPublisherPolicy,
  SigstoreCapabilityVerifier,
} from "../domain/capability/sigstore-capability-verifier.js";
import type {
  CapabilityPackageMutationStore,
  ReplaceCapabilityBundleResult,
} from "./capability-package-store.js";
import type { CapabilityRepositoryStore } from "./capability-repository-store.js";
import {
  ReopenCapabilityRepositoryCandidateError,
  reopenCapabilityRepositoryCandidate,
} from "./reopen-capability-repository-candidate.js";

export type CapabilityRepositoryReplacementStage =
  | "validate candidate authority"
  | "verify candidate package";

export class CapabilityRepositoryReplacementError extends Error {
  override readonly name = "CapabilityRepositoryReplacementError";
  readonly code = "capability_repository_replacement_failed" as const;

  constructor(readonly stage: CapabilityRepositoryReplacementStage) {
    super(`Capability repository replacement failed during ${stage}`);
  }
}

export interface ReplaceCapabilityRepositoryCandidateDependencies {
  readonly candidates: Pick<CapabilityRepositoryStore, "readCandidate">;
  readonly verifier: SigstoreCapabilityVerifier;
  readonly packages: Pick<CapabilityPackageMutationStore, "replace">;
}

export interface ReplaceCapabilityRepositoryCandidateInput
  extends SigstoreCapabilityPublisherPolicy {
  readonly candidateDigest: string;
  readonly expectedCurrentVersion: string;
  readonly signal?: AbortSignal;
}

export async function replaceCapabilityRepositoryCandidate(
  dependencies: ReplaceCapabilityRepositoryCandidateDependencies,
  input: ReplaceCapabilityRepositoryCandidateInput,
): Promise<ReplaceCapabilityBundleResult> {
  let reopened: Awaited<ReturnType<typeof reopenCapabilityRepositoryCandidate>>;
  try {
    reopened = await reopenCapabilityRepositoryCandidate(dependencies, input);
  } catch (error) {
    if (error instanceof ReopenCapabilityRepositoryCandidateError) {
      throw new CapabilityRepositoryReplacementError(error.stage);
    }
    throw error;
  }

  throwIfAborted(input.signal);
  return await dependencies.packages.replace({
    expectedCurrentVersion: input.expectedCurrentVersion,
    source: reopened.identity.target.source,
    expectedSha256: reopened.identity.bundle.digest.slice("sha256:".length),
    content: reopened.capabilityBundle,
    publisher: { ...reopened.identity.publisher },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
