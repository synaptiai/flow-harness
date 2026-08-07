import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decideApproval } from "../../../src/application/command-approval.js";
import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("workflow approval-node execution", () => {
  it("pauses on an exact durable evidence-bound request without executing the control node", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();

    const state = await runWorkflow(approvalNodeWorkflow(), {
      ...options(store, successfulExecutor(calls)),
      runId: "run-workflow-approval",
    });

    expect(calls).toEqual(["plan"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "workflow_approval_requested",
    ]);
    expect(store.events.at(-1)).toMatchObject({
      requestId: "approval-4",
      nodeId: "review",
      attempt: 1,
      request: {
        prompt: "Approve the verified plan.",
        evidence: [
          {
            sourceNodeId: "plan",
            sourceAttempt: 1,
            sourceField: "command.stdout",
            sourceHash: sha256("plan output"),
          },
        ],
      },
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(state).toMatchObject({
      status: "waiting_for_approval",
      resources: { nodeStarts: 1 },
      nodes: {
        review: { status: "pending", workflowApproval: { status: "pending" } },
      },
    });
  });

  it("resumes after approval and executes only the downstream command", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-workflow-approved", calls);
    await decideApproval({
      runId: "run-workflow-approved",
      requestId: "approval-4",
      decision: "approve",
      actor: "operator:daniel",
      store,
      now: () => new Date("2026-08-07T15:00:02.000Z"),
    });

    const state = await resumeWorkflow(approvalNodeWorkflow(), {
      ...options(store, successfulExecutor(calls)),
      runId: "run-workflow-approved",
      now: () => new Date("2026-08-07T15:00:03.000Z"),
    });

    expect(calls).toEqual(["plan", "verify"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "workflow_approval_requested",
      "workflow_approval_approved",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 2 },
      budget: { remaining: { nodeStarts: 0 } },
      goal: { status: "accepted" },
      nodes: {
        review: {
          status: "succeeded",
          control: { kind: "approval", actor: "operator:daniel" },
          workflowApproval: { status: "approved" },
        },
      },
    });
  });

  it("keeps a pending request stable across a no-op resume", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-workflow-pending", calls);

    const state = await resumeWorkflow(approvalNodeWorkflow(), {
      ...options(store, successfulExecutor(calls)),
      runId: "run-workflow-pending",
    });

    expect(calls).toEqual(["plan"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "workflow_approval_requested",
      "run_resumed",
    ]);
    expect(state).toMatchObject({
      status: "waiting_for_approval",
      nodes: { review: { workflowApproval: { requestId: "approval-4", status: "pending" } } },
    });
  });

  it("records denial as terminal failure without downstream execution", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-workflow-denied", calls);

    const state = await decideApproval({
      runId: "run-workflow-denied",
      requestId: "approval-4",
      decision: "deny",
      actor: "operator:daniel",
      reason: " unsafe plan ",
      store,
      now: () => new Date("2026-08-07T15:00:02.000Z"),
    });

    expect(calls).toEqual(["plan"]);
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "workflow_approval_denied",
      "run_failed",
    ]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "review",
      failureReason: "workflow approval denied by operator:daniel: unsafe plan",
      nodes: {
        review: {
          status: "failed",
          error: { code: "workflow_approval_denied", sideEffectStatus: "none" },
          workflowApproval: { status: "denied", reason: "unsafe plan" },
        },
        verify: { status: "pending" },
      },
    });
  });

  it("rejects a duplicate workflow approval decision without appending", async () => {
    const store = await waitingStore("run-workflow-duplicate", []);
    await decideApproval({
      runId: "run-workflow-duplicate",
      requestId: "approval-4",
      decision: "approve",
      actor: "operator:first",
      store,
    });
    const before = structuredClone(store.events);

    await expect(
      decideApproval({
        runId: "run-workflow-duplicate",
        requestId: "approval-4",
        decision: "deny",
        actor: "operator:second",
        store,
      }),
    ).rejects.toMatchObject({ code: "not_waiting" });
    expect(store.events).toEqual(before);
  });

  it("preserves a pending request when the workflow approval append fails", async () => {
    const store = await waitingStore("run-workflow-append-failure", []);
    const before = structuredClone(store.events);
    store.failNextAppend("workflow_approval_approved");

    await expect(
      decideApproval({
        runId: "run-workflow-append-failure",
        requestId: "approval-4",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toThrowError(/injected append failure/i);
    expect(store.events).toEqual(before);

    await expect(
      decideApproval({
        runId: "run-workflow-append-failure",
        requestId: "approval-4",
        decision: "approve",
        actor: "operator:daniel",
        store,
      }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("repairs a denial interrupted before run terminalization without executing", async () => {
    const calls: string[] = [];
    const store = await waitingStore("run-workflow-denial-repair", calls);
    store.failNextAppend("run_failed");

    await expect(
      decideApproval({
        runId: "run-workflow-denial-repair",
        requestId: "approval-4",
        decision: "deny",
        actor: "operator:daniel",
        store,
      }),
    ).rejects.toThrowError(/injected append failure/i);
    expect(store.events.at(-1)?.type).toBe("workflow_approval_denied");

    const state = await resumeWorkflow(approvalNodeWorkflow(), {
      ...options(store, successfulExecutor(calls)),
      runId: "run-workflow-denial-repair",
    });
    expect(calls).toEqual(["plan"]);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "review" });
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "run_resumed",
      "run_failed",
    ]);
  });

  it("fails closed when declared approval evidence is truncated", async () => {
    const store = new MemoryStore();
    const state = await runWorkflow(approvalNodeWorkflow(), {
      ...options(store, successfulExecutor([], true)),
      runId: "run-workflow-truncated",
    });

    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_control_failed",
      "run_failed",
    ]);
    expect(state).toMatchObject({
      status: "failed",
      nodes: {
        review: {
          error: {
            code: "workflow_approval_evidence_truncated",
            retryable: false,
            sideEffectStatus: "none",
          },
        },
      },
    });
  });

  it("omits an approval in an unselected branch without prompting", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(conditionalApprovalWorkflow(), {
      ...options(store, branchExecutor(calls)),
      runId: "run-workflow-approval-omitted",
    });

    expect(calls).toEqual(["classify", "clean", "verify"]);
    expect(store.events.some((event) => event.type === "workflow_approval_requested")).toBe(false);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        plan: { status: "omitted", omission: { reason: "condition_not_selected" } },
        review: { status: "omitted", omission: { reason: "dependency_omitted" } },
      },
    });
  });

  it("waits for a concurrent executable wave to quiesce before requesting approval", async () => {
    const store = new MemoryStore();
    await runWorkflow(concurrentApprovalWorkflow(), {
      ...options(store, successfulExecutor([])),
      runId: "run-workflow-approval-concurrent",
    });

    const types = store.events.map((event) => event.type);
    const requestIndex = types.indexOf("workflow_approval_requested");
    const leftSuccessIndex = store.events.findIndex(
      (event) => event.type === "node_succeeded" && event.nodeId === "left",
    );
    const rightSuccessIndex = store.events.findIndex(
      (event) => event.type === "node_succeeded" && event.nodeId === "right",
    );
    expect(
      store.events.filter((event) => event.type === "workflow_approval_requested"),
    ).toHaveLength(1);
    expect(
      store.events.find((event) => event.type === "workflow_approval_requested"),
    ).toMatchObject({
      request: {
        evidence: [{ sourceNodeId: "left" }, { sourceNodeId: "right" }],
      },
    });
    expect(requestIndex).toBeGreaterThan(leftSuccessIndex);
    expect(requestIndex).toBeGreaterThan(rightSuccessIndex);
  });

  it("uses an approval node inside a bounded loop and omits later iterations after stop", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const workflow = loopApprovalWorkflow();
    const waiting = await runWorkflow(workflow, {
      ...options(store, loopExecutor(calls)),
      runId: "run-workflow-approval-loop",
    });
    const request = store.events.find((event) => event.type === "workflow_approval_requested");
    if (request?.type !== "workflow_approval_requested") {
      throw new Error("expected loop approval request");
    }
    expect(waiting.status).toBe("waiting_for_approval");

    await decideApproval({
      runId: "run-workflow-approval-loop",
      requestId: request.requestId,
      decision: "approve",
      actor: "operator:daniel",
      store,
    });
    const state = await resumeWorkflow(workflow, {
      ...options(store, loopExecutor(calls)),
      runId: "run-workflow-approval-loop",
    });

    expect(state.status).toBe("succeeded");
    expect(
      store.events.filter((event) => event.type === "workflow_approval_requested"),
    ).toHaveLength(1);
    expect(state.nodes["repair--i2--node--review"]).toMatchObject({ status: "omitted" });
  });
});

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];
  #failingEventType: RunEvent["type"] | undefined;

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.#failingEventType) {
      this.#failingEventType = undefined;
      throw new Error(`injected append failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
  }

  failNextAppend(eventType: RunEvent["type"]): void {
    this.#failingEventType = eventType;
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

async function waitingStore(runId: string, calls: string[]): Promise<MemoryStore> {
  const store = new MemoryStore();
  await runWorkflow(approvalNodeWorkflow(), {
    ...options(store, successfulExecutor(calls)),
    runId,
  });
  return store;
}

function options(store: MemoryStore, executor: NodeExecutor) {
  return {
    cwd: "/workspace",
    protectedPaths: [] as const,
    store,
    executor,
    now: () => new Date("2026-08-07T15:00:01.000Z"),
  };
}

function successfulExecutor(calls: string[], truncated = false): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.type === "approval") {
        throw new Error("approval control node reached executor");
      }
      calls.push(node.id);
      const stdout = node.id === "plan" ? "plan output" : "verified";
      return {
        status: "succeeded",
        evidence: {
          kind: "command",
          executable: "node",
          args: [node.id],
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          stdoutHash: sha256(stdout),
          stderrHash: sha256(""),
          stdoutTruncated: node.id === "plan" && truncated,
          stderrTruncated: false,
          timedOut: false,
          durationMs: 1,
        },
      };
    },
  };
}

function approvalNodeWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: workflow-approval }
budget: { maxNodeStarts: 2 }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: approved-verification }
  outcome: The approved workflow is verified.
  criteria:
    - id: verification-passes
      description: The terminal verification command passes.
      verifier: { nodeId: verify }
nodes:
  - id: plan
    type: command
    command: { executable: node, args: [plan] }
  - id: review
    type: approval
    dependsOn: [plan]
    approval:
      prompt: Approve the verified plan.
      evidence:
        - { nodeId: plan, field: command.stdout }
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [verify] }
`);
}

function conditionalApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditional-workflow-approval }
nodes:
  - id: classify
    type: command
    command: { executable: node, args: [classify] }
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: command.stdout }
      cases: [{ id: needs-work, equals: needs-work }]
      default: clean
  - id: plan
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: needs-work }
    command: { executable: node, args: [plan] }
  - id: review
    type: approval
    dependsOn: [plan]
    approval:
      prompt: Approve the plan.
      evidence: [{ nodeId: plan, field: command.stdout }]
  - id: clean
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: clean }
    command: { executable: node, args: [clean] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: needs-work, nodeId: review }
        - { case: clean, nodeId: clean }
  - id: verify
    type: command
    dependsOn: [converge]
    command: { executable: node, args: [verify] }
`);
}

function concurrentApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-workflow-approval }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [root] }
  - id: left
    type: command
    dependsOn: [root]
    command: { executable: node, args: [left] }
  - id: right
    type: command
    dependsOn: [root]
    command: { executable: node, args: [right] }
  - id: review
    type: approval
    dependsOn: [left, right]
    approval:
      prompt: Approve both results.
      evidence:
        - { nodeId: left, field: command.stdout }
        - { nodeId: right, field: command.stdout }
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [verify] }
`);
}

function loopApprovalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: loop-workflow-approval }
nodes:
  - id: repair
    type: loop
    loop:
      maxIterations: 2
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: plan
            type: command
            command: { executable: node, args: [plan] }
          - id: review
            type: approval
            dependsOn: [plan]
            approval:
              prompt: Approve this iteration plan.
              evidence: [{ nodeId: plan, field: command.stdout }]
          - id: probe
            type: command
            dependsOn: [review]
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: node, args: [verify] }
`);
}

function branchExecutor(calls: string[]): NodeExecutor {
  return outputExecutor(calls, (nodeId) => (nodeId === "classify" ? "clean" : nodeId));
}

function loopExecutor(calls: string[]): NodeExecutor {
  return outputExecutor(calls, (nodeId) => (nodeId.includes("probe") ? "pass" : nodeId));
}

function outputExecutor(calls: string[], output: (nodeId: string) => string): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.type === "approval") {
        throw new Error("approval control node reached executor");
      }
      calls.push(node.id);
      const stdout = output(node.id);
      return {
        status: "succeeded",
        evidence: {
          kind: "command",
          executable: "node",
          args: [node.id],
          exitCode: 0,
          signal: null,
          stdout,
          stderr: "",
          stdoutHash: sha256(stdout),
          stderrHash: sha256(""),
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          durationMs: 1,
        },
      };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
