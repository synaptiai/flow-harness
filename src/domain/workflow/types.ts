import type { CompiledGoal } from "../goal/types.js";

export const FLOW_WORKFLOW_API_VERSION = "flow.synapti.ai/v1alpha1" as const;

export type AgentToolName = "read" | "ls" | "edit";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CompiledRunBudget {
  readonly maxNodeStarts?: number;
  readonly maxModelTokens?: number;
  readonly maxCostUsdMicros?: number;
  readonly maxExecutionMs?: number;
}

export interface CompiledWorkflow {
  readonly apiVersion: typeof FLOW_WORKFLOW_API_VERSION;
  readonly id: string;
  readonly description?: string;
  readonly goal?: CompiledGoal;
  readonly budget?: CompiledRunBudget;
  readonly nodes: readonly CompiledNode[];
}

export interface CompiledNodeBase {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface CompiledCommandNode extends CompiledNodeBase {
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

export interface CompiledAgentNode extends CompiledNodeBase {
  readonly type: "agent";
  readonly agent: {
    readonly prompt: string;
    readonly model: {
      readonly provider: string;
      readonly id: string;
      readonly thinking: ThinkingLevel;
    };
    readonly tools: readonly AgentToolName[];
    readonly recovery?: {
      readonly mode: "fresh";
      readonly maxAttempts: number;
    };
    readonly timeoutMs: number;
  };
}

export type CompiledNode = CompiledCommandNode | CompiledAgentNode;
