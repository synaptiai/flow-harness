import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  CandidateDelta,
  CandidateDeltaEntry,
  CandidatePromotionLifecycle,
  CandidatePromotionRequest,
  CandidatePromotionSettlement,
  CandidateWorkspaceManager,
  IsolatedWorkspace,
  WorkspaceEntryIdentity,
  WorkspaceIsolator,
} from "../../application/ports.js";
import { MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES } from "../../domain/workflow/types.js";
import {
  type CandidatePromotionTestHooks,
  promoteCapturedCandidate,
  reconcileCapturedCandidatePromotion,
} from "./candidate-promotion.js";

export { CandidatePromotionInterruptedError } from "./candidate-promotion.js";

export const REFLINK_COPY_WORKSPACE_BACKEND = "reflink-copy-v1" as const;
export const DEFAULT_MAX_WORKSPACE_ENTRIES = 200_000;
export const DEFAULT_MAX_WORKSPACE_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_CANDIDATE_DELTA_ENTRIES = 20_000;
export const DEFAULT_MAX_CANDIDATE_DELTA_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_CANDIDATE_DELTA_EVIDENCE_BYTES = MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES;

const workspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const manifestSchema = z
  .object({
    version: z.literal(1),
    workspaceId: workspaceIdSchema,
    sourceCwd: z.string().min(1).max(4096),
    excludedPaths: z.array(z.string().min(1).max(4096)).max(256),
    backend: z.literal(REFLINK_COPY_WORKSPACE_BACKEND),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type WorkspaceIsolationErrorCode =
  | "invalid_workspace_id"
  | "candidate_delta_exists"
  | "candidate_delta_limit_exceeded"
  | "candidate_no_change"
  | "candidate_source_stale"
  | "snapshot_limit_exceeded"
  | "source_changed"
  | "source_invalid"
  | "unsupported_entry"
  | "workspace_exists"
  | "workspace_mismatch"
  | "workspace_missing";

export class WorkspaceIsolationError extends Error {
  override readonly name = "WorkspaceIsolationError";

  constructor(
    readonly code: WorkspaceIsolationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface WorkspaceSnapshotRequest {
  readonly workspaceId: string;
  readonly sourceCwd: string;
  readonly excludedPaths?: readonly string[];
}

interface SnapshotLimits {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxDeltaEntries?: number;
  readonly maxDeltaBytes?: number;
  readonly maxDeltaEvidenceBytes?: number;
}

interface SnapshotState {
  entryCount: number;
  bytes: number;
  readonly digest: ReturnType<typeof createHash>;
  readonly entries: Array<{
    readonly path: string;
    readonly identity: Exclude<WorkspaceEntryIdentity, { readonly kind: "missing" }>;
  }>;
}

interface ObservedWorkspaceSnapshot {
  readonly digest: string;
  readonly entries: readonly SnapshotState["entries"][number][];
}

const MISSING_ENTRY: WorkspaceEntryIdentity = Object.freeze({ kind: "missing" });

export class ReflinkCopyWorkspaceIsolator implements WorkspaceIsolator, CandidateWorkspaceManager {
  readonly #baseDirectory: string;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #maxDeltaEntries: number;
  readonly #maxDeltaBytes: number;
  readonly #maxDeltaEvidenceBytes: number;

  constructor(baseDirectory: string, limits: SnapshotLimits = {}) {
    this.#baseDirectory = resolve(baseDirectory);
    this.#maxEntries = checkedLimit(
      limits.maxEntries ?? DEFAULT_MAX_WORKSPACE_ENTRIES,
      "maxEntries",
    );
    this.#maxBytes = checkedLimit(limits.maxBytes ?? DEFAULT_MAX_WORKSPACE_BYTES, "maxBytes");
    this.#maxDeltaEntries = checkedLimit(
      limits.maxDeltaEntries ?? DEFAULT_MAX_CANDIDATE_DELTA_ENTRIES,
      "maxDeltaEntries",
    );
    this.#maxDeltaBytes = checkedLimit(
      limits.maxDeltaBytes ?? DEFAULT_MAX_CANDIDATE_DELTA_BYTES,
      "maxDeltaBytes",
    );
    this.#maxDeltaEvidenceBytes = checkedLimit(
      limits.maxDeltaEvidenceBytes ?? DEFAULT_MAX_CANDIDATE_DELTA_EVIDENCE_BYTES,
      "maxDeltaEvidenceBytes",
    );
  }

  async create(request: WorkspaceSnapshotRequest): Promise<IsolatedWorkspace> {
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const sourceCwd = await canonicalDirectory(request.sourceCwd);
    const excludedPaths = await normalizeExcludedPaths(sourceCwd, request.excludedPaths ?? []);
    await ensureOwnerDirectory(this.#baseDirectory);
    const identityDirectory = this.#identityDirectory(workspaceId);
    try {
      await mkdir(identityDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new WorkspaceIsolationError(
          "workspace_exists",
          `isolated workspace "${workspaceId}" already exists`,
          { cause: error },
        );
      }
      throw error;
    }

    const stagingDirectory = join(identityDirectory, `staging-${randomUUID()}`);
    const workspaceDirectory = join(identityDirectory, "workspace");
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      const snapshotDigest = await snapshotDirectory(
        sourceCwd,
        stagingDirectory,
        this.#maxEntries,
        this.#maxBytes,
        excludedPaths,
      );
      const workspace: IsolatedWorkspace = Object.freeze({
        workspaceId,
        cwd: workspaceDirectory,
        backend: REFLINK_COPY_WORKSPACE_BACKEND,
        snapshotDigest,
      });
      await writeDurableManifest(
        join(identityDirectory, "manifest.json"),
        JSON.stringify({
          version: 1,
          workspaceId,
          sourceCwd,
          excludedPaths,
          backend: workspace.backend,
          snapshotDigest,
        }),
      );
      await rename(stagingDirectory, workspaceDirectory);
      await syncDirectory(identityDirectory);
      return workspace;
    } catch (error) {
      await rm(identityDirectory, { recursive: true, force: true });
      if (error instanceof WorkspaceIsolationError) {
        throw error;
      }
      throw new WorkspaceIsolationError(
        "source_invalid",
        `failed to snapshot workspace "${workspaceId}": ${boundedMessage(error)}`,
        { cause: error },
      );
    }
  }

  async reopen(request: WorkspaceSnapshotRequest): Promise<IsolatedWorkspace> {
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const sourceCwd = await canonicalDirectory(request.sourceCwd);
    const excludedPaths = await normalizeExcludedPaths(sourceCwd, request.excludedPaths ?? []);
    const identityDirectory = this.#identityDirectory(workspaceId);
    let input: string;
    try {
      input = await readFile(join(identityDirectory, "manifest.json"), "utf8");
      const workspaceStat = await stat(join(identityDirectory, "workspace"));
      if (!workspaceStat.isDirectory()) {
        throw new Error("workspace target is not a directory");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new WorkspaceIsolationError(
          "workspace_missing",
          `isolated workspace "${workspaceId}" is missing`,
          { cause: error },
        );
      }
      throw error;
    }
    const parsed = manifestSchema.safeParse(JSON.parse(input) as unknown);
    if (
      !parsed.success ||
      parsed.data.workspaceId !== workspaceId ||
      parsed.data.sourceCwd !== sourceCwd ||
      !sameStrings(parsed.data.excludedPaths, excludedPaths)
    ) {
      throw new WorkspaceIsolationError(
        "workspace_mismatch",
        `isolated workspace "${workspaceId}" does not match its source identity`,
        { ...(parsed.success ? {} : { cause: parsed.error }) },
      );
    }
    return Object.freeze({
      workspaceId,
      cwd: join(identityDirectory, "workspace"),
      backend: parsed.data.backend,
      snapshotDigest: parsed.data.snapshotDigest,
    });
  }

  async captureCandidateDelta(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly expectedSnapshotDigest: string;
    readonly excludedPaths?: readonly string[];
  }): Promise<CandidateDelta> {
    const workspace = await this.reopen(request);
    if (workspace.snapshotDigest !== request.expectedSnapshotDigest) {
      throw new WorkspaceIsolationError(
        "candidate_source_stale",
        `candidate workspace "${workspace.workspaceId}" baseline digest does not match its durable run evidence`,
      );
    }
    const sourceCwd = await canonicalDirectory(request.sourceCwd);
    const excludedPaths = await normalizeExcludedPaths(sourceCwd, request.excludedPaths ?? []);
    const [baseline, candidate] = await Promise.all([
      observeWorkspaceDirectory(sourceCwd, this.#maxEntries, this.#maxBytes, excludedPaths),
      observeWorkspaceDirectory(workspace.cwd, this.#maxEntries, this.#maxBytes, excludedPaths),
    ]);
    if (baseline.digest !== workspace.snapshotDigest) {
      throw new WorkspaceIsolationError(
        "candidate_source_stale",
        `candidate workspace "${workspace.workspaceId}" parent changed after isolation`,
      );
    }

    const entries = candidateDeltaEntries(baseline.entries, candidate.entries);
    if (entries.length === 0) {
      throw new WorkspaceIsolationError(
        "candidate_no_change",
        `candidate workspace "${workspace.workspaceId}" does not change the parent workspace`,
      );
    }
    const logicalBytes = entries.reduce(
      (total, entry) =>
        total +
        (entry.before.kind === "file" ? entry.before.size : 0) +
        (entry.after.kind === "file" ? entry.after.size : 0),
      0,
    );
    if (entries.length > this.#maxDeltaEntries || logicalBytes > this.#maxDeltaBytes) {
      throw new WorkspaceIsolationError(
        "candidate_delta_limit_exceeded",
        `candidate delta exceeds its limit: ${entries.length}/${this.#maxDeltaEntries} entries and ${logicalBytes}/${this.#maxDeltaBytes} bytes`,
      );
    }

    const evidenceBytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
    if (evidenceBytes > this.#maxDeltaEvidenceBytes) {
      throw new WorkspaceIsolationError(
        "candidate_delta_limit_exceeded",
        `candidate delta evidence exceeds its limit: ${evidenceBytes}/${this.#maxDeltaEvidenceBytes} UTF-8 bytes`,
      );
    }

    const manifest = {
      version: 1 as const,
      workspaceId: workspace.workspaceId,
      baselineSnapshotDigest: baseline.digest,
      candidateSnapshotDigest: candidate.digest,
      entryCount: entries.length,
      logicalBytes,
      entries,
    };
    const captured = { ...manifest, deltaDigest: sha256(JSON.stringify(manifest)) };

    const identityDirectory = this.#identityDirectory(workspace.workspaceId);
    const candidateDirectory = join(identityDirectory, "candidate");
    const blobDirectory = join(candidateDirectory, "blobs");
    try {
      await mkdir(candidateDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return await reopenCapturedCandidateDelta(candidateDirectory, captured, error);
      }
      throw error;
    }

    try {
      await mkdir(blobDirectory, { mode: 0o700 });
      for (const entry of entries) {
        if (entry.after.kind !== "file") {
          continue;
        }
        await writeDurableCandidateBlob(
          join(workspace.cwd, ...entry.path.split("/")),
          join(blobDirectory, entry.after.sha256),
          entry.after,
        );
      }
      await syncDirectory(blobDirectory);
      await writeDurableManifest(join(candidateDirectory, "delta.json"), JSON.stringify(captured));
      await syncDirectory(candidateDirectory);
      return freezeCandidateDelta(captured);
    } catch (error) {
      await rm(candidateDirectory, { recursive: true, force: true });
      if (error instanceof WorkspaceIsolationError) {
        throw error;
      }
      throw new WorkspaceIsolationError(
        "source_changed",
        `failed to capture candidate workspace "${workspace.workspaceId}": ${boundedMessage(error)}`,
        { cause: error },
      );
    }
  }

  async promoteCandidateDelta(
    request: CandidatePromotionRequest,
    lifecycle: CandidatePromotionLifecycle,
    hooks: CandidatePromotionTestHooks = {},
  ): Promise<CandidatePromotionSettlement> {
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const sourceCwd = await canonicalDirectory(request.sourceCwd);
    await this.reopen({
      workspaceId,
      sourceCwd,
      excludedPaths: request.excludedPaths ?? [],
    });
    return await promoteCapturedCandidate(
      {
        identityDirectory: this.#identityDirectory(workspaceId),
        sourceCwd,
        request: { ...request, workspaceId, sourceCwd },
      },
      lifecycle,
      hooks,
    );
  }

  async reconcileCandidatePromotion(
    request: CandidatePromotionRequest,
  ): Promise<CandidatePromotionSettlement> {
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const sourceCwd = await canonicalDirectory(request.sourceCwd);
    await this.reopen({
      workspaceId,
      sourceCwd,
      excludedPaths: request.excludedPaths ?? [],
    });
    return await reconcileCapturedCandidatePromotion({
      identityDirectory: this.#identityDirectory(workspaceId),
      sourceCwd,
      request: { ...request, workspaceId, sourceCwd },
    });
  }

  async cleanup(workspaceIdInput: string): Promise<"discarded"> {
    const workspaceId = parseWorkspaceId(workspaceIdInput);
    await rm(this.#identityDirectory(workspaceId), { recursive: true, force: true });
    return "discarded";
  }

  #identityDirectory(workspaceId: string): string {
    const candidate = resolve(this.#baseDirectory, workspaceId);
    const fromBase = relative(this.#baseDirectory, candidate);
    if (
      fromBase === "" ||
      fromBase === ".." ||
      fromBase.startsWith(`..${sep}`) ||
      basename(candidate) !== workspaceId
    ) {
      throw new WorkspaceIsolationError(
        "invalid_workspace_id",
        `invalid isolated workspace id "${workspaceId}"`,
      );
    }
    return candidate;
  }
}

async function snapshotDirectory(
  sourceRoot: string,
  targetRoot: string,
  maxEntries: number,
  maxBytes: number,
  excludedPaths: readonly string[],
): Promise<string> {
  const state: SnapshotState = {
    entryCount: 0,
    bytes: 0,
    digest: createHash("sha256"),
    entries: [],
  };
  for (const excludedPath of excludedPaths) {
    state.digest.update(`excluded\0${excludedPath}\0`);
  }
  await copyDirectory(
    sourceRoot,
    targetRoot,
    "",
    state,
    maxEntries,
    maxBytes,
    new Set(excludedPaths),
  );
  return state.digest.digest("hex");
}

async function observeWorkspaceDirectory(
  sourceRoot: string,
  maxEntries: number,
  maxBytes: number,
  excludedPaths: readonly string[],
): Promise<ObservedWorkspaceSnapshot> {
  const state: SnapshotState = {
    entryCount: 0,
    bytes: 0,
    digest: createHash("sha256"),
    entries: [],
  };
  for (const excludedPath of excludedPaths) {
    state.digest.update(`excluded\0${excludedPath}\0`);
  }
  await copyDirectory(
    sourceRoot,
    undefined,
    "",
    state,
    maxEntries,
    maxBytes,
    new Set(excludedPaths),
  );
  return Object.freeze({
    digest: state.digest.digest("hex"),
    entries: Object.freeze([...state.entries]),
  });
}

async function copyDirectory(
  sourceDirectory: string,
  targetDirectory: string | undefined,
  relativeDirectory: string,
  state: SnapshotState,
  maxEntries: number,
  maxBytes: number,
  excludedPaths: ReadonlySet<string>,
): Promise<void> {
  const directory = await opendir(sourceDirectory);
  const entries = [];
  for await (const entry of directory) {
    if (entry.name !== ".flow") {
      entries.push(entry.name);
    }
  }
  entries.sort((left, right) => left.localeCompare(right, "en"));

  for (const name of entries) {
    const source = join(sourceDirectory, name);
    const target = targetDirectory === undefined ? undefined : join(targetDirectory, name);
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (excludedPaths.has(relativePath)) {
      continue;
    }
    const before = await lstat(source);
    state.entryCount += 1;
    enforceSnapshotLimits(state, maxEntries, maxBytes);

    if (before.isDirectory()) {
      const mode = before.mode & 0o777;
      if (target !== undefined) {
        await mkdir(target, { mode });
        await chmod(target, mode);
      }
      state.entries.push(
        Object.freeze({
          path: relativePath,
          identity: { kind: "directory" as const, mode },
        }),
      );
      state.digest.update(`directory\0${relativePath}\0${mode}\0`);
      await copyDirectory(source, target, relativePath, state, maxEntries, maxBytes, excludedPaths);
      continue;
    }
    if (before.isSymbolicLink()) {
      const linkTarget = await readlink(source);
      if (target !== undefined) {
        await symlink(linkTarget, target);
      }
      state.entries.push(
        Object.freeze({
          path: relativePath,
          identity: { kind: "symlink" as const, target: linkTarget },
        }),
      );
      state.digest.update(`symlink\0${relativePath}\0${before.mode & 0o777}\0${linkTarget}\0`);
      continue;
    }
    if (!before.isFile()) {
      throw new WorkspaceIsolationError(
        "unsupported_entry",
        `workspace entry "${relativePath}" is not a regular file, directory, or symbolic link`,
      );
    }

    state.bytes += before.size;
    enforceSnapshotLimits(state, maxEntries, maxBytes);
    if (target !== undefined) {
      await cloneOrCopyFile(source, target);
      await chmod(target, before.mode & 0o777);
    }
    const [sourceHash, targetHash, after] = await Promise.all([
      hashFile(source),
      target === undefined ? Promise.resolve(undefined) : hashFile(target),
      lstat(source),
    ]);
    if (
      (targetHash !== undefined && sourceHash !== targetHash) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `workspace entry "${relativePath}" changed while its snapshot was created`,
      );
    }
    const mode = before.mode & 0o777;
    state.entries.push(
      Object.freeze({
        path: relativePath,
        identity: { kind: "file" as const, mode, size: before.size, sha256: sourceHash },
      }),
    );
    state.digest.update(`file\0${relativePath}\0${mode}\0${before.size}\0${sourceHash}\0`);
  }
}

async function cloneOrCopyFile(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE);
  } catch (error) {
    if (!canFallbackFromClone(error)) {
      throw error;
    }
    await copyFile(source, target);
  }
}

function canFallbackFromClone(error: unknown): boolean {
  return ["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS"].includes(errorCode(error) ?? "");
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return digest.digest("hex");
}

function enforceSnapshotLimits(state: SnapshotState, maxEntries: number, maxBytes: number): void {
  if (state.entryCount > maxEntries || state.bytes > maxBytes) {
    throw new WorkspaceIsolationError(
      "snapshot_limit_exceeded",
      `workspace snapshot exceeds its limit: ${state.entryCount}/${maxEntries} entries and ${state.bytes}/${maxBytes} bytes`,
    );
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new Error("source is not a directory");
    }
  } catch (error) {
    throw new WorkspaceIsolationError(
      "source_invalid",
      `workspace source "${path}" is not an accessible directory`,
      { cause: error },
    );
  }
  return canonical;
}

async function normalizeExcludedPaths(
  sourceRoot: string,
  inputs: readonly string[],
): Promise<readonly string[]> {
  if (inputs.length > 256) {
    throw new WorkspaceIsolationError(
      "source_invalid",
      "workspace snapshot accepts at most 256 excluded paths",
    );
  }
  const normalized = new Set<string>();
  for (const input of inputs) {
    let absolute = resolve(input);
    try {
      absolute = await realpath(absolute);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new WorkspaceIsolationError(
          "source_invalid",
          `workspace exclusion "${input}" cannot be resolved`,
          { cause: error },
        );
      }
    }
    const fromSource = relative(sourceRoot, absolute);
    if (fromSource === "") {
      throw new WorkspaceIsolationError(
        "source_invalid",
        "workspace source root cannot also be an excluded path",
      );
    }
    if (fromSource === ".." || fromSource.startsWith(`..${sep}`)) {
      continue;
    }
    normalized.add(fromSource.split(sep).join("/"));
  }
  return Object.freeze([...normalized].sort((left, right) => left.localeCompare(right, "en")));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function candidateDeltaEntries(
  baseline: ObservedWorkspaceSnapshot["entries"],
  candidate: ObservedWorkspaceSnapshot["entries"],
): readonly CandidateDeltaEntry[] {
  const baselineByPath = new Map(baseline.map((entry) => [entry.path, entry.identity]));
  const candidateByPath = new Map(candidate.map((entry) => [entry.path, entry.identity]));
  const paths = new Set([...baselineByPath.keys(), ...candidateByPath.keys()]);
  const entries: CandidateDeltaEntry[] = [];
  for (const path of [...paths].sort((left, right) => left.localeCompare(right, "en"))) {
    const before = baselineByPath.get(path) ?? MISSING_ENTRY;
    const after = candidateByPath.get(path) ?? MISSING_ENTRY;
    if (!sameWorkspaceEntryIdentity(before, after)) {
      entries.push(
        Object.freeze({
          path,
          before: freezeWorkspaceEntryIdentity(before),
          after: freezeWorkspaceEntryIdentity(after),
        }),
      );
    }
  }
  return Object.freeze(entries);
}

function sameWorkspaceEntryIdentity(
  left: WorkspaceEntryIdentity,
  right: WorkspaceEntryIdentity,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "missing" || right.kind === "missing") {
    return true;
  }
  if (left.kind === "directory" && right.kind === "directory") {
    return left.mode === right.mode;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  return (
    left.kind === "file" &&
    right.kind === "file" &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

function freezeWorkspaceEntryIdentity(identity: WorkspaceEntryIdentity): WorkspaceEntryIdentity {
  return Object.freeze({ ...identity });
}

function freezeCandidateDelta(delta: CandidateDelta): CandidateDelta {
  return Object.freeze({
    ...delta,
    entries: Object.freeze(
      delta.entries.map((entry) =>
        Object.freeze({
          path: entry.path,
          before: freezeWorkspaceEntryIdentity(entry.before),
          after: freezeWorkspaceEntryIdentity(entry.after),
        }),
      ),
    ),
  });
}

async function reopenCapturedCandidateDelta(
  candidateDirectory: string,
  expected: CandidateDelta,
  cause: unknown,
): Promise<CandidateDelta> {
  try {
    const durable = await readFile(join(candidateDirectory, "delta.json"), "utf8");
    if (durable === `${JSON.stringify(expected)}\n`) {
      return freezeCandidateDelta(expected);
    }
  } catch {
    // The typed error below intentionally classifies missing, partial, and divergent captures alike.
  }
  throw new WorkspaceIsolationError(
    "candidate_delta_exists",
    `candidate workspace "${expected.workspaceId}" has a different or incomplete captured delta`,
    { cause },
  );
}

async function writeDurableCandidateBlob(
  source: string,
  target: string,
  expected: Extract<WorkspaceEntryIdentity, { readonly kind: "file" }>,
): Promise<void> {
  try {
    const targetStat = await lstat(target);
    if (
      !targetStat.isFile() ||
      targetStat.size !== expected.size ||
      (await hashFile(target)) !== expected.sha256
    ) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `candidate content blob ${expected.sha256} does not match its expected identity`,
      );
    }
    return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size !== expected.size) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `candidate file changed before blob ${expected.sha256} was captured`,
      );
    }
    targetHandle = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, expected.size)));
    let position = 0;
    while (position < expected.size) {
      const requested = Math.min(buffer.length, expected.size - position);
      const result = await sourceHandle.read(buffer, 0, requested, position);
      if (result.bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      await targetHandle.write(chunk, 0, chunk.length, position);
      position += chunk.length;
    }
    const after = await sourceHandle.stat();
    if (
      position !== expected.size ||
      digest.digest("hex") !== expected.sha256 ||
      !sameFileObservation(before, after)
    ) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `candidate file changed while blob ${expected.sha256} was captured`,
      );
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

function sameFileObservation(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function ensureOwnerDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeDurableManifest(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${contents}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseWorkspaceId(input: string): string {
  const parsed = workspaceIdSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkspaceIsolationError(
      "invalid_workspace_id",
      `invalid isolated workspace id "${input}"`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function checkedLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 4096 ? message : `${message.slice(0, 4093)}...`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
