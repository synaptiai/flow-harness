import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
  readonly afterPathValidation?: (provenance: string) => Promise<void> | void;
}

export async function admitLocalPromptCandidate(
  candidatePath: string,
  options: LocalPromptCandidateAdmissionOptions = {},
): Promise<AdmittedLocalPromptCandidate> {
  const absoluteCandidatePath = resolve(candidatePath);
  const candidateRoot = await realpath(dirname(absoluteCandidatePath));
  const candidateRootObservation = await observeDirectory(candidateRoot, "prompt candidate root");
  const canonicalCandidatePath = join(candidateRoot, basename(absoluteCandidatePath));
  const candidateObservation = await observeRegularFile(canonicalCandidatePath, "prompt candidate");
  await options.afterPathValidation?.(basename(canonicalCandidatePath));
  const candidateFile = await stableReadFile(
    canonicalCandidatePath,
    MAX_PROMPT_CANDIDATE_BYTES,
    "prompt candidate",
    candidateObservation,
  );
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
  const baselineFile = await stableReadFile(
    baselineAdmission.path,
    MAX_LOCAL_WORKFLOW_BYTES,
    "candidate baseline workflow",
    requiredFinalObservation(baselineAdmission),
  );
  await revalidatePathObservations(baselineAdmission.observations);
  const baselineText = decodeUtf8(baselineFile.content, "candidate baseline workflow");
  const baselineSource = parseWorkflowSourceText(baselineText, source.baseline.workflow);
  const baselineCompiled = compileWorkflowText(baselineText, source.baseline.workflow);

  const evidence = await Promise.all(
    source.evidence.map(async (declared) => {
      const admission = await resolveAdmittedFile(
        candidateRoot,
        candidateRootObservation,
        declared.path,
      );
      await options.afterPathValidation?.(declared.path);
      const file = await stableReadFile(
        admission.path,
        MAX_TUNING_EVIDENCE_BYTES,
        `candidate evidence "${declared.path}"`,
        requiredFinalObservation(admission),
      );
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
    const content = await handle.readFile();
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

async function observeDirectory(path: string, label: string): Promise<BigIntStats> {
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
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new LocalPromptCandidateError(
      "invalid_source",
      `${label} must be a direct directory without symbolic links`,
    );
  }
  return entry;
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
    if (current.isSymbolicLink() || !sameFileIdentity(observation.identity, current)) {
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
