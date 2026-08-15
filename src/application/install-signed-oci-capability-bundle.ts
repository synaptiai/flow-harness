import {
  assertOciDescriptorBytes,
  type OciCapabilityArtifactReference,
  parseOciCapabilityArtifactReference,
} from "../domain/capability/oci-capability-artifacts.js";
import {
  type SigstoreCapabilityPublisherPolicy,
  type SigstoreCapabilityVerifier,
  validateSigstoreCapabilityPublisherPolicy,
} from "../domain/capability/sigstore-capability-verifier.js";
import type {
  CapabilityPublisherVerification,
  InstallCapabilityBundleInput,
  InstallCapabilityBundleResult,
} from "../infrastructure/fs/local-capability-package-store.js";
import {
  OciCapabilityRegistryError,
  type StrictOciCapabilityRegistry,
} from "../infrastructure/http/strict-oci-capability-registry.js";

export interface SignedOciCapabilityPackageStore {
  install(input: InstallCapabilityBundleInput): Promise<InstallCapabilityBundleResult>;
}

export interface InstallSignedOciCapabilityBundleInput extends SigstoreCapabilityPublisherPolicy {
  readonly reference: string;
  readonly signal?: AbortSignal;
}

export interface InstallSignedOciCapabilityBundleResult extends InstallCapabilityBundleResult {
  readonly source: string;
  readonly publisher: CapabilityPublisherVerification;
}

export interface SignedOciCapabilityBundleInstaller {
  install(
    input: InstallSignedOciCapabilityBundleInput,
  ): Promise<InstallSignedOciCapabilityBundleResult>;
}

export function createSignedOciCapabilityBundleInstaller(
  registry: StrictOciCapabilityRegistry,
  verifier: SigstoreCapabilityVerifier,
  store: SignedOciCapabilityPackageStore,
): SignedOciCapabilityBundleInstaller {
  return Object.freeze({
    async install(
      input: InstallSignedOciCapabilityBundleInput,
    ): Promise<InstallSignedOciCapabilityBundleResult> {
      throwIfAborted(input.signal);
      let requestedReference: OciCapabilityArtifactReference;
      try {
        requestedReference = parseOciCapabilityArtifactReference(input.reference);
      } catch {
        throw new OciCapabilityRegistryError("validate OCI reference");
      }
      const policy = validateSigstoreCapabilityPublisherPolicy(input);
      const acquired = await registry.acquire(requestedReference.canonical, input.signal);
      throwIfAborted(input.signal);

      try {
        if (
          acquired.reference.canonical !== requestedReference.canonical ||
          acquired.manifest.digest !== requestedReference.manifestDigest
        ) {
          throw new Error("acquired artifact identity mismatch");
        }
        assertOciDescriptorBytes(
          acquired.manifest.bundle,
          acquired.capabilityBundle,
          "capability bundle layer",
        );
        assertOciDescriptorBytes(
          acquired.manifest.sigstoreBundle,
          acquired.sigstoreBundle,
          "Sigstore bundle layer",
        );
      } catch {
        throw new OciCapabilityRegistryError("validate OCI manifest");
      }

      verifier.verify(acquired.capabilityBundle, acquired.sigstoreBundle, policy);
      throwIfAborted(input.signal);

      const publisher: CapabilityPublisherVerification = Object.freeze({
        kind: "sigstore-keyless-v0.3",
        certificateIssuer: policy.certificateIssuer,
        certificateIdentity: policy.certificateIdentity,
        signatureBundleDigest: acquired.manifest.sigstoreBundle.digest,
      });
      const installed = await store.install({
        source: acquired.reference.canonical,
        expectedSha256: acquired.manifest.bundle.digest.slice("sha256:".length),
        content: acquired.capabilityBundle,
        publisher,
      });
      return Object.freeze({
        ...installed,
        source: acquired.reference.canonical,
        publisher,
      });
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
