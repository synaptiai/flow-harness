import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createPromptActivationSnapshot,
  MAX_PROMPT_ACTIVATION_SOURCE_BYTES,
} from "../../../src/domain/adaptation/prompt-activation.js";
import {
  calculateCapabilitySnapshotDigest,
  MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { MAX_RUN_EVENT_BYTES, type RunEvent } from "../../../src/domain/run/events.js";
import { JsonlRunStore, RunStoreError } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlRunStore", () => {
  it("reserves the documented envelope for a complete activation snapshot", () => {
    expect(MAX_RUN_EVENT_BYTES).toBe(20 * 1024 * 1024);
  });

  it("persists a maximum-source activation inside the production event envelope", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);
    const activation = createPromptActivationSnapshot(
      promptActivationInput({ sourceBytes: MAX_PROMPT_ACTIVATION_SOURCE_BYTES }),
    );
    const packages: never[] = [];
    const activations = [activation];
    const capabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      activations,
      digest: calculateCapabilitySnapshotDigest(packages, activations),
    });
    const event: RunEvent = {
      ...runStarted(),
      workflowId: activation.workflowId,
      workflowDigest: activation.candidate.projectedWorkflow.workflowDigest,
      capabilitySnapshot,
    };
    const capabilityBytes = Buffer.byteLength(JSON.stringify(capabilitySnapshot), "utf8");
    const eventBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");

    expect(capabilityBytes).toBeLessThanOrEqual(MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES);
    expect(eventBytes).toBeLessThanOrEqual(MAX_RUN_EVENT_BYTES);
    await store.append(event);
    await expect(store.read("run-1")).resolves.toEqual([event]);
  });

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

  it("creates and uses an arbitrarily deep runs directory", async () => {
    const temporaryRoot = await createTemporaryDirectory();
    const root = join(temporaryRoot, "one", "two", "three", "four", "five", "runs");
    const store = new JsonlRunStore(root);

    await store.append(runStarted());
    await store.append(nodeStarted());

    await expect(store.read("run-1")).resolves.toEqual([runStarted(), nodeStarted()]);
  });

  it("rejects an out-of-order append", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);

    await store.append(runStarted());

    await expect(store.append({ ...nodeStarted(), sequence: 3 })).rejects.toThrowError(
      /expected sequence 2/i,
    );
  });

  it("rejects oversized event records before claiming a run", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root, 64);

    await expect(store.append(runStarted())).rejects.toMatchObject({ code: "limit" });
    await expect(store.read("run-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("persists worst-case JSON escaping within production evidence bounds", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);
    const output = "\0".repeat(32_768);
    const argument = "\0".repeat(4_096);
    await store.append(runStarted());
    await store.append(nodeStarted());
    await store.append({
      ...base(3),
      type: "node_succeeded",
      nodeId: "node-version",
      attempt: 1,
      evidence: {
        kind: "command",
        executable: "node",
        args: Array.from({ length: 16 }, () => argument),
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: output,
        stdoutHash: sha256(output),
        stderrHash: sha256(output),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
        sandbox: {
          backend: "anthropic-sandbox-runtime",
          backendVersion: "0.0.70",
          profile: "workspace-write-network-deny-v1",
          policyDigest: "d".repeat(64),
        },
      },
    });
    await store.append({ ...base(4), type: "run_succeeded" });

    const events = await store.read("run-1");
    expect(events.at(-1)?.type).toBe("run_succeeded");
    expect(events[2]).toMatchObject({
      evidence: {
        sandbox: {
          backend: "anthropic-sandbox-runtime",
          backendVersion: "0.0.70",
          profile: "workspace-write-network-deny-v1",
          policyDigest: "d".repeat(64),
        },
      },
    });
  });

  it("persists maximum escaped agent policy and effect evidence within the ledger ceiling", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlRunStore(root);
    const operationDigest = "a".repeat(64);
    const target = "\0".repeat(1_024);
    const policy = new PolicyBroker(
      {
        runId: "run-1",
        workflowId: "verify-foundation",
        nodeId: "node-version",
        attempt: 1,
      },
      ["filesystem.write"],
    );
    for (let index = 0; index < 64; index += 1) {
      policy.authorize({
        action: "filesystem.write",
        target,
        boundary: "inside",
        operationDigest,
      });
    }
    const effectReceipts = Array.from({ length: 32 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      runId: "run-1",
      workflowId: "verify-foundation",
      nodeId: "node-version",
      attempt: 1,
      kind: "filesystem.edit" as const,
      target,
      operationDigest,
      beforeSha256: "b".repeat(64),
      afterSha256: "c".repeat(64),
      outcome: "committed" as const,
    }));
    const event: RunEvent = {
      ...base(3),
      type: "node_failed",
      nodeId: "node-version",
      attempt: 1,
      error: {
        code: "pi_agent_failed",
        message: "\0".repeat(16_384),
        retryable: false,
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        provider: "test",
        model: "test",
        text: "\0".repeat(65_536),
        textHash: sha256("\0".repeat(65_536)),
        textTruncated: false,
        durationMs: 1,
        policyDecisions: policy.close(),
        effectReceipts,
      },
    };
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
    expect(serializedBytes).toBeGreaterThan(1_048_576);
    expect(serializedBytes).toBeLessThanOrEqual(MAX_RUN_EVENT_BYTES);

    await store.append(runStarted());
    await store.append(nodeStarted());
    await store.append(event);

    await expect(store.read("run-1")).resolves.toHaveLength(3);
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
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "run_exists" },
    });
    await expect(new JsonlRunStore(root).read("run-1")).resolves.toEqual([runStarted()]);
  });

  it("claims an existing run before appending from a new store instance", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");

    const recovered = new JsonlRunStore(root);
    await expect(recovered.claim("run-1")).resolves.toEqual([runStarted()]);
    await recovered.append(nodeStarted());

    await expect(recovered.read("run-1")).resolves.toEqual([runStarted(), nodeStarted()]);
  });

  it("refuses to claim a run owned by a live process", async () => {
    const root = await createTemporaryDirectory();
    const owner = new JsonlRunStore(root);
    await owner.append(runStarted());

    await expect(new JsonlRunStore(root).claim("run-1")).rejects.toMatchObject({
      code: "not_owner",
    });
    await expect(new JsonlRunStore(root).claim("run-1")).rejects.toThrowError(
      new RegExp(`process ${process.pid}`),
    );
  });

  it("atomically grants recovery ownership to only one claimant", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");
    const first = new JsonlRunStore(root);
    const second = new JsonlRunStore(root);

    const results = await Promise.allSettled([first.claim("run-1"), second.claim("run-1")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("reclaims recovery ownership left by an exited process", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");
    const exitedProcess = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const exitedPid = exitedProcess.pid;
    if (exitedPid === undefined) {
      throw new Error("test child process did not receive a process id");
    }
    await once(exitedProcess, "exit");
    await writeOwner(root, exitedPid);

    const recovered = new JsonlRunStore(root);
    await expect(recovered.claim("run-1")).resolves.toEqual([runStarted()]);
  });

  it("fails closed when ownership metadata is corrupt", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");
    const ownerPath = join(root, "run-1", ".owner", "owner.json");
    await mkdir(join(root, "run-1", ".owner"));
    await writeFile(ownerPath, "not-json\n", { mode: 0o600 });

    await expect(new JsonlRunStore(root).claim("run-1")).rejects.toMatchObject({
      code: "corrupt",
    });
    await expect(readFile(ownerPath, "utf8")).resolves.toBe("not-json\n");
  });

  it("fails closed when an ownership directory has no metadata", async () => {
    const root = await createTemporaryDirectory();
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");
    await mkdir(join(root, "run-1", ".owner"));

    await expect(new JsonlRunStore(root).claim("run-1")).rejects.toMatchObject({
      code: "corrupt",
    });
    await expect(access(join(root, "run-1", ".owner"))).resolves.toBeUndefined();
  });

  it("refuses a missing run without creating recovery state", async () => {
    const root = await createTemporaryDirectory();

    await expect(new JsonlRunStore(root).claim("missing-run")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(access(join(root, "missing-run"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("repairs a torn tail before a recovered claimant appends", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const original = new JsonlRunStore(root);
    await original.append(runStarted());
    await original.release("run-1");
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify(runStarted())}\n${JSON.stringify(nodeStarted())}`,
    );

    const recovered = new JsonlRunStore(root);
    await expect(recovered.claim("run-1")).resolves.toEqual([runStarted()]);
    await recovered.append(nodeStarted());

    await expect(recovered.read("run-1")).resolves.toEqual([runStarted(), nodeStarted()]);
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

  it("rejects a ledger whose durable run id does not match its directory", async () => {
    const root = await createTemporaryDirectory();
    const runDirectory = join(root, "run-1");
    const store = new JsonlRunStore(root);
    await store.append(runStarted());
    await store.release("run-1");
    await writeFile(
      join(runDirectory, "events.jsonl"),
      `${JSON.stringify({ ...runStarted(), runId: "different-run" })}\n`,
    );

    await expect(store.read("run-1")).rejects.toMatchObject({ code: "corrupt" });
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

async function writeOwner(root: string, pid: number): Promise<void> {
  const ownerDirectory = join(root, "run-1", ".owner");
  await mkdir(ownerDirectory);
  await writeFile(
    join(ownerDirectory, "owner.json"),
    `${JSON.stringify({
      version: 1,
      pid,
      token: "00000000-0000-4000-8000-000000000000",
      acquiredAt: "2026-08-06T15:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

function runStarted(): Extract<RunEvent, { readonly type: "run_started" }> {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
