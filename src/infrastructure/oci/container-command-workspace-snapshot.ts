import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, opendir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_EXCLUSIONS = 4_096;
const READ_CHUNK_BYTES = 65_536;

export interface ContainerCommandWorkspaceSnapshotRequest {
  readonly workspace: string;
  readonly excludedPaths?: readonly string[];
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

interface SnapshotState {
  entries: number;
  bytes: number;
  readonly digest: ReturnType<typeof createHash>;
}

export async function observeContainerCommandWorkspaceSnapshot(
  request: ContainerCommandWorkspaceSnapshotRequest,
): Promise<string> {
  if (!isAbsolute(request.workspace)) {
    throw new Error("container command workspace snapshot root is invalid");
  }
  const maxEntries = checkedLimit(
    request.maxEntries ?? DEFAULT_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES,
    "entry",
  );
  const maxBytes = checkedLimit(
    request.maxBytes ?? DEFAULT_MAX_BYTES,
    DEFAULT_MAX_BYTES,
    "content",
  );
  const exclusions = normalizeExclusions(request.workspace, request.excludedPaths ?? []);
  const state: SnapshotState = {
    entries: 0,
    bytes: 0,
    digest: createHash("sha256"),
  };
  state.digest.update("flow-container-command-workspace-v1\0");
  for (const exclusion of exclusions) {
    state.digest.update(`excluded\0${exclusion}\0`);
  }
  await observeDirectory(
    request.workspace,
    "",
    exclusions,
    state,
    maxEntries,
    maxBytes,
    request.signal,
  );
  return state.digest.digest("hex");
}

async function observeDirectory(
  absoluteDirectory: string,
  relativeDirectory: string,
  exclusions: readonly string[],
  state: SnapshotState,
  maxEntries: number,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const before = await lstat(absoluteDirectory, { bigint: true });
  if (!before.isDirectory()) {
    throw new Error("container command workspace snapshot directory is invalid");
  }
  const directory = await opendir(absoluteDirectory);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      state.entries += 1;
      if (state.entries > maxEntries) {
        throw new Error("container command workspace snapshot exceeds its entry limit");
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  names.sort((left, right) => left.localeCompare(right, "en"));

  for (const name of names) {
    throwIfAborted(signal);
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (isExcluded(relativePath, exclusions)) {
      continue;
    }
    const absolutePath = join(absoluteDirectory, name);
    const metadata = await lstat(absolutePath, { bigint: true });

    if (metadata.isDirectory()) {
      state.digest.update(`directory\0${relativePath}\0${permissionMode(metadata.mode)}\0`);
      await observeDirectory(
        absolutePath,
        relativePath,
        exclusions,
        state,
        maxEntries,
        maxBytes,
        signal,
      );
      continue;
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const after = await lstat(absolutePath, { bigint: true });
      assertStableMetadata(metadata, after);
      state.digest.update(
        `symlink\0${relativePath}\0${permissionMode(metadata.mode)}\0${target}\0`,
      );
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error("container command workspace snapshot contains an unsupported entry");
    }

    const size = Number(metadata.size);
    state.bytes += size;
    if (!Number.isSafeInteger(size) || state.bytes > maxBytes) {
      throw new Error("container command workspace snapshot exceeds its content limit");
    }
    const contentDigest = await hashStableFile(absolutePath, metadata, size, signal);
    state.digest.update(
      `file\0${relativePath}\0${permissionMode(metadata.mode)}\0${size}\0${contentDigest}\0`,
    );
  }

  const after = await lstat(absoluteDirectory, { bigint: true });
  assertStableMetadata(before, after);
}

async function hashStableFile(
  path: string,
  pathnameMetadata: BigIntStats,
  size: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedBefore = await handle.stat({ bigint: true });
    assertStableMetadata(pathnameMetadata, openedBefore);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < size) {
      throwIfAborted(signal);
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new Error("container command workspace snapshot source changed during observation");
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const extra = await handle.read(buffer, 0, 1, position);
    if (extra.bytesRead !== 0) {
      throw new Error("container command workspace snapshot source changed during observation");
    }
    const openedAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await lstat(path, { bigint: true });
    assertStableMetadata(openedBefore, openedAfter);
    assertStableMetadata(openedBefore, pathnameAfter);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function normalizeExclusions(workspace: string, inputs: readonly string[]): readonly string[] {
  if (inputs.length > MAX_EXCLUSIONS) {
    throw new Error("container command workspace snapshot has too many exclusions");
  }
  const normalized = new Set<string>();
  for (const input of inputs) {
    if (!isAbsolute(input)) {
      throw new Error("container command workspace snapshot exclusion is invalid");
    }
    const fromWorkspace = relative(workspace, input);
    if (
      fromWorkspace === "" ||
      fromWorkspace === ".." ||
      fromWorkspace.startsWith(`..${sep}`) ||
      isAbsolute(fromWorkspace)
    ) {
      throw new Error("container command workspace snapshot exclusion is outside the workspace");
    }
    normalized.add(fromWorkspace.split(sep).join("/"));
  }
  const minimal: string[] = [];
  for (const path of [...normalized].sort((left, right) => left.localeCompare(right, "en"))) {
    if (!minimal.some((parent) => path === parent || path.startsWith(`${parent}/`))) {
      minimal.push(path);
    }
  }
  return Object.freeze(minimal);
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function checkedLimit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`container command workspace snapshot ${name} limit is invalid`);
  }
  return value;
}

function permissionMode(mode: bigint): number {
  return Number(mode & 0o777n);
}

function assertStableMetadata(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("container command workspace snapshot source changed during observation");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("container command workspace snapshot was cancelled");
}
