import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  MAX_CHILD_SPECIALIST_CANDIDATE_BYTES,
  type ChildSpecialistCandidateIdentity,
  type ChildSpecialistCandidateSource,
  type ProjectedChildSpecialistCandidate,
  parseChildSpecialistCandidateText,
  projectChildSpecialistCandidate,
} from "../../domain/adaptation/child-specialist-candidate.js";
import type { CapabilityPackageSnapshot } from "../../domain/capability/agent-skills.js";
import { compileWorkflowText, parseWorkflowSourceText } from "../../domain/workflow/compiler.js";
import type { WorkflowSource } from "../../domain/workflow/schema.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";

const MAX_LOCAL_WORKFLOW_BYTES = 1_048_576;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface AdmittedLocalChildSpecialistCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: ChildSpecialistCandidateSource;
  readonly provenance: string;
  readonly sourceSha256: string;
  readonly identity: ChildSpecialistCandidateIdentity;
  readonly baseline: {
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly source: WorkflowSource;
    readonly provenance: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly packages: readonly CapabilityPackageSnapshot[];
  readonly workflow: ProjectedChildSpecialistCandidate["workflow"];
}

export interface LocalChildSpecialistCandidateOptions {
  readonly packages?: readonly CapabilityPackageSnapshot[] | undefined;
  readonly resolvePackages?:
    | ((source: ChildSpecialistCandidateSource) => Promise<readonly CapabilityPackageSnapshot[]>)
    | undefined;
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

export type LocalChildSpecialistCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalChildSpecialistCandidateError extends Error {
  override readonly name = "LocalChildSpecialistCandidateError";

  constructor(
    readonly code: LocalChildSpecialistCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function admitLocalChildSpecialistCandidate(
  candidatePath: string,
  options: LocalChildSpecialistCandidateOptions,
): Promise<AdmittedLocalChildSpecialistCandidate> {
  options.signal?.throwIfAborted();
  const absoluteCandidatePath = resolve(candidatePath);
  const root = dirname(absoluteCandidatePath);
  const candidateDirectories = await observeLexicalDirectories(root, "candidate", options.signal);
  const candidateFile = await stableReadFile(
    absoluteCandidatePath,
    MAX_CHILD_SPECIALIST_CANDIDATE_BYTES,
    "candidate",
    options.signal,
    options.expectedSource,
  );
  await options.afterCandidateRead?.();
  options.signal?.throwIfAborted();
  const sourceText = decodeUtf8(candidateFile.content, "candidate");
  let source: ChildSpecialistCandidateSource;
  try {
    source = parseChildSpecialistCandidateText(sourceText, basename(absoluteCandidatePath));
  } catch {
    throw invalidSource();
  }
  if (options.packages !== undefined && options.resolvePackages !== undefined) {
    throw invalidSource();
  }
  options.signal?.throwIfAborted();
  let packages = options.packages;
  if (packages === undefined && options.resolvePackages !== undefined) {
    try {
      packages = await options.resolvePackages(source);
    } catch {
      options.signal?.throwIfAborted();
      throw invalidSource();
    }
  }
  options.signal?.throwIfAborted();
  if (packages === undefined) {
    throw invalidSource();
  }

  const baselinePath = join(root, source.baseline.workflow.path);
  const baselineDirectories = await observeLexicalDirectories(
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
    throw invalidSource();
  }

  let projected: ProjectedChildSpecialistCandidate;
  try {
    projected = projectChildSpecialistCandidate({
      manifestProvenance: basename(absoluteCandidatePath),
      sourceSha256: candidateFile.sha256,
      source,
      baseline: {
        provenance: source.baseline.workflow.path,
        sourceText: baselineText,
        sourceSha256: baselineFile.sha256,
        source: baselineSource,
        compiled: baselineCompiled,
        packages,
      },
    });
  } catch {
    throw invalidSource();
  }
  await options.beforeReturn?.();
  options.signal?.throwIfAborted();
  await revalidateLexicalDirectories(
    uniqueDirectoryObservations([...candidateDirectories, ...baselineDirectories]),
    options.signal,
  );
  await revalidateFile(absoluteCandidatePath, candidateFile.identity, "candidate", options.signal);
  await revalidateFile(baselinePath, baselineFile.identity, "baseline", options.signal);
  options.signal?.throwIfAborted();

  return deepFreeze({
    sourcePath: absoluteCandidatePath,
    sourceText,
    source,
    provenance: basename(absoluteCandidatePath),
    sourceSha256: candidateFile.sha256,
    identity: projected.identity,
    baseline: {
      sourcePath: baselinePath,
      sourceText: baselineText,
      source: baselineSource,
      provenance: source.baseline.workflow.path,
      sourceSha256: baselineFile.sha256,
      compiled: baselineCompiled,
      workflowDigest: source.baseline.workflow.workflowDigest,
    },
    packages,
    workflow: projected.workflow,
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
    throw invalidPath(label);
  }
  signal?.throwIfAborted();
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw invalidPath(label);
  if (expected !== undefined && !sameFileIdentity(expected.identity, lexical)) {
    throw sourceChanged(label);
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    signal?.throwIfAborted();
    throw invalidPath(label);
  }
  let result: StableFile | undefined;
  let operationError: unknown;
  try {
    const before = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!before.isFile()) throw invalidPath(label);
    if (before.size > BigInt(maxBytes)) throw limitExceeded(label);
    const content = await readBounded(handle, maxBytes, label, signal);
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (BigInt(content.byteLength) !== before.size || !sameFileIdentity(before, after)) {
      throw sourceChanged(label);
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (expected !== undefined && expected.sha256 !== sha256) throw sourceChanged(label);
    result = { identity: before, content, sha256 };
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
  if (closeError !== undefined || result === undefined) throw invalidSource();
  await revalidateFile(path, result.identity, label, signal);
  return result;
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
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) throw limitExceeded(label);
  return Buffer.concat(chunks, totalBytes);
}

async function observeLexicalDirectories(
  path: string,
  label: "candidate" | "baseline",
  signal?: AbortSignal,
): Promise<readonly DirectoryObservation[]> {
  signal?.throwIfAborted();
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
      throw invalidPath(label);
    }
    signal?.throwIfAborted();
    if (identity.isSymbolicLink() || !identity.isDirectory()) throw invalidPath(label);
    observations.push({ path: current, identity });
  }
  return observations;
}

async function revalidateLexicalDirectories(
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
      throw sourceChanged("candidate");
    }
    signal?.throwIfAborted();
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== observation.identity.dev ||
      current.ino !== observation.identity.ino
    ) {
      throw sourceChanged("candidate");
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

function uniqueDirectoryObservations(
  observations: readonly DirectoryObservation[],
): readonly DirectoryObservation[] {
  return [...new Map(observations.map((observation) => [observation.path, observation])).values()];
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

function decodeUtf8(content: Buffer, label: "candidate" | "baseline"): string {
  try {
    return fatalUtf8Decoder.decode(content);
  } catch {
    throw new LocalChildSpecialistCandidateError(
      "invalid_source",
      `child-specialist ${label} is not valid UTF-8`,
    );
  }
}

function invalidPath(label: "candidate" | "baseline") {
  return new LocalChildSpecialistCandidateError(
    "invalid_path",
    `child-specialist ${label} is not an admitted regular file without links`,
  );
}

function invalidSource() {
  return new LocalChildSpecialistCandidateError(
    "invalid_source",
    "child-specialist candidate source is invalid",
  );
}

function limitExceeded(label: "candidate" | "baseline") {
  return new LocalChildSpecialistCandidateError(
    "limit_exceeded",
    `child-specialist ${label} exceeds its byte limit`,
  );
}

function sourceChanged(label: "candidate" | "baseline") {
  return new LocalChildSpecialistCandidateError(
    "source_changed",
    `child-specialist ${label} changed during admission`,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
