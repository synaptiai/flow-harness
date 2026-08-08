import { describe, expect, it } from "vitest";

import { parseRunEvent, type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("proof-safe interrupted attempt replay", () => {
  it("archives a read-only attempt and permits the exact next attempt", () => {
    const state = replay([
      runStarted({ effectProtocol: "none" }),
      nodeStarted(2),
      interrupted(3),
      resumed(4),
      nodeStarted(5, 2),
    ]);

    expect(state.recoveryRequirements).toEqual({
      implement: { mode: "fresh", maxAttempts: 3, effectProtocol: "none" },
    });
    expect(state.nodes.implement).toMatchObject({
      status: "running",
      attempt: 2,
      interruptedAttempts: [
        {
          attempt: 1,
          startedAt: at(2),
          interruptedAt: at(3),
          reason: "process_interrupted",
          disposition: "fresh_retry",
          resourceAccounting: "incomplete",
          effectProtocol: null,
          effects: [],
        },
      ],
    });
    expect(Object.isFrozen(state.recoveryRequirements)).toBe(true);
    expect(Object.isFrozen(state.nodes.implement?.interruptedAttempts)).toBe(true);
    expect(Object.isFrozen(state.nodes.implement?.interruptedAttempts[0])).toBe(true);
  });

  it.each([
    ["no effects", []],
    ["executor-settled not-applied effect", [prepared(3), settledNotApplied(4)]],
    ["reconciled not-applied effect", [prepared(3), reconciledNotApplied(4)]],
  ])("accepts a durable edit attempt with %s", (_case, effects) => {
    const sequence = effects.length + 3;
    const state = replay([
      runStarted({ effectProtocol: "flow.effects/v1" }),
      nodeStarted(2, 1, "flow.effects/v1"),
      ...effects,
      interrupted(sequence),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "pending",
      attempt: 1,
      startedAt: null,
      effectProtocol: null,
      effects: [],
    });
    expect(state.nodes.implement?.interruptedAttempts[0]?.effects).toHaveLength(effects.length / 2);
  });

  it.each([
    ["committed settlement", settledCommitted(4)],
    ["unknown settlement", settledUnknown(4)],
    ["applied reconciliation", reconciledApplied(4)],
    ["unknown reconciliation", reconciledUnknown(4)],
  ])("rejects retry after an effect has a %s", (_case, resolution) => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "flow.effects/v1" }),
        nodeStarted(2, 1, "flow.effects/v1"),
        prepared(3),
        resolution,
        interrupted(5),
      ]),
    ).toThrow(/not applied|recovery|effect/i);
  });

  it("rejects retry while a durable effect remains open", () => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "flow.effects/v1" }),
        nodeStarted(2, 1, "flow.effects/v1"),
        prepared(3),
        interrupted(4),
      ]),
    ).toThrow(/open|unresolved|not applied|effect/i);
  });

  it("rejects fresh recovery for an execution-capable attempt even before a command starts", () => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "none" }),
        { ...nodeStarted(2), commandProtocol: "flow.agent-commands/v1" },
        interrupted(3),
      ]),
    ).toThrow(/command|execution|recovery/i);
  });

  it.each([
    ["read-only policy with a durable protocol", "none", "flow.effects/v1"],
    ["edit policy without its durable protocol", "flow.effects/v1", undefined],
  ] as const)("rejects a %s", (_case, requiredProtocol, startedProtocol) => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: requiredProtocol }),
        nodeStarted(2, 1, startedProtocol),
        interrupted(3),
      ]),
    ).toThrow(/effect protocol|recovery/i);
  });

  it("rejects recovery when the workflow did not opt in", () => {
    expect(() => replay([runStarted(), nodeStarted(2), interrupted(3)])).toThrow(
      /not configured|recovery/i,
    );
  });

  it("rejects recovery after the final configured attempt", () => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "none", maxAttempts: 2 }),
        nodeStarted(2),
        interrupted(3),
        resumed(4),
        nodeStarted(5, 2),
        interrupted(6, 2),
      ]),
    ).toThrow(/attempt|exhausted|recovery/i);
  });

  it.each([
    ["model tokens", { maxModelTokens: 100 }],
    ["model cost", { maxCostUsdMicros: 100 }],
    ["active execution time", { maxExecutionMs: 100 }],
  ])("rejects recovery with an unaccountable %s budget", (_case, budget) => {
    expect(() =>
      replay([runStarted({ effectProtocol: "none", budget }), nodeStarted(2), interrupted(3)]),
    ).toThrow(/resource|account|budget/i);
  });

  it("requires capacity for the next node start", () => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "none", budget: { maxNodeStarts: 1 } }),
        nodeStarted(2),
        interrupted(3),
      ]),
    ).toThrow(/node.?start|budget|capacity/i);

    expect(() =>
      replay([
        runStarted({ effectProtocol: "none", budget: { maxNodeStarts: 2 } }),
        nodeStarted(2),
        interrupted(3),
      ]),
    ).not.toThrow();
  });

  it("requires exact attempt identities for interruption and restart", () => {
    expect(() =>
      replay([runStarted({ effectProtocol: "none" }), nodeStarted(2), interrupted(3, 2)]),
    ).toThrow(/attempt/i);

    expect(() =>
      replay([
        runStarted({ effectProtocol: "none" }),
        nodeStarted(2),
        interrupted(3),
        resumed(4),
        nodeStarted(5, 3),
      ]),
    ).toThrow(/next node attempt|attempt/i);
  });

  it("rejects duplicate interruption disposition", () => {
    expect(() =>
      replay([
        runStarted({ effectProtocol: "none" }),
        nodeStarted(2),
        interrupted(3),
        interrupted(4),
      ]),
    ).toThrow(/running|duplicate|pending/i);
  });

  it("rejects duplicate or out-of-run recovery requirements", () => {
    const started = runStarted({ effectProtocol: "none" });
    const requirement = started.recoveryRequirements?.[0];
    if (requirement === undefined) {
      throw new Error("test recovery requirement was not created");
    }

    expect(() =>
      replay([{ ...started, recoveryRequirements: [requirement, requirement] }]),
    ).toThrow(/unique node ids/i);
    expect(() =>
      replay([
        {
          ...started,
          recoveryRequirements: [{ ...requirement, nodeId: "outside-run" }],
        },
      ]),
    ).toThrow(/outside the run node set/i);
  });

  it.each([
    ["unsupported mode", { mode: "continue" }],
    ["attempt limit below the retry minimum", { maxAttempts: 1 }],
    ["attempt limit above the safety maximum", { maxAttempts: 17 }],
    ["unsupported effect protocol", { effectProtocol: "legacy" }],
    ["unknown policy property", { additionalAuthority: true }],
  ])("rejects an %s in persisted recovery policy", (_case, override) => {
    const started = runStarted({ effectProtocol: "none" });
    const requirement = started.recoveryRequirements?.[0];
    if (requirement === undefined) {
      throw new Error("test recovery requirement was not created");
    }

    expect(() =>
      parseRunEvent({
        ...started,
        recoveryRequirements: [{ ...requirement, ...override }],
      }),
    ).toThrow(/recoveryRequirements/i);
  });
});

interface StartOptions {
  readonly effectProtocol?: "none" | "flow.effects/v1";
  readonly maxAttempts?: number;
  readonly budget?: {
    readonly maxNodeStarts?: number;
    readonly maxModelTokens?: number;
    readonly maxCostUsdMicros?: number;
    readonly maxExecutionMs?: number;
  };
}

function runStarted(options?: StartOptions) {
  return {
    ...base(1),
    type: "run_started",
    nodeIds: ["implement"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
    ...(options?.budget === undefined ? {} : { budget: options.budget }),
    ...(options?.effectProtocol === undefined
      ? {}
      : {
          recoveryRequirements: [
            {
              nodeId: "implement",
              mode: "fresh",
              maxAttempts: options.maxAttempts ?? 3,
              effectProtocol: options.effectProtocol,
            },
          ],
        }),
  };
}

function nodeStarted(sequence: number, attempt = 1, effectProtocol?: "flow.effects/v1") {
  return {
    ...base(sequence),
    type: "node_started",
    nodeId: "implement",
    attempt,
    ...(effectProtocol === undefined ? {} : { effectProtocol }),
  };
}

function interrupted(sequence: number, attempt = 1) {
  return {
    ...base(sequence),
    type: "node_attempt_interrupted",
    nodeId: "implement",
    attempt,
    reason: "process_interrupted",
    disposition: "fresh_retry",
    resourceAccounting: "incomplete",
  };
}

function resumed(sequence: number) {
  return { ...base(sequence), type: "run_resumed" };
}

function prepared(sequence: number) {
  return {
    ...base(sequence),
    type: "node_effect_prepared",
    nodeId: "implement",
    attempt: 1,
    effectId: `effect-${sequence}`,
    effectSequence: 1,
    descriptor: {
      kind: "filesystem.edit",
      target: "/workspace/source.ts",
      operationDigest: "b".repeat(64),
      beforeSha256: "c".repeat(64),
      afterSha256: "d".repeat(64),
      mode: 0o644,
    },
  };
}

function settledNotApplied(sequence: number) {
  return settled(sequence, "not_applied", "commit_not_entered");
}

function settledCommitted(sequence: number) {
  return settled(sequence, "committed", "directory_synced");
}

function settledUnknown(sequence: number) {
  return settled(sequence, "unknown", "post_commit_failure");
}

function settled(sequence: number, outcome: string, reason: string) {
  return {
    ...base(sequence),
    type: "node_effect_settled",
    nodeId: "implement",
    attempt: 1,
    effectId: "effect-3",
    outcome,
    reason,
  };
}

function reconciledNotApplied(sequence: number) {
  return reconciled(sequence, "not_applied", "target_matches_before", "c");
}

function reconciledApplied(sequence: number) {
  return reconciled(sequence, "applied", "target_matches_after", "d");
}

function reconciledUnknown(sequence: number) {
  return reconciled(sequence, "unknown", "target_content_diverged", "e");
}

function reconciled(sequence: number, outcome: string, reason: string, digest: string) {
  return {
    ...base(sequence),
    type: "node_effect_reconciled",
    nodeId: "implement",
    attempt: 1,
    effectId: "effect-3",
    outcome,
    reason,
    observedSha256: digest.repeat(64),
    observedMode: 0o644,
  };
}

function replay(events: readonly unknown[]) {
  return reduceRunEvents(events as readonly RunEvent[]);
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: at(sequence),
    runId: "run-recovery",
    workflowId: "workflow-recovery",
  };
}

function at(sequence: number): string {
  return `2026-08-07T17:00:${String(sequence).padStart(2, "0")}.000Z`;
}
