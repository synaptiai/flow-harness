import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createImmutableInputFixture } from "../../../src/infrastructure/verification/immutable-input-fixture.js";

async function withParents(
  run: (parent: string, workspace: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-fixture-owner-test-")));
  const parent = join(root, "private");
  const workspace = join(root, "workspace");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  try {
    await run(parent, workspace);
  } finally {
    // This test-owned root contains no candidate-controlled process or external paths.
    await makeTraversable(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeTraversable(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeTraversable(join(path, name));
}

const contents = Buffer.from('{"valid":true}\n');

describe("immutable input fixture owner", () => {
  it("creates distinct readable, missing, mode-000 file and parent inputs from detached bytes", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const contents = Buffer.from('{"valid":true}\n');
      const expected = Buffer.from(contents);
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      contents.fill(0);
      try {
        expect(await readFile(owner.paths.readableFile)).toEqual(expected);
        expect((await lstat(owner.paths.deniedFile)).mode & 0o777).toBe(0);
        expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
        await expect(lstat(owner.paths.missingFile)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await owner.verifyIntegrity()).toEqual({ status: "verified" });
        expect(Object.isFrozen(owner.paths)).toBe(true);
      } finally {
        expect(await owner.cleanup("never-started")).toEqual({ status: "removed" });
      }
      await expect(lstat(owner.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("exposes only fixture paths and host lifecycle operations", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      try {
        expect(Object.keys(owner).sort()).toEqual([
          "cleanup",
          "confirmExecutionSettled",
          "markExecutionStarted",
          "paths",
          "verifyHostPreconditions",
          "verifyIntegrity",
        ]);
        expect(Object.isFrozen(owner)).toBe(true);
      } finally {
        await owner.cleanup("never-started");
      }
    });
  });

  it("proves host EACCES separately from readable and missing controls, failing closed for privilege bypass", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      try {
        const denied = await readFile(owner.paths.deniedFile).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === "EACCES",
        );
        expect(await owner.verifyHostPreconditions()).toEqual(
          denied
            ? { status: "verified" }
            : { status: "retained", reason: "host-precondition-failed" },
        );
      } finally {
        await owner.cleanup("never-started");
      }
    });
  });

  it("requires a completed integrity check between sequential executions", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      owner.markExecutionStarted();
      owner.confirmExecutionSettled();
      expect(await owner.verifyIntegrity()).toEqual({ status: "verified" });
      owner.markExecutionStarted();
      owner.confirmExecutionSettled();
      expect(await owner.cleanup("settled")).toEqual({ status: "removed" });
    });
  });

  it("retains on overlapping inspection and cleanup without removing any fixture", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      const inspecting = owner.verifyIntegrity();
      expect(await owner.cleanup("never-started")).toEqual({
        status: "retained",
        reason: "invalid-lifecycle",
      });
      expect(await inspecting).toEqual({ status: "retained", reason: "invalid-lifecycle" });
      expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
      expect(await readFile(owner.paths.readableFile)).toEqual(contents);
      await owner.cleanup("never-started");
    });
  });

  it("detaches contents before asynchronous fixture creation begins", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const offered = Buffer.from(contents);
      const creating = createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents: offered,
      });
      offered.fill(65);
      const owner = await creating;
      try {
        expect(await readFile(owner.paths.readableFile)).toEqual(contents);
      } finally {
        await owner.cleanup("never-started");
      }
    });
  });

  it.each(["overlap", "unverified-restart", "false-settlement"] as const)(
    "retains after the invalid lifecycle transition %s",
    async (transition) => {
      await withParents(async (privateParent, candidateWorkspace) => {
        const owner = await createImmutableInputFixture({
          privateParent,
          candidateWorkspace,
          contents,
        });
        try {
          if (transition !== "false-settlement") owner.markExecutionStarted();
          if (transition === "unverified-restart") owner.confirmExecutionSettled();
          expect(() =>
            transition === "false-settlement"
              ? owner.confirmExecutionSettled()
              : owner.markExecutionStarted(),
          ).toThrow("Invalid fixture lifecycle");
          expect(await owner.cleanup("settled")).toEqual({
            status: "retained",
            reason: "invalid-lifecycle",
          });
          expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
        } finally {
          await owner.cleanup("settled");
        }
      });
    },
  );

  it.each(["verify", "cleanup"] as const)(
    "retains without loosening permissions when %s is requested before settlement",
    async (operation) => {
      await withParents(async (privateParent, candidateWorkspace) => {
        const owner = await createImmutableInputFixture({
          privateParent,
          candidateWorkspace,
          contents,
        });
        owner.markExecutionStarted();
        expect(
          await (operation === "verify" ? owner.verifyIntegrity() : owner.cleanup("settled")),
        ).toEqual({ status: "retained", reason: "execution-unconfirmed" });
        expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
        expect(await owner.cleanup("settled")).toEqual({
          status: "retained",
          reason: "execution-unconfirmed",
        });
      });
    },
  );

  it("rejects a cleanup confirmation that falsely claims execution occurred", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      expect(await owner.cleanup("settled")).toEqual({
        status: "retained",
        reason: "invalid-lifecycle",
      });
      expect((await lstat(owner.paths.root)).isDirectory()).toBe(true);
    });
  });

  it.each(["bytes", "oversize", "mode", "inventory", "hard-link"] as const)(
    "retains persistent %s drift instead of cleaning it up",
    async (mutation) => {
      await withParents(async (privateParent, candidateWorkspace) => {
        const owner = await createImmutableInputFixture({
          privateParent,
          candidateWorkspace,
          contents,
        });
        if (mutation === "bytes")
          await writeFile(owner.paths.readableFile, Buffer.alloc(contents.length, 65));
        if (mutation === "oversize") await writeFile(owner.paths.readableFile, Buffer.alloc(4097));
        if (mutation === "mode") await chmod(owner.paths.deniedFile, 0o600);
        if (mutation === "inventory") await writeFile(owner.paths.missingFile, "unexpected");
        if (mutation === "hard-link")
          await link(owner.paths.readableFile, join(candidateWorkspace, "alias"));
        expect(await owner.verifyIntegrity()).toEqual({
          status: "retained",
          reason: "integrity-drift",
        });
        expect(await owner.cleanup("never-started")).toEqual({
          status: "retained",
          reason: "integrity-drift",
        });
        expect((await lstat(owner.paths.root)).isDirectory()).toBe(true);
        expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
      });
    },
  );

  it.each(["file", "parent", "inputs", "root"] as const)(
    "does not follow or chmod a replaced %s symlink",
    async (replacement) => {
      await withParents(async (privateParent, candidateWorkspace) => {
        const owner = await createImmutableInputFixture({
          privateParent,
          candidateWorkspace,
          contents,
        });
        const external = join(candidateWorkspace, "external");
        await mkdir(external, { mode: 0o700 });
        const externalFile = join(external, "child.txt");
        await writeFile(externalFile, "untouched", { mode: 0o600 });
        const target =
          replacement === "file"
            ? owner.paths.deniedFile
            : replacement === "parent"
              ? owner.paths.deniedParent
              : replacement === "inputs"
                ? owner.paths.inputs
                : owner.paths.root;
        const original = `${target}.original`;
        await rename(target, original);
        await symlink(replacement === "file" ? externalFile : external, target);
        expect(await owner.cleanup("never-started")).toEqual({
          status: "retained",
          reason: "integrity-drift",
        });
        expect(await readFile(externalFile, "utf8")).toBe("untouched");
        expect((await lstat(external)).mode & 0o777).toBe(0o700);
        expect((await lstat(externalFile)).mode & 0o777).toBe(0o600);
        expect((await lstat(target)).isSymbolicLink()).toBe(true);
        await unlink(target);
        await rename(original, target);
      });
    },
  );

  it("restores a denied parent's mode after discovering child identity drift", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      await chmod(owner.paths.deniedParent, 0o700);
      await rename(owner.paths.deniedChild, join(candidateWorkspace, "original"));
      await writeFile(owner.paths.deniedChild, contents, { mode: 0o600 });
      await chmod(owner.paths.deniedParent, 0);
      expect(await owner.verifyIntegrity()).toEqual({
        status: "retained",
        reason: "integrity-drift",
      });
      expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
      await owner.cleanup("never-started");
    });
  });

  it("detects child byte drift and preserves denied-parent permissions", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      await chmod(owner.paths.deniedParent, 0o700);
      await writeFile(owner.paths.deniedChild, Buffer.alloc(contents.length, 65));
      await chmod(owner.paths.deniedParent, 0);
      expect(await owner.verifyIntegrity()).toEqual({
        status: "retained",
        reason: "integrity-drift",
      });
      expect((await lstat(owner.paths.deniedParent)).mode & 0o777).toBe(0);
      await owner.cleanup("never-started");
    });
  });

  it("retains root replacement by a real directory", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const owner = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      await rename(owner.paths.root, `${owner.paths.root}.original`);
      await mkdir(owner.paths.root, { mode: 0o700 });
      expect(await owner.cleanup("never-started")).toEqual({
        status: "retained",
        reason: "integrity-drift",
      });
      expect((await lstat(owner.paths.root)).isDirectory()).toBe(true);
    });
  });

  it("allows independent sibling fixtures without freezing unrelated parent inventory", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const first = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      const second = await createImmutableInputFixture({
        privateParent,
        candidateWorkspace,
        contents,
      });
      expect(await first.verifyIntegrity()).toEqual({ status: "verified" });
      expect(await first.cleanup("never-started")).toEqual({ status: "removed" });
      expect(await second.cleanup("never-started")).toEqual({ status: "removed" });
    });
  });

  it("rejects unbounded contents before creating filesystem entries", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      for (const invalid of [Buffer.alloc(0), Buffer.alloc(4097)]) {
        await expect(
          createImmutableInputFixture({ privateParent, candidateWorkspace, contents: invalid }),
        ).rejects.toThrow("between 1 and 4096");
      }
      expect(await readdir(privateParent)).toEqual([]);
    });
  });

  it("rejects a non-private parent without changing its mode", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      await chmod(privateParent, 0o755);
      await expect(
        createImmutableInputFixture({ privateParent, candidateWorkspace, contents }),
      ).rejects.toThrow("mode 0700");
      expect((await lstat(privateParent)).mode & 0o777).toBe(0o755);
      expect(await readdir(privateParent)).toEqual([]);
    });
  });

  it("rejects overlap in either direction and symlink parents without creating fixtures", async () => {
    await withParents(async (privateParent, candidateWorkspace) => {
      const nested = join(privateParent, "nested");
      await mkdir(nested, { mode: 0o700 });
      for (const [parent, workspace] of [
        [privateParent, privateParent],
        [privateParent, nested],
        [nested, privateParent],
      ] as const) {
        await expect(
          createImmutableInputFixture({
            privateParent: parent,
            candidateWorkspace: workspace,
            contents,
          }),
        ).rejects.toThrow("must not overlap");
      }
      const alias = join(candidateWorkspace, "alias");
      await symlink(privateParent, alias);
      await expect(
        createImmutableInputFixture({ privateParent: alias, candidateWorkspace, contents }),
      ).rejects.toThrow("without symlinks");
      expect(await readdir(privateParent)).toEqual(["nested"]);
    });
  });
});
