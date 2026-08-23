import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  MAX_PHASE_ROUTING_CANDIDATE_BYTES,
  type PhaseRoutingCandidateIdentity,
  type PhaseRoutingCandidateSource,
  type ProjectedPhaseRoutingCandidate,
  parsePhaseRoutingCandidateText,
  projectPhaseRoutingCandidate,
} from "../../domain/adaptation/phase-routing-candidate.js";
import { compileWorkflowText, parseWorkflowSourceText } from "../../domain/workflow/compiler.js";
import type { WorkflowSource } from "../../domain/workflow/schema.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";

const MAX_LOCAL_WORKFLOW_BYTES = 1_048_576;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface AdmittedLocalPhaseRoutingCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: PhaseRoutingCandidateSource;
  readonly sourceSha256: string;
  readonly identity: PhaseRoutingCandidateIdentity;
  readonly baseline: {
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly source: WorkflowSource;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly workflows: ProjectedPhaseRoutingCandidate["workflows"];
}

export interface LocalPhaseRoutingCandidateOptions {
  readonly signal?: AbortSignal | undefined;
  /** @internal Exact source identity captured by the generic candidate discriminator. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string } | undefined;
  /** @internal Deterministic candidate source-race and cancellation seam. */
  readonly afterCandidateRead?: () => void | Promise<void>;
  /** @internal Deterministic baseline source-race and cancellation seam. */
  readonly afterBaselineRead?: () => void | Promise<void>;
  /** @internal Deterministic final revalidation seam. */
  readonly beforeReturn?: () => void | Promise<void>;
}

export type LocalPhaseRoutingCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalPhaseRoutingCandidateError extends Error {
  override readonly name = "LocalPhaseRoutingCandidateError";

  constructor(
    readonly code: LocalPhaseRoutingCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function admitLocalPhaseRoutingCandidate(
  candidatePath: string,
  options: LocalPhaseRoutingCandidateOptions = {},
): Promise<AdmittedLocalPhaseRoutingCandidate> {
  options.signal?.throwIfAborted();
  const absoluteCandidatePath = resolve(candidatePath);
  const root = dirname(absoluteCandidatePath);
  const candidateDirectories = await observeDirectories(root, "candidate", options.signal);
  const candidateFile = await stableReadFile(
    absoluteCandidatePath,
    MAX_PHASE_ROUTING_CANDIDATE_BYTES,
    "candidate",
    options.signal,
    options.expectedSource,
  );
  await options.afterCandidateRead?.();
  options.signal?.throwIfAborted();
  const sourceText = decodeUtf8(candidateFile.content, "candidate");
  let source: PhaseRoutingCandidateSource;
  try {
    source = parsePhaseRoutingCandidateText(sourceText, basename(absoluteCandidatePath));
  } catch {
    throw invalidSource("candidate", "source is invalid");
  }

  const baselinePath = join(root, source.baseline.workflow.path);
  const baselineDirectories = await observeDirectories(
    dirname(baselinePath),
    "baseline",
    options.signal,
  );
  const baselineFile = await stableReadFile(
    baselinePath,
    MAX_LOCAL_WORKFLOW_BYTES,
    "baseline",
    options.signal,
  );
  await options.afterBaselineRead?.();
  options.signal?.throwIfAborted();
  const baselineText = decodeUtf8(baselineFile.content, "baseline");
  let baselineSource: WorkflowSource;
  let baselineCompiled: CompiledWorkflow;
  try {
    baselineSource = parseWorkflowSourceText(baselineText, source.baseline.workflow.path);
    baselineCompiled = compileWorkflowText(baselineText, source.baseline.workflow.path);
  } catch {
    throw invalidSource("baseline", "is invalid");
  }

  let projected: ProjectedPhaseRoutingCandidate;
  try {
    projected = projectPhaseRoutingCandidate({
      manifestProvenance: basename(absoluteCandidatePath),
      sourceSha256: candidateFile.sha256,
      source,
      baseline: {
        provenance: source.baseline.workflow.path,
        sourceText: baselineText,
        sourceSha256: baselineFile.sha256,
        source: baselineSource,
        compiled: baselineCompiled,
      },
    });
  } catch {
    throw invalidSource("candidate", "projection is invalid");
  }
  await options.beforeReturn?.();
  options.signal?.throwIfAborted();
  await revalidateDirectories(
    uniqueDirectories([...candidateDirectories, ...baselineDirectories]),
    options.signal,
  );
  await revalidateFile(absoluteCandidatePath, candidateFile.identity, "candidate", options.signal);
  await revalidateFile(baselinePath, baselineFile.identity, "baseline", options.signal);

  return deepFreeze({
    sourcePath: absoluteCandidatePath,
    sourceText,
    source,
    sourceSha256: candidateFile.sha256,
    identity: projected.identity,
    baseline: {
      sourcePath: baselinePath,
      sourceText: baselineText,
      source: baselineSource,
      sourceSha256: baselineFile.sha256,
      compiled: baselineCompiled,
      workflowDigest: source.baseline.workflow.workflowDigest,
    },
    workflows: projected.workflows,
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

async function stableReadFile(
  path: string,
  maxBytes: number,
  label: "candidate" | "baseline",
  signal?: AbortSignal,
  expected?: { readonly identity: BigIntStats; readonly sha256: string },
): Promise<StableFile> {
  signal?.throwIfAborted();
  let lexical: BigIntStats;
  try {
    lexical = await lstat(path, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw invalidPath(label, "is unavailable");
  }
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw invalidPath(label, "must be a regular file without links");
  }
  if (expected !== undefined && !sameFileIdentity(expected.identity, lexical)) {
    throw sourceChanged(label);
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    signal?.throwIfAborted();
    throw invalidPath(label, "cannot be opened without links");
  }
  let settled: StableFile | undefined;
  let operationError: unknown;
  try {
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!before.isFile()) throw invalidPath(label, "is not a regular file");
    if (before.size > BigInt(maxBytes)) {
      throw new LocalPhaseRoutingCandidateError(
        "limit_exceeded",
        `phase-routing candidate ${label} exceeds its byte limit`,
      );
    }
    const content = await readBounded(handle, maxBytes, label, signal);
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (BigInt(content.byteLength) !== before.size || !sameFileIdentity(before, after)) {
      throw sourceChanged(label);
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (expected !== undefined && expected.sha256 !== sha256) throw sourceChanged(label);
    settled = { identity: before, content, sha256 };
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
  if (closeError !== undefined || settled === undefined) {
    throw invalidSource(label, "could not be settled");
  }
  await revalidateFile(path, settled.identity, label, signal);
  return settled;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  label: "candidate" | "baseline",
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    signal?.throwIfAborted();
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new LocalPhaseRoutingCandidateError(
      "limit_exceeded",
      `phase-routing candidate ${label} exceeds its byte limit`,
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

async function observeDirectories(
  path: string,
  label: "candidate" | "baseline",
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
      throw invalidPath(label, "ancestry is unavailable");
    }
    signal?.throwIfAborted();
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw invalidPath(label, "ancestry must contain only direct directories");
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
      throw new LocalPhaseRoutingCandidateError(
        "source_changed",
        "phase-routing candidate ancestry changed",
      );
    }
    signal?.throwIfAborted();
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== observation.identity.dev ||
      current.ino !== observation.identity.ino
    ) {
      throw new LocalPhaseRoutingCandidateError(
        "source_changed",
        "phase-routing candidate ancestry changed",
      );
    }
  }
}

async function revalidateFile(
  path: string,
  identity: BigIntStats,
  label: "candidate" | "baseline",
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let current: BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch {
    signal?.throwIfAborted();
    throw sourceChanged(label);
  }
  signal?.throwIfAborted();
  if (current.isSymbolicLink() || !sameFileIdentity(identity, current)) {
    throw sourceChanged(label);
  }
}

function uniqueDirectories(
  observations: readonly DirectoryObservation[],
): readonly DirectoryObservation[] {
  return [...new Map(observations.map((item) => [item.path, item])).values()];
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

function invalidPath(
  label: "candidate" | "baseline",
  detail: string,
): LocalPhaseRoutingCandidateError {
  return new LocalPhaseRoutingCandidateError(
    "invalid_path",
    `phase-routing candidate ${label} ${detail}`,
  );
}

function invalidSource(
  label: "candidate" | "baseline",
  detail: string,
): LocalPhaseRoutingCandidateError {
  return new LocalPhaseRoutingCandidateError(
    "invalid_source",
    `phase-routing candidate ${label} ${detail}`,
  );
}

function sourceChanged(label: "candidate" | "baseline"): LocalPhaseRoutingCandidateError {
  return new LocalPhaseRoutingCandidateError(
    "source_changed",
    `phase-routing candidate ${label} changed during admission`,
  );
}

function decodeUtf8(content: Buffer, label: "candidate" | "baseline"): string {
  try {
    return fatalUtf8Decoder.decode(content);
  } catch {
    throw invalidSource(label, "is not UTF-8");
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
