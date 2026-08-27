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
import { resumeWorkflow } from "../../../src/application/run-workflow.js";
import {
  parseRunEvent,
  reduceRunEvents,
  type FilesystemEditEffectDescriptor,
  type NodeEffectReconciliationInput,
  type RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";

describe("resumeWorkflow durable effect reconciliation", () => {
  it("durably records an observation before refusing the unfinished node", async () => {
    const store = new MemoryRecoverableRunStore(openEffectEvents());
    const executor = recordingExecutor();
    const reconciler = recordingReconciler((descriptor) => matchesAfter(descriptor));

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, executor, reconciler)),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(reconciler.targets).toEqual(["/workspace/first.ts"]);
    expect(executor.calls).toEqual([]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_reconciled",
    ]);
    expect(store.events.at(-1)).toMatchObject({
      sequence: 4,
      type: "node_effect_reconciled",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      outcome: "applied",
      reason: "target_matches_after",
      observedSha256: "d".repeat(64),
      observedMode: 0o644,
    });
    expect(reduceRunEvents(store.events).nodes.implement?.effects[0]).toMatchObject({
      settlement: null,
      reconciliation: { outcome: "applied", reason: "target_matches_after" },
    });
    expect(store.releaseCalls).toEqual(["run-reconcile"]);
  });

  it("validates incompatible history before invoking the reconciler", async () => {
    const events = openEffectEvents();
    events[0] = parseRunEvent({ ...events[0], workflowDigest: "f".repeat(64) });
    const store = new MemoryRecoverableRunStore(events);
    const reconciler = recordingReconciler((descriptor) => matchesAfter(descriptor));

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), reconciler)),
    ).rejects.toMatchObject({ code: "workflow_mismatch" });

    expect(reconciler.targets).toEqual([]);
    expect(store.events).toHaveLength(3);
  });

  it("preserves a durable prefix when a later effect cannot be observed", async () => {
    const store = new MemoryRecoverableRunStore(openEffectEvents(2));
    const firstPass = recordingReconciler((descriptor) => {
      if (descriptor.target.endsWith("second.ts")) {
        throw new Error("injected second observation failure");
      }
      return matchesBefore(descriptor);
    });

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), firstPass)),
    ).rejects.toThrow(/second observation failure/i);

    expect(firstPass.targets).toEqual(["/workspace/first.ts", "/workspace/second.ts"]);
    expect(store.events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_prepared",
      "node_effect_reconciled",
    ]);

    const secondPass = recordingReconciler((descriptor) => matchesAfter(descriptor));
    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), secondPass)),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(secondPass.targets).toEqual(["/workspace/second.ts"]);
    expect(store.events.at(-1)).toMatchObject({
      sequence: 6,
      effectId: "effect-4",
      outcome: "applied",
    });
  });

  it("skips an already reconciled effect without duplicating its event", async () => {
    const initial = openEffectEvents();
    initial.push(
      parseRunEvent({
        ...base(4),
        type: "node_effect_reconciled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        ...matchesBefore(firstDescriptor()),
      }),
    );
    const store = new MemoryRecoverableRunStore(initial);
    const reconciler = recordingReconciler((descriptor) => matchesAfter(descriptor));

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), reconciler)),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(reconciler.targets).toEqual([]);
    expect(store.events).toHaveLength(4);
  });

  it("skips an executor-settled effect", async () => {
    const initial = openEffectEvents();
    initial.push(
      parseRunEvent({
        ...base(4),
        type: "node_effect_settled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        outcome: "committed",
        reason: "directory_synced",
      }),
    );
    const store = new MemoryRecoverableRunStore(initial);
    const reconciler = recordingReconciler((descriptor) => matchesAfter(descriptor));

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), reconciler)),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    expect(reconciler.targets).toEqual([]);
    expect(store.events).toHaveLength(4);
  });

  it("leaves the effect open when durable publication rejects", async () => {
    const store = new MemoryRecoverableRunStore(openEffectEvents(), "node_effect_reconciled");
    const reconciler = recordingReconciler((descriptor) => matchesAfter(descriptor));

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), reconciler)),
    ).rejects.toThrow(/injected persistence failure/i);

    expect(reconciler.targets).toEqual(["/workspace/first.ts"]);
    expect(store.events).toHaveLength(3);
    expect(reduceRunEvents(store.events).nodes.implement?.effects[0]).toMatchObject({
      settlement: null,
      reconciliation: null,
    });
  });

  it("fails closed when a reconciler returns without publishing an observation", async () => {
    const store = new MemoryRecoverableRunStore(openEffectEvents());
    const reconciler: NodeEffectReconciler = {
      reconcile: async () => undefined,
    };

    await expect(
      resumeWorkflow(workflow(), resumeOptions(store, recordingExecutor(), reconciler)),
    ).rejects.toThrow(/without publishing|reconciliation/i);
    expect(store.events).toHaveLength(3);
  });
});

class MemoryRecoverableRunStore implements RecoverableRunEventStore {
  readonly events: RunEvent[];
  readonly releaseCalls: string[] = [];

  constructor(
    initial: readonly RunEvent[],
    private readonly failingType?: RunEvent["type"],
  ) {
    this.events = structuredClone([...initial]);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async append(event: RunEvent): Promise<void> {
    if (event.type === this.failingType) {
      throw new Error("injected persistence failure");
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

function recordingReconciler(
  observe: (
    descriptor: FilesystemEditEffectDescriptor,
  ) => NodeEffectReconciliationInput | Promise<NodeEffectReconciliationInput>,
): NodeEffectReconciler & { readonly targets: string[] } {
  const targets: string[] = [];
  return {
    targets,
    async reconcile(descriptor, publish) {
      targets.push(descriptor.target);
      if (descriptor.kind !== "filesystem.edit") {
        throw new Error("expected an edit effect");
      }
      await publish(await observe(descriptor));
    },
  };
}

function recordingExecutor(): NodeExecutor & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async execute(
      node: CompiledNode,
      _context: NodeExecutionContext,
    ): Promise<NodeExecutionOutcome> {
      calls.push(node.id);
      throw new Error("executor must not run during effect reconciliation");
    },
  };
}

function resumeOptions(
  store: RecoverableRunEventStore,
  executor: NodeExecutor,
  effectReconciler: NodeEffectReconciler,
) {
  return {
    cwd: process.cwd(),
    protectedPaths: [],
    runId: "run-reconcile",
    store,
    executor,
    effectReconciler,
    now: () => new Date("2026-08-07T11:00:00.000Z"),
  };
}

function openEffectEvents(effectCount = 1): RunEvent[] {
  const compiled = workflow();
  const events: RunEvent[] = [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: resolve(process.cwd()),
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    }),
    preparedEvent(3, 1, firstDescriptor()),
  ];
  if (effectCount === 2) {
    events.push(preparedEvent(4, 2, secondDescriptor()));
  }
  return events;
}

function preparedEvent(
  sequence: number,
  effectSequence: number,
  descriptor: FilesystemEditEffectDescriptor,
) {
  return parseRunEvent({
    ...base(sequence),
    type: "node_effect_prepared",
    nodeId: "implement",
    attempt: 1,
    effectId: `effect-${sequence}`,
    effectSequence,
    descriptor,
  });
}

function firstDescriptor(): FilesystemEditEffectDescriptor {
  return {
    kind: "filesystem.edit",
    target: "/workspace/first.ts",
    operationDigest: "b".repeat(64),
    beforeSha256: "c".repeat(64),
    afterSha256: "d".repeat(64),
    mode: 0o644,
  };
}

function secondDescriptor(): FilesystemEditEffectDescriptor {
  return {
    kind: "filesystem.edit",
    target: "/workspace/second.ts",
    operationDigest: "e".repeat(64),
    beforeSha256: "f".repeat(64),
    afterSha256: "a".repeat(64),
    mode: 0o600,
  };
}

function matchesAfter(descriptor: FilesystemEditEffectDescriptor): NodeEffectReconciliationInput {
  return {
    outcome: "applied",
    reason: "target_matches_after",
    observedSha256: descriptor.afterSha256,
    observedMode: descriptor.mode,
  };
}

function matchesBefore(descriptor: FilesystemEditEffectDescriptor): NodeEffectReconciliationInput {
  return {
    outcome: "not_applied",
    reason: "target_matches_before",
    observedSha256: descriptor.beforeSha256,
    observedMode: descriptor.mode,
  };
}

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: recovery-reconciliation }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-reconcile",
    workflowId: "recovery-reconciliation",
  };
}
