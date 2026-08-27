import type { BigIntStats, Dirent } from "node:fs";
import { chmod, lstat, mkdir, opendir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  EMPTY_DIRECTORY_STATE_SHA256,
  type FilesystemMkdirEffectDescriptor,
  type NodeEffectReconciliationInput,
} from "../../domain/run/events.js";
import {
  acquireCrossProcessEditLock,
  type CrossProcessEditLock,
  sameObservedIdentity,
  syncDirectory,
  withMutationQueue,
} from "./hash-anchored-edit.js";

export const DIRECTORY_CREATE_MODE: 0o755 = 0o755;
export const EMPTY_DIRECTORY_SHA256 = EMPTY_DIRECTORY_STATE_SHA256;

export interface ExclusiveDirectoryCreateResult {
  readonly afterSha256: typeof EMPTY_DIRECTORY_SHA256;
}

export interface ExclusiveDirectoryCreateBoundary extends ExclusiveDirectoryCreateResult {
  readonly beforeSha256: null;
  readonly mode: typeof DIRECTORY_CREATE_MODE;
}

export type ExclusiveDirectoryCreateSettlement =
  | { readonly outcome: "committed"; readonly reason: "directory_synced" }
  | { readonly outcome: "not_applied"; readonly reason: "commit_not_entered" }
  | { readonly outcome: "unknown"; readonly reason: "post_commit_failure" };

export interface ExclusiveDirectoryCreateOptions {
  readonly signal?: AbortSignal;
  readonly effectLifecycle?: {
    prepare(boundary: ExclusiveDirectoryCreateBoundary): Promise<void>;
    settle(settlement: ExclusiveDirectoryCreateSettlement): Promise<void>;
  };
  readonly create?: (target: string, mode: number) => Promise<void>;
  readonly setMode?: (target: string, mode: number) => Promise<void>;
  readonly syncTarget?: (target: string) => Promise<void>;
  readonly syncParent?: (parent: string) => Promise<void>;
}

export interface ExclusiveDirectoryReconciliationOptions {
  readonly signal?: AbortSignal;
  readonly beforeIdentityRecheck?: () => Promise<void>;
  readonly beforeMissingTargetRecheck?: () => Promise<void>;
  readonly readDirectoryEntry?: (target: string) => Promise<Dirent<string> | null>;
}

export type ExclusiveDirectoryCreateErrorCode =
  | "aborted"
  | "effect_uncertain"
  | "invalid_target"
  | "io_failure"
  | "target_busy"
  | "target_exists";

export class ExclusiveDirectoryCreateError extends Error {
  override readonly name: string = "ExclusiveDirectoryCreateError";

  constructor(
    readonly code: ExclusiveDirectoryCreateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ExclusiveDirectoryCreateUncertainError extends ExclusiveDirectoryCreateError {
  override readonly name = "ExclusiveDirectoryCreateUncertainError";

  constructor(
    readonly result: ExclusiveDirectoryCreateResult,
    cause: unknown,
  ) {
    super(
      "effect_uncertain",
      `directory creation committed but durability acknowledgement is uncertain: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

export async function createExclusiveDirectory(
  target: string,
  options: ExclusiveDirectoryCreateOptions = {},
): Promise<ExclusiveDirectoryCreateResult> {
  throwIfAborted(options.signal);
  return await withMutationQueue(target, async () => {
    throwIfAborted(options.signal);
    return await createInQueue(target, options);
  });
}

export async function reconcileExclusiveDirectoryCreateEffect(
  descriptor: FilesystemMkdirEffectDescriptor,
  publish: (observation: NodeEffectReconciliationInput) => Promise<void>,
  options: ExclusiveDirectoryReconciliationOptions = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await withMutationQueue(descriptor.target, async () => {
    throwIfAborted(options.signal);
    let lock: CrossProcessEditLock;
    try {
      lock = await acquireCrossProcessEditLock(descriptor.target);
    } catch (error) {
      if (!causedByMissingPath(error)) {
        throw directoryFailure("could not acquire directory-reconciliation lock", error);
      }
      await options.beforeMissingTargetRecheck?.();
      const observation = await observeDirectory(descriptor, options);
      if (observation.reason !== "target_missing") {
        throw directoryFailure("could not acquire directory-reconciliation lock", error);
      }
      throwIfAborted(options.signal);
      await publish(observation);
      return;
    }

    let operationError: unknown;
    try {
      const observation = await observeDirectory(descriptor, options);
      throwIfAborted(options.signal);
      await publish(observation);
    } catch (error) {
      operationError = error;
    }
    try {
      await lock.release();
    } catch (releaseError) {
      operationError = new AggregateError(
        operationError === undefined ? [releaseError] : [operationError, releaseError],
        "directory reconciliation lock release failed",
      );
    }
    if (operationError !== undefined) {
      throw directoryFailure("directory reconciliation failed", operationError);
    }
  });
}

async function createInQueue(
  target: string,
  options: ExclusiveDirectoryCreateOptions,
): Promise<ExclusiveDirectoryCreateResult> {
  let lock: CrossProcessEditLock;
  try {
    lock = await acquireCrossProcessEditLock(target);
  } catch (error) {
    throw directoryFailure("could not acquire directory-creation lock", error);
  }

  let result: ExclusiveDirectoryCreateResult | undefined;
  let operationError: unknown;
  try {
    result = await createWhileLocked(target, options);
  } catch (error) {
    operationError = error;
  }

  try {
    await lock.release();
  } catch (releaseError) {
    const committedResult =
      result ??
      (operationError instanceof ExclusiveDirectoryCreateUncertainError
        ? operationError.result
        : undefined);
    if (committedResult !== undefined) {
      throw new ExclusiveDirectoryCreateUncertainError(
        committedResult,
        new AggregateError(
          operationError === undefined ? [releaseError] : [operationError, releaseError],
          "directory-creation lock release failed after mkdir",
        ),
      );
    }
    throw directoryFailure(
      "directory creation failed and its lock could not be released",
      new AggregateError(
        operationError === undefined ? [releaseError] : [operationError, releaseError],
      ),
    );
  }

  if (operationError !== undefined) {
    throw operationError;
  }
  if (result === undefined) {
    throw new ExclusiveDirectoryCreateError(
      "io_failure",
      "directory creation completed without a result",
    );
  }
  return result;
}

async function createWhileLocked(
  target: string,
  options: ExclusiveDirectoryCreateOptions,
): Promise<ExclusiveDirectoryCreateResult> {
  await requireAbsentTarget(target);
  throwIfAborted(options.signal);
  const result = Object.freeze({ afterSha256: EMPTY_DIRECTORY_SHA256 });
  let prepared = false;
  let committed = false;
  let settlementAttempted = false;

  try {
    if (options.effectLifecycle !== undefined) {
      await options.effectLifecycle.prepare({
        beforeSha256: null,
        afterSha256: EMPTY_DIRECTORY_SHA256,
        mode: DIRECTORY_CREATE_MODE,
      });
      prepared = true;
      throwIfAborted(options.signal);
    }
    await (options.create ?? createDirectory)(target, DIRECTORY_CREATE_MODE);
    committed = true;
    throwIfAborted(options.signal);
    await (options.setMode ?? chmod)(target, DIRECTORY_CREATE_MODE);
    throwIfAborted(options.signal);
    await requireExactCreatedState(target);
    throwIfAborted(options.signal);
    await (options.syncTarget ?? syncDirectory)(target);
    throwIfAborted(options.signal);
    await (options.syncParent ?? syncDirectory)(dirname(target));
    throwIfAborted(options.signal);
    if (options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      await options.effectLifecycle.settle({ outcome: "committed", reason: "directory_synced" });
    }
    return result;
  } catch (error) {
    let cause = error;
    if (prepared && !committed && options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      try {
        await options.effectLifecycle.settle({
          outcome: "not_applied",
          reason: "commit_not_entered",
        });
      } catch (settlementError) {
        cause = new AggregateError(
          [cause, settlementError],
          "pre-mkdir failure and effect settlement both failed",
        );
      }
    } else if (committed && !settlementAttempted && options.effectLifecycle !== undefined) {
      settlementAttempted = true;
      try {
        await options.effectLifecycle.settle({
          outcome: "unknown",
          reason: "post_commit_failure",
        });
      } catch (settlementError) {
        cause = new AggregateError(
          [cause, settlementError],
          "post-mkdir failure and effect settlement both failed",
        );
      }
    }
    if (committed) {
      throw new ExclusiveDirectoryCreateUncertainError(result, cause);
    }
    throw directoryFailure("could not create directory exclusively", cause);
  }
}

async function createDirectory(target: string, mode: number): Promise<void> {
  await mkdir(target, { mode, recursive: false });
}

async function requireAbsentTarget(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw directoryFailure("could not inspect directory-creation target", error);
  }
  throw new ExclusiveDirectoryCreateError(
    "target_exists",
    "directory-creation target already exists and will not be replaced",
  );
}

async function requireExactCreatedState(target: string): Promise<void> {
  let before: BigIntStats;
  let after: BigIntStats;
  let firstEntry: Dirent<string> | null;
  try {
    before = await lstat(target, { bigint: true });
    firstEntry = await readFirstDirectoryEntry(target);
    after = await lstat(target, { bigint: true });
  } catch (error) {
    throw directoryFailure("could not verify created directory", error);
  }
  if (!before.isDirectory() || !after.isDirectory() || !sameObservedIdentity(before, after)) {
    throw new ExclusiveDirectoryCreateError(
      "io_failure",
      "created directory identity changed before durable settlement",
    );
  }
  if ((after.mode & 0o777n) !== BigInt(DIRECTORY_CREATE_MODE) || firstEntry !== null) {
    throw new ExclusiveDirectoryCreateError(
      "io_failure",
      "created directory state changed before durable settlement",
    );
  }
}

async function observeDirectory(
  descriptor: FilesystemMkdirEffectDescriptor,
  options: ExclusiveDirectoryReconciliationOptions,
): Promise<NodeEffectReconciliationInput> {
  let before: BigIntStats;
  try {
    before = await lstat(descriptor.target, { bigint: true });
  } catch (error) {
    return unavailableObservation(error);
  }
  if (!before.isDirectory()) {
    return { outcome: "unknown", reason: "target_not_directory" };
  }

  let firstEntry: Dirent<string> | null;
  try {
    firstEntry = await (options.readDirectoryEntry ?? readFirstDirectoryEntry)(descriptor.target);
    await options.beforeIdentityRecheck?.();
  } catch (error) {
    return isNodeError(error)
      ? { outcome: "unknown", reason: "target_unreadable" }
      : Promise.reject(error);
  }

  let after: BigIntStats;
  try {
    after = await lstat(descriptor.target, { bigint: true });
  } catch (error) {
    return isNodeError(error)
      ? { outcome: "unknown", reason: "target_changed_during_observation" }
      : Promise.reject(error);
  }
  if (!after.isDirectory() || !sameObservedIdentity(before, after)) {
    return { outcome: "unknown", reason: "target_changed_during_observation" };
  }

  const observedMode = Number(after.mode & 0o777n);
  if (firstEntry !== null) {
    return { outcome: "unknown", reason: "target_not_empty" };
  }
  if (observedMode !== descriptor.mode) {
    return {
      outcome: "unknown",
      reason: "target_mode_diverged",
      observedSha256: EMPTY_DIRECTORY_SHA256,
      observedMode,
    };
  }
  return {
    outcome: "applied",
    reason: "target_matches_after",
    observedSha256: EMPTY_DIRECTORY_SHA256,
    observedMode,
  };
}

async function readFirstDirectoryEntry(target: string): Promise<Dirent<string> | null> {
  const directory = await opendir(target);
  let entry: Dirent<string> | null = null;
  let operationError: unknown;
  try {
    entry = await directory.read();
  } catch (error) {
    operationError = error;
  }
  try {
    await directory.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return entry;
}

function unavailableObservation(error: unknown): NodeEffectReconciliationInput {
  if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
    return { outcome: "unknown", reason: "target_missing" };
  }
  if (isNodeError(error)) {
    return { outcome: "unknown", reason: "target_unreadable" };
  }
  throw error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ExclusiveDirectoryCreateError("aborted", "directory creation was cancelled", {
      cause: signal.reason,
    });
  }
}

function directoryFailure(message: string, cause: unknown): ExclusiveDirectoryCreateError {
  if (cause instanceof ExclusiveDirectoryCreateError) {
    return cause;
  }
  if (causedByMissingPath(cause)) {
    return new ExclusiveDirectoryCreateError(
      "invalid_target",
      `${message}: the target parent directory is unavailable`,
      { cause },
    );
  }
  if (isNodeError(cause) && cause.code === "EEXIST") {
    return new ExclusiveDirectoryCreateError(
      "target_exists",
      "directory-creation target already exists and will not be replaced",
      { cause },
    );
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "target_busy"
  ) {
    return new ExclusiveDirectoryCreateError("target_busy", cause.message, { cause });
  }
  return new ExclusiveDirectoryCreateError("io_failure", `${message}: ${errorMessage(cause)}`, {
    cause,
  });
}

function causedByMissingPath(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isNodeError(current) && (current.code === "ENOENT" || current.code === "ENOTDIR")) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
