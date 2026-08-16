import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  MAX_PROMPT_CANDIDATE_BYTES,
  type PromptCandidateIdentity,
  type PromptCandidateSource,
  parsePromptCandidateText,
  projectPromptCandidate,
} from "../../domain/adaptation/prompt-candidate.js";
import {
  MAX_TUNING_EVIDENCE_BYTES,
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../../domain/evaluation/tuning-evidence.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import { compileWorkflowText, parseWorkflowSourceText } from "../../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { WorkflowSource } from "../../domain/workflow/schema.js";
import type { CompiledWorkflow } from "../../domain/workflow/types.js";

const MAX_LOCAL_WORKFLOW_BYTES = 1_048_576;

export type LocalPromptCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalPromptCandidateError extends Error {
  override readonly name = "LocalPromptCandidateError";

  constructor(
    readonly code: LocalPromptCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export interface AdmittedLocalPromptCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: PromptCandidateSource;
  readonly identity: PromptCandidateIdentity;
  readonly baseline: {
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly source: WorkflowSource;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly evidence: readonly {
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly workflow: {
    readonly source: string;
    readonly sourceSha256: string;
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
}

interface StableFile {
  readonly content: Buffer;
  readonly sha256: string;
}

interface PathObservation {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface AdmittedFilePath {
  readonly path: string;
  readonly observations: readonly PathObservation[];
}

export interface LocalPromptCandidateAdmissionOptions {
  readonly signal?: AbortSignal;
  readonly afterPathValidation?: (provenance: string) => Promise<void> | void;
  /** @internal Binds neutral candidate dispatch to this exact source. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string };
}

export interface AdmittedLocalPromptCandidateGenerationSources {
  readonly outputPath: string;
  readonly root: string;
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
  readonly revalidate: () => Promise<void>;
}

export async function admitLocalPromptCandidateGenerationSources(
  outputPath: string,
  baselinePath: string,
  evidencePaths: readonly string[],
  options: LocalPromptCandidateAdmissionOptions = {},
): Promise<AdmittedLocalPromptCandidateGenerationSources> {
  options.signal?.throwIfAborted();
  if (evidencePaths.length === 0 || evidencePaths.length > 16) {
    throw new LocalPromptCandidateError(
      "limit_exceeded",
      "prompt candidate generation requires between 1 and 16 evidence files",
    );
  }
  const absoluteOutputPath = resolve(outputPath);
  const lexicalRoot = dirname(absoluteOutputPath);
  const lexicalRootObservations = await observeDirectoryAncestry(
    lexicalRoot,
    "prompt candidate generation root",
    options.signal,
  );
  const lexicalRootObservation = requiredDirectoryObservation(lexicalRootObservations);
  options.signal?.throwIfAborted();
  let root: string;
  try {
    root = await realpath(lexicalRoot);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new LocalPromptCandidateError(
      "invalid_source",
      "prompt candidate generation root cannot be resolved",
      { cause: error },
    );
  }
  options.signal?.throwIfAborted();
  const rootObservation = await observeDirectory(
    root,
    "prompt candidate generation root",
    options.signal,
  );
  options.signal?.throwIfAborted();
  if (!sameDirectoryIdentity(lexicalRootObservation, rootObservation)) {
    throw new LocalPromptCandidateError("source_changed", "candidate generation root changed");
  }
  const canonicalOutputPath = join(root, basename(absoluteOutputPath));
  const baselineProvenance = sourceProvenance(lexicalRoot, root, baselinePath, "baseline workflow");
  const baselineAdmission = await resolveAdmittedFile(root, rootObservation, baselineProvenance);
  options.signal?.throwIfAborted();
  await options.afterPathValidation?.(baselineProvenance);
  options.signal?.throwIfAborted();
  const baselineFile = await stableReadFile(
    baselineAdmission.path,
    MAX_LOCAL_WORKFLOW_BYTES,
    "candidate baseline workflow",
    requiredFinalObservation(baselineAdmission),
  );
  options.signal?.throwIfAborted();
  await revalidatePathObservations(baselineAdmission.observations);
  options.signal?.throwIfAborted();
  const baselineText = decodeUtf8(baselineFile.content, "candidate baseline workflow");
  const baselineSource = parseWorkflowSourceText(baselineText, baselineProvenance);
  const baselineCompiled = compileWorkflowText(baselineText, baselineProvenance);
  options.signal?.throwIfAborted();

  const evidenceAdmissions = await Promise.all(
    evidencePaths.map(async (evidencePath) => {
      options.signal?.throwIfAborted();
      const provenance = sourceProvenance(lexicalRoot, root, evidencePath, "tuning evidence");
      const admission = await resolveAdmittedFile(root, rootObservation, provenance);
      options.signal?.throwIfAborted();
      await options.afterPathValidation?.(provenance);
      options.signal?.throwIfAborted();
      const file = await stableReadFile(
        admission.path,
        MAX_TUNING_EVIDENCE_BYTES,
        `candidate evidence "${provenance}"`,
        requiredFinalObservation(admission),
      );
      options.signal?.throwIfAborted();
      await revalidatePathObservations(admission.observations);
      options.signal?.throwIfAborted();
      const sourceText = decodeUtf8(file.content, `candidate evidence "${provenance}"`);
      let raw: unknown;
      try {
        raw = parseStrictJson(sourceText, {
          maxDepth: 32,
          maxNodes: 131_072,
          valueLabel: `candidate evidence "${provenance}"`,
        });
      } catch (error) {
        throw new LocalPromptCandidateError(
          "invalid_source",
          `candidate evidence "${provenance}" is invalid: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      options.signal?.throwIfAborted();
      return {
        provenance,
        admission,
        sourcePath: admission.path,
        sourceText,
        sourceSha256: file.sha256,
        packet: parseTuningEvidencePacket(raw),
      };
    }),
  );
  options.signal?.throwIfAborted();
  if (
    new Set(evidenceAdmissions.map((item) => item.provenance)).size !== evidenceAdmissions.length
  ) {
    throw new LocalPromptCandidateError(
      "invalid_path",
      "prompt candidate generation evidence paths must be unique",
    );
  }
  const observations = [
    ...lexicalRootObservations,
    { path: root, identity: rootObservation },
    ...baselineAdmission.observations,
    ...evidenceAdmissions.flatMap((item) => item.admission.observations),
  ];
  const revalidate = async () => {
    options.signal?.throwIfAborted();
    await revalidatePathObservations(observations);
    options.signal?.throwIfAborted();
  };
  await revalidate();
  return deepFreeze({
    outputPath: canonicalOutputPath,
    root,
    baseline: {
      provenance: baselineProvenance,
      sourcePath: baselineAdmission.path,
      sourceText: baselineText,
      sourceSha256: baselineFile.sha256,
      source: baselineSource,
      compiled: baselineCompiled,
      workflowDigest: calculateWorkflowDigest(baselineCompiled),
    },
    evidence: evidenceAdmissions.map(({ admission: _admission, ...item }) => item),
    revalidate,
  });
}

export async function admitLocalPromptCandidate(
  candidatePath: string,
  options: LocalPromptCandidateAdmissionOptions = {},
): Promise<AdmittedLocalPromptCandidate> {
  options.signal?.throwIfAborted();
  const absoluteCandidatePath = resolve(candidatePath);
  const candidateRoot = await realpath(dirname(absoluteCandidatePath));
  options.signal?.throwIfAborted();
  const candidateRootObservation = await observeDirectory(candidateRoot, "prompt candidate root");
  const canonicalCandidatePath = join(candidateRoot, basename(absoluteCandidatePath));
  const candidateObservation = await observeRegularFile(canonicalCandidatePath, "prompt candidate");
  await options.afterPathValidation?.(basename(canonicalCandidatePath));
  options.signal?.throwIfAborted();
  if (
    options.expectedSource !== undefined &&
    !sameFileIdentity(options.expectedSource.identity, candidateObservation)
  ) {
    throw new LocalPromptCandidateError(
      "source_changed",
      "prompt candidate changed after kind discrimination",
    );
  }
  const candidateFile = await stableReadFile(
    canonicalCandidatePath,
    MAX_PROMPT_CANDIDATE_BYTES,
    "prompt candidate",
    candidateObservation,
  );
  options.signal?.throwIfAborted();
  if (
    options.expectedSource !== undefined &&
    options.expectedSource.sha256 !== candidateFile.sha256
  ) {
    throw new LocalPromptCandidateError(
      "source_changed",
      "prompt candidate changed after kind discrimination",
    );
  }
  await revalidatePathObservations([
    { path: candidateRoot, identity: candidateRootObservation },
    { path: canonicalCandidatePath, identity: candidateObservation },
  ]);
  const candidateText = decodeUtf8(candidateFile.content, "prompt candidate");
  const source = parsePromptCandidateText(candidateText, basename(candidatePath));

  const baselineAdmission = await resolveAdmittedFile(
    candidateRoot,
    candidateRootObservation,
    source.baseline.workflow,
  );
  await options.afterPathValidation?.(source.baseline.workflow);
  options.signal?.throwIfAborted();
  const baselineFile = await stableReadFile(
    baselineAdmission.path,
    MAX_LOCAL_WORKFLOW_BYTES,
    "candidate baseline workflow",
    requiredFinalObservation(baselineAdmission),
  );
  options.signal?.throwIfAborted();
  await revalidatePathObservations(baselineAdmission.observations);
  const baselineText = decodeUtf8(baselineFile.content, "candidate baseline workflow");
  const baselineSource = parseWorkflowSourceText(baselineText, source.baseline.workflow);
  const baselineCompiled = compileWorkflowText(baselineText, source.baseline.workflow);

  const evidence = await Promise.all(
    source.evidence.map(async (declared) => {
      options.signal?.throwIfAborted();
      const admission = await resolveAdmittedFile(
        candidateRoot,
        candidateRootObservation,
        declared.path,
      );
      await options.afterPathValidation?.(declared.path);
      options.signal?.throwIfAborted();
      const file = await stableReadFile(
        admission.path,
        MAX_TUNING_EVIDENCE_BYTES,
        `candidate evidence "${declared.path}"`,
        requiredFinalObservation(admission),
      );
      options.signal?.throwIfAborted();
      await revalidatePathObservations(admission.observations);
      const sourceText = decodeUtf8(file.content, `candidate evidence "${declared.path}"`);
      let raw: unknown;
      try {
        raw = parseStrictJson(sourceText, {
          maxDepth: 32,
          maxNodes: 131_072,
          valueLabel: `candidate evidence "${declared.path}"`,
        });
      } catch (error) {
        throw new LocalPromptCandidateError(
          "invalid_source",
          `candidate evidence "${declared.path}" is invalid: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      return Object.freeze({
        sourcePath: admission.path,
        sourceText,
        sourceSha256: file.sha256,
        packet: parseTuningEvidencePacket(raw),
      });
    }),
  );

  options.signal?.throwIfAborted();

  const projected = projectPromptCandidate({
    manifestProvenance: basename(canonicalCandidatePath),
    source,
    sourceSha256: candidateFile.sha256,
    baseline: {
      provenance: source.baseline.workflow,
      source: baselineSource,
      sourceSha256: baselineFile.sha256,
      compiled: baselineCompiled,
    },
    evidence: evidence.map((item, index) => ({
      provenance: source.evidence[index]?.path ?? "",
      sourceSha256: item.sourceSha256,
      packet: item.packet,
    })),
  });
  options.signal?.throwIfAborted();
  return deepFreeze({
    sourcePath: canonicalCandidatePath,
    sourceText: candidateText,
    source,
    identity: projected.identity,
    baseline: {
      sourcePath: baselineAdmission.path,
      sourceText: baselineText,
      source: baselineSource,
      sourceSha256: baselineFile.sha256,
      compiled: baselineCompiled,
      workflowDigest: calculateWorkflowDigest(baselineCompiled),
    },
    evidence,
    workflow: projected.workflow,
  });
}

async function resolveAdmittedFile(
  root: string,
  expectedRoot: BigIntStats,
  provenance: string,
): Promise<AdmittedFilePath> {
  const candidate = resolve(root, provenance);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new LocalPromptCandidateError(
      "invalid_path",
      `path "${provenance}" escapes or aliases the candidate root`,
    );
  }
  let current = root;
  const segments = provenance.split("/");
  let observedRoot: BigIntStats;
  try {
    observedRoot = await lstat(root, { bigint: true });
  } catch (error) {
    throw new LocalPromptCandidateError(
      "source_changed",
      `candidate root changed before path "${provenance}" was admitted`,
      { cause: error },
    );
  }
  if (
    observedRoot.isSymbolicLink() ||
    !observedRoot.isDirectory() ||
    !sameFileIdentity(expectedRoot, observedRoot)
  ) {
    throw new LocalPromptCandidateError(
      "source_changed",
      `candidate root changed before path "${provenance}" was admitted`,
    );
  }
  const observations: PathObservation[] = [{ path: root, identity: observedRoot }];
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let entry: BigIntStats;
    try {
      entry = await lstat(current, { bigint: true });
    } catch (error) {
      throw new LocalPromptCandidateError(
        "invalid_source",
        `path "${provenance}" cannot be admitted: ${boundedMessage(error)}`,
        { cause: error },
      );
    }
    if (entry.isSymbolicLink()) {
      throw new LocalPromptCandidateError(
        "invalid_path",
        `path "${provenance}" contains a symbolic link`,
      );
    }
    if (index < segments.length - 1 && !entry.isDirectory()) {
      throw new LocalPromptCandidateError(
        "invalid_source",
        `path "${provenance}" contains a non-directory ancestor`,
      );
    }
    observations.push({ path: current, identity: entry });
  }
  const final = observations.at(-1)?.identity;
  if (final === undefined) {
    throw new LocalPromptCandidateError("invalid_path", `path "${provenance}" is empty`);
  }
  if (!final.isFile()) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `path "${provenance}" is not a regular file`,
    );
  }
  return { path: candidate, observations: Object.freeze(observations) };
}

function sourceProvenance(
  lexicalRoot: string,
  canonicalRoot: string,
  sourcePath: string,
  label: string,
): string {
  const absolute = resolve(sourcePath);
  const fromLexicalRoot = relative(lexicalRoot, absolute);
  const fromCanonicalRoot = relative(canonicalRoot, absolute);
  const fromRoot = pathIsWithinRoot(fromLexicalRoot)
    ? fromLexicalRoot
    : pathIsWithinRoot(fromCanonicalRoot)
      ? fromCanonicalRoot
      : undefined;
  if (fromRoot === undefined) {
    throw new LocalPromptCandidateError(
      "invalid_path",
      `${label} path "${sourcePath}" escapes or aliases the candidate root`,
    );
  }
  return fromRoot.split(sep).join("/");
}

function pathIsWithinRoot(value: string): boolean {
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

async function stableReadFile(
  path: string,
  maxBytes: number,
  label: string,
  expected: BigIntStats,
): Promise<StableFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} cannot be opened without following links: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileIdentity(expected, before)) {
      throw new LocalPromptCandidateError(
        "source_changed",
        `${label} changed identity before it was opened`,
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw new LocalPromptCandidateError("limit_exceeded", `${label} exceeds ${maxBytes} bytes`);
    }
    const content = await readFileBounded(handle, maxBytes, label);
    const after = await handle.stat({ bigint: true });
    if (BigInt(content.byteLength) !== before.size || !sameFileIdentity(before, after)) {
      throw new LocalPromptCandidateError("source_changed", `${label} changed while it was read`);
    }
    return Object.freeze({
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function readFileBounded(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > maxBytes) {
    throw new LocalPromptCandidateError("limit_exceeded", `${label} exceeds ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function observeRegularFile(path: string, label: string): Promise<BigIntStats> {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} cannot be observed: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} must be a direct regular file without symbolic links`,
    );
  }
  return entry;
}

async function observeDirectory(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<BigIntStats> {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} cannot be observed: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  signal?.throwIfAborted();
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} must be a direct directory without symbolic links`,
    );
  }
  return entry;
}

async function observeDirectoryAncestry(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<PathObservation[]> {
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
    const identity = await observeDirectory(current, label, signal);
    observations.push({ path: current, identity });
  }
  return observations;
}

function requiredDirectoryObservation(observations: readonly PathObservation[]): BigIntStats {
  const identity = observations.at(-1)?.identity;
  if (identity === undefined) {
    throw new LocalPromptCandidateError(
      "invalid_path",
      "prompt candidate generation root observation is incomplete",
    );
  }
  return identity;
}

async function revalidatePathObservations(observations: readonly PathObservation[]): Promise<void> {
  for (const observation of observations) {
    let current: BigIntStats;
    try {
      current = await lstat(observation.path, { bigint: true });
    } catch (error) {
      throw new LocalPromptCandidateError(
        "source_changed",
        `candidate path "${observation.path}" changed after it was read`,
        { cause: error },
      );
    }
    const identityMatches = observation.identity.isDirectory()
      ? sameDirectoryIdentity(observation.identity, current)
      : sameFileIdentity(observation.identity, current);
    if (current.isSymbolicLink() || !identityMatches) {
      throw new LocalPromptCandidateError(
        "source_changed",
        `candidate path "${observation.path}" changed after it was validated`,
      );
    }
  }
}

function requiredFinalObservation(admission: AdmittedFilePath): BigIntStats {
  const final = admission.observations.at(-1)?.identity;
  if (final === undefined) {
    throw new LocalPromptCandidateError("invalid_path", "candidate file observation is incomplete");
  }
  return final;
}

function decodeUtf8(content: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new LocalPromptCandidateError("invalid_source", `${label} is not valid UTF-8`, {
      cause: error,
    });
  }
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    !left.isSymbolicLink() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
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

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return value;
}
