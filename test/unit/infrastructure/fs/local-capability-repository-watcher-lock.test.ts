import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalCapabilityRepositoryWatcherLock,
  LocalCapabilityRepositoryWatcherLockError,
} from "../../../../src/infrastructure/fs/local-capability-repository-watcher-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local capability repository watcher lock", () => {
  it("owns one bounded record and removes only that record on release", async () => {
    const root = await projectRoot();
    const lock = new LocalCapabilityRepositoryWatcherLock(root);

    const lease = await lock.acquire();
    const record = await readFile(lockPath(root), "utf8");
    expect(Buffer.byteLength(record, "utf8")).toBeLessThanOrEqual(1_024);
    expect(JSON.parse(record)).toMatchObject({ version: 1, pid: process.pid });

    await lease.release();
    await expect(readFile(lockPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second owner without waiting or stealing the first lease", async () => {
    const root = await projectRoot();
    const first = await new LocalCapabilityRepositoryWatcherLock(root).acquire();

    await expect(new LocalCapabilityRepositoryWatcherLock(root).acquire()).rejects.toEqual(
      new LocalCapabilityRepositoryWatcherLockError("acquire watcher ownership"),
    );

    expect(await readFile(lockPath(root), "utf8")).toContain(`"pid":${process.pid}`);
    await first.release();
  });

  it("does not follow or remove a watcher-lock symlink", async () => {
    const root = await projectRoot();
    const privateCanary = join(root, "PRIVATE_EXTERNAL_CANARY");
    await writeFile(privateCanary, "PRIVATE_EXTERNAL_CONTENT", { mode: 0o600 });
    await symlink(privateCanary, lockPath(root));

    await expect(new LocalCapabilityRepositoryWatcherLock(root).acquire()).rejects.toEqual(
      new LocalCapabilityRepositoryWatcherLockError("acquire watcher ownership"),
    );

    expect(await readFile(privateCanary, "utf8")).toBe("PRIVATE_EXTERNAL_CONTENT");
  });

  it("fails closed without unlinking a replacement observed before release", async () => {
    const root = await projectRoot();
    const replacement = Buffer.from('{"PRIVATE":"REPLACEMENT"}');
    const beforeReleaseUnlink = vi.fn(async (path: string) => {
      await rename(path, `${path}.original`);
      await writeFile(path, replacement, { mode: 0o600 });
    });
    const lease = await new LocalCapabilityRepositoryWatcherLock(root, {
      beforeReleaseUnlink,
    }).acquire();

    await expect(lease.release()).rejects.toEqual(
      new LocalCapabilityRepositoryWatcherLockError("release watcher ownership"),
    );

    expect(beforeReleaseUnlink).toHaveBeenCalledOnce();
    expect(await readFile(lockPath(root))).toEqual(replacement);
  });

  it("preserves exact cancellation before ownership is acquired", async () => {
    const root = await projectRoot();
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    controller.abort(reason);

    await expect(
      new LocalCapabilityRepositoryWatcherLock(root).acquire(controller.signal),
    ).rejects.toBe(reason);
    await expect(readFile(lockPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-repository-watcher-lock-"));
  roots.push(root);
  await mkdir(join(root, ".flow", "capability.repository"), { recursive: true, mode: 0o700 });
  return root;
}

function lockPath(root: string): string {
  return join(root, ".flow", "capability.repository", "watcher.lock");
}
