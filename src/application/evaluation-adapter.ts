import { join } from "node:path";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
} from "../domain/capability/agent-skills.js";
import type { EvaluationOciLease } from "../domain/evaluation/attempt.js";
import type {
  AcpQualificationObservation,
  ContextCompactionEvaluationMetrics,
  DelegationEvaluationObservation,
  EvaluationHarnessOutcome,
  EvaluationMetrics,
  PhaseRoutingObservation,
} from "../domain/evaluation/records.js";
import {
  parseAcpQualificationObservation,
  parseDelegationEvaluationObservation,
  unavailableEvaluationMetrics,
} from "../domain/evaluation/records.js";
import {
  type AgentModelTokenBreakdown,
  type ModelUsageObservation,
  modelUsageObservationFromLegacy,
} from "../domain/run/budget.js";
import type { ContextCompactionPolicy } from "../domain/run/context-compaction.js";
import {
  type AgentEvidence,
  type NodeEvidence,
  type RunState,
  reduceRunEvents,
} from "../domain/run/events.js";
import type {
  ModelSessionModelMessageEvent,
  ModelSessionRequestPreparedEvent,
  ModelSessionRequestSettledEvent,
  ModelSessionState,
} from "../domain/run/model-session.js";
import type { CompiledNode, CompiledWorkflow } from "../domain/workflow/types.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ModelSessionStore, NodeExecutor, RunEventStore, WorkspaceIsolator } from "./ports.js";
import { runWorkflow } from "./run-workflow.js";

export interface HarnessEvaluationRequest {
  readonly planDigest: string;
  readonly purpose?: "acp-interoperability-v1" | "phase-routing-v1" | "delegation-v1";
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
  readonly qualification?: AcpQualificationObservation;
  readonly phaseRouting?: PhaseRoutingObservation;
  readonly delegation?: DelegationEvaluationObservation;
}

export class HarnessUnsafeStateError extends Error {
  override readonly name: string = "HarnessUnsafeStateError";
}

export interface HarnessEvaluationAdapter {
  readonly kind: string;
  assertCurrent?(): Promise<void>;
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
  readonly delegationManagerNodeId?: string;
  readonly assertDelegationExecutorCurrent?: () => Promise<void>;
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

  async assertCurrent(): Promise<void> {
    try {
      await this.profile.assertDelegationExecutorCurrent?.();
    } catch (error) {
      throw new HarnessUnsafeStateError(
        "delegation executor identity changed after evaluation plan admission",
        { cause: error },
      );
    }
  }

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
    await this.assertCurrent();
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
    if (
      this.dependencies.contextCompaction !== undefined &&
      this.dependencies.contextCompaction.mode !== "none" &&
      this.dependencies.artifactStore === undefined
    ) {
      return crashedResult(
        "reference-first context compaction evaluation requires an artifact store",
        elapsed(started, clock()),
      );
    }
    const phaseRoutingProfile =
      this.profile.capabilitySnapshot?.effectiveHarness?.phaseRoutingProfile;
    if (phaseRoutingProfile !== undefined && this.dependencies.modelSessionStore === undefined) {
      return crashedResult(
        "phase-routing evaluation requires a durable model-session store",
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
      const runStore = this.dependencies.createStore(runId);
      const state = await runWorkflow(this.profile.workflow.compiled, {
        cwd: request.workspace.cwd,
        protectedPaths: [join(request.workspace.cwd, request.instruction.path)],
        store: runStore,
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
      const qualification = acpQualificationObservation(this.profile, state);
      const phaseRouting =
        phaseRoutingProfile === undefined
          ? undefined
          : await phaseRoutingObservation(
              this.profile.workflow.compiled,
              state,
              runStore,
              requireModelSessionStore(this.dependencies.modelSessionStore),
              phaseRoutingProfile.profileDigest,
            );
      const delegation =
        request.purpose === "delegation-v1"
          ? await delegationEvaluationObservation(this.profile, state, runStore)
          : undefined;
      return Object.freeze({
        harness: harnessOutcome(state),
        metrics:
          contextCompaction === undefined
            ? metrics
            : metricsWithContextCompaction(metrics, contextCompaction),
        ...(qualification === undefined ? {} : { qualification }),
        ...(phaseRouting === undefined ? {} : { phaseRouting }),
        ...(delegation === undefined ? {} : { delegation }),
      });
    } catch (error) {
      return crashedResult(boundedReason(error), elapsed(started, clock()));
    }
  }
}

interface RoutedRequestEvidence {
  readonly prepared: ModelSessionRequestPreparedEvent;
  readonly settled?: ModelSessionRequestSettledEvent | undefined;
  readonly message?: ModelSessionModelMessageEvent | undefined;
}

async function phaseRoutingObservation(
  workflow: CompiledWorkflow,
  state: RunState,
  runStore: RunEventStore,
  modelSessionStore: ModelSessionStore,
  profileDigest: string,
): Promise<PhaseRoutingObservation | undefined> {
  const requests: RoutedRequestEvidence[] = [];
  await collectRoutedRequests(workflow, state, runStore, modelSessionStore, requests);
  if (requests.length === 0) return undefined;
  if (requests.length > 1_024) {
    throw new Error("phase-routing observation exceeds the request evidence limit");
  }
  for (const request of requests) {
    if (request.prepared.identity.routing?.profileDigest !== profileDigest) {
      throw new Error("model request is missing the admitted phase-routing profile evidence");
    }
  }
  const settled = requests.filter(
    (request): request is RoutedRequestEvidence & { settled: ModelSessionRequestSettledEvent } =>
      request.settled !== undefined,
  );
  const completeCost = requests.every((request) => request.message?.usage !== undefined);
  const completeLatency = settled.length === requests.length;
  return Object.freeze({
    version: 1,
    profileDigest,
    requestCount: requests.length,
    settledRequestCount: settled.length,
    decisionDigests: requests.map(
      (request) => requireRoutingDecision(request.prepared).decisionDigest,
    ),
    costUsdMicros: completeCost
      ? safeObservationTotal(
          requests.map((request) => requireMessageUsage(request).costUsdMicros),
          "phase-routing cost",
        )
      : null,
    latencyMs: completeLatency
      ? safeObservationTotal(
          settled.map((request) => requestLatencyMs(request.prepared, request.settled)),
          "phase-routing latency",
        )
      : null,
  });
}

function requestLatencyMs(
  prepared: ModelSessionRequestPreparedEvent,
  settled: ModelSessionRequestSettledEvent,
): number {
  const latencyMs = Date.parse(settled.at) - Date.parse(prepared.at);
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) {
    throw new Error("phase-routing request timestamps are not monotonic");
  }
  return latencyMs;
}

function safeObservationTotal(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} exceeds the safe evidence range`);
  }
  return total;
}

async function collectRoutedRequests(
  workflow: CompiledWorkflow,
  state: RunState,
  runStore: RunEventStore,
  modelSessionStore: ModelSessionStore,
  output: RoutedRequestEvidence[],
): Promise<void> {
  for (const node of workflow.nodes) {
    const nodeState = state.nodes[node.id];
    if (nodeState?.modelSession !== null && nodeState?.modelSession !== undefined) {
      const session = await modelSessionStore.read({
        runId: state.runId,
        workflowId: state.workflowId,
        nodeId: node.id,
      });
      appendSessionRequests(session, output);
    }
    if (
      node.type === "child" &&
      nodeState?.childRun !== null &&
      nodeState?.childRun !== undefined
    ) {
      const childState = reduceRunEvents(await runStore.read(nodeState.childRun.runId));
      await collectRoutedRequests(
        node.child.workflow,
        childState,
        runStore,
        modelSessionStore,
        output,
      );
    }
  }
}

function appendSessionRequests(session: ModelSessionState, output: RoutedRequestEvidence[]): void {
  for (const prepared of session.events.filter(
    (event): event is ModelSessionRequestPreparedEvent => event.type === "model_request_prepared",
  )) {
    const matches = (event: {
      readonly attempt: number;
      readonly turn: number;
      readonly request: number;
    }) =>
      event.attempt === prepared.attempt &&
      event.turn === prepared.turn &&
      event.request === prepared.request;
    output.push({
      prepared,
      settled: session.events.find(
        (event): event is ModelSessionRequestSettledEvent =>
          event.type === "model_request_settled" && matches(event),
      ),
      message: session.events.find(
        (event): event is ModelSessionModelMessageEvent =>
          event.type === "model_message_committed" && matches(event),
      ),
    });
  }
}

function requireRoutingDecision(request: ModelSessionRequestPreparedEvent) {
  const decision = request.identity.routing;
  if (decision === undefined) throw new Error("model request has no phase-routing decision");
  return decision;
}

function requireMessageUsage(request: RoutedRequestEvidence) {
  const usage = request.message?.usage;
  if (usage === undefined) throw new Error("model request has no complete usage evidence");
  return usage;
}

function acpQualificationObservation(
  profile: FlowWorkflowEvaluationProfile,
  state: RunState,
): AcpQualificationObservation | undefined {
  const snapshot = profile.capabilitySnapshot?.acpAgent;
  if (snapshot === undefined || state.status !== "succeeded") return undefined;
  const resultNodes = profile.workflow.compiled.nodes.filter((node) => node.type === "result");
  if (resultNodes.length !== 1) {
    throw new Error("ACP qualification requires exactly one workflow result node");
  }
  const resultNode = resultNodes[0];
  if (resultNode === undefined || resultNode.result.source.field !== "agent.text") {
    throw new Error("ACP qualification result must source one agent text field");
  }
  const sourceNode = profile.workflow.compiled.nodes.find(
    (node) => node.id === resultNode.result.source.nodeId,
  );
  const resultState = state.nodes[resultNode.id];
  const sourceEvidence = state.nodes[resultNode.result.source.nodeId]?.evidence;
  if (
    sourceNode?.type !== "agent" ||
    resultState?.control?.kind !== "result" ||
    resultState.control.sourceNodeId !== sourceNode.id ||
    sourceEvidence?.kind !== "agent" ||
    sourceEvidence.acp === undefined ||
    sourceEvidence.usageObservation === undefined ||
    sourceEvidence.activity === undefined
  ) {
    throw new Error("ACP qualification run is missing authenticated result evidence");
  }
  const evidence = sourceEvidence;
  const acp = evidence.acp;
  if (acp === undefined) {
    throw new Error("ACP qualification run is missing authenticated executor evidence");
  }
  if (acp.agentName !== snapshot.name || acp.agentDigest !== snapshot.digest) {
    throw new Error("ACP qualification runtime identity does not match its admitted executor");
  }
  return parseAcpQualificationObservation({
    version: 1,
    workflowDigest: profile.workflow.workflowDigest,
    capabilitySnapshotDigest: profile.capabilitySnapshot?.digest,
    agent: { name: snapshot.name, digest: snapshot.digest },
    result: {
      sha256: resultState.control.valueHash,
      bytes: Buffer.byteLength(resultState.control.canonicalValue, "utf8"),
    },
    durationMs: evidence.durationMs,
    activity: evidence.activity,
    policyViolations: evidence.policyDecisions.filter((decision) => decision.outcome === "denied")
      .length,
    terminationStatus: acp.terminationStatus,
    processContainment: acp.processContainment,
    sandbox: acp.sandbox,
    usage: evidence.usageObservation,
    usageProvenance: acp.usageProvenance,
    ...(acp.authorityViolation === undefined ? {} : { authorityViolation: acp.authorityViolation }),
  });
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
  const summaryUsageComplete =
    starts.length === settlements.length &&
    settlements.every(
      (event) => event.settlement.outcome !== "interrupted" && event.settlement.usage !== undefined,
    );
  const summaryMetric = (values: readonly number[]): number | null =>
    starts.length === 0 ? 0 : summaryUsageComplete ? sumMetrics(values) : null;
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
    summaryInputTokens: summaryMetric(summaryUsage.map((usage) => usage.inputTokens)),
    summaryOutputTokens: summaryMetric(summaryUsage.map((usage) => usage.outputTokens)),
    summaryCostUsdMicros: summaryMetric(summaryUsage.map((usage) => usage.costUsdMicros)),
    artifactReopenAttempts: artifactReopens.attempts,
    artifactReopenSuccesses: artifactReopens.successes,
  });
}

function metricsWithContextCompaction(
  metrics: EvaluationMetrics,
  contextCompaction: ContextCompactionEvaluationMetrics,
): EvaluationMetrics {
  const summaryUsageAvailable =
    contextCompaction.summaryInputTokens !== null &&
    contextCompaction.summaryOutputTokens !== null &&
    contextCompaction.summaryCostUsdMicros !== null;
  return Object.freeze({
    ...metrics,
    ...(summaryUsageAvailable
      ? {}
      : {
          costUsdMicros: null,
          inputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
        }),
    contextCompaction,
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

async function delegationEvaluationObservation(
  profile: FlowWorkflowEvaluationProfile,
  state: RunState,
  store: RunEventStore,
): Promise<DelegationEvaluationObservation> {
  const snapshot = profile.capabilitySnapshot?.delegation;
  const managerId = profile.delegationManagerNodeId ?? snapshot?.target.managerNodeId;
  if (managerId === undefined) {
    throw new Error("delegation evaluation profile has no admitted manager target");
  }
  const manager = state.nodes[managerId];
  if (manager === undefined) {
    throw new Error(`delegation evaluation manager "${managerId}" is missing from run state`);
  }
  const violations = new Set<
    DelegationEvaluationObservation["constraints"]["violations"][number]
  >();
  if (
    snapshot !== undefined &&
    (snapshot.target.workflowId !== state.workflowId || snapshot.target.managerNodeId !== managerId)
  ) {
    violations.add("manager_target");
  }
  if (manager.delegations.length > 1) violations.add("call_limit");
  if (snapshot === undefined && manager.delegations.length > 0) violations.add("call_limit");
  const delegation = manager.delegations[0];
  const settlement = delegation?.settlement?.evidence;
  const receipts =
    manager.evidence?.kind === "agent" ? (manager.evidence.delegationReceipts ?? []) : [];
  if (delegation !== undefined && settlement === undefined) violations.add("settlement");
  if (receipts.length !== manager.delegations.length) violations.add("receipt");
  if (
    delegation !== undefined &&
    (delegation.candidateDigest !== snapshot?.candidateDigest ||
      delegation.snapshotDigest !== snapshot.snapshotDigest)
  ) {
    violations.add("child_identity");
  }
  let child: DelegationEvaluationObservation["invocation"]["child"] = null;
  if (settlement !== undefined) {
    const result = settlement.result;
    child = Object.freeze({
      runId: settlement.childRunId,
      workflowId: settlement.workflowId,
      workflowDigest: settlement.workflowDigest,
      resultNodeId: result?.nodeId ?? null,
      resultSchemaDigest: result?.schemaDigest ?? null,
      resultValueHash: result?.valueHash ?? null,
      terminalSequence: settlement.terminalSequence,
      outcome: settlement.outcome,
      resources: settlement.resources,
      ...(settlement.resourceAvailability === undefined
        ? {}
        : { resourceAvailability: settlement.resourceAvailability }),
      durationMs: settlement.durationMs,
      workspaceDisposition: settlement.workspace.disposition,
    });
    if (
      snapshot === undefined ||
      settlement.childRunId !== delegation?.child.runId ||
      settlement.workflowId !== snapshot.child.workflowId ||
      settlement.workflowDigest !== snapshot.child.workflowDigest
    ) {
      violations.add("child_identity");
    }
    if (settlement.outcome !== "succeeded") violations.add("child_outcome");
    if (
      result === null ||
      snapshot === undefined ||
      result.nodeId !== snapshot.child.resultNodeId ||
      result.schemaDigest !== snapshot.child.resultSchemaDigest
    ) {
      violations.add("typed_result");
    }
    if (settlement.workspace.disposition !== "discarded") {
      violations.add("workspace_cleanup");
    }
    if (
      state.resources.nodeStarts < settlement.resources.nodeStarts ||
      state.resources.modelTokens < settlement.resources.modelTokens ||
      state.resources.modelCostUsdMicros < settlement.resources.modelCostUsdMicros ||
      state.resources.executionMs < settlement.resources.executionMs ||
      state.resources.artifactBytes < settlement.resources.artifactBytes
    ) {
      violations.add("resource_accounting");
    }
    try {
      const childState = reduceRunEvents(await store.read(settlement.childRunId));
      const childPackageClosureDigest =
        childState.capabilitySnapshot?.digest ?? calculateCapabilitySnapshotDigest([]);
      if (
        childState.capabilitySnapshot?.delegation !== undefined ||
        snapshot === undefined ||
        childPackageClosureDigest !== snapshot.child.packageClosureDigest
      ) {
        violations.add("authority_attenuation");
      }
    } catch {
      violations.add("authority_attenuation");
    }
  }
  const violationList = Object.freeze([...violations].sort());
  const resourceAvailability = settlement?.resourceAvailability;
  const complete =
    (delegation === undefined || settlement !== undefined) &&
    (resourceAvailability === undefined ||
      (resourceAvailability.modelTokens === "complete" &&
        resourceAvailability.modelCostUsdMicros === "complete"));
  return parseDelegationEvaluationObservation({
    version: 1,
    mode: snapshot === undefined ? "baseline" : "candidate",
    workflowDigest: profile.workflow.workflowDigest,
    packageClosureDigest: calculateCapabilitySnapshotDigest(
      profile.capabilitySnapshot?.packages ?? [],
    ),
    manager: { nodeId: managerId, attempt: manager.attempt, outcome: manager.status },
    authority:
      snapshot === undefined
        ? null
        : {
            candidateDigest: snapshot.candidateDigest,
            snapshotDigest: snapshot.snapshotDigest,
            executorIdentityDigest: snapshot.executor.identityDigest,
            maxDepth: snapshot.maxDepth,
            maxCalls: snapshot.maxCalls,
          },
    invocation: {
      count: delegation === undefined ? 0 : 1,
      prepared: delegation !== undefined,
      settled: settlement !== undefined,
      receipt: settlement !== undefined && receipts.length === 1,
      child,
    },
    constraints: { complete, violations: violationList },
  });
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
  const modelEvidence = attemptedModels.flatMap(({ state: node }) =>
    terminalAttemptEvidence(node).map(modelUsageObservation),
  );
  const tokenBreakdownComplete =
    attemptedModels.every(({ state: node }) => node.interruptedAttempts.length === 0) &&
    modelEvidence.every(
      (usage) =>
        usage?.modelTokens.status === "complete" && usage.modelTokens.breakdown !== undefined,
    );
  const costComplete = attemptedModels.every(({ node, state: nodeState }) =>
    node.type === "child"
      ? nodeState.evidence?.kind === "child" &&
        nodeState.evidence.resourceAvailability?.modelCostUsdMicros !== "unavailable"
      : nodeState.interruptedAttempts.length === 0 &&
        terminalAttemptEvidence(nodeState).every(
          (evidence) => modelUsageObservation(evidence)?.costUsd.status === "complete",
        ),
  );
  const usage = tokenBreakdownComplete
    ? sumTokenBreakdowns(
        modelEvidence.flatMap((item) =>
          item?.modelTokens.status === "complete" && item.modelTokens.breakdown !== undefined
            ? [item.modelTokens.breakdown]
            : [],
        ),
      )
    : undefined;
  const attemptedAgents = attemptedNodes(workflow, state, (node) => node.type === "agent");
  const hasAttemptedChild =
    attemptedNodes(workflow, state, (node) => node.type === "child").length > 0;
  const agentEvidence = attemptedAgents.flatMap(({ state: node }) =>
    terminalAttemptEvidence(node).map((evidence) =>
      evidence?.kind === "agent" ? evidence : undefined,
    ),
  );
  const activityComplete =
    !hasAttemptedChild &&
    attemptedAgents.every(({ state: node }) => node.interruptedAttempts.length === 0) &&
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
    !hasAttemptedChild &&
    attemptedAgents.every(({ state: node }) => node.interruptedAttempts.length === 0) &&
    agentEvidence.every((evidence) => evidence !== undefined);
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
    (total, node) => total + node.interruptedAttempts.length + node.failedAttempts.length,
    0,
  );
  const attemptedTimedNodes = attemptedNodes(workflow, state, isTimedNode);
  const activeTimeComplete = attemptedTimedNodes.every(
    ({ state: node }) =>
      node.interruptedAttempts.length === 0 &&
      terminalAttemptEvidence(node).every((evidence) => evidence !== null),
  );
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

function terminalAttemptEvidence(
  node: RunState["nodes"][string],
): readonly (NodeEvidence | null)[] {
  return [...node.failedAttempts.map((attempt) => attempt.evidence), node.evidence];
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

function modelUsageObservation(evidence: NodeEvidence | null): ModelUsageObservation | undefined {
  if (evidence?.kind === "agent") {
    return (
      evidence.usageObservation ??
      (evidence.usage === undefined ? undefined : modelUsageObservationFromLegacy(evidence.usage))
    );
  }
  if (evidence?.kind === "verifier" && evidence.driver === "model") {
    return (
      evidence.usageObservation ??
      (evidence.usage === undefined ? undefined : modelUsageObservationFromLegacy(evidence.usage))
    );
  }
  return undefined;
}

function sumTokenBreakdowns(usages: readonly AgentModelTokenBreakdown[]): AgentModelTokenBreakdown {
  return usages.reduce<AgentModelTokenBreakdown>(
    (total, usage) => ({
      inputTokens: safeMetricSum(total.inputTokens, usage.inputTokens),
      cacheReadTokens: safeMetricSum(total.cacheReadTokens, usage.cacheReadTokens),
      cacheWriteTokens: safeMetricSum(total.cacheWriteTokens, usage.cacheWriteTokens),
      outputTokens: safeMetricSum(total.outputTokens, usage.outputTokens),
    }),
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
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
