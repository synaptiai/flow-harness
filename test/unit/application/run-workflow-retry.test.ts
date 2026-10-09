import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  NodeEffectReconciler,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import {
  RunWorkflowAbortedError,
  resumeWorkflow,
  runWorkflow,
} from "../../../src/application/run-workflow.js";
import {
  calculateRecoveryBackoffDelayMs,
  type FilesystemEditEffectDescriptor,
  parseRunEvent,
  type RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("runWorkflow proof-safe fresh recovery", () => {
  it("fresh-retries a completed side-effect-free provider failure with accounted usage", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let agentExecutions = 0;
    const executor: NodeExecutor & {
      readonly calls: { readonly nodeId: string; readonly attempt: number }[];
    } = {
      calls: [],
      async execute(node, context) {
        this.calls.push({ nodeId: node.id, attempt: context.attempt });
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        agentExecutions += 1;
        if (agentExecutions > 1) {
          return successfulAgentOutcome();
        }
        return {
          status: "failed",
          error: {
            code: "pi_agent_error",
            message: "agent provider execution failed",
            retryable: true,
            sideEffectStatus: "none",
          },
          evidence: {
            kind: "agent",
            provider: "test",
            model: "deterministic",
            text: "",
            textHash: sha256(""),
            textTruncated: false,
            durationMs: 5,
            usage: {
              inputTokens: 2,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsdMicros: 7,
            },
            policyDecisions: [],
            effectReceipts: [],
          },
        };
      },
    };

    const state = await runWorkflow(
      workflow("read", true),
      options(store, executor, "run-terminal-retry"),
    );

    expect(executor.calls).toEqual([
      { nodeId: "implement", attempt: 1 },
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "node_retry_scheduled",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: {
        nodeStarts: 3,
        modelTokens: 3,
        modelCostUsdMicros: 7,
        executionMs: 7,
      },
      nodes: {
        implement: {
          status: "succeeded",
          attempt: 2,
          failedAttempts: [
            {
              attempt: 1,
              error: { code: "pi_agent_error", retryable: true, sideEffectStatus: "none" },
            },
          ],
        },
      },
    });
  });

  it("waits for the durable jittered backoff before a provider retry", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let agentExecutions = 0;
    let clockMs = Date.parse("2026-08-07T18:00:00.000Z");
    const waits: number[] = [];
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") return successfulCommandOutcome(node.id);
        agentExecutions += 1;
        return agentExecutions === 1 ? retryableAgentFailure() : successfulAgentOutcome();
      },
    };
    const runId = "run-terminal-backoff";
    const backoff = { initialDelayMs: 30_000, maxDelayMs: 120_000 };

    const state = await runWorkflow(workflow("read", true, undefined, 3, undefined, backoff), {
      ...options(store, executor, runId),
      now: () => new Date(clockMs),
      async recoveryDelay(milliseconds) {
        waits.push(milliseconds);
        clockMs += milliseconds;
      },
    });

    const expectedDelay = calculateRecoveryBackoffDelayMs(runId, "implement", 1, backoff);
    expect(waits).toEqual([expectedDelay]);
    expect(store.events.find((event) => event.type === "node_retry_scheduled")).toMatchObject({
      notBefore: new Date(Date.parse("2026-08-07T18:00:00.000Z") + expectedDelay).toISOString(),
    });
    expect(
      store.events.filter((event) => event.type === "node_started").map((event) => event.at),
    ).toEqual([
      "2026-08-07T18:00:00.000Z",
      new Date(Date.parse("2026-08-07T18:00:00.000Z") + expectedDelay).toISOString(),
      new Date(Date.parse("2026-08-07T18:00:00.000Z") + expectedDelay).toISOString(),
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      recoveryRequirements: { implement: { backoff } },
      nodes: { implement: { retryNotBefore: null } },
    });
  });

  it("resumes a retry by waiting for its persisted remaining backoff", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let agentExecutions = 0;
    let clockMs = Date.parse("2026-08-07T18:00:00.000Z");
    const waits: number[] = [];
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") return successfulCommandOutcome(node.id);
        agentExecutions += 1;
        return agentExecutions === 1 ? retryableAgentFailure() : successfulAgentOutcome();
      },
    };
    const runId = "run-resumed-backoff";
    const backoff = { initialDelayMs: 30_000, maxDelayMs: 120_000 };
    const compiled = workflow("read", true, undefined, 3, undefined, backoff);

    await expect(
      runWorkflow(compiled, {
        ...options(store, executor, runId),
        now: () => new Date(clockMs),
        async recoveryDelay() {
          throw new Error("simulated process exit during retry backoff");
        },
      }),
    ).rejects.toThrow(/simulated process exit/i);
    expect(store.events.at(-1)?.type).toBe("node_retry_scheduled");

    const state = await resumeWorkflow(compiled, {
      ...resumeOptions(store, executor, runId),
      now: () => new Date(clockMs),
      async recoveryDelay(milliseconds) {
        waits.push(milliseconds);
        clockMs += milliseconds;
      },
    });

    expect(waits).toEqual([calculateRecoveryBackoffDelayMs(runId, "implement", 1, backoff)]);
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: { implement: { attempt: 2, failedAttempts: [{ attempt: 1 }] } },
    });
  });

  it("resumes after the failed attempt commits before its retry disposition", async () => {
    const store = new MemoryRecoverableRunStore([]);
    store.failNext("node_retry_scheduled");
    let agentExecutions = 0;
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        agentExecutions += 1;
        return agentExecutions === 1 ? retryableAgentFailure() : successfulAgentOutcome();
      },
    };

    await expect(
      runWorkflow(workflow("read", true), options(store, executor, "run-retry-boundary")),
    ).rejects.toThrow(/injected node_retry_scheduled persistence failure/i);
    expect(store.events.at(-1)?.type).toBe("node_failed");

    const state = await resumeWorkflow(workflow("read", true), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "run-retry-boundary",
      store,
      executor,
      now: () => new Date("2026-08-07T18:00:10.000Z"),
    });

    expect(state).toMatchObject({
      status: "succeeded",
      nodes: { implement: { attempt: 2, failedAttempts: [{ attempt: 1 }] } },
    });
    expect(store.events.filter((event) => event.type === "node_retry_scheduled")).toHaveLength(1);
  });

  it("stops after the declared number of completed failure attempts", async () => {
    const store = new MemoryRecoverableRunStore([]);
    const attempts: number[] = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        attempts.push(context.attempt);
        return retryableAgentFailure();
      },
    };

    const state = await runWorkflow(
      workflow("read", true, undefined, 2),
      options(store, executor, "run-attempt-limit"),
    );

    expect(attempts).toEqual([1, 2]);
    expect(state).toMatchObject({
      status: "failed",
      failedNodeId: "implement",
      nodes: { implement: { attempt: 2, failedAttempts: [{ attempt: 1 }] } },
    });
  });

  it("does not retry when bounded model usage is unavailable", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let calls = 0;
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        calls += 1;
        return retryableAgentFailure(null);
      },
    };

    const state = await runWorkflow(
      workflow("read", true, undefined, 3, 10),
      options(store, executor, "run-missing-usage"),
    );

    expect(calls).toBe(1);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "implement" });
    expect(store.events.some((event) => event.type === "node_retry_scheduled")).toBe(false);
  });

  it("retries when the declared token budget has complete token accounting", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let calls = 0;
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        calls += 1;
        return calls === 1
          ? retryableAgentFailure({
              kind: "agent",
              provider: "test",
              model: "deterministic",
              text: "",
              textHash: sha256(""),
              textTruncated: false,
              durationMs: 1,
              usageObservation: {
                modelTokens: { status: "complete", totalTokens: 2 },
                costUsd: { status: "unavailable" },
              },
              policyDecisions: [],
              effectReceipts: [],
            })
          : successfulAgentOutcome();
      },
    };

    const state = await runWorkflow(
      workflow("read", true, undefined, 3, 10),
      options(store, executor, "run-token-accounting"),
    );

    expect(calls).toBe(2);
    expect(state).toMatchObject({ status: "succeeded", resources: { modelTokens: 2 } });
  });

  it("does not retry a failure carrying non-agent evidence", async () => {
    const store = new MemoryRecoverableRunStore([]);
    let calls = 0;
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        calls += 1;
        return retryableAgentFailure(successfulCommandOutcome(node.id).evidence);
      },
    };

    const state = await runWorkflow(
      workflow("read", true),
      options(store, executor, "run-incompatible-evidence"),
    );

    expect(calls).toBe(1);
    expect(state).toMatchObject({ status: "failed", failedNodeId: "implement" });
    expect(store.events.some((event) => event.type === "node_retry_scheduled")).toBe(false);
  });

  it("fresh-retries malformed model-verifier output with complete accounting", async () => {
    const store = new MemoryRecoverableRunStore([]);
    const attempts: number[] = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        attempts.push(context.attempt);
        if (node.type === "agent") return successfulAgentOutcome();
        if (node.type !== "verifier") return successfulCommandOutcome(node.id);
        return context.attempt === 1
          ? invalidModelVerifierOutcome()
          : successfulModelVerifierOutcome();
      },
    };

    const state = await runWorkflow(
      verifierRecoveryWorkflow(),
      options(store, executor, "run-verifier-retry"),
    );

    expect(attempts).toEqual([1, 1, 2]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 3, modelTokens: 12, modelCostUsdMicros: 4 },
      recoveryRequirements: {
        verify: { mode: "fresh", maxAttempts: 2, effectProtocol: "none" },
      },
      nodes: {
        verify: {
          status: "succeeded",
          attempt: 2,
          failedAttempts: [
            {
              attempt: 1,
              evidence: { kind: "verifier", driver: "model", result: "invalid_output" },
            },
          ],
        },
      },
    });
  });

  it("does not select one retry from a concurrent wave with multiple failures", async () => {
    const compiled = concurrentRetryWorkflow();
    const store = new MemoryRecoverableRunStore([]);
    store.failNext("run_failed");
    const calls: string[] = [];
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "agent") {
          return successfulCommandOutcome(node.id);
        }
        calls.push(node.id);
        return retryableAgentFailure();
      },
    };

    await expect(
      runWorkflow(compiled, options(store, executor, "run-multiple-failures")),
    ).rejects.toThrow(/injected run_failed persistence failure/i);
    expect(store.events.filter((event) => event.type === "node_failed")).toHaveLength(2);

    const state = await resumeWorkflow(
      compiled,
      resumeOptions(store, executor, "run-multiple-failures"),
    );

    expect(calls.sort()).toEqual(["left", "right"]);
    expect(state.status).toBe("failed");
    expect(store.events.some((event) => event.type === "node_retry_scheduled")).toBe(false);
  });

  it("persists only explicitly configured agent recovery requirements", async () => {
    const recoveryStore = new MemoryRecoverableRunStore([]);
    const defaultStore = new MemoryRecoverableRunStore([]);
    const executor = successfulExecutor();

    await runWorkflow(workflow("read", true), options(recoveryStore, executor, "run-policy"));
    await runWorkflow(workflow("read", false), options(defaultStore, executor, "run-default"));

    expect(recoveryStore.events[0]).toMatchObject({
      type: "run_started",
      recoveryRequirements: [
        {
          nodeId: "implement",
          mode: "fresh",
          maxAttempts: 3,
          effectProtocol: "none",
        },
      ],
    });
    expect(defaultStore.events[0]).not.toHaveProperty("recoveryRequirements");
  });

  it("disposes a read-only interruption before executing fresh attempt two", async () => {
    const compiled = workflow("read", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();

    const state = await resumeWorkflow(compiled, resumeOptions(store, executor));

    expect(executor.calls).toEqual([
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_attempt_interrupted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      attempt: 2,
      interruptedAttempts: [{ attempt: 1, disposition: "fresh_retry" }],
    });
  });

  it("does not charge an interrupted attempt before terminal artifact evidence is committed", async () => {
    const compiled = workflow("read", true, 20);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();

    const state = await resumeWorkflow(compiled, resumeOptions(store, executor));

    expect(executor.calls).toEqual([
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    expect(state).toMatchObject({
      status: "succeeded",
      resources: { artifactBytes: 13 },
      budget: { remaining: { artifactBytes: 7 } },
    });
  });

  it("retries an edit-capable attempt only after reconciliation proves no edit applied", async () => {
    const compiled = workflow("edit", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled, firstDescriptor()));
    const executor = successfulExecutor();
    const reconciler = reconcilerFor("not_applied");

    const state = await resumeWorkflow(compiled, {
      ...resumeOptions(store, executor),
      effectReconciler: reconciler,
    });

    expect(reconciler.targets).toEqual(["/workspace/source.ts"]);
    expect(executor.calls[0]).toEqual({ nodeId: "implement", attempt: 2 });
    expect(store.events.slice(3, 6).map((event) => event.type)).toEqual([
      "node_effect_reconciled",
      "node_attempt_interrupted",
      "run_resumed",
    ]);
    expect(state.nodes.implement?.interruptedAttempts[0]?.effects[0]).toMatchObject({
      reconciliation: { outcome: "not_applied" },
    });
  });

  it("fails with a stable ineligible code when reconciliation finds an applied edit", async () => {
    const compiled = workflow("edit", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled, firstDescriptor()));
    const executor = successfulExecutor();
    const reconciler = reconcilerFor("applied");

    await expect(
      resumeWorkflow(compiled, {
        ...resumeOptions(store, executor),
        effectReconciler: reconciler,
      }),
    ).rejects.toMatchObject({ code: "recovery_retry_ineligible" });

    expect(executor.calls).toEqual([]);
    expect(store.events.at(-1)).toMatchObject({
      type: "node_effect_reconciled",
      outcome: "applied",
    });
    expect(store.events.some((event) => event.type === "node_attempt_interrupted")).toBe(false);
  });

  it("classifies an opted-in legacy writable attempt as retry-ineligible", async () => {
    const compiled = workflow("edit", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled, undefined, true));
    const executor = successfulExecutor();

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toMatchObject({
      code: "recovery_retry_ineligible",
    });

    expect(executor.calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("preserves the legacy uncertain-operation result when recovery was omitted", async () => {
    const compiled = workflow("read", false);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toMatchObject({
      code: "uncertain_operation",
    });
    expect(executor.calls).toEqual([]);
    expect(store.events).toHaveLength(2);
  });

  it("rejects a forged run-start recovery policy before mutation or execution", async () => {
    const compiled = workflow("read", false);
    const initial = openAttemptEvents(compiled);
    const started = initial[0];
    if (started?.type !== "run_started") {
      throw new Error("test run start was not created");
    }
    initial[0] = parseRunEvent({
      ...started,
      recoveryRequirements: [
        {
          nodeId: "implement",
          mode: "fresh",
          maxAttempts: 3,
          effectProtocol: "none",
        },
      ],
    });
    const store = new MemoryRecoverableRunStore(initial);
    const executor = successfulExecutor();

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toMatchObject({
      code: "workflow_mismatch",
    });

    expect(executor.calls).toEqual([]);
    expect(store.events).toEqual(initial);
  });

  it("continues after a crash between disposition and the resume marker without duplication", async () => {
    const compiled = workflow("read", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();
    store.failNext("run_resumed");

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toThrow(
      /injected run_resumed persistence failure/i,
    );
    expect(store.events.at(-1)?.type).toBe("node_attempt_interrupted");
    expect(executor.calls).toEqual([]);

    const state = await resumeWorkflow(compiled, resumeOptions(store, executor));

    expect(store.events.filter((event) => event.type === "node_attempt_interrupted")).toHaveLength(
      1,
    );
    expect(state.nodes.implement).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("rejects committed history that skipped the resume marker after disposition", async () => {
    const compiled = workflow("read", true);
    const initial = openAttemptEvents(compiled);
    initial.push(
      parseRunEvent({
        ...base(3),
        type: "node_attempt_interrupted",
        nodeId: "implement",
        attempt: 1,
        reason: "process_interrupted",
        disposition: "fresh_retry",
        resourceAccounting: "incomplete",
      }),
      parseRunEvent({
        ...base(4),
        type: "node_started",
        nodeId: "implement",
        attempt: 2,
      }),
    );
    const store = new MemoryRecoverableRunStore(initial);
    const executor = successfulExecutor();

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toMatchObject({
      code: "workflow_mismatch",
    });
    expect(executor.calls).toEqual([]);
    expect(store.events).toEqual(initial);
  });

  it("does not execute or advance state when disposition persistence fails", async () => {
    const compiled = workflow("read", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();
    store.failNext("node_attempt_interrupted");

    await expect(resumeWorkflow(compiled, resumeOptions(store, executor))).rejects.toThrow(
      /injected node_attempt_interrupted persistence failure/i,
    );

    expect(executor.calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("does not dispose an attempt when cancellation arrives while claiming the run", async () => {
    const compiled = workflow("read", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled));
    const executor = successfulExecutor();
    const controller = new AbortController();
    store.afterClaim(() => controller.abort("operator cancelled"));

    await expect(
      resumeWorkflow(compiled, {
        ...resumeOptions(store, executor),
        signal: controller.signal,
      }),
    ).rejects.toThrow(RunWorkflowAbortedError);

    expect(executor.calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("retains reconciliation evidence but does not dispose after cancellation", async () => {
    const compiled = workflow("edit", true);
    const store = new MemoryRecoverableRunStore(openAttemptEvents(compiled, firstDescriptor()));
    const executor = successfulExecutor();
    const controller = new AbortController();
    const reconciler: NodeEffectReconciler = {
      async reconcile(descriptor, publish) {
        if (descriptor.kind !== "filesystem.edit") {
          throw new Error("expected an edit effect");
        }
        await publish({
          outcome: "not_applied",
          reason: "target_matches_before",
          observedSha256: descriptor.beforeSha256,
          observedMode: descriptor.mode,
        });
        controller.abort("operator cancelled");
      },
    };

    await expect(
      resumeWorkflow(compiled, {
        ...resumeOptions(store, executor),
        effectReconciler: reconciler,
        signal: controller.signal,
      }),
    ).rejects.toThrow(RunWorkflowAbortedError);

    expect(executor.calls).toEqual([]);
    expect(store.events.at(-1)?.type).toBe("node_effect_reconciled");
    expect(store.events.some((event) => event.type === "node_attempt_interrupted")).toBe(false);
  });
});

class MemoryRecoverableRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[];
  readonly releaseCalls: string[] = [];
  private failingType: RunEvent["type"] | undefined;
  private afterClaimCallback: (() => void) | undefined;

  constructor(initial: readonly RunEvent[]) {
    this.events = structuredClone([...initial]);
  }

  failNext(type: RunEvent["type"]): void {
    this.failingType = type;
  }

  afterClaim(callback: () => void): void {
    this.afterClaimCallback = callback;
  }

  async claim(): Promise<readonly RunEvent[]> {
    const events = structuredClone(this.events);
    this.afterClaimCallback?.();
    return events;
  }

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.failingType) {
      this.failingType = undefined;
      throw new Error(`injected ${event.type} persistence failure`);
    }
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(runId: string): Promise<void> {
    this.releaseCalls.push(runId);
  }
}

function successfulExecutor(): NodeExecutor & {
  readonly calls: { readonly nodeId: string; readonly attempt: number }[];
} {
  const calls: { nodeId: string; attempt: number }[] = [];
  return {
    calls,
    async execute(
      node: CompiledNode,
      context: NodeExecutionContext,
    ): Promise<NodeExecutionOutcome> {
      calls.push({ nodeId: node.id, attempt: context.attempt });
      return node.type === "agent" ? successfulAgentOutcome() : successfulCommandOutcome(node.id);
    },
  };
}

function options(store: RecoverableRunEventStore, executor: NodeExecutor, runId: string) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    store,
    executor,
    runId,
    now: () => new Date("2026-08-07T18:00:00.000Z"),
  };
}

function resumeOptions(
  store: RecoverableRunEventStore,
  executor: NodeExecutor,
  runId = "run-retry",
) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    runId,
    store,
    executor,
    now: () => new Date("2026-08-07T18:00:10.000Z"),
  };
}

function concurrentRetryWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: concurrent-retry }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: node, args: [--version] }
  - id: left
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze the left branch.
      model: { provider: test, id: deterministic }
      tools: [read]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: right
    type: agent
    dependsOn: [root]
    agent:
      prompt: Analyze the right branch.
      model: { provider: test, id: deterministic }
      tools: [read]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: join
    type: command
    dependsOn: [left, right]
    command: { executable: node, args: [--version] }
`);
}

function openAttemptEvents(
  compiled: ReturnType<typeof workflow>,
  descriptor?: FilesystemEditEffectDescriptor,
  omitEffectProtocol = false,
): RunEvent[] {
  const implement = compiled.nodes[0];
  if (implement?.type !== "agent") {
    throw new Error("test workflow must start with an agent");
  }
  const effectProtocol = implement.agent.tools.includes("edit") ? "flow.effects/v1" : "none";
  const events: RunEvent[] = [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: resolve(process.cwd()),
      ...(compiled.budget === undefined ? {} : { budget: compiled.budget }),
      ...(implement.agent.recovery === undefined
        ? {}
        : {
            recoveryRequirements: [
              {
                nodeId: implement.id,
                mode: implement.agent.recovery.mode,
                maxAttempts: implement.agent.recovery.maxAttempts,
                effectProtocol,
              },
            ],
          }),
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      ...(effectProtocol === "flow.effects/v1" && !omitEffectProtocol ? { effectProtocol } : {}),
    }),
  ];
  if (descriptor !== undefined) {
    events.push(
      parseRunEvent({
        ...base(3),
        type: "node_effect_prepared",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        effectSequence: 1,
        descriptor,
      }),
    );
  }
  return events;
}

function reconcilerFor(outcome: "applied" | "not_applied"): NodeEffectReconciler & {
  readonly targets: string[];
} {
  const targets: string[] = [];
  return {
    targets,
    async reconcile(descriptor, publish) {
      targets.push(descriptor.target);
      if (descriptor.kind !== "filesystem.edit") {
        throw new Error("expected an edit effect");
      }
      await publish(
        outcome === "applied"
          ? {
              outcome,
              reason: "target_matches_after",
              observedSha256: descriptor.afterSha256,
              observedMode: descriptor.mode,
            }
          : {
              outcome,
              reason: "target_matches_before",
              observedSha256: descriptor.beforeSha256,
              observedMode: descriptor.mode,
            },
      );
    },
  };
}

function workflow(
  tool: "read" | "edit",
  recovery: boolean,
  maxArtifactBytes?: number,
  maxAttempts = 3,
  maxModelTokens?: number,
  backoff?: { readonly initialDelayMs: number; readonly maxDelayMs: number },
) {
  const budget = [
    maxArtifactBytes === undefined ? undefined : `maxArtifactBytes: ${maxArtifactBytes}`,
    maxModelTokens === undefined ? undefined : `maxModelTokens: ${maxModelTokens}`,
  ].filter((entry): entry is string => entry !== undefined);
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: proof-safe-retry }
${budget.length === 0 ? "" : `budget: { ${budget.join(", ")} }`}
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [${tool}]
      ${
        recovery
          ? `recovery: { mode: fresh, maxAttempts: ${maxAttempts}${
              backoff === undefined
                ? ""
                : `, backoff: { initialDelayMs: ${backoff.initialDelayMs}, maxDelayMs: ${backoff.maxDelayMs} }`
            } }`
          : ""
      }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function retryableAgentFailure(
  evidence: NodeExecutionOutcome["evidence"] = {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text: "",
    textHash: sha256(""),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: [],
    effectReceipts: [],
  },
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "pi_agent_error",
      message: "agent provider execution failed",
      retryable: true,
      sideEffectStatus: "none",
    },
    evidence,
  };
}

function verifierRecoveryWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: verifier-retry }
budget: { maxModelTokens: 100, maxCostUsd: 0.0001 }
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: test, id: deterministic }
      tools: [read]
  - id: verify
    type: verifier
    dependsOn: [analyze]
    verifier:
      kind: model
      prompt: Verify the report.
      evidence: [{ nodeId: analyze, field: agent.text }]
      model: { provider: test, id: deterministic }
      recovery: { mode: fresh, maxAttempts: 2 }
`);
}

function invalidModelVerifierOutcome(): NodeExecutionOutcome {
  const raw = '{"verdict":"accepted","reason":"verified","extra":null}';
  return {
    status: "failed",
    error: {
      code: "verifier_inconclusive",
      message: "model verifier output violated the strict verdict contract",
      retryable: true,
      sideEffectStatus: "none",
    },
    evidence: {
      kind: "verifier",
      driver: "model",
      result: "invalid_output",
      verdict: "inconclusive",
      reason: "model verifier output violated the strict verdict contract",
      reasonHash: sha256("model verifier output violated the strict verdict contract"),
      provider: "test",
      model: "deterministic",
      raw,
      rawHash: sha256(raw),
      rawTruncated: false,
      durationMs: 2,
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 4,
      },
      sources: [modelVerifierSource()],
    },
  };
}

function successfulModelVerifierOutcome(): NodeExecutionOutcome {
  const raw = '{"verdict":"accepted","reason":"verified"}';
  return {
    status: "succeeded",
    evidence: {
      kind: "verifier",
      driver: "model",
      result: "parsed",
      verdict: "accepted",
      reason: "verified",
      reasonHash: sha256("verified"),
      provider: "test",
      model: "deterministic",
      raw,
      rawHash: sha256(raw),
      rawTruncated: false,
      durationMs: 2,
      usage: {
        inputTokens: 4,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 0,
      },
      sources: [modelVerifierSource()],
    },
  };
}

function modelVerifierSource() {
  return {
    sourceNodeId: "analyze",
    sourceAttempt: 1,
    sourceField: "agent.text" as const,
    sourceHash: sha256("implemented"),
  };
}

function firstDescriptor(): FilesystemEditEffectDescriptor {
  return {
    kind: "filesystem.edit",
    target: "/workspace/source.ts",
    operationDigest: "b".repeat(64),
    beforeSha256: "c".repeat(64),
    afterSha256: "d".repeat(64),
    mode: 0o644,
  };
}

function successfulAgentOutcome(): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text: "implemented",
      textHash: sha256("implemented"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function successfulCommandOutcome(nodeId: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "command",
      executable: "node",
      args: [nodeId],
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      stdoutHash: sha256("ok"),
      stderrHash: sha256(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T18:00:0${sequence}.000Z`,
    runId: "run-retry",
    workflowId: "proof-safe-retry",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
