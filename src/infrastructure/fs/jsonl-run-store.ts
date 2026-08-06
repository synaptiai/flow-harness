import { access, type FileHandle, mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
}

export class JsonlRunStore {
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

  #eventsPath(runId: string): string {
    return join(this.rootDirectory, runId, "events.jsonl");
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

    try {
      await createDurableDirectory(runDirectory);

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
      });
    } catch (error) {
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
        `this store instance does not own run "${runId}"; resume is not supported`,
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

function validateReplay(runId: string, events: readonly RunEvent[]): void {
  try {
    reduceRunEvents(events);
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

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new RunStoreError("invalid_run_id", `invalid run id "${runId}"`);
  }
  return runId;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
