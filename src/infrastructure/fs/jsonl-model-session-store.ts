import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants, type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  appendModelSessionEvent,
  createModelSession,
  createModelSessionEvent,
  MAX_MODEL_SESSION_EVENT_BYTES,
  MAX_MODEL_SESSION_EVENTS,
  MAX_MODEL_SESSION_RECORD_BYTES,
  type ModelSessionEvent,
  type ModelSessionEventInput,
  type ModelSessionIdentity,
  type ModelSessionState,
  modelSessionId,
  parseModelSessionEvent,
  reduceModelSessionEvents,
} from "../../domain/run/model-session.js";

export type ModelSessionStoreErrorCode =
  | "aborted"
  | "corrupt"
  | "invalid_identity"
  | "io"
  | "limit"
  | "not_found"
  | "not_owner"
  | "session_exists"
  | "unsafe_path";

export class ModelSessionStoreError extends Error {
  override readonly name = "ModelSessionStoreError";

  constructor(
    readonly code: ModelSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ModelSessionStoreOptions {
  readonly maxEventBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxEvents?: number;
}

interface OwnedSession {
  readonly state: ModelSessionState;
  readonly committedBytes: number;
  readonly ownerToken: string;
}

interface LedgerRead {
  readonly state: ModelSessionState;
  readonly committedBytes: number;
  readonly hasTornTail: boolean;
}

interface OwnerRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
}

const ownerRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().safe(),
    token: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export class JsonlModelSessionStore {
  readonly maxEventBytes: number;
  readonly maxRecordBytes: number;
  readonly maxEvents: number;
  readonly #appendTailBySession = new Map<string, Promise<void>>();
  readonly #ownedSessions = new Map<string, OwnedSession>();

  constructor(
    readonly rootDirectory: string,
    options: ModelSessionStoreOptions = {},
  ) {
    this.maxEventBytes = positiveLimit(
      options.maxEventBytes ?? MAX_MODEL_SESSION_EVENT_BYTES,
      "maxEventBytes",
    );
    this.maxRecordBytes = positiveLimit(
      options.maxRecordBytes ?? MAX_MODEL_SESSION_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.maxEvents = positiveLimit(options.maxEvents ?? MAX_MODEL_SESSION_EVENTS, "maxEvents");
    if (this.maxEventBytes > MAX_MODEL_SESSION_EVENT_BYTES) {
      throw new RangeError(`maxEventBytes must not exceed ${MAX_MODEL_SESSION_EVENT_BYTES}`);
    }
    if (this.maxRecordBytes > MAX_MODEL_SESSION_RECORD_BYTES) {
      throw new RangeError(`maxRecordBytes must not exceed ${MAX_MODEL_SESSION_RECORD_BYTES}`);
    }
    if (this.maxEvents > MAX_MODEL_SESSION_EVENTS) {
      throw new RangeError(`maxEvents must not exceed ${MAX_MODEL_SESSION_EVENTS}`);
    }
  }

  create(
    identityInput: ModelSessionIdentity,
    at: string,
    signal?: AbortSignal,
  ): Promise<ModelSessionState> {
    const identity = validateIdentity(identityInput);
    const sessionId = modelSessionId(identity);
    return this.#serialize(sessionId, async () => {
      throwIfAborted(signal);
      return await this.#createNow(identity, at, signal);
    });
  }

  append(
    identityInput: ModelSessionIdentity,
    input: ModelSessionEventInput,
    at: string,
    signal?: AbortSignal,
  ): Promise<ModelSessionState> {
    const identity = validateIdentity(identityInput);
    const sessionId = modelSessionId(identity);
    return this.#serialize(sessionId, async () => {
      throwIfAborted(signal);
      return await this.#appendNow(identity, input, at, signal);
    });
  }

  async read(identityInput: ModelSessionIdentity): Promise<ModelSessionState> {
    const identity = validateIdentity(identityInput);
    return (await this.#readCommitted(identity)).state;
  }

  async claim(
    identityInput: ModelSessionIdentity,
    signal?: AbortSignal,
  ): Promise<ModelSessionState> {
    const identity = validateIdentity(identityInput);
    const sessionId = modelSessionId(identity);
    return await this.#serialize(sessionId, async () => {
      throwIfAborted(signal);
      const current = this.#ownedSessions.get(sessionId);
      if (current !== undefined) {
        return current.state;
      }
      await this.#assertSessionDirectory(identity);
      const ownerToken = await this.#acquireOwnership(identity, signal);
      try {
        const ledger = await this.#readCommitted(identity);
        throwIfAborted(signal);
        if (ledger.hasTornTail) {
          const handle = await this.#openSafeRecord(identity, constants.O_WRONLY);
          try {
            await handle.truncate(ledger.committedBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        this.#ownedSessions.set(sessionId, {
          state: ledger.state,
          committedBytes: ledger.committedBytes,
          ownerToken,
        });
        return ledger.state;
      } catch (error) {
        await this.#releaseOwnership(identity, ownerToken).catch(() => undefined);
        throw error;
      }
    });
  }

  async release(identityInput: ModelSessionIdentity): Promise<void> {
    const identity = validateIdentity(identityInput);
    const sessionId = modelSessionId(identity);
    await this.#serialize(sessionId, async () => {
      const owned = this.#ownedSessions.get(sessionId);
      if (owned === undefined) {
        return;
      }
      await this.#releaseOwnership(identity, owned.ownerToken);
      this.#ownedSessions.delete(sessionId);
    });
  }

  recordPath(identityInput: ModelSessionIdentity): string {
    const identity = validateIdentity(identityInput);
    return join(this.#sessionDirectory(identity), "events.jsonl");
  }

  #serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#appendTailBySession.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#appendTailBySession.set(sessionId, tail);
    return result.finally(() => {
      if (this.#appendTailBySession.get(sessionId) === tail) {
        this.#appendTailBySession.delete(sessionId);
      }
    });
  }

  async #createNow(
    identity: ModelSessionIdentity,
    at: string,
    signal?: AbortSignal,
  ): Promise<ModelSessionState> {
    const sessionId = modelSessionId(identity);
    if (this.#ownedSessions.has(sessionId)) {
      throw new ModelSessionStoreError(
        "session_exists",
        `model session "${sessionId}" already exists`,
      );
    }
    const sessionDirectory = this.#sessionDirectory(identity);
    await this.#prepareSessionParent(identity);
    throwIfAborted(signal);
    try {
      await mkdir(sessionDirectory, { mode: 0o700 });
      await syncDirectory(dirname(sessionDirectory));
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ModelSessionStoreError(
          "session_exists",
          `model session "${sessionId}" already exists`,
          { cause: error },
        );
      }
      throw storeIoError(sessionId, "create its directory", error);
    }

    let ownerToken: string | undefined;
    try {
      ownerToken = await this.#acquireOwnership(identity, signal);
      const created = createModelSession(identity, at);
      const line = `${JSON.stringify(created.event)}\n`;
      this.#validateAppend(created.state.eventCount, 0, line);
      throwIfAborted(signal);
      const handle = await openNoFollow(this.recordPath(identity), "exclusive-write");
      try {
        await validateRecordHandle(handle, this.recordPath(identity));
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(sessionDirectory);
      const committedBytes = Buffer.byteLength(line, "utf8");
      this.#ownedSessions.set(sessionId, {
        state: created.state,
        committedBytes,
        ownerToken,
      });
      return created.state;
    } catch (error) {
      if (ownerToken !== undefined) {
        await this.#releaseOwnership(identity, ownerToken).catch(() => undefined);
      }
      await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ModelSessionStoreError) {
        throw error;
      }
      throw storeIoError(sessionId, "create its record", error);
    }
  }

  async #appendNow(
    identity: ModelSessionIdentity,
    input: ModelSessionEventInput,
    at: string,
    signal?: AbortSignal,
  ): Promise<ModelSessionState> {
    const sessionId = modelSessionId(identity);
    const owned = this.#ownedSessions.get(sessionId);
    if (owned === undefined) {
      throw new ModelSessionStoreError(
        "not_owner",
        `this store instance does not own model session "${sessionId}"`,
      );
    }
    const event = createModelSessionEvent(owned.state, input, at);
    const line = `${JSON.stringify(event)}\n`;
    this.#validateAppend(owned.state.eventCount + 1, owned.committedBytes, line);
    throwIfAborted(signal);
    try {
      const handle = await this.#openSafeRecord(identity, constants.O_WRONLY | constants.O_APPEND);
      try {
        await handle.truncate(owned.committedBytes);
        throwIfAborted(signal);
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const nextState = appendModelSessionEvent(owned.state, event);
      const committedBytes = owned.committedBytes + Buffer.byteLength(line, "utf8");
      this.#ownedSessions.set(sessionId, {
        state: nextState,
        committedBytes,
        ownerToken: owned.ownerToken,
      });
      return nextState;
    } catch (error) {
      if (error instanceof ModelSessionStoreError) {
        throw error;
      }
      throw storeIoError(sessionId, "append its record", error);
    }
  }

  async #readCommitted(identity: ModelSessionIdentity): Promise<LedgerRead> {
    const sessionId = modelSessionId(identity);
    let handle: FileHandle;
    try {
      await this.#assertSessionDirectory(identity);
      handle = await this.#openSafeRecord(identity, constants.O_RDONLY);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ModelSessionStoreError(
          "not_found",
          `model session "${sessionId}" does not exist`,
          { cause: error },
        );
      }
      if (error instanceof ModelSessionStoreError) {
        throw error;
      }
      throw storeIoError(sessionId, "open its record", error);
    }

    let contents: Buffer;
    try {
      const metadata = await handle.stat();
      const maximumReadableBytes = this.maxRecordBytes + this.maxEventBytes;
      if (metadata.size > maximumReadableBytes) {
        throw new ModelSessionStoreError(
          "limit",
          `model session "${sessionId}" exceeds the ${maximumReadableBytes}-byte read ceiling`,
        );
      }
      contents = await handle.readFile();
    } finally {
      await handle.close();
    }

    const hasTornTail = contents.length > 0 && contents.at(-1) !== 0x0a;
    const lastNewline = contents.lastIndexOf(0x0a);
    const committedBytes = hasTornTail ? lastNewline + 1 : contents.length;
    if (committedBytes > this.maxRecordBytes) {
      throw new ModelSessionStoreError(
        "limit",
        `model session "${sessionId}" exceeds ${this.maxRecordBytes} committed bytes`,
      );
    }
    const committed = contents.subarray(0, committedBytes).toString("utf8");
    const lines = committed.length === 0 ? [] : committed.slice(0, -1).split("\n");
    if (lines.length > this.maxEvents) {
      throw new ModelSessionStoreError(
        "limit",
        `model session "${sessionId}" exceeds ${this.maxEvents} events`,
      );
    }
    const events: ModelSessionEvent[] = [];
    for (const [index, line] of lines.entries()) {
      const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (lineBytes > this.maxEventBytes) {
        throw new ModelSessionStoreError(
          "limit",
          `model session "${sessionId}" event ${index + 1} exceeds ${this.maxEventBytes} bytes`,
        );
      }
      if (line.length === 0) {
        throw new ModelSessionStoreError(
          "corrupt",
          `model session "${sessionId}" contains an empty record at line ${index + 1}`,
        );
      }
      try {
        events.push(parseModelSessionEvent(JSON.parse(line)));
      } catch (error) {
        throw new ModelSessionStoreError(
          "corrupt",
          `model session "${sessionId}" contains an invalid record at line ${index + 1}`,
          { cause: error },
        );
      }
    }
    let state: ModelSessionState;
    try {
      state = reduceModelSessionEvents(events);
    } catch (error) {
      throw new ModelSessionStoreError(
        "corrupt",
        `model session "${sessionId}" cannot be replayed`,
        { cause: error },
      );
    }
    if (
      state.sessionId !== sessionId ||
      state.runId !== identity.runId ||
      state.workflowId !== identity.workflowId ||
      state.nodeId !== identity.nodeId
    ) {
      throw new ModelSessionStoreError(
        "corrupt",
        `model session "${sessionId}" identity does not match its path`,
      );
    }
    return { state, committedBytes, hasTornTail };
  }

  #validateAppend(eventCount: number, committedBytes: number, line: string): void {
    const eventBytes = Buffer.byteLength(line, "utf8");
    if (eventBytes > this.maxEventBytes) {
      throw new ModelSessionStoreError(
        "limit",
        `model session event is ${eventBytes} bytes; maximum is ${this.maxEventBytes}`,
      );
    }
    if (committedBytes + eventBytes > this.maxRecordBytes) {
      throw new ModelSessionStoreError(
        "limit",
        `model session record would exceed ${this.maxRecordBytes} bytes`,
      );
    }
    if (eventCount > this.maxEvents) {
      throw new ModelSessionStoreError(
        "limit",
        `model session record would exceed ${this.maxEvents} events`,
      );
    }
  }

  async #prepareSessionParent(identity: ModelSessionIdentity): Promise<void> {
    const runDirectory = join(this.rootDirectory, identity.runId);
    await assertSafeDirectory(runDirectory, "run directory");
    const modelSessionsDirectory = join(runDirectory, "model-sessions");
    try {
      await mkdir(modelSessionsDirectory, { mode: 0o700 });
      await syncDirectory(runDirectory);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw storeIoError(modelSessionId(identity), "create its parent directory", error);
      }
    }
    await assertSafeDirectory(modelSessionsDirectory, "model session parent directory");
  }

  async #assertSessionDirectory(identity: ModelSessionIdentity): Promise<void> {
    await assertSafeDirectory(join(this.rootDirectory, identity.runId), "run directory");
    await assertSafeDirectory(
      join(this.rootDirectory, identity.runId, "model-sessions"),
      "model session parent directory",
    );
    await assertSafeDirectory(this.#sessionDirectory(identity), "model session directory");
  }

  async #openSafeRecord(identity: ModelSessionIdentity, flags: number): Promise<FileHandle> {
    const path = this.recordPath(identity);
    let handle: FileHandle;
    try {
      handle = await openNoFollow(path, flags);
    } catch (error) {
      if (isUnsafeLinkError(error)) {
        throw new ModelSessionStoreError("unsafe_path", `unsafe model session path "${path}"`, {
          cause: error,
        });
      }
      throw error;
    }
    try {
      await validateRecordHandle(handle, path);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #acquireOwnership(identity: ModelSessionIdentity, signal?: AbortSignal): Promise<string> {
    const sessionDirectory = this.#sessionDirectory(identity);
    const ownerDirectory = join(sessionDirectory, ".owner");
    const token = randomUUID();
    const candidateDirectory = join(sessionDirectory, `.owner-${token}.pending`);
    const record: OwnerRecord = {
      version: 1,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    let published = false;
    try {
      throwIfAborted(signal);
      await mkdir(candidateDirectory, { mode: 0o700 });
      await writeDurablePrivateFile(
        join(candidateDirectory, "owner.json"),
        `${JSON.stringify(record)}\n`,
      );
      await syncDirectory(candidateDirectory);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        throwIfAborted(signal);
        const current = await this.#readOwnerRecordIfPresent(identity);
        if (current !== undefined) {
          if (isProcessAlive(current.pid)) {
            throw new ModelSessionStoreError(
              "not_owner",
              `model session "${modelSessionId(identity)}" is owned by live process ${current.pid}`,
            );
          }
          const retired = join(sessionDirectory, `.owner-${randomUUID()}.stale`);
          await rename(ownerDirectory, retired);
          await syncDirectory(sessionDirectory);
          await rm(retired, { recursive: true, force: true });
          continue;
        }
        try {
          await rename(candidateDirectory, ownerDirectory);
          published = true;
          await syncDirectory(sessionDirectory);
          return token;
        } catch (error) {
          if (!isRenameCollision(error)) {
            throw error;
          }
        }
      }
      throw new ModelSessionStoreError(
        "not_owner",
        `model session "${modelSessionId(identity)}" ownership changed repeatedly`,
      );
    } catch (error) {
      if (error instanceof ModelSessionStoreError) {
        throw error;
      }
      if (isUnsafeLinkError(error)) {
        throw new ModelSessionStoreError(
          "unsafe_path",
          `unsafe ownership path for model session "${modelSessionId(identity)}"`,
          { cause: error },
        );
      }
      throw storeIoError(modelSessionId(identity), "acquire ownership", error);
    } finally {
      if (!published) {
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #releaseOwnership(identity: ModelSessionIdentity, token: string): Promise<void> {
    const sessionDirectory = this.#sessionDirectory(identity);
    const ownerDirectory = join(sessionDirectory, ".owner");
    const current = await this.#readOwnerRecord(identity);
    if (current.token !== token) {
      throw new ModelSessionStoreError(
        "not_owner",
        `model session "${modelSessionId(identity)}" ownership changed`,
      );
    }
    const retired = join(sessionDirectory, `.owner-${randomUUID()}.released`);
    try {
      await rename(ownerDirectory, retired);
      await syncDirectory(sessionDirectory);
      await rm(retired, { recursive: true, force: true });
      await syncDirectory(sessionDirectory);
    } catch (error) {
      throw storeIoError(modelSessionId(identity), "release ownership", error);
    }
  }

  async #readOwnerRecord(identity: ModelSessionIdentity): Promise<OwnerRecord> {
    const ownerDirectory = join(this.#sessionDirectory(identity), ".owner");
    await assertSafeDirectory(ownerDirectory, "model session ownership directory");
    const path = join(ownerDirectory, "owner.json");
    let handle: FileHandle;
    try {
      handle = await openNoFollow(path, constants.O_RDONLY);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ModelSessionStoreError(
          "corrupt",
          `model session "${modelSessionId(identity)}" ownership metadata is missing`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await validateRecordHandle(handle, path);
      const input = await handle.readFile("utf8");
      const parsed = ownerRecordSchema.safeParse(JSON.parse(input));
      if (!parsed.success) {
        throw parsed.error;
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ModelSessionStoreError) {
        throw error;
      }
      throw new ModelSessionStoreError(
        "corrupt",
        `model session "${modelSessionId(identity)}" ownership metadata is invalid`,
        { cause: error },
      );
    } finally {
      await handle.close();
    }
  }

  async #readOwnerRecordIfPresent(
    identity: ModelSessionIdentity,
  ): Promise<OwnerRecord | undefined> {
    const ownerDirectory = join(this.#sessionDirectory(identity), ".owner");
    try {
      await lstat(ownerDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    return await this.#readOwnerRecord(identity);
  }

  #sessionDirectory(identity: ModelSessionIdentity): string {
    const candidate = resolve(
      this.rootDirectory,
      identity.runId,
      "model-sessions",
      modelSessionId(identity),
    );
    const root = resolve(this.rootDirectory);
    if (!candidate.startsWith(`${root}/`)) {
      throw new ModelSessionStoreError(
        "invalid_identity",
        "model session path escapes the configured root",
      );
    }
    return candidate;
  }
}

async function assertSafeDirectory(path: string, label: string): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw error;
    }
    throw new ModelSessionStoreError("io", `failed to inspect ${label} "${path}"`, {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ModelSessionStoreError("unsafe_path", `${label} "${path}" is not a real directory`);
  }
  validateOwnerAndMode(metadata, path, 0o700);
}

async function validateRecordHandle(handle: FileHandle, path: string): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new ModelSessionStoreError(
      "unsafe_path",
      `model session record "${path}" must be one regular file with one link`,
    );
  }
  validateOwnerAndMode(metadata, path, 0o600);
}

function validateOwnerAndMode(metadata: Stats, path: string, expectedMode: number): void {
  const getuid = process.getuid;
  if (getuid !== undefined && metadata.uid !== getuid()) {
    throw new ModelSessionStoreError(
      "unsafe_path",
      `model session path "${path}" is not owned by the current user`,
    );
  }
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new ModelSessionStoreError(
      "unsafe_path",
      `model session path "${path}" must have mode ${expectedMode.toString(8)}`,
    );
  }
}

async function openNoFollow(path: string, flags: number | "exclusive-write"): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const resolvedFlags =
    flags === "exclusive-write"
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
      : flags | noFollow;
  return await open(path, resolvedFlags, 0o600);
}

async function writeDurablePrivateFile(path: string, contents: string): Promise<void> {
  const handle = await openNoFollow(path, "exclusive-write");
  try {
    await validateRecordHandle(handle, path);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateIdentity(identity: ModelSessionIdentity): ModelSessionIdentity {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identity.runId)) {
    throw new ModelSessionStoreError(
      "invalid_identity",
      `invalid model session run id "${identity.runId}"`,
    );
  }
  for (const [label, value] of [
    ["workflowId", identity.workflowId],
    ["nodeId", identity.nodeId],
  ] as const) {
    if (value.length === 0 || value.length > 512) {
      throw new ModelSessionStoreError(
        "invalid_identity",
        `${label} must be a non-empty string of at most 512 characters`,
      );
    }
  }
  return Object.freeze({ ...identity });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw new ModelSessionStoreError("aborted", "model session operation was aborted", {
    cause: signal.reason,
  });
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function storeIoError(
  sessionId: string,
  operation: string,
  cause: unknown,
): ModelSessionStoreError {
  return new ModelSessionStoreError(
    "io",
    `failed to ${operation} for model session "${sessionId}"`,
    { cause },
  );
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
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isUnsafeLinkError(error: unknown): boolean {
  return isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
