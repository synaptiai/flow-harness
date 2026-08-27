import { describe, expect, it } from "vitest";

import { parseRunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("durable effect reconciliation replay", () => {
  it("replays an exact applied create effect with an explicit absent pre-state", () => {
    const state = reduceRunEvents([
      ...preparedCreateEvents(),
      reconciliationEvent({
        outcome: "applied",
        reason: "target_matches_after",
        observedSha256: "d".repeat(64),
        observedMode: 0o644,
      }),
    ]);

    expect(state.nodes.implement?.effects[0]).toMatchObject({
      descriptor: { kind: "filesystem.create", beforeSha256: null },
      reconciliation: { outcome: "applied", reason: "target_matches_after" },
    });
  });

  it("keeps a missing create effect unknown instead of authorizing a retry", () => {
    const state = reduceRunEvents([
      ...preparedCreateEvents(),
      reconciliationEvent({ outcome: "unknown", reason: "target_missing" }),
    ]);

    expect(state.nodes.implement?.effects[0]?.reconciliation).toMatchObject({
      outcome: "unknown",
      reason: "target_missing",
    });
  });

  it("rejects a create effect that claims an existing before digest", () => {
    expect(() =>
      parseRunEvent({
        ...preparedCreateEvents()[2],
        descriptor: {
          kind: "filesystem.create",
          target: "/workspace/new.ts",
          operationDigest: "b".repeat(64),
          beforeSha256: "c".repeat(64),
          afterSha256: "d".repeat(64),
          mode: 0o644,
        },
      }),
    ).toThrow(/beforeSha256|invalid/i);
  });

  it.each([
    ["applied", "target_matches_after", "d", 0o644],
    ["not_applied", "target_matches_before", "c", 0o644],
    ["unknown", "target_content_diverged", "e", 0o600],
    ["unknown", "target_mode_diverged", "d", 0o600],
  ] as const)(
    "replays an immutable %s observation with recovery provenance",
    (outcome, reason, observedDigest, observedMode) => {
      const state = reduceRunEvents([
        ...preparedEvents(),
        reconciliationEvent({
          outcome,
          reason,
          observedSha256: observedDigest.repeat(64),
          observedMode,
        }),
      ]);

      expect(state.nodes.implement?.effects[0]).toMatchObject({
        settlement: null,
        reconciliation: {
          outcome,
          reason,
          observedSha256: observedDigest.repeat(64),
          observedMode,
          reconciledAt: "2026-08-07T10:00:04.000Z",
        },
      });
      expect(Object.isFrozen(state.nodes.implement?.effects[0]?.reconciliation)).toBe(true);
    },
  );

  it.each([
    "target_missing",
    "target_not_regular",
    "target_not_directory",
    "target_not_empty",
    "target_unreadable",
    "target_too_large",
    "target_changed_during_observation",
  ] as const)("replays bounded unknown reason %s without invented file evidence", (reason) => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      reconciliationEvent({ outcome: "unknown", reason }),
    ]);

    expect(state.nodes.implement?.effects[0]).toMatchObject({
      settlement: null,
      reconciliation: {
        outcome: "unknown",
        reason,
        reconciledAt: "2026-08-07T10:00:04.000Z",
      },
    });
    expect(state.nodes.implement?.effects[0]?.reconciliation).not.toHaveProperty("observedSha256");
  });

  it.each([
    {
      name: "applied with the before digest",
      input: exactInput("applied", "target_matches_after", "c", 0o644),
    },
    {
      name: "not applied with the after digest",
      input: exactInput("not_applied", "target_matches_before", "d", 0o644),
    },
    {
      name: "exact content with the wrong mode",
      input: exactInput("applied", "target_matches_after", "d", 0o600),
    },
    {
      name: "content divergence that matches the before digest",
      input: exactInput("unknown", "target_content_diverged", "c", 0o644),
    },
    {
      name: "mode divergence whose content is also divergent",
      input: exactInput("unknown", "target_mode_diverged", "e", 0o600),
    },
    {
      name: "mode divergence with the expected mode",
      input: exactInput("unknown", "target_mode_diverged", "d", 0o644),
    },
  ])("rejects $name", ({ input }) => {
    expect(() => reduceRunEvents([...preparedEvents(), reconciliationEvent(input)])).toThrow(
      /reconciliation|observation|digest|mode|contradict/i,
    );
  });

  it.each([
    {
      outcome: "applied",
      reason: "target_matches_before",
      observedSha256: "d".repeat(64),
      observedMode: 0o644,
    },
    {
      outcome: "unknown",
      reason: "target_missing",
      observedSha256: "e".repeat(64),
      observedMode: 0o600,
    },
    {
      outcome: "unknown",
      reason: "target_content_diverged",
    },
  ])("rejects an invalid reconciliation shape before replay", (input) => {
    expect(() => reconciliationEvent(input)).toThrow();
  });

  it("rejects a duplicate reconciliation", () => {
    const first = reconciliationEvent(exactInput("applied", "target_matches_after", "d", 0o644));
    const duplicate = parseRunEvent({
      ...first,
      sequence: 5,
      at: "2026-08-07T10:00:05.000Z",
    });

    expect(() => reduceRunEvents([...preparedEvents(), first, duplicate])).toThrow(
      /already reconciled|resolved/i,
    );
  });

  it("rejects reconciliation after executor settlement", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_effect_settled",
          nodeId: "implement",
          attempt: 1,
          effectId: "effect-3",
          outcome: "committed",
          reason: "directory_synced",
        }),
        parseRunEvent({
          ...reconciliationEvent(exactInput("applied", "target_matches_after", "d", 0o644)),
          sequence: 5,
          at: "2026-08-07T10:00:05.000Z",
        }),
      ]),
    ).toThrow(/settled|resolved/i);
  });

  it("rejects executor settlement after reconciliation", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        reconciliationEvent(exactInput("not_applied", "target_matches_before", "c", 0o644)),
        parseRunEvent({
          ...base(5),
          type: "node_effect_settled",
          nodeId: "implement",
          attempt: 1,
          effectId: "effect-3",
          outcome: "not_applied",
          reason: "commit_not_entered",
        }),
      ]),
    ).toThrow(/reconciled|resolved/i);
  });

  it("rejects reconciliation for an unknown effect", () => {
    const unknown = parseRunEvent({
      ...reconciliationEvent(exactInput("applied", "target_matches_after", "d", 0o644)),
      sequence: 3,
      at: "2026-08-07T10:00:03.000Z",
    });
    expect(() => reduceRunEvents([...preparedEvents().slice(0, 2), unknown])).toThrow(
      /unknown effect/i,
    );
  });

  it("does not allow a reconciled effect to terminalize the interrupted attempt", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        reconciliationEvent(exactInput("not_applied", "target_matches_before", "c", 0o644)),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: {
            code: "agent_failed",
            message: "agent interrupted",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: null,
        }),
      ]),
    ).toThrow(/unresolved effect/i);
  });
});

function preparedEvents() {
  return [
    parseRunEvent({
      ...base(1),
      type: "run_started",
      nodeIds: ["implement"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
    }),
    parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    }),
    parseRunEvent({
      ...base(3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target: "/workspace/source.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        mode: 0o644,
      },
    }),
  ] as const;
}

function preparedCreateEvents() {
  const [started, nodeStarted] = preparedEvents();
  return [
    started,
    nodeStarted,
    parseRunEvent({
      ...base(3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.create",
        target: "/workspace/new.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: null,
        afterSha256: "d".repeat(64),
        mode: 0o644,
      },
    }),
  ];
}

function reconciliationEvent(input: Record<string, unknown>) {
  return parseRunEvent({
    ...base(4),
    type: "node_effect_reconciled",
    nodeId: "implement",
    attempt: 1,
    effectId: "effect-3",
    ...input,
  });
}

function exactInput(
  outcome: "applied" | "not_applied" | "unknown",
  reason:
    | "target_matches_after"
    | "target_matches_before"
    | "target_content_diverged"
    | "target_mode_diverged",
  digest: string,
  mode: number,
) {
  return {
    outcome,
    reason,
    observedSha256: digest.repeat(64),
    observedMode: mode,
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-1",
    workflowId: "durable-effects",
  };
}
