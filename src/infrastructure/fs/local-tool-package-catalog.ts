import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createCapabilitySnapshot,
  type ToolPackageCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import {
  MAX_TOOL_PACKAGE_MANIFEST_BYTES,
  parseToolPackageManifest,
  type ToolPackageDefinition,
  type ToolPackageManifest,
  type ToolPackageSnapshotInput,
} from "../../domain/capability/tool-packages.js";
import type { CapabilityBundleToolPackage } from "../../domain/capability/capability-bundles.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_ENTRIES = 2_000;
export const MAX_TOOL_PACKAGES = 32;
const MANIFEST_NAME = "TOOL.yaml";
const installedToolSources = new WeakMap<DiscoveredToolPackage, string>();

export type ToolPackageCatalogErrorCode =
  | "duplicate_package"
  | "invalid_package"
  | "io"
  | "limit_exceeded"
  | "missing_package"
  | "source_changed"
  | "unsafe_entry"
  | "version_mismatch";

export class ToolPackageCatalogError extends Error {
  override readonly name = "ToolPackageCatalogError";

  constructor(
    readonly code: ToolPackageCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedMessage(message), options);
  }
}

export interface ToolPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface DiscoveredToolPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly definition: ToolPackageDefinition;
  readonly permissions: readonly ["process.execute"];
  readonly toolName: string;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface ProjectToolPackageCatalog {
  readonly projectRoot: string;
  readonly root: string;
  readonly packages: readonly DiscoveredToolPackage[];
}

export function createInstalledDiscoveredToolPackage(input: {
  readonly projectRoot: string;
  readonly bundleDigest: string;
  readonly package: CapabilityBundleToolPackage;
}): DiscoveredToolPackage {
  const digest = requireBundleDigest(input.bundleDigest);
  const directory = join(
    input.projectRoot,
    ".flow",
    "packages",
    "sha256",
    digest,
    "tool-package",
    input.package.name,
  );
  const source = Buffer.from(input.package.manifestBase64, "base64");
  const manifest = parseManifest(source, `${directory}/${MANIFEST_NAME}`);
  const discovered = discoveredPackage(input.projectRoot, directory, source, manifest);
  installedToolSources.set(discovered, input.package.manifestBase64);
  return discovered;
}

interface ScanBudget {
  entries: number;
}

export async function discoverProjectToolPackages(
  projectRoot: string,
): Promise<ProjectToolPackageCatalog> {
  const canonicalProject = await canonicalDirectory(projectRoot, "Flow project root");
  const flowDirectory = join(canonicalProject, ".flow");
  const flowMetadata = await optionalLstat(flowDirectory);
  if (flowMetadata === null) {
    return emptyCatalog(canonicalProject, join(flowDirectory, "tools"));
  }
  assertRealDirectory(flowMetadata, flowDirectory);
  const root = join(flowDirectory, "tools");
  const rootMetadata = await optionalLstat(root);
  if (rootMetadata === null) {
    return emptyCatalog(canonicalProject, root);
  }
  assertRealDirectory(rootMetadata, root);
  const canonicalRoot = await realpath(root);
  assertWithin(canonicalRoot, flowDirectory, "tool package root");

  const packages: DiscoveredToolPackage[] = [];
  await scanPackages(canonicalProject, canonicalRoot, canonicalRoot, 0, { entries: 0 }, packages);
  packages.sort((left, right) => compareStrings(left.name, right.name));
  if (packages.length > MAX_TOOL_PACKAGES) {
    throw limitError(`tool package catalog exceeds ${MAX_TOOL_PACKAGES} packages`);
  }
  for (let index = 1; index < packages.length; index += 1) {
    const current = packages[index];
    const previous = packages[index - 1];
    if (current === undefined || previous === undefined) {
      throw new ToolPackageCatalogError("io", "tool package ordering is inconsistent");
    }
    if (current.name === previous.name) {
      throw new ToolPackageCatalogError(
        "duplicate_package",
        `duplicate tool package name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
  return deepFreeze({ projectRoot: canonicalProject, root: canonicalRoot, packages });
}

export async function snapshotSelectedToolPackages(
  catalog: ProjectToolPackageCatalog,
  references: readonly ToolPackageReference[],
): Promise<ToolPackageCapabilitySnapshot> {
  if (references.length === 0) {
    throw new ToolPackageCatalogError(
      "missing_package",
      "at least one tool package must be selected for a capability snapshot",
    );
  }
  if (
    references.length > MAX_TOOL_PACKAGES ||
    new Set(references.map((item) => item.name)).size !== references.length
  ) {
    throw new ToolPackageCatalogError(
      "invalid_package",
      "selected tool package names must be unique and bounded",
    );
  }
  const byName = new Map(catalog.packages.map((item) => [item.name, item]));
  const inputs: ToolPackageSnapshotInput[] = [];
  for (const reference of [...references].sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const discovered = byName.get(reference.name);
    if (discovered === undefined) {
      throw new ToolPackageCatalogError(
        "missing_package",
        `selected tool package "${reference.name}" was not discovered below "${catalog.root}"`,
      );
    }
    if (discovered.version !== reference.version) {
      throw new ToolPackageCatalogError(
        "version_mismatch",
        `selected tool package "${reference.name}" requires version "${reference.version}" but discovered "${discovered.version}"`,
      );
    }
    inputs.push(await snapshotPackage(catalog, discovered));
  }
  try {
    return createCapabilitySnapshot([], [], inputs);
  } catch (error) {
    if (error instanceof ToolPackageCatalogError) {
      throw error;
    }
    throw new ToolPackageCatalogError(
      "invalid_package",
      `failed to create tool package snapshot: ${error instanceof Error ? error.message : String(error)}`,
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
  packages: DiscoveredToolPackage[],
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`tool package discovery exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  const entries = await readDirectory(directory);
  budget.entries += entries.length;
  if (budget.entries > MAX_DISCOVERY_ENTRIES) {
    throw limitError(`tool package discovery exceeds ${MAX_DISCOVERY_ENTRIES} entries`);
  }
  const manifest = entries.find((entry) => entry.name === MANIFEST_NAME);
  if (manifest !== undefined) {
    if (manifest.isSymbolicLink() || !manifest.isFile()) {
      throw unsafeError(
        `tool package manifest "${join(directory, MANIFEST_NAME)}" must be a regular file`,
      );
    }
    if (entries.length !== 1) {
      throw unsafeError(
        `tool package "${directory}" must contain only its inert ${MANIFEST_NAME} manifest`,
      );
    }
    packages.push(await readDiscoveredPackage(projectRoot, catalogRoot, directory));
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`tool package discovery refuses symbolic link "${path}"`);
    }
    if (!entry.isDirectory()) {
      throw unsafeError(`tool package catalog entry "${path}" must be a package directory`);
    }
    await scanPackages(projectRoot, catalogRoot, path, depth + 1, budget, packages);
  }
}

async function readDiscoveredPackage(
  projectRoot: string,
  catalogRoot: string,
  directory: string,
): Promise<DiscoveredToolPackage> {
  const path = join(directory, MANIFEST_NAME);
  const source = await readRegularFile(path, catalogRoot);
  const parsed = parseManifest(source, path);
  if (parsed.metadata.name !== basename(directory)) {
    throw new ToolPackageCatalogError(
      "invalid_package",
      `${path}: name "${parsed.metadata.name}" must match parent directory "${basename(directory)}"`,
    );
  }
  return discoveredPackage(projectRoot, directory, source, parsed);
}

function discoveredPackage(
  projectRoot: string,
  directory: string,
  source: Uint8Array,
  manifest: ToolPackageManifest,
): DiscoveredToolPackage {
  return deepFreeze({
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    description: manifest.metadata.description,
    ...(manifest.metadata.license === undefined ? {} : { license: manifest.metadata.license }),
    ...(manifest.metadata.compatibility === undefined
      ? {}
      : { compatibility: manifest.metadata.compatibility }),
    definition: manifest.spec,
    permissions: manifest.spec.permissions,
    toolName: manifest.spec.tool.name,
    trust: "project-explicit" as const,
    provenance: portableRelative(projectRoot, directory),
    directory,
    manifestSha256: sha256(source),
  });
}

async function snapshotPackage(
  catalog: ProjectToolPackageCatalog,
  discovered: DiscoveredToolPackage,
): Promise<ToolPackageSnapshotInput> {
  const installedSource = installedToolSources.get(discovered);
  if (installedSource !== undefined) {
    const source = Buffer.from(installedSource, "base64");
    const manifest = parseManifest(source, `${discovered.directory}/${MANIFEST_NAME}`);
    return {
      kind: "tool-package",
      apiVersion: manifest.apiVersion,
      name: discovered.name,
      version: discovered.version,
      description: discovered.description,
      ...(discovered.license === undefined ? {} : { license: discovered.license }),
      ...(discovered.compatibility === undefined
        ? {}
        : { compatibility: discovered.compatibility }),
      trust: discovered.trust,
      provenance: discovered.provenance,
      definition: discovered.definition,
      manifest: { content: source },
    };
  }
  const directoryMetadata = await lstatSafe(discovered.directory);
  assertRealDirectory(directoryMetadata, discovered.directory);
  const canonicalDirectoryPath = await realpath(discovered.directory);
  if (canonicalDirectoryPath !== discovered.directory) {
    throw unsafeError(`tool package "${discovered.directory}" changed identity`);
  }
  assertWithin(canonicalDirectoryPath, catalog.root, "tool package");
  const entries = await readDirectory(canonicalDirectoryPath);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== MANIFEST_NAME ||
    entries[0].isSymbolicLink() ||
    !entries[0].isFile()
  ) {
    throw new ToolPackageCatalogError(
      "source_changed",
      `tool package "${discovered.name}" contents changed after discovery`,
    );
  }
  const path = join(canonicalDirectoryPath, MANIFEST_NAME);
  const source = await readRegularFile(path, catalog.root);
  const manifest = parseManifest(source, path);
  if (
    sha256(source) !== discovered.manifestSha256 ||
    JSON.stringify(manifest) !== JSON.stringify(toManifest(discovered))
  ) {
    throw new ToolPackageCatalogError(
      "source_changed",
      `tool package "${discovered.name}" manifest changed after discovery`,
    );
  }
  return {
    kind: "tool-package",
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

function toManifest(discovered: DiscoveredToolPackage): ToolPackageManifest {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ToolPackage",
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

function parseManifest(source: Uint8Array, path: string): ToolPackageManifest {
  try {
    return parseToolPackageManifest(source, path);
  } catch (error) {
    throw new ToolPackageCatalogError(
      "invalid_package",
      error instanceof Error ? error.message : `${path}: invalid tool package manifest`,
      { cause: error },
    );
  }
}

async function readRegularFile(path: string, root: string): Promise<Buffer> {
  const before = await lstatSafe(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeError(`tool package file "${path}" must be a regular file`);
  }
  if (before.size === 0 || before.size > MAX_TOOL_PACKAGE_MANIFEST_BYTES) {
    throw limitError(
      `tool package manifest "${path}" must be 1-${MAX_TOOL_PACKAGE_MANIFEST_BYTES} bytes`,
    );
  }
  const canonical = await realpath(path);
  assertWithin(canonical, root, "tool package file");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw unsafeError(`tool package file "${path}" changed identity before it was opened`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== content.byteLength) {
      throw new ToolPackageCatalogError(
        "source_changed",
        `tool package file "${path}" changed while it was being captured`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ToolPackageCatalogError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw unsafeError(`tool package file "${path}" must not be a symbolic link`, error);
    }
    throw new ToolPackageCatalogError("io", `failed to read tool package file "${path}"`, {
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
    throw new ToolPackageCatalogError("io", `failed to read tool package directory "${path}"`, {
      cause: error,
    });
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    const metadata = await lstat(canonical);
    assertRealDirectory(metadata, canonical);
    return canonical;
  } catch (error) {
    if (error instanceof ToolPackageCatalogError) {
      throw error;
    }
    throw new ToolPackageCatalogError("io", `${label} "${path}" is not available`, {
      cause: error,
    });
  }
}

function assertRealDirectory(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeError(`tool package path "${path}" must be a real directory`);
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
    throw unsafeError(`tool package path "${path}" is outside "${root}"`);
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
    throw new ToolPackageCatalogError("io", `failed to inspect tool package path "${path}"`, {
      cause: error,
    });
  }
}

async function lstatSafe(path: string): Promise<Stats> {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    throw new ToolPackageCatalogError("source_changed", `tool package path "${path}" disappeared`);
  }
  return metadata;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function emptyCatalog(projectRoot: string, root: string): ProjectToolPackageCatalog {
  return deepFreeze({ projectRoot, root, packages: [] });
}

function limitError(message: string): ToolPackageCatalogError {
  return new ToolPackageCatalogError("limit_exceeded", message);
}

function unsafeError(message: string, cause?: unknown): ToolPackageCatalogError {
  return new ToolPackageCatalogError(
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

function requireBundleDigest(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  if (match?.[1] === undefined) {
    throw new ToolPackageCatalogError(
      "invalid_package",
      "installed tool package bundle digest is invalid",
    );
  }
  return match[1];
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
