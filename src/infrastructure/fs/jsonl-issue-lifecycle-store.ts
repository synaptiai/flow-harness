import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";

import { z } from "zod";

import type {
  IssueLifecycleCommandRecord,
  IssueLifecycleCommandRecordInput,
  IssueLifecycleCommandSettlement,
  IssueLifecycleEventPage,
  IssueLifecycleEventPageRequest,
  IssueLifecycleRunInitialization,
  IssueLifecycleStore,
} from "../../application/issue-lifecycle-store.js";
import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../../domain/issue-lifecycle/commands.js";
import {
  createInitialIssueLifecycleState,
  ISSUE_LIFECYCLE_TERMINAL_PHASES,
  type IssueLifecycleEvent,
  type IssueLifecycleState,
  parseIssueLifecycleEvent,
  reduceIssueLifecycleEvent,
} from "../../domain/issue-lifecycle/events.js";
import {
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type FrozenIssueRunManifest,
  type IssuePrivateBlobInput,
  type IssuePrivateBlobReference,
  parseIssuePrivateBlobReference,
  parseIssuePrivateManifest,
  verifyIssuePrivateBlob,
} from "../../domain/issue-lifecycle/private-manifest.js";

export const MAX_ISSUE_LIFECYCLE_EVENT_BYTES = 64 * 1024;
export const MAX_ISSUE_LIFECYCLE_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_ISSUE_LIFECYCLE_EVENTS = 16_384;
export const MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE = 100;
export const MAX_ISSUE_PRIVATE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_ISSUE_PRIVATE_BLOB_BYTES = 32 * 1024 * 1024;
export const MAX_ISSUE_PRIVATE_BLOBS = 4_096;
export const MAX_ISSUE_PRIVATE_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_ISSUE_COMMAND_BYTES = 64 * 1024;
export const MAX_ISSUE_COMMANDS = 4_096;
const MAX_OWNER_RECORD_BYTES = 4_096;
const OWNERSHIP_WITNESS_HOST = "127.0.0.1" as const;
const OWNERSHIP_WITNESS_PROBE_TIMEOUT_MS = 500;
const MAX_OWNERSHIP_WITNESS_RESPONSE_BYTES = 128;

export type IssueLifecycleStoreErrorCode =
  | "corrupt"
  | "command_conflict"
  | "command_not_found"
  | "invalid_page"
  | "invalid_run_id"
  | "io"
  | "limit"
  | "manifest_missing"
  | "not_found"
  | "not_owner"
  | "run_exists"
  | "sequence"
  | "unsafe_path";

export type IssueLifecycleStorePublicationPoint =
  | "initialize_before_publish"
  | "initialize_after_publish"
  | "blob_before_publish"
  | "blob_after_publish"
  | "command_reservation_before_publish"
  | "command_reservation_after_publish"
  | "command_before_publish"
  | "command_after_publish"
  | "settlement_before_publish"
  | "settlement_after_publish";

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
  readonly maxManifestBytes?: number;
  readonly maxBlobBytes?: number;
  readonly maxBlobs?: number;
  readonly maxPrivateBytes?: number;
  readonly maxCommandBytes?: number;
  readonly maxCommands?: number;
  readonly ownershipWitness?: IssueLifecycleOwnershipWitnessAdapter;
  readonly publicationHook?: (
    point: IssueLifecycleStorePublicationPoint,
    identity: string,
  ) => void | Promise<void>;
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

const commandIdentifierSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const exactTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const commandSettlementSchema = z
  .object({
    version: z.literal(1),
    commandDigest: digestSchema,
    settledAt: exactTimestampSchema,
    outcome: z.enum(["completed", "failed", "rejected"]),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
      .optional(),
    resultDigest: digestSchema.optional(),
  })
  .strict()
  .superRefine((settlement, context) => {
    if (settlement.outcome === "completed" && settlement.code !== undefined) {
      context.addIssue({ code: "custom", path: ["code"], message: "completed cannot have code" });
    }
    if (settlement.outcome !== "completed" && settlement.code === undefined) {
      context.addIssue({ code: "custom", path: ["code"], message: "failure requires code" });
    }
  });
const commandReservationSchema = z
  .object({
    version: z.literal(1),
    commandId: commandIdentifierSchema,
    commandDigest: digestSchema,
  })
  .strict();

interface StoredCommandRequest {
  readonly version: 1;
  readonly runId: string;
  readonly recordedAt: string;
  readonly commandDigest: string;
  readonly command: ReturnType<typeof parseIssueLifecycleCommand>;
}

interface PreparedInitialization {
  readonly manifest: FrozenIssueRunManifest;
  readonly manifestContents: string;
  readonly blobs: readonly {
    readonly input: IssuePrivateBlobInput;
    readonly reference: IssuePrivateBlobReference;
  }[];
  readonly snapshot: IssueLifecycleEvent;
  readonly eventLine: string;
  readonly state: IssueLifecycleState;
  readonly command: IssueLifecycleCommandRecord;
  readonly commandContents: string;
}

export class JsonlIssueLifecycleStore implements IssueLifecycleStore {
  readonly rootDirectory: string;
  readonly maxEventBytes: number;
  readonly maxLedgerBytes: number;
  readonly maxEvents: number;
  readonly maxPageSize: number;
  readonly maxManifestBytes: number;
  readonly maxBlobBytes: number;
  readonly maxBlobs: number;
  readonly maxPrivateBytes: number;
  readonly maxCommandBytes: number;
  readonly maxCommands: number;
  readonly #operationTailByRun = new Map<string, Promise<void>>();
  readonly #ownedRuns = new Map<string, OwnedRun>();
  readonly #ownershipWitness: IssueLifecycleOwnershipWitnessAdapter;
  readonly #publicationHook:
    | ((point: IssueLifecycleStorePublicationPoint, identity: string) => void | Promise<void>)
    | undefined;

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
    this.maxManifestBytes = boundedLimit(
      options.maxManifestBytes ?? MAX_ISSUE_PRIVATE_MANIFEST_BYTES,
      MAX_ISSUE_PRIVATE_MANIFEST_BYTES,
      "maxManifestBytes",
    );
    this.maxBlobBytes = boundedLimit(
      options.maxBlobBytes ?? MAX_ISSUE_PRIVATE_BLOB_BYTES,
      MAX_ISSUE_PRIVATE_BLOB_BYTES,
      "maxBlobBytes",
    );
    this.maxBlobs = boundedLimit(
      options.maxBlobs ?? MAX_ISSUE_PRIVATE_BLOBS,
      MAX_ISSUE_PRIVATE_BLOBS,
      "maxBlobs",
    );
    this.maxPrivateBytes = boundedLimit(
      options.maxPrivateBytes ?? MAX_ISSUE_PRIVATE_TOTAL_BYTES,
      MAX_ISSUE_PRIVATE_TOTAL_BYTES,
      "maxPrivateBytes",
    );
    this.maxCommandBytes = boundedLimit(
      options.maxCommandBytes ?? MAX_ISSUE_COMMAND_BYTES,
      MAX_ISSUE_COMMAND_BYTES,
      "maxCommandBytes",
    );
    this.maxCommands = boundedLimit(
      options.maxCommands ?? MAX_ISSUE_COMMANDS,
      MAX_ISSUE_COMMANDS,
      "maxCommands",
    );
    this.#ownershipWitness = options.ownershipWitness ?? new LoopbackOwnershipWitnessAdapter();
    this.#publicationHook = options.publicationHook;
    if (this.maxLedgerBytes < this.maxEventBytes) {
      throw new RangeError("maxLedgerBytes must be no smaller than maxEventBytes");
    }
  }

  async initialize(input: IssueLifecycleRunInitialization): Promise<void> {
    const prepared = prepareInitialization(input, {
      maxEventBytes: this.maxEventBytes,
      maxLedgerBytes: this.maxLedgerBytes,
      maxEvents: this.maxEvents,
      maxManifestBytes: this.maxManifestBytes,
      maxBlobBytes: this.maxBlobBytes,
      maxBlobs: this.maxBlobs,
      maxPrivateBytes: this.maxPrivateBytes,
      maxCommandBytes: this.maxCommandBytes,
    });
    await this.#serialize(prepared.manifest.runId, async () => await this.#initializeNow(prepared));
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

  async readManifest(runIdInput: string): Promise<FrozenIssueRunManifest> {
    const runId = validateRunId(runIdInput);
    try {
      await this.#assertRunDirectory(runId);
      await assertSafeDirectory(this.#privateDirectory(runId), "unsafe_path");
      const contents = await readBoundedPrivateFile(
        this.#manifestPath(runId),
        this.maxManifestBytes,
      );
      return parseIssuePrivateManifest(JSON.parse(contents.toString("utf8")));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        try {
          await this.#assertLedgerExists(runId);
        } catch (ledgerError) {
          throw storeError(ledgerError);
        }
        throw new IssueLifecycleStoreError("manifest_missing", { cause: error });
      }
      if (error instanceof IssueLifecycleStoreError) throw error;
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
  }

  async putBlob(
    runIdInput: string,
    input: IssuePrivateBlobInput,
  ): Promise<IssuePrivateBlobReference> {
    const runId = validateRunId(runIdInput);
    let reference: IssuePrivateBlobReference;
    try {
      reference = createIssuePrivateBlobReference(input);
    } catch (error) {
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
    if (input.bytes.byteLength > this.maxBlobBytes) {
      throw new IssueLifecycleStoreError("limit");
    }
    const detached: IssuePrivateBlobInput = {
      mediaType: reference.mediaType,
      bytes: Uint8Array.from(input.bytes),
    };
    return await this.#serialize(
      runId,
      async () => await this.#putBlobNow(runId, detached, reference),
    );
  }

  async readBlob(
    runIdInput: string,
    referenceInput: IssuePrivateBlobReference,
  ): Promise<IssuePrivateBlobInput> {
    const runId = validateRunId(runIdInput);
    let reference: IssuePrivateBlobReference;
    try {
      reference = parseIssuePrivateBlobReference(referenceInput);
    } catch (error) {
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
    if (reference.byteLength > this.maxBlobBytes) throw new IssueLifecycleStoreError("limit");
    return await this.#readBlobNow(runId, reference);
  }

  async recordCommand(
    input: IssueLifecycleCommandRecordInput,
  ): Promise<IssueLifecycleCommandRecord> {
    const command = normalizeCommandInput(input, this.maxCommandBytes);
    return await this.#serialize(command.runId, async () => await this.#recordCommandNow(command));
  }

  async readCommand(
    runIdInput: string,
    commandIdInput: string,
  ): Promise<IssueLifecycleCommandRecord> {
    const runId = validateRunId(runIdInput);
    const commandId = validateCommandId(commandIdInput);
    await this.#auditCommandJournal(runId);
    return await this.#readCommandNow(runId, commandId);
  }

  async settleCommand(
    runIdInput: string,
    commandIdInput: string,
    settlementInput: IssueLifecycleCommandSettlement,
  ): Promise<IssueLifecycleCommandRecord> {
    const runId = validateRunId(runIdInput);
    const commandId = validateCommandId(commandIdInput);
    const settlement = parseCommandSettlement(settlementInput);
    await this.#auditCommandJournal(runId);
    return await this.#serialize(
      runId,
      async () => await this.#settleCommandNow(runId, commandId, settlement),
    );
  }

  async readPendingCancellation(
    runIdInput: string,
  ): Promise<IssueLifecycleCommandRecord | undefined> {
    const runId = validateRunId(runIdInput);
    await this.#assertPrivateLayout(runId);
    await this.#auditCommandJournal(runId);
    const commandIds = await this.#listCommandIds(runId);
    const cancellations: IssueLifecycleCommandRecord[] = [];
    for (const commandId of commandIds) {
      const record = await this.#readCommandNow(runId, commandId);
      if (record.command.kind === "cancel" && record.settlement === undefined) {
        cancellations.push(record);
      }
    }
    cancellations.sort((left, right) =>
      left.recordedAt === right.recordedAt
        ? compareStrings(left.command.commandId, right.command.commandId)
        : compareStrings(left.recordedAt, right.recordedAt),
    );
    return cancellations[0];
  }

  async #initializeNow(prepared: PreparedInitialization): Promise<void> {
    const runId = prepared.manifest.runId;
    await ensureStorageRoot(this.rootDirectory);
    const runDirectory = this.#runDirectory(runId);
    const ownerToken = randomUUID();
    const stagingDirectory = join(this.rootDirectory, `.${runId}-${ownerToken}.pending`);
    let witness: IssueLifecycleOwnershipWitnessHandle | undefined;
    let published = false;
    try {
      await assertRunIdentityAvailable(runDirectory);
      witness = await this.#ownershipWitness.acquire(ownerToken);
      await mkdir(stagingDirectory, { mode: 0o700 });
      const ownerDirectory = join(stagingDirectory, ".owner");
      const privateDirectory = join(stagingDirectory, "private");
      const blobsDirectory = join(privateDirectory, "blobs");
      const sha256Directory = join(blobsDirectory, "sha256");
      const commandsDirectory = join(privateDirectory, "commands");
      const commandSlotsDirectory = join(privateDirectory, "command-slots");
      await mkdir(ownerDirectory, { mode: 0o700 });
      await mkdir(privateDirectory, { mode: 0o700 });
      await mkdir(blobsDirectory, { mode: 0o700 });
      await mkdir(sha256Directory, { mode: 0o700 });
      await mkdir(commandsDirectory, { mode: 0o700 });
      await mkdir(commandSlotsDirectory, { mode: 0o700 });

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
      await writeDurablePrivateFile(
        join(privateDirectory, "frozen-v1.json"),
        prepared.manifestContents,
      );
      for (const blob of prepared.blobs) {
        await writePreparedBlobDirectory(sha256Directory, blob.input, blob.reference);
      }
      await writePreparedCommandDirectory(
        commandsDirectory,
        prepared.commandContents,
        prepared.command,
      );
      await writeCommandReservationDirectory(
        commandSlotsDirectory,
        0,
        prepared.command.command.commandId,
        prepared.command.commandDigest,
      );
      await writeDurablePrivateFile(join(stagingDirectory, "events.jsonl"), prepared.eventLine);

      await syncDirectory(ownerDirectory);
      await syncDirectory(sha256Directory);
      await syncDirectory(blobsDirectory);
      await syncDirectory(commandsDirectory);
      await syncDirectory(commandSlotsDirectory);
      await syncDirectory(privateDirectory);
      await syncDirectory(stagingDirectory);
      await this.#publish("initialize_before_publish", runId);
      try {
        await rename(stagingDirectory, runDirectory);
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        await classifyExistingRunDirectory(runDirectory);
        throw new IssueLifecycleStoreError("run_exists", { cause: error });
      }
      published = true;
      await syncDirectory(this.rootDirectory);
      await this.#publish("initialize_after_publish", runId);
      this.#ownedRuns.set(runId, {
        state: prepared.state,
        committedBytes: Buffer.byteLength(prepared.eventLine, "utf8"),
        ownerToken,
        witness,
      });
    } catch (error) {
      this.#ownedRuns.delete(runId);
      await witness?.close().catch(() => undefined);
      if (!published) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storeError(error);
    }
  }

  async #putBlobNow(
    runId: string,
    input: IssuePrivateBlobInput,
    reference: IssuePrivateBlobReference,
  ): Promise<IssuePrivateBlobReference> {
    const owned = this.#ownedRuns.get(runId);
    if (owned === undefined) throw new IssueLifecycleStoreError("not_owner");
    await this.#assertOwnership(runId, owned);
    await this.#assertPrivateLayout(runId);
    const targetDirectory = this.#blobDirectory(runId, reference.digest);
    try {
      return await this.#readBlobNow(runId, reference).then(() => reference);
    } catch (error) {
      if (!(error instanceof IssueLifecycleStoreError && error.code === "not_found")) throw error;
    }

    const usage = await this.#privateBlobUsage(runId);
    if (
      usage.count + 1 > this.maxBlobs ||
      usage.bytes + reference.byteLength > this.maxPrivateBytes
    ) {
      throw new IssueLifecycleStoreError("limit");
    }

    const stagingDirectory = join(
      this.#sha256Directory(runId),
      `.${reference.digest}-${randomUUID()}.pending`,
    );
    let published = false;
    try {
      await writePreparedBlobDirectoryAt(stagingDirectory, input, reference);
      this.#assertLocalWitness(owned);
      await this.#publish("blob_before_publish", reference.digest);
      this.#assertLocalWitness(owned);
      try {
        await rename(stagingDirectory, targetDirectory);
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        await this.#readBlobNow(runId, reference);
        return reference;
      }
      published = true;
      await syncDirectory(this.#sha256Directory(runId));
      await this.#publish("blob_after_publish", reference.digest);
      return reference;
    } catch (error) {
      if (!published) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storeError(error);
    }
  }

  async #readBlobNow(
    runId: string,
    reference: IssuePrivateBlobReference,
  ): Promise<IssuePrivateBlobInput> {
    try {
      await this.#assertPrivateLayout(runId);
      const directory = this.#blobDirectory(runId, reference.digest);
      await assertSafeDirectory(directory, "unsafe_path");
      const metadataContents = await readBoundedPrivateFile(
        join(directory, "metadata.json"),
        4_096,
      );
      const storedReference = parseIssuePrivateBlobReference(
        JSON.parse(metadataContents.toString("utf8")),
      );
      const bytes = await readBoundedPrivateFile(join(directory, "data"), this.maxBlobBytes);
      const input = { mediaType: storedReference.mediaType, bytes: Uint8Array.from(bytes) };
      verifyIssuePrivateBlob(input, storedReference);
      if (!sameBlobReference(storedReference, reference)) {
        throw new IssueLifecycleStoreError("corrupt");
      }
      return Object.freeze(input);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("not_found", { cause: error });
      }
      if (error instanceof IssueLifecycleStoreError) throw error;
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
  }

  async #privateBlobUsage(
    runId: string,
  ): Promise<{ readonly count: number; readonly bytes: number }> {
    const entries = await readdir(this.#sha256Directory(runId), { withFileTypes: true });
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name.endsWith(".pending")) continue;
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new IssueLifecycleStoreError("unsafe_path");
      }
      count += 1;
      if (count > this.maxBlobs) throw new IssueLifecycleStoreError("limit");
      const directory = this.#blobDirectory(runId, entry.name);
      await assertSafeDirectory(directory, "unsafe_path");
      const metadata = parseIssuePrivateBlobReference(
        JSON.parse(
          (await readBoundedPrivateFile(join(directory, "metadata.json"), 4_096)).toString("utf8"),
        ),
      );
      if (metadata.digest !== entry.name || metadata.byteLength > this.maxBlobBytes) {
        throw new IssueLifecycleStoreError("corrupt");
      }
      await this.#readBlobNow(runId, metadata);
      bytes += metadata.byteLength;
      if (bytes > this.maxPrivateBytes) throw new IssueLifecycleStoreError("limit");
    }
    return { count, bytes };
  }

  async #recordCommandNow(
    command: IssueLifecycleCommandRecord,
  ): Promise<IssueLifecycleCommandRecord> {
    await this.#assertPrivateLayout(command.runId);
    await this.#auditCommandJournal(command.runId);
    const targetDirectory = this.#commandDirectory(command.runId, command.command.commandId);
    try {
      const existing = await this.#readCommandNow(command.runId, command.command.commandId);
      assertSameCommand(existing, command);
      return existing;
    } catch (error) {
      if (!(error instanceof IssueLifecycleStoreError && error.code === "command_not_found")) {
        throw error;
      }
    }

    const manifest = await this.readManifest(command.runId);
    if (command.recordedAt < manifest.createdAt) {
      throw new IssueLifecycleStoreError("corrupt");
    }

    if (command.command.kind === "run") {
      throw new IssueLifecycleStoreError("command_conflict");
    }

    const contents = `${JSON.stringify(withoutSettlement(command))}\n`;
    if (Buffer.byteLength(contents, "utf8") > this.maxCommandBytes) {
      throw new IssueLifecycleStoreError("limit");
    }
    await this.#reserveCommandSlot(command);
    const stagingDirectory = join(
      this.#commandsDirectory(command.runId),
      `.${command.command.commandId}-${randomUUID()}.pending`,
    );
    let published = false;
    try {
      await writePreparedCommandDirectoryAt(stagingDirectory, contents);
      await this.#publish("command_before_publish", command.command.commandId);
      try {
        await rename(stagingDirectory, targetDirectory);
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        const existing = await this.#readCommandNow(command.runId, command.command.commandId);
        assertSameCommand(existing, command);
        return existing;
      }
      published = true;
      await syncDirectory(this.#commandsDirectory(command.runId));
      await this.#publish("command_after_publish", command.command.commandId);
      return command;
    } catch (error) {
      if (!published) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storeError(error);
    }
  }

  async #readCommandNow(runId: string, commandId: string): Promise<IssueLifecycleCommandRecord> {
    try {
      await this.#assertPrivateLayout(runId);
      const directory = this.#commandDirectory(runId, commandId);
      await assertSafeDirectory(directory, "unsafe_path");
      const request = parseStoredCommandRequest(
        JSON.parse(
          (
            await readBoundedPrivateFile(join(directory, "request.json"), this.maxCommandBytes)
          ).toString("utf8"),
        ),
      );
      if (request.runId !== runId || request.command.commandId !== commandId) {
        throw new IssueLifecycleStoreError("corrupt");
      }
      const settlement = await this.#readSettlementIfPresent(directory);
      if (settlement !== undefined && settlement.commandDigest !== request.commandDigest) {
        throw new IssueLifecycleStoreError("corrupt");
      }
      return settlement === undefined
        ? deepFreeze(request)
        : deepFreeze({ ...request, settlement });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("command_not_found", { cause: error });
      }
      if (error instanceof IssueLifecycleStoreError) throw error;
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
  }

  async #settleCommandNow(
    runId: string,
    commandId: string,
    settlement: IssueLifecycleCommandSettlement,
  ): Promise<IssueLifecycleCommandRecord> {
    const command = await this.#readCommandNow(runId, commandId);
    if (command.commandDigest !== settlement.commandDigest) {
      throw new IssueLifecycleStoreError("command_conflict");
    }
    if (settlement.settledAt < command.recordedAt) {
      throw new IssueLifecycleStoreError("corrupt");
    }
    if (command.settlement !== undefined) {
      if (!sameJson(command.settlement, settlement)) {
        throw new IssueLifecycleStoreError("command_conflict");
      }
      return command;
    }

    const commandDirectory = this.#commandDirectory(runId, commandId);
    const targetDirectory = join(commandDirectory, "settlement");
    const stagingDirectory = join(commandDirectory, `.settlement-${randomUUID()}.pending`);
    let published = false;
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      await writeDurablePrivateFile(
        join(stagingDirectory, "record.json"),
        `${JSON.stringify(settlement)}\n`,
      );
      await syncDirectory(stagingDirectory);
      await this.#publish("settlement_before_publish", commandId);
      try {
        await rename(stagingDirectory, targetDirectory);
      } catch (error) {
        if (!isRenameCollision(error)) throw error;
        const existing = await this.#readCommandNow(runId, commandId);
        if (existing.settlement === undefined || !sameJson(existing.settlement, settlement)) {
          throw new IssueLifecycleStoreError("command_conflict", { cause: error });
        }
        return existing;
      }
      published = true;
      await syncDirectory(commandDirectory);
      await this.#publish("settlement_after_publish", commandId);
      return deepFreeze({ ...command, settlement });
    } catch (error) {
      if (!published) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storeError(error);
    }
  }

  async #readSettlementIfPresent(
    commandDirectory: string,
  ): Promise<IssueLifecycleCommandSettlement | undefined> {
    const directory = join(commandDirectory, "settlement");
    try {
      await assertSafeDirectory(directory, "unsafe_path");
      return parseCommandSettlement(
        JSON.parse(
          (
            await readBoundedPrivateFile(join(directory, "record.json"), this.maxCommandBytes)
          ).toString("utf8"),
        ),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #listCommandIds(runId: string): Promise<readonly string[]> {
    const entries = await readdir(this.#commandsDirectory(runId), { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (!/^\.[0-9a-f-]{36}-[0-9a-f-]{36}\.pending$/.test(entry.name) || !entry.isDirectory()) {
          throw new IssueLifecycleStoreError("unsafe_path");
        }
        await assertSafeDirectory(join(this.#commandsDirectory(runId), entry.name), "unsafe_path");
        continue;
      }
      if (!entry.isDirectory() || !commandIdentifierSchema.safeParse(entry.name).success) {
        throw new IssueLifecycleStoreError("unsafe_path");
      }
      ids.push(entry.name);
      if (ids.length > this.maxCommands) throw new IssueLifecycleStoreError("limit");
    }
    return ids.sort(compareStrings);
  }

  async #auditCommandJournal(runId: string): Promise<void> {
    await this.#assertPrivateLayout(runId);
    const entries = await readdir(this.#commandSlotsDirectory(runId), { withFileTypes: true });
    const reservations = new Map<
      string,
      { readonly commandId: string; readonly commandDigest: string }
    >();
    let slotCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (!/^\.slot-[0-9]{4}-[0-9a-f-]{36}\.pending$/.test(entry.name) || !entry.isDirectory()) {
          throw new IssueLifecycleStoreError("unsafe_path");
        }
        await assertSafeDirectory(
          join(this.#commandSlotsDirectory(runId), entry.name),
          "unsafe_path",
        );
        continue;
      }
      if (!entry.isDirectory() || !/^[0-9]{4}$/.test(entry.name)) {
        throw new IssueLifecycleStoreError("unsafe_path");
      }
      const slot = Number.parseInt(entry.name, 10);
      if (slot >= this.maxCommands || entry.name !== commandSlotName(slot)) {
        throw new IssueLifecycleStoreError("limit");
      }
      slotCount += 1;
      if (slotCount > this.maxCommands) throw new IssueLifecycleStoreError("limit");
      const reservation = await readCommandReservation(
        join(this.#commandSlotsDirectory(runId), entry.name),
      );
      if (reservations.has(reservation.commandId)) {
        throw new IssueLifecycleStoreError("corrupt");
      }
      reservations.set(reservation.commandId, reservation);
    }

    for (const commandId of await this.#listCommandIds(runId)) {
      const command = await this.#readCommandNow(runId, commandId);
      const reservation = reservations.get(commandId);
      if (reservation === undefined || reservation.commandDigest !== command.commandDigest) {
        throw new IssueLifecycleStoreError("corrupt");
      }
    }
  }

  async #reserveCommandSlot(command: IssueLifecycleCommandRecord): Promise<void> {
    const slotsDirectory = this.#commandSlotsDirectory(command.runId);
    for (let slot = 0; slot < this.maxCommands; slot += 1) {
      const targetDirectory = join(slotsDirectory, commandSlotName(slot));
      const stagingDirectory = join(
        slotsDirectory,
        `.slot-${commandSlotName(slot)}-${randomUUID()}.pending`,
      );
      let published = false;
      try {
        await writeCommandReservationDirectoryAt(
          stagingDirectory,
          command.command.commandId,
          command.commandDigest,
        );
        await this.#publish("command_reservation_before_publish", command.command.commandId);
        try {
          await rename(stagingDirectory, targetDirectory);
        } catch (error) {
          if (!isRenameCollision(error)) throw error;
          const reservation = await readCommandReservation(targetDirectory);
          if (
            reservation.commandId === command.command.commandId &&
            reservation.commandDigest === command.commandDigest
          ) {
            return;
          }
          if (reservation.commandId === command.command.commandId) {
            throw new IssueLifecycleStoreError("command_conflict");
          }
          continue;
        }
        published = true;
        await syncDirectory(slotsDirectory);
        await this.#publish("command_reservation_after_publish", command.command.commandId);
        return;
      } catch (error) {
        throw storeError(error);
      } finally {
        if (!published) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
    throw new IssueLifecycleStoreError("limit");
  }

  async #publish(point: IssueLifecycleStorePublicationPoint, identity: string): Promise<void> {
    await this.#publicationHook?.(point, identity);
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

  #privateDirectory(runId: string): string {
    return join(this.#runDirectory(runId), "private");
  }

  #manifestPath(runId: string): string {
    return join(this.#privateDirectory(runId), "frozen-v1.json");
  }

  #sha256Directory(runId: string): string {
    return join(this.#privateDirectory(runId), "blobs", "sha256");
  }

  #blobDirectory(runId: string, digest: string): string {
    return join(this.#sha256Directory(runId), digest);
  }

  #commandsDirectory(runId: string): string {
    return join(this.#privateDirectory(runId), "commands");
  }

  #commandSlotsDirectory(runId: string): string {
    return join(this.#privateDirectory(runId), "command-slots");
  }

  #commandDirectory(runId: string, commandId: string): string {
    return join(this.#commandsDirectory(runId), commandId);
  }

  async #assertRunDirectory(runId: string): Promise<void> {
    await assertSafeStorageRoot(this.rootDirectory);
    await assertSafeDirectory(this.#runDirectory(runId), "unsafe_path");
  }

  async #assertPrivateLayout(runId: string): Promise<void> {
    try {
      await this.#assertRunDirectory(runId);
      await assertSafeDirectory(this.#privateDirectory(runId), "unsafe_path");
      await assertSafeDirectory(join(this.#privateDirectory(runId), "blobs"), "unsafe_path");
      await assertSafeDirectory(this.#sha256Directory(runId), "unsafe_path");
      await assertSafeDirectory(this.#commandsDirectory(runId), "unsafe_path");
      await assertSafeDirectory(this.#commandSlotsDirectory(runId), "unsafe_path");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new IssueLifecycleStoreError("corrupt", { cause: error });
      }
      throw storeError(error);
    }
  }
}

function prepareInitialization(
  input: IssueLifecycleRunInitialization,
  limits: {
    readonly maxEventBytes: number;
    readonly maxLedgerBytes: number;
    readonly maxEvents: number;
    readonly maxManifestBytes: number;
    readonly maxBlobBytes: number;
    readonly maxBlobs: number;
    readonly maxPrivateBytes: number;
    readonly maxCommandBytes: number;
  },
): PreparedInitialization {
  let manifest: FrozenIssueRunManifest;
  let snapshot: IssueLifecycleEvent;
  try {
    manifest = parseIssuePrivateManifest(input.manifest);
    snapshot = parseIssueLifecycleEvent(input.snapshot);
  } catch (error) {
    throw new IssueLifecycleStoreError("corrupt", { cause: error });
  }
  const manifestContents = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(manifestContents, "utf8") > limits.maxManifestBytes) {
    throw new IssueLifecycleStoreError("limit");
  }
  if (
    snapshot.runId !== manifest.runId ||
    snapshot.sequence !== 1 ||
    snapshot.type !== "phase_transitioned" ||
    snapshot.from !== "preflight" ||
    snapshot.to !== "issue_frozen" ||
    snapshot.receipt.kind !== "issue_snapshot"
  ) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  if (snapshot.at !== manifest.createdAt) throw new IssueLifecycleStoreError("corrupt");
  const receipt = snapshot.receipt;
  const expectedReceipt = {
    repositoryIdentity: manifest.repository.identity,
    issueNumber: manifest.issue.number,
    issueNodeId: manifest.issue.nodeId,
    issueUpdatedAt: manifest.issue.updatedAt,
    baseBranch: manifest.base.branch,
    baseCommit: manifest.base.commit,
    branch: manifest.branch.name,
    issueDigest: manifest.issue.contentDigest,
    frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
    planDigest: manifest.planDigest,
    implementationTemplateWorkflowDigest: manifest.implementationWorkflow.templateWorkflowDigest,
    reviewTemplateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
    budgetDigest: manifest.budgetDigest,
  };
  for (const [key, expected] of Object.entries(expectedReceipt)) {
    if (receipt[key as keyof typeof receipt] !== expected) {
      throw new IssueLifecycleStoreError("corrupt");
    }
  }
  const state = validateCandidate(undefined, snapshot);
  const eventLine = serializeEvent(snapshot);
  if (
    Buffer.byteLength(eventLine, "utf8") > limits.maxEventBytes ||
    Buffer.byteLength(eventLine, "utf8") > limits.maxLedgerBytes ||
    limits.maxEvents < 1
  ) {
    throw new IssueLifecycleStoreError("limit");
  }

  const command = normalizeCommandInput(input.command, limits.maxCommandBytes);
  if (
    command.runId !== manifest.runId ||
    command.recordedAt !== manifest.createdAt ||
    command.command.kind !== "run" ||
    command.command.commandId !== manifest.initialCommandId ||
    command.command.issueUrl !== manifest.issue.canonicalUrl ||
    command.command.repositoryIdentity !== manifest.repository.identity ||
    command.command.planDigest !== manifest.planDigest ||
    command.command.provider !== manifest.implementationWorkflow.model.provider ||
    command.command.model !== manifest.implementationWorkflow.model.id
  ) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  const commandContents = `${JSON.stringify(withoutSettlement(command))}\n`;
  if (Buffer.byteLength(commandContents, "utf8") > limits.maxCommandBytes) {
    throw new IssueLifecycleStoreError("limit");
  }

  const expectedReferences = new Map(
    Object.values(manifest.artifacts).map((reference) => [reference.digest, reference]),
  );
  const blobs = new Map<
    string,
    { readonly input: IssuePrivateBlobInput; readonly reference: IssuePrivateBlobReference }
  >();
  let privateBytes = 0;
  for (const inputBlob of input.initialBlobs) {
    let reference: IssuePrivateBlobReference;
    try {
      reference = createIssuePrivateBlobReference(inputBlob);
    } catch (error) {
      throw new IssueLifecycleStoreError("corrupt", { cause: error });
    }
    if (reference.byteLength > limits.maxBlobBytes) throw new IssueLifecycleStoreError("limit");
    const expected = expectedReferences.get(reference.digest);
    if (expected === undefined || !sameBlobReference(reference, expected)) {
      throw new IssueLifecycleStoreError("corrupt");
    }
    if (!blobs.has(reference.digest)) {
      privateBytes += reference.byteLength;
      blobs.set(reference.digest, {
        input: { mediaType: reference.mediaType, bytes: Uint8Array.from(inputBlob.bytes) },
        reference,
      });
    }
  }
  if (
    blobs.size !== expectedReferences.size ||
    blobs.size > limits.maxBlobs ||
    privateBytes > limits.maxPrivateBytes
  ) {
    throw new IssueLifecycleStoreError(
      blobs.size > limits.maxBlobs || privateBytes > limits.maxPrivateBytes ? "limit" : "corrupt",
    );
  }

  return {
    manifest,
    manifestContents,
    blobs: Object.freeze([...blobs.values()]),
    snapshot,
    eventLine,
    state,
    command,
    commandContents,
  };
}

function normalizeCommandInput(
  input: IssueLifecycleCommandRecordInput,
  maxBytes: number,
): IssueLifecycleCommandRecord {
  const runId = validateRunId(input.runId);
  const timestamp = exactTimestampSchema.safeParse(input.recordedAt);
  if (!timestamp.success) throw new IssueLifecycleStoreError("corrupt", { cause: timestamp.error });
  let command: ReturnType<typeof parseIssueLifecycleCommand>;
  try {
    command = parseIssueLifecycleCommand(input.command);
  } catch (error) {
    throw new IssueLifecycleStoreError("corrupt", { cause: error });
  }
  if (command.kind !== "run" && command.runId !== runId) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  const commandDigest = calculateIssueLifecycleCommandDigest(command);
  const record = deepFreeze({
    version: 1 as const,
    runId,
    recordedAt: timestamp.data,
    commandDigest,
    command,
  });
  if (Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8") > maxBytes) {
    throw new IssueLifecycleStoreError("limit");
  }
  return record;
}

function parseStoredCommandRequest(input: unknown): StoredCommandRequest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  const candidate = input as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "command,commandDigest,recordedAt,runId,version" ||
    candidate.version !== 1 ||
    typeof candidate.runId !== "string" ||
    typeof candidate.recordedAt !== "string" ||
    typeof candidate.commandDigest !== "string"
  ) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  const normalized = normalizeCommandInput(
    {
      runId: candidate.runId,
      recordedAt: candidate.recordedAt,
      command: parseIssueLifecycleCommand(candidate.command),
    },
    MAX_ISSUE_COMMAND_BYTES,
  );
  if (normalized.commandDigest !== candidate.commandDigest) {
    throw new IssueLifecycleStoreError("corrupt");
  }
  return withoutSettlement(normalized);
}

function parseCommandSettlement(input: unknown): IssueLifecycleCommandSettlement {
  const parsed = commandSettlementSchema.safeParse(input);
  if (!parsed.success) throw new IssueLifecycleStoreError("corrupt", { cause: parsed.error });
  const settlement: IssueLifecycleCommandSettlement = {
    version: 1,
    commandDigest: parsed.data.commandDigest,
    settledAt: parsed.data.settledAt,
    outcome: parsed.data.outcome,
    ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
    ...(parsed.data.resultDigest === undefined ? {} : { resultDigest: parsed.data.resultDigest }),
  };
  return deepFreeze(settlement);
}

function withoutSettlement(record: IssueLifecycleCommandRecord): StoredCommandRequest {
  return {
    version: 1,
    runId: record.runId,
    recordedAt: record.recordedAt,
    commandDigest: record.commandDigest,
    command: record.command,
  };
}

function assertSameCommand(
  existing: IssueLifecycleCommandRecord,
  candidate: IssueLifecycleCommandRecord,
): void {
  if (
    existing.commandDigest !== candidate.commandDigest ||
    existing.runId !== candidate.runId ||
    !sameJson(existing.command, candidate.command)
  ) {
    throw new IssueLifecycleStoreError("command_conflict");
  }
}

function validateCommandId(commandId: string): string {
  const parsed = commandIdentifierSchema.safeParse(commandId);
  if (!parsed.success) throw new IssueLifecycleStoreError("unsafe_path", { cause: parsed.error });
  return parsed.data;
}

async function writePreparedBlobDirectory(
  parent: string,
  input: IssuePrivateBlobInput,
  reference: IssuePrivateBlobReference,
): Promise<void> {
  await writePreparedBlobDirectoryAt(join(parent, reference.digest), input, reference);
}

async function writePreparedBlobDirectoryAt(
  directory: string,
  input: IssuePrivateBlobInput,
  reference: IssuePrivateBlobReference,
): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await writeDurablePrivateFile(join(directory, "metadata.json"), `${JSON.stringify(reference)}\n`);
  await writeDurablePrivateBytes(join(directory, "data"), input.bytes);
  await syncDirectory(directory);
}

async function writePreparedCommandDirectory(
  parent: string,
  contents: string,
  command: IssueLifecycleCommandRecord,
): Promise<void> {
  await writePreparedCommandDirectoryAt(join(parent, command.command.commandId), contents);
}

async function writePreparedCommandDirectoryAt(directory: string, contents: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  await writeDurablePrivateFile(join(directory, "request.json"), contents);
  await syncDirectory(directory);
}

function commandSlotName(slot: number): string {
  return slot.toString(10).padStart(4, "0");
}

async function writeCommandReservationDirectory(
  parent: string,
  slot: number,
  commandId: string,
  commandDigest: string,
): Promise<void> {
  await writeCommandReservationDirectoryAt(
    join(parent, commandSlotName(slot)),
    commandId,
    commandDigest,
  );
}

async function writeCommandReservationDirectoryAt(
  directory: string,
  commandId: string,
  commandDigest: string,
): Promise<void> {
  const reservation = commandReservationSchema.parse({
    version: 1,
    commandId,
    commandDigest,
  });
  await mkdir(directory, { mode: 0o700 });
  await writeDurablePrivateFile(
    join(directory, "reservation.json"),
    `${JSON.stringify(reservation)}\n`,
  );
  await syncDirectory(directory);
}

async function readCommandReservation(directory: string): Promise<{
  readonly commandId: string;
  readonly commandDigest: string;
}> {
  try {
    await assertSafeDirectory(directory, "unsafe_path");
    const parsed = commandReservationSchema.safeParse(
      JSON.parse(
        (await readBoundedPrivateFile(join(directory, "reservation.json"), 1_024)).toString("utf8"),
      ),
    );
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  } catch (error) {
    if (error instanceof IssueLifecycleStoreError) throw error;
    throw new IssueLifecycleStoreError("corrupt", { cause: error });
  }
}

function sameBlobReference(
  left: IssuePrivateBlobReference,
  right: IssuePrivateBlobReference,
): boolean {
  return (
    left.version === right.version &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength &&
    left.digest === right.digest
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
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
  await writeDurablePrivateBytes(path, Buffer.from(contents, "utf8"));
}

async function writeDurablePrivateBytes(path: string, contents: Uint8Array): Promise<void> {
  const handle = await openNoFollow(path, "exclusive-write");
  try {
    await validateRecordHandle(handle);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if (isUnsafeLinkError(error)) {
      throw new IssueLifecycleStoreError("unsafe_path", { cause: error });
    }
    throw error;
  }
  try {
    const metadata = await validateRecordHandle(handle);
    if (metadata.size > maxBytes) throw new IssueLifecycleStoreError("limit");
    return await handle.readFile();
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
