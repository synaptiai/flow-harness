import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import {
  resumeWorkflow,
  RunCancellation,
  runWorkflow,
} from "../../../src/application/run-workflow.js";
import type { CommandEvidence, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("typed result workflow execution", () => {
  it("publishes a canonical typed result without executing the result node", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultWorkflow(), {
      ...options(store, executorFor(calls, '{ "score": 1, "accepted": true }')),
      runId: "run-result-success",
    });

    expect(calls).toEqual(["produce"]);
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node_result_published",
          nodeId: "publish",
          canonicalValue: '{"accepted":true,"score":1}',
          valueHash: sha256('{"accepted":true,"score":1}'),
        }),
      ]),
    );
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 1 },
      nodes: { publish: { status: "succeeded", control: { kind: "result" } } },
    });
  });

  it.each([
    ["malformed JSON", "not-json", false, "result_invalid_json"],
    ["schema mismatch", '{"accepted":true,"score":2}', false, "result_schema_mismatch"],
    ["truncated source", '{"accepted":true,"score":1}', true, "result_source_truncated"],
  ])("fails closed for %s", async (_name, stdout, truncated, code) => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultWorkflow(), {
      ...options(store, executorFor(calls, stdout, truncated)),
      runId: `run-result-${code}`,
    });

    expect(calls).toEqual(["produce"]);
    expect(store.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "node_control_failed",
        nodeId: "publish",
        error: expect.objectContaining({ code, retryable: false, sideEffectStatus: "none" }),
      }),
      expect.objectContaining({ type: "run_failed", failedNodeId: "publish" }),
    ]);
    expect(state).toMatchObject({ status: "failed", nodes: { publish: { status: "failed" } } });
  });

  it("composes result.value through the ordinary evidence contract", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(composedResultWorkflow(), {
      ...options(store, executorFor(calls, "true")),
      runId: "run-result-composed",
    });

    expect(calls).toEqual(["produce"]);
    expect(store.events.filter((event) => event.type === "node_result_published")).toHaveLength(2);
    expect(state.nodes.final).toMatchObject({
      status: "succeeded",
      control: {
        kind: "result",
        sourceNodeId: "first",
        sourceField: "result.value",
        canonicalValue: "true",
      },
    });
    expect(state.resources.nodeStarts).toBe(1);
  });

  it("routes a condition from canonical result.value evidence", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultConditionWorkflow(), {
      ...options(store, executorFor(calls, "true")),
      runId: "run-result-condition",
    });

    expect(calls).toEqual(["produce", "selected", "finish"]);
    expect(state.nodes.route).toMatchObject({
      status: "succeeded",
      control: {
        kind: "condition",
        sourceNodeId: "publish",
        sourceField: "result.value",
        sourceHash: sha256("true"),
        selectedCase: "accepted",
      },
    });
  });

  it("binds canonical result.value into a durable approval request", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultApprovalWorkflow(), {
      ...options(store, executorFor(calls, "true")),
      runId: "run-result-approval",
    });

    expect(calls).toEqual(["produce"]);
    expect(state.status).toBe("waiting_for_approval");
    expect(store.events.at(-1)).toMatchObject({
      type: "workflow_approval_requested",
      nodeId: "review",
      request: {
        evidence: [
          {
            sourceNodeId: "publish",
            sourceField: "result.value",
            sourceHash: sha256("true"),
          },
        ],
      },
    });
  });

  it("passes canonical result.value to a model verifier", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const raw = '{"verdict":"accepted","reason":"typed result accepted"}';
    const executor: NodeExecutor = {
      async execute(node, context): Promise<NodeExecutionOutcome> {
        calls.push(node.id);
        if (node.type === "command") {
          return { status: "succeeded", evidence: commandEvidence("true", false) };
        }
        if (node.type !== "verifier" || node.verifier.kind !== "model") {
          throw new Error(`control node "${node.id}" reached the executor`);
        }
        const verifierSources = context.verifierSources;
        if (verifierSources === undefined) {
          throw new Error("model verifier must receive its declared result source");
        }
        expect(verifierSources).toEqual([
          {
            sourceNodeId: "publish",
            sourceAttempt: 1,
            sourceField: "result.value",
            sourceHash: sha256("true"),
            value: "true",
            truncated: false,
          },
        ]);
        return {
          status: "succeeded",
          evidence: {
            kind: "verifier",
            driver: "model",
            result: "parsed",
            verdict: "accepted",
            reason: "typed result accepted",
            reasonHash: sha256("typed result accepted"),
            durationMs: 1,
            sources: verifierSources.map((source) => ({
              sourceNodeId: source.sourceNodeId,
              sourceAttempt: source.sourceAttempt,
              sourceField: source.sourceField,
              sourceHash: source.sourceHash,
            })),
            provider: "test",
            model: "deterministic",
            raw,
            rawHash: sha256(raw),
            rawTruncated: false,
          },
        };
      },
    };

    const state = await runWorkflow(resultVerifierWorkflow(), {
      ...options(store, executor),
      runId: "run-result-verifier",
    });

    expect(calls).toEqual(["produce", "review"]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 2 },
      nodes: { review: { evidence: { kind: "verifier", verdict: "accepted" } } },
    });
  });

  it("terminates a bounded loop from canonical result.value evidence", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultLoopWorkflow(), {
      ...options(store, executorFor(calls, "true")),
      runId: "run-result-loop",
    });

    expect(calls).toEqual(["converge--i1--node--produce", "finish"]);
    expect(state.nodes["converge--i1--check"]).toMatchObject({
      control: {
        kind: "loop-check",
        sourceNodeId: "converge--i1--node--publish",
        sourceField: "result.value",
        sourceHash: sha256("true"),
        decision: "stop",
      },
    });
    expect(state.nodes.converge).toMatchObject({
      control: { kind: "loop", completedIterations: 1 },
    });
    expect(state.resources.nodeStarts).toBe(2);
  });

  it("gives resource exhaustion precedence over result publication", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const state = await runWorkflow(resultWorkflow("budget:\n  maxNodeStarts: 1"), {
      ...options(store, executorFor(calls, '{"accepted":true,"score":1}')),
      runId: "run-result-budget",
    });

    expect(state).toMatchObject({
      status: "resource_exhausted",
      nodes: { publish: { status: "pending", attempt: 0 } },
    });
    expect(store.events.some((event) => event.type === "node_result_published")).toBe(false);
  });

  it("gives operator cancellation precedence over result publication", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore();
    const controller = new AbortController();
    const executor: NodeExecutor = {
      async execute(node) {
        calls.push(node.id);
        controller.abort(
          new RunCancellation(
            "operator cancelled",
            "operator:test",
            "08c7c7ec-cd77-4a4f-85a7-1302acc8f0ab",
          ),
        );
        return {
          status: "succeeded",
          evidence: commandEvidence('{"accepted":true,"score":1}', false),
        };
      },
    };

    const state = await runWorkflow(resultWorkflow(), {
      ...options(store, executor),
      runId: "run-result-cancelled",
      signal: controller.signal,
    });

    expect(calls).toEqual(["produce"]);
    expect(state).toMatchObject({
      status: "cancelled",
      nodes: { publish: { status: "pending", attempt: 0 } },
    });
    expect(store.events.some((event) => event.type === "node_result_published")).toBe(false);
  });

  it("gives source failure precedence over result publication", async () => {
    const store = new RecoverableMemoryStore();
    const executor: NodeExecutor = {
      async execute() {
        return {
          status: "failed",
          error: {
            code: "command_failed",
            message: "source command failed",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: {
            ...commandEvidence("", false),
            exitCode: 1,
          },
        };
      },
    };

    const state = await runWorkflow(resultWorkflow(), {
      ...options(store, executor),
      runId: "run-result-source-failed",
    });

    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "produce",
      nodes: { publish: { status: "pending", attempt: 0 } },
    });
    expect(store.events.some((event) => event.type === "node_result_published")).toBe(false);
  });

  it("resumes after a committed publication without republishing or rerunning its source", async () => {
    const calls: string[] = [];
    const store = new RecoverableMemoryStore("node_result_published");
    const workflow = resultWorkflow();
    const runId = "run-result-recovery";

    await expect(
      runWorkflow(workflow, {
        ...options(store, executorFor(calls, '{"accepted":true,"score":1}')),
        runId,
      }),
    ).rejects.toThrow(/injected post-commit failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executorFor(calls, '{"accepted":true,"score":1}')),
      runId,
    });

    expect(state.status).toBe("succeeded");
    expect(calls).toEqual(["produce"]);
    expect(store.events.filter((event) => event.type === "node_result_published")).toHaveLength(1);
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
    now: () => new Date("2026-08-08T00:30:00.000Z"),
  };
}

function executorFor(calls: string[], stdout: string, truncated = false): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.type !== "command") {
        throw new Error(`control node "${node.id}" reached the executor`);
      }
      calls.push(node.id);
      return { status: "succeeded", evidence: commandEvidence(stdout, truncated) };
    },
  };
}

function commandEvidence(stdout: string, stdoutTruncated: boolean): CommandEvidence {
  return {
    kind: "command",
    executable: "node",
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function resultWorkflow(workflowFields = ""): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: typed-result }
${workflowFields}
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema:
        type: object
        properties:
          score: { type: number, minimum: 0, maximum: 1 }
          accepted: { type: boolean }
        required: [score, accepted]
`);
}

function composedResultWorkflow(): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: composed-result }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: first
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
  - id: final
    type: result
    dependsOn: [first]
    result:
      source: { nodeId: first, field: result.value }
      schema: { type: boolean }
`);
}

function resultConditionWorkflow(): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-condition }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
  - id: route
    type: condition
    dependsOn: [publish]
    condition:
      source: { nodeId: publish, field: result.value }
      cases: [{ id: accepted, equals: "true" }]
      default: rejected
  - id: selected
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: accepted }
    command: { executable: node }
  - id: rejected
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: rejected }
    command: { executable: node }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: accepted, nodeId: selected }
        - { case: rejected, nodeId: rejected }
  - id: finish
    type: command
    dependsOn: [converge]
    command: { executable: node }
`);
}

function resultApprovalWorkflow(): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-approval }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
  - id: review
    type: approval
    dependsOn: [publish]
    approval:
      prompt: Approve the typed result.
      evidence: [{ nodeId: publish, field: result.value }]
  - id: finish
    type: command
    dependsOn: [review]
    command: { executable: node }
`);
}

function resultVerifierWorkflow(): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-verifier }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
  - id: review
    type: verifier
    dependsOn: [publish]
    verifier:
      kind: model
      prompt: Review the typed result.
      evidence: [{ nodeId: publish, field: result.value }]
      model: { provider: test, id: deterministic }
`);
}

function resultLoopWorkflow(): ReturnType<typeof compileWorkflowText> {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-loop }
nodes:
  - id: converge
    type: loop
    loop:
      maxIterations: 2
      until:
        source: { nodeId: publish, field: result.value }
        equals: "true"
      body:
        nodes:
          - id: produce
            type: command
            command: { executable: node }
          - id: publish
            type: result
            dependsOn: [produce]
            result:
              source: { nodeId: produce, field: command.stdout }
              schema: { type: boolean }
  - id: finish
    type: command
    dependsOn: [converge]
    command: { executable: node }
`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
