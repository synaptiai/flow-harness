import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalAcpSessionStore,
  LocalAcpSessionStoreError,
} from "../../../../src/infrastructure/fs/local-acp-session-store.js";

const SESSION_ONE = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO = "22222222-2222-4222-8222-222222222222";
const POLICY_ONE = "1".repeat(64);
const POLICY_TWO = "2".repeat(64);
const PROJECT = "/workspace/project";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local ACP session store", () => {
  it("publishes immutable sessions and lists them through a bounded restart cursor", async () => {
    const root = await temporaryRoot();
    const store = new LocalAcpSessionStore(root);
    await store.create(sessionInput(SESSION_TWO, "2026-08-17T12:00:01.000Z"));
    await store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"));

    const restarted = new LocalAcpSessionStore(root);
    await expect(
      restarted.read(SESSION_ONE, { projectRoot: PROJECT, policyDigest: POLICY_ONE }),
    ).resolves.toMatchObject({
      apiVersion: "flow.acp.session/v1",
      sessionId: SESSION_ONE,
      runId: SESSION_ONE,
      projectRoot: PROJECT,
      policyDigest: POLICY_ONE,
      actor: "editor:test",
      createdAt: "2026-08-17T12:00:00.000Z",
      descriptorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const first = await restarted.list({
      projectRoot: PROJECT,
      policyDigest: POLICY_ONE,
      limit: 1,
    });
    expect(first.sessions.map(({ sessionId }) => sessionId)).toEqual([SESSION_ONE]);
    expect(first.cursor).toBe(SESSION_ONE);
    await expect(
      restarted.list({
        projectRoot: PROJECT,
        policyDigest: POLICY_ONE,
        limit: 1,
        ...(first.cursor === undefined ? {} : { after: first.cursor }),
      }),
    ).resolves.toMatchObject({
      sessions: [{ sessionId: SESSION_TWO }],
      cursor: undefined,
    });
  });

  it("makes exact concurrent publication idempotent without overwriting identity", async () => {
    const root = await temporaryRoot();
    const first = new LocalAcpSessionStore(root);
    const second = new LocalAcpSessionStore(root);
    const input = sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z");

    const results = await Promise.all([first.create(input), second.create(input)]);

    expect(results[0]).toEqual(results[1]);
    await expect(first.create({ ...input, actor: "editor:other" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      first.read(SESSION_ONE, { projectRoot: PROJECT, policyDigest: POLICY_ONE }),
    ).resolves.toMatchObject({ actor: "editor:test" });
  });

  it.each([
    [
      "project",
      { projectRoot: "/workspace/foreign", policyDigest: POLICY_ONE },
      "project_mismatch",
    ],
    ["policy", { projectRoot: PROJECT, policyDigest: POLICY_TWO }, "policy_mismatch"],
  ] as const)(
    "rejects a foreign %s before returning session state",
    async (_name, expected, code) => {
      const root = await temporaryRoot();
      const store = new LocalAcpSessionStore(root);
      await store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"));

      await expect(store.read(SESSION_ONE, expected)).rejects.toMatchObject({ code });
      await expect(store.list({ ...expected, limit: 16 })).rejects.toMatchObject({ code });
    },
  );

  it("stops before publication when cancellation wins the commit boundary", async () => {
    const root = await temporaryRoot();
    const cancellation = new Error("PRIVATE_CANCEL");
    const controller = new AbortController();
    const store = new LocalAcpSessionStore(root, {
      beforePublish: () => controller.abort(cancellation),
    });

    await expect(
      store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"), {
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);
    await expect(
      new LocalAcpSessionStore(root).read(SESSION_ONE, {
        projectRoot: PROJECT,
        policyDigest: POLICY_ONE,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets a durable publication win cancellation that arrives after commit", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const store = new LocalAcpSessionStore(root, {
      afterPublish: () => controller.abort(new Error("PRIVATE_LATE_CANCEL")),
    });

    await expect(
      store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"), {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ sessionId: SESSION_ONE });
    await expect(
      new LocalAcpSessionStore(root).read(SESSION_ONE, {
        projectRoot: PROJECT,
        policyDigest: POLICY_ONE,
      }),
    ).resolves.toMatchObject({ sessionId: SESSION_ONE });
  });

  it("rejects symlink, oversized, redigested, and unknown session records with fixed errors", async () => {
    const root = await temporaryRoot();
    const store = new LocalAcpSessionStore(root);
    const record = await store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"));
    const sessions = join(root, ".acp-sessions");
    const recordPath = join(sessions, `${SESSION_ONE}.json`);
    const privatePath = join(root, "PRIVATE_RECORD.json");
    const original = await readFile(recordPath, "utf8");

    await rm(recordPath);
    await symlink(privatePath, recordPath);
    await writeFile(privatePath, original, "utf8");
    await expect(
      store.read(SESSION_ONE, { projectRoot: PROJECT, policyDigest: POLICY_ONE }),
    ).rejects.toMatchObject({ code: "invalid_session" });

    await rm(recordPath);
    await writeFile(recordPath, "x".repeat(16_385), "utf8");
    await expect(
      store.read(SESSION_ONE, { projectRoot: PROJECT, policyDigest: POLICY_ONE }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    await writeFile(recordPath, JSON.stringify({ ...record, actor: "PRIVATE_FORGED" }), "utf8");
    const error = await store
      .read(SESSION_ONE, { projectRoot: PROJECT, policyDigest: POLICY_ONE })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalAcpSessionStoreError);
    expect(error).toMatchObject({ code: "invalid_session" });
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain("PRIVATE_");
  });

  it("bounds directory enumeration including ignored temporary entries", async () => {
    const root = await temporaryRoot();
    const sessions = join(root, ".acp-sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await Promise.all(
      [".pending-one", ".pending-two", ".pending-three"].map((name) =>
        writeFile(join(sessions, name), "PRIVATE_PENDING", "utf8"),
      ),
    );
    const store = new LocalAcpSessionStore(root, { maxEntries: 2 });

    await expect(
      store.list({ projectRoot: PROJECT, policyDigest: POLICY_ONE, limit: 2 }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects session publication after the exact store-entry bound", async () => {
    const root = await temporaryRoot();
    const store = new LocalAcpSessionStore(root, { maxEntries: 2 });
    await store.create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"));
    await store.create(sessionInput(SESSION_TWO, "2026-08-17T12:00:01.000Z"));

    await expect(
      store.create(
        sessionInput("33333333-3333-4333-8333-333333333333", "2026-08-17T12:00:02.000Z"),
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      store.list({ projectRoot: PROJECT, policyDigest: POLICY_ONE, limit: 2 }),
    ).resolves.toMatchObject({
      sessions: [{ sessionId: SESSION_ONE }, { sessionId: SESSION_TWO }],
    });
  });

  it("does not let a later publication bypass an aborted queued turn", async () => {
    const root = await temporaryRoot();
    const firstAtPublish = deferred();
    const releaseFirst = deferred();
    const first = new LocalAcpSessionStore(root, {
      maxEntries: 3,
      beforePublish: async () => {
        firstAtPublish.resolve();
        await releaseFirst.promise;
      },
    }).create(sessionInput(SESSION_ONE, "2026-08-17T12:00:00.000Z"));
    await firstAtPublish.promise;

    const cancellation = new Error("PRIVATE_QUEUED_CANCEL");
    const controller = new AbortController();
    const secondQueued = deferred();
    const queued = new LocalAcpSessionStore(root, {
      maxEntries: 3,
      afterCreationQueued: () => secondQueued.resolve(),
    }).create(sessionInput(SESSION_TWO, "2026-08-17T12:00:01.000Z"), { signal: controller.signal });
    await secondQueued.promise;
    controller.abort(cancellation);
    await expect(queued).rejects.toBe(cancellation);

    const thirdAtPublish = deferred();
    const third = new LocalAcpSessionStore(root, {
      maxEntries: 3,
      beforePublish: () => thirdAtPublish.resolve(),
    }).create(sessionInput("33333333-3333-4333-8333-333333333333", "2026-08-17T12:00:02.000Z"));
    await expect(
      Promise.race([thirdAtPublish.promise.then(() => "started"), delay(20).then(() => "blocked")]),
    ).resolves.toBe("blocked");

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ sessionId: SESSION_ONE });
    await expect(third).resolves.toMatchObject({
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
  });
});

function sessionInput(sessionId: string, createdAt: string) {
  return {
    sessionId,
    projectRoot: PROJECT,
    policyDigest: POLICY_ONE,
    actor: "editor:test",
    createdAt,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `flow-acp-session-${crypto.randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
