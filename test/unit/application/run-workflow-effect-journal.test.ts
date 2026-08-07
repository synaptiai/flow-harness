import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runWorkflow } from "../../../src/application/run-workflow.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
  RunEventStore,
} from "../../../src/application/ports.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import type { AgentEffectReceipt, RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("runWorkflow durable effect journal", () => {
  it("acknowledges a prepared edit only after its event is durable", async () => {
    const store = new MemoryRunStore();
    let journalObserved = false;
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      expect(node.type).toBe("agent");
      journalObserved = context.effectJournal !== undefined;
      if (context.effectJournal === undefined) {
        return successfulAgentOutcome([]);
      }
      expect(store.events.at(-1)).toMatchObject({
        type: "node_started",
        effectProtocol: "flow.effects/v1",
      });

      const prepared = await context.effectJournal.prepare({
        kind: "filesystem.edit",
        target: "/workspace/source.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        mode: 0o644,
      });
      expect(prepared).toMatchObject({ effectId: "effect-3", effectSequence: 1 });
      expect(store.events.at(-1)).toMatchObject({
        type: "node_effect_prepared",
        effectId: "effect-3",
        effectSequence: 1,
      });

      const receipt = await prepared.settle({
        outcome: "committed",
        reason: "directory_synced",
      });
      expect(receipt).toMatchObject({ sequence: 1, outcome: "committed" });
      expect(store.events.at(-1)).toMatchObject({
        type: "node_effect_settled",
        effectId: "effect-3",
        outcome: "committed",
      });
      return successfulAgentOutcome(receipt === null ? [] : [receipt]);
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      now: incrementingClock(),
    });

    expect(journalObserved).toBe(true);
    expect(state.status).toBe("succeeded");
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_settled",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("serializes concurrent effect preparation and settlement", async () => {
    const store = new MemoryRunStore();
    let preparedIdentities: readonly string[] = [];
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      const prepared = await Promise.all([
        context.effectJournal.prepare(descriptor("/workspace/first.ts", "b")),
        context.effectJournal.prepare(descriptor("/workspace/second.ts", "e")),
      ]);
      preparedIdentities = prepared.map((effect) => `${effect.effectId}:${effect.effectSequence}`);
      await Promise.all(
        prepared.map((effect) =>
          effect.settle({ outcome: "not_applied", reason: "commit_not_entered" }),
        ),
      );
      return successfulAgentOutcome(
        [],
        [descriptor("/workspace/first.ts", "b"), descriptor("/workspace/second.ts", "e")],
      );
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      now: incrementingClock(),
    });

    expect(state.status).toBe("succeeded");
    expect(preparedIdentities).toEqual(["effect-3:1", "effect-4:2"]);
    expect(
      store.events
        .filter((event) => event.type.startsWith("node_effect_"))
        .map((event) => event.sequence),
    ).toEqual([3, 4, 5, 6]);
  });

  it("poisons later publications after an effect append rejects", async () => {
    const store = new MemoryRunStore("node_effect_prepared", 1);
    const observedErrors: string[] = [];
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      for (const target of ["/workspace/first.ts", "/workspace/second.ts"]) {
        try {
          await context.effectJournal.prepare(descriptor(target, "b"));
        } catch (error) {
          observedErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return successfulAgentOutcome([]);
    });

    await expect(
      runWorkflow(editWorkflow(), {
        cwd: process.cwd(),
        protectedPaths: [],
        runId: "effect-run",
        store,
        executor,
        now: incrementingClock(),
      }),
    ).rejects.toThrow(/injected persistence failure/i);

    expect(observedErrors).toEqual([
      "injected persistence failure for node_effect_prepared",
      "injected persistence failure for node_effect_prepared",
    ]);
    expect(store.attemptedTypes.filter((type) => type === "node_effect_prepared")).toHaveLength(1);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("poisons later publications when an effect append rejects with undefined", async () => {
    const store = new UndefinedRejectingRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      for (const target of ["/workspace/first.ts", "/workspace/second.ts"]) {
        try {
          await context.effectJournal.prepare(descriptor(target, "b"));
        } catch {
          // The executor may observe an untyped rejection, but the journal must stay poisoned.
        }
      }
      return successfulAgentOutcome([]);
    });

    let rejected = false;
    try {
      await runWorkflow(editWorkflow(), {
        cwd: process.cwd(),
        protectedPaths: [],
        runId: "effect-run",
        store,
        executor,
        now: incrementingClock(),
      });
    } catch {
      rejected = true;
    }

    expect(rejected).toBe(true);
    expect(store.attemptedTypes.filter((type) => type === "node_effect_prepared")).toHaveLength(1);
    expect(store.events.map((event) => event.type)).toEqual(["run_started", "node_started"]);
  });

  it("preserves executor uncertainty when no durable effect was prepared", async () => {
    const store = new MemoryRunStore();

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor: executorFrom(async (node) =>
        node.type === "agent" ? uncertainAgentOutcome([]) : successfulCommandOutcome(),
      ),
      now: incrementingClock(),
    });

    expect(state.nodes.implement?.error?.sideEffectStatus).toBe("uncertain");
  });

  it("preserves executor uncertainty after a committed durable effect", async () => {
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      const effect = await context.effectJournal.prepare(descriptor("/workspace/source.ts", "b"));
      const receipt = await effect.settle({ outcome: "committed", reason: "directory_synced" });
      return uncertainAgentOutcome(receipt === null ? [] : [receipt]);
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      now: incrementingClock(),
    });

    expect(state.nodes.implement?.error?.sideEffectStatus).toBe("uncertain");
    expect(state.nodes.implement?.evidence).toMatchObject({
      effectReceipts: [{ outcome: "committed" }],
    });
  });

  it("makes an unknown durable effect non-retryable despite executor optimism", async () => {
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      const effect = await context.effectJournal.prepare(descriptor("/workspace/source.ts", "b"));
      const receipt = await effect.settle({
        outcome: "unknown",
        reason: "post_commit_failure",
      });
      const outcome = uncertainAgentOutcome(receipt === null ? [] : [receipt]);
      if (outcome.status !== "failed") {
        throw new Error("uncertain test outcome must fail");
      }
      return {
        ...outcome,
        error: { ...outcome.error, retryable: true },
      };
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      now: incrementingClock(),
    });

    expect(state.nodes.implement?.error).toMatchObject({
      retryable: false,
      sideEffectStatus: "uncertain",
    });
  });

  it("records a side-effect-free cancellation when abort arrives after writable node start", async () => {
    const controller = new AbortController();
    const store = new AbortOnNodeStartStore(controller);
    let executorCalls = 0;

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor: executorFrom(async () => {
        executorCalls += 1;
        return successfulAgentOutcome([]);
      }),
      signal: controller.signal,
      now: incrementingClock(),
    });

    expect(executorCalls).toBe(0);
    expect(state).toMatchObject({
      status: "cancelled",
      nodes: { implement: { error: { sideEffectStatus: "none" }, effects: [] } },
    });
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_cancelled",
    ]);
  });

  it("derives cancellation as side-effect-free after a not-applied edit", async () => {
    const controller = new AbortController();
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      const effect = await context.effectJournal.prepare(descriptor("/workspace/source.ts", "b"));
      await effect.settle({ outcome: "not_applied", reason: "commit_not_entered" });
      controller.abort(new Error("cancel after non-entry"));
      return successfulAgentOutcome([], [descriptor("/workspace/source.ts", "b")]);
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      signal: controller.signal,
      now: incrementingClock(),
    });

    expect(state).toMatchObject({
      status: "cancelled",
      nodes: {
        implement: {
          error: { sideEffectStatus: "none" },
          effects: [{ settlement: { outcome: "not_applied" } }],
          evidence: { effectReceipts: [] },
        },
      },
    });
  });

  it("retains committed evidence when cancellation races agent success", async () => {
    const controller = new AbortController();
    const store = new MemoryRunStore();
    const executor = executorFrom(async (node, context) => {
      if (node.type === "command") {
        return successfulCommandOutcome();
      }
      if (context.effectJournal === undefined) {
        throw new Error("missing durable effect journal");
      }
      const effect = await context.effectJournal.prepare(descriptor("/workspace/source.ts", "b"));
      const receipt = await effect.settle({
        outcome: "committed",
        reason: "directory_synced",
      });
      controller.abort(new Error("cancel after commit"));
      return successfulAgentOutcome(receipt === null ? [] : [receipt]);
    });

    const state = await runWorkflow(editWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "effect-run",
      store,
      executor,
      signal: controller.signal,
      now: incrementingClock(),
    });

    expect(state).toMatchObject({
      status: "cancelled",
      nodes: {
        implement: {
          error: { sideEffectStatus: "committed" },
          effects: [{ settlement: { outcome: "committed" } }],
          evidence: { effectReceipts: [{ sequence: 1, outcome: "committed" }] },
        },
      },
    });
  });
});

class MemoryRunStore implements RunEventStore {
  readonly events: RunEvent[] = [];
  readonly attemptedTypes: RunEvent["type"][] = [];

  constructor(
    private readonly failingType?: RunEvent["type"],
    private remainingFailures = 0,
  ) {}

  async append(event: RunEvent): Promise<void> {
    this.attemptedTypes.push(event.type);
    if (event.type === this.failingType && this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error(`injected persistence failure for ${event.type}`);
    }
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }
}

class UndefinedRejectingRunStore extends MemoryRunStore {
  #rejected = false;

  override async append(event: RunEvent): Promise<void> {
    this.attemptedTypes.push(event.type);
    if (event.type === "node_effect_prepared" && !this.#rejected) {
      this.#rejected = true;
      throw undefined;
    }
    this.events.push(structuredClone(event));
  }
}

class AbortOnNodeStartStore extends MemoryRunStore {
  constructor(private readonly controller: AbortController) {
    super();
  }

  override async append(event: RunEvent): Promise<void> {
    await super.append(event);
    if (event.type === "node_started" && event.nodeId === "implement") {
      this.controller.abort(new Error("cancel after durable start"));
    }
  }
}

function descriptor(target: string, digestSeed: string) {
  return {
    kind: "filesystem.edit" as const,
    target,
    operationDigest: digestSeed.repeat(64),
    beforeSha256: "c".repeat(64),
    afterSha256: "d".repeat(64),
    mode: 0o644,
  };
}

function executorFrom(
  execute: (node: CompiledNode, context: NodeExecutionContext) => Promise<NodeExecutionOutcome>,
): NodeExecutor {
  return { execute };
}

function successfulAgentOutcome(
  effectReceipts: readonly AgentEffectReceipt[],
  authorizedEffects: readonly ReturnType<typeof descriptor>[] = effectReceipts.map((receipt) => ({
    kind: receipt.kind,
    target: receipt.target,
    operationDigest: receipt.operationDigest,
    beforeSha256: receipt.beforeSha256,
    afterSha256: receipt.afterSha256,
    mode: 0o644,
  })),
) {
  const policy = new PolicyBroker(
    {
      runId: "effect-run",
      workflowId: "durable-effect-workflow",
      nodeId: "implement",
      attempt: 1,
    },
    ["filesystem.write"],
  );
  for (const effect of authorizedEffects) {
    policy.authorize({
      action: "filesystem.write",
      target: effect.target,
      boundary: "inside",
      operationDigest: effect.operationDigest,
    });
  }
  return {
    status: "succeeded" as const,
    evidence: {
      kind: "agent" as const,
      provider: "test",
      model: "deterministic",
      text: "done",
      textHash: createHash("sha256").update("done").digest("hex"),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: policy.close(),
      effectReceipts,
    },
  };
}

function uncertainAgentOutcome(
  effectReceipts: readonly AgentEffectReceipt[],
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "pi_agent_timeout",
      message: "provider cleanup did not settle",
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence: successfulAgentOutcome(effectReceipts).evidence,
  };
}

function successfulCommandOutcome() {
  const stdout = "verified\n";
  return {
    status: "succeeded" as const,
    evidence: {
      kind: "command" as const,
      executable: "node",
      args: ["--version"],
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutHash: createHash("sha256").update(stdout).digest("hex"),
      stderrHash: createHash("sha256").update("").digest("hex"),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function editWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: durable-effect-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [read, edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function incrementingClock() {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(`2026-08-07T10:10:${String(seconds).padStart(2, "0")}.000Z`);
  };
}
