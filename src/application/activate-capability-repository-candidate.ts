import { createHash } from "node:crypto";
import { parseCapabilityBundle } from "../domain/capability/capability-bundles.js";
import { parseSignedCapabilityBundleEnvelope } from "../domain/capability/signed-capability-bundle-envelope.js";
import type {
  SigstoreCapabilityPublisherPolicy,
  SigstoreCapabilityVerifier,
} from "../domain/capability/sigstore-capability-verifier.js";
import type {
  CapabilityPackageMutationStore,
  InstallCapabilityBundleResult,
} from "./capability-package-store.js";
import {
  type CapabilityRepositoryCandidateIdentity,
  parseCapabilityRepositoryCandidateIdentity,
} from "./capability-repository-candidate.js";
import type { CapabilityRepositoryStore } from "./capability-repository-store.js";

export type CapabilityRepositoryActivationStage =
  | "validate candidate authority"
  | "verify candidate package";

export class CapabilityRepositoryActivationError extends Error {
  override readonly name = "CapabilityRepositoryActivationError";
  readonly code = "capability_repository_activation_failed" as const;

  constructor(readonly stage: CapabilityRepositoryActivationStage) {
    super(`Capability repository activation failed during ${stage}`);
  }
}

export interface ActivateCapabilityRepositoryCandidateDependencies {
  readonly candidates: Pick<CapabilityRepositoryStore, "readCandidate">;
  readonly verifier: SigstoreCapabilityVerifier;
  readonly packages: Pick<CapabilityPackageMutationStore, "install">;
}

export interface ActivateCapabilityRepositoryCandidateInput
  extends SigstoreCapabilityPublisherPolicy {
  readonly candidateDigest: string;
  readonly signal?: AbortSignal;
}

export async function activateCapabilityRepositoryCandidate(
  dependencies: ActivateCapabilityRepositoryCandidateDependencies,
  input: ActivateCapabilityRepositoryCandidateInput,
): Promise<InstallCapabilityBundleResult> {
  throwIfAborted(input.signal);
  const stored = await dependencies.candidates.readCandidate(input.candidateDigest, input.signal);
  throwIfAborted(input.signal);

  let identity: CapabilityRepositoryCandidateIdentity;
  try {
    identity = parseCapabilityRepositoryCandidateIdentity(stored.identity);
    if (
      identity.candidateDigest !== input.candidateDigest ||
      identity.publisher.certificateIssuer !== input.certificateIssuer ||
      identity.publisher.certificateIdentity !== input.certificateIdentity
    ) {
      throw new Error("candidate authority does not match activation authority");
    }
  } catch {
    throw new CapabilityRepositoryActivationError("validate candidate authority");
  }

  let capabilityBundle: Buffer;
  try {
    const envelopeBytes = stored.envelopeBytes();
    const envelope = parseSignedCapabilityBundleEnvelope(envelopeBytes);
    capabilityBundle = envelope.capabilityBundle();
    const sigstoreBundle = envelope.sigstoreBundle();
    const bundle = parseCapabilityBundle(capabilityBundle);
    const verified = dependencies.verifier.verify(capabilityBundle, sigstoreBundle, {
      certificateIssuer: input.certificateIssuer,
      certificateIdentity: input.certificateIdentity,
    });
    throwIfAborted(input.signal);
    if (
      envelope.bytes !== identity.envelope.bytes ||
      envelope.digest !== identity.envelope.digest ||
      envelope.capabilityBundleBytes !== identity.envelope.capabilityBundleBytes ||
      envelope.sigstoreBundleBytes !== identity.envelope.sigstoreBundleBytes ||
      bundle.name !== identity.bundle.name ||
      bundle.version !== identity.bundle.version ||
      bundle.bytes !== identity.bundle.bytes ||
      bundle.digest !== identity.bundle.digest ||
      verified.certificateIssuer !== identity.publisher.certificateIssuer ||
      verified.certificateIdentity !== identity.publisher.certificateIdentity ||
      digest(sigstoreBundle) !== identity.publisher.signatureBundleDigest
    ) {
      throw new Error("candidate package contradicts its reviewed identity");
    }
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw input.signal.reason;
    }
    if (error instanceof CapabilityRepositoryActivationError) {
      throw error;
    }
    throw new CapabilityRepositoryActivationError("verify candidate package");
  }

  throwIfAborted(input.signal);
  return await dependencies.packages.install({
    source: identity.target.source,
    expectedSha256: identity.bundle.digest.slice("sha256:".length),
    content: capabilityBundle,
    publisher: { ...identity.publisher },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
