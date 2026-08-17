import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  type AgentSkillPackageBlueprint,
  MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES,
  parseAgentSkillPackageBlueprintText,
} from "../../domain/adaptation/agent-skill-package-candidate-generation.js";
import {
  type AdmittedLocalPromptCandidateGenerationSources,
  admitLocalPromptCandidateGenerationSources,
  LocalPromptCandidateError,
} from "./local-prompt-candidate.js";

export type LocalAgentSkillPackageCandidateGenerationSourceErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalAgentSkillPackageCandidateGenerationSourceError extends Error {
  override readonly name = "LocalAgentSkillPackageCandidateGenerationSourceError";

  constructor(
    readonly code: LocalAgentSkillPackageCandidateGenerationSourceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface AdmitLocalAgentSkillPackageCandidateGenerationSourcesInput {
  readonly outputPath: string;
  readonly baselinePath: string;
  readonly evidencePaths: readonly string[];
  readonly blueprintPath: string;
  readonly signal?: AbortSignal;
  /** @internal Deterministic source race and cancellation seam. */
  readonly afterPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic blueprint path race and cancellation seam. */
  readonly afterBlueprintEntryObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic blueprint read race and cancellation seam. */
  readonly afterBlueprintFileBoundary?: (
    phase: "open" | "stat" | "read" | "close",
  ) => void | Promise<void>;
}

export interface AdmittedLocalAgentSkillPackageCandidateGenerationSources
  extends Pick<
    AdmittedLocalPromptCandidateGenerationSources,
    "outputPath" | "root" | "baseline" | "evidence"
  > {
  readonly blueprint: {
    readonly provenance: string;
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly document: AgentSkillPackageBlueprint;
  };
  readonly revalidate: () => Promise<void>;
}

interface PathObservation {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface StableFile {
  readonly content: Buffer;
  readonly sha256: string;
}

export async function admitLocalAgentSkillPackageCandidateGenerationSources(
  input: AdmitLocalAgentSkillPackageCandidateGenerationSourcesInput,
): Promise<AdmittedLocalAgentSkillPackageCandidateGenerationSources> {
  input.signal?.throwIfAborted();
  let common: AdmittedLocalPromptCandidateGenerationSources;
  try {
    common = await admitLocalPromptCandidateGenerationSources(
      input.outputPath,
      input.baselinePath,
      input.evidencePaths,
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.afterPathValidation === undefined
          ? {}
          : { afterPathValidation: input.afterPathValidation }),
      },
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      error instanceof LocalPromptCandidateError && error.code === "source_changed"
        ? "source_changed"
        : error instanceof LocalPromptCandidateError && error.code === "limit_exceeded"
          ? "limit_exceeded"
          : "invalid_source",
      "candidate generation workflow or evidence cannot be admitted",
    );
  }
  input.signal?.throwIfAborted();
  const provenance = portableSourceProvenance(common.root, input.blueprintPath);
  let observations: readonly PathObservation[];
  try {
    observations = await observeSourcePath(
      common.root,
      provenance,
      input.signal,
      input.afterBlueprintEntryObservation,
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof LocalAgentSkillPackageCandidateGenerationSourceError) {
      throw error;
    }
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint cannot be admitted",
    );
  }
  input.signal?.throwIfAborted();
  await input.afterPathValidation?.(provenance);
  input.signal?.throwIfAborted();
  const sourcePath = join(common.root, ...provenance.split("/"));
  const expected = requiredFinalObservation(observations);
  let file: StableFile;
  try {
    file = await stableReadFile(
      sourcePath,
      expected,
      input.signal,
      input.afterBlueprintFileBoundary,
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof LocalAgentSkillPackageCandidateGenerationSourceError) {
      throw error;
    }
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint cannot be admitted",
    );
  }
  input.signal?.throwIfAborted();
  const sourceText = decodeUtf8(file.content);
  let document: AgentSkillPackageBlueprint;
  try {
    document = parseAgentSkillPackageBlueprintText(sourceText, "package blueprint");
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      error instanceof Error && "code" in error && error.code === "limit_exceeded"
        ? "limit_exceeded"
        : "invalid_source",
      "package blueprint is invalid",
    );
  }
  const revalidate = async (): Promise<void> => {
    input.signal?.throwIfAborted();
    try {
      await common.revalidate();
      input.signal?.throwIfAborted();
      await revalidatePathObservations(observations, input.signal);
      input.signal?.throwIfAborted();
    } catch {
      input.signal?.throwIfAborted();
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "source_changed",
        "candidate generation sources changed after admission",
      );
    }
  };
  await revalidate();
  return deepFreeze({
    outputPath: common.outputPath,
    root: common.root,
    baseline: common.baseline,
    evidence: common.evidence,
    blueprint: {
      provenance,
      sourcePath,
      sourceText,
      sourceSha256: file.sha256,
      document,
    },
    revalidate,
  });
}

function portableSourceProvenance(root: string, sourcePath: string): string {
  const absolute = resolve(sourcePath);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_path",
      "package blueprint must be below the candidate generation root",
    );
  }
  const provenance = fromRoot.split(sep).join("/");
  if (
    provenance.includes("\\") ||
    provenance
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_path",
      "package blueprint path is invalid",
    );
  }
  return provenance;
}

async function observeSourcePath(
  root: string,
  provenance: string,
  signal?: AbortSignal,
  afterObservation?: (provenance: string) => void | Promise<void>,
): Promise<readonly PathObservation[]> {
  signal?.throwIfAborted();
  const observations: PathObservation[] = [];
  let current = root;
  const segments = provenance.split("/");
  const rootIdentity = await observePath(root, signal);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_path",
      "candidate generation root is not a direct directory",
    );
  }
  // Common source admission already revalidates this output root by no-follow
  // directory identity. Do not duplicate it with timestamp-sensitive checks:
  // the publisher's own same-parent lock and staging entries change those timestamps.
  for (const [index, segment] of segments.entries()) {
    signal?.throwIfAborted();
    current = join(current, segment);
    const identity = await observePath(current, signal);
    await afterObservation?.(segments.slice(0, index + 1).join("/"));
    signal?.throwIfAborted();
    if (identity.isSymbolicLink()) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "invalid_path",
        "package blueprint path contains a link",
      );
    }
    if (index < segments.length - 1 && !identity.isDirectory()) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "invalid_source",
        "package blueprint path contains a non-directory ancestor",
      );
    }
    if (index === segments.length - 1 && !identity.isFile()) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "invalid_source",
        "package blueprint is not a regular file",
      );
    }
    observations.push({ path: current, identity });
  }
  return Object.freeze(observations);
}

async function observePath(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  try {
    const identity = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    return identity;
  } catch (_error) {
    signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint source is unavailable",
    );
  }
}

async function stableReadFile(
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
  afterBoundary?: (phase: "open" | "stat" | "read" | "close") => void | Promise<void>,
): Promise<StableFile> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (_error) {
    signal?.throwIfAborted();
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint cannot be opened without links",
    );
  }
  let result: StableFile | undefined;
  let operationError: unknown;
  try {
    await afterBoundary?.("open");
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    await afterBoundary?.("stat");
    signal?.throwIfAborted();
    if (!before.isFile() || !sameFileIdentity(expected, before)) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "source_changed",
        "package blueprint changed before read",
      );
    }
    if (before.size > BigInt(MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES)) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "limit_exceeded",
        "package blueprint exceeds its byte limit",
      );
    }
    const content = await readBounded(handle, MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES, signal);
    await afterBoundary?.("read");
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    const pathAfter = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (
      BigInt(content.byteLength) !== before.size ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathAfter)
    ) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "source_changed",
        "package blueprint changed during read",
      );
    }
    result = Object.freeze({
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
    await afterBoundary?.("close");
  } catch (error) {
    closeError = error;
  }
  signal?.throwIfAborted();
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeError !== undefined || result === undefined) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint read did not settle",
    );
  }
  return result;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    signal?.throwIfAborted();
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "limit_exceeded",
      "package blueprint exceeds its byte limit",
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

async function revalidatePathObservations(
  observations: readonly PathObservation[],
  signal?: AbortSignal,
): Promise<void> {
  for (const observation of observations) {
    signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(observation.path, { bigint: true });
      signal?.throwIfAborted();
    } catch (_error) {
      signal?.throwIfAborted();
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "source_changed",
        "package blueprint source changed",
      );
    }
    const same = observation.identity.isDirectory()
      ? sameDirectoryIdentity(observation.identity, current)
      : sameFileIdentity(observation.identity, current);
    if (current.isSymbolicLink() || !same) {
      throw new LocalAgentSkillPackageCandidateGenerationSourceError(
        "source_changed",
        "package blueprint source changed",
      );
    }
  }
}

function requiredFinalObservation(observations: readonly PathObservation[]): BigIntStats {
  const identity = observations.at(-1)?.identity;
  if (identity === undefined) {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint observation is incomplete",
    );
  }
  return identity;
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new LocalAgentSkillPackageCandidateGenerationSourceError(
      "invalid_source",
      "package blueprint must be valid UTF-8",
    );
  }
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
