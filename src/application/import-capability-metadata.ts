import { createHash } from "node:crypto";

import { parseCapabilityMetadata } from "../domain/capability/capability-metadata.js";
import {
  type SigstoreCapabilityPublisherPolicy,
  type SigstoreCapabilityVerifier,
  validateSigstoreCapabilityPublisherPolicy,
} from "../domain/capability/sigstore-capability-verifier.js";
import type {
  RefreshCapabilityMetadataInput,
  RefreshCapabilityMetadataResult,
} from "./capability-package-store.js";

export interface ImportCapabilityMetadataInput extends SigstoreCapabilityPublisherPolicy {
  readonly metadata: Uint8Array;
  readonly sigstoreBundle: Uint8Array;
  readonly now: Date;
  readonly signal?: AbortSignal;
}

export interface SignedCapabilityMetadataStore {
  refreshMetadata(input: RefreshCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult>;
}

export interface CapabilityMetadataImporter {
  import(input: ImportCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult>;
}

export function createCapabilityMetadataImporter(
  verifier: SigstoreCapabilityVerifier,
  store: SignedCapabilityMetadataStore,
): CapabilityMetadataImporter {
  return Object.freeze({
    async import(input: ImportCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult> {
      throwIfAborted(input.signal);
      const policy = validateSigstoreCapabilityPublisherPolicy(input);
      const metadataBytes = Buffer.from(input.metadata);
      const sigstoreBundleBytes = Buffer.from(input.sigstoreBundle);
      const metadata = parseCapabilityMetadata(metadataBytes, input.now);
      throwIfAborted(input.signal);
      verifier.verify(metadataBytes, sigstoreBundleBytes, policy);
      throwIfAborted(input.signal);
      return await store.refreshMetadata({
        metadata,
        authority: {
          kind: "sigstore-keyless-v0.3",
          certificateIssuer: policy.certificateIssuer,
          certificateIdentity: policy.certificateIdentity,
          signatureBundleDigest: `sha256:${createHash("sha256")
            .update(sigstoreBundleBytes)
            .digest("hex")}`,
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
