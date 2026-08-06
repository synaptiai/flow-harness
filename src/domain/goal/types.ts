export const FLOW_GOAL_API_VERSION = "flow.synapti.ai/v1alpha1" as const;

export interface CompiledCriterion {
  readonly id: string;
  readonly description: string;
  readonly verifierNodeId: string;
}

export interface CompiledGoal {
  readonly apiVersion: typeof FLOW_GOAL_API_VERSION;
  readonly id: string;
  readonly outcome: string;
  readonly criteria: readonly CompiledCriterion[];
}

export type CriterionStatus = "pending" | "accepted" | "rejected" | "inconclusive" | "missing";

export type GoalStatus = "pending" | "accepted" | "not_accepted";

export interface CriterionDecision {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly at: string;
  readonly evidenceAvailable: boolean;
}

export interface CriterionRunState extends CompiledCriterion {
  readonly status: CriterionStatus;
  readonly decision: CriterionDecision | null;
}

export interface GoalRunState {
  readonly apiVersion: typeof FLOW_GOAL_API_VERSION;
  readonly id: string;
  readonly outcome: string;
  readonly status: GoalStatus;
  readonly criteria: Readonly<Record<string, CriterionRunState>>;
}
