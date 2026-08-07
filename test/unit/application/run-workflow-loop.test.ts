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
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("bounded loop workflow execution", () => {
  it("continues one iteration, stops on exact evidence, and runs downstream work", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(loopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: loopExecutor(calls),
      runId: "run-loop-continues-once",
      now: () => new Date("2026-08-07T19:30:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "repair--i2--node--probe", "verify"]);
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node_loop_checked",
          nodeId: "repair--i1--check",
          iteration: 1,
          decision: "continue",
          sourceHash: sha256("again"),
        }),
        expect.objectContaining({
          type: "node_loop_checked",
          nodeId: "repair--i2--check",
          iteration: 2,
          decision: "stop",
          sourceHash: sha256("pass"),
        }),
        expect.objectContaining({
          type: "node_loop_completed",
          nodeId: "repair",
          completedIterations: 2,
          terminatingCheckNodeId: "repair--i2--check",
        }),
      ]),
    );
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 3 },
      nodes: {
        "repair--i1--check": { control: { kind: "loop-check", decision: "continue" } },
        "repair--i2--check": { control: { kind: "loop-check", decision: "stop" } },
        repair: {
          status: "succeeded",
          control: { kind: "loop", completedIterations: 2 },
        },
        verify: { status: "succeeded" },
      },
    });
  });

  it("stops early and durably omits every unused iteration", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(loopWorkflow(3), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "pass"),
      runId: "run-loop-stops-early",
      now: () => new Date("2026-08-07T19:31:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "verify"]);
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node_omitted",
          nodeId: "repair--i2--node--probe",
          reason: "loop_not_continued",
        }),
        expect.objectContaining({
          type: "node_omitted",
          nodeId: "repair--i3--node--probe",
          reason: "dependency_omitted",
        }),
      ]),
    );
    expect(state.nodes.repair).toMatchObject({
      status: "succeeded",
      control: { kind: "loop", completedIterations: 1 },
    });
    expect(state.resources.nodeStarts).toBe(2);
  });

  it("fails with loop_limit_reached and never starts downstream work", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(loopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "again"),
      runId: "run-loop-limit",
      now: () => new Date("2026-08-07T19:32:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "repair--i2--node--probe"]);
    expect(store.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "node_control_failed",
        nodeId: "repair",
        error: expect.objectContaining({ code: "loop_limit_reached" }),
      }),
      expect.objectContaining({ type: "run_failed", failedNodeId: "repair" }),
    ]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "repair",
      nodes: { verify: { status: "pending" } },
    });
  });

  it("fails closed when loop source evidence is truncated", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(loopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "pass", true),
      runId: "run-loop-truncated",
      now: () => new Date("2026-08-07T19:33:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe"]);
    expect(store.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: "node_control_failed",
        nodeId: "repair--i1--check",
        error: expect.objectContaining({ code: "loop_source_truncated" }),
      }),
      expect.objectContaining({ type: "run_failed", failedNodeId: "repair--i1--check" }),
    ]);
    expect(state.status).toBe("failed");
  });

  it("rejects an out-of-order durable loop check before recovery mutates the log", async () => {
    const calls: string[] = [];
    const store = new MemoryStore("second--i1--node--probe");
    const workflow = parallelLoopWorkflow();
    const runId = "run-loop-forged-check-order";

    await expect(
      runWorkflow(workflow, {
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor: commandExecutor(calls, () => "pass"),
        runId,
        now: () => new Date("2026-08-07T19:34:00.000Z"),
      }),
    ).rejects.toThrowError(/injected post-commit failure/i);

    const previous = store.events.at(-1);
    if (previous === undefined) {
      throw new Error("expected a committed source event");
    }
    store.events.push({
      version: 1,
      sequence: previous.sequence + 1,
      at: "2026-08-07T19:34:01.000Z",
      runId,
      workflowId: workflow.id,
      type: "node_loop_checked",
      nodeId: "second--i1--check",
      attempt: 1,
      loopId: "second",
      iteration: 1,
      sourceNodeId: "second--i1--node--probe",
      sourceAttempt: 1,
      sourceField: "command.stdout",
      sourceHash: sha256("pass"),
      decision: "stop",
    });
    const eventCount = store.events.length;

    await expect(
      resumeWorkflow(workflow, {
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor: commandExecutor(calls, () => "pass"),
        runId,
        now: () => new Date("2026-08-07T19:34:02.000Z"),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RunRecoveryError>>({ code: "workflow_mismatch" }),
    );
    expect(store.events).toHaveLength(eventCount);
  });

  it.each([
    ["loop check", "node_loop_checked" as const, 2],
    ["loop omission", "node_omitted" as const, 2],
    ["loop completion", "node_loop_completed" as const, 1],
  ])(
    "recovers after a committed %s without repeating its durable transition",
    async (_name, failType, expectedEventCount) => {
      const calls: string[] = [];
      const store = new MemoryStore(undefined, failType);
      const stopsEarly = failType === "node_omitted";
      const workflow = loopWorkflow();
      const executor = stopsEarly ? commandExecutor(calls, () => "pass") : loopExecutor(calls);
      const runId = `run-loop-recovery-${failType}`;

      await expect(
        runWorkflow(workflow, {
          cwd: process.cwd(),
          protectedPaths: [],
          store,
          executor,
          runId,
          now: () => new Date("2026-08-07T19:35:00.000Z"),
        }),
      ).rejects.toThrowError(/injected post-commit failure/i);

      const state = await resumeWorkflow(workflow, {
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor,
        runId,
        now: () => new Date("2026-08-07T19:35:01.000Z"),
      });

      expect(calls).toEqual(
        stopsEarly
          ? ["repair--i1--node--probe", "verify"]
          : ["repair--i1--node--probe", "repair--i2--node--probe", "verify"],
      );
      expect(store.events.filter((event) => event.type === failType)).toHaveLength(
        expectedEventCount,
      );
      expect(state.status).toBe("succeeded");
    },
  );

  it("allows body concurrency without iteration overlap", async () => {
    const calls: string[] = [];
    const active = new Set<string>();
    const siblingBarriers = new Map<
      number,
      { readonly promise: Promise<void>; readonly release: () => void; started: number }
    >();
    let maxActiveSiblings = 0;
    let crossIterationOverlap = false;
    const executor: NodeExecutor = {
      async execute(node): Promise<NodeExecutionOutcome> {
        if (node.type !== "command") {
          throw new Error(`control node "${node.id}" reached the executor`);
        }
        calls.push(node.id);
        if (node.id.includes("--i2--") && [...active].some((id) => id.includes("--i1--"))) {
          crossIterationOverlap = true;
        }
        active.add(node.id);
        try {
          const iteration = node.id.includes("--i1--") ? 1 : node.id.includes("--i2--") ? 2 : 0;
          if (iteration > 0 && (node.id.endsWith("--left") || node.id.endsWith("--right"))) {
            let barrier = siblingBarriers.get(iteration);
            if (barrier === undefined) {
              let release = (): void => undefined;
              const promise = new Promise<void>((resolve) => {
                release = resolve;
              });
              barrier = { promise, release, started: 0 };
              siblingBarriers.set(iteration, barrier);
            }
            barrier.started += 1;
            maxActiveSiblings = Math.max(
              maxActiveSiblings,
              [...active].filter(
                (id) => id.includes(`--i${iteration}--`) && /--(?:left|right)$/.test(id),
              ).length,
            );
            if (barrier.started === 2) {
              barrier.release();
            }
            await barrier.promise;
          }
          const stdout = node.id.includes("--i1--node--probe")
            ? "again"
            : node.id.includes("--i2--node--probe")
              ? "pass"
              : "ok";
          return { status: "succeeded", evidence: commandEvidence(stdout) };
        } finally {
          active.delete(node.id);
        }
      },
    };

    const state = await runWorkflow(concurrentBodyLoopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store: new MemoryStore(),
      executor,
      runId: "run-loop-body-concurrency",
      now: () => new Date("2026-08-07T19:36:00.000Z"),
    });

    expect(calls).toEqual([
      "repair--i1--node--setup",
      "repair--i1--node--left",
      "repair--i1--node--right",
      "repair--i1--node--probe",
      "repair--i2--node--setup",
      "repair--i2--node--left",
      "repair--i2--node--right",
      "repair--i2--node--probe",
      "verify",
    ]);
    expect(maxActiveSiblings).toBe(2);
    expect(crossIterationOverlap).toBe(false);
    expect(state.status).toBe("succeeded");
  });

  it("binds approval to one qualified loop instance and omits later requests", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const workflow = approvalLoopWorkflow();
    const runId = "run-loop-approval";
    const waiting = await runWorkflow(workflow, {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "pass"),
      runId,
      now: () => new Date("2026-08-07T19:37:00.000Z"),
    });

    expect(waiting.status).toBe("waiting_for_approval");
    expect(calls).toEqual([]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      approvalRequirements: [
        { nodeId: "repair--i1--node--probe", grantTtlMs: 120000 },
        { nodeId: "repair--i2--node--probe", grantTtlMs: 120000 },
      ],
    });
    const request = store.events.find((event) => event.type === "command_approval_requested");
    if (request?.type !== "command_approval_requested") {
      throw new Error("expected a durable loop approval request");
    }
    const grantedAt = "2026-08-07T19:37:01.000Z";
    store.events.push({
      version: 1,
      sequence: request.sequence + 1,
      at: grantedAt,
      runId,
      workflowId: workflow.id,
      type: "command_approval_granted",
      nodeId: request.nodeId,
      attempt: request.attempt,
      requestId: request.requestId,
      operationDigest: request.operationDigest,
      actor: "test-operator",
      expiresAt: new Date(Date.parse(grantedAt) + request.grantTtlMs).toISOString(),
    });

    const state = await resumeWorkflow(workflow, {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "pass"),
      runId,
      now: () => new Date("2026-08-07T19:37:02.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "verify"]);
    expect(
      store.events.filter((event) => event.type === "command_approval_requested"),
    ).toHaveLength(1);
    expect(state.nodes["repair--i1--node--probe"]?.approval).toMatchObject({
      status: "consumed",
    });
    expect(state.nodes["repair--i2--node--probe"]).toMatchObject({ status: "omitted" });
  });

  it("lets a node-start budget preempt the next iteration", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const state = await runWorkflow(budgetedLoopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "again"),
      runId: "run-loop-budget",
      now: () => new Date("2026-08-07T19:38:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe"]);
    expect(state).toMatchObject({
      status: "resource_exhausted",
      budget: { exhausted: [{ dimension: "nodeStarts", limit: 1, consumed: 1 }] },
      nodes: {
        "repair--i1--check": { status: "pending" },
        "repair--i2--node--probe": { status: "pending" },
      },
    });
    expect(store.events.at(-1)?.type).toBe("run_budget_exhausted");
  });

  it("cancels after a committed continue without admitting the next iteration", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const store = new MemoryStore(undefined, undefined, (event) => {
      if (event.type === "node_loop_checked") {
        controller.abort("operator cancelled after loop check");
      }
    });
    const state = await runWorkflow(loopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor: commandExecutor(calls, () => "again"),
      runId: "run-loop-cancel",
      now: () => new Date("2026-08-07T19:39:00.000Z"),
      signal: controller.signal,
    });

    expect(calls).toEqual(["repair--i1--node--probe"]);
    expect(store.events.slice(-2).map((event) => event.type)).toEqual([
      "node_loop_checked",
      "run_cancelled",
    ]);
    expect(state).toMatchObject({
      status: "cancelled",
      nodes: { "repair--i2--node--probe": { status: "pending" } },
    });
  });

  it("records durable effects against the exact loop instance", async () => {
    const calls: string[] = [];
    const store = new MemoryStore();
    const runId = "run-loop-effect";
    const workflow = agentLoopWorkflow({ tools: "edit" });
    const executor: NodeExecutor = {
      async execute(node, context): Promise<NodeExecutionOutcome> {
        calls.push(node.id);
        if (node.type === "command") {
          return { status: "succeeded", evidence: commandEvidence("verified") };
        }
        if (context.effectJournal === undefined) {
          throw new Error("expected a durable effect journal");
        }
        const descriptor = {
          kind: "filesystem.edit" as const,
          target: "/workspace/source.ts",
          operationDigest: "a".repeat(64),
          beforeSha256: "b".repeat(64),
          afterSha256: "c".repeat(64),
          mode: 0o644,
        };
        const policy = new PolicyBroker(
          {
            runId,
            workflowId: workflow.id,
            nodeId: node.id,
            attempt: context.attempt,
          },
          ["filesystem.write"],
        );
        policy.authorize({
          action: "filesystem.write",
          target: descriptor.target,
          boundary: "inside",
          operationDigest: descriptor.operationDigest,
        });
        const prepared = await context.effectJournal.prepare(descriptor);
        const receipt = await prepared.settle({
          outcome: "committed",
          reason: "directory_synced",
        });
        const text = "pass";
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
            policyDecisions: policy.close(),
            effectReceipts: receipt === null ? [] : [receipt],
          },
        };
      },
    };

    const state = await runWorkflow(workflow, {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor,
      runId,
      now: () => new Date("2026-08-07T19:40:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "verify"]);
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "node_effect_prepared",
          nodeId: "repair--i1--node--probe",
          attempt: 1,
        }),
        expect.objectContaining({
          type: "node_effect_settled",
          nodeId: "repair--i1--node--probe",
          outcome: "committed",
        }),
      ]),
    );
    expect(state.status).toBe("succeeded");
  });

  it("fresh-recovers only the interrupted qualified instance and preserves iteration identity", async () => {
    const calls: Array<{ readonly nodeId: string; readonly attempt: number }> = [];
    const store = new MemoryStore(undefined, "node_started");
    const workflow = agentLoopWorkflow({ tools: "read", recovery: true });
    const runId = "run-loop-fresh-recovery";
    const executor: NodeExecutor = {
      async execute(node, context): Promise<NodeExecutionOutcome> {
        calls.push({ nodeId: node.id, attempt: context.attempt });
        if (node.type === "command") {
          return { status: "succeeded", evidence: commandEvidence("verified") };
        }
        const text = "pass";
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
      },
    };

    await expect(
      runWorkflow(workflow, {
        cwd: process.cwd(),
        protectedPaths: [],
        store,
        executor,
        runId,
        now: () => new Date("2026-08-07T19:41:00.000Z"),
      }),
    ).rejects.toThrowError(/injected post-commit failure/i);
    expect(calls).toEqual([]);
    expect(store.events[0]).toMatchObject({
      type: "run_started",
      recoveryRequirements: [
        {
          nodeId: "repair--i1--node--probe",
          mode: "fresh",
          maxAttempts: 3,
          effectProtocol: "none",
        },
      ],
    });

    const state = await resumeWorkflow(workflow, {
      cwd: process.cwd(),
      protectedPaths: [],
      store,
      executor,
      runId,
      now: () => new Date("2026-08-07T19:41:01.000Z"),
    });

    expect(calls).toEqual([
      { nodeId: "repair--i1--node--probe", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    expect(store.events.filter((event) => event.type === "node_attempt_interrupted")).toEqual([
      expect.objectContaining({
        nodeId: "repair--i1--node--probe",
        attempt: 1,
        disposition: "fresh_retry",
      }),
    ]);
    expect(state.nodes["repair--i1--node--probe"]).toMatchObject({
      status: "succeeded",
      attempt: 2,
      interruptedAttempts: [{ attempt: 1 }],
    });
  });

  it("executes qualified conditions, omissions, and joins inside each loop body", async () => {
    const calls: string[] = [];
    const state = await runWorkflow(conditionalBodyLoopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store: new MemoryStore(),
      executor: commandExecutor(calls, (nodeId) =>
        nodeId.endsWith("--classify")
          ? "change"
          : nodeId.includes("--i1--node--probe")
            ? "again"
            : nodeId.includes("--i2--node--probe")
              ? "pass"
              : "ok",
      ),
      runId: "run-loop-conditional-body",
      now: () => new Date("2026-08-07T19:42:00.000Z"),
    });

    expect(calls).toEqual([
      "repair--i1--node--classify",
      "repair--i1--node--change",
      "repair--i1--node--probe",
      "repair--i2--node--classify",
      "repair--i2--node--change",
      "repair--i2--node--probe",
      "verify",
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "repair--i1--node--route": {
          control: { kind: "condition", selectedCase: "change" },
        },
        "repair--i1--node--clean": {
          status: "omitted",
          omission: { reason: "condition_not_selected" },
        },
        "repair--i1--node--converge": {
          control: {
            kind: "join",
            completedNodeId: "repair--i1--node--change",
          },
        },
        "repair--i2--node--route": {
          control: { kind: "condition", selectedCase: "change" },
        },
        repair: { control: { kind: "loop", completedIterations: 2 } },
      },
    });
  });

  it("omits a loop controller when its enclosing condition branch is not selected", async () => {
    const calls: string[] = [];
    const state = await runWorkflow(conditionallySkippedLoopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store: new MemoryStore(),
      executor: commandExecutor(calls, (nodeId) => (nodeId === "classify" ? "skip" : "ok")),
      runId: "run-loop-conditionally-skipped",
      now: () => new Date("2026-08-07T19:42:30.000Z"),
    });

    expect(calls).toEqual(["classify", "skip-branch", "verify"]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "run-branch": { status: "omitted" },
        "repair--i1--node--probe": { status: "omitted" },
        "repair--i1--check": { status: "omitted" },
        repair: {
          status: "omitted",
          omission: {
            reason: "dependency_omitted",
            omittedDependencies: ["repair--i1--check"],
          },
        },
        "after-loop": { status: "omitted" },
        converge: { status: "succeeded" },
        verify: { status: "succeeded" },
      },
    });
  });

  it("requires downstream deterministic goal verification after loop convergence", async () => {
    const calls: string[] = [];
    const state = await runWorkflow(goalLoopWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      store: new MemoryStore(),
      executor: commandExecutor(calls, () => "pass"),
      runId: "run-loop-goal",
      now: () => new Date("2026-08-07T19:43:00.000Z"),
    });

    expect(calls).toEqual(["repair--i1--node--probe", "verify"]);
    expect(state).toMatchObject({
      status: "succeeded",
      goal: {
        status: "accepted",
        criteria: {
          "verification-passes": {
            status: "accepted",
            decision: { nodeId: "verify", attempt: 1, evidenceAvailable: true },
          },
        },
      },
    });
  });
});

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  constructor(
    private failAfterSucceededNodeId?: string,
    private failAfterType?: RunEvent["type"],
    private readonly afterAppend?: (event: RunEvent) => void,
  ) {}

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
    if (event.type === "node_succeeded" && event.nodeId === this.failAfterSucceededNodeId) {
      this.failAfterSucceededNodeId = undefined;
      throw new Error("injected post-commit failure");
    }
    if (event.type === this.failAfterType) {
      this.failAfterType = undefined;
      throw new Error("injected post-commit failure");
    }
    this.afterAppend?.(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}

function loopExecutor(calls: string[]): NodeExecutor {
  return commandExecutor(calls, (nodeId) =>
    nodeId.includes("--i1--") ? "again" : nodeId.includes("--i2--") ? "pass" : "verified",
  );
}

function commandExecutor(
  calls: string[],
  stdoutFor: (nodeId: string) => string,
  stdoutTruncated = false,
): NodeExecutor {
  return {
    async execute(node): Promise<NodeExecutionOutcome> {
      if (node.type !== "command") {
        throw new Error(`control node "${node.id}" reached the executor`);
      }
      calls.push(node.id);
      return {
        status: "succeeded",
        evidence: { ...commandEvidence(stdoutFor(node.id)), stdoutTruncated },
      };
    },
  };
}

function loopWorkflow(maxIterations = 2) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: bounded-loop }
nodes:
  - id: repair
    type: loop
    loop:
      maxIterations: ${maxIterations}
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [scripts/probe.mjs] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function conditionallySkippedLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditionally-skipped-loop }
nodes:
  - id: classify
    type: command
    command: { executable: node, args: [--version] }
  - id: route
    type: condition
    dependsOn: [classify]
    condition:
      source: { nodeId: classify, field: command.stdout }
      cases: [{ id: run, equals: run }]
      default: skip
  - id: run-branch
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: run }
    command: { executable: node, args: [--version] }
  - id: repair
    type: loop
    dependsOn: [run-branch]
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [--version] }
  - id: after-loop
    type: command
    dependsOn: [repair]
    command: { executable: node, args: [--version] }
  - id: skip-branch
    type: command
    dependsOn: [route]
    when: { conditionId: route, case: skip }
    command: { executable: node, args: [--version] }
  - id: converge
    type: join
    join:
      conditionId: route
      branches:
        - { case: run, nodeId: after-loop }
        - { case: skip, nodeId: skip-branch }
  - id: verify
    type: command
    dependsOn: [converge]
    command: { executable: node, args: [--version] }
`);
}

function parallelLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: parallel-bounded-loops }
concurrency: { maxNodes: 2 }
nodes:
  - id: start
    type: command
    command: { executable: node, args: [scripts/start.mjs] }
  - id: first
    type: loop
    dependsOn: [start]
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [scripts/first.mjs] }
  - id: second
    type: loop
    dependsOn: [start]
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [scripts/second.mjs] }
  - id: verify
    type: command
    dependsOn: [first, second]
    command: { executable: npm, args: [test] }
`);
}

function concurrentBodyLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-loop-body }
concurrency: { maxNodes: 2 }
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
          - id: setup
            type: command
            command: { executable: node, args: [setup] }
          - id: left
            type: command
            dependsOn: [setup]
            command: { executable: node, args: [left] }
          - id: right
            type: command
            dependsOn: [setup]
            command: { executable: node, args: [right] }
          - id: probe
            type: command
            dependsOn: [left, right]
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function approvalLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approved-loop }
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
          - id: probe
            type: command
            approval: { mode: required, grantTtlMs: 120000 }
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function budgetedLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: budgeted-loop }
budget: { maxNodeStarts: 1 }
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
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function agentLoopWorkflow(options: {
  readonly tools: "read" | "edit";
  readonly recovery?: boolean;
}) {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: agent-loop }
nodes:
  - id: repair
    type: loop
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: agent.text }
        equals: pass
      body:
        nodes:
          - id: probe
            type: agent
            agent:
              prompt: Inspect and repair the workspace.
              model: { provider: test, id: deterministic }
              tools: [${options.tools}]
              ${options.recovery === true ? "recovery: { mode: fresh, maxAttempts: 3 }" : ""}
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function conditionalBodyLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: conditional-loop-body }
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
          - id: classify
            type: command
            command: { executable: node, args: [classify] }
          - id: route
            type: condition
            dependsOn: [classify]
            condition:
              source: { nodeId: classify, field: command.stdout }
              cases: [{ id: change, equals: change }]
              default: clean
          - id: change
            type: command
            dependsOn: [route]
            when: { conditionId: route, case: change }
            command: { executable: node, args: [change] }
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
                - { case: change, nodeId: change }
                - { case: clean, nodeId: clean }
          - id: probe
            type: command
            dependsOn: [converge]
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function goalLoopWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: goal-loop }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: loop-verified }
  outcome: The bounded repair loop is independently verified.
  criteria:
    - id: verification-passes
      description: The final verifier succeeds after convergence.
      verifier: { nodeId: verify }
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
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);
}

function commandEvidence(stdout: string): CommandEvidence {
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
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
