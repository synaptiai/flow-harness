import { type BigIntStats, constants, type Dir, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentSkillManifestError,
  parseAgentSkillManifest,
} from "../../domain/capability/agent-skill-manifest.js";
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
import type { CapabilityBundleAgentSkillPackage } from "../../domain/capability/capability-bundles.js";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_ENTRIES = 2_000;
export const MAX_AGENT_SKILL_SNAPSHOT_ENTRIES = MAX_DISCOVERY_ENTRIES;
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

export async function snapshotProjectAgentSkillPath(input: {
  readonly projectRoot: string;
  readonly provenance: string;
  readonly expectedName: string;
  readonly signal?: AbortSignal;
  /** @internal Deterministic package-entry race and cancellation seam. */
  readonly afterEntryObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic package-revalidation cancellation seam. */
  readonly afterRevalidationObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic package-directory cancellation seam. */
  readonly afterDirectoryBoundary?: (
    provenance: string,
    phase: "entries" | "stat",
  ) => void | Promise<void>;
  /** @internal Deterministic package-file cancellation seam. */
  readonly afterFileBoundary?: (
    provenance: string,
    phase: "open" | "stat" | "close",
  ) => void | Promise<void>;
  /** @internal Proves cancellation prevents post-capture package processing. */
  readonly afterPackageCapture?: () => void | Promise<void>;
}): Promise<{
  readonly snapshot: AgentSkillCapabilitySnapshot;
  readonly revalidate: () => Promise<void>;
  readonly revalidateForPublication: () => Promise<void>;
}> {
  input.signal?.throwIfAborted();
  if (!isAgentSkillName(input.expectedName)) {
    throw new AgentSkillCatalogError("invalid_skill", "selected Agent Skill name is invalid");
  }
  const canonicalProject = resolve(input.projectRoot);
  const projectIdentity = await observeDirectDirectory(canonicalProject, input.signal);
  const skillsRoot = join(canonicalProject, ".flow", "skills");
  const directory = resolve(canonicalProject, input.provenance);
  assertWithin(directory, skillsRoot, "Agent Skill package");
  if (
    directory === skillsRoot ||
    portableRelative(canonicalProject, directory) !== input.provenance
  ) {
    throw unsafeError("Agent Skill package provenance is not canonical");
  }
  const observations = new Map<string, BigIntStats>();
  observations.set(canonicalProject, projectIdentity);
  let current = canonicalProject;
  for (const segment of input.provenance.split("/")) {
    input.signal?.throwIfAborted();
    current = join(current, segment);
    const identity = await observeDirectDirectory(current, input.signal);
    rememberDirectObservation(observations, current, identity);
  }
  await input.afterEntryObservation?.(input.provenance);
  input.signal?.throwIfAborted();
  const revalidate = async (): Promise<void> => {
    await revalidateDirectObservations(
      observations,
      input.signal,
      input.afterRevalidationObservation === undefined
        ? undefined
        : (path) =>
            input.afterRevalidationObservation?.(
              path === canonicalProject ? "" : portableRelative(canonicalProject, path),
            ),
    );
  };
  const revalidateForPublication = async (): Promise<void> => {
    input.signal?.throwIfAborted();
    let currentRoot: BigIntStats;
    try {
      currentRoot = await lstat(canonicalProject, { bigint: true });
    } catch (error) {
      input.signal?.throwIfAborted();
      throw new AgentSkillCatalogError("source_changed", "Agent Skill project root changed", {
        cause: error,
      });
    }
    input.signal?.throwIfAborted();
    if (!sameDirectoryNodeIdentity(projectIdentity, currentRoot)) {
      throw new AgentSkillCatalogError("source_changed", "Agent Skill project root changed");
    }
    await revalidateDirectObservations(
      new Map([...observations].filter(([path]) => path !== canonicalProject)),
      input.signal,
      input.afterRevalidationObservation === undefined
        ? undefined
        : (path) => input.afterRevalidationObservation?.(portableRelative(canonicalProject, path)),
    );
  };
  await revalidate();
  const state: DirectPackageCaptureState = {
    entries: 0,
    files: 0,
    logicalBytes: 0,
    observations,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.afterEntryObservation === undefined
      ? {}
      : { afterEntryObservation: input.afterEntryObservation }),
    ...(input.afterDirectoryBoundary === undefined
      ? {}
      : { afterDirectoryBoundary: input.afterDirectoryBoundary }),
    ...(input.afterFileBoundary === undefined
      ? {}
      : { afterFileBoundary: input.afterFileBoundary }),
  };
  const files: { path: string; content: Uint8Array }[] = [];
  await collectDirectPackageFiles(canonicalProject, directory, directory, 0, state, files);
  await input.afterPackageCapture?.();
  input.signal?.throwIfAborted();
  files.sort((left, right) => compareStrings(left.path, right.path));
  const manifest = files.find((file) => file.path === "SKILL.md");
  if (manifest === undefined) {
    throw new AgentSkillCatalogError("source_changed", "selected Agent Skill lost its manifest");
  }
  const parsed = parseLocalSkillManifest(
    Buffer.from(manifest.content),
    join(directory, "SKILL.md"),
  );
  if (parsed.name !== input.expectedName || parsed.name !== basename(directory)) {
    throw new AgentSkillCatalogError(
      "invalid_skill",
      "selected Agent Skill identity contradicts the declared package path",
    );
  }
  const snapshot = createCapabilitySnapshot([
    {
      kind: "agent-skill",
      name: parsed.name,
      description: parsed.description,
      ...(parsed.license === undefined ? {} : { license: parsed.license }),
      ...(parsed.compatibility === undefined ? {} : { compatibility: parsed.compatibility }),
      metadata: parsed.metadata,
      requestedTools: parsed.requestedTools,
      trust: "project-explicit",
      provenance: input.provenance,
      files,
    },
  ]) as AgentSkillCapabilitySnapshot;
  await revalidate();
  return deepFreeze({ snapshot, revalidate, revalidateForPublication });
}

interface DirectPackageCaptureState {
  entries: number;
  files: number;
  logicalBytes: number;
  readonly observations: Map<string, BigIntStats>;
  readonly signal?: AbortSignal;
  readonly afterEntryObservation?: (provenance: string) => void | Promise<void>;
  readonly afterDirectoryBoundary?: (
    provenance: string,
    phase: "entries" | "stat",
  ) => void | Promise<void>;
  readonly afterFileBoundary?: (
    provenance: string,
    phase: "open" | "stat" | "close",
  ) => void | Promise<void>;
}

async function collectDirectPackageFiles(
  projectRoot: string,
  packageRoot: string,
  directory: string,
  depth: number,
  state: DirectPackageCaptureState,
  files: { path: string; content: Uint8Array }[],
): Promise<void> {
  state.signal?.throwIfAborted();
  if (depth > MAX_DISCOVERY_DEPTH) {
    throw limitError(`Agent Skill package exceeds depth ${MAX_DISCOVERY_DEPTH}`);
  }
  const directoryIdentity = await observeDirectDirectory(directory, state.signal);
  rememberDirectObservation(state.observations, directory, directoryIdentity);
  if (depth > 0) {
    await state.afterEntryObservation?.(portableRelative(projectRoot, directory));
    state.signal?.throwIfAborted();
  }
  let handle: Dir | undefined;
  const entries: Dirent[] = [];
  try {
    try {
      handle = await opendir(directory);
    } catch (error) {
      state.signal?.throwIfAborted();
      throw new AgentSkillCatalogError("source_changed", "Agent Skill directory cannot be opened", {
        cause: error,
      });
    }
    state.signal?.throwIfAborted();
    for await (const entry of handle) {
      state.signal?.throwIfAborted();
      state.entries += 1;
      if (state.entries > MAX_AGENT_SKILL_SNAPSHOT_ENTRIES) {
        throw limitError(`Agent Skill package exceeds ${MAX_AGENT_SKILL_SNAPSHOT_ENTRIES} entries`);
      }
      entries.push(entry);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    state.signal?.throwIfAborted();
  }
  const directoryProvenance = portableRelative(projectRoot, directory);
  await state.afterDirectoryBoundary?.(directoryProvenance, "entries");
  state.signal?.throwIfAborted();
  let afterDirectory: BigIntStats;
  try {
    afterDirectory = await lstat(directory, { bigint: true });
  } catch (error) {
    state.signal?.throwIfAborted();
    throw new AgentSkillCatalogError(
      "source_changed",
      "Agent Skill directory changed during read",
      { cause: error },
    );
  }
  await state.afterDirectoryBoundary?.(directoryProvenance, "stat");
  state.signal?.throwIfAborted();
  if (!sameDirectIdentity(directoryIdentity, afterDirectory)) {
    throw new AgentSkillCatalogError("source_changed", "Agent Skill directory changed during read");
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    state.signal?.throwIfAborted();
    const path = join(directory, entry.name);
    let identity: BigIntStats;
    try {
      identity = await lstat(path, { bigint: true });
    } catch (error) {
      state.signal?.throwIfAborted();
      throw new AgentSkillCatalogError("source_changed", "Agent Skill entry changed", {
        cause: error,
      });
    }
    state.signal?.throwIfAborted();
    if (identity.isSymbolicLink()) {
      throw unsafeError("Agent Skill package contains a symbolic link");
    }
    rememberDirectObservation(state.observations, path, identity);
    const provenance = portableRelative(projectRoot, path);
    await state.afterEntryObservation?.(provenance);
    state.signal?.throwIfAborted();
    if (identity.isDirectory()) {
      await collectDirectPackageFiles(projectRoot, packageRoot, path, depth + 1, state, files);
      continue;
    }
    if (!identity.isFile()) {
      throw unsafeError("Agent Skill package contains a non-regular entry");
    }
    state.files += 1;
    if (state.files > MAX_AGENT_SKILL_FILES) {
      throw limitError(`Agent Skill package exceeds ${MAX_AGENT_SKILL_FILES} files`);
    }
    const content = await readDirectPackageFile(
      path,
      identity,
      state.signal,
      state.afterFileBoundary === undefined
        ? undefined
        : (phase) => state.afterFileBoundary?.(provenance, phase),
    );
    state.logicalBytes += content.byteLength;
    if (state.logicalBytes > MAX_AGENT_SKILL_PACKAGE_BYTES) {
      throw limitError(`Agent Skill package exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} bytes`);
    }
    files.push({ path: portableRelative(packageRoot, path), content });
  }
}

async function readDirectPackageFile(
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
  afterBoundary?: (phase: "open" | "stat" | "close") => void | Promise<void>,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (expected.size > BigInt(MAX_AGENT_SKILL_FILE_BYTES)) {
    throw limitError(`Agent Skill file exceeds ${MAX_AGENT_SKILL_FILE_BYTES} bytes`);
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    signal?.throwIfAborted();
    throw unsafeError("Agent Skill file cannot be opened without links", error);
  }
  let readOutcome:
    | { readonly ok: true; readonly value: Buffer }
    | { readonly ok: false; readonly error: unknown };
  try {
    readOutcome = {
      ok: true,
      value: await readOpenedDirectPackageFile(handle, path, expected, signal, afterBoundary),
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
  let boundaryOutcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  try {
    if (closeOutcome.ok) {
      await afterBoundary?.("close");
    }
    boundaryOutcome = { ok: true };
  } catch (error) {
    boundaryOutcome = { ok: false, error };
  }
  signal?.throwIfAborted();
  if (!readOutcome.ok) {
    throw readOutcome.error;
  }
  if (!closeOutcome.ok) {
    throw closeOutcome.error;
  }
  if (!boundaryOutcome.ok) {
    throw boundaryOutcome.error;
  }
  return readOutcome.value;
}

async function readOpenedDirectPackageFile(
  handle: FileHandle,
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
  afterBoundary?: (phase: "open" | "stat" | "close") => void | Promise<void>,
): Promise<Buffer> {
  await afterBoundary?.("open");
  signal?.throwIfAborted();
  const before = await handle.stat({ bigint: true });
  await afterBoundary?.("stat");
  signal?.throwIfAborted();
  if (!before.isFile() || !sameDirectIdentity(expected, before)) {
    throw new AgentSkillCatalogError("source_changed", "Agent Skill file changed before read");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_AGENT_SKILL_FILE_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_AGENT_SKILL_FILE_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_AGENT_SKILL_FILE_BYTES) {
    throw limitError(`Agent Skill file exceeds ${MAX_AGENT_SKILL_FILE_BYTES} bytes`);
  }
  const after = await handle.stat({ bigint: true });
  signal?.throwIfAborted();
  const lexical = await lstat(path, { bigint: true });
  signal?.throwIfAborted();
  if (!sameDirectIdentity(before, after) || !sameDirectIdentity(after, lexical)) {
    throw new AgentSkillCatalogError("source_changed", "Agent Skill file changed during read");
  }
  return Buffer.concat(chunks, total);
}

async function observeDirectDirectory(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  signal?.throwIfAborted();
  let identity: BigIntStats;
  try {
    identity = await lstat(path, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    throw new AgentSkillCatalogError("source_changed", "Agent Skill directory is unavailable", {
      cause: error,
    });
  }
  signal?.throwIfAborted();
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw unsafeError("Agent Skill directory must be a direct directory");
  }
  return identity;
}

function rememberDirectObservation(
  observations: Map<string, BigIntStats>,
  path: string,
  identity: BigIntStats,
): void {
  const prior = observations.get(path);
  if (prior !== undefined && !sameDirectIdentity(prior, identity)) {
    throw new AgentSkillCatalogError("source_changed", "Agent Skill path changed during admission");
  }
  observations.set(path, identity);
}

async function revalidateDirectObservations(
  observations: ReadonlyMap<string, BigIntStats>,
  signal?: AbortSignal,
  afterObservation?: (path: string) => void | Promise<void>,
): Promise<void> {
  for (const [path, expected] of observations) {
    signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(path, { bigint: true });
    } catch (error) {
      signal?.throwIfAborted();
      throw new AgentSkillCatalogError("source_changed", "Agent Skill path changed", {
        cause: error,
      });
    }
    await afterObservation?.(path);
    signal?.throwIfAborted();
    if (!sameDirectIdentity(expected, current)) {
      throw new AgentSkillCatalogError("source_changed", "Agent Skill path changed");
    }
  }
}

function sameDirectIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.isFile() === right.isFile() &&
    left.isDirectory() === right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink()
  );
}

function sameDirectoryNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
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
