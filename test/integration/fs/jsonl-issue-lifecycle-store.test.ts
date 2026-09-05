import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IssueLifecycleEvent } from "../../../src/domain/issue-lifecycle/events.js";
import { deriveIssueExternalEffectId } from "../../../src/domain/issue-lifecycle/events.js";
import {
  type IssueLifecycleOwnershipWitnessAdapter,
  type IssueLifecycleOwnershipWitnessHandle,
  type IssueLifecycleOwnershipWitnessProbe,
  type IssueLifecycleOwnershipWitnessRecord,
  IssueLifecycleStoreError,
  JsonlIssueLifecycleStore,
  MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE,
} from "../../../src/infrastructure/fs/jsonl-issue-lifecycle-store.js";

const temporaryDirectories: string[] = [];
const RUN_ID = "issue-run-197";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlIssueLifecycleStore", () => {
  it("durably creates on sequence one and appends reducer-validated events", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    const events = [issueSnapshot(), workspacePrepared()];

    for (const event of events) await store.append(event);

    await expect(store.read(RUN_ID)).resolves.toEqual(events);
    await expect(store.exists(RUN_ID)).resolves.toBe(true);
    const contents = await readFile(join(root, RUN_ID, "events.jsonl"), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trim().split("\n")).toHaveLength(2);
  });

  it("serializes concurrent appends from one owner", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);

    await store.append(issueSnapshot());
    await Promise.all([store.append(workspacePrepared()), store.append(workspaceSettled())]);

    await expect(store.read(RUN_ID)).resolves.toEqual([
      issueSnapshot(),
      workspacePrepared(),
      workspaceSettled(),
    ]);
  });

  it("returns bounded public pages with stable cursors and terminal state", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.append(issueSnapshot());
    await store.append(runFailed());

    await expect(store.readPage({ runId: RUN_ID, afterSequence: 0, limit: 1 })).resolves.toEqual({
      events: [issueSnapshot()],
      cursor: 1,
      hasMore: true,
      terminal: false,
    });
    await expect(store.readPage({ runId: RUN_ID, afterSequence: 1, limit: 1 })).resolves.toEqual({
      events: [runFailed()],
      cursor: 2,
      hasMore: false,
      terminal: true,
    });
    await expect(store.readPage({ runId: RUN_ID, afterSequence: 2, limit: 1 })).resolves.toEqual({
      events: [],
      cursor: 2,
      hasMore: false,
      terminal: true,
    });
  });

  it("rejects invalid page bounds and cursors", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.append(issueSnapshot());

    for (const request of [
      { runId: RUN_ID, afterSequence: -1, limit: 1 },
      { runId: RUN_ID, afterSequence: 0, limit: 0 },
      { runId: RUN_ID, afterSequence: 0, limit: MAX_ISSUE_LIFECYCLE_EVENT_PAGE_SIZE + 1 },
      { runId: RUN_ID, afterSequence: 2, limit: 1 },
    ]) {
      await expect(store.readPage(request)).rejects.toMatchObject({ code: "invalid_page" });
    }
  });

  it("rejects unsafe run identities before resolving a path with content-free errors", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);

    for (const runId of ["../secret", "Upper", "under_score", "a-", "x".repeat(129)]) {
      const error = await store.read(runId).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(IssueLifecycleStoreError);
      expect(error).toMatchObject({ code: "invalid_run_id" });
      expect((error as Error).message).toBe("Issue lifecycle store failed: invalid_run_id");
      expect((error as Error).message).not.toContain(runId);
      expect((error as Error).message).not.toContain(root);
    }
  });

  it("creates only on sequence one and rejects invalid append order before writing", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);

    await expect(store.append(workspacePrepared())).rejects.toMatchObject({ code: "not_owner" });
    await store.append(issueSnapshot());
    await expect(store.append({ ...workspacePrepared(), sequence: 3 })).rejects.toMatchObject({
      code: "sequence",
    });
    await expect(store.append(illegalTransition())).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.read(RUN_ID)).resolves.toEqual([issueSnapshot()]);
  });

  it("atomically grants a new run to one store instance", async () => {
    const root = await createTemporaryDirectory();
    const witnesses = new FakeOwnershipWitnessAdapter();
    const first = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    const second = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });

    const results = await Promise.allSettled([
      first.append(issueSnapshot()),
      second.append(issueSnapshot()),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "run_exists" },
    });
    expect(witnesses.openHandleCount()).toBe(1);
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).resolves.toEqual([
      issueSnapshot(),
    ]);
    await first.release(RUN_ID);
    await second.release(RUN_ID);
    expect(witnesses.openHandleCount()).toBe(0);
  });

  it("closes the default loopback witness when ownership is released", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.append(issueSnapshot());
    const owner = await readOwner(root);

    await expect(readLoopbackWitness(owner.witness, owner.token)).resolves.toBe(owner.token);
    await store.release(RUN_ID);
    await expect(readLoopbackWitness(owner.witness, owner.token)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  it("closes an acquired witness when first publication fails", async () => {
    const root = await createTemporaryDirectory();
    const witnesses = new FakeOwnershipWitnessAdapter();
    witnesses.afterAcquire = async (token) => {
      await mkdir(join(root, `.${RUN_ID}-${token}.pending`), { mode: 0o700 });
    };

    await expect(
      new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses }).append(issueSnapshot()),
    ).rejects.toMatchObject({ code: "io" });
    expect(witnesses.openHandleCount()).toBe(0);
  });

  it("does not let an abandoned first-record staging directory reserve a run identity", async () => {
    const root = await createTemporaryDirectory();
    const abandoned = join(root, `.${RUN_ID}-abandoned.pending`);
    await mkdir(abandoned, { mode: 0o700 });
    await writeFile(join(abandoned, "events.jsonl"), '{"partial":true}', "utf8");
    const store = new JsonlIssueLifecycleStore(root);

    await expect(store.append(issueSnapshot())).resolves.toBeUndefined();
    await expect(store.read(RUN_ID)).resolves.toEqual([issueSnapshot()]);
  });

  it("requires exclusive ownership and supports release, claim, and resumed append", async () => {
    const root = await createTemporaryDirectory();
    const owner = new JsonlIssueLifecycleStore(root);
    await owner.append(issueSnapshot());

    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "not_owner",
    });
    await owner.release(RUN_ID);
    await owner.release(RUN_ID);
    const recovered = new JsonlIssueLifecycleStore(root);
    await expect(recovered.claim(RUN_ID)).resolves.toEqual([issueSnapshot()]);
    await recovered.append(workspacePrepared());
    await expect(recovered.read(RUN_ID)).resolves.toEqual([issueSnapshot(), workspacePrepared()]);
  });

  it("atomically grants released recovery ownership to one claimant", async () => {
    const root = await createTemporaryDirectory();
    const witnesses = new FakeOwnershipWitnessAdapter();
    const original = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    const first = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    const second = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });

    const results = await Promise.allSettled([first.claim(RUN_ID), second.claim(RUN_ID)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(witnesses.openHandleCount()).toBe(1);
    await first.release(RUN_ID);
    await second.release(RUN_ID);
    expect(witnesses.openHandleCount()).toBe(0);
  });

  it("reclaims a crashed first-event owner even when its PID has been reused", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    const witnesses = new FakeOwnershipWitnessAdapter();
    await writeOwner(root, process.pid, { host: "127.0.0.1", port: 41_001 });

    const recovered = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    await expect(recovered.claim(RUN_ID)).resolves.toEqual([issueSnapshot()]);
    expect(witnesses.openHandleCount()).toBe(1);
    await recovered.release(RUN_ID);
    expect(witnesses.openHandleCount()).toBe(0);
  });

  it("atomically recovers one owner when claimants observe the same dead witness", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await writeOwner(root, process.pid, { host: "127.0.0.1", port: 41_001 });
    const witnesses = new DeadWitnessRaceAdapter(41_001);
    const first = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    const second = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });

    const results = await Promise.allSettled([first.claim(RUN_ID), second.claim(RUN_ID)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(witnesses.openHandleCount()).toBe(1);
    await first.release(RUN_ID);
    await second.release(RUN_ID);
    expect(witnesses.openHandleCount()).toBe(0);
  });

  it.each(["live", "ambiguous"] as const)(
    "fails closed when the recorded ownership witness is %s",
    async (probe) => {
      const root = await createTemporaryDirectory();
      const witnesses = new FakeOwnershipWitnessAdapter();
      const owner = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
      await owner.append(issueSnapshot());
      witnesses.probeOverride = probe;

      await expect(
        new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses }).claim(RUN_ID),
      ).rejects.toMatchObject({ code: "not_owner" });
      expect(witnesses.openHandleCount()).toBe(1);
      await owner.release(RUN_ID);
    },
  );

  it("rejects append without mutation after the local ownership witness is lost", async () => {
    const root = await createTemporaryDirectory();
    const witnesses = new FakeOwnershipWitnessAdapter();
    const store = new JsonlIssueLifecycleStore(root, { ownershipWitness: witnesses });
    await store.append(issueSnapshot());
    await witnesses.closeAll();

    await expect(store.append(workspacePrepared())).rejects.toMatchObject({ code: "not_owner" });
    await expect(store.read(RUN_ID)).resolves.toEqual([issueSnapshot()]);
  });

  it("ignores a torn tail on public read and repairs it when claimed", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    const path = eventsPath(root);
    await appendFile(path, '{"version":1', "utf8");

    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).resolves.toEqual([
      issueSnapshot(),
    ]);
    const recovered = new JsonlIssueLifecycleStore(root);
    await recovered.claim(RUN_ID);
    await expect(readFile(path, "utf8")).resolves.toBe(`${JSON.stringify(issueSnapshot())}\n`);
    await recovered.append(workspacePrepared());
    await expect(recovered.read(RUN_ID)).resolves.toEqual([issueSnapshot(), workspacePrepared()]);
  });

  it("treats a valid unterminated final event as uncommitted", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await appendFile(eventsPath(root), JSON.stringify(workspacePrepared()), "utf8");

    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).resolves.toEqual([
      issueSnapshot(),
    ]);
  });

  it("fails closed on committed corruption and mismatched ledger identity", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await appendFile(eventsPath(root), "not-json\n", "utf8");

    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "corrupt",
    });
    await writeFile(
      eventsPath(root),
      `${JSON.stringify({ ...issueSnapshot(), runId: "different-run" })}\n`,
      "utf8",
    );
    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("fails closed on corrupt or incomplete ownership records", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    const ownerDirectory = join(root, RUN_ID, ".owner");
    await mkdir(ownerDirectory, { mode: 0o700 });
    await writeFile(join(ownerDirectory, "owner.json"), "not-json\n", { mode: 0o600 });
    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "corrupt",
    });

    await rm(ownerDirectory, { recursive: true });
    await mkdir(ownerDirectory, { mode: 0o700 });
    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("bounds ownership metadata and fails closed if the active record disappears", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await rm(join(root, RUN_ID, ".owner"), { recursive: true });
    await expect(original.append(workspacePrepared())).rejects.toMatchObject({ code: "corrupt" });

    await mkdir(join(root, RUN_ID, ".owner"), { mode: 0o700 });
    await writeFile(join(root, RUN_ID, ".owner", "owner.json"), "x".repeat(4_097), {
      mode: 0o600,
    });
    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "limit",
    });
  });

  it("rejects symbolic run, record, and ownership paths", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    await symlink(outside, join(root, RUN_ID));
    await expect(new JsonlIssueLifecycleStore(root).append(issueSnapshot())).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await rm(join(root, RUN_ID));

    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await rm(eventsPath(root));
    await writeFile(join(outside, "outside-events"), "secret", { mode: 0o600 });
    await symlink(join(outside, "outside-events"), eventsPath(root));
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });

    await rm(eventsPath(root));
    await writeFile(eventsPath(root), `${JSON.stringify(issueSnapshot())}\n`, { mode: 0o600 });
    await symlink(outside, join(root, RUN_ID, ".owner"));
    await expect(new JsonlIssueLifecycleStore(root).claim(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects a symbolic storage root and special or multiply linked records", async () => {
    const parent = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const symbolicRoot = join(parent, "issue-runs");
    await symlink(outside, symbolicRoot);
    await expect(
      new JsonlIssueLifecycleStore(symbolicRoot).append(issueSnapshot()),
    ).rejects.toMatchObject({ code: "unsafe_path" });

    const populatedOutside = await createTemporaryDirectory();
    const populatedStore = new JsonlIssueLifecycleStore(populatedOutside);
    await populatedStore.append(issueSnapshot());
    await populatedStore.release(RUN_ID);
    const populatedSymbolicRoot = join(parent, "populated-issue-runs");
    await symlink(populatedOutside, populatedSymbolicRoot);
    await expect(
      new JsonlIssueLifecycleStore(populatedSymbolicRoot).read(RUN_ID),
    ).rejects.toMatchObject({ code: "unsafe_path" });

    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await link(eventsPath(root), join(outside, "linked-events"));
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await rm(join(outside, "linked-events"));
    await rm(eventsPath(root));
    await mkdir(eventsPath(root), { mode: 0o700 });
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects unsafe ledger and directory permissions", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlIssueLifecycleStore(root);
    await original.append(issueSnapshot());
    await original.release(RUN_ID);
    await chmod(eventsPath(root), 0o644);
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await chmod(eventsPath(root), 0o600);
    await chmod(join(root, RUN_ID), 0o755);
    await expect(new JsonlIssueLifecycleStore(root).read(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("enforces configured event, ledger, event-count, and read ceilings", async () => {
    const firstLine = `${JSON.stringify(issueSnapshot())}\n`;
    const firstBytes = Buffer.byteLength(firstLine, "utf8");

    const eventRoot = await createTemporaryDirectory();
    const eventLimited = new JsonlIssueLifecycleStore(eventRoot, {
      maxEventBytes: firstBytes - 1,
      maxLedgerBytes: firstBytes,
    });
    await expect(eventLimited.append(issueSnapshot())).rejects.toMatchObject({ code: "limit" });
    await expect(eventLimited.exists(RUN_ID)).resolves.toBe(false);

    const ledgerRoot = await createTemporaryDirectory();
    const ledgerLimited = new JsonlIssueLifecycleStore(ledgerRoot, {
      maxEventBytes: firstBytes,
      maxLedgerBytes: firstBytes,
    });
    await ledgerLimited.append(issueSnapshot());
    await expect(ledgerLimited.append(workspacePrepared())).rejects.toMatchObject({
      code: "limit",
    });

    const countRoot = await createTemporaryDirectory();
    const countLimited = new JsonlIssueLifecycleStore(countRoot, { maxEvents: 1 });
    await countLimited.append(issueSnapshot());
    await expect(countLimited.append(workspacePrepared())).rejects.toMatchObject({ code: "limit" });

    const readRoot = await createTemporaryDirectory();
    const writer = new JsonlIssueLifecycleStore(readRoot);
    await writer.append(issueSnapshot());
    await writer.append(workspacePrepared());
    await writer.release(RUN_ID);
    await expect(
      new JsonlIssueLifecycleStore(readRoot, { maxEvents: 1 }).read(RUN_ID),
    ).rejects.toMatchObject({ code: "limit" });
    await expect(
      new JsonlIssueLifecycleStore(readRoot, {
        maxEventBytes: firstBytes - 1,
        maxLedgerBytes: firstBytes * 4,
      }).read(RUN_ID),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("rejects invalid configured limits", async () => {
    const root = await createTemporaryDirectory();
    for (const options of [
      { maxEventBytes: 0 },
      { maxLedgerBytes: 0 },
      { maxEvents: 0 },
      { maxPageSize: 0 },
      { maxEventBytes: 2, maxLedgerBytes: 1 },
    ]) {
      expect(() => new JsonlIssueLifecycleStore(root, options)).toThrow(RangeError);
    }
  });

  it("reports a missing run without creating storage", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);

    await expect(store.exists(RUN_ID)).resolves.toBe(false);
    await expect(store.read(RUN_ID)).rejects.toMatchObject({ code: "not_found" });
    await expect(store.claim(RUN_ID)).rejects.toMatchObject({ code: "not_found" });
    await expect(lstat(join(root, RUN_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-issue-lifecycle-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function issueSnapshot(): IssueLifecycleEvent {
  return {
    ...base(1),
    type: "phase_transitioned",
    from: "preflight",
    to: "issue_frozen",
    receipt: {
      kind: "issue_snapshot",
      repositoryIdentity: "owner/repo",
      issueNumber: 197,
      issueNodeId: "I_issue197",
      issueUpdatedAt: "2026-08-28T12:00:00.000Z",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      branch: "flow/issue-197",
      issueDigest: "b".repeat(64),
      frozenContractDigest: "1".repeat(64),
      planDigest: "2".repeat(64),
      implementationTemplateWorkflowDigest: "3".repeat(64),
      reviewTemplateWorkflowDigest: "4".repeat(64),
      budgetDigest: "5".repeat(64),
      evidenceDigest: "c".repeat(64),
    },
  };
}

function workspacePrepared(): Extract<
  IssueLifecycleEvent,
  { readonly type: "external_effect_prepared" }
> {
  const operationDigest = "d".repeat(64);
  return {
    ...base(2),
    type: "external_effect_prepared",
    effectId: deriveIssueExternalEffectId("workspace", operationDigest),
    effectKind: "workspace",
    operationDigest,
  };
}

function workspaceSettled(): IssueLifecycleEvent {
  return {
    ...base(3),
    type: "external_effect_settled",
    effectId: workspacePrepared().effectId,
    outcome: "applied",
    observationDigest: "e".repeat(64),
    result: { kind: "workspace", workspaceIdentityDigest: "f".repeat(64) },
  };
}

function runFailed(): IssueLifecycleEvent {
  return {
    ...base(2),
    type: "run_failed",
    code: "verification_failed",
    evidenceDigest: "6".repeat(64),
  };
}

function illegalTransition(): IssueLifecycleEvent {
  return {
    ...base(2),
    type: "phase_transitioned",
    from: "issue_frozen",
    to: "workspace_prepared",
    receipt: {
      kind: "workspace",
      workspaceIdentityDigest: "f".repeat(64),
      evidenceDigest: "c".repeat(64),
    },
  };
}

function eventsPath(root: string): string {
  return join(root, RUN_ID, "events.jsonl");
}

async function writeOwner(
  root: string,
  pid: number,
  witness: IssueLifecycleOwnershipWitnessRecord = { host: "127.0.0.1", port: 41_000 },
): Promise<void> {
  const ownerDirectory = join(root, RUN_ID, ".owner");
  await mkdir(ownerDirectory, { mode: 0o700 });
  await writeFile(
    join(ownerDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      pid,
      token: "00000000-0000-4000-8000-000000000000",
      acquiredAt: "2026-08-28T12:00:00.000Z",
      witness,
    })}\n`,
    { mode: 0o600 },
  );
}

class FakeOwnershipWitnessAdapter implements IssueLifecycleOwnershipWitnessAdapter {
  probeOverride: IssueLifecycleOwnershipWitnessProbe | undefined;
  afterAcquire: ((token: string) => Promise<void>) | undefined;
  readonly #handles = new Map<string, FakeOwnershipWitnessHandle>();
  #nextPort = 42_000;

  async acquire(token: string): Promise<IssueLifecycleOwnershipWitnessHandle> {
    const handle = new FakeOwnershipWitnessHandle(
      token,
      { host: "127.0.0.1", port: this.#nextPort },
      () => this.#handles.delete(token),
    );
    this.#nextPort += 1;
    this.#handles.set(token, handle);
    await this.afterAcquire?.(token);
    return handle;
  }

  async probe(
    record: IssueLifecycleOwnershipWitnessRecord,
    token: string,
  ): Promise<IssueLifecycleOwnershipWitnessProbe> {
    if (this.probeOverride !== undefined) return this.probeOverride;
    const handle = this.#handles.get(token);
    if (handle === undefined || !handle.isOpen()) return "dead";
    return sameWitness(handle.record, record) ? "live" : "ambiguous";
  }

  openHandleCount(): number {
    return [...this.#handles.values()].filter((handle) => handle.isOpen()).length;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#handles.values()].map(async (handle) => await handle.close()));
  }
}

class DeadWitnessRaceAdapter extends FakeOwnershipWitnessAdapter {
  readonly #deadPort: number;
  #probeCount = 0;
  readonly #barrier: Promise<void>;
  #releaseBarrier: (() => void) | undefined;

  constructor(deadPort: number) {
    super();
    this.#deadPort = deadPort;
    this.#barrier = new Promise((resolveBarrier) => {
      this.#releaseBarrier = resolveBarrier;
    });
  }

  override async probe(
    record: IssueLifecycleOwnershipWitnessRecord,
    token: string,
  ): Promise<IssueLifecycleOwnershipWitnessProbe> {
    if (record.port !== this.#deadPort) return await super.probe(record, token);
    this.#probeCount += 1;
    if (this.#probeCount === 2) this.#releaseBarrier?.();
    await this.#barrier;
    return "dead";
  }
}

class FakeOwnershipWitnessHandle implements IssueLifecycleOwnershipWitnessHandle {
  #open = true;

  constructor(
    readonly token: string,
    readonly record: IssueLifecycleOwnershipWitnessRecord,
    readonly onClose: () => void,
  ) {}

  isOpen(): boolean {
    return this.#open;
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    this.onClose();
  }
}

function sameWitness(
  left: IssueLifecycleOwnershipWitnessRecord,
  right: IssueLifecycleOwnershipWitnessRecord,
): boolean {
  return left.host === right.host && left.port === right.port;
}

async function readOwner(root: string): Promise<{
  readonly token: string;
  readonly witness: IssueLifecycleOwnershipWitnessRecord;
}> {
  return JSON.parse(await readFile(join(root, RUN_ID, ".owner", "owner.json"), "utf8"));
}

async function readLoopbackWitness(
  record: IssueLifecycleOwnershipWitnessRecord,
  token: string,
): Promise<string> {
  return await new Promise((resolveWitness, rejectWitness) => {
    let response = "";
    const socket = createConnection({ host: record.host, port: record.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectWitness(new Error("Timed out reading ownership witness"));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      resolveWitness(response.trimEnd());
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectWitness(error);
    });
  }).then((response) => {
    if (response !== token) throw new Error("Ownership witness returned the wrong token");
    return response;
  });
}

function base(sequence: number) {
  return {
    version: 1 as const,
    runId: RUN_ID,
    sequence,
    at: `2026-08-28T12:00:0${sequence}.000Z`,
  };
}
