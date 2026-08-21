import { appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGoalWorkspaceRevision,
  type GoalWorkspaceRevision,
  parseGoalWorkspaceSourceText,
} from "../../../../src/domain/goal/workspace.js";
import {
  goalWorkspaceLedgerPath,
  LocalGoalWorkspaceStore,
} from "../../../../src/infrastructure/fs/local-goal-workspace-store.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanup].map(async (path) => await rm(path, { recursive: true, force: true })),
  );
  cleanup.clear();
});

describe("local goal workspace store", { timeout: 20_000 }, () => {
  it("initializes, updates with exact CAS, and replays bounded history after restart", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    const second = revision(2, first.digest, "Second objective.");

    await expect(store.initialize(first)).resolves.toEqual(first);
    await expect(
      store.update({ revision: first.revision, digest: first.digest }, second),
    ).resolves.toEqual(second);

    const reopened = new LocalGoalWorkspaceStore(projectRoot);
    await expect(reopened.readCurrent()).resolves.toEqual(second);
    await expect(reopened.readHistory({ after: 0, limit: 1 })).resolves.toEqual([first]);
    await expect(reopened.readHistory({ after: 1, limit: 20 })).resolves.toEqual([second]);
  });

  it("rejects duplicate initialization and stale revision or digest without mutation", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const second = revision(2, first.digest, "Second objective.");

    await expect(store.initialize(first)).rejects.toMatchObject({ code: "already_exists" });
    await expect(store.update({ revision: 2, digest: first.digest }, second)).rejects.toMatchObject(
      {
        code: "conflict",
      },
    );
    await expect(
      store.update({ revision: 1, digest: "f".repeat(64) }, second),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.readCurrent()).resolves.toEqual(first);
  });

  it("rejects a revision timestamp rollback without corrupting the committed ledger", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const rollback = createGoalWorkspaceRevision(
      parseGoalWorkspaceSourceText(
        JSON.stringify({
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "GoalWorkspace",
          objective: "Rollback objective.",
          facts: [],
          invariants: [],
          verifiedFacts: [],
          openQuestions: [],
          nextAction: { id: "continue", text: "Continue." },
        }),
        "goal.json",
      ),
      [],
      {
        revision: 2,
        previousDigest: first.digest,
        at: "2026-08-21T09:59:00.000Z",
      },
    );

    await expect(
      store.update({ revision: first.revision, digest: first.digest }, rollback),
    ).rejects.toMatchObject({
      code: "clock_rollback",
      message: "goal workspace clock moved backward",
    });
    await expect(store.readCurrent()).resolves.toEqual(first);
  });

  it("serializes concurrent writers and commits at most one stale candidate", async () => {
    const projectRoot = await temporaryProject();
    const firstStore = new LocalGoalWorkspaceStore(projectRoot);
    const initial = revision(1, null, "Initial objective.");
    await firstStore.initialize(initial);
    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let acquired: (() => void) | undefined;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holdingStore = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        afterLockAcquired: async () => {
          acquired?.();
          await lockHeld;
        },
      },
    });
    const contender = new LocalGoalWorkspaceStore(projectRoot);
    const expected = { revision: initial.revision, digest: initial.digest };
    const firstUpdate = holdingStore.update(
      expected,
      revision(2, initial.digest, "Winner objective."),
    );
    await acquiredLock;

    await expect(
      contender.update(expected, revision(2, initial.digest, "Losing objective.")),
    ).rejects.toMatchObject({ code: "busy" });
    releaseLock?.();
    await expect(firstUpdate).resolves.toMatchObject({ objective: "Winner objective." });
    await expect(firstStore.readCurrent()).resolves.toMatchObject({
      objective: "Winner objective.",
    });
  });

  it("retires a complete writer lease whose owner process no longer exists", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const writer = join(projectRoot, ".flow", "goal-workspace", ".writer");
    await mkdir(writer, { mode: 0o700 });
    await writeFile(
      join(writer, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: crypto.randomUUID(),
        acquiredAt: "2026-08-21T10:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const second = revision(2, first.digest, "Recovered objective.");

    await expect(store.update({ revision: 1, digest: first.digest }, second)).resolves.toEqual(
      second,
    );
    await expect(store.readCurrent()).resolves.toEqual(second);
  });

  it("ignores an unterminated tail and repairs it only while committing the next revision", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    await appendFile(goalWorkspaceLedgerPath(projectRoot), '{"PRIVATE_TORN_TAIL"');

    await expect(store.readCurrent()).resolves.toEqual(first);
    const second = revision(2, first.digest, "Second objective.");
    await store.update({ revision: 1, digest: first.digest }, second);

    const ledger = await readFile(goalWorkspaceLedgerPath(projectRoot), "utf8");
    expect(ledger).not.toContain("PRIVATE_TORN_TAIL");
    expect(ledger.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("rejects committed corruption without disclosing its contents", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const corrupt = {
      ...revision(2, first.digest, "Second objective."),
      objective: "PRIVATE_CORRUPT",
    };
    await appendFile(goalWorkspaceLedgerPath(projectRoot), `${JSON.stringify(corrupt)}\n`);

    const error = await store.readCurrent().catch((caught) => caught);
    expect(error).toMatchObject({ code: "corrupt" });
    expect((error as Error).message).toBe("goal workspace ledger is corrupt");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_CORRUPT");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("rejects a valid revision whose predecessor does not match the committed head", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const disconnected = revision(2, "f".repeat(64), "Disconnected objective.");
    await appendFile(goalWorkspaceLedgerPath(projectRoot), `${JSON.stringify(disconnected)}\n`);

    await expect(store.readCurrent()).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects a symlinked ledger without following the external target", async () => {
    const projectRoot = await temporaryProject();
    const store = new LocalGoalWorkspaceStore(projectRoot);
    const first = revision(1, null, "First objective.");
    await store.initialize(first);
    const external = join(await temporaryProject(), "PRIVATE_EXTERNAL_LEDGER");
    await writeFile(external, `${JSON.stringify(first)}\n`);
    const ledgerPath = goalWorkspaceLedgerPath(projectRoot);
    await rename(ledgerPath, `${ledgerPath}.original`);
    await symlink(external, ledgerPath);

    await expect(store.readCurrent()).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(readFile(external, "utf8")).resolves.toContain("First objective.");
  });

  it("rejects a ledger path replacement after reading the opened inode", async () => {
    const projectRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    await new LocalGoalWorkspaceStore(projectRoot).initialize(first);
    const ledgerPath = goalWorkspaceLedgerPath(projectRoot);
    let replaced = false;
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        afterLedgerFileRead: async () => {
          if (replaced) return;
          replaced = true;
          await rename(ledgerPath, `${ledgerPath}.original`);
          await writeFile(ledgerPath, `${JSON.stringify(first)}\n`, { mode: 0o600 });
        },
      },
    });

    await expect(store.readCurrent()).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects a symlinked Flow state directory before creating external workspace state", async () => {
    const projectRoot = join(tmpdir(), `flow-goal-workspace-${crypto.randomUUID()}`);
    const external = join(tmpdir(), `flow-goal-workspace-external-${crypto.randomUUID()}`);
    cleanup.add(projectRoot);
    cleanup.add(external);
    await mkdir(projectRoot);
    await mkdir(external);
    await symlink(external, join(projectRoot, ".flow"));

    await expect(
      new LocalGoalWorkspaceStore(projectRoot).initialize(revision(1, null, "First objective.")),
    ).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(readFile(join(external, "goal-workspace", "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces exact ledger byte and revision-count limits", async () => {
    const exactRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    const lineBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`, "utf8");
    await expect(
      new LocalGoalWorkspaceStore(exactRoot, { maxLedgerBytes: lineBytes }).initialize(first),
    ).resolves.toEqual(first);

    const overflowRoot = await temporaryProject();
    await expect(
      new LocalGoalWorkspaceStore(overflowRoot, { maxLedgerBytes: lineBytes - 1 }).initialize(
        first,
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    const revisionRoot = await temporaryProject();
    const bounded = new LocalGoalWorkspaceStore(revisionRoot, { maxRevisions: 1 });
    await bounded.initialize(first);
    await expect(
      bounded.update(
        { revision: first.revision, digest: first.digest },
        revision(2, first.digest, "Second objective."),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    await expect(bounded.readHistory({ after: 0, limit: 100 })).resolves.toEqual([first]);
    await expect(bounded.readHistory({ after: 0, limit: 101 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  }, 15_000);

  it("preserves exact cancellation before append and commits no new revision", async () => {
    const projectRoot = await temporaryProject();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_EXACT_CANCELLATION");
    const first = revision(1, null, "First objective.");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: { beforeAppend: () => controller.abort(reason) },
    });

    await expect(store.initialize(first, controller.signal)).rejects.toBe(reason);
    await expect(new LocalGoalWorkspaceStore(projectRoot).readCurrent()).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("preserves exact cancellation at a ledger read boundary", async () => {
    const projectRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    await new LocalGoalWorkspaceStore(projectRoot).initialize(first);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_READ_CANCELLATION");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        afterLedgerChunkRead: () => controller.abort(reason),
      },
    });

    await expect(store.readCurrent(controller.signal)).rejects.toBe(reason);
  });

  it("reconciles an exact durable append after a later operation failure", async () => {
    const projectRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        afterAppendSynced: () => {
          throw new Error("PRIVATE_POST_COMMIT_FAILURE");
        },
      },
    });

    await expect(store.initialize(first)).resolves.toEqual(first);
    await expect(new LocalGoalWorkspaceStore(projectRoot).readCurrent()).resolves.toEqual(first);
  });

  it("does not report initial commit success before the ledger directory entry is settled", async () => {
    const projectRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        beforeLedgerDirectorySynced: () => {
          throw new Error("PRIVATE_DIRECTORY_SYNC_FAILURE");
        },
      },
    });

    const error = await store.initialize(first).catch((caught) => caught);

    expect(error).toMatchObject({ code: "commit_uncertain" });
    expect((error as Error).message).toBe("goal workspace commit is uncertain");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_DIRECTORY_SYNC_FAILURE");
  });

  it("returns exact durable success when cancellation arrives after append sync", async () => {
    const projectRoot = await temporaryProject();
    const controller = new AbortController();
    const first = revision(1, null, "First objective.");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        afterAppendSynced: () => controller.abort(new Error("PRIVATE_LATE_CANCELLATION")),
      },
    });

    await expect(store.initialize(first, controller.signal)).resolves.toEqual(first);
    await expect(new LocalGoalWorkspaceStore(projectRoot).readCurrent()).resolves.toEqual(first);
  });

  it("reports lock-release uncertainty without masking the durable revision", async () => {
    const projectRoot = await temporaryProject();
    const first = revision(1, null, "First objective.");
    const store = new LocalGoalWorkspaceStore(projectRoot, {
      hooks: {
        beforeLockReleased: () => {
          throw new Error("PRIVATE_RELEASE_FAILURE");
        },
      },
    });

    const error = await store.initialize(first).catch((caught) => caught);
    expect(error).toMatchObject({ code: "settlement_uncertain" });
    expect((error as Error).message).toBe("goal workspace writer settlement is uncertain");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_RELEASE_FAILURE");
    await expect(new LocalGoalWorkspaceStore(projectRoot).readCurrent()).resolves.toEqual(first);
  });
});

async function temporaryProject(): Promise<string> {
  const root = join(tmpdir(), `flow-goal-workspace-${crypto.randomUUID()}`);
  cleanup.add(root);
  await mkdir(join(root, ".flow"), { recursive: true });
  return root;
}

function revision(
  revisionNumber: number,
  previousDigest: string | null,
  objective: string,
): GoalWorkspaceRevision {
  return createGoalWorkspaceRevision(
    parseGoalWorkspaceSourceText(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "GoalWorkspace",
        objective,
        facts: [],
        invariants: [],
        verifiedFacts: [],
        openQuestions: [],
        nextAction: { id: "continue", text: "Continue." },
      }),
      "goal.json",
    ),
    [],
    {
      revision: revisionNumber,
      previousDigest,
      at: `2026-08-21T10:${String(revisionNumber).padStart(2, "0")}:00.000Z`,
    },
  );
}
