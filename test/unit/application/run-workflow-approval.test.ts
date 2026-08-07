import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type {
  CommandApprovalGrantedEvent,
  CommandApprovalRequestedEvent,
  RunEvent,
} from "../../../src/domain/run/events.js";
import {
  calculateCommandApprovalOperationDigest,
  createCommandApprovalOperation,
} from "../../../src/domain/approval/command-approval.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("approval-gated workflow execution", () => {
  it("persists an exact approval request and releases ownership before execution", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const state = await runWorkflow(approvalWorkflow(), {
      ...options(store, recordingExecutor(calls)),
      cwd: "/workspace/nested/..",
      runId: "run-approval-wait",
    });

    expect(calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);
    expect(store.releaseCalls).toEqual(["run-approval-wait"]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      executionCwd: "/workspace",
      approvalRequirements: [{ nodeId: "verify", grantTtlMs: 60000 }],
    });
    expect(store.events[1]).toMatchObject({
      type: "command_approval_requested",
      requestId: "approval-2",
      nodeId: "verify",
      attempt: 1,
      grantTtlMs: 60000,
      operation: {
        action: "process.execute",
        cwd: "/workspace",
        executable: "node",
        args: ["--version"],
        timeoutMs: 10000,
      },
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(state).toMatchObject({
      status: "waiting_for_approval",
      nodes: { verify: { status: "pending", approval: { requestId: "approval-2" } } },
    });
  });

  it("keeps a pending request durable across a no-op resume", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-pending-resume");

    const state = await resumeWorkflow(approvalWorkflow(), {
      ...options(store, recordingExecutor(calls)),
      runId: "run-pending-resume",
    });

    expect(calls).toEqual([]);
    expect(state.status).toBe("waiting_for_approval");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "run_resumed",
    ]);
  });

  it("starts an approved command exactly once on recovery", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-approved-resume");
    await store.append(grantFor(store.events, 3, "2026-08-07T15:01:01.000Z"));
    await store.release("run-approved-resume");

    const state = await resumeWorkflow(approvalWorkflow(), {
      ...options(store, recordingExecutor(calls)),
      runId: "run-approved-resume",
      now: () => new Date("2026-08-07T15:00:02.000Z"),
    });

    expect(calls).toEqual(["verify"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_granted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(store.events[4]).toMatchObject({
      type: "node_started",
      approval: {
        requestId: "approval-2",
        operationDigest: requestFrom(store.events).operationDigest,
      },
    });
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: { verify: { approval: { status: "consumed" } } },
    });
  });

  it("renews an expired grant without invoking the executor", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-expired-grant", 1000);
    await store.append(grantFor(store.events, 3, "2026-08-07T15:00:02.000Z"));
    await store.release("run-expired-grant");

    const state = await resumeWorkflow(approvalWorkflow(1000), {
      ...options(store, recordingExecutor(calls)),
      runId: "run-expired-grant",
      now: () => new Date("2026-08-07T15:00:02.000Z"),
    });

    expect(calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_granted",
      "run_resumed",
      "command_approval_expired",
      "command_approval_requested",
    ]);
    expect(state).toMatchObject({
      status: "waiting_for_approval",
      nodes: {
        verify: { approval: { status: "pending", requestId: "approval-6" } },
      },
    });
  });

  it("refuses recovery under a different execution directory", async () => {
    const store = await waitingStore("run-cwd-mismatch");

    await expect(
      resumeWorkflow(approvalWorkflow(), {
        ...options(store, recordingExecutor([])),
        cwd: "/different-workspace",
        runId: "run-cwd-mismatch",
      }),
    ).rejects.toMatchObject({ code: "execution_context_mismatch" });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);
  });

  it("refuses a self-consistent pending request for a different command", async () => {
    const store = await waitingStore("run-operation-mismatch");
    const request = requestFrom(store.events);
    const tamperedOperation = { ...request.operation, executable: "npm" };
    const tamperedDigest = createHash("sha256")
      .update(JSON.stringify(tamperedOperation))
      .digest("hex");
    store.events[1] = {
      ...request,
      operation: tamperedOperation,
      operationDigest: tamperedDigest,
    };

    await expect(
      resumeWorkflow(approvalWorkflow(), {
        ...options(store, recordingExecutor([])),
        runId: "run-operation-mismatch",
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);
  });

  it("refuses recovery when the approval declaration changes", async () => {
    const store = await waitingStore("run-approval-mismatch");

    await expect(
      resumeWorkflow(approvalWorkflow(120000), {
        ...options(store, recordingExecutor([])),
        runId: "run-approval-mismatch",
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);
  });

  it("refuses an approval request whose dependencies were not completed", async () => {
    const workflow = dependentApprovalWorkflow();
    const later = workflow.nodes[1];
    if (later?.type !== "command") {
      throw new Error("expected a command node");
    }
    const operation = createCommandApprovalOperation(later, "/workspace");
    const store = new MemoryRecoverableRunStore();
    store.events.push(
      {
        version: 1,
        sequence: 1,
        at: "2026-08-07T15:00:01.000Z",
        runId: "run-premature-approval",
        workflowId: workflow.id,
        type: "run_started",
        nodeIds: workflow.nodes.map((node) => node.id),
        workflowApiVersion: workflow.apiVersion,
        workflowDigest: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
        executionCwd: "/workspace",
        approvalRequirements: [{ nodeId: "later", grantTtlMs: 60000 }],
      },
      {
        version: 1,
        sequence: 2,
        at: "2026-08-07T15:00:02.000Z",
        runId: "run-premature-approval",
        workflowId: workflow.id,
        type: "command_approval_requested",
        nodeId: "later",
        attempt: 1,
        requestId: "approval-2",
        grantTtlMs: 60000,
        operation,
        operationDigest: calculateCommandApprovalOperationDigest(operation),
      },
    );

    await expect(
      resumeWorkflow(workflow, {
        ...options(store, recordingExecutor([])),
        runId: "run-premature-approval",
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);
  });
});

class MemoryRecoverableRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];
  readonly claimCalls: string[] = [];
  readonly releaseCalls: string[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    this.claimCalls.push(runId);
    return structuredClone(this.events);
  }

  async release(runId: string): Promise<void> {
    this.releaseCalls.push(runId);
  }
}

async function waitingStore(runId: string, grantTtlMs = 60000) {
  const store = new MemoryRecoverableRunStore();
  await runWorkflow(approvalWorkflow(grantTtlMs), {
    ...options(store, recordingExecutor([])),
    runId,
  });
  return store;
}

function options(store: MemoryRecoverableRunStore, executor: NodeExecutor) {
  return {
    cwd: "/workspace",
    protectedPaths: [] as const,
    store,
    executor,
    now: () => new Date("2026-08-07T15:00:01.000Z"),
  };
}

function recordingExecutor(calls: string[]): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      calls.push(node.id);
      return {
        status: "succeeded",
        evidence: {
          kind: "command",
          executable: "node",
          args: ["--version"],
          exitCode: 0,
          signal: null,
          stdout: "v22.19.0\n",
          stderr: "",
          stdoutHash: createHash("sha256").update("v22.19.0\n").digest("hex"),
          stderrHash: createHash("sha256").update("").digest("hex"),
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          durationMs: 1,
        },
      };
    },
  };
}

function approvalWorkflow(grantTtlMs = 60000) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-workflow }
nodes:
  - id: verify
    type: command
    approval: { mode: required, grantTtlMs: ${grantTtlMs} }
    command: { executable: node, args: [--version], timeoutMs: 10000 }
`);
}

function dependentApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: dependent-approval }
nodes:
  - id: first
    type: command
    command: { executable: node, args: [--version] }
  - id: later
    type: command
    dependsOn: [first]
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: npm, args: [test] }
`);
}

function requestFrom(events: readonly RunEvent[]): CommandApprovalRequestedEvent {
  const event = events.find(
    (candidate): candidate is CommandApprovalRequestedEvent =>
      candidate.type === "command_approval_requested",
  );
  if (event === undefined) {
    throw new Error("expected approval request event");
  }
  return event;
}

function grantFor(
  events: readonly RunEvent[],
  sequence: number,
  expiresAt: string,
): CommandApprovalGrantedEvent {
  const request = requestFrom(events);
  return {
    version: 1,
    sequence,
    at: "2026-08-07T15:00:01.000Z",
    runId: request.runId,
    workflowId: request.workflowId,
    type: "command_approval_granted",
    nodeId: request.nodeId,
    attempt: request.attempt,
    requestId: request.requestId,
    operationDigest: request.operationDigest,
    actor: "operator:daniel",
    expiresAt,
  };
}
