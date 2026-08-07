import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  appendAdmissionEvent,
  createAdmissionSnapshotEvent,
  parseAdmissionEvent,
  reduceAdmissionEvents,
  AdmissionStateError,
  type AdmissionEvent,
  type AdmissionState,
} from "../../supervisor/admission.js";

export const MAX_ADMISSION_EVENT_BYTES = 40 * 1024 * 1024;
export const MAX_ADMISSION_LEDGER_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ADMISSION_COMPACTION_TRANSITIONS = 4_096;

export type AdmissionStoreErrorCode =
  | "corrupt"
  | "io"
  | "limit"
  | "not_idle"
  | "not_open"
  | "policy_mismatch"
  | "unsafe_permissions";

export class AdmissionStoreError extends Error {
  override readonly name = "AdmissionStoreError";

  constructor(
    readonly code: AdmissionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface LedgerRead {
  readonly events: readonly AdmissionEvent[];
  readonly committedBytes: number;
  readonly hasTornTail: boolean;
}

interface OpenedAdmission {
  readonly state: AdmissionState;
  readonly committedBytes: number;
}

export class JsonlAdmissionStore {
  readonly runsDirectory: string;
  readonly controlDirectory: string;
  readonly ledgerPath: string;
  readonly #expectedUid: number;
  #opened: OpenedAdmission | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    runsDirectory: string,
    readonly maxEventBytes = MAX_ADMISSION_EVENT_BYTES,
    readonly maxLedgerBytes = MAX_ADMISSION_LEDGER_BYTES,
    readonly compactAfterTransitions = DEFAULT_ADMISSION_COMPACTION_TRANSITIONS,
  ) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
      throw new RangeError("maxEventBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxLedgerBytes) || maxLedgerBytes < maxEventBytes) {
      throw new RangeError("maxLedgerBytes must be a safe integer no smaller than maxEventBytes");
    }
    if (!Number.isSafeInteger(compactAfterTransitions) || compactAfterTransitions <= 0) {
      throw new RangeError("compactAfterTransitions must be a positive safe integer");
    }
    this.runsDirectory = resolve(runsDirectory);
    this.controlDirectory = join(this.runsDirectory, ".supervisor");
    this.ledgerPath = join(this.controlDirectory, "admission.jsonl");
    this.#expectedUid = currentUid();
  }

  get state(): AdmissionState {
    return this.#requireOpen().state;
  }

  async open(
    initializedInput: Extract<AdmissionEvent, { readonly type: "admission_initialized" }>,
  ): Promise<AdmissionState> {
    if (this.#opened !== undefined) {
      throw new AdmissionStoreError("not_open", "admission store is already open");
    }
    const parsed = parseAdmissionEvent(initializedInput);
    if (parsed.type !== "admission_initialized") {
      throw new AdmissionStoreError("corrupt", "admission store requires an initialization event");
    }
    const line = serializeRecord(parsed);
    validateRecordSize(line, this.maxEventBytes);

    await ensurePrivateDirectory(this.controlDirectory, this.#expectedUid);
    let handle: FileHandle | undefined;
    let created = false;
    try {
      try {
        handle = await open(
          this.ledgerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }

      if (created && handle !== undefined) {
        await writeAndSync(handle, line);
        handle = undefined;
        await syncDirectory(this.controlDirectory);
        const state = replayLedger([parsed]);
        this.#opened = { state, committedBytes: Buffer.byteLength(line, "utf8") };
        return state;
      }

      const ledger = await this.#readCommitted();
      const state = replayLedger(ledger.events);
      assertMatchingPolicy(state, parsed);
      if (ledger.hasTornTail) {
        await this.#truncateAndSync(ledger.committedBytes);
      }
      this.#opened = { state, committedBytes: ledger.committedBytes };
      return state;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (created) {
        await rm(this.ledgerPath, { force: true }).catch(() => undefined);
        await syncDirectory(this.controlDirectory).catch(() => undefined);
      }
      throw storeError("failed to open the admission ledger", error);
    }
  }

  append(event: AdmissionEvent): Promise<AdmissionState> {
    return this.#enqueue(async () => await this.#appendNow(event));
  }

  compact(at: string): Promise<AdmissionState> {
    return this.#enqueue(async () => await this.#compactNow(at));
  }

  retire(): Promise<string> {
    return this.#enqueue(async () => await this.#retireNow());
  }

  async read(): Promise<AdmissionState> {
    this.#requireOpen();
    const ledger = await this.#readCommitted();
    return replayLedger(ledger.events);
  }

  close(): void {
    this.#opened = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #appendNow(eventInput: AdmissionEvent): Promise<AdmissionState> {
    let opened = this.#requireOpen();
    let event: AdmissionEvent;
    let nextState: AdmissionState;
    try {
      event = parseAdmissionEvent(eventInput);
      nextState = appendAdmissionEvent(opened.state, event);
    } catch (error) {
      throw new AdmissionStoreError("corrupt", "refused an invalid admission transition", {
        cause: error,
      });
    }
    const line = serializeRecord(event);
    validateRecordSize(line, this.maxEventBytes);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (
      opened.state.events.length >= this.compactAfterTransitions ||
      opened.committedBytes + lineBytes > this.maxLedgerBytes
    ) {
      await this.#compactNow(event.at);
      opened = this.#requireOpen();
      try {
        nextState = appendAdmissionEvent(opened.state, event);
      } catch (error) {
        throw new AdmissionStoreError("corrupt", "refused an invalid admission transition", {
          cause: error,
        });
      }
    }
    if (opened.committedBytes + lineBytes > this.maxLedgerBytes) {
      throw new AdmissionStoreError(
        "limit",
        `compacted admission ledger would exceed ${this.maxLedgerBytes} bytes`,
      );
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(
        this.ledgerPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      await assertPrivateFile(handle, this.ledgerPath, this.#expectedUid, this.maxLedgerBytes);
      await handle.truncate(opened.committedBytes);
      await handle.writeFile(line, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#opened = {
        state: nextState,
        committedBytes: opened.committedBytes + lineBytes,
      };
      return nextState;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      throw storeError("failed to append the admission ledger", error);
    }
  }

  async #compactNow(at: string): Promise<AdmissionState> {
    const opened = this.#requireOpen();
    const snapshot = createAdmissionSnapshotEvent(opened.state, at);
    const line = serializeRecord(snapshot);
    validateRecordSize(line, this.maxEventBytes);
    const compacted = replayLedger([snapshot]);
    const pending = join(this.controlDirectory, `.admission.${randomUUID()}.pending`);
    let published = false;
    try {
      const handle = await open(
        pending,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await writeAndSync(handle, line);
      await rename(pending, this.ledgerPath);
      published = true;
      await syncDirectory(this.controlDirectory);
      this.#opened = { state: compacted, committedBytes: Buffer.byteLength(line, "utf8") };
      return compacted;
    } catch (error) {
      throw storeError("failed to compact the admission ledger", error);
    } finally {
      if (!published) {
        await rm(pending, { force: true }).catch(() => undefined);
      }
    }
  }

  async #retireNow(): Promise<string> {
    const opened = this.#requireOpen();
    if (
      Object.keys(opened.state.jobs).length !== 0 ||
      Object.keys(opened.state.rejections).length !== 0
    ) {
      throw new AdmissionStoreError(
        "not_idle",
        "admission policy cannot be retired while jobs or rejection commits remain pending",
      );
    }
    const retiredPath = join(
      this.controlDirectory,
      `admission.${opened.state.policyDigest.slice(0, 12)}.${opened.state.lastSequence}.${randomUUID()}.retired.jsonl`,
    );
    try {
      await rename(this.ledgerPath, retiredPath);
      await syncDirectory(this.controlDirectory);
      this.#opened = undefined;
      return retiredPath;
    } catch (error) {
      throw storeError("failed to retire the idle admission policy", error);
    }
  }

  async #readCommitted(): Promise<LedgerRead> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await assertPrivateFile(
        handle,
        this.ledgerPath,
        this.#expectedUid,
        this.maxLedgerBytes,
      );
      const contents = await handle.readFile();
      await handle.close();
      handle = undefined;
      const hasTornTail = metadata.size > 0 && contents.at(-1) !== 0x0a;
      const lastNewline = contents.lastIndexOf(0x0a);
      const committedBytes = hasTornTail ? lastNewline + 1 : contents.length;
      const committedText = contents.subarray(0, committedBytes).toString("utf8");
      const lines = committedText.length === 0 ? [] : committedText.slice(0, -1).split("\n");
      const events: AdmissionEvent[] = [];
      for (const [index, line] of lines.entries()) {
        if (line.length === 0) {
          throw new AdmissionStoreError(
            "corrupt",
            `admission ledger contains an empty record at line ${index + 1}`,
          );
        }
        if (Buffer.byteLength(line, "utf8") + 1 > this.maxEventBytes) {
          throw new AdmissionStoreError(
            "limit",
            `admission record at line ${index + 1} exceeds ${this.maxEventBytes} bytes`,
          );
        }
        try {
          events.push(parseAdmissionEvent(JSON.parse(line)));
        } catch (error) {
          throw new AdmissionStoreError(
            "corrupt",
            `admission ledger contains an invalid record at line ${index + 1}`,
            { cause: error },
          );
        }
      }
      return { events: Object.freeze(events), committedBytes, hasTornTail };
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      throw storeError("failed to read the admission ledger", error);
    }
  }

  async #truncateAndSync(size: number): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.ledgerPath, constants.O_WRONLY | constants.O_NOFOLLOW);
      await assertPrivateFile(handle, this.ledgerPath, this.#expectedUid, this.maxLedgerBytes);
      await handle.truncate(size);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      throw storeError("failed to repair the admission ledger tail", error);
    }
  }

  #requireOpen(): OpenedAdmission {
    if (this.#opened === undefined) {
      throw new AdmissionStoreError("not_open", "admission store is not open");
    }
    return this.#opened;
  }
}

function replayLedger(events: readonly AdmissionEvent[]): AdmissionState {
  try {
    return reduceAdmissionEvents(events);
  } catch (error) {
    throw new AdmissionStoreError("corrupt", "admission ledger cannot be replayed", {
      cause: error,
    });
  }
}

function assertMatchingPolicy(
  state: AdmissionState,
  initialized: Extract<AdmissionEvent, { readonly type: "admission_initialized" }>,
): void {
  if (
    state.policyDigest !== initialized.policyDigest ||
    state.limits.maxActiveWorkers !== initialized.limits.maxActiveWorkers ||
    state.limits.maxQueuedJobs !== initialized.limits.maxQueuedJobs
  ) {
    throw new AdmissionStoreError(
      "policy_mismatch",
      `admission ledger policy ${state.policyDigest} does not match requested policy ${initialized.policyDigest}`,
    );
  }
}

function serializeRecord(event: AdmissionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function validateRecordSize(line: string, maxEventBytes: number): void {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > maxEventBytes) {
    throw new AdmissionStoreError(
      "limit",
      `admission record is ${bytes} bytes; maximum is ${maxEventBytes}`,
    );
  }
}

async function ensurePrivateDirectory(directory: string, expectedUid: number): Promise<void> {
  const parent = dirname(directory);
  const before = await optionalLstat(directory);
  if (before?.isSymbolicLink() === true) {
    throw new AdmissionStoreError(
      "unsafe_permissions",
      `private directory "${directory}" must not be a symbolic link`,
    );
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid) {
    throw new AdmissionStoreError(
      "unsafe_permissions",
      `private directory "${directory}" must be a real directory owned by uid ${expectedUid}`,
    );
  }
  await chmod(directory, 0o700);
  if (before === null) {
    await syncDirectory(directory);
    await syncDirectory(parent);
  }
}

async function assertPrivateFile(
  handle: FileHandle,
  path: string,
  expectedUid: number,
  maxBytes: number,
) {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0) {
    throw new AdmissionStoreError(
      "unsafe_permissions",
      `admission ledger "${path}" must be an owner-only regular file`,
    );
  }
  if (metadata.size > maxBytes) {
    throw new AdmissionStoreError(
      "limit",
      `admission ledger is ${metadata.size} bytes; maximum is ${maxBytes}`,
    );
  }
  return metadata;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeAndSync(handle: FileHandle, contents: string): Promise<void> {
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new AdmissionStoreError(
      "unsafe_permissions",
      "durable admission requires a POSIX user id",
    );
  }
  return uid;
}

function storeError(message: string, cause: unknown): AdmissionStoreError {
  if (cause instanceof AdmissionStoreError) {
    return cause;
  }
  if (cause instanceof AdmissionStateError) {
    return new AdmissionStoreError("corrupt", message, { cause });
  }
  return new AdmissionStoreError("io", message, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
