import type {
  AgentEffectReceipt,
  FilesystemEditEffectDescriptor,
  NodeEffectReconciliationInput,
  NodeEffectSettlementInput,
  NodeEvidence,
  NodeFailure,
  RunEvent,
} from "../domain/run/events.js";
import type {
  CompiledAgentNode,
  CompiledCommandNode,
  CompiledNode,
} from "../domain/workflow/types.js";

export interface RunEventStore {
  append(event: RunEvent): Promise<void>;
  read(runId: string): Promise<readonly RunEvent[]>;
}

export interface RecoverableRunEventStore extends RunEventStore {
  claim(runId: string): Promise<readonly RunEvent[]>;
  release(runId: string): Promise<void>;
}

export interface NodeExecutionContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly effectJournal?: NodeEffectJournal;
  readonly signal?: AbortSignal;
}

export interface NodeEffectJournal {
  prepare(descriptor: FilesystemEditEffectDescriptor): Promise<PreparedNodeEffect>;
}

export interface PreparedNodeEffect {
  readonly effectId: string;
  readonly effectSequence: number;
  settle(settlement: NodeEffectSettlementInput): Promise<AgentEffectReceipt | null>;
}

export interface NodeEffectReconciler {
  reconcile(
    descriptor: FilesystemEditEffectDescriptor,
    publish: (observation: NodeEffectReconciliationInput) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
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
