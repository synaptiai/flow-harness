import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../../src/domain/run/events.js";
import { JsonlRunStore, RunStoreError } from "../../../src/infrastructure/fs/jsonl-run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlRunStore", () => {
  it("durably appends and reads ordered events", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);
    const events = [runStarted(), nodeStarted()];

    for (const event of events) {
      await store.append(event);
    }

    await expect(store.read("run-1")).resolves.toEqual(events);
    const contents = await readFile(join(root, "run-1", "events.jsonl"), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trim().split("\n")).toHaveLength(2);
  });

  it("rejects an out-of-order append", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);

    await store.append(runStarted());

    await expect(store.append({ ...nodeStarted(), sequence: 3 })).rejects.toThrowError(
      /expected sequence 2/i,
    );
  });

  it("atomically grants a run id to only one store instance", async () => {
    const root = await createTemporaryDirectory();
    const firstStore = new JsonlRunStore(root);
    const secondStore = new JsonlRunStore(root);

    const results = await Promise.allSettled([
      firstStore.append(runStarted()),
      secondStore.append(runStarted()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(new JsonlRunStore(root).read("run-1")).resolves.toEqual([runStarted()]);
  });

  it("ignores only an invalid torn trailing record", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const store = new JsonlRunStore(root);
    await store.append(runStarted());
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify(runStarted())}\n{"version":1`,
    );

    await expect(store.read("run-1")).resolves.toEqual([runStarted()]);
  });

  it("treats a valid unterminated trailing record as uncommitted", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const store = new JsonlRunStore(root);
    await store.append(runStarted());
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify(runStarted())}\n${JSON.stringify(nodeStarted())}`,
    );

    await expect(store.read("run-1")).resolves.toEqual([runStarted()]);
  });

  it("repairs an ignored torn tail before the owner appends", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const store = new JsonlRunStore(root);
    await store.append(runStarted());
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify(runStarted())}\n{"version":1`,
    );

    await store.append(nodeStarted());

    await expect(store.read("run-1")).resolves.toEqual([runStarted(), nodeStarted()]);
  });

  it("fails closed on corruption before the trailing record", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const store = new JsonlRunStore(root);
    await store.append(runStarted());
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify(runStarted())}\nnot-json\n${JSON.stringify(nodeStarted())}\n`,
    );

    await expect(store.read("run-1")).rejects.toBeInstanceOf(RunStoreError);
  });

  it("rejects unsafe run identifiers before path resolution", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);

    await expect(store.read("../outside")).rejects.toThrowError(/invalid run id/i);
  });

  it("rejects an illegal transition before it reaches the ledger", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);
    await store.append(runStarted());

    await expect(
      store.append({
        ...base(2),
        type: "run_succeeded",
      }),
    ).rejects.toThrowError(/not every node succeeded/i);
    await expect(store.read("run-1")).resolves.toEqual([runStarted()]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-run-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runStarted(): RunEvent {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["node-version"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "c".repeat(64),
  };
}

function nodeStarted(): RunEvent {
  return {
    ...base(2),
    type: "node_started",
    nodeId: "node-version",
    attempt: 1,
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-06T15:00:0${sequence}.000Z`,
    runId: "run-1",
    workflowId: "verify-foundation",
  };
}
