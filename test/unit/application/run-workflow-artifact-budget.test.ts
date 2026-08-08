import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type { CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("artifact-budgeted workflow scheduling", () => {
  it("settles equality and starts no downstream work", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const state = await runWorkflow(sequentialWorkflow(2), {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) => success(nodeId, "é")),
      ),
      runId: "run-artifact-equality",
    });

    expect(calls).toEqual(["prepare"]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { artifactBytes: 2 },
      budget: {
        remaining: { artifactBytes: 0 },
        exhausted: [{ dimension: "artifactBytes", limit: 2, consumed: 2 }],
      },
      nodes: { prepare: { status: "succeeded" }, verify: { status: "pending" } },
    });
  });

  it("quiesces a complete concurrency wave and retains its bounded overshoot", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const state = await runWorkflow(concurrentWorkflow(3), {
      ...options(
        store,
        recordingExecutor(calls, (nodeId) => success(nodeId, nodeId === "root" ? "" : "é")),
      ),
      runId: "run-artifact-wave-overshoot",
    });

    expect(calls).toEqual(["root", "left", "right"]);
    expect(outcomeNodeIds(store.events)).toEqual(["root", "left", "right"]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { artifactBytes: 4 },
      budget: {
        exhausted: [{ dimension: "artifactBytes", limit: 3, consumed: 4 }],
      },
      nodes: { finish: { status: "pending" } },
    });
  });

  it("prioritizes committed artifact settlement over later cancellation", async () => {
    const controller = new AbortController();
    const store = new MemoryRunStore(undefined, (event) => {
      if (event.type === "node_succeeded") {
        controller.abort(new Error("cancelled after durable output"));
      }
    });
    const state = await runWorkflow(sequentialWorkflow(2), {
      ...options(
        store,
        recordingExecutor([], (nodeId) => success(nodeId, "é")),
      ),
      runId: "run-artifact-cancel-race",
      signal: controller.signal,
    });

    expect(state.status).toBe("resource_exhausted");
    expect(store.events.at(-1)?.type).toBe("run_budget_exhausted");
  });

  it("recovers committed artifact evidence into the identical terminal exhaustion", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore("run_budget_exhausted");
    const workflow = sequentialWorkflow(2);
    const executor = recordingExecutor(calls, (nodeId) => success(nodeId, "é"));

    await expect(
      runWorkflow(workflow, {
        ...options(store, executor),
        runId: "run-artifact-recovery",
      }),
    ).rejects.toThrow(/injected append failure/i);
    expect(calls).toEqual(["prepare"]);

    store.failOn = undefined;
    const resumed = await resumeWorkflow(workflow, {
      ...options(store, executor),
      runId: "run-artifact-recovery",
    });

    expect(calls).toEqual(["prepare"]);
    expect(resumed).toMatchObject({
      status: "resource_exhausted",
      resources: { artifactBytes: 2 },
      budget: {
        remaining: { artifactBytes: 0 },
        exhausted: [{ dimension: "artifactBytes", limit: 2, consumed: 2 }],
      },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_resumed",
      "run_budget_exhausted",
    ]);
  });

  it("refuses recovery when only the persisted artifact ceiling differs", async () => {
    const store = new MemoryRunStore();
    const workflow = approvalWorkflow(10);
    await runWorkflow(workflow, {
      ...options(
        store,
        recordingExecutor([], (nodeId) => success(nodeId, "")),
      ),
      runId: "run-artifact-budget-mismatch",
    });
    const started = store.events[0];
    if (started?.type !== "run_started") {
      throw new Error("expected run_started");
    }
    store.events[0] = { ...started, budget: { maxArtifactBytes: 11 } };

    await expect(
      resumeWorkflow(workflow, {
        ...options(
          store,
          recordingExecutor([], (nodeId) => success(nodeId, "")),
        ),
        runId: "run-artifact-budget-mismatch",
      }),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });
  });
});

class MemoryRunStore implements RecoverableRunEventStore {
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

function options(store: MemoryRunStore, executor: NodeExecutor) {
  return {
    cwd: "/workspace",
    protectedPaths: [] as const,
    store,
    executor,
    now: () => new Date("2026-08-08T13:00:00.000Z"),
  };
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

function success(
  nodeId: string,
  stdout: string,
): { readonly status: "succeeded"; readonly evidence: CommandEvidence } {
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: "node",
      args: [nodeId],
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
}

function sequentialWorkflow(maxArtifactBytes: number) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: sequential-artifact-budget }
budget: { maxArtifactBytes: ${maxArtifactBytes} }
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

function concurrentWorkflow(maxArtifactBytes: number) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-artifact-budget }
budget: { maxArtifactBytes: ${maxArtifactBytes} }
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
  - id: finish
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [finish] }
`);
}

function approvalWorkflow(maxArtifactBytes: number) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-artifact-budget }
budget: { maxArtifactBytes: ${maxArtifactBytes} }
nodes:
  - id: verify
    type: command
    approval: { mode: required }
    command: { executable: node, args: [verify] }
`);
}

function outcomeNodeIds(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "node_succeeded" || event.type === "node_failed" ? [event.nodeId] : [],
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
