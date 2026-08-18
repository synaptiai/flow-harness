import { createHash } from "node:crypto";

import { parseCapabilityBundle } from "../domain/capability/capability-bundles.js";
import { parseSignedCapabilityBundleEnvelope } from "../domain/capability/signed-capability-bundle-envelope.js";
import type {
  SigstoreCapabilityPublisherPolicy,
  SigstoreCapabilityVerifier,
} from "../domain/capability/sigstore-capability-verifier.js";
import {
  type CapabilityRepositoryCandidateIdentity,
  parseCapabilityRepositoryCandidateIdentity,
} from "./capability-repository-candidate.js";
import type { CapabilityRepositoryStore } from "./capability-repository-store.js";

export type ReopenCapabilityRepositoryCandidateStage =
  | "validate candidate authority"
  | "verify candidate package";

export class ReopenCapabilityRepositoryCandidateError extends Error {
  override readonly name = "ReopenCapabilityRepositoryCandidateError";

  constructor(readonly stage: ReopenCapabilityRepositoryCandidateStage) {
    super(`Capability repository candidate reopen failed during ${stage}`);
  }
}

export interface ReopenCapabilityRepositoryCandidateDependencies {
  readonly candidates: Pick<CapabilityRepositoryStore, "readCandidate">;
  readonly verifier: SigstoreCapabilityVerifier;
}

export interface ReopenCapabilityRepositoryCandidateInput
  extends SigstoreCapabilityPublisherPolicy {
  readonly candidateDigest: string;
  readonly signal?: AbortSignal;
}

export interface ReopenedCapabilityRepositoryCandidate {
  readonly identity: CapabilityRepositoryCandidateIdentity;
  readonly capabilityBundle: Buffer;
}

export async function reopenCapabilityRepositoryCandidate(
  dependencies: ReopenCapabilityRepositoryCandidateDependencies,
  input: ReopenCapabilityRepositoryCandidateInput,
): Promise<ReopenedCapabilityRepositoryCandidate> {
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
      throw new Error("candidate authority does not match requested authority");
    }
  } catch {
    throw new ReopenCapabilityRepositoryCandidateError("validate candidate authority");
  }

  try {
    const envelopeBytes = stored.envelopeBytes();
    const envelope = parseSignedCapabilityBundleEnvelope(envelopeBytes);
    const capabilityBundle = envelope.capabilityBundle();
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
    return Object.freeze({ identity, capabilityBundle });
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw input.signal.reason;
    }
    if (error instanceof ReopenCapabilityRepositoryCandidateError) {
      throw error;
    }
    throw new ReopenCapabilityRepositoryCandidateError("verify candidate package");
  }
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
