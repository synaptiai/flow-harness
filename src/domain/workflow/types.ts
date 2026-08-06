export const FLOW_WORKFLOW_API_VERSION = "flow.synapti.ai/v1alpha1" as const;

export type AgentToolName = "read" | "ls";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CompiledWorkflow {
  readonly apiVersion: typeof FLOW_WORKFLOW_API_VERSION;
  readonly id: string;
  readonly description?: string;
  readonly nodes: readonly CompiledNode[];
}

export interface CompiledNodeBase {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface CompiledCommandNode extends CompiledNodeBase {
  readonly type: "command";
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
    readonly timeoutMs: number;
  };
}

export type CompiledNode = CompiledCommandNode | CompiledAgentNode;
