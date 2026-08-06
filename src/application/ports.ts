import type { NodeEvidence, NodeFailure, RunEvent } from "../domain/run/events.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledNode,
} from "../domain/workflow/types.js";

export interface RunEventStore {
  append(event: RunEvent): Promise<void>;
  read(runId: string): Promise<readonly RunEvent[]>;
}

export interface NodeExecutionContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly signal?: AbortSignal;
}

export interface NodeExecutionSuccess {
  readonly status: "succeeded";
  readonly evidence: NodeEvidence;
}

export interface NodeExecutionFailure {
  readonly status: "failed";
  readonly error: NodeFailure;
  readonly evidence: NodeEvidence | null;
}

export type NodeExecutionOutcome = NodeExecutionSuccess | NodeExecutionFailure;

export interface NodeExecutor {
  execute(node: CompiledNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}

export interface CommandExecutor {
  execute(node: CompiledCommandNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}

export interface AgentExecutor {
  execute(node: CompiledAgentNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}
