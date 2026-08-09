import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import {
  type CommandApprovalOperation,
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  isValidApprovalActor,
} from "../approval/command-approval.js";
import {
  calculateWorkflowApprovalRequestDigest,
  type WorkflowApprovalRequest,
  workflowApprovalDenialMessage,
  workflowApprovalEvidenceTruncationMessage,
  workflowApprovalRequestId,
} from "../approval/workflow-approval.js";
import {
  type AgentCapabilityEvidence,
  agentCapabilityEvidenceSchema,
  agentSkillNameSchema,
  type CapabilitySnapshot,
  createAgentCapabilityEvidence,
  MAX_AGENT_SKILL_PACKAGES,
  persistedCapabilitySnapshotSchema,
} from "../capability/agent-skills.js";
import {
  type VerifierPackageUseEvidence,
  verifierPackageNameSchema,
  verifierPackageUseEvidenceSchema,
  verifierPackageVersionSchema,
} from "../capability/verifier-packages.js";
import {
  acceptGoal,
  createGoalRunState,
  GoalEvaluationError,
  recordCriterionDecision,
  rejectIncompleteGoal,
} from "../goal/evaluator.js";
import { compiledGoalSchema } from "../goal/schema.js";
import type { CompiledGoal, GoalRunState } from "../goal/types.js";
import {
  calculatePolicyRequestDigest,
  classifyPolicyAction,
  MAX_POLICY_DECISIONS,
  MAX_POLICY_TARGET_BYTES,
} from "../policy/broker.js";
import { policyDecisionSchema } from "../policy/schema.js";
import type { PolicyDecision } from "../policy/types.js";
import {
  evaluateOptimizationBaseline,
  evaluateOptimizationCandidate,
  type OptimizationInvariantObservation,
  OptimizationResultError,
  resolveOptimizationPointerSchema,
} from "../result/optimization-result.js";
import {
  calculateResultSchemaDigest,
  evaluateTypedResult,
  resultSourceTruncationMessage,
  TypedResultError,
} from "../result/typed-result.js";
import { parseVerifierVerdictJson } from "../verification/verdict.js";
import { boundedCompiledResultSchemaSchema } from "../workflow/schema.js";
import {
  type CompiledResultSchema,
  type CompiledRunBudget,
  type CompiledVerifierConfig,
  type CompiledWorkflowConcurrency,
  type ConditionSourceField,
  type EvidenceSourceField,
  MAX_COMPILED_WORKFLOW_NODES,
  MAX_CONCURRENT_NODES,
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  MAX_LOOP_ITERATIONS,
  MAX_OPTIMIZATION_CANDIDATES,
  MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES,
  MAX_RESULT_VALUE_BYTES,
} from "../workflow/types.js";
import {
  type AgentModelUsage,
  addRunResources,
  agentModelUsageSchema,
  budgetExhaustionReason,
  calculateRunBudgetState,
  committedDurationMs,
  emptyRunResources,
  RUN_BUDGET_DIMENSIONS,
  type RunBudgetExhaustion,
  type RunBudgetState,
  type RunResourceConsumption,
  retainedArtifactBytes,
  runBudgetExhaustionSchema,
  runBudgetLimitsSchema,
  sameBudgetExhaustions,
  totalModelTokens,
} from "./budget.js";

export interface CommandEvidence {
  readonly kind: "command";
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly sandbox?: SandboxEvidence;
}

export interface SandboxEvidence {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profile: string;
  readonly policyDigest: string;
}

export interface AgentEvidence {
  readonly kind: "agent";
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly textHash: string;
  readonly textTruncated: boolean;
  readonly durationMs: number;
  readonly usage?: AgentModelUsage;
  readonly policyDecisions: readonly PolicyDecision[];
  readonly effectReceipts: readonly AgentEffectReceipt[];
  readonly capabilities?: AgentCapabilityEvidence;
}

export type VerifierVerdict = "accepted" | "rejected" | "inconclusive";

export interface VerifierSourceObservation {
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: EvidenceSourceField;
  readonly sourceHash: string;
}

interface VerifierEvidenceBase {
  readonly kind: "verifier";
  readonly verdict: VerifierVerdict;
  readonly reason: string;
  readonly reasonHash: string;
  readonly durationMs: number;
  readonly sources: readonly VerifierSourceObservation[];
  readonly package?: VerifierPackageUseEvidence;
}

export interface CommandVerifierEvidence extends VerifierEvidenceBase {
  readonly driver: "command";
  readonly result: "completed" | "execution_failed";
  readonly command: CommandEvidence | null;
}

export interface ModelVerifierEvidence extends VerifierEvidenceBase {
  readonly driver: "model";
  readonly result: "parsed" | "invalid_output" | "execution_failed";
  readonly provider: string;
  readonly model: string;
  readonly raw: string;
  readonly rawHash: string;
  readonly rawTruncated: boolean;
  readonly usage?: AgentModelUsage;
}

export type VerifierEvidence = CommandVerifierEvidence | ModelVerifierEvidence;

export interface ChildRunLink {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly resultNodeId: string;
  readonly resultSchemaDigest: string;
  readonly isolationBackend: "reflink-copy-v1";
}

export interface ExecutionWorkspaceProvenance {
  readonly backend: "reflink-copy-v1";
  readonly snapshotDigest: string;
  readonly parentRunId: string;
  readonly parentNodeId: string;
  readonly parentAttempt: number;
}

export interface ChildResultEvidence {
  readonly nodeId: string;
  readonly schemaDigest: string;
  readonly canonicalValue: string;
  readonly valueHash: string;
}

export interface ChildEvidence {
  readonly kind: "child";
  readonly childRunId: string;
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly terminalSequence: number;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "resource_exhausted";
  readonly result: ChildResultEvidence | null;
  readonly resources: RunResourceConsumption;
  readonly durationMs: number;
  readonly workspace: {
    readonly backend: "reflink-copy-v1";
    readonly snapshotDigest: string;
    readonly disposition: "discarded" | "retained";
  };
}

export const MAX_AGENT_EFFECT_RECEIPTS = 32;
export const MAX_RUN_EVENT_BYTES = 2_097_152;
export const DURABLE_EFFECT_PROTOCOL = "flow.effects/v1" as const;

export interface AgentEffectReceipt {
  readonly version: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly kind: "filesystem.edit";
  readonly target: string;
  readonly operationDigest: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly outcome: "committed" | "uncertain";
}

export type NodeEvidence = CommandEvidence | AgentEvidence | VerifierEvidence | ChildEvidence;

export interface NodeFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly sideEffectStatus: "none" | "committed" | "uncertain";
}

interface RunEventBase {
  readonly version: 1;
  readonly sequence: number;
  readonly at: string;
  readonly runId: string;
  readonly workflowId: string;
}

export interface RunStartedEvent extends RunEventBase {
  readonly type: "run_started";
  readonly nodeIds: readonly string[];
  readonly workflowApiVersion: "flow.synapti.ai/v1alpha1";
  readonly workflowDigest: string;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly capabilityRequirements?: readonly AgentCapabilityRequirement[];
  readonly verifierPackageRequirements?: readonly VerifierPackageRequirement[];
  readonly budget?: CompiledRunBudget;
  readonly concurrency?: CompiledWorkflowConcurrency;
  readonly goal?: CompiledGoal;
  readonly executionCwd?: string;
  readonly executionWorkspace?: ExecutionWorkspaceProvenance;
  readonly approvalRequirements?: readonly CommandApprovalRequirement[];
  readonly recoveryRequirements?: readonly AgentRecoveryRequirement[];
  readonly controlGraph?: ControlGraph;
}

export interface RunResumedEvent extends RunEventBase {
  readonly type: "run_resumed";
}

export interface NodeStartedEvent extends RunEventBase {
  readonly type: "node_started";
  readonly nodeId: string;
  readonly attempt: number;
  readonly effectProtocol?: typeof DURABLE_EFFECT_PROTOCOL;
  readonly approval?: {
    readonly requestId: string;
    readonly operationDigest: string;
  };
  readonly child?: ChildRunLink;
}

export interface NodeAttemptInterruptedEvent extends RunEventBase {
  readonly type: "node_attempt_interrupted";
  readonly nodeId: string;
  readonly attempt: number;
  readonly reason: "process_interrupted";
  readonly disposition: "fresh_retry";
  readonly resourceAccounting: "incomplete";
}

export interface ControlBranchGuard {
  readonly conditionId: string;
  readonly case: string;
}

export interface ControlLoopInstance {
  readonly loopId: string;
  readonly iteration: number;
  readonly templateNodeId: string;
}

export interface ControlLoopGuard {
  readonly loopId: string;
  readonly iteration: number;
  readonly checkNodeId: string;
}

export interface ControlOptimizationGuard {
  readonly optimizationId: string;
  readonly candidate: number;
  readonly checkNodeId: string;
}

interface ControlGraphNodeBase {
  readonly nodeId: string;
  readonly dependsOn: readonly string[];
  readonly loopInstance?: ControlLoopInstance;
  readonly loopGuard?: ControlLoopGuard;
  readonly optimizationGuard?: ControlOptimizationGuard;
}

export interface ControlGraphExecutableNode extends ControlGraphNodeBase {
  readonly type: "command" | "agent";
  readonly when?: ControlBranchGuard;
}

export interface ControlGraphChildNode extends ControlGraphNodeBase {
  readonly type: "child";
  readonly when?: ControlBranchGuard;
  readonly child: {
    readonly workflowId: string;
    readonly workflowDigest: string;
    readonly resultNodeId: string;
    readonly resultSchema: CompiledResultSchema;
    readonly resultSchemaDigest: string;
  };
  readonly optimizationCandidate?: {
    readonly optimizationId: string;
    readonly candidate: number;
    readonly checkNodeId: string;
  };
}

export interface ControlGraphApprovalNode extends ControlGraphNodeBase {
  readonly type: "approval";
  readonly when?: ControlBranchGuard;
  readonly approval: {
    readonly prompt: string;
    readonly evidence: readonly {
      readonly nodeId: string;
      readonly field: ConditionSourceField;
    }[];
  };
}

export interface ControlGraphVerifierNode extends ControlGraphNodeBase {
  readonly type: "verifier";
  readonly when?: ControlBranchGuard;
  readonly verifier: CompiledVerifierConfig;
}

export interface ControlGraphResultNode extends ControlGraphNodeBase {
  readonly type: "result";
  readonly when?: ControlBranchGuard;
  readonly result: {
    readonly source: {
      readonly nodeId: string;
      readonly field: EvidenceSourceField;
    };
    readonly schema: CompiledResultSchema;
    readonly schemaDigest: string;
  };
}

export interface ControlGraphConditionNode extends ControlGraphNodeBase {
  readonly type: "condition";
  readonly when?: ControlBranchGuard;
  readonly condition: {
    readonly source: {
      readonly nodeId: string;
      readonly field: ConditionSourceField;
    };
    readonly cases: readonly {
      readonly id: string;
      readonly equals: string;
    }[];
    readonly default: string;
  };
}

export interface ControlGraphJoinNode extends ControlGraphNodeBase {
  readonly type: "join";
  readonly join: {
    readonly conditionId: string;
    readonly branches: readonly {
      readonly case: string;
      readonly nodeId: string;
    }[];
  };
}

export interface ControlGraphLoopCheckNode extends ControlGraphNodeBase {
  readonly type: "loop-check";
  readonly loopCheck: {
    readonly loopId: string;
    readonly iteration: number;
    readonly source: {
      readonly nodeId: string;
      readonly field: ConditionSourceField;
    };
    readonly equals: string;
  };
}

export interface ControlGraphLoopNode extends ControlGraphNodeBase {
  readonly type: "loop";
  readonly loop: {
    readonly maxIterations: number;
    readonly checkNodeIds: readonly string[];
  };
}

export interface ControlGraphOptimizationCheckNode extends ControlGraphNodeBase {
  readonly type: "optimization-check";
  readonly when?: never;
  readonly optimizationCheck: {
    readonly optimizationId: string;
    readonly candidate: number;
    readonly candidateNodeId: string;
    readonly priorCheckNodeId?: string;
    readonly baseline: { readonly nodeId: string; readonly field: "result.value" };
    readonly metric: {
      readonly pointer: string;
      readonly direction: "minimize" | "maximize";
    };
    readonly invariants: readonly {
      readonly pointer: string;
      readonly equals: null | boolean | number | string;
    }[];
    readonly maxConsecutiveNonImproving: number;
    readonly rollback: "previous-best";
  };
}

export interface ControlGraphOptimizationNode extends ControlGraphNodeBase {
  readonly type: "optimization";
  readonly when?: never;
  readonly optimization: {
    readonly baseline: { readonly nodeId: string; readonly field: "result.value" };
    readonly baselineSchemaDigest: string;
    readonly metric: {
      readonly pointer: string;
      readonly direction: "minimize" | "maximize";
    };
    readonly invariants: readonly {
      readonly pointer: string;
      readonly equals: null | boolean | number | string;
    }[];
    readonly maxCandidates: number;
    readonly maxConsecutiveNonImproving: number;
    readonly rollback: "previous-best";
    readonly candidateNodeIds: readonly string[];
    readonly checkNodeIds: readonly string[];
  };
}

export type ControlGraphNode =
  | ControlGraphExecutableNode
  | ControlGraphChildNode
  | ControlGraphApprovalNode
  | ControlGraphVerifierNode
  | ControlGraphResultNode
  | ControlGraphConditionNode
  | ControlGraphJoinNode
  | ControlGraphLoopCheckNode
  | ControlGraphLoopNode
  | ControlGraphOptimizationCheckNode
  | ControlGraphOptimizationNode;

export interface ControlGraph {
  readonly nodes: readonly ControlGraphNode[];
}

export interface NodeConditionEvaluatedEvent extends RunEventBase {
  readonly type: "node_condition_evaluated";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: ConditionSourceField;
  readonly sourceHash: string;
  readonly selectedCase: string;
}

export interface NodeResultPublishedEvent extends RunEventBase {
  readonly type: "node_result_published";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: EvidenceSourceField;
  readonly sourceHash: string;
  readonly schemaDigest: string;
  readonly canonicalValue: string;
  readonly valueHash: string;
}

export type NodeOmittedEvent = RunEventBase &
  (
    | {
        readonly type: "node_omitted";
        readonly nodeId: string;
        readonly reason: "condition_not_selected";
        readonly conditionId: string;
        readonly selectedCase: string;
        readonly expectedCase: string;
      }
    | {
        readonly type: "node_omitted";
        readonly nodeId: string;
        readonly reason: "dependency_omitted";
        readonly omittedDependencies: readonly string[];
      }
    | {
        readonly type: "node_omitted";
        readonly nodeId: string;
        readonly reason: "loop_not_continued";
        readonly loopId: string;
        readonly iteration: number;
        readonly checkNodeId: string;
      }
    | {
        readonly type: "node_omitted";
        readonly nodeId: string;
        readonly reason: "optimization_stopped";
        readonly optimizationId: string;
        readonly candidate: number;
        readonly checkNodeId: string;
      }
  );

export interface NodeJoinedEvent extends RunEventBase {
  readonly type: "node_joined";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly conditionId: string;
  readonly selectedCase: string;
  readonly completedNodeId: string;
  readonly omittedNodeIds: readonly string[];
}

export interface NodeLoopCheckedEvent extends RunEventBase {
  readonly type: "node_loop_checked";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly loopId: string;
  readonly iteration: number;
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: ConditionSourceField;
  readonly sourceHash: string;
  readonly decision: "stop" | "continue";
}

export interface NodeLoopCompletedEvent extends RunEventBase {
  readonly type: "node_loop_completed";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly completedIterations: number;
  readonly terminatingCheckNodeId: string;
}

export type OptimizationCandidateOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "resource_exhausted";

export type OptimizationEvaluationReason =
  | "improved"
  | "not_improved"
  | "invariant_failed"
  | "candidate_no_change"
  | "candidate_delta_limit_exceeded"
  | "candidate_failed"
  | "candidate_cancelled"
  | "candidate_resource_exhausted";

export interface OptimizationPromotionBoundary {
  readonly promotionId: string;
  readonly workspaceId: string;
  readonly deltaDigest: string;
  readonly baselineSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly entryCount: number;
  readonly logicalBytes: number;
}

export type OptimizationWorkspaceEntryIdentity =
  | { readonly kind: "missing" }
  | { readonly kind: "directory"; readonly mode: number }
  | {
      readonly kind: "file";
      readonly mode: number;
      readonly size: number;
      readonly sha256: string;
    }
  | { readonly kind: "symlink"; readonly target: string };

export interface OptimizationDeltaEntry {
  readonly path: string;
  readonly before: OptimizationWorkspaceEntryIdentity;
  readonly after: OptimizationWorkspaceEntryIdentity;
}

export interface NodeOptimizationEvaluatedEvent extends RunEventBase {
  readonly type: "node_optimization_evaluated";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly optimizationId: string;
  readonly candidate: number;
  readonly candidateNodeId: string;
  readonly baselineValueHash: string;
  readonly baselineMetric: number;
  readonly baselineInvariants: readonly OptimizationInvariantObservation[];
  readonly bestValueHashBefore: string;
  readonly bestMetricBefore: number;
  readonly candidateOutcome: OptimizationCandidateOutcome;
  readonly candidateValueHash: string | null;
  readonly candidateMetric: number | null;
  readonly candidateInvariants: readonly OptimizationInvariantObservation[] | null;
  readonly decision: "promote" | "reject";
  readonly reason: OptimizationEvaluationReason;
  readonly stagnation: number;
  readonly stop: boolean;
  readonly promotion: OptimizationPromotionBoundary | null;
  readonly deltaEntries: readonly OptimizationDeltaEntry[] | null;
}

export interface NodeOptimizationPromotionPreparedEvent extends RunEventBase {
  readonly type: "node_optimization_promotion_prepared";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly optimizationId: string;
  readonly candidate: number;
  readonly promotion: OptimizationPromotionBoundary;
}

export type OptimizationPromotionSettlement =
  | { readonly outcome: "committed"; readonly reason: "local_commit_durable" }
  | {
      readonly outcome: "rolled_back";
      readonly reason: "compensated_after_failure" | "reconciled_incomplete";
    }
  | { readonly outcome: "unknown"; readonly reason: "affected_path_diverged" };

export type NodeOptimizationPromotionSettledEvent = RunEventBase & {
  readonly type: "node_optimization_promotion_settled";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly optimizationId: string;
  readonly candidate: number;
  readonly promotionId: string;
  readonly deltaDigest: string;
} & OptimizationPromotionSettlement;

export interface NodeOptimizationCandidateCleanedEvent extends RunEventBase {
  readonly type: "node_optimization_candidate_cleaned";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly optimizationId: string;
  readonly candidate: number;
  readonly candidateNodeId: string;
  readonly workspaceId: string;
  readonly reason: "rejected" | "promotion_settled";
}

export interface NodeOptimizationCheckedEvent extends RunEventBase {
  readonly type: "node_optimization_checked";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly optimizationId: string;
  readonly candidate: number;
  readonly outcome: "accepted" | "rejected";
  readonly reason: OptimizationEvaluationReason;
  readonly bestValueHash: string;
  readonly bestMetric: number;
  readonly bestCandidate: number | null;
  readonly stagnation: number;
  readonly stop: boolean;
}

export interface NodeOptimizationCompletedEvent extends RunEventBase {
  readonly type: "node_optimization_completed";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly completedCandidates: number;
  readonly terminatingCheckNodeId: string;
  readonly bestValueHash: string;
  readonly bestMetric: number;
  readonly bestCandidate: number | null;
  readonly stopReason: "stagnation" | "max_candidates";
}

export interface NodeControlFailedEvent extends RunEventBase {
  readonly type: "node_control_failed";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly error: NodeFailure;
}

export interface FilesystemEditEffectDescriptor {
  readonly kind: "filesystem.edit";
  readonly target: string;
  readonly operationDigest: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly mode: number;
}

export interface NodeEffectPreparedEvent extends RunEventBase {
  readonly type: "node_effect_prepared";
  readonly nodeId: string;
  readonly attempt: number;
  readonly effectId: string;
  readonly effectSequence: number;
  readonly descriptor: FilesystemEditEffectDescriptor;
}

export type NodeEffectSettlementInput =
  | {
      readonly outcome: "committed";
      readonly reason: "directory_synced";
    }
  | {
      readonly outcome: "not_applied";
      readonly reason: "commit_not_entered";
    }
  | {
      readonly outcome: "unknown";
      readonly reason: "post_commit_failure";
    };

export type NodeEffectSettlement = NodeEffectSettlementInput & {
  readonly settledAt: string;
};

export type NodeEffectSettledEvent = RunEventBase & {
  readonly type: "node_effect_settled";
  readonly nodeId: string;
  readonly attempt: number;
  readonly effectId: string;
} & NodeEffectSettlementInput;

export type NodeEffectReconciliationInput =
  | {
      readonly outcome: "applied";
      readonly reason: "target_matches_after";
      readonly observedSha256: string;
      readonly observedMode: number;
    }
  | {
      readonly outcome: "not_applied";
      readonly reason: "target_matches_before";
      readonly observedSha256: string;
      readonly observedMode: number;
    }
  | {
      readonly outcome: "unknown";
      readonly reason: "target_content_diverged" | "target_mode_diverged";
      readonly observedSha256: string;
      readonly observedMode: number;
    }
  | {
      readonly outcome: "unknown";
      readonly reason:
        | "target_missing"
        | "target_not_regular"
        | "target_unreadable"
        | "target_too_large"
        | "target_changed_during_observation";
    };

export type NodeEffectReconciliation = NodeEffectReconciliationInput & {
  readonly reconciledAt: string;
};

export type NodeEffectReconciledEvent = RunEventBase & {
  readonly type: "node_effect_reconciled";
  readonly nodeId: string;
  readonly attempt: number;
  readonly effectId: string;
} & NodeEffectReconciliationInput;

export interface CommandApprovalRequirement {
  readonly nodeId: string;
  readonly grantTtlMs: number;
}

export interface AgentRecoveryRequirement {
  readonly nodeId: string;
  readonly mode: "fresh";
  readonly maxAttempts: number;
  readonly effectProtocol: "none" | typeof DURABLE_EFFECT_PROTOCOL;
}

export interface AgentCapabilityRequirement {
  readonly nodeId: string;
  readonly skills: readonly string[];
}

export interface VerifierPackageRequirement {
  readonly nodeId: string;
  readonly name: string;
  readonly version: string;
  readonly kind: "command" | "model";
}

export interface CommandApprovalRequestedEvent extends RunEventBase {
  readonly type: "command_approval_requested";
  readonly nodeId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly grantTtlMs: number;
  readonly operation: CommandApprovalOperation;
  readonly operationDigest: string;
}

export interface CommandApprovalGrantedEvent extends RunEventBase {
  readonly type: "command_approval_granted";
  readonly nodeId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly operationDigest: string;
  readonly actor: string;
  readonly expiresAt: string;
}

export interface CommandApprovalDeniedEvent extends RunEventBase {
  readonly type: "command_approval_denied";
  readonly nodeId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly operationDigest: string;
  readonly actor: string;
  readonly reason?: string;
}

export interface CommandApprovalExpiredEvent extends RunEventBase {
  readonly type: "command_approval_expired";
  readonly nodeId: string;
  readonly attempt: number;
  readonly requestId: string;
  readonly operationDigest: string;
}

export interface WorkflowApprovalRequestedEvent extends RunEventBase {
  readonly type: "workflow_approval_requested";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly requestId: string;
  readonly request: WorkflowApprovalRequest;
  readonly requestDigest: string;
}

export interface WorkflowApprovalApprovedEvent extends RunEventBase {
  readonly type: "workflow_approval_approved";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly actor: string;
}

export interface WorkflowApprovalDeniedEvent extends RunEventBase {
  readonly type: "workflow_approval_denied";
  readonly nodeId: string;
  readonly attempt: 1;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly actor: string;
  readonly reason?: string;
}

export interface NodeSucceededEvent extends RunEventBase {
  readonly type: "node_succeeded";
  readonly nodeId: string;
  readonly attempt: number;
  readonly evidence: NodeEvidence;
}

export interface NodeFailedEvent extends RunEventBase {
  readonly type: "node_failed";
  readonly nodeId: string;
  readonly attempt: number;
  readonly error: NodeFailure;
  readonly evidence: NodeEvidence | null;
}

export interface RunSucceededEvent extends RunEventBase {
  readonly type: "run_succeeded";
}

export interface RunFailedEvent extends RunEventBase {
  readonly type: "run_failed";
  readonly failedNodeId: string;
  readonly reason: string;
}

export interface RunCancelledEvent extends RunEventBase {
  readonly type: "run_cancelled";
  readonly reason: string;
  readonly cancelledNodeId?: string;
  readonly cancelledNodeIds?: readonly string[];
  readonly actor?: string;
  readonly requestId?: string;
}

export interface RunBudgetExhaustedEvent extends RunEventBase {
  readonly type: "run_budget_exhausted";
  readonly exhausted: readonly RunBudgetExhaustion[];
}

export type RunEvent =
  | RunStartedEvent
  | RunResumedEvent
  | CommandApprovalRequestedEvent
  | CommandApprovalGrantedEvent
  | CommandApprovalDeniedEvent
  | CommandApprovalExpiredEvent
  | WorkflowApprovalRequestedEvent
  | WorkflowApprovalApprovedEvent
  | WorkflowApprovalDeniedEvent
  | NodeStartedEvent
  | NodeAttemptInterruptedEvent
  | NodeConditionEvaluatedEvent
  | NodeResultPublishedEvent
  | NodeOmittedEvent
  | NodeJoinedEvent
  | NodeLoopCheckedEvent
  | NodeLoopCompletedEvent
  | NodeOptimizationEvaluatedEvent
  | NodeOptimizationPromotionPreparedEvent
  | NodeOptimizationPromotionSettledEvent
  | NodeOptimizationCandidateCleanedEvent
  | NodeOptimizationCheckedEvent
  | NodeOptimizationCompletedEvent
  | NodeControlFailedEvent
  | NodeEffectPreparedEvent
  | NodeEffectSettledEvent
  | NodeEffectReconciledEvent
  | NodeSucceededEvent
  | NodeFailedEvent
  | RunSucceededEvent
  | RunFailedEvent
  | RunCancelledEvent
  | RunBudgetExhaustedEvent;

export type RunStatus =
  | "running"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "resource_exhausted";
export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "omitted";

export type CommandApprovalStatus = "pending" | "granted" | "denied" | "expired" | "consumed";

export interface CommandApprovalRunState {
  readonly status: CommandApprovalStatus;
  readonly requestId: string;
  readonly attempt: number;
  readonly requestedAt: string;
  readonly grantTtlMs: number;
  readonly operation: CommandApprovalOperation;
  readonly operationDigest: string;
  readonly decidedAt: string | null;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly expiredAt: string | null;
  readonly consumedAt: string | null;
}

export type WorkflowApprovalStatus = "pending" | "approved" | "denied";

export interface WorkflowApprovalRunState {
  readonly status: WorkflowApprovalStatus;
  readonly requestId: string;
  readonly attempt: 1;
  readonly requestedAt: string;
  readonly request: WorkflowApprovalRequest;
  readonly requestDigest: string;
  readonly decidedAt: string | null;
  readonly actor: string | null;
  readonly reason: string | null;
}

export interface NodeRunState {
  readonly status: NodeRunStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidence: NodeEvidence | null;
  readonly error: NodeFailure | null;
  readonly approval: CommandApprovalRunState | null;
  readonly workflowApproval: WorkflowApprovalRunState | null;
  readonly childRun: ChildRunLink | null;
  readonly effectProtocol: typeof DURABLE_EFFECT_PROTOCOL | null;
  readonly effects: readonly NodeEffectRunState[];
  readonly interruptedAttempts: readonly InterruptedNodeAttemptState[];
  readonly control: NodeControlRunState | null;
  readonly omission: NodeOmissionRunState | null;
  readonly optimization: OptimizationCheckRunState | null;
}

export interface OptimizationCheckRunState {
  readonly optimizationId: string;
  readonly candidate: number;
  readonly candidateNodeId: string;
  readonly baselineValueHash: string;
  readonly baselineMetric: number;
  readonly baselineInvariants: readonly OptimizationInvariantObservation[];
  readonly bestValueHashBefore: string;
  readonly bestMetricBefore: number;
  readonly candidateOutcome: OptimizationCandidateOutcome;
  readonly candidateValueHash: string | null;
  readonly candidateMetric: number | null;
  readonly candidateInvariants: readonly OptimizationInvariantObservation[] | null;
  readonly decision: "promote" | "reject";
  readonly reason: OptimizationEvaluationReason;
  readonly stagnation: number;
  readonly stop: boolean;
  readonly promotion: OptimizationPromotionBoundary | null;
  readonly deltaEntries: readonly OptimizationDeltaEntry[] | null;
  readonly evaluatedAt: string;
  readonly preparedAt: string | null;
  readonly settlement: (OptimizationPromotionSettlement & { readonly settledAt: string }) | null;
  readonly cleanedAt: string | null;
}

export type NodeControlRunState =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly requestDigest: string;
      readonly actor: string;
    }
  | {
      readonly kind: "condition";
      readonly sourceNodeId: string;
      readonly sourceAttempt: number;
      readonly sourceField: ConditionSourceField;
      readonly sourceHash: string;
      readonly selectedCase: string;
    }
  | {
      readonly kind: "result";
      readonly sourceNodeId: string;
      readonly sourceAttempt: number;
      readonly sourceField: EvidenceSourceField;
      readonly sourceHash: string;
      readonly schemaDigest: string;
      readonly canonicalValue: string;
      readonly valueHash: string;
    }
  | {
      readonly kind: "join";
      readonly conditionId: string;
      readonly selectedCase: string;
      readonly completedNodeId: string;
      readonly omittedNodeIds: readonly string[];
    }
  | {
      readonly kind: "loop-check";
      readonly loopId: string;
      readonly iteration: number;
      readonly sourceNodeId: string;
      readonly sourceAttempt: number;
      readonly sourceField: ConditionSourceField;
      readonly sourceHash: string;
      readonly decision: "stop" | "continue";
    }
  | {
      readonly kind: "loop";
      readonly completedIterations: number;
      readonly terminatingCheckNodeId: string;
    }
  | {
      readonly kind: "optimization-check";
      readonly optimizationId: string;
      readonly candidate: number;
      readonly outcome: "accepted" | "rejected";
      readonly reason: OptimizationEvaluationReason;
      readonly bestValueHash: string;
      readonly bestMetric: number;
      readonly bestCandidate: number | null;
      readonly stagnation: number;
      readonly stop: boolean;
    }
  | {
      readonly kind: "optimization";
      readonly completedCandidates: number;
      readonly terminatingCheckNodeId: string;
      readonly bestValueHash: string;
      readonly bestMetric: number;
      readonly bestCandidate: number | null;
      readonly stopReason: "stagnation" | "max_candidates";
    };

export type NodeOmissionRunState =
  | {
      readonly reason: "condition_not_selected";
      readonly conditionId: string;
      readonly selectedCase: string;
      readonly expectedCase: string;
    }
  | {
      readonly reason: "dependency_omitted";
      readonly omittedDependencies: readonly string[];
    }
  | {
      readonly reason: "loop_not_continued";
      readonly loopId: string;
      readonly iteration: number;
      readonly checkNodeId: string;
    }
  | {
      readonly reason: "optimization_stopped";
      readonly optimizationId: string;
      readonly candidate: number;
      readonly checkNodeId: string;
    };

export interface InterruptedNodeAttemptState {
  readonly attempt: number;
  readonly startedAt: string;
  readonly interruptedAt: string;
  readonly reason: "process_interrupted";
  readonly disposition: "fresh_retry";
  readonly resourceAccounting: "incomplete";
  readonly effectProtocol: typeof DURABLE_EFFECT_PROTOCOL | null;
  readonly effects: readonly NodeEffectRunState[];
}

export interface NodeEffectRunState {
  readonly effectId: string;
  readonly effectSequence: number;
  readonly descriptor: FilesystemEditEffectDescriptor;
  readonly preparedAt: string;
  readonly settlement: NodeEffectSettlement | null;
  readonly reconciliation: NodeEffectReconciliation | null;
}

export interface RunState {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowApiVersion: "flow.synapti.ai/v1alpha1";
  readonly workflowDigest: string;
  readonly capabilitySnapshot: CapabilitySnapshot | null;
  readonly capabilityRequirements: Readonly<Record<string, readonly string[]>>;
  readonly verifierPackageRequirements: Readonly<
    Record<string, Omit<VerifierPackageRequirement, "nodeId">>
  >;
  readonly executionCwd: string | null;
  readonly executionWorkspace: ExecutionWorkspaceProvenance | null;
  readonly approvalRequirements: Readonly<
    Record<string, Omit<CommandApprovalRequirement, "nodeId">>
  >;
  readonly recoveryRequirements: Readonly<Record<string, Omit<AgentRecoveryRequirement, "nodeId">>>;
  readonly controlGraph: ControlGraph | null;
  readonly concurrency: CompiledWorkflowConcurrency;
  readonly resources: RunResourceConsumption;
  readonly budget: RunBudgetState | null;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly lastSequence: number;
  readonly failedNodeId: string | null;
  readonly failureReason: string | null;
  readonly goal: GoalRunState | null;
  readonly nodes: Readonly<Record<string, NodeRunState>>;
}

export class RunReplayError extends Error {
  override readonly name = "RunReplayError";

  constructor(
    readonly eventIndex: number,
    message: string,
  ) {
    super(`Cannot replay event ${eventIndex + 1}: ${message}`);
  }
}

export function calculateChildRunId(parentRunId: string, nodeId: string, attempt: number): string {
  const identity = sha256(`${parentRunId}\0${nodeId}\0${attempt}`).slice(0, 48);
  return `child-${identity}`;
}

export function calculateOptimizationPromotionId(runId: string, checkNodeId: string): string {
  return `promotion-${sha256(`${runId}\0${checkNodeId}`).slice(0, 48)}`;
}

export function loopLimitFailureMessage(loopId: string, maxIterations: number): string {
  return `loop "${loopId}" reached maximum ${maxIterations} iterations without satisfying its stop condition`;
}

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const effectIdSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^effect-[1-9][0-9]*$/);

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), {
    message: "must be an absolute NUL-free path",
  });

const grantTtlSchema = z.number().int().positive().max(86_400_000);

const actorSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(isValidApprovalActor, "actor must not contain control characters");

const approvalOperationSchema = z
  .object({
    version: z.literal(1),
    action: z.literal("process.execute"),
    cwd: absolutePathSchema,
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict();

const approvalReferenceSchema = z
  .object({
    requestId: identifierSchema,
    operationDigest: sha256Schema,
  })
  .strict();

const canonicalWorkflowApprovalPromptSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value === value.trim(), {
    message: "workflow approval prompt must not contain surrounding whitespace",
  });

const evidenceSourceFieldSchema = z.enum([
  "command.stdout",
  "command.stderr",
  "agent.text",
  "verifier.verdict",
  "verifier.reason",
  "result.value",
]);

const workflowApprovalEvidenceObservationSchema = z
  .object({
    sourceNodeId: identifierSchema,
    sourceAttempt: z.number().int().positive(),
    sourceField: evidenceSourceFieldSchema,
    sourceHash: sha256Schema,
  })
  .strict();

const workflowApprovalRequestSchema = z
  .object({
    version: z.literal(1),
    runId: identifierSchema,
    workflowId: identifierSchema,
    workflowDigest: sha256Schema,
    nodeId: identifierSchema,
    attempt: z.literal(1),
    prompt: canonicalWorkflowApprovalPromptSchema,
    evidence: z
      .array(workflowApprovalEvidenceObservationSchema)
      .min(1)
      .max(16)
      .refine(
        (items) =>
          new Set(items.map((item) => `${item.sourceNodeId}\0${item.sourceField}`)).size ===
          items.length,
        "workflow approval evidence sources must be unique",
      ),
  })
  .strict();

const commandOutputSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= 32_768, {
    message: "command output must not exceed 32768 UTF-8 bytes",
  });

const agentOutputSchema = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 65_536, {
  message: "agent output must not exceed 65536 UTF-8 bytes",
});

const sandboxIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const sandboxEvidenceSchema = z
  .object({
    backend: sandboxIdentifierSchema,
    backendVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    profile: sandboxIdentifierSchema,
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const eventBaseShape = {
  version: z.literal(1),
  sequence: z.number().int().positive(),
  at: z.iso.datetime({ offset: true }),
  runId: identifierSchema,
  workflowId: identifierSchema,
};

const filesystemEditEffectDescriptorSchema = z
  .object({
    kind: z.literal("filesystem.edit"),
    target: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_POLICY_TARGET_BYTES)
      .refine((value) => isAbsolute(value) && !value.includes("\0") && normalize(value) === value, {
        message: "effect target must be an absolute normalized NUL-free path",
      }),
    operationDigest: sha256Schema,
    beforeSha256: sha256Schema,
    afterSha256: sha256Schema,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict()
  .refine((descriptor) => descriptor.beforeSha256 !== descriptor.afterSha256, {
    message: "effect before and after digests must differ",
  });

const commandEvidenceSchema = z
  .object({
    kind: z.literal("command"),
    executable: z.string().min(1).max(4096),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: commandOutputSchema,
    stderr: commandOutputSchema,
    stdoutHash: z.string().regex(/^[a-f0-9]{64}$/),
    stderrHash: z.string().regex(/^[a-f0-9]{64}$/),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sandbox: sandboxEvidenceSchema.optional(),
  })
  .strict();

const agentEvidenceSchema = z
  .object({
    kind: z.literal("agent"),
    provider: z.string().min(1).max(96),
    model: z.string().min(1).max(256),
    text: agentOutputSchema,
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    textTruncated: z.boolean(),
    durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    usage: agentModelUsageSchema.optional(),
    policyDecisions: z.array(policyDecisionSchema).max(MAX_POLICY_DECISIONS).default([]),
    effectReceipts: z
      .array(
        z
          .object({
            version: z.literal(1),
            sequence: z.number().int().positive().max(MAX_AGENT_EFFECT_RECEIPTS),
            runId: identifierSchema,
            workflowId: identifierSchema,
            nodeId: identifierSchema,
            attempt: z.number().int().positive(),
            kind: z.literal("filesystem.edit"),
            target: z
              .string()
              .min(1)
              .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_POLICY_TARGET_BYTES),
            operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
            beforeSha256: z.string().regex(/^[a-f0-9]{64}$/),
            afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
            outcome: z.enum(["committed", "uncertain"]),
          })
          .strict(),
      )
      .max(MAX_AGENT_EFFECT_RECEIPTS)
      .default([]),
    capabilities: agentCapabilityEvidenceSchema.optional(),
  })
  .strict();

const verifierSourceObservationSchema = z
  .object({
    sourceNodeId: identifierSchema,
    sourceAttempt: z.number().int().positive(),
    sourceField: evidenceSourceFieldSchema,
    sourceHash: sha256Schema,
  })
  .strict();

const verifierEvidenceCommonShape = {
  kind: z.literal("verifier"),
  verdict: z.enum(["accepted", "rejected", "inconclusive"]),
  reason: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value === value.trim(), {
      message: "verifier reason must not contain surrounding whitespace",
    }),
  reasonHash: sha256Schema,
  durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  package: verifierPackageUseEvidenceSchema.optional(),
};

const commandVerifierEvidenceSchema = z
  .object({
    ...verifierEvidenceCommonShape,
    driver: z.literal("command"),
    result: z.enum(["completed", "execution_failed"]),
    sources: z.array(verifierSourceObservationSchema).length(0),
    command: commandEvidenceSchema.nullable(),
  })
  .strict();

const modelVerifierEvidenceSchema = z
  .object({
    ...verifierEvidenceCommonShape,
    driver: z.literal("model"),
    result: z.enum(["parsed", "invalid_output", "execution_failed"]),
    provider: z.string().min(1).max(96),
    model: z.string().min(1).max(256),
    raw: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 16_384, {
      message: "verifier raw output must not exceed 16384 UTF-8 bytes",
    }),
    rawHash: sha256Schema,
    rawTruncated: z.boolean(),
    usage: agentModelUsageSchema.optional(),
    sources: z
      .array(verifierSourceObservationSchema)
      .min(1)
      .max(16)
      .refine(
        (items) =>
          new Set(items.map((item) => `${item.sourceNodeId}\0${item.sourceField}`)).size ===
          items.length,
        "verifier source observations must be unique",
      ),
  })
  .strict();

const childRunLinkSchema = z
  .object({
    runId: identifierSchema,
    workflowId: identifierSchema,
    workflowDigest: sha256Schema,
    resultNodeId: identifierSchema,
    resultSchemaDigest: sha256Schema,
    isolationBackend: z.literal("reflink-copy-v1"),
  })
  .strict();

const executionWorkspaceSchema = z
  .object({
    backend: z.literal("reflink-copy-v1"),
    snapshotDigest: sha256Schema,
    parentRunId: identifierSchema,
    parentNodeId: identifierSchema,
    parentAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const childResultEvidenceSchema = z
  .object({
    nodeId: identifierSchema,
    schemaDigest: sha256Schema,
    canonicalValue: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_RESULT_VALUE_BYTES,
        `child canonical result must not exceed ${MAX_RESULT_VALUE_BYTES} UTF-8 bytes`,
      ),
    valueHash: sha256Schema,
  })
  .strict();

const childResourceSchema = z
  .object({
    nodeStarts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modelTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modelCostUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    executionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    artifactBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict();

const childEvidenceSchema = z
  .object({
    kind: z.literal("child"),
    childRunId: identifierSchema,
    workflowId: identifierSchema,
    workflowDigest: sha256Schema,
    terminalSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    outcome: z.enum(["succeeded", "failed", "cancelled", "resource_exhausted"]),
    result: childResultEvidenceSchema.nullable(),
    resources: childResourceSchema,
    durationMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspace: z
      .object({
        backend: z.literal("reflink-copy-v1"),
        snapshotDigest: sha256Schema,
        disposition: z.enum(["discarded", "retained"]),
      })
      .strict(),
  })
  .strict();

const nodeEvidenceSchema = z.union([
  commandEvidenceSchema,
  agentEvidenceSchema,
  commandVerifierEvidenceSchema,
  modelVerifierEvidenceSchema,
  childEvidenceSchema,
]);

const nodeFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1).max(16_384),
    retryable: z.boolean(),
    sideEffectStatus: z.enum(["none", "committed", "uncertain"]),
  })
  .strict();

const controlBranchGuardSchema = z
  .object({
    conditionId: identifierSchema,
    case: identifierSchema,
  })
  .strict();

const controlDependencySchema = z.array(identifierSchema).max(128);

const loopIterationSchema = z.number().int().min(1).max(MAX_LOOP_ITERATIONS);

const controlLoopInstanceSchema = z
  .object({
    loopId: identifierSchema,
    iteration: loopIterationSchema,
    templateNodeId: identifierSchema,
  })
  .strict();

const controlLoopGuardSchema = z
  .object({
    loopId: identifierSchema,
    iteration: loopIterationSchema,
    checkNodeId: identifierSchema,
  })
  .strict();

const optimizationCandidateNumberSchema = z.number().int().min(1).max(MAX_OPTIMIZATION_CANDIDATES);

const controlOptimizationGuardSchema = z
  .object({
    optimizationId: identifierSchema,
    candidate: optimizationCandidateNumberSchema,
    checkNodeId: identifierSchema,
  })
  .strict();

const controlNodeBaseShape = {
  nodeId: identifierSchema,
  dependsOn: controlDependencySchema,
  loopInstance: controlLoopInstanceSchema.optional(),
  loopGuard: controlLoopGuardSchema.optional(),
  optimizationGuard: controlOptimizationGuardSchema.optional(),
};

const controlOptimizationMetricSchema = z
  .object({
    pointer: z.string().max(4_096),
    direction: z.enum(["minimize", "maximize"]),
  })
  .strict();

const controlOptimizationInvariantSchema = z
  .object({
    pointer: z.string().max(4_096),
    equals: z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(65_536)]),
  })
  .strict();

const controlOptimizationBaselineSchema = z
  .object({
    nodeId: identifierSchema,
    field: z.literal("result.value"),
  })
  .strict();

const controlConditionSchema = z
  .object({
    source: z
      .object({
        nodeId: identifierSchema,
        field: evidenceSourceFieldSchema,
      })
      .strict(),
    cases: z
      .array(
        z
          .object({
            id: identifierSchema,
            equals: agentOutputSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    default: identifierSchema,
  })
  .strict()
  .superRefine((condition, context) => {
    const ids = condition.cases.map((item) => item.id);
    const values = condition.cases.map((item) => item.equals);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "control condition case identifiers must be unique",
      });
    }
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "control condition case values must be unique",
      });
    }
    if (ids.includes(condition.default)) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "control condition default must be distinct from exact cases",
      });
    }
    if (
      condition.cases.reduce((total, item) => total + Buffer.byteLength(item.equals, "utf8"), 0) >
      65_536
    ) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "control condition values must not exceed 65536 UTF-8 bytes in total",
      });
    }
  });

const controlVerifierCommandSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict();

const controlVerifierSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: controlVerifierCommandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model"),
      prompt: z
        .string()
        .min(1)
        .max(16_384)
        .refine((value) => value === value.trim(), {
          message: "verifier prompt must not contain surrounding whitespace",
        }),
      evidence: z
        .array(
          z
            .object({
              nodeId: identifierSchema,
              field: evidenceSourceFieldSchema,
            })
            .strict(),
        )
        .min(1)
        .max(16)
        .refine(
          (items) =>
            new Set(items.map((item) => `${item.nodeId}\0${item.field}`)).size === items.length,
          "verifier evidence sources must be unique",
        ),
      model: z
        .object({
          provider: z.string().min(1).max(96),
          id: z.string().min(1).max(256),
          thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
        })
        .strict(),
      timeoutMs: z.number().int().positive().max(86_400_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("packaged-command"),
      package: z
        .object({
          name: verifierPackageNameSchema,
          version: verifierPackageVersionSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("packaged-model"),
      package: z
        .object({
          name: verifierPackageNameSchema,
          version: verifierPackageVersionSchema,
        })
        .strict(),
      evidence: z
        .array(
          z
            .object({
              nodeId: identifierSchema,
              field: evidenceSourceFieldSchema,
            })
            .strict(),
        )
        .min(1)
        .max(16)
        .refine(
          (items) =>
            new Set(items.map((item) => `${item.nodeId}\0${item.field}`)).size === items.length,
          "verifier evidence sources must be unique",
        ),
      model: z
        .object({
          provider: z.string().min(1).max(96),
          id: z.string().min(1).max(256),
          thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
        })
        .strict(),
      timeoutMs: z.number().int().positive().max(86_400_000),
    })
    .strict(),
]);

const controlGraphNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("command"),
      when: controlBranchGuardSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("agent"),
      when: controlBranchGuardSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("child"),
      when: controlBranchGuardSchema.optional(),
      child: z
        .object({
          workflowId: identifierSchema,
          workflowDigest: sha256Schema,
          resultNodeId: identifierSchema,
          resultSchema: boundedCompiledResultSchemaSchema,
          resultSchemaDigest: sha256Schema,
        })
        .strict(),
      optimizationCandidate: z
        .object({
          optimizationId: identifierSchema,
          candidate: optimizationCandidateNumberSchema,
          checkNodeId: identifierSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("approval"),
      when: controlBranchGuardSchema.optional(),
      approval: z
        .object({
          prompt: canonicalWorkflowApprovalPromptSchema,
          evidence: z
            .array(
              z
                .object({
                  nodeId: identifierSchema,
                  field: evidenceSourceFieldSchema,
                })
                .strict(),
            )
            .min(1)
            .max(16)
            .refine(
              (items) =>
                new Set(items.map((item) => `${item.nodeId}\0${item.field}`)).size === items.length,
              "workflow approval evidence sources must be unique",
            ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("verifier"),
      when: controlBranchGuardSchema.optional(),
      verifier: controlVerifierSchema,
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("result"),
      when: controlBranchGuardSchema.optional(),
      result: z
        .object({
          source: z
            .object({
              nodeId: identifierSchema,
              field: evidenceSourceFieldSchema,
            })
            .strict(),
          schema: boundedCompiledResultSchemaSchema,
          schemaDigest: sha256Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("condition"),
      when: controlBranchGuardSchema.optional(),
      condition: controlConditionSchema,
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("join"),
      join: z
        .object({
          conditionId: identifierSchema,
          branches: z
            .array(
              z
                .object({
                  case: identifierSchema,
                  nodeId: identifierSchema,
                })
                .strict(),
            )
            .min(2)
            .max(33),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("loop-check"),
      loopCheck: z
        .object({
          loopId: identifierSchema,
          iteration: loopIterationSchema,
          source: z
            .object({
              nodeId: identifierSchema,
              field: evidenceSourceFieldSchema,
            })
            .strict(),
          equals: agentOutputSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("loop"),
      loop: z
        .object({
          maxIterations: loopIterationSchema,
          checkNodeIds: z
            .array(identifierSchema)
            .min(1)
            .max(MAX_LOOP_ITERATIONS)
            .refine((items) => new Set(items).size === items.length, {
              message: "loop check node ids must be unique",
            }),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("optimization-check"),
      optimizationCheck: z
        .object({
          optimizationId: identifierSchema,
          candidate: optimizationCandidateNumberSchema,
          candidateNodeId: identifierSchema,
          priorCheckNodeId: identifierSchema.optional(),
          baseline: controlOptimizationBaselineSchema,
          metric: controlOptimizationMetricSchema,
          invariants: z.array(controlOptimizationInvariantSchema).max(16),
          maxConsecutiveNonImproving: optimizationCandidateNumberSchema,
          rollback: z.literal("previous-best"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlNodeBaseShape,
      type: z.literal("optimization"),
      optimization: z
        .object({
          baseline: controlOptimizationBaselineSchema,
          baselineSchemaDigest: sha256Schema,
          metric: controlOptimizationMetricSchema,
          invariants: z.array(controlOptimizationInvariantSchema).max(16),
          maxCandidates: optimizationCandidateNumberSchema,
          maxConsecutiveNonImproving: optimizationCandidateNumberSchema,
          rollback: z.literal("previous-best"),
          candidateNodeIds: z.array(identifierSchema).min(1).max(MAX_OPTIMIZATION_CANDIDATES),
          checkNodeIds: z.array(identifierSchema).min(1).max(MAX_OPTIMIZATION_CANDIDATES),
        })
        .strict(),
    })
    .strict(),
]);

const controlGraphSchema = z
  .object({
    nodes: z
      .array(controlGraphNodeSchema)
      .min(1)
      .max(MAX_COMPILED_WORKFLOW_NODES)
      .refine(
        (nodes) => new Set(nodes.map((node) => node.nodeId)).size === nodes.length,
        "control graph node ids must be unique",
      ),
  })
  .strict()
  .refine(
    (graph) =>
      Buffer.byteLength(JSON.stringify(graph), "utf8") <= MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
    `serialized control graph must not exceed ${MAX_CONTROL_GRAPH_SERIALIZED_BYTES} UTF-8 bytes`,
  );

const optimizationEvaluationReasonSchema = z.enum([
  "improved",
  "not_improved",
  "invariant_failed",
  "candidate_no_change",
  "candidate_delta_limit_exceeded",
  "candidate_failed",
  "candidate_cancelled",
  "candidate_resource_exhausted",
]);
const optimizationScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(65_536),
]);
const optimizationInvariantObservationSchema = z
  .object({
    pointer: z.string().max(4_096),
    expected: optimizationScalarSchema,
    actual: optimizationScalarSchema,
    passed: z.boolean(),
  })
  .strict();
const optimizationWorkspaceEntryIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("directory"),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      mode: z.number().int().min(0).max(0o777),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sha256: sha256Schema,
    })
    .strict(),
  z.object({ kind: z.literal("symlink"), target: z.string().max(4_096) }).strict(),
]);
const optimizationDeltaEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\0") &&
          path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "optimization delta path must be a canonical relative path",
      ),
    before: optimizationWorkspaceEntryIdentitySchema,
    after: optimizationWorkspaceEntryIdentitySchema,
  })
  .strict();
const optimizationPromotionBoundarySchema = z
  .object({
    promotionId: identifierSchema,
    workspaceId: identifierSchema,
    deltaDigest: sha256Schema,
    baselineSnapshotDigest: sha256Schema,
    candidateSnapshotDigest: sha256Schema,
    entryCount: z.number().int().positive().max(20_000),
    logicalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_started"),
      nodeIds: z
        .array(identifierSchema)
        .min(1)
        .refine((items) => new Set(items).size === items.length, "node ids must be unique"),
      workflowApiVersion: z.literal("flow.synapti.ai/v1alpha1"),
      workflowDigest: sha256Schema,
      capabilitySnapshot: persistedCapabilitySnapshotSchema.optional(),
      capabilityRequirements: z
        .array(
          z
            .object({
              nodeId: identifierSchema,
              skills: z
                .array(agentSkillNameSchema)
                .min(1)
                .max(MAX_AGENT_SKILL_PACKAGES)
                .refine(
                  (items) => new Set(items).size === items.length,
                  "selected Agent Skills must be unique",
                ),
            })
            .strict(),
        )
        .max(MAX_COMPILED_WORKFLOW_NODES)
        .optional(),
      verifierPackageRequirements: z
        .array(
          z
            .object({
              nodeId: identifierSchema,
              name: verifierPackageNameSchema,
              version: verifierPackageVersionSchema,
              kind: z.enum(["command", "model"]),
            })
            .strict(),
        )
        .max(MAX_COMPILED_WORKFLOW_NODES)
        .optional(),
      budget: runBudgetLimitsSchema.optional(),
      concurrency: z
        .object({ maxNodes: z.number().int().min(1).max(MAX_CONCURRENT_NODES) })
        .strict()
        .optional(),
      goal: compiledGoalSchema.optional(),
      executionCwd: absolutePathSchema.optional(),
      executionWorkspace: executionWorkspaceSchema.optional(),
      approvalRequirements: z
        .array(z.object({ nodeId: identifierSchema, grantTtlMs: grantTtlSchema }).strict())
        .max(MAX_COMPILED_WORKFLOW_NODES)
        .optional(),
      recoveryRequirements: z
        .array(
          z
            .object({
              nodeId: identifierSchema,
              mode: z.literal("fresh"),
              maxAttempts: z.number().int().min(2).max(16),
              effectProtocol: z.enum(["none", DURABLE_EFFECT_PROTOCOL]),
            })
            .strict(),
        )
        .max(MAX_COMPILED_WORKFLOW_NODES)
        .optional(),
      controlGraph: controlGraphSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_resumed"),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("command_approval_requested"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      requestId: identifierSchema,
      grantTtlMs: grantTtlSchema,
      operation: approvalOperationSchema,
      operationDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("command_approval_granted"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      requestId: identifierSchema,
      operationDigest: sha256Schema,
      actor: actorSchema,
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("command_approval_denied"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      requestId: identifierSchema,
      operationDigest: sha256Schema,
      actor: actorSchema,
      reason: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("command_approval_expired"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      requestId: identifierSchema,
      operationDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("workflow_approval_requested"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      requestId: identifierSchema,
      request: workflowApprovalRequestSchema,
      requestDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("workflow_approval_approved"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      requestId: identifierSchema,
      requestDigest: sha256Schema,
      actor: actorSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("workflow_approval_denied"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      requestId: identifierSchema,
      requestDigest: sha256Schema,
      actor: actorSchema,
      reason: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_started"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      effectProtocol: z.literal(DURABLE_EFFECT_PROTOCOL).optional(),
      approval: approvalReferenceSchema.optional(),
      child: childRunLinkSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_attempt_interrupted"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      reason: z.literal("process_interrupted"),
      disposition: z.literal("fresh_retry"),
      resourceAccounting: z.literal("incomplete"),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_condition_evaluated"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      sourceNodeId: identifierSchema,
      sourceAttempt: z.number().int().positive(),
      sourceField: evidenceSourceFieldSchema,
      sourceHash: sha256Schema,
      selectedCase: identifierSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_result_published"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      sourceNodeId: identifierSchema,
      sourceAttempt: z.number().int().positive(),
      sourceField: evidenceSourceFieldSchema,
      sourceHash: sha256Schema,
      schemaDigest: sha256Schema,
      canonicalValue: z
        .string()
        .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_RESULT_VALUE_BYTES, {
          message: `canonical result must not exceed ${MAX_RESULT_VALUE_BYTES} UTF-8 bytes`,
        }),
      valueHash: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_omitted"),
      nodeId: identifierSchema,
      reason: z.enum([
        "condition_not_selected",
        "dependency_omitted",
        "loop_not_continued",
        "optimization_stopped",
      ]),
      conditionId: identifierSchema.optional(),
      selectedCase: identifierSchema.optional(),
      expectedCase: identifierSchema.optional(),
      omittedDependencies: z.array(identifierSchema).min(1).max(128).optional(),
      loopId: identifierSchema.optional(),
      iteration: loopIterationSchema.optional(),
      checkNodeId: identifierSchema.optional(),
      optimizationId: identifierSchema.optional(),
      candidate: optimizationCandidateNumberSchema.optional(),
    })
    .strict()
    .superRefine((event, context) => {
      const hasAllConditionFields =
        event.conditionId !== undefined &&
        event.selectedCase !== undefined &&
        event.expectedCase !== undefined;
      const hasAnyConditionField =
        event.conditionId !== undefined ||
        event.selectedCase !== undefined ||
        event.expectedCase !== undefined;
      const hasDependencyFields = event.omittedDependencies !== undefined;
      const hasAllLoopFields =
        event.loopId !== undefined &&
        event.iteration !== undefined &&
        event.checkNodeId !== undefined;
      const hasAnyLoopField =
        event.loopId !== undefined ||
        event.iteration !== undefined ||
        event.checkNodeId !== undefined;
      const hasAllOptimizationFields =
        event.optimizationId !== undefined &&
        event.candidate !== undefined &&
        event.checkNodeId !== undefined;
      const hasAnyOptimizationField =
        event.optimizationId !== undefined || event.candidate !== undefined;
      if (
        event.reason === "condition_not_selected" &&
        (!hasAllConditionFields ||
          hasDependencyFields ||
          hasAnyLoopField ||
          hasAnyOptimizationField)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "condition omission requires only condition decision fields",
        });
      }
      if (
        event.reason === "dependency_omitted" &&
        (!hasDependencyFields || hasAnyConditionField || hasAnyLoopField || hasAnyOptimizationField)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "dependency omission requires only omitted dependencies",
        });
      }
      if (
        event.reason === "loop_not_continued" &&
        (!hasAllLoopFields ||
          hasAnyConditionField ||
          hasDependencyFields ||
          hasAnyOptimizationField)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "loop omission requires only loop guard fields",
        });
      }
      if (
        event.reason === "optimization_stopped" &&
        (!hasAllOptimizationFields ||
          event.loopId !== undefined ||
          event.iteration !== undefined ||
          hasAnyConditionField ||
          hasDependencyFields)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "optimization omission requires only optimization guard fields",
        });
      }
    }),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_joined"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      conditionId: identifierSchema,
      selectedCase: identifierSchema,
      completedNodeId: identifierSchema,
      omittedNodeIds: z.array(identifierSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_loop_checked"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      loopId: identifierSchema,
      iteration: loopIterationSchema,
      sourceNodeId: identifierSchema,
      sourceAttempt: z.number().int().positive(),
      sourceField: evidenceSourceFieldSchema,
      sourceHash: sha256Schema,
      decision: z.enum(["stop", "continue"]),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_loop_completed"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      completedIterations: loopIterationSchema,
      terminatingCheckNodeId: identifierSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_evaluated"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      optimizationId: identifierSchema,
      candidate: optimizationCandidateNumberSchema,
      candidateNodeId: identifierSchema,
      baselineValueHash: sha256Schema,
      baselineMetric: z.number().finite(),
      baselineInvariants: z.array(optimizationInvariantObservationSchema).max(16),
      bestValueHashBefore: sha256Schema,
      bestMetricBefore: z.number().finite(),
      candidateOutcome: z.enum(["succeeded", "failed", "cancelled", "resource_exhausted"]),
      candidateValueHash: sha256Schema.nullable(),
      candidateMetric: z.number().finite().nullable(),
      candidateInvariants: z.array(optimizationInvariantObservationSchema).max(16).nullable(),
      decision: z.enum(["promote", "reject"]),
      reason: optimizationEvaluationReasonSchema,
      stagnation: z.number().int().nonnegative().max(MAX_OPTIMIZATION_CANDIDATES),
      stop: z.boolean(),
      promotion: optimizationPromotionBoundarySchema.nullable(),
      deltaEntries: z
        .array(optimizationDeltaEntrySchema)
        .min(1)
        .max(20_000)
        .refine(
          (entries) =>
            Buffer.byteLength(JSON.stringify(entries), "utf8") <=
            MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES,
          `serialized optimization delta evidence must not exceed ${MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES} UTF-8 bytes`,
        )
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_promotion_prepared"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      optimizationId: identifierSchema,
      candidate: optimizationCandidateNumberSchema,
      promotion: optimizationPromotionBoundarySchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_promotion_settled"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      optimizationId: identifierSchema,
      candidate: optimizationCandidateNumberSchema,
      promotionId: identifierSchema,
      deltaDigest: sha256Schema,
      outcome: z.enum(["committed", "rolled_back", "unknown"]),
      reason: z.enum([
        "local_commit_durable",
        "compensated_after_failure",
        "reconciled_incomplete",
        "affected_path_diverged",
      ]),
    })
    .strict()
    .superRefine((event, context) => {
      const valid =
        (event.outcome === "committed" && event.reason === "local_commit_durable") ||
        (event.outcome === "rolled_back" &&
          (event.reason === "compensated_after_failure" ||
            event.reason === "reconciled_incomplete")) ||
        (event.outcome === "unknown" && event.reason === "affected_path_diverged");
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: `promotion settlement outcome "${event.outcome}" has an invalid reason`,
        });
      }
    }),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_candidate_cleaned"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      optimizationId: identifierSchema,
      candidate: optimizationCandidateNumberSchema,
      candidateNodeId: identifierSchema,
      workspaceId: identifierSchema,
      reason: z.enum(["rejected", "promotion_settled"]),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_checked"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      optimizationId: identifierSchema,
      candidate: optimizationCandidateNumberSchema,
      outcome: z.enum(["accepted", "rejected"]),
      reason: optimizationEvaluationReasonSchema,
      bestValueHash: sha256Schema,
      bestMetric: z.number().finite(),
      bestCandidate: optimizationCandidateNumberSchema.nullable(),
      stagnation: z.number().int().nonnegative().max(MAX_OPTIMIZATION_CANDIDATES),
      stop: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_optimization_completed"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      completedCandidates: optimizationCandidateNumberSchema,
      terminatingCheckNodeId: identifierSchema,
      bestValueHash: sha256Schema,
      bestMetric: z.number().finite(),
      bestCandidate: optimizationCandidateNumberSchema.nullable(),
      stopReason: z.enum(["stagnation", "max_candidates"]),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_control_failed"),
      nodeId: identifierSchema,
      attempt: z.literal(1),
      error: nodeFailureSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_effect_prepared"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      effectId: effectIdSchema,
      effectSequence: z.number().int().positive().max(MAX_AGENT_EFFECT_RECEIPTS),
      descriptor: filesystemEditEffectDescriptorSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_effect_settled"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      effectId: effectIdSchema,
      outcome: z.enum(["committed", "not_applied", "unknown"]),
      reason: z.enum(["directory_synced", "commit_not_entered", "post_commit_failure"]),
    })
    .strict()
    .superRefine((event, context) => {
      const expectedReason =
        event.outcome === "committed"
          ? "directory_synced"
          : event.outcome === "not_applied"
            ? "commit_not_entered"
            : "post_commit_failure";
      if (event.reason !== expectedReason) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: `effect settlement outcome "${event.outcome}" requires reason "${expectedReason}"`,
        });
      }
    }),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_effect_reconciled"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      effectId: effectIdSchema,
      outcome: z.enum(["applied", "not_applied", "unknown"]),
      reason: z.enum([
        "target_matches_after",
        "target_matches_before",
        "target_missing",
        "target_not_regular",
        "target_unreadable",
        "target_too_large",
        "target_content_diverged",
        "target_mode_diverged",
        "target_changed_during_observation",
      ]),
      observedSha256: sha256Schema.optional(),
      observedMode: z.number().int().min(0).max(0o777).optional(),
    })
    .strict()
    .superRefine((event, context) => {
      const exactObservation =
        event.reason === "target_matches_after" ||
        event.reason === "target_matches_before" ||
        event.reason === "target_content_diverged" ||
        event.reason === "target_mode_diverged";
      if (exactObservation !== (event.observedSha256 !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["observedSha256"],
          message: exactObservation
            ? `effect reconciliation reason "${event.reason}" requires an observed digest`
            : `effect reconciliation reason "${event.reason}" forbids an observed digest`,
        });
      }
      if (exactObservation !== (event.observedMode !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["observedMode"],
          message: exactObservation
            ? `effect reconciliation reason "${event.reason}" requires an observed mode`
            : `effect reconciliation reason "${event.reason}" forbids an observed mode`,
        });
      }

      const expectedOutcome =
        event.reason === "target_matches_after"
          ? "applied"
          : event.reason === "target_matches_before"
            ? "not_applied"
            : "unknown";
      if (event.outcome !== expectedOutcome) {
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: `effect reconciliation reason "${event.reason}" requires outcome "${expectedOutcome}"`,
        });
      }
    }),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_succeeded"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      evidence: nodeEvidenceSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_failed"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      error: nodeFailureSchema,
      evidence: nodeEvidenceSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_succeeded"),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_failed"),
      failedNodeId: identifierSchema,
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_cancelled"),
      reason: z.string().min(1).max(16_384),
      cancelledNodeId: identifierSchema.optional(),
      cancelledNodeIds: z
        .array(identifierSchema)
        .min(1)
        .max(MAX_CONCURRENT_NODES)
        .refine((items) => new Set(items).size === items.length, {
          message: "cancelled node ids must be unique",
        })
        .optional(),
      actor: actorSchema.optional(),
      requestId: z.uuid().optional(),
    })
    .strict()
    .superRefine((event, context) => {
      if ((event.actor === undefined) !== (event.requestId === undefined)) {
        context.addIssue({
          code: "custom",
          message: "cancellation actor and request id must be provided together",
        });
      }
      if (event.cancelledNodeId !== undefined && event.cancelledNodeIds !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["cancelledNodeIds"],
          message: "cancellation must use either a single node id or an ordered node-id list",
        });
      }
    }),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("run_budget_exhausted"),
      exhausted: z.array(runBudgetExhaustionSchema).min(1).max(RUN_BUDGET_DIMENSIONS.length),
    })
    .strict(),
]);

export function parseRunEvent(input: unknown): RunEvent {
  return runEventSchema.parse(input) as RunEvent;
}

export function reduceRunEvents(inputEvents: readonly RunEvent[]): RunState {
  if (inputEvents.length === 0) {
    throw new RunReplayError(0, "the ledger is empty");
  }

  let state: RunState | undefined;
  for (const [index, inputEvent] of inputEvents.entries()) {
    state = appendRunEvent(state, inputEvent, index);
  }
  if (state === undefined) {
    throw new RunReplayError(0, "the ledger is empty");
  }
  return state;
}

/**
 * Validate and apply one event without replaying prior evidence. Stores use this
 * transition function to keep append cost linear in the number of events.
 */
export function appendRunEvent(
  currentState: RunState | undefined,
  inputEvent: RunEvent,
  eventIndex = currentState?.lastSequence ?? 0,
): RunState {
  let event: RunEvent;
  try {
    event = parseRunEvent(inputEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RunReplayError(eventIndex, `event schema is invalid: ${message}`);
  }

  const expectedSequence = (currentState?.lastSequence ?? 0) + 1;
  if (event.sequence !== expectedSequence) {
    throw new RunReplayError(
      eventIndex,
      `expected sequence ${expectedSequence}, received ${event.sequence}`,
    );
  }

  if (currentState === undefined) {
    if (event.type !== "run_started") {
      throw new RunReplayError(eventIndex, "the first event must be run_started");
    }
    const nodes: Record<string, NodeRunState> = {};
    for (const nodeId of event.nodeIds) {
      nodes[nodeId] = pendingNodeState();
    }
    if (
      event.goal?.criteria.some((criterion) => !event.nodeIds.includes(criterion.verifierNodeId))
    ) {
      throw new RunReplayError(eventIndex, "goal references a verifier outside the run node set");
    }
    const requirements = event.approvalRequirements ?? [];
    if (
      new Set(requirements.map((requirement) => requirement.nodeId)).size !== requirements.length
    ) {
      throw new RunReplayError(eventIndex, "approval requirements must have unique node ids");
    }
    if (requirements.some((requirement) => !event.nodeIds.includes(requirement.nodeId))) {
      throw new RunReplayError(
        eventIndex,
        "approval requirement references a node outside the run node set",
      );
    }
    if (requirements.length > 0 && event.executionCwd === undefined) {
      throw new RunReplayError(
        eventIndex,
        "approval requirements require a persisted execution working directory",
      );
    }
    const approvalRequirements = Object.fromEntries(
      requirements.map((requirement) => [
        requirement.nodeId,
        Object.freeze({ grantTtlMs: requirement.grantTtlMs }),
      ]),
    );
    const capabilityRequirements = event.capabilityRequirements ?? [];
    if (
      new Set(capabilityRequirements.map((requirement) => requirement.nodeId)).size !==
      capabilityRequirements.length
    ) {
      throw new RunReplayError(eventIndex, "capability requirements must have unique node ids");
    }
    if (capabilityRequirements.some((requirement) => !event.nodeIds.includes(requirement.nodeId))) {
      throw new RunReplayError(
        eventIndex,
        "capability requirement references a node outside the run node set",
      );
    }
    if (capabilityRequirements.length > 0 && event.capabilitySnapshot === undefined) {
      throw new RunReplayError(
        eventIndex,
        "capability requirements require a durable run capability snapshot",
      );
    }
    const availableCapabilityNames = new Set(
      event.capabilitySnapshot?.packages
        .filter((item) => item.kind === "agent-skill")
        .map((skill) => skill.name) ?? [],
    );
    const missingRequiredCapability = capabilityRequirements
      .flatMap((requirement) => requirement.skills)
      .find((name) => !availableCapabilityNames.has(name));
    if (missingRequiredCapability !== undefined) {
      throw new RunReplayError(
        eventIndex,
        `capability requirement references missing Agent Skill "${missingRequiredCapability}"`,
      );
    }
    const capabilityRequirementsByNode = Object.fromEntries(
      capabilityRequirements.map((requirement) => [
        requirement.nodeId,
        Object.freeze([...requirement.skills]),
      ]),
    );
    const verifierPackageRequirements = event.verifierPackageRequirements ?? [];
    if (
      new Set(verifierPackageRequirements.map((requirement) => requirement.nodeId)).size !==
      verifierPackageRequirements.length
    ) {
      throw new RunReplayError(
        eventIndex,
        "verifier package requirements must have unique node ids",
      );
    }
    if (
      verifierPackageRequirements.some((requirement) => !event.nodeIds.includes(requirement.nodeId))
    ) {
      throw new RunReplayError(
        eventIndex,
        "verifier package requirement references a node outside the run node set",
      );
    }
    if (verifierPackageRequirements.length > 0 && event.capabilitySnapshot === undefined) {
      throw new RunReplayError(
        eventIndex,
        "verifier package requirements require a durable capability snapshot",
      );
    }
    const recoveryRequirements = event.recoveryRequirements ?? [];
    if (
      new Set(recoveryRequirements.map((requirement) => requirement.nodeId)).size !==
      recoveryRequirements.length
    ) {
      throw new RunReplayError(eventIndex, "recovery requirements must have unique node ids");
    }
    if (recoveryRequirements.some((requirement) => !event.nodeIds.includes(requirement.nodeId))) {
      throw new RunReplayError(
        eventIndex,
        "recovery requirement references a node outside the run node set",
      );
    }
    const recoveryRequirementsByNode = Object.fromEntries(
      recoveryRequirements.map((requirement) => [
        requirement.nodeId,
        Object.freeze({
          mode: requirement.mode,
          maxAttempts: requirement.maxAttempts,
          effectProtocol: requirement.effectProtocol,
        }),
      ]),
    );
    const controlGraph =
      event.controlGraph === undefined
        ? null
        : validateControlGraph(event.controlGraph, event.nodeIds, eventIndex);
    const packagedControlNodes =
      controlGraph?.nodes.filter(
        (node) =>
          node.type === "verifier" &&
          (node.verifier.kind === "packaged-command" || node.verifier.kind === "packaged-model"),
      ) ?? [];
    if (packagedControlNodes.length !== verifierPackageRequirements.length) {
      throw new RunReplayError(
        eventIndex,
        "verifier package requirements do not cover the packaged control graph exactly",
      );
    }
    for (const requirement of verifierPackageRequirements) {
      const controlNode = packagedControlNodes.find((node) => node.nodeId === requirement.nodeId);
      if (controlNode?.type !== "verifier") {
        throw new RunReplayError(
          eventIndex,
          `verifier package requirement references non-packaged node "${requirement.nodeId}"`,
        );
      }
      const expectedKind =
        controlNode.verifier.kind === "packaged-command"
          ? "command"
          : controlNode.verifier.kind === "packaged-model"
            ? "model"
            : null;
      const reference =
        controlNode.verifier.kind === "packaged-command" ||
        controlNode.verifier.kind === "packaged-model"
          ? controlNode.verifier.package
          : null;
      if (
        expectedKind === null ||
        reference === null ||
        requirement.name !== reference.name ||
        requirement.version !== reference.version ||
        requirement.kind !== expectedKind
      ) {
        throw new RunReplayError(
          eventIndex,
          `verifier package requirement for node "${requirement.nodeId}" does not match the control graph`,
        );
      }
      const selected = event.capabilitySnapshot?.packages.find(
        (item) =>
          item.kind === "verifier-package" &&
          item.name === requirement.name &&
          item.version === requirement.version,
      );
      if (
        selected?.kind !== "verifier-package" ||
        selected.version !== requirement.version ||
        selected.definition.kind !== requirement.kind
      ) {
        throw new RunReplayError(
          eventIndex,
          `verifier package requirement for node "${requirement.nodeId}" does not match the durable snapshot`,
        );
      }
    }
    const verifierPackageRequirementsByNode = Object.fromEntries(
      verifierPackageRequirements.map(({ nodeId, ...requirement }) => [
        nodeId,
        Object.freeze({ ...requirement }),
      ]),
    );
    const concurrency = Object.freeze({ maxNodes: event.concurrency?.maxNodes ?? 1 });
    if (concurrency.maxNodes > 1 && controlGraph === null) {
      throw new RunReplayError(
        eventIndex,
        "concurrent run metadata requires a persisted control graph",
      );
    }
    const resources = emptyRunResources();
    return freezeRunState({
      runId: event.runId,
      workflowId: event.workflowId,
      workflowApiVersion: event.workflowApiVersion,
      workflowDigest: event.workflowDigest,
      capabilitySnapshot:
        event.capabilitySnapshot === undefined
          ? null
          : deepFreeze(structuredClone(event.capabilitySnapshot)),
      capabilityRequirements: Object.freeze(capabilityRequirementsByNode),
      verifierPackageRequirements: Object.freeze(verifierPackageRequirementsByNode),
      executionCwd: event.executionCwd ?? null,
      executionWorkspace:
        event.executionWorkspace === undefined
          ? null
          : deepFreeze(structuredClone(event.executionWorkspace)),
      approvalRequirements: Object.freeze(approvalRequirements),
      recoveryRequirements: Object.freeze(recoveryRequirementsByNode),
      controlGraph,
      concurrency,
      resources,
      budget: calculateRunBudgetState(event.budget, resources),
      status: "running",
      startedAt: event.at,
      finishedAt: null,
      lastSequence: event.sequence,
      failedNodeId: null,
      failureReason: null,
      goal: event.goal === undefined ? null : createGoalRunState(event.goal),
      nodes,
    });
  }

  if (event.runId !== currentState.runId || event.workflowId !== currentState.workflowId) {
    throw new RunReplayError(eventIndex, "runId and workflowId must remain constant");
  }
  if (isTerminalRunStatus(currentState.status)) {
    throw new RunReplayError(
      eventIndex,
      `event follows terminal run status "${currentState.status}"`,
    );
  }
  if (event.type === "run_started") {
    throw new RunReplayError(eventIndex, "run_started may occur only once");
  }

  const nodes: Record<string, NodeRunState> = { ...currentState.nodes };
  const failedNodes = Object.entries(nodes).filter(([, node]) => node.status === "failed");
  if (
    failedNodes.length > 0 &&
    event.type !== "run_failed" &&
    event.type !== "run_cancelled" &&
    event.type !== "run_budget_exhausted" &&
    event.type !== "run_resumed" &&
    event.type !== "node_effect_reconciled" &&
    event.type !== "node_attempt_interrupted" &&
    !isRunningNodeOutcome(event, nodes)
  ) {
    throw new RunReplayError(
      eventIndex,
      "node_failed closes admission and permits only sibling outcomes, typed recovery evidence, or run terminalization",
    );
  }

  let status: RunStatus = currentState.status;
  let finishedAt: string | null = currentState.finishedAt;
  let failedNodeId: string | null = currentState.failedNodeId;
  let failureReason: string | null = currentState.failureReason;
  let goal = currentState.goal;
  let resources = currentState.resources;

  switch (event.type) {
    case "run_resumed": {
      const openAttempt = Object.entries(nodes).find(([, node]) => node.status === "running");
      if (openAttempt !== undefined) {
        const [nodeId, node] = openAttempt;
        throw new RunReplayError(
          eventIndex,
          `run cannot resume while node "${nodeId}" attempt ${node.attempt} remains running`,
        );
      }
      break;
    }
    case "command_approval_requested": {
      if (currentState.status !== "running") {
        throw new RunReplayError(eventIndex, "a new approval request requires a running run");
      }
      if ((currentState.budget?.exhausted.length ?? 0) > 0) {
        throw new RunReplayError(
          eventIndex,
          "command approval cannot be requested after the run budget is exhausted",
        );
      }
      const unconsumedApproval = Object.entries(nodes).find(
        ([nodeId, node]) =>
          nodeId !== event.nodeId &&
          node.approval !== null &&
          (node.approval.status === "pending" || node.approval.status === "granted"),
      );
      if (unconsumedApproval !== undefined) {
        throw new RunReplayError(
          eventIndex,
          `another approval grant remains unconsumed for node "${unconsumedApproval[0]}"`,
        );
      }
      if (Object.values(nodes).some((node) => node.status === "running")) {
        throw new RunReplayError(
          eventIndex,
          "approval cannot be requested while a node is running",
        );
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      if (current.status !== "pending") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" must be pending before requesting approval`,
        );
      }
      const requirement = currentState.approvalRequirements[event.nodeId];
      if (requirement === undefined) {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" does not require approval`);
      }
      if (current.approval !== null && current.approval.status !== "expired") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" already has a current approval request`,
        );
      }
      if (event.attempt !== current.attempt + 1) {
        throw new RunReplayError(
          eventIndex,
          `approval attempt ${event.attempt} does not match next node attempt ${current.attempt + 1}`,
        );
      }
      if (event.requestId !== commandApprovalRequestId(event.sequence)) {
        throw new RunReplayError(
          eventIndex,
          "approval request id does not match its event sequence",
        );
      }
      if (event.grantTtlMs !== requirement.grantTtlMs) {
        throw new RunReplayError(
          eventIndex,
          "approval request grant lifetime does not match the run requirement",
        );
      }
      if (currentState.executionCwd === null || event.operation.cwd !== currentState.executionCwd) {
        throw new RunReplayError(
          eventIndex,
          "approval operation working directory does not match the run execution context",
        );
      }
      if (event.operationDigest !== calculateCommandApprovalOperationDigest(event.operation)) {
        throw new RunReplayError(eventIndex, "approval operation digest is invalid");
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        approval: approvalStateFromRequest(event),
      });
      status = "waiting_for_approval";
      break;
    }
    case "command_approval_granted": {
      if (currentState.status !== "waiting_for_approval") {
        throw new RunReplayError(eventIndex, "approval grant requires a waiting run");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      const approval = requirePendingApproval(current, event, eventIndex);
      const expectedExpiry = new Date(Date.parse(event.at) + approval.grantTtlMs).toISOString();
      if (event.expiresAt !== expectedExpiry) {
        throw new RunReplayError(
          eventIndex,
          "approval expiry does not match the declared grant lifetime",
        );
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        approval: deepFreeze({
          ...approval,
          status: "granted" as const,
          decidedAt: event.at,
          actor: event.actor,
          expiresAt: event.expiresAt,
        }),
      });
      status = "running";
      break;
    }
    case "command_approval_denied": {
      if (currentState.status !== "waiting_for_approval") {
        throw new RunReplayError(eventIndex, "approval denial requires a waiting run");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      const approval = requirePendingApproval(current, event, eventIndex);
      const message = approvalDenialMessage(event.actor, event.reason);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "failed",
        attempt: event.attempt,
        finishedAt: event.at,
        error: Object.freeze({
          code: "command_approval_denied",
          message,
          retryable: false,
          sideEffectStatus: "none",
        }),
        approval: deepFreeze({
          ...approval,
          status: "denied" as const,
          decidedAt: event.at,
          actor: event.actor,
          reason: event.reason ?? null,
        }),
      });
      goal = applyCriterionDecision(
        goal,
        {
          runId: event.runId,
          nodeId: event.nodeId,
          attempt: event.attempt,
          at: event.at,
          outcome: "inconclusive",
          evidenceAvailable: false,
        },
        eventIndex,
      );
      status = "running";
      break;
    }
    case "command_approval_expired": {
      if (currentState.status !== "running") {
        throw new RunReplayError(eventIndex, "approval expiry requires an active granted run");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      const approval = requireGrantedApproval(current, event, eventIndex);
      if (approval.expiresAt === null || Date.parse(event.at) < Date.parse(approval.expiresAt)) {
        throw new RunReplayError(eventIndex, "approval grant has not expired");
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        approval: deepFreeze({
          ...approval,
          status: "expired" as const,
          expiredAt: event.at,
        }),
      });
      break;
    }
    case "workflow_approval_requested": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      if ((currentState.budget?.exhausted.length ?? 0) > 0) {
        throw new RunReplayError(
          eventIndex,
          "workflow approval cannot be requested after the run budget is exhausted",
        );
      }
      const unconsumedCommandApproval = Object.entries(nodes).find(
        ([nodeId, node]) =>
          nodeId !== event.nodeId &&
          node.approval !== null &&
          (node.approval.status === "pending" || node.approval.status === "granted"),
      );
      if (unconsumedCommandApproval !== undefined) {
        throw new RunReplayError(
          eventIndex,
          `another approval remains open for node "${unconsumedCommandApproval[0]}"`,
        );
      }
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "approval") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" is not a workflow approval control node`,
        );
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      if (current.workflowApproval !== null) {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" already has a workflow approval request`,
        );
      }
      requireSucceededDependencies(requirement, nodes, eventIndex);
      requireSelectedGuard(requirement, nodes, eventIndex);
      const observations = requirement.approval.evidence.map((source) => {
        const observation = controlSourceObservation(requirement.nodeId, source, nodes, eventIndex);
        if (observation.truncated) {
          throw new RunReplayError(
            eventIndex,
            `workflow approval "${event.nodeId}" source evidence is truncated`,
          );
        }
        return {
          sourceNodeId: source.nodeId,
          sourceAttempt: observation.attempt,
          sourceField: source.field,
          sourceHash: observation.hash,
        } as const;
      });
      const expectedRequest: WorkflowApprovalRequest = {
        version: 1,
        runId: currentState.runId,
        workflowId: currentState.workflowId,
        workflowDigest: currentState.workflowDigest,
        nodeId: requirement.nodeId,
        attempt: 1,
        prompt: requirement.approval.prompt,
        evidence: observations,
      };
      if (event.requestId !== workflowApprovalRequestId(event.sequence)) {
        throw new RunReplayError(
          eventIndex,
          "workflow approval request id does not match its event sequence",
        );
      }
      if (JSON.stringify(event.request) !== JSON.stringify(expectedRequest)) {
        throw new RunReplayError(
          eventIndex,
          "workflow approval request snapshot does not match durable graph evidence",
        );
      }
      const expectedDigest = calculateWorkflowApprovalRequestDigest(expectedRequest);
      if (event.requestDigest !== expectedDigest) {
        throw new RunReplayError(eventIndex, "workflow approval request digest is invalid");
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        workflowApproval: workflowApprovalStateFromRequest(event),
      });
      status = "waiting_for_approval";
      break;
    }
    case "workflow_approval_approved": {
      if (currentState.status !== "waiting_for_approval") {
        throw new RunReplayError(eventIndex, "workflow approval requires a waiting run");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      const approval = requirePendingWorkflowApproval(current, event, eventIndex);
      const control: NodeControlRunState = deepFreeze({
        kind: "approval",
        requestId: event.requestId,
        requestDigest: event.requestDigest,
        actor: event.actor,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        workflowApproval: deepFreeze({
          ...approval,
          status: "approved" as const,
          decidedAt: event.at,
          actor: event.actor,
        }),
        control,
      });
      status = "running";
      break;
    }
    case "workflow_approval_denied": {
      if (currentState.status !== "waiting_for_approval") {
        throw new RunReplayError(eventIndex, "workflow approval denial requires a waiting run");
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      const approval = requirePendingWorkflowApproval(current, event, eventIndex);
      const message = workflowApprovalDenialMessage(event.actor, event.reason);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "failed",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        error: Object.freeze({
          code: "workflow_approval_denied",
          message,
          retryable: false,
          sideEffectStatus: "none",
        }),
        workflowApproval: deepFreeze({
          ...approval,
          status: "denied" as const,
          decidedAt: event.at,
          actor: event.actor,
          reason: event.reason ?? null,
        }),
      });
      status = "running";
      break;
    }
    case "node_started": {
      if (currentState.status !== "running") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" cannot start while the run is waiting for approval`,
        );
      }
      const runningCount = Object.values(nodes).filter((node) => node.status === "running").length;
      if (runningCount >= currentState.concurrency.maxNodes) {
        throw new RunReplayError(
          eventIndex,
          currentState.concurrency.maxNodes === 1
            ? "only one node may be running at a time"
            : `node concurrency capacity ${currentState.concurrency.maxNodes} is already occupied`,
        );
      }
      if ((currentState.budget?.exhausted.length ?? 0) > 0) {
        throw new RunReplayError(
          eventIndex,
          `node cannot start because the run budget is exhausted for ${currentState.budget?.exhausted
            .map((item) => item.dimension)
            .join(", ")}`,
        );
      }
      const current = requireNode(nodes, event.nodeId, eventIndex);
      if (current.status !== "pending") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" must be pending before start`);
      }
      let childRun: ChildRunLink | null = null;
      if (currentState.controlGraph !== null) {
        const controlNode = requireControlGraphNode(currentState, event.nodeId, eventIndex);
        if (
          controlNode.type === "condition" ||
          controlNode.type === "approval" ||
          controlNode.type === "result" ||
          controlNode.type === "join" ||
          controlNode.type === "loop-check" ||
          controlNode.type === "loop"
        ) {
          throw new RunReplayError(
            eventIndex,
            `control node "${event.nodeId}" cannot start through an executor`,
          );
        }
        if (controlNode.type === "child") {
          if (
            event.child === undefined ||
            event.child.runId !== calculateChildRunId(event.runId, event.nodeId, event.attempt) ||
            !childRunLinkMatches(event.child, controlNode.child)
          ) {
            throw new RunReplayError(
              eventIndex,
              `child node "${event.nodeId}" start does not match its durable child link`,
            );
          }
          childRun = deepFreeze(structuredClone(event.child));
        } else if (event.child !== undefined) {
          throw new RunReplayError(
            eventIndex,
            `non-child node "${event.nodeId}" cannot carry a child link`,
          );
        }
        requireSucceededDependencies(controlNode, nodes, eventIndex);
        requireSelectedGuard(controlNode, nodes, eventIndex);
      } else if (event.child !== undefined) {
        throw new RunReplayError(eventIndex, "child node start requires a persisted control graph");
      }
      const requirement = currentState.approvalRequirements[event.nodeId];
      let approval = current.approval;
      if (requirement === undefined) {
        if (event.approval !== undefined) {
          throw new RunReplayError(eventIndex, `node "${event.nodeId}" does not require approval`);
        }
      } else {
        if (approval === null) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" requires an approved request before start`,
          );
        }
        if (approval.status !== "granted" || event.approval === undefined) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" requires an unexpired grant before start`,
          );
        }
        if (event.attempt !== approval.attempt) {
          throw new RunReplayError(
            eventIndex,
            `node start attempt ${event.attempt} does not match approval grant attempt ${approval.attempt}`,
          );
        }
        if (
          event.approval.requestId !== approval.requestId ||
          event.approval.operationDigest !== approval.operationDigest
        ) {
          throw new RunReplayError(
            eventIndex,
            "node start approval does not match its exact grant",
          );
        }
        if (approval.expiresAt === null || Date.parse(event.at) >= Date.parse(approval.expiresAt)) {
          throw new RunReplayError(eventIndex, "command approval grant expired before node start");
        }
        approval = deepFreeze({
          ...approval,
          status: "consumed" as const,
          consumedAt: event.at,
        });
      }
      if (event.attempt !== current.attempt + 1) {
        throw new RunReplayError(
          eventIndex,
          `node start attempt ${event.attempt} does not match next node attempt ${current.attempt + 1}`,
        );
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "running",
        attempt: event.attempt,
        startedAt: event.at,
        approval,
        childRun,
        effectProtocol: event.effectProtocol ?? null,
        effects: Object.freeze([]),
      });
      resources = addResourcesForStart(resources, eventIndex);
      break;
    }
    case "node_attempt_interrupted": {
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      const requirement = currentState.recoveryRequirements[event.nodeId];
      validateInterruptedAttemptRecovery(currentState, current, requirement, eventIndex);
      const interruptedAttempt: InterruptedNodeAttemptState = deepFreeze({
        attempt: current.attempt,
        startedAt: requireStartedAt(current, eventIndex),
        interruptedAt: event.at,
        reason: event.reason,
        disposition: event.disposition,
        resourceAccounting: event.resourceAccounting,
        effectProtocol: current.effectProtocol,
        effects: current.effects,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        evidence: null,
        error: null,
        approval: null,
        workflowApproval: null,
        effectProtocol: null,
        effects: Object.freeze([]),
        interruptedAttempts: Object.freeze([...current.interruptedAttempts, interruptedAttempt]),
      });
      break;
    }
    case "node_condition_evaluated": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "condition") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" is not a condition control node`,
        );
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireSucceededDependencies(requirement, nodes, eventIndex);
      requireSelectedGuard(requirement, nodes, eventIndex);
      const source = conditionSourceObservation(requirement, nodes, eventIndex);
      if (source.truncated) {
        throw new RunReplayError(
          eventIndex,
          `condition "${event.nodeId}" source evidence is truncated`,
        );
      }
      if (event.sourceNodeId !== requirement.condition.source.nodeId) {
        throw new RunReplayError(
          eventIndex,
          "condition source node does not match its control graph",
        );
      }
      if (event.sourceAttempt !== source.attempt) {
        throw new RunReplayError(
          eventIndex,
          "condition source attempt does not match durable evidence",
        );
      }
      if (event.sourceField !== requirement.condition.source.field) {
        throw new RunReplayError(
          eventIndex,
          "condition source field does not match its control graph",
        );
      }
      if (event.sourceHash !== source.hash) {
        throw new RunReplayError(
          eventIndex,
          "condition source hash does not match durable evidence",
        );
      }
      const selectedCase =
        requirement.condition.cases.find((item) => item.equals === source.value)?.id ??
        requirement.condition.default;
      if (event.selectedCase !== selectedCase) {
        throw new RunReplayError(
          eventIndex,
          `condition selected case "${event.selectedCase}" does not match durable source evidence`,
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "condition",
        sourceNodeId: event.sourceNodeId,
        sourceAttempt: event.sourceAttempt,
        sourceField: event.sourceField,
        sourceHash: event.sourceHash,
        selectedCase: event.selectedCase,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_result_published": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "result") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" is not a result control node`);
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireSucceededDependencies(requirement, nodes, eventIndex);
      requireSelectedGuard(requirement, nodes, eventIndex);
      const source = controlSourceObservation(
        requirement.nodeId,
        requirement.result.source,
        nodes,
        eventIndex,
      );
      if (source.truncated) {
        throw new RunReplayError(
          eventIndex,
          `result "${event.nodeId}" source evidence is truncated`,
        );
      }
      if (event.sourceNodeId !== requirement.result.source.nodeId) {
        throw new RunReplayError(eventIndex, "result source node does not match its control graph");
      }
      if (event.sourceAttempt !== source.attempt) {
        throw new RunReplayError(
          eventIndex,
          "result source attempt does not match durable evidence",
        );
      }
      if (event.sourceField !== requirement.result.source.field) {
        throw new RunReplayError(
          eventIndex,
          "result source field does not match its control graph",
        );
      }
      if (event.sourceHash !== source.hash) {
        throw new RunReplayError(eventIndex, "result source hash does not match durable evidence");
      }
      const expectedSchemaDigest = calculateResultSchemaDigest(requirement.result.schema);
      if (
        requirement.result.schemaDigest !== expectedSchemaDigest ||
        event.schemaDigest !== expectedSchemaDigest
      ) {
        throw new RunReplayError(eventIndex, "result schema digest does not match its declaration");
      }
      let evaluated: ReturnType<typeof evaluateTypedResult>;
      try {
        evaluated = evaluateTypedResult(source.value, requirement.result.schema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RunReplayError(
          eventIndex,
          `result publication does not match durable source validation: ${message}`,
        );
      }
      if (event.canonicalValue !== evaluated.canonicalValue) {
        throw new RunReplayError(
          eventIndex,
          "result canonical value does not match durable source evidence",
        );
      }
      if (event.valueHash !== evaluated.valueHash) {
        throw new RunReplayError(eventIndex, "result value hash does not match canonical value");
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "result",
        sourceNodeId: event.sourceNodeId,
        sourceAttempt: event.sourceAttempt,
        sourceField: event.sourceField,
        sourceHash: event.sourceHash,
        schemaDigest: event.schemaDigest,
        canonicalValue: event.canonicalValue,
        valueHash: event.valueHash,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_loop_checked": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "loop-check") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" is not a loop check`);
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireTerminalDependencies(requirement, nodes, eventIndex);
      const source = loopSourceObservation(requirement, nodes, eventIndex);
      if (source.truncated) {
        throw new RunReplayError(
          eventIndex,
          `loop check "${event.nodeId}" source evidence is truncated`,
        );
      }
      if (
        event.loopId !== requirement.loopCheck.loopId ||
        event.iteration !== requirement.loopCheck.iteration
      ) {
        throw new RunReplayError(
          eventIndex,
          "loop check identity does not match its control graph",
        );
      }
      if (event.sourceNodeId !== requirement.loopCheck.source.nodeId) {
        throw new RunReplayError(
          eventIndex,
          "loop check source node does not match its control graph",
        );
      }
      if (event.sourceAttempt !== source.attempt) {
        throw new RunReplayError(
          eventIndex,
          "loop check source attempt does not match durable evidence",
        );
      }
      if (event.sourceField !== requirement.loopCheck.source.field) {
        throw new RunReplayError(
          eventIndex,
          "loop check source field does not match its control graph",
        );
      }
      if (event.sourceHash !== source.hash) {
        throw new RunReplayError(
          eventIndex,
          "loop check source hash does not match durable evidence",
        );
      }
      const decision = source.value === requirement.loopCheck.equals ? "stop" : "continue";
      if (event.decision !== decision) {
        throw new RunReplayError(
          eventIndex,
          `loop check decision "${event.decision}" does not match durable source evidence`,
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "loop-check",
        loopId: event.loopId,
        iteration: event.iteration,
        sourceNodeId: event.sourceNodeId,
        sourceAttempt: event.sourceAttempt,
        sourceField: event.sourceField,
        sourceHash: event.sourceHash,
        decision: event.decision,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_loop_completed": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "loop") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" is not a loop controller`);
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireTerminalDependencies(requirement, nodes, eventIndex);
      const terminating = requirement.loop.checkNodeIds.find((checkNodeId) => {
        const control = nodes[checkNodeId]?.control;
        return control?.kind === "loop-check" && control.decision === "stop";
      });
      if (terminating === undefined) {
        throw new RunReplayError(
          eventIndex,
          `loop "${event.nodeId}" has no successful stop decision`,
        );
      }
      const terminatingControl = nodes[terminating]?.control;
      if (terminatingControl?.kind !== "loop-check") {
        throw new RunReplayError(eventIndex, "loop terminating check has no durable decision");
      }
      if (
        event.terminatingCheckNodeId !== terminating ||
        event.completedIterations !== terminatingControl.iteration
      ) {
        throw new RunReplayError(
          eventIndex,
          "loop completion does not match its first durable stop decision",
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "loop",
        completedIterations: event.completedIterations,
        terminatingCheckNodeId: event.terminatingCheckNodeId,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_omitted": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      const current = requireNode(nodes, event.nodeId, eventIndex);
      if (current.status !== "pending") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" must be pending before omission`,
        );
      }
      requireTerminalDependencies(requirement, nodes, eventIndex);

      let omission: NodeOmissionRunState;
      if (event.reason === "condition_not_selected") {
        if (
          requirement.type === "join" ||
          requirement.type === "loop-check" ||
          requirement.type === "loop" ||
          requirement.when === undefined
        ) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" has no condition guard to omit`,
          );
        }
        const guard = requirement.when;
        const decision = requireConditionDecision(nodes, guard.conditionId, eventIndex);
        if (
          event.conditionId !== guard.conditionId ||
          event.expectedCase !== guard.case ||
          event.selectedCase !== decision.selectedCase
        ) {
          throw new RunReplayError(
            eventIndex,
            "condition omission does not match the exact guard decision",
          );
        }
        if (decision.selectedCase === guard.case) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" guard selected case "${guard.case}" and cannot be omitted`,
          );
        }
        omission = deepFreeze({
          reason: event.reason,
          conditionId: event.conditionId,
          selectedCase: event.selectedCase,
          expectedCase: event.expectedCase,
        });
      } else if (event.reason === "loop_not_continued") {
        const guard = requirement.loopGuard;
        const instance = requirement.loopInstance;
        if (
          guard === undefined ||
          instance === undefined ||
          event.loopId !== guard.loopId ||
          event.iteration !== guard.iteration ||
          event.checkNodeId !== guard.checkNodeId ||
          instance.loopId !== guard.loopId ||
          instance.iteration !== guard.iteration
        ) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" loop omission does not match its exact loop guard`,
          );
        }
        const decision = requireLoopCheckDecision(nodes, guard.checkNodeId, eventIndex);
        if (decision.decision !== "stop") {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" prior loop check continued and cannot omit the iteration`,
          );
        }
        omission = deepFreeze({
          reason: event.reason,
          loopId: event.loopId,
          iteration: event.iteration,
          checkNodeId: event.checkNodeId,
        });
      } else if (event.reason === "optimization_stopped") {
        const guard = requirement.optimizationGuard;
        if (
          guard === undefined ||
          event.optimizationId !== guard.optimizationId ||
          event.candidate !== guard.candidate ||
          event.checkNodeId !== guard.checkNodeId
        ) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" optimization omission does not match its exact guard`,
          );
        }
        const prior = requireNode(nodes, guard.checkNodeId, eventIndex);
        if (
          prior.status !== "succeeded" ||
          prior.control?.kind !== "optimization-check" ||
          !prior.control.stop
        ) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" prior optimization check did not stop`,
          );
        }
        omission = deepFreeze({
          reason: event.reason,
          optimizationId: event.optimizationId,
          candidate: event.candidate,
          checkNodeId: event.checkNodeId,
        });
      } else {
        if (
          requirement.type !== "join" &&
          requirement.type !== "loop-check" &&
          requirement.type !== "loop" &&
          requirement.when !== undefined
        ) {
          const controllingCondition = requireNode(nodes, requirement.when.conditionId, eventIndex);
          if (controllingCondition.status !== "omitted") {
            const decision = requireConditionDecision(
              nodes,
              requirement.when.conditionId,
              eventIndex,
            );
            if (decision.selectedCase !== requirement.when.case) {
              throw new RunReplayError(
                eventIndex,
                `node "${event.nodeId}" must record its unselected condition guard before dependency omission`,
              );
            }
          }
        }
        const omittedDependencies = requirement.dependsOn.filter(
          (dependency) => nodes[dependency]?.status === "omitted",
        );
        if (omittedDependencies.length === 0) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" has no omitted declared dependencies`,
          );
        }
        if (!sameStrings(event.omittedDependencies, omittedDependencies)) {
          throw new RunReplayError(
            eventIndex,
            `node "${event.nodeId}" omission does not name its exact omitted dependencies`,
          );
        }
        omission = deepFreeze({
          reason: event.reason,
          omittedDependencies: Object.freeze([...event.omittedDependencies]),
        });
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "omitted",
        finishedAt: event.at,
        omission,
      });
      break;
    }
    case "node_joined": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "join") {
        throw new RunReplayError(eventIndex, `node "${event.nodeId}" is not a join control node`);
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireTerminalDependencies(requirement, nodes, eventIndex);
      const decision = requireConditionDecision(nodes, requirement.join.conditionId, eventIndex);
      if (event.conditionId !== requirement.join.conditionId) {
        throw new RunReplayError(eventIndex, "join condition does not match its control graph");
      }
      if (event.selectedCase !== decision.selectedCase) {
        throw new RunReplayError(
          eventIndex,
          "join selected case does not match its condition decision",
        );
      }
      const selectedBranch = requirement.join.branches.find(
        (branch) => branch.case === decision.selectedCase,
      );
      if (selectedBranch === undefined) {
        throw new RunReplayError(
          eventIndex,
          "join condition selected a case without a branch mapping",
        );
      }
      if (event.completedNodeId !== selectedBranch.nodeId) {
        throw new RunReplayError(
          eventIndex,
          "join completed terminal does not match its selected case",
        );
      }
      if (nodes[selectedBranch.nodeId]?.status !== "succeeded") {
        throw new RunReplayError(
          eventIndex,
          `join selected branch terminal "${selectedBranch.nodeId}" has not succeeded`,
        );
      }
      const omittedNodeIds = requirement.join.branches
        .filter((branch) => branch.case !== decision.selectedCase)
        .map((branch) => branch.nodeId);
      if (!sameStrings(event.omittedNodeIds, omittedNodeIds)) {
        throw new RunReplayError(
          eventIndex,
          "join omitted terminals do not match its unselected cases",
        );
      }
      if (omittedNodeIds.some((nodeId) => nodes[nodeId]?.status !== "omitted")) {
        throw new RunReplayError(
          eventIndex,
          "join cannot complete before every unselected terminal is omitted",
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "join",
        conditionId: event.conditionId,
        selectedCase: event.selectedCase,
        completedNodeId: event.completedNodeId,
        omittedNodeIds: Object.freeze([...event.omittedNodeIds]),
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_optimization_evaluated": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireOptimizationCheckRequirement(
        currentState,
        event.nodeId,
        eventIndex,
      );
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireTerminalDependencies(requirement, nodes, eventIndex);
      requireSelectedGuard(requirement, nodes, eventIndex);
      if (current.optimization !== null) {
        throw new RunReplayError(eventIndex, `optimization check "${event.nodeId}" is evaluated`);
      }
      const expected = expectedOptimizationEvaluation(currentState, requirement, nodes, eventIndex);
      validateOptimizationEvaluationEvent(event, expected, eventIndex);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        optimization: deepFreeze({
          optimizationId: event.optimizationId,
          candidate: event.candidate,
          candidateNodeId: event.candidateNodeId,
          baselineValueHash: event.baselineValueHash,
          baselineMetric: event.baselineMetric,
          baselineInvariants: structuredClone(event.baselineInvariants),
          bestValueHashBefore: event.bestValueHashBefore,
          bestMetricBefore: event.bestMetricBefore,
          candidateOutcome: event.candidateOutcome,
          candidateValueHash: event.candidateValueHash,
          candidateMetric: event.candidateMetric,
          candidateInvariants:
            event.candidateInvariants === null ? null : structuredClone(event.candidateInvariants),
          decision: event.decision,
          reason: event.reason,
          stagnation: event.stagnation,
          stop: event.stop,
          promotion: event.promotion === null ? null : structuredClone(event.promotion),
          deltaEntries: event.deltaEntries === null ? null : structuredClone(event.deltaEntries),
          evaluatedAt: event.at,
          preparedAt: null,
          settlement: null,
          cleanedAt: null,
        }),
      });
      break;
    }
    case "node_optimization_promotion_prepared": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireOptimizationCheckRequirement(
        currentState,
        event.nodeId,
        eventIndex,
      );
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      const optimization = requireOptimizationEvaluation(current, event.nodeId, eventIndex);
      requireOptimizationEventIdentity(requirement, optimization, event, eventIndex);
      if (optimization.decision !== "promote" || optimization.promotion === null) {
        throw new RunReplayError(eventIndex, "only an improving candidate can prepare promotion");
      }
      if (optimization.preparedAt !== null) {
        throw new RunReplayError(eventIndex, `optimization promotion is already prepared`);
      }
      if (!sameOptimizationPromotion(event.promotion, optimization.promotion)) {
        throw new RunReplayError(
          eventIndex,
          "optimization promotion prepare boundary does not match its evaluation",
        );
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        optimization: deepFreeze({ ...optimization, preparedAt: event.at }),
      });
      break;
    }
    case "node_optimization_promotion_settled": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireOptimizationCheckRequirement(
        currentState,
        event.nodeId,
        eventIndex,
      );
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      const optimization = requireOptimizationEvaluation(current, event.nodeId, eventIndex);
      requireOptimizationEventIdentity(requirement, optimization, event, eventIndex);
      if (optimization.preparedAt === null || optimization.promotion === null) {
        throw new RunReplayError(
          eventIndex,
          "optimization promotion must be prepared before settlement",
        );
      }
      if (optimization.settlement !== null) {
        throw new RunReplayError(eventIndex, "optimization promotion is already settled");
      }
      if (
        event.promotionId !== optimization.promotion.promotionId ||
        event.deltaDigest !== optimization.promotion.deltaDigest
      ) {
        throw new RunReplayError(eventIndex, "optimization settlement identity is invalid");
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        optimization: deepFreeze({
          ...optimization,
          settlement: {
            outcome: event.outcome,
            reason: event.reason,
            settledAt: event.at,
          } as OptimizationPromotionSettlement & { readonly settledAt: string },
        }),
      });
      break;
    }
    case "node_optimization_candidate_cleaned": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireOptimizationCheckRequirement(
        currentState,
        event.nodeId,
        eventIndex,
      );
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      const optimization = requireOptimizationEvaluation(current, event.nodeId, eventIndex);
      requireOptimizationEventIdentity(requirement, optimization, event, eventIndex);
      if (optimization.cleanedAt !== null) {
        throw new RunReplayError(eventIndex, "optimization candidate is already cleaned");
      }
      const candidate = requireOptimizationCandidateEvidence(requirement, nodes, eventIndex);
      if (
        event.candidateNodeId !== requirement.optimizationCheck.candidateNodeId ||
        event.workspaceId !== candidate.childRunId
      ) {
        throw new RunReplayError(eventIndex, "optimization cleanup workspace identity is invalid");
      }
      if (candidate.workspace.disposition !== "retained") {
        throw new RunReplayError(eventIndex, "optimization cleanup requires a retained workspace");
      }
      if (optimization.decision === "promote") {
        if (optimization.settlement === null || optimization.settlement.outcome === "unknown") {
          throw new RunReplayError(
            eventIndex,
            "optimization cleanup requires a conclusive promotion settlement",
          );
        }
        if (event.reason !== "promotion_settled") {
          throw new RunReplayError(eventIndex, "promoted candidate cleanup has an invalid reason");
        }
      } else if (event.reason !== "rejected") {
        throw new RunReplayError(eventIndex, "rejected candidate cleanup has an invalid reason");
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        optimization: deepFreeze({ ...optimization, cleanedAt: event.at }),
      });
      break;
    }
    case "node_optimization_checked": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireOptimizationCheckRequirement(
        currentState,
        event.nodeId,
        eventIndex,
      );
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      const optimization = requireOptimizationEvaluation(current, event.nodeId, eventIndex);
      requireOptimizationEventIdentity(requirement, optimization, event, eventIndex);
      const candidate = requireOptimizationCandidateEvidence(requirement, nodes, eventIndex);
      if (candidate.workspace.disposition === "retained" && optimization.cleanedAt === null) {
        throw new RunReplayError(
          eventIndex,
          "optimization candidate must be cleaned before check completion",
        );
      }
      const accepted =
        optimization.decision === "promote" && optimization.settlement?.outcome === "committed";
      if (optimization.decision === "promote" && optimization.settlement === null) {
        throw new RunReplayError(eventIndex, "optimization promotion has no durable settlement");
      }
      if (optimization.settlement?.outcome === "unknown") {
        throw new RunReplayError(eventIndex, "an uncertain promotion cannot complete its check");
      }
      const expectedBestValueHash = accepted
        ? optimization.candidateValueHash
        : optimization.bestValueHashBefore;
      const expectedBestMetric = accepted
        ? optimization.candidateMetric
        : optimization.bestMetricBefore;
      const previousBestCandidate = priorOptimizationBestCandidate(requirement, nodes, eventIndex);
      const expectedBestCandidate = accepted ? optimization.candidate : previousBestCandidate;
      if (
        expectedBestValueHash === null ||
        expectedBestMetric === null ||
        event.outcome !== (accepted ? "accepted" : "rejected") ||
        event.reason !== optimization.reason ||
        event.bestValueHash !== expectedBestValueHash ||
        event.bestMetric !== expectedBestMetric ||
        event.bestCandidate !== expectedBestCandidate ||
        event.stagnation !== optimization.stagnation ||
        event.stop !== optimization.stop
      ) {
        throw new RunReplayError(
          eventIndex,
          "optimization check summary contradicts its durable evaluation",
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "optimization-check",
        optimizationId: event.optimizationId,
        candidate: event.candidate,
        outcome: event.outcome,
        reason: event.reason,
        bestValueHash: event.bestValueHash,
        bestMetric: event.bestMetric,
        bestCandidate: event.bestCandidate,
        stagnation: event.stagnation,
        stop: event.stop,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: optimization.evaluatedAt,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_optimization_completed": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      if (requirement.type !== "optimization") {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" is not an optimization controller`,
        );
      }
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      requireTerminalDependencies(requirement, nodes, eventIndex);
      const completed = completedOptimizationChecks(requirement, nodes, eventIndex);
      const terminating = completed.at(-1);
      if (terminating === undefined) {
        throw new RunReplayError(eventIndex, "optimization controller has no completed candidate");
      }
      const stopped = terminating.control.stop;
      const expectedReason = stopped ? "stagnation" : "max_candidates";
      if (
        (!stopped && completed.length !== requirement.optimization.maxCandidates) ||
        event.completedCandidates !== completed.length ||
        event.terminatingCheckNodeId !== terminating.nodeId ||
        event.bestValueHash !== terminating.control.bestValueHash ||
        event.bestMetric !== terminating.control.bestMetric ||
        event.bestCandidate !== terminating.control.bestCandidate ||
        event.stopReason !== expectedReason
      ) {
        throw new RunReplayError(
          eventIndex,
          "optimization completion contradicts its durable checks",
        );
      }
      const control: NodeControlRunState = deepFreeze({
        kind: "optimization",
        completedCandidates: event.completedCandidates,
        terminatingCheckNodeId: event.terminatingCheckNodeId,
        bestValueHash: event.bestValueHash,
        bestMetric: event.bestMetric,
        bestCandidate: event.bestCandidate,
        stopReason: event.stopReason,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        control,
      });
      break;
    }
    case "node_control_failed": {
      requireRunningControlTransition(currentState, nodes, eventIndex);
      const requirement = requireControlGraphNode(currentState, event.nodeId, eventIndex);
      const current = requirePendingControlState(nodes, event.nodeId, event.attempt, eventIndex);
      if (requirement.type === "condition") {
        requireSucceededDependencies(requirement, nodes, eventIndex);
        requireSelectedGuard(requirement, nodes, eventIndex);
        const source = conditionSourceObservation(requirement, nodes, eventIndex);
        if (!source.truncated) {
          throw new RunReplayError(
            eventIndex,
            `condition "${event.nodeId}" source evidence is complete and cannot fail as truncated`,
          );
        }
        if (
          event.error.code !== "condition_source_truncated" ||
          event.error.retryable ||
          event.error.sideEffectStatus !== "none"
        ) {
          throw new RunReplayError(
            eventIndex,
            "condition source truncation requires a side-effect-free non-retryable control failure",
          );
        }
      } else if (requirement.type === "loop-check") {
        requireTerminalDependencies(requirement, nodes, eventIndex);
        const source = loopSourceObservation(requirement, nodes, eventIndex);
        if (!source.truncated) {
          throw new RunReplayError(
            eventIndex,
            `loop check "${event.nodeId}" source evidence is complete and cannot fail as truncated`,
          );
        }
        if (
          event.error.code !== "loop_source_truncated" ||
          event.error.retryable ||
          event.error.sideEffectStatus !== "none"
        ) {
          throw new RunReplayError(
            eventIndex,
            "loop source truncation requires a side-effect-free non-retryable control failure",
          );
        }
      } else if (requirement.type === "approval") {
        requireSucceededDependencies(requirement, nodes, eventIndex);
        requireSelectedGuard(requirement, nodes, eventIndex);
        const truncated = requirement.approval.evidence.find(
          (source) =>
            controlSourceObservation(requirement.nodeId, source, nodes, eventIndex).truncated,
        );
        if (truncated === undefined) {
          throw new RunReplayError(
            eventIndex,
            `workflow approval "${event.nodeId}" evidence is complete and cannot fail as truncated`,
          );
        }
        if (
          event.error.code !== "workflow_approval_evidence_truncated" ||
          event.error.message !==
            workflowApprovalEvidenceTruncationMessage(
              event.nodeId,
              truncated.nodeId,
              truncated.field,
            ) ||
          event.error.retryable ||
          event.error.sideEffectStatus !== "none"
        ) {
          throw new RunReplayError(
            eventIndex,
            "workflow approval evidence truncation requires the exact side-effect-free non-retryable control failure",
          );
        }
      } else if (requirement.type === "result") {
        requireSucceededDependencies(requirement, nodes, eventIndex);
        requireSelectedGuard(requirement, nodes, eventIndex);
        const source = controlSourceObservation(
          requirement.nodeId,
          requirement.result.source,
          nodes,
          eventIndex,
        );
        if (source.truncated) {
          if (
            event.error.code !== "result_source_truncated" ||
            event.error.message !==
              resultSourceTruncationMessage(event.nodeId, requirement.result.source.field) ||
            event.error.retryable ||
            event.error.sideEffectStatus !== "none"
          ) {
            throw new RunReplayError(
              eventIndex,
              "result source truncation requires the exact side-effect-free non-retryable control failure",
            );
          }
        } else {
          let validationError: TypedResultError | undefined;
          try {
            evaluateTypedResult(source.value, requirement.result.schema);
          } catch (error) {
            if (error instanceof TypedResultError) {
              validationError = error;
            } else {
              throw error;
            }
          }
          if (validationError === undefined) {
            throw new RunReplayError(
              eventIndex,
              `result "${event.nodeId}" source is valid and cannot record a control failure`,
            );
          }
          if (
            event.error.code !== validationError.code ||
            event.error.message !== validationError.message ||
            event.error.retryable ||
            event.error.sideEffectStatus !== "none"
          ) {
            throw new RunReplayError(
              eventIndex,
              "result validation failure classification does not match durable source evidence",
            );
          }
        }
      } else if (requirement.type === "optimization-check") {
        requireTerminalDependencies(requirement, nodes, eventIndex);
        requireSelectedGuard(requirement, nodes, eventIndex);
        const allowedCodes = new Set([
          "candidate_runtime_unavailable",
          "candidate_evaluation_failed",
          "candidate_delta_exists",
          "candidate_delta_limit_exceeded",
          "candidate_source_stale",
          "candidate_promotion_failed",
          "candidate_promotion_invalid",
          "candidate_promotion_missing",
          "candidate_promotion_rolled_back",
          "candidate_promotion_stale",
          "candidate_promotion_uncertain",
          "candidate_workspace_cleanup_failed",
        ]);
        const settlement = current.optimization?.settlement?.outcome;
        const expectedSideEffect =
          settlement === "committed"
            ? "committed"
            : settlement === "unknown" || event.error.code === "candidate_promotion_uncertain"
              ? "uncertain"
              : "none";
        if (
          !allowedCodes.has(event.error.code) ||
          event.error.retryable ||
          event.error.sideEffectStatus !== expectedSideEffect
        ) {
          throw new RunReplayError(
            eventIndex,
            "optimization failure has an invalid code, retry policy, or side-effect status",
          );
        }
      } else if (requirement.type === "loop") {
        requireTerminalDependencies(requirement, nodes, eventIndex);
        const allContinued = requirement.loop.checkNodeIds.every((checkNodeId) => {
          const control = nodes[checkNodeId]?.control;
          return control?.kind === "loop-check" && control.decision === "continue";
        });
        if (!allContinued) {
          throw new RunReplayError(
            eventIndex,
            `loop "${event.nodeId}" cannot exhaust before every check durably continues`,
          );
        }
        if (
          event.error.code !== "loop_limit_reached" ||
          event.error.message !==
            loopLimitFailureMessage(event.nodeId, requirement.loop.maxIterations) ||
          event.error.retryable ||
          event.error.sideEffectStatus !== "none"
        ) {
          throw new RunReplayError(
            eventIndex,
            "loop limit requires the exact side-effect-free non-retryable control failure",
          );
        }
      } else {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" cannot record a control failure`,
        );
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "failed",
        attempt: event.attempt,
        startedAt: event.at,
        finishedAt: event.at,
        error: deepFreeze(structuredClone(event.error)),
      });
      break;
    }
    case "node_effect_prepared": {
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      if (current.effectProtocol !== DURABLE_EFFECT_PROTOCOL) {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" attempt ${event.attempt} did not declare the durable effect protocol`,
        );
      }
      if (event.effectId !== nodeEffectId(event.sequence)) {
        throw new RunReplayError(eventIndex, "effect id does not match its prepare event sequence");
      }
      const expectedEffectSequence = current.effects.length + 1;
      if (event.effectSequence !== expectedEffectSequence) {
        throw new RunReplayError(
          eventIndex,
          `effect sequence ${event.effectSequence} does not match next effect sequence ${expectedEffectSequence}`,
        );
      }
      if (current.effects.length >= MAX_AGENT_EFFECT_RECEIPTS) {
        throw new RunReplayError(
          eventIndex,
          `node effect limit of ${MAX_AGENT_EFFECT_RECEIPTS} was exceeded`,
        );
      }
      const effect: NodeEffectRunState = deepFreeze({
        effectId: event.effectId,
        effectSequence: event.effectSequence,
        descriptor: structuredClone(event.descriptor),
        preparedAt: event.at,
        settlement: null,
        reconciliation: null,
      });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        effects: Object.freeze([...current.effects, effect]),
      });
      break;
    }
    case "node_effect_settled": {
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      if (current.effectProtocol !== DURABLE_EFFECT_PROTOCOL) {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" attempt ${event.attempt} did not declare the durable effect protocol`,
        );
      }
      const effectIndex = current.effects.findIndex((effect) => effect.effectId === event.effectId);
      const effect = current.effects[effectIndex];
      if (effect === undefined) {
        throw new RunReplayError(
          eventIndex,
          `effect settlement references unknown effect "${event.effectId}"`,
        );
      }
      if (effect.settlement !== null) {
        throw new RunReplayError(eventIndex, `effect "${event.effectId}" is already settled`);
      }
      if (effect.reconciliation !== null) {
        throw new RunReplayError(eventIndex, `effect "${event.effectId}" is already reconciled`);
      }
      const settlement: NodeEffectSettlement = deepFreeze({
        outcome: event.outcome,
        reason: event.reason,
        settledAt: event.at,
      } as NodeEffectSettlement);
      const effects = [...current.effects];
      effects[effectIndex] = Object.freeze({ ...effect, settlement });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        effects: Object.freeze(effects),
      });
      break;
    }
    case "node_effect_reconciled": {
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      if (current.effectProtocol !== DURABLE_EFFECT_PROTOCOL) {
        throw new RunReplayError(
          eventIndex,
          `node "${event.nodeId}" attempt ${event.attempt} did not declare the durable effect protocol`,
        );
      }
      const effectIndex = current.effects.findIndex((effect) => effect.effectId === event.effectId);
      const effect = current.effects[effectIndex];
      if (effect === undefined) {
        throw new RunReplayError(
          eventIndex,
          `effect reconciliation references unknown effect "${event.effectId}"`,
        );
      }
      if (effect.settlement !== null) {
        throw new RunReplayError(eventIndex, `effect "${event.effectId}" is already settled`);
      }
      if (effect.reconciliation !== null) {
        throw new RunReplayError(eventIndex, `effect "${event.effectId}" is already reconciled`);
      }
      validateEffectReconciliation(event, effect, eventIndex);
      const reconciliation: NodeEffectReconciliation = deepFreeze({
        outcome: event.outcome,
        reason: event.reason,
        ...(!("observedSha256" in event)
          ? {}
          : {
              observedSha256: event.observedSha256,
              observedMode: event.observedMode,
            }),
        reconciledAt: event.at,
      } as NodeEffectReconciliation);
      const effects = [...current.effects];
      effects[effectIndex] = Object.freeze({ ...effect, reconciliation });
      nodes[event.nodeId] = Object.freeze({
        ...current,
        effects: Object.freeze(effects),
      });
      break;
    }
    case "node_succeeded": {
      requireNextRunningOutcome(nodes, event.nodeId, eventIndex);
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      validateDurableEffectProjection(current, event.evidence, event, eventIndex);
      validateEvidenceIntegrity(event.evidence, event, eventIndex, current.effectProtocol === null);
      validateAgentCapabilityEvidenceProjection(
        currentState.capabilitySnapshot,
        currentState.capabilityRequirements[event.nodeId],
        event.evidence,
        eventIndex,
      );
      validateSucceededEvidence(event.evidence, eventIndex);
      validateVerifierEvidenceProjection(
        currentState.controlGraph,
        currentState.capabilitySnapshot,
        currentState.verifierPackageRequirements,
        nodes,
        event,
        event.evidence,
        eventIndex,
      );
      validateChildEvidenceProjection(
        currentState.controlGraph,
        nodes,
        event,
        event.evidence,
        eventIndex,
      );
      resources = addResourcesForEvidence(resources, event.evidence, eventIndex);
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "succeeded",
        finishedAt: event.at,
        evidence: deepFreeze(structuredClone(event.evidence)),
      });
      goal = applyCriterionDecision(
        goal,
        {
          runId: event.runId,
          nodeId: event.nodeId,
          attempt: event.attempt,
          at: event.at,
          outcome:
            event.evidence.kind === "command"
              ? "accepted"
              : event.evidence.kind === "verifier"
                ? event.evidence.verdict
                : "inconclusive",
          evidenceAvailable: true,
        },
        eventIndex,
      );
      break;
    }
    case "node_failed": {
      requireNextRunningOutcome(nodes, event.nodeId, eventIndex);
      const current = requireRunningAttempt(nodes, event.nodeId, event.attempt, eventIndex);
      validateDurableEffectProjection(current, event.evidence, event, eventIndex);
      if (event.evidence !== null) {
        validateEvidenceIntegrity(
          event.evidence,
          event,
          eventIndex,
          current.effectProtocol === null,
        );
        validateAgentCapabilityEvidenceProjection(
          currentState.capabilitySnapshot,
          currentState.capabilityRequirements[event.nodeId],
          event.evidence,
          eventIndex,
        );
      }
      validateVerifierEvidenceProjection(
        currentState.controlGraph,
        currentState.capabilitySnapshot,
        currentState.verifierPackageRequirements,
        nodes,
        event,
        event.evidence,
        eventIndex,
      );
      validateChildEvidenceProjection(
        currentState.controlGraph,
        nodes,
        event,
        event.evidence,
        eventIndex,
      );
      if (event.evidence !== null) {
        resources = addResourcesForEvidence(resources, event.evidence, eventIndex);
      }
      nodes[event.nodeId] = Object.freeze({
        ...current,
        status: "failed",
        finishedAt: event.at,
        evidence: event.evidence === null ? null : deepFreeze(structuredClone(event.evidence)),
        error: deepFreeze(structuredClone(event.error)),
      });
      goal = applyCriterionDecision(
        goal,
        {
          runId: event.runId,
          nodeId: event.nodeId,
          attempt: event.attempt,
          at: event.at,
          outcome: isConclusiveVerifierRejection(event.evidence) ? "rejected" : "inconclusive",
          evidenceAvailable: event.evidence !== null,
        },
        eventIndex,
      );
      break;
    }
    case "run_succeeded": {
      if (
        !Object.values(nodes).every(
          (node) => node.status === "succeeded" || node.status === "omitted",
        )
      ) {
        throw new RunReplayError(
          eventIndex,
          "run cannot succeed because not every node succeeded or was omitted",
        );
      }
      const blockingExhaustions =
        calculateRunBudgetState(currentState.budget?.limits, resources)?.exhausted.filter(
          (item) => item.dimension !== "nodeStarts",
        ) ?? [];
      if (blockingExhaustions.length > 0) {
        throw new RunReplayError(
          eventIndex,
          "run cannot succeed because a settled resource budget is exhausted",
        );
      }
      status = "succeeded";
      finishedAt = event.at;
      goal = applyGoalAcceptance(goal, eventIndex);
      break;
    }
    case "run_failed": {
      if (
        calculateRunBudgetState(currentState.budget?.limits, resources)?.exhausted.some(
          (item) => item.dimension !== "nodeStarts",
        ) === true
      ) {
        throw new RunReplayError(
          eventIndex,
          "run must record resource exhaustion instead of generic failure after its budget is exhausted",
        );
      }
      const failed = requireNode(nodes, event.failedNodeId, eventIndex);
      if (
        failed.status !== "failed" ||
        failedNodes.length === 0 ||
        failedNodes[0]?.[0] !== event.failedNodeId ||
        Object.values(nodes).some((node) => node.status === "running")
      ) {
        throw new RunReplayError(
          eventIndex,
          `failed node "${event.failedNodeId}" is not the deterministic primary failed node of a quiescent run`,
        );
      }
      status = "failed";
      finishedAt = event.at;
      failedNodeId = event.failedNodeId;
      failureReason = event.reason;
      goal = goal === null ? null : rejectIncompleteGoal(goal);
      break;
    }
    case "run_cancelled": {
      const exhausted =
        calculateRunBudgetState(currentState.budget?.limits, resources)?.exhausted ?? [];
      if (
        exhausted.some((item) => item.dimension !== "nodeStarts") ||
        (exhausted.some((item) => item.dimension === "nodeStarts") &&
          failedNodes.length === 0 &&
          Object.values(nodes).some((node) => node.status === "pending"))
      ) {
        throw new RunReplayError(
          eventIndex,
          "run must record resource exhaustion instead of cancellation after its budget is exhausted",
        );
      }
      if (Object.values(nodes).some((node) => node.status === "running")) {
        throw new RunReplayError(eventIndex, "run cannot cancel while a node remains running");
      }
      const failedNodeIds = failedNodes.map(([nodeId]) => nodeId);
      if (
        failedNodeIds.length === 0 &&
        (event.cancelledNodeId !== undefined || event.cancelledNodeIds !== undefined)
      ) {
        throw new RunReplayError(
          eventIndex,
          "cancellation names nodes even though no node settled as failed",
        );
      }
      if (
        failedNodeIds.length === 1 &&
        !(
          event.cancelledNodeId === failedNodeIds[0] ||
          sameStrings(event.cancelledNodeIds ?? [], failedNodeIds)
        )
      ) {
        throw new RunReplayError(eventIndex, "cancellation must identify its sole cancelled node");
      }
      if (failedNodeIds.length > 1 && !sameStrings(event.cancelledNodeIds ?? [], failedNodeIds)) {
        throw new RunReplayError(
          eventIndex,
          "cancellation failed-node projection does not match every failed node in declaration order",
        );
      }
      status = "cancelled";
      finishedAt = event.at;
      failedNodeId = failedNodeIds[0] ?? null;
      failureReason = event.reason;
      goal = goal === null ? null : rejectIncompleteGoal(goal);
      break;
    }
    case "run_budget_exhausted": {
      if (Object.values(nodes).some((node) => node.status === "running")) {
        throw new RunReplayError(eventIndex, "run budget cannot terminate while a node is running");
      }
      const budget = calculateRunBudgetState(currentState.budget?.limits, resources);
      if (budget === null || budget.exhausted.length === 0) {
        throw new RunReplayError(eventIndex, "run budget is not exhausted");
      }
      if (
        budget.exhausted.every((item) => item.dimension === "nodeStarts") &&
        (failedNodes.length > 0 ||
          Object.values(nodes).every((node) => node.status === "succeeded"))
      ) {
        throw new RunReplayError(
          eventIndex,
          "node-start exhaustion cannot replace an already determined failed or successful outcome",
        );
      }
      if (!sameBudgetExhaustions(event.exhausted, budget.exhausted)) {
        throw new RunReplayError(
          eventIndex,
          "run budget exhaustion does not match durable limits and consumption",
        );
      }
      status = "resource_exhausted";
      finishedAt = event.at;
      failureReason = budgetExhaustionReason(event.exhausted);
      goal = goal === null ? null : rejectIncompleteGoal(goal);
      break;
    }
  }

  const budget = calculateRunBudgetState(currentState.budget?.limits, resources);
  return freezeRunState({
    runId: currentState.runId,
    workflowId: currentState.workflowId,
    workflowApiVersion: currentState.workflowApiVersion,
    workflowDigest: currentState.workflowDigest,
    capabilitySnapshot: currentState.capabilitySnapshot,
    capabilityRequirements: currentState.capabilityRequirements,
    verifierPackageRequirements: currentState.verifierPackageRequirements,
    executionCwd: currentState.executionCwd,
    executionWorkspace: currentState.executionWorkspace,
    approvalRequirements: currentState.approvalRequirements,
    recoveryRequirements: currentState.recoveryRequirements,
    controlGraph: currentState.controlGraph,
    concurrency: currentState.concurrency,
    resources,
    budget,
    status,
    startedAt: currentState.startedAt,
    finishedAt,
    lastSequence: event.sequence,
    failedNodeId,
    failureReason,
    goal,
    nodes,
  });
}

function applyCriterionDecision(
  goal: GoalRunState | null,
  input: Parameters<typeof recordCriterionDecision>[1],
  eventIndex: number,
): GoalRunState | null {
  if (goal === null) {
    return null;
  }
  try {
    return recordCriterionDecision(goal, input);
  } catch (error) {
    throw goalReplayError(error, eventIndex);
  }
}

function applyGoalAcceptance(goal: GoalRunState | null, eventIndex: number): GoalRunState | null {
  if (goal === null) {
    return null;
  }
  try {
    return acceptGoal(goal);
  } catch (error) {
    throw goalReplayError(error, eventIndex);
  }
}

function goalReplayError(error: unknown, eventIndex: number): RunReplayError {
  const message = error instanceof Error ? error.message : String(error);
  return new RunReplayError(
    eventIndex,
    error instanceof GoalEvaluationError ? message : `goal evaluation failed: ${message}`,
  );
}

function isConclusiveVerifierRejection(evidence: NodeEvidence | null): boolean {
  if (evidence?.kind === "verifier") {
    return evidence.verdict === "rejected";
  }
  return (
    evidence?.kind === "command" &&
    evidence.exitCode !== null &&
    evidence.exitCode !== 0 &&
    evidence.signal === null &&
    !evidence.timedOut
  );
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "resource_exhausted"
  );
}

function approvalStateFromRequest(event: CommandApprovalRequestedEvent): CommandApprovalRunState {
  return deepFreeze({
    status: "pending",
    requestId: event.requestId,
    attempt: event.attempt,
    requestedAt: event.at,
    grantTtlMs: event.grantTtlMs,
    operation: structuredClone(event.operation),
    operationDigest: event.operationDigest,
    decidedAt: null,
    actor: null,
    reason: null,
    expiresAt: null,
    expiredAt: null,
    consumedAt: null,
  });
}

function workflowApprovalStateFromRequest(
  event: WorkflowApprovalRequestedEvent,
): WorkflowApprovalRunState {
  return deepFreeze({
    status: "pending",
    requestId: event.requestId,
    attempt: event.attempt,
    requestedAt: event.at,
    request: structuredClone(event.request),
    requestDigest: event.requestDigest,
    decidedAt: null,
    actor: null,
    reason: null,
  });
}

type WorkflowApprovalIdentityEvent = WorkflowApprovalApprovedEvent | WorkflowApprovalDeniedEvent;

function requirePendingWorkflowApproval(
  node: NodeRunState,
  event: WorkflowApprovalIdentityEvent,
  eventIndex: number,
): WorkflowApprovalRunState {
  if (node.status !== "pending" || node.workflowApproval?.status !== "pending") {
    throw new RunReplayError(
      eventIndex,
      "workflow approval request must be pending before decision",
    );
  }
  if (
    event.requestId !== node.workflowApproval.requestId ||
    event.attempt !== node.workflowApproval.attempt ||
    event.requestDigest !== node.workflowApproval.requestDigest
  ) {
    throw new RunReplayError(
      eventIndex,
      "workflow approval decision does not match the current exact request",
    );
  }
  return node.workflowApproval;
}

type ApprovalIdentityEvent =
  | CommandApprovalGrantedEvent
  | CommandApprovalDeniedEvent
  | CommandApprovalExpiredEvent;

function requirePendingApproval(
  node: NodeRunState,
  event: ApprovalIdentityEvent,
  eventIndex: number,
): CommandApprovalRunState {
  if (node.status !== "pending" || node.approval?.status !== "pending") {
    throw new RunReplayError(
      eventIndex,
      "command approval request must be pending before decision",
    );
  }
  validateApprovalIdentity(node.approval, event, eventIndex);
  return node.approval;
}

function requireGrantedApproval(
  node: NodeRunState,
  event: ApprovalIdentityEvent,
  eventIndex: number,
): CommandApprovalRunState {
  if (node.status !== "pending" || node.approval?.status !== "granted") {
    throw new RunReplayError(eventIndex, "command approval request must be granted before expiry");
  }
  validateApprovalIdentity(node.approval, event, eventIndex);
  return node.approval;
}

function validateApprovalIdentity(
  approval: CommandApprovalRunState,
  event: ApprovalIdentityEvent,
  eventIndex: number,
): void {
  if (
    event.requestId !== approval.requestId ||
    event.attempt !== approval.attempt ||
    event.operationDigest !== approval.operationDigest
  ) {
    throw new RunReplayError(
      eventIndex,
      "approval decision does not match the current exact request",
    );
  }
}

function approvalDenialMessage(actor: string, reason: string | undefined): string {
  return `command approval denied by ${actor}${reason === undefined ? "" : `: ${reason}`}`;
}

function freezeRunState(state: RunState): RunState {
  return Object.freeze({ ...state, nodes: Object.freeze({ ...state.nodes }) });
}

function validateControlGraph(
  input: ControlGraph,
  nodeIds: readonly string[],
  eventIndex: number,
): ControlGraph {
  const graph = structuredClone(input);
  if (
    !sameStrings(
      graph.nodes.map((node) => node.nodeId),
      nodeIds,
    )
  ) {
    throw new RunReplayError(
      eventIndex,
      "control graph nodes must exactly match ordered run node ids",
    );
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  for (const node of graph.nodes) {
    if (new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new RunReplayError(
        eventIndex,
        `control graph node "${node.nodeId}" has duplicate dependencies`,
      );
    }
    for (const dependency of node.dependsOn) {
      if (dependency === node.nodeId || !nodeById.has(dependency)) {
        throw new RunReplayError(
          eventIndex,
          `control graph node "${node.nodeId}" has invalid dependency "${dependency}"`,
        );
      }
    }
    if (
      node.type !== "join" &&
      node.type !== "loop-check" &&
      node.type !== "loop" &&
      node.type !== "optimization-check" &&
      node.type !== "optimization" &&
      node.when !== undefined
    ) {
      const condition = nodeById.get(node.when.conditionId);
      if (
        condition?.type !== "condition" ||
        !node.dependsOn.includes(condition.nodeId) ||
        !controlConditionCases(condition).includes(node.when.case)
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph node "${node.nodeId}" has an invalid condition guard`,
        );
      }
    }
    if (node.type === "condition") {
      const source = nodeById.get(node.condition.source.nodeId);
      const compatible = controlEvidenceFieldMatchesNode(node.condition.source.field, source?.type);
      if (!node.dependsOn.includes(node.condition.source.nodeId) || !compatible) {
        throw new RunReplayError(
          eventIndex,
          `control graph condition "${node.nodeId}" has an invalid source`,
        );
      }
    }
    if (node.type === "approval") {
      for (const evidence of node.approval.evidence) {
        const source = nodeById.get(evidence.nodeId);
        const compatible = controlEvidenceFieldMatchesNode(evidence.field, source?.type);
        if (!node.dependsOn.includes(evidence.nodeId) || !compatible) {
          throw new RunReplayError(
            eventIndex,
            `control graph approval "${node.nodeId}" has an invalid evidence source`,
          );
        }
      }
    }
    if (node.type === "verifier" && node.verifier.kind === "model") {
      for (const evidence of node.verifier.evidence) {
        const source = nodeById.get(evidence.nodeId);
        if (
          !node.dependsOn.includes(evidence.nodeId) ||
          !controlEvidenceFieldMatchesNode(evidence.field, source?.type)
        ) {
          throw new RunReplayError(
            eventIndex,
            `control graph verifier "${node.nodeId}" has an invalid evidence source`,
          );
        }
      }
    }
    if (node.type === "result") {
      const source = nodeById.get(node.result.source.nodeId);
      if (
        !node.dependsOn.includes(node.result.source.nodeId) ||
        !controlEvidenceFieldMatchesNode(node.result.source.field, source?.type)
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph result "${node.nodeId}" has an invalid source`,
        );
      }
      if (node.result.schemaDigest !== calculateResultSchemaDigest(node.result.schema)) {
        throw new RunReplayError(
          eventIndex,
          `control graph result "${node.nodeId}" has an invalid schema digest`,
        );
      }
    }
    if (node.type === "join") {
      const condition = nodeById.get(node.join.conditionId);
      if (condition?.type !== "condition") {
        throw new RunReplayError(
          eventIndex,
          `control graph join "${node.nodeId}" has an invalid condition`,
        );
      }
      const branchNodeIds = node.join.branches.map((branch) => branch.nodeId);
      if (!sameStrings(node.dependsOn, branchNodeIds)) {
        throw new RunReplayError(
          eventIndex,
          `control graph join "${node.nodeId}" dependencies do not match its branches`,
        );
      }
      const expectedCases = controlConditionCases(condition);
      const actualCases = node.join.branches.map((branch) => branch.case);
      if (
        actualCases.length !== expectedCases.length ||
        new Set(actualCases).size !== actualCases.length ||
        expectedCases.some((caseId) => !actualCases.includes(caseId))
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph join "${node.nodeId}" does not cover every condition case`,
        );
      }
    }
    if (node.loopInstance !== undefined) {
      const loop = nodeById.get(node.loopInstance.loopId);
      if (loop?.type !== "loop" || node.type === "loop" || node.type === "loop-check") {
        throw new RunReplayError(
          eventIndex,
          `control graph node "${node.nodeId}" has invalid loop instance metadata`,
        );
      }
      if (node.loopInstance.iteration > loop.loop.maxIterations) {
        throw new RunReplayError(
          eventIndex,
          `control graph node "${node.nodeId}" loop iteration is outside its controller bound`,
        );
      }
    }
    if (node.loopGuard !== undefined) {
      const check = nodeById.get(node.loopGuard.checkNodeId);
      if (
        node.loopInstance === undefined ||
        node.loopGuard.loopId !== node.loopInstance.loopId ||
        node.loopGuard.iteration !== node.loopInstance.iteration ||
        node.loopGuard.iteration <= 1 ||
        !node.dependsOn.includes(node.loopGuard.checkNodeId) ||
        check?.type !== "loop-check" ||
        check.loopCheck.loopId !== node.loopGuard.loopId ||
        check.loopCheck.iteration !== node.loopGuard.iteration - 1
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph node "${node.nodeId}" has an invalid loop guard`,
        );
      }
    }
    if (node.type === "loop-check") {
      const source = nodeById.get(node.loopCheck.source.nodeId);
      const loop = nodeById.get(node.loopCheck.loopId);
      const compatible = controlEvidenceFieldMatchesNode(node.loopCheck.source.field, source?.type);
      if (
        loop?.type !== "loop" ||
        !node.dependsOn.includes(node.loopCheck.source.nodeId) ||
        !compatible
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop check "${node.nodeId}" has an invalid source or controller`,
        );
      }
      if (loop.loop.checkNodeIds[node.loopCheck.iteration - 1] !== node.nodeId) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop check "${node.nodeId}" is not registered by its controller`,
        );
      }
      if (
        source?.loopInstance?.loopId !== node.loopCheck.loopId ||
        source.loopInstance.iteration !== node.loopCheck.iteration
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop check "${node.nodeId}" source must belong to the same loop iteration`,
        );
      }
    }
    if (node.type === "loop") {
      if (
        node.loop.maxIterations !== node.loop.checkNodeIds.length ||
        !sameStrings(node.dependsOn, node.loop.checkNodeIds)
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${node.nodeId}" does not match its ordered checks`,
        );
      }
      for (const [index, checkNodeId] of node.loop.checkNodeIds.entries()) {
        const check = nodeById.get(checkNodeId);
        if (
          check?.type !== "loop-check" ||
          check.loopCheck.loopId !== node.nodeId ||
          check.loopCheck.iteration !== index + 1
        ) {
          throw new RunReplayError(
            eventIndex,
            `control graph loop "${node.nodeId}" has an invalid check sequence`,
          );
        }
      }
    }
  }

  const entryCount = graph.nodes.filter((node) => node.dependsOn.length === 0).length;
  if (entryCount !== 1) {
    throw new RunReplayError(
      eventIndex,
      `control graph must contain exactly one entry node; found ${entryCount}`,
    );
  }
  if (controlGraphHasCycle(graph.nodes)) {
    throw new RunReplayError(eventIndex, "control graph contains a dependency cycle");
  }
  validateControlGraphLoopInstances(graph.nodes, nodeById, eventIndex);
  validateControlGraphOptimizations(graph.nodes, nodeById, eventIndex);
  const dependedUpon = new Set(graph.nodes.flatMap((node) => node.dependsOn));
  const invalidTerminal = graph.nodes.find(
    (node) =>
      !dependedUpon.has(node.nodeId) &&
      node.type !== "command" &&
      node.type !== "verifier" &&
      node.type !== "result" &&
      node.type !== "child" &&
      node.type !== "optimization",
  );
  if (invalidTerminal !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `control graph terminal "${invalidTerminal.nodeId}" must be a command, child, verifier, or result node`,
    );
  }
  for (const condition of graph.nodes.filter(
    (node): node is ControlGraphConditionNode => node.type === "condition",
  )) {
    const joins = graph.nodes.filter(
      (node): node is ControlGraphJoinNode =>
        node.type === "join" && node.join.conditionId === condition.nodeId,
    );
    if (joins.length !== 1) {
      throw new RunReplayError(
        eventIndex,
        `control graph condition "${condition.nodeId}" must have exactly one join`,
      );
    }
    validateControlGraphBranches(graph.nodes, condition, joins[0], eventIndex);
  }
  return deepFreeze(graph);
}

function validateControlGraphLoopInstances(
  nodes: readonly ControlGraphNode[],
  nodeById: ReadonlyMap<string, ControlGraphNode>,
  eventIndex: number,
): void {
  for (const loop of nodes.filter((node): node is ControlGraphLoopNode => node.type === "loop")) {
    let expectedTemplates: readonly string[] | undefined;
    let expectedTemplateStructures: readonly string[] | undefined;
    let expectedStopContract: string | undefined;
    for (let iteration = 1; iteration <= loop.loop.maxIterations; iteration += 1) {
      const instances = nodes.filter(
        (node) =>
          node.loopInstance?.loopId === loop.nodeId && node.loopInstance.iteration === iteration,
      );
      const templates = instances.map((node) => node.loopInstance?.templateNodeId ?? "");
      if (instances.length === 0 || new Set(templates).size !== templates.length) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} has invalid template instances`,
        );
      }
      if (expectedTemplates === undefined) {
        expectedTemplates = templates;
      } else if (!sameStrings(templates, expectedTemplates)) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} does not clone the same templates`,
        );
      }
      const templateIdByNodeId = new Map(
        instances.map((node) => [node.nodeId, node.loopInstance?.templateNodeId ?? ""]),
      );
      const templateStructures = instances.map((node) =>
        serializeLoopTemplateStructure(node, templateIdByNodeId),
      );
      if (expectedTemplateStructures === undefined) {
        expectedTemplateStructures = templateStructures;
      } else if (!sameStrings(templateStructures, expectedTemplateStructures)) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} does not clone the same template structure`,
        );
      }

      const instanceIds = new Set(instances.map((node) => node.nodeId));
      const entries = instances.filter(
        (node) => !node.dependsOn.some((dependency) => instanceIds.has(dependency)),
      );
      if (entries.length !== 1) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} must have exactly one entry`,
        );
      }
      const entry = entries[0];
      if (entry === undefined) {
        throw new RunReplayError(eventIndex, "loop entry validation invariant failed");
      }

      if (iteration === 1) {
        if (instances.some((node) => node.loopGuard !== undefined)) {
          throw new RunReplayError(
            eventIndex,
            `control graph loop "${loop.nodeId}" first iteration cannot have a prior-check guard`,
          );
        }
      } else {
        const priorCheckNodeId = loop.loop.checkNodeIds[iteration - 2];
        const guarded = instances.filter((node) => node.loopGuard !== undefined);
        if (
          priorCheckNodeId === undefined ||
          guarded.length !== 1 ||
          guarded[0]?.nodeId !== entry.nodeId ||
          entry.loopGuard?.checkNodeId !== priorCheckNodeId ||
          !sameStrings(entry.dependsOn, [priorCheckNodeId])
        ) {
          throw new RunReplayError(
            eventIndex,
            `control graph loop "${loop.nodeId}" iteration ${iteration} must have exactly one prior-check-guarded entry`,
          );
        }
      }

      const nonEntryWithExternalDependency = instances.find(
        (node) =>
          node.nodeId !== entry.nodeId &&
          node.dependsOn.some((dependency) => !instanceIds.has(dependency)),
      );
      if (nonEntryWithExternalDependency !== undefined) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop instance "${nonEntryWithExternalDependency.nodeId}" has a cross-iteration dependency`,
        );
      }

      const checkNodeId = loop.loop.checkNodeIds[iteration - 1];
      const check = checkNodeId === undefined ? undefined : nodeById.get(checkNodeId);
      if (check?.type !== "loop-check") {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} has no matching check`,
        );
      }
      const checkSource = nodeById.get(check.loopCheck.source.nodeId);
      const stopContract = JSON.stringify({
        sourceTemplateNodeId:
          checkSource?.loopInstance?.templateNodeId ?? check.loopCheck.source.nodeId,
        field: check.loopCheck.source.field,
        equals: check.loopCheck.equals,
      });
      if (expectedStopContract === undefined) {
        expectedStopContract = stopContract;
      } else if (stopContract !== expectedStopContract) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop "${loop.nodeId}" iteration ${iteration} changes its stop contract`,
        );
      }
      const terminalIds = instances
        .filter((candidate) => !instances.some((node) => node.dependsOn.includes(candidate.nodeId)))
        .map((node) => node.nodeId);
      const expectedCheckDependencies = terminalIds.includes(check.loopCheck.source.nodeId)
        ? terminalIds
        : [...terminalIds, check.loopCheck.source.nodeId];
      if (!sameStrings(check.dependsOn, expectedCheckDependencies)) {
        throw new RunReplayError(
          eventIndex,
          `control graph loop check "${check.nodeId}" must wait for every iteration terminal and its source`,
        );
      }
    }
  }
}

function validateControlGraphOptimizations(
  nodes: readonly ControlGraphNode[],
  nodeById: ReadonlyMap<string, ControlGraphNode>,
  eventIndex: number,
): void {
  const controllers = nodes.filter(
    (node): node is ControlGraphOptimizationNode => node.type === "optimization",
  );
  const registeredCandidateIds = new Set<string>();
  const registeredCheckIds = new Set<string>();

  for (const controller of controllers) {
    const contract = controller.optimization;
    if (
      contract.candidateNodeIds.length !== contract.maxCandidates ||
      contract.checkNodeIds.length !== contract.maxCandidates ||
      new Set(contract.candidateNodeIds).size !== contract.candidateNodeIds.length ||
      new Set(contract.checkNodeIds).size !== contract.checkNodeIds.length ||
      contract.maxConsecutiveNonImproving > contract.maxCandidates ||
      !sameStrings(controller.dependsOn, contract.checkNodeIds)
    ) {
      throw new RunReplayError(
        eventIndex,
        `control graph optimization "${controller.nodeId}" has inconsistent bounds or registrations`,
      );
    }

    const baseline = nodeById.get(contract.baseline.nodeId);
    if (
      baseline?.type !== "result" ||
      baseline.result.schemaDigest !== contract.baselineSchemaDigest ||
      baseline.result.schemaDigest !== calculateResultSchemaDigest(baseline.result.schema)
    ) {
      throw new RunReplayError(
        eventIndex,
        `control graph optimization "${controller.nodeId}" has an invalid baseline schema`,
      );
    }
    validateControlOptimizationPointers(controller, baseline.result.schema, eventIndex);

    for (let candidate = 1; candidate <= contract.maxCandidates; candidate += 1) {
      const candidateNodeId = contract.candidateNodeIds[candidate - 1];
      const checkNodeId = contract.checkNodeIds[candidate - 1];
      const priorCheckNodeId = candidate === 1 ? undefined : contract.checkNodeIds[candidate - 2];
      const candidateNode =
        candidateNodeId === undefined ? undefined : nodeById.get(candidateNodeId);
      const checkNode = checkNodeId === undefined ? undefined : nodeById.get(checkNodeId);
      if (
        candidateNode?.type !== "child" ||
        candidateNode.optimizationCandidate?.optimizationId !== controller.nodeId ||
        candidateNode.optimizationCandidate.candidate !== candidate ||
        candidateNode.optimizationCandidate.checkNodeId !== checkNodeId ||
        candidateNode.child.resultSchemaDigest !== contract.baselineSchemaDigest
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph optimization "${controller.nodeId}" candidate ${candidate} is invalid`,
        );
      }
      if (
        checkNode?.type !== "optimization-check" ||
        checkNode.optimizationCheck.optimizationId !== controller.nodeId ||
        checkNode.optimizationCheck.candidate !== candidate ||
        checkNode.optimizationCheck.candidateNodeId !== candidateNodeId ||
        checkNode.optimizationCheck.priorCheckNodeId !== priorCheckNodeId ||
        !sameStrings(checkNode.dependsOn, [candidateNodeId]) ||
        !sameOptimizationCheckContract(checkNode, controller)
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph optimization "${controller.nodeId}" check ${candidate} is invalid`,
        );
      }

      if (candidate === 1) {
        if (
          candidateNode.optimizationGuard !== undefined ||
          checkNode.optimizationGuard !== undefined ||
          !candidateNode.dependsOn.includes(contract.baseline.nodeId)
        ) {
          throw new RunReplayError(
            eventIndex,
            `control graph optimization "${controller.nodeId}" first candidate has an invalid entry`,
          );
        }
      } else if (
        priorCheckNodeId === undefined ||
        !sameOptimizationGuard(
          candidateNode.optimizationGuard,
          controller.nodeId,
          candidate,
          priorCheckNodeId,
        ) ||
        !sameOptimizationGuard(
          checkNode.optimizationGuard,
          controller.nodeId,
          candidate,
          priorCheckNodeId,
        ) ||
        !sameStrings(candidateNode.dependsOn, [priorCheckNodeId])
      ) {
        throw new RunReplayError(
          eventIndex,
          `control graph optimization "${controller.nodeId}" candidate ${candidate} has an invalid prior-check guard`,
        );
      }
      registeredCandidateIds.add(candidateNode.nodeId);
      registeredCheckIds.add(checkNode.nodeId);
    }
  }

  for (const node of nodes) {
    if (node.type === "child" && node.optimizationCandidate !== undefined) {
      if (!registeredCandidateIds.has(node.nodeId)) {
        throw new RunReplayError(
          eventIndex,
          `control graph candidate child "${node.nodeId}" is not registered by an optimization`,
        );
      }
    } else if (node.type === "optimization-check") {
      if (!registeredCheckIds.has(node.nodeId)) {
        throw new RunReplayError(
          eventIndex,
          `control graph optimization check "${node.nodeId}" is not registered by an optimization`,
        );
      }
    } else if (node.optimizationGuard !== undefined) {
      throw new RunReplayError(
        eventIndex,
        `control graph node "${node.nodeId}" has optimization guard metadata outside a candidate sequence`,
      );
    }
  }
}

function validateControlOptimizationPointers(
  controller: ControlGraphOptimizationNode,
  schema: CompiledResultSchema,
  eventIndex: number,
): void {
  try {
    const metricSchema = resolveOptimizationPointerSchema(
      schema,
      controller.optimization.metric.pointer,
    );
    if (metricSchema.type !== "number" && metricSchema.type !== "integer") {
      throw new RunReplayError(
        eventIndex,
        `control graph optimization "${controller.nodeId}" metric is not numeric`,
      );
    }
    for (const invariant of controller.optimization.invariants) {
      const invariantSchema = resolveOptimizationPointerSchema(schema, invariant.pointer);
      if (invariantSchema.type === "array" || invariantSchema.type === "object") {
        throw new RunReplayError(
          eventIndex,
          `control graph optimization "${controller.nodeId}" invariant is not scalar`,
        );
      }
      evaluateTypedResult(JSON.stringify(invariant.equals), invariantSchema);
    }
  } catch (error) {
    if (error instanceof RunReplayError) {
      throw error;
    }
    if (error instanceof OptimizationResultError || error instanceof TypedResultError) {
      throw new RunReplayError(
        eventIndex,
        `control graph optimization "${controller.nodeId}" has an invalid metric or invariant contract`,
      );
    }
    throw error;
  }
}

function sameOptimizationCheckContract(
  check: ControlGraphOptimizationCheckNode,
  controller: ControlGraphOptimizationNode,
): boolean {
  const checkContract = check.optimizationCheck;
  const controllerContract = controller.optimization;
  return (
    JSON.stringify(checkContract.baseline) === JSON.stringify(controllerContract.baseline) &&
    JSON.stringify(checkContract.metric) === JSON.stringify(controllerContract.metric) &&
    JSON.stringify(checkContract.invariants) === JSON.stringify(controllerContract.invariants) &&
    checkContract.maxConsecutiveNonImproving === controllerContract.maxConsecutiveNonImproving &&
    checkContract.rollback === controllerContract.rollback
  );
}

function sameOptimizationGuard(
  guard: ControlOptimizationGuard | undefined,
  optimizationId: string,
  candidate: number,
  checkNodeId: string,
): boolean {
  return (
    guard?.optimizationId === optimizationId &&
    guard.candidate === candidate &&
    guard.checkNodeId === checkNodeId
  );
}

function serializeLoopTemplateStructure(
  node: ControlGraphNode,
  templateIdByNodeId: ReadonlyMap<string, string>,
): string {
  const templateNodeId = (nodeId: string): string => templateIdByNodeId.get(nodeId) ?? nodeId;
  const internalDependencies = node.dependsOn.flatMap((nodeId) => {
    const templateId = templateIdByNodeId.get(nodeId);
    return templateId === undefined ? [] : [templateId];
  });
  const common = {
    templateNodeId: node.loopInstance?.templateNodeId,
    type: node.type,
    dependsOn: internalDependencies,
  };
  if (node.type === "command" || node.type === "agent") {
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
    });
  }
  if (node.type === "child") {
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
      child: node.child,
    });
  }
  if (node.type === "verifier") {
    const verifier =
      node.verifier.kind === "command" || node.verifier.kind === "packaged-command"
        ? node.verifier
        : {
            ...node.verifier,
            evidence: node.verifier.evidence.map((source) => ({
              nodeId: templateNodeId(source.nodeId),
              field: source.field,
            })),
          };
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
      verifier,
    });
  }
  if (node.type === "approval") {
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
      approval: {
        prompt: node.approval.prompt,
        evidence: node.approval.evidence.map((source) => ({
          nodeId: templateNodeId(source.nodeId),
          field: source.field,
        })),
      },
    });
  }
  if (node.type === "result") {
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
      result: {
        source: {
          nodeId: templateNodeId(node.result.source.nodeId),
          field: node.result.source.field,
        },
        schema: node.result.schema,
        schemaDigest: node.result.schemaDigest,
      },
    });
  }
  if (node.type === "condition") {
    return JSON.stringify({
      ...common,
      ...(node.when === undefined
        ? {}
        : {
            when: {
              conditionId: templateNodeId(node.when.conditionId),
              case: node.when.case,
            },
          }),
      condition: {
        source: {
          nodeId: templateNodeId(node.condition.source.nodeId),
          field: node.condition.source.field,
        },
        cases: node.condition.cases,
        default: node.condition.default,
      },
    });
  }
  if (node.type === "join") {
    return JSON.stringify({
      ...common,
      join: {
        conditionId: templateNodeId(node.join.conditionId),
        branches: node.join.branches.map((branch) => ({
          case: branch.case,
          nodeId: templateNodeId(branch.nodeId),
        })),
      },
    });
  }
  return JSON.stringify(common);
}

function controlConditionCases(condition: ControlGraphConditionNode): readonly string[] {
  return [...condition.condition.cases.map((item) => item.id), condition.condition.default];
}

function controlEvidenceFieldMatchesNode(
  field: EvidenceSourceField,
  nodeType: ControlGraphNode["type"] | undefined,
): boolean {
  return (
    (field.startsWith("command.") && nodeType === "command") ||
    (field === "agent.text" && nodeType === "agent") ||
    (field.startsWith("verifier.") && nodeType === "verifier") ||
    (field === "result.value" && (nodeType === "result" || nodeType === "child"))
  );
}

function controlGraphHasCycle(nodes: readonly ControlGraphNode[]): boolean {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(nodeId: string): boolean {
    if (visiting.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    const node = nodeById.get(nodeId);
    if (node === undefined) {
      return false;
    }
    visiting.add(nodeId);
    const cyclic = node.dependsOn.some(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
    return cyclic;
  }

  return nodes.some((node) => visit(node.nodeId));
}

function validateControlGraphBranches(
  nodes: readonly ControlGraphNode[],
  condition: ControlGraphConditionNode,
  join: ControlGraphJoinNode | undefined,
  eventIndex: number,
): void {
  const cases = controlConditionCases(condition);
  for (const caseId of cases) {
    const hasBranch = nodes.some(
      (node) =>
        node.type !== "join" &&
        node.type !== "loop-check" &&
        node.type !== "loop" &&
        node.when?.conditionId === condition.nodeId &&
        node.when.case === caseId,
    );
    if (!hasBranch) {
      throw new RunReplayError(
        eventIndex,
        `control graph condition "${condition.nodeId}" case "${caseId}" has no guarded branch`,
      );
    }
  }
  if (join === undefined) {
    return;
  }

  const membership = controlGraphBranchMembership(nodes, condition.nodeId);
  const crossCaseNode = [...membership.entries()].find(([, value]) => value === "cross");
  if (crossCaseNode !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `control graph node "${crossCaseNode[0]}" depends across cases of condition "${condition.nodeId}"`,
    );
  }
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  for (const branch of join.join.branches) {
    if (membership.get(branch.nodeId) !== branch.case) {
      throw new RunReplayError(
        eventIndex,
        `control graph join "${join.nodeId}" branch "${branch.nodeId}" does not belong to case "${branch.case}"`,
      );
    }
    const incomplete = [...membership.entries()].some(
      ([nodeId, value]) =>
        value === branch.case &&
        nodeId !== branch.nodeId &&
        !controlGraphIsAncestor(nodeId, branch.nodeId, nodeById),
    );
    if (incomplete) {
      throw new RunReplayError(
        eventIndex,
        `control graph join "${join.nodeId}" terminal "${branch.nodeId}" does not wait for every node in case "${branch.case}"`,
      );
    }
  }
}

function controlGraphBranchMembership(
  nodes: readonly ControlGraphNode[],
  conditionId: string,
): ReadonlyMap<string, string | "cross" | undefined> {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const memo = new Map<string, string | "cross" | undefined>();
  const visiting = new Set<string>();

  function visit(nodeId: string): string | "cross" | undefined {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }
    if (visiting.has(nodeId)) {
      return "cross";
    }
    const node = nodeById.get(nodeId);
    if (node === undefined || node.nodeId === conditionId) {
      return undefined;
    }
    if (node.type === "join" && node.join.conditionId === conditionId) {
      memo.set(nodeId, undefined);
      return undefined;
    }

    visiting.add(nodeId);
    const dependencyMemberships = node.dependsOn
      .map(visit)
      .filter((value): value is string => value !== undefined);
    visiting.delete(nodeId);

    let result: string | "cross" | undefined;
    const directGuard =
      node.type === "join" || node.type === "loop-check" || node.type === "loop"
        ? undefined
        : node.when;
    if (directGuard?.conditionId === conditionId) {
      result = dependencyMemberships.some(
        (value) => value === "cross" || value !== directGuard.case,
      )
        ? "cross"
        : directGuard.case;
    } else if (dependencyMemberships.includes("cross")) {
      result = "cross";
    } else {
      const unique = new Set(dependencyMemberships);
      result = unique.size > 1 ? "cross" : unique.values().next().value;
    }
    memo.set(nodeId, result);
    return result;
  }

  for (const node of nodes) {
    visit(node.nodeId);
  }
  return memo;
}

function controlGraphIsAncestor(
  ancestorId: string,
  nodeId: string,
  nodeById: ReadonlyMap<string, ControlGraphNode>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(nodeId)) {
    return false;
  }
  visited.add(nodeId);
  const node = nodeById.get(nodeId);
  if (node === undefined) {
    return false;
  }
  return node.dependsOn.some(
    (dependency) =>
      dependency === ancestorId ||
      controlGraphIsAncestor(ancestorId, dependency, nodeById, visited),
  );
}

function requireRunningControlTransition(
  state: RunState,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): void {
  if (state.status !== "running") {
    throw new RunReplayError(eventIndex, "control transition requires a running workflow");
  }
  if (Object.values(nodes).some((node) => node.status === "running")) {
    throw new RunReplayError(eventIndex, "control transition cannot overlap a running node");
  }
}

function requireControlGraphNode(
  state: RunState,
  nodeId: string,
  eventIndex: number,
): ControlGraphNode {
  const node = state.controlGraph?.nodes.find((item) => item.nodeId === nodeId);
  if (node === undefined) {
    throw new RunReplayError(
      eventIndex,
      `node "${nodeId}" has no persisted control graph declaration`,
    );
  }
  return node;
}

function requirePendingControlState(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  attempt: number,
  eventIndex: number,
): NodeRunState {
  const node = requireNode(nodes, nodeId, eventIndex);
  if (node.status !== "pending") {
    throw new RunReplayError(eventIndex, `control node "${nodeId}" must be pending`);
  }
  if (attempt !== node.attempt + 1 || attempt !== 1) {
    throw new RunReplayError(eventIndex, `control node "${nodeId}" requires logical attempt 1`);
  }
  return node;
}

function requireTerminalDependencies(
  requirement: ControlGraphNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): void {
  const incomplete = requirement.dependsOn.find((dependency) => {
    const status = nodes[dependency]?.status;
    return status !== "succeeded" && status !== "omitted";
  });
  if (incomplete !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `control node "${requirement.nodeId}" dependency "${incomplete}" is not terminal`,
    );
  }
}

function requireSucceededDependencies(
  requirement: ControlGraphNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): void {
  const incomplete = requirement.dependsOn.find(
    (dependency) => nodes[dependency]?.status !== "succeeded",
  );
  if (incomplete !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `node "${requirement.nodeId}" dependency "${incomplete}" has not succeeded`,
    );
  }
}

function requireConditionDecision(
  nodes: Readonly<Record<string, NodeRunState>>,
  conditionId: string,
  eventIndex: number,
): Extract<NodeControlRunState, { readonly kind: "condition" }> {
  const condition = requireNode(nodes, conditionId, eventIndex);
  if (condition.status !== "succeeded" || condition.control?.kind !== "condition") {
    throw new RunReplayError(eventIndex, `condition "${conditionId}" has no durable decision`);
  }
  return condition.control;
}

function requireLoopCheckDecision(
  nodes: Readonly<Record<string, NodeRunState>>,
  checkNodeId: string,
  eventIndex: number,
): Extract<NodeControlRunState, { readonly kind: "loop-check" }> {
  const check = requireNode(nodes, checkNodeId, eventIndex);
  if (check.status !== "succeeded" || check.control?.kind !== "loop-check") {
    throw new RunReplayError(eventIndex, `loop check "${checkNodeId}" has no durable decision`);
  }
  return check.control;
}

function requireOptimizationCheckRequirement(
  state: RunState,
  nodeId: string,
  eventIndex: number,
): ControlGraphOptimizationCheckNode {
  const requirement = requireControlGraphNode(state, nodeId, eventIndex);
  if (requirement.type !== "optimization-check") {
    throw new RunReplayError(eventIndex, `node "${nodeId}" is not an optimization check`);
  }
  return requirement;
}

function requireOptimizationEvaluation(
  state: NodeRunState,
  nodeId: string,
  eventIndex: number,
): OptimizationCheckRunState {
  if (state.optimization === null) {
    throw new RunReplayError(eventIndex, `optimization check "${nodeId}" is not evaluated`);
  }
  return state.optimization;
}

function requireOptimizationCandidateEvidence(
  requirement: ControlGraphOptimizationCheckNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): ChildEvidence {
  const candidate = requireNode(nodes, requirement.optimizationCheck.candidateNodeId, eventIndex);
  if (candidate.status !== "succeeded" || candidate.evidence?.kind !== "child") {
    throw new RunReplayError(
      eventIndex,
      `optimization candidate "${requirement.optimizationCheck.candidateNodeId}" has no durable child evidence`,
    );
  }
  return candidate.evidence;
}

interface ExpectedOptimizationEvaluation {
  readonly optimizationId: string;
  readonly candidateNumber: number;
  readonly candidateNodeId: string;
  readonly baselineValueHash: string;
  readonly baselineMetric: number;
  readonly baselineInvariants: readonly OptimizationInvariantObservation[];
  readonly bestValueHashBefore: string;
  readonly bestMetricBefore: number;
  readonly priorStagnation: number;
  readonly maxConsecutiveNonImproving: number;
  readonly candidate: ChildEvidence;
  readonly candidateValueHash: string | null;
  readonly candidateMetric: number | null;
  readonly candidateInvariants: readonly OptimizationInvariantObservation[] | null;
  readonly decision: "accepted" | "rejected";
  readonly reason: OptimizationEvaluationReason;
  readonly stagnation: number;
  readonly stop: boolean;
}

function expectedOptimizationEvaluation(
  state: RunState,
  requirement: ControlGraphOptimizationCheckNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): ExpectedOptimizationEvaluation {
  const baseline = requireNode(nodes, requirement.optimizationCheck.baseline.nodeId, eventIndex);
  if (baseline.status !== "succeeded" || baseline.control?.kind !== "result") {
    throw new RunReplayError(eventIndex, "optimization baseline has no durable typed result");
  }
  const candidateNode = state.controlGraph?.nodes.find(
    (node): node is ControlGraphChildNode =>
      node.nodeId === requirement.optimizationCheck.candidateNodeId && node.type === "child",
  );
  if (candidateNode === undefined) {
    throw new RunReplayError(eventIndex, "optimization candidate declaration is not a child");
  }
  const candidate = requireOptimizationCandidateEvidence(requirement, nodes, eventIndex);
  let baselineObservation: ReturnType<typeof evaluateOptimizationBaseline>;
  const prior = priorOptimizationCheck(requirement, nodes, eventIndex);
  const bestValueHashBefore = prior?.bestValueHash ?? baseline.control.valueHash;
  const priorStagnation = prior?.stagnation ?? 0;
  try {
    baselineObservation = evaluateOptimizationBaseline({
      source: baseline.control.canonicalValue,
      schema: candidateNode.child.resultSchema,
      metric: requirement.optimizationCheck.metric,
      invariants: requirement.optimizationCheck.invariants,
    });
  } catch (error) {
    throw new RunReplayError(
      eventIndex,
      `optimization evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const common = {
    optimizationId: requirement.optimizationCheck.optimizationId,
    candidateNumber: requirement.optimizationCheck.candidate,
    candidateNodeId: requirement.optimizationCheck.candidateNodeId,
    baselineValueHash: baselineObservation.valueHash,
    baselineMetric: baselineObservation.metric,
    baselineInvariants: baselineObservation.invariants,
    bestValueHashBefore,
    bestMetricBefore: prior?.bestMetric ?? baselineObservation.metric,
    priorStagnation,
    maxConsecutiveNonImproving: requirement.optimizationCheck.maxConsecutiveNonImproving,
    candidate,
  };
  if (candidate.outcome !== "succeeded") {
    const stagnation = priorStagnation + 1;
    return {
      ...common,
      candidateValueHash: null,
      candidateMetric: null,
      candidateInvariants: null,
      decision: "rejected",
      reason: optimizationCandidateFailureReason(candidate.outcome),
      stagnation,
      stop: stagnation >= requirement.optimizationCheck.maxConsecutiveNonImproving,
    };
  }
  if (candidate.result === null) {
    throw new RunReplayError(eventIndex, "successful optimization candidate has no typed result");
  }
  let candidateObservation: ReturnType<typeof evaluateOptimizationCandidate>;
  try {
    candidateObservation = evaluateOptimizationCandidate({
      source: candidate.result.canonicalValue,
      schema: candidateNode.child.resultSchema,
      metric: requirement.optimizationCheck.metric,
      invariants: requirement.optimizationCheck.invariants,
      bestMetric: prior?.bestMetric ?? baselineObservation.metric,
      priorStagnation,
      maxConsecutiveNonImproving: requirement.optimizationCheck.maxConsecutiveNonImproving,
    });
  } catch (error) {
    throw new RunReplayError(
      eventIndex,
      `optimization evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    ...common,
    candidateValueHash: candidateObservation.valueHash,
    candidateMetric: candidateObservation.metric,
    candidateInvariants: candidateObservation.invariants,
    decision: candidateObservation.decision,
    reason: candidateObservation.reason,
    stagnation: candidateObservation.stagnation,
    stop: candidateObservation.stop,
  };
}

function optimizationCandidateFailureReason(
  outcome: Exclude<OptimizationCandidateOutcome, "succeeded">,
): OptimizationEvaluationReason {
  switch (outcome) {
    case "failed":
      return "candidate_failed";
    case "cancelled":
      return "candidate_cancelled";
    case "resource_exhausted":
      return "candidate_resource_exhausted";
  }
}

function validateOptimizationEvaluationEvent(
  event: NodeOptimizationEvaluatedEvent,
  expected: ExpectedOptimizationEvaluation,
  eventIndex: number,
): void {
  if (
    event.optimizationId !== expected.optimizationId ||
    event.candidate !== expected.candidateNumber ||
    event.candidateNodeId !== expected.candidateNodeId
  ) {
    throw new RunReplayError(eventIndex, "optimization evaluation identity is invalid");
  }
  if (
    event.baselineValueHash !== expected.baselineValueHash ||
    event.baselineMetric !== expected.baselineMetric ||
    !sameOptimizationInvariantObservations(event.baselineInvariants, expected.baselineInvariants)
  ) {
    throw new RunReplayError(eventIndex, "optimization baseline metric or value hash is invalid");
  }
  if (
    event.bestValueHashBefore !== expected.bestValueHashBefore ||
    event.bestMetricBefore !== expected.bestMetricBefore
  ) {
    throw new RunReplayError(eventIndex, "optimization best metric or value hash is invalid");
  }
  if (
    event.candidateOutcome !== expected.candidate.outcome ||
    event.candidateValueHash !== expected.candidateValueHash ||
    event.candidateMetric !== expected.candidateMetric ||
    !sameNullableOptimizationInvariantObservations(
      event.candidateInvariants,
      expected.candidateInvariants,
    )
  ) {
    throw new RunReplayError(eventIndex, "optimization candidate metric or outcome is invalid");
  }

  const captureRejection =
    expected.decision === "accepted" &&
    (event.reason === "candidate_no_change" || event.reason === "candidate_delta_limit_exceeded");
  const expectedDecision =
    expected.decision === "accepted" && !captureRejection ? "promote" : "reject";
  const expectedReason = captureRejection ? event.reason : expected.reason;
  const expectedStagnation = captureRejection ? expected.priorStagnation + 1 : expected.stagnation;
  const expectedStop = captureRejection
    ? expectedStagnation >= expected.maxConsecutiveNonImproving
    : expected.stop;
  if (
    event.decision !== expectedDecision ||
    event.reason !== expectedReason ||
    event.stagnation !== expectedStagnation ||
    event.stop !== expectedStop
  ) {
    throw new RunReplayError(eventIndex, "optimization decision or stagnation is invalid");
  }
  if (event.decision === "promote") {
    const promotion = event.promotion;
    if (
      promotion === null ||
      event.deltaEntries === null ||
      promotion.promotionId !== calculateOptimizationPromotionId(event.runId, event.nodeId) ||
      promotion.workspaceId !== expected.candidate.childRunId ||
      promotion.baselineSnapshotDigest !== expected.candidate.workspace.snapshotDigest ||
      promotion.candidateSnapshotDigest === promotion.baselineSnapshotDigest ||
      !optimizationDeltaMatchesBoundary(promotion, event.deltaEntries)
    ) {
      throw new RunReplayError(eventIndex, "optimization promotion boundary is invalid");
    }
  } else if (event.promotion !== null || event.deltaEntries !== null) {
    throw new RunReplayError(eventIndex, "rejected optimization candidate cannot carry promotion");
  }
}

function sameNullableOptimizationInvariantObservations(
  left: readonly OptimizationInvariantObservation[] | null,
  right: readonly OptimizationInvariantObservation[] | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameOptimizationInvariantObservations(left, right);
}

function sameOptimizationInvariantObservations(
  left: readonly OptimizationInvariantObservation[],
  right: readonly OptimizationInvariantObservation[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (observation, index) =>
        observation.pointer === right[index]?.pointer &&
        observation.expected === right[index]?.expected &&
        observation.actual === right[index]?.actual &&
        observation.passed === right[index]?.passed,
    )
  );
}

function optimizationDeltaMatchesBoundary(
  boundary: OptimizationPromotionBoundary,
  entries: readonly OptimizationDeltaEntry[],
): boolean {
  if (
    entries.length !== boundary.entryCount ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    entries.some((entry, index) =>
      index === 0 ? false : (entries[index - 1]?.path.localeCompare(entry.path, "en") ?? 0) >= 0,
    )
  ) {
    return false;
  }
  const logicalBytes = entries.reduce(
    (total, entry) =>
      total +
      (entry.before.kind === "file" ? entry.before.size : 0) +
      (entry.after.kind === "file" ? entry.after.size : 0),
    0,
  );
  if (!Number.isSafeInteger(logicalBytes) || logicalBytes !== boundary.logicalBytes) {
    return false;
  }
  const manifest = {
    version: 1 as const,
    workspaceId: boundary.workspaceId,
    baselineSnapshotDigest: boundary.baselineSnapshotDigest,
    candidateSnapshotDigest: boundary.candidateSnapshotDigest,
    entryCount: boundary.entryCount,
    logicalBytes: boundary.logicalBytes,
    entries,
  };
  return sha256(JSON.stringify(manifest)) === boundary.deltaDigest;
}

function priorOptimizationCheck(
  requirement: ControlGraphOptimizationCheckNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): Extract<NodeControlRunState, { readonly kind: "optimization-check" }> | undefined {
  const priorId = requirement.optimizationCheck.priorCheckNodeId;
  if (priorId === undefined) {
    return undefined;
  }
  const prior = requireNode(nodes, priorId, eventIndex);
  if (prior.status !== "succeeded" || prior.control?.kind !== "optimization-check") {
    throw new RunReplayError(eventIndex, `prior optimization check "${priorId}" has no decision`);
  }
  return prior.control;
}

function priorOptimizationBestCandidate(
  requirement: ControlGraphOptimizationCheckNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): number | null {
  return priorOptimizationCheck(requirement, nodes, eventIndex)?.bestCandidate ?? null;
}

function requireOptimizationEventIdentity(
  requirement: ControlGraphOptimizationCheckNode,
  optimization: OptimizationCheckRunState,
  event: { readonly optimizationId: string; readonly candidate: number },
  eventIndex: number,
): void {
  if (
    event.optimizationId !== requirement.optimizationCheck.optimizationId ||
    event.candidate !== requirement.optimizationCheck.candidate ||
    optimization.optimizationId !== event.optimizationId ||
    optimization.candidate !== event.candidate
  ) {
    throw new RunReplayError(eventIndex, "optimization event identity is invalid");
  }
}

function sameOptimizationPromotion(
  left: OptimizationPromotionBoundary,
  right: OptimizationPromotionBoundary,
): boolean {
  return (
    left.promotionId === right.promotionId &&
    left.workspaceId === right.workspaceId &&
    left.deltaDigest === right.deltaDigest &&
    left.baselineSnapshotDigest === right.baselineSnapshotDigest &&
    left.candidateSnapshotDigest === right.candidateSnapshotDigest &&
    left.entryCount === right.entryCount &&
    left.logicalBytes === right.logicalBytes
  );
}

function completedOptimizationChecks(
  requirement: ControlGraphOptimizationNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): readonly {
  readonly nodeId: string;
  readonly control: Extract<NodeControlRunState, { readonly kind: "optimization-check" }>;
}[] {
  const completed: Array<{
    readonly nodeId: string;
    readonly control: Extract<NodeControlRunState, { readonly kind: "optimization-check" }>;
  }> = [];
  let stopped = false;
  for (const checkNodeId of requirement.optimization.checkNodeIds) {
    const check = requireNode(nodes, checkNodeId, eventIndex);
    if (check.status === "omitted") {
      if (!stopped) {
        throw new RunReplayError(
          eventIndex,
          "optimization check was omitted before a stop decision",
        );
      }
      continue;
    }
    if (stopped || check.status !== "succeeded" || check.control?.kind !== "optimization-check") {
      throw new RunReplayError(eventIndex, "optimization controller has an invalid check sequence");
    }
    completed.push({ nodeId: checkNodeId, control: check.control });
    stopped = check.control.stop;
  }
  return Object.freeze(completed);
}

function requireSelectedGuard(
  requirement: ControlGraphNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): void {
  if (requirement.loopGuard !== undefined) {
    const decision = requireLoopCheckDecision(nodes, requirement.loopGuard.checkNodeId, eventIndex);
    if (decision.decision !== "continue") {
      throw new RunReplayError(
        eventIndex,
        `node "${requirement.nodeId}" prior loop check did not continue iteration ${requirement.loopGuard.iteration}`,
      );
    }
  }
  if (requirement.optimizationGuard !== undefined) {
    const prior = requireNode(nodes, requirement.optimizationGuard.checkNodeId, eventIndex);
    if (prior.status !== "succeeded" || prior.control?.kind !== "optimization-check") {
      throw new RunReplayError(
        eventIndex,
        `node "${requirement.nodeId}" prior optimization check has no durable decision`,
      );
    }
    if (prior.control.stop) {
      throw new RunReplayError(
        eventIndex,
        `node "${requirement.nodeId}" prior optimization check stopped candidate ${requirement.optimizationGuard.candidate}`,
      );
    }
  }
  if (
    requirement.type === "join" ||
    requirement.type === "loop-check" ||
    requirement.type === "loop" ||
    requirement.when === undefined
  ) {
    return;
  }
  const decision = requireConditionDecision(nodes, requirement.when.conditionId, eventIndex);
  if (decision.selectedCase !== requirement.when.case) {
    throw new RunReplayError(
      eventIndex,
      `node "${requirement.nodeId}" condition guard did not select case "${requirement.when.case}"`,
    );
  }
}

function conditionSourceObservation(
  requirement: ControlGraphConditionNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): ReturnType<typeof controlSourceObservation> {
  return controlSourceObservation(
    requirement.nodeId,
    requirement.condition.source,
    nodes,
    eventIndex,
  );
}

function loopSourceObservation(
  requirement: ControlGraphLoopCheckNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): ReturnType<typeof controlSourceObservation> {
  return controlSourceObservation(
    requirement.nodeId,
    requirement.loopCheck.source,
    nodes,
    eventIndex,
  );
}

function controlSourceObservation(
  controlNodeId: string,
  declaration: { readonly nodeId: string; readonly field: ConditionSourceField },
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = requireNode(nodes, declaration.nodeId, eventIndex);
  if (source.status !== "succeeded") {
    throw new RunReplayError(
      eventIndex,
      `control node "${controlNodeId}" source has no successful durable evidence`,
    );
  }
  if (declaration.field === "result.value") {
    if (source.control?.kind === "result") {
      return {
        attempt: source.attempt,
        value: source.control.canonicalValue,
        hash: source.control.valueHash,
        truncated: false,
      };
    }
    if (source.evidence?.kind === "child" && source.evidence.result !== null) {
      return {
        attempt: source.attempt,
        value: source.evidence.result.canonicalValue,
        hash: source.evidence.result.valueHash,
        truncated: false,
      };
    }
    throw new RunReplayError(
      eventIndex,
      `control node "${controlNodeId}" source field is incompatible with durable evidence`,
    );
  }
  if (source.evidence === null) {
    throw new RunReplayError(
      eventIndex,
      `control node "${controlNodeId}" source has no successful durable evidence`,
    );
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind !== "command") {
        break;
      }
      return {
        attempt: source.attempt,
        value: source.evidence.stdout,
        hash: source.evidence.stdoutHash,
        truncated: source.evidence.stdoutTruncated,
      };
    case "command.stderr":
      if (source.evidence.kind !== "command") {
        break;
      }
      return {
        attempt: source.attempt,
        value: source.evidence.stderr,
        hash: source.evidence.stderrHash,
        truncated: source.evidence.stderrTruncated,
      };
    case "agent.text":
      if (source.evidence.kind !== "agent") {
        break;
      }
      return {
        attempt: source.attempt,
        value: source.evidence.text,
        hash: source.evidence.textHash,
        truncated: source.evidence.textTruncated,
      };
    case "verifier.verdict":
      if (source.evidence.kind !== "verifier") {
        break;
      }
      return {
        attempt: source.attempt,
        value: source.evidence.verdict,
        hash: sha256(source.evidence.verdict),
        truncated: false,
      };
    case "verifier.reason":
      if (source.evidence.kind !== "verifier") {
        break;
      }
      return {
        attempt: source.attempt,
        value: source.evidence.reason,
        hash: source.evidence.reasonHash,
        truncated: false,
      };
  }
  throw new RunReplayError(
    eventIndex,
    `control node "${controlNodeId}" source field is incompatible with durable evidence`,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function childRunLinkMatches(
  link: ChildRunLink,
  requirement: ControlGraphChildNode["child"],
): boolean {
  return (
    link.workflowId === requirement.workflowId &&
    link.workflowDigest === requirement.workflowDigest &&
    link.resultNodeId === requirement.resultNodeId &&
    link.resultSchemaDigest === requirement.resultSchemaDigest &&
    link.isolationBackend === "reflink-copy-v1"
  );
}

function addResourcesForStart(
  resources: RunResourceConsumption,
  eventIndex: number,
): RunResourceConsumption {
  try {
    return addRunResources(resources, { nodeStarts: 1 });
  } catch (error) {
    throw resourceReplayError(eventIndex, error);
  }
}

function addResourcesForEvidence(
  resources: RunResourceConsumption,
  evidence: NodeEvidence,
  eventIndex: number,
): RunResourceConsumption {
  try {
    if (evidence.kind === "child") {
      return addRunResources(resources, evidence.resources);
    }
    return addRunResources(resources, {
      executionMs: committedDurationMs(evidence.durationMs),
      artifactBytes: artifactBytesForEvidence(evidence),
      ...((evidence.kind === "agent" ||
        (evidence.kind === "verifier" && evidence.driver === "model")) &&
      evidence.usage !== undefined
        ? {
            modelTokens: totalModelTokens(evidence.usage),
            modelCostUsdMicros: evidence.usage.costUsdMicros,
          }
        : {}),
    });
  } catch (error) {
    throw resourceReplayError(eventIndex, error);
  }
}

function artifactBytesForEvidence(evidence: Exclude<NodeEvidence, ChildEvidence>): number {
  switch (evidence.kind) {
    case "command":
      return retainedArtifactBytes([evidence.stdout, evidence.stderr]);
    case "agent":
      return retainedArtifactBytes([evidence.text]);
    case "verifier":
      if (evidence.driver === "model") {
        return retainedArtifactBytes([evidence.raw]);
      }
      return evidence.command === null
        ? 0
        : retainedArtifactBytes([evidence.command.stdout, evidence.command.stderr]);
  }
}

function resourceReplayError(eventIndex: number, error: unknown): RunReplayError {
  const message = error instanceof Error ? error.message : String(error);
  return new RunReplayError(eventIndex, `resource accounting failed: ${message}`);
}

function validateSucceededEvidence(evidence: NodeEvidence, eventIndex: number): void {
  if (
    evidence.kind === "command" &&
    (evidence.exitCode !== 0 || evidence.signal !== null || evidence.timedOut)
  ) {
    throw new RunReplayError(
      eventIndex,
      "successful command evidence must have exit code 0, no signal, and no timeout",
    );
  }
  if (evidence.kind === "verifier" && evidence.verdict !== "accepted") {
    throw new RunReplayError(
      eventIndex,
      "successful verifier evidence must have an accepted verdict",
    );
  }
  if (evidence.kind === "agent" && evidence.textTruncated) {
    throw new RunReplayError(eventIndex, "successful agent evidence must not be truncated");
  }
  if (
    evidence.kind === "agent" &&
    evidence.effectReceipts.some((receipt) => receipt.outcome === "uncertain")
  ) {
    throw new RunReplayError(
      eventIndex,
      "successful agent evidence must not contain an uncertain effect receipt",
    );
  }
}

function validateChildEvidenceProjection(
  graph: ControlGraph | null,
  nodes: Readonly<Record<string, NodeRunState>>,
  event: NodeSucceededEvent | NodeFailedEvent,
  evidence: NodeEvidence | null,
  eventIndex: number,
): void {
  const requirement = graph?.nodes.find((node) => node.nodeId === event.nodeId);
  if (requirement?.type !== "child") {
    if (evidence?.kind === "child") {
      throw new RunReplayError(eventIndex, "child evidence belongs to a non-child node");
    }
    return;
  }
  const childRun = requireNode(nodes, event.nodeId, eventIndex).childRun;
  if (childRun === null || !childRunLinkMatches(childRun, requirement.child)) {
    throw new RunReplayError(eventIndex, "child evidence has no matching durable child link");
  }
  if (evidence === null) {
    if (
      event.type !== "node_failed" ||
      !event.error.code.startsWith("child_") ||
      event.error.sideEffectStatus !== "none"
    ) {
      throw new RunReplayError(eventIndex, "child node is missing its durable child evidence");
    }
    return;
  }
  if (evidence.kind !== "child") {
    throw new RunReplayError(eventIndex, "child node has incompatible evidence");
  }
  if (
    evidence.childRunId !== childRun.runId ||
    evidence.workflowId !== requirement.child.workflowId ||
    evidence.workflowDigest !== requirement.child.workflowDigest ||
    evidence.workspace.backend !== childRun.isolationBackend
  ) {
    throw new RunReplayError(eventIndex, "child evidence does not match its durable child link");
  }
  if (evidence.result !== null) {
    let evaluated: ReturnType<typeof evaluateTypedResult>;
    try {
      evaluated = evaluateTypedResult(
        evidence.result.canonicalValue,
        requirement.child.resultSchema,
      );
    } catch (error) {
      throw new RunReplayError(
        eventIndex,
        `child canonical result is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      evidence.result.nodeId !== requirement.child.resultNodeId ||
      evidence.result.schemaDigest !== requirement.child.resultSchemaDigest ||
      evaluated.canonicalValue !== evidence.result.canonicalValue ||
      evaluated.valueHash !== evidence.result.valueHash
    ) {
      throw new RunReplayError(
        eventIndex,
        "child result does not match its node, schema, canonical value, or hash",
      );
    }
  }
  if (evidence.outcome === "succeeded" && evidence.result === null) {
    throw new RunReplayError(eventIndex, "succeeded child evidence is missing its typed result");
  }
  if (event.type === "node_succeeded") {
    if (requirement.optimizationCandidate === undefined) {
      if (
        evidence.outcome !== "succeeded" ||
        evidence.result === null ||
        evidence.workspace.disposition !== "discarded"
      ) {
        throw new RunReplayError(
          eventIndex,
          "successful child evidence requires a succeeded child, typed result, and discarded workspace",
        );
      }
    } else if (
      (evidence.outcome === "succeeded" &&
        (evidence.result === null || evidence.workspace.disposition !== "retained")) ||
      (evidence.outcome !== "succeeded" && evidence.workspace.disposition !== "discarded")
    ) {
      throw new RunReplayError(
        eventIndex,
        "optimization candidate outcome has an invalid result or workspace disposition",
      );
    }
  }
  if (event.type === "node_failed") {
    const cleanupFailed = event.error.code === "child_workspace_cleanup_failed";
    if (cleanupFailed !== (evidence.workspace.disposition === "retained")) {
      throw new RunReplayError(
        eventIndex,
        "child workspace disposition does not match its cleanup failure",
      );
    }
    const expectedFailureCode = cleanupFailed
      ? "child_workspace_cleanup_failed"
      : evidence.outcome === "succeeded"
        ? null
        : `child_run_${evidence.outcome}`;
    if (expectedFailureCode === null || event.error.code !== expectedFailureCode) {
      throw new RunReplayError(
        eventIndex,
        `child outcome "${evidence.outcome}" does not match failure code "${event.error.code}"`,
      );
    }
  }
}

type InlineVerifierRequirement = Extract<
  CompiledVerifierConfig,
  { readonly kind: "command" | "model" }
>;

function resolvePersistedVerifierRequirement(
  requirement: ControlGraphVerifierNode,
  snapshot: CapabilitySnapshot | null,
  packageRequirement: Omit<VerifierPackageRequirement, "nodeId"> | undefined,
  evidence: NodeEvidence | null,
  eventIndex: number,
): InlineVerifierRequirement {
  const declared = requirement.verifier;
  if (declared.kind === "command" || declared.kind === "model") {
    if (
      packageRequirement !== undefined ||
      (evidence?.kind === "verifier" && evidence.package !== undefined)
    ) {
      throw new RunReplayError(
        eventIndex,
        `inline verifier node "${requirement.nodeId}" cannot report package identity`,
      );
    }
    return declared;
  }
  const expectedKind = declared.kind === "packaged-command" ? "command" : "model";
  if (
    packageRequirement === undefined ||
    packageRequirement.name !== declared.package.name ||
    packageRequirement.version !== declared.package.version ||
    packageRequirement.kind !== expectedKind
  ) {
    throw new RunReplayError(
      eventIndex,
      `packaged verifier node "${requirement.nodeId}" has inconsistent durable requirements`,
    );
  }
  const selected = snapshot?.packages.find(
    (item) =>
      item.kind === "verifier-package" &&
      item.name === packageRequirement.name &&
      item.version === packageRequirement.version,
  );
  if (
    selected?.kind !== "verifier-package" ||
    selected.version !== packageRequirement.version ||
    selected.definition.kind !== expectedKind
  ) {
    throw new RunReplayError(
      eventIndex,
      `packaged verifier node "${requirement.nodeId}" has no matching durable package`,
    );
  }
  if (
    evidence?.kind === "verifier" &&
    (evidence.package === undefined ||
      evidence.package.name !== selected.name ||
      evidence.package.version !== selected.version ||
      evidence.package.digest !== selected.digest)
  ) {
    throw new RunReplayError(
      eventIndex,
      `packaged verifier node "${requirement.nodeId}" evidence does not match package identity`,
    );
  }
  if (selected.definition.kind === "command") {
    return Object.freeze({
      kind: "command",
      command: Object.freeze({
        executable: selected.definition.command.executable,
        args: Object.freeze([...selected.definition.command.args]),
        timeoutMs: selected.definition.command.timeoutMs,
      }),
    });
  }
  if (declared.kind !== "packaged-model") {
    throw new RunReplayError(
      eventIndex,
      `packaged verifier node "${requirement.nodeId}" has incompatible model configuration`,
    );
  }
  return Object.freeze({
    kind: "model",
    prompt: selected.definition.prompt,
    evidence: declared.evidence,
    model: declared.model,
    timeoutMs: declared.timeoutMs,
  });
}

function validateVerifierEvidenceProjection(
  graph: ControlGraph | null,
  snapshot: CapabilitySnapshot | null,
  packageRequirements: Readonly<Record<string, Omit<VerifierPackageRequirement, "nodeId">>>,
  nodes: Readonly<Record<string, NodeRunState>>,
  event: NodeSucceededEvent | NodeFailedEvent,
  evidence: NodeEvidence | null,
  eventIndex: number,
): void {
  const requirement = graph?.nodes.find((node) => node.nodeId === event.nodeId);
  if (requirement?.type !== "verifier") {
    if (evidence?.kind === "verifier") {
      throw new RunReplayError(eventIndex, "verifier evidence belongs to a non-verifier node");
    }
    return;
  }
  const verifier = resolvePersistedVerifierRequirement(
    requirement,
    snapshot,
    packageRequirements[event.nodeId],
    evidence,
    eventIndex,
  );
  if (evidence === null) {
    if (
      event.type !== "node_failed" ||
      (event.error.code !== "verifier_inconclusive" && event.error.code !== "workflow_aborted") ||
      event.error.retryable ||
      event.error.sideEffectStatus === "committed"
    ) {
      throw new RunReplayError(
        eventIndex,
        `verifier node "${event.nodeId}" has no valid inconclusive failure evidence`,
      );
    }
    return;
  }
  if (evidence.kind !== "verifier") {
    throw new RunReplayError(
      eventIndex,
      `verifier node "${event.nodeId}" has incompatible evidence`,
    );
  }
  if (evidence.driver !== verifier.kind) {
    throw new RunReplayError(
      eventIndex,
      "verifier evidence driver does not match the control graph",
    );
  }
  if (event.type === "node_succeeded") {
    if (evidence.verdict !== "accepted") {
      throw new RunReplayError(eventIndex, "successful verifier evidence must be accepted");
    }
  } else {
    const cancelledAfterVerdict = event.error.code === "workflow_aborted";
    if (evidence.verdict === "accepted" && !cancelledAfterVerdict) {
      throw new RunReplayError(eventIndex, "failed verifier evidence cannot be accepted");
    }
    const expectedCode =
      evidence.verdict === "rejected" ? "verifier_rejected" : "verifier_inconclusive";
    if (
      (!cancelledAfterVerdict && event.error.code !== expectedCode) ||
      (!cancelledAfterVerdict && event.error.message !== evidence.reason) ||
      event.error.retryable
    ) {
      throw new RunReplayError(
        eventIndex,
        "failed verifier error does not match its durable verdict",
      );
    }
  }

  if (evidence.driver === "command") {
    if (verifier.kind !== "command") {
      throw new RunReplayError(eventIndex, "command verifier evidence has no command requirement");
    }
    const command = evidence.command;
    if (evidence.result === "completed" && command === null) {
      throw new RunReplayError(
        eventIndex,
        "completed command verifier evidence is missing command evidence",
      );
    }
    if (evidence.result === "execution_failed" && evidence.verdict !== "inconclusive") {
      throw new RunReplayError(eventIndex, "failed command execution must be inconclusive");
    }
    if (command !== null) {
      if (
        command.executable !== verifier.command.executable ||
        !sameStrings(command.args, verifier.command.args) ||
        command.durationMs !== evidence.durationMs
      ) {
        throw new RunReplayError(
          eventIndex,
          "command verifier evidence does not match its declaration",
        );
      }
      const expectedVerdict =
        evidence.result === "execution_failed" ? "inconclusive" : commandVerdict(command);
      if (evidence.verdict !== expectedVerdict) {
        throw new RunReplayError(
          eventIndex,
          "command verifier verdict contradicts command evidence",
        );
      }
      const deterministicReason =
        evidence.result === "completed" && expectedVerdict === "accepted"
          ? "command exited with code 0"
          : evidence.result === "completed" &&
              expectedVerdict === "rejected" &&
              command.exitCode !== null
            ? `command exited with code ${command.exitCode}`
            : null;
      if (deterministicReason !== null && evidence.reason !== deterministicReason) {
        throw new RunReplayError(
          eventIndex,
          "command verifier reason contradicts command evidence",
        );
      }
      if (event.type === "node_failed" && event.error.sideEffectStatus === "none") {
        throw new RunReplayError(
          eventIndex,
          "failed command verifier with command evidence must preserve possible side effects",
        );
      }
    } else if (evidence.durationMs !== 0) {
      throw new RunReplayError(
        eventIndex,
        "command verifier without command evidence cannot report execution duration",
      );
    }
    return;
  }

  if (verifier.kind !== "model") {
    throw new RunReplayError(eventIndex, "model verifier evidence has no model requirement");
  }
  if (evidence.provider !== verifier.model.provider || evidence.model !== verifier.model.id) {
    throw new RunReplayError(
      eventIndex,
      "model verifier provenance does not match its declaration",
    );
  }
  if (evidence.sources.length !== verifier.evidence.length) {
    throw new RunReplayError(
      eventIndex,
      "model verifier source observations do not match declaration",
    );
  }
  for (const [index, declaration] of verifier.evidence.entries()) {
    const observation = evidence.sources[index];
    if (observation === undefined) {
      throw new RunReplayError(eventIndex, "model verifier source observation is missing");
    }
    const actual = verifierSourceObservation(event.nodeId, declaration, nodes, eventIndex);
    if (
      actual.truncated &&
      !(
        event.type === "node_failed" &&
        evidence.result === "execution_failed" &&
        evidence.verdict === "inconclusive"
      )
    ) {
      throw new RunReplayError(
        eventIndex,
        `model verifier source ${index + 1} is truncated in durable evidence`,
      );
    }
    if (
      observation.sourceNodeId !== declaration.nodeId ||
      observation.sourceAttempt !== actual.attempt ||
      observation.sourceField !== declaration.field ||
      observation.sourceHash !== actual.hash
    ) {
      throw new RunReplayError(
        eventIndex,
        `model verifier source ${index + 1} does not match durable source attempt and hash`,
      );
    }
  }
  if (
    event.type === "node_failed" &&
    event.error.sideEffectStatus !== "none" &&
    event.error.code !== "workflow_aborted"
  ) {
    throw new RunReplayError(
      eventIndex,
      "tool-free model verifier failure must be side-effect-free",
    );
  }
  if (evidence.result === "parsed") {
    if (evidence.rawTruncated) {
      throw new RunReplayError(eventIndex, "parsed model verifier output cannot be truncated");
    }
    const parsed = parsePersistedVerifierResponse(evidence.raw, eventIndex);
    if (parsed.verdict !== evidence.verdict || parsed.reason !== evidence.reason) {
      throw new RunReplayError(eventIndex, "parsed model verifier output contradicts its verdict");
    }
  } else if (evidence.verdict !== "inconclusive") {
    throw new RunReplayError(eventIndex, "unparsed model verifier output must be inconclusive");
  }
}

function commandVerdict(command: CommandEvidence): VerifierVerdict {
  if (command.exitCode === 0 && command.signal === null && !command.timedOut) {
    return "accepted";
  }
  if (
    command.exitCode !== null &&
    command.exitCode !== 0 &&
    command.signal === null &&
    !command.timedOut
  ) {
    return "rejected";
  }
  return "inconclusive";
}

function parsePersistedVerifierResponse(
  raw: string,
  eventIndex: number,
): { readonly verdict: VerifierVerdict; readonly reason: string } {
  const parsed = parseVerifierVerdictJson(raw);
  if (parsed === null) {
    throw new RunReplayError(
      eventIndex,
      "parsed model verifier output violates the strict verdict contract",
    );
  }
  return parsed;
}

function verifierSourceObservation(
  verifierNodeId: string,
  declaration: { readonly nodeId: string; readonly field: EvidenceSourceField },
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): { readonly attempt: number; readonly hash: string; readonly truncated: boolean } {
  const source = requireNode(nodes, declaration.nodeId, eventIndex);
  if (source.status !== "succeeded") {
    throw new RunReplayError(
      eventIndex,
      `verifier node "${verifierNodeId}" source has no successful durable evidence`,
    );
  }
  if (declaration.field === "result.value") {
    if (source.control?.kind === "result") {
      return {
        attempt: source.attempt,
        hash: source.control.valueHash,
        truncated: false,
      };
    }
    if (source.evidence?.kind === "child" && source.evidence.result !== null) {
      return {
        attempt: source.attempt,
        hash: source.evidence.result.valueHash,
        truncated: false,
      };
    }
    throw new RunReplayError(
      eventIndex,
      `verifier node "${verifierNodeId}" source field is incompatible with durable evidence`,
    );
  }
  if (source.evidence === null) {
    throw new RunReplayError(
      eventIndex,
      `verifier node "${verifierNodeId}" source has no successful durable evidence`,
    );
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          hash: source.evidence.stdoutHash,
          truncated: source.evidence.stdoutTruncated,
        };
      }
      break;
    case "command.stderr":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          hash: source.evidence.stderrHash,
          truncated: source.evidence.stderrTruncated,
        };
      }
      break;
    case "agent.text":
      if (source.evidence.kind === "agent") {
        return {
          attempt: source.attempt,
          hash: source.evidence.textHash,
          truncated: source.evidence.textTruncated,
        };
      }
      break;
    case "verifier.verdict":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          hash: sha256(source.evidence.verdict),
          truncated: false,
        };
      }
      break;
    case "verifier.reason":
      if (source.evidence.kind === "verifier") {
        return { attempt: source.attempt, hash: source.evidence.reasonHash, truncated: false };
      }
      break;
  }
  throw new RunReplayError(
    eventIndex,
    `verifier node "${verifierNodeId}" source field is incompatible with durable evidence`,
  );
}

function validateEffectReconciliation(
  event: NodeEffectReconciledEvent,
  effect: NodeEffectRunState,
  eventIndex: number,
): void {
  const descriptor = effect.descriptor;
  switch (event.reason) {
    case "target_matches_after":
      if (
        event.observedSha256 !== descriptor.afterSha256 ||
        event.observedMode !== descriptor.mode
      ) {
        throw new RunReplayError(
          eventIndex,
          "applied effect reconciliation contradicts the prepared after digest or mode",
        );
      }
      break;
    case "target_matches_before":
      if (
        event.observedSha256 !== descriptor.beforeSha256 ||
        event.observedMode !== descriptor.mode
      ) {
        throw new RunReplayError(
          eventIndex,
          "not-applied effect reconciliation contradicts the prepared before digest or mode",
        );
      }
      break;
    case "target_content_diverged":
      if (
        event.observedSha256 === descriptor.beforeSha256 ||
        event.observedSha256 === descriptor.afterSha256
      ) {
        throw new RunReplayError(
          eventIndex,
          "content-diverged effect reconciliation matches a prepared digest",
        );
      }
      break;
    case "target_mode_diverged":
      if (
        (event.observedSha256 !== descriptor.beforeSha256 &&
          event.observedSha256 !== descriptor.afterSha256) ||
        event.observedMode === descriptor.mode
      ) {
        throw new RunReplayError(
          eventIndex,
          "mode-diverged effect reconciliation contradicts the prepared digest or mode",
        );
      }
      break;
    default:
      break;
  }
}

function validateDurableEffectProjection(
  node: NodeRunState,
  evidence: NodeEvidence | null,
  event: NodeSucceededEvent | NodeFailedEvent,
  eventIndex: number,
): void {
  if (node.effectProtocol === null) {
    return;
  }
  const unresolved = node.effects.find((effect) => effect.settlement === null);
  if (unresolved !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `node cannot complete while unresolved effect "${unresolved.effectId}" remains prepared`,
    );
  }
  if (event.type === "node_failed") {
    const hasUnknownEffect = node.effects.some(
      (effect) => effect.settlement?.outcome === "unknown",
    );
    const hasCommittedEffect = node.effects.some(
      (effect) => effect.settlement?.outcome === "committed",
    );
    if (hasUnknownEffect && event.error.retryable) {
      throw new RunReplayError(
        eventIndex,
        "failure after an unknown durable effect cannot be retryable",
      );
    }
    const contradictsDurableEffects = hasUnknownEffect
      ? event.error.sideEffectStatus !== "uncertain"
      : hasCommittedEffect
        ? event.error.sideEffectStatus === "none"
        : event.error.sideEffectStatus === "committed";
    if (contradictsDurableEffects) {
      throw new RunReplayError(
        eventIndex,
        `failure side-effect status "${event.error.sideEffectStatus}" contradicts the durable effect journal`,
      );
    }
  }
  if (node.effects.length > 0) {
    if (evidence?.kind !== "agent") {
      throw new RunReplayError(
        eventIndex,
        "durable effect authorization evidence is missing from the terminal agent evidence",
      );
    }
    const matchedDecisionIndexes = new Set<number>();
    for (const effect of node.effects) {
      const matchingDecisionIndex = evidence.policyDecisions.findIndex(
        (decision, decisionIndex) =>
          !matchedDecisionIndexes.has(decisionIndex) &&
          decision.action === "filesystem.write" &&
          decision.target === effect.descriptor.target &&
          decision.operationDigest === effect.descriptor.operationDigest &&
          decision.outcome === "allowed",
      );
      if (matchingDecisionIndex === -1) {
        throw new RunReplayError(
          eventIndex,
          `durable effect "${effect.effectId}" has no matching write authorization evidence`,
        );
      }
      matchedDecisionIndexes.add(matchingDecisionIndex);
    }
  }
  const expectedReceipts: AgentEffectReceipt[] = node.effects.flatMap((effect) => {
    const settlement = effect.settlement;
    if (settlement === null || settlement.outcome === "not_applied") {
      return [];
    }
    return [
      {
        version: 1,
        sequence: effect.effectSequence,
        runId: event.runId,
        workflowId: event.workflowId,
        nodeId: event.nodeId,
        attempt: event.attempt,
        kind: effect.descriptor.kind,
        target: effect.descriptor.target,
        operationDigest: effect.descriptor.operationDigest,
        beforeSha256: effect.descriptor.beforeSha256,
        afterSha256: effect.descriptor.afterSha256,
        outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
      },
    ];
  });
  if (evidence === null) {
    if (expectedReceipts.length > 0) {
      throw new RunReplayError(eventIndex, "terminal evidence is missing durable effect receipts");
    }
    return;
  }
  if (evidence.kind !== "agent") {
    throw new RunReplayError(
      eventIndex,
      "a durable effect protocol attempt requires agent evidence",
    );
  }
  if (evidence.effectReceipts.length !== expectedReceipts.length) {
    throw new RunReplayError(
      eventIndex,
      "terminal durable effect receipts do not match settled effects",
    );
  }
  for (const [index, expected] of expectedReceipts.entries()) {
    const actual = evidence.effectReceipts[index];
    if (actual === undefined || !sameEffectReceipt(actual, expected)) {
      throw new RunReplayError(
        eventIndex,
        `terminal durable effect receipts do not match settled effect ${index + 1}`,
      );
    }
  }
}

function sameEffectReceipt(left: AgentEffectReceipt, right: AgentEffectReceipt): boolean {
  return (
    left.version === right.version &&
    left.sequence === right.sequence &&
    left.runId === right.runId &&
    left.workflowId === right.workflowId &&
    left.nodeId === right.nodeId &&
    left.attempt === right.attempt &&
    left.kind === right.kind &&
    left.target === right.target &&
    left.operationDigest === right.operationDigest &&
    left.beforeSha256 === right.beforeSha256 &&
    left.afterSha256 === right.afterSha256 &&
    left.outcome === right.outcome
  );
}

function validateEvidenceIntegrity(
  evidence: NodeEvidence,
  event: NodeSucceededEvent | NodeFailedEvent,
  eventIndex: number,
  requireContiguousReceiptSequence: boolean,
): void {
  if (
    evidence.kind === "child" &&
    evidence.result !== null &&
    evidence.result.valueHash !== sha256(evidence.result.canonicalValue)
  ) {
    throw new RunReplayError(eventIndex, "child result value hash is invalid");
  }
  if (evidence.kind === "verifier") {
    if (evidence.reasonHash !== sha256(evidence.reason)) {
      throw new RunReplayError(eventIndex, "verifier evidence reason hash is invalid");
    }
    if (evidence.driver === "model") {
      if (!evidence.rawTruncated && evidence.rawHash !== sha256(evidence.raw)) {
        throw new RunReplayError(eventIndex, "verifier raw output hash is invalid");
      }
    } else if (evidence.command !== null) {
      validateEvidenceIntegrity(
        evidence.command,
        event,
        eventIndex,
        requireContiguousReceiptSequence,
      );
    }
  }
  if (
    evidence.kind === "agent" &&
    !evidence.textTruncated &&
    evidence.textHash !== sha256(evidence.text)
  ) {
    throw new RunReplayError(eventIndex, "agent evidence text hash is invalid");
  }
  if (evidence.kind === "agent") {
    for (const [index, decision] of evidence.policyDecisions.entries()) {
      const expectedSequence = index + 1;
      if (decision.sequence !== expectedSequence) {
        throw new RunReplayError(
          eventIndex,
          `policy decision sequence must be contiguous; expected ${expectedSequence}, received ${decision.sequence}`,
        );
      }
      if (
        decision.runId !== event.runId ||
        decision.workflowId !== event.workflowId ||
        decision.nodeId !== event.nodeId ||
        decision.attempt !== event.attempt
      ) {
        throw new RunReplayError(
          eventIndex,
          "policy decision attribution does not match its node event",
        );
      }
      if (decision.authority !== classifyPolicyAction(decision.action)) {
        throw new RunReplayError(eventIndex, "policy decision authority does not match its action");
      }
      const expectedOutcome = decision.reason === "operation_declared" ? "allowed" : "denied";
      if (decision.outcome !== expectedOutcome) {
        throw new RunReplayError(eventIndex, "policy decision outcome does not match its reason");
      }
      const expectedDigest = calculatePolicyRequestDigest({
        version: decision.version,
        runId: decision.runId,
        workflowId: decision.workflowId,
        nodeId: decision.nodeId,
        attempt: decision.attempt,
        authority: decision.authority,
        action: decision.action,
        target: decision.target,
        ...(decision.operationDigest === undefined
          ? {}
          : { operationDigest: decision.operationDigest }),
      });
      if (decision.requestDigest !== expectedDigest) {
        throw new RunReplayError(eventIndex, "policy decision request digest is invalid");
      }
    }
    const matchedPolicyDecisionIndexes = new Set<number>();
    for (const [index, receipt] of evidence.effectReceipts.entries()) {
      const expectedSequence = index + 1;
      if (requireContiguousReceiptSequence && receipt.sequence !== expectedSequence) {
        throw new RunReplayError(
          eventIndex,
          `effect receipt sequence must be contiguous; expected ${expectedSequence}, received ${receipt.sequence}`,
        );
      }
      if (
        receipt.runId !== event.runId ||
        receipt.workflowId !== event.workflowId ||
        receipt.nodeId !== event.nodeId ||
        receipt.attempt !== event.attempt
      ) {
        throw new RunReplayError(
          eventIndex,
          "effect receipt attribution does not match its node event",
        );
      }
      if (receipt.beforeSha256 === receipt.afterSha256) {
        throw new RunReplayError(eventIndex, "edit effect receipt must describe changed content");
      }
      const matchingDecisionIndex = evidence.policyDecisions.findIndex(
        (decision, decisionIndex) =>
          !matchedPolicyDecisionIndexes.has(decisionIndex) &&
          decision.action === "filesystem.write" &&
          decision.target === receipt.target &&
          decision.operationDigest === receipt.operationDigest &&
          decision.outcome === "allowed",
      );
      if (matchingDecisionIndex === -1) {
        throw new RunReplayError(
          eventIndex,
          "effect receipt does not match an unused allowed policy decision",
        );
      }
      matchedPolicyDecisionIndexes.add(matchingDecisionIndex);
    }
    if (
      event.type === "node_failed" &&
      event.error.sideEffectStatus === "committed" &&
      evidence.effectReceipts.length === 0
    ) {
      throw new RunReplayError(
        eventIndex,
        "committed side-effect status requires an effect receipt",
      );
    }
    if (event.type === "node_failed" && evidence.effectReceipts.length > 0) {
      const hasUncertain = evidence.effectReceipts.some(
        (receipt) => receipt.outcome === "uncertain",
      );
      if (hasUncertain && event.error.sideEffectStatus !== "uncertain") {
        throw new RunReplayError(
          eventIndex,
          "an uncertain effect receipt requires uncertain side-effect status",
        );
      }
      if (!hasUncertain && event.error.sideEffectStatus === "none") {
        throw new RunReplayError(
          eventIndex,
          "a committed effect receipt cannot have side-effect-free failure status",
        );
      }
    }
  }
  if (evidence.kind === "command") {
    if (!evidence.stdoutTruncated && evidence.stdoutHash !== sha256(evidence.stdout)) {
      throw new RunReplayError(eventIndex, "command evidence stdout hash is invalid");
    }
    if (!evidence.stderrTruncated && evidence.stderrHash !== sha256(evidence.stderr)) {
      throw new RunReplayError(eventIndex, "command evidence stderr hash is invalid");
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pendingNodeState(): NodeRunState {
  return Object.freeze({
    status: "pending",
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    evidence: null,
    error: null,
    approval: null,
    workflowApproval: null,
    childRun: null,
    effectProtocol: null,
    effects: Object.freeze([]),
    interruptedAttempts: Object.freeze([]),
    control: null,
    omission: null,
    optimization: null,
  });
}

function validateInterruptedAttemptRecovery(
  state: RunState,
  node: NodeRunState,
  requirement: Omit<AgentRecoveryRequirement, "nodeId"> | undefined,
  eventIndex: number,
): void {
  if (requirement === undefined) {
    throw new RunReplayError(eventIndex, "fresh recovery is not configured for this node");
  }
  if (node.attempt >= requirement.maxAttempts) {
    throw new RunReplayError(
      eventIndex,
      `fresh recovery attempts are exhausted at attempt ${node.attempt}`,
    );
  }

  const limits = state.budget?.limits;
  if (
    limits?.maxModelTokens !== undefined ||
    limits?.maxCostUsdMicros !== undefined ||
    limits?.maxExecutionMs !== undefined
  ) {
    throw new RunReplayError(
      eventIndex,
      "fresh recovery cannot account for interrupted model, cost, or execution resources",
    );
  }
  if (limits?.maxNodeStarts !== undefined && state.resources.nodeStarts >= limits.maxNodeStarts) {
    throw new RunReplayError(
      eventIndex,
      "fresh recovery has no node-start budget capacity for the next attempt",
    );
  }

  if (requirement.effectProtocol === "none") {
    if (node.effectProtocol !== null || node.effects.length > 0) {
      throw new RunReplayError(
        eventIndex,
        "read-only fresh recovery requires an attempt without an effect protocol or effects",
      );
    }
    return;
  }

  if (node.effectProtocol !== DURABLE_EFFECT_PROTOCOL) {
    throw new RunReplayError(
      eventIndex,
      `fresh recovery requires effect protocol "${DURABLE_EFFECT_PROTOCOL}"`,
    );
  }
  const unsafeEffect = node.effects.find((effect) => !effectIsProvenNotApplied(effect));
  if (unsafeEffect !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `fresh recovery requires effect "${unsafeEffect.effectId}" to be proven not applied`,
    );
  }
}

function effectIsProvenNotApplied(effect: NodeEffectRunState): boolean {
  return (
    effect.settlement?.outcome === "not_applied" || effect.reconciliation?.outcome === "not_applied"
  );
}

function requireStartedAt(node: NodeRunState, eventIndex: number): string {
  if (node.startedAt === null) {
    throw new RunReplayError(eventIndex, "running node is missing its start timestamp");
  }
  return node.startedAt;
}

export function nodeEffectId(eventSequence: number): string {
  if (!Number.isSafeInteger(eventSequence) || eventSequence <= 0) {
    throw new RangeError("effect event sequence must be a positive safe integer");
  }
  return `effect-${eventSequence}`;
}

function requireNode(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  eventIndex: number,
): NodeRunState {
  const node = nodes[nodeId];
  if (node === undefined) {
    throw new RunReplayError(eventIndex, `event references unknown node "${nodeId}"`);
  }
  return node;
}

function validateAgentCapabilityEvidenceProjection(
  snapshot: CapabilitySnapshot | null,
  declaredSkills: readonly string[] | undefined,
  evidence: NodeEvidence,
  eventIndex: number,
): void {
  const capabilities = evidence.kind === "agent" ? evidence.capabilities : undefined;
  if (declaredSkills === undefined) {
    if (capabilities !== undefined) {
      throw new RunReplayError(
        eventIndex,
        "agent capability evidence is not declared for this node",
      );
    }
    return;
  }
  if (snapshot === null || capabilities === undefined) {
    throw new RunReplayError(
      eventIndex,
      "declared Agent Skills require capability evidence bound to the durable run snapshot",
    );
  }
  try {
    const expected = createAgentCapabilityEvidence(snapshot, declaredSkills, capabilities.reads);
    if (JSON.stringify(expected) !== JSON.stringify(capabilities)) {
      throw new Error("selected package evidence does not match the durable node declaration");
    }
  } catch (error) {
    throw new RunReplayError(
      eventIndex,
      `agent capability evidence is not bound to durable content: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireRunningAttempt(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  attempt: number,
  eventIndex: number,
): NodeRunState {
  const node = requireNode(nodes, nodeId, eventIndex);
  if (node.status !== "running") {
    throw new RunReplayError(eventIndex, `node "${nodeId}" must be running before completion`);
  }
  if (node.attempt !== attempt) {
    throw new RunReplayError(
      eventIndex,
      `node "${nodeId}" completion attempt ${attempt} does not match ${node.attempt}`,
    );
  }
  return node;
}

function isRunningNodeOutcome(
  event: RunEvent,
  nodes: Readonly<Record<string, NodeRunState>>,
): event is NodeSucceededEvent | NodeFailedEvent {
  return (
    (event.type === "node_succeeded" || event.type === "node_failed") &&
    nodes[event.nodeId]?.status === "running"
  );
}

function requireNextRunningOutcome(
  nodes: Readonly<Record<string, NodeRunState>>,
  nodeId: string,
  eventIndex: number,
): void {
  const next = Object.entries(nodes).find(([, node]) => node.status === "running");
  if (next !== undefined && next[0] !== nodeId) {
    throw new RunReplayError(
      eventIndex,
      `node outcome for "${nodeId}" violates declaration order; "${next[0]}" must settle first`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
