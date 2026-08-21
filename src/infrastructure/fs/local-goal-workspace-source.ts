import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import {
  type GoalWorkspaceSource,
  MAX_GOAL_WORKSPACE_SOURCE_BYTES,
  parseGoalWorkspaceSourceText,
} from "../../domain/goal/workspace.js";

export type LocalGoalWorkspaceSourceErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalGoalWorkspaceSourceError extends Error {
  override readonly name = "LocalGoalWorkspaceSourceError";

  constructor(
    readonly code: LocalGoalWorkspaceSourceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface LocalGoalWorkspaceSource {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly source: GoalWorkspaceSource;
}

export interface LocalGoalWorkspaceSourceOptions {
  readonly signal?: AbortSignal;
  /** @internal Test seam after the opened file bytes have been read. */
  readonly afterRead?: () => Promise<void> | void;
}

export async function readLocalGoalWorkspaceSource(
  path: string,
  options: LocalGoalWorkspaceSourceOptions = {},
): Promise<LocalGoalWorkspaceSource> {
  options.signal?.throwIfAborted();
  const sourcePath = resolve(path);
  let handle: FileHandle;
  try {
    handle = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch {
    options.signal?.throwIfAborted();
    throw new LocalGoalWorkspaceSourceError(
      "invalid_path",
      "goal workspace source cannot be opened safely",
    );
  }
  options.signal?.throwIfAborted();

  let operation:
    | { readonly status: "resolved"; readonly value: LocalGoalWorkspaceSource }
    | { readonly status: "rejected"; readonly error: unknown };
  try {
    operation = {
      status: "resolved",
      value: await readOpenedSource(handle, sourcePath, options),
    };
  } catch (error) {
    operation = { status: "rejected", error };
  }

  try {
    await handle.close();
  } catch {
    options.signal?.throwIfAborted();
    if (operation.status === "rejected") throw operation.error;
    throw new LocalGoalWorkspaceSourceError(
      "invalid_path",
      "goal workspace source could not be settled",
    );
  }
  options.signal?.throwIfAborted();
  if (operation.status === "rejected") throw operation.error;
  return operation.value;
}

async function readOpenedSource(
  handle: FileHandle,
  sourcePath: string,
  options: LocalGoalWorkspaceSourceOptions,
): Promise<LocalGoalWorkspaceSource> {
  const before = await handle.stat({ bigint: true });
  options.signal?.throwIfAborted();
  assertAdmittedSource(before);
  if (before.size > BigInt(MAX_GOAL_WORKSPACE_SOURCE_BYTES)) {
    throw new LocalGoalWorkspaceSourceError(
      "limit_exceeded",
      `goal workspace source exceeds ${MAX_GOAL_WORKSPACE_SOURCE_BYTES} bytes`,
    );
  }

  const content = await readBounded(handle, options.signal);
  options.signal?.throwIfAborted();
  await options.afterRead?.();
  options.signal?.throwIfAborted();
  const after = await handle.stat({ bigint: true });
  options.signal?.throwIfAborted();
  let current: BigIntStats;
  try {
    current = await lstat(sourcePath, { bigint: true });
  } catch {
    options.signal?.throwIfAborted();
    throw new LocalGoalWorkspaceSourceError(
      "source_changed",
      "goal workspace source changed while it was read",
    );
  }
  options.signal?.throwIfAborted();
  if (!sameSource(before, after) || !sameSource(after, current)) {
    throw new LocalGoalWorkspaceSourceError(
      "source_changed",
      "goal workspace source changed while it was read",
    );
  }

  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new LocalGoalWorkspaceSourceError(
      "invalid_source",
      "goal workspace source is not valid UTF-8",
    );
  }
  let source: GoalWorkspaceSource;
  try {
    source = parseGoalWorkspaceSourceText(sourceText, "goal workspace source");
  } catch {
    throw new LocalGoalWorkspaceSourceError("invalid_source", "goal workspace source is invalid");
  }
  return Object.freeze({ sourcePath, sourceText, source });
}

async function readBounded(handle: FileHandle, signal: AbortSignal | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, MAX_GOAL_WORKSPACE_SOURCE_BYTES + 1 - total),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_GOAL_WORKSPACE_SOURCE_BYTES) {
      throw new LocalGoalWorkspaceSourceError(
        "limit_exceeded",
        `goal workspace source exceeds ${MAX_GOAL_WORKSPACE_SOURCE_BYTES} bytes`,
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function assertAdmittedSource(stat: BigIntStats): void {
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (currentUid !== undefined && stat.uid !== BigInt(currentUid))
  ) {
    throw new LocalGoalWorkspaceSourceError(
      "invalid_path",
      "goal workspace source must be one owned regular file",
    );
  }
}

function sameSource(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
