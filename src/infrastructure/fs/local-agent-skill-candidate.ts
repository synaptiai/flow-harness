import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  type AgentSkillCandidateErrorCode,
  type AgentSkillCandidateIdentity,
  type AgentSkillCandidateSource,
  MAX_AGENT_SKILL_CANDIDATE_BYTES,
  parseAgentSkillCandidateText,
  projectAgentSkillCandidate,
} from "../../domain/adaptation/agent-skill-candidate.js";
import type {
  AgentSkillCapabilitySnapshot,
  AgentSkillPackageSnapshot,
} from "../../domain/capability/agent-skills.js";
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
import {
  AgentSkillCatalogError,
  snapshotProjectAgentSkillPath,
} from "./local-agent-skill-catalog.js";

const MAX_LOCAL_WORKFLOW_BYTES = 8 * 1024 * 1024;

export type LocalAgentSkillCandidateErrorCode =
  | AgentSkillCandidateErrorCode
  | "invalid_path"
  | "invalid_source"
  | "source_changed";

export class LocalAgentSkillCandidateError extends Error {
  override readonly name = "LocalAgentSkillCandidateError";

  constructor(
    readonly code: LocalAgentSkillCandidateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${boundedText(message, 8_192)}`, options);
  }
}

export interface LocalAgentSkillCandidateAdmissionOptions {
  readonly signal?: AbortSignal;
  /** @internal Deterministic race and cancellation seam. */
  readonly afterPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic ancestor-observation cancellation seam. */
  readonly afterCandidateAncestorObservation?: (isCandidateRoot: boolean) => void | Promise<void>;
  /** @internal Deterministic selected-package entry race and cancellation seam. */
  readonly afterSkillEntryObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic selected-package revalidation cancellation seam. */
  readonly afterSkillRevalidationObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic selected-package directory cancellation seam. */
  readonly afterSkillDirectoryBoundary?: (
    provenance: string,
    phase: "entries" | "stat",
  ) => void | Promise<void>;
  /** @internal Deterministic selected-package file cancellation seam. */
  readonly afterSkillFileBoundary?: (
    provenance: string,
    phase: "open" | "stat" | "close",
  ) => void | Promise<void>;
  /** @internal Proves cancellation prevents post-capture package processing. */
  readonly afterSkillPackageCapture?: () => void | Promise<void>;
  /** @internal Binds neutral candidate dispatch to this exact source. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string };
}

export interface AdmittedLocalAgentSkillCandidate {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: AgentSkillCandidateSource;
  readonly identity: AgentSkillCandidateIdentity;
  readonly baseline: {
    readonly workflow: {
      readonly sourcePath: string;
      readonly sourceText: string;
      readonly source: WorkflowSource;
      readonly sourceSha256: string;
      readonly compiled: CompiledWorkflow;
      readonly workflowDigest: string;
    };
    readonly skill: AgentSkillPackageSnapshot;
  };
  readonly evidence: readonly {
    readonly sourcePath: string;
    readonly sourceText: string;
    readonly sourceSha256: string;
    readonly packet: TuningEvidencePacket;
  }[];
  readonly workflow: {
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly baselineCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  readonly candidateCapabilitySnapshot: AgentSkillCapabilitySnapshot;
}

interface PathObservation {
  readonly path: string;
  readonly identity: BigIntStats;
}

interface AdmittedFilePath {
  readonly path: string;
  readonly observations: readonly PathObservation[];
}

interface StableFile {
  readonly content: Buffer;
  readonly sha256: string;
}

export async function admitLocalAgentSkillCandidate(
  candidatePath: string,
  options: LocalAgentSkillCandidateAdmissionOptions = {},
): Promise<AdmittedLocalAgentSkillCandidate> {
  assertActive(options.signal);
  const absoluteCandidatePath = resolve(candidatePath);
  const candidateRoot = dirname(absoluteCandidatePath);
  const rootPathObservations = await observeLexicalDirectories(
    candidateRoot,
    options.signal,
    options.afterCandidateAncestorObservation,
  );
  const rootObservation = requiredRootObservation(rootPathObservations);
  const canonicalCandidatePath = join(candidateRoot, basename(absoluteCandidatePath));
  const candidateObservation = await observeRegularFile(canonicalCandidatePath, options.signal);
  await options.afterPathValidation?.(basename(canonicalCandidatePath));
  assertActive(options.signal);
  if (
    options.expectedSource !== undefined &&
    !sameFileIdentity(options.expectedSource.identity, candidateObservation)
  ) {
    throw new LocalAgentSkillCandidateError(
      "source_changed",
      "candidate changed after kind discrimination",
    );
  }
  await revalidatePathObservations(
    [...rootPathObservations, { path: canonicalCandidatePath, identity: candidateObservation }],
    options.signal,
  );
  const candidateFile = await stableReadFile(
    canonicalCandidatePath,
    MAX_AGENT_SKILL_CANDIDATE_BYTES,
    candidateObservation,
    options.signal,
  );
  if (
    options.expectedSource !== undefined &&
    options.expectedSource.sha256 !== candidateFile.sha256
  ) {
    throw new LocalAgentSkillCandidateError(
      "source_changed",
      "candidate changed after kind discrimination",
    );
  }
  const candidateText = decodeUtf8(candidateFile.content);
  const source = parseAgentSkillCandidateText(candidateText, basename(candidatePath));

  const workflowAdmission = await resolveAdmittedFile(
    candidateRoot,
    rootObservation,
    source.baseline.workflow.path,
    options.signal,
  );
  await options.afterPathValidation?.(source.baseline.workflow.path);
  assertActive(options.signal);
  const workflowFile = await stableReadFile(
    workflowAdmission.path,
    MAX_LOCAL_WORKFLOW_BYTES,
    requiredFinalObservation(workflowAdmission),
    options.signal,
  );
  await revalidatePathObservations(workflowAdmission.observations, options.signal);
  const workflowText = decodeUtf8(workflowFile.content);
  let workflowSource: WorkflowSource;
  let compiled: CompiledWorkflow;
  try {
    workflowSource = parseWorkflowSourceText(workflowText, source.baseline.workflow.path);
    compiled = compileWorkflowText(workflowText, source.baseline.workflow.path);
  } catch (error) {
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate baseline workflow is invalid",
      { cause: error },
    );
  }

  const evidence: Array<AdmittedLocalAgentSkillCandidate["evidence"][number]> = [];
  const evidenceObservations: PathObservation[] = [];
  for (const declared of source.evidence) {
    assertActive(options.signal);
    const admission = await resolveAdmittedFile(
      candidateRoot,
      rootObservation,
      declared.path,
      options.signal,
    );
    await options.afterPathValidation?.(declared.path);
    assertActive(options.signal);
    const file = await stableReadFile(
      admission.path,
      MAX_TUNING_EVIDENCE_BYTES,
      requiredFinalObservation(admission),
      options.signal,
    );
    await revalidatePathObservations(admission.observations, options.signal);
    evidenceObservations.push(...admission.observations);
    const sourceText = decodeUtf8(file.content);
    let raw: unknown;
    try {
      raw = parseStrictJson(sourceText, {
        maxDepth: 32,
        maxNodes: 131_072,
        valueLabel: "Agent Skill candidate evidence",
      });
    } catch (error) {
      throw new LocalAgentSkillCandidateError(
        "invalid_source",
        "candidate evidence is not strict JSON",
        { cause: error },
      );
    }
    evidence.push(
      deepFreeze({
        sourcePath: admission.path,
        sourceText,
        sourceSha256: file.sha256,
        packet: parseTuningEvidencePacket(raw),
      }),
    );
  }

  assertActive(options.signal);
  await revalidatePathObservations(
    [
      { path: candidateRoot, identity: rootObservation },
      { path: canonicalCandidatePath, identity: candidateObservation },
    ],
    options.signal,
  );
  let baselineCapabilitySnapshot: AgentSkillCapabilitySnapshot;
  let revalidateSkill: () => Promise<void>;
  try {
    await options.afterPathValidation?.(source.baseline.skill.path);
    assertActive(options.signal);
    const admittedSkill = await snapshotProjectAgentSkillPath({
      projectRoot: candidateRoot,
      provenance: source.baseline.skill.path,
      expectedName: source.scope.skillName,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.afterSkillEntryObservation === undefined
        ? {}
        : { afterEntryObservation: options.afterSkillEntryObservation }),
      ...(options.afterSkillRevalidationObservation === undefined
        ? {}
        : { afterRevalidationObservation: options.afterSkillRevalidationObservation }),
      ...(options.afterSkillDirectoryBoundary === undefined
        ? {}
        : { afterDirectoryBoundary: options.afterSkillDirectoryBoundary }),
      ...(options.afterSkillFileBoundary === undefined
        ? {}
        : { afterFileBoundary: options.afterSkillFileBoundary }),
      ...(options.afterSkillPackageCapture === undefined
        ? {}
        : { afterPackageCapture: options.afterSkillPackageCapture }),
    });
    baselineCapabilitySnapshot = admittedSkill.snapshot;
    revalidateSkill = admittedSkill.revalidate;
    assertActive(options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof LocalAgentSkillCandidateError) {
      throw error;
    }
    if (error instanceof AgentSkillCatalogError && error.code === "source_changed") {
      throw new LocalAgentSkillCandidateError(
        "source_changed",
        "candidate baseline skill changed during admission",
        { cause: error },
      );
    }
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate baseline skill cannot be admitted",
      { cause: error },
    );
  }
  assertActive(options.signal);
  const skill = baselineCapabilitySnapshot.packages[0];
  if (skill === undefined) {
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate baseline skill snapshot is unavailable",
    );
  }
  await revalidatePathObservations(
    [
      { path: candidateRoot, identity: rootObservation },
      { path: canonicalCandidatePath, identity: candidateObservation },
      ...rootPathObservations,
      ...workflowAdmission.observations,
      ...evidenceObservations,
    ],
    options.signal,
  );
  await revalidateSkill();
  assertActive(options.signal);
  let projected: ReturnType<typeof projectAgentSkillCandidate>;
  try {
    projected = projectAgentSkillCandidate({
      manifestProvenance: basename(canonicalCandidatePath),
      source,
      sourceSha256: candidateFile.sha256,
      baseline: {
        workflow: {
          provenance: source.baseline.workflow.path,
          sourceSha256: workflowFile.sha256,
          compiled,
        },
        skill,
      },
      evidence: evidence.map((item, index) => ({
        provenance: source.evidence[index]?.path ?? "",
        sourceSha256: item.sourceSha256,
        packet: item.packet,
      })),
    });
  } catch (error) {
    if (isAgentSkillCandidateError(error)) {
      throw new LocalAgentSkillCandidateError(error.code, publicProjectionMessage(error.code));
    }
    throw error;
  }
  await revalidatePathObservations(
    [
      ...rootPathObservations,
      { path: canonicalCandidatePath, identity: candidateObservation },
      ...workflowAdmission.observations,
      ...evidenceObservations,
    ],
    options.signal,
  );
  await revalidateSkill();
  assertActive(options.signal);
  return deepFreeze({
    sourcePath: canonicalCandidatePath,
    sourceText: candidateText,
    source,
    identity: projected.identity,
    baseline: {
      workflow: {
        sourcePath: workflowAdmission.path,
        sourceText: workflowText,
        source: workflowSource,
        sourceSha256: workflowFile.sha256,
        compiled,
        workflowDigest: calculateWorkflowDigest(compiled),
      },
      skill,
    },
    evidence,
    workflow: projected.workflow,
    baselineCapabilitySnapshot: projected.baselineCapabilitySnapshot,
    candidateCapabilitySnapshot: projected.candidateCapabilitySnapshot,
  });
}

async function observeLexicalDirectories(
  path: string,
  signal?: AbortSignal,
  afterObservation?: (isCandidateRoot: boolean) => void | Promise<void>,
): Promise<PathObservation[]> {
  assertActive(signal);
  const absolutePath = resolve(path);
  const anchor = parse(absolutePath).root;
  const components = relative(anchor, absolutePath).split(sep).filter(Boolean);
  const observations: PathObservation[] = [];
  let current = anchor;
  for (const component of ["", ...components]) {
    assertActive(signal);
    if (component !== "") {
      current = join(current, component);
    }
    let identity: BigIntStats;
    try {
      identity = await lstat(current, { bigint: true });
    } catch (error) {
      signal?.throwIfAborted();
      throw new LocalAgentSkillCandidateError("invalid_path", "candidate root is unavailable", {
        cause: error,
      });
    }
    await afterObservation?.(current === absolutePath);
    assertActive(signal);
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
      throw new LocalAgentSkillCandidateError(
        "invalid_path",
        "candidate root ancestry must contain only direct directories",
      );
    }
    observations.push({ path: current, identity });
  }
  return observations;
}

function requiredRootObservation(observations: readonly PathObservation[]): BigIntStats {
  const identity = observations.at(-1)?.identity;
  if (identity === undefined) {
    throw new LocalAgentSkillCandidateError("invalid_path", "candidate root is unavailable");
  }
  return identity;
}

async function resolveAdmittedFile(
  root: string,
  expectedRoot: BigIntStats,
  provenance: string,
  signal?: AbortSignal,
): Promise<AdmittedFilePath> {
  assertActive(signal);
  const candidate = resolve(root, provenance);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new LocalAgentSkillCandidateError("invalid_path", "candidate path escapes its root");
  }
  let current = root;
  let observedRoot: BigIntStats;
  try {
    observedRoot = await lstat(root, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    throw new LocalAgentSkillCandidateError("source_changed", "candidate root changed", {
      cause: error,
    });
  }
  assertActive(signal);
  if (
    observedRoot.isSymbolicLink() ||
    !observedRoot.isDirectory() ||
    !sameDirectoryIdentity(expectedRoot, observedRoot)
  ) {
    throw new LocalAgentSkillCandidateError("source_changed", "candidate root changed");
  }
  const observations: PathObservation[] = [{ path: root, identity: observedRoot }];
  for (const [index, segment] of provenance.split("/").entries()) {
    assertActive(signal);
    current = join(current, segment);
    let entry: BigIntStats;
    try {
      entry = await lstat(current, { bigint: true });
    } catch (error) {
      signal?.throwIfAborted();
      throw new LocalAgentSkillCandidateError("invalid_source", "candidate source is unavailable", {
        cause: error,
      });
    }
    assertActive(signal);
    if (entry.isSymbolicLink()) {
      throw new LocalAgentSkillCandidateError("invalid_path", "candidate path contains a link");
    }
    if (index < provenance.split("/").length - 1 && !entry.isDirectory()) {
      throw new LocalAgentSkillCandidateError(
        "invalid_source",
        "candidate path contains a non-directory ancestor",
      );
    }
    observations.push({ path: current, identity: entry });
  }
  const final = observations.at(-1)?.identity;
  if (final === undefined || !final.isFile()) {
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate source is not a regular file",
    );
  }
  return { path: candidate, observations: Object.freeze(observations) };
}

async function stableReadFile(
  path: string,
  maxBytes: number,
  expected: BigIntStats,
  signal?: AbortSignal,
): Promise<StableFile> {
  assertActive(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    signal?.throwIfAborted();
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate source cannot be opened without links",
      { cause: error },
    );
  }
  try {
    assertActive(signal);
    const before = await handle.stat({ bigint: true });
    assertActive(signal);
    if (!before.isFile() || !sameFileIdentity(expected, before)) {
      throw new LocalAgentSkillCandidateError(
        "source_changed",
        "candidate source changed before read",
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw new LocalAgentSkillCandidateError(
        "limit_exceeded",
        "candidate source exceeds its byte limit",
      );
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      assertActive(signal);
      const remaining = maxBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      assertActive(signal);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) {
      throw new LocalAgentSkillCandidateError(
        "limit_exceeded",
        "candidate source exceeds its byte limit",
      );
    }
    const content = Buffer.concat(chunks, totalBytes);
    const after = await handle.stat({ bigint: true });
    assertActive(signal);
    if (BigInt(content.byteLength) !== before.size || !sameFileIdentity(before, after)) {
      throw new LocalAgentSkillCandidateError(
        "source_changed",
        "candidate source changed during read",
      );
    }
    return Object.freeze({
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function observeRegularFile(path: string, signal?: AbortSignal): Promise<BigIntStats> {
  assertActive(signal);
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch (error) {
    signal?.throwIfAborted();
    throw new LocalAgentSkillCandidateError("invalid_source", "candidate source is unavailable", {
      cause: error,
    });
  }
  assertActive(signal);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new LocalAgentSkillCandidateError(
      "invalid_source",
      "candidate source must be a direct regular file",
    );
  }
  return entry;
}

async function revalidatePathObservations(
  observations: readonly PathObservation[],
  signal?: AbortSignal,
): Promise<void> {
  for (const observation of observations) {
    assertActive(signal);
    let current: BigIntStats;
    try {
      current = await lstat(observation.path, { bigint: true });
    } catch (error) {
      signal?.throwIfAborted();
      throw new LocalAgentSkillCandidateError("source_changed", "candidate source changed", {
        cause: error,
      });
    }
    assertActive(signal);
    const matches = observation.identity.isDirectory()
      ? sameDirectoryIdentity(observation.identity, current)
      : sameFileIdentity(observation.identity, current);
    if (current.isSymbolicLink() || !matches) {
      throw new LocalAgentSkillCandidateError("source_changed", "candidate source changed");
    }
  }
}

function requiredFinalObservation(admission: AdmittedFilePath): BigIntStats {
  const final = admission.observations.at(-1)?.identity;
  if (final === undefined) {
    throw new LocalAgentSkillCandidateError(
      "invalid_path",
      "candidate source observation is incomplete",
    );
  }
  return final;
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new LocalAgentSkillCandidateError("invalid_source", "candidate source is not UTF-8", {
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
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isAgentSkillCandidateError(
  error: unknown,
): error is { readonly code: AgentSkillCandidateErrorCode } {
  return (
    error instanceof Error &&
    error.name === "AgentSkillCandidateError" &&
    typeof (error as { readonly code?: unknown }).code === "string"
  );
}

function publicProjectionMessage(code: AgentSkillCandidateErrorCode): string {
  switch (code) {
    case "identity_mismatch":
      return "candidate identity does not match admitted sources";
    case "invalid_projection":
      return "candidate projection changes disallowed skill authority";
    case "invalid_schema":
      return "candidate does not match its schema";
    case "invalid_target":
      return "candidate resource target is invalid";
    case "invalid_yaml":
      return "candidate is not strict YAML or JSON";
    case "limit_exceeded":
      return "candidate exceeds an admitted limit";
  }
}

function assertActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
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
