import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Identity of the patched observer helper, `observer-apply-seccomp`, which installs the
 * observer namespace restriction before the workload runs. The caller supplies the exact
 * digest it expects; Flow does not ship or locate a default helper.
 */
export interface ObserverNamespaceHelper {
  readonly path: string;
  readonly sha256: string;
}

export type ObserverNamespaceHelperAdmission =
  | { readonly kind: "admitted"; readonly helper: ObserverNamespaceHelper }
  | { readonly kind: "rejected"; readonly reason: string };

/** Filesystem reads used by admission, replaceable for unprivileged tests. */
export interface ObserverHelperFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    readonly uid: number;
    readonly mode: number;
    readonly size: number;
  }>;
  readDigest(path: string, maxBytes: number): Promise<string>;
}

const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const hostFileSystem: ObserverHelperFileSystem = {
  realpath: (path) => realpath(path),
  lstat: (path) => lstat(path),
  async readDigest(path, maxBytes) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(65_536);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new Error("observer helper exceeds the size limit");
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  },
};

/**
 * Admits the helper only when no unprivileged user can replace it between this check and
 * its execution: the canonical file and every ancestor directory must be owned by root and
 * writable by no group or other user. The bytes must then match the expected digest.
 * Any failure rejects the helper; callers must not fall back to an unrestricted sandbox.
 */
export async function admitObserverNamespaceHelper(
  candidate: ObserverNamespaceHelper,
  fileSystem: ObserverHelperFileSystem = hostFileSystem,
): Promise<ObserverNamespaceHelperAdmission> {
  const rejected = (reason: string): ObserverNamespaceHelperAdmission =>
    Object.freeze({ kind: "rejected", reason });
  if (
    typeof candidate.path !== "string" ||
    candidate.path.includes("\0") ||
    !isAbsolute(candidate.path) ||
    resolve(candidate.path) !== candidate.path
  )
    return rejected("helper path must be absolute and normalized");
  if (typeof candidate.sha256 !== "string" || !SHA256.test(candidate.sha256))
    return rejected("expected helper digest must be lowercase SHA-256");
  try {
    if ((await fileSystem.realpath(candidate.path)) !== candidate.path)
      return rejected("helper path must not traverse a symbolic link");
    const file = await fileSystem.lstat(candidate.path);
    if (!file.isFile()) return rejected("helper must be a regular file");
    if (file.uid !== 0 || (file.mode & 0o022) !== 0)
      return rejected("helper must be owned by root and writable only by root");
    if ((file.mode & 0o111) === 0) return rejected("helper must be executable");
    if (file.size > MAX_HELPER_BYTES) return rejected("helper exceeds the size limit");
    for (let directory = dirname(candidate.path); ; directory = dirname(directory)) {
      const metadata = await fileSystem.lstat(directory);
      if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
        return rejected("helper ancestors must be root-owned directories writable only by root");
      if (directory === "/") break;
    }
    if ((await fileSystem.readDigest(candidate.path, MAX_HELPER_BYTES)) !== candidate.sha256)
      return rejected("helper digest does not match");
  } catch {
    return rejected("helper could not be inspected");
  }
  return Object.freeze({
    kind: "admitted",
    helper: Object.freeze({ path: candidate.path, sha256: candidate.sha256 }),
  });
}
