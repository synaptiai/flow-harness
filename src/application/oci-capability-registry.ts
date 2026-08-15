import type {
  OciCapabilityArtifactManifest,
  OciCapabilityArtifactReference,
} from "../domain/capability/oci-capability-artifacts.js";

export type OciCapabilityRegistryStage =
  | "validate OCI reference"
  | "resolve OCI registry"
  | "read OCI manifest"
  | "acquire anonymous registry token"
  | "acquire private registry token"
  | "validate OCI manifest"
  | "read capability bundle layer"
  | "read Sigstore bundle layer"
  | "acquire OCI artifact";

export class OciCapabilityRegistryError extends Error {
  override readonly name = "OciCapabilityRegistryError";
  readonly code = "oci_registry_failed" as const;

  constructor(readonly stage: OciCapabilityRegistryStage) {
    super(`OCI capability registry failed during ${stage}`);
  }
}

export interface AcquiredOciCapabilityArtifact {
  readonly reference: OciCapabilityArtifactReference;
  readonly manifest: OciCapabilityArtifactManifest;
  readonly capabilityBundle: Buffer;
  readonly sigstoreBundle: Buffer;
}

export interface OciRegistryCredentialChallenge {
  readonly realm: string;
  readonly service: string;
  readonly scope: string;
}

export interface OciRegistryBasicCredentials {
  readonly username: string;
  readonly password: Buffer;
}

export type OciRegistryCredentialProvider = (
  challenge: OciRegistryCredentialChallenge,
  signal: AbortSignal,
) => Promise<OciRegistryBasicCredentials>;

export interface StrictOciCapabilityRegistry {
  acquire(
    reference: string,
    signal?: AbortSignal,
    credentialProvider?: OciRegistryCredentialProvider,
  ): Promise<AcquiredOciCapabilityArtifact>;
}
