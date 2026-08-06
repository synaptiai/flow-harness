import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RunWorkflowAbortedError, runWorkflow } from "../../../src/application/run-workflow.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
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

  it("overrides executor success when cancellation arrives during a node", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const controller = new AbortController();
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      controller.abort(new Error("operator cancelled"));
      return successfulOutcome(node.id);
    });

    const state = await runWorkflow(threeNodeWorkflow(), {
      ...options(store, executor, "run-mid-cancel"),
      signal: controller.signal,
    });

    expect(calls).toEqual(["first"]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "first",
      failureReason: "operator cancelled",
      nodes: { first: { status: "failed", error: { code: "workflow_aborted" } } },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_failed",
    ]);
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
});

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  constructor(
    private readonly failingType?: RunEvent["type"],
    private readonly onAppend?: (event: RunEvent) => void,
  ) {}

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

function executorFrom(
  execute: (node: CompiledNode, context: NodeExecutionContext) => Promise<NodeExecutionOutcome>,
): NodeExecutor {
  return { execute };
}

function options(store: RunEventStore, executor: NodeExecutor, runId: string) {
  return {
    cwd: process.cwd(),
    runId,
    store,
    executor,
    now: () => new Date("2026-08-06T15:00:00.000Z"),
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

function successfulOutcome(nodeId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: commandEvidence(nodeId, 0),
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
