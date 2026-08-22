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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelRequestIdentity,
  ModelSessionEventInput,
  ModelSessionIdentity,
} from "../../../src/domain/run/model-session.js";
import { JsonlModelSessionStore } from "../../../src/infrastructure/fs/jsonl-model-session-store.js";

const temporaryDirectories: string[] = [];
const identity: ModelSessionIdentity = {
  runId: "run-1",
  workflowId: "workflow-1",
  nodeId: "analyze",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlModelSessionStore", () => {
  it("durably creates and appends a private session record", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, identity.runId), { mode: 0o700 });
    const store = new JsonlModelSessionStore(root);

    await store.create(identity, at(0));
    await store.append(identity, { type: "attempt_started", attempt: 1 }, at(1));
    await store.append(identity, primaryPrompt(), at(2));

    const state = await store.read(identity);
    const path = store.recordPath(identity);
    expect(state.events.map((event) => event.type)).toEqual([
      "session_created",
      "attempt_started",
      "user_message_committed",
    ]);
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("serializes concurrent appends from one owner", async () => {
    const store = await createStore();

    await Promise.all([
      store.append(identity, { type: "attempt_started", attempt: 1 }, at(1)),
      store.append(identity, primaryPrompt(), at(2)),
    ]);

    await expect(store.read(identity)).resolves.toMatchObject({
      eventCount: 3,
      primaryPromptCommitted: true,
    });
  });

  it("grants live ownership to only one store instance", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, identity.runId), { mode: 0o700 });
    const first = new JsonlModelSessionStore(root);
    const second = new JsonlModelSessionStore(root);
    await first.create(identity, at(0));

    await expect(second.claim(identity)).rejects.toMatchObject({ code: "not_owner" });
    await first.release(identity);
    await expect(second.claim(identity)).resolves.toMatchObject({ eventCount: 1 });
  });

  it("ignores and repairs only an unterminated final record", async () => {
    const store = await createStore();
    await store.append(identity, { type: "attempt_started", attempt: 1 }, at(1));
    await store.release(identity);
    await appendFile(store.recordPath(identity), '{"version":1', "utf8");

    const recovered = new JsonlModelSessionStore(store.rootDirectory);
    await expect(recovered.claim(identity)).resolves.toMatchObject({ eventCount: 2 });
    await recovered.append(identity, primaryPrompt(), at(2));

    const contents = await readFile(recovered.recordPath(identity), "utf8");
    expect(contents).not.toContain('{"version":1{"');
    await expect(recovered.read(identity)).resolves.toMatchObject({ eventCount: 3 });
  });

  it("rejects corruption in the committed prefix", async () => {
    const store = await createStore();
    await store.release(identity);
    await appendFile(store.recordPath(identity), "not-json\n", "utf8");

    await expect(
      new JsonlModelSessionStore(store.rootDirectory).claim(identity),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects symbolic record directories and multiply linked record files", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, identity.runId);
    const outside = await createTemporaryDirectory();
    await mkdir(runDirectory, { mode: 0o700 });
    await symlink(outside, join(runDirectory, "model-sessions"));

    await expect(new JsonlModelSessionStore(root).create(identity, at(0))).rejects.toMatchObject({
      code: "unsafe_path",
    });

    await rm(join(runDirectory, "model-sessions"));
    const store = new JsonlModelSessionStore(root);
    await store.create(identity, at(0));
    await store.release(identity);
    await link(store.recordPath(identity), join(outside, "linked-events.jsonl"));
    await expect(new JsonlModelSessionStore(root).claim(identity)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects a symbolic ownership directory before reading its metadata", async () => {
    const store = await createStore();
    const outside = await createTemporaryDirectory();
    await store.release(identity);
    await symlink(outside, join(dirname(store.recordPath(identity)), ".owner"));

    await expect(
      new JsonlModelSessionStore(store.rootDirectory).claim(identity),
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects unsafe run ids and unsafe record permissions", async () => {
    const store = await createStore();
    await expect(store.read({ ...identity, runId: "../outside" })).rejects.toMatchObject({
      code: "invalid_identity",
    });
    await store.release(identity);
    await chmod(store.recordPath(identity), 0o644);

    await expect(
      new JsonlModelSessionStore(store.rootDirectory).claim(identity),
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("enforces configured event, record, and count limits before append", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, identity.runId), { mode: 0o700 });
    const eventLimited = new JsonlModelSessionStore(root, { maxEventBytes: 10_000 });
    await eventLimited.create(identity, at(0));
    await eventLimited.append(identity, { type: "attempt_started", attempt: 1 }, at(1));
    await expect(
      eventLimited.append(identity, { ...primaryPrompt(), text: "x".repeat(20_000) }, at(2)),
    ).rejects.toMatchObject({ code: "limit" });

    const countIdentity = { ...identity, nodeId: "count" };
    const countLimited = new JsonlModelSessionStore(root, { maxEvents: 2 });
    await countLimited.create(countIdentity, at(0));
    await countLimited.append(countIdentity, { type: "attempt_started", attempt: 1 }, at(1));
    await expect(countLimited.append(countIdentity, primaryPrompt(), at(2))).rejects.toMatchObject({
      code: "limit",
    });

    const recordIdentity = { ...identity, nodeId: "record" };
    const recordLimited = new JsonlModelSessionStore(root, { maxRecordBytes: 4_000 });
    await recordLimited.create(recordIdentity, at(0));
    await recordLimited.append(recordIdentity, { type: "attempt_started", attempt: 1 }, at(1));
    await expect(
      recordLimited.append(recordIdentity, { ...primaryPrompt(), text: "x".repeat(4_000) }, at(2)),
    ).rejects.toMatchObject({ code: "limit" });
  });

  it("honors cancellation before creating durable state", async () => {
    const root = await createTemporaryDirectory();
    await mkdir(join(root, identity.runId), { mode: 0o700 });
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));
    const store = new JsonlModelSessionStore(root);

    await expect(store.create(identity, at(0), controller.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(lstat(store.recordPath(identity))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores complete request events without provider-native private state", async () => {
    const store = await createStore();
    await store.append(identity, { type: "attempt_started", attempt: 1 }, at(1));
    await store.append(identity, primaryPrompt(), at(2));
    await store.append(
      identity,
      {
        type: "model_request_prepared",
        attempt: 1,
        turn: 1,
        request: 1,
        identity: requestIdentity(),
      },
      at(3),
    );

    const contents = await readFile(store.recordPath(identity), "utf8");
    expect(contents).not.toContain("responseId");
    expect(contents).not.toContain("thoughtSignature");
    expect(contents).not.toContain("credential");
  });
});

async function createStore(): Promise<JsonlModelSessionStore> {
  const root = await createTemporaryDirectory();
  await mkdir(join(root, identity.runId), { mode: 0o700 });
  const store = new JsonlModelSessionStore(root);
  await store.create(identity, at(0));
  return store;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-model-session-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function primaryPrompt(): Extract<
  ModelSessionEventInput,
  { readonly type: "user_message_committed" }
> {
  return {
    type: "user_message_committed",
    attempt: 1,
    origin: "primary_prompt",
    text: "Inspect the project.",
  };
}

function requestIdentity(): ModelRequestIdentity {
  return {
    version: 1,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiAdapter: "messages-v1",
    thinking: "medium",
    runtimeVersion: "pi-0.84.0",
    system: { sha256: "1".repeat(64), bytes: 100 },
    toolCatalog: { sha256: "2".repeat(64), bytes: 200, count: 2 },
    authority: { sha256: "3".repeat(64) },
    portableHistory: { sha256: "4".repeat(64), eventCount: 1, bytes: 80 },
    runtimeSurface: { sha256: "5".repeat(64), bytes: 380 },
    attempt: 1,
    turn: 1,
    request: 1,
  };
}

function at(sequence: number): string {
  return `2026-08-22T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}
