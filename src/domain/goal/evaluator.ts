import type { CompiledGoal, CriterionRunState, CriterionStatus, GoalRunState } from "./types.js";

export interface CriterionDecisionInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly at: string;
  readonly outcome: Extract<CriterionStatus, "accepted" | "rejected" | "inconclusive">;
  readonly evidenceAvailable: boolean;
}

export class GoalEvaluationError extends Error {
  override readonly name = "GoalEvaluationError";
}

export function createGoalRunState(goal: CompiledGoal): GoalRunState {
  const criteria = Object.create(null) as Record<string, CriterionRunState>;
  for (const criterion of goal.criteria) {
    if (Object.hasOwn(criteria, criterion.id)) {
      throw new GoalEvaluationError(`criterion id "${criterion.id}" is duplicated`);
    }
    criteria[criterion.id] = Object.freeze({
      ...criterion,
      status: "pending",
      decision: null,
    });
  }

  return freezeGoalState({
    apiVersion: goal.apiVersion,
    id: goal.id,
    outcome: goal.outcome,
    status: "pending",
    criteria,
  });
}

export function recordCriterionDecision(
  state: GoalRunState,
  input: CriterionDecisionInput,
): GoalRunState {
  requirePendingGoal(state);
  if (input.outcome !== "inconclusive" && !input.evidenceAvailable) {
    throw new GoalEvaluationError(`${input.outcome} criterion decision requires evidence`);
  }

  let matched = false;
  const criteria = Object.create(null) as Record<string, CriterionRunState>;
  for (const [criterionId, criterion] of Object.entries(state.criteria)) {
    if (criterion.verifierNodeId !== input.nodeId) {
      criteria[criterionId] = criterion;
      continue;
    }
    if (criterion.status !== "pending") {
      throw new GoalEvaluationError(`criterion "${criterion.id}" already has a decision`);
    }
    matched = true;
    criteria[criterionId] = Object.freeze({
      ...criterion,
      status: input.outcome,
      decision: Object.freeze({
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        at: input.at,
        evidenceAvailable: input.evidenceAvailable,
      }),
    });
  }

  return matched ? freezeGoalState({ ...state, criteria }) : state;
}

export function acceptGoal(state: GoalRunState): GoalRunState {
  requirePendingGoal(state);
  const unaccepted = Object.values(state.criteria).filter(
    (criterion) => criterion.status !== "accepted",
  );
  if (unaccepted.length > 0) {
    throw new GoalEvaluationError(
      `goal cannot be accepted because criteria are not accepted: ${unaccepted.map((criterion) => criterion.id).join(", ")}`,
    );
  }
  return freezeGoalState({ ...state, status: "accepted" });
}

export function rejectIncompleteGoal(state: GoalRunState): GoalRunState {
  requirePendingGoal(state);
  const criteria = Object.fromEntries(
    Object.entries(state.criteria).map(([criterionId, criterion]) => [
      criterionId,
      criterion.status === "pending"
        ? Object.freeze({ ...criterion, status: "missing" as const })
        : criterion,
    ]),
  );
  return freezeGoalState({ ...state, status: "not_accepted", criteria });
}

function requirePendingGoal(state: GoalRunState): void {
  if (state.status !== "pending") {
    throw new GoalEvaluationError(`goal is already terminal with status "${state.status}"`);
  }
}

function freezeGoalState(state: GoalRunState): GoalRunState {
  return Object.freeze({ ...state, criteria: Object.freeze({ ...state.criteria }) });
}
