import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { executeWorkerJob, requestWorker } from "../../../src/supervisor/worker.js";
import { createActiveRunClaim, createJobRecord } from "../../../src/supervisor/records.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("detached run worker", () => {
  it("authenticates control, preserves cancellation evidence, and releases its claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-run",
      mode: "run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: workflowSource(),
      cwd: directory,
      token: "a".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    let markExecutionStarted: (() => void) | undefined;
    let executionHasStarted = false;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executor: NodeExecutor = {
      async execute(node, context) {
        executionHasStarted = true;
        markExecutionStarted?.();
        return await new Promise((resolve) => {
          context.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "failed",
                error: {
                  code: "command_aborted",
                  message: "command was cancelled",
                  retryable: false,
                  sideEffectStatus: "uncertain",
                },
                evidence: {
                  kind: "command",
                  executable: node.type === "command" ? node.command.executable : "unexpected",
                  args: [],
                  exitCode: null,
                  signal: "SIGTERM",
                  stdout: "partial output",
                  stderr: "",
                  stdoutHash: createHash("sha256").update("partial output").digest("hex"),
                  stderrHash: createHash("sha256").update("").digest("hex"),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  timedOut: false,
                  durationMs: 10,
                },
              }),
            { once: true },
          );
        });
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4321,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    expect(executionHasStarted).toBe(false);

    const identity = await requestWorker(descriptor, { type: "identify" });
    expect(identity).toMatchObject({
      ok: true,
      result: {
        type: "identity",
        workerId: job.workerId,
        runId: job.runId,
        pid: 4321,
        jobDigest: job.digest,
        status: "running",
      },
    });
    await executionStarted;

    await expect(
      requestWorker({ ...descriptor, token: "b".repeat(64) }, { type: "identify" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });

    const commandId = randomUUID();
    const cancellation = await requestWorker(descriptor, {
      type: "cancel",
      commandId,
      actor: "operator:test",
      reason: "Stop the test run.",
    });
    const workerExitCode = await worker;
    expect(cancellation, JSON.stringify(cancellation)).toMatchObject({
      ok: true,
      result: {
        type: "cancelled",
        commandId,
        runId: job.runId,
        runStatus: "cancelled",
      },
    });

    expect(workerExitCode).toBe(1);
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_cancelled",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_cancelled",
      actor: "operator:test",
      requestId: commandId,
      cancelledNodeId: "execute",
    });
    await expect(store.readActiveRunClaim(job.runId)).resolves.toBeNull();
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "cancelled",
      exitCode: 1,
    });
  });
});

async function waitForDescriptor(store: LocalSupervisorStore, workerId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await store.readWorkerDescriptor(workerId);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "not_found")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for worker descriptor");
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-test }
nodes:
  - id: execute
    type: command
    command:
      executable: node
      args: [--version]
      timeoutMs: 10000
`;
}
