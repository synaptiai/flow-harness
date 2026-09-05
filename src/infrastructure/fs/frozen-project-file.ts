import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const MAX_FROZEN_PROJECT_FILE_BYTES = 1_048_576;

const MAX_PROJECT_PATH_BYTES = 4_095;
const MAX_RELATIVE_PATH_BYTES = 4_095;
const MAX_PATH_SEGMENT_BYTES = 255;
const MAX_PATH_DEPTH = 64;

export type FrozenProjectFileErrorCode =
  | "request_invalid"
  | "path_invalid"
  | "unsafe_root"
  | "unsafe_path"
  | "file_unavailable"
  | "unsafe_file"
  | "file_too_large"
  | "file_changed";

export class FrozenProjectFileError extends Error {
  override readonly name = "FrozenProjectFileError";

  constructor(readonly code: FrozenProjectFileErrorCode) {
    super(`Frozen project file read failed: ${code}`);
  }
}

export interface FrozenProjectFileRequest {
  readonly projectRoot: string;
  readonly path: string;
  readonly maxBytes: number;
}

export interface FrozenProjectFile {
  readonly version: 1;
  readonly path: string;
  readonly byteLength: number;
  readonly contentBase64: string;
  readonly sha256: string;
}

interface PathObservation {
  readonly path: string;
  readonly metadata: BigIntStats;
}

/** Reads one admitted project file without following links and binds its exact content. */
export async function readFrozenProjectFile(
  request: FrozenProjectFileRequest,
): Promise<FrozenProjectFile> {
  validateRequest(request);
  const ownerId = currentUserId();
  const root = request.projectRoot;
  const rootObservation = await observeRoot(root, ownerId);
  const segments = request.path.split("/");
  const observations: PathObservation[] = [{ path: root, metadata: rootObservation }];
  let current = root;

  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const metadata = await observePath(current, "unsafe_path");
    if (!isSafeOwnedDirectory(metadata, ownerId)) {
      throw new FrozenProjectFileError("unsafe_path");
    }
    observations.push({ path: current, metadata });
  }

  const filePath = join(current, segments.at(-1) as string);
  const lexicalFile = await observePath(filePath, "file_unavailable");
  if (lexicalFile.isSymbolicLink()) {
    throw new FrozenProjectFileError("unsafe_path");
  }
  assertSafeOwnedFile(lexicalFile, ownerId, request.maxBytes);
  await assertCanonicalPath(filePath, "unsafe_file");

  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new FrozenProjectFileError("file_unavailable");
    }
    throw new FrozenProjectFileError("unsafe_file");
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameObservation(lexicalFile, opened)) {
      throw new FrozenProjectFileError("file_changed");
    }
    assertSafeOwnedFile(opened, ownerId, request.maxBytes);
    const content = await readExact(handle, Number(opened.size), request.maxBytes);
    const [after, lexicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      observePath(filePath, "file_changed"),
    ]);
    if (!sameObservation(opened, after) || !sameObservation(opened, lexicalAfter)) {
      throw new FrozenProjectFileError("file_changed");
    }
    await verifyPathObservations(observations, ownerId);
    await assertCanonicalPath(filePath, "file_changed");
    return Object.freeze({
      version: 1,
      path: request.path,
      byteLength: content.byteLength,
      contentBase64: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function validateRequest(request: FrozenProjectFileRequest): void {
  if (
    !isAbsolute(request.projectRoot) ||
    request.projectRoot.includes("\0") ||
    Buffer.byteLength(request.projectRoot, "utf8") > MAX_PROJECT_PATH_BYTES ||
    resolve(request.projectRoot) !== request.projectRoot ||
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > MAX_FROZEN_PROJECT_FILE_BYTES
  ) {
    throw new FrozenProjectFileError("request_invalid");
  }
  const segments = request.path.split("/");
  if (
    request.path.length === 0 ||
    request.path.includes("\0") ||
    request.path.includes("\\") ||
    request.path.startsWith("/") ||
    Buffer.byteLength(request.path, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    segments.length > MAX_PATH_DEPTH ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > MAX_PATH_SEGMENT_BYTES,
    )
  ) {
    throw new FrozenProjectFileError("path_invalid");
  }
}

async function observeRoot(root: string, ownerId: bigint): Promise<BigIntStats> {
  const metadata = await observePath(root, "unsafe_root");
  if (!isSafeOwnedDirectory(metadata, ownerId)) {
    throw new FrozenProjectFileError("unsafe_root");
  }
  await assertCanonicalPath(root, "unsafe_root");
  return metadata;
}

async function observePath(
  path: string,
  errorCode: "file_unavailable" | "file_changed" | "unsafe_path" | "unsafe_root",
): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw new FrozenProjectFileError(errorCode);
  }
}

async function assertCanonicalPath(
  path: string,
  errorCode: "file_changed" | "unsafe_file" | "unsafe_root",
): Promise<void> {
  try {
    if ((await realpath(path)) !== path) throw new FrozenProjectFileError(errorCode);
  } catch (error) {
    if (error instanceof FrozenProjectFileError) throw error;
    throw new FrozenProjectFileError(errorCode);
  }
}

function isSafeOwnedDirectory(metadata: BigIntStats, ownerId: bigint): boolean {
  return (
    metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    metadata.uid === ownerId &&
    (metadata.mode & 0o22n) === 0n
  );
}

function assertSafeOwnedFile(metadata: BigIntStats, ownerId: bigint, maxBytes: number): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerId ||
    (metadata.mode & 0o22n) !== 0n ||
    metadata.nlink !== 1n ||
    metadata.size < 0n
  ) {
    throw new FrozenProjectFileError("unsafe_file");
  }
  if (metadata.size > BigInt(maxBytes)) {
    throw new FrozenProjectFileError("file_too_large");
  }
}

async function readExact(handle: FileHandle, size: number, maxBytes: number): Promise<Buffer> {
  const content = Buffer.alloc(size);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(content, position, size - position, position);
    if (bytesRead === 0) throw new FrozenProjectFileError("file_changed");
    position += bytesRead;
  }
  const overflowProbe = Buffer.allocUnsafe(1);
  const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, position);
  if (overflowBytes !== 0 || content.byteLength > maxBytes) {
    throw new FrozenProjectFileError("file_changed");
  }
  return content;
}

async function verifyPathObservations(
  observations: readonly PathObservation[],
  ownerId: bigint,
): Promise<void> {
  for (const observation of observations) {
    const current = await observePath(observation.path, "file_changed");
    if (
      !sameObservation(observation.metadata, current) ||
      !isSafeOwnedDirectory(current, ownerId)
    ) {
      throw new FrozenProjectFileError("file_changed");
    }
  }
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function currentUserId(): bigint {
  const getuid = process.getuid;
  if (getuid === undefined) throw new FrozenProjectFileError("request_invalid");
  return BigInt(getuid.call(process));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
