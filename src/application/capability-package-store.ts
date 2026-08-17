import type { CapabilityBundle } from "../domain/capability/capability-bundles.js";
import type {
  CapabilityMetadata,
  CapabilityMetadataTarget,
} from "../domain/capability/capability-metadata.js";

export const CAPABILITY_METADATA_STATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;

export interface CapabilityPublisherVerification {
  readonly kind: "sigstore-keyless-v0.3";
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
  readonly signatureBundleDigest: string;
}

export interface InstallCapabilityBundleInput {
  readonly source: string;
  readonly expectedSha256: string;
  readonly content: Uint8Array;
  readonly publisher?: CapabilityPublisherVerification;
  readonly signal?: AbortSignal;
}

export interface InstallCapabilityBundleResult {
  readonly status: "installed" | "already_installed";
  readonly bundle: CapabilityBundle;
}

export interface CapabilityMetadataState {
  readonly apiVersion: typeof CAPABILITY_METADATA_STATE_API_VERSION;
  readonly kind: "CapabilityMetadataState";
  readonly name: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly metadataBytes: number;
  readonly metadataDigest: string;
  readonly authority: CapabilityPublisherVerification;
  readonly targets: readonly CapabilityMetadataTarget[];
}

export interface RefreshCapabilityMetadataInput {
  readonly metadata: CapabilityMetadata;
  readonly authority: CapabilityPublisherVerification;
  readonly signal?: AbortSignal;
}

export interface RefreshCapabilityMetadataResult {
  readonly status: "established" | "refreshed" | "already_current";
  readonly state: CapabilityMetadataState;
}

export interface CapabilityPackageMutationStore {
  install(input: InstallCapabilityBundleInput): Promise<InstallCapabilityBundleResult>;
  refreshMetadata(input: RefreshCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult>;
}
