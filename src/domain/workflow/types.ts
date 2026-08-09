import type { CompiledGoal } from "../goal/types.js";

export const FLOW_WORKFLOW_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_CONTROL_GRAPH_SERIALIZED_BYTES = 524_288;
export const MAX_CONCURRENT_NODES = 32;
export const MAX_COMPILED_WORKFLOW_NODES = 256;
export const MAX_LOOP_BODY_NODES = 16;
export const MAX_LOOP_ITERATIONS = 32;
export const MAX_OPTIMIZATION_CANDIDATES = 16;
export const MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES = 128 * 1024;
export const MAX_RESULT_SCHEMA_DEPTH = 8;
export const MAX_RESULT_SCHEMA_NODES = 128;
export const MAX_RESULT_SCHEMA_SERIALIZED_BYTES = 65_536;
export const MAX_RESULT_VALUE_BYTES = 262_144;
export const MAX_RESULT_VALUE_NODES = 16_384;
export const MAX_RESULT_ARRAY_ITEMS = MAX_RESULT_VALUE_NODES - 1;
export const MAX_CHILD_WORKFLOW_SOURCE_BYTES = 1_048_576;
export const MAX_CHILD_WORKFLOW_DEPTH = 4;
export const MAX_RUN_TREE_NODES = 1_024;

export type AgentToolName = "read" | "ls" | "edit" | "exec";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type EvidenceSourceField =
  | "command.stdout"
  | "command.stderr"
  | "agent.text"
  | "verifier.verdict"
  | "verifier.reason"
  | "result.value";
export type ConditionSourceField = EvidenceSourceField;

export interface CompiledRunBudget {
  readonly maxNodeStarts?: number;
  readonly maxModelTokens?: number;
  readonly maxCostUsdMicros?: number;
  readonly maxExecutionMs?: number;
  readonly maxArtifactBytes?: number;
}

export interface CompiledWorkflowConcurrency {
  readonly maxNodes: number;
}

export interface CompiledWorkflow {
  readonly apiVersion: typeof FLOW_WORKFLOW_API_VERSION;
  readonly id: string;
  readonly description?: string;
  readonly sourcePackage?: CompiledWorkflowPackageReference;
  readonly goal?: CompiledGoal;
  readonly budget?: CompiledRunBudget;
  readonly concurrency?: CompiledWorkflowConcurrency;
  readonly nodes: readonly CompiledNode[];
}

export interface CompiledWorkflowPackageReference {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export interface CompiledNodeBase {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly loopInstance?: CompiledLoopInstance;
  readonly loopGuard?: CompiledLoopGuard;
  readonly optimizationGuard?: CompiledOptimizationGuard;
}

export interface CompiledLoopInstance {
  readonly loopId: string;
  readonly iteration: number;
  readonly templateNodeId: string;
}

export interface CompiledLoopGuard {
  readonly loopId: string;
  readonly iteration: number;
  readonly checkNodeId: string;
}

export interface CompiledOptimizationGuard {
  readonly optimizationId: string;
  readonly candidate: number;
  readonly checkNodeId: string;
}

export interface CompiledBranchGuard {
  readonly conditionId: string;
  readonly case: string;
}

export interface CompiledApprovalEvidenceSource {
  readonly nodeId: string;
  readonly field: ConditionSourceField;
}

export interface CompiledVerifierEvidenceSource {
  readonly nodeId: string;
  readonly field: EvidenceSourceField;
}

export interface CompiledVerifierPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface CompiledToolPackageReference {
  readonly name: string;
  readonly version: string;
}

export interface CompiledGuardedNodeBase extends CompiledNodeBase {
  readonly when?: CompiledBranchGuard;
}

export interface CompiledCommandNode extends CompiledGuardedNodeBase {
  readonly type: "command";
  readonly approval?: {
    readonly mode: "required";
    readonly grantTtlMs: number;
  };
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly timeoutMs: number;
  };
}

export interface CompiledAgentNode extends CompiledGuardedNodeBase {
  readonly type: "agent";
  readonly agent: {
    readonly prompt: string;
    readonly model: {
      readonly provider: string;
      readonly id: string;
      readonly thinking: ThinkingLevel;
    };
    readonly tools: readonly AgentToolName[];
    readonly skills: readonly string[];
    readonly toolPackages: readonly CompiledToolPackageReference[];
    readonly toolApproval?: {
      readonly exec: {
        readonly mode: "required";
        readonly grantTtlMs: number;
      };
    };
    readonly recovery?: {
      readonly mode: "fresh";
      readonly maxAttempts: number;
    };
    readonly timeoutMs: number;
  };
}

export type CompiledVerifierConfig =
  | {
      readonly kind: "command";
      readonly command: {
        readonly executable: string;
        readonly args: readonly string[];
        readonly timeoutMs: number;
      };
    }
  | {
      readonly kind: "model";
      readonly prompt: string;
      readonly evidence: readonly CompiledVerifierEvidenceSource[];
      readonly model: {
        readonly provider: string;
        readonly id: string;
        readonly thinking: ThinkingLevel;
      };
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "packaged-command";
      readonly package: CompiledVerifierPackageReference;
    }
  | {
      readonly kind: "packaged-model";
      readonly package: CompiledVerifierPackageReference;
      readonly evidence: readonly CompiledVerifierEvidenceSource[];
      readonly model: {
        readonly provider: string;
        readonly id: string;
        readonly thinking: ThinkingLevel;
      };
      readonly timeoutMs: number;
    };

export interface CompiledVerifierNode extends CompiledGuardedNodeBase {
  readonly type: "verifier";
  readonly verifier: CompiledVerifierConfig;
}

export interface CompiledConditionNode extends CompiledGuardedNodeBase {
  readonly type: "condition";
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

export interface CompiledApprovalNode extends CompiledGuardedNodeBase {
  readonly type: "approval";
  readonly approval: {
    readonly prompt: string;
    readonly evidence: readonly CompiledApprovalEvidenceSource[];
  };
}

export type CompiledResultSchema =
  | { readonly type: "null" }
  | { readonly type: "boolean" }
  | {
      readonly type: "number";
      readonly minimum?: number | undefined;
      readonly maximum?: number | undefined;
    }
  | {
      readonly type: "integer";
      readonly minimum?: number | undefined;
      readonly maximum?: number | undefined;
    }
  | {
      readonly type: "string";
      readonly maxLength: number;
    }
  | {
      readonly type: "array";
      readonly maxItems: number;
      readonly items: CompiledResultSchema;
    }
  | {
      readonly type: "object";
      readonly properties: Readonly<Record<string, CompiledResultSchema>>;
      readonly required: readonly string[];
    };

export interface CompiledResultNode extends CompiledGuardedNodeBase {
  readonly type: "result";
  readonly result: {
    readonly source: {
      readonly nodeId: string;
      readonly field: EvidenceSourceField;
    };
    readonly schema: CompiledResultSchema;
    readonly schemaDigest: string;
  };
}

export interface CompiledChildNode extends CompiledGuardedNodeBase {
  readonly type: "child";
  readonly optimizationCandidate?: {
    readonly optimizationId: string;
    readonly candidate: number;
    readonly checkNodeId: string;
  };
  readonly child: {
    readonly workflow: CompiledWorkflow;
    readonly workflowDigest: string;
    readonly resultNodeId: string;
    readonly resultSchema: CompiledResultSchema;
    readonly resultSchemaDigest: string;
  };
}

export interface CompiledJoinNode extends CompiledNodeBase {
  readonly type: "join";
  readonly join: {
    readonly conditionId: string;
    readonly branches: readonly {
      readonly case: string;
      readonly nodeId: string;
    }[];
  };
}

export interface CompiledLoopCheckNode extends CompiledGuardedNodeBase {
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

export interface CompiledLoopNode extends CompiledGuardedNodeBase {
  readonly type: "loop";
  readonly loop: {
    readonly maxIterations: number;
    readonly checkNodeIds: readonly string[];
  };
}

export interface CompiledOptimizationCheckNode extends CompiledGuardedNodeBase {
  readonly type: "optimization-check";
  readonly optimizationCheck: {
    readonly optimizationId: string;
    readonly candidate: number;
    readonly candidateNodeId: string;
    readonly priorCheckNodeId?: string;
    readonly baseline: {
      readonly nodeId: string;
      readonly field: "result.value";
    };
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

export interface CompiledOptimizationNode extends CompiledGuardedNodeBase {
  readonly type: "optimization";
  readonly optimization: {
    readonly baseline: {
      readonly nodeId: string;
      readonly field: "result.value";
    };
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

export type CompiledNode =
  | CompiledCommandNode
  | CompiledAgentNode
  | CompiledVerifierNode
  | CompiledApprovalNode
  | CompiledResultNode
  | CompiledChildNode
  | CompiledConditionNode
  | CompiledJoinNode
  | CompiledLoopCheckNode
  | CompiledLoopNode
  | CompiledOptimizationCheckNode
  | CompiledOptimizationNode;
