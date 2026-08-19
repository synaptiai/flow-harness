import type { CapabilityBundle } from "../domain/capability/capability-bundles.js";
import type {
  CapabilityMetadata,
  CapabilityMetadataTarget,
} from "../domain/capability/capability-metadata.js";

export const CAPABILITY_METADATA_STATE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const CAPABILITY_PACKAGE_PRUNE_PLAN_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS = 256;
export const MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES = 128 * 1024 * 1024;
export const MAX_CAPABILITY_PACKAGE_RECOVERY_BLOBS = 512;
export const MAX_CAPABILITY_PACKAGE_RECOVERY_BYTES = 256 * 1024 * 1024;

export interface CapabilityPackageRecoveryInventoryInput {
  readonly physicalBlobCount: number;
  readonly physicalBlobBytes: number;
}

export function checkCapabilityPackageRecoveryInventory(
  input: CapabilityPackageRecoveryInventoryInput,
): Readonly<{ allowed: boolean }> {
  if (
    !Number.isSafeInteger(input.physicalBlobCount) ||
    input.physicalBlobCount < 0 ||
    !Number.isSafeInteger(input.physicalBlobBytes) ||
    input.physicalBlobBytes < 0
  ) {
    throw new TypeError("capability package recovery inventory must be non-negative");
  }
  return Object.freeze({
    allowed:
      input.physicalBlobCount <= MAX_CAPABILITY_PACKAGE_RECOVERY_BLOBS &&
      input.physicalBlobBytes <= MAX_CAPABILITY_PACKAGE_RECOVERY_BYTES,
  });
}

export interface CapabilityPackagePhysicalPublicationInput {
  readonly physicalBlobCount: number;
  readonly physicalBlobBytes: number;
  readonly publicationBytes: number;
  readonly blobAlreadyPresent: boolean;
}

export interface CapabilityPackagePhysicalPublicationCheck {
  readonly allowed: boolean;
  readonly resultingBlobCount: number;
  readonly resultingBlobBytes: number;
}

export function checkCapabilityPackagePhysicalPublication(
  input: CapabilityPackagePhysicalPublicationInput,
): CapabilityPackagePhysicalPublicationCheck {
  for (const value of [input.physicalBlobCount, input.physicalBlobBytes, input.publicationBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("capability package physical storage measurements must be non-negative");
    }
  }
  const resultingBlobCount = input.physicalBlobCount + (input.blobAlreadyPresent ? 0 : 1);
  const resultingBlobBytes =
    input.physicalBlobBytes + (input.blobAlreadyPresent ? 0 : input.publicationBytes);
  return Object.freeze({
    allowed:
      resultingBlobCount <= MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS &&
      resultingBlobBytes <= MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES,
    resultingBlobCount,
    resultingBlobBytes,
  });
}

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

export interface InstallCapabilityBundleFromRepositoryInput
  extends Omit<InstallCapabilityBundleInput, "signal"> {
  readonly signal: AbortSignal;
  readonly trustedClockHighWater: string;
  readonly advanceTrustedClockHighWater: (observedAt: string) => Promise<void>;
  readonly assertCurrent: (signal: AbortSignal) => Promise<void>;
}

export interface InstallCapabilityBundleResult {
  readonly status: "installed" | "already_installed";
  readonly bundle: CapabilityBundle;
}

export interface ReplaceCapabilityBundleInput
  extends Omit<InstallCapabilityBundleInput, "publisher"> {
  readonly expectedCurrentVersion: string;
  readonly publisher: CapabilityPublisherVerification;
}

export type ReplaceCapabilityBundleResult =
  | {
      readonly status: "replaced";
      readonly cleanup: "retained";
      readonly bundle: CapabilityBundle;
      readonly previous: Readonly<{
        readonly name: string;
        readonly version: string;
        readonly digest: string;
      }>;
    }
  | {
      readonly status: "already_current";
      readonly bundle: CapabilityBundle;
    };

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

export interface PreviewCapabilityPackagePruneInput {
  readonly signal?: AbortSignal;
}

export interface CapabilityPackagePrunePreview {
  readonly status: "preview";
  readonly planDigest: string;
  readonly retiredBlobCount: number;
  readonly retiredBlobBytes: number;
}

export interface ApplyCapabilityPackagePruneInput {
  readonly expectedPlanDigest: string;
  readonly signal?: AbortSignal;
}

export interface CapabilityPackagePruneApplyResult {
  readonly status: "applied";
  readonly planDigest: string;
  readonly unlinkedBlobCount: number;
  readonly unlinkedBlobBytes: number;
}

export interface CapabilityPackageMutationStore {
  install(input: InstallCapabilityBundleInput): Promise<InstallCapabilityBundleResult>;
  installFromRepository(
    input: InstallCapabilityBundleFromRepositoryInput,
  ): Promise<InstallCapabilityBundleResult>;
  settleMutation(signal: AbortSignal): Promise<void>;
  replace(input: ReplaceCapabilityBundleInput): Promise<ReplaceCapabilityBundleResult>;
  refreshMetadata(input: RefreshCapabilityMetadataInput): Promise<RefreshCapabilityMetadataResult>;
}
