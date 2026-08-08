import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
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

describe("reflink-copy candidate delta capture", () => {
  it("captures sorted create, update, delete, mode, directory, binary, and symlink changes", async () => {
    const fixture = await candidateFixture();
    const workspace = await fixture.isolator.create({
      workspaceId: "candidate-complete",
      sourceCwd: fixture.source,
    });

    await writeFile(join(workspace.cwd, "updated.bin"), Buffer.from([0, 255, 1, 2]));
    await chmod(join(workspace.cwd, "updated.bin"), 0o751);
    await chmod(join(workspace.cwd, "unchanged-mode.sh"), 0o755);
    await unlink(join(workspace.cwd, "deleted.txt"));
    await rm(join(workspace.cwd, "removed"), { recursive: true });
    await mkdir(join(workspace.cwd, "created"), { mode: 0o750 });
    await writeFile(join(workspace.cwd, "created", "new.bin"), Buffer.from([3, 0, 4]));
    await unlink(join(workspace.cwd, "link"));
    await symlink("created/new.bin", join(workspace.cwd, "link"));

    const delta = await fixture.isolator.captureCandidateDelta({
      workspaceId: workspace.workspaceId,
      sourceCwd: fixture.source,
      expectedSnapshotDigest: workspace.snapshotDigest,
    });

    expect(delta).toMatchObject({
      version: 1,
      workspaceId: workspace.workspaceId,
      baselineSnapshotDigest: workspace.snapshotDigest,
      candidateSnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      deltaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      entryCount: 8,
      logicalBytes: 48,
    });
    expect(
      delta.entries.map((entry) => ({
        path: entry.path,
        before: entry.before.kind,
        after: entry.after.kind,
      })),
    ).toEqual([
      { path: "created", before: "missing", after: "directory" },
      { path: "created/new.bin", before: "missing", after: "file" },
      { path: "deleted.txt", before: "file", after: "missing" },
      { path: "link", before: "symlink", after: "symlink" },
      { path: "removed", before: "directory", after: "missing" },
      { path: "removed/nested.txt", before: "file", after: "missing" },
      { path: "unchanged-mode.sh", before: "file", after: "file" },
      { path: "updated.bin", before: "file", after: "file" },
    ]);
    expect(delta.entries.find((entry) => entry.path === "updated.bin")).toMatchObject({
      before: { kind: "file", mode: 0o640, size: 4, sha256: expect.any(String) },
      after: { kind: "file", mode: 0o751, size: 4, sha256: expect.any(String) },
    });
    expect(await readFile(join(fixture.source, "updated.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    expect((await lstat(join(fixture.source, "link"))).isSymbolicLink()).toBe(true);
    expect(Object.isFrozen(delta)).toBe(true);
    expect(delta.entries.every(Object.isFrozen)).toBe(true);
  });

  it("refuses capture when the parent no longer matches the isolated baseline", async () => {
    const fixture = await candidateFixture();
    const workspace = await fixture.isolator.create({
      workspaceId: "candidate-stale",
      sourceCwd: fixture.source,
    });
    await writeFile(join(workspace.cwd, "updated.bin"), "candidate");
    await writeFile(join(fixture.source, "deleted.txt"), "newer parent");

    await expect(
      fixture.isolator.captureCandidateDelta({
        workspaceId: workspace.workspaceId,
        sourceCwd: fixture.source,
        expectedSnapshotDigest: workspace.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: "candidate_source_stale" });
  });

  it("fails closed when the candidate contains a special filesystem entry", async () => {
    const fixture = await candidateFixture();
    const workspace = await fixture.isolator.create({
      workspaceId: "candidate-special",
      sourceCwd: fixture.source,
    });
    await execFileAsync("mkfifo", [join(workspace.cwd, "blocked.fifo")]);

    await expect(
      fixture.isolator.captureCandidateDelta({
        workspaceId: workspace.workspaceId,
        sourceCwd: fixture.source,
        expectedSnapshotDigest: workspace.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: "unsupported_entry" });
  });

  it("rejects a no-op candidate and enforces delta entry and logical-byte limits", async () => {
    const noChange = await candidateFixture();
    const unchanged = await noChange.isolator.create({
      workspaceId: "candidate-no-change",
      sourceCwd: noChange.source,
    });
    await expect(
      noChange.isolator.captureCandidateDelta({
        workspaceId: unchanged.workspaceId,
        sourceCwd: noChange.source,
        expectedSnapshotDigest: unchanged.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: "candidate_no_change" });

    const bounded = await candidateFixture({ maxDeltaEntries: 1, maxDeltaBytes: 1 });
    const changed = await bounded.isolator.create({
      workspaceId: "candidate-bounded",
      sourceCwd: bounded.source,
    });
    await writeFile(join(changed.cwd, "updated.bin"), "too large");
    await unlink(join(changed.cwd, "deleted.txt"));
    await expect(
      bounded.isolator.captureCandidateDelta({
        workspaceId: changed.workspaceId,
        sourceCwd: bounded.source,
        expectedSnapshotDigest: changed.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: "candidate_delta_limit_exceeded" });
  });

  it("rejects delta metadata that cannot fit safely in durable optimization evidence", async () => {
    const bounded = await candidateFixture({ maxDeltaEvidenceBytes: 1 });
    const changed = await bounded.isolator.create({
      workspaceId: "candidate-evidence-bounded",
      sourceCwd: bounded.source,
    });
    await writeFile(join(changed.cwd, "updated.bin"), "changed");

    await expect(
      bounded.isolator.captureCandidateDelta({
        workspaceId: changed.workspaceId,
        sourceCwd: bounded.source,
        expectedSnapshotDigest: changed.snapshotDigest,
      }),
    ).rejects.toMatchObject({ code: "candidate_delta_limit_exceeded" });
    await expect(
      lstat(join(bounded.storage, changed.workspaceId, "candidate")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens an identical durable capture after publication is interrupted", async () => {
    const fixture = await candidateFixture();
    const workspace = await fixture.isolator.create({
      workspaceId: "candidate-capture-replay",
      sourceCwd: fixture.source,
    });
    await writeFile(join(workspace.cwd, "updated.bin"), "changed");
    const request = {
      workspaceId: workspace.workspaceId,
      sourceCwd: fixture.source,
      expectedSnapshotDigest: workspace.snapshotDigest,
    };

    const first = await fixture.isolator.captureCandidateDelta(request);
    const reopened = await fixture.isolator.captureCandidateDelta(request);

    expect(reopened).toEqual(first);
  });
});

async function candidateFixture(
  limits: {
    readonly maxDeltaEntries?: number;
    readonly maxDeltaBytes?: number;
    readonly maxDeltaEvidenceBytes?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "flow-candidate-delta-"));
  const source = join(root, "source");
  const storage = join(root, "state", "workspaces");
  await mkdir(join(source, "removed"), { recursive: true });
  await writeFile(join(source, "updated.bin"), Buffer.from([0, 1, 2, 3]));
  await chmod(join(source, "updated.bin"), 0o640);
  await writeFile(join(source, "deleted.txt"), "delete me\n");
  await writeFile(join(source, "removed", "nested.txt"), "nested\n");
  await writeFile(join(source, "unchanged-mode.sh"), "#!/bin/sh\n");
  await chmod(join(source, "unchanged-mode.sh"), 0o644);
  await symlink("deleted.txt", join(source, "link"));
  const isolator = new ReflinkCopyWorkspaceIsolator(storage, limits);
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, storage, isolator };
}
