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
  type SupplementalMemoryCandidateIdentity,
  type SupplementalMemoryCandidateSource,
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
} from "../../domain/adaptation/supplemental-memory-candidate.js";

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

export interface LocalSupplementalMemoryCandidateOptions {
  readonly signal?: AbortSignal | undefined;
  readonly resolveBaseline: (
    source: SupplementalMemoryCandidateSource,
  ) => Promise<EffectiveHarnessState>;
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
  try {
    projected = projectSupplementalMemoryCandidate({
      manifestProvenance: basename(absolutePath),
      sourceSha256: file.sha256,
      source,
      baseline,
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
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes <= MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES + 1 - bytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    bytes += bytesRead;
  }
  if (bytes > MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES) {
    throw new LocalSupplementalMemoryCandidateError(
      "limit_exceeded",
      "supplemental-memory candidate source exceeds its byte limit",
    );
  }
  return Buffer.concat(chunks, bytes);
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
      !sameIdentity(observation.identity, current)
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

function invalidPath(message: string): LocalSupplementalMemoryCandidateError {
  return new LocalSupplementalMemoryCandidateError("invalid_path", message);
}

function sourceChanged(): LocalSupplementalMemoryCandidateError {
  return new LocalSupplementalMemoryCandidateError(
    "source_changed",
    "supplemental-memory candidate source changed during admission",
  );
}
