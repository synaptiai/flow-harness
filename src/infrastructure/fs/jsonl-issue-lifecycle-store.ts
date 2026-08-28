import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants, type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";

import { z } from "zod";

import type {
  IssueLifecycleEventPage,
  IssueLifecycleEventPageRequest,
  IssueLifecycleStore,
} from "../../application/issue-lifecycle-store.js";
import {
  createInitialIssueLifecycleState,
  ISSUE_LIFECYCLE_TERMINAL_PHASES,
  type IssueLifecycleEvent,
  type IssueLifecycleState,
  parseIssueLifecycleEvent,
  reduceIssueLifecycleEvent,
} from "../../domain/issue-lifecycle/events.js";

export const MAX_ISSUE_LIFECYCLE_EVENT_BYTES = 64 * 1024;
export const MAX_ISSUE_LIFECYCLE_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_ISSUE_LIFECYCLE_EVENTS = 16_384;
export const MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE = 100;
const MAX_OWNER_RECORD_BYTES = 4_096;
const OWNERSHIP_WITNESS_HOST = "127.0.0.1" as const;
const OWNERSHIP_WITNESS_PROBE_TIMEOUT_MS = 500;
const MAX_OWNERSHIP_WITNESS_RESPONSE_BYTES = 128;

export type IssueLifecycleStoreErrorCode =
  | "corrupt"
  | "invalid_page"
  | "invalid_run_id"
  | "io"
  | "limit"
  | "not_found"
  | "not_owner"
  | "run_exists"
  | "sequence"
  | "unsafe_path";

export class IssueLifecycleStoreError extends Error {
  override readonly name = "IssueLifecycleStoreError";

  constructor(
    readonly code: IssueLifecycleStoreErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Issue lifecycle store failed: ${code}`, options);
  }
}

export interface JsonlIssueLifecycleStoreOptions {
  readonly maxEventBytes?: number;
  readonly maxLedgerBytes?: number;
  readonly maxEvents?: number;
  readonly maxPageSize?: number;
  readonly ownershipWitness?: IssueLifecycleOwnershipWitnessAdapter;
}

export interface IssueLifecycleOwnershipWitnessRecord {
  readonly host: typeof OWNERSHIP_WITNESS_HOST;
  readonly port: number;
}

export type IssueLifecycleOwnershipWitnessProbe = "live" | "dead" | "ambiguous";

export interface IssueLifecycleOwnershipWitnessHandle {
  readonly token: string;
  readonly record: IssueLifecycleOwnershipWitnessRecord;
  isOpen(): boolean;
  close(): Promise<void>;
}

export interface IssueLifecycleOwnershipWitnessAdapter {
  acquire(token: string): Promise<IssueLifecycleOwnershipWitnessHandle>;
  probe(
    record: IssueLifecycleOwnershipWitnessRecord,
    token: string,
  ): Promise<IssueLifecycleOwnershipWitnessProbe>;
}

interface LedgerRead {
  readonly events: readonly IssueLifecycleEvent[];
  readonly state: IssueLifecycleState;
  readonly committedBytes: number;
  readonly hasTornTail: boolean;
}

interface OwnedRun {
  readonly state: IssueLifecycleState;
  readonly committedBytes: number;
  readonly ownerToken: string;
  readonly witness: IssueLifecycleOwnershipWitnessHandle;
}

interface OwnerRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: string;
  readonly witness: IssueLifecycleOwnershipWitnessRecord;
}

const ownerRecordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().safe(),
    token: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
    witness: z
      .object({
        host: z.literal(OWNERSHIP_WITNESS_HOST),
        port: z.number().int().positive().max(65_535),
      })
      .strict(),
  })
  .strict();

export class JsonlIssueLifecycleStore implements IssueLifecycleStore {
  readonly rootDirectory: string;
  readonly maxEventBytes: number;
  readonly maxLedgerBytes: number;
  readonly maxEvents: number;
  readonly maxPageSize: number;
  readonly #operationTailByRun = new Map<string, Promise<void>>();
  readonly #ownedRuns = new Map<string, OwnedRun>();
  readonly #ownershipWitness: IssueLifecycleOwnershipWitnessAdapter;

  constructor(rootDirectory: string, options: JsonlIssueLifecycleStoreOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.maxEventBytes = boundedLimit(
      options.maxEventBytes ?? MAX_ISSUE_LIFECYCLE_EVENT_BYTES,
      MAX_ISSUE_LIFECYCLE_EVENT_BYTES,
      "maxEventBytes",
    );
    this.maxLedgerBytes = boundedLimit(
      options.maxLedgerBytes ?? MAX_ISSUE_LIFECYCLE_LEDGER_BYTES,
      MAX_ISSUE_LIFECYCLE_LEDGER_BYTES,
      "maxLedgerBytes",
    );
    this.maxEvents = boundedLimit(
      options.maxEvents ?? MAX_ISSUE_LIFECYCLE_EVENTS,
      MAX_ISSUE_LIFECYCLE_EVENTS,
      "maxEvents",
    );
    this.maxPageSize = boundedLimit(
      options.maxPageSize ?? MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE,
      MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE,
      "maxPageSize",
    );
    this.#ownershipWitness = options.ownershipWitness ?? new LoopbackOwnershipWitnessAdapter();
    if (this.maxLedgerBytes < this.maxEventBytes) {
      throw new RangeError("maxLedgerBytes must be no smaller than maxEventBytes");
    }
  }

  append(eventInput: IssueLifecycleEvent): Promise<void> {
    const runId = validateRunId(eventInput.runId);
    let event: IssueLifecycleEvent;
    try {
      event = parseIssueLifecycleEvent(eventInput);
    } catch (error) {
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
    return this.#serialize(runId, async () => await this.#appendNow(event));
  }

  async claim(runIdInput: string): Promise<readonly IssueLifecycleEvent[]> {
    const runId = validateRunId(runIdInput);
    return await this.#serialize(runId, async () => await this.#claimNow(runId));
  }

  async release(runIdInput: string): Promise<void> {
    const runId = validateRunId(runIdInput);
    await this.#serialize(runId, async () => {
      const owned = this.#ownedRuns.get(runId);
      if (owned === undefined) return;
      try {
        await this.#releaseOwnership(runId, owned);
      } finally {
        this.#ownedRuns.delete(runId);
        await owned.witness.close();
      }
    });
  }

  async exists(runIdInput: string): Promise<boolean> {
    const runId = validateRunId(runIdInput);
    try {
      await this.#assertRunDirectory(runId);
      const handle = await this.#openSafeRecord(runId, constants.O_RDONLY);
      await handle.close();
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      if (error instanceof IssueLifecycleStoreError) throw error;
      throw new IssueLifecycleStoreError("io", { cause: error });
    }
  }

  async read(runIdInput: string): Promise<readonly IssueLifecycleEvent[]> {
    const runId = validateRunId(runIdInput);
    const ledger = await this.#readCommitted(runId);
    return Object.freeze([...ledger.events]);
  }

  async readPage(request: IssueLifecycleEventPageRequest): Promise<IssueLifecycleEventPage> {
    const runId = validateRunId(request.runId);
    if (
      !Number.isSafeInteger(request.afterSequence) ||
      request.afterSequence < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit <= 0 ||
      request.limit > this.maxPageSize
    ) {
      throw new IssueLifecycleStoreError("invalid_page");
    }
    const ledger = await this.#readCommitted(runId);
    if (request.afterSequence > ledger.state.sequence) {
      throw new IssueLifecycleStoreError("invalid_page");
    }
    const events = ledger.events
      .filter((event) => event.sequence > request.afterSequence)
      .slice(0, request.limit);
    const cursor = events.at(-1)?.sequence ?? request.afterSequence;
    const hasMore = cursor < ledger.state.sequence;
    const terminal =
      !hasMore && ISSUE_LIFECYCLE_TERMINAL_PHASES.includes(ledger.state.phase as never);
    return Object.freeze({
      events: Object.freeze([...events]),
      cursor,
      hasMore,
      terminal,
    });
  }

  #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTailByRun.get(runId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#operationTailByRun.set(runId, tail);
    return result.finally(() => {
      if (this.#operationTailByRun.get(runId) === tail) this.#operationTailByRun.delete(runId);
    });
  }

  async #appendNow(event: IssueLifecycleEvent): Promise<void> {
    if (event.sequence === 1) {
      await this.#createAndAppend(event);
      return;
    }
    await this.#appendOwned(event);
  }

  async #createAndAppend(event: IssueLifecycleEvent): Promise<void> {
    const runId = event.runId;
    const nextState = validateCandidate(undefined, event);
    const line = serializeEvent(event);
    this.#validateAppend(1, 0, line);
    await ensureStorageRoot(this.rootDirectory);
    const runDirectory = this.#runDirectory(runId);
    const ownerToken = randomUUID();
    let witness: IssueLifecycleOwnershipWitnessHandle | undefined;
    const stagingDirectory = join(this.rootDirectory, `.${runId}-${ownerToken}.pending`);
    let published = false;
    try {
      await assertRunIdentityAvailable(runDirectory);
      witness = await this.#ownershipWitness.acquire(ownerToken);
      await mkdir(stagingDirectory, { mode: 0o700 });
      const ownerDirectory = join(stagingDirectory, ".owner");
      await mkdir(ownerDirectory, { mode: 0o700 });
      const ownerRecord: OwnerRecord = {
        version: 1,
        pid: process.pid,
        token: ownerToken,
        acquiredAt: new Date().toISOString(),
        witness: witness.record,
      };
      await writeDurablePrivateFile(
        join(ownerDirectory, "owner.json"),
        `${JSON.stringify(ownerRecord)}\n`,
      );
      await syncDirectory(ownerDirectory);
      await writeDurablePrivateFile(join(stagingDirectory, "events.jsonl"), line);
      await syncDirectory(stagingDirectory);
      try {
        await rename(stagingDirectory, runDirectory);
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        await classifyExistingRunDirectory(runDirectory);
        throw new IssueLifecycleStoreError("run_exists", { cause: error });
      }
      published = true;
      this.#ownedRuns.set(runId, {
        state: nextState,
        committedBytes: Buffer.byteLength(line, "utf8"),
        ownerToken,
        witness,
      });
      await syncDirectory(this.rootDirectory);
    } catch (error) {
      this.#ownedRuns.delete(runId);
      await witness?.close().catch(() => undefined);
      if (!published) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storeError(error);
    }
  }

  async #appendOwned(event: IssueLifecycleEvent): Promise<void> {
    const runId = event.runId;
    const owned = this.#ownedRuns.get(runId);
    if (owned === undefined) throw new IssueLifecycleStoreError("not_owner");
    if (event.sequence !== owned.state.sequence + 1) {
      throw new IssueLifecycleStoreError("sequence");
    }
    const nextState = validateCandidate(owned.state, event);
    const line = serializeEvent(event);
    this.#validateAppend(owned.state.sequence + 1, owned.committedBytes, line);
    await this.#assertOwnership(runId, owned);
    try {
      const handle = await this.#openSafeRecord(runId, constants.O_WRONLY | constants.O_APPEND);
      try {
        this.#assertLocalWitness(owned);
        await handle.truncate(owned.committedBytes);
        this.#assertLocalWitness(owned);
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#ownedRuns.set(runId, {
        state: nextState,
        committedBytes: owned.committedBytes + Buffer.byteLength(line, "utf8"),
        ownerToken: owned.ownerToken,
        witness: owned.witness,
      });
    } catch (error) {
      throw storeError(error);
    }
  }

  async #claimNow(runId: string): Promise<readonly IssueLifecycleEvent[]> {
    const alreadyOwned = this.#ownedRuns.get(runId);
    if (alreadyOwned !== undefined) {
      await this.#assertOwnership(runId, alreadyOwned);
      const ledger = await this.#readCommitted(runId);
      await this.#repairTornTail(runId, ledger);
      this.#ownedRuns.set(runId, {
        state: ledger.state,
        committedBytes: ledger.committedBytes,
        ownerToken: alreadyOwned.ownerToken,
        witness: alreadyOwned.witness,
      });
      return Object.freeze([...ledger.events]);
    }

    await this.#assertLedgerExists(runId);
    const ownership = await this.#acquireOwnership(runId);
    try {
      const ledger = await this.#readCommitted(runId);
      await this.#repairTornTail(runId, ledger);
      this.#ownedRuns.set(runId, {
        state: ledger.state,
        committedBytes: ledger.committedBytes,
        ownerToken: ownership.token,
        witness: ownership,
      });
      return Object.freeze([...ledger.events]);
    } catch (error) {
      await this.#abandonOwnership(runId, ownership);
      throw error;
    }
  }

  async #readCommitted(runId: string): Promise<LedgerRead> {
    let handle: FileHandle;
    try {
      await this.#assertRunDirectory(runId);
      handle = await this.#openSafeRecord(runId, constants.O_RDONLY);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("not_found", { cause: error });
      }
      throw storeError(error);
    }

    let contents: Buffer;
    try {
      const metadata = await handle.stat();
      if (metadata.size > this.maxLedgerBytes + this.maxEventBytes) {
        throw new IssueLifecycleStoreError("limit");
      }
      contents = await handle.readFile();
    } catch (error) {
      throw storeError(error);
    } finally {
      await handle.close();
    }

    const hasTornTail = contents.length > 0 && contents.at(-1) !== 0x0a;
    const lastNewline = contents.lastIndexOf(0x0a);
    const committedBytes = hasTornTail ? lastNewline + 1 : contents.length;
    if (committedBytes > this.maxLedgerBytes) throw new IssueLifecycleStoreError("limit");
    const committed = contents.subarray(0, committedBytes).toString("utf8");
    const lines = committed.length === 0 ? [] : committed.slice(0, -1).split("\n");
    if (lines.length > this.maxEvents) throw new IssueLifecycleStoreError("limit");

    const events: IssueLifecycleEvent[] = [];
    for (const line of lines) {
      if (line.length === 0) throw new IssueLifecycleStoreError("corrupt");
      if (Buffer.byteLength(`${line}\n`, "utf8") > this.maxEventBytes) {
        throw new IssueLifecycleStoreError("limit");
      }
      try {
        events.push(parseIssueLifecycleEvent(JSON.parse(line)));
      } catch (error) {
        throw new IssueLifecycleStoreError("corrupt", { cause: error });
      }
    }
    const state = validateReplay(runId, events);
    return {
      events: Object.freeze(events),
      state,
      committedBytes,
      hasTornTail,
    };
  }

  async #repairTornTail(runId: string, ledger: LedgerRead): Promise<void> {
    if (!ledger.hasTornTail) return;
    const handle = await this.#openSafeRecord(runId, constants.O_WRONLY);
    try {
      await handle.truncate(ledger.committedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #validateAppend(eventCount: number, committedBytes: number, line: string): void {
    const eventBytes = Buffer.byteLength(line, "utf8");
    if (
      eventBytes > this.maxEventBytes ||
      committedBytes + eventBytes > this.maxLedgerBytes ||
      eventCount > this.maxEvents
    ) {
      throw new IssueLifecycleStoreError("limit");
    }
  }

  async #assertLedgerExists(runId: string): Promise<void> {
    try {
      await this.#assertRunDirectory(runId);
      const handle = await this.#openSafeRecord(runId, constants.O_RDONLY);
      await handle.close();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("not_found", { cause: error });
      }
      throw storeError(error);
    }
  }

  async #openSafeRecord(runId: string, flags: number): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await openNoFollow(this.#eventsPath(runId), flags);
    } catch (error) {
      if (isUnsafeLinkError(error)) {
        throw new IssueLifecycleStoreError("unsafe_path", { cause: error });
      }
      throw error;
    }
    try {
      await validateRecordHandle(handle);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #acquireOwnership(runId: string): Promise<IssueLifecycleOwnershipWitnessHandle> {
    const runDirectory = this.#runDirectory(runId);
    await this.#assertRunDirectory(runId);
    const ownerDirectory = this.#ownerDirectory(runId);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.#readOwnerRecordIfPresent(runId);
      if (current !== undefined) {
        const probe = await this.#probeOwnershipWitness(current);
        if (probe !== "dead") throw new IssueLifecycleStoreError("not_owner");
        await this.#tryRetireStaleOwnership(runId, current);
        continue;
      }

      const token = randomUUID();
      const candidateDirectory = join(runDirectory, `.owner-${token}.pending`);
      let witness: IssueLifecycleOwnershipWitnessHandle | undefined;
      let published = false;
      try {
        witness = await this.#ownershipWitness.acquire(token);
        const record: OwnerRecord = {
          version: 1,
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
          witness: witness.record,
        };
        await mkdir(candidateDirectory, { mode: 0o700 });
        await writeDurablePrivateFile(
          join(candidateDirectory, "owner.json"),
          `${JSON.stringify(record)}\n`,
        );
        await syncDirectory(candidateDirectory);
        try {
          await rename(candidateDirectory, ownerDirectory);
          published = true;
          await syncDirectory(runDirectory);
          return witness;
        } catch (error) {
          if (!isRenameCollision(error)) throw error;
        }
      } catch (error) {
        throw storeError(error);
      } finally {
        if (!published) {
          await witness?.close().catch(() => undefined);
          await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    throw new IssueLifecycleStoreError("not_owner");
  }

  async #assertOwnership(runId: string, owned: OwnedRun): Promise<void> {
    this.#assertLocalWitness(owned);
    const current = await this.#readOwnerRecord(runId);
    if (
      current.token !== owned.ownerToken ||
      current.pid !== process.pid ||
      !sameWitness(current.witness, owned.witness.record)
    ) {
      throw new IssueLifecycleStoreError("not_owner");
    }
    this.#assertLocalWitness(owned);
  }

  #assertLocalWitness(owned: OwnedRun): void {
    if (!owned.witness.isOpen()) throw new IssueLifecycleStoreError("not_owner");
  }

  async #releaseOwnership(runId: string, owned: OwnedRun): Promise<void> {
    await this.#assertOwnership(runId, owned);
    await this.#retireOwnership(runId, "released");
  }

  async #abandonOwnership(
    runId: string,
    witness: IssueLifecycleOwnershipWitnessHandle,
  ): Promise<void> {
    try {
      const current = await this.#readOwnerRecordIfPresent(runId).catch(() => undefined);
      if (
        current?.token === witness.token &&
        current.pid === process.pid &&
        sameWitness(current.witness, witness.record)
      ) {
        await this.#retireOwnership(runId, "released").catch(() => undefined);
      }
    } finally {
      await witness.close().catch(() => undefined);
    }
  }

  async #probeOwnershipWitness(owner: OwnerRecord): Promise<IssueLifecycleOwnershipWitnessProbe> {
    try {
      return await this.#ownershipWitness.probe(owner.witness, owner.token);
    } catch {
      return "ambiguous";
    }
  }

  async #tryRetireStaleOwnership(runId: string, stale: OwnerRecord): Promise<boolean> {
    const current = await this.#readOwnerRecordIfPresent(runId);
    if (current === undefined || !sameOwner(current, stale)) return false;
    const runDirectory = this.#runDirectory(runId);
    const retiredDirectory = join(runDirectory, `.owner-${stale.token}.stale`);
    try {
      await rename(this.#ownerDirectory(runId), retiredDirectory);
      await syncDirectory(runDirectory);
      return true;
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || isRenameCollision(error))) {
        return false;
      }
      throw storeError(error);
    }
  }

  async #retireOwnership(runId: string, suffix: "released"): Promise<void> {
    const runDirectory = this.#runDirectory(runId);
    const retiredDirectory = join(runDirectory, `.owner-${randomUUID()}.${suffix}`);
    try {
      await rename(this.#ownerDirectory(runId), retiredDirectory);
      await syncDirectory(runDirectory);
      await rm(retiredDirectory, { recursive: true, force: true });
      await syncDirectory(runDirectory);
    } catch (error) {
      throw storeError(error);
    }
  }

  async #readOwnerRecordIfPresent(runId: string): Promise<OwnerRecord | undefined> {
    try {
      await lstat(this.#ownerDirectory(runId));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw storeError(error);
    }
    return await this.#readOwnerRecord(runId);
  }

  async #readOwnerRecord(runId: string): Promise<OwnerRecord> {
    const ownerDirectory = this.#ownerDirectory(runId);
    try {
      await this.#assertRunDirectory(runId);
      await assertSafeDirectory(ownerDirectory, "unsafe_path");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("corrupt", { cause: error });
      }
      throw storeError(error);
    }
    let handle: FileHandle;
    try {
      handle = await openNoFollow(join(ownerDirectory, "owner.json"), constants.O_RDONLY);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("corrupt", { cause: error });
      }
      if (isUnsafeLinkError(error)) {
        throw new IssueLifecycleStoreError("unsafe_path", { cause: error });
      }
      throw storeError(error);
    }
    try {
      const metadata = await validateRecordHandle(handle);
      if (metadata.size > MAX_OWNER_RECORD_BYTES) {
        throw new IssueLifecycleStoreError("limit");
      }
      const parsed = ownerRecordSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    } catch (error) {
      if (error instanceof IssueLifecycleStoreError) throw error;
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    } finally {
      await handle.close();
    }
  }

  #runDirectory(runId: string): string {
    return join(this.rootDirectory, runId);
  }

  #eventsPath(runId: string): string {
    return join(this.#runDirectory(runId), "events.jsonl");
  }

  #ownerDirectory(runId: string): string {
    return join(this.#runDirectory(runId), ".owner");
  }

  async #assertRunDirectory(runId: string): Promise<void> {
    await assertSafeStorageRoot(this.rootDirectory);
    await assertSafeDirectory(this.#runDirectory(runId), "unsafe_path");
  }
}

function validateCandidate(
  state: IssueLifecycleState | undefined,
  event: IssueLifecycleEvent,
): IssueLifecycleState {
  try {
    const current = state ?? createInitialIssueLifecycleState(event.runId, event.at);
    return reduceIssueLifecycleEvent(current, event);
  } catch (error) {
    throw new IssueLifecycleStoreError("corrupt", { cause: error });
  }
}

function validateReplay(
  runId: string,
  events: readonly IssueLifecycleEvent[],
): IssueLifecycleState {
  const first = events[0];
  if (first === undefined || first.runId !== runId) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  let state = createInitialIssueLifecycleState(runId, first.at);
  try {
    for (const event of events) state = reduceIssueLifecycleEvent(state, event);
    return state;
  } catch (error) {
    throw new IssueLifecycleStoreError("corrupt", { cause: error });
  }
}

function serializeEvent(event: IssueLifecycleEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function validateRunId(runId: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(runId) || runId.length > 128) {
    throw new IssueLifecycleStoreError("invalid_run_id");
  }
  return runId;
}

async function ensureStorageRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700, recursive: true });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw storeError(error);
  }
  await assertSafeStorageRoot(path);
}

async function assertSafeStorageRoot(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new IssueLifecycleStoreError("unsafe_path");
  }
  validateOwner(metadata);
  if ((metadata.mode & 0o022) !== 0) throw new IssueLifecycleStoreError("unsafe_path");
}

async function classifyExistingRunDirectory(path: string): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw storeError(error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new IssueLifecycleStoreError("unsafe_path");
  }
  validateOwnerAndMode(metadata, 0o700);
}

async function assertRunIdentityAvailable(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw storeError(error);
  }
  await classifyExistingRunDirectory(path);
  throw new IssueLifecycleStoreError("run_exists");
}

async function assertSafeDirectory(
  path: string,
  errorCode: Extract<IssueLifecycleStoreErrorCode, "unsafe_path">,
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new IssueLifecycleStoreError(errorCode);
  }
  validateOwnerAndMode(metadata, 0o700);
}

async function validateRecordHandle(handle: FileHandle): Promise<Stats> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new IssueLifecycleStoreError("unsafe_path");
  }
  validateOwnerAndMode(metadata, 0o600);
  return metadata;
}

function validateOwner(metadata: Stats): void {
  const getuid = process.getuid;
  if (getuid !== undefined && metadata.uid !== getuid()) {
    throw new IssueLifecycleStoreError("unsafe_path");
  }
}

function validateOwnerAndMode(metadata: Stats, expectedMode: number): void {
  validateOwner(metadata);
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new IssueLifecycleStoreError("unsafe_path");
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
    await validateRecordHandle(handle);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
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

function boundedLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function storeError(error: unknown): IssueLifecycleStoreError {
  return error instanceof IssueLifecycleStoreError
    ? error
    : new IssueLifecycleStoreError("io", { cause: error });
}

const localOwnershipWitnesses = new Map<string, LoopbackOwnershipWitnessHandle>();

class LoopbackOwnershipWitnessAdapter implements IssueLifecycleOwnershipWitnessAdapter {
  async acquire(token: string): Promise<IssueLifecycleOwnershipWitnessHandle> {
    if (localOwnershipWitnesses.has(token)) {
      throw new IssueLifecycleStoreError("io");
    }
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.on("error", () => undefined);
      socket.setTimeout(OWNERSHIP_WITNESS_PROBE_TIMEOUT_MS, () => socket.destroy());
      socket.end(`${token}\n`, "utf8");
    });
    const record = await listenForOwnershipWitness(server).catch(async (error: unknown) => {
      await closeWitnessServer(server, connections);
      throw error;
    });
    const handle = new LoopbackOwnershipWitnessHandle(token, record, server, connections);
    localOwnershipWitnesses.set(token, handle);
    server.once("close", () => handle.markClosed());
    server.on("error", () => undefined);
    server.unref();
    return handle;
  }

  async probe(
    record: IssueLifecycleOwnershipWitnessRecord,
    token: string,
  ): Promise<IssueLifecycleOwnershipWitnessProbe> {
    const local = localOwnershipWitnesses.get(token);
    if (local !== undefined) {
      return local.isOpen() && sameWitness(local.record, record) ? "live" : "ambiguous";
    }
    return await probeOwnershipWitness(record, token);
  }
}

class LoopbackOwnershipWitnessHandle implements IssueLifecycleOwnershipWitnessHandle {
  #open = true;
  readonly #server: Server;
  readonly #connections: Set<Socket>;

  constructor(
    readonly token: string,
    readonly record: IssueLifecycleOwnershipWitnessRecord,
    server: Server,
    connections: Set<Socket>,
  ) {
    this.#server = server;
    this.#connections = connections;
  }

  isOpen(): boolean {
    return this.#open && this.#server.listening;
  }

  markClosed(): void {
    this.#open = false;
    if (localOwnershipWitnesses.get(this.token) === this) {
      localOwnershipWitnesses.delete(this.token);
    }
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    this.markClosed();
    await closeWitnessServer(this.#server, this.#connections);
  }
}

async function listenForOwnershipWitness(
  server: Server,
): Promise<IssueLifecycleOwnershipWitnessRecord> {
  return await new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ host: OWNERSHIP_WITNESS_HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Ownership witness did not bind an IP endpoint"));
        return;
      }
      resolveListen({ host: OWNERSHIP_WITNESS_HOST, port: address.port });
    });
  });
}

async function closeWitnessServer(server: Server, connections: Set<Socket>): Promise<void> {
  for (const socket of connections) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function probeOwnershipWitness(
  record: IssueLifecycleOwnershipWitnessRecord,
  token: string,
): Promise<IssueLifecycleOwnershipWitnessProbe> {
  return await new Promise((resolveProbe) => {
    let response = Buffer.alloc(0);
    let settled = false;
    const socket = createConnection({ host: record.host, port: record.port });
    const timeout = setTimeout(() => finish("ambiguous"), OWNERSHIP_WITNESS_PROBE_TIMEOUT_MS);
    timeout.unref();

    const finish = (result: IssueLifecycleOwnershipWitnessProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(result);
    };

    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_OWNERSHIP_WITNESS_RESPONSE_BYTES) finish("ambiguous");
    });
    socket.once("end", () => {
      finish(response.equals(Buffer.from(`${token}\n`, "utf8")) ? "live" : "ambiguous");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "dead" : "ambiguous");
    });
  });
}

function sameWitness(
  left: IssueLifecycleOwnershipWitnessRecord,
  right: IssueLifecycleOwnershipWitnessRecord,
): boolean {
  return left.host === right.host && left.port === right.port;
}

function sameOwner(left: OwnerRecord, right: OwnerRecord): boolean {
  return (
    left.version === right.version &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.acquiredAt === right.acquiredAt &&
    sameWitness(left.witness, right.witness)
  );
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
