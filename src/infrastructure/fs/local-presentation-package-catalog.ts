import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dir, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createPresentationPackageSnapshot,
  MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES,
  type PresentationPackageDefinition,
  type PresentationPackageManifest,
  type PresentationPackageSnapshot,
  parsePresentationPackageManifest,
} from "../../domain/capability/presentation-packages.js";

const MANIFEST_NAME = "PRESENTATION.yaml";
const MAX_DISCOVERY_ENTRIES = 2_000;
export const MAX_PRESENTATION_PACKAGES = 32;
const installedSources = new WeakMap<DiscoveredPresentationPackage, string>();

export type PresentationPackageCatalogErrorCode =
  | "duplicate_package"
  | "invalid_package"
  | "io"
  | "limit_exceeded"
  | "missing_package"
  | "source_changed"
  | "unsafe_entry"
  | "version_mismatch";

export class PresentationPackageCatalogError extends Error {
  override readonly name = "PresentationPackageCatalogError";

  constructor(
    readonly code: PresentationPackageCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message.slice(0, 16_384), options);
  }
}

export interface PresentationPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface DiscoveredPresentationPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly definition: PresentationPackageDefinition;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface ProjectPresentationPackageCatalog {
  readonly projectRoot: string;
  readonly root: string;
  readonly packages: readonly DiscoveredPresentationPackage[];
}

export interface PresentationPackageCatalogOptions {
  readonly signal?: AbortSignal;
  /** @internal Test seam for deterministic source-race coverage. */
  readonly afterPackageDirectoryObserved?: (directory: string) => void | Promise<void>;
  /** @internal Test seam for deterministic bounded-read coverage. */
  readonly afterManifestStat?: (path: string) => void | Promise<void>;
}

export interface InstalledPresentationPackage {
  readonly kind: "presentation-package";
  readonly name: string;
  readonly version: string;
  readonly manifestBase64: string;
}

export function createInstalledDiscoveredPresentationPackage(input: {
  readonly projectRoot: string;
  readonly bundleDigest: string;
  readonly package: InstalledPresentationPackage;
}): DiscoveredPresentationPackage {
  const digest = /^(?:sha256:)?([a-f0-9]{64})$/.exec(input.bundleDigest)?.[1];
  if (digest === undefined) {
    throw new PresentationPackageCatalogError("invalid_package", "bundle digest is invalid");
  }
  const directory = join(
    input.projectRoot,
    ".flow",
    "packages",
    "sha256",
    digest,
    "presentation-package",
    input.package.name,
  );
  const source = decodeInstalledSource(input.package.manifestBase64);
  const manifest = parseManifest(source);
  const discovered = discoveredPackage(input.projectRoot, directory, source, manifest);
  installedSources.set(discovered, input.package.manifestBase64);
  return discovered;
}

export async function discoverProjectPresentationPackages(
  projectRoot: string,
  options: PresentationPackageCatalogOptions = {},
): Promise<ProjectPresentationPackageCatalog> {
  throwIfAborted(options.signal);
  const canonicalProject = await requiredRealpath(
    projectRoot,
    options.signal,
    "resolve Flow project root",
  );
  const projectMetadata = await requiredLstat(
    canonicalProject,
    options.signal,
    "inspect Flow project root",
  );
  assertDirectory(projectMetadata, "Flow project root");
  const flowRoot = join(canonicalProject, ".flow");
  const root = join(flowRoot, "presentations");
  const flowRootMetadata = await optionalLstat(flowRoot, options.signal);
  if (flowRootMetadata === null) {
    await assertUnchangedDirectory(
      canonicalProject,
      projectMetadata,
      options.signal,
      "Flow project root changed during discovery",
    );
    return deepFreeze({ projectRoot: canonicalProject, root, packages: [] });
  }
  assertDirectory(flowRootMetadata, "Flow state root");
  const rootMetadata = await optionalLstat(root, options.signal);
  if (rootMetadata === null) {
    await assertUnchangedDirectory(
      canonicalProject,
      projectMetadata,
      options.signal,
      "Flow project root changed during discovery",
    );
    await assertUnchangedDirectory(
      flowRoot,
      flowRootMetadata,
      options.signal,
      "Flow state root changed during discovery",
    );
    return deepFreeze({ projectRoot: canonicalProject, root, packages: [] });
  }
  assertDirectory(rootMetadata, "presentation package root");
  const canonicalRoot = await requiredRealpath(
    root,
    options.signal,
    "resolve presentation package root",
  );
  assertWithin(canonicalRoot, canonicalProject);
  const canonicalRootMetadata = await requiredLstat(
    canonicalRoot,
    options.signal,
    "inspect presentation package root",
  );
  if (!sameIdentity(rootMetadata, canonicalRootMetadata)) {
    throw new PresentationPackageCatalogError(
      "source_changed",
      "presentation package root changed during discovery",
    );
  }
  const entries = await readDirectory(canonicalRoot, MAX_DISCOVERY_ENTRIES, options.signal);
  const packages: DiscoveredPresentationPackage[] = [];
  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new PresentationPackageCatalogError(
        "unsafe_entry",
        "presentation package root contains an unsafe entry",
      );
    }
    packages.push(
      await readDiscoveredPackage(
        canonicalProject,
        canonicalRoot,
        entry.name,
        options.signal,
        options.afterPackageDirectoryObserved,
        options.afterManifestStat,
      ),
    );
  }
  packages.sort(compareByName);
  assertPresentationPackageCatalog(packages);
  await assertUnchangedDirectory(
    canonicalProject,
    projectMetadata,
    options.signal,
    "Flow project root changed during discovery",
  );
  await assertUnchangedDirectory(
    flowRoot,
    flowRootMetadata,
    options.signal,
    "Flow state root changed during discovery",
  );
  await assertUnchangedDirectory(
    canonicalRoot,
    canonicalRootMetadata,
    options.signal,
    "presentation package root changed during discovery",
  );
  return deepFreeze({ projectRoot: canonicalProject, root: canonicalRoot, packages });
}

export async function snapshotSelectedPresentationPackage(
  catalog: ProjectPresentationPackageCatalog,
  reference: PresentationPackageReference,
  options: PresentationPackageCatalogOptions = {},
): Promise<PresentationPackageSnapshot> {
  throwIfAborted(options.signal);
  const discovered = catalog.packages.find((item) => item.name === reference.name);
  if (discovered === undefined) {
    throw new PresentationPackageCatalogError("missing_package", "presentation package is missing");
  }
  if (discovered.version !== reference.version) {
    throw new PresentationPackageCatalogError(
      "version_mismatch",
      "presentation package version does not match",
    );
  }
  const installedSource = installedSources.get(discovered);
  let source: Buffer;
  if (installedSource !== undefined) {
    source = decodeInstalledSource(installedSource);
  } else {
    const current = await readDiscoveredPackage(
      catalog.projectRoot,
      catalog.root,
      basename(discovered.directory),
      options.signal,
      options.afterPackageDirectoryObserved,
      options.afterManifestStat,
    );
    if (!sameDiscoveredPackage(discovered, current)) {
      throw new PresentationPackageCatalogError(
        "source_changed",
        "presentation package source changed after discovery",
      );
    }
    source = await readRegularManifest(
      join(discovered.directory, MANIFEST_NAME),
      options.signal,
      options.afterManifestStat,
    );
    if (sha256(source) !== discovered.manifestSha256) {
      throw new PresentationPackageCatalogError(
        "source_changed",
        "presentation package source changed during snapshot",
      );
    }
  }
  throwIfAborted(options.signal);
  try {
    return createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: discovered.provenance,
      manifest: { content: source },
    });
  } catch (error) {
    throw new PresentationPackageCatalogError(
      "invalid_package",
      "presentation package snapshot is invalid",
      { cause: error },
    );
  }
}

export function assertPresentationPackageCatalog(
  packages: readonly DiscoveredPresentationPackage[],
): void {
  if (packages.length > MAX_PRESENTATION_PACKAGES) {
    throw new PresentationPackageCatalogError(
      "limit_exceeded",
      "presentation package catalog exceeds its package limit",
    );
  }
  const names = new Set<string>();
  for (const item of packages) {
    if (names.has(item.name)) {
      throw new PresentationPackageCatalogError(
        "duplicate_package",
        "presentation package names must be unique",
      );
    }
    names.add(item.name);
  }
}

async function readDiscoveredPackage(
  projectRoot: string,
  catalogRoot: string,
  name: string,
  signal: AbortSignal | undefined,
  afterPackageDirectoryObserved?: (directory: string) => void | Promise<void>,
  afterManifestStat?: (path: string) => void | Promise<void>,
): Promise<DiscoveredPresentationPackage> {
  throwIfAborted(signal);
  const directory = join(catalogRoot, name);
  assertWithin(directory, catalogRoot);
  const metadata = await requiredLstat(directory, signal, "inspect presentation package directory");
  assertDirectory(metadata, "presentation package directory");
  await afterPackageDirectoryObserved?.(directory);
  throwIfAborted(signal);
  const entries = await readDirectory(directory, 2, signal);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== MANIFEST_NAME ||
    entries[0].isSymbolicLink() ||
    !entries[0].isFile()
  ) {
    throw new PresentationPackageCatalogError(
      "unsafe_entry",
      `presentation package must contain only ${MANIFEST_NAME}`,
    );
  }
  const source = await readRegularManifest(
    join(directory, MANIFEST_NAME),
    signal,
    afterManifestStat,
  );
  const directoryAfter = await requiredLstat(
    directory,
    signal,
    "inspect presentation package directory",
  );
  if (!sameIdentity(metadata, directoryAfter)) {
    throw new PresentationPackageCatalogError(
      "source_changed",
      "presentation package directory changed during discovery",
    );
  }
  const manifest = parseManifest(source);
  if (manifest.metadata.name !== name) {
    throw new PresentationPackageCatalogError(
      "invalid_package",
      "presentation package directory and manifest names disagree",
    );
  }
  return discoveredPackage(projectRoot, directory, source, manifest);
}

function discoveredPackage(
  projectRoot: string,
  directory: string,
  source: Buffer,
  manifest: PresentationPackageManifest,
): DiscoveredPresentationPackage {
  return deepFreeze({
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    description: manifest.metadata.description,
    ...(manifest.metadata.license === undefined ? {} : { license: manifest.metadata.license }),
    ...(manifest.metadata.compatibility === undefined
      ? {}
      : { compatibility: manifest.metadata.compatibility }),
    definition: manifest.spec,
    trust: "project-explicit" as const,
    provenance: portableRelative(projectRoot, directory),
    directory,
    manifestSha256: sha256(source),
  });
}

async function readRegularManifest(
  path: string,
  signal: AbortSignal | undefined,
  afterManifestStat?: (path: string) => void | Promise<void>,
): Promise<Buffer> {
  throwIfAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new PresentationPackageCatalogError("io", "open presentation package manifest", {
      cause: error,
    });
  }
  let readOutcome:
    | { readonly ok: true; readonly value: Buffer }
    | { readonly ok: false; readonly error: unknown };
  try {
    readOutcome = {
      ok: true,
      value: await readOpenedManifest(handle, path, signal, afterManifestStat),
    };
  } catch (error) {
    readOutcome = { ok: false, error };
  }
  let closeOutcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  try {
    await handle.close();
    closeOutcome = { ok: true };
  } catch (error) {
    closeOutcome = { ok: false, error };
  }
  throwIfAborted(signal);
  if (!readOutcome.ok) {
    if (readOutcome.error instanceof PresentationPackageCatalogError) {
      throw readOutcome.error;
    }
    throw new PresentationPackageCatalogError("io", "read presentation package manifest", {
      cause: readOutcome.error,
    });
  }
  if (!closeOutcome.ok) {
    throw new PresentationPackageCatalogError("io", "close presentation package manifest", {
      cause: closeOutcome.error,
    });
  }
  return readOutcome.value;
}

async function readOpenedManifest(
  handle: FileHandle,
  path: string,
  signal: AbortSignal | undefined,
  afterManifestStat?: (path: string) => void | Promise<void>,
): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  throwIfAborted(signal);
  assertRegularBounded(before);
  await afterManifestStat?.(path);
  throwIfAborted(signal);
  const source = Buffer.allocUnsafe(MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES + 1);
  let total = 0;
  while (total < source.byteLength) {
    const { bytesRead } = await handle.read(source, total, source.byteLength - total, null);
    throwIfAborted(signal);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  if (total === 0 || total > MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES) {
    throw new PresentationPackageCatalogError(
      "limit_exceeded",
      "presentation package manifest exceeds its byte limit",
    );
  }
  const after = await handle.stat({ bigint: true });
  throwIfAborted(signal);
  const pathAfter = await requiredLstat(path, signal, "inspect presentation package manifest");
  if (!sameIdentity(before, after) || !sameIdentity(after, pathAfter)) {
    throw new PresentationPackageCatalogError(
      "source_changed",
      "presentation package manifest changed during read",
    );
  }
  return source.subarray(0, total);
}

async function requiredRealpath(
  path: string,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<string> {
  try {
    const result = await realpath(path);
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw new PresentationPackageCatalogError("io", stage, { cause: error });
  }
}

async function requiredLstat(
  path: string,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<BigIntStats> {
  try {
    const result = await lstat(path, { bigint: true });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw new PresentationPackageCatalogError("io", stage, { cause: error });
  }
}

async function assertUnchangedDirectory(
  path: string,
  expected: BigIntStats,
  signal: AbortSignal | undefined,
  message: string,
): Promise<void> {
  const current = await requiredLstat(path, signal, "inspect presentation package authority");
  if (!sameIdentity(expected, current)) {
    throw new PresentationPackageCatalogError("source_changed", message);
  }
}

async function readDirectory(
  path: string,
  maximumEntries: number,
  signal: AbortSignal | undefined,
): Promise<readonly Dirent[]> {
  throwIfAborted(signal);
  let directory: Dir;
  try {
    directory = await opendir(path);
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new PresentationPackageCatalogError("io", "open presentation package directory", {
      cause: error,
    });
  }
  const entries: Dirent[] = [];
  try {
    for await (const entry of directory) {
      throwIfAborted(signal);
      entries.push(entry);
      if (entries.length > maximumEntries) {
        throw new PresentationPackageCatalogError(
          "limit_exceeded",
          "presentation package directory exceeds its entry limit",
        );
      }
    }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof PresentationPackageCatalogError) {
      throw error;
    }
    throw new PresentationPackageCatalogError("io", "read presentation package directory", {
      cause: error,
    });
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  return entries;
}

async function optionalLstat(
  path: string,
  signal: AbortSignal | undefined,
): Promise<BigIntStats | null> {
  try {
    const result = await lstat(path, { bigint: true });
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new PresentationPackageCatalogError("io", "inspect presentation package path", {
      cause: error,
    });
  }
}

function parseManifest(source: Buffer): PresentationPackageManifest {
  try {
    return parsePresentationPackageManifest(source);
  } catch (error) {
    throw new PresentationPackageCatalogError(
      "invalid_package",
      "presentation package manifest is invalid",
      { cause: error },
    );
  }
}

function decodeInstalledSource(value: string): Buffer {
  const source = Buffer.from(value, "base64");
  if (
    source.byteLength === 0 ||
    source.byteLength > MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES ||
    source.toString("base64") !== value
  ) {
    throw new PresentationPackageCatalogError(
      "invalid_package",
      "installed presentation package manifest is invalid",
    );
  }
  return source;
}

function assertRegularBounded(metadata: BigIntStats): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PresentationPackageCatalogError(
      "unsafe_entry",
      "presentation package manifest must be a regular file",
    );
  }
  if (metadata.size <= 0n || metadata.size > BigInt(MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES)) {
    throw new PresentationPackageCatalogError(
      "limit_exceeded",
      "presentation package manifest exceeds its byte limit",
    );
  }
}

function assertDirectory(metadata: BigIntStats, label: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PresentationPackageCatalogError("unsafe_entry", `${label} must be a real directory`);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDiscoveredPackage(
  left: DiscoveredPresentationPackage,
  right: DiscoveredPresentationPackage,
): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.manifestSha256 === right.manifestSha256 &&
    JSON.stringify(left.definition) === JSON.stringify(right.definition)
  );
}

function portableRelative(root: string, path: string): string {
  const result = relative(root, path).split(sep).join("/");
  if (result.length === 0 || result.startsWith("../") || result === "..") {
    throw new PresentationPackageCatalogError("unsafe_entry", "package path escapes project");
  }
  return result;
}

function assertWithin(path: string, root: string): void {
  const candidate = resolve(path);
  const boundary = resolve(root);
  const rel = relative(boundary, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new PresentationPackageCatalogError("unsafe_entry", "package path escapes project");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareByName(
  left: DiscoveredPresentationPackage,
  right: DiscoveredPresentationPackage,
): number {
  return compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
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
