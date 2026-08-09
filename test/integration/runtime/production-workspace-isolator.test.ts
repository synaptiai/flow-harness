import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ReflinkCopyWorkspaceIsolator } from "../../../src/infrastructure/fs/reflink-copy-workspace-isolator.js";
import {
  copyLegacyWorkspaceIdentity,
  createProductionWorkspaceIsolator,
} from "../../../src/infrastructure/runtime/production-workspace-isolator.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("production workspace isolation", () => {
  it("stores a child workspace outside a project with a deep run-store path", async () => {
    const fixture = await projectFixture();
    const isolator = createProductionWorkspaceIsolator(
      fixture.runsDirectory,
      [fixture.runsDirectory, fixture.flowDirectory],
      fixture.project,
    );

    const workspace = await isolator.create({
      workspaceId: "child-deep-store",
      sourceCwd: fixture.project,
      excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
    });

    expect(isWithin(fixture.project, workspace.cwd)).toBe(false);
    await expect(readFile(join(workspace.cwd, "source.txt"), "utf8")).resolves.toBe("source\n");
    await expect(lstat(join(workspace.cwd, ".flow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves a legacy child workspace before it reopens the workspace", async () => {
    const fixture = await projectFixture();
    const workspaceId = "child-legacy-recovery";
    const oldRequest = {
      workspaceId,
      sourceCwd: fixture.project,
      excludedPaths: [fixture.runsDirectory],
    };
    const legacy = new ReflinkCopyWorkspaceIsolator(join(fixture.runsDirectory, ".workspaces"));
    const created = await legacy.create(oldRequest);
    await writeFile(join(created.cwd, "recovery.txt"), "resume here\n");
    const isolator = createProductionWorkspaceIsolator(
      fixture.runsDirectory,
      [fixture.runsDirectory, fixture.flowDirectory],
      fixture.project,
    );

    const reopened = await isolator.reopen({
      ...oldRequest,
      excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
    });

    expect(reopened.snapshotDigest).toBe(created.snapshotDigest);
    expect(reopened.relocatedFromCwd).toBe(created.cwd);
    expect(isWithin(fixture.project, reopened.cwd)).toBe(false);
    await execFileAsync(
      process.execPath,
      ["-e", 'require("node:fs").writeFileSync("command-result.txt", "command ran\\n")'],
      { cwd: reopened.cwd },
    );
    await expect(readFile(join(reopened.cwd, "recovery.txt"), "utf8")).resolves.toBe(
      "resume here\n",
    );
    await expect(readFile(join(reopened.cwd, "command-result.txt"), "utf8")).resolves.toBe(
      "command ran\n",
    );
    await expect(lstat(dirname(created.cwd))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves nested legacy workspaces with their translated source identity", async () => {
    const fixture = await projectFixture();
    const legacy = new ReflinkCopyWorkspaceIsolator(join(fixture.runsDirectory, ".workspaces"));
    const parent = await legacy.create({
      workspaceId: "child-legacy-parent",
      sourceCwd: fixture.project,
      excludedPaths: [fixture.runsDirectory],
    });
    const nested = await legacy.create({
      workspaceId: "child-legacy-nested",
      sourceCwd: parent.cwd,
      excludedPaths: [],
    });
    const isolator = createProductionWorkspaceIsolator(
      fixture.runsDirectory,
      [fixture.runsDirectory, fixture.flowDirectory],
      fixture.project,
      fixture.project,
    );

    const movedParent = await isolator.reopen({
      workspaceId: parent.workspaceId,
      sourceCwd: fixture.project,
      excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
    });
    const movedNested = await isolator.reopen({
      workspaceId: nested.workspaceId,
      sourceCwd: movedParent.cwd,
      excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
    });

    expect(movedParent.relocatedFromCwd).toBe(parent.cwd);
    expect(movedNested.relocatedFromCwd).toBe(nested.cwd);
    expect(movedNested.snapshotDigest).toBe(nested.snapshotDigest);
    expect(isWithin(fixture.project, movedNested.cwd)).toBe(false);
    await expect(readFile(join(movedNested.cwd, "source.txt"), "utf8")).resolves.toBe("source\n");

    await writeFile(join(movedNested.cwd, "candidate.txt"), "candidate change\n");
    const delta = await isolator.captureCandidateDelta({
      workspaceId: nested.workspaceId,
      sourceCwd: movedParent.cwd,
      expectedSnapshotDigest: nested.snapshotDigest,
      excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
    });
    expect(delta.entries).toEqual([
      expect.objectContaining({
        path: "candidate.txt",
        before: { kind: "missing" },
        after: expect.objectContaining({ kind: "file" }),
      }),
    ]);

    const settlements: unknown[] = [];
    const settlement = await isolator.promoteCandidateDelta(
      {
        promotionId: "promote-moved-nested",
        workspaceId: nested.workspaceId,
        sourceCwd: movedParent.cwd,
        deltaDigest: delta.deltaDigest,
        excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
      },
      {
        async prepare() {},
        async settle(value) {
          settlements.push(value);
        },
      },
    );
    expect(settlement).toEqual({ outcome: "committed", reason: "local_commit_durable" });
    expect(settlements).toEqual([settlement]);
    await expect(readFile(join(movedParent.cwd, "candidate.txt"), "utf8")).resolves.toBe(
      "candidate change\n",
    );
    await expect(lstat(parent.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the explicit project root when a custom run directory is named .flow", async () => {
    const fixture = await projectFixture();
    const customRunsDirectory = join(fixture.root, "custom-state", ".flow");
    await mkdir(customRunsDirectory, { recursive: true });
    const isolator = createProductionWorkspaceIsolator(
      customRunsDirectory,
      [customRunsDirectory, fixture.flowDirectory],
      fixture.project,
      fixture.project,
    );

    const workspace = await isolator.create({
      workspaceId: "child-explicit-project",
      sourceCwd: fixture.project,
      excludedPaths: [customRunsDirectory, fixture.flowDirectory],
    });

    expect(workspace.cwd).toContain(join(fixture.root, ".project.flow-workspaces"));
    expect(workspace.cwd).not.toContain(".custom-state.flow-workspaces");
  });

  it("reopens one workspace through a second run-store path alias", async () => {
    const fixture = await projectFixture();
    const firstAlias = join(fixture.root, "runs-first");
    const secondAlias = join(fixture.root, "runs-second");
    await Promise.all([
      symlink(fixture.runsDirectory, firstAlias, "dir"),
      symlink(fixture.runsDirectory, secondAlias, "dir"),
    ]);
    const first = createProductionWorkspaceIsolator(
      firstAlias,
      [firstAlias, fixture.flowDirectory],
      fixture.project,
      fixture.project,
    );
    const created = await first.create({
      workspaceId: "child-run-store-alias",
      sourceCwd: fixture.project,
      excludedPaths: [firstAlias, fixture.flowDirectory],
    });
    const second = createProductionWorkspaceIsolator(
      secondAlias,
      [secondAlias, fixture.flowDirectory],
      fixture.project,
      fixture.project,
    );

    const reopened = await second.reopen({
      workspaceId: created.workspaceId,
      sourceCwd: fixture.project,
      excludedPaths: [secondAlias, fixture.flowDirectory],
    });

    expect(reopened.cwd).toBe(created.cwd);
    expect(reopened.snapshotDigest).toBe(created.snapshotDigest);
  });

  it("copies and verifies a legacy identity before cross-filesystem publication", async () => {
    const fixture = await projectFixture();
    const workspaceId = "child-copy-migration";
    const legacyBase = join(fixture.runsDirectory, ".workspaces");
    const legacy = new ReflinkCopyWorkspaceIsolator(legacyBase);
    const created = await legacy.create({
      workspaceId,
      sourceCwd: fixture.project,
      excludedPaths: [fixture.runsDirectory],
    });
    await writeFile(join(created.cwd, "changed.txt"), "changed in child\n");
    const targetBase = join(fixture.root, "copy-target");
    const target = join(targetBase, workspaceId);
    await mkdir(targetBase);

    await copyLegacyWorkspaceIdentity(
      dirname(created.cwd),
      target,
      targetBase,
      legacyBase,
      workspaceId,
    );

    await expect(lstat(dirname(created.cwd))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      new ReflinkCopyWorkspaceIsolator(targetBase).reopen({
        workspaceId,
        sourceCwd: fixture.project,
        excludedPaths: [fixture.runsDirectory],
      }),
    ).resolves.toMatchObject({ workspaceId });
    await expect(readFile(join(target, "workspace", "changed.txt"), "utf8")).resolves.toBe(
      "changed in child\n",
    );
  });

  it("rejects a symbolic link planted at the private workspace collection", async () => {
    const fixture = await projectFixture();
    const outside = join(fixture.root, "outside");
    const collection = join(
      dirname(fixture.project),
      `.${basename(fixture.project)}.flow-workspaces`,
    );
    await mkdir(outside);
    await symlink(outside, collection);
    const isolator = createProductionWorkspaceIsolator(
      fixture.runsDirectory,
      [fixture.runsDirectory, fixture.flowDirectory],
      fixture.project,
    );

    await expect(
      isolator.create({
        workspaceId: "child-linked-collection",
        sourceCwd: fixture.project,
        excludedPaths: [fixture.runsDirectory, fixture.flowDirectory],
      }),
    ).rejects.toMatchObject({ code: "source_invalid" });
    await expect(lstat(join(outside, "child-linked-collection"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function projectFixture(): Promise<{
  readonly root: string;
  readonly project: string;
  readonly flowDirectory: string;
  readonly runsDirectory: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-production-workspace-")));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const flowDirectory = join(project, ".flow");
  const runsDirectory = join(flowDirectory, "custom", "runs");
  await mkdir(runsDirectory, { recursive: true });
  await writeFile(join(project, "source.txt"), "source\n");
  return { root, project, flowDirectory, runsDirectory };
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

import { execFile } from "node:child_process";
