import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { parseRunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";

describe("durable node effect replay", () => {
  it("replays an immutable prepared effect for a protocol-v1 attempt", () => {
    const state = reduceRunEvents([
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
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "running",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
      effects: [
        {
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
          preparedAt: "2026-08-07T10:00:03.000Z",
          settlement: null,
        },
      ],
    });
    expect(Object.isFrozen(state.nodes.implement?.effects)).toBe(true);
    expect(Object.isFrozen(state.nodes.implement?.effects[0]?.descriptor)).toBe(true);
  });

  it.each([
    ["committed", "directory_synced"],
    ["not_applied", "commit_not_entered"],
    ["unknown", "post_commit_failure"],
  ] as const)("settles a prepared effect as %s", (outcome, reason) => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      parseRunEvent({
        ...base(4),
        type: "node_effect_settled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        outcome,
        reason,
      }),
    ]);

    expect(state.nodes.implement?.effects[0]).toMatchObject({
      effectId: "effect-3",
      settlement: {
        outcome,
        reason,
        settledAt: "2026-08-07T10:00:04.000Z",
      },
    });
    expect(Object.isFrozen(state.nodes.implement?.effects[0]?.settlement)).toBe(true);
  });

  it("rejects a terminal outcome while a prepared effect remains unresolved", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        parseRunEvent({
          ...base(4),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: {
            code: "agent_failed",
            message: "agent stopped",
            retryable: false,
            sideEffectStatus: "uncertain",
          },
          evidence: null,
        }),
      ]),
    ).toThrow(/unresolved effect/i);
  });

  it("rejects terminal evidence that omits a committed durable effect", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("committed", "directory_synced"),
        parseRunEvent({
          ...base(5),
          type: "node_succeeded",
          nodeId: "implement",
          attempt: 1,
          evidence: agentEvidence(undefined, "/workspace/source.ts", true),
        }),
      ]),
    ).toThrow(/durable effect receipts/i);
  });

  it("accepts terminal evidence that exactly projects a committed effect", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      settledEvent("committed", "directory_synced"),
      parseRunEvent({
        ...base(5),
        type: "node_succeeded",
        nodeId: "implement",
        attempt: 1,
        evidence: agentEvidence("committed"),
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        effectReceipts: [{ sequence: 1, outcome: "committed" }],
      },
    });
  });

  it("rejects a terminal receipt whose target differs from its durable effect", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("committed", "directory_synced"),
        parseRunEvent({
          ...base(5),
          type: "node_succeeded",
          nodeId: "implement",
          attempt: 1,
          evidence: agentEvidence("committed", "/workspace/other.ts", true, "/workspace/source.ts"),
        }),
      ]),
    ).toThrow(/durable effect receipts/i);
  });

  it("maps an unknown settlement to an uncertain terminal receipt", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      settledEvent("unknown", "post_commit_failure"),
      parseRunEvent({
        ...base(5),
        type: "node_failed",
        nodeId: "implement",
        attempt: 1,
        error: failure("uncertain"),
        evidence: agentEvidence("uncertain"),
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "failed",
      error: { sideEffectStatus: "uncertain" },
      evidence: { effectReceipts: [{ outcome: "uncertain" }] },
    });
  });

  it("accepts a not-applied settlement without a terminal receipt", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      settledEvent("not_applied", "commit_not_entered"),
      parseRunEvent({
        ...base(5),
        type: "node_failed",
        nodeId: "implement",
        attempt: 1,
        error: failure("none"),
        evidence: agentEvidence(undefined, "/workspace/source.ts", true),
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "failed",
      error: { sideEffectStatus: "none" },
      evidence: { kind: "agent", effectReceipts: [] },
    });
  });

  it("rejects a not-applied effect without its write authorization evidence", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("not_applied", "commit_not_entered"),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: failure("none"),
          evidence: null,
        }),
      ]),
    ).toThrow(/authorization/i);
  });

  it("rejects a not-applied effect with mismatched write authorization evidence", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("not_applied", "commit_not_entered"),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: failure("none"),
          evidence: agentEvidence(undefined, "/workspace/other.ts", true),
        }),
      ]),
    ).toThrow(/authorization/i);
  });

  it("accepts conservative uncertainty when the durable journal has no effects", () => {
    const state = reduceRunEvents([
      ...preparedEvents().slice(0, 2),
      parseRunEvent({
        ...base(3),
        type: "node_failed",
        nodeId: "implement",
        attempt: 1,
        error: failure("uncertain"),
        evidence: agentEvidence(),
      }),
    ]);

    expect(state.nodes.implement?.error?.sideEffectStatus).toBe("uncertain");
  });

  it("accepts conservative uncertainty when the durable journal has a committed effect", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      settledEvent("committed", "directory_synced"),
      parseRunEvent({
        ...base(5),
        type: "node_failed",
        nodeId: "implement",
        attempt: 1,
        error: failure("uncertain"),
        evidence: agentEvidence("committed"),
      }),
    ]);

    expect(state.nodes.implement?.error?.sideEffectStatus).toBe("uncertain");
  });

  it("preserves effect sequence gaps when an earlier effect was not applied", () => {
    const state = reduceRunEvents([
      ...preparedEvents(),
      parseRunEvent({
        ...base(4),
        type: "node_effect_prepared",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-4",
        effectSequence: 2,
        descriptor: {
          kind: "filesystem.edit",
          target: "/workspace/second.ts",
          operationDigest: "e".repeat(64),
          beforeSha256: "f".repeat(64),
          afterSha256: "a".repeat(64),
          mode: 0o600,
        },
      }),
      parseRunEvent({
        ...base(5),
        type: "node_effect_settled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        outcome: "not_applied",
        reason: "commit_not_entered",
      }),
      parseRunEvent({
        ...base(6),
        type: "node_effect_settled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-4",
        outcome: "committed",
        reason: "directory_synced",
      }),
      parseRunEvent({
        ...base(7),
        type: "node_succeeded",
        nodeId: "implement",
        attempt: 1,
        evidence: secondEffectEvidence(),
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      evidence: { effectReceipts: [{ sequence: 2, outcome: "committed" }] },
    });
  });

  it("rejects failure side-effect status that contradicts durable settlements", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("not_applied", "commit_not_entered"),
        parseRunEvent({
          ...base(5),
          type: "node_failed",
          nodeId: "implement",
          attempt: 1,
          error: failure("committed"),
          evidence: null,
        }),
      ]),
    ).toThrow(/side.effect status/i);
  });

  it("rejects duplicate settlement of one effect", () => {
    expect(() =>
      reduceRunEvents([
        ...preparedEvents(),
        settledEvent("committed", "directory_synced"),
        parseRunEvent({
          ...base(5),
          type: "node_effect_settled",
          nodeId: "implement",
          attempt: 1,
          effectId: "effect-3",
          outcome: "committed",
          reason: "directory_synced",
        }),
      ]),
    ).toThrow(/already settled/i);
  });

  it("rejects an outcome and reason that do not form a valid settlement", () => {
    expect(() =>
      parseRunEvent({
        ...base(4),
        type: "node_effect_settled",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-3",
        outcome: "committed",
        reason: "commit_not_entered",
      }),
    ).toThrow(/requires reason/i);
  });

  it("rejects effect events when the attempt did not declare the durable protocol", () => {
    const events = preparedEvents();
    const legacyStart = parseRunEvent({
      ...base(2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
    });

    expect(() =>
      reduceRunEvents([...events.slice(0, 1), legacyStart, ...events.slice(2, 3)]),
    ).toThrow(/effect protocol/i);
  });

  it("preserves legacy terminal receipt replay when no effect protocol was declared", () => {
    const state = reduceRunEvents([
      ...preparedEvents().slice(0, 1),
      parseRunEvent({
        ...base(2),
        type: "node_started",
        nodeId: "implement",
        attempt: 1,
      }),
      parseRunEvent({
        ...base(3),
        type: "node_succeeded",
        nodeId: "implement",
        attempt: 1,
        evidence: agentEvidence("committed"),
      }),
    ]);

    expect(state.nodes.implement).toMatchObject({
      status: "succeeded",
      effectProtocol: null,
      effects: [],
      evidence: { effectReceipts: [{ outcome: "committed" }] },
    });
  });

  it("rejects an effect identity that is not derived from its global event sequence", () => {
    const events = preparedEvents();
    const invalidIdentity = parseRunEvent({
      ...base(3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-99",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target: "/workspace/source.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        mode: 0o644,
      },
    });

    expect(() => reduceRunEvents([...events.slice(0, 2), invalidIdentity])).toThrow(
      /event sequence/i,
    );
  });

  it.each([
    ["other", 1],
    ["implement", 2],
  ] as const)("rejects effect preparation attributed to node %s attempt %s", (nodeId, attempt) => {
    const event = parseRunEvent({
      ...base(3),
      type: "node_effect_prepared",
      nodeId,
      attempt,
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
    });

    expect(() => reduceRunEvents([...preparedEvents().slice(0, 2), event])).toThrow(
      /unknown node|running|attempt/i,
    );
  });

  it("rejects a skipped attempt-local effect sequence", () => {
    const skipped = parseRunEvent({
      ...base(3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 2,
      descriptor: {
        kind: "filesystem.edit",
        target: "/workspace/source.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        mode: 0o644,
      },
    });

    expect(() => reduceRunEvents([...preparedEvents().slice(0, 2), skipped])).toThrow(
      /effect sequence/i,
    );
  });

  it("rejects settlement without a prepared effect", () => {
    const settlement = parseRunEvent({
      ...base(3),
      type: "node_effect_settled",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      outcome: "committed",
      reason: "directory_synced",
    });

    expect(() => reduceRunEvents([...preparedEvents().slice(0, 2), settlement])).toThrow(
      /unknown effect/i,
    );
  });

  it("rejects effect events after the node is terminal", () => {
    const terminal = parseRunEvent({
      ...base(3),
      type: "node_succeeded",
      nodeId: "implement",
      attempt: 1,
      evidence: agentEvidence(),
    });
    const lateEffect = parseRunEvent({
      ...base(4),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-4",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target: "/workspace/source.ts",
        operationDigest: "b".repeat(64),
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        mode: 0o644,
      },
    });

    expect(() => reduceRunEvents([...preparedEvents().slice(0, 2), terminal, lateEffect])).toThrow(
      /running|terminal/i,
    );
  });

  it.each([
    { field: "digest", operationDigest: "b".repeat(63), mode: 0o644 },
    { field: "mode", operationDigest: "b".repeat(64), mode: 0o1000 },
  ])("rejects a malformed effect $field before replay", ({ operationDigest, mode }) => {
    expect(() =>
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
          operationDigest,
          beforeSha256: "c".repeat(64),
          afterSha256: "d".repeat(64),
          mode,
        },
      }),
    ).toThrow();
  });

  it.each(["relative/source.ts", "/workspace/../outside.ts", "/workspace/source\0.ts"])(
    "rejects a non-canonical effect target %j",
    (target) => {
      expect(() =>
        parseRunEvent({
          ...base(3),
          type: "node_effect_prepared",
          nodeId: "implement",
          attempt: 1,
          effectId: "effect-3",
          effectSequence: 1,
          descriptor: {
            kind: "filesystem.edit",
            target,
            operationDigest: "b".repeat(64),
            beforeSha256: "c".repeat(64),
            afterSha256: "d".repeat(64),
            mode: 0o644,
          },
        }),
      ).toThrow(/target|path|canonical/i);
    },
  );

  it("rejects an effect sequence beyond the durable effect bound before replay", () => {
    expect(() =>
      parseRunEvent({
        ...base(35),
        type: "node_effect_prepared",
        nodeId: "implement",
        attempt: 1,
        effectId: "effect-35",
        effectSequence: 33,
        descriptor: {
          kind: "filesystem.edit",
          target: "/workspace/source-33.ts",
          operationDigest: "e".repeat(64),
          beforeSha256: "c".repeat(64),
          afterSha256: "d".repeat(64),
          mode: 0o644,
        },
      }),
    ).toThrow(/32|too big/i);
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
  ];
}

function settledEvent(
  outcome: "committed" | "not_applied" | "unknown",
  reason: "directory_synced" | "commit_not_entered" | "post_commit_failure",
) {
  return parseRunEvent({
    ...base(4),
    type: "node_effect_settled",
    nodeId: "implement",
    attempt: 1,
    effectId: "effect-3",
    outcome,
    reason,
  });
}

function agentEvidence(
  receiptOutcome?: "committed" | "uncertain",
  target = "/workspace/source.ts",
  authorizeEffect = receiptOutcome !== undefined,
  authorizationTarget = target,
) {
  const effectReceipts =
    receiptOutcome === undefined
      ? []
      : [
          {
            version: 1 as const,
            sequence: 1,
            runId: "run-1",
            workflowId: "durable-effects",
            nodeId: "implement",
            attempt: 1,
            kind: "filesystem.edit" as const,
            target,
            operationDigest: "b".repeat(64),
            beforeSha256: "c".repeat(64),
            afterSha256: "d".repeat(64),
            outcome: receiptOutcome,
          },
        ];
  return {
    kind: "agent" as const,
    provider: "test",
    model: "deterministic",
    text: "done",
    textHash: createHash("sha256").update("done").digest("hex"),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: authorizeEffect ? editPolicy(authorizationTarget) : [],
    effectReceipts,
  };
}

function editPolicy(target: string) {
  const broker = new PolicyBroker(
    {
      runId: "run-1",
      workflowId: "durable-effects",
      nodeId: "implement",
      attempt: 1,
    },
    ["filesystem.write"],
  );
  broker.authorize({
    action: "filesystem.write",
    target,
    boundary: "inside",
    operationDigest: "b".repeat(64),
  });
  return broker.close();
}

function secondEffectEvidence() {
  const target = "/workspace/second.ts";
  const operationDigest = "e".repeat(64);
  const broker = new PolicyBroker(
    {
      runId: "run-1",
      workflowId: "durable-effects",
      nodeId: "implement",
      attempt: 1,
    },
    ["filesystem.write"],
  );
  broker.authorize({
    action: "filesystem.write",
    target: "/workspace/source.ts",
    boundary: "inside",
    operationDigest: "b".repeat(64),
  });
  broker.authorize({
    action: "filesystem.write",
    target,
    boundary: "inside",
    operationDigest,
  });
  return {
    kind: "agent" as const,
    provider: "test",
    model: "deterministic",
    text: "done",
    textHash: createHash("sha256").update("done").digest("hex"),
    textTruncated: false,
    durationMs: 1,
    policyDecisions: broker.close(),
    effectReceipts: [
      {
        version: 1 as const,
        sequence: 2,
        runId: "run-1",
        workflowId: "durable-effects",
        nodeId: "implement",
        attempt: 1,
        kind: "filesystem.edit" as const,
        target,
        operationDigest,
        beforeSha256: "f".repeat(64),
        afterSha256: "a".repeat(64),
        outcome: "committed" as const,
      },
    ],
  };
}

function failure(sideEffectStatus: "none" | "committed" | "uncertain") {
  return {
    code: "agent_failed",
    message: "agent stopped",
    retryable: false,
    sideEffectStatus,
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
