import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  NodeEffectReconciler,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("bounded concurrent workflow execution", () => {
  it("overlaps independent ready nodes without exceeding maxNodes", async () => {
    const leftRelease = deferred<void>();
    const rightRelease = deferred<void>();
    const leftStarted = deferred<void>();
    const rightStarted = deferred<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      if (node.id === "left" || node.id === "right") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        (node.id === "left" ? leftStarted : rightStarted).resolve();
        await (node.id === "left" ? leftRelease : rightRelease).promise;
        active -= 1;
      }
      return success(node.id);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(concurrentWorkflow(), options(store, executor, "run-overlap"));

    await leftStarted.promise;
    await settleTurns();
    const overlapped = calls.includes("right");
    leftRelease.resolve();
    rightRelease.resolve();
    const state = await running;

    expect(overlapped).toBe(true);
    expect(maxActive).toBe(2);
    expect(calls).toEqual(["root", "left", "right", "join"]);
    expect(state.status).toBe("succeeded");
  });

  it("defers a third ready node until the full admitted wave quiesces", async () => {
    const leftRelease = deferred<void>();
    const rightRelease = deferred<void>();
    const leftStarted = deferred<void>();
    const rightStarted = deferred<void>();
    const deferredStarted = deferred<void>();
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      if (node.id === "left" || node.id === "right" || node.id === "deferred") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (node.id === "left") {
          leftStarted.resolve();
          await leftRelease.promise;
        } else if (node.id === "right") {
          rightStarted.resolve();
          await rightRelease.promise;
        } else {
          deferredStarted.resolve();
        }
        active -= 1;
      }
      return success(node.id);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(
      concurrentWorkflow(true),
      options(store, executor, "run-capacity-waves"),
    );

    await Promise.all([leftStarted.promise, rightStarted.promise]);
    await settleTurns();
    expect(calls).not.toContain("deferred");
    leftRelease.resolve();
    rightRelease.resolve();
    await deferredStarted.promise;
    const state = await running;

    expect(maxActive).toBe(2);
    expect(calls).toEqual(["root", "left", "right", "deferred", "join"]);
    expect(state.status).toBe("succeeded");
  });

  it("commits starts and outcomes in declaration order when completion timing reverses", async () => {
    const leftRelease = deferred<void>();
    const rightRelease = deferred<void>();
    const leftStarted = deferred<void>();
    const rightStarted = deferred<void>();
    const rightFinished = deferred<void>();
    const completions: string[] = [];
    const executor = executorFrom(async (node) => {
      if (node.id === "left" || node.id === "right") {
        (node.id === "left" ? leftStarted : rightStarted).resolve();
        await (node.id === "left" ? leftRelease : rightRelease).promise;
        completions.push(node.id);
        if (node.id === "right") {
          rightFinished.resolve();
        }
      }
      return success(node.id);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(
      concurrentWorkflow(),
      options(store, executor, "run-outcome-order"),
    );

    await leftStarted.promise;
    await settleTurns();
    rightRelease.resolve();
    await Promise.race([rightFinished.promise, settleTurns()]);
    leftRelease.resolve();
    await running;

    expect(completions).toEqual(["right", "left"]);
    expect(eventNodeIds(store.events, "node_started")).toEqual(["root", "left", "right", "join"]);
    expect(outcomeNodeIds(store.events)).toEqual(["root", "left", "right", "join"]);
  });

  it("quiesces admitted siblings and starts no new work after a failure", async () => {
    const leftRelease = deferred<void>();
    const rightRelease = deferred<void>();
    const leftStarted = deferred<void>();
    const rightStarted = deferred<void>();
    const calls: string[] = [];
    let rightSettled = false;
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      if (node.id === "left") {
        leftStarted.resolve();
        await leftRelease.promise;
        return failure(node.id, "left failed");
      }
      if (node.id === "right") {
        rightStarted.resolve();
        await rightRelease.promise;
        rightSettled = true;
      }
      return success(node.id);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(
      concurrentWorkflow(true),
      options(store, executor, "run-failure-quiescence"),
    );

    await leftStarted.promise;
    await settleTurns();
    leftRelease.resolve();
    await settleTurns();
    expect(rightSettled).toBe(false);
    rightRelease.resolve();
    const state = await running;

    expect(rightSettled).toBe(true);
    expect(calls).toEqual(["root", "left", "right"]);
    expect(outcomeNodeIds(store.events)).toEqual(["root", "left", "right"]);
    expect(store.events.at(-1)).toMatchObject({
      type: "run_failed",
      failedNodeId: "left",
    });
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "left",
      nodes: { deferred: { status: "pending" }, join: { status: "pending" } },
    });
  });

  it("does not mask an admitted failure when the wave consumes the final node starts", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const state = await runWorkflow(concurrentStartBudgetFailureWorkflow(), {
      ...options(
        store,
        executorFrom(async (node) => {
          calls.push(node.id);
          return node.id === "left" ? failure(node.id, "left failed") : success(node.id);
        }),
        "run-concurrent-final-start-failure",
      ),
    });

    expect(calls).toEqual(["root", "left", "right"]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "left",
      budget: {
        exhausted: [{ dimension: "nodeStarts", limit: 3, consumed: 3 }],
      },
      nodes: { deferred: { status: "pending" }, join: { status: "pending" } },
    });
    expect(store.events.at(-1)).toMatchObject({
      type: "run_failed",
      failedNodeId: "left",
    });
  });

  it("cancels and settles every node in an admitted wave before returning", async () => {
    const leftStarted = deferred<void>();
    const rightStarted = deferred<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    const settled: string[] = [];
    const executor = executorFrom(async (node, signal) => {
      calls.push(node.id);
      if (node.id === "left" || node.id === "right") {
        (node.id === "left" ? leftStarted : rightStarted).resolve();
        await aborted(signal);
        settled.push(node.id);
      }
      return success(node.id);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(concurrentWorkflow(), {
      ...options(store, executor, "run-cancel-wave"),
      signal: controller.signal,
    });

    await leftStarted.promise;
    await settleTurns();
    controller.abort("operator cancelled");
    const state = await running;

    expect(calls).toEqual(["root", "left", "right"]);
    expect(settled).toEqual(["left", "right"]);
    expect(store.events.at(-1)).toMatchObject({
      type: "run_cancelled",
      cancelledNodeIds: ["left", "right"],
    });
    expect(state.status).toBe("cancelled");
  });

  it("fresh-retries every proof-safe open attempt before one resume marker", async () => {
    const workflow = recoverableConcurrentWorkflow();
    const store = new MemoryRunStore();
    const calls: string[] = [];
    const executor = executorFrom(async (node, _signal, attempt) => {
      calls.push(`${node.id}:${attempt}`);
      return successFor(node);
    });
    store.failNext((event) => event.type === "node_succeeded" && event.nodeId === "left");

    await expect(
      runWorkflow(workflow, options(store, executor, "run-concurrent-recovery")),
    ).rejects.toThrowError(/injected persistence failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executor, "run-concurrent-recovery"),
      runId: "run-concurrent-recovery",
    });

    expect(eventNodeIds(store.events, "node_attempt_interrupted")).toEqual(["left", "right"]);
    expect(store.events.filter((event) => event.type === "run_resumed")).toHaveLength(1);
    expect(calls).toEqual(["root:1", "left:1", "right:1", "left:2", "right:2", "join:1"]);
    expect(state.status).toBe("succeeded");
  });

  it("replays several interruption dispositions after a crash before run_resumed", async () => {
    const workflow = recoverableConcurrentWorkflow();
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => successFor(node));
    store.failNext((event) => event.type === "node_succeeded" && event.nodeId === "left");
    await expect(
      runWorkflow(workflow, options(store, executor, "run-concurrent-resume-marker")),
    ).rejects.toThrowError(/injected persistence failure/i);
    store.failNext((event) => event.type === "run_resumed");

    await expect(
      resumeWorkflow(workflow, {
        ...options(store, executor, "run-concurrent-resume-marker"),
        runId: "run-concurrent-resume-marker",
      }),
    ).rejects.toThrowError(/injected persistence failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executor, "run-concurrent-resume-marker"),
      runId: "run-concurrent-resume-marker",
    });

    expect(eventNodeIds(store.events, "node_attempt_interrupted")).toEqual(["left", "right"]);
    expect(store.events.filter((event) => event.type === "run_resumed")).toHaveLength(1);
    expect(state.status).toBe("succeeded");
  });

  it("disposes a safe open sibling after a prior failure outcome was committed", async () => {
    const workflow = recoverableConcurrentWorkflow();
    const store = new MemoryRunStore();
    const calls: string[] = [];
    const executor = executorFrom(async (node, _signal, attempt) => {
      calls.push(`${node.id}:${attempt}`);
      if (node.id === "left") {
        return agentFailure(node, "left failed");
      }
      return successFor(node);
    });
    store.failNext((event) => event.type === "node_succeeded" && event.nodeId === "right");

    await expect(
      runWorkflow(workflow, options(store, executor, "run-partial-failed-wave")),
    ).rejects.toThrowError(/injected persistence failure/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executor, "run-partial-failed-wave"),
      runId: "run-partial-failed-wave",
    });

    expect(eventNodeIds(store.events, "node_attempt_interrupted")).toEqual(["right"]);
    expect(calls).toEqual(["root:1", "left:1", "right:1"]);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "left" });
  });

  it("runs a selected conditional fork concurrently and converges through its explicit join", async () => {
    const leftRelease = deferred<void>();
    const rightRelease = deferred<void>();
    const leftStarted = deferred<void>();
    const calls: string[] = [];
    const executor = executorFrom(async (node) => {
      calls.push(node.id);
      if (node.id === "left" || node.id === "right") {
        if (node.id === "left") {
          leftStarted.resolve();
        }
        await (node.id === "left" ? leftRelease : rightRelease).promise;
      }
      if (node.id === "classify") {
        return commandSuccessWithStdout(node.id, "selected\n");
      }
      return successFor(node);
    });
    const store = new MemoryRunStore();
    const running = runWorkflow(conditionalConcurrentWorkflow(), {
      ...options(store, executor, "run-conditional-concurrent"),
    });

    await leftStarted.promise;
    await settleTurns();
    const overlapped = calls.includes("right");
    leftRelease.resolve();
    rightRelease.resolve();
    const state = await running;

    expect(overlapped).toBe(true);
    expect(calls).toEqual(["classify", "left", "right", "branch-terminal", "final"]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        alternative: { status: "omitted" },
        converge: { status: "succeeded", control: { kind: "join" } },
      },
    });
  });

  it("settles an earlier wave before requesting a later command approval", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const state = await runWorkflow(approvalBarrierWorkflow(), {
      ...options(
        store,
        executorFrom(async (node) => {
          calls.push(node.id);
          return successFor(node);
        }),
        "run-concurrent-approval",
      ),
    });

    expect(calls).toEqual(["root", "left"]);
    expect(state.status).toBe("waiting_for_approval");
    expect(store.events.at(-1)).toMatchObject({
      type: "command_approval_requested",
      nodeId: "approved",
    });
    const leftOutcome = store.events.findIndex(
      (event) => event.type === "node_succeeded" && event.nodeId === "left",
    );
    expect(leftOutcome).toBeGreaterThanOrEqual(0);
    expect(leftOutcome).toBeLessThan(store.events.length - 1);
  });

  it("preserves a complete admitted wave before terminal settlement exhaustion", async () => {
    const calls: string[] = [];
    const store = new MemoryRunStore();
    const state = await runWorkflow(concurrentBudgetWorkflow(), {
      ...options(
        store,
        executorFrom(async (node) => {
          calls.push(node.id);
          return {
            status: "succeeded",
            evidence: { ...commandEvidence(node.id, 0), durationMs: node.id === "root" ? 1 : 6 },
          };
        }),
        "run-concurrent-budget",
      ),
    });

    expect(calls).toEqual(["root", "left", "right"]);
    expect(outcomeNodeIds(store.events)).toEqual(["root", "left", "right"]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      resources: { executionMs: 13 },
      nodes: { join: { status: "pending" } },
    });
  });

  it("reconciles every concurrent open edit before retrying either attempt", async () => {
    const workflow = recoverableConcurrentWorkflow(true);
    const store = new MemoryRunStore();
    const calls: string[] = [];
    const observedTargets: string[] = [];
    const executor = executorFrom(async (node, _signal, attempt, context) => {
      calls.push(`${node.id}:${attempt}`);
      if (node.type === "agent" && attempt === 1) {
        await context.effectJournal?.prepare(effectDescriptor(node.id));
        return agentFailure(node, "process interrupted with an open effect");
      }
      return successFor(node);
    });
    const reconciler: NodeEffectReconciler = {
      async reconcile(descriptor, publish): Promise<void> {
        observedTargets.push(descriptor.target);
        if (descriptor.kind !== "filesystem.edit") {
          throw new Error("expected an edit effect");
        }
        await publish({
          outcome: "not_applied",
          reason: "target_matches_before",
          observedSha256: descriptor.beforeSha256,
          observedMode: descriptor.mode,
        });
      },
    };

    await expect(
      runWorkflow(workflow, options(store, executor, "run-concurrent-effects")),
    ).rejects.toThrowError(/effect|settle|open/i);

    const state = await resumeWorkflow(workflow, {
      ...options(store, executor, "run-concurrent-effects"),
      runId: "run-concurrent-effects",
      effectReconciler: reconciler,
    });

    expect(observedTargets).toEqual(["/workspace/left.ts", "/workspace/right.ts"]);
    expect(eventNodeIds(store.events, "node_effect_reconciled")).toEqual(["left", "right"]);
    expect(eventNodeIds(store.events, "node_attempt_interrupted")).toEqual(["left", "right"]);
    expect(calls).toEqual(["root:1", "left:1", "right:1", "left:2", "right:2", "join:1"]);
    expect(state.status).toBe("succeeded");
  });

  it("archives a safe concurrent attempt but remains blocked on an open command", async () => {
    const workflow = mixedRecoveryWorkflow();
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node) => successFor(node));
    store.failNext((event) => event.type === "node_succeeded" && event.nodeId === "agent-branch");
    await expect(
      runWorkflow(workflow, options(store, executor, "run-mixed-recovery")),
    ).rejects.toThrowError(/injected persistence failure/i);

    await expect(
      resumeWorkflow(workflow, {
        ...options(store, executor, "run-mixed-recovery"),
        runId: "run-mixed-recovery",
      }),
    ).rejects.toThrowError(/command-branch.*no committed outcome/i);

    expect(eventNodeIds(store.events, "node_attempt_interrupted")).toEqual(["agent-branch"]);
    expect(store.events.some((event) => event.type === "run_resumed")).toBe(false);
  });
});

function concurrentWorkflow(includeDeferred = false) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-workflow }
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
${
  includeDeferred
    ? `  - id: deferred
    type: command
    dependsOn: [root]
    command: { executable: node, args: [deferred] }
`
    : ""
}  - id: join
    type: command
    dependsOn: [left, right${includeDeferred ? ", deferred" : ""}]
    command: { executable: node, args: [join] }
`);
}

function recoverableConcurrentWorkflow(withEdits = false) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: recoverable-concurrent-workflow }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [root] }
  - id: left
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze the left branch.
      model: { provider: test, id: deterministic }
      tools: [${withEdits ? "edit" : ""}]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: right
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze the right branch.
      model: { provider: test, id: deterministic }
      tools: [${withEdits ? "edit" : ""}]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: join
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [join] }
`);
}

function conditionalConcurrentWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditional-concurrent-workflow }
concurrency: { maxNodes: 2 }
nodes:
  - id: classify
    type: command
    command: { executable: node, args: [classify] }
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: command.stdout }
      cases:
        - { id: selected, equals: "selected\\n" }
      default: alternative
  - id: left
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: selected }
    command: { executable: node, args: [left] }
  - id: right
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: selected }
    command: { executable: node, args: [right] }
  - id: branch-terminal
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [branch-terminal] }
  - id: alternative
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: alternative }
    command: { executable: node, args: [alternative] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: selected, nodeId: branch-terminal }
        - { case: alternative, nodeId: alternative }
  - id: final
    type: command
    dependsOn: [converge]
    command: { executable: node, args: [final] }
`);
}

function approvalBarrierWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-approval-workflow }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [root] }
  - id: left
    type: command
    dependsOn: [root]
    command: { executable: node, args: [left] }
  - id: approved
    type: command
    dependsOn: [root]
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [approved] }
  - id: join
    type: command
    dependsOn: [left, approved]
    command: { executable: node, args: [join] }
`);
}

function concurrentBudgetWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-budget-workflow }
budget: { maxExecutionMs: 10 }
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
  - id: join
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [join] }
`);
}

function concurrentStartBudgetFailureWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-start-budget-failure-workflow }
budget: { maxNodeStarts: 3 }
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
  - id: deferred
    type: command
    dependsOn: [root]
    command: { executable: node, args: [deferred] }
  - id: join
    type: command
    dependsOn: [left, right, deferred]
    command: { executable: node, args: [join] }
`);
}

function mixedRecoveryWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: mixed-recovery-workflow }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [root] }
  - id: agent-branch
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze safely.
      model: { provider: test, id: deterministic }
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: command-branch
    type: command
    dependsOn: [root]
    command: { executable: node, args: [command-branch] }
  - id: join
    type: command
    dependsOn: [agent-branch, command-branch]
    command: { executable: node, args: [join] }
`);
}

function executorFrom(
  execute: (
    node: CompiledNode,
    signal: AbortSignal | undefined,
    attempt: number,
    context: NodeExecutionContext,
  ) => Promise<NodeExecutionOutcome>,
): NodeExecutor {
  return {
    async execute(node, context): Promise<NodeExecutionOutcome> {
      return await execute(node, context.signal, context.attempt, context);
    },
  };
}

function options(store: RecoverableRunEventStore, executor: NodeExecutor, runId: string) {
  return {
    cwd: "/workspace",
    protectedPaths: [".flow", ".git"],
    store,
    executor,
    runId,
  };
}

function success(nodeId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: commandEvidence(nodeId, 0),
  };
}

function successFor(node: CompiledNode): NodeExecutionOutcome {
  if (node.type === "agent") {
    const text = `${node.id} complete`;
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
  return success(node.id);
}

function agentFailure(node: CompiledNode, message: string): NodeExecutionOutcome {
  const succeeded = successFor(node);
  if (succeeded.evidence?.kind !== "agent") {
    throw new Error("agent failure helper requires an agent node");
  }
  return {
    status: "failed",
    error: {
      code: "agent_interrupted",
      message,
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: succeeded.evidence,
  };
}

function commandSuccessWithStdout(nodeId: string, stdout: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      ...commandEvidence(nodeId, 0),
      stdout,
      stdoutHash: sha256(stdout),
    },
  };
}

function effectDescriptor(nodeId: string) {
  return {
    kind: "filesystem.edit" as const,
    target: `/workspace/${nodeId}.ts`,
    operationDigest: sha256(`operation:${nodeId}`),
    beforeSha256: sha256(`before:${nodeId}`),
    afterSha256: sha256(`after:${nodeId}`),
    mode: 0o644,
  };
}

function failure(nodeId: string, message: string): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "command_failed",
      message,
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: commandEvidence(nodeId, 1),
  };
}

function commandEvidence(nodeId: string, exitCode: number) {
  const stdout = `${nodeId}\n`;
  return {
    kind: "command" as const,
    executable: "node",
    args: [nodeId],
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function eventNodeIds(
  events: readonly RunEvent[],
  type: "node_started" | "node_attempt_interrupted" | "node_effect_reconciled",
): string[] {
  return events
    .filter(
      (event): event is Extract<RunEvent, { readonly type: typeof type }> => event.type === type,
    )
    .map((event) => event.nodeId);
}

function outcomeNodeIds(events: readonly RunEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<RunEvent, { readonly type: "node_succeeded" | "node_failed" }> =>
        event.type === "node_succeeded" || event.type === "node_failed",
    )
    .map((event) => event.nodeId);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settleTurns(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
}

class MemoryRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];
  private failure: ((event: RunEvent) => boolean) | undefined;

  async append(event: RunEvent): Promise<void> {
    if (this.failure?.(event) === true) {
      this.failure = undefined;
      throw new Error(`injected persistence failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    return await this.read(runId);
  }

  async release(_runId: string): Promise<void> {}

  failNext(predicate: (event: RunEvent) => boolean): void {
    this.failure = predicate;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
