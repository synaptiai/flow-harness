import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type {
  CommandEvidence,
  CommandApprovalGrantedEvent,
  CommandApprovalRequestedEvent,
  RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("budgeted workflow execution", () => {
  it("commits model-token equality and stops before downstream work", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const executor = recordingExecutor(calls, (nodeId) =>
      nodeId === "analyze"
        ? agentSuccess(2, {
            inputTokens: 6,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 5,
          })
        : commandSuccess(nodeId, 1),
    );

    const state = await runWorkflow(modelWorkflow("maxModelTokens: 10"), {
      ...options(store, executor),
      runId: "run-token-equality",
    });

    expect(calls).toEqual(["analyze"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_budget_exhausted",
    ]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { modelTokens: 10, modelCostUsdMicros: 5, nodeStarts: 1 },
      budget: {
        exhausted: [{ dimension: "modelTokens", limit: 10, consumed: 10 }],
      },
      nodes: { analyze: { status: "succeeded" }, verify: { status: "pending" } },
    });
  });

  it("records full cost overshoot and does not invoke another executor", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const state = await runWorkflow(modelWorkflow("maxCostUsd: 0.000010"), {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) =>
          nodeId === "analyze"
            ? agentSuccess(1, {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsdMicros: 17,
              })
            : commandSuccess(nodeId, 1),
        ),
      ),
      runId: "run-cost-overshoot",
    });

    expect(calls).toEqual(["analyze"]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { modelCostUsdMicros: 17 },
      budget: {
        exhausted: [{ dimension: "modelCostUsdMicros", limit: 10, consumed: 17 }],
      },
    });
  });

  it("stops at a node-start boundary without invoking the next executor", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const state = await runWorkflow(commandWorkflow("maxNodeStarts: 1"), {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) => commandSuccess(nodeId, 1)),
      ),
      runId: "run-start-boundary",
    });

    expect(calls).toEqual(["prepare"]);
    expect(state.status).toBe("resource_exhausted");
    expect(store.events.at(-1)).toMatchObject({
      type: "run_budget_exhausted",
      exhausted: [{ dimension: "nodeStarts", limit: 1, consumed: 1 }],
    });
  });

  it("prioritizes a pending start boundary over a later cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore(undefined, (event) => {
      if (event.type === "node_succeeded") {
        controller.abort(new Error("operator cancelled after commit"));
      }
    });
    const state = await runWorkflow(commandWorkflow("maxNodeStarts: 1"), {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) => commandSuccess(nodeId, 1)),
      ),
      runId: "run-cancelled-at-start-boundary",
      signal: controller.signal,
    });

    expect(calls).toEqual(["prepare"]);
    expect(state.status).toBe("resource_exhausted");
    expect(store.events.at(-1)?.type).toBe("run_budget_exhausted");
  });

  it("allows a completed graph to use its final permitted start", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: final-start-workflow }
budget: { maxNodeStarts: 1 }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [verify] }
`);

    const state = await runWorkflow(workflow, {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) => commandSuccess(nodeId, 1)),
      ),
      runId: "run-final-start",
    });

    expect(calls).toEqual(["verify"]);
    expect(state).toMatchObject({
      status: "succeeded",
      budget: {
        remaining: { nodeStarts: 0 },
        exhausted: [{ dimension: "nodeStarts", limit: 1, consumed: 1 }],
      },
    });
  });

  it("does not mask a failed node merely because it used the final permitted start", async () => {
    const store = new MemoryRecoverableRunStore();
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: failed-final-start-workflow }
budget: { maxNodeStarts: 1 }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [verify] }
`);
    const executor: NodeExecutor = {
      async execute() {
        return {
          status: "failed",
          error: {
            code: "verification_failed",
            message: "verification failed",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: { ...commandSuccess("verify", 1).evidence, exitCode: 1 },
        };
      },
    };

    const state = await runWorkflow(workflow, {
      ...options(store, executor),
      runId: "run-failed-final-start",
    });

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "verify",
      budget: {
        exhausted: [{ dimension: "nodeStarts", limit: 1, consumed: 1 }],
      },
    });
    expect(store.events.at(-1)?.type).toBe("run_failed");
  });

  it("bounds an agent by remaining active execution time and settles equality", async () => {
    const observedTimeouts: number[] = [];
    const store = new MemoryRecoverableRunStore();
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type !== "agent") {
          throw new Error("downstream verifier must not execute");
        }
        observedTimeouts.push(node.agent.timeoutMs);
        return agentSuccess(5, {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 0,
        });
      },
    };

    const state = await runWorkflow(modelWorkflow("maxExecutionMs: 5"), {
      ...options(store, executor),
      runId: "run-active-time-equality",
    });

    expect(observedTimeouts).toEqual([5]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { executionMs: 5 },
      budget: {
        exhausted: [{ dimension: "executionMs", limit: 5, consumed: 5 }],
      },
    });
  });

  it("counts failed model evidence and prefers explicit exhaustion to generic failure", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore();
    const executor = recordingExecutor(calls, () => ({
      status: "failed",
      error: {
        code: "provider_failed",
        message: "provider failed after settlement",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: agentEvidence(3, {
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 12,
      }),
    }));

    const state = await runWorkflow(modelWorkflow("maxCostUsd: 0.000010"), {
      ...options(store, executor),
      runId: "run-failed-settlement",
    });

    expect(calls).toEqual(["analyze"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_budget_exhausted",
    ]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { modelCostUsdMicros: 12 },
      nodes: { analyze: { status: "failed", error: { code: "provider_failed" } } },
    });
  });

  it("preserves settled model usage when cancellation races with executor success", async () => {
    const controller = new AbortController();
    const store = new MemoryRecoverableRunStore();
    const executor: NodeExecutor = {
      async execute() {
        controller.abort(new Error("operator cancelled after settlement"));
        return agentSuccess(3, {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 12,
        });
      },
    };

    const state = await runWorkflow(modelWorkflow("maxModelTokens: 2"), {
      ...options(store, executor),
      runId: "run-cancelled-settlement",
      signal: controller.signal,
    });

    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_budget_exhausted",
    ]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: {
        modelTokens: 2,
        modelCostUsdMicros: 12,
        executionMs: 3,
      },
      nodes: {
        analyze: {
          status: "failed",
          error: { code: "workflow_aborted" },
          evidence: { usage: { costUsdMicros: 12 } },
        },
      },
    });
  });

  it("prioritizes committed settlement exhaustion over a later cancellation", async () => {
    const controller = new AbortController();
    const store = new MemoryRecoverableRunStore(undefined, (event) => {
      if (event.type === "node_succeeded") {
        controller.abort(new Error("operator cancelled after commit"));
      }
    });
    const executor = recordingExecutor([], () =>
      agentSuccess(3, {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 12,
      }),
    );

    const state = await runWorkflow(modelWorkflow("maxModelTokens: 2"), {
      ...options(store, executor),
      runId: "run-cancelled-after-settlement",
      signal: controller.signal,
    });

    expect(state.status).toBe("resource_exhausted");
    expect(store.events.at(-1)?.type).toBe("run_budget_exhausted");
  });

  it("binds remaining active execution time into approval and resumed execution", async () => {
    const calls: Array<{ readonly nodeId: string; readonly timeoutMs: number }> = [];
    const store = new MemoryRecoverableRunStore();
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type !== "command" && node.type !== "agent") {
          throw new Error(`unexpected control node ${node.id}`);
        }
        const timeoutMs = node.type === "command" ? node.command.timeoutMs : node.agent.timeoutMs;
        calls.push({ nodeId: node.id, timeoutMs });
        return commandSuccess(node.id, node.id === "prepare" ? 4 : 1);
      },
    };

    const waiting = await runWorkflow(approvalBudgetWorkflow(), {
      ...options(store, executor, () => new Date("2026-08-07T17:00:00.000Z")),
      runId: "run-budget-approval",
    });

    expect(waiting.status).toBe("waiting_for_approval");
    expect(calls).toEqual([{ nodeId: "prepare", timeoutMs: 10 }]);
    const request = approvalRequest(store.events);
    expect(request.operation.timeoutMs).toBe(6);

    await store.append(approvalGrant(request, 5));
    await store.release();
    const resumed = await resumeWorkflow(approvalBudgetWorkflow(), {
      ...options(store, executor, () => new Date("2026-08-07T17:00:30.000Z")),
      runId: "run-budget-approval",
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.resources.executionMs).toBe(5);
    expect(calls).toEqual([
      { nodeId: "prepare", timeoutMs: 10 },
      { nodeId: "verify", timeoutMs: 6 },
    ]);
    expect(approvalRequest(store.events).operation).toEqual(request.operation);
  });

  it("renews an expired grant with the same remaining execution bound", async () => {
    const calls: Array<{ readonly nodeId: string; readonly timeoutMs: number }> = [];
    const store = new MemoryRecoverableRunStore();
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type !== "command") {
          throw new Error("expected command node");
        }
        calls.push({ nodeId: node.id, timeoutMs: node.command.timeoutMs });
        return commandSuccess(node.id, 4);
      },
    };
    await runWorkflow(approvalBudgetWorkflow(), {
      ...options(store, executor),
      runId: "run-budget-expiry",
    });
    const firstRequest = approvalRequest(store.events);
    await store.append(approvalGrant(firstRequest, 5));

    const state = await resumeWorkflow(approvalBudgetWorkflow(), {
      ...options(store, executor, () => new Date("2026-08-07T17:01:01.000Z")),
      runId: "run-budget-expiry",
    });

    const requests = store.events.filter(
      (event): event is CommandApprovalRequestedEvent =>
        event.type === "command_approval_requested",
    );
    expect(calls).toEqual([{ nodeId: "prepare", timeoutMs: 10 }]);
    expect(state.status).toBe("waiting_for_approval");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.operation.timeoutMs)).toEqual([6, 6]);
    expect(state.resources.executionMs).toBe(4);
  });

  it("recovers a committed settlement into the same terminal exhaustion", async () => {
    const calls: string[] = [];
    const store = new MemoryRecoverableRunStore("run_budget_exhausted");
    const workflow = modelWorkflow("maxModelTokens: 2");
    const executor = recordingExecutor(calls, () =>
      agentSuccess(1, {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 1,
      }),
    );

    await expect(
      runWorkflow(workflow, {
        ...options(store, executor),
        runId: "run-recover-exhaustion",
      }),
    ).rejects.toThrowError(/injected append failure/i);
    expect(calls).toEqual(["analyze"]);

    store.failOn = undefined;
    const resumed = await resumeWorkflow(workflow, {
      ...options(
        store,
        recordingExecutor(calls, () => commandSuccess("verify", 1)),
      ),
      runId: "run-recover-exhaustion",
    });

    expect(calls).toEqual(["analyze"]);
    expect(resumed.status).toBe("resource_exhausted");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_resumed",
      "run_budget_exhausted",
    ]);
  });

  it("refuses recovery when persisted limits differ from the compiled workflow", async () => {
    const store = new MemoryRecoverableRunStore();
    const workflow = approvalBudgetWorkflow();
    await runWorkflow(workflow, {
      ...options(
        store,
        recordingExecutor([], (nodeId) => commandSuccess(nodeId, 4)),
      ),
      runId: "run-budget-mismatch",
    });
    const started = store.events[0];
    if (started?.type !== "run_started") {
      throw new Error("expected run_started");
    }
    store.events[0] = { ...started, budget: { maxExecutionMs: 20 } };

    await expect(
      resumeWorkflow(workflow, {
        ...options(
          store,
          recordingExecutor([], (nodeId) => commandSuccess(nodeId, 1)),
        ),
        runId: "run-budget-mismatch",
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
  });
});

class MemoryRecoverableRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  constructor(
    public failOn?: RunEvent["type"],
    readonly afterAppend?: (event: RunEvent) => void,
  ) {}

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.failOn) {
      throw new Error(`injected append failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
    this.afterAppend?.(event);
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

function options(
  store: MemoryRecoverableRunStore,
  executor: NodeExecutor,
  now: () => Date = () => new Date("2026-08-07T17:00:00.000Z"),
) {
  return { cwd: "/workspace", protectedPaths: [] as const, store, executor, now };
}

function recordingExecutor(
  calls: string[],
  outcome: (nodeId: string) => NodeExecutionOutcome,
): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      calls.push(node.id);
      return outcome(node.id);
    },
  };
}

function commandSuccess(
  nodeId: string,
  durationMs: number,
): { readonly status: "succeeded"; readonly evidence: CommandEvidence } {
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: "node",
      args: [nodeId],
      exitCode: 0,
      signal: null,
      stdout: nodeId,
      stderr: "",
      stdoutHash: sha256(nodeId),
      stderrHash: sha256(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs,
    },
  };
}

function agentSuccess(
  durationMs: number,
  usage: NonNullable<ReturnType<typeof agentEvidence>["usage"]>,
): NodeExecutionOutcome {
  return { status: "succeeded", evidence: agentEvidence(durationMs, usage) };
}

function agentEvidence(
  durationMs: number,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsdMicros: number;
  },
) {
  return {
    kind: "agent" as const,
    provider: "test-provider",
    model: "test-model",
    text: "analysis",
    textHash: sha256("analysis"),
    textTruncated: false,
    durationMs,
    usage,
    policyDecisions: [],
    effectReceipts: [],
  };
}

function modelWorkflow(budgetLine: string) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-budget-workflow }
budget:
  ${budgetLine}
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`);
}

function commandWorkflow(budgetLine: string) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-budget-workflow }
budget:
  ${budgetLine}
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [prepare] }
  - id: verify
    type: command
    dependsOn: [prepare]
    command: { executable: node, args: [verify] }
`);
}

function approvalBudgetWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-budget-workflow }
budget:
  maxExecutionMs: 10
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [prepare], timeoutMs: 100 }
  - id: verify
    type: command
    dependsOn: [prepare]
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [verify], timeoutMs: 100 }
`);
}

function approvalRequest(events: readonly RunEvent[]): CommandApprovalRequestedEvent {
  const request = events.find(
    (event): event is CommandApprovalRequestedEvent => event.type === "command_approval_requested",
  );
  if (request === undefined) {
    throw new Error("expected an approval request");
  }
  return request;
}

function approvalGrant(
  request: CommandApprovalRequestedEvent,
  sequence: number,
): CommandApprovalGrantedEvent {
  return {
    version: 1,
    sequence,
    at: "2026-08-07T17:00:01.000Z",
    runId: request.runId,
    workflowId: request.workflowId,
    type: "command_approval_granted",
    nodeId: request.nodeId,
    attempt: request.attempt,
    requestId: request.requestId,
    operationDigest: request.operationDigest,
    actor: "operator:test",
    expiresAt: "2026-08-07T17:01:01.000Z",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
