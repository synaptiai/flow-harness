import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  type AgentSkillPackageCandidateIdentity,
  type AgentSkillPackageCandidateSource,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_BYTES,
  parseAgentSkillPackageCandidateText,
  projectAgentSkillPackageCandidate,
} from "../../domain/adaptation/agent-skill-package-candidate.js";
import {
  type AgentSkillCapabilitySnapshot,
  createCapabilitySnapshot,
  MAX_AGENT_SKILL_FILE_BYTES,
} from "../../domain/capability/agent-skills.js";
import type { TuningEvidencePacket } from "../../domain/evaluation/tuning-evidence.js";
import type { WorkflowSource } from "../../domain/workflow/schema.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";
import {
  admitLocalAgentSkillPackageCandidateGenerationSources,
  LocalAgentSkillPackageCandidateGenerationSourceError,
} from "./local-agent-skill-package-candidate-generation.js";

export type LocalAgentSkillPackageCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalAgentSkillPackageCandidateError extends Error {
  override readonly name = "LocalAgentSkillPackageCandidateError";

  constructor(
    readonly code: LocalAgentSkillPackageCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface LocalAgentSkillPackageCandidateAdmissionOptions {
  readonly signal?: AbortSignal;
  /** @internal Deterministic candidate-tree race and cancellation seam. */
  readonly afterEntryObservation?: (provenance: string) => void | Promise<void>;
}

export interface AdmittedLocalAgentSkillPackageCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly sourceSha256: string;
  readonly source: AgentSkillPackageCandidateSource;
  readonly identity: AgentSkillPackageCandidateIdentity;
  readonly baseline: {
    readonly provenance: string;
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly source: WorkflowSource;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly package: AgentSkillCapabilitySnapshot["packages"][number];
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  readonly revalidate: () => Promise<void>;
}

interface PathObservation {
  readonly path: string;
  readonly identity: BigIntStats;
  readonly contentStable?: boolean;
}

interface StableFile {
  readonly content: Buffer;
  readonly sha256: string;
  readonly observation: PathObservation;
}

export async function admitLocalAgentSkillPackageCandidate(
  candidatePath: string,
  options: LocalAgentSkillPackageCandidateAdmissionOptions = {},
): Promise<AdmittedLocalAgentSkillPackageCandidate> {
  try {
    return await admitLocalAgentSkillPackageCandidateUnchecked(candidatePath, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof LocalAgentSkillPackageCandidateError) {
      throw error;
    }
    throw invalidSource("candidate directory could not be admitted");
  }
}

async function admitLocalAgentSkillPackageCandidateUnchecked(
  candidatePath: string,
  options: LocalAgentSkillPackageCandidateAdmissionOptions,
): Promise<AdmittedLocalAgentSkillPackageCandidate> {
  options.signal?.throwIfAborted();
  const absolute = resolve(candidatePath);
  const lexicalParent = dirname(absolute);
  const lexicalParentObservations = await observeDirectoryAncestry(lexicalParent, options.signal);
  const lexicalParentIdentity = lexicalParentObservations.at(-1)?.identity;
  if (lexicalParentIdentity === undefined) {
    throw invalidPath("candidate parent directory observation is incomplete");
  }
  let parent: string;
  try {
    parent = await realpath(lexicalParent);
  } catch {
    options.signal?.throwIfAborted();
    throw invalidPath("candidate parent directory is invalid");
  }
  options.signal?.throwIfAborted();
  const canonicalParentIdentity = await observeDirectory(parent, options.signal);
  if (!sameDirectoryNodeIdentity(lexicalParentIdentity, canonicalParentIdentity)) {
    throw new LocalAgentSkillPackageCandidateError(
      "source_changed",
      "candidate parent directory changed during admission",
    );
  }
  const root = join(parent, basename(absolute));
  const rootIdentity = await observeDirectory(root, options.signal);
  const manifestPath = join(root, "CANDIDATE.json");
  const manifest = await stableReadFile(
    manifestPath,
    MAX_AGENT_SKILL_PACKAGE_CANDIDATE_BYTES,
    options.signal,
  );
  options.signal?.throwIfAborted();
  const sourceText = decodeUtf8(manifest.content);
  let source: AgentSkillPackageCandidateSource;
  try {
    source = parseAgentSkillPackageCandidateText(sourceText);
  } catch {
    throw invalidSource("candidate manifest is invalid");
  }

  let common: Awaited<ReturnType<typeof admitLocalAgentSkillPackageCandidateGenerationSources>>;
  try {
    common = await admitLocalAgentSkillPackageCandidateGenerationSources({
      outputPath: root,
      baselinePath: join(parent, ...source.baseline.workflow.path.split("/")),
      evidencePaths: source.evidence.map((item) => join(parent, ...item.path.split("/"))),
      blueprintPath: join(parent, ...source.blueprint.path.split("/")),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidateError(
      error instanceof LocalAgentSkillPackageCandidateGenerationSourceError &&
        error.code === "source_changed"
        ? "source_changed"
        : error instanceof LocalAgentSkillPackageCandidateGenerationSourceError &&
            error.code === "limit_exceeded"
          ? "limit_exceeded"
          : "invalid_source",
      "candidate workflow, evidence, or blueprint cannot be admitted",
    );
  }
  if (
    common.baseline.provenance !== source.baseline.workflow.path ||
    common.baseline.sourceSha256 !== source.baseline.workflow.sourceSha256 ||
    common.baseline.workflowDigest !== source.baseline.workflow.workflowDigest ||
    common.blueprint.provenance !== source.blueprint.path ||
    common.blueprint.sourceSha256 !== source.blueprint.sourceSha256
  ) {
    throw invalidSource("candidate source identities do not match");
  }
  if (
    common.evidence.length !== source.evidence.length ||
    common.evidence.some((item, index) => {
      const declared = source.evidence[index];
      return (
        declared === undefined ||
        item.provenance !== declared.path ||
        item.sourceSha256 !== declared.sourceSha256 ||
        item.packet.evidenceDigest !== declared.evidenceDigest ||
        item.packet.evaluation.planDigest !== declared.planDigest
      );
    })
  ) {
    throw invalidSource("candidate evidence identities do not match");
  }

  const packageRoot = join(root, ...source.package.path.split("/"));
  const capture = await capturePackageTree(
    root,
    packageRoot,
    source,
    options.signal,
    options.afterEntryObservation,
  );
  let candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  try {
    candidateCapabilitySnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        ...source.blueprint.document.skill,
        provenance: source.package.path,
        files: capture.files,
      },
    ]);
  } catch {
    throw invalidSource("candidate package is invalid");
  }
  const skill = candidateCapabilitySnapshot.packages[0];
  if (skill === undefined || skill.digest !== source.package.packageDigest) {
    throw invalidSource("candidate package identity does not match");
  }
  const projected = projectAgentSkillPackageCandidate({
    manifestProvenance: `${basename(root)}/CANDIDATE.json`,
    source,
    sourceSha256: manifest.sha256,
    baseline: {
      provenance: common.baseline.provenance,
      source: common.baseline.source,
      sourceSha256: common.baseline.sourceSha256,
      compiled: common.baseline.compiled,
    },
    evidence: common.evidence,
    package: skill,
  });
  const observations = [
    ...lexicalParentObservations,
    { path: root, identity: rootIdentity },
    manifest.observation,
    ...capture.observations,
  ];
  const revalidate = async (): Promise<void> => {
    options.signal?.throwIfAborted();
    await common.revalidate();
    options.signal?.throwIfAborted();
    await revalidateObservations(observations, options.signal);
    options.signal?.throwIfAborted();
  };
  await revalidate();
  return deepFreeze({
    sourcePath: manifestPath,
    sourceText,
    sourceSha256: manifest.sha256,
    source,
    identity: projected.identity,
    baseline: common.baseline,
    evidence: common.evidence,
    package: skill,
    workflow: projected.workflow,
    candidateCapabilitySnapshot: projected.candidateCapabilitySnapshot,
    revalidate,
  });
}

async function capturePackageTree(
  candidateRoot: string,
  packageRoot: string,
  source: AgentSkillPackageCandidateSource,
  signal: AbortSignal | undefined,
  afterEntryObservation: LocalAgentSkillPackageCandidateAdmissionOptions["afterEntryObservation"],
): Promise<{
  readonly files: readonly { readonly path: string; readonly content: Uint8Array }[];
  readonly observations: readonly PathObservation[];
}> {
  const expectedFiles = new Set(source.blueprint.document.files.map((file) => file.path));
  const expectedDirectories = new Set<string>(["", "skill", source.package.path]);
  for (const path of expectedFiles) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      expectedDirectories.add(`${source.package.path}/${segments.slice(0, length).join("/")}`);
    }
  }
  const maxEntries = expectedDirectories.size + expectedFiles.size;
  const observations: PathObservation[] = [];
  const actualFiles = new Set<string>();
  let entries = 0;
  const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const identity = await observeDirectory(absoluteDirectory, signal);
    observations.push({ path: absoluteDirectory, identity });
    const directory = await opendir(absoluteDirectory);
    try {
      for await (const entry of directory) {
        signal?.throwIfAborted();
        entries += 1;
        if (entries > maxEntries) {
          throw new LocalAgentSkillPackageCandidateError(
            "limit_exceeded",
            "candidate directory contains too many entries",
          );
        }
        const relativePath =
          relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
        const absolutePath = join(absoluteDirectory, entry.name);
        const observed = await lstat(absolutePath, { bigint: true });
        signal?.throwIfAborted();
        await afterEntryObservation?.(relativePath);
        signal?.throwIfAborted();
        if (observed.isSymbolicLink()) {
          throw invalidPath("candidate directory contains a link");
        }
        if (observed.isDirectory()) {
          if (!expectedDirectories.has(relativePath)) {
            throw invalidSource("candidate directory contains an unknown directory");
          }
          await walk(absolutePath, relativePath);
          continue;
        }
        if (!observed.isFile()) {
          throw invalidSource("candidate directory contains a special file");
        }
        if (relativePath === "CANDIDATE.json") {
          continue;
        }
        const packagePrefix = `${source.package.path}/`;
        if (!relativePath.startsWith(packagePrefix)) {
          throw invalidSource("candidate directory contains an unknown file");
        }
        const packagePath = relativePath.slice(packagePrefix.length);
        if (!expectedFiles.has(packagePath)) {
          throw invalidSource("candidate directory contains an undeclared package file");
        }
        actualFiles.add(packagePath);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await walk(candidateRoot, "");
  if (
    actualFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((path) => !actualFiles.has(path))
  ) {
    throw invalidSource("candidate package file set does not match the blueprint");
  }
  const files: { path: string; content: Uint8Array }[] = [];
  for (const path of [...expectedFiles].sort(compareStrings)) {
    signal?.throwIfAborted();
    const file = await stableReadFile(
      join(packageRoot, ...path.split("/")),
      MAX_AGENT_SKILL_FILE_BYTES,
      signal,
    );
    if ((file.observation.identity.mode & 0o111n) !== 0n) {
      throw invalidSource("candidate package contains an executable file");
    }
    decodeUtf8(file.content);
    observations.push(file.observation);
    files.push({ path, content: file.content });
  }
  return { files, observations };
}

async function observeDirectory(
  path: string,
  signal: AbortSignal | undefined,
): Promise<BigIntStats> {
  let identity: BigIntStats;
  try {
    identity = await lstat(path, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw invalidPath("candidate directory is unavailable");
  }
  signal?.throwIfAborted();
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw invalidPath("candidate path is not a direct directory");
  }
  return identity;
}

async function observeDirectoryAncestry(
  path: string,
  signal: AbortSignal | undefined,
): Promise<readonly PathObservation[]> {
  signal?.throwIfAborted();
  const absolute = resolve(path);
  const anchor = parse(absolute).root;
  const components = relative(anchor, absolute).split(sep).filter(Boolean);
  const observations: PathObservation[] = [];
  let current = anchor;
  for (const component of ["", ...components]) {
    signal?.throwIfAborted();
    if (component !== "") {
      current = join(current, component);
    }
    const identity = await observeDirectory(current, signal);
    observations.push({ path: current, identity, contentStable: false });
  }
  return observations;
}

async function stableReadFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<StableFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    signal?.throwIfAborted();
    throw invalidSource("candidate file cannot be opened without links");
  }
  let result: StableFile | undefined;
  let operationError: unknown;
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!before.isFile() || before.isSymbolicLink()) {
      throw invalidSource("candidate file is not regular");
    }
    if (before.size > BigInt(maxBytes)) {
      throw new LocalAgentSkillPackageCandidateError(
        "limit_exceeded",
        "candidate file exceeds its byte limit",
      );
    }
    const content = await readBounded(handle, maxBytes, signal);
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    const pathAfter = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (
      BigInt(content.byteLength) !== before.size ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathAfter)
    ) {
      throw new LocalAgentSkillPackageCandidateError(
        "source_changed",
        "candidate file changed during admission",
      );
    }
    result = {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      observation: { path, identity: after },
    };
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  signal?.throwIfAborted();
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeError !== undefined || result === undefined) {
    throw invalidSource("candidate file read did not settle");
  }
  return result;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    signal?.throwIfAborted();
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new LocalAgentSkillPackageCandidateError(
      "limit_exceeded",
      "candidate file exceeds its byte limit",
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

async function revalidateObservations(
  observations: readonly PathObservation[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const observation of observations) {
    signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(observation.path, { bigint: true });
    } catch {
      signal?.throwIfAborted();
      throw new LocalAgentSkillPackageCandidateError(
        "source_changed",
        "candidate directory changed after admission",
      );
    }
    signal?.throwIfAborted();
    const same = observation.identity.isDirectory()
      ? observation.contentStable === false
        ? sameDirectoryNodeIdentity(observation.identity, current)
        : sameDirectoryIdentity(observation.identity, current)
      : sameFileIdentity(observation.identity, current);
    if (!same) {
      throw new LocalAgentSkillPackageCandidateError(
        "source_changed",
        "candidate directory changed after admission",
      );
    }
  }
}

function sameDirectoryNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameDirectoryNodeIdentity(left, right) &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw invalidSource("candidate file is not valid UTF-8");
  }
}

function invalidPath(message: string): LocalAgentSkillPackageCandidateError {
  return new LocalAgentSkillPackageCandidateError("invalid_path", message);
}

function invalidSource(message: string): LocalAgentSkillPackageCandidateError {
  return new LocalAgentSkillPackageCandidateError("invalid_source", message);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
