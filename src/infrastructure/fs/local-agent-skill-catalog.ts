import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type AgentSkillCapabilitySnapshot,
  type AgentSkillPackageSnapshotInput,
  createCapabilitySnapshot,
  isAgentSkillName,
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_AGENT_SKILL_FILES,
  MAX_AGENT_SKILL_PACKAGE_BYTES,
  MAX_AGENT_SKILL_PACKAGES,
} from "../../domain/capability/agent-skills.js";
import {
  AgentSkillManifestError,
  parseAgentSkillManifest,
} from "../../domain/capability/agent-skill-manifest.js";
import type { CapabilityBundleAgentSkillPackage } from "../../domain/capability/capability-bundles.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_ENTRIES = 2_000;
const installedAgentSkillSources = new WeakMap<
  DiscoveredAgentSkill,
  CapabilityBundleAgentSkillPackage["files"]
>();
export type AgentSkillCatalogErrorCode =
  | "duplicate_skill"
  | "invalid_skill"
  | "io"
  | "limit_exceeded"
  | "missing_skill"
  | "source_changed"
  | "unsafe_entry";

export class AgentSkillCatalogError extends Error {
  override readonly name = "AgentSkillCatalogError";

  constructor(
    readonly code: AgentSkillCatalogErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedMessage(message), options);
  }
}

export interface DiscoveredAgentSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly directory: string;
}

export interface ProjectAgentSkillCatalog {
  readonly projectRoot: string;
  readonly root: string;
  readonly skills: readonly DiscoveredAgentSkill[];
}

export function createInstalledDiscoveredAgentSkill(input: {
  readonly projectRoot: string;
  readonly bundleDigest: string;
  readonly skill: CapabilityBundleAgentSkillPackage;
}): DiscoveredAgentSkill {
  const digest = requireBundleDigest(input.bundleDigest);
  const provenance = `.flow/packages/sha256/${digest}/agent-skill/${input.skill.name}`;
  const discovered = deepFreeze({
    name: input.skill.name,
    description: input.skill.description,
    ...(input.skill.license === undefined ? {} : { license: input.skill.license }),
    ...(input.skill.compatibility === undefined
      ? {}
      : { compatibility: input.skill.compatibility }),
    metadata: input.skill.metadata,
    requestedTools: input.skill.requestedTools,
    trust: "project-explicit" as const,
    provenance,
    directory: join(input.projectRoot, ...provenance.split("/")),
  });
  installedAgentSkillSources.set(discovered, input.skill.files);
  return discovered;
}

interface ScanBudget {
  entries: number;
}

export async function discoverProjectAgentSkills(
  projectRoot: string,
): Promise<ProjectAgentSkillCatalog> {
  const canonicalProject = await canonicalDirectory(projectRoot, "Flow project root");
  const flowDirectory = join(canonicalProject, ".flow");
  const flowMetadata = await optionalLstat(flowDirectory);
  if (flowMetadata === null) {
    return emptyCatalog(canonicalProject, join(canonicalProject, ".flow", "skills"));
  }
  assertRealDirectory(flowMetadata, flowDirectory);
  const root = join(flowDirectory, "skills");
  const rootMetadata = await optionalLstat(root);
  if (rootMetadata === null) {
    return emptyCatalog(canonicalProject, root);
  }
  assertRealDirectory(rootMetadata, root);
  const canonicalRoot = await realpath(root);
  assertWithin(canonicalRoot, flowDirectory, "Agent Skills root");

  const discovered: DiscoveredAgentSkill[] = [];
  await scanForSkills(
    canonicalProject,
    canonicalRoot,
    canonicalRoot,
    0,
    { entries: 0 },
    discovered,
  );
  discovered.sort((left, right) => compareStrings(left.name, right.name));
  if (discovered.length > MAX_AGENT_SKILL_PACKAGES) {
    throw limitError(`Agent Skills catalog exceeds ${MAX_AGENT_SKILL_PACKAGES} packages`);
  }
  for (let index = 1; index < discovered.length; index += 1) {
    const current = discovered[index];
    const previous = discovered[index - 1];
    if (current === undefined || previous === undefined) {
      throw new AgentSkillCatalogError("io", "Agent Skills catalog ordering is inconsistent");
    }
    if (current?.name === previous?.name) {
      throw new AgentSkillCatalogError(
        "duplicate_skill",
        `duplicate Agent Skill name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
  return deepFreeze({ projectRoot: canonicalProject, root: canonicalRoot, skills: discovered });
}

export async function snapshotSelectedAgentSkills(
  catalog: ProjectAgentSkillCatalog,
  names: readonly string[],
): Promise<AgentSkillCapabilitySnapshot> {
  if (names.length === 0) {
    throw new AgentSkillCatalogError(
      "missing_skill",
      "at least one Agent Skill must be selected for a capability snapshot",
    );
  }
  if (new Set(names).size !== names.length || names.some((name) => !isAgentSkillName(name))) {
    throw new AgentSkillCatalogError(
      "invalid_skill",
      "selected Agent Skill names must be valid and unique",
    );
  }
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  const inputs: AgentSkillPackageSnapshotInput[] = [];
  for (const name of [...names].sort(compareStrings)) {
    const discovered = byName.get(name);
    if (discovered === undefined) {
      throw new AgentSkillCatalogError(
        "missing_skill",
        `selected Agent Skill "${name}" was not discovered below "${catalog.root}"`,
      );
    }
    inputs.push(await snapshotPackage(catalog, discovered));
  }
  try {
    return createCapabilitySnapshot(inputs);
  } catch (error) {
    if (error instanceof AgentSkillCatalogError) {
      throw error;
    }
    throw new AgentSkillCatalogError(
      "invalid_skill",
      `failed to create Agent Skills snapshot: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function scanForSkills(
  projectRoot: string,
  skillsRoot: string,
  directory: string,
  depth: number,
  budget: ScanBudget,
  discovered: DiscoveredAgentSkill[],
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`Agent Skills discovery exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  const entries = await readDirectory(directory);
  budget.entries += entries.length;
  if (budget.entries > MAX_DISCOVERY_ENTRIES) {
    throw limitError(`Agent Skills discovery exceeds ${MAX_DISCOVERY_ENTRIES} entries`);
  }
  const manifest = entries.find((entry) => entry.name === "SKILL.md");
  if (manifest !== undefined) {
    if (!manifest.isFile() || manifest.isSymbolicLink()) {
      throw unsafeError(
        `Agent Skill manifest "${join(directory, manifest.name)}" must be a regular file`,
      );
    }
    discovered.push(await readDiscoveredSkill(projectRoot, skillsRoot, directory));
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`Agent Skills discovery refuses symbolic link "${path}"`);
    }
    if (!entry.isDirectory()) {
      continue;
    }
    await scanForSkills(projectRoot, skillsRoot, path, depth + 1, budget, discovered);
  }
}

async function readDiscoveredSkill(
  projectRoot: string,
  skillsRoot: string,
  directory: string,
): Promise<DiscoveredAgentSkill> {
  const manifestPath = join(directory, "SKILL.md");
  const source = await readRegularFile(manifestPath, skillsRoot, MAX_AGENT_SKILL_FILE_BYTES);
  const frontmatter = parseLocalSkillManifest(source, manifestPath);
  if (frontmatter.name !== basename(directory)) {
    throw new AgentSkillCatalogError(
      "invalid_skill",
      `${manifestPath}: name "${frontmatter.name}" must match parent directory "${basename(directory)}"`,
    );
  }
  return deepFreeze({
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.license === undefined ? {} : { license: frontmatter.license }),
    ...(frontmatter.compatibility === undefined
      ? {}
      : { compatibility: frontmatter.compatibility }),
    metadata: frontmatter.metadata,
    requestedTools: frontmatter.requestedTools,
    trust: "project-explicit" as const,
    provenance: portableRelative(projectRoot, directory),
    directory,
  });
}

async function snapshotPackage(
  catalog: ProjectAgentSkillCatalog,
  discovered: DiscoveredAgentSkill,
): Promise<AgentSkillPackageSnapshotInput> {
  const installedFiles = installedAgentSkillSources.get(discovered);
  if (installedFiles !== undefined) {
    return {
      kind: "agent-skill",
      name: discovered.name,
      description: discovered.description,
      ...(discovered.license === undefined ? {} : { license: discovered.license }),
      ...(discovered.compatibility === undefined
        ? {}
        : { compatibility: discovered.compatibility }),
      metadata: discovered.metadata,
      requestedTools: discovered.requestedTools,
      trust: discovered.trust,
      provenance: discovered.provenance,
      files: installedFiles.map((file) => ({
        path: file.path,
        content: Buffer.from(file.contentBase64, "base64"),
      })),
    };
  }
  const directoryMetadata = await lstatSafe(discovered.directory);
  assertRealDirectory(directoryMetadata, discovered.directory);
  const canonicalDirectoryPath = await realpath(discovered.directory);
  if (canonicalDirectoryPath !== discovered.directory) {
    throw unsafeError(`Agent Skill package "${discovered.directory}" changed identity`);
  }
  assertWithin(canonicalDirectoryPath, catalog.root, "Agent Skill package");
  const files: { path: string; content: Uint8Array }[] = [];
  await collectPackageFiles(catalog.root, canonicalDirectoryPath, canonicalDirectoryPath, 0, files);
  files.sort((left, right) => compareStrings(left.path, right.path));
  const packageBytes = files.reduce((total, file) => total + file.content.byteLength, 0);
  if (packageBytes > MAX_AGENT_SKILL_PACKAGE_BYTES) {
    throw limitError(
      `Agent Skill "${discovered.name}" exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} bytes`,
    );
  }
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (manifest === undefined) {
    throw new AgentSkillCatalogError(
      "source_changed",
      `Agent Skill "${discovered.name}" no longer contains SKILL.md`,
    );
  }
  const current = parseLocalSkillManifest(
    Buffer.from(manifest.content),
    join(discovered.directory, "SKILL.md"),
  );
  if (
    current.name !== discovered.name ||
    current.description !== discovered.description ||
    current.license !== discovered.license ||
    current.compatibility !== discovered.compatibility ||
    JSON.stringify(current.metadata) !== JSON.stringify(discovered.metadata) ||
    JSON.stringify(current.requestedTools) !== JSON.stringify(discovered.requestedTools)
  ) {
    throw new AgentSkillCatalogError(
      "source_changed",
      `Agent Skill "${discovered.name}" manifest changed after discovery`,
    );
  }
  return {
    kind: "agent-skill",
    name: discovered.name,
    description: discovered.description,
    ...(discovered.license === undefined ? {} : { license: discovered.license }),
    ...(discovered.compatibility === undefined ? {} : { compatibility: discovered.compatibility }),
    metadata: discovered.metadata,
    requestedTools: discovered.requestedTools,
    trust: discovered.trust,
    provenance: discovered.provenance,
    files,
  };
}

async function collectPackageFiles(
  skillsRoot: string,
  packageRoot: string,
  directory: string,
  depth: number,
  files: { path: string; content: Uint8Array }[],
): Promise<void> {
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`Agent Skill package exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  for (const entry of await readDirectory(directory)) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`Agent Skill package refuses symbolic link "${path}"`);
    }
    if (entry.isDirectory()) {
      await collectPackageFiles(skillsRoot, packageRoot, path, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) {
      throw unsafeError(`Agent Skill package entry "${path}" must be a regular file or directory`);
    }
    if (files.length >= MAX_AGENT_SKILL_FILES) {
      throw limitError(`Agent Skill package exceeds ${MAX_AGENT_SKILL_FILES} files`);
    }
    files.push({
      path: portableRelative(packageRoot, path),
      content: await readRegularFile(path, skillsRoot, MAX_AGENT_SKILL_FILE_BYTES),
    });
  }
}

function parseLocalSkillManifest(source: Uint8Array, path: string) {
  try {
    return parseAgentSkillManifest(source, path);
  } catch (error) {
    if (error instanceof AgentSkillManifestError) {
      throw new AgentSkillCatalogError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

async function readRegularFile(path: string, root: string, maxBytes: number): Promise<Buffer> {
  const before = await lstatSafe(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeError(`Agent Skill file "${path}" must be a regular file`);
  }
  if (before.size > maxBytes) {
    throw limitError(`Agent Skill file "${path}" exceeds ${maxBytes} bytes`);
  }
  const canonical = await realpath(path);
  assertWithin(canonical, root, "Agent Skill file");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw unsafeError(`Agent Skill file "${path}" changed identity before it was opened`);
    }
    if (opened.size > maxBytes) {
      throw limitError(`Agent Skill file "${path}" exceeds ${maxBytes} bytes`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== content.byteLength) {
      throw new AgentSkillCatalogError(
        "source_changed",
        `Agent Skill file "${path}" changed while it was being captured`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof AgentSkillCatalogError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw unsafeError(`Agent Skill file "${path}" must not be a symbolic link`, error);
    }
    throw new AgentSkillCatalogError("io", `failed to read Agent Skill file "${path}"`, {
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
    throw new AgentSkillCatalogError("io", `failed to read Agent Skills directory "${path}"`, {
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
    if (error instanceof AgentSkillCatalogError) {
      throw error;
    }
    throw new AgentSkillCatalogError("io", `${label} "${path}" is not available`, { cause: error });
  }
}

function assertRealDirectory(metadata: Stats, path: string): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw unsafeError(`Agent Skills path "${path}" must be a real directory`);
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
    throw unsafeError(`Agent Skill path "${path}" is outside "${root}"`);
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
    throw new AgentSkillCatalogError("io", `failed to inspect Agent Skills path "${path}"`, {
      cause: error,
    });
  }
}

async function lstatSafe(path: string): Promise<Stats> {
  const metadata = await optionalLstat(path);
  if (metadata === null) {
    throw new AgentSkillCatalogError("source_changed", `Agent Skills path "${path}" disappeared`);
  }
  return metadata;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function emptyCatalog(projectRoot: string, root: string): ProjectAgentSkillCatalog {
  return deepFreeze({ projectRoot, root, skills: [] });
}

function limitError(message: string): AgentSkillCatalogError {
  return new AgentSkillCatalogError("limit_exceeded", message);
}

function unsafeError(message: string, cause?: unknown): AgentSkillCatalogError {
  return new AgentSkillCatalogError(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireBundleDigest(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  if (match?.[1] === undefined) {
    throw new AgentSkillCatalogError(
      "invalid_skill",
      "installed Agent Skill bundle digest is invalid",
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
