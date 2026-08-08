import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
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

import type { IsolatedWorkspace, WorkspaceIsolator } from "../../application/ports.js";

export const REFLINK_COPY_WORKSPACE_BACKEND = "reflink-copy-v1" as const;
export const DEFAULT_MAX_WORKSPACE_ENTRIES = 200_000;
export const DEFAULT_MAX_WORKSPACE_BYTES = 10 * 1024 * 1024 * 1024;

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
}

interface SnapshotState {
  entries: number;
  bytes: number;
  readonly digest: ReturnType<typeof createHash>;
}

export class ReflinkCopyWorkspaceIsolator implements WorkspaceIsolator {
  readonly #baseDirectory: string;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(baseDirectory: string, limits: SnapshotLimits = {}) {
    this.#baseDirectory = resolve(baseDirectory);
    this.#maxEntries = checkedLimit(
      limits.maxEntries ?? DEFAULT_MAX_WORKSPACE_ENTRIES,
      "maxEntries",
    );
    this.#maxBytes = checkedLimit(limits.maxBytes ?? DEFAULT_MAX_WORKSPACE_BYTES, "maxBytes");
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
    entries: 0,
    bytes: 0,
    digest: createHash("sha256"),
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

async function copyDirectory(
  sourceDirectory: string,
  targetDirectory: string,
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
    const target = join(targetDirectory, name);
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (excludedPaths.has(relativePath)) {
      continue;
    }
    const before = await lstat(source);
    state.entries += 1;
    enforceSnapshotLimits(state, maxEntries, maxBytes);

    if (before.isDirectory()) {
      await mkdir(target, { mode: before.mode & 0o777 });
      await chmod(target, before.mode & 0o777);
      state.digest.update(`directory\0${relativePath}\0${before.mode & 0o777}\0`);
      await copyDirectory(source, target, relativePath, state, maxEntries, maxBytes, excludedPaths);
      continue;
    }
    if (before.isSymbolicLink()) {
      const linkTarget = await readlink(source);
      await symlink(linkTarget, target);
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
    await cloneOrCopyFile(source, target);
    await chmod(target, before.mode & 0o777);
    const [sourceHash, targetHash, after] = await Promise.all([
      hashFile(source),
      hashFile(target),
      lstat(source),
    ]);
    if (
      sourceHash !== targetHash ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new WorkspaceIsolationError(
        "source_changed",
        `workspace entry "${relativePath}" changed while its snapshot was created`,
      );
    }
    state.digest.update(
      `file\0${relativePath}\0${before.mode & 0o777}\0${before.size}\0${targetHash}\0`,
    );
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
  if (state.entries > maxEntries || state.bytes > maxBytes) {
    throw new WorkspaceIsolationError(
      "snapshot_limit_exceeded",
      `workspace snapshot exceeds its limit: ${state.entries}/${maxEntries} entries and ${state.bytes}/${maxBytes} bytes`,
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
