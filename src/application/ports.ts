import type { AgentCommandRequest } from "../domain/agent-command.js";
import type { AgentCommandApprovalRequest } from "../domain/approval/command-approval.js";
import type { CapabilitySnapshot } from "../domain/capability/agent-skills.js";
import type { VerifierPackageUseEvidence } from "../domain/capability/verifier-packages.js";
import type { PolicyDecision } from "../domain/policy/types.js";
import type {
  AgentCommandApprovalReference,
  AgentCommandSettlementOutcome,
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
  readonly relocatedFromCwd?: string;
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
  readonly legacySourceCwd?: string;
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
    readonly legacySourceCwd?: string;
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
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly effectJournal?: NodeEffectJournal;
  readonly agentCommandJournal?: NodeAgentCommandJournal;
  readonly agentCommandApprovalGate?: NodeAgentCommandApprovalGate;
  readonly agentCommandExecutor?: AgentCommandExecutor;
  readonly verifierSources?: readonly VerifierSourceInput[];
  readonly verifierPackage?: VerifierPackageUseEvidence;
  readonly agentSystemPrompt?: string;
  readonly agentGoalWorkspace?: string;
  readonly agentSupplementalMemory?: string;
  readonly agentExactModelSettings?: boolean;
  readonly agentMaxOutputBytes?: number;
  readonly agentMaxOutputTokens?: number;
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

export interface NodeAgentCommandJournal {
  prepare(input: {
    readonly request: AgentCommandRequest;
    readonly operationDigest: string;
    readonly decision: PolicyDecision;
    readonly approval?: AgentCommandApprovalReference;
  }): Promise<PreparedNodeAgentCommand>;
}

export interface AgentCommandApprovalWait {
  readonly requestId: string;
  readonly request: AgentCommandApprovalRequest;
  readonly requestDigest: string;
}

export interface AgentCommandApprovalDecision {
  readonly version: 1;
  readonly runId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly operationDigest: string;
  readonly decision: "approve" | "deny";
  readonly actor: string;
  readonly reason?: string;
  readonly submittedAt: string;
}

export interface AgentCommandApprovalDecisionSource {
  waitForDecision(
    wait: AgentCommandApprovalWait,
    signal?: AbortSignal,
  ): Promise<AgentCommandApprovalDecision>;
}

export type AgentCommandApprovalDecisionSourceErrorCode =
  | "decision_invalid"
  | "temporarily_unavailable";

/** Provider-neutral classification for decision input that the application must audit or retry. */
export class AgentCommandApprovalDecisionSourceError extends Error {
  override readonly name = "AgentCommandApprovalDecisionSourceError";

  constructor(
    readonly code: AgentCommandApprovalDecisionSourceErrorCode,
    message: string,
    readonly retryAfterMs = 50,
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 1_000) {
      throw new RangeError("decision-source retry delay must be between 1 and 1000ms");
    }
  }
}

export interface AgentCommandApprovalDecisionSink {
  submitDecision(decision: AgentCommandApprovalDecision): Promise<void>;
}

export interface AgentCommandApprovalDecisionChannel
  extends AgentCommandApprovalDecisionSource,
    AgentCommandApprovalDecisionSink {}

export interface NodeAgentCommandApprovalGate {
  authorize(
    request: AgentCommandRequest,
    signal?: AbortSignal,
  ): Promise<AgentCommandApprovalReference>;
}

export interface PreparedNodeAgentCommand {
  readonly commandId: string;
  readonly commandSequence: number;
  settle(outcome: AgentCommandSettlementOutcome): Promise<AgentCommandSettlementReceipt>;
}

export interface AgentCommandSettlementReceipt {
  readonly artifactBudgetExhausted: boolean;
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

export interface AgentCommandExecutor {
  executeAgentCommand(
    command: AgentCommandRequest,
    context: NodeExecutionContext,
  ): Promise<AgentCommandSettlementOutcome>;
}

export interface AgentExecutor {
  execute(node: CompiledAgentNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}

export interface VerifierExecutor {
  execute(node: CompiledVerifierNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome>;
}
