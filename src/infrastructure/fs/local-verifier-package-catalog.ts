import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createCapabilitySnapshot,
  type VerifierPackageCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import {
  MAX_VERIFIER_PACKAGE_MANIFEST_BYTES,
  parseVerifierPackageManifest,
  type VerifierPackageDefinition,
  type VerifierPackageManifest,
  type VerifierPackageSnapshotInput,
} from "../../domain/capability/verifier-packages.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_ENTRIES = 2_000;
const MAX_VERIFIER_PACKAGES = 32;
const MANIFEST_NAME = "VERIFIER.yaml";

export type VerifierPackageCatalogErrorCode =
  | "duplicate_package"
  | "invalid_package"
  | "io"
  | "limit_exceeded"
  | "missing_package"
  | "source_changed"
  | "unsafe_entry"
  | "version_mismatch";

export class VerifierPackageCatalogError extends Error {
  override readonly name = "VerifierPackageCatalogError";

  constructor(
    readonly code: VerifierPackageCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedMessage(message), options);
  }
}

export interface VerifierPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface DiscoveredVerifierPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly definition: VerifierPackageDefinition;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface ProjectVerifierPackageCatalog {
  readonly projectRoot: string;
  readonly root: string;
  readonly packages: readonly DiscoveredVerifierPackage[];
}

interface ScanBudget {
  entries: number;
}

export async function discoverProjectVerifierPackages(
  projectRoot: string,
): Promise<ProjectVerifierPackageCatalog> {
  const canonicalProject = await canonicalDirectory(projectRoot, "Flow project root");
  const flowDirectory = join(canonicalProject, ".flow");
  const flowMetadata = await optionalLstat(flowDirectory);
  if (flowMetadata === null) {
    return emptyCatalog(canonicalProject, join(flowDirectory, "verifiers"));
  }
  assertRealDirectory(flowMetadata, flowDirectory);
  const root = join(flowDirectory, "verifiers");
  const rootMetadata = await optionalLstat(root);
  if (rootMetadata === null) {
    return emptyCatalog(canonicalProject, root);
  }
  assertRealDirectory(rootMetadata, root);
  const canonicalRoot = await realpath(root);
  assertWithin(canonicalRoot, flowDirectory, "verifier package root");

  const packages: DiscoveredVerifierPackage[] = [];
  await scanPackages(canonicalProject, canonicalRoot, canonicalRoot, 0, { entries: 0 }, packages);
  packages.sort((left, right) => compareStrings(left.name, right.name));
  if (packages.length > MAX_VERIFIER_PACKAGES) {
    throw limitError(`verifier package catalog exceeds ${MAX_VERIFIER_PACKAGES} packages`);
  }
  for (let index = 1; index < packages.length; index += 1) {
    const current = packages[index];
    const previous = packages[index - 1];
    if (current === undefined || previous === undefined) {
      throw new VerifierPackageCatalogError("io", "verifier package ordering is inconsistent");
    }
    if (current?.name === previous?.name) {
      throw new VerifierPackageCatalogError(
        "duplicate_package",
        `duplicate verifier package name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
  return deepFreeze({ projectRoot: canonicalProject, root: canonicalRoot, packages });
}

export async function snapshotSelectedVerifierPackages(
  catalog: ProjectVerifierPackageCatalog,
  references: readonly VerifierPackageReference[],
): Promise<VerifierPackageCapabilitySnapshot> {
  if (references.length === 0) {
    throw new VerifierPackageCatalogError(
      "missing_package",
      "at least one verifier package must be selected for a capability snapshot",
    );
  }
  if (
    references.length > MAX_VERIFIER_PACKAGES ||
    new Set(references.map((item) => item.name)).size !== references.length
  ) {
    throw new VerifierPackageCatalogError(
      "invalid_package",
      "selected verifier package names must be unique and bounded",
    );
  }
  const byName = new Map(catalog.packages.map((item) => [item.name, item]));
  const inputs: VerifierPackageSnapshotInput[] = [];
  for (const reference of [...references].sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const discovered = byName.get(reference.name);
    if (discovered === undefined) {
      throw new VerifierPackageCatalogError(
        "missing_package",
        `selected verifier package "${reference.name}" was not discovered below "${catalog.root}"`,
      );
    }
    if (discovered.version !== reference.version) {
      throw new VerifierPackageCatalogError(
        "version_mismatch",
        `selected verifier package "${reference.name}" requires version "${reference.version}" but discovered "${discovered.version}"`,
      );
    }
    inputs.push(await snapshotPackage(catalog, discovered));
  }
  try {
    return createCapabilitySnapshot([], inputs);
  } catch (error) {
    if (error instanceof VerifierPackageCatalogError) {
      throw error;
    }
    throw new VerifierPackageCatalogError(
      "invalid_package",
      `failed to create verifier package snapshot: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function scanPackages(
  projectRoot: string,
  catalogRoot: string,
  directory: string,
  depth: number,
  budget: ScanBudget,
  packages: DiscoveredVerifierPackage[],
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`verifier package discovery exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  const entries = await readDirectory(directory);
  budget.entries += entries.length;
  if (budget.entries > MAX_DISCOVERY_ENTRIES) {
    throw limitError(`verifier package discovery exceeds ${MAX_DISCOVERY_ENTRIES} entries`);
  }
  const manifest = entries.find((entry) => entry.name === MANIFEST_NAME);
  if (manifest !== undefined) {
    if (manifest.isSymbolicLink() || !manifest.isFile()) {
      throw unsafeError(
        `verifier package manifest "${join(directory, MANIFEST_NAME)}" must be a regular file`,
      );
    }
    if (entries.length !== 1) {
      throw unsafeError(
        `verifier package "${directory}" must contain only its inert ${MANIFEST_NAME} manifest`,
      );
    }
    packages.push(await readDiscoveredPackage(projectRoot, catalogRoot, directory));
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`verifier package discovery refuses symbolic link "${path}"`);
    }
    if (!entry.isDirectory()) {
      throw unsafeError(`verifier package catalog entry "${path}" must be a package directory`);
    }
    await scanPackages(projectRoot, catalogRoot, path, depth + 1, budget, packages);
  }
}

async function readDiscoveredPackage(
  projectRoot: string,
  catalogRoot: string,
  directory: string,
): Promise<DiscoveredVerifierPackage> {
  const path = join(directory, MANIFEST_NAME);
  const source = await readRegularFile(path, catalogRoot);
  const manifest = parseManifest(source, path);
  if (manifest.metadata.name !== basename(directory)) {
    throw new VerifierPackageCatalogError(
      "invalid_package",
      `${path}: name "${manifest.metadata.name}" must match parent directory "${basename(directory)}"`,
    );
  }
  return discoveredPackage(projectRoot, directory, source, manifest);
}

function discoveredPackage(
  projectRoot: string,
  directory: string,
  source: Uint8Array,
  manifest: VerifierPackageManifest,
): DiscoveredVerifierPackage {
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

async function snapshotPackage(
  catalog: ProjectVerifierPackageCatalog,
  discovered: DiscoveredVerifierPackage,
): Promise<VerifierPackageSnapshotInput> {
  const directoryMetadata = await lstatSafe(discovered.directory);
  assertRealDirectory(directoryMetadata, discovered.directory);
  const canonicalDirectoryPath = await realpath(discovered.directory);
  if (canonicalDirectoryPath !== discovered.directory) {
    throw unsafeError(`verifier package "${discovered.directory}" changed identity`);
  }
  assertWithin(canonicalDirectoryPath, catalog.root, "verifier package");
  const entries = await readDirectory(canonicalDirectoryPath);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== MANIFEST_NAME ||
    entries[0].isSymbolicLink() ||
    !entries[0].isFile()
  ) {
    throw new VerifierPackageCatalogError(
      "source_changed",
      `verifier package "${discovered.name}" contents changed after discovery`,
    );
  }
  const path = join(canonicalDirectoryPath, MANIFEST_NAME);
  const source = await readRegularFile(path, catalog.root);
  const manifest = parseManifest(source, path);
  if (
    sha256(source) !== discovered.manifestSha256 ||
    JSON.stringify(manifest) !== JSON.stringify(toManifest(discovered))
  ) {
    throw new VerifierPackageCatalogError(
      "source_changed",
      `verifier package "${discovered.name}" manifest changed after discovery`,
    );
  }
  return {
    kind: "verifier-package",
    apiVersion: manifest.apiVersion,
    name: discovered.name,
    version: discovered.version,
    description: discovered.description,
    ...(discovered.license === undefined ? {} : { license: discovered.license }),
    ...(discovered.compatibility === undefined ? {} : { compatibility: discovered.compatibility }),
    trust: discovered.trust,
    provenance: discovered.provenance,
    definition: discovered.definition,
    manifest: { content: source },
  };
}

function toManifest(discovered: DiscoveredVerifierPackage): VerifierPackageManifest {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "VerifierPackage",
    metadata: {
      name: discovered.name,
      version: discovered.version,
      description: discovered.description,
      ...(discovered.license === undefined ? {} : { license: discovered.license }),
      ...(discovered.compatibility === undefined
        ? {}
        : { compatibility: discovered.compatibility }),
    },
    spec: discovered.definition,
  };
}

function parseManifest(source: Uint8Array, path: string): VerifierPackageManifest {
  try {
    return parseVerifierPackageManifest(source, path);
  } catch (error) {
    throw new VerifierPackageCatalogError(
      "invalid_package",
      error instanceof Error ? error.message : `${path}: invalid verifier package manifest`,
      { cause: error },
    );
  }
}

async function readRegularFile(path: string, root: string): Promise<Buffer> {
  const before = await lstatSafe(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeError(`verifier package file "${path}" must be a regular file`);
  }
  if (before.size === 0 || before.size > MAX_VERIFIER_PACKAGE_MANIFEST_BYTES) {
    throw limitError(
      `verifier package manifest "${path}" must be 1-${MAX_VERIFIER_PACKAGE_MANIFEST_BYTES} bytes`,
    );
  }
  const canonical = await realpath(path);
  assertWithin(canonical, root, "verifier package file");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw unsafeError(`verifier package file "${path}" changed identity before it was opened`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== content.byteLength) {
      throw new VerifierPackageCatalogError(
        "source_changed",
        `verifier package file "${path}" changed while it was being captured`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof VerifierPackageCatalogError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw unsafeError(`verifier package file "${path}" must not be a symbolic link`, error);
    }
    throw new VerifierPackageCatalogError("io", `failed to read verifier package file "${path}"`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    throw new VerifierPackageCatalogError(
      "io",
      `failed to read verifier package directory "${path}"`,
      {
        cause: error,
      },
    );
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    const metadata = await lstat(canonical);
    assertRealDirectory(metadata, canonical);
    return canonical;
  } catch (error) {
    if (error instanceof VerifierPackageCatalogError) {
      throw error;
    }
    throw new VerifierPackageCatalogError("io", `${label} "${path}" is not available`, {
      cause: error,
    });
  }
}

function assertRealDirectory(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeError(`verifier package path "${path}" must be a real directory`);
  }
}

function assertWithin(path: string, root: string, label: string): void {
  const fromRoot = relative(resolve(root), resolve(path));
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw unsafeError(`${label} "${path}" escapes "${root}"`);
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (value.length === 0 || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw unsafeError(`verifier package path "${path}" is outside "${root}"`);
  }
  return value.split(sep).join("/");
}

async function optionalLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw new VerifierPackageCatalogError(
      "io",
      `failed to inspect verifier package path "${path}"`,
      {
        cause: error,
      },
    );
  }
}

async function lstatSafe(path: string): Promise<Stats> {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    throw new VerifierPackageCatalogError(
      "source_changed",
      `verifier package path "${path}" disappeared`,
    );
  }
  return metadata;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function emptyCatalog(projectRoot: string, root: string): ProjectVerifierPackageCatalog {
  return deepFreeze({ projectRoot, root, packages: [] });
}

function limitError(message: string): VerifierPackageCatalogError {
  return new VerifierPackageCatalogError("limit_exceeded", message);
}

function unsafeError(message: string, cause?: unknown): VerifierPackageCatalogError {
  return new VerifierPackageCatalogError(
    "unsafe_entry",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  return bytes.length <= 16_384
    ? message
    : `${bytes.subarray(0, 16_300).toString("utf8")}… [truncated]`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
