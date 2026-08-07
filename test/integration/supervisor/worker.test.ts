import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { createProductionNodeEffectReconciler } from "../../../src/infrastructure/runtime/production-effect-reconciler.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
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
      effectReconciler: createProductionNodeEffectReconciler(),
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

  it("preserves an uncertain resumed run after durably reconciling its open edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-reconcile-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const target = join(directory, "source.ts");
    await writeFile(target, "after\n", { mode: 0o640 });
    await chmod(target, 0o640);
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const source = recoveryWorkflowSource();
    const compiled = compileWorkflowText(source);
    const runId = "worker-reconcile";
    const runStore = new JsonlRunStore(runsDirectory);
    await runStore.append({
      ...runEventBase(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: directory,
    });
    await runStore.append({
      ...runEventBase(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    });
    await runStore.append({
      ...runEventBase(compiled.id, runId, 3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target,
        operationDigest: "b".repeat(64),
        beforeSha256: sha256("before\n"),
        afterSha256: sha256("after\n"),
        mode: 0o640,
      },
    });
    await runStore.release(runId);

    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId,
      mode: "resume",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: source,
      cwd: directory,
      token: "c".repeat(64),
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
    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
        async execute() {
          throw new Error("an uncertain resume must not execute a node");
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4322,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { status: "running", runId },
    });

    await expect(worker).resolves.toBe(1);
    const events = await new JsonlRunStore(runsDirectory).read(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_reconciled",
    ]);
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "running",
      recoveryErrorCode: "uncertain_operation",
      exitCode: 1,
    });
    await expect(store.readActiveRunClaim(runId)).resolves.toBeNull();
  });

  it("completes an opted-in proof-safe retry as fresh attempt two", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-retry-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const source = proofSafeRetryWorkflowSource();
    const compiled = compileWorkflowText(source);
    const runId = "worker-proof-safe-retry";
    const runStore = new JsonlRunStore(runsDirectory);
    await runStore.append({
      ...runEventBase(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: directory,
      recoveryRequirements: [
        {
          nodeId: "implement",
          mode: "fresh",
          maxAttempts: 2,
          effectProtocol: "none",
        },
      ],
    });
    await runStore.append({
      ...runEventBase(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
    });
    await runStore.release(runId);
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId,
      mode: "resume",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: source,
      cwd: directory,
      token: "d".repeat(64),
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
    const calls: Array<{ nodeId: string; attempt: number }> = [];
    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
        async execute(node, context) {
          calls.push({ nodeId: node.id, attempt: context.attempt });
          return node.type === "agent"
            ? {
                status: "succeeded",
                evidence: {
                  kind: "agent",
                  provider: "test",
                  model: "deterministic",
                  text: "analysis",
                  textHash: sha256("analysis"),
                  textTruncated: false,
                  durationMs: 1,
                  policyDecisions: [],
                  effectReceipts: [],
                },
              }
            : {
                status: "succeeded",
                evidence: successfulCommandEvidence(node.id),
              };
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4323,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { status: "running", runId },
    });

    await expect(worker).resolves.toBe(0);
    expect(calls).toEqual([
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    const events = await new JsonlRunStore(runsDirectory).read(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_attempt_interrupted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
    await expect(store.readActiveRunClaim(runId)).resolves.toBeNull();
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

function recoveryWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-reconciliation }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
}

function proofSafeRetryWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-proof-safe-retry }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: test, id: deterministic }
      tools: [read]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
}

function successfulCommandEvidence(nodeId: string) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [nodeId],
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    stdoutHash: sha256("ok"),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function runEventBase(workflowId: string, runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId,
    workflowId,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
