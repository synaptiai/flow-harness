import { randomUUID } from "node:crypto";
import {
  access,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { RecoverableRunEventStore } from "../../application/ports.js";
import {
  appendRunEvent,
  parseRunEvent,
  reduceRunEvents,
  RunReplayError,
  type RunEvent,
  type RunState,
} from "../../domain/run/events.js";

export type RunStoreErrorCode =
  | "corrupt"
  | "invalid_run_id"
  | "io"
  | "limit"
  | "not_found"
  | "not_owner"
  | "run_exists"
  | "sequence";

export class RunStoreError extends Error {
  override readonly name = "RunStoreError";

  constructor(
    readonly code: RunStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface LedgerRead {
  readonly events: readonly RunEvent[];
  readonly committedBytes: number;
  readonly hasTornTail: boolean;
}

interface OwnedRun {
  readonly state: RunState;
  readonly committedBytes: number;
  readonly ownerToken: string;
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
    token: z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export class JsonlRunStore implements RecoverableRunEventStore {
  readonly #appendTailByRun = new Map<string, Promise<void>>();
  readonly #ownedRuns = new Map<string, OwnedRun>();

  constructor(
    readonly rootDirectory: string,
    readonly maxEventBytes = 1_048_576,
  ) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
      throw new RangeError("maxEventBytes must be a positive safe integer");
    }
  }

  append(event: RunEvent): Promise<void> {
    const runId = validateRunId(event.runId);
    const previous = this.#appendTailByRun.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.#appendNow(parseRunEvent(event)));
    this.#appendTailByRun.set(
      runId,
      next.catch(() => undefined),
    );
    return next;
  }

  async read(runIdInput: string): Promise<readonly RunEvent[]> {
    const runId = validateRunId(runIdInput);
    const ledger = await this.#readCommitted(runId);
    validateReplay(runId, ledger.events);
    return Object.freeze([...ledger.events]);
  }

  async claim(runIdInput: string): Promise<readonly RunEvent[]> {
    const runId = validateRunId(runIdInput);
    await this.#assertLedgerExists(runId);

    const alreadyOwned = this.#ownedRuns.get(runId);
    if (alreadyOwned !== undefined) {
      const ledger = await this.#readCommitted(runId);
      this.#ownedRuns.set(runId, {
        state: validateReplay(runId, ledger.events),
        committedBytes: ledger.committedBytes,
        ownerToken: alreadyOwned.ownerToken,
      });
      return Object.freeze([...ledger.events]);
    }

    const ownerToken = await this.#acquireOwnership(runId, "recovery");
    try {
      const ledger = await this.#readCommitted(runId);
      this.#ownedRuns.set(runId, {
        state: validateReplay(runId, ledger.events),
        committedBytes: ledger.committedBytes,
        ownerToken,
      });
      return Object.freeze([...ledger.events]);
    } catch (error) {
      await this.#releaseOwnership(runId, ownerToken).catch(() => undefined);
      throw error;
    }
  }

  async release(runIdInput: string): Promise<void> {
    const runId = validateRunId(runIdInput);
    await (this.#appendTailByRun.get(runId) ?? Promise.resolve());
    const owned = this.#ownedRuns.get(runId);
    if (owned === undefined) {
      return;
    }
    await this.#releaseOwnership(runId, owned.ownerToken);
    this.#ownedRuns.delete(runId);
  }

  #eventsPath(runId: string): string {
    return join(this.rootDirectory, runId, "events.jsonl");
  }

  #ownerDirectory(runId: string): string {
    return join(this.rootDirectory, runId, ".owner");
  }

  async #appendNow(event: RunEvent): Promise<void> {
    if (event.sequence === 1) {
      await this.#claimAndAppend(event);
      return;
    }
    await this.#appendOwned(event);
  }

  async #claimAndAppend(event: RunEvent): Promise<void> {
    const runId = event.runId;
    const nextState = validateCandidate(runId, undefined, event);
    const runDirectory = join(this.rootDirectory, runId);
    const path = this.#eventsPath(runId);
    const line = `${JSON.stringify(event)}\n`;
    validateEventSize(runId, line, this.maxEventBytes);

    let ownerToken: string | undefined;
    try {
      await createDurableDirectory(runDirectory);
      ownerToken = await this.#acquireOwnership(runId, "fresh");

      let handle: FileHandle;
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new RunStoreError("run_exists", `run "${runId}" already exists`, {
            cause: error,
          });
        }
        throw error;
      }

      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(runDirectory);
      this.#ownedRuns.set(runId, {
        state: nextState,
        committedBytes: Buffer.byteLength(line, "utf8"),
        ownerToken,
      });
    } catch (error) {
      if (ownerToken !== undefined) {
        await this.#releaseOwnership(runId, ownerToken).catch(() => undefined);
      }
      if (error instanceof RunStoreError) {
        throw error;
      }
      throw new RunStoreError("io", `failed to claim run "${runId}"`, { cause: error });
    }
  }

  async #appendOwned(event: RunEvent): Promise<void> {
    const runId = event.runId;
    const owned = this.#ownedRuns.get(runId);
    if (owned === undefined) {
      throw new RunStoreError(
        "not_owner",
        `this store instance does not own run "${runId}"; claim it before appending`,
      );
    }

    const expectedSequence = owned.state.lastSequence + 1;
    if (event.sequence !== expectedSequence) {
      throw new RunStoreError(
        "sequence",
        `expected sequence ${expectedSequence} for run "${runId}", received ${event.sequence}`,
      );
    }
    const nextState = validateCandidate(runId, owned.state, event);

    const path = this.#eventsPath(runId);
    const line = `${JSON.stringify(event)}\n`;
    validateEventSize(runId, line, this.maxEventBytes);
    try {
      // Repair any partial write left by a prior failed append without rereading
      // or replaying the entire ledger.
      await truncate(path, owned.committedBytes);
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#ownedRuns.set(runId, {
        state: nextState,
        committedBytes: owned.committedBytes + Buffer.byteLength(line, "utf8"),
        ownerToken: owned.ownerToken,
      });
    } catch (error) {
      throw new RunStoreError("io", `failed to append run "${runId}"`, { cause: error });
    }
  }

  async #readCommitted(runId: string): Promise<LedgerRead> {
    const path = this.#eventsPath(runId);
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new RunStoreError("not_found", `run "${runId}" does not exist`, { cause: error });
      }
      throw new RunStoreError("io", `failed to read run "${runId}"`, { cause: error });
    }

    const hasTornTail = contents.length > 0 && contents.at(-1) !== 0x0a;
    const lastNewline = contents.lastIndexOf(0x0a);
    const committedBytes = hasTornTail ? lastNewline + 1 : contents.length;
    const committedText = contents.subarray(0, committedBytes).toString("utf8");
    const lines = committedText.length === 0 ? [] : committedText.slice(0, -1).split("\n");
    const events: RunEvent[] = [];

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) {
        throw new RunStoreError(
          "corrupt",
          `run "${runId}" contains an empty record at line ${index + 1}`,
        );
      }
      try {
        events.push(parseRunEvent(JSON.parse(line)));
      } catch (error) {
        throw new RunStoreError(
          "corrupt",
          `run "${runId}" contains an invalid record at line ${index + 1}`,
          { cause: error },
        );
      }
    }

    return { events: Object.freeze(events), committedBytes, hasTornTail };
  }

  async #assertLedgerExists(runId: string): Promise<void> {
    try {
      await access(this.#eventsPath(runId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new RunStoreError("not_found", `run "${runId}" does not exist`, { cause: error });
      }
      throw new RunStoreError("io", `failed to access run "${runId}"`, { cause: error });
    }
  }

  async #acquireOwnership(runId: string, intent: "fresh" | "recovery"): Promise<string> {
    const runDirectory = join(this.rootDirectory, runId);
    const ownerDirectory = this.#ownerDirectory(runId);
    const token = randomUUID();
    const candidateDirectory = join(runDirectory, `.owner-${token}.pending`);
    const record: OwnerRecord = {
      version: 1,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    let published = false;

    try {
      await mkdir(candidateDirectory, { mode: 0o700 });
      await writeDurableFile(join(candidateDirectory, "owner.json"), `${JSON.stringify(record)}\n`);
      await syncDirectory(candidateDirectory);

      const ownerBeforePublish = await this.#readOwnerRecord(runId);
      if (ownerBeforePublish !== undefined) {
        if (isProcessAlive(ownerBeforePublish.pid)) {
          throw ownershipConflict(runId, ownerBeforePublish.pid, intent);
        }
        await this.#retireOwner(runId, runDirectory, ownerDirectory);
      }

      for (let attempt = 0; attempt < 16; attempt += 1) {
        try {
          await rename(candidateDirectory, ownerDirectory);
          published = true;
          await syncDirectory(runDirectory);
          return token;
        } catch (error) {
          if (!isRenameCollision(error)) {
            throw error;
          }
        }

        const currentOwner = await this.#readOwnerRecord(runId);
        if (currentOwner === undefined) {
          continue;
        }
        if (isProcessAlive(currentOwner.pid)) {
          throw ownershipConflict(runId, currentOwner.pid, intent);
        }

        await this.#retireOwner(runId, runDirectory, ownerDirectory);
      }

      throw new RunStoreError(
        "not_owner",
        `run "${runId}" ownership changed repeatedly; recovery was refused`,
      );
    } catch (error) {
      if (error instanceof RunStoreError) {
        throw error;
      }
      throw new RunStoreError("io", `failed to acquire ownership of run "${runId}"`, {
        cause: error,
      });
    } finally {
      if (!published) {
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #releaseOwnership(runId: string, token: string): Promise<void> {
    const runDirectory = join(this.rootDirectory, runId);
    const ownerDirectory = this.#ownerDirectory(runId);
    const currentOwner = await this.#readOwnerRecord(runId);
    if (currentOwner === undefined) {
      return;
    }
    if (currentOwner.token !== token) {
      throw new RunStoreError(
        "not_owner",
        `run "${runId}" ownership no longer belongs to this store instance`,
      );
    }

    const retiredDirectory = join(runDirectory, `.owner-${randomUUID()}.released`);
    try {
      await rename(ownerDirectory, retiredDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw new RunStoreError("io", `failed to release ownership of run "${runId}"`, {
        cause: error,
      });
    }
    try {
      await syncDirectory(runDirectory);
      await rm(retiredDirectory, { recursive: true, force: true });
      await syncDirectory(runDirectory);
    } catch (error) {
      throw new RunStoreError("io", `failed to finalize ownership release for run "${runId}"`, {
        cause: error,
      });
    }
  }

  async #readOwnerRecord(runId: string): Promise<OwnerRecord | undefined> {
    const ownerDirectory = this.#ownerDirectory(runId);
    const path = join(ownerDirectory, "owner.json");
    let input: string | undefined;
    let missingMetadataError: NodeJS.ErrnoException | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        input = await readFile(path, "utf8");
        break;
      } catch (error) {
        if (!(isNodeError(error) && error.code === "ENOENT")) {
          throw new RunStoreError("io", `failed to read ownership for run "${runId}"`, {
            cause: error,
          });
        }
        missingMetadataError = error;
        try {
          await access(ownerDirectory);
        } catch (ownerError) {
          if (isNodeError(ownerError) && ownerError.code === "ENOENT") {
            return undefined;
          }
          throw new RunStoreError("io", `failed to inspect ownership for run "${runId}"`, {
            cause: ownerError,
          });
        }
      }
    }
    if (input === undefined) {
      throw new RunStoreError(
        "corrupt",
        `run "${runId}" has an ownership directory without metadata`,
        { cause: missingMetadataError },
      );
    }

    try {
      return ownerRecordSchema.parse(JSON.parse(input));
    } catch (error) {
      throw new RunStoreError("corrupt", `run "${runId}" has corrupt ownership metadata`, {
        cause: error,
      });
    }
  }

  async #retireOwner(runId: string, runDirectory: string, ownerDirectory: string): Promise<void> {
    const retiredDirectory = join(runDirectory, `.owner-${randomUUID()}.stale`);
    try {
      await rename(ownerDirectory, retiredDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw new RunStoreError("io", `failed to retire stale ownership for run "${runId}"`, {
        cause: error,
      });
    }
    await syncDirectory(runDirectory);
    await rm(retiredDirectory, { recursive: true, force: true });
    await syncDirectory(runDirectory);
  }
}

function validateCandidate(runId: string, state: RunState | undefined, event: RunEvent): RunState {
  try {
    return appendRunEvent(state, event);
  } catch (error) {
    if (error instanceof RunReplayError) {
      throw new RunStoreError(
        "corrupt",
        `refused invalid transition for run "${runId}": ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function validateReplay(runId: string, events: readonly RunEvent[]): RunState {
  try {
    const state = reduceRunEvents(events);
    if (state.runId !== runId) {
      throw new RunReplayError(
        0,
        `ledger run id "${state.runId}" does not match directory run id "${runId}"`,
      );
    }
    return state;
  } catch (error) {
    if (error instanceof RunReplayError) {
      throw new RunStoreError("corrupt", `run "${runId}" cannot be replayed: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function validateEventSize(runId: string, line: string, maxEventBytes: number): void {
  const size = Buffer.byteLength(line, "utf8");
  if (size > maxEventBytes) {
    throw new RunStoreError(
      "limit",
      `event for run "${runId}" is ${size} bytes; maximum is ${maxEventBytes}`,
    );
  }
}

async function createDurableDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let current = resolve(directory);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const created of missing) {
    await syncDirectory(created);
    await syncDirectory(dirname(created));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function isRenameCollision(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function ownershipConflict(
  runId: string,
  pid: number,
  intent: "fresh" | "recovery",
): RunStoreError {
  return intent === "fresh"
    ? new RunStoreError("run_exists", `run "${runId}" already exists or is being created`)
    : new RunStoreError("not_owner", `run "${runId}" is owned by live process ${pid}`);
}

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new RunStoreError("invalid_run_id", `invalid run id "${runId}"`);
  }
  return runId;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
