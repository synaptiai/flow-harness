import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  type EffectiveHarnessState,
  parseEffectiveHarnessState,
} from "../../domain/adaptation/effective-harness-state.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES,
  type ProjectedSupplementalMemoryCandidate,
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
  type SupplementalMemoryCandidateIdentity,
  type SupplementalMemoryCandidateSource,
} from "../../domain/adaptation/supplemental-memory-candidate.js";
import { MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE } from "../../domain/adaptation/supplemental-memory-candidate-generation.js";
import type { RunEvidenceReference } from "../../domain/evidence/run-evidence-reference.js";
import {
  MAX_TUNING_EVIDENCE_BYTES,
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../../domain/evaluation/tuning-evidence.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface AdmittedLocalSupplementalMemoryCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: SupplementalMemoryCandidateSource;
  readonly sourceSha256: string;
  readonly identity: SupplementalMemoryCandidateIdentity;
  readonly baseline: EffectiveHarnessState;
  readonly state: ProjectedSupplementalMemoryCandidate["state"];
}

export interface AdmittedLocalSupplementalMemoryCandidateGenerationSources {
  readonly outputPath: string;
  readonly root: string;
  readonly evidence: readonly {
    readonly provenance: string;
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly revalidate: () => Promise<void>;
}

export interface LocalSupplementalMemoryCandidateGenerationSourcesOptions {
  readonly signal?: AbortSignal | undefined;
  /** @internal Deterministic source-race and cancellation seam. */
  readonly afterEvidenceRead?: (provenance: string) => void | Promise<void>;
}

export interface LocalSupplementalMemoryCandidateOptions {
  readonly signal?: AbortSignal | undefined;
  readonly resolveBaseline: (
    source: SupplementalMemoryCandidateSource,
  ) => Promise<EffectiveHarnessState>;
  readonly resolveRelationshipEvidence?:
    | ((
        source: SupplementalMemoryCandidateSource,
        baseline: EffectiveHarnessState,
      ) => Promise<readonly RunEvidenceReference[]>)
    | undefined;
  /** @internal Exact source identity captured by the generic candidate discriminator. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string } | undefined;
  /** @internal Deterministic source-race and cancellation seam. */
  readonly afterRead?: () => void | Promise<void>;
  /** @internal Deterministic final revalidation seam. */
  readonly beforeReturn?: () => void | Promise<void>;
}

export type LocalSupplementalMemoryCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalSupplementalMemoryCandidateError extends Error {
  override readonly name = "LocalSupplementalMemoryCandidateError";

  constructor(
    readonly code: LocalSupplementalMemoryCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function admitLocalSupplementalMemoryCandidateGenerationSources(
  outputPath: string,
  evidencePaths: readonly string[],
  options: LocalSupplementalMemoryCandidateGenerationSourcesOptions = {},
): Promise<AdmittedLocalSupplementalMemoryCandidateGenerationSources> {
  options.signal?.throwIfAborted();
  if (
    evidencePaths.length === 0 ||
    evidencePaths.length > MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE
  ) {
    throw new LocalSupplementalMemoryCandidateError(
      "limit_exceeded",
      "supplemental-memory generation evidence count is invalid",
    );
  }
  const canonicalOutputPath = resolve(outputPath);
  const root = dirname(canonicalOutputPath);
  const rootDirectories = await observeLexicalDirectories(root, options.signal);
  options.signal?.throwIfAborted();
  const admittedEvidence = await admitGenerationEvidence(
    root,
    evidencePaths.map((path) => evidenceProvenance(root, path)),
    options,
  );
  const provenances = admittedEvidence.items.map((item) => item.provenance);
  if (new Set(provenances).size !== provenances.length) {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_path",
      "supplemental-memory generation evidence paths must be unique",
    );
  }
  const revalidate = async () => {
    options.signal?.throwIfAborted();
    await revalidateDirectories(rootDirectories, options.signal);
    await admittedEvidence.revalidate();
    options.signal?.throwIfAborted();
  };
  await revalidate();
  return deepFreeze({
    outputPath: canonicalOutputPath,
    root,
    evidence: admittedEvidence.items,
    revalidate,
  });
}

export async function admitLocalSupplementalMemoryCandidate(
  candidatePath: string,
  options: LocalSupplementalMemoryCandidateOptions,
): Promise<AdmittedLocalSupplementalMemoryCandidate> {
  options.signal?.throwIfAborted();
  const absolutePath = resolve(candidatePath);
  const directories = await observeLexicalDirectories(dirname(absolutePath), options.signal);
  const file = await stableReadCandidate(absolutePath, options);
  await options.afterRead?.();
  options.signal?.throwIfAborted();
  let sourceText: string;
  let source: SupplementalMemoryCandidateSource;
  try {
    sourceText = fatalUtf8Decoder.decode(file.content);
    source = parseSupplementalMemoryCandidateText(sourceText, basename(absolutePath));
  } catch {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_source",
      "supplemental-memory candidate source is invalid",
    );
  }
  options.signal?.throwIfAborted();
  let baseline: EffectiveHarnessState;
  try {
    const resolved = await options.resolveBaseline(source);
    options.signal?.throwIfAborted();
    baseline = parseEffectiveHarnessState(resolved, { scopeDigest: resolved.scopeDigest });
  } catch {
    options.signal?.throwIfAborted();
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_source",
      "supplemental-memory candidate baseline cannot be resolved",
    );
  }
  let projected: ProjectedSupplementalMemoryCandidate;
  const generationEvidence =
    source.generation === undefined
      ? undefined
      : await admitGenerationEvidence(
          dirname(absolutePath),
          source.generation.evidence.map((item) => item.path),
          { signal: options.signal },
        );
  let relationshipEvidence: readonly RunEvidenceReference[] | undefined;
  if ((source.relationships?.add.length ?? 0) > 0) {
    if (options.resolveRelationshipEvidence === undefined) {
      throw new LocalSupplementalMemoryCandidateError(
        "invalid_source",
        "supplemental-memory relationship evidence cannot be resolved",
      );
    }
    try {
      relationshipEvidence = await options.resolveRelationshipEvidence(source, baseline);
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      throw new LocalSupplementalMemoryCandidateError(
        "invalid_source",
        "supplemental-memory relationship evidence cannot be resolved",
      );
    }
  }
  options.signal?.throwIfAborted();
  try {
    projected = projectSupplementalMemoryCandidate({
      manifestProvenance: basename(absolutePath),
      sourceSha256: file.sha256,
      source,
      baseline,
      ...(generationEvidence === undefined
        ? {}
        : {
            evidence: generationEvidence.items.map((item) => ({
              provenance: item.provenance,
              sourceSha256: item.sourceSha256,
              packet: item.packet,
            })),
          }),
      ...(relationshipEvidence === undefined ? {} : { relationshipEvidence }),
    });
  } catch {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_source",
      "supplemental-memory candidate projection is invalid",
    );
  }
  await options.beforeReturn?.();
  options.signal?.throwIfAborted();
  await revalidateDirectories(directories, options.signal);
  await revalidateFile(absolutePath, file.identity, options.signal);
  await generationEvidence?.revalidate();
  options.signal?.throwIfAborted();
  return Object.freeze({
    sourcePath: absolutePath,
    sourceText,
    source,
    sourceSha256: file.sha256,
    identity: projected.identity,
    baseline,
    state: projected.state,
  });
}

interface StableFile {
  readonly identity: BigIntStats;
  readonly content: Buffer;
  readonly sha256: string;
}

interface DirectoryObservation {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface AdmittedGenerationEvidence {
  readonly items: readonly {
    readonly provenance: string;
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly revalidate: () => Promise<void>;
}

async function admitGenerationEvidence(
  root: string,
  provenances: readonly string[],
  options: LocalSupplementalMemoryCandidateGenerationSourcesOptions,
): Promise<AdmittedGenerationEvidence> {
  const admitted = [] as Array<{
    provenance: string;
    sourcePath: string;
    sourceText: string;
    sourceSha256: string;
    packet: TuningEvidencePacket;
    directories: readonly DirectoryObservation[];
    identity: BigIntStats;
  }>;
  for (const provenance of provenances) {
    options.signal?.throwIfAborted();
    if (!isPortableRelativePath(provenance)) {
      throw new LocalSupplementalMemoryCandidateError(
        "invalid_path",
        "supplemental-memory generation evidence path is invalid",
      );
    }
    const sourcePath = resolve(root, provenance);
    if (evidenceProvenance(root, sourcePath) !== provenance) {
      throw new LocalSupplementalMemoryCandidateError(
        "invalid_path",
        "supplemental-memory generation evidence path escapes its root",
      );
    }
    const directories = await observeLexicalDirectories(dirname(sourcePath), options.signal);
    const file = await stableReadEvidence(sourcePath, options.signal);
    await options.afterEvidenceRead?.(provenance);
    options.signal?.throwIfAborted();
    let sourceText: string;
    let packet: TuningEvidencePacket;
    try {
      sourceText = fatalUtf8Decoder.decode(file.content);
      packet = parseTuningEvidencePacket(
        parseStrictJson(sourceText, {
          maxDepth: 32,
          maxNodes: 131_072,
          valueLabel: "supplemental-memory generation evidence",
        }),
      );
    } catch {
      throw new LocalSupplementalMemoryCandidateError(
        "invalid_source",
        "supplemental-memory generation evidence is invalid",
      );
    }
    admitted.push({
      provenance,
      sourcePath,
      sourceText,
      sourceSha256: file.sha256,
      packet,
      directories,
      identity: file.identity,
    });
  }
  const revalidate = async () => {
    for (const item of admitted) {
      options.signal?.throwIfAborted();
      await revalidateDirectories(item.directories, options.signal);
      await revalidateFile(item.sourcePath, item.identity, options.signal);
    }
  };
  await revalidate();
  return {
    items: admitted.map(({ directories: _directories, identity: _identity, ...item }) => item),
    revalidate,
  };
}

async function stableReadEvidence(path: string, signal?: AbortSignal): Promise<StableFile> {
  signal?.throwIfAborted();
  let lexical: BigIntStats;
  try {
    lexical = await lstat(path, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw invalidPath("generation evidence is unavailable");
  }
  signal?.throwIfAborted();
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw invalidPath("generation evidence must be a regular file without links");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    signal?.throwIfAborted();
    throw invalidPath("generation evidence cannot be opened without links");
  }
  let operation: StableFile | undefined;
  let operationError: unknown;
  try {
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!before.isFile()) throw invalidPath("generation evidence is not a regular file");
    if (before.size > BigInt(MAX_TUNING_EVIDENCE_BYTES)) {
      throw new LocalSupplementalMemoryCandidateError(
        "limit_exceeded",
        "supplemental-memory generation evidence exceeds its byte limit",
      );
    }
    const content = await readBoundedFile(
      handle,
      MAX_TUNING_EVIDENCE_BYTES,
      "supplemental-memory generation evidence exceeds its byte limit",
      signal,
    );
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (BigInt(content.byteLength) !== before.size || !sameIdentity(before, after)) {
      throw sourceChanged();
    }
    operation = {
      identity: before,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
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
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined || operation === undefined) {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_source",
      "supplemental-memory generation evidence could not be settled",
    );
  }
  return operation;
}

async function stableReadCandidate(
  path: string,
  options: LocalSupplementalMemoryCandidateOptions,
): Promise<StableFile> {
  options.signal?.throwIfAborted();
  let lexical: BigIntStats;
  try {
    lexical = await lstat(path, { bigint: true });
  } catch {
    options.signal?.throwIfAborted();
    throw invalidPath("source is unavailable");
  }
  options.signal?.throwIfAborted();
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw invalidPath("source must be a regular file without links");
  }
  if (
    options.expectedSource !== undefined &&
    !sameIdentity(options.expectedSource.identity, lexical)
  ) {
    throw sourceChanged();
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    options.signal?.throwIfAborted();
    throw invalidPath("source cannot be opened without links");
  }
  let operation: StableFile | undefined;
  let operationError: unknown;
  try {
    const before = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    if (!before.isFile()) throw invalidPath("source is not a regular file");
    if (before.size > BigInt(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES)) {
      throw new LocalSupplementalMemoryCandidateError(
        "limit_exceeded",
        "supplemental-memory candidate source exceeds its byte limit",
      );
    }
    const content = await readBounded(handle, options.signal);
    const after = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    if (BigInt(content.byteLength) !== before.size || !sameIdentity(before, after)) {
      throw sourceChanged();
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (options.expectedSource !== undefined && options.expectedSource.sha256 !== sha256) {
      throw sourceChanged();
    }
    operation = { identity: before, content, sha256 };
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  options.signal?.throwIfAborted();
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined || operation === undefined) {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_source",
      "supplemental-memory candidate source could not be settled",
    );
  }
  return operation;
}

async function readBounded(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  return readBoundedFile(
    handle,
    MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES,
    "supplemental-memory candidate source exceeds its byte limit",
    signal,
  );
}

async function readBoundedFile(
  handle: FileHandle,
  maxBytes: number,
  limitMessage: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes <= maxBytes) {
    signal?.throwIfAborted();
    const remaining = maxBytes + 1 - bytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    bytes += bytesRead;
  }
  if (bytes > maxBytes) {
    throw new LocalSupplementalMemoryCandidateError("limit_exceeded", limitMessage);
  }
  return Buffer.concat(chunks, bytes);
}

function evidenceProvenance(root: string, sourcePath: string): string {
  const provenance = relative(root, resolve(sourcePath)).split(sep).join("/");
  if (!isPortableRelativePath(provenance)) {
    throw new LocalSupplementalMemoryCandidateError(
      "invalid_path",
      "supplemental-memory generation evidence path escapes its root",
    );
  }
  return provenance;
}

function isPortableRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

async function observeLexicalDirectories(
  path: string,
  signal?: AbortSignal,
): Promise<readonly DirectoryObservation[]> {
  const anchor = parse(path).root;
  const components = relative(anchor, path).split(sep).filter(Boolean);
  const observations: DirectoryObservation[] = [];
  let current = anchor;
  for (const component of ["", ...components]) {
    signal?.throwIfAborted();
    if (component !== "") current = join(current, component);
    let identity: BigIntStats;
    try {
      identity = await lstat(current, { bigint: true });
    } catch {
      signal?.throwIfAborted();
      throw invalidPath("ancestry is unavailable");
    }
    signal?.throwIfAborted();
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw invalidPath("ancestry must contain only direct directories");
    }
    observations.push({ path: current, identity });
  }
  return observations;
}

async function revalidateDirectories(
  observations: readonly DirectoryObservation[],
  signal?: AbortSignal,
): Promise<void> {
  for (const observation of observations) {
    signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(observation.path, { bigint: true });
    } catch {
      signal?.throwIfAborted();
      throw sourceChanged();
    }
    signal?.throwIfAborted();
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameDirectoryIdentity(observation.identity, current)
    ) {
      throw sourceChanged();
    }
  }
}

async function revalidateFile(
  path: string,
  identity: BigIntStats,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw sourceChanged();
  }
  signal?.throwIfAborted();
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(identity, current)) {
    throw sourceChanged();
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

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function invalidPath(message: string): LocalSupplementalMemoryCandidateError {
  return new LocalSupplementalMemoryCandidateError("invalid_path", message);
}

function sourceChanged(): LocalSupplementalMemoryCandidateError {
  return new LocalSupplementalMemoryCandidateError(
    "source_changed",
    "supplemental-memory candidate source changed during admission",
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
