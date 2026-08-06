import { type FileHandle, mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseRunEvent,
  reduceRunEvents,
  RunReplayError,
  type RunEvent,
} from "../../domain/run/events.js";

export type RunStoreErrorCode =
  | "corrupt"
  | "invalid_run_id"
  | "io"
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

export class JsonlRunStore {
  readonly #appendTailByRun = new Map<string, Promise<void>>();
  readonly #ownedRuns = new Set<string>();

  constructor(readonly rootDirectory: string) {}

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
    validateCandidate(runId, [], event);
    const runDirectory = join(this.rootDirectory, runId);
    const path = this.#eventsPath(runId);

    try {
      await mkdir(runDirectory, { recursive: true, mode: 0o700 });
      await syncDirectoryChain(this.rootDirectory, 3);
      await syncDirectory(runDirectory);

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

      this.#ownedRuns.add(runId);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(runDirectory);
    } catch (error) {
      if (error instanceof RunStoreError) {
        throw error;
      }
      throw new RunStoreError("io", `failed to claim run "${runId}"`, { cause: error });
    }
  }

  async #appendOwned(event: RunEvent): Promise<void> {
    const runId = event.runId;
    if (!this.#ownedRuns.has(runId)) {
      throw new RunStoreError(
        "not_owner",
        `this store instance does not own run "${runId}"; resume is not supported`,
      );
    }

    const ledger = await this.#readCommitted(runId);
    const expectedSequence = (ledger.events.at(-1)?.sequence ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new RunStoreError(
        "sequence",
        `expected sequence ${expectedSequence} for run "${runId}", received ${event.sequence}`,
      );
    }
    validateCandidate(runId, ledger.events, event);

    const path = this.#eventsPath(runId);
    try {
      if (ledger.hasTornTail) {
        await truncate(path, ledger.committedBytes);
      }
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
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

function validateCandidate(runId: string, events: readonly RunEvent[], event: RunEvent): void {
  try {
    reduceRunEvents([...events, event]);
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

async function syncDirectoryChain(directory: string, depth: number): Promise<void> {
  let current = resolve(directory);
  for (let index = 0; index < depth; index += 1) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
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
