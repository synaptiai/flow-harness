import { createHash } from "node:crypto";

import type { CapabilityMetadata } from "../domain/capability/capability-metadata.js";
import { parseCapabilityMetadata } from "../domain/capability/capability-metadata.js";
import {
  type SigstoreCapabilityPublisherPolicy,
  type SigstoreCapabilityVerifier,
  validateSigstoreCapabilityPublisherPolicy,
} from "../domain/capability/sigstore-capability-verifier.js";
import type { CapabilityPublisherVerification } from "./capability-package-store.js";

export interface VerifySignedCapabilityMetadataInput extends SigstoreCapabilityPublisherPolicy {
  readonly metadata: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
  readonly now: Date;
  readonly signal?: AbortSignal;
}

export interface SignedCapabilityMetadataVerifier {
  verify(input: VerifySignedCapabilityMetadataInput): Promise<VerifiedSignedCapabilityMetadata>;
}

export class VerifiedSignedCapabilityMetadata {
  readonly metadata: CapabilityMetadata;
  readonly authority: CapabilityPublisherVerification;

  readonly #metadataBytes: Buffer;
  readonly #sigstoreBundleBytes: Buffer;

  constructor(input: {
    readonly metadata: CapabilityMetadata;
    readonly authority: CapabilityPublisherVerification;
    readonly metadataBytes: Buffer;
    readonly sigstoreBundleBytes: Buffer;
  }) {
    this.metadata = input.metadata;
    this.authority = Object.freeze({ ...input.authority });
    this.#metadataBytes = Buffer.from(input.metadataBytes);
    this.#sigstoreBundleBytes = Buffer.from(input.sigstoreBundleBytes);
    Object.freeze(this);
  }

  metadataBytes(): Buffer {
    return Buffer.from(this.#metadataBytes);
  }

  sigstoreBundleBytes(): Buffer {
    return Buffer.from(this.#sigstoreBundleBytes);
  }
}

export function createSignedCapabilityMetadataVerifier(
  verifier: SigstoreCapabilityVerifier,
): SignedCapabilityMetadataVerifier {
  return Object.freeze({
    async verify(
      input: VerifySignedCapabilityMetadataInput,
    ): Promise<VerifiedSignedCapabilityMetadata> {
      throwIfAborted(input.signal);
      const policy = validateSigstoreCapabilityPublisherPolicy(input);
      const metadataBytes = Buffer.from(input.metadata);
      const sigstoreBundleBytes = Buffer.from(input.sigstoreBundle);
      const metadata = parseCapabilityMetadata(metadataBytes, input.now);
      throwIfAborted(input.signal);
      verifier.verify(metadataBytes, sigstoreBundleBytes, policy);
      throwIfAborted(input.signal);

      return new VerifiedSignedCapabilityMetadata({
        metadata,
        metadataBytes,
        sigstoreBundleBytes,
        authority: {
          kind: "sigstore-keyless-v0.3",
          certificateIssuer: policy.certificateIssuer,
          certificateIdentity: policy.certificateIdentity,
          signatureBundleDigest: `sha256:${createHash("sha256")
            .update(sigstoreBundleBytes)
            .digest("hex")}`,
        },
      });
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
