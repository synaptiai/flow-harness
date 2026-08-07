import { constants, type Dirent } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  parseActiveRunClaim,
  parseJobRecord,
  parseSupervisorCommandRecord,
  parseSupervisorDescriptor,
  parseSupervisorStartLock,
  parseWorkerDescriptor,
  socketRoot,
  type ActiveRunClaim,
  type JobRecord,
  type SupervisorCommandRecord,
  type SupervisorDescriptor,
  type SupervisorStartLock,
  type WorkerDescriptor,
} from "../../supervisor/records.js";
import { MAX_SUPERVISOR_FRAME_BYTES } from "../../supervisor/protocol.js";

const MAX_RECORD_BYTES = MAX_SUPERVISOR_FRAME_BYTES + 64 * 1024;

export type LocalSupervisorStoreErrorCode =
  | "corrupt"
  | "identity_mismatch"
  | "io"
  | "job_exists"
  | "not_found"
  | "run_claimed"
  | "unsafe_permissions";

export class LocalSupervisorStoreError extends Error {
  override readonly name = "LocalSupervisorStoreError";

  constructor(
    readonly code: LocalSupervisorStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface LocalSupervisorStoreOptions {
  readonly socketDirectory?: string;
  readonly expectedUid?: number;
}

export class LocalSupervisorStore {
  readonly runsDirectory: string;
  readonly controlDirectory: string;
  readonly jobsDirectory: string;
  readonly claimsDirectory: string;
  readonly workersDirectory: string;
  readonly commandsDirectory: string;
  readonly socketDirectory: string;
  readonly #expectedUid: number;

  constructor(runsDirectory: string, options: LocalSupervisorStoreOptions = {}) {
    this.runsDirectory = resolve(runsDirectory);
    this.controlDirectory = join(this.runsDirectory, ".supervisor");
    this.jobsDirectory = join(this.controlDirectory, "jobs");
    this.claimsDirectory = join(this.controlDirectory, "active");
    this.workersDirectory = join(this.controlDirectory, "workers");
    this.commandsDirectory = join(this.controlDirectory, "commands");
    this.#expectedUid = options.expectedUid ?? currentUid();
    this.socketDirectory = resolve(options.socketDirectory ?? socketRoot(this.#expectedUid));
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.runsDirectory, { recursive: true });
      for (const directory of [
        this.controlDirectory,
        this.jobsDirectory,
        this.claimsDirectory,
        this.workersDirectory,
        this.commandsDirectory,
        this.socketDirectory,
      ]) {
        await ensurePrivateDirectory(directory, this.#expectedUid);
      }
    } catch (error) {
      if (error instanceof LocalSupervisorStoreError) {
        throw error;
      }
      throw new LocalSupervisorStoreError(
        "io",
        `failed to initialize supervisor state under "${this.controlDirectory}"`,
        { cause: error },
      );
    }
  }

  async reserveSubmission(jobInput: JobRecord, claimInput: ActiveRunClaim): Promise<void> {
    const job = parseJobRecord(jobInput);
    const claim = parseActiveRunClaim(claimInput);
    if (claim.runId !== job.runId || claim.jobId !== job.jobId || claim.workerId !== job.workerId) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `active claim for run "${claim.runId}" does not match job "${job.jobId}"`,
      );
    }
    await this.reserveJob(job);
    await this.reserveActiveRunClaim(claim);
  }

  async reserveJob(jobInput: JobRecord): Promise<void> {
    const job = parseJobRecord(jobInput);
    await this.initialize();

    const jobPath = this.#jobPath(job.jobId);
    try {
      await writeExclusiveRecord(jobPath, job);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw storeIoError(`failed to persist job "${job.jobId}"`, error);
      }
      const existing = await this.readJob(job.jobId);
      if (existing.digest !== job.digest) {
        throw new LocalSupervisorStoreError(
          "job_exists",
          `job "${job.jobId}" already exists with different content`,
          { cause: error },
        );
      }
    }
  }

  async reserveActiveRunClaim(claimInput: ActiveRunClaim): Promise<void> {
    const claim = parseActiveRunClaim(claimInput);
    const job = await this.readJob(claim.jobId);
    if (claim.runId !== job.runId || claim.workerId !== job.workerId) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `active claim for run "${claim.runId}" does not match job "${job.jobId}"`,
      );
    }
    await this.initialize();
    const claimPath = this.#claimPath(claim.runId);
    try {
      await writeExclusiveRecord(claimPath, claim);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw storeIoError(`failed to claim active run "${claim.runId}"`, error);
      }
      const existing = await this.readActiveRunClaim(claim.runId);
      if (
        existing?.jobId === claim.jobId &&
        existing.workerId === claim.workerId &&
        existing.claimedAt === claim.claimedAt
      ) {
        return;
      }
      throw new LocalSupervisorStoreError(
        "run_claimed",
        `run "${claim.runId}" already has an active job`,
        { cause: error },
      );
    }
  }

  async readJob(jobId: string): Promise<JobRecord> {
    validateUuid(jobId, "job id");
    return await this.#readRequiredRecord(this.#jobPath(jobId), parseJobRecord, `job "${jobId}"`);
  }

  async readActiveRunClaim(runId: string): Promise<ActiveRunClaim | null> {
    validateRunId(runId);
    return await this.#readOptionalRecord(
      this.#claimPath(runId),
      parseActiveRunClaim,
      `active claim for run "${runId}"`,
    );
  }

  async releaseActiveRunClaim(runId: string, jobId: string): Promise<void> {
    validateRunId(runId);
    validateUuid(jobId, "job id");
    const claim = await this.readActiveRunClaim(runId);
    if (claim === null) {
      return;
    }
    if (claim.jobId !== jobId) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `active run "${runId}" belongs to job "${claim.jobId}", not "${jobId}"`,
      );
    }

    const path = this.#claimPath(runId);
    const retired = join(this.claimsDirectory, `.${runId}.${randomUUID()}.released`);
    try {
      await rename(path, retired);
      await syncDirectory(this.claimsDirectory);
      await rm(retired);
      await syncDirectory(this.claimsDirectory);
    } catch (error) {
      throw storeIoError(`failed to release active run "${runId}"`, error);
    }
  }

  async writeWorkerDescriptor(input: WorkerDescriptor): Promise<void> {
    const descriptor = parseWorkerDescriptor(input);
    await this.initialize();
    const existing = await this.#readOptionalRecord(
      this.#workerPath(descriptor.workerId),
      parseWorkerDescriptor,
      `worker "${descriptor.workerId}"`,
    );
    if (existing !== null && !sameWorkerIdentity(existing, descriptor)) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `worker "${descriptor.workerId}" identity cannot be replaced`,
      );
    }
    try {
      await writeAtomicRecord(this.#workerPath(descriptor.workerId), descriptor);
    } catch (error) {
      throw storeIoError(`failed to persist worker "${descriptor.workerId}"`, error);
    }
  }

  async writeSupervisorDescriptor(input: SupervisorDescriptor): Promise<void> {
    const descriptor = parseSupervisorDescriptor(input);
    if (descriptor.runsDirectory !== this.runsDirectory) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `supervisor generation "${descriptor.generation}" targets a different run directory`,
      );
    }
    await this.initialize();
    try {
      await writeAtomicRecord(join(this.controlDirectory, "supervisor.json"), descriptor);
    } catch (error) {
      throw storeIoError("failed to persist the supervisor descriptor", error);
    }
  }

  async readSupervisorDescriptor(): Promise<SupervisorDescriptor | null> {
    return await this.#readOptionalRecord(
      join(this.controlDirectory, "supervisor.json"),
      parseSupervisorDescriptor,
      "supervisor descriptor",
    );
  }

  async reserveSupervisorStart(
    input: SupervisorStartLock,
  ): Promise<
    | { readonly acquired: true; readonly record: SupervisorStartLock }
    | { readonly acquired: false; readonly record: SupervisorStartLock }
  > {
    const record = parseSupervisorStartLock(input);
    await this.initialize();
    try {
      await writeExclusiveRecord(this.#supervisorStartPath(), record);
      return { acquired: true, record };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw storeIoError("failed to reserve supervisor startup", error);
      }
      const existing = await this.#readRequiredRecord(
        this.#supervisorStartPath(),
        parseSupervisorStartLock,
        "supervisor startup lock",
      );
      return { acquired: false, record: existing };
    }
  }

  async releaseSupervisorStart(token: string): Promise<void> {
    validateUuid(token, "supervisor startup token");
    const existing = await this.#readRequiredRecord(
      this.#supervisorStartPath(),
      parseSupervisorStartLock,
      "supervisor startup lock",
    );
    if (existing.token !== token) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        "supervisor startup lock belongs to another caller",
      );
    }
    const retired = join(this.controlDirectory, `.supervisor-start.${randomUUID()}.released`);
    try {
      await rename(this.#supervisorStartPath(), retired);
      await syncDirectory(this.controlDirectory);
      await rm(retired);
      await syncDirectory(this.controlDirectory);
    } catch (error) {
      throw storeIoError("failed to release supervisor startup", error);
    }
  }

  async listActiveRunClaims(): Promise<readonly ActiveRunClaim[]> {
    return await this.#listRecords(this.claimsDirectory, parseActiveRunClaim, "active run claim");
  }

  async listWorkerDescriptors(): Promise<readonly WorkerDescriptor[]> {
    return await this.#listRecords(
      this.workersDirectory,
      parseWorkerDescriptor,
      "worker descriptor",
    );
  }

  async readWorkerDescriptor(workerId: string): Promise<WorkerDescriptor> {
    validateUuid(workerId, "worker id");
    return await this.#readRequiredRecord(
      this.#workerPath(workerId),
      parseWorkerDescriptor,
      `worker "${workerId}"`,
    );
  }

  async recordCommand(input: SupervisorCommandRecord): Promise<SupervisorCommandRecord> {
    const command = parseSupervisorCommandRecord(input);
    await this.initialize();
    try {
      await writeExclusiveRecord(this.#commandPath(command.commandId), command);
      return command;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw storeIoError(`failed to record command "${command.commandId}"`, error);
      }
      const existing = await this.readCommand(command.commandId);
      if (existing.type !== command.type || existing.requestDigest !== command.requestDigest) {
        throw new LocalSupervisorStoreError(
          "identity_mismatch",
          `command "${command.commandId}" already exists with different input`,
          { cause: error },
        );
      }
      return existing;
    }
  }

  async readCommand(commandId: string): Promise<SupervisorCommandRecord> {
    validateUuid(commandId, "command id");
    return await this.#readRequiredRecord(
      this.#commandPath(commandId),
      parseSupervisorCommandRecord,
      `command "${commandId}"`,
    );
  }

  async updateCommand(input: SupervisorCommandRecord): Promise<void> {
    const command = parseSupervisorCommandRecord(input);
    const existing = await this.readCommand(command.commandId);
    if (
      existing.type !== command.type ||
      existing.requestDigest !== command.requestDigest ||
      existing.recordedAt !== command.recordedAt
    ) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `command "${command.commandId}" identity cannot be replaced`,
      );
    }
    if (JSON.stringify(existing) === JSON.stringify(command)) {
      return;
    }
    if (
      existing.status === "completed" &&
      command.status === "completed" &&
      JSON.stringify(existing.result) === JSON.stringify(command.result)
    ) {
      return;
    }
    const transitionAllowed =
      existing.type === command.type &&
      ((existing.status === "recorded" && command.status !== "recorded") ||
        (existing.status === "queued" &&
          (command.status === "completed" ||
            command.status === "rejected" ||
            command.status === "uncertain")) ||
        (existing.status === "uncertain" && command.status === "completed"));
    if (!transitionAllowed) {
      throw new LocalSupervisorStoreError(
        "identity_mismatch",
        `command "${command.commandId}" cannot transition from ${existing.status} to ${command.status}`,
      );
    }
    try {
      await writeAtomicRecord(this.#commandPath(command.commandId), command);
    } catch (error) {
      throw storeIoError(`failed to update command "${command.commandId}"`, error);
    }
  }

  async #readRequiredRecord<T>(
    path: string,
    parse: (input: unknown) => T,
    label: string,
  ): Promise<T> {
    const record = await this.#readOptionalRecord(path, parse, label);
    if (record === null) {
      throw new LocalSupervisorStoreError("not_found", `${label} does not exist`);
    }
    return record;
  }

  async #readOptionalRecord<T>(
    path: string,
    parse: (input: unknown) => T,
    label: string,
  ): Promise<T | null> {
    let contents: string;
    try {
      contents = await readPrivateFile(path, this.#expectedUid);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof LocalSupervisorStoreError) {
        throw error;
      }
      throw storeIoError(`failed to read ${label}`, error);
    }
    try {
      return parse(JSON.parse(contents));
    } catch (error) {
      throw new LocalSupervisorStoreError("corrupt", `${label} is corrupt`, { cause: error });
    }
  }

  async #listRecords<T>(
    directory: string,
    parse: (input: unknown) => T,
    label: string,
  ): Promise<readonly T[]> {
    await this.initialize();
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      throw storeIoError(`failed to list ${label} records`, error);
    }
    const names = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    if (names.length > 1024) {
      throw new LocalSupervisorStoreError(
        "corrupt",
        `${label} record count exceeds the limit of 1024`,
      );
    }
    const records: T[] = [];
    for (const name of names) {
      records.push(
        await this.#readRequiredRecord(join(directory, name), parse, `${label} "${name}"`),
      );
    }
    return Object.freeze(records);
  }

  #jobPath(jobId: string): string {
    return join(this.jobsDirectory, `${jobId}.json`);
  }

  #claimPath(runId: string): string {
    return join(this.claimsDirectory, `${runId}.json`);
  }

  #workerPath(workerId: string): string {
    return join(this.workersDirectory, `${workerId}.json`);
  }

  #commandPath(commandId: string): string {
    return join(this.commandsDirectory, `${commandId}.json`);
  }

  #supervisorStartPath(): string {
    return join(this.controlDirectory, "supervisor-start.json");
  }
}

async function ensurePrivateDirectory(directory: string, expectedUid: number): Promise<void> {
  let before: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    before = await lstat(directory);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (before?.isSymbolicLink() === true) {
    throw new LocalSupervisorStoreError(
      "unsafe_permissions",
      `private directory "${directory}" must not be a symbolic link`,
    );
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalSupervisorStoreError(
      "unsafe_permissions",
      `private path "${directory}" is not a real directory`,
    );
  }
  if (metadata.uid !== expectedUid) {
    throw new LocalSupervisorStoreError(
      "unsafe_permissions",
      `private directory "${directory}" is owned by uid ${metadata.uid}, expected ${expectedUid}`,
    );
  }
  await chmod(directory, 0o700);
}

async function writeExclusiveRecord(path: string, record: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  await writeAndSync(handle, record);
  await syncDirectory(resolve(path, ".."));
}

async function writeAtomicRecord(path: string, record: unknown): Promise<void> {
  const directory = resolve(path, "..");
  const pending = join(directory, `.${randomUUID()}.pending`);
  let published = false;
  try {
    const handle = await open(pending, "wx", 0o600);
    await writeAndSync(handle, record);
    await rename(pending, path);
    published = true;
    await syncDirectory(directory);
  } finally {
    if (!published) {
      await rm(pending, { force: true }).catch(() => undefined);
    }
  }
}

async function writeAndSync(handle: FileHandle, record: unknown): Promise<void> {
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(path: string, expectedUid: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o077) !== 0) {
      throw new LocalSupervisorStoreError(
        "unsafe_permissions",
        `private record "${path}" is not an owner-only regular file`,
      );
    }
    if (metadata.size > MAX_RECORD_BYTES) {
      throw new LocalSupervisorStoreError(
        "corrupt",
        `private record "${path}" exceeds ${MAX_RECORD_BYTES} bytes`,
      );
    }
    return await handle.readFile("utf8");
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

function sameWorkerIdentity(left: WorkerDescriptor, right: WorkerDescriptor): boolean {
  return (
    left.workerId === right.workerId &&
    left.jobId === right.jobId &&
    left.runId === right.runId &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.jobDigest === right.jobDigest &&
    left.socketPath === right.socketPath &&
    left.startedAt === right.startedAt
  );
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) {
    throw new LocalSupervisorStoreError("corrupt", `invalid run id "${runId}"`);
  }
}

function validateUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new LocalSupervisorStoreError("corrupt", `invalid ${label} "${value}"`);
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new LocalSupervisorStoreError(
      "unsafe_permissions",
      "detached supervision requires a POSIX user id",
    );
  }
  return uid;
}

function storeIoError(message: string, cause: unknown): LocalSupervisorStoreError {
  return cause instanceof LocalSupervisorStoreError
    ? cause
    : new LocalSupervisorStoreError("io", message, { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
