import { join } from "node:path";
import type { CapabilitySnapshot } from "../domain/capability/agent-skills.js";
import type { EvaluationOciLease } from "../domain/evaluation/attempt.js";
import type {
  ContextCompactionEvaluationMetrics,
  EvaluationHarnessOutcome,
  EvaluationMetrics,
} from "../domain/evaluation/records.js";
import { unavailableEvaluationMetrics } from "../domain/evaluation/records.js";
import type { AgentModelUsage } from "../domain/run/budget.js";
import type { ContextCompactionPolicy } from "../domain/run/context-compaction.js";
import type { AgentEvidence, NodeEvidence, RunState } from "../domain/run/events.js";
import type { CompiledNode, CompiledWorkflow } from "../domain/workflow/types.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ModelSessionStore, NodeExecutor, RunEventStore, WorkspaceIsolator } from "./ports.js";
import { runWorkflow } from "./run-workflow.js";

export interface HarnessEvaluationRequest {
  readonly planDigest: string;
  readonly trial: {
    readonly trialId: string;
    readonly position: number;
    readonly taskId: string;
    readonly profileId: string;
    readonly seed: number;
    readonly repetition: number;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly backend: "reflink-copy-v1";
    readonly snapshotDigest: string;
  };
  readonly instruction: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly controls: {
    readonly model: {
      readonly provider: string;
      readonly id: string;
      readonly thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    };
    readonly budget: {
      readonly maxNodeStarts: number;
      readonly maxModelTokens: number;
      readonly maxCostUsdMicros: number;
      readonly maxExecutionMs: number;
      readonly maxArtifactBytes: number;
    };
    readonly network: "deny";
    readonly retry: { readonly providerRetries: 0; readonly harnessRetries: 0 };
  };
  readonly durability?: {
    readonly updateOciLease: (lease: EvaluationOciLease) => Promise<void>;
  };
}

export interface HarnessEvaluationResult {
  readonly harness: EvaluationHarnessOutcome;
  readonly metrics: EvaluationMetrics;
}

export class HarnessUnsafeStateError extends Error {
  override readonly name: string = "HarnessUnsafeStateError";
}

export interface HarnessEvaluationAdapter {
  readonly kind: string;
  run(request: HarnessEvaluationRequest): Promise<HarnessEvaluationResult>;
}

export interface FlowWorkflowEvaluationProfile {
  readonly id: string;
  readonly adapter: "flow-workflow-v1";
  readonly workflow: {
    readonly compiled: CompiledWorkflow;
    readonly workflowDigest: string;
  };
  readonly capabilitySnapshot?: CapabilitySnapshot;
}

export interface FlowWorkflowEvaluationAdapterDependencies {
  readonly executor: NodeExecutor;
  readonly createStore: (runId: string) => RunEventStore;
  readonly workspaceIsolator?: WorkspaceIsolator;
  readonly artifactStore?: ArtifactStore;
  readonly modelSessionStore?: ModelSessionStore;
  readonly contextCompaction?: ContextCompactionPolicy;
  readonly clockMs?: () => number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export class FlowWorkflowEvaluationAdapter implements HarnessEvaluationAdapter {
  readonly kind = "flow-workflow-v1";

  constructor(
    private readonly profile: FlowWorkflowEvaluationProfile,
    private readonly dependencies: FlowWorkflowEvaluationAdapterDependencies,
  ) {}

  async run(request: HarnessEvaluationRequest): Promise<HarnessEvaluationResult> {
    const runId = `eval-${request.trial.trialId}`;
    const clock = this.dependencies.clockMs ?? Date.now;
    const started = clock();
    if (request.trial.profileId !== this.profile.id) {
      return crashedResult(
        `adapter profile "${this.profile.id}" cannot run trial profile "${request.trial.profileId}"`,
        elapsed(started, clock()),
      );
    }
    if (
      this.dependencies.contextCompaction !== undefined &&
      this.dependencies.contextCompaction.mode !== this.profile.id
    ) {
      return crashedResult(
        `adapter compaction mode "${this.dependencies.contextCompaction.mode}" does not match profile "${this.profile.id}"`,
        elapsed(started, clock()),
      );
    }
    if (
      this.dependencies.contextCompaction !== undefined &&
      this.dependencies.modelSessionStore === undefined
    ) {
      return crashedResult(
        "context compaction evaluation requires a durable model-session store",
        elapsed(started, clock()),
      );
    }
    try {
      const artifactReopens = { attempts: 0, successes: 0 };
      const artifactStore =
        this.dependencies.artifactStore === undefined
          ? undefined
          : this.dependencies.contextCompaction === undefined
            ? this.dependencies.artifactStore
            : observedArtifactStore(this.dependencies.artifactStore, artifactReopens);
      const executor =
        this.dependencies.contextCompaction === undefined
          ? this.dependencies.executor
          : compactionExecutor(this.dependencies.executor, this.dependencies.contextCompaction);
      const state = await runWorkflow(this.profile.workflow.compiled, {
        cwd: request.workspace.cwd,
        protectedPaths: [join(request.workspace.cwd, request.instruction.path)],
        store: this.dependencies.createStore(runId),
        executor,
        runId,
        ...(this.profile.capabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: this.profile.capabilitySnapshot }),
        ...(this.dependencies.workspaceIsolator === undefined
          ? {}
          : { workspaceIsolator: this.dependencies.workspaceIsolator }),
        ...(artifactStore === undefined ? {} : { artifactStore }),
        ...(this.dependencies.modelSessionStore === undefined
          ? {}
          : { modelSessionStore: this.dependencies.modelSessionStore }),
        ...(this.dependencies.now === undefined ? {} : { now: this.dependencies.now }),
        ...(this.dependencies.signal === undefined ? {} : { signal: this.dependencies.signal }),
      });
      const metrics = metricsFromState(
        this.profile.workflow.compiled,
        state,
        elapsed(started, clock()),
      );
      const contextCompaction =
        this.dependencies.contextCompaction === undefined
          ? undefined
          : await contextCompactionMetrics(
              this.profile.workflow.compiled,
              state,
              this.dependencies.contextCompaction,
              requireModelSessionStore(this.dependencies.modelSessionStore),
              artifactReopens,
            );
      return Object.freeze({
        harness: harnessOutcome(state),
        metrics:
          contextCompaction === undefined
            ? metrics
            : Object.freeze({ ...metrics, contextCompaction }),
      });
    } catch (error) {
      return crashedResult(boundedReason(error), elapsed(started, clock()));
    }
  }
}

function compactionExecutor(
  executor: NodeExecutor,
  contextCompaction: ContextCompactionPolicy,
): NodeExecutor {
  const wrapped: NodeExecutor = {
    execute: async (node, context) =>
      await executor.execute(node, { ...context, contextCompaction }),
  };
  return Object.freeze(wrapped);
}

function observedArtifactStore(
  store: ArtifactStore,
  reopens: { attempts: number; successes: number },
): ArtifactStore {
  const observed: ArtifactStore = {
    retain: async (input) => await store.retain(input),
    read: async (input) => {
      reopens.attempts = safeMetricSum(reopens.attempts, 1);
      const result = await store.read(input);
      reopens.successes = safeMetricSum(reopens.successes, 1);
      return result;
    },
    inspect: async (reference, signal) => await store.inspect(reference, signal),
    list: async (signal) => await store.list(signal),
    setRetention: async (input) => await store.setRetention(input),
    planPrune: async (signal) => await store.planPrune(signal),
    applyPrune: async (input) => await store.applyPrune(input),
  };
  return Object.freeze(observed);
}

async function contextCompactionMetrics(
  workflow: CompiledWorkflow,
  state: RunState,
  policy: ContextCompactionPolicy,
  store: ModelSessionStore,
  artifactReopens: { readonly attempts: number; readonly successes: number },
): Promise<ContextCompactionEvaluationMetrics> {
  const sessions = await Promise.all(
    workflow.nodes.flatMap((node) => {
      const nodeState = state.nodes[node.id];
      return isModelNode(node) && nodeState?.modelSession != null
        ? [store.read({ runId: state.runId, workflowId: workflow.id, nodeId: node.id })]
        : [];
    }),
  );
  const requests = sessions.flatMap((session) =>
    session.events.filter((event) => event.type === "model_request_prepared"),
  );
  const starts = sessions.flatMap((session) =>
    session.events.filter((event) => event.type === "context_compaction_started"),
  );
  const settlements = sessions.flatMap((session) =>
    session.events.filter((event) => event.type === "context_compaction_settled"),
  );
  const summaryUsage = settlements.flatMap((event) =>
    event.settlement.outcome === "interrupted" || event.settlement.usage === undefined
      ? []
      : [event.settlement.usage],
  );
  return Object.freeze({
    mode: policy.mode,
    providerRequestBytes: sumMetrics(requests.map((event) => event.identity.runtimeSurface.bytes)),
    providerRequestEstimatedTokens: sumMetrics(
      requests.map((event) => Math.ceil(event.identity.runtimeSurface.bytes / 4)),
    ),
    attempts: starts.length,
    accepted: settlements.filter((event) => event.settlement.outcome === "accepted").length,
    rejected: settlements.filter((event) => event.settlement.outcome === "rejected").length,
    interrupted: settlements.filter((event) => event.settlement.outcome === "interrupted").length,
    summaryInputTokens: sumMetrics(summaryUsage.map((usage) => usage.inputTokens)),
    summaryOutputTokens: sumMetrics(summaryUsage.map((usage) => usage.outputTokens)),
    summaryCostUsdMicros: sumMetrics(summaryUsage.map((usage) => usage.costUsdMicros)),
    artifactReopenAttempts: artifactReopens.attempts,
    artifactReopenSuccesses: artifactReopens.successes,
  });
}

function requireModelSessionStore(store: ModelSessionStore | undefined): ModelSessionStore {
  if (store === undefined) {
    throw new Error("context compaction evaluation requires a durable model-session store");
  }
  return store;
}

function sumMetrics(values: readonly number[]): number {
  return values.reduce((total, value) => safeMetricSum(total, value), 0);
}

function safeMetricSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("evaluation metric total exceeds a non-negative safe integer");
  }
  return total;
}

function harnessOutcome(state: RunState): EvaluationHarnessOutcome {
  switch (state.status) {
    case "succeeded":
      return Object.freeze({ outcome: "completed", runId: state.runId, reason: null });
    case "failed":
      return Object.freeze({
        outcome: "failed",
        runId: state.runId,
        reason: state.failureReason ?? "workflow failed without a durable reason",
      });
    case "cancelled":
      return Object.freeze({
        outcome: "cancelled",
        runId: state.runId,
        reason: state.failureReason ?? "workflow was cancelled",
      });
    case "resource_exhausted": {
      const timedOut = state.budget?.exhausted.some((item) => item.dimension === "executionMs");
      return Object.freeze({
        outcome: timedOut ? "timed_out" : "failed",
        runId: state.runId,
        reason: state.failureReason ?? "workflow resource budget was exhausted",
      });
    }
    case "running":
    case "waiting_for_approval":
      return Object.freeze({
        outcome: "missing_output",
        runId: state.runId,
        reason: `workflow settled in non-terminal state "${state.status}"`,
      });
  }
}

function metricsFromState(
  workflow: CompiledWorkflow,
  state: RunState,
  wallTimeMs: number,
): EvaluationMetrics {
  const attemptedModels = attemptedNodes(workflow, state, isModelNode);
  const modelEvidence = attemptedModels.map(({ state: node }) => modelUsage(node.evidence));
  const usageComplete = modelEvidence.every((usage) => usage !== undefined);
  const costComplete = attemptedModels.every(({ node, state: nodeState }) =>
    node.type === "child"
      ? nodeState.evidence?.kind === "child"
      : modelUsage(nodeState.evidence) !== undefined,
  );
  const usage = usageComplete
    ? sumUsage(modelEvidence.filter((item): item is AgentModelUsage => item !== undefined))
    : undefined;
  const attemptedAgents = attemptedNodes(workflow, state, (node) => node.type === "agent");
  const hasAttemptedChild =
    attemptedNodes(workflow, state, (node) => node.type === "child").length > 0;
  const agentEvidence = attemptedAgents.map(({ state: node }) =>
    node.evidence?.kind === "agent" ? node.evidence : undefined,
  );
  const activityComplete =
    !hasAttemptedChild &&
    agentEvidence.every((evidence): evidence is AgentEvidence => evidence?.activity !== undefined);
  const activity = activityComplete
    ? agentEvidence.reduce(
        (total, evidence) => ({
          turns: total.turns + (evidence.activity?.turns ?? 0),
          toolCalls: total.toolCalls + (evidence.activity?.toolCalls ?? 0),
          toolErrors: total.toolErrors + (evidence.activity?.toolErrors ?? 0),
        }),
        { turns: 0, toolCalls: 0, toolErrors: 0 },
      )
    : undefined;
  const policyComplete =
    !hasAttemptedChild && agentEvidence.every((evidence) => evidence !== undefined);
  const policyViolations = policyComplete
    ? agentEvidence.reduce(
        (total, evidence) =>
          total +
          (evidence?.policyDecisions.filter((decision) => decision.outcome === "denied").length ??
            0),
        0,
      )
    : null;
  const recoveryAttempts = Object.values(state.nodes).reduce(
    (total, node) => total + node.interruptedAttempts.length,
    0,
  );
  const attemptedTimedNodes = attemptedNodes(workflow, state, isTimedNode);
  const activeTimeComplete = attemptedTimedNodes.every(({ state: node }) => node.evidence !== null);
  return Object.freeze({
    costUsdMicros: costComplete ? state.resources.modelCostUsdMicros : null,
    inputTokens: usage?.inputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    turns: activity?.turns ?? null,
    toolCalls: activity?.toolCalls ?? null,
    toolErrors: activity?.toolErrors ?? null,
    wallTimeMs,
    activeTimeMs: activeTimeComplete ? state.resources.executionMs : null,
    interventions: hasAttemptedChild ? null : countInterventions(state),
    policyViolations,
    recoveryAttempts: hasAttemptedChild ? null : recoveryAttempts,
    recoveryOutcome: hasAttemptedChild
      ? null
      : recoveryAttempts === 0
        ? "not_attempted"
        : state.status === "succeeded"
          ? "succeeded"
          : "failed",
  });
}

function isTimedNode(node: CompiledNode): boolean {
  return (
    node.type === "command" ||
    node.type === "agent" ||
    node.type === "verifier" ||
    node.type === "child"
  );
}

function attemptedNodes(
  workflow: CompiledWorkflow,
  state: RunState,
  predicate: (node: CompiledNode) => boolean,
): readonly { readonly node: CompiledNode; readonly state: RunState["nodes"][string] }[] {
  return workflow.nodes.flatMap((node) => {
    const nodeState = state.nodes[node.id];
    return predicate(node) && nodeState !== undefined && nodeState.attempt > 0
      ? [{ node, state: nodeState }]
      : [];
  });
}

function isModelNode(node: CompiledNode): boolean {
  return (
    node.type === "agent" ||
    (node.type === "verifier" &&
      (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")) ||
    node.type === "child"
  );
}

function modelUsage(evidence: NodeEvidence | null): AgentModelUsage | undefined {
  if (evidence?.kind === "agent") {
    return evidence.usage;
  }
  if (evidence?.kind === "verifier" && evidence.driver === "model") {
    return evidence.usage;
  }
  return undefined;
}

function sumUsage(usages: readonly AgentModelUsage[]): AgentModelUsage {
  return usages.reduce<AgentModelUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      costUsdMicros: total.costUsdMicros + usage.costUsdMicros,
    }),
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
    },
  );
}

function countInterventions(state: RunState): number {
  return Object.values(state.nodes).reduce(
    (total, node) =>
      total +
      Number(node.approval !== null && node.approval.decidedAt !== null) +
      Number(node.workflowApproval !== null && node.workflowApproval.decidedAt !== null) +
      node.agentCommandApprovals.filter((approval) => approval.decidedAt !== null).length,
    0,
  );
}

function crashedResult(reason: string, wallTimeMs: number): HarnessEvaluationResult {
  return Object.freeze({
    harness: Object.freeze({ outcome: "crashed", runId: null, reason: reason.slice(0, 4_096) }),
    metrics: Object.freeze({ ...unavailableEvaluationMetrics(), wallTimeMs }),
  });
}

function elapsed(started: number, completed: number): number {
  const duration = Math.ceil(Math.max(0, completed - started));
  return Number.isSafeInteger(duration) ? duration : 0;
}

function boundedReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
