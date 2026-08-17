import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  CAPABILITY_METADATA_STATE_API_VERSION,
  type CapabilityMetadataState,
  type CapabilityPublisherVerification,
  type InstallCapabilityBundleInput,
  type InstallCapabilityBundleResult,
  type RefreshCapabilityMetadataInput,
  type RefreshCapabilityMetadataResult,
} from "../../application/capability-package-store.js";
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
  CAPABILITY_METADATA_STATE_API_VERSION,
  type CapabilityMetadataState,
  type CapabilityPublisherVerification,
  type InstallCapabilityBundleInput,
  type InstallCapabilityBundleResult,
  type RefreshCapabilityMetadataInput,
  type RefreshCapabilityMetadataResult,
} from "../../application/capability-package-store.js";

const MAX_CAPABILITY_LOCK_BYTES = 512 * 1024;
const MAX_CAPABILITY_METADATA_STATE_BYTES = 768 * 1024;
const MAX_CAPABILITY_LOCK_ENTRIES = 128;
const MAX_CAPABILITY_LOCKED_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_ERROR_BYTES = 16_384;

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
  | "commit_uncertain"
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
  readonly beforeMutationLockRelease?: () => Promise<void>;
  readonly beforeStoreDirectoryParentSync?: (path: string, parent: string) => Promise<void>;
  readonly afterStoreDirectoryParentSynced?: (path: string, parent: string) => Promise<void>;
  readonly afterMutationLockCollision?: () => Promise<void>;
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
      const metadata = await readCapabilityMetadataState(paths.metadataPath);
      throwIfAborted(input.signal);
      requireTrustedTarget(metadata, bundle, input.source, publisher, this.now());
      const lock = await readCapabilityLock(paths.lockPath);
      throwIfAborted(input.signal);
      const existing = lock.bundles.find(
        (entry) => entry.name === bundle.name && entry.version === bundle.version,
      );
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
        requireTrustedTarget(metadata, bundle, existing.source, existing.publisher, this.now());
        await requireExactBlob(paths, existing, Buffer.from(input.content));
        throwIfAborted(input.signal);
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
      await publishBlob(paths, entry, Buffer.from(input.content), this.hooks, input.signal);
      throwIfAborted(input.signal);
      requireTrustedTarget(metadata, bundle, input.source, publisher, this.now());
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
      );
      return Object.freeze({ status: "installed" as const, bundle });
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
    const lock = await readCapabilityLock(paths.lockPath, options.signal, this.hooks);
    const entry = lock.bundles.find(
      (candidate) => candidate.name === name && candidate.version === version,
    );
    if (entry === undefined) {
      throw new CapabilityPackageStoreError(
        "not_found",
        `capability bundle ${name}@${version} is not installed`,
      );
    }
    const installed = await readVerifiedLockedBundle(paths, entry, options.signal, this.hooks);
    options.signal?.throwIfAborted();
    return installed;
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
    const lock = await readCapabilityLock(paths.lockPath, options.signal, this.hooks);
    const verified: VerifiedInstalledCapabilityBundle[] = [];
    for (const entry of lock.bundles) {
      options.signal?.throwIfAborted();
      const installed = await readVerifiedLockedBundle(paths, entry, options.signal, this.hooks);
      requireTrustedTarget(metadata, installed.bundle, entry.source, entry.publisher, this.now());
      verified.push(installed);
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

interface CapabilityStorePaths {
  readonly flowDirectory: string;
  readonly packagesDirectory: string;
  readonly blobDirectory: string;
  readonly lockPath: string;
  readonly metadataPath: string;
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
  signal?.throwIfAborted();
  await requireCanonicalBlobStore(paths);
  signal?.throwIfAborted();
  const digest = entry.digest.slice("sha256:".length);
  const path = join(paths.blobDirectory, `${digest}.flowpkg`);
  let content: Buffer;
  try {
    await hooks?.beforeVerifyBundleRead?.(entry);
    content = await readBoundedRegularFile(path, MAX_CAPABILITY_BUNDLE_BYTES, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      `capability bundle blob ${entry.digest} is missing, unsafe, or unreadable`,
      { cause: error },
    );
  }
  signal?.throwIfAborted();
  await requireCanonicalBlobStore(paths);
  signal?.throwIfAborted();
  if (content.byteLength !== entry.bytes) {
    throw new CapabilityPackageStoreError(
      "corrupt_blob",
      `capability bundle blob ${entry.digest} does not match its locked byte count`,
    );
  }
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
      "commit_uncertain",
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
  if (primary instanceof CapabilityPackageStoreError) {
    return new CapabilityPackageStoreError(primary.code, primary.message, { cause });
  }
  return cause;
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
