import type { CapabilitySnapshot } from "../domain/capability/agent-skills.js";
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
  CompiledVerifierNode,
  EvidenceSourceField,
} from "../domain/workflow/types.js";

export interface RunEventStore {
  append(event: RunEvent): Promise<void>;
  read(runId: string): Promise<readonly RunEvent[]>;
}

export interface RecoverableRunEventStore extends RunEventStore {
  claim(runId: string): Promise<readonly RunEvent[]>;
  release(runId: string): Promise<void>;
  exists?(runId: string): Promise<boolean>;
}

export interface IsolatedWorkspace {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly backend: "reflink-copy-v1";
  readonly snapshotDigest: string;
}

export interface WorkspaceIsolator {
  create(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly excludedPaths?: readonly string[];
  }): Promise<IsolatedWorkspace>;
  reopen(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly excludedPaths?: readonly string[];
  }): Promise<IsolatedWorkspace>;
  cleanup(workspaceId: string): Promise<"discarded">;
}

export type WorkspaceEntryIdentity =
  | { readonly kind: "missing" }
  | { readonly kind: "directory"; readonly mode: number }
  | {
      readonly kind: "file";
      readonly mode: number;
      readonly size: number;
      readonly sha256: string;
    }
  | { readonly kind: "symlink"; readonly target: string };

export interface CandidateDeltaEntry {
  readonly path: string;
  readonly before: WorkspaceEntryIdentity;
  readonly after: WorkspaceEntryIdentity;
}

export interface CandidateDelta {
  readonly version: 1;
  readonly workspaceId: string;
  readonly baselineSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly entryCount: number;
  readonly logicalBytes: number;
  readonly entries: readonly CandidateDeltaEntry[];
  readonly deltaDigest: string;
}

export interface CandidatePromotionRequest {
  readonly promotionId: string;
  readonly workspaceId: string;
  readonly sourceCwd: string;
  readonly deltaDigest: string;
  readonly excludedPaths?: readonly string[];
}

export interface CandidatePromotionBoundary {
  readonly promotionId: string;
  readonly workspaceId: string;
  readonly deltaDigest: string;
  readonly baselineSnapshotDigest: string;
  readonly candidateSnapshotDigest: string;
  readonly entryCount: number;
  readonly logicalBytes: number;
}

export type CandidatePromotionSettlement =
  | { readonly outcome: "committed"; readonly reason: "local_commit_durable" }
  | {
      readonly outcome: "rolled_back";
      readonly reason: "compensated_after_failure" | "reconciled_incomplete";
    }
  | { readonly outcome: "unknown"; readonly reason: "affected_path_diverged" };

export interface CandidatePromotionLifecycle {
  prepare(boundary: CandidatePromotionBoundary): Promise<void>;
  settle(settlement: CandidatePromotionSettlement): Promise<void>;
}

export interface CandidateWorkspaceManager {
  captureCandidateDelta(request: {
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly expectedSnapshotDigest: string;
    readonly excludedPaths?: readonly string[];
  }): Promise<CandidateDelta>;
  promoteCandidateDelta(
    request: CandidatePromotionRequest,
    lifecycle: CandidatePromotionLifecycle,
  ): Promise<CandidatePromotionSettlement>;
  reconcileCandidatePromotion(
    request: CandidatePromotionRequest,
  ): Promise<CandidatePromotionSettlement>;
}

export interface NodeExecutionContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly effectJournal?: NodeEffectJournal;
  readonly verifierSources?: readonly VerifierSourceInput[];
  readonly agentSystemPrompt?: string;
  readonly agentMaxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface VerifierSourceInput {
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceField: EvidenceSourceField;
  readonly sourceHash: string;
  readonly value: string;
  readonly truncated: boolean;
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

export interface VerifierExecutor {
  execute(node: CompiledVerifierNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}
