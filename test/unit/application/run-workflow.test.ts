import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RunCancellation,
  RunWorkflowAbortedError,
  resumeWorkflow,
  runWorkflow,
} from "../../../src/application/run-workflow.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
} from "../../../src/application/ports.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("runWorkflow", () => {
  it("executes nodes only in dependency order and replays a successful state", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    const state = await runWorkflow(threeNodeWorkflow(), options(store, executor, "run-order"));

    expect(calls).toEqual(["first", "second", "third"]);
    expect(state.status).toBe("succeeded");
    expect(state.workflowApiVersion).toBe("flow.synapti.ai/v1alpha1");
    expect(state.workflowDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("ignores an executor-supplied next node and retains graph authority", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return {
        ...successfulOutcome(node.id),
        nextNode: "third",
      } as unknown as NodeExecutionOutcome;
    });

    await runWorkflow(threeNodeWorkflow(), options(store, executor, "run-steering"));

    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("binds run evidence to the exact compiled workflow content", async () => {
    const executor = executorFrom(async (node) => successfulOutcome(node.id));
    const firstStore = new MemoryRunStore();
    const secondStore = new MemoryRunStore();
    const repeatedStore = new MemoryRunStore();
    const originalWorkflow = threeNodeWorkflow();
    const changedWorkflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ordered-workflow }
nodes:
  - id: first
    type: command
    command: { executable: node, args: [--help] }
  - id: second
    type: command
    dependsOn: [first]
    command: { executable: node, args: [--version] }
  - id: third
    type: command
    dependsOn: [second]
    command: { executable: node, args: [--version] }
`);

    const first = await runWorkflow(
      originalWorkflow,
      options(firstStore, executor, "run-digest-a"),
    );
    const second = await runWorkflow(
      changedWorkflow,
      options(secondStore, executor, "run-digest-b"),
    );
    const repeated = await runWorkflow(
      originalWorkflow,
      options(repeatedStore, executor, "run-digest-c"),
    );

    const expected = createHash("sha256").update(JSON.stringify(originalWorkflow)).digest("hex");
    expect(first.workflowDigest).toBe(expected);
    expect(repeated.workflowDigest).toBe(expected);
    expect(first.workflowDigest).not.toBe(second.workflowDigest);
  });

  it("commits the compiled goal and returns accepted criterion state", async () => {
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    const state = await runWorkflow(
      goalWorkflow(),
      options(store, executor, "run-goal-acceptance"),
    );

    expect(store.events[0]).toMatchObject({
      type: "run_started",
      goal: {
        id: "verified-change",
        criteria: [{ id: "verification-passes", verifierNodeId: "verify" }],
      },
    });
    expect(state).toMatchObject({
      status: "succeeded",
      goal: {
        status: "accepted",
        criteria: {
          "verification-passes": {
            status: "accepted",
            decision: {
              runId: "run-goal-acceptance",
              nodeId: "verify",
              attempt: 1,
            },
          },
        },
      },
    });
  });

  it("binds a model verifier to the exact durable evidence attempt", async () => {
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type !== "verifier") {
        return successfulOutcome(node.id);
      }
      expect(context.verifierSources).toEqual([
        {
          sourceNodeId: "source",
          sourceAttempt: 1,
          sourceField: "command.stdout",
          sourceHash: createHash("sha256").update("source").digest("hex"),
          value: "source",
          truncated: false,
        },
      ]);
      const reason = "The persisted command output satisfies the rubric.";
      const raw = JSON.stringify({ verdict: "accepted", reason });
      return {
        status: "succeeded",
        evidence: {
          kind: "verifier",
          driver: "model",
          result: "parsed",
          verdict: "accepted",
          reason,
          reasonHash: createHash("sha256").update(reason).digest("hex"),
          provider: "test",
          model: "deterministic",
          raw,
          rawHash: createHash("sha256").update(raw).digest("hex"),
          rawTruncated: false,
          durationMs: 1,
          sources: [
            {
              sourceNodeId: "source",
              sourceAttempt: 1,
              sourceField: "command.stdout",
              sourceHash: createHash("sha256").update("source").digest("hex"),
            },
          ],
        },
      };
    });

    const state = await runWorkflow(
      modelVerifierWorkflow(),
      options(store, executor, "run-model-verifier"),
    );

    expect(state.status).toBe("succeeded");
    expect(state.nodes.review).toMatchObject({
      status: "succeeded",
      evidence: { kind: "verifier", driver: "model", verdict: "accepted" },
    });
  });

  it("uses dependencies before declaration order and declaration order among ready nodes", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: fan-in-workflow }
nodes:
  - id: join
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [--version] }
  - id: right
    type: command
    dependsOn: [root]
    command: { executable: node, args: [--version] }
  - id: root
    type: command
    command: { executable: node, args: [--version] }
  - id: left
    type: command
    dependsOn: [root]
    command: { executable: node, args: [--version] }
`);

    await runWorkflow(workflow, options(store, executor, "run-fan-in"));

    expect(calls).toEqual(["root", "right", "left", "join"]);
    expect(new Set(calls).size).toBe(4);
  });

  it("releases fresh execution ownership after reaching a terminal state", async () => {
    const store = new MemoryRecoverableRunStore([]);
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    await runWorkflow(threeNodeWorkflow(), options(store, executor, "run-owned"));

    expect(store.releaseCalls).toEqual(["run-owned"]);
  });

  it("fails the run and never executes dependents after a node failure", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      if (node.id === "second") {
        return {
          status: "failed",
          error: {
            code: "verification_failed",
            message: "verification exited nonzero",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: commandEvidence(node.id, 1),
        };
      }
      return successfulOutcome(node.id);
    });

    const state = await runWorkflow(threeNodeWorkflow(), options(store, executor, "run-failure"));

    expect(calls).toEqual(["first", "second"]);
    expect(state.status).toBe("failed");
    expect(state.failedNodeId).toBe("second");
    expect(state.nodes.third?.status).toBe("pending");
  });

  it("does not invoke an executor when the node-start event cannot be committed", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore("node_started");
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    await expect(
      runWorkflow(threeNodeWorkflow(), options(store, executor, "run-store-failure")),
    ).rejects.toThrowError(/injected persistence failure/i);
    expect(calls).toEqual([]);
  });

  it("rejects pre-cancelled work before claiming a run", async () => {
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => successfulOutcome(node.id));
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));

    await expect(
      runWorkflow(threeNodeWorkflow(), {
        ...options(store, executor, "run-pre-cancelled"),
        signal: controller.signal,
      }),
    ).rejects.toThrowError(RunWorkflowAbortedError);
    expect(store.events).toEqual([]);
  });

  it("preserves node evidence and records attributable cancellation during a node", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const controller = new AbortController();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      controller.abort(
        new RunCancellation(
          "operator cancelled",
          "operator:test",
          "a4f43869-0aca-4db0-851a-c1e6bca34c7e",
        ),
      );
      return successfulOutcome(node.id);
    });

    const state = await runWorkflow(threeNodeWorkflow(), {
      ...options(store, executor, "run-mid-cancel"),
      signal: controller.signal,
    });

    expect(calls).toEqual(["first"]);
    expect(state).toMatchObject({
      status: "cancelled",
      failedNodeId: "first",
      failureReason: "operator cancelled",
      nodes: { first: { status: "failed", error: { code: "workflow_aborted" } } },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_cancelled",
    ]);
    expect(store.events.at(-1)).toMatchObject({
      type: "run_cancelled",
      cancelledNodeId: "first",
      actor: "operator:test",
      requestId: "a4f43869-0aca-4db0-851a-c1e6bca34c7e",
    });
  });

  it("records cancellation between nodes without starting another node", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const store = new MemoryRunStore(undefined, (event) => {
      if (event.type === "node_succeeded") {
        controller.abort("pause requested");
      }
    });
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    const state = await runWorkflow(threeNodeWorkflow(), {
      ...options(store, executor, "run-between-cancel"),
      signal: controller.signal,
    });

    expect(calls).toEqual(["first"]);
    expect(state).toMatchObject({
      status: "cancelled",
      failedNodeId: null,
      failureReason: "pause requested",
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_cancelled",
    ]);
  });

  it("linearizes a signal arriving during the durable success commit as success", async () => {
    const controller = new AbortController();
    const store = new MemoryRunStore(undefined, (event) => {
      if (event.type === "run_succeeded") {
        controller.abort(new Error("late signal"));
      }
    });
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    const state = await runWorkflow(threeNodeWorkflow(), {
      ...options(store, executor, "run-late-signal"),
      signal: controller.signal,
    });

    expect(state.status).toBe("succeeded");
    expect(store.events.at(-1)?.type).toBe("run_succeeded");
  });

  it("resumes a safe boundary to the same terminal node outcomes", async () => {
    const workflow = threeNodeWorkflow();
    const store = new MemoryRecoverableRunStore(eventsThroughFirstSuccess(workflow));
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    const state = await resumeWorkflow(workflow, resumeOptions(store, executor, "run-resume"));

    expect(calls).toEqual(["second", "third"]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        first: { status: "succeeded", attempt: 1 },
        second: { status: "succeeded", attempt: 1 },
        third: { status: "succeeded", attempt: 1 },
      },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(store.releaseCalls).toEqual(["run-resume"]);
  });

  it("does not re-execute successful nodes when only terminalization remains", async () => {
    const workflow = threeNodeWorkflow();
    const initial = await successfulLedger(workflow, "run-terminalization");
    initial.pop();
    const store = new MemoryRecoverableRunStore(initial);
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    const state = await resumeWorkflow(
      workflow,
      resumeOptions(store, executor, "run-terminalization"),
    );

    expect(calls).toEqual([]);
    expect(state.status).toBe("succeeded");
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "run_resumed",
      "run_succeeded",
    ]);
  });

  it("refuses an uncertain open attempt without appending or executing", async () => {
    const workflow = threeNodeWorkflow();
    const initial = eventsThroughFirstSuccess(workflow);
    initial.push({
      ...eventBase("run-resume", workflow.id, 4),
      type: "node_started",
      nodeId: "second",
      attempt: 1,
    });
    const store = new MemoryRecoverableRunStore(initial);
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-resume")),
    ).rejects.toMatchObject({ code: "uncertain_operation" });
    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-resume")),
    ).rejects.toThrowError(/node "second" attempt 1/i);
    expect(calls).toEqual([]);
    expect(store.events).toEqual(initial);
    expect(store.releaseCalls).toEqual(["run-resume", "run-resume"]);
  });

  it("rejects a durable-effect marker on a node that does not declare edit", async () => {
    const workflow = readOnlyAgentWorkflow();
    const initialStore = new MemoryRunStore();
    await runWorkflow(
      workflow,
      options(
        initialStore,
        executorFrom(async (node) =>
          node.type === "agent" ? successfulAgentOutcome() : successfulOutcome(node.id),
        ),
        "run-forged-effects",
      ),
    );
    const initial = structuredClone(initialStore.events);
    initial.pop();
    const startedIndex = initial.findIndex(
      (event) => event.type === "node_started" && event.nodeId === "analyze",
    );
    const started = initial[startedIndex];
    if (started?.type !== "node_started") {
      throw new Error("read-only agent start was not recorded");
    }
    initial[startedIndex] = { ...started, effectProtocol: "flow.effects/v1" };
    const store = new MemoryRecoverableRunStore(initial);
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-forged-effects")),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events).toEqual(initial);
  });

  it("classifies an open durable-effect marker on a read-only node as workflow mismatch", async () => {
    const workflow = readOnlyAgentWorkflow();
    const initialStore = new MemoryRunStore();
    await runWorkflow(
      workflow,
      options(
        initialStore,
        executorFrom(async (node) =>
          node.type === "agent" ? successfulAgentOutcome() : successfulOutcome(node.id),
        ),
        "run-open-forged-effects",
      ),
    );
    const initial = structuredClone(initialStore.events.slice(0, 2));
    const started = initial[1];
    if (started?.type !== "node_started") {
      throw new Error("read-only agent start was not recorded");
    }
    initial[1] = { ...started, effectProtocol: "flow.effects/v1" };
    const store = new MemoryRecoverableRunStore(initial);
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-open-forged-effects")),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events).toEqual(initial);
  });

  it("refuses a terminal run without mutating its ledger", async () => {
    const workflow = threeNodeWorkflow();
    const initial = await successfulLedger(workflow, "run-terminal");
    const store = new MemoryRecoverableRunStore(initial);
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-terminal")),
    ).rejects.toMatchObject({ code: "terminal_run" });
    expect(store.events).toEqual(initial);
    expect(store.releaseCalls).toEqual(["run-terminal"]);
  });

  it("refuses a workflow mismatch without mutating its ledger", async () => {
    const original = threeNodeWorkflow();
    const changed = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ordered-workflow }
nodes:
  - id: first
    type: command
    command: { executable: node, args: [--help] }
  - id: second
    type: command
    dependsOn: [first]
    command: { executable: node, args: [--version] }
  - id: third
    type: command
    dependsOn: [second]
    command: { executable: node, args: [--version] }
`);
    const initial = eventsThroughFirstSuccess(original);
    const store = new MemoryRecoverableRunStore(initial);
    const executor = executorFrom(async (node) => successfulOutcome(node.id));

    await expect(
      resumeWorkflow(changed, resumeOptions(store, executor, "run-resume")),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(store.events).toEqual(initial);
    expect(store.releaseCalls).toEqual(["run-resume"]);
  });

  it("refuses recovered history that violated graph dependency order", async () => {
    const workflow = threeNodeWorkflow();
    const initial: RunEvent[] = [
      {
        ...eventBase("run-resume", workflow.id, 1),
        type: "run_started",
        nodeIds: workflow.nodes.map((node) => node.id),
        workflowApiVersion: workflow.apiVersion,
        workflowDigest: workflowDigest(workflow),
      },
      {
        ...eventBase("run-resume", workflow.id, 2),
        type: "node_started",
        nodeId: "second",
        attempt: 1,
      },
      {
        ...eventBase("run-resume", workflow.id, 3),
        type: "node_succeeded",
        nodeId: "second",
        attempt: 1,
        evidence: commandEvidence("second", 0),
      },
    ];
    const store = new MemoryRecoverableRunStore(initial);
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-resume")),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(calls).toEqual([]);
    expect(store.events).toEqual(initial);
    expect(store.releaseCalls).toEqual(["run-resume"]);
  });

  it("refuses recovered history that skipped the scheduler-selected ready node", async () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: deterministic-ready-order }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [--version] }
  - id: first-ready
    type: command
    dependsOn: [root]
    command: { executable: node, args: [--version] }
  - id: later-ready
    type: command
    dependsOn: [root]
    command: { executable: node, args: [--help] }
`);
    const initial: RunEvent[] = [
      {
        ...eventBase("run-ready-order", workflow.id, 1),
        type: "run_started",
        nodeIds: workflow.nodes.map((node) => node.id),
        workflowApiVersion: workflow.apiVersion,
        workflowDigest: workflowDigest(workflow),
      },
      {
        ...eventBase("run-ready-order", workflow.id, 2),
        type: "node_started",
        nodeId: "root",
        attempt: 1,
      },
      {
        ...eventBase("run-ready-order", workflow.id, 3),
        type: "node_succeeded",
        nodeId: "root",
        attempt: 1,
        evidence: commandEvidence("root", 0),
      },
      {
        ...eventBase("run-ready-order", workflow.id, 4),
        type: "node_started",
        nodeId: "later-ready",
        attempt: 1,
      },
    ];
    const store = new MemoryRecoverableRunStore(initial);
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    await expect(
      resumeWorkflow(workflow, resumeOptions(store, executor, "run-ready-order")),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
    expect(calls).toEqual([]);
    expect(store.events).toEqual(initial);
  });

  it("finalizes a committed node failure without re-executing it", async () => {
    const workflow = threeNodeWorkflow();
    const initial = eventsThroughFirstSuccess(workflow);
    initial.push(
      {
        ...eventBase("run-resume", workflow.id, 4),
        type: "node_started",
        nodeId: "second",
        attempt: 1,
      },
      {
        ...eventBase("run-resume", workflow.id, 5),
        type: "node_failed",
        nodeId: "second",
        attempt: 1,
        error: {
          code: "command_failed",
          message: "verification failed",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: commandEvidence("second", 1),
      },
    );
    const store = new MemoryRecoverableRunStore(initial);
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      return successfulOutcome(node.id);
    });

    const state = await resumeWorkflow(workflow, resumeOptions(store, executor, "run-resume"));

    expect(calls).toEqual([]);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "second" });
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "run_resumed",
      "run_failed",
    ]);
  });

  it("rejects pre-cancelled recovery before claiming the run", async () => {
    const workflow = threeNodeWorkflow();
    const store = new MemoryRecoverableRunStore(eventsThroughFirstSuccess(workflow));
    const executor = executorFrom(async (node) => successfulOutcome(node.id));
    const controller = new AbortController();
    controller.abort("operator cancelled");

    await expect(
      resumeWorkflow(workflow, {
        ...resumeOptions(store, executor, "run-resume"),
        signal: controller.signal,
      }),
    ).rejects.toThrowError(RunWorkflowAbortedError);
    expect(store.claimCalls).toEqual([]);
    expect(store.releaseCalls).toEqual([]);
  });
});

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[];

  constructor(
    private readonly failingType?: RunEvent["type"],
    private readonly onAppend?: (event: RunEvent) => void,
    initialEvents: readonly RunEvent[] = [],
  ) {
    this.events = structuredClone([...initialEvents]);
  }

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.failingType) {
      throw new Error("injected persistence failure");
    }
    this.events.push(structuredClone(event));
    this.onAppend?.(event);
  }

  async read(): Promise<readonly RunEvent[]> {
    return this.events;
  }
}

class MemoryRecoverableRunStore extends MemoryRunStore implements RecoverableRunEventStore {
  readonly claimCalls: string[] = [];
  readonly releaseCalls: string[] = [];

  constructor(initialEvents: readonly RunEvent[]) {
    super(undefined, undefined, initialEvents);
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    this.claimCalls.push(runId);
    return structuredClone(this.events);
  }

  async release(runId: string): Promise<void> {
    this.releaseCalls.push(runId);
  }
}

function executorFrom(
  execute: (node: CompiledNode, context: NodeExecutionContext) => Promise<NodeExecutionOutcome>,
): NodeExecutor {
  return { execute };
}

function options(store: RunEventStore, executor: NodeExecutor, runId: string) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    runId,
    store,
    executor,
    now: () => new Date("2026-08-06T15:00:00.000Z"),
  };
}

function resumeOptions(store: RecoverableRunEventStore, executor: NodeExecutor, runId: string) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    runId,
    store,
    executor,
    now: () => new Date("2026-08-06T15:00:00.000Z"),
  };
}

function eventsThroughFirstSuccess(workflow: ReturnType<typeof threeNodeWorkflow>): RunEvent[] {
  return [
    {
      ...eventBase("run-resume", workflow.id, 1),
      type: "run_started",
      nodeIds: workflow.nodes.map((node) => node.id),
      workflowApiVersion: workflow.apiVersion,
      workflowDigest: workflowDigest(workflow),
    },
    {
      ...eventBase("run-resume", workflow.id, 2),
      type: "node_started",
      nodeId: "first",
      attempt: 1,
    },
    {
      ...eventBase("run-resume", workflow.id, 3),
      type: "node_succeeded",
      nodeId: "first",
      attempt: 1,
      evidence: commandEvidence("first", 0),
    },
  ];
}

async function successfulLedger(
  workflow: ReturnType<typeof threeNodeWorkflow>,
  runId: string,
): Promise<RunEvent[]> {
  const store = new MemoryRunStore();
  const executor = executorFrom(async (node) => successfulOutcome(node.id));
  await runWorkflow(workflow, options(store, executor, runId));
  return structuredClone(store.events);
}

function workflowDigest(workflow: ReturnType<typeof threeNodeWorkflow>): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}

function eventBase(runId: string, workflowId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: "2026-08-06T15:00:00.000Z",
    runId,
    workflowId,
  };
}

function threeNodeWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ordered-workflow }
nodes:
  - id: first
    type: command
    command: { executable: node, args: [--version] }
  - id: second
    type: command
    dependsOn: [first]
    command: { executable: node, args: [--version] }
  - id: third
    type: command
    dependsOn: [second]
    command: { executable: node, args: [--version] }
`);
}

function goalWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: goal-workflow }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: verified-change }
  outcome: Deterministic verification accepts the change.
  criteria:
    - id: verification-passes
      description: Verification passes.
      verifier: { nodeId: verify }
nodes:
  - id: prepare
    type: command
    command: { executable: node, args: [--version] }
  - id: verify
    type: command
    dependsOn: [prepare]
    command: { executable: npm, args: [test] }
`);
}

function modelVerifierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: model-verifier-workflow }
nodes:
  - id: source
    type: command
    command: { executable: node, args: [--version] }
  - id: review
    type: verifier
    dependsOn: [source]
    verifier:
      kind: model
      prompt: Decide whether the command output proves the change is valid.
      evidence: [{ nodeId: source, field: command.stdout }]
      model: { provider: test, id: deterministic }
`);
}

function readOnlyAgentWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: read-only-agent-workflow }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Inspect the workspace.
      model: { provider: test, id: deterministic }
      tools: [read]
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: node, args: [--version] }
`);
}

function successfulOutcome(nodeId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: commandEvidence(nodeId, 0),
  };
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  const text = "analyzed";
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function commandEvidence(nodeId: string, exitCode: number) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [nodeId],
    exitCode,
    signal: null,
    stdout: nodeId,
    stderr: "",
    stdoutHash: createHash("sha256").update(nodeId).digest("hex"),
    stderrHash: createHash("sha256").update("").digest("hex"),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}
