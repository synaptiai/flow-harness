import type {
  SigstoreCapabilityPublisherPolicy,
  SigstoreCapabilityVerifier,
} from "../domain/capability/sigstore-capability-verifier.js";
import type {
  RefreshCapabilityMetadataInput,
  RefreshCapabilityMetadataResult,
} from "./capability-package-store.js";
import { createSignedCapabilityMetadataVerifier } from "./verify-signed-capability-metadata.js";

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
  const signedMetadataVerifier = createSignedCapabilityMetadataVerifier(verifier);
  return Object.freeze({
    async import(input: ImportCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult> {
      const verified = await signedMetadataVerifier.verify(input);
      return await store.refreshMetadata({
        metadata: verified.metadata,
        authority: verified.authority,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  });
}
