import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureOwnedPrivateDirectory,
  OwnedPrivateDirectoryError,
} from "../../../../src/infrastructure/fs/owned-private-directory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("owned private directory", () => {
  it("creates an owner-only canonical directory", async () => {
    const parent = await canonicalTemporaryRoot();
    const directory = join(parent, "private");

    await expect(ensureOwnedPrivateDirectory(directory)).resolves.toBe(directory);
    const metadata = await lstat(directory);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.mode & 0o077).toBe(0);
  });

  it("rejects a pre-created symbolic link", async () => {
    const parent = await canonicalTemporaryRoot();
    const target = join(parent, "target");
    const directory = join(parent, "private");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);

    await expect(ensureOwnedPrivateDirectory(directory)).rejects.toBeInstanceOf(
      OwnedPrivateDirectoryError,
    );
  });

  it("rejects a symbolic link in the parent path before creating the target", async () => {
    const parent = await canonicalTemporaryRoot();
    const outside = join(parent, "outside");
    const linkedParent = join(parent, "linked-parent");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linkedParent);

    await expect(ensureOwnedPrivateDirectory(join(linkedParent, "private"))).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await expect(lstat(join(outside, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a pre-existing regular file", async () => {
    const parent = await canonicalTemporaryRoot();
    const directory = join(parent, "private");
    await writeFile(directory, "not a directory", { mode: 0o600 });

    await expect(ensureOwnedPrivateDirectory(directory)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it.each(["relative/private", "/tmp/../tmp/private", "/tmp/private\0suffix"])(
    "rejects invalid path shape %j",
    async (path) => {
      await expect(ensureOwnedPrivateDirectory(path)).rejects.toMatchObject({
        code: "invalid_path",
      });
    },
  );

  it("rejects a group- or world-writable existing directory", async () => {
    const parent = await canonicalTemporaryRoot();
    const directory = join(parent, "private");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o777);

    await expect(ensureOwnedPrivateDirectory(directory)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects a group- or world-readable existing directory", async () => {
    const parent = await canonicalTemporaryRoot();
    const directory = join(parent, "private");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);

    await expect(ensureOwnedPrivateDirectory(directory)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });
});

async function canonicalTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-owned-private-"));
  temporaryRoots.push(root);
  return await realpath(root);
}
