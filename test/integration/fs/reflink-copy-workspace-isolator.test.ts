import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ReflinkCopyWorkspaceIsolator } from "../../../src/infrastructure/fs/reflink-copy-workspace-isolator.js";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("reflink-copy workspace isolation", () => {
  it("materializes dirty and untracked content without sharing parent mutations", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.source, "tracked.txt"), "dirty parent\n");
    await writeFile(join(fixture.source, "untracked.txt"), "untracked\n");

    const isolated = await fixture.isolator.create({
      workspaceId: "child-abc123",
      sourceCwd: fixture.source,
    });
    await writeFile(join(isolated.cwd, "tracked.txt"), "child changed\n");

    expect(await readFile(join(fixture.source, "tracked.txt"), "utf8")).toBe("dirty parent\n");
    expect(await readFile(join(isolated.cwd, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(isolated).toMatchObject({
      workspaceId: "child-abc123",
      backend: "reflink-copy-v1",
      snapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("preserves modes and symbolic links without following them", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.source, "script.sh"), "#!/bin/sh\n");
    await chmod(join(fixture.source, "script.sh"), 0o751);
    await symlink("../outside-secret", join(fixture.source, "external-link"));

    const isolated = await fixture.isolator.create({
      workspaceId: "child-links",
      sourceCwd: fixture.source,
    });

    expect((await stat(join(isolated.cwd, "script.sh"))).mode & 0o777).toBe(0o751);
    expect((await lstat(join(isolated.cwd, "external-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(isolated.cwd, "external-link"))).toBe("../outside-secret");
  });

  it("excludes Flow state, reopens an exact workspace, and cleans up idempotently", async () => {
    const fixture = await workspaceFixture();
    await mkdir(join(fixture.source, ".flow"), { recursive: true });
    await writeFile(join(fixture.source, ".flow", "events.jsonl"), "secret state");

    const created = await fixture.isolator.create({
      workspaceId: "child-recovery",
      sourceCwd: fixture.source,
    });
    const reopened = await fixture.isolator.reopen({
      workspaceId: created.workspaceId,
      sourceCwd: fixture.source,
    });

    expect(reopened).toEqual(created);
    await expect(lstat(join(created.cwd, ".flow"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.isolator.cleanup(created.workspaceId)).resolves.toBe("discarded");
    await expect(fixture.isolator.cleanup(created.workspaceId)).resolves.toBe("discarded");
    await expect(
      fixture.isolator.reopen({
        workspaceId: created.workspaceId,
        sourceCwd: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("excludes arbitrary protected state and binds the exclusion policy to recovery", async () => {
    const fixture = await workspaceFixture();
    const protectedState = join(fixture.source, "custom-runs");
    await mkdir(protectedState, { recursive: true });
    await writeFile(join(protectedState, "events.jsonl"), "private ledger");

    const created = await fixture.isolator.create({
      workspaceId: "child-protected-state",
      sourceCwd: fixture.source,
      excludedPaths: [protectedState],
    });

    await expect(lstat(join(created.cwd, "custom-runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fixture.isolator.reopen({
        workspaceId: created.workspaceId,
        sourceCwd: fixture.source,
        excludedPaths: [protectedState],
      }),
    ).resolves.toEqual(created);
    await expect(
      fixture.isolator.reopen({
        workspaceId: created.workspaceId,
        sourceCwd: fixture.source,
        excludedPaths: [],
      }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  });

  it("fails closed on special files and removes the partial materialization", async () => {
    const fixture = await workspaceFixture();
    await execFileAsync("mkfifo", [join(fixture.source, "blocked.fifo")]);

    await expect(
      fixture.isolator.create({
        workspaceId: "child-special",
        sourceCwd: fixture.source,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_entry",
    });
    await expect(
      fixture.isolator.reopen({
        workspaceId: "child-special",
        sourceCwd: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("enforces logical byte and entry ceilings before exposing a workspace", async () => {
    const fixture = await workspaceFixture({ maxEntries: 2, maxBytes: 4 });
    await writeFile(join(fixture.source, "too-large.txt"), "12345");

    await expect(
      fixture.isolator.create({
        workspaceId: "child-bounded",
        sourceCwd: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
    await expect(
      fixture.isolator.reopen({
        workspaceId: "child-bounded",
        sourceCwd: fixture.source,
      }),
    ).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("rejects invalid identities and duplicate materialization", async () => {
    const fixture = await workspaceFixture();

    await expect(
      fixture.isolator.create({ workspaceId: "../escape", sourceCwd: fixture.source }),
    ).rejects.toMatchObject({ code: "invalid_workspace_id" });
    await fixture.isolator.create({ workspaceId: "child-once", sourceCwd: fixture.source });
    await expect(
      fixture.isolator.create({ workspaceId: "child-once", sourceCwd: fixture.source }),
    ).rejects.toMatchObject({ code: "workspace_exists" });
  });
});

async function workspaceFixture(
  limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "flow-child-isolation-"));
  const source = join(root, "source");
  const storage = join(root, "state", "workspaces");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "tracked.txt"), "original\n");
  const isolator = new ReflinkCopyWorkspaceIsolator(storage, limits);
  cleanup.push(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, storage, isolator };
}
