import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import type { DelegationExecutorIdentity } from "../../domain/adaptation/delegation-evaluation.js";
import {
  type DelegationEvaluationCandidateIdentity,
  type DelegationEvaluationCandidateSource,
  MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES,
  type ProjectedDelegationEvaluationCandidate,
  parseDelegationEvaluationCandidateText,
  projectDelegationEvaluationCandidate,
} from "../../domain/adaptation/delegation-evaluation-candidate.js";
import {
  type CapabilityPackageSnapshot,
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import { compileWorkflowText, parseWorkflowSourceText } from "../../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { WorkflowSource } from "../../domain/workflow/schema.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";

const MAX_LOCAL_WORKFLOW_BYTES = 1_048_576;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface DelegationExecutorAdmission {
  readonly identity: DelegationExecutorIdentity;
  assertCurrent(): Promise<void>;
}

export interface AdmittedLocalDelegationEvaluationCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: DelegationEvaluationCandidateSource;
  readonly provenance: string;
  readonly sourceSha256: string;
  readonly identity: DelegationEvaluationCandidateIdentity;
  readonly baseline: AdmittedDelegationWorkflow;
  readonly child: AdmittedDelegationWorkflow;
  readonly packages: readonly CapabilityPackageSnapshot[];
  readonly baselineCapabilitySnapshot?: CapabilitySnapshot;
  readonly candidateCapabilitySnapshot: CapabilitySnapshot;
  readonly snapshot: ProjectedDelegationEvaluationCandidate["snapshot"];
  assertExecutorCurrent(): Promise<void>;
}

interface AdmittedDelegationWorkflow {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: WorkflowSource;
  readonly provenance: string;
  readonly sourceSha256: string;
  readonly compiled: CompiledWorkflow;
  readonly workflowDigest: string;
}

export interface LocalDelegationEvaluationCandidateOptions {
  readonly packages?: readonly CapabilityPackageSnapshot[];
  readonly resolvePackages?: (
    source: DelegationEvaluationCandidateSource,
  ) => Promise<readonly CapabilityPackageSnapshot[]>;
  readonly resolveExecutor: (
    source: DelegationEvaluationCandidateSource,
  ) => Promise<DelegationExecutorAdmission>;
  readonly signal?: AbortSignal;
  /** @internal Exact source identity captured by the generic candidate discriminator. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string };
  /** @internal Deterministic source-race and cancellation seams. */
  readonly afterCandidateRead?: () => void | Promise<void>;
  readonly afterBaselineRead?: () => void | Promise<void>;
  readonly afterChildRead?: () => void | Promise<void>;
  readonly beforeReturn?: () => void | Promise<void>;
}

export type LocalDelegationEvaluationCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalDelegationEvaluationCandidateError extends Error {
  override readonly name = "LocalDelegationEvaluationCandidateError";

  constructor(
    readonly code: LocalDelegationEvaluationCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function admitLocalDelegationEvaluationCandidate(
  candidatePath: string,
  options: LocalDelegationEvaluationCandidateOptions,
): Promise<AdmittedLocalDelegationEvaluationCandidate> {
  options.signal?.throwIfAborted();
  const absoluteCandidatePath = resolve(candidatePath);
  const root = dirname(absoluteCandidatePath);
  const candidateDirectories = await observeLexicalDirectories(root, options.signal);
  const candidateFile = await stableReadFile(
    absoluteCandidatePath,
    MAX_DELEGATION_EVALUATION_CANDIDATE_BYTES,
    "candidate",
    options.signal,
    options.expectedSource,
  );
  await options.afterCandidateRead?.();
  options.signal?.throwIfAborted();
  const sourceText = decodeUtf8(candidateFile.content, "candidate");
  let source: DelegationEvaluationCandidateSource;
  try {
    source = parseDelegationEvaluationCandidateText(sourceText, basename(absoluteCandidatePath));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { readonly code?: string }).code === "limit_exceeded"
    ) {
      throw limitExceeded("candidate");
    }
    throw invalidSource();
  }
  if (options.packages !== undefined && options.resolvePackages !== undefined) {
    throw invalidSource();
  }

  const packages = await resolvePackageClosure(source, options);
  const executor = await resolveExecutor(source, options);
  const baselinePath = join(root, source.baseline.workflow.path);
  const childPath = join(root, source.delegation.child.path);
  if (
    new Set([absoluteCandidatePath, baselinePath, childPath]).size !== 3 ||
    dirname(baselinePath) === baselinePath ||
    dirname(childPath) === childPath
  ) {
    throw invalidPath("candidate");
  }

  const baselineDirectories = await observeLexicalDirectories(
    dirname(baselinePath),
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
  const childDirectories = await observeLexicalDirectories(dirname(childPath), options.signal);
  const childFile = await stableReadFile(
    childPath,
    MAX_LOCAL_WORKFLOW_BYTES,
    "child",
    options.signal,
  );
  await options.afterChildRead?.();
  options.signal?.throwIfAborted();

  const baseline = compileLocalWorkflow(baselinePath, source.baseline.workflow.path, baselineFile);
  const child = compileLocalWorkflow(childPath, source.delegation.child.path, childFile);
  let projected: ProjectedDelegationEvaluationCandidate;
  try {
    projected = projectDelegationEvaluationCandidate({
      manifestProvenance: basename(absoluteCandidatePath),
      sourceSha256: candidateFile.sha256,
      source,
      baseline: {
        provenance: baseline.provenance,
        sourceText: baseline.sourceText,
        sourceSha256: baseline.sourceSha256,
        source: baseline.source,
        compiled: baseline.compiled,
        packages,
      },
      child: {
        provenance: child.provenance,
        sourceText: child.sourceText,
        sourceSha256: child.sourceSha256,
        source: child.source,
        compiled: child.compiled,
      },
      executor: executor.identity,
    });
  } catch {
    throw invalidSource();
  }

  const baselineCapabilitySnapshot =
    packages.length === 0
      ? undefined
      : validateCapabilitySnapshot({
          version: 1,
          packages,
          digest: calculateCapabilitySnapshotDigest(packages),
        });
  const candidateCapabilitySnapshot = validateCapabilitySnapshot({
    version: 1,
    packages,
    delegation: projected.snapshot,
    digest: calculateCapabilitySnapshotDigest(
      packages,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      projected.snapshot,
    ),
  });

  await options.beforeReturn?.();
  options.signal?.throwIfAborted();
  await revalidateLexicalDirectories(
    uniqueDirectoryObservations([
      ...candidateDirectories,
      ...baselineDirectories,
      ...childDirectories,
    ]),
    options.signal,
  );
  await revalidateFile(absoluteCandidatePath, candidateFile.identity, "candidate", options.signal);
  await revalidateFile(baselinePath, baselineFile.identity, "baseline", options.signal);
  await revalidateFile(childPath, childFile.identity, "child", options.signal);
  try {
    await executor.assertCurrent();
  } catch {
    options.signal?.throwIfAborted();
    throw invalidSource();
  }
  options.signal?.throwIfAborted();

  return deepFreeze({
    sourcePath: absoluteCandidatePath,
    sourceText,
    source,
    provenance: basename(absoluteCandidatePath),
    sourceSha256: candidateFile.sha256,
    identity: projected.identity,
    baseline,
    child,
    packages,
    ...(baselineCapabilitySnapshot === undefined ? {} : { baselineCapabilitySnapshot }),
    candidateCapabilitySnapshot,
    snapshot: projected.snapshot,
    assertExecutorCurrent: async () => {
      await executor.assertCurrent();
    },
  });
}

async function resolvePackageClosure(
  source: DelegationEvaluationCandidateSource,
  options: LocalDelegationEvaluationCandidateOptions,
): Promise<readonly CapabilityPackageSnapshot[]> {
  options.signal?.throwIfAborted();
  if (options.packages !== undefined) return options.packages;
  if (options.resolvePackages === undefined) throw invalidSource();
  try {
    const packages = await options.resolvePackages(source);
    options.signal?.throwIfAborted();
    return packages;
  } catch {
    options.signal?.throwIfAborted();
    throw invalidSource();
  }
}

async function resolveExecutor(
  source: DelegationEvaluationCandidateSource,
  options: LocalDelegationEvaluationCandidateOptions,
): Promise<DelegationExecutorAdmission> {
  options.signal?.throwIfAborted();
  try {
    const executor = await options.resolveExecutor(source);
    options.signal?.throwIfAborted();
    return executor;
  } catch {
    options.signal?.throwIfAborted();
    throw invalidSource();
  }
}

function compileLocalWorkflow(
  sourcePath: string,
  provenance: string,
  file: StableFile,
): AdmittedDelegationWorkflow {
  const sourceText = decodeUtf8(file.content, "workflow");
  try {
    const source = parseWorkflowSourceText(sourceText, provenance);
    const compiled = compileWorkflowText(sourceText, provenance);
    return deepFreeze({
      sourcePath,
      sourceText,
      source,
      provenance,
      sourceSha256: file.sha256,
      compiled,
      workflowDigest: calculateWorkflowDigest(compiled),
    });
  } catch {
    throw invalidSource();
  }
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

type SourceLabel = "baseline" | "candidate" | "child";

async function stableReadFile(
  path: string,
  maxBytes: number,
  label: SourceLabel,
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
  label: SourceLabel,
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
      throw invalidPath("candidate");
    }
    signal?.throwIfAborted();
    if (identity.isSymbolicLink() || !identity.isDirectory()) throw invalidPath("candidate");
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
  label: SourceLabel,
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

function decodeUtf8(content: Buffer, label: SourceLabel | "workflow"): string {
  try {
    return fatalUtf8Decoder.decode(content);
  } catch {
    throw new LocalDelegationEvaluationCandidateError(
      "invalid_source",
      `delegation ${label} is not valid UTF-8`,
    );
  }
}

function invalidPath(label: SourceLabel) {
  return new LocalDelegationEvaluationCandidateError(
    "invalid_path",
    `delegation ${label} is not an admitted regular file without links`,
  );
}

function invalidSource() {
  return new LocalDelegationEvaluationCandidateError(
    "invalid_source",
    "delegation evaluation candidate source is invalid",
  );
}

function limitExceeded(label: SourceLabel) {
  return new LocalDelegationEvaluationCandidateError(
    "limit_exceeded",
    `delegation ${label} exceeds its byte limit`,
  );
}

function sourceChanged(label: SourceLabel) {
  return new LocalDelegationEvaluationCandidateError(
    "source_changed",
    `delegation ${label} changed during admission`,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
