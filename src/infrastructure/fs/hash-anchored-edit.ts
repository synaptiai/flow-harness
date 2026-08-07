import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename as renameFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const MAX_EDIT_REPLACEMENTS = 32;
export const MAX_EDIT_INPUT_BYTES = 262_144;
export const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;

export interface ExactTextEdit {
  readonly oldText: string;
  readonly newText: string;
}

export interface HashAnchoredEditRequest {
  readonly expectedSha256: string;
  readonly edits: readonly ExactTextEdit[];
}

export interface HashAnchoredEditResult {
  readonly beforeSha256: string;
  readonly afterSha256: string;
}

export interface HashAnchoredEditBoundary extends HashAnchoredEditResult {
  readonly mode: number;
}

export type HashAnchoredEditBoundarySettlement =
  | { readonly outcome: "committed"; readonly reason: "directory_synced" }
  | { readonly outcome: "not_applied"; readonly reason: "commit_not_entered" }
  | { readonly outcome: "unknown"; readonly reason: "post_commit_failure" };

export interface HashAnchoredEditEffectLifecycle {
  prepare(boundary: HashAnchoredEditBoundary): Promise<void>;
  settle(settlement: HashAnchoredEditBoundarySettlement): Promise<void>;
}

export interface HashAnchoredEditOptions {
  readonly signal?: AbortSignal;
  readonly effectLifecycle?: HashAnchoredEditEffectLifecycle;
  readonly removeTemporary?: (path: string) => Promise<void>;
  readonly rename?: (temporaryPath: string, targetPath: string) => Promise<void>;
  readonly syncDirectory?: (directory: string) => Promise<void>;
}

export type HashAnchoredEditErrorCode =
  | "aborted"
  | "effect_uncertain"
  | "file_too_large"
  | "invalid_input"
  | "invalid_target"
  | "invalid_utf8"
  | "io_failure"
  | "no_change"
  | "replacement_ambiguous"
  | "replacement_not_found"
  | "replacement_overlap"
  | "stale_version"
  | "target_busy";

export class HashAnchoredEditError extends Error {
  override readonly name: string = "HashAnchoredEditError";

  constructor(
    readonly code: HashAnchoredEditErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class HashAnchoredEditUncertainError extends HashAnchoredEditError {
  override readonly name = "HashAnchoredEditUncertainError";

  constructor(
    readonly result: HashAnchoredEditResult,
    cause: unknown,
  ) {
    super(
      "effect_uncertain",
      `edit committed but durability acknowledgement is uncertain: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

const mutationQueues = new Map<string, Promise<void>>();

export async function editHashAnchoredTextFile(
  target: string,
  request: HashAnchoredEditRequest,
  options: HashAnchoredEditOptions = {},
): Promise<HashAnchoredEditResult> {
  validateRequest(request);
  throwIfAborted(options.signal);
  return await withMutationQueue(target, async () => {
    throwIfAborted(options.signal);
    return await editInQueue(target, request, options);
  });
}

async function editInQueue(
  target: string,
  request: HashAnchoredEditRequest,
  options: HashAnchoredEditOptions,
): Promise<HashAnchoredEditResult> {
  const lock = await acquireCrossProcessEditLock(target);
  let result: HashAnchoredEditResult | undefined;
  let operationError: unknown;
  try {
    result = await editWhileLocked(target, request, options);
  } catch (error) {
    operationError = error;
  }

  try {
    await lock.release();
  } catch (releaseError) {
    const committedResult =
      result ??
      (operationError instanceof HashAnchoredEditUncertainError
        ? operationError.result
        : undefined);
    if (committedResult !== undefined) {
      throw new HashAnchoredEditUncertainError(
        committedResult,
        new AggregateError(
          operationError === undefined ? [releaseError] : [operationError, releaseError],
          "edit lock release failed after target commit",
        ),
      );
    }
    throw ioFailure(
      `edit failed and its cross-process lock could not be released (${errorMessage(operationError)})`,
      releaseError,
    );
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (result === undefined) {
    throw new HashAnchoredEditError("io_failure", "edit completed without a result");
  }
  return result;
}

async function editWhileLocked(
  target: string,
  request: HashAnchoredEditRequest,
  options: HashAnchoredEditOptions,
): Promise<HashAnchoredEditResult> {
  const metadata = await readRegularFileMetadata(target);
  throwIfAborted(options.signal);
  if (metadata.size > MAX_EDIT_FILE_BYTES) {
    throw new HashAnchoredEditError(
      "file_too_large",
      `edit target exceeds ${MAX_EDIT_FILE_BYTES} bytes`,
    );
  }

  let beforeBytes: Buffer;
  try {
    beforeBytes = await readFile(target);
  } catch (error) {
    throw ioFailure("could not read edit target", error);
  }
  throwIfAborted(options.signal);
  if (beforeBytes.length > MAX_EDIT_FILE_BYTES) {
    throw new HashAnchoredEditError(
      "file_too_large",
      `edit target exceeds ${MAX_EDIT_FILE_BYTES} bytes`,
    );
  }

  const beforeSha256 = sha256(beforeBytes);
  if (beforeSha256 !== request.expectedSha256) {
    throw new HashAnchoredEditError(
      "stale_version",
      `edit target is stale: expected ${request.expectedSha256}, received ${beforeSha256}`,
    );
  }

  const beforeText = decodeUtf8(beforeBytes);
  const afterText = applyExactEdits(beforeText, request.edits);
  const afterBytes = Buffer.from(afterText, "utf8");
  if (afterBytes.length > MAX_EDIT_FILE_BYTES) {
    throw new HashAnchoredEditError(
      "file_too_large",
      `edited target exceeds ${MAX_EDIT_FILE_BYTES} bytes`,
    );
  }
  const result = Object.freeze({ beforeSha256, afterSha256: sha256(afterBytes) });

  const temporaryPath = join(
    dirname(target),
    `.flow-edit-${sha256(Buffer.from(target)).slice(0, 16)}-${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  let renamed = false;
  let prepared = false;
  let settlementAttempted = false;
  try {
    const expectedMode = metadata.mode & 0o777;
    const handle = await openTemporaryFile(temporaryPath, expectedMode);
    temporaryCreated = true;
    await writeAndSyncTemporary(handle, afterBytes, expectedMode);
    throwIfAborted(options.signal);

    const currentMetadata = await readRegularFileMetadata(target);
    if (currentMetadata.size > MAX_EDIT_FILE_BYTES) {
      throw new HashAnchoredEditError(
        "file_too_large",
        `edit target exceeds ${MAX_EDIT_FILE_BYTES} bytes before commit`,
      );
    }
    const currentBytes = await readFile(target).catch((error: unknown) => {
      throw ioFailure("could not re-read edit target before commit", error);
    });
    throwIfAborted(options.signal);
    if (sha256(currentBytes) !== beforeSha256) {
      throw new HashAnchoredEditError(
        "stale_version",
        "edit target changed while the replacement was being prepared",
      );
    }
    if ((currentMetadata.mode & 0o777) !== expectedMode) {
      throw new HashAnchoredEditError(
        "stale_version",
        "edit target mode changed while the replacement was being prepared",
      );
    }

    if (options.effectLifecycle !== undefined) {
      await options.effectLifecycle.prepare({ ...result, mode: expectedMode });
      prepared = true;
      throwIfAborted(options.signal);
    }

    await (options.rename ?? renameFile)(temporaryPath, target);
    renamed = true;
    temporaryCreated = false;
  } catch (error) {
    let failure = error;
    if (temporaryCreated) {
      try {
        await removeTemporaryFile(temporaryPath, error, options.removeTemporary ?? unlink);
      } catch (cleanupError) {
        failure = cleanupError;
      }
    }
    if (prepared && !renamed && options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      try {
        await options.effectLifecycle.settle({
          outcome: "not_applied",
          reason: "commit_not_entered",
        });
      } catch (settlementError) {
        failure = ioFailure(
          `edit failed before commit and its effect settlement also failed (${errorMessage(failure)})`,
          new AggregateError(
            [failure, settlementError],
            "pre-commit edit failure and effect settlement both failed",
          ),
        );
      }
    }
    if (failure instanceof HashAnchoredEditError) {
      throw failure;
    }
    throw ioFailure("could not atomically replace edit target", failure);
  }

  try {
    throwIfAborted(options.signal);
    await (options.syncDirectory ?? syncDirectory)(dirname(target));
    if (options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      await options.effectLifecycle.settle({
        outcome: "committed",
        reason: "directory_synced",
      });
    }
    return result;
  } catch (error) {
    if (!renamed) {
      throw error;
    }
    let cause = error;
    if (prepared && !settlementAttempted && options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      try {
        await options.effectLifecycle.settle({
          outcome: "unknown",
          reason: "post_commit_failure",
        });
      } catch (settlementError) {
        cause = new AggregateError(
          [error, settlementError],
          "post-commit operation and effect settlement both failed",
        );
      }
    }
    throw new HashAnchoredEditUncertainError(result, cause);
  }
}

function validateRequest(request: HashAnchoredEditRequest): void {
  if (!/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
    throw new HashAnchoredEditError(
      "invalid_input",
      "expectedSha256 must be a lowercase SHA-256 hex value",
    );
  }
  if (request.edits.length === 0 || request.edits.length > MAX_EDIT_REPLACEMENTS) {
    throw new HashAnchoredEditError(
      "invalid_input",
      `edits must contain between 1 and ${MAX_EDIT_REPLACEMENTS} replacements`,
    );
  }
  let totalBytes = 0;
  for (const [index, edit] of request.edits.entries()) {
    if (!hasOnlyValidUnicodeScalars(edit.oldText) || !hasOnlyValidUnicodeScalars(edit.newText)) {
      throw new HashAnchoredEditError(
        "invalid_input",
        `edits[${index}] must contain valid Unicode scalar values`,
      );
    }
    if (edit.oldText.length === 0) {
      throw new HashAnchoredEditError("invalid_input", `edits[${index}].oldText must not be empty`);
    }
    totalBytes += Buffer.byteLength(edit.oldText, "utf8");
    totalBytes += Buffer.byteLength(edit.newText, "utf8");
  }
  if (totalBytes > MAX_EDIT_INPUT_BYTES) {
    throw new HashAnchoredEditError(
      "invalid_input",
      `edit replacements exceed ${MAX_EDIT_INPUT_BYTES} UTF-8 bytes`,
    );
  }
}

function hasOnlyValidUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function applyExactEdits(content: string, edits: readonly ExactTextEdit[]): string {
  const matches = edits.map((edit, index) => {
    const first = content.indexOf(edit.oldText);
    if (first === -1) {
      throw new HashAnchoredEditError(
        "replacement_not_found",
        `edits[${index}].oldText was not found exactly`,
      );
    }
    if (content.indexOf(edit.oldText, first + 1) !== -1) {
      throw new HashAnchoredEditError(
        "replacement_ambiguous",
        `edits[${index}].oldText is not unique`,
      );
    }
    return { index, start: first, end: first + edit.oldText.length, newText: edit.newText };
  });

  matches.sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      throw new HashAnchoredEditError(
        "replacement_overlap",
        `edits[${previous.index}] and edits[${current.index}] overlap`,
      );
    }
  }

  let output = content;
  for (const match of [...matches].reverse()) {
    output = `${output.slice(0, match.start)}${match.newText}${output.slice(match.end)}`;
  }
  if (output === content) {
    throw new HashAnchoredEditError("no_change", "edit replacements do not change the target");
  }
  return output;
}

async function readRegularFileMetadata(target: string): Promise<{ size: number; mode: number }> {
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile()) {
      throw new HashAnchoredEditError("invalid_target", "edit target must be a regular file");
    }
    return { size: metadata.size, mode: metadata.mode };
  } catch (error) {
    if (error instanceof HashAnchoredEditError) {
      throw error;
    }
    throw new HashAnchoredEditError(
      "invalid_target",
      `edit target is unavailable: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new HashAnchoredEditError("invalid_utf8", "edit target is not valid UTF-8", {
      cause: error,
    });
  }
}

async function openTemporaryFile(path: string, mode: number): Promise<FileHandle> {
  try {
    return await open(path, "wx", mode);
  } catch (error) {
    throw ioFailure("could not create exclusive edit temporary file", error);
  }
}

async function writeAndSyncTemporary(
  handle: FileHandle,
  content: Buffer,
  mode: number,
): Promise<void> {
  let operationError: unknown;
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined) {
    throw ioFailure("could not write and sync edit temporary file", operationError);
  }
}

async function removeTemporaryFile(
  path: string,
  originalError: unknown,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  try {
    await remove(path);
  } catch (cleanupError) {
    if (!isMissingPath(cleanupError)) {
      throw ioFailure(
        `edit failed and temporary cleanup also failed (${errorMessage(originalError)})`,
        cleanupError,
      );
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  let operationError: unknown;
  try {
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
}

interface CrossProcessEditLock {
  release(): Promise<void>;
}

interface EditLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
}

async function acquireCrossProcessEditLock(target: string): Promise<CrossProcessEditLock> {
  const directory = dirname(target);
  const lockPath = join(directory, `.flow-edit-${sha256(Buffer.from(target))}.lock`);
  const token = randomUUID();
  const owner: EditLockOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    token,
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw ioFailure("could not acquire cross-process edit lock", error);
      }
      const existing = await readEditLockOwner(lockPath);
      if (
        existing !== undefined &&
        existing.hostname === owner.hostname &&
        !isProcessAlive(existing.pid)
      ) {
        try {
          await unlink(lockPath);
        } catch (unlinkError) {
          if (!(isNodeError(unlinkError) && unlinkError.code === "ENOENT")) {
            throw ioFailure("could not retire stale cross-process edit lock", unlinkError);
          }
        }
        continue;
      }
      throw new HashAnchoredEditError(
        "target_busy",
        existing === undefined
          ? "edit target has an incomplete or corrupt cross-process lock"
          : `edit target is owned by Flow process ${existing.pid} on ${existing.hostname}`,
      );
    }

    let writeError: unknown;
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      writeError = error;
    }
    try {
      await handle.close();
    } catch (error) {
      writeError ??= error;
    }
    if (writeError !== undefined) {
      await unlink(lockPath).catch(() => undefined);
      throw ioFailure("could not publish cross-process edit lock", writeError);
    }

    return Object.freeze({
      release: async () => {
        const current = await readEditLockOwner(lockPath);
        if (current?.token !== token) {
          throw new HashAnchoredEditError(
            "io_failure",
            "cross-process edit lock ownership changed before release",
          );
        }
        await unlink(lockPath).catch((error: unknown) => {
          throw ioFailure("could not release cross-process edit lock", error);
        });
      },
    });
  }

  throw new HashAnchoredEditError(
    "target_busy",
    "cross-process edit lock changed repeatedly; edit was refused",
  );
}

async function readEditLockOwner(lockPath: string): Promise<EditLockOwner | undefined> {
  let input: string;
  try {
    input = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw ioFailure("could not inspect cross-process edit lock", error);
  }

  try {
    const value = JSON.parse(input) as Partial<EditLockOwner>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.hostname !== "string" ||
      value.hostname.length === 0 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.token)
    ) {
      return undefined;
    }
    return value as EditLockOwner;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

async function withMutationQueue<T>(target: string, effect: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(target) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  mutationQueues.set(target, chained);
  await previous;
  try {
    return await effect();
  } finally {
    release();
    if (mutationQueues.get(target) === chained) {
      mutationQueues.delete(target);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HashAnchoredEditError("aborted", "edit operation was cancelled", {
      cause: signal.reason,
    });
  }
}

function ioFailure(message: string, cause: unknown): HashAnchoredEditError {
  return new HashAnchoredEditError("io_failure", `${message}: ${errorMessage(cause)}`, { cause });
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
