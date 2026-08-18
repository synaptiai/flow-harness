import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const MAX_WATCHER_LOCK_BYTES = 1_024;

export type LocalCapabilityRepositoryWatcherLockStage =
  | "acquire watcher ownership"
  | "release watcher ownership";

export class LocalCapabilityRepositoryWatcherLockError extends Error {
  override readonly name = "LocalCapabilityRepositoryWatcherLockError";
  readonly code = "capability_repository_watcher_lock_failed" as const;

  constructor(readonly stage: LocalCapabilityRepositoryWatcherLockStage) {
    super(`Capability repository watcher lock failed during ${stage}`);
  }
}

export interface CapabilityRepositoryWatcherLease {
  release(): Promise<void>;
}

export interface LocalCapabilityRepositoryWatcherLockHooks {
  readonly beforeReleaseUnlink?: (path: string) => Promise<void>;
}

export class LocalCapabilityRepositoryWatcherLock {
  readonly #root: string;
  readonly #path: string;

  constructor(
    projectRoot: string,
    private readonly hooks: LocalCapabilityRepositoryWatcherLockHooks = {},
  ) {
    this.#root = join(resolve(projectRoot), ".flow", "capability.repository");
    this.#path = join(this.#root, "watcher.lock");
  }

  async acquire(signal?: AbortSignal): Promise<CapabilityRepositoryWatcherLease> {
    throwIfAborted(signal);
    const content = Buffer.from(
      JSON.stringify({
        version: 1,
        hostname: hostname(),
        pid: process.pid,
        token: randomUUID(),
      }),
    );
    if (content.byteLength > MAX_WATCHER_LOCK_BYTES) {
      throw new LocalCapabilityRepositoryWatcherLockError("acquire watcher ownership");
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const root = await lstat(this.#root);
      throwIfAborted(signal);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new Error("repository root is not a direct directory");
      }
      handle = await open(
        this.#path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(this.#root);
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      throw new LocalCapabilityRepositoryWatcherLockError("acquire watcher ownership");
    }

    let released = false;
    return Object.freeze({
      release: async () => {
        if (released) {
          throw new LocalCapabilityRepositoryWatcherLockError("release watcher ownership");
        }
        await this.#release(content);
        released = true;
      },
    });
  }

  async #release(expected: Buffer): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size < 1n ||
        before.size > BigInt(MAX_WATCHER_LOCK_BYTES)
      ) {
        throw new Error("watcher ownership record is invalid");
      }
      const content = await handle.readFile();
      if (!content.equals(expected)) {
        throw new Error("watcher ownership changed");
      }
      await handle.close();
      handle = undefined;

      await this.hooks.beforeReleaseUnlink?.(this.#path);
      const current = await lstat(this.#path, { bigint: true });
      if (!sameFile(before, current)) {
        throw new Error("watcher ownership path changed");
      }
      await unlink(this.#path);
      await syncDirectory(this.#root);
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      throw new LocalCapabilityRepositoryWatcherLockError("release watcher ownership");
    }
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.isFile() &&
    !right.isSymbolicLink()
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
