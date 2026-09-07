import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export type OwnedPrivateDirectoryErrorCode = "invalid_path" | "unsafe_path" | "io";

export class OwnedPrivateDirectoryError extends Error {
  override readonly name = "OwnedPrivateDirectoryError";

  constructor(
    readonly code: OwnedPrivateDirectoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(`owned private directory failed: ${code}`, options);
  }
}

/** Creates or re-admits one canonical owner-only directory without following links. */
export async function ensureOwnedPrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw new OwnedPrivateDirectoryError("invalid_path");
  }
  const ownerId = process.getuid?.();
  if (ownerId === undefined) throw new OwnedPrivateDirectoryError("invalid_path");
  try {
    if ((await realpath(dirname(path))) !== dirname(path)) {
      throw new OwnedPrivateDirectoryError("unsafe_path");
    }
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    });
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      before.uid !== ownerId ||
      (before.mode & 0o077) !== 0 ||
      (await realpath(path)) !== path
    ) {
      throw new OwnedPrivateDirectoryError("unsafe_path");
    }
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== before.uid ||
      after.mode !== before.mode
    ) {
      throw new OwnedPrivateDirectoryError("unsafe_path");
    }
    return path;
  } catch (error) {
    if (error instanceof OwnedPrivateDirectoryError) throw error;
    throw new OwnedPrivateDirectoryError("io", { cause: error });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
