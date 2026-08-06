import { describe, expect, it } from "vitest";

import {
  GoalEvaluationError,
  acceptGoal,
  createGoalRunState,
  recordCriterionDecision,
  rejectIncompleteGoal,
} from "../../../src/domain/goal/evaluator.js";
import type { CompiledGoal } from "../../../src/domain/goal/types.js";

describe("goal evaluator", () => {
  it("creates immutable pending criterion state from a compiled goal", () => {
    const state = createGoalRunState(compiledGoal());

    expect(state).toMatchObject({
      id: "verified-change",
      status: "pending",
      criteria: {
        "tests-pass": { status: "pending", decision: null },
        "types-pass": { status: "pending", decision: null },
      },
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.criteria)).toBe(true);
    expect(Object.values(state.criteria).every(Object.isFrozen)).toBe(true);
  });

  it("accepts criterion identifiers that match inherited object property names", () => {
    const goal: CompiledGoal = {
      ...compiledGoal(),
      criteria: [
        {
          id: "constructor",
          description: "The constructor criterion passes.",
          verifierNodeId: "test",
        },
      ],
    };

    expect(createGoalRunState(goal).criteria.constructor).toMatchObject({
      id: "constructor",
      status: "pending",
    });
  });

  it("accepts only criteria linked to a successful verifier attempt", () => {
    const state = recordCriterionDecision(createGoalRunState(compiledGoal()), {
      runId: "run-4",
      nodeId: "test",
      attempt: 2,
      at: "2026-08-06T19:00:00.000Z",
      outcome: "accepted",
      evidenceAvailable: true,
    });

    expect(state.criteria["tests-pass"]).toMatchObject({
      status: "accepted",
      decision: {
        runId: "run-4",
        nodeId: "test",
        attempt: 2,
        evidenceAvailable: true,
      },
    });
    expect(state.criteria["types-pass"]?.status).toBe("pending");
  });

  it("records a normal non-zero verifier result as rejected", () => {
    const state = recordCriterionDecision(createGoalRunState(compiledGoal()), {
      runId: "run-4",
      nodeId: "test",
      attempt: 1,
      at: "2026-08-06T19:00:00.000Z",
      outcome: "rejected",
      evidenceAvailable: true,
    });

    expect(state.criteria["tests-pass"]?.status).toBe("rejected");
  });

  it("records infrastructure uncertainty as inconclusive", () => {
    const state = recordCriterionDecision(createGoalRunState(compiledGoal()), {
      runId: "run-4",
      nodeId: "typecheck",
      attempt: 1,
      at: "2026-08-06T19:00:00.000Z",
      outcome: "inconclusive",
      evidenceAvailable: false,
    });

    expect(state.criteria["types-pass"]).toMatchObject({
      status: "inconclusive",
      decision: { evidenceAvailable: false },
    });
  });

  it("marks every undecided criterion missing when a run terminates unsuccessfully", () => {
    const partiallyAccepted = recordCriterionDecision(createGoalRunState(compiledGoal()), {
      runId: "run-4",
      nodeId: "test",
      attempt: 1,
      at: "2026-08-06T19:00:00.000Z",
      outcome: "accepted",
      evidenceAvailable: true,
    });

    const state = rejectIncompleteGoal(partiallyAccepted);

    expect(state.status).toBe("not_accepted");
    expect(state.criteria["tests-pass"]?.status).toBe("accepted");
    expect(state.criteria["types-pass"]).toMatchObject({ status: "missing", decision: null });
  });

  it("refuses to accept a goal until every criterion is accepted", () => {
    expect(() => acceptGoal(createGoalRunState(compiledGoal()))).toThrowError(GoalEvaluationError);
  });

  it("accepts a goal after every criterion has deterministic accepted evidence", () => {
    let state = createGoalRunState(compiledGoal());
    for (const nodeId of ["test", "typecheck"]) {
      state = recordCriterionDecision(state, {
        runId: "run-4",
        nodeId,
        attempt: 1,
        at: "2026-08-06T19:00:00.000Z",
        outcome: "accepted",
        evidenceAvailable: true,
      });
    }

    expect(acceptGoal(state).status).toBe("accepted");
  });

  it("refuses conclusive decisions without evidence", () => {
    expect(() =>
      recordCriterionDecision(createGoalRunState(compiledGoal()), {
        runId: "run-4",
        nodeId: "test",
        attempt: 1,
        at: "2026-08-06T19:00:00.000Z",
        outcome: "accepted",
        evidenceAvailable: false,
      }),
    ).toThrowError(/requires evidence/i);
  });
});

function compiledGoal(): CompiledGoal {
  return Object.freeze({
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "verified-change",
    outcome: "The change is accepted.",
    criteria: Object.freeze([
      Object.freeze({
        id: "tests-pass",
        description: "Tests pass.",
        verifierNodeId: "test",
      }),
      Object.freeze({
        id: "types-pass",
        description: "Type checking passes.",
        verifierNodeId: "typecheck",
      }),
    ]),
  });
}
