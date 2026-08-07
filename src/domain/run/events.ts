import { z } from "zod";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import {
  GoalEvaluationError,
  acceptGoal,
  createGoalRunState,
  recordCriterionDecision,
  rejectIncompleteGoal,
} from "../goal/evaluator.js";
import { compiledGoalSchema } from "../goal/schema.js";
import type { CompiledGoal, GoalRunState } from "../goal/types.js";
import {
  MAX_CONCURRENT_NODES,
  MAX_CONTROL_GRAPH_SERIALIZED_BYTES,
  type CompiledRunBudget,
  type CompiledWorkflowConcurrency,
  type ConditionSourceField,
} from "../workflow/types.js";
import {
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  isValidApprovalActor,
  type CommandApprovalOperation,
} from "../approval/command-approval.js";
import {
  MAX_POLICY_DECISIONS,
  MAX_POLICY_TARGET_BYTES,
  calculatePolicyRequestDigest,
  classifyPolicyAction,
} from "../policy/broker.js";
import { policyDecisionSchema } from "../policy/schema.js";
import type { PolicyDecision } from "../policy/types.js";
import {
  addRunResources,
  agentModelUsageSchema,
  budgetExhaustionReason,
  calculateRunBudgetState,
  committedDurationMs,
  emptyRunResources,
  runBudgetExhaustionSchema,
  runBudgetLimitsSchema,
  sameBudgetExhaustions,
  totalModelTokens,
  type AgentModelUsage,
  type RunBudgetExhaustion,
  type RunBudgetState,
  type RunResourceConsumption,
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

export type NodeEvidence = CommandEvidence | AgentEvidence;

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
  readonly budget?: CompiledRunBudget;
  readonly concurrency?: CompiledWorkflowConcurrency;
  readonly goal?: CompiledGoal;
  readonly executionCwd?: string;
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

export interface ControlGraphExecutableNode {
  readonly nodeId: string;
  readonly type: "command" | "agent";
  readonly dependsOn: readonly string[];
  readonly when?: ControlBranchGuard;
}

export interface ControlGraphConditionNode {
  readonly nodeId: string;
  readonly type: "condition";
  readonly dependsOn: readonly string[];
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

export interface ControlGraphJoinNode {
  readonly nodeId: string;
  readonly type: "join";
  readonly dependsOn: readonly string[];
  readonly join: {
    readonly conditionId: string;
    readonly branches: readonly {
      readonly case: string;
      readonly nodeId: string;
    }[];
  };
}

export type ControlGraphNode =
  | ControlGraphExecutableNode
  | ControlGraphConditionNode
  | ControlGraphJoinNode;

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
  | NodeStartedEvent
  | NodeAttemptInterruptedEvent
  | NodeConditionEvaluatedEvent
  | NodeOmittedEvent
  | NodeJoinedEvent
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

export interface NodeRunState {
  readonly status: NodeRunStatus;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly evidence: NodeEvidence | null;
  readonly error: NodeFailure | null;
  readonly approval: CommandApprovalRunState | null;
  readonly effectProtocol: typeof DURABLE_EFFECT_PROTOCOL | null;
  readonly effects: readonly NodeEffectRunState[];
  readonly interruptedAttempts: readonly InterruptedNodeAttemptState[];
  readonly control: NodeControlRunState | null;
  readonly omission: NodeOmissionRunState | null;
}

export type NodeControlRunState =
  | {
      readonly kind: "condition";
      readonly sourceNodeId: string;
      readonly sourceAttempt: number;
      readonly sourceField: ConditionSourceField;
      readonly sourceHash: string;
      readonly selectedCase: string;
    }
  | {
      readonly kind: "join";
      readonly conditionId: string;
      readonly selectedCase: string;
      readonly completedNodeId: string;
      readonly omittedNodeIds: readonly string[];
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
  readonly executionCwd: string | null;
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
  })
  .strict();

const nodeEvidenceSchema = z.discriminatedUnion("kind", [
  commandEvidenceSchema,
  agentEvidenceSchema,
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

const controlConditionSchema = z
  .object({
    source: z
      .object({
        nodeId: identifierSchema,
        field: z.enum(["command.stdout", "command.stderr", "agent.text"]),
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

const controlGraphNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      nodeId: identifierSchema,
      type: z.literal("command"),
      dependsOn: controlDependencySchema,
      when: controlBranchGuardSchema.optional(),
    })
    .strict(),
  z
    .object({
      nodeId: identifierSchema,
      type: z.literal("agent"),
      dependsOn: controlDependencySchema,
      when: controlBranchGuardSchema.optional(),
    })
    .strict(),
  z
    .object({
      nodeId: identifierSchema,
      type: z.literal("condition"),
      dependsOn: controlDependencySchema,
      when: controlBranchGuardSchema.optional(),
      condition: controlConditionSchema,
    })
    .strict(),
  z
    .object({
      nodeId: identifierSchema,
      type: z.literal("join"),
      dependsOn: controlDependencySchema,
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
]);

const controlGraphSchema = z
  .object({
    nodes: z
      .array(controlGraphNodeSchema)
      .min(1)
      .max(64)
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
      budget: runBudgetLimitsSchema.optional(),
      concurrency: z
        .object({ maxNodes: z.number().int().min(1).max(MAX_CONCURRENT_NODES) })
        .strict()
        .optional(),
      goal: compiledGoalSchema.optional(),
      executionCwd: absolutePathSchema.optional(),
      approvalRequirements: z
        .array(z.object({ nodeId: identifierSchema, grantTtlMs: grantTtlSchema }).strict())
        .max(64)
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
        .max(64)
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
      type: z.literal("node_started"),
      nodeId: identifierSchema,
      attempt: z.number().int().positive(),
      effectProtocol: z.literal(DURABLE_EFFECT_PROTOCOL).optional(),
      approval: approvalReferenceSchema.optional(),
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
      sourceField: z.enum(["command.stdout", "command.stderr", "agent.text"]),
      sourceHash: sha256Schema,
      selectedCase: identifierSchema,
    })
    .strict(),
  z
    .object({
      ...eventBaseShape,
      type: z.literal("node_omitted"),
      nodeId: identifierSchema,
      reason: z.enum(["condition_not_selected", "dependency_omitted"]),
      conditionId: identifierSchema.optional(),
      selectedCase: identifierSchema.optional(),
      expectedCase: identifierSchema.optional(),
      omittedDependencies: z.array(identifierSchema).min(1).max(128).optional(),
    })
    .strict()
    .superRefine((event, context) => {
      const conditionFields =
        event.conditionId !== undefined &&
        event.selectedCase !== undefined &&
        event.expectedCase !== undefined;
      const dependencyFields = event.omittedDependencies !== undefined;
      if (event.reason === "condition_not_selected" && (!conditionFields || dependencyFields)) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "condition omission requires only condition decision fields",
        });
      }
      if (event.reason === "dependency_omitted" && (!dependencyFields || conditionFields)) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "dependency omission requires only omitted dependencies",
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
      exhausted: z.array(runBudgetExhaustionSchema).min(1).max(4),
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
      executionCwd: event.executionCwd ?? null,
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
      if (currentState.controlGraph !== null) {
        const controlNode = requireControlGraphNode(currentState, event.nodeId, eventIndex);
        if (controlNode.type === "condition" || controlNode.type === "join") {
          throw new RunReplayError(
            eventIndex,
            `control node "${event.nodeId}" cannot start through an executor`,
          );
        }
        requireSucceededDependencies(controlNode, nodes, eventIndex);
        requireSelectedGuard(controlNode, nodes, eventIndex);
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
        if (requirement.type === "join" || requirement.when === undefined) {
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
      } else {
        if (requirement.type !== "join" && requirement.when !== undefined) {
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
    case "node_control_failed": {
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
      validateSucceededEvidence(event.evidence, eventIndex);
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
          outcome: event.evidence.kind === "command" ? "accepted" : "inconclusive",
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
      }
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
    executionCwd: currentState.executionCwd,
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
    if (node.type !== "join" && node.when !== undefined) {
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
      const compatible =
        (node.condition.source.field.startsWith("command.") && source?.type === "command") ||
        (node.condition.source.field === "agent.text" && source?.type === "agent");
      if (!node.dependsOn.includes(node.condition.source.nodeId) || !compatible) {
        throw new RunReplayError(
          eventIndex,
          `control graph condition "${node.nodeId}" has an invalid source`,
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
  const dependedUpon = new Set(graph.nodes.flatMap((node) => node.dependsOn));
  const invalidTerminal = graph.nodes.find(
    (node) => !dependedUpon.has(node.nodeId) && node.type !== "command",
  );
  if (invalidTerminal !== undefined) {
    throw new RunReplayError(
      eventIndex,
      `control graph terminal "${invalidTerminal.nodeId}" must be a command node`,
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

function controlConditionCases(condition: ControlGraphConditionNode): readonly string[] {
  return [...condition.condition.cases.map((item) => item.id), condition.condition.default];
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
    const directGuard = node.type === "join" ? undefined : node.when;
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

function requireSelectedGuard(
  requirement: ControlGraphNode,
  nodes: Readonly<Record<string, NodeRunState>>,
  eventIndex: number,
): void {
  if (requirement.type === "join" || requirement.when === undefined) {
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
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = requireNode(nodes, requirement.condition.source.nodeId, eventIndex);
  if (source.status !== "succeeded" || source.evidence === null) {
    throw new RunReplayError(
      eventIndex,
      `condition "${requirement.nodeId}" source has no successful durable evidence`,
    );
  }
  switch (requirement.condition.source.field) {
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
  }
  throw new RunReplayError(
    eventIndex,
    `condition "${requirement.nodeId}" source field is incompatible with durable evidence`,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
    return addRunResources(resources, {
      executionMs: committedDurationMs(evidence.durationMs),
      ...(evidence.kind === "agent" && evidence.usage !== undefined
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
    effectProtocol: null,
    effects: Object.freeze([]),
    interruptedAttempts: Object.freeze([]),
    control: null,
    omission: null,
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
