import { describe, expect, it } from "vitest";

import {
  createIssueWorkflowAccounting,
  type IssueWorkflowDispatch,
  type IssueWorkflowSettlement,
  issueWorkflowDispatchSchema,
  issueWorkflowEnvelopeSchema,
  issueWorkflowSettlementSchema,
  prepareIssueWorkflowDispatch,
  settleIssueWorkflowDispatch,
} from "../../../src/domain/issue-lifecycle/workflow-accounting.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const envelope = {
  maxNodeStarts: 10,
  maxModelTokens: 100,
  maxCostUsdMicros: 100,
  maxExecutionMs: 100,
  maxArtifactBytes: 100,
};
const resources = {
  nodeStarts: 1,
  modelTokens: 20,
  modelCostUsdMicros: 10,
  executionMs: 10,
  artifactBytes: 10,
};
const availability = {
  nodeStarts: "complete",
  modelTokens: "complete",
  modelCostUsdMicros: "complete",
  executionMs: "complete",
  artifactBytes: "complete",
} as const;

function initial() {
  return createIssueWorkflowAccounting({
    parentIssueRunId: "issue-accounting",
    frozenContractDigest: digest,
    pools: { implementation: envelope, review: envelope },
  });
}

function dispatch(overrides: Partial<IssueWorkflowDispatch> = {}): IssueWorkflowDispatch {
  return {
    version: 1,
    dispatchId: "dispatch-one",
    parentIssueRunId: "issue-accounting",
    ordinal: 1,
    role: "implementation",
    cycle: 0,
    flowRunId: "issue-accounting-implementation-1",
    frozenContractDigest: digest,
    templateWorkflowDigest: digest,
    executionWorkflowDigest: digest,
    workspaceIdentityDigest: digest,
    candidateHead: null,
    reportDigest: null,
    envelope: { ...envelope, maxModelTokens: 50, maxCostUsdMicros: 50 },
    ...overrides,
  };
}

function settlement(overrides: Partial<IssueWorkflowSettlement> = {}): IssueWorkflowSettlement {
  return {
    version: 1,
    dispatchId: "dispatch-one",
    flowRunId: "issue-accounting-implementation-1",
    executionWorkflowDigest: digest,
    terminalSequence: 8,
    ledgerDigest: digest,
    status: "succeeded",
    resources,
    availability,
    ...overrides,
  };
}

function second(overrides: Partial<IssueWorkflowDispatch> = {}): IssueWorkflowDispatch {
  return dispatch({
    dispatchId: "dispatch-two",
    ordinal: 2,
    flowRunId: "issue-accounting-implementation-2",
    cycle: 1,
    candidateHead: "a".repeat(40),
    reportDigest: otherDigest,
    envelope: {
      maxNodeStarts: 2,
      maxModelTokens: 30,
      maxCostUsdMicros: 20,
      maxExecutionMs: 20,
      maxArtifactBytes: 20,
    },
    ...overrides,
  });
}

describe("issue workflow accounting", () => {
  it("creates independent empty role pools without mutating the caller", () => {
    const state = initial();
    expect(state.consumed.implementation).toEqual({
      nodeStarts: 0,
      modelTokens: 0,
      modelCostUsdMicros: 0,
      executionMs: 0,
      artifactBytes: 0,
    });
    expect(state.consumed.review).toEqual(state.consumed.implementation);
    expect(state.pending).toBeNull();
    expect(state.settled).toEqual([]);
    expect(Object.isFrozen(state.pools.implementation)).toBe(true);
    expect(Object.isFrozen(envelope)).toBe(false);
  });

  it.each(Object.keys(envelope))("requires the %s envelope dimension", (dimension) => {
    const incomplete: Record<string, number> = { ...envelope };
    delete incomplete[dimension];
    expect(issueWorkflowEnvelopeSchema.safeParse(incomplete).success).toBe(false);
  });

  it.each([-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid envelope limit %s",
    (maxModelTokens) => {
      expect(issueWorkflowEnvelopeSchema.safeParse({ ...envelope, maxModelTokens }).success).toBe(
        false,
      );
    },
  );

  it("reserves the exact immutable envelope without charging it as actual usage", () => {
    const before = initial();
    const proposed = dispatch();
    const state = prepareIssueWorkflowDispatch(before, proposed);
    expect(state.pending).toEqual(proposed);
    expect(state.consumed).toEqual(before.consumed);
    expect(before.pending).toBeNull();
    expect(Object.isFrozen(state.pending?.envelope)).toBe(true);
    expect(Object.isFrozen(proposed.envelope)).toBe(false);
  });

  it("forbids any other dispatch while either role has an unresolved reservation", () => {
    const state = prepareIssueWorkflowDispatch(initial(), dispatch());
    expect(() =>
      prepareIssueWorkflowDispatch(state, second({ role: "review", ordinal: 1 })),
    ).toThrow(/pending|unresolved/i);
  });

  it.each([
    ["parentIssueRunId", "issue-foreign"],
    ["frozenContractDigest", otherDigest],
    ["ordinal", 2],
  ])("rejects a dispatch with mismatched %s", (field, value) => {
    expect(() =>
      prepareIssueWorkflowDispatch(initial(), { ...dispatch(), [field]: value }),
    ).toThrow();
  });

  it.each(Object.keys(envelope))(
    "rejects an oversized %s envelope before dispatch",
    (dimension) => {
      expect(() =>
        prepareIssueWorkflowDispatch(initial(), {
          ...dispatch(),
          envelope: { ...envelope, [dimension]: 101 },
        }),
      ).toThrow(/budget|capacity|envelope/i);
    },
  );

  it.each(["succeeded", "failed", "cancelled", "resource_exhausted"] as const)(
    "charges actual usage and releases reservation for a %s child",
    (status) => {
      const state = settleIssueWorkflowDispatch(
        prepareIssueWorkflowDispatch(initial(), dispatch()),
        settlement({ status }),
      );
      expect(state.pending).toBeNull();
      expect(state.consumed.implementation).toEqual(resources);
      expect(state.consumed.review.modelTokens).toBe(0);
      expect(state.settled).toEqual([{ dispatch: dispatch(), settlement: settlement({ status }) }]);
      expect(Object.isFrozen(state.settled[0]?.settlement.resources)).toBe(true);
    },
  );

  it("rejects a settlement without a prepared dispatch", () => {
    expect(() => settleIssueWorkflowDispatch(initial(), settlement())).toThrow(/pending|prepared/i);
  });

  it.each([
    ["dispatchId", "dispatch-other"],
    ["flowRunId", "issue-other-review"],
    ["executionWorkflowDigest", otherDigest],
  ])("rejects settlement with mismatched %s", (field, value) => {
    expect(() =>
      settleIssueWorkflowDispatch(prepareIssueWorkflowDispatch(initial(), dispatch()), {
        ...settlement(),
        [field]: value,
      }),
    ).toThrow(/identity|match/i);
  });

  it("does not charge duplicate terminal receipts", () => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    expect(() => settleIssueWorkflowDispatch(settled, settlement())).toThrow();
    expect(settled.consumed.implementation).toEqual(resources);
  });

  it.each(["dispatchId", "flowRunId"] as const)("rejects reused %s", (field) => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    expect(() =>
      prepareIssueWorkflowDispatch(settled, second({ [field]: dispatch()[field] })),
    ).toThrow(/duplicate|reuse/i);
  });

  it("charges additional cycles cumulatively, never resetting original consumption", () => {
    const first = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    const next = second();
    const final = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(first, next),
      settlement({ dispatchId: next.dispatchId, flowRunId: next.flowRunId }),
    );
    expect(final.consumed.implementation.modelTokens).toBe(40);
    expect(final.consumed.implementation.nodeStarts).toBe(2);
    expect(first.consumed.implementation.modelTokens).toBe(20);
    expect(final.settled).toHaveLength(2);
  });

  it.each([
    ["maxNodeStarts", "nodeStarts"],
    ["maxModelTokens", "modelTokens"],
    ["maxCostUsdMicros", "modelCostUsdMicros"],
    ["maxExecutionMs", "executionMs"],
    ["maxArtifactBytes", "artifactBytes"],
  ] as const)(
    "does not spend unused review %s capacity on an implementation envelope",
    (limit, resource) => {
      const settled = settleIssueWorkflowDispatch(
        prepareIssueWorkflowDispatch(initial(), dispatch()),
        settlement(),
      );
      const remaining = envelope[limit] - resources[resource];
      const fitting = second({ envelope: { ...second().envelope, [limit]: remaining } });
      expect(prepareIssueWorkflowDispatch(settled, fitting).pending).toEqual(fitting);
      expect(() =>
        prepareIssueWorkflowDispatch(
          settled,
          second({ envelope: { ...fitting.envelope, [limit]: remaining + 1 } }),
        ),
      ).toThrow(/budget|capacity|envelope/i);
      expect(settled.consumed.review[resource]).toBe(0);
    },
  );

  it("admits an envelope exactly equal to remaining capacity", () => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    const next = second({ envelope: { ...second().envelope, maxModelTokens: 80 } });
    expect(prepareIssueWorkflowDispatch(settled, next).pending).toEqual(next);
  });

  it("rejects a supplied state whose consumed totals contradict its settled receipts", () => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    const forged = {
      ...settled,
      consumed: { ...settled.consumed, implementation: initial().consumed.implementation },
    };
    expect(() => prepareIssueWorkflowDispatch(forged, second())).toThrow(/accounting|replay/i);
  });

  it("rejects a supplied state that conceals unavailable settled usage", () => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement({ availability: { ...availability, modelTokens: "unavailable" } }),
    );
    const forged = {
      ...settled,
      availability: { ...settled.availability, implementation: availability },
    };
    expect(() => prepareIssueWorkflowDispatch(forged, second())).toThrow(/accounting|replay/i);
  });

  it("rejects settlement when supplied history fabricates consumed totals", () => {
    const pending = prepareIssueWorkflowDispatch(initial(), dispatch());
    const forged = {
      ...pending,
      consumed: { ...pending.consumed, review: resources },
    };
    expect(() => settleIssueWorkflowDispatch(forged, settlement())).toThrow(/accounting|replay/i);
  });

  it.each(Object.keys(availability))(
    "keeps unavailable %s sticky and blocks both roles",
    (dimension) => {
      const settled = settleIssueWorkflowDispatch(
        prepareIssueWorkflowDispatch(initial(), dispatch()),
        { ...settlement(), availability: { ...availability, [dimension]: "unavailable" } },
      );
      expect(settled.availability.implementation).toMatchObject({ [dimension]: "unavailable" });
      expect(settled.consumed.implementation).toEqual(resources);
      for (const role of ["implementation", "review"] as const) {
        expect(() => prepareIssueWorkflowDispatch(settled, second({ role }))).toThrow(
          /unavailable|unknown/i,
        );
      }
    },
  );

  it("retains full overshoot and prevents a new dispatch even in the other role", () => {
    const settled = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement({ resources: { ...resources, modelTokens: 101 }, status: "resource_exhausted" }),
    );
    expect(settled.consumed.implementation.modelTokens).toBe(101);
    expect(() => prepareIssueWorkflowDispatch(settled, second({ role: "review" }))).toThrow(
      /budget|exhaust/i,
    );
  });

  it("rejects overflowing actual settlement without altering prior state", () => {
    const first = settleIssueWorkflowDispatch(
      prepareIssueWorkflowDispatch(initial(), dispatch()),
      settlement(),
    );
    const next = second();
    const pending = prepareIssueWorkflowDispatch(first, next);
    expect(() =>
      settleIssueWorkflowDispatch(
        pending,
        settlement({
          dispatchId: next.dispatchId,
          flowRunId: next.flowRunId,
          resources: { ...resources, modelTokens: Number.MAX_SAFE_INTEGER },
        }),
      ),
    ).toThrow(/overflow/i);
    expect(pending.pending).toEqual(next);
    expect(pending.consumed.implementation.modelTokens).toBe(20);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid usage %s", (modelTokens) => {
    expect(
      issueWorkflowSettlementSchema.safeParse({
        ...settlement(),
        resources: { ...resources, modelTokens },
      }).success,
    ).toBe(false);
  });

  it("rejects nonterminal status and unexpected receipt properties", () => {
    expect(
      issueWorkflowSettlementSchema.safeParse({ ...settlement(), status: "running" }).success,
    ).toBe(false);
    expect(
      issueWorkflowSettlementSchema.safeParse({ ...settlement(), prompt: "untrusted" }).success,
    ).toBe(false);
    expect(
      issueWorkflowDispatchSchema.safeParse({ ...dispatch(), extra: "untrusted" }).success,
    ).toBe(false);
  });
});
