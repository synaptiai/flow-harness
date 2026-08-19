import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  type ApplyCapabilityPackagePruneInput,
  CAPABILITY_METADATA_STATE_API_VERSION,
  CAPABILITY_PACKAGE_PRUNE_PLAN_API_VERSION,
  type CapabilityMetadataState,
  type CapabilityPackagePruneApplyResult,
  type CapabilityPackagePrunePreview,
  type CapabilityPublisherVerification,
  checkCapabilityPackagePhysicalPublication,
  checkCapabilityPackageRecoveryInventory,
  type InstallCapabilityBundleFromRepositoryInput,
  type InstallCapabilityBundleInput,
  type InstallCapabilityBundleResult,
  type PreviewCapabilityPackagePruneInput,
  type RefreshCapabilityMetadataInput,
  type RefreshCapabilityMetadataResult,
  type ReplaceCapabilityBundleInput,
  type ReplaceCapabilityBundleResult,
} from "../../application/capability-package-store.js";
import {
  assertCapabilityBundleReplacement,
  CapabilityBundleReplacementError,
} from "../../domain/capability/capability-bundle-replacement.js";
import {
  type CapabilityBundle,
  MAX_CAPABILITY_BUNDLE_BYTES,
  parseDigestPinnedCapabilityBundle,
} from "../../domain/capability/capability-bundles.js";
import {
  CAPABILITY_METADATA_API_VERSION,
  type CapabilityMetadata,
  type CapabilityMetadataTarget,
  MAX_CAPABILITY_METADATA_BYTES,
  MAX_CAPABILITY_METADATA_TARGETS,
} from "../../domain/capability/capability-metadata.js";
import { parseOciCapabilityArtifactReference } from "../../domain/capability/oci-capability-artifacts.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../../domain/capability/verifier-packages.js";
import { parseStrictJson } from "../../domain/strict-json.js";

export const CAPABILITY_LOCK_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export {
  type ApplyCapabilityPackagePruneInput,
  CAPABILITY_METADATA_STATE_API_VERSION,
  CAPABILITY_PACKAGE_PRUNE_PLAN_API_VERSION,
  type CapabilityMetadataState,
  type CapabilityPackagePruneApplyResult,
  type CapabilityPackagePrunePreview,
  type CapabilityPublisherVerification,
  type InstallCapabilityBundleFromRepositoryInput,
  type InstallCapabilityBundleInput,
  type InstallCapabilityBundleResult,
  type PreviewCapabilityPackagePruneInput,
  type RefreshCapabilityMetadataInput,
  type RefreshCapabilityMetadataResult,
  type ReplaceCapabilityBundleInput,
  type ReplaceCapabilityBundleResult,
} from "../../application/capability-package-store.js";

const MAX_CAPABILITY_LOCK_BYTES = 512 * 1024;
const MAX_CAPABILITY_METADATA_STATE_BYTES = 768 * 1024;
const MAX_CAPABILITY_LOCK_ENTRIES = 128;
const MAX_CAPABILITY_LOCKED_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_ERROR_BYTES = 16_384;
const CAPABILITY_BLOB_FILE_NAME = /^[a-f0-9]{64}\.flowpkg$/;

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const capabilityPublisherSchema = z
  .object({
    kind: z.literal("sigstore-keyless-v0.3"),
    certificateIssuer: z
      .string()
      .min(1)
      .max(2_048)
      .refine(isCanonicalHttpsIssuer, "must be a canonical HTTPS issuer"),
    certificateIdentity: z
      .string()
      .min(1)
      .max(4_096)
      .refine(isCanonicalPublisherIdentity, "must be a bounded exact identity"),
    signatureBundleDigest: sha256DigestSchema,
  })
  .strict();
const capabilityLockEntrySchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    source: z.string().min(1).max(4_096),
    digest: sha256DigestSchema,
    bytes: z.number().int().positive().max(MAX_CAPABILITY_BUNDLE_BYTES),
    publisher: capabilityPublisherSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (!isValidCapabilitySource(entry.source, entry.publisher !== undefined)) {
      context.addIssue({ code: "custom", path: ["source"], message: "invalid source authority" });
    }
  });

const capabilityLockSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_LOCK_API_VERSION),
    kind: z.literal("CapabilityLock"),
    bundles: z.array(capabilityLockEntrySchema).max(MAX_CAPABILITY_LOCK_ENTRIES),
  })
  .strict();

const capabilityMetadataPublisherPolicySchema = capabilityPublisherSchema.omit({
  kind: true,
  signatureBundleDigest: true,
});
const capabilityMetadataTargetSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    digest: sha256DigestSchema,
    bytes: z.number().int().positive().max(MAX_CAPABILITY_BUNDLE_BYTES),
    source: z.string().min(1).max(4_096),
    status: z.enum(["active", "revoked"]),
    publisher: capabilityMetadataPublisherPolicySchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (!isValidCapabilitySource(target.source, target.publisher !== undefined)) {
      context.addIssue({ code: "custom", path: ["source"], message: "invalid source authority" });
    }
  });
const capabilityMetadataStateSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_METADATA_STATE_API_VERSION),
    kind: z.literal("CapabilityMetadataState"),
    name: verifierPackageNameSchema,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.string().refine(isCanonicalInstant),
    metadataBytes: z.number().int().positive().max(MAX_CAPABILITY_METADATA_BYTES),
    metadataDigest: sha256DigestSchema,
    authority: capabilityPublisherSchema,
    targets: z.array(capabilityMetadataTargetSchema).max(MAX_CAPABILITY_METADATA_TARGETS),
  })
  .strict();

const mutationLockOwnerSchema = z
  .object({
    pid: z.number().int().positive().max(2_147_483_647),
    hostname: z.string().min(1).max(255),
    token: z.string().min(1).max(128),
  })
  .strict();

export interface CapabilityLockEntry {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly digest: string;
  readonly bytes: number;
  readonly publisher?: CapabilityPublisherVerification;
}

export interface CapabilityLock {
  readonly apiVersion: typeof CAPABILITY_LOCK_API_VERSION;
  readonly kind: "CapabilityLock";
  readonly bundles: readonly CapabilityLockEntry[];
}

export type CapabilityPackageStoreErrorCode =
  | "invalid_bundle"
  | "invalid_source"
  | "invalid_identity"
  | "invalid_lock"
  | "invalid_metadata"
  | "metadata_rollback"
  | "metadata_expired"
  | "metadata_target"
  | "identity_conflict"
  | "corrupt_blob"
  | "unsafe_state"
  | "busy"
  | "not_found"
  | "physical_limit"
  | "plan_mismatch"
  | "commit_uncertain"
  | "settlement_uncertain"
  | "io";

export class CapabilityPackageStoreError extends Error {
  override readonly name = "CapabilityPackageStoreError";

  constructor(
    readonly code: CapabilityPackageStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RemoveCapabilityBundleResult {
  readonly status: "removed";
  readonly cleanup: "deleted" | "missing" | "failed";
  readonly entry: CapabilityLockEntry;
}

export interface VerifiedInstalledCapabilityBundle {
  readonly entry: CapabilityLockEntry;
  readonly bundle: CapabilityBundle;
}

export interface CapabilityPackageStoreHooks {
  readonly afterCapabilityLockRenamed?: () => Promise<void>;
  readonly beforeCapabilityLockRename?: () => Promise<void>;
  readonly beforeCapabilityLockPublished?: () => Promise<void>;
  readonly beforeMutationLockRelease?: () => Promise<void>;
  readonly beforeStoreDirectoryParentSync?: (path: string, parent: string) => Promise<void>;
  readonly afterStoreDirectoryParentSynced?: (path: string, parent: string) => Promise<void>;
  readonly afterMutationLockCollision?: () => Promise<void>;
  readonly afterPruneBlobDirectorySynced?: () => Promise<void>;
  readonly afterPruneCandidateUnlinked?: (
    candidate: Readonly<{ digest: string; bytes: number }>,
  ) => Promise<void>;
  readonly beforePruneCandidateUnlink?: (
    candidate: Readonly<{ digest: string; bytes: number }>,
  ) => Promise<void>;
  readonly beforePruneBlobDirectorySync?: () => Promise<void>;
  readonly settlePruneHandle?: (
    kind: "blob" | "directory",
    close: () => Promise<void>,
  ) => Promise<void>;
  readonly settleVerifiedGenerationHandle?: (
    entry: CapabilityLockEntry,
    close: () => Promise<void>,
  ) => Promise<void>;
  readonly afterVerifyBundleOpened?: (entry: CapabilityLockEntry) => Promise<void>;
  readonly beforeVerifyBundleOpen?: (entry: CapabilityLockEntry) => Promise<void>;
  readonly beforeVerifyBundleRead?: (entry: CapabilityLockEntry) => Promise<void>;
  readonly beforeVerifyLockRead?: () => Promise<void>;
  readonly beforeCapabilityMetadataRename?: () => Promise<void>;
  readonly afterCapabilityMetadataRenamed?: () => Promise<void>;
  readonly now?: () => Date;
}

export interface VerifyCapabilityBundlesOptions {
  readonly signal?: AbortSignal;
}

export class LocalCapabilityPackageStore {
  constructor(
    readonly projectRoot: string,
    private readonly hooks: CapabilityPackageStoreHooks = {},
  ) {}

  async refreshMetadata(
    input: RefreshCapabilityMetadataInput,
  ): Promise<RefreshCapabilityMetadataResult> {
    throwIfAborted(input.signal);
    const state = createCapabilityMetadataState(input.metadata, input.authority);
    requireCurrentMetadata(state, this.now());
    const paths = await storePaths(this.projectRoot);
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    return await withMutationLock(mutationLock, async () => {
      throwIfAborted(input.signal);
      requireCurrentMetadata(state, this.now());
      const current = await readCapabilityMetadataState(paths.metadataPath);
      if (current !== null) {
        requireMonotonicMetadata(current, state);
        if (current.version === state.version) {
          return deepFreeze({ status: "already_current" as const, state: current });
        }
      }
      await publishCapabilityMetadataState(paths, state, this.hooks, input.signal);
      return deepFreeze({
        status: current === null ? ("established" as const) : ("refreshed" as const),
        state,
      });
    });
  }

  async inspectMetadata(signal?: AbortSignal): Promise<CapabilityMetadataState | null> {
    throwIfAborted(signal);
    const paths = await storePaths(this.projectRoot);
    throwIfAborted(signal);
    const state = await readCapabilityMetadataState(paths.metadataPath);
    throwIfAborted(signal);
    return state;
  }

  private now(): Date {
    const value = this.hooks.now?.() ?? new Date();
    return new Date(value.getTime());
  }

  async install(input: InstallCapabilityBundleInput): Promise<InstallCapabilityBundleResult> {
    return await this.#install(input, false);
  }

  async installFromRepository(
    input: InstallCapabilityBundleFromRepositoryInput,
  ): Promise<InstallCapabilityBundleResult> {
    return await this.#install(input, true);
  }

  async settleMutation(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const paths = await storePaths(this.projectRoot);
    signal.throwIfAborted();
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    await withMutationLock(mutationLock, async () => {
      signal.throwIfAborted();
    });
  }

  async #install(
    input: InstallCapabilityBundleInput | InstallCapabilityBundleFromRepositoryInput,
    metadataRequired: boolean,
  ): Promise<InstallCapabilityBundleResult> {
    throwIfAborted(input.signal);
    if (
      !isValidCapabilitySource(input.source, input.publisher !== undefined) ||
      (input.publisher !== undefined &&
        !capabilityPublisherSchema.safeParse(input.publisher).success)
    ) {
      throw new CapabilityPackageStoreError(
        "invalid_source",
        "capability bundle source and publisher evidence are invalid",
      );
    }
    const publisher =
      input.publisher === undefined ? undefined : canonicalPublisher(input.publisher);
    let bundle: CapabilityBundle;
    try {
      bundle = parseDigestPinnedCapabilityBundle(input.content, input.expectedSha256);
    } catch (error) {
      throw new CapabilityPackageStoreError(
        "invalid_bundle",
        boundedMessage(
          `capability bundle is invalid: ${error instanceof Error ? error.message : String(error)}`,
        ),
        { cause: error },
      );
    }
    throwIfAborted(input.signal);
    const paths = await storePaths(this.projectRoot);
    throwIfAborted(input.signal);
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    return await withMutationLock(mutationLock, async () => {
      throwIfAborted(input.signal);
      const repositoryInput = metadataRequired
        ? (input as InstallCapabilityBundleFromRepositoryInput)
        : undefined;
      const observeNow =
        repositoryInput === undefined
          ? async () => this.now()
          : createRepositoryClockObserver(repositoryInput, () => this.now());
      const metadata = await readCapabilityMetadataState(paths.metadataPath);
      throwIfAborted(input.signal);
      if (metadataRequired && metadata === null) {
        throw new CapabilityPackageStoreError(
          "metadata_target",
          "capability bundle does not match one active trusted metadata target",
        );
      }
      requireTrustedTarget(metadata, bundle, input.source, publisher, await observeNow());
      const assertRepositoryCurrent =
        repositoryInput === undefined
          ? undefined
          : async () => {
              await assertRepositoryInstallCurrent(repositoryInput, observeNow);
              requireTrustedTarget(metadata, bundle, input.source, publisher, await observeNow());
            };
      const assertPublicationCurrent =
        assertRepositoryCurrent ??
        (metadata === null
          ? undefined
          : async () => {
              requireTrustedTarget(metadata, bundle, input.source, publisher, await observeNow());
            });
      const lock = await readCapabilityLock(paths.lockPath);
      throwIfAborted(input.signal);
      const sameName = lock.bundles.filter((entry) => entry.name === bundle.name);
      const existing = sameName.find(
        (entry) => entry.name === bundle.name && entry.version === bundle.version,
      );
      if (
        metadataRequired &&
        (sameName.length > 1 || (sameName.length === 1 && existing === undefined))
      ) {
        throw new CapabilityPackageStoreError(
          "identity_conflict",
          `capability package ${bundle.name} already has a different active version`,
        );
      }
      if (existing !== undefined) {
        if (existing.digest !== bundle.digest) {
          throw new CapabilityPackageStoreError(
            "identity_conflict",
            `capability bundle ${bundle.name}@${bundle.version} is already locked to ${existing.digest}`,
          );
        }
        if (
          publisher !== undefined &&
          (existing.source !== input.source ||
            existing.publisher === undefined ||
            !isDeepStrictEqual(existing.publisher, publisher))
        ) {
          throw new CapabilityPackageStoreError(
            "identity_conflict",
            `capability bundle ${bundle.name}@${bundle.version} is already locked with different acquisition evidence`,
          );
        }
        await requireExactBlob(paths, existing, Buffer.from(input.content));
        throwIfAborted(input.signal);
        if (assertRepositoryCurrent !== undefined) {
          await assertRepositoryCurrent();
        } else {
          requireTrustedTarget(
            metadata,
            bundle,
            existing.source,
            existing.publisher,
            await observeNow(),
          );
        }
        return Object.freeze({ status: "already_installed" as const, bundle });
      }
      const entry: CapabilityLockEntry = Object.freeze({
        name: bundle.name,
        version: bundle.version,
        source: input.source,
        digest: bundle.digest,
        bytes: bundle.bytes,
        ...(publisher === undefined ? {} : { publisher }),
      });
      await requirePhysicalPublicationAllowed(paths, lock, entry, input.signal, this.hooks);
      await publishBlob(
        paths,
        entry,
        Buffer.from(input.content),
        this.hooks,
        input.signal,
        assertPublicationCurrent,
      );
      throwIfAborted(input.signal);
      const bundles = [...lock.bundles, entry].sort(compareLockEntries);
      assertCanonicalLockEntries(bundles);
      await publishCapabilityLock(
        paths,
        {
          apiVersion: CAPABILITY_LOCK_API_VERSION,
          kind: "CapabilityLock",
          bundles,
        },
        this.hooks,
        input.signal,
        assertPublicationCurrent,
      );
      return Object.freeze({ status: "installed" as const, bundle });
    });
  }

  async replace(input: ReplaceCapabilityBundleInput): Promise<ReplaceCapabilityBundleResult> {
    throwIfAborted(input.signal);
    if (
      !verifierPackageVersionSchema.safeParse(input.expectedCurrentVersion).success ||
      !isValidCapabilitySource(input.source, true) ||
      !capabilityPublisherSchema.safeParse(input.publisher).success
    ) {
      throw new CapabilityPackageStoreError(
        "invalid_source",
        "capability bundle replacement input is invalid",
      );
    }
    const publisher = canonicalPublisher(input.publisher);
    let bundle: CapabilityBundle;
    try {
      bundle = parseDigestPinnedCapabilityBundle(input.content, input.expectedSha256);
    } catch (error) {
      throw new CapabilityPackageStoreError("invalid_bundle", "replacement bundle is invalid", {
        cause: error,
      });
    }
    throwIfAborted(input.signal);
    const paths = await storePaths(this.projectRoot);
    throwIfAborted(input.signal);
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    return await withMutationLock(mutationLock, async () => {
      throwIfAborted(input.signal);
      const metadata = await readCapabilityMetadataState(paths.metadataPath);
      throwIfAborted(input.signal);
      requireTrustedTarget(metadata, bundle, input.source, publisher, this.now());
      const lock = await readCapabilityLock(paths.lockPath, input.signal, this.hooks);
      throwIfAborted(input.signal);
      const sameName = lock.bundles.filter((entry) => entry.name === bundle.name);
      const alreadyCurrent = sameName.find((entry) => entry.version === bundle.version);
      if (alreadyCurrent !== undefined) {
        if (
          sameName.length !== 1 ||
          alreadyCurrent.digest !== bundle.digest ||
          alreadyCurrent.bytes !== bundle.bytes ||
          alreadyCurrent.source !== input.source ||
          alreadyCurrent.publisher === undefined ||
          !isDeepStrictEqual(alreadyCurrent.publisher, publisher)
        ) {
          throw replacementConflict();
        }
        await requireExactBlob(paths, alreadyCurrent, Buffer.from(input.content));
        throwIfAborted(input.signal);
        return deepFreeze({ status: "already_current" as const, bundle });
      }
      const current = sameName.find((entry) => entry.version === input.expectedCurrentVersion);
      if (sameName.length !== 1 || current === undefined) {
        throw new CapabilityPackageStoreError(
          "not_found",
          "established capability bundle version is not available for replacement",
        );
      }
      const installed = await readVerifiedLockedBundle(paths, current, input.signal, this.hooks);
      throwIfAborted(input.signal);
      requireTrustedTarget(
        metadata,
        installed.bundle,
        current.source,
        current.publisher,
        this.now(),
      );
      if (
        current.publisher === undefined ||
        current.publisher.certificateIssuer !== publisher.certificateIssuer ||
        current.publisher.certificateIdentity !== publisher.certificateIdentity
      ) {
        throw replacementConflict();
      }
      try {
        assertCapabilityBundleReplacement(installed.bundle, bundle);
      } catch (error) {
        if (error instanceof CapabilityBundleReplacementError) {
          throw replacementConflict(error);
        }
        throw error;
      }
      const entry: CapabilityLockEntry = Object.freeze({
        name: bundle.name,
        version: bundle.version,
        source: input.source,
        digest: bundle.digest,
        bytes: bundle.bytes,
        publisher,
      });
      await requirePhysicalPublicationAllowed(paths, lock, entry, input.signal, this.hooks);
      await publishBlob(paths, entry, Buffer.from(input.content), this.hooks, input.signal);
      throwIfAborted(input.signal);
      requireTrustedTarget(metadata, bundle, input.source, publisher, this.now());
      const bundles = lock.bundles
        .map((existing) => (existing === current ? entry : existing))
        .sort(compareLockEntries);
      assertCanonicalLockEntries(bundles);
      await publishCapabilityLock(
        paths,
        { apiVersion: CAPABILITY_LOCK_API_VERSION, kind: "CapabilityLock", bundles },
        this.hooks,
        input.signal,
      );
      return deepFreeze({
        status: "replaced" as const,
        cleanup: "retained" as const,
        bundle,
        previous: { name: current.name, version: current.version, digest: current.digest },
      });
    });
  }

  async previewPrune(
    input: PreviewCapabilityPackagePruneInput = {},
  ): Promise<CapabilityPackagePrunePreview> {
    throwIfAborted(input.signal);
    const paths = await storePaths(this.projectRoot);
    throwIfAborted(input.signal);
    const plan = await buildCapabilityPackagePrunePlan(paths, input.signal, this.hooks);
    throwIfAborted(input.signal);
    return deepFreeze({
      status: "preview" as const,
      planDigest: plan.planDigest,
      retiredBlobCount: plan.candidates.length,
      retiredBlobBytes: plan.candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    });
  }

  async applyPrune(
    input: ApplyCapabilityPackagePruneInput,
  ): Promise<CapabilityPackagePruneApplyResult> {
    throwIfAborted(input.signal);
    if (!sha256DigestSchema.safeParse(input.expectedPlanDigest).success) {
      throw new CapabilityPackageStoreError(
        "plan_mismatch",
        "capability package prune plan digest is invalid",
      );
    }
    const paths = await storePaths(this.projectRoot);
    throwIfAborted(input.signal);
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    return await withMutationLock(mutationLock, async () => {
      throwIfAborted(input.signal);
      const plan = await buildCapabilityPackagePrunePlan(paths, input.signal, this.hooks);
      throwIfAborted(input.signal);
      if (plan.planDigest !== input.expectedPlanDigest) {
        throw new CapabilityPackageStoreError(
          "plan_mismatch",
          "capability package prune plan no longer matches the store",
        );
      }
      let unlinkedBlobBytes = 0;
      let unlinkedBlobCount = 0;
      let primaryFailure: unknown;
      try {
        for (const candidate of plan.candidates) {
          throwIfAborted(input.signal);
          await this.hooks.beforePruneCandidateUnlink?.(candidate);
          throwIfAborted(input.signal);
          await unlinkPruneCandidate(paths, candidate, input.signal, this.hooks);
          unlinkedBlobBytes += candidate.bytes;
          unlinkedBlobCount += 1;
          await this.hooks.afterPruneCandidateUnlinked?.(candidate);
          throwIfAborted(input.signal);
        }
      } catch (error) {
        primaryFailure =
          input.signal?.aborted === true
            ? input.signal.reason
            : error instanceof CapabilityPackageStoreError
              ? error
              : ioError("could not apply retired capability package maintenance", error);
      }
      if (unlinkedBlobCount > 0) {
        try {
          await this.hooks.beforePruneBlobDirectorySync?.();
          await syncDirectory(paths.blobDirectory);
          await this.hooks.afterPruneBlobDirectorySynced?.();
        } catch (error) {
          throw new CapabilityPackageStoreError(
            "settlement_uncertain",
            "retired capability package maintenance could not be settled",
            {
              cause:
                primaryFailure === undefined
                  ? error
                  : new AggregateError(
                      [primaryFailure, error],
                      "capability package maintenance and settlement failed",
                    ),
            },
          );
        }
      }
      if (primaryFailure !== undefined) {
        throw primaryFailure;
      }
      if (input.signal?.aborted === true) {
        throw input.signal.reason;
      }
      return deepFreeze({
        status: "applied" as const,
        planDigest: plan.planDigest,
        unlinkedBlobCount,
        unlinkedBlobBytes,
      });
    });
  }

  async list(): Promise<CapabilityLock> {
    const paths = await storePaths(this.projectRoot);
    return await readCapabilityLock(paths.lockPath);
  }

  async inspect(
    name: string,
    version: string,
    options: VerifyCapabilityBundlesOptions = {},
  ): Promise<VerifiedInstalledCapabilityBundle> {
    if (
      !verifierPackageNameSchema.safeParse(name).success ||
      !verifierPackageVersionSchema.safeParse(version).success
    ) {
      throw new CapabilityPackageStoreError(
        "invalid_identity",
        "capability bundle inspection requires a valid name and exact version",
      );
    }
    options.signal?.throwIfAborted();
    const paths = await storePaths(this.projectRoot);
    const [installed] = await readVerifiedCapabilityGeneration(
      paths,
      (lock) => {
        const entry = lock.bundles.find(
          (candidate) => candidate.name === name && candidate.version === version,
        );
        if (entry === undefined) {
          throw new CapabilityPackageStoreError(
            "not_found",
            `capability bundle ${name}@${version} is not installed`,
          );
        }
        return [entry];
      },
      options.signal,
      this.hooks,
    );
    options.signal?.throwIfAborted();
    return installed as VerifiedInstalledCapabilityBundle;
  }

  async verify(
    options: VerifyCapabilityBundlesOptions = {},
  ): Promise<readonly VerifiedInstalledCapabilityBundle[]> {
    options.signal?.throwIfAborted();
    const paths = await storePaths(this.projectRoot);
    options.signal?.throwIfAborted();
    const metadata = await readCapabilityMetadataState(paths.metadataPath);
    if (metadata !== null) {
      requireCurrentMetadata(metadata, this.now());
    }
    const verified = await readVerifiedCapabilityGeneration(
      paths,
      (lock) => lock.bundles,
      options.signal,
      this.hooks,
    );
    for (const installed of verified) {
      options.signal?.throwIfAborted();
      requireTrustedTarget(
        metadata,
        installed.bundle,
        installed.entry.source,
        installed.entry.publisher,
        this.now(),
      );
    }
    const settledMetadata = await readCapabilityMetadataState(paths.metadataPath);
    if (!isDeepStrictEqual(metadata, settledMetadata)) {
      throw new CapabilityPackageStoreError(
        "metadata_target",
        "trusted capability metadata changed during package verification",
      );
    }
    if (metadata !== null) {
      requireCurrentMetadata(metadata, this.now());
    }
    options.signal?.throwIfAborted();
    return deepFreeze(verified);
  }

  async remove(name: string, version: string): Promise<RemoveCapabilityBundleResult> {
    if (
      !verifierPackageNameSchema.safeParse(name).success ||
      !verifierPackageVersionSchema.safeParse(version).success
    ) {
      throw new CapabilityPackageStoreError(
        "invalid_identity",
        "capability bundle removal requires a valid name and exact version",
      );
    }
    const paths = await storePaths(this.projectRoot);
    const mutationLock = await acquireMutationLock(paths.flowDirectory, this.hooks);
    return await withMutationLock(mutationLock, async () => {
      const lock = await readCapabilityLock(paths.lockPath);
      const index = lock.bundles.findIndex(
        (entry) => entry.name === name && entry.version === version,
      );
      const entry = lock.bundles[index];
      if (index < 0 || entry === undefined) {
        throw new CapabilityPackageStoreError(
          "not_found",
          `capability bundle ${name}@${version} is not installed`,
        );
      }
      await publishCapabilityLock(
        paths,
        {
          apiVersion: CAPABILITY_LOCK_API_VERSION,
          kind: "CapabilityLock",
          bundles: lock.bundles.filter((_, entryIndex) => entryIndex !== index),
        },
        this.hooks,
      );
      const cleanup = await cleanupOrphanBlob(paths, entry);
      return deepFreeze({ status: "removed" as const, cleanup, entry: { ...entry } });
    });
  }
}

interface CapabilityPackagePruneCandidate {
  readonly digest: string;
  readonly bytes: number;
}

interface CapabilityPackagePrunePlan {
  readonly apiVersion: typeof CAPABILITY_PACKAGE_PRUNE_PLAN_API_VERSION;
  readonly kind: "CapabilityPackagePrunePlan";
  readonly activeLockDigest: string;
  readonly candidates: readonly CapabilityPackagePruneCandidate[];
  readonly planDigest: string;
}

async function buildCapabilityPackagePrunePlan(
  paths: CapabilityStorePaths,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<CapabilityPackagePrunePlan> {
  signal?.throwIfAborted();
  const lock = await readCapabilityLock(paths.lockPath, signal);
  signal?.throwIfAborted();
  const activeByDigest = new Map(lock.bundles.map((entry) => [entry.digest, entry]));
  const observedActive = new Set<string>();
  const candidates: CapabilityPackagePruneCandidate[] = [];
  let physicalBlobCount = 0;
  let physicalBlobBytes = 0;
  let directory: Awaited<ReturnType<typeof opendir>>;
  let scanFailure: unknown;
  try {
    directory = await opendir(paths.blobDirectory);
  } catch (error) {
    signal?.throwIfAborted();
    if (isNodeError(error) && error.code === "ENOENT" && lock.bundles.length === 0) {
      return createCapabilityPackagePrunePlan(lock, candidates);
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CapabilityPackageStoreError(
        "corrupt_blob",
        "active capability package blobs are missing",
      );
    }
    throw ioError("could not inspect capability package blob store", error);
  }
  try {
    await requireCanonicalBlobStore(paths);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      physicalBlobCount += 1;
      if (
        !checkCapabilityPackageRecoveryInventory({
          physicalBlobCount,
          physicalBlobBytes,
        }).allowed
      ) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "capability package blob store exceeds its recovery entry limit",
        );
      }
      if (!CAPABILITY_BLOB_FILE_NAME.test(entry.name)) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "capability package blob store contains an unexpected entry",
        );
      }
      const digestHex = entry.name.slice(0, -".flowpkg".length);
      const digest = `sha256:${digestHex}`;
      const content = await readBoundedSingleLinkBlob(
        join(paths.blobDirectory, entry.name),
        signal,
        hooks,
      );
      physicalBlobBytes += content.byteLength;
      if (
        !checkCapabilityPackageRecoveryInventory({
          physicalBlobCount,
          physicalBlobBytes,
        }).allowed
      ) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "capability package blob store exceeds its recovery byte limit",
        );
      }
      if (sha256Digest(content) !== digest) {
        throw new CapabilityPackageStoreError(
          "corrupt_blob",
          "capability package blob content does not match its canonical name",
        );
      }
      const active = activeByDigest.get(digest);
      if (active === undefined) {
        candidates.push(Object.freeze({ digest, bytes: content.byteLength }));
      } else {
        if (active.bytes !== content.byteLength) {
          throw new CapabilityPackageStoreError(
            "corrupt_blob",
            "active capability package blob does not match its locked byte count",
          );
        }
        observedActive.add(digest);
      }
    }
    await requireCanonicalBlobStore(paths);
  } catch (error) {
    scanFailure = signal?.aborted === true ? signal.reason : error;
  }
  let closeFailure: unknown;
  try {
    await settlePruneHandle(
      "directory",
      async () => {
        await directory.close().catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== "ERR_DIR_CLOSED") {
            throw error;
          }
        });
      },
      hooks,
    );
  } catch (error) {
    closeFailure = error;
  }
  if (closeFailure !== undefined) {
    throw pruneHandleSettlementFailure(scanFailure, closeFailure);
  }
  if (scanFailure !== undefined) {
    throw scanFailure;
  }
  if (observedActive.size !== activeByDigest.size) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      "active capability package blobs are missing",
    );
  }
  candidates.sort((left, right) =>
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
  );
  return createCapabilityPackagePrunePlan(lock, candidates);
}

function createCapabilityPackagePrunePlan(
  lock: CapabilityLock,
  candidates: readonly CapabilityPackagePruneCandidate[],
): CapabilityPackagePrunePlan {
  const payload = Object.freeze({
    apiVersion: CAPABILITY_PACKAGE_PRUNE_PLAN_API_VERSION,
    kind: "CapabilityPackagePrunePlan" as const,
    activeLockDigest: capabilityLockDigest(lock),
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate }))),
  });
  return deepFreeze({
    ...payload,
    planDigest: sha256Digest(Buffer.from(JSON.stringify(payload))),
  });
}

async function requirePhysicalPublicationAllowed(
  paths: CapabilityStorePaths,
  lock: CapabilityLock,
  entry: CapabilityLockEntry,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<void> {
  signal?.throwIfAborted();
  const plan = await buildCapabilityPackagePrunePlan(paths, signal, hooks);
  signal?.throwIfAborted();
  if (plan.activeLockDigest !== capabilityLockDigest(lock)) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package lock changed during physical storage inspection",
    );
  }
  const physicalBlobCount = lock.bundles.length + plan.candidates.length;
  const physicalBlobBytes =
    lock.bundles.reduce((total, active) => total + active.bytes, 0) +
    plan.candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const blobAlreadyPresent =
    lock.bundles.some((active) => active.digest === entry.digest) ||
    plan.candidates.some((candidate) => candidate.digest === entry.digest);
  const publication = checkCapabilityPackagePhysicalPublication({
    physicalBlobCount,
    physicalBlobBytes,
    publicationBytes: entry.bytes,
    blobAlreadyPresent,
  });
  if (!publication.allowed) {
    throw new CapabilityPackageStoreError(
      "physical_limit",
      "capability package physical storage limit would be exceeded",
    );
  }
}

function capabilityLockDigest(lock: CapabilityLock): string {
  return sha256Digest(Buffer.from(JSON.stringify(lock)));
}

async function unlinkPruneCandidate(
  paths: CapabilityStorePaths,
  candidate: CapabilityPackagePruneCandidate,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<void> {
  signal?.throwIfAborted();
  await requireCanonicalBlobStore(paths);
  const path = join(paths.blobDirectory, `${candidate.digest.slice("sha256:".length)}.flowpkg`);
  const content = await readBoundedSingleLinkBlob(path, signal, hooks);
  signal?.throwIfAborted();
  if (content.byteLength !== candidate.bytes || sha256Digest(content) !== candidate.digest) {
    throw new CapabilityPackageStoreError(
      "plan_mismatch",
      "capability package prune candidate changed before deletion",
    );
  }
  await requireCanonicalBlobStore(paths);
  signal?.throwIfAborted();
  try {
    await unlink(path);
  } catch (error) {
    signal?.throwIfAborted();
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CapabilityPackageStoreError(
        "plan_mismatch",
        "capability package prune candidate changed before deletion",
      );
    }
    throw ioError("could not unlink retired capability package blob", error);
  }
}

async function readBoundedSingleLinkBlob(
  path: string,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<Buffer> {
  signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>>;
  let content: Buffer | undefined;
  let primaryFailure: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    signal?.throwIfAborted();
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        "capability package blob must be a real regular file",
        { cause: error },
      );
    }
    throw error;
  }
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_CAPABILITY_BUNDLE_BYTES)
    ) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        "capability package blob is not a bounded single-link regular file",
      );
    }
    content = await readBoundedHandle(handle, MAX_CAPABILITY_BUNDLE_BYTES, signal);
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(content.byteLength) !== before.size
    ) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        "capability package blob changed while it was read",
      );
    }
  } catch (error) {
    primaryFailure = signal?.aborted === true ? signal.reason : error;
  }
  let closeFailure: unknown;
  try {
    await settlePruneHandle("blob", async () => await handle.close(), hooks);
  } catch (error) {
    closeFailure = error;
  }
  if (closeFailure !== undefined) {
    throw pruneHandleSettlementFailure(primaryFailure, closeFailure);
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  return content as Buffer;
}

async function settlePruneHandle(
  kind: "blob" | "directory",
  close: () => Promise<void>,
  hooks?: CapabilityPackageStoreHooks,
): Promise<void> {
  if (hooks?.settlePruneHandle === undefined) {
    await close();
    return;
  }
  await hooks.settlePruneHandle(kind, close);
}

function pruneHandleSettlementFailure(primary: unknown, cleanup: unknown): Error {
  return new CapabilityPackageStoreError(
    "settlement_uncertain",
    "capability package prune handles could not be settled",
    {
      cause:
        primary === undefined
          ? cleanup
          : new AggregateError(
              [primary, cleanup],
              "capability package prune inspection and handle settlement failed",
            ),
    },
  );
}

function sha256Digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

interface CapabilityStorePaths {
  readonly flowDirectory: string;
  readonly packagesDirectory: string;
  readonly blobDirectory: string;
  readonly lockPath: string;
  readonly metadataPath: string;
}

function replacementConflict(cause?: unknown): CapabilityPackageStoreError {
  return new CapabilityPackageStoreError(
    "identity_conflict",
    "capability bundle replacement is incompatible with the established package",
    cause === undefined ? undefined : { cause },
  );
}

async function storePaths(projectRoot: string): Promise<CapabilityStorePaths> {
  const requestedRoot = resolve(projectRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch (error) {
    throw ioError("could not resolve capability package project root", error);
  }
  const flowDirectory = join(canonicalRoot, ".flow");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(flowDirectory);
  } catch (error) {
    throw ioError("capability package store requires an existing .flow directory", error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package .flow path must be a real directory",
    );
  }
  const canonicalFlow = await realpath(flowDirectory).catch((error: unknown) => {
    throw ioError("could not resolve capability package .flow directory", error);
  });
  if (canonicalFlow !== flowDirectory) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package .flow directory must not traverse symbolic links",
    );
  }
  const packagesDirectory = join(flowDirectory, "packages");
  return Object.freeze({
    flowDirectory,
    packagesDirectory,
    blobDirectory: join(packagesDirectory, "sha256"),
    lockPath: join(flowDirectory, "packages.lock.json"),
    metadataPath: join(flowDirectory, "packages.metadata.json"),
  });
}

async function readCapabilityMetadataState(path: string): Promise<CapabilityMetadataState | null> {
  let content: Buffer;
  try {
    content = await readBoundedRegularFile(path, MAX_CAPABILITY_METADATA_STATE_BYTES);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw ioError("could not read trusted capability metadata state", error);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const input = parseStrictJson(text, {
      maxDepth: 10,
      maxNodes: 16_384,
      valueLabel: "trusted capability metadata state",
    });
    const state = canonicalMetadataState(capabilityMetadataStateSchema.parse(input));
    if (!content.equals(Buffer.from(`${JSON.stringify(state)}\n`))) {
      throw new Error("trusted metadata state is not canonical");
    }
    assertCanonicalMetadataTargets(state.targets);
    return state;
  } catch {
    throw new CapabilityPackageStoreError(
      "invalid_metadata",
      "trusted capability metadata state is invalid",
    );
  }
}

async function readCapabilityLock(
  lockPath: string,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<CapabilityLock> {
  let content: Buffer;
  try {
    await hooks?.beforeVerifyLockRead?.();
    content = await readBoundedRegularFile(lockPath, MAX_CAPABILITY_LOCK_BYTES, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyCapabilityLock();
    }
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        "capability package lock must be a real regular file",
        { cause: error },
      );
    }
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw ioError("could not read capability package lock", error);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw invalidLock("capability package lock must be valid UTF-8", error);
  }
  try {
    const input = parseStrictJson(text, {
      maxDepth: 8,
      maxNodes: 2_048,
      valueLabel: "capability package lock",
    });
    const parsed = capabilityLockSchema.parse(input);
    const bundles: CapabilityLockEntry[] = parsed.bundles.map((entry) => ({
      name: entry.name,
      version: entry.version,
      source: entry.source,
      digest: entry.digest,
      bytes: entry.bytes,
      ...(entry.publisher === undefined ? {} : { publisher: { ...entry.publisher } }),
    }));
    assertCanonicalLockEntries(bundles);
    return deepFreeze({
      apiVersion: parsed.apiVersion,
      kind: parsed.kind,
      bundles,
    });
  } catch (error) {
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw invalidLock(
      `capability package lock is invalid: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function assertCanonicalLockEntries(entries: readonly CapabilityLockEntry[]): void {
  const digests = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (current === undefined) {
      throw invalidLock("capability package lock contains an invalid entry");
    }
    if (previous !== undefined && compareLockEntries(previous, current) >= 0) {
      throw invalidLock("capability package lock entries must be strictly sorted and unique");
    }
    if (digests.has(current.digest)) {
      throw invalidLock("capability package lock bundle digests must be unique");
    }
    digests.add(current.digest);
    totalBytes += current.bytes;
    if (totalBytes > MAX_CAPABILITY_LOCKED_BUNDLE_BYTES) {
      throw invalidLock(
        `capability package lock exceeds ${MAX_CAPABILITY_LOCKED_BUNDLE_BYTES} total bundle bytes`,
      );
    }
  }
}

async function readVerifiedLockedBundle(
  paths: CapabilityStorePaths,
  entry: CapabilityLockEntry,
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<VerifiedInstalledCapabilityBundle> {
  return (
    await readVerifiedLockedBundles(paths, [entry], signal, hooks)
  )[0] as VerifiedInstalledCapabilityBundle;
}

interface CapabilityBlobHandle {
  readonly entry: CapabilityLockEntry;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface OpenedCapabilityBlob extends CapabilityBlobHandle {
  readonly before: BigIntStats;
}

async function readVerifiedCapabilityGeneration(
  paths: CapabilityStorePaths,
  selectEntries: (lock: CapabilityLock) => readonly CapabilityLockEntry[],
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<readonly VerifiedInstalledCapabilityBundle[]> {
  let lock = await readCapabilityLock(paths.lockPath, signal, hooks);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    const entries = selectEntries(lock);
    try {
      return await readVerifiedLockedBundles(paths, entries, signal, hooks);
    } catch (error) {
      if (
        !(error instanceof CapabilityPackageStoreError && error.code === "settlement_uncertain")
      ) {
        signal?.throwIfAborted();
      }
      if (!isMissingLockedBlobFailure(error) || attempt > 0) {
        throw error;
      }
      const current = await readCapabilityLock(paths.lockPath, signal, hooks);
      signal?.throwIfAborted();
      if (isDeepStrictEqual(lock, current)) {
        throw error;
      }
      lock = current;
    }
  }
  throw new CapabilityPackageStoreError(
    "corrupt_blob",
    "active capability package generation could not be read",
  );
}

function isMissingLockedBlobFailure(error: unknown): boolean {
  return (
    error instanceof CapabilityPackageStoreError &&
    error.code === "corrupt_blob" &&
    isNodeError(error.cause) &&
    error.cause.code === "ENOENT"
  );
}

async function readVerifiedLockedBundles(
  paths: CapabilityStorePaths,
  entries: readonly CapabilityLockEntry[],
  signal?: AbortSignal,
  hooks?: CapabilityPackageStoreHooks,
): Promise<readonly VerifiedInstalledCapabilityBundle[]> {
  signal?.throwIfAborted();
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  await requireCanonicalBlobStore(paths);
  signal?.throwIfAborted();
  const handles: CapabilityBlobHandle[] = [];
  const opened: OpenedCapabilityBlob[] = [];
  let verified: VerifiedInstalledCapabilityBundle[] | undefined;
  let primaryFailure: unknown;
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const digest = entry.digest.slice("sha256:".length);
      const path = join(paths.blobDirectory, `${digest}.flowpkg`);
      await hooks?.beforeVerifyBundleOpen?.(entry);
      signal?.throwIfAborted();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      handles.push({ entry, handle });
      await hooks?.afterVerifyBundleOpened?.(entry);
      signal?.throwIfAborted();
      const before = await handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 1n ||
        before.size > BigInt(MAX_CAPABILITY_BUNDLE_BYTES)
      ) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "active capability package blob must be a bounded single-link regular file",
        );
      }
      opened.push({ entry, handle, before });
    }
    await requireCanonicalBlobStore(paths);
    verified = [];
    for (const item of opened) {
      signal?.throwIfAborted();
      await hooks?.beforeVerifyBundleRead?.(item.entry);
      signal?.throwIfAborted();
      const content = await readBoundedHandle(item.handle, MAX_CAPABILITY_BUNDLE_BYTES, signal);
      signal?.throwIfAborted();
      const after: BigIntStats = await item.handle.stat({ bigint: true });
      signal?.throwIfAborted();
      if (
        item.before.dev !== after.dev ||
        item.before.ino !== after.ino ||
        item.before.nlink < after.nlink ||
        item.before.size !== after.size ||
        item.before.mtimeNs !== after.mtimeNs ||
        (item.before.nlink === after.nlink && item.before.ctimeNs !== after.ctimeNs) ||
        BigInt(content.byteLength) !== item.before.size
      ) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "active capability package blob changed while it was read",
        );
      }
      verified.push(parseVerifiedLockedBundleContent(item.entry, content));
    }
  } catch (error) {
    primaryFailure =
      signal?.aborted === true ? signal.reason : normalizeLockedBlobReadFailure(error);
  }
  const closeFailures: unknown[] = [];
  for (const item of handles) {
    try {
      if (hooks?.settleVerifiedGenerationHandle === undefined) {
        await item.handle.close();
      } else {
        await hooks.settleVerifiedGenerationHandle(item.entry, async () => {
          await item.handle.close();
        });
      }
    } catch (error) {
      closeFailures.push(error);
    }
  }
  if (closeFailures.length > 0) {
    throw new CapabilityPackageStoreError(
      "settlement_uncertain",
      "capability package blob handles could not be settled",
      {
        cause: new AggregateError(
          primaryFailure === undefined ? closeFailures : [primaryFailure, ...closeFailures],
          "capability package read and handle settlement failed",
        ),
      },
    );
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
  return deepFreeze(verified ?? []);
}

function normalizeLockedBlobReadFailure(error: unknown): Error {
  if (error instanceof CapabilityPackageStoreError) {
    return error;
  }
  return new CapabilityPackageStoreError(
    "corrupt_blob",
    "active capability package blob is missing, unsafe, or unreadable",
    { cause: error },
  );
}

function parseVerifiedLockedBundleContent(
  entry: CapabilityLockEntry,
  content: Buffer,
): VerifiedInstalledCapabilityBundle {
  if (content.byteLength !== entry.bytes) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      `capability bundle blob ${entry.digest} does not match its locked byte count`,
    );
  }
  const digest = entry.digest.slice("sha256:".length);
  let bundle: CapabilityBundle;
  try {
    bundle = parseDigestPinnedCapabilityBundle(content, digest);
  } catch (error) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      boundedMessage(
        `capability bundle blob ${entry.digest} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { cause: error },
    );
  }
  if (bundle.name !== entry.name || bundle.version !== entry.version) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      `capability bundle blob ${entry.digest} derives identity ${bundle.name}@${bundle.version}, not locked identity ${entry.name}@${entry.version}`,
    );
  }
  return deepFreeze({ entry: { ...entry }, bundle });
}

async function publishBlob(
  paths: CapabilityStorePaths,
  entry: CapabilityLockEntry,
  content: Buffer,
  hooks: CapabilityPackageStoreHooks,
  signal?: AbortSignal,
  beforePublish?: () => Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  await ensureDirectory(paths.packagesDirectory, paths.flowDirectory, hooks);
  throwIfAborted(signal);
  await ensureDirectory(paths.blobDirectory, paths.packagesDirectory, hooks);
  throwIfAborted(signal);
  await requireCanonicalBlobStore(paths);
  const digest = entry.digest.slice("sha256:".length);
  const target = join(paths.blobDirectory, `${digest}.flowpkg`);
  try {
    await requireExactBlob(paths, entry, content);
    throwIfAborted(signal);
    return;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  const temporary = join(paths.blobDirectory, `.${digest}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    throwIfAborted(signal);
    await handle.writeFile(content);
    throwIfAborted(signal);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeCapabilityLockRename?.();
    throwIfAborted(signal);
    await beforePublish?.();
    throwIfAborted(signal);
    try {
      await link(temporary, target);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
      await requireExactBlob(paths, entry, content);
    }
    await unlink(temporary);
    await syncDirectory(paths.blobDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw ioError("could not publish capability bundle blob", error);
  }
}

async function requireExactBlob(
  paths: CapabilityStorePaths,
  entry: CapabilityLockEntry,
  expected: Buffer,
): Promise<void> {
  await requireCanonicalBlobStore(paths);
  const digest = entry.digest.slice("sha256:".length);
  const path = join(paths.blobDirectory, `${digest}.flowpkg`);
  let content: Buffer;
  try {
    content = await readBoundedRegularFile(path, MAX_CAPABILITY_BUNDLE_BYTES);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw error;
    }
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw ioError("could not read capability bundle blob", error);
  }
  await requireCanonicalBlobStore(paths);
  if (content.byteLength !== entry.bytes || !content.equals(expected)) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      `capability bundle blob ${entry.digest} does not contain the locked bytes`,
    );
  }
  try {
    parseDigestPinnedCapabilityBundle(content, digest);
  } catch (error) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      boundedMessage(
        `capability bundle blob ${entry.digest} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ),
      { cause: error },
    );
  }
}

async function publishCapabilityLock(
  paths: CapabilityStorePaths,
  lock: CapabilityLock,
  hooks: CapabilityPackageStoreHooks,
  signal?: AbortSignal,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(lock)}\n`, "utf8");
  if (content.byteLength > MAX_CAPABILITY_LOCK_BYTES) {
    throw invalidLock(`capability package lock exceeds ${MAX_CAPABILITY_LOCK_BYTES} bytes`);
  }
  const temporary = join(paths.flowDirectory, `.packages.lock.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeCapabilityLockPublished?.();
    throwIfAborted(signal);
    await beforeRename?.();
    throwIfAborted(signal);
    await rename(temporary, paths.lockPath);
    renamed = true;
    await hooks.afterCapabilityLockRenamed?.();
    await syncDirectory(paths.flowDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    if (renamed) {
      throw new CapabilityPackageStoreError(
        "commit_uncertain",
        "capability package lock was replaced but its directory sync failed; inspect packages.lock.json before retrying",
        { cause: error },
      );
    }
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    throw ioError("could not publish capability package lock", error);
  }
}

async function publishCapabilityMetadataState(
  paths: CapabilityStorePaths,
  state: CapabilityMetadataState,
  hooks: CapabilityPackageStoreHooks,
  signal: AbortSignal | undefined,
): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (content.byteLength > MAX_CAPABILITY_METADATA_STATE_BYTES) {
    throw new CapabilityPackageStoreError(
      "invalid_metadata",
      "trusted capability metadata state exceeds its byte limit",
    );
  }
  const temporary = join(paths.flowDirectory, `.packages.metadata.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeCapabilityMetadataRename?.();
    throwIfAborted(signal);
    await rename(temporary, paths.metadataPath);
    renamed = true;
    await hooks.afterCapabilityMetadataRenamed?.();
    await syncDirectory(paths.flowDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    if (renamed) {
      throw new CapabilityPackageStoreError(
        "commit_uncertain",
        "trusted capability metadata was replaced but its directory sync failed; inspect packages.metadata.json before retrying",
        { cause: error },
      );
    }
    if (signal?.aborted === true) {
      throw error;
    }
    throw ioError("could not publish trusted capability metadata state", error);
  }
}

function createCapabilityMetadataState(
  metadata: CapabilityMetadata,
  authority: CapabilityPublisherVerification,
): CapabilityMetadataState {
  try {
    if (
      metadata.apiVersion !== CAPABILITY_METADATA_API_VERSION ||
      metadata.kind !== "CapabilityMetadata"
    ) {
      throw new Error("invalid metadata identity");
    }
    const state = canonicalMetadataState(
      capabilityMetadataStateSchema.parse({
        apiVersion: CAPABILITY_METADATA_STATE_API_VERSION,
        kind: "CapabilityMetadataState",
        name: metadata.name,
        version: metadata.version,
        expiresAt: metadata.expiresAt,
        metadataBytes: metadata.bytes,
        metadataDigest: metadata.digest,
        authority,
        targets: metadata.targets,
      }),
    );
    assertCanonicalMetadataTargets(state.targets);
    return state;
  } catch {
    throw new CapabilityPackageStoreError(
      "invalid_metadata",
      "trusted capability metadata input is invalid",
    );
  }
}

function canonicalMetadataState(
  state: z.infer<typeof capabilityMetadataStateSchema>,
): CapabilityMetadataState {
  return deepFreeze({
    apiVersion: state.apiVersion,
    kind: state.kind,
    name: state.name,
    version: state.version,
    expiresAt: state.expiresAt,
    metadataBytes: state.metadataBytes,
    metadataDigest: state.metadataDigest,
    authority: canonicalPublisher(state.authority),
    targets: state.targets.map((target) => ({
      name: target.name,
      version: target.version,
      digest: target.digest,
      bytes: target.bytes,
      source: target.source,
      status: target.status,
      ...(target.publisher === undefined
        ? {}
        : {
            publisher: {
              certificateIssuer: target.publisher.certificateIssuer,
              certificateIdentity: target.publisher.certificateIdentity,
            },
          }),
    })),
  });
}

function requireMonotonicMetadata(
  current: CapabilityMetadataState,
  candidate: CapabilityMetadataState,
): void {
  const sameAuthority =
    current.name === candidate.name &&
    current.authority.kind === candidate.authority.kind &&
    current.authority.certificateIssuer === candidate.authority.certificateIssuer &&
    current.authority.certificateIdentity === candidate.authority.certificateIdentity;
  if (
    !sameAuthority ||
    candidate.version < current.version ||
    (candidate.version === current.version &&
      (candidate.metadataDigest !== current.metadataDigest ||
        candidate.metadataBytes !== current.metadataBytes))
  ) {
    throw new CapabilityPackageStoreError(
      "metadata_rollback",
      "trusted capability metadata would roll back or substitute current authority",
    );
  }
}

function requireCurrentMetadata(state: CapabilityMetadataState, now: Date): void {
  if (Number.isNaN(now.getTime()) || now.getTime() >= Date.parse(state.expiresAt)) {
    throw new CapabilityPackageStoreError(
      "metadata_expired",
      "trusted capability metadata is expired or the trusted clock is invalid",
    );
  }
}

async function assertRepositoryInstallCurrent(
  input: InstallCapabilityBundleFromRepositoryInput,
  now: () => Promise<Date>,
): Promise<void> {
  input.signal.throwIfAborted();
  await now();
  try {
    await input.assertCurrent(input.signal);
  } catch {
    input.signal.throwIfAborted();
    throw new CapabilityPackageStoreError(
      "metadata_target",
      "capability repository candidate changed before package publication",
    );
  }
  input.signal.throwIfAborted();
  await now();
}

function createRepositoryClockObserver(
  input: InstallCapabilityBundleFromRepositoryInput,
  now: () => Date,
): () => Promise<Date> {
  let highWater = input.trustedClockHighWater;
  requireRepositoryClockHighWater(highWater, new Date(highWater));
  return async () => {
    let observed: Date;
    try {
      observed = now();
    } catch {
      throw new CapabilityPackageStoreError(
        "metadata_rollback",
        "trusted capability repository installation clock moved backwards",
      );
    }
    requireRepositoryClockHighWater(highWater, observed);
    const observedAt = observed.toISOString();
    try {
      await input.advanceTrustedClockHighWater(observedAt);
    } catch {
      throw new CapabilityPackageStoreError(
        "metadata_target",
        "trusted capability repository installation clock could not be persisted",
      );
    }
    highWater = observedAt;
    return new Date(observed.getTime());
  };
}

function requireRepositoryClockHighWater(trustedClockHighWater: string, now: Date): void {
  const highWater = new Date(trustedClockHighWater);
  if (
    !Number.isFinite(highWater.getTime()) ||
    highWater.toISOString() !== trustedClockHighWater ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() < highWater.getTime()
  ) {
    throw new CapabilityPackageStoreError(
      "metadata_rollback",
      "trusted capability repository installation clock moved backwards",
    );
  }
}

function requireTrustedTarget(
  state: CapabilityMetadataState | null,
  bundle: Pick<CapabilityBundle, "name" | "version" | "digest" | "bytes">,
  source: string,
  publisher: CapabilityPublisherVerification | undefined,
  now: Date,
): void {
  if (state === null) {
    return;
  }
  requireCurrentMetadata(state, now);
  const target = state.targets.find(
    (candidate) => candidate.name === bundle.name && candidate.version === bundle.version,
  );
  const publisherMatches =
    target?.publisher === undefined
      ? publisher === undefined
      : publisher !== undefined &&
        target.publisher.certificateIssuer === publisher.certificateIssuer &&
        target.publisher.certificateIdentity === publisher.certificateIdentity;
  if (
    target === undefined ||
    target.status !== "active" ||
    target.digest !== bundle.digest ||
    target.bytes !== bundle.bytes ||
    target.source !== source ||
    !publisherMatches
  ) {
    throw new CapabilityPackageStoreError(
      "metadata_target",
      "capability bundle does not match one active trusted metadata target",
    );
  }
}

function assertCanonicalMetadataTargets(targets: readonly CapabilityMetadataTarget[]): void {
  for (let index = 1; index < targets.length; index += 1) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareLockEntries(previous, current) >= 0
    ) {
      throw new Error("trusted metadata targets must be strictly sorted and unique");
    }
  }
}

async function cleanupOrphanBlob(
  paths: CapabilityStorePaths,
  entry: CapabilityLockEntry,
): Promise<RemoveCapabilityBundleResult["cleanup"]> {
  const digest = entry.digest.slice("sha256:".length);
  const path = join(paths.blobDirectory, `${digest}.flowpkg`);
  try {
    await requireCanonicalBlobStore(paths);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return "failed";
    }
    await requireCanonicalBlobStore(paths);
    await unlink(path);
    await syncDirectory(paths.blobDirectory);
    return "deleted";
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? "missing" : "failed";
  }
}

interface MutationLock {
  readonly release: () => Promise<void>;
}

async function acquireMutationLock(
  flowDirectory: string,
  hooks: CapabilityPackageStoreHooks,
): Promise<MutationLock> {
  const path = join(flowDirectory, "packages.mutation.lock");
  const owner = `${JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID() })}\n`;
  const temporary = join(flowDirectory, `.packages.mutation.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporary, "wx", 0o600);
  } catch (error) {
    throw ioError("could not prepare capability package mutation lock", error);
  }
  try {
    await handle.writeFile(owner, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw ioError("could not publish capability package mutation lock", error);
  }
  let published = false;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await link(temporary, path);
        published = true;
        break;
      } catch (error) {
        if (!(isNodeError(error) && error.code === "EEXIST")) {
          throw error;
        }
        await hooks.afterMutationLockCollision?.();
        try {
          const existing = await readMutationLockOwner(path);
          throw new CapabilityPackageStoreError(
            "busy",
            `capability package mutation lock is held by pid ${existing.pid} on ${existing.hostname}; verify the owner and remove the lock manually if it is stale`,
          );
        } catch (ownerError) {
          if (isNodeError(ownerError) && ownerError.code === "ENOENT") {
            continue;
          }
          throw ownerError;
        }
      }
    }
    if (!published) {
      throw new CapabilityPackageStoreError(
        "busy",
        "capability package mutation lock changed repeatedly during acquisition",
      );
    }
    await unlink(temporary);
    await syncDirectory(flowDirectory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (published) {
      await removeOwnedMutationLock(path, owner, flowDirectory).catch(() => undefined);
    }
    if (error instanceof CapabilityPackageStoreError) {
      throw error;
    }
    throw ioError("could not publish capability package mutation lock", error);
  }
  return Object.freeze({
    async release(): Promise<void> {
      await hooks.beforeMutationLockRelease?.();
      let current: Buffer;
      try {
        current = await readBoundedRegularFile(path, 4_096);
      } catch (error) {
        throw ioError("could not inspect capability package mutation lock", error);
      }
      if (current.toString("utf8") !== owner) {
        throw new CapabilityPackageStoreError(
          "unsafe_state",
          "capability package mutation lock ownership changed before release",
        );
      }
      try {
        await unlink(path);
        await syncDirectory(flowDirectory);
      } catch (error) {
        throw ioError("could not release capability package mutation lock", error);
      }
    },
  });
}

async function removeOwnedMutationLock(
  path: string,
  owner: string,
  flowDirectory: string,
): Promise<void> {
  const current = await readBoundedRegularFile(path, 4_096);
  if (current.toString("utf8") !== owner) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package mutation lock ownership changed during cleanup",
    );
  }
  await unlink(path);
  await syncDirectory(flowDirectory);
}

async function readMutationLockOwner(
  path: string,
): Promise<z.infer<typeof mutationLockOwnerSchema>> {
  let content: Buffer;
  try {
    content = await readBoundedRegularFile(path, 4_096);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw error;
    }
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package mutation lock is unsafe or unreadable",
      { cause: error },
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return mutationLockOwnerSchema.parse(
      parseStrictJson(text, {
        maxDepth: 4,
        maxNodes: 16,
        valueLabel: "capability package mutation lock",
      }),
    );
  } catch (error) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      "capability package mutation lock owner is invalid",
      { cause: error },
    );
  }
}

async function ensureDirectory(
  path: string,
  parent: string,
  hooks: CapabilityPackageStoreHooks,
): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) {
      throw ioError(`could not create capability package directory ${JSON.stringify(path)}`, error);
    }
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw ioError(`could not inspect capability package directory ${JSON.stringify(path)}`, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      `capability package path ${JSON.stringify(path)} must be a real directory`,
    );
  }
  const canonical = await realpath(path).catch((error: unknown) => {
    throw ioError(`could not resolve capability package directory ${JSON.stringify(path)}`, error);
  });
  if (canonical !== path) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      `capability package path ${JSON.stringify(path)} must not traverse symbolic links`,
    );
  }
  try {
    await hooks.beforeStoreDirectoryParentSync?.(path, parent);
    await syncDirectory(parent);
    await hooks.afterStoreDirectoryParentSynced?.(path, parent);
  } catch (error) {
    throw ioError(`could not persist capability package directory ${JSON.stringify(path)}`, error);
  }
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        `capability package file ${JSON.stringify(path)} is not a bounded regular file`,
      );
    }
    const content = await readBoundedHandle(handle, maximumBytes, signal);
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(content.byteLength) !== before.size
    ) {
      throw new CapabilityPackageStoreError(
        "unsafe_state",
        `capability package file ${JSON.stringify(path)} changed while it was read`,
      );
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readBoundedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      `capability package file exceeded ${maximumBytes} bytes while it was read`,
    );
  }
  return buffer.subarray(0, offset);
}

async function requireCanonicalBlobStore(paths: CapabilityStorePaths): Promise<void> {
  await requireCanonicalDirectory(paths.packagesDirectory, "capability package store");
  await requireCanonicalDirectory(paths.blobDirectory, "capability package blob store");
}

async function requireCanonicalDirectory(path: string, label: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw error;
    }
    throw ioError(`could not inspect ${label}`, error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CapabilityPackageStoreError("unsafe_state", `${label} must be a real directory`);
  }
  const canonical = await realpath(path).catch((error: unknown) => {
    throw ioError(`could not resolve ${label}`, error);
  });
  if (canonical !== path) {
    throw new CapabilityPackageStoreError(
      "unsafe_state",
      `${label} must not traverse symbolic links`,
    );
  }
}

async function withMutationLock<T>(lock: MutationLock, operation: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  let primaryFailure: unknown;
  try {
    result = await operation();
  } catch (error) {
    primaryFailure = error;
  }
  let releaseFailure: unknown;
  try {
    await lock.release();
  } catch (error) {
    releaseFailure = error;
  }
  if (primaryFailure !== undefined) {
    if (releaseFailure !== undefined) {
      throw preservePrimaryFailure(primaryFailure, releaseFailure);
    }
    throw primaryFailure;
  }
  if (releaseFailure !== undefined) {
    throw new CapabilityPackageStoreError(
      "settlement_uncertain",
      "capability package mutation completed but its mutation lock could not be released; inspect state before retrying",
      { cause: releaseFailure },
    );
  }
  return result as T;
}

function preservePrimaryFailure(primary: unknown, cleanup: unknown): Error {
  const cause = new AggregateError(
    [primary, cleanup],
    "capability package mutation and lock cleanup both failed",
  );
  return new CapabilityPackageStoreError(
    "settlement_uncertain",
    "capability package mutation and its mutation lock cleanup both require settlement",
    { cause },
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function compareLockEntries(
  left: Pick<CapabilityLockEntry, "name" | "version">,
  right: Pick<CapabilityLockEntry, "name" | "version">,
): number {
  const leftKey = `${left.name}\0${left.version}`;
  const rightKey = `${right.name}\0${right.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function emptyCapabilityLock(): CapabilityLock {
  return Object.freeze({
    apiVersion: CAPABILITY_LOCK_API_VERSION,
    kind: "CapabilityLock",
    bundles: Object.freeze([]),
  });
}

function isCanonicalHttpsSource(source: string): boolean {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  return (
    source === url.toString() &&
    !source.includes("?") &&
    !source.includes("#") &&
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hostname.length > 0
  );
}

function isValidCapabilitySource(source: string, hasPublisher: boolean): boolean {
  if (isCanonicalHttpsSource(source)) {
    return true;
  }
  if (!hasPublisher) {
    return false;
  }
  try {
    return parseOciCapabilityArtifactReference(source).canonical === source;
  } catch {
    return false;
  }
}

function isCanonicalHttpsIssuer(source: string): boolean {
  try {
    const parsed = new URL(source);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.hostname === parsed.hostname.toLowerCase() &&
      parsed.toString() === source
    );
  } catch {
    return false;
  }
}

function isCanonicalPublisherIdentity(identity: string): boolean {
  if (
    identity !== identity.trim() ||
    Buffer.byteLength(identity, "utf8") > 4_096 ||
    Array.from(identity).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    return false;
  }
  try {
    return (
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(identity, "utf8")) === identity
    );
  } catch {
    return false;
  }
}

function isCanonicalInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function canonicalPublisher(
  publisher: CapabilityPublisherVerification,
): CapabilityPublisherVerification {
  return Object.freeze({
    kind: publisher.kind,
    certificateIssuer: publisher.certificateIssuer,
    certificateIdentity: publisher.certificateIdentity,
    signatureBundleDigest: publisher.signatureBundleDigest,
  });
}

function invalidLock(message: string, cause?: unknown): CapabilityPackageStoreError {
  return new CapabilityPackageStoreError(
    "invalid_lock",
    boundedMessage(message),
    cause === undefined ? undefined : { cause },
  );
}

function ioError(message: string, cause: unknown): CapabilityPackageStoreError {
  return new CapabilityPackageStoreError("io", boundedMessage(message), { cause });
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  return bytes.byteLength <= MAX_STORE_ERROR_BYTES
    ? message
    : `${bytes.subarray(0, MAX_STORE_ERROR_BYTES - 24).toString("utf8")}… [truncated]`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
