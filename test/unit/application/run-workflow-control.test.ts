import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import {
  resumeWorkflow,
  runWorkflow,
  type RunRecoveryError,
} from "../../../src/application/run-workflow.js";
import type { CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("durable conditional workflow execution", () => {
  it("executes only the selected exact-match branch and reconciles at an explicit join", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(controlWorkflow(), {
      ...options(store, executorFor(calls, "needs-work\n")),
      runId: "run-control-selected",
    });

    expect(calls).toEqual(["classify", "implement", "verify-change", "verify-final"]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      controlGraph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            nodeId: "route",
            type: "condition",
            condition: {
              source: { nodeId: "classify", field: "command.stdout" },
              cases: [{ id: "needs-work", equals: "needs-work\n" }],
              default: "already-clean",
            },
          }),
          expect.objectContaining({
            nodeId: "converge",
            type: "join",
            dependsOn: ["verify-change", "inspect-clean"],
          }),
        ]),
      },
    });
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node_condition_evaluated",
          nodeId: "route",
          selectedCase: "needs-work",
          sourceHash: sha256("needs-work\n"),
        }),
        expect.objectContaining({
          type: "node_omitted",
          nodeId: "inspect-clean",
          reason: "condition_not_selected",
        }),
        expect.objectContaining({
          type: "node_joined",
          nodeId: "converge",
          completedNodeId: "verify-change",
          omittedNodeIds: ["inspect-clean"],
        }),
      ]),
    );
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 4 },
      nodes: {
        route: { status: "succeeded", attempt: 1 },
        "inspect-clean": { status: "omitted", attempt: 0 },
        converge: { status: "succeeded", attempt: 1 },
      },
    });
  });

  it("takes the default branch and propagates omission to its unselected descendants", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(controlWorkflow(), {
      ...options(store, executorFor(calls, "already-clean\n")),
      runId: "run-control-default",
    });

    expect(calls).toEqual(["classify", "inspect-clean", "verify-final"]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 3 },
      nodes: {
        route: { control: { kind: "condition", selectedCase: "already-clean" } },
        implement: {
          status: "omitted",
          omission: { reason: "condition_not_selected" },
        },
        "verify-change": {
          status: "omitted",
          omission: { reason: "dependency_omitted", omittedDependencies: ["implement"] },
        },
        converge: {
          control: { kind: "join", completedNodeId: "inspect-clean" },
        },
      },
    });
  });

  it("propagates an omitted outer branch through its nested condition and join", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type === "condition" || node.type === "join") {
          throw new Error(`control node "${node.id}" reached the executor`);
        }
        calls.push(node.id);
        if (node.type === "agent") {
          return agentSuccess();
        }
        const stdout = node.id === "classify-outer" ? "bypass\n" : `${node.id}\n`;
        return { status: "succeeded", evidence: commandEvidence(stdout, false) };
      },
    };

    const state = await runWorkflow(nestedControlWorkflow(), {
      ...options(store, executor),
      runId: "run-nested-omission",
    });

    expect(calls).toEqual(["classify-outer", "bypass", "verify-final"]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "classify-inner": { status: "omitted" },
        "route-inner": { status: "omitted" },
        change: { status: "omitted" },
        clean: { status: "omitted" },
        "join-inner": {
          status: "omitted",
          omission: {
            reason: "dependency_omitted",
            omittedDependencies: ["change", "clean"],
          },
        },
        "join-outer": { status: "succeeded" },
      },
    });
  });

  it.each([
    ["command stderr", "command" as const, "command.stderr" as const],
    ["agent text", "agent" as const, "agent.text" as const],
  ])("routes exact values from %s evidence", async (_name, sourceType, sourceField) => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type === "condition" || node.type === "join") {
          throw new Error(`control node "${node.id}" reached the executor`);
        }
        calls.push(node.id);
        if (node.type === "agent") {
          return agentSuccess("matched");
        }
        return {
          status: "succeeded",
          evidence:
            node.id === "classify" && sourceField === "command.stderr"
              ? commandEvidenceWithStreams("", "matched", false)
              : commandEvidence(`${node.id}\n`, false),
        };
      },
    };

    const state = await runWorkflow(sourceFieldControlWorkflow(sourceType, sourceField), {
      ...options(store, executor),
      runId: `run-control-${sourceType}`,
    });

    expect(calls).toEqual(["classify", "selected", "verify-final"]);
    expect(state.nodes.route).toMatchObject({
      status: "succeeded",
      control: { kind: "condition", sourceField, selectedCase: "matched" },
    });
  });

  it("fails closed when a condition source was truncated", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(controlWorkflow(), {
      ...options(store, executorFor(calls, "needs-work\n", true)),
      runId: "run-control-truncated",
    });

    expect(calls).toEqual(["classify"]);
    expect(store.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "node_control_failed",
        nodeId: "route",
        error: expect.objectContaining({
          code: "condition_source_truncated",
          retryable: false,
          sideEffectStatus: "none",
        }),
      }),
      expect.objectContaining({ type: "run_failed", failedNodeId: "route" }),
    ]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "route",
      nodes: { route: { status: "failed", attempt: 1 } },
    });
  });

  it.each([
    ["condition decision", "node_condition_evaluated" as const],
    ["branch omission", "node_omitted" as const],
    ["join", "node_joined" as const],
  ])("recovers after a committed %s without re-executing durable work", async (_name, failType) => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore(failType);
    const workflow = controlWorkflow();
    const runId = `run-control-recovery-${failType}`;

    await expect(
      runWorkflow(workflow, {
        ...options(store, executorFor(calls, "needs-work\n")),
        runId,
      }),
    ).rejects.toThrowError(/injected post-commit failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executorFor(calls, "needs-work\n")),
      runId,
    });

    expect(calls).toEqual(["classify", "implement", "verify-change", "verify-final"]);
    expect(store.events.filter((event) => event.type === failType)).toHaveLength(1);
    expect(
      store.events.filter((event) => event.type === "node_started" && event.nodeId === "classify"),
    ).toHaveLength(1);
    expect(state.status).toBe("succeeded");
  });

  it("recovers a committed typed control failure without re-executing its source", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore("node_control_failed");
    const workflow = controlWorkflow();

    await expect(
      runWorkflow(workflow, {
        ...options(store, executorFor(calls, "needs-work\n", true)),
        runId: "run-control-failure-recovery",
      }),
    ).rejects.toThrowError(/injected post-commit failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executorFor(calls, "needs-work\n", true)),
      runId: "run-control-failure-recovery",
    });

    expect(calls).toEqual(["classify"]);
    expect(store.events.filter((event) => event.type === "node_control_failed")).toHaveLength(1);
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "run_resumed",
      "run_failed",
    ]);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "route" });
  });

  it("rejects a valid but changed persisted control graph before recovery mutates the log", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore("node_succeeded");
    const workflow = controlWorkflow();

    await expect(
      runWorkflow(workflow, {
        ...options(store, executorFor(calls, "needs-work\n")),
        runId: "run-control-mismatch",
      }),
    ).rejects.toThrowError(/injected post-commit failure/i);
    const started = store.events[0];
    if (started?.type !== "run_started" || started.controlGraph === undefined) {
      throw new Error("expected persisted control graph");
    }
    const changed = structuredClone(started);
    const changedGraph = changed.controlGraph;
    if (changedGraph === undefined) {
      throw new Error("expected cloned control graph");
    }
    const route = changedGraph.nodes.find((node) => node.nodeId === "route");
    if (route?.type !== "condition") {
      throw new Error("expected condition graph node");
    }
    store.events[0] = {
      ...changed,
      controlGraph: {
        nodes: changedGraph.nodes.map((node) =>
          node.nodeId === "route" && node.type === "condition"
            ? {
                ...node,
                condition: {
                  ...node.condition,
                  cases: [{ id: "needs-work", equals: "changed\n" }],
                },
              }
            : node,
        ),
      },
    };
    const eventCount = store.events.length;

    await expect(
      resumeWorkflow(workflow, {
        ...options(store, executorFor(calls, "needs-work\n")),
        runId: "run-control-mismatch",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RunRecoveryError>>({ code: "workflow_mismatch" }),
    );
    expect(store.events).toHaveLength(eventCount);
    expect(calls).toEqual(["classify"]);
  });
});

class RecoverableMemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  constructor(private failAfterType?: RunEvent["type"]) {}

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
    if (event.type === this.failAfterType) {
      this.failAfterType = undefined;
      throw new Error("injected post-commit failure");
    }
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

function options(store: RecoverableRunEventStore, executor: NodeExecutor) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    store,
    executor,
    now: () => new Date("2026-08-07T18:30:00.000Z"),
  };
}

function executorFor(calls: string[], classifier: string, truncated = false): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.type === "condition" || node.type === "join") {
        throw new Error(`control node "${node.id}" reached the executor`);
      }
      calls.push(node.id);
      if (node.type === "agent") {
        return agentSuccess();
      }
      return {
        status: "succeeded",
        evidence: commandEvidence(node.id === "classify" ? classifier : `${node.id}\n`, truncated),
      };
    },
  };
}

function commandEvidence(stdout: string, stdoutTruncated: boolean): CommandEvidence {
  return commandEvidenceWithStreams(stdout, "", stdoutTruncated);
}

function commandEvidenceWithStreams(
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
): CommandEvidence {
  return {
    kind: "command",
    executable: "node",
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
    stdoutTruncated,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function agentSuccess(text = "implemented"): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function controlWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditional-control }
nodes:
  - id: classify
    type: command
    command: { executable: node, args: [scripts/classify.mjs] }
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: command.stdout }
      cases:
        - { id: needs-work, equals: "needs-work\\n" }
      default: already-clean
  - id: implement
    type: agent
    dependsOn: [route]
    when: { conditionId: route, case: needs-work }
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
  - id: verify-change
    type: command
    dependsOn: [implement]
    command: { executable: npm, args: [test] }
  - id: inspect-clean
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: already-clean }
    command: { executable: node, args: [--version] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: needs-work, nodeId: verify-change }
        - { case: already-clean, nodeId: inspect-clean }
  - id: verify-final
    type: command
    dependsOn: [converge]
    command: { executable: npm, args: [test] }
`);
}

function sourceFieldControlWorkflow(
  sourceType: "command" | "agent",
  sourceField: "command.stderr" | "agent.text",
) {
  const sourceNode =
    sourceType === "command"
      ? `  - id: classify
    type: command
    command: { executable: node, args: [classify] }`
      : `  - id: classify
    type: agent
    agent:
      prompt: Classify this run.
      model: { provider: test, id: deterministic }`;
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${sourceType}-source-control }
nodes:
${sourceNode}
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: ${sourceField} }
      cases:
        - { id: matched, equals: matched }
      default: fallback
  - id: selected
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: matched }
    command: { executable: node, args: [selected] }
  - id: fallback
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: fallback }
    command: { executable: node, args: [fallback] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: matched, nodeId: selected }
        - { case: fallback, nodeId: fallback }
  - id: verify-final
    type: command
    dependsOn: [converge]
    command: { executable: node, args: [verify-final] }
`);
}

function nestedControlWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: nested-conditional-control }
nodes:
  - id: classify-outer
    type: command
    command: { executable: node, args: [classify-outer] }
  - id: route-outer
    type: condition
    dependsOn: [classify-outer]
    condition:
      source: { nodeId: classify-outer, field: command.stdout }
      cases:
        - { id: inner, equals: "inner\\n" }
      default: bypass
  - id: classify-inner
    type: command
    dependsOn: [route-outer]
    when: { conditionId: route-outer, case: inner }
    command: { executable: node, args: [classify-inner] }
  - id: route-inner
    type: condition
    dependsOn: [route-outer, classify-inner]
    when: { conditionId: route-outer, case: inner }
    condition:
      source: { nodeId: classify-inner, field: command.stdout }
      cases:
        - { id: change, equals: "change\\n" }
      default: clean
  - id: change
    type: command
    dependsOn: [route-inner]
    when: { conditionId: route-inner, case: change }
    command: { executable: node, args: [change] }
  - id: clean
    type: command
    dependsOn: [route-inner]
    when: { conditionId: route-inner, case: clean }
    command: { executable: node, args: [clean] }
  - id: join-inner
    type: join
    join:
      conditionId: route-inner
      branches:
        - { case: change, nodeId: change }
        - { case: clean, nodeId: clean }
  - id: bypass
    type: command
    dependsOn: [route-outer]
    when: { conditionId: route-outer, case: bypass }
    command: { executable: node, args: [bypass] }
  - id: join-outer
    type: join
    join:
      conditionId: route-outer
      branches:
        - { case: inner, nodeId: join-inner }
        - { case: bypass, nodeId: bypass }
  - id: verify-final
    type: command
    dependsOn: [join-outer]
    command: { executable: node, args: [verify-final] }
`);
}
