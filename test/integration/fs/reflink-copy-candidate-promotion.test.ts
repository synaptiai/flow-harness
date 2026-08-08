import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CandidatePromotionInterruptedError,
  ReflinkCopyWorkspaceIsolator,
} from "../../../src/infrastructure/fs/reflink-copy-workspace-isolator.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

describe("reflink-copy candidate promotion", () => {
  it("promotes the complete typed delta while preserving unrelated newer parent state", async () => {
    const fixture = await promotionFixture("commit");
    await writeFile(join(fixture.source, "unrelated.txt"), "newer unrelated\n");
    const lifecycle = promotionLifecycle();

    const settlement = await fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle);

    expect(settlement).toEqual({ outcome: "committed", reason: "local_commit_durable" });
    expect(lifecycle.calls).toEqual([
      ["prepare", fixture.request.promotionId, fixture.delta.deltaDigest],
      ["settle", "committed", "local_commit_durable"],
    ]);
    await expect(readFile(join(fixture.source, "updated.bin"))).resolves.toEqual(
      Buffer.from([9, 0, 8]),
    );
    expect((await stat(join(fixture.source, "updated.bin"))).mode & 0o777).toBe(0o751);
    await expect(lstat(join(fixture.source, "deleted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(fixture.source, "removed"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.source, "created", "new.txt"), "utf8")).resolves.toBe(
      "created\n",
    );
    expect(await readlink(join(fixture.source, "link"))).toBe("created/new.txt");
    expect(await readFile(join(fixture.source, "unrelated.txt"), "utf8")).toBe("newer unrelated\n");
  });

  it("refuses a stale affected parent path before prepare and preserves the newer content", async () => {
    const fixture = await promotionFixture("stale");
    const lifecycle = promotionLifecycle();
    await writeFile(join(fixture.source, "updated.bin"), "newer parent");

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle),
    ).rejects.toMatchObject({ code: "candidate_promotion_stale" });
    expect(lifecycle.calls).toEqual([]);
    expect(await readFile(join(fixture.source, "updated.bin"), "utf8")).toBe("newer parent");
  });

  it("refuses an added child inside an affected directory before prepare", async () => {
    const fixture = await promotionFixture("stale-directory-child");
    const lifecycle = promotionLifecycle();
    await writeFile(join(fixture.source, "removed", "newer.txt"), "newer child\n");

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle),
    ).rejects.toMatchObject({ code: "candidate_promotion_stale" });
    expect(lifecycle.calls).toEqual([]);
    expect(await readFile(join(fixture.source, "removed", "newer.txt"), "utf8")).toBe(
      "newer child\n",
    );
    expect(await readFile(join(fixture.source, "removed", "nested.txt"), "utf8")).toBe("nested\n");
  });

  it("refuses an unchanged ancestor replaced by a symlink before promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-candidate-ancestor-symlink-"));
    const source = join(root, "source");
    const external = join(root, "external");
    const storage = join(root, "state", "workspaces");
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(external);
    await writeFile(join(source, "nested", "value.txt"), "baseline\n");
    const isolator = new ReflinkCopyWorkspaceIsolator(storage);
    const workspace = await isolator.create({
      workspaceId: "candidate-ancestor-symlink",
      sourceCwd: source,
    });
    await writeFile(join(workspace.cwd, "nested", "value.txt"), "candidate\n");
    const delta = await isolator.captureCandidateDelta({
      workspaceId: workspace.workspaceId,
      sourceCwd: source,
      expectedSnapshotDigest: workspace.snapshotDigest,
    });
    await writeFile(join(external, "value.txt"), "baseline\n");
    await rm(join(source, "nested"), { recursive: true });
    await symlink(external, join(source, "nested"));
    const lifecycle = promotionLifecycle();
    const request = {
      promotionId: "promotion-ancestor-symlink",
      workspaceId: workspace.workspaceId,
      sourceCwd: source,
      deltaDigest: delta.deltaDigest,
    } as const;
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(isolator.promoteCandidateDelta(request, lifecycle)).rejects.toMatchObject({
      code: "candidate_promotion_stale",
    });
    expect(lifecycle.calls).toEqual([]);
    await expect(readFile(join(external, "value.txt"), "utf8")).resolves.toBe("baseline\n");
  });

  it("compensates a live mid-apply failure and records a rolled-back settlement", async () => {
    const fixture = await promotionFixture("live-failure");
    const lifecycle = promotionLifecycle();

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle, {
        afterStep(step) {
          if (step === 3) {
            throw new Error("injected apply failure");
          }
        },
      }),
    ).rejects.toMatchObject({ code: "candidate_promotion_rolled_back" });

    expect(lifecycle.calls.at(-1)).toEqual(["settle", "rolled_back", "compensated_after_failure"]);
    await expectBaselineState(fixture.source);
  });

  it("reconciles an interrupted partial apply backward to the previous best", async () => {
    const fixture = await promotionFixture("interrupted-rollback");
    const lifecycle = promotionLifecycle();

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle, {
        afterStep(step) {
          if (step === 3) {
            throw new CandidatePromotionInterruptedError("after_apply_step");
          }
        },
      }),
    ).rejects.toBeInstanceOf(CandidatePromotionInterruptedError);

    await expect(fixture.isolator.reconcileCandidatePromotion(fixture.request)).resolves.toEqual({
      outcome: "rolled_back",
      reason: "reconciled_incomplete",
    });
    await expectBaselineState(fixture.source);
  });

  it("removes a journal-owned staged replacement after interruption before rename", async () => {
    const fixture = await promotionFixture("interrupted-staging");
    const lifecycle = promotionLifecycle();

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle, {
        afterTemporaryDurable() {
          throw new CandidatePromotionInterruptedError("after_temporary_durable");
        },
      }),
    ).rejects.toBeInstanceOf(CandidatePromotionInterruptedError);

    await expect(fixture.isolator.reconcileCandidatePromotion(fixture.request)).resolves.toEqual({
      outcome: "rolled_back",
      reason: "reconciled_incomplete",
    });
    await expect((await import("node:fs/promises")).readdir(fixture.source)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.flow-promote-/)]),
    );
    await expectBaselineState(fixture.source);
  });

  it("does not follow a replaced ancestor while cleaning interrupted staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-candidate-cleanup-symlink-"));
    const source = join(root, "source");
    const external = join(root, "external");
    const storage = join(root, "state", "workspaces");
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(external);
    await writeFile(join(source, "nested", "value.txt"), "baseline\n");
    const isolator = new ReflinkCopyWorkspaceIsolator(storage);
    const workspace = await isolator.create({
      workspaceId: "candidate-cleanup-symlink",
      sourceCwd: source,
    });
    await writeFile(join(workspace.cwd, "nested", "value.txt"), "candidate\n");
    const delta = await isolator.captureCandidateDelta({
      workspaceId: workspace.workspaceId,
      sourceCwd: source,
      expectedSnapshotDigest: workspace.snapshotDigest,
    });
    const request = {
      promotionId: "promotion-cleanup-symlink",
      workspaceId: workspace.workspaceId,
      sourceCwd: source,
      deltaDigest: delta.deltaDigest,
    } as const;
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await expect(
      isolator.promoteCandidateDelta(request, promotionLifecycle(), {
        afterTemporaryDurable() {
          throw new CandidatePromotionInterruptedError("after_temporary_durable");
        },
      }),
    ).rejects.toBeInstanceOf(CandidatePromotionInterruptedError);
    const temporaryName = (await readdir(join(source, "nested"))).find((name) =>
      name.startsWith(".flow-promote-"),
    );
    expect(temporaryName).toBeDefined();
    if (temporaryName === undefined) {
      throw new Error("interrupted promotion did not leave its expected temporary");
    }
    await rm(join(source, "nested"), { recursive: true });
    await writeFile(join(external, "value.txt"), "baseline\n");
    await writeFile(join(external, temporaryName), "external sentinel\n");
    await symlink(external, join(source, "nested"));

    await expect(isolator.reconcileCandidatePromotion(request)).resolves.toEqual({
      outcome: "unknown",
      reason: "affected_path_diverged",
    });
    await expect(readFile(join(external, temporaryName), "utf8")).resolves.toBe(
      "external sentinel\n",
    );
  });

  it("reconciles a durable local commit forward without reapplying it", async () => {
    const fixture = await promotionFixture("interrupted-commit");
    const lifecycle = promotionLifecycle();

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle, {
        afterLocalCommit() {
          throw new CandidatePromotionInterruptedError("after_local_commit");
        },
      }),
    ).rejects.toBeInstanceOf(CandidatePromotionInterruptedError);
    const beforeReconcile = await readFile(join(fixture.source, "updated.bin"));

    await expect(fixture.isolator.reconcileCandidatePromotion(fixture.request)).resolves.toEqual({
      outcome: "committed",
      reason: "local_commit_durable",
    });
    expect(await readFile(join(fixture.source, "updated.bin"))).toEqual(beforeReconcile);
  });

  it("returns unknown and preserves artifacts when an interrupted affected path diverges", async () => {
    const fixture = await promotionFixture("interrupted-unknown");
    const lifecycle = promotionLifecycle();

    await expect(
      fixture.isolator.promoteCandidateDelta(fixture.request, lifecycle, {
        afterStep(step) {
          if (step === 3) {
            throw new CandidatePromotionInterruptedError("after_apply_step");
          }
        },
      }),
    ).rejects.toBeInstanceOf(CandidatePromotionInterruptedError);
    await writeFile(join(fixture.source, "updated.bin"), "hostile third state");

    await expect(fixture.isolator.reconcileCandidatePromotion(fixture.request)).resolves.toEqual({
      outcome: "unknown",
      reason: "affected_path_diverged",
    });
    expect(await readFile(join(fixture.source, "updated.bin"), "utf8")).toBe("hostile third state");
  });
});

async function promotionFixture(suffix: string) {
  const root = await mkdtemp(join(tmpdir(), "flow-candidate-promotion-"));
  const source = join(root, "source");
  const storage = join(root, "state", "workspaces");
  await mkdir(join(source, "removed"), { recursive: true });
  await writeFile(join(source, "updated.bin"), Buffer.from([0, 1, 2]));
  await chmod(join(source, "updated.bin"), 0o640);
  await writeFile(join(source, "deleted.txt"), "deleted\n");
  await writeFile(join(source, "removed", "nested.txt"), "nested\n");
  await symlink("deleted.txt", join(source, "link"));
  const isolator = new ReflinkCopyWorkspaceIsolator(storage);
  const workspace = await isolator.create({
    workspaceId: `candidate-${suffix}`,
    sourceCwd: source,
  });
  await writeFile(join(workspace.cwd, "updated.bin"), Buffer.from([9, 0, 8]));
  await chmod(join(workspace.cwd, "updated.bin"), 0o751);
  await unlink(join(workspace.cwd, "deleted.txt"));
  await rm(join(workspace.cwd, "removed"), { recursive: true });
  await mkdir(join(workspace.cwd, "created"), { mode: 0o750 });
  await writeFile(join(workspace.cwd, "created", "new.txt"), "created\n");
  await unlink(join(workspace.cwd, "link"));
  await symlink("created/new.txt", join(workspace.cwd, "link"));
  const delta = await isolator.captureCandidateDelta({
    workspaceId: workspace.workspaceId,
    sourceCwd: source,
    expectedSnapshotDigest: workspace.snapshotDigest,
  });
  const request = {
    promotionId: `promotion-${suffix}`,
    workspaceId: workspace.workspaceId,
    sourceCwd: source,
    deltaDigest: delta.deltaDigest,
  } as const;
  cleanup.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, storage, isolator, workspace, delta, request };
}

function promotionLifecycle() {
  const calls: unknown[][] = [];
  return {
    calls,
    async prepare(boundary: { promotionId: string; deltaDigest: string }) {
      calls.push(["prepare", boundary.promotionId, boundary.deltaDigest]);
    },
    async settle(settlement: { outcome: string; reason: string }) {
      calls.push(["settle", settlement.outcome, settlement.reason]);
    },
  };
}

async function expectBaselineState(source: string): Promise<void> {
  expect(await readFile(join(source, "updated.bin"))).toEqual(Buffer.from([0, 1, 2]));
  expect((await stat(join(source, "updated.bin"))).mode & 0o777).toBe(0o640);
  expect(await readFile(join(source, "deleted.txt"), "utf8")).toBe("deleted\n");
  expect(await readFile(join(source, "removed", "nested.txt"), "utf8")).toBe("nested\n");
  expect(await readlink(join(source, "link"))).toBe("deleted.txt");
  await expect(lstat(join(source, "created"))).rejects.toMatchObject({ code: "ENOENT" });
}
