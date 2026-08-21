import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  access,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  type GoalWorkspaceRevision,
  MAX_GOAL_WORKSPACE_REVISIONS,
  MAX_GOAL_WORKSPACE_SERIALIZED_BYTES,
  parseGoalWorkspaceRevision,
} from "../../domain/goal/workspace.js";
import { parseStrictJson } from "../../domain/strict-json.js";

export const MAX_GOAL_WORKSPACE_LEDGER_BYTES =
  MAX_GOAL_WORKSPACE_REVISIONS * MAX_GOAL_WORKSPACE_SERIALIZED_BYTES;
export const MAX_GOAL_WORKSPACE_HISTORY_PAGE = 100;

export type LocalGoalWorkspaceStoreErrorCode =
  | "already_exists"
  | "busy"
  | "clock_rollback"
  | "commit_uncertain"
  | "conflict"
  | "corrupt"
  | "invalid_request"
  | "io"
  | "limit_exceeded"
  | "not_found"
  | "settlement_uncertain"
  | "unsafe_state";

export class LocalGoalWorkspaceStoreError extends Error {
  override readonly name = "LocalGoalWorkspaceStoreError";

  constructor(readonly code: LocalGoalWorkspaceStoreErrorCode) {
    super(publicMessage(code));
  }
}

export interface LocalGoalWorkspaceStoreHooks {
  readonly afterLockAcquired?: () => void | Promise<void>;
  readonly afterLedgerChunkRead?: () => void | Promise<void>;
  readonly afterLedgerFileRead?: () => void | Promise<void>;
  readonly beforeAppend?: () => void | Promise<void>;
  readonly beforeLedgerDirectorySynced?: () => void | Promise<void>;
  readonly afterAppendSynced?: () => void | Promise<void>;
  readonly beforeLockReleased?: () => void | Promise<void>;
}

export interface LocalGoalWorkspaceStoreOptions {
  readonly maxLedgerBytes?: number;
  readonly maxRevisions?: number;
  readonly hooks?: LocalGoalWorkspaceStoreHooks;
}

interface LedgerRead {
  readonly revisions: readonly GoalWorkspaceRevision[];
  readonly committedBytes: number;
  readonly hasTornTail: boolean;
  readonly observation?: BigIntStats;
}

interface WriterRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

const writerRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().safe(),
    token: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export class LocalGoalWorkspaceStore {
  readonly #rootDirectory: string;
  readonly #maxLedgerBytes: number;
  readonly #maxRevisions: number;
  readonly #hooks: LocalGoalWorkspaceStoreHooks;

  constructor(
    readonly projectRoot: string,
    options: LocalGoalWorkspaceStoreOptions = {},
  ) {
    this.#rootDirectory = join(resolve(projectRoot), ".flow", "goal-workspace");
    this.#maxLedgerBytes = options.maxLedgerBytes ?? MAX_GOAL_WORKSPACE_LEDGER_BYTES;
    this.#maxRevisions = options.maxRevisions ?? MAX_GOAL_WORKSPACE_REVISIONS;
    this.#hooks = options.hooks ?? {};
    if (!Number.isSafeInteger(this.#maxLedgerBytes) || this.#maxLedgerBytes <= 0) {
      throw new RangeError("goal workspace ledger byte limit must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.#maxRevisions) ||
      this.#maxRevisions <= 0 ||
      this.#maxRevisions > MAX_GOAL_WORKSPACE_REVISIONS
    ) {
      throw new RangeError(
        `goal workspace revision limit must be between 1 and ${MAX_GOAL_WORKSPACE_REVISIONS}`,
      );
    }
  }

  async initialize(
    revision: GoalWorkspaceRevision,
    signal?: AbortSignal,
  ): Promise<GoalWorkspaceRevision> {
    return await this.#withWriter(
      async () => await this.#commit(null, parseGoalWorkspaceRevision(revision), signal),
      signal,
    );
  }

  async update(
    expected: { readonly revision: number; readonly digest: string },
    revision: GoalWorkspaceRevision,
    signal?: AbortSignal,
  ): Promise<GoalWorkspaceRevision> {
    if (!Number.isSafeInteger(expected.revision) || expected.revision <= 0) {
      throw new LocalGoalWorkspaceStoreError("invalid_request");
    }
    return await this.#withWriter(
      async () => await this.#commit(expected, parseGoalWorkspaceRevision(revision), signal),
      signal,
    );
  }

  async readCurrent(signal?: AbortSignal): Promise<GoalWorkspaceRevision> {
    signal?.throwIfAborted();
    const ledger = await this.#readLedger(false, signal);
    signal?.throwIfAborted();
    const current = ledger.revisions.at(-1);
    if (current === undefined) throw new LocalGoalWorkspaceStoreError("not_found");
    return current;
  }

  async readHistory(
    page: { readonly after: number; readonly limit: number },
    signal?: AbortSignal,
  ): Promise<readonly GoalWorkspaceRevision[]> {
    if (
      !Number.isSafeInteger(page.after) ||
      page.after < 0 ||
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > MAX_GOAL_WORKSPACE_HISTORY_PAGE
    ) {
      throw new LocalGoalWorkspaceStoreError("invalid_request");
    }
    signal?.throwIfAborted();
    const ledger = await this.#readLedger(false, signal);
    signal?.throwIfAborted();
    return Object.freeze(
      ledger.revisions.filter((revision) => revision.revision > page.after).slice(0, page.limit),
    );
  }

  async #commit(
    expected: { readonly revision: number; readonly digest: string } | null,
    candidate: GoalWorkspaceRevision,
    signal?: AbortSignal,
  ): Promise<GoalWorkspaceRevision> {
    signal?.throwIfAborted();
    const ledger = await this.#readLedger(true, signal);
    signal?.throwIfAborted();
    const current = ledger.revisions.at(-1);
    if (expected === null) {
      if (current !== undefined) throw new LocalGoalWorkspaceStoreError("already_exists");
      if (candidate.revision !== 1 || candidate.previousDigest !== null) {
        throw new LocalGoalWorkspaceStoreError("conflict");
      }
    } else {
      if (current === undefined) throw new LocalGoalWorkspaceStoreError("not_found");
      if (current.revision !== expected.revision || current.digest !== expected.digest) {
        throw new LocalGoalWorkspaceStoreError("conflict");
      }
      if (
        candidate.revision !== current.revision + 1 ||
        candidate.previousDigest !== current.digest
      ) {
        throw new LocalGoalWorkspaceStoreError("conflict");
      }
      if (Date.parse(candidate.at) < Date.parse(current.at)) {
        throw new LocalGoalWorkspaceStoreError("clock_rollback");
      }
    }
    if (ledger.revisions.length >= this.#maxRevisions) {
      throw new LocalGoalWorkspaceStoreError("limit_exceeded");
    }
    const line = Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8");
    if (ledger.committedBytes + line.byteLength > this.#maxLedgerBytes) {
      throw new LocalGoalWorkspaceStoreError("limit_exceeded");
    }

    await this.#hooks.beforeAppend?.();
    signal?.throwIfAborted();
    let durable = false;
    try {
      const handle = await this.#openMutationHandle(ledger.observation);
      try {
        await handle.truncate(ledger.committedBytes);
        await writeComplete(handle, line, ledger.committedBytes);
        await handle.sync();
        durable = ledger.observation !== undefined;
      } finally {
        await handle.close();
      }
      await this.#hooks.beforeLedgerDirectorySynced?.();
      await syncDirectory(this.#rootDirectory);
      durable = true;
      await this.#hooks.afterAppendSynced?.();
      signal?.throwIfAborted();
      return candidate;
    } catch (error) {
      if (!durable) {
        signal?.throwIfAborted();
        if (error instanceof LocalGoalWorkspaceStoreError) throw error;
        throw new LocalGoalWorkspaceStoreError("commit_uncertain");
      }
      const reconciled = await this.#reconcileExact(candidate);
      if (reconciled !== undefined) return reconciled;
      throw new LocalGoalWorkspaceStoreError("commit_uncertain");
    }
  }

  async #reconcileExact(
    candidate: GoalWorkspaceRevision,
    signal?: AbortSignal,
  ): Promise<GoalWorkspaceRevision | undefined> {
    signal?.throwIfAborted();
    try {
      const ledger = await this.#readLedger(false, signal);
      signal?.throwIfAborted();
      const current = ledger.revisions.at(-1);
      return current?.revision === candidate.revision && current.digest === candidate.digest
        ? current
        : undefined;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  async #withWriter<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const token = await this.#acquireWriter(signal);
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown };
    try {
      await this.#hooks.afterLockAcquired?.();
      signal?.throwIfAborted();
      outcome = { ok: true, value: await operation() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await this.#releaseWriter(token);
    } catch {
      throw new LocalGoalWorkspaceStoreError("settlement_uncertain");
    }
    if (!outcome.ok) {
      throw outcome.error ?? new LocalGoalWorkspaceStoreError("io");
    }
    return outcome.value;
  }

  async #acquireWriter(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      await this.#assertSafeFlowDirectory();
      signal?.throwIfAborted();
      await createDurableDirectory(this.#rootDirectory);
      await this.#assertCanonicalRoot();
      signal?.throwIfAborted();
    } catch (error) {
      if (error instanceof LocalGoalWorkspaceStoreError) throw error;
      throw new LocalGoalWorkspaceStoreError("io");
    }
    const token = randomUUID();
    const candidateDirectory = join(this.#rootDirectory, `.writer-${token}.pending`);
    const record: WriterRecord = {
      version: 1,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    let published = false;
    try {
      await mkdir(candidateDirectory, { mode: 0o700 });
      await writeDurableFile(
        join(candidateDirectory, "owner.json"),
        Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
      );
      signal?.throwIfAborted();
      await syncDirectory(candidateDirectory);
      signal?.throwIfAborted();
      for (let attempt = 0; attempt < 16; attempt += 1) {
        signal?.throwIfAborted();
        try {
          await rename(candidateDirectory, this.#writerDirectory());
          published = true;
          await syncDirectory(this.#rootDirectory);
          return token;
        } catch (error) {
          if (!isRenameCollision(error)) throw error;
        }
        const current = await this.#readWriterRecord();
        signal?.throwIfAborted();
        if (current === undefined) continue;
        if (isProcessAlive(current.pid)) throw new LocalGoalWorkspaceStoreError("busy");
        await this.#retireStaleWriter();
        signal?.throwIfAborted();
      }
      throw new LocalGoalWorkspaceStoreError("busy");
    } catch (error) {
      if (error instanceof LocalGoalWorkspaceStoreError) throw error;
      signal?.throwIfAborted();
      throw new LocalGoalWorkspaceStoreError("io");
    } finally {
      if (!published) {
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #releaseWriter(token: string): Promise<void> {
    const current = await this.#readWriterRecord();
    if (current === undefined || current.token !== token) {
      throw new LocalGoalWorkspaceStoreError("settlement_uncertain");
    }
    await this.#hooks.beforeLockReleased?.();
    const released = join(this.#rootDirectory, `.writer-${randomUUID()}.released`);
    await rename(this.#writerDirectory(), released);
    await syncDirectory(this.#rootDirectory);
    await rm(released, { recursive: true, force: true });
    await syncDirectory(this.#rootDirectory);
  }

  async #retireStaleWriter(): Promise<void> {
    const retired = join(this.#rootDirectory, `.writer-${randomUUID()}.stale`);
    try {
      await rename(this.#writerDirectory(), retired);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    await syncDirectory(this.#rootDirectory);
    await rm(retired, { recursive: true, force: true });
    await syncDirectory(this.#rootDirectory);
  }

  async #readWriterRecord(): Promise<WriterRecord | undefined> {
    try {
      const directory = await lstat(this.#writerDirectory(), { bigint: true });
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new LocalGoalWorkspaceStoreError("unsafe_state");
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (error instanceof LocalGoalWorkspaceStoreError) throw error;
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
    const path = join(this.#writerDirectory(), "owner.json");
    let content: Buffer;
    try {
      content = await readBoundedRegularFile(path, 4_096);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        try {
          await access(this.#writerDirectory());
        } catch (directoryError) {
          if (isNodeError(directoryError) && directoryError.code === "ENOENT") return undefined;
          throw directoryError;
        }
      }
      if (error instanceof LocalGoalWorkspaceStoreError) throw error;
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
    try {
      return writerRecordSchema.parse(
        parseStrictJson(decodeUtf8(content), {
          maxDepth: 4,
          maxNodes: 16,
          valueLabel: "goal workspace writer",
        }),
      );
    } catch {
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
  }

  async #readLedger(allowMissing: boolean, signal?: AbortSignal): Promise<LedgerRead> {
    signal?.throwIfAborted();
    let content: Buffer;
    let observation: BigIntStats | undefined;
    try {
      const read = await readBoundedRegularFileWithObservation(
        goalWorkspaceLedgerPath(this.projectRoot),
        this.#maxLedgerBytes,
        {
          ...(signal === undefined ? {} : { signal }),
          ...(this.#hooks.afterLedgerChunkRead === undefined
            ? {}
            : { afterChunkRead: this.#hooks.afterLedgerChunkRead }),
          ...(this.#hooks.afterLedgerFileRead === undefined
            ? {}
            : { afterFileRead: this.#hooks.afterLedgerFileRead }),
        },
      );
      content = read.content;
      observation = read.observation;
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (isNodeError(error) && error.code === "ENOENT") {
        if (allowMissing) {
          return { revisions: Object.freeze([]), committedBytes: 0, hasTornTail: false };
        }
        throw new LocalGoalWorkspaceStoreError("not_found");
      }
      if (error instanceof LocalGoalWorkspaceStoreError) throw error;
      throw new LocalGoalWorkspaceStoreError("io");
    }
    const hasTornTail = content.length > 0 && content.at(-1) !== 0x0a;
    const lastNewline = content.lastIndexOf(0x0a);
    const committedBytes = hasTornTail ? lastNewline + 1 : content.length;
    const committed = content.subarray(0, committedBytes);
    if (committed.length === 0) {
      if (allowMissing) {
        return { revisions: Object.freeze([]), committedBytes: 0, hasTornTail, observation };
      }
      throw new LocalGoalWorkspaceStoreError("not_found");
    }
    let text: string;
    try {
      text = decodeUtf8(committed);
    } catch {
      throw new LocalGoalWorkspaceStoreError("corrupt");
    }
    const lines = text.slice(0, -1).split("\n");
    if (lines.length > this.#maxRevisions) {
      throw new LocalGoalWorkspaceStoreError("limit_exceeded");
    }
    const revisions: GoalWorkspaceRevision[] = [];
    for (const [index, line] of lines.entries()) {
      signal?.throwIfAborted();
      if (
        line.length === 0 ||
        Buffer.byteLength(line, "utf8") > MAX_GOAL_WORKSPACE_SERIALIZED_BYTES
      ) {
        throw new LocalGoalWorkspaceStoreError("corrupt");
      }
      let revision: GoalWorkspaceRevision;
      try {
        revision = parseGoalWorkspaceRevision(
          parseStrictJson(line, {
            maxDepth: 12,
            maxNodes: 4_096,
            valueLabel: "goal workspace revision",
          }),
        );
      } catch {
        signal?.throwIfAborted();
        throw new LocalGoalWorkspaceStoreError("corrupt");
      }
      const previous = revisions.at(-1);
      if (
        revision.revision !== index + 1 ||
        (previous === undefined
          ? revision.previousDigest !== null
          : revision.previousDigest !== previous.digest ||
            Date.parse(revision.at) < Date.parse(previous.at))
      ) {
        throw new LocalGoalWorkspaceStoreError("corrupt");
      }
      revisions.push(revision);
    }
    return {
      revisions: Object.freeze(revisions),
      committedBytes,
      hasTornTail,
      observation,
    };
  }

  async #openMutationHandle(observation?: BigIntStats): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(
        goalWorkspaceLedgerPath(this.projectRoot),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          (observation === undefined ? constants.O_EXCL : 0),
        0o600,
      );
    } catch (error) {
      if (isUnsafeOpenError(error) || (observation === undefined && isAlreadyExists(error))) {
        throw new LocalGoalWorkspaceStoreError("unsafe_state");
      }
      throw error;
    }
    try {
      const current = await handle.stat({ bigint: true });
      assertSafeFile(current);
      if (observation !== undefined && !sameFileObservation(observation, current)) {
        throw new LocalGoalWorkspaceStoreError("unsafe_state");
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #assertCanonicalRoot(): Promise<void> {
    const stat = await lstat(this.#rootDirectory, { bigint: true });
    const canonical = await realpath(this.#rootDirectory);
    const expected = join(await realpath(this.projectRoot), ".flow", "goal-workspace");
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical !== expected ||
      (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
      (Number(stat.mode) & 0o022) !== 0
    ) {
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
  }

  async #assertSafeFlowDirectory(): Promise<void> {
    const flowDirectory = dirname(this.#rootDirectory);
    const stat = await lstat(flowDirectory, { bigint: true });
    const canonical = await realpath(flowDirectory);
    const expected = join(await realpath(this.projectRoot), ".flow");
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      canonical !== expected ||
      (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
      (Number(stat.mode) & 0o022) !== 0
    ) {
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
  }

  #writerDirectory(): string {
    return join(this.#rootDirectory, ".writer");
  }
}

export function goalWorkspaceLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".flow", "goal-workspace", "events.jsonl");
}

async function readBoundedRegularFile(path: string, maximum: number): Promise<Buffer> {
  return (await readBoundedRegularFileWithObservation(path, maximum)).content;
}

interface BoundedReadOptions {
  readonly signal?: AbortSignal;
  readonly afterChunkRead?: () => void | Promise<void>;
  readonly afterFileRead?: () => void | Promise<void>;
}

async function readBoundedRegularFileWithObservation(
  path: string,
  maximum: number,
  options: BoundedReadOptions = {},
): Promise<{ readonly content: Buffer; readonly observation: BigIntStats }> {
  options.signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isUnsafeOpenError(error)) throw new LocalGoalWorkspaceStoreError("unsafe_state");
    throw error;
  }
  options.signal?.throwIfAborted();
  try {
    const before = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    assertSafeFile(before);
    if (before.size > BigInt(maximum)) throw new LocalGoalWorkspaceStoreError("limit_exceeded");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximum) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      await options.afterChunkRead?.();
      options.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximum) throw new LocalGoalWorkspaceStoreError("limit_exceeded");
    const after = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    if (!sameFileObservation(before, after) || after.size !== BigInt(total)) {
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
    await options.afterFileRead?.();
    options.signal?.throwIfAborted();
    let current: BigIntStats;
    try {
      current = await lstat(path, { bigint: true });
    } catch {
      options.signal?.throwIfAborted();
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
    options.signal?.throwIfAborted();
    assertSafeFile(current);
    if (!sameFileObservation(after, current)) {
      throw new LocalGoalWorkspaceStoreError("unsafe_state");
    }
    return { content: Buffer.concat(chunks, total), observation: after };
  } finally {
    await handle.close();
  }
}

function assertSafeFile(stat: BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
    (Number(stat.mode) & 0o022) !== 0
  ) {
    throw new LocalGoalWorkspaceStoreError("unsafe_state");
  }
}

function sameFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function writeComplete(handle: FileHandle, content: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < content.length) {
    const result = await handle.write(
      content,
      written,
      content.length - written,
      position + written,
    );
    if (result.bytesWritten <= 0) throw new LocalGoalWorkspaceStoreError("commit_uncertain");
    written += result.bytesWritten;
  }
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await writeComplete(handle, content, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDurableDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let current = resolve(directory);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) {
    await syncDirectory(created);
    await syncDirectory(dirname(created));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeUtf8(content: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function isRenameCollision(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EPERM")
  );
}

function isUnsafeOpenError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function publicMessage(code: LocalGoalWorkspaceStoreErrorCode): string {
  switch (code) {
    case "already_exists":
      return "goal workspace already exists";
    case "busy":
      return "goal workspace writer is busy";
    case "clock_rollback":
      return "goal workspace clock moved backward";
    case "commit_uncertain":
      return "goal workspace commit is uncertain";
    case "conflict":
      return "goal workspace revision changed";
    case "corrupt":
      return "goal workspace ledger is corrupt";
    case "invalid_request":
      return "goal workspace request is invalid";
    case "io":
      return "goal workspace storage failed";
    case "limit_exceeded":
      return "goal workspace storage exceeds its limit";
    case "not_found":
      return "goal workspace does not exist";
    case "settlement_uncertain":
      return "goal workspace writer settlement is uncertain";
    case "unsafe_state":
      return "goal workspace storage is unsafe";
  }
}
