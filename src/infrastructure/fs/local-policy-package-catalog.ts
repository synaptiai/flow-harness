import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createCapabilitySnapshot,
  type PolicyPackageCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import type { CapabilityBundlePolicyPackage } from "../../domain/capability/capability-bundles.js";
import {
  MAX_POLICY_PACKAGE_MANIFEST_BYTES,
  type PolicyPackageDefinition,
  type PolicyPackageManifest,
  type PolicyPackageSnapshotInput,
  parsePolicyPackageManifest,
} from "../../domain/capability/policy-packages.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_ENTRIES = 2_000;
export const MAX_POLICY_PACKAGES = 32;
const MANIFEST_NAME = "POLICY.yaml";
const installedPolicySources = new WeakMap<DiscoveredPolicyPackage, string>();

export type PolicyPackageCatalogErrorCode =
  | "duplicate_package"
  | "invalid_package"
  | "io"
  | "limit_exceeded"
  | "missing_package"
  | "source_changed"
  | "unsafe_entry"
  | "version_mismatch";

export class PolicyPackageCatalogError extends Error {
  override readonly name = "PolicyPackageCatalogError";

  constructor(
    readonly code: PolicyPackageCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedMessage(message), options);
  }
}

export interface PolicyPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface DiscoveredPolicyPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly definition: PolicyPackageDefinition;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly directory: string;
  readonly manifestSha256: string;
}

export interface ProjectPolicyPackageCatalog {
  readonly projectRoot: string;
  readonly root: string;
  readonly packages: readonly DiscoveredPolicyPackage[];
}

export function createInstalledDiscoveredPolicyPackage(input: {
  readonly projectRoot: string;
  readonly bundleDigest: string;
  readonly package: CapabilityBundlePolicyPackage;
}): DiscoveredPolicyPackage {
  const digest = requireBundleDigest(input.bundleDigest);
  const directory = join(
    input.projectRoot,
    ".flow",
    "packages",
    "sha256",
    digest,
    "policy-package",
    input.package.name,
  );
  const source = Buffer.from(input.package.manifestBase64, "base64");
  const parsed = parseManifest(source, `${directory}/${MANIFEST_NAME}`);
  const discovered = discoveredPackage(input.projectRoot, directory, source, parsed);
  installedPolicySources.set(discovered, input.package.manifestBase64);
  return discovered;
}

export async function discoverProjectPolicyPackages(
  projectRoot: string,
): Promise<ProjectPolicyPackageCatalog> {
  const canonicalProject = await canonicalDirectory(projectRoot, "Flow project root");
  const flowDirectory = join(canonicalProject, ".flow");
  const flowMetadata = await optionalLstat(flowDirectory);
  if (flowMetadata === null) {
    return emptyCatalog(canonicalProject, join(flowDirectory, "policies"));
  }
  assertRealDirectory(flowMetadata, flowDirectory);
  const root = join(flowDirectory, "policies");
  const rootMetadata = await optionalLstat(root);
  if (rootMetadata === null) {
    return emptyCatalog(canonicalProject, root);
  }
  assertRealDirectory(rootMetadata, root);
  const canonicalRoot = await realpath(root);
  assertWithin(canonicalRoot, flowDirectory, "policy package root");

  const packages: DiscoveredPolicyPackage[] = [];
  await scanPackages(canonicalProject, canonicalRoot, canonicalRoot, 0, { entries: 0 }, packages);
  packages.sort(compareByName);
  assertPolicyPackageCatalog(packages);
  return deepFreeze({ projectRoot: canonicalProject, root: canonicalRoot, packages });
}

export async function snapshotSelectedPolicyPackages(
  catalog: ProjectPolicyPackageCatalog,
  references: readonly PolicyPackageReference[],
): Promise<PolicyPackageCapabilitySnapshot> {
  if (references.length === 0) {
    throw new PolicyPackageCatalogError(
      "missing_package",
      "at least one policy package must be selected for a capability snapshot",
    );
  }
  if (
    references.length > MAX_POLICY_PACKAGES ||
    new Set(references.map((item) => item.name)).size !== references.length
  ) {
    throw new PolicyPackageCatalogError(
      "invalid_package",
      "selected policy package names must be unique and bounded",
    );
  }
  const byName = new Map(catalog.packages.map((item) => [item.name, item]));
  const inputs: PolicyPackageSnapshotInput[] = [];
  for (const reference of [...references].sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const discovered = byName.get(reference.name);
    if (discovered === undefined) {
      throw new PolicyPackageCatalogError(
        "missing_package",
        `selected policy package "${reference.name}" was not discovered below "${catalog.root}"`,
      );
    }
    if (discovered.version !== reference.version) {
      throw new PolicyPackageCatalogError(
        "version_mismatch",
        `selected policy package "${reference.name}" requires version "${reference.version}" but discovered "${discovered.version}"`,
      );
    }
    inputs.push(await snapshotPackage(catalog, discovered));
  }
  try {
    return createCapabilitySnapshot([], [], [], [], inputs);
  } catch (error) {
    if (error instanceof PolicyPackageCatalogError) {
      throw error;
    }
    throw new PolicyPackageCatalogError(
      "invalid_package",
      `failed to create policy package snapshot: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function assertPolicyPackageCatalog(
  packages: readonly DiscoveredPolicyPackage[],
  label = "combined policy package catalog",
): void {
  if (packages.length > MAX_POLICY_PACKAGES) {
    throw limitError(`${label} exceeds ${MAX_POLICY_PACKAGES} packages`);
  }
  for (let index = 1; index < packages.length; index += 1) {
    const current = packages[index];
    const previous = packages[index - 1];
    if (current === undefined || previous === undefined) {
      throw new PolicyPackageCatalogError("io", "policy package ordering is inconsistent");
    }
    if (current.name === previous.name) {
      throw new PolicyPackageCatalogError(
        "duplicate_package",
        `duplicate policy package name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
}

interface ScanBudget {
  entries: number;
}

async function scanPackages(
  projectRoot: string,
  catalogRoot: string,
  directory: string,
  depth: number,
  budget: ScanBudget,
  packages: DiscoveredPolicyPackage[],
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`policy package discovery exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  const entries = await readDirectory(directory);
  budget.entries += entries.length;
  if (budget.entries > MAX_DISCOVERY_ENTRIES) {
    throw limitError(`policy package discovery exceeds ${MAX_DISCOVERY_ENTRIES} entries`);
  }
  const manifest = entries.find((entry) => entry.name === MANIFEST_NAME);
  if (manifest !== undefined) {
    if (manifest.isSymbolicLink() || !manifest.isFile()) {
      throw unsafeError(
        `policy package manifest "${join(directory, MANIFEST_NAME)}" must be a regular file`,
      );
    }
    if (entries.length !== 1) {
      throw unsafeError(
        `policy package "${directory}" must contain only its inert ${MANIFEST_NAME} manifest`,
      );
    }
    packages.push(await readDiscoveredPackage(projectRoot, catalogRoot, directory));
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`policy package discovery refuses symbolic link "${path}"`);
    }
    if (!entry.isDirectory()) {
      throw unsafeError(`policy package catalog entry "${path}" must be a package directory`);
    }
    await scanPackages(projectRoot, catalogRoot, path, depth + 1, budget, packages);
  }
}

async function readDiscoveredPackage(
  projectRoot: string,
  catalogRoot: string,
  directory: string,
): Promise<DiscoveredPolicyPackage> {
  const path = join(directory, MANIFEST_NAME);
  const source = await readRegularFile(path, catalogRoot);
  const manifest = parseManifest(source, path);
  if (manifest.metadata.name !== basename(directory)) {
    throw new PolicyPackageCatalogError(
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
  manifest: PolicyPackageManifest,
): DiscoveredPolicyPackage {
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
  catalog: ProjectPolicyPackageCatalog,
  discovered: DiscoveredPolicyPackage,
): Promise<PolicyPackageSnapshotInput> {
  const installedSource = installedPolicySources.get(discovered);
  if (installedSource !== undefined) {
    const source = Buffer.from(installedSource, "base64");
    assertDiscoveredManifest(discovered, source, `${discovered.directory}/${MANIFEST_NAME}`);
    return snapshotInput(discovered, source);
  }
  const metadata = await lstatSafe(discovered.directory);
  assertRealDirectory(metadata, discovered.directory);
  const canonicalDirectoryPath = await realpath(discovered.directory);
  if (canonicalDirectoryPath !== discovered.directory) {
    throw unsafeError(`policy package "${discovered.directory}" changed identity`);
  }
  assertWithin(canonicalDirectoryPath, catalog.root, "policy package");
  const entries = await readDirectory(canonicalDirectoryPath);
  if (
    entries.length !== 1 ||
    entries[0]?.name !== MANIFEST_NAME ||
    entries[0].isSymbolicLink() ||
    !entries[0].isFile()
  ) {
    throw new PolicyPackageCatalogError(
      "source_changed",
      `policy package "${discovered.name}" contents changed after discovery`,
    );
  }
  const path = join(canonicalDirectoryPath, MANIFEST_NAME);
  const source = await readRegularFile(path, catalog.root);
  assertDiscoveredManifest(discovered, source, path);
  return snapshotInput(discovered, source);
}

function assertDiscoveredManifest(
  discovered: DiscoveredPolicyPackage,
  source: Uint8Array,
  path: string,
): void {
  const manifest = parseManifest(source, path);
  if (
    sha256(source) !== discovered.manifestSha256 ||
    manifest.metadata.name !== discovered.name ||
    manifest.metadata.version !== discovered.version ||
    manifest.metadata.description !== discovered.description ||
    manifest.metadata.license !== discovered.license ||
    manifest.metadata.compatibility !== discovered.compatibility ||
    JSON.stringify(manifest.spec) !== JSON.stringify(discovered.definition)
  ) {
    throw new PolicyPackageCatalogError(
      "source_changed",
      `policy package "${discovered.name}" manifest changed after discovery`,
    );
  }
}

function snapshotInput(
  discovered: DiscoveredPolicyPackage,
  source: Uint8Array,
): PolicyPackageSnapshotInput {
  return {
    kind: "policy-package",
    trust: discovered.trust,
    provenance: discovered.provenance,
    manifest: { content: source },
  };
}

function parseManifest(source: Uint8Array, path: string): PolicyPackageManifest {
  try {
    return parsePolicyPackageManifest(source, path);
  } catch (error) {
    throw new PolicyPackageCatalogError(
      "invalid_package",
      error instanceof Error ? error.message : `${path}: invalid policy package manifest`,
      { cause: error },
    );
  }
}

async function readRegularFile(path: string, root: string): Promise<Buffer> {
  const before = await lstatBigintSafe(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeError(`policy package file "${path}" must be a regular file`);
  }
  if (before.size === 0n || before.size > BigInt(MAX_POLICY_PACKAGE_MANIFEST_BYTES)) {
    throw limitError(
      `policy package manifest "${path}" must be 1-${MAX_POLICY_PACKAGE_MANIFEST_BYTES} bytes`,
    );
  }
  const canonical = await realpath(path);
  assertWithin(canonical, root, "policy package file");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw unsafeError(`policy package file "${path}" changed identity before it was opened`);
    }
    const content = await readBounded(
      handle,
      MAX_POLICY_PACKAGE_MANIFEST_BYTES,
      `policy package manifest "${path}"`,
    );
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, after) || after.size !== BigInt(content.byteLength)) {
      throw new PolicyPackageCatalogError(
        "source_changed",
        `policy package file "${path}" changed while it was being captured`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof PolicyPackageCatalogError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw unsafeError(`policy package file "${path}" must not be a symbolic link`, error);
    }
    throw new PolicyPackageCatalogError("io", `failed to read policy package file "${path}"`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle, maxBytes: number, label: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw limitError(`${label} exceeds ${maxBytes} bytes while being captured`);
  }
  return buffer.subarray(0, offset);
}

async function readDirectory(path: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    throw new PolicyPackageCatalogError("io", `failed to read policy package directory "${path}"`, {
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
    if (error instanceof PolicyPackageCatalogError) {
      throw error;
    }
    throw new PolicyPackageCatalogError("io", `${label} "${path}" is not available`, {
      cause: error,
    });
  }
}

function assertRealDirectory(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeError(`policy package path "${path}" must be a real directory`);
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
    throw unsafeError(`policy package path "${path}" is outside "${root}"`);
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
    throw new PolicyPackageCatalogError("io", `failed to inspect policy package path "${path}"`, {
      cause: error,
    });
  }
}

async function lstatSafe(path: string): Promise<Stats> {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    throw new PolicyPackageCatalogError(
      "source_changed",
      `policy package path "${path}" disappeared`,
    );
  }
  return metadata;
}

async function lstatBigintSafe(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new PolicyPackageCatalogError(
        "source_changed",
        `policy package path "${path}" disappeared`,
      );
    }
    throw new PolicyPackageCatalogError("io", `failed to inspect policy package path "${path}"`, {
      cause: error,
    });
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function emptyCatalog(projectRoot: string, root: string): ProjectPolicyPackageCatalog {
  return deepFreeze({ projectRoot, root, packages: [] });
}

function limitError(message: string): PolicyPackageCatalogError {
  return new PolicyPackageCatalogError("limit_exceeded", message);
}

function unsafeError(message: string, cause?: unknown): PolicyPackageCatalogError {
  return new PolicyPackageCatalogError(
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

function requireBundleDigest(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  if (match?.[1] === undefined) {
    throw new PolicyPackageCatalogError(
      "invalid_package",
      "installed policy package bundle digest is invalid",
    );
  }
  return match[1];
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return compareStrings(left.name, right.name);
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
