import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DelegationEvaluationSnapshot } from "../domain/adaptation/delegation-evaluation.js";
import {
  createPhaseRoutingDecision,
  type PhaseRoutingDecision,
} from "../domain/adaptation/phase-routing-candidate.js";
import { renderSupplementalMemoryBlock } from "../domain/adaptation/supplemental-memory.js";
import { renderSupplementalMemoryRelationshipBlock } from "../domain/adaptation/supplemental-memory-relationships.js";
import { AGENT_COMMAND_PROTOCOL, type AgentCommandRequest } from "../domain/agent-command.js";
import {
  agentCommandApprovalRequestId,
  calculateAgentCommandApprovalRequestDigest,
  calculateCommandApprovalOperationDigest,
  commandApprovalRequestId,
  createAgentCommandApprovalRequest,
  createCommandApprovalOperation,
  isValidApprovalActor,
} from "../domain/approval/command-approval.js";
import {
  calculateWorkflowApprovalRequestDigest,
  workflowApprovalEvidenceTruncationMessage,
  workflowApprovalRequestId,
} from "../domain/approval/workflow-approval.js";
import {
  calculateCapabilitySnapshotDigest,
  type CapabilitySnapshot,
  createAgentCapabilityEvidence,
  validateCapabilitySnapshot,
} from "../domain/capability/agent-skills.js";
import type { VerifierPackageUseEvidence } from "../domain/capability/verifier-packages.js";
import {
  bindWorkflowCapabilities,
  collectWorkflowPackageReferences,
  resolveVerifierPackageNode,
} from "../domain/capability/workflow-capabilities.js";
import { renderGoalWorkspaceContext } from "../domain/goal/workspace.js";
import { assertWorkflowSatisfiesPolicyPackages } from "../domain/policy/policy-package-admission.js";
import type { PolicyDecision } from "../domain/policy/types.js";
import {
  evaluateOptimizationBaseline,
  evaluateOptimizationCandidate,
} from "../domain/result/optimization-result.js";
import {
  evaluateTypedResult,
  resultSourceTruncationMessage,
  TypedResultError,
} from "../domain/result/typed-result.js";
import {
  type AgentCapabilityRequirement,
  type AgentDelegationReceipt,
  type AgentCommandSettlementOutcome,
  type AgentEffectReceipt,
  type AgentRecoveryRequirement,
  appendRunEvent,
  type ChildEvidence,
  type ChildResultEvidence,
  type ChildRunLink,
  type ControlGraph,
  calculateChildRunId,
  calculateOptimizationPromotionId,
  DURABLE_EFFECT_PROTOCOL,
  type ExecutionWorkspaceProvenance,
  type FilesystemEditEffectDescriptor,
  loopLimitFailureMessage,
  type NodeEffectReconciledEvent,
  type NodeEffectSettlementInput,
  type NodeFailure,
  nodeDelegationId,
  type NodeOptimizationEvaluatedEvent,
  nodeAgentCommandId,
  nodeEffectId,
  type OptimizationCheckRunState,
  type OptimizationPromotionBoundary,
  type RunBudgetExhaustedEvent,
  type RunCancelledEvent,
  type RunEvent,
  type RunFailedEvent,
  RunReplayError,
  type RunResumedEvent,
  type RunStartedEvent,
  type RunState,
  reduceRunEvents,
  type ToolPackageRequirement,
  type VerifierPackageRequirement,
  type WorkflowPackageRequirement,
} from "../domain/run/events.js";
import {
  type ModelSessionEventInput,
  type ModelSessionIdentity,
  type ModelSessionState,
  modelSessionSummary,
} from "../domain/run/model-session.js";
import { createModelWorkProfileContext } from "../domain/run/work-profile.js";
import {
  projectCompiledControlGraph,
  workflowRequiresControlGraph,
} from "../domain/workflow/control-graph.js";
import { calculateWorkflowDigest } from "../domain/workflow/digest.js";
import { compileWorkflowText } from "../domain/workflow/compiler.js";
import type {
  CompiledAgentNode,
  CompiledApprovalNode,
  CompiledChildNode,
  CompiledCommandNode,
  CompiledConditionNode,
  CompiledJoinNode,
  CompiledLoopCheckNode,
  CompiledLoopNode,
  CompiledNode,
  CompiledOptimizationCheckNode,
  CompiledOptimizationNode,
  CompiledResultNode,
  CompiledVerifierNode,
  CompiledWorkflow,
  EvidenceSourceField,
  WorkProfile,
} from "../domain/workflow/types.js";
import { MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES } from "../domain/workflow/types.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalDecisionSource,
  AgentCommandApprovalWait,
  CandidatePromotionRequest,
  CandidatePromotionSettlement,
  CandidateWorkspaceManager,
  IsolatedWorkspace,
  LeanProofFaithfulnessApprovalContext,
  ModelSessionJournal,
  ModelSessionStore,
  NodeAgentCommandApprovalGate,
  NodeAgentCommandJournal,
  NodeEffectJournal,
  NodeEffectReconciler,
  NodeDelegationSession,
  NodeExecutionOutcome,
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
  VerifierSourceInput,
  WorkspaceIsolator,
} from "./ports.js";
import { AgentCommandApprovalDecisionSourceError } from "./ports.js";

export interface RunWorkflowOptions {
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly protectedPaths: readonly string[];
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly store: RunEventStore;
  readonly executor: NodeExecutor;
  readonly workspaceIsolator?: WorkspaceIsolator;
  readonly executionWorkspace?: ExecutionWorkspaceProvenance;
  readonly runId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly agentCommandApprovalDecisions?: AgentCommandApprovalDecisionSource;
  readonly artifactStore?: ArtifactStore;
  readonly workProfile?: WorkProfile;
  readonly modelSessionStore?: ModelSessionStore;
}

export interface ResumeWorkflowOptions extends Omit<RunWorkflowOptions, "runId" | "store"> {
  readonly runId: string;
  readonly store: RecoverableRunEventStore;
  readonly effectReconciler?: NodeEffectReconciler;
}

const effectiveHarnessChildPath = Symbol("effective-harness-child-path");
const delegationObjective = Symbol("delegation-objective");
type InternalRunWorkflowOptions = RunWorkflowOptions & {
  readonly [effectiveHarnessChildPath]?: readonly string[];
  readonly [delegationObjective]?: string;
};
type InternalResumeWorkflowOptions = ResumeWorkflowOptions & {
  readonly [effectiveHarnessChildPath]?: readonly string[];
  readonly [delegationObjective]?: string;
};

export async function runWorkflow(
  workflow: CompiledWorkflow,
  options: RunWorkflowOptions,
): Promise<RunState> {
  return await runWorkflowInternal(workflow, options);
}

async function runWorkflowInternal(
  workflow: CompiledWorkflow,
  options: InternalRunWorkflowOptions,
): Promise<RunState> {
  assertNotAborted(options.signal);
  const capabilitySnapshot = bindWorkflowCapabilities(workflow, options.capabilitySnapshot, {
    allowUnexpected:
      options.executionWorkspace?.parentRunId !== undefined ||
      options.capabilitySnapshot?.delegation !== undefined,
  });
  assertWorkflowSatisfiesPolicyPackages(workflow, capabilitySnapshot);
  assertPhaseRoutingRuntimeSupported(capabilitySnapshot);
  const runId = options.runId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const executionCwd = resolve(options.cwd);
  const workProfile = options.workProfile ?? workflow.workProfile ?? "standard";
  return await releaseAfter(options.store, runId, async () => {
    const approvalRequirements = commandApprovalRequirements(workflow);
    const agentCommandApprovalRequirements = workflowAgentCommandApprovalRequirements(workflow);
    const capabilityRequirements = agentCapabilityRequirements(workflow);
    const verifierPackageRequirements = workflowVerifierPackageRequirements(workflow);
    const toolPackageRequirements = workflowToolPackageRequirements(workflow);
    const workflowPackageRequirements = collectWorkflowPackageReferences(workflow);
    const recoveryRequirements = agentRecoveryRequirements(workflow);
    const controlGraph = workflowControlGraph(workflow);
    const started: RunStartedEvent = {
      ...eventBase(workflow, runId, 1, now),
      type: "run_started",
      nodeIds: workflow.nodes.map((node) => node.id),
      workflowApiVersion: workflow.apiVersion,
      workflowDigest: calculateWorkflowDigest(workflow),
      workProfile,
      ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      executionCwd,
      ...(options.executionWorkspace === undefined
        ? {}
        : { executionWorkspace: options.executionWorkspace }),
      ...(workflow.budget === undefined ? {} : { budget: workflow.budget }),
      ...(workflow.concurrency === undefined ? {} : { concurrency: workflow.concurrency }),
      ...(approvalRequirements.length === 0 ? {} : { approvalRequirements }),
      ...(agentCommandApprovalRequirements.length === 0
        ? {}
        : { agentCommandApprovalRequirements }),
      ...(capabilityRequirements.length === 0 ? {} : { capabilityRequirements }),
      ...(verifierPackageRequirements.length === 0 ? {} : { verifierPackageRequirements }),
      ...(toolPackageRequirements.length === 0 ? {} : { toolPackageRequirements }),
      ...(workflowPackageRequirements.length === 0 ? {} : { workflowPackageRequirements }),
      ...(recoveryRequirements.length === 0 ? {} : { recoveryRequirements }),
      ...(controlGraph === undefined ? {} : { controlGraph }),
      ...(workflow.goal === undefined ? {} : { goal: workflow.goal }),
    };
    await options.store.append(started);
    return await continueWorkflow(
      workflow,
      {
        ...options,
        cwd: executionCwd,
        workProfile,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      },
      runId,
      appendRunEvent(undefined, started),
      now,
    );
  });
}

export async function resumeWorkflow(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
): Promise<RunState> {
  return await resumeWorkflowWithRelocation(workflow, options);
}

interface RecoveryWorkspaceRelocation {
  readonly fromCwd: string;
  readonly toCwd: string;
}

async function resumeWorkflowWithRelocation(
  workflow: CompiledWorkflow,
  options: InternalResumeWorkflowOptions,
  workspaceRelocation?: RecoveryWorkspaceRelocation,
): Promise<RunState> {
  assertNotAborted(options.signal);
  if (options.capabilitySnapshot !== undefined) {
    const preflightSnapshot = bindWorkflowCapabilities(workflow, options.capabilitySnapshot, {
      allowUnexpected:
        options.executionWorkspace?.parentRunId !== undefined ||
        options.capabilitySnapshot.delegation !== undefined,
    });
    assertWorkflowSatisfiesPolicyPackages(workflow, preflightSnapshot);
    assertPhaseRoutingRuntimeSupported(preflightSnapshot);
  }

  const events = await options.store.claim(options.runId);
  return await releaseAfter(options.store, options.runId, async () => {
    assertNotAborted(options.signal);
    let state = reduceRunEvents(events);
    let persistedCapabilitySnapshot: CapabilitySnapshot | undefined;
    try {
      persistedCapabilitySnapshot = bindWorkflowCapabilities(
        workflow,
        state.capabilitySnapshot ?? undefined,
        {
          allowUnexpected:
            options.executionWorkspace?.parentRunId !== undefined ||
            state.executionWorkspace?.parentRunId !== undefined ||
            state.capabilitySnapshot?.delegation !== undefined,
        },
      );
      assertWorkflowSatisfiesPolicyPackages(workflow, persistedCapabilitySnapshot);
      assertPhaseRoutingRuntimeSupported(persistedCapabilitySnapshot);
    } catch (error) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${options.runId}" capability history is incompatible: ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (
      options.capabilitySnapshot !== undefined &&
      options.capabilitySnapshot.digest !== persistedCapabilitySnapshot?.digest
    ) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${options.runId}" capability snapshot does not match durable history`,
      );
    }
    if (options.workProfile !== undefined && options.workProfile !== state.workProfile) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${options.runId}" work profile does not match durable history`,
      );
    }
    const effectiveOptions: ResumeWorkflowOptions = {
      ...options,
      workProfile: state.workProfile,
      ...(persistedCapabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: persistedCapabilitySnapshot }),
    };
    const executionCwd = resolve(options.cwd);
    const now = options.now ?? (() => new Date());
    validateRecoveryCompatibility(
      workflow,
      options.runId,
      executionCwd,
      options.executionWorkspace,
      workspaceRelocation,
      state,
      events,
    );
    if (state.executionCwd !== executionCwd && workspaceRelocation !== undefined) {
      const relocated: RunResumedEvent = {
        ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
        type: "run_resumed",
        workspaceRelocation,
      };
      await options.store.append(relocated);
      state = appendRunEvent(state, relocated);
    }
    await validateRecoveredChildTrees(workflow, effectiveOptions, state);
    state = await reconcileOpenEffects(workflow, effectiveOptions, state, now);
    assertNotAborted(options.signal);
    state = await disposeProofSafeInterruptedAttempt(workflow, effectiveOptions, state, now);
    state = await recoverOpenChildAttempts(workflow, effectiveOptions, state, now);
    state = await recoverOpenDelegationAttempts(workflow, effectiveOptions, state, now);
    rejectOpenAttempt(options.runId, state);
    const resumed: RunResumedEvent = {
      ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
      type: "run_resumed",
    };
    await options.store.append(resumed);
    state = appendRunEvent(state, resumed);
    return await continueWorkflow(
      workflow,
      { ...effectiveOptions, cwd: executionCwd },
      options.runId,
      state,
      now,
    );
  });
}

async function continueWorkflow(
  workflow: CompiledWorkflow,
  options: Omit<InternalRunWorkflowOptions, "runId">,
  runId: string,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  let publicationTail = Promise.resolve();
  let publicationPoisoned = false;
  let publicationFailure: unknown;
  let agentCommandApprovalTail = Promise.resolve();

  async function record(event: RunEvent): Promise<void> {
    await publish(async () => {
      await append(event);
    });
  }

  async function append(event: RunEvent): Promise<void> {
    const nextState = appendRunEvent(state, event);
    await options.store.append(event);
    state = nextState;
  }

  function publish<T>(operation: () => Promise<T>): Promise<T> {
    const publication = publicationTail.then(async () => {
      if (publicationPoisoned) {
        throw publicationFailure;
      }
      try {
        return await operation();
      } catch (error) {
        publicationPoisoned = true;
        publicationFailure = error;
        throw error;
      }
    });
    publicationTail = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  function nextSequence(): number {
    return state.lastSequence + 1;
  }

  function base(sequence: number, at?: Date) {
    return eventBase(workflow, runId, sequence, now, at);
  }

  const failed = Object.entries(state.nodes).find(([, node]) => node.status === "failed");
  if (failed !== undefined) {
    const [failedNodeId, failedNode] = failed;
    if (failedNode.error === null) {
      throw new Error(`Failed node "${failedNodeId}" has no committed error`);
    }
    if (hasSettlementExhaustion(state)) {
      return await exhaustRun();
    }
    await record({
      ...base(nextSequence()),
      type: "run_failed",
      failedNodeId,
      reason: failedNode.error.message,
    });
    return state;
  }

  workflowLoop: while (!workflowIsTerminal(state)) {
    if ((state.budget?.exhausted.length ?? 0) > 0) {
      return await exhaustRun();
    }
    if (isAborted(options.signal)) {
      return await cancelRun();
    }
    const admitted: Array<{
      readonly node: ExecutableNode;
      readonly executionNode: ExecutableNode;
      readonly attempt: number;
      readonly effectJournal?: NodeEffectJournal;
      readonly agentCommandJournal?: NodeAgentCommandJournal;
      readonly agentCommandApprovalGate?: NodeAgentCommandApprovalGate;
      readonly modelSessionJournal?: ModelSessionJournal;
      readonly verifierSources?: readonly VerifierSourceInput[];
      readonly proofFaithfulnessApproval?: LeanProofFaithfulnessApprovalContext;
      readonly verifierPackage?: VerifierPackageUseEvidence;
      readonly delegationChild?: CompiledChildNode;
      readonly preflightOutcome?: NodeExecutionOutcome;
    }> = [];
    const childBudgetReservations = {
      nodeStarts: 0,
      modelTokens: 0,
      modelCostUsdMicros: 0,
      executionMs: 0,
      artifactBytes: 0,
    };

    while (admitted.length < state.concurrency.maxNodes) {
      const transition = selectNextTransition(workflow.nodes, state);
      if (transition === undefined) {
        if (admitted.length === 0) {
          throw new Error("Compiled workflow has no ready node; compiler invariant was violated");
        }
        break;
      }
      if (transition.kind !== "execute") {
        if (admitted.length > 0) {
          break;
        }
        if (
          transition.kind === "request_approval" &&
          state.nodes[transition.node.id]?.workflowApproval?.status === "pending"
        ) {
          return state;
        }
        if (transition.kind === "evaluate_optimization") {
          await progressOptimizationCheck(transition.node);
          const checkState = state.nodes[transition.node.id];
          if (checkState?.status === "failed") {
            if (checkState.error === null) {
              throw new Error(`Failed optimization check "${transition.node.id}" has no error`);
            }
            await record({
              ...base(nextSequence()),
              type: "run_failed",
              failedNodeId: transition.node.id,
              reason: checkState.error.message,
            });
            return state;
          }
          continue workflowLoop;
        }
        const event = controlTransitionEvent(transition, state, base(nextSequence()));
        await record(event);
        if (event.type === "workflow_approval_requested") {
          return state;
        }
        if (event.type === "node_control_failed") {
          const failed: RunFailedEvent = {
            ...base(nextSequence()),
            type: "run_failed",
            failedNodeId: event.nodeId,
            reason: event.error.message,
          };
          await record(failed);
          return state;
        }
        continue workflowLoop;
      }

      const node = transition.node;
      if (admitted.length > 0 && (node.type === "child") !== (admitted[0]?.node.type === "child")) {
        break;
      }
      const verifierResolution =
        node.type === "verifier"
          ? resolveVerifierPackageNode(node, options.capabilitySnapshot)
          : undefined;
      const executionNode = boundNodeTimeout(verifierResolution?.node ?? node, state);
      const attempt = (state.nodes[node.id]?.attempt ?? 0) + 1;
      const modelSessionJournal =
        isModelBackedNode(executionNode) &&
        (attempt === 1 || state.nodes[node.id]?.modelSession !== null)
          ? await prepareModelSessionAttempt(
              options.modelSessionStore,
              { runId, workflowId: workflow.id, nodeId: node.id },
              executionNode,
              attempt,
              now,
              options.signal,
            )
          : undefined;
      const verifierSources = verifierExecutionSources(executionNode, state, workflow.nodes);
      const proofFaithfulnessApproval = proofFaithfulnessApprovalForNode(executionNode, state);
      const delegationChild = delegationChildForNode(
        options.capabilitySnapshot,
        workflow.id,
        executionNode,
      );
      const preflightOutcome =
        executionNode.type === "child"
          ? childBudgetPreflight(executionNode, state, childBudgetReservations)
          : delegationChild === undefined
            ? undefined
            : childBudgetPreflight(delegationChild, state, childBudgetReservations);
      let approval: { readonly requestId: string; readonly operationDigest: string } | undefined;
      let startTime: Date | undefined;
      if (node.type === "command" && node.approval !== undefined) {
        if (executionNode.type !== "command") {
          throw new Error("bounded command node changed type");
        }
        const operation = createCommandApprovalOperation(executionNode, options.cwd);
        const operationDigest = calculateCommandApprovalOperationDigest(operation);
        const currentApproval = state.nodes[node.id]?.approval ?? null;

        if (currentApproval === null || currentApproval.status === "expired") {
          if (admitted.length > 0) {
            break;
          }
          const sequence = nextSequence();
          await record({
            ...base(sequence),
            type: "command_approval_requested",
            nodeId: node.id,
            attempt,
            requestId: commandApprovalRequestId(sequence),
            grantTtlMs: node.approval.grantTtlMs,
            operation,
            operationDigest,
          });
          return state;
        }
        if (
          currentApproval.operationDigest !== operationDigest ||
          calculateCommandApprovalOperationDigest(currentApproval.operation) !== operationDigest
        ) {
          throw new RunRecoveryError(
            "workflow_mismatch",
            `run "${runId}" approval operation no longer matches command node "${node.id}"`,
          );
        }
        if (currentApproval.status === "pending") {
          if (admitted.length > 0) {
            break;
          }
          return state;
        }
        if (currentApproval.status !== "granted") {
          throw new Error(
            `approval invariant was violated for node "${node.id}" with status "${currentApproval.status}"`,
          );
        }

        startTime = now();
        if (
          currentApproval.expiresAt === null ||
          startTime.getTime() >= Date.parse(currentApproval.expiresAt)
        ) {
          if (admitted.length > 0) {
            break;
          }
          await record({
            ...base(nextSequence(), startTime),
            type: "command_approval_expired",
            nodeId: node.id,
            attempt,
            requestId: currentApproval.requestId,
            operationDigest,
          });
          continue workflowLoop;
        }
        approval = {
          requestId: currentApproval.requestId,
          operationDigest,
        };
      }

      try {
        await record({
          ...base(nextSequence(), startTime),
          type: "node_started",
          nodeId: node.id,
          attempt,
          ...(node.type === "child" ? { child: createChildRunLink(runId, node, attempt) } : {}),
          ...(approval === undefined ? {} : { approval }),
          ...(supportsDurableEffects(node) ? { effectProtocol: DURABLE_EFFECT_PROTOCOL } : {}),
          ...(supportsAgentCommands(node) ? { commandProtocol: AGENT_COMMAND_PROTOCOL } : {}),
          ...(modelSessionJournal === undefined
            ? {}
            : { modelSession: modelSessionSummary(modelSessionJournal.state) }),
        });
      } catch (error) {
        if (modelSessionJournal !== undefined && options.modelSessionStore !== undefined) {
          await options.modelSessionStore
            .release(modelSessionIdentity(modelSessionJournal.state))
            .catch(() => undefined);
        }
        throw error;
      }
      const effectJournal = supportsDurableEffects(node)
        ? createEffectJournal(node.id, attempt)
        : undefined;
      const agentCommandJournal = supportsAgentCommands(node)
        ? createAgentCommandJournal(node.id, attempt)
        : undefined;
      const agentCommandApprovalGate = requiresAgentCommandApproval(node)
        ? createAgentCommandApprovalGate(node.id, attempt, node.agent.toolApproval.exec.grantTtlMs)
        : undefined;
      admitted.push({
        node,
        executionNode,
        attempt,
        ...(effectJournal === undefined ? {} : { effectJournal }),
        ...(agentCommandJournal === undefined ? {} : { agentCommandJournal }),
        ...(agentCommandApprovalGate === undefined ? {} : { agentCommandApprovalGate }),
        ...(modelSessionJournal === undefined ? {} : { modelSessionJournal }),
        ...(verifierSources === undefined ? {} : { verifierSources }),
        ...(proofFaithfulnessApproval === undefined ? {} : { proofFaithfulnessApproval }),
        ...(verifierResolution?.package === undefined
          ? {}
          : { verifierPackage: verifierResolution.package }),
        ...(delegationChild === undefined ? {} : { delegationChild }),
        ...(preflightOutcome === undefined ? {} : { preflightOutcome }),
      });
      if (preflightOutcome === undefined) {
        if (executionNode.type === "child") {
          reserveChildBudget(executionNode, childBudgetReservations);
        } else if (delegationChild !== undefined) {
          reserveChildBudget(delegationChild, childBudgetReservations);
        }
      }
      if (preflightOutcome !== undefined) {
        break;
      }
      if ((state.budget?.exhausted.length ?? 0) > 0) {
        break;
      }
    }

    const modelWorkProfile = createModelWorkProfileContext(state.workProfile, state.budget);
    const settlements = await Promise.all(
      admitted.map(
        async ({
          executionNode,
          attempt,
          effectJournal,
          agentCommandJournal,
          agentCommandApprovalGate,
          modelSessionJournal,
          verifierSources,
          proofFaithfulnessApproval,
          verifierPackage,
          delegationChild,
          preflightOutcome,
        }) => {
          const abortedBeforeExecution = isAborted(options.signal);
          const agentSupplementalMemory =
            executionNode.type === "agent"
              ? supplementalMemoryForAgent(
                  options.capabilitySnapshot,
                  options[effectiveHarnessChildPath] ?? [],
                  executionNode.id,
                )
              : undefined;
          const agentGoalWorkspace =
            executionNode.type === "agent"
              ? goalWorkspaceForAgent(options.capabilitySnapshot)
              : undefined;
          const agentDelegationObjective =
            executionNode.type === "agent"
              ? delegationObjectiveSystemPrompt(options[delegationObjective])
              : undefined;
          const modelBacked = isModelBackedNode(executionNode);
          const phaseRouting = modelBacked
            ? phaseRoutingForNode(
                options.capabilitySnapshot,
                options[effectiveHarnessChildPath] ?? [],
                executionNode,
              )
            : undefined;
          const delegationSnapshot = options.capabilitySnapshot?.delegation;
          const delegationSession =
            delegationChild === undefined
              ? undefined
              : delegationSnapshot === undefined
                ? (() => {
                    throw new Error("delegation child has no capability snapshot");
                  })()
                : createNodeDelegationSession({
                    snapshot: delegationSnapshot,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    execute: async (signal) =>
                      await executeChildNode(
                        delegationChild,
                        {
                          runId,
                          workflowId: workflow.id,
                          nodeId: executionNode.id,
                          attempt,
                          cwd: options.cwd,
                          ...(options.projectRoot === undefined
                            ? {}
                            : { projectRoot: options.projectRoot }),
                          protectedPaths: options.protectedPaths,
                          ...(signal === undefined ? {} : { signal }),
                        },
                        options,
                        now,
                        capabilitySnapshotWithoutDelegation(options.capabilitySnapshot),
                        delegationSnapshot.objective.text,
                      ),
                    prepare: async () => {
                      const sequence = nextSequence();
                      const delegationId = nodeDelegationId(sequence);
                      await record({
                        ...base(sequence),
                        type: "node_delegation_prepared",
                        nodeId: executionNode.id,
                        attempt,
                        delegationSequence: 1,
                        delegationId,
                        candidateDigest: delegationSnapshot.candidateDigest,
                        snapshotDigest: delegationSnapshot.snapshotDigest,
                        child: createChildRunLink(runId, delegationChild, attempt),
                      });
                      return delegationId;
                    },
                    settle: async (delegationId, evidence) => {
                      await record({
                        ...base(nextSequence()),
                        type: "node_delegation_settled",
                        nodeId: executionNode.id,
                        attempt,
                        delegationSequence: 1,
                        delegationId,
                        candidateDigest: delegationSnapshot.candidateDigest,
                        snapshotDigest: delegationSnapshot.snapshotDigest,
                        evidence,
                      });
                    },
                  });
          const outcome = abortedBeforeExecution
            ? executionNode.type === "child"
              ? childFailure("child_cancelled_before_start", abortReason(options.signal))
              : abortedOutcome(options.signal)
            : preflightOutcome !== undefined
              ? preflightOutcome
              : await executeNode(
                  executionNode,
                  options.executor,
                  {
                    runId,
                    workflowId: workflow.id,
                    nodeId: executionNode.id,
                    attempt,
                    cwd: options.cwd,
                    ...(options.projectRoot === undefined
                      ? {}
                      : { projectRoot: options.projectRoot }),
                    protectedPaths: options.protectedPaths,
                    ...(options.capabilitySnapshot === undefined
                      ? {}
                      : { capabilitySnapshot: options.capabilitySnapshot }),
                    ...(options.artifactStore === undefined
                      ? {}
                      : { artifactStore: options.artifactStore }),
                    ...(effectJournal === undefined ? {} : { effectJournal }),
                    ...(agentCommandJournal === undefined ? {} : { agentCommandJournal }),
                    ...(agentCommandApprovalGate === undefined ? {} : { agentCommandApprovalGate }),
                    ...(delegationSession === undefined ? {} : { delegationSession }),
                    ...(modelSessionJournal === undefined
                      ? {}
                      : { modelSession: modelSessionJournal }),
                    ...(verifierSources === undefined ? {} : { verifierSources }),
                    ...(proofFaithfulnessApproval === undefined
                      ? {}
                      : { proofFaithfulnessApproval }),
                    ...(verifierPackage === undefined ? {} : { verifierPackage }),
                    ...(agentGoalWorkspace === undefined ? {} : { agentGoalWorkspace }),
                    ...(agentDelegationObjective === undefined
                      ? {}
                      : { agentSystemPrompt: agentDelegationObjective }),
                    ...(agentSupplementalMemory === undefined ? {} : { agentSupplementalMemory }),
                    ...(modelBacked ? { modelWorkProfile } : {}),
                    ...(phaseRouting === undefined ? {} : { phaseRouting }),
                    ...(executionNode.type !== "agent" ||
                    executionNode.agent.contextCompaction === undefined
                      ? {}
                      : { contextCompaction: executionNode.agent.contextCompaction }),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                  },
                  options,
                  now,
                );
          return { outcome, abortedBeforeExecution };
        },
      ),
    );
    await publicationTail;

    for (const [index, admission] of admitted.entries()) {
      const settlement = settlements[index];
      if (settlement === undefined) {
        throw new Error(`node "${admission.node.id}" has no executor settlement`);
      }
      const { outcome, abortedBeforeExecution } = settlement;
      const abortAfterSuccessfulExecution =
        isAborted(options.signal) &&
        outcome.status === "succeeded" &&
        admission.node.type !== "child";
      const interruptedOutcome = abortAfterSuccessfulExecution
        ? abortedOutcome(options.signal, outcome.evidence)
        : outcome;
      const retrySafeOutcome =
        admission.effectJournal === undefined
          ? interruptedOutcome
          : normalizeUnknownEffectRetryability(admission.node.id, interruptedOutcome);
      const authoritativeOutcome =
        admission.effectJournal === undefined ||
        (!abortedBeforeExecution && !abortAfterSuccessfulExecution)
          ? retrySafeOutcome
          : normalizeWorkflowAbortEffectStatus(admission.node.id, retrySafeOutcome);
      const modelSession =
        admission.modelSessionJournal === undefined
          ? undefined
          : await settleModelSessionAttempt(
              options.modelSessionStore,
              admission.modelSessionJournal,
              admission.attempt,
              authoritativeOutcome,
            );

      if (authoritativeOutcome.status === "failed") {
        await record({
          ...base(nextSequence()),
          type: "node_failed",
          nodeId: admission.node.id,
          attempt: admission.attempt,
          error: authoritativeOutcome.error,
          evidence: authoritativeOutcome.evidence,
          ...(modelSession === undefined ? {} : { modelSession }),
        });
      } else {
        await record({
          ...base(nextSequence()),
          type: "node_succeeded",
          nodeId: admission.node.id,
          attempt: admission.attempt,
          evidence: authoritativeOutcome.evidence,
          ...(modelSession === undefined ? {} : { modelSession }),
        });
      }
    }

    if (hasSettlementExhaustion(state) || hasPendingStartExhaustion(state)) {
      return await exhaustRun();
    }
    const failedNodeIds = Object.entries(state.nodes)
      .filter(([, node]) => node.status === "failed")
      .map(([nodeId]) => nodeId);
    if (isAborted(options.signal)) {
      return await cancelRun(failedNodeIds);
    }
    const primaryFailure = failedNodeIds[0];
    if (primaryFailure !== undefined) {
      const error = state.nodes[primaryFailure]?.error;
      if (error === null || error === undefined) {
        throw new Error(`Failed node "${primaryFailure}" has no committed error`);
      }
      await record({
        ...base(nextSequence()),
        type: "run_failed",
        failedNodeId: primaryFailure,
        reason: error.message,
      });
      return state;
    }
  }

  if (state.budget?.exhausted.some((item) => item.dimension !== "nodeStarts") === true) {
    return await exhaustRun();
  }
  if (isAborted(options.signal)) {
    return await cancelRun();
  }

  await record({
    ...base(nextSequence()),
    type: "run_succeeded",
  });
  return state;

  async function progressOptimizationCheck(node: CompiledOptimizationCheckNode): Promise<void> {
    const manager = candidateWorkspaceManager(options.workspaceIsolator);
    if (manager === null) {
      await failOptimizationCheck(
        node,
        "candidate_runtime_unavailable",
        "optimization candidates require a candidate workspace manager",
        "none",
      );
      return;
    }

    let check = state.nodes[node.id];
    if (check === undefined) {
      throw new Error(`optimization check "${node.id}" has no run state`);
    }
    if (check.optimization === null) {
      let evaluation: NodeOptimizationEvaluatedEvent;
      try {
        evaluation = await createOptimizationEvaluationEvent(
          node,
          state,
          manager,
          options.cwd,
          options.protectedPaths,
          base(nextSequence()),
        );
      } catch (error) {
        await failOptimizationCheck(
          node,
          optimizationFailureCode(error, "candidate_evaluation_failed"),
          boundedFailureMessage(error instanceof Error ? error.message : String(error)),
          "none",
        );
        return;
      }
      await record(evaluation);
      check = state.nodes[node.id];
    }

    let optimization = check?.optimization;
    if (optimization === null || optimization === undefined) {
      throw new Error(`optimization check "${node.id}" has no durable evaluation`);
    }
    if (optimization.decision === "promote") {
      const request = optimizationPromotionRequest(
        optimization,
        options.cwd,
        options.protectedPaths,
      );
      try {
        if (optimization.preparedAt === null) {
          await manager.promoteCandidateDelta(request, {
            prepare: async (boundary) => {
              await record({
                ...base(nextSequence()),
                type: "node_optimization_promotion_prepared",
                nodeId: node.id,
                attempt: 1,
                optimizationId: node.optimizationCheck.optimizationId,
                candidate: node.optimizationCheck.candidate,
                promotion: boundary,
              });
            },
            settle: async (settlement) => {
              await record(
                optimizationSettlementEvent(node, request, settlement, base(nextSequence())),
              );
            },
          });
        } else if (optimization.settlement === null) {
          const settlement = await manager.reconcileCandidatePromotion(request);
          await record(
            optimizationSettlementEvent(node, request, settlement, base(nextSequence())),
          );
        }
      } catch (error) {
        const latest = state.nodes[node.id]?.optimization;
        const failureCode = optimizationFailureCode(error, "candidate_promotion_failed");
        await failOptimizationCheck(
          node,
          failureCode,
          boundedFailureMessage(error instanceof Error ? error.message : String(error)),
          latest?.settlement?.outcome === "unknown" ||
            failureCode === "candidate_promotion_uncertain"
            ? "uncertain"
            : latest?.settlement?.outcome === "committed"
              ? "committed"
              : "none",
        );
        return;
      }
      check = state.nodes[node.id];
      optimization = check?.optimization;
      if (optimization === null || optimization === undefined) {
        throw new Error(`optimization check "${node.id}" lost its durable evaluation`);
      }
      if (optimization.settlement?.outcome !== "committed") {
        const outcome = optimization.settlement?.outcome;
        await failOptimizationCheck(
          node,
          outcome === "unknown"
            ? "candidate_promotion_uncertain"
            : "candidate_promotion_rolled_back",
          outcome === "unknown"
            ? `optimization promotion for "${node.id}" has an uncertain affected path`
            : `optimization promotion for "${node.id}" was rolled back`,
          outcome === "unknown" ? "uncertain" : "none",
        );
        return;
      }
    }

    const candidate = optimizationCandidateEvidence(node, state);
    if (candidate.workspace.disposition === "retained" && optimization.cleanedAt === null) {
      try {
        await options.workspaceIsolator?.cleanup(candidate.childRunId);
      } catch (error) {
        await failOptimizationCheck(
          node,
          "candidate_workspace_cleanup_failed",
          `candidate workspace "${candidate.childRunId}" could not be discarded: ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
          optimization.settlement?.outcome === "committed" ? "committed" : "none",
        );
        return;
      }
      await record({
        ...base(nextSequence()),
        type: "node_optimization_candidate_cleaned",
        nodeId: node.id,
        attempt: 1,
        optimizationId: node.optimizationCheck.optimizationId,
        candidate: node.optimizationCheck.candidate,
        candidateNodeId: node.optimizationCheck.candidateNodeId,
        workspaceId: candidate.childRunId,
        reason: optimization.decision === "promote" ? "promotion_settled" : "rejected",
      });
      optimization = state.nodes[node.id]?.optimization ?? optimization;
    }

    const accepted =
      optimization.decision === "promote" && optimization.settlement?.outcome === "committed";
    const priorBestCandidate = optimizationPriorBestCandidate(node, state);
    await record({
      ...base(nextSequence()),
      type: "node_optimization_checked",
      nodeId: node.id,
      attempt: 1,
      optimizationId: node.optimizationCheck.optimizationId,
      candidate: node.optimizationCheck.candidate,
      outcome: accepted ? "accepted" : "rejected",
      reason: optimization.reason,
      bestValueHash: accepted
        ? requireOptimizationCandidateValue(optimization.candidateValueHash, node.id)
        : optimization.bestValueHashBefore,
      bestMetric: accepted
        ? requireOptimizationCandidateMetric(optimization.candidateMetric, node.id)
        : optimization.bestMetricBefore,
      bestCandidate: accepted ? node.optimizationCheck.candidate : priorBestCandidate,
      stagnation: optimization.stagnation,
      stop: optimization.stop,
    });
  }

  async function failOptimizationCheck(
    node: CompiledOptimizationCheckNode,
    code: string,
    message: string,
    sideEffectStatus: NodeFailure["sideEffectStatus"],
  ): Promise<void> {
    await record({
      ...base(nextSequence()),
      type: "node_control_failed",
      nodeId: node.id,
      attempt: 1,
      error: {
        code,
        message,
        retryable: false,
        sideEffectStatus,
      },
    });
  }

  function createEffectJournal(nodeId: string, attempt: number): NodeEffectJournal {
    return Object.freeze({
      prepare: async (descriptor: FilesystemEditEffectDescriptor) =>
        await publish(async () => {
          const preparedDescriptor = structuredClone(descriptor);
          const sequence = nextSequence();
          const effectId = nodeEffectId(sequence);
          const effectSequence = (state.nodes[nodeId]?.effects.length ?? 0) + 1;
          await append({
            ...base(sequence),
            type: "node_effect_prepared",
            nodeId,
            attempt,
            effectId,
            effectSequence,
            descriptor: preparedDescriptor,
          });
          let settled = false;
          return Object.freeze({
            effectId,
            effectSequence,
            settle: async (settlement: NodeEffectSettlementInput) =>
              await publish(async () => {
                if (settled) {
                  throw new Error(`effect "${effectId}" is already settled`);
                }
                await append({
                  ...base(nextSequence()),
                  type: "node_effect_settled",
                  nodeId,
                  attempt,
                  effectId,
                  ...settlement,
                });
                settled = true;
                if (settlement.outcome === "not_applied") {
                  return null;
                }
                const receipt: AgentEffectReceipt = Object.freeze({
                  version: 1,
                  sequence: effectSequence,
                  runId,
                  workflowId: workflow.id,
                  nodeId,
                  attempt,
                  kind: preparedDescriptor.kind,
                  target: preparedDescriptor.target,
                  operationDigest: preparedDescriptor.operationDigest,
                  beforeSha256: preparedDescriptor.beforeSha256,
                  afterSha256: preparedDescriptor.afterSha256,
                  outcome: settlement.outcome === "committed" ? "committed" : "uncertain",
                });
                return receipt;
              }),
          });
        }),
    });
  }

  function createAgentCommandApprovalGate(
    nodeId: string,
    attempt: number,
    grantTtlMs: number,
  ): NodeAgentCommandApprovalGate {
    return Object.freeze({
      authorize: async (command: AgentCommandRequest, signal?: AbortSignal) => {
        const approvalSignal = combineAbortSignals(options.signal, signal);
        return await serializeAgentCommandApproval(approvalSignal, async () => {
          const decisions = options.agentCommandApprovalDecisions;
          if (decisions === undefined) {
            throw new AgentCommandApprovalUnavailableError();
          }
          const request = createAgentCommandApprovalRequest({
            runId,
            workflowId: workflow.id,
            nodeId,
            attempt,
            cwd: options.cwd,
            command,
            grantTtlMs,
          });
          const requestDigest = calculateAgentCommandApprovalRequestDigest(request);
          const wait = await publish(async (): Promise<AgentCommandApprovalWait> => {
            const sequence = nextSequence();
            const requestId = agentCommandApprovalRequestId(sequence);
            await append({
              ...base(sequence),
              type: "agent_command_approval_requested",
              nodeId,
              attempt,
              requestId,
              request,
              requestDigest,
            });
            return Object.freeze({ requestId, request, requestDigest });
          });

          let decision: AgentCommandApprovalDecision;
          try {
            decision = await waitForAgentCommandApprovalDecision(decisions, wait, approvalSignal);
          } catch (error) {
            const cancellationReason = isAborted(approvalSignal)
              ? "agent_aborted"
              : error instanceof AgentCommandApprovalDecisionSourceError &&
                  error.code === "decision_invalid"
                ? "decision_invalid"
                : "decision_channel_failed";
            await cancelAgentCommandApproval(wait, cancellationReason);
            if (cancellationReason === "decision_invalid") {
              throw new AgentCommandApprovalDecisionInvalidError();
            }
            throw error;
          }
          if (isAborted(approvalSignal)) {
            await cancelAgentCommandApproval(wait, "agent_aborted");
            throw approvalSignal?.reason ?? new Error("agent command approval wait was cancelled");
          }

          if (!isExactAgentCommandApprovalDecision(decision, wait)) {
            await cancelAgentCommandApproval(wait, "decision_invalid");
            throw new AgentCommandApprovalDecisionInvalidError();
          }
          const actor = decision.actor;
          const reason = decision.reason;
          if (decision.decision === "deny") {
            const committed = await publish(async () => {
              if (isAborted(approvalSignal)) {
                await appendAgentCommandApprovalCancellation(wait, "agent_aborted");
                return false;
              }
              await append({
                ...base(nextSequence()),
                type: "agent_command_approval_denied",
                nodeId,
                attempt,
                requestId: wait.requestId,
                requestDigest,
                operationDigest: request.operationDigest,
                actor,
                ...(reason === undefined ? {} : { reason }),
              });
              return true;
            });
            if (!committed) {
              throw (
                approvalSignal?.reason ?? new Error("agent command approval wait was cancelled")
              );
            }
            throw new AgentCommandApprovalDeniedError(actor, reason);
          }

          const committed = await publish(async () => {
            if (isAborted(approvalSignal)) {
              await appendAgentCommandApprovalCancellation(wait, "agent_aborted");
              return false;
            }
            const grantedAt = now();
            await append({
              ...base(nextSequence(), grantedAt),
              type: "agent_command_approval_granted",
              nodeId,
              attempt,
              requestId: wait.requestId,
              requestDigest,
              operationDigest: request.operationDigest,
              actor,
              expiresAt: new Date(grantedAt.getTime() + grantTtlMs).toISOString(),
            });
            return true;
          });
          if (!committed) {
            throw approvalSignal?.reason ?? new Error("agent command approval wait was cancelled");
          }
          return Object.freeze({
            requestId: wait.requestId,
            requestDigest,
            operationDigest: request.operationDigest,
          });
        });
      },
    });
  }

  async function waitForAgentCommandApprovalDecision(
    source: AgentCommandApprovalDecisionSource,
    wait: AgentCommandApprovalWait,
    signal: AbortSignal | undefined,
  ): Promise<AgentCommandApprovalDecision> {
    while (true) {
      try {
        return await source.waitForDecision(wait, signal);
      } catch (error) {
        if (isAborted(signal)) {
          throw signal?.reason ?? new Error("agent command approval wait was cancelled");
        }
        if (
          !(error instanceof AgentCommandApprovalDecisionSourceError) ||
          error.code !== "temporarily_unavailable"
        ) {
          throw error;
        }
        await abortableApprovalDelay(error.retryAfterMs, signal);
      }
    }
  }

  function serializeAgentCommandApproval<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queued = agentCommandApprovalTail.then(async () => {
      if (isAborted(signal)) {
        throw signal?.reason ?? new Error("agent command approval wait was cancelled");
      }
      return await operation();
    });
    agentCommandApprovalTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function cancelAgentCommandApproval(
    wait: AgentCommandApprovalWait,
    reason: "agent_aborted" | "decision_channel_failed" | "decision_invalid",
  ): Promise<void> {
    await publish(async () => {
      await appendAgentCommandApprovalCancellation(wait, reason);
    });
  }

  async function appendAgentCommandApprovalCancellation(
    wait: AgentCommandApprovalWait,
    reason: "agent_aborted" | "decision_channel_failed" | "decision_invalid",
  ): Promise<void> {
    await append({
      ...base(nextSequence()),
      type: "agent_command_approval_cancelled",
      nodeId: wait.request.nodeId,
      attempt: wait.request.attempt,
      requestId: wait.requestId,
      requestDigest: wait.requestDigest,
      operationDigest: wait.request.operationDigest,
      reason,
    });
  }

  function createAgentCommandJournal(nodeId: string, attempt: number): NodeAgentCommandJournal {
    return Object.freeze({
      prepare: async (input: {
        readonly request: AgentCommandRequest;
        readonly operationDigest: string;
        readonly decision: PolicyDecision;
        readonly approval?: {
          readonly requestId: string;
          readonly requestDigest: string;
          readonly operationDigest: string;
        };
      }) => {
        const result = await publish(async () => {
          const durableInput = structuredClone(input);
          const preparationAt = durableInput.approval === undefined ? undefined : now();
          const approval =
            durableInput.approval === undefined
              ? undefined
              : state.nodes[nodeId]?.agentCommandApprovals.find(
                  (candidate) =>
                    candidate.requestId === durableInput.approval?.requestId &&
                    candidate.status === "granted" &&
                    candidate.requestDigest === durableInput.approval.requestDigest &&
                    candidate.operationDigest === durableInput.approval.operationDigest &&
                    candidate.operationDigest === durableInput.operationDigest &&
                    candidate.request.attempt === attempt,
                );
          if (
            approval?.expiresAt !== null &&
            approval?.expiresAt !== undefined &&
            preparationAt !== undefined &&
            preparationAt.getTime() >= Date.parse(approval.expiresAt)
          ) {
            await append({
              ...base(nextSequence(), preparationAt),
              type: "agent_command_approval_expired",
              nodeId,
              attempt,
              requestId: approval.requestId,
              requestDigest: approval.requestDigest,
              operationDigest: approval.operationDigest,
            });
            return Object.freeze({ kind: "expired" as const, requestId: approval.requestId });
          }
          const sequence = nextSequence();
          const commandId = nodeAgentCommandId(sequence);
          const commandSequence = (state.nodes[nodeId]?.commands.length ?? 0) + 1;
          await append({
            ...base(sequence, preparationAt),
            type: "node_agent_command_prepared",
            nodeId,
            attempt,
            commandId,
            commandSequence,
            ...durableInput,
          });
          let settled = false;
          return Object.freeze({
            kind: "prepared" as const,
            value: Object.freeze({
              commandId,
              commandSequence,
              settle: async (outcome: AgentCommandSettlementOutcome) =>
                await publish(async () => {
                  if (settled) {
                    throw new Error(`command "${commandId}" is already settled`);
                  }
                  await append({
                    ...base(nextSequence()),
                    type: "node_agent_command_settled",
                    nodeId,
                    attempt,
                    commandId,
                    outcome: structuredClone(outcome),
                  });
                  settled = true;
                  return Object.freeze({
                    artifactBudgetExhausted:
                      state.budget?.exhausted.some((item) => item.dimension === "artifactBytes") ===
                      true,
                  });
                }),
            }),
          });
        });
        if (result.kind === "expired") {
          throw new AgentCommandApprovalExpiredError(result.requestId);
        }
        return result.value;
      },
    });
  }

  function normalizeWorkflowAbortEffectStatus(
    nodeId: string,
    outcome: NodeExecutionOutcome,
  ): NodeExecutionOutcome {
    if (outcome.status === "succeeded") {
      return outcome;
    }
    const effects = state.nodes[nodeId]?.effects ?? [];
    if (effects.some((effect) => effect.settlement === null)) {
      return outcome;
    }
    const sideEffectStatus = effects.some((effect) => effect.settlement?.outcome === "unknown")
      ? "uncertain"
      : effects.some((effect) => effect.settlement?.outcome === "committed")
        ? "committed"
        : "none";
    return Object.freeze({
      ...outcome,
      error: Object.freeze({ ...outcome.error, sideEffectStatus }),
    });
  }

  function normalizeUnknownEffectRetryability(
    nodeId: string,
    outcome: NodeExecutionOutcome,
  ): NodeExecutionOutcome {
    if (
      outcome.status === "succeeded" ||
      !outcome.error.retryable ||
      !state.nodes[nodeId]?.effects.some((effect) => effect.settlement?.outcome === "unknown")
    ) {
      return outcome;
    }
    return Object.freeze({
      ...outcome,
      error: Object.freeze({ ...outcome.error, retryable: false }),
    });
  }

  async function cancelRun(cancelledNodeIds: readonly string[] = []): Promise<RunState> {
    const attribution = cancellationAttribution(options.signal);
    const cancelledNodeId = cancelledNodeIds.length === 1 ? cancelledNodeIds[0] : undefined;
    const cancelled: RunCancelledEvent = {
      ...base(nextSequence()),
      type: "run_cancelled",
      reason: abortReason(options.signal),
      ...(cancelledNodeId !== undefined
        ? { cancelledNodeId }
        : cancelledNodeIds.length === 0
          ? {}
          : { cancelledNodeIds }),
      ...(attribution === undefined ? {} : attribution),
    };
    await record(cancelled);
    return state;
  }

  async function exhaustRun(): Promise<RunState> {
    const exhausted = state.budget?.exhausted;
    if (exhausted === undefined || exhausted.length === 0) {
      throw new Error("budget exhaustion invariant was violated");
    }
    const event: RunBudgetExhaustedEvent = {
      ...base(nextSequence()),
      type: "run_budget_exhausted",
      exhausted,
    };
    await record(event);
    return state;
  }
}

function supportsDurableEffects(node: CompiledNode): node is CompiledAgentNode {
  return node.type === "agent" && node.agent.tools.includes("edit");
}

function supportsAgentCommands(node: CompiledNode): node is CompiledAgentNode {
  return (
    node.type === "agent" &&
    (node.agent.tools.includes("exec") || node.agent.toolPackages.length > 0)
  );
}

function requiresAgentCommandApproval(node: CompiledNode): node is CompiledAgentNode & {
  readonly agent: CompiledAgentNode["agent"] & {
    readonly toolApproval: NonNullable<CompiledAgentNode["agent"]["toolApproval"]>;
  };
} {
  return node.type === "agent" && node.agent.toolApproval !== undefined;
}

function createChildRunLink(
  parentRunId: string,
  node: CompiledChildNode,
  attempt: number,
): ChildRunLink {
  return Object.freeze({
    runId: calculateChildRunId(parentRunId, node.id, attempt),
    workflowId: node.child.workflow.id,
    workflowDigest: node.child.workflowDigest,
    resultNodeId: node.child.resultNodeId,
    resultSchemaDigest: node.child.resultSchemaDigest,
    isolationBackend: "reflink-copy-v1",
  });
}

function delegationChildForNode(
  snapshot: CapabilitySnapshot | undefined,
  workflowId: string,
  node: CompiledNode,
): CompiledChildNode | undefined {
  const delegation = snapshot?.delegation;
  if (
    delegation === undefined ||
    delegation.target.workflowId !== workflowId ||
    delegation.target.managerNodeId !== node.id
  ) {
    return undefined;
  }
  if (node.type !== "agent") {
    throw new Error(`delegation target node "${node.id}" is not an agent`);
  }
  const workflow = compileWorkflowText(
    delegation.child.sourceText,
    `delegation child for ${workflowId}/${node.id}`,
  );
  const result = workflow.nodes.find((candidate) => candidate.id === delegation.child.resultNodeId);
  if (result?.type !== "result") {
    throw new Error(`delegation child result node "${delegation.child.resultNodeId}" is missing`);
  }
  return Object.freeze({
    id: node.id,
    type: "child",
    dependsOn: Object.freeze([]),
    child: Object.freeze({
      workflow,
      workflowDigest: delegation.child.workflowDigest,
      resultNodeId: result.id,
      resultSchema: result.result.schema,
      resultSchemaDigest: result.result.schemaDigest,
    }),
  });
}

function capabilitySnapshotWithoutDelegation(
  snapshot: CapabilitySnapshot | undefined,
): CapabilitySnapshot | undefined {
  if (snapshot === undefined || snapshot.packages.length === 0) {
    return undefined;
  }
  return validateCapabilitySnapshot({
    version: 1,
    packages: snapshot.packages,
    digest: calculateCapabilitySnapshotDigest(snapshot.packages),
  });
}

function createNodeDelegationSession(input: {
  readonly snapshot: DelegationEvaluationSnapshot;
  readonly signal?: AbortSignal;
  readonly execute: (signal?: AbortSignal) => Promise<NodeExecutionOutcome>;
  readonly prepare: () => Promise<string>;
  readonly settle: (delegationId: string, evidence: ChildEvidence) => Promise<void>;
}): NodeDelegationSession {
  let invoked = false;
  const receipts: AgentDelegationReceipt[] = [];
  return Object.freeze({
    async delegate(signal?: AbortSignal): Promise<ChildResultEvidence> {
      if (invoked) {
        throw new Error("flow_delegate was already invoked for this manager attempt");
      }
      invoked = true;
      const effectiveSignal = combinedAbortSignal(input.signal, signal);
      assertNotAborted(effectiveSignal);
      const delegationId = await input.prepare();
      const outcome = await input.execute(effectiveSignal);
      if (outcome.evidence?.kind !== "child") {
        throw new Error(`delegation "${delegationId}" has no terminal child evidence`);
      }
      const evidence = outcome.evidence;
      await input.settle(delegationId, evidence);
      receipts.push(
        Object.freeze({
          version: 1,
          sequence: 1,
          candidateDigest: input.snapshot.candidateDigest,
          snapshotDigest: input.snapshot.snapshotDigest,
          childRunId: evidence.childRunId,
          terminalSequence: evidence.terminalSequence,
          outcome: evidence.outcome,
          resultValueHash: evidence.result?.valueHash ?? null,
        }),
      );
      if (outcome.status === "failed") {
        throw new Error(outcome.error.message);
      }
      if (evidence.result === null) {
        throw new Error(`delegation "${delegationId}" succeeded without its typed result`);
      }
      return evidence.result;
    },
    receipts(): readonly AgentDelegationReceipt[] {
      return Object.freeze([...receipts]);
    },
  });
}

function combinedAbortSignal(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignal | undefined {
  if (primary === undefined || primary === secondary) return secondary;
  if (secondary === undefined) return primary;
  return AbortSignal.any([primary, secondary]);
}

interface ChildBudgetReservation {
  nodeStarts: number;
  modelTokens: number;
  modelCostUsdMicros: number;
  executionMs: number;
  artifactBytes: number;
}

function childBudgetPreflight(
  node: CompiledChildNode,
  state: RunState,
  reserved: ChildBudgetReservation,
): NodeExecutionOutcome | undefined {
  const remaining = state.budget?.remaining;
  const child = node.child.workflow.budget;
  if (remaining === undefined || child === undefined) {
    return undefined;
  }
  const unavailable = [
    remaining.nodeStarts !== undefined &&
    1 + reserved.nodeStarts + requireBudgetLimit(child.maxNodeStarts) > remaining.nodeStarts
      ? "nodeStarts"
      : null,
    remaining.modelTokens !== undefined &&
    reserved.modelTokens + requireBudgetLimit(child.maxModelTokens) > remaining.modelTokens
      ? "modelTokens"
      : null,
    remaining.modelCostUsdMicros !== undefined &&
    reserved.modelCostUsdMicros + requireBudgetLimit(child.maxCostUsdMicros) >
      remaining.modelCostUsdMicros
      ? "modelCostUsdMicros"
      : null,
    remaining.executionMs !== undefined &&
    reserved.executionMs + requireBudgetLimit(child.maxExecutionMs) > remaining.executionMs
      ? "executionMs"
      : null,
    remaining.artifactBytes !== undefined &&
    reserved.artifactBytes + requireBudgetLimit(child.maxArtifactBytes) > remaining.artifactBytes
      ? "artifactBytes"
      : null,
  ].filter((value): value is string => value !== null);
  return unavailable.length === 0
    ? undefined
    : childFailure(
        "child_budget_unavailable",
        `child node "${node.id}" ceiling exceeds parent remaining budget for ${unavailable.join(", ")}`,
      );
}

function reserveChildBudget(node: CompiledChildNode, reserved: ChildBudgetReservation): void {
  const budget = node.child.workflow.budget;
  if (budget === undefined) {
    return;
  }
  reserved.nodeStarts = saturatingAdd(
    reserved.nodeStarts,
    requireBudgetLimit(budget.maxNodeStarts),
  );
  reserved.modelTokens = saturatingAdd(
    reserved.modelTokens,
    requireBudgetLimit(budget.maxModelTokens),
  );
  reserved.modelCostUsdMicros = saturatingAdd(
    reserved.modelCostUsdMicros,
    requireBudgetLimit(budget.maxCostUsdMicros),
  );
  reserved.executionMs = saturatingAdd(
    reserved.executionMs,
    requireBudgetLimit(budget.maxExecutionMs),
  );
  reserved.artifactBytes = saturatingAdd(
    reserved.artifactBytes,
    requireBudgetLimit(budget.maxArtifactBytes),
  );
}

function requireBudgetLimit(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("compiled child workflow is missing a required budget limit");
  }
  return value;
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

export const RUN_RECOVERY_ERROR_CODES = [
  "child_recovery_ineligible",
  "execution_context_mismatch",
  "reconciliation_incomplete",
  "reconciliation_unavailable",
  "recovery_retry_ineligible",
  "terminal_run",
  "uncertain_operation",
  "workflow_mismatch",
] as const;

export type RunRecoveryErrorCode = (typeof RUN_RECOVERY_ERROR_CODES)[number];

export class RunRecoveryError extends Error {
  override readonly name = "RunRecoveryError";

  constructor(
    readonly code: RunRecoveryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class RunWorkflowAbortedError extends Error {
  override readonly name = "RunWorkflowAbortedError";
}

export class AgentCommandApprovalUnavailableError extends Error {
  override readonly name = "AgentCommandApprovalUnavailableError";

  constructor() {
    super("agent command approval requires a configured durable decision channel");
  }
}

export class AgentCommandApprovalDecisionInvalidError extends Error {
  override readonly name = "AgentCommandApprovalDecisionInvalidError";

  constructor() {
    super("agent command approval decision does not match the exact pending request");
  }
}

export class AgentCommandApprovalDeniedError extends Error {
  override readonly name = "AgentCommandApprovalDeniedError";

  constructor(
    readonly actor: string,
    readonly reason: string | undefined,
  ) {
    super(`agent command approval denied by ${actor}${reason === undefined ? "" : `: ${reason}`}`);
  }
}

export class AgentCommandApprovalExpiredError extends Error {
  override readonly name = "AgentCommandApprovalExpiredError";

  constructor(readonly requestId: string) {
    super(`agent command approval "${requestId}" expired before command preparation`);
  }
}

export class RunCancellation extends Error {
  override readonly name = "RunCancellation";

  constructor(
    message: string,
    readonly actor: string,
    readonly requestId: string,
  ) {
    super(boundedFailureMessage(message));
    if (!isValidCancellationActor(actor)) {
      throw new RangeError(
        "cancellation actor must be 1-128 characters without control characters",
      );
    }
    if (!UUID_PATTERN.test(requestId)) {
      throw new RangeError("cancellation request id must be a UUID");
    }
  }
}

function validateRecoveryCompatibility(
  workflow: CompiledWorkflow,
  runId: string,
  executionCwd: string,
  executionWorkspace: ExecutionWorkspaceProvenance | undefined,
  workspaceRelocation: RecoveryWorkspaceRelocation | undefined,
  state: RunState,
  events: readonly RunEvent[],
): void {
  if (state.status !== "running" && state.status !== "waiting_for_approval") {
    throw new RunRecoveryError(
      "terminal_run",
      `run "${runId}" is already terminal with status "${state.status}"`,
    );
  }

  const validRelocation =
    state.executionWorkspace !== null &&
    workspaceRelocation?.fromCwd === state.executionCwd &&
    resolve(workspaceRelocation.toCwd) === executionCwd;
  if (state.executionCwd !== null && state.executionCwd !== executionCwd && !validRelocation) {
    throw new RunRecoveryError(
      "execution_context_mismatch",
      `run "${runId}" was started in "${state.executionCwd}" and cannot resume in "${executionCwd}"`,
    );
  }
  if (!sameExecutionWorkspace(state.executionWorkspace, executionWorkspace)) {
    throw new RunRecoveryError(
      "execution_context_mismatch",
      `run "${runId}" workspace provenance does not match its recovery context`,
    );
  }

  const expectedNodeIds = workflow.nodes.map((node) => node.id);
  const recoveredNodeIds = Object.keys(state.nodes);
  if (
    state.runId !== runId ||
    state.workflowId !== workflow.id ||
    state.workflowApiVersion !== workflow.apiVersion ||
    state.workflowDigest !== calculateWorkflowDigest(workflow) ||
    !sameStrings(recoveredNodeIds, expectedNodeIds)
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" was not started from this exact compiled workflow`,
    );
  }

  const expectedApprovalRequirements = commandApprovalRequirements(workflow);
  const recoveredApprovalRequirements = Object.entries(state.approvalRequirements).map(
    ([nodeId, requirement]) => ({ nodeId, grantTtlMs: requirement.grantTtlMs }),
  );
  if (!sameApprovalRequirements(recoveredApprovalRequirements, expectedApprovalRequirements)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" approval requirements do not match the compiled workflow`,
    );
  }

  const expectedAgentCommandApprovalRequirements =
    workflowAgentCommandApprovalRequirements(workflow);
  const recoveredAgentCommandApprovalRequirements = Object.entries(
    state.agentCommandApprovalRequirements,
  ).map(([nodeId, requirement]) => ({ nodeId, grantTtlMs: requirement.grantTtlMs }));
  if (
    !sameApprovalRequirements(
      recoveredAgentCommandApprovalRequirements,
      expectedAgentCommandApprovalRequirements,
    )
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" agent command approval requirements do not match the compiled workflow`,
    );
  }

  const expectedCapabilityRequirements = agentCapabilityRequirements(workflow);
  const recoveredCapabilityRequirements = Object.entries(state.capabilityRequirements).map(
    ([nodeId, skills]) => ({ nodeId, skills }),
  );
  if (
    !sameCapabilityRequirements(recoveredCapabilityRequirements, expectedCapabilityRequirements)
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" capability requirements do not match the compiled workflow`,
    );
  }

  const expectedVerifierPackageRequirements = workflowVerifierPackageRequirements(workflow);
  const recoveredVerifierPackageRequirements = Object.entries(
    state.verifierPackageRequirements,
  ).map(([nodeId, requirement]) => ({ nodeId, ...requirement }));
  if (
    !sameVerifierPackageRequirements(
      recoveredVerifierPackageRequirements,
      expectedVerifierPackageRequirements,
    )
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" verifier package requirements do not match the compiled workflow`,
    );
  }

  const expectedToolPackageRequirements = workflowToolPackageRequirements(workflow);
  const recoveredToolPackageRequirements = Object.entries(state.toolPackageRequirements).map(
    ([nodeId, requirement]) => ({ nodeId, ...requirement }),
  );
  if (
    !sameToolPackageRequirements(recoveredToolPackageRequirements, expectedToolPackageRequirements)
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" tool package requirements do not match the compiled workflow`,
    );
  }

  const expectedWorkflowPackageRequirements = collectWorkflowPackageReferences(workflow);
  if (
    !sameWorkflowPackageRequirements(
      state.workflowPackageRequirements,
      expectedWorkflowPackageRequirements,
    )
  ) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" workflow package requirements do not match the compiled workflow`,
    );
  }

  const expectedRecoveryRequirements = agentRecoveryRequirements(workflow);
  const recoveredRecoveryRequirements = Object.entries(state.recoveryRequirements).map(
    ([nodeId, requirement]) => ({ nodeId, ...requirement }),
  );
  if (!sameRecoveryRequirements(recoveredRecoveryRequirements, expectedRecoveryRequirements)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" recovery requirements do not match the compiled workflow`,
    );
  }

  if (!sameRunBudget(state.budget?.limits, workflow.budget)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" budget does not match the compiled workflow`,
    );
  }

  if (state.concurrency.maxNodes !== (workflow.concurrency?.maxNodes ?? 1)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" concurrency does not match the compiled workflow`,
    );
  }

  if (!sameControlGraph(state.controlGraph, workflowControlGraph(workflow))) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" control graph does not match the compiled workflow`,
    );
  }

  const workflowNodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.approval === null) {
      continue;
    }
    const node = workflowNodeById.get(nodeId);
    if (node?.type !== "command" || node.approval === undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" has approval state for non-approved node "${nodeId}"`,
      );
    }
  }
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.workflowApproval === null) {
      continue;
    }
    if (workflowNodeById.get(nodeId)?.type !== "approval") {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" has workflow approval state for non-approval node "${nodeId}"`,
      );
    }
  }

  validateRecoveredHistory(workflow, runId, events);
}

async function reconcileOpenEffects(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  const openAttempts = Object.entries(state.nodes).filter(([, node]) => node.status === "running");
  for (const [nodeId, node] of openAttempts) {
    const openEffects = node.effects.filter(
      (effect) => effect.settlement === null && effect.reconciliation === null,
    );
    if (openEffects.length === 0) {
      continue;
    }
    const reconciler = options.effectReconciler;
    if (reconciler === undefined) {
      throw new RunRecoveryError(
        "reconciliation_unavailable",
        `run "${options.runId}" cannot inspect open durable effects because no effect reconciler is configured`,
      );
    }

    for (const effect of openEffects) {
      let publicationStarted = false;
      let published = false;
      await reconciler.reconcile(
        effect.descriptor,
        async (observation) => {
          if (publicationStarted) {
            throw new RunRecoveryError(
              "reconciliation_incomplete",
              `effect reconciler published more than one observation for "${effect.effectId}"`,
            );
          }
          publicationStarted = true;
          const event: NodeEffectReconciledEvent = {
            ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
            type: "node_effect_reconciled",
            nodeId,
            attempt: node.attempt,
            effectId: effect.effectId,
            ...observation,
          };
          const nextState = appendRunEvent(state, event);
          await options.store.append(event);
          state = nextState;
          published = true;
        },
        options.signal,
      );
      if (!published) {
        throw new RunRecoveryError(
          "reconciliation_incomplete",
          `effect reconciler returned without publishing an observation for "${effect.effectId}"`,
        );
      }
    }
  }
  return state;
}

function isModelBackedNode(node: CompiledNode): boolean {
  return node.type === "agent" || (node.type === "verifier" && node.verifier.kind === "model");
}

async function prepareModelSessionAttempt(
  store: ModelSessionStore | undefined,
  identity: ModelSessionIdentity,
  node: CompiledNode,
  attempt: number,
  now: () => Date,
  signal?: AbortSignal,
): Promise<ModelSessionJournal | undefined> {
  if (store === undefined) return undefined;
  let state =
    attempt === 1
      ? await store.create(identity, now().toISOString(), signal)
      : await store.claim(identity, signal);
  const journal = createModelSessionJournal(store, identity, state, now, signal);
  try {
    state = await journal.append({ type: "attempt_started", attempt });
    if (node.type === "agent" && !state.primaryPromptCommitted) {
      await journal.append({
        type: "user_message_committed",
        attempt,
        origin: "primary_prompt",
        text: node.agent.prompt,
      });
    }
    return journal;
  } catch (error) {
    await store.release(identity).catch(() => undefined);
    throw error;
  }
}

function createModelSessionJournal(
  store: ModelSessionStore,
  identity: ModelSessionIdentity,
  initialState: ModelSessionState,
  now: () => Date,
  signal?: AbortSignal,
): ModelSessionJournal {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    async read() {
      state = await store.read(identity);
      return state;
    },
    async append(input: ModelSessionEventInput) {
      state = await store.append(identity, input, now().toISOString(), signal);
      return state;
    },
  };
}

async function settleModelSessionAttempt(
  store: ModelSessionStore | undefined,
  journal: ModelSessionJournal,
  attempt: number,
  outcome: NodeExecutionOutcome,
): Promise<ReturnType<typeof modelSessionSummary>> {
  if (store === undefined) {
    throw new Error("model session journal requires its originating store");
  }
  const identity = modelSessionIdentity(journal.state);
  try {
    if (journal.state.activeRequest !== null) {
      const active = journal.state.activeRequest;
      await journal.append({
        type: "model_request_settled",
        attempt: active.attempt,
        turn: active.turn,
        request: active.request,
        outcome:
          outcome.status === "failed" &&
          (outcome.error.code.includes("output") || outcome.error.code.includes("limit"))
            ? "output_limited"
            : "failed",
      });
    }
    const state = await journal.append({
      type: "attempt_settled",
      attempt,
      outcome: modelSessionAttemptOutcome(outcome),
    });
    return modelSessionSummary(state);
  } finally {
    await store.release(identity);
  }
}

function modelSessionAttemptOutcome(
  outcome: NodeExecutionOutcome,
): "succeeded" | "failed" | "aborted" | "timed_out" {
  if (outcome.status === "succeeded") return "succeeded";
  const code = outcome.error.code.toLowerCase();
  if (code.includes("timeout") || code.includes("timed_out")) return "timed_out";
  if (code.includes("abort") || code.includes("cancel")) return "aborted";
  return "failed";
}

function modelSessionIdentity(state: ModelSessionState): ModelSessionIdentity {
  return { runId: state.runId, workflowId: state.workflowId, nodeId: state.nodeId };
}

async function disposeProofSafeInterruptedAttempt(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  state: RunState,
  now: () => Date,
): Promise<RunState> {
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.status !== "running" || state.recoveryRequirements[nodeId] === undefined) {
      continue;
    }

    const compiledNode = workflow.nodes.find((candidate) => candidate.id === nodeId);
    if (compiledNode === undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${options.runId}" has no compiled node "${nodeId}"`,
      );
    }
    let modelSession: ReturnType<typeof modelSessionSummary> | undefined;
    if (node.modelSession !== null && isModelBackedNode(compiledNode)) {
      if (options.modelSessionStore === undefined) {
        throw new RunRecoveryError(
          "recovery_retry_ineligible",
          `run "${options.runId}" cannot recover model session for node "${nodeId}" attempt ${node.attempt}: model session store is unavailable`,
        );
      }
      const identity = { runId: options.runId, workflowId: workflow.id, nodeId };
      let sessionClaimed = false;
      let sessionFailure: unknown;
      try {
        let session = await options.modelSessionStore.claim(identity, options.signal);
        sessionClaimed = true;
        if (session.activeCompaction !== null) {
          const active = session.activeCompaction;
          session = await options.modelSessionStore.append(
            identity,
            {
              type: "context_compaction_settled",
              attempt: active.attempt,
              compaction: active.compaction,
              generationAttempt: active.generationAttempt,
              settlement: { outcome: "interrupted", reason: "process_interrupted" },
            },
            now().toISOString(),
            options.signal,
          );
        }
        if (session.activeRollingEpoch !== null) {
          const active = session.activeRollingEpoch;
          session = await options.modelSessionStore.append(
            identity,
            {
              type: "rolling_context_epoch_settled",
              attempt: active.attempt,
              epoch: active.epoch,
              generationAttempt: active.generationAttempt,
              settlement: { outcome: "interrupted", reason: "process_interrupted" },
            },
            now().toISOString(),
            options.signal,
          );
        }
        const lastEvent = session.events.at(-1);
        if (!(lastEvent?.type === "attempt_interrupted" && lastEvent.attempt === node.attempt)) {
          session = await options.modelSessionStore.append(
            identity,
            {
              type: "attempt_interrupted",
              attempt: node.attempt,
              reason: "process_interrupted",
            },
            now().toISOString(),
            options.signal,
          );
        }
        modelSession = modelSessionSummary(session);
      } catch (error) {
        sessionFailure = error;
      }
      if (sessionClaimed) {
        try {
          await options.modelSessionStore.release(identity);
        } catch (error) {
          sessionFailure ??= error;
        }
      }
      if (sessionFailure !== undefined) {
        throw new RunRecoveryError(
          "recovery_retry_ineligible",
          `run "${options.runId}" cannot recover model session for node "${nodeId}" attempt ${node.attempt}: ${boundedFailureMessage(sessionFailure instanceof Error ? sessionFailure.message : String(sessionFailure))}`,
        );
      }
    }

    const event: RunEvent = {
      ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
      type: "node_attempt_interrupted",
      nodeId,
      attempt: node.attempt,
      reason: "process_interrupted",
      disposition: "fresh_retry",
      resourceAccounting: "incomplete",
      ...(modelSession === undefined ? {} : { modelSession }),
    };
    let nextState: RunState;
    try {
      nextState = appendRunEvent(state, event);
    } catch (error) {
      if (!(error instanceof RunReplayError)) {
        throw error;
      }
      throw new RunRecoveryError(
        "recovery_retry_ineligible",
        `run "${options.runId}" cannot fresh-retry node "${nodeId}" attempt ${node.attempt}: ${error.message}`,
      );
    }
    await options.store.append(event);
    state = nextState;
  }
  return state;
}

async function recoverOpenChildAttempts(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.status !== "running") {
      continue;
    }
    const node = nodeById.get(nodeId);
    if (node?.type !== "child") {
      continue;
    }
    let outcome: NodeExecutionOutcome;
    try {
      outcome = await recoverChildNode(node, nodeState.attempt, options, now);
    } catch (error) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot recover child node "${nodeId}": ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (outcome.status === "failed" && outcome.evidence === null) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot recover child node "${nodeId}": ${outcome.error.message}`,
      );
    }
    const event: RunEvent =
      outcome.status === "succeeded"
        ? {
            ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
            type: "node_succeeded",
            nodeId,
            attempt: nodeState.attempt,
            evidence: outcome.evidence,
          }
        : {
            ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
            type: "node_failed",
            nodeId,
            attempt: nodeState.attempt,
            error: outcome.error,
            evidence: outcome.evidence,
          };
    const nextState = appendRunEvent(state, event);
    await options.store.append(event);
    state = nextState;
  }
  return state;
}

async function recoverOpenDelegationAttempts(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  initialState: RunState,
  now: () => Date,
): Promise<RunState> {
  let state = initialState;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.status !== "running") continue;
    const open = nodeState.delegations.find((delegation) => delegation.settlement === null);
    if (open === undefined) continue;
    const node = nodeById.get(nodeId);
    const child =
      node === undefined
        ? undefined
        : delegationChildForNode(options.capabilitySnapshot, workflow.id, node);
    const store = childRunStore(options.store);
    if (child === undefined || store === null || options.workspaceIsolator === undefined) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot reconstruct delegation "${open.delegationId}"`,
      );
    }
    if (!(await store.exists(open.child.runId))) {
      await options.workspaceIsolator.cleanup(open.child.runId);
      continue;
    }
    let outcome: NodeExecutionOutcome;
    try {
      outcome = await recoverChildNode(
        child,
        nodeState.attempt,
        options,
        now,
        capabilitySnapshotWithoutDelegation(options.capabilitySnapshot),
        options.capabilitySnapshot?.delegation?.objective.text,
      );
    } catch (error) {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" cannot recover delegation "${open.delegationId}": ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (outcome.evidence?.kind !== "child") {
      throw new RunRecoveryError(
        "child_recovery_ineligible",
        `run "${options.runId}" delegation "${open.delegationId}" has no terminal child evidence`,
      );
    }
    const event: RunEvent = {
      ...eventBase(workflow, options.runId, state.lastSequence + 1, now),
      type: "node_delegation_settled",
      nodeId,
      attempt: nodeState.attempt,
      delegationSequence: open.sequence,
      delegationId: open.delegationId,
      candidateDigest: open.candidateDigest,
      snapshotDigest: open.snapshotDigest,
      evidence: outcome.evidence,
    };
    const nextState = appendRunEvent(state, event);
    await options.store.append(event);
    state = nextState;
  }
  return state;
}

async function validateRecoveredChildTrees(
  workflow: CompiledWorkflow,
  options: ResumeWorkflowOptions,
  state: RunState,
): Promise<void> {
  try {
    await validateRecoveredChildTree(workflow, options.store, state);
  } catch (error) {
    throw new RunRecoveryError(
      "child_recovery_ineligible",
      `run "${options.runId}" cannot verify its settled child tree: ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function validateRecoveredChildTree(
  workflow: CompiledWorkflow,
  store: RecoverableRunEventStore,
  state: RunState,
): Promise<void> {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    const node = nodeById.get(nodeId);
    const evidence = nodeState.evidence;
    if (node?.type === "child" && evidence?.kind === "child") {
      const link = nodeState.childRun;
      if (link === null) {
        throw new Error(`settled child node "${nodeId}" has no durable child link`);
      }
      await validateRecoveredChildEvidence(node, link, evidence, state, nodeState.attempt, store);
    }
    for (const delegation of nodeState.delegations) {
      const delegatedEvidence = delegation.settlement?.evidence;
      if (delegatedEvidence === undefined) continue;
      if (node === undefined) {
        throw new Error(`delegation manager node "${nodeId}" is missing`);
      }
      const child = delegationChildForNode(
        state.capabilitySnapshot ?? undefined,
        state.workflowId,
        node,
      );
      if (child === undefined) {
        throw new Error(`settled delegation for "${nodeId}" has no admitted child`);
      }
      await validateRecoveredChildEvidence(
        child,
        delegation.child,
        delegatedEvidence,
        state,
        nodeState.attempt,
        store,
      );
    }
  }
}

async function validateRecoveredChildEvidence(
  node: CompiledChildNode,
  link: ChildRunLink,
  evidence: ChildEvidence,
  parentState: RunState,
  attempt: number,
  store: RecoverableRunEventStore,
): Promise<void> {
  const childState = reduceRunEvents(await store.read(evidence.childRunId));
  validateRecoveredChildIdentity(
    link,
    node,
    parentState.runId,
    attempt,
    parentState.workProfile,
    childState,
  );
  if (!runStateIsTerminal(childState)) {
    throw new Error(`settled child run "${evidence.childRunId}" is not terminal`);
  }
  const expected = childEvidence(node, childState, evidence.workspace.disposition);
  if (!sameChildEvidenceProjection(evidence, expected)) {
    throw new Error(`settled child evidence for "${node.id}" diverges from its child ledger`);
  }
  await validateRecoveredChildTree(node.child.workflow, store, childState);
}

function rejectOpenAttempt(runId: string, state: RunState): void {
  const openAttempt = Object.entries(state.nodes).find(([, node]) => node.status === "running");
  if (openAttempt === undefined) {
    return;
  }
  const [nodeId, node] = openAttempt;
  throw new RunRecoveryError(
    "uncertain_operation",
    `run "${runId}" cannot resume because node "${nodeId}" attempt ${node.attempt} has no committed outcome`,
  );
}

function validateRecoveredHistory(
  workflow: CompiledWorkflow,
  runId: string,
  events: readonly RunEvent[],
): void {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  let replayState: RunState | undefined;
  let interruptionRequiresResume = false;

  for (const event of events) {
    if (
      interruptionRequiresResume &&
      event.type !== "run_resumed" &&
      event.type !== "node_attempt_interrupted"
    ) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" contains recovery history that skipped the required resume marker`,
      );
    }
    if (event.type === "run_resumed") {
      interruptionRequiresResume = false;
    }
    if (event.type === "command_approval_requested") {
      const node = nodeById.get(event.nodeId);
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node?.type !== "command" ||
        expectedTransition?.kind !== "execute" ||
        expectedTransition.node.id !== event.nodeId ||
        node.approval === undefined ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains approval history that violates the compiled workflow graph`,
        );
      }
      if (replayState === undefined) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval history has no starting state`,
        );
      }
      if (replayState.executionCwd === null) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval history has no persisted execution working directory`,
        );
      }
      const executionNode = boundNodeTimeout(node, replayState);
      const expectedOperation = createCommandApprovalOperation(
        executionNode,
        replayState.executionCwd,
      );
      const expectedDigest = calculateCommandApprovalOperationDigest(expectedOperation);
      if (
        event.operationDigest !== expectedDigest ||
        calculateCommandApprovalOperationDigest(event.operation) !== expectedDigest
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" approval operation does not match command node "${event.nodeId}"`,
        );
      }
    } else if (event.type === "workflow_approval_requested") {
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      if (
        expectedTransition?.kind !== "request_approval" ||
        expectedTransition.node.id !== event.nodeId
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains workflow approval history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_started") {
      const node = nodeById.get(event.nodeId);
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      const expectedAttempt = replayState?.nodes[event.nodeId]?.attempt;
      if (
        node === undefined ||
        expectedTransition?.kind !== "execute" ||
        expectedTransition.node.id !== event.nodeId ||
        expectedAttempt === undefined ||
        event.attempt !== expectedAttempt + 1 ||
        (event.effectProtocol !== undefined && !supportsDurableEffects(node)) ||
        (supportsAgentCommands(node)
          ? event.commandProtocol !== AGENT_COMMAND_PROTOCOL
          : event.commandProtocol !== undefined)
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains node history that violates the compiled workflow graph`,
        );
      }
    } else if (event.type === "node_attempt_interrupted") {
      const node = nodeById.get(event.nodeId);
      if (
        node?.type !== "agent" ||
        node.agent.recovery === undefined ||
        replayState === undefined ||
        !node.dependsOn.every(
          (dependency) => replayState?.nodes[dependency]?.status === "succeeded",
        )
      ) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains recovery history that violates the compiled workflow graph`,
        );
      }
      interruptionRequiresResume = true;
    } else if (event.type === "node_succeeded" || event.type === "node_failed") {
      validateRecoveredAgentCapabilities(
        nodeById.get(event.nodeId),
        event.evidence,
        replayState?.capabilitySnapshot ?? null,
        runId,
      );
    } else if (
      event.type === "node_condition_evaluated" ||
      event.type === "node_result_published" ||
      event.type === "node_loop_checked" ||
      event.type === "node_loop_completed" ||
      event.type === "node_optimization_evaluated" ||
      event.type === "node_optimization_promotion_prepared" ||
      event.type === "node_optimization_promotion_settled" ||
      event.type === "node_optimization_candidate_cleaned" ||
      event.type === "node_optimization_checked" ||
      event.type === "node_optimization_completed" ||
      event.type === "node_omitted" ||
      event.type === "node_joined" ||
      event.type === "node_control_failed"
    ) {
      const expectedTransition =
        replayState === undefined ? undefined : selectNextTransition(workflow.nodes, replayState);
      if (!controlEventMatchesTransition(event, expectedTransition)) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `run "${runId}" contains control history that violates the compiled workflow graph`,
        );
      }
    }
    replayState = appendRunEvent(replayState, event);
  }
}

function validateRecoveredAgentCapabilities(
  node: CompiledNode | undefined,
  evidence: NodeExecutionOutcome["evidence"],
  snapshot: CapabilitySnapshot | null,
  runId: string,
): void {
  if (node?.type !== "agent") {
    return;
  }
  const capabilities = evidence?.kind === "agent" ? evidence.capabilities : undefined;
  if (node.agent.skills.length === 0) {
    if (capabilities !== undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `run "${runId}" attributes undeclared Agent Skills to node "${node.id}"`,
      );
    }
    return;
  }
  if (evidence === null) {
    return;
  }
  if (snapshot === null || capabilities === undefined) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" omits selected Agent Skills evidence for node "${node.id}"`,
    );
  }
  try {
    const expected = createAgentCapabilityEvidence(snapshot, node.agent.skills, capabilities.reads);
    if (JSON.stringify(expected) !== JSON.stringify(capabilities)) {
      throw new Error("node selection does not match compiled workflow");
    }
  } catch (error) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" has incompatible Agent Skills evidence for node "${node.id}": ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

function eventBase(
  workflow: CompiledWorkflow,
  runId: string,
  sequence: number,
  now: () => Date,
  at = now(),
) {
  return {
    version: 1 as const,
    sequence,
    at: at.toISOString(),
    runId,
    workflowId: workflow.id,
  };
}

function commandApprovalRequirements(workflow: CompiledWorkflow) {
  return Object.freeze(
    workflow.nodes.flatMap((node) =>
      node.type === "command" && node.approval !== undefined
        ? [Object.freeze({ nodeId: node.id, grantTtlMs: node.approval.grantTtlMs })]
        : [],
    ),
  );
}

function workflowAgentCommandApprovalRequirements(workflow: CompiledWorkflow) {
  return Object.freeze(
    workflow.nodes.flatMap((node) =>
      requiresAgentCommandApproval(node)
        ? [
            Object.freeze({
              nodeId: node.id,
              grantTtlMs: node.agent.toolApproval.exec.grantTtlMs,
            }),
          ]
        : [],
    ),
  );
}

function agentCapabilityRequirements(
  workflow: CompiledWorkflow,
): readonly AgentCapabilityRequirement[] {
  return Object.freeze(
    workflow.nodes.flatMap((node) =>
      node.type === "agent" && node.agent.skills.length > 0
        ? [
            Object.freeze({
              nodeId: node.id,
              skills: Object.freeze([...node.agent.skills]),
            }),
          ]
        : [],
    ),
  );
}

function workflowVerifierPackageRequirements(
  workflow: CompiledWorkflow,
): readonly VerifierPackageRequirement[] {
  return Object.freeze(
    workflow.nodes.flatMap((node) => {
      if (
        node.type !== "verifier" ||
        (node.verifier.kind !== "packaged-command" && node.verifier.kind !== "packaged-model")
      ) {
        return [];
      }
      return [
        Object.freeze({
          nodeId: node.id,
          name: node.verifier.package.name,
          version: node.verifier.package.version,
          kind: node.verifier.kind === "packaged-command" ? "command" : "model",
        }),
      ];
    }),
  );
}

function workflowToolPackageRequirements(
  workflow: CompiledWorkflow,
): readonly ToolPackageRequirement[] {
  return Object.freeze(
    workflow.nodes.flatMap((node) =>
      node.type === "agent" && node.agent.toolPackages.length > 0
        ? [
            Object.freeze({
              nodeId: node.id,
              rawExec: node.agent.tools.includes("exec"),
              packages: Object.freeze(
                node.agent.toolPackages.map((item) => Object.freeze({ ...item })),
              ),
            }),
          ]
        : [],
    ),
  );
}

function agentRecoveryRequirements(
  workflow: CompiledWorkflow,
): readonly AgentRecoveryRequirement[] {
  return Object.freeze(
    workflow.nodes.flatMap((node) => {
      if (node.type !== "agent" || node.agent.recovery === undefined) {
        return [];
      }
      const requirement: AgentRecoveryRequirement = Object.freeze({
        nodeId: node.id,
        mode: node.agent.recovery.mode,
        maxAttempts: node.agent.recovery.maxAttempts,
        effectProtocol: supportsDurableEffects(node) ? DURABLE_EFFECT_PROTOCOL : "none",
      });
      return [requirement];
    }),
  );
}

function workflowControlGraph(workflow: CompiledWorkflow): ControlGraph | undefined {
  if (!workflowRequiresControlGraph(workflow)) {
    return undefined;
  }
  return projectCompiledControlGraph(workflow);
}

function sameControlGraph(left: ControlGraph | null, right: ControlGraph | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right ?? null);
}

function sameApprovalRequirements(
  left: readonly { readonly nodeId: string; readonly grantTtlMs: number }[],
  right: readonly { readonly nodeId: string; readonly grantTtlMs: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.grantTtlMs === right[index]?.grantTtlMs,
    )
  );
}

function sameCapabilityRequirements(
  left: readonly AgentCapabilityRequirement[],
  right: readonly AgentCapabilityRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        sameStrings(requirement.skills, right[index]?.skills ?? []),
    )
  );
}

function sameVerifierPackageRequirements(
  left: readonly VerifierPackageRequirement[],
  right: readonly VerifierPackageRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.name === right[index]?.name &&
        requirement.version === right[index]?.version &&
        requirement.kind === right[index]?.kind,
    )
  );
}

function sameToolPackageRequirements(
  left: readonly ToolPackageRequirement[],
  right: readonly ToolPackageRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.rawExec === right[index]?.rawExec &&
        requirement.packages.length === right[index]?.packages.length &&
        requirement.packages.every(
          (item, packageIndex) =>
            item.name === right[index]?.packages[packageIndex]?.name &&
            item.version === right[index]?.packages[packageIndex]?.version,
        ),
    )
  );
}

function sameWorkflowPackageRequirements(
  left: readonly WorkflowPackageRequirement[],
  right: readonly WorkflowPackageRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.name === right[index]?.name &&
        requirement.version === right[index]?.version &&
        requirement.digest === right[index]?.digest,
    )
  );
}

function sameRecoveryRequirements(
  left: readonly AgentRecoveryRequirement[],
  right: readonly AgentRecoveryRequirement[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (requirement, index) =>
        requirement.nodeId === right[index]?.nodeId &&
        requirement.mode === right[index]?.mode &&
        requirement.maxAttempts === right[index]?.maxAttempts &&
        requirement.effectProtocol === right[index]?.effectProtocol,
    )
  );
}

function sameRunBudget(
  left: CompiledWorkflow["budget"],
  right: CompiledWorkflow["budget"],
): boolean {
  return (
    left?.maxNodeStarts === right?.maxNodeStarts &&
    left?.maxModelTokens === right?.maxModelTokens &&
    left?.maxCostUsdMicros === right?.maxCostUsdMicros &&
    left?.maxExecutionMs === right?.maxExecutionMs &&
    left?.maxArtifactBytes === right?.maxArtifactBytes
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameExecutionWorkspace(
  left: ExecutionWorkspaceProvenance | null,
  right: ExecutionWorkspaceProvenance | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right ?? null);
}

async function releaseAfter<T>(
  store: RunEventStore,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let operationCompleted = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  if (hasRelease(store)) {
    try {
      await store.release(runId);
    } catch (error) {
      releaseError = error;
    }
  }

  if (!operationCompleted) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        `run "${runId}" failed and its ownership could not be released`,
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
  return result as T;
}

function hasRelease(
  store: RunEventStore,
): store is RunEventStore & Pick<RecoverableRunEventStore, "release"> {
  return "release" in store && typeof store.release === "function";
}

type ExecutableNode =
  | CompiledAgentNode
  | CompiledChildNode
  | CompiledCommandNode
  | CompiledVerifierNode;

type WorkflowTransition =
  | { readonly kind: "execute"; readonly node: ExecutableNode }
  | { readonly kind: "request_approval"; readonly node: CompiledApprovalNode }
  | { readonly kind: "evaluate_condition"; readonly node: CompiledConditionNode }
  | { readonly kind: "publish_result"; readonly node: CompiledResultNode }
  | {
      readonly kind: "omit_condition";
      readonly node:
        | CompiledAgentNode
        | CompiledCommandNode
        | CompiledVerifierNode
        | CompiledApprovalNode
        | CompiledResultNode
        | CompiledChildNode
        | CompiledConditionNode;
      readonly selectedCase: string;
    }
  | {
      readonly kind: "omit_dependency";
      readonly node: CompiledNode;
      readonly omittedDependencies: readonly string[];
    }
  | {
      readonly kind: "omit_loop";
      readonly node:
        | CompiledAgentNode
        | CompiledCommandNode
        | CompiledVerifierNode
        | CompiledApprovalNode
        | CompiledResultNode
        | CompiledChildNode
        | CompiledConditionNode;
    }
  | { readonly kind: "omit_optimization"; readonly node: CompiledNode }
  | { readonly kind: "join"; readonly node: CompiledJoinNode }
  | { readonly kind: "evaluate_loop"; readonly node: CompiledLoopCheckNode }
  | { readonly kind: "complete_loop"; readonly node: CompiledLoopNode }
  | { readonly kind: "evaluate_optimization"; readonly node: CompiledOptimizationCheckNode }
  | { readonly kind: "complete_optimization"; readonly node: CompiledOptimizationNode };

function selectNextTransition(
  nodes: readonly CompiledNode[],
  state: RunState,
): WorkflowTransition | undefined {
  for (const node of nodes) {
    const nodeState = state.nodes[node.id];
    if (nodeState?.status !== "pending") {
      continue;
    }
    const dependencyStates = node.dependsOn.map((dependency) => state.nodes[dependency]);
    if (
      dependencyStates.some(
        (dependency) => dependency?.status !== "succeeded" && dependency?.status !== "omitted",
      )
    ) {
      continue;
    }
    if (node.optimizationGuard !== undefined) {
      const decision = optimizationCheckDecision(state, node.optimizationGuard.checkNodeId);
      if (decision === "stop") {
        return { kind: "omit_optimization", node };
      }
      if (decision === undefined) {
        if (state.nodes[node.optimizationGuard.checkNodeId]?.status !== "omitted") {
          continue;
        }
      }
    }
    if (node.type === "join") {
      const decision = conditionDecision(state, node.join.conditionId);
      if (decision !== undefined) {
        return { kind: "join", node };
      }
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      if (
        state.nodes[node.join.conditionId]?.status === "omitted" &&
        omittedDependencies.length > 0
      ) {
        return { kind: "omit_dependency", node, omittedDependencies };
      }
      continue;
    }
    if (node.type === "loop-check") {
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      return omittedDependencies.length > 0
        ? { kind: "omit_dependency", node, omittedDependencies }
        : { kind: "evaluate_loop", node };
    }
    if (node.type === "loop") {
      if (
        node.loop.checkNodeIds.some(
          (checkNodeId) => loopCheckDecision(state, checkNodeId) === "stop",
        )
      ) {
        return { kind: "complete_loop", node };
      }
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      return omittedDependencies.length > 0
        ? { kind: "omit_dependency", node, omittedDependencies }
        : { kind: "complete_loop", node };
    }
    if (node.type === "optimization-check") {
      const omittedDependencies = node.dependsOn.filter(
        (dependency) => state.nodes[dependency]?.status === "omitted",
      );
      return omittedDependencies.length > 0
        ? { kind: "omit_dependency", node, omittedDependencies }
        : { kind: "evaluate_optimization", node };
    }
    if (node.type === "optimization") {
      return { kind: "complete_optimization", node };
    }
    if (node.loopGuard !== undefined) {
      const decision = loopCheckDecision(state, node.loopGuard.checkNodeId);
      if (decision === "stop") {
        return { kind: "omit_loop", node };
      }
      if (decision === undefined) {
        if (state.nodes[node.loopGuard.checkNodeId]?.status !== "omitted") {
          continue;
        }
      }
    }
    if (node.when !== undefined) {
      const decision = conditionDecision(state, node.when.conditionId);
      if (decision === undefined) {
        if (state.nodes[node.when.conditionId]?.status !== "omitted") {
          continue;
        }
      } else if (decision.selectedCase !== node.when.case) {
        return { kind: "omit_condition", node, selectedCase: decision.selectedCase };
      }
    }
    const omittedDependencies = node.dependsOn.filter(
      (dependency) => state.nodes[dependency]?.status === "omitted",
    );
    if (omittedDependencies.length > 0) {
      return { kind: "omit_dependency", node, omittedDependencies };
    }
    if (node.type === "condition") {
      return { kind: "evaluate_condition", node };
    }
    if (node.type === "approval") {
      return { kind: "request_approval", node };
    }
    if (node.type === "result") {
      return { kind: "publish_result", node };
    }
    return { kind: "execute", node };
  }
  return undefined;
}

function controlEventMatchesTransition(
  event: Extract<
    RunEvent,
    {
      readonly type:
        | "node_condition_evaluated"
        | "node_result_published"
        | "node_loop_checked"
        | "node_loop_completed"
        | "node_optimization_evaluated"
        | "node_optimization_promotion_prepared"
        | "node_optimization_promotion_settled"
        | "node_optimization_candidate_cleaned"
        | "node_optimization_checked"
        | "node_optimization_completed"
        | "node_omitted"
        | "node_joined"
        | "node_control_failed"
        | "workflow_approval_requested";
    }
  >,
  transition: WorkflowTransition | undefined,
): boolean {
  if (event.type === "node_condition_evaluated") {
    return transition?.kind === "evaluate_condition" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_result_published") {
    return transition?.kind === "publish_result" && transition.node.id === event.nodeId;
  }
  if (event.type === "workflow_approval_requested") {
    return transition?.kind === "request_approval" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_loop_checked") {
    return transition?.kind === "evaluate_loop" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_loop_completed") {
    return transition?.kind === "complete_loop" && transition.node.id === event.nodeId;
  }
  if (
    event.type === "node_optimization_evaluated" ||
    event.type === "node_optimization_promotion_prepared" ||
    event.type === "node_optimization_promotion_settled" ||
    event.type === "node_optimization_candidate_cleaned" ||
    event.type === "node_optimization_checked"
  ) {
    return transition?.kind === "evaluate_optimization" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_optimization_completed") {
    return transition?.kind === "complete_optimization" && transition.node.id === event.nodeId;
  }
  if (event.type === "node_control_failed") {
    return (
      (transition?.kind === "evaluate_condition" ||
        transition?.kind === "request_approval" ||
        transition?.kind === "publish_result" ||
        transition?.kind === "evaluate_loop" ||
        transition?.kind === "complete_loop" ||
        transition?.kind === "evaluate_optimization" ||
        transition?.kind === "complete_optimization") &&
      transition.node.id === event.nodeId
    );
  }
  if (event.type === "node_joined") {
    return transition?.kind === "join" && transition.node.id === event.nodeId;
  }
  return (
    (transition?.kind === "omit_condition" ||
      transition?.kind === "omit_dependency" ||
      transition?.kind === "omit_loop" ||
      transition?.kind === "omit_optimization") &&
    transition.node.id === event.nodeId
  );
}

function controlTransitionEvent(
  transition: Exclude<
    WorkflowTransition,
    { readonly kind: "execute" } | { readonly kind: "evaluate_optimization" }
  >,
  state: RunState,
  base: ReturnType<typeof eventBase>,
): RunEvent {
  if (transition.kind === "omit_optimization") {
    const guard = transition.node.optimizationGuard;
    if (guard === undefined) {
      throw new Error(`optimization omission for node "${transition.node.id}" has no guard`);
    }
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "optimization_stopped",
      optimizationId: guard.optimizationId,
      candidate: guard.candidate,
      checkNodeId: guard.checkNodeId,
    };
  }
  if (transition.kind === "omit_loop") {
    const guard = transition.node.loopGuard;
    if (guard === undefined) {
      throw new Error(`loop omission for node "${transition.node.id}" has no loop guard`);
    }
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "loop_not_continued",
      loopId: guard.loopId,
      iteration: guard.iteration,
      checkNodeId: guard.checkNodeId,
    };
  }
  if (transition.kind === "omit_condition") {
    const guard = transition.node.when;
    if (guard === undefined) {
      throw new Error(`control omission for node "${transition.node.id}" has no guard`);
    }
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "condition_not_selected",
      conditionId: guard.conditionId,
      selectedCase: transition.selectedCase,
      expectedCase: guard.case,
    };
  }
  if (transition.kind === "omit_dependency") {
    return {
      ...base,
      type: "node_omitted",
      nodeId: transition.node.id,
      reason: "dependency_omitted",
      omittedDependencies: transition.omittedDependencies,
    };
  }
  if (transition.kind === "join") {
    const decision = conditionDecision(state, transition.node.join.conditionId);
    if (decision === undefined) {
      throw new Error(`join "${transition.node.id}" has no durable condition decision`);
    }
    const selectedBranch = transition.node.join.branches.find(
      (branch) => branch.case === decision.selectedCase,
    );
    if (selectedBranch === undefined) {
      throw new Error(`join "${transition.node.id}" has no selected branch mapping`);
    }
    return {
      ...base,
      type: "node_joined",
      nodeId: transition.node.id,
      attempt: 1,
      conditionId: transition.node.join.conditionId,
      selectedCase: decision.selectedCase,
      completedNodeId: selectedBranch.nodeId,
      omittedNodeIds: transition.node.join.branches
        .filter((branch) => branch.case !== decision.selectedCase)
        .map((branch) => branch.nodeId),
    };
  }

  if (transition.kind === "complete_loop") {
    const terminatingCheckNodeId = transition.node.loop.checkNodeIds.find(
      (checkNodeId) => loopCheckDecision(state, checkNodeId) === "stop",
    );
    if (terminatingCheckNodeId === undefined) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "loop_limit_reached",
          message: loopLimitFailureMessage(transition.node.id, transition.node.loop.maxIterations),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    const completedIterations =
      transition.node.loop.checkNodeIds.indexOf(terminatingCheckNodeId) + 1;
    return {
      ...base,
      type: "node_loop_completed",
      nodeId: transition.node.id,
      attempt: 1,
      completedIterations,
      terminatingCheckNodeId,
    };
  }

  if (transition.kind === "complete_optimization") {
    const completed = transition.node.optimization.checkNodeIds.flatMap((checkNodeId) => {
      const control = state.nodes[checkNodeId]?.control;
      return control?.kind === "optimization-check" ? [{ checkNodeId, control }] : [];
    });
    const terminating = completed.at(-1);
    if (terminating === undefined) {
      throw new Error(`optimization "${transition.node.id}" has no durable check`);
    }
    return {
      ...base,
      type: "node_optimization_completed",
      nodeId: transition.node.id,
      attempt: 1,
      completedCandidates: completed.length,
      terminatingCheckNodeId: terminating.checkNodeId,
      bestValueHash: terminating.control.bestValueHash,
      bestMetric: terminating.control.bestMetric,
      bestCandidate: terminating.control.bestCandidate,
      stopReason: terminating.control.stop ? "stagnation" : "max_candidates",
    };
  }

  if (transition.kind === "request_approval") {
    const observations = transition.node.approval.evidence.map((declaration) => {
      const source = controlSource(transition.node.id, declaration, state);
      return { declaration, source };
    });
    const truncated = observations.find(({ source }) => source.truncated);
    if (truncated !== undefined) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "workflow_approval_evidence_truncated",
          message: workflowApprovalEvidenceTruncationMessage(
            transition.node.id,
            truncated.declaration.nodeId,
            truncated.declaration.field,
          ),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    const request = {
      version: 1 as const,
      runId: state.runId,
      workflowId: state.workflowId,
      workflowDigest: state.workflowDigest,
      nodeId: transition.node.id,
      attempt: 1 as const,
      prompt: transition.node.approval.prompt,
      evidence: observations.map(({ declaration, source }) => ({
        sourceNodeId: declaration.nodeId,
        sourceAttempt: source.attempt,
        sourceField: declaration.field,
        sourceHash: source.hash,
      })),
    };
    return {
      ...base,
      type: "workflow_approval_requested",
      nodeId: transition.node.id,
      attempt: 1,
      requestId: workflowApprovalRequestId(base.sequence),
      request,
      requestDigest: calculateWorkflowApprovalRequestDigest(request),
    };
  }

  if (transition.kind === "publish_result") {
    const source = controlSource(transition.node.id, transition.node.result.source, state);
    if (source.truncated) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "result_source_truncated",
          message: resultSourceTruncationMessage(
            transition.node.id,
            transition.node.result.source.field,
          ),
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    let evaluated: ReturnType<typeof evaluateTypedResult>;
    try {
      evaluated = evaluateTypedResult(source.value, transition.node.result.schema);
    } catch (error) {
      if (!(error instanceof TypedResultError)) {
        throw error;
      }
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    return {
      ...base,
      type: "node_result_published",
      nodeId: transition.node.id,
      attempt: 1,
      sourceNodeId: transition.node.result.source.nodeId,
      sourceAttempt: source.attempt,
      sourceField: transition.node.result.source.field,
      sourceHash: source.hash,
      schemaDigest: transition.node.result.schemaDigest,
      canonicalValue: evaluated.canonicalValue,
      valueHash: evaluated.valueHash,
    };
  }

  if (transition.kind === "evaluate_loop") {
    const source = loopCheckSource(transition.node, state);
    if (source.truncated) {
      return {
        ...base,
        type: "node_control_failed",
        nodeId: transition.node.id,
        attempt: 1,
        error: {
          code: "loop_source_truncated",
          message: `loop check "${transition.node.id}" source ${transition.node.loopCheck.source.field} is truncated`,
          retryable: false,
          sideEffectStatus: "none",
        },
      };
    }
    return {
      ...base,
      type: "node_loop_checked",
      nodeId: transition.node.id,
      attempt: 1,
      loopId: transition.node.loopCheck.loopId,
      iteration: transition.node.loopCheck.iteration,
      sourceNodeId: transition.node.loopCheck.source.nodeId,
      sourceAttempt: source.attempt,
      sourceField: transition.node.loopCheck.source.field,
      sourceHash: source.hash,
      decision: source.value === transition.node.loopCheck.equals ? "stop" : "continue",
    };
  }

  const source = conditionSource(transition.node, state);
  if (source.truncated) {
    return {
      ...base,
      type: "node_control_failed",
      nodeId: transition.node.id,
      attempt: 1,
      error: {
        code: "condition_source_truncated",
        message: `condition "${transition.node.id}" source ${transition.node.condition.source.field} is truncated`,
        retryable: false,
        sideEffectStatus: "none",
      },
    };
  }
  const selectedCase =
    transition.node.condition.cases.find((item) => item.equals === source.value)?.id ??
    transition.node.condition.default;
  return {
    ...base,
    type: "node_condition_evaluated",
    nodeId: transition.node.id,
    attempt: 1,
    sourceNodeId: transition.node.condition.source.nodeId,
    sourceAttempt: source.attempt,
    sourceField: transition.node.condition.source.field,
    sourceHash: source.hash,
    selectedCase,
  };
}

function conditionDecision(
  state: RunState,
  conditionId: string,
):
  | Extract<NonNullable<RunState["nodes"][string]["control"]>, { readonly kind: "condition" }>
  | undefined {
  const control = state.nodes[conditionId]?.control;
  return control?.kind === "condition" ? control : undefined;
}

function loopCheckDecision(state: RunState, checkNodeId: string): "stop" | "continue" | undefined {
  const control = state.nodes[checkNodeId]?.control;
  return control?.kind === "loop-check" ? control.decision : undefined;
}

function optimizationCheckDecision(
  state: RunState,
  checkNodeId: string,
): "stop" | "continue" | undefined {
  const control = state.nodes[checkNodeId]?.control;
  return control?.kind === "optimization-check" ? (control.stop ? "stop" : "continue") : undefined;
}

async function createOptimizationEvaluationEvent(
  node: CompiledOptimizationCheckNode,
  state: RunState,
  manager: CandidateWorkspaceManager,
  sourceCwd: string,
  protectedPaths: readonly string[],
  base: ReturnType<typeof eventBase>,
): Promise<NodeOptimizationEvaluatedEvent> {
  const baselineState = state.nodes[node.optimizationCheck.baseline.nodeId];
  if (baselineState?.status !== "succeeded" || baselineState.control?.kind !== "result") {
    throw new Error(`optimization baseline for "${node.id}" has no typed result`);
  }
  const candidateDeclaration = state.controlGraph?.nodes.find(
    (candidate) =>
      candidate.nodeId === node.optimizationCheck.candidateNodeId && candidate.type === "child",
  );
  if (candidateDeclaration?.type !== "child") {
    throw new Error(`optimization candidate for "${node.id}" has no child declaration`);
  }
  const candidate = optimizationCandidateEvidence(node, state);
  const baseline = evaluateOptimizationBaseline({
    source: baselineState.control.canonicalValue,
    schema: candidateDeclaration.child.resultSchema,
    metric: node.optimizationCheck.metric,
    invariants: node.optimizationCheck.invariants,
  });
  const priorControl =
    node.optimizationCheck.priorCheckNodeId === undefined
      ? undefined
      : state.nodes[node.optimizationCheck.priorCheckNodeId]?.control;
  if (
    node.optimizationCheck.priorCheckNodeId !== undefined &&
    priorControl?.kind !== "optimization-check"
  ) {
    throw new Error(`optimization check "${node.id}" has no prior durable decision`);
  }
  const prior = priorControl?.kind === "optimization-check" ? priorControl : undefined;
  const common = {
    ...base,
    type: "node_optimization_evaluated" as const,
    nodeId: node.id,
    attempt: 1 as const,
    optimizationId: node.optimizationCheck.optimizationId,
    candidate: node.optimizationCheck.candidate,
    candidateNodeId: node.optimizationCheck.candidateNodeId,
    baselineValueHash: baseline.valueHash,
    baselineMetric: baseline.metric,
    baselineInvariants: baseline.invariants,
    bestValueHashBefore: prior?.bestValueHash ?? baseline.valueHash,
    bestMetricBefore: prior?.bestMetric ?? baseline.metric,
    candidateOutcome: candidate.outcome,
  };
  const priorStagnation = prior?.stagnation ?? 0;
  if (candidate.outcome !== "succeeded") {
    const stagnation = priorStagnation + 1;
    return {
      ...common,
      candidateValueHash: null,
      candidateMetric: null,
      candidateInvariants: null,
      decision: "reject",
      reason: candidateFailureReason(candidate.outcome),
      stagnation,
      stop: stagnation >= node.optimizationCheck.maxConsecutiveNonImproving,
      promotion: null,
      deltaEntries: null,
    };
  }
  if (candidate.result === null) {
    throw new Error(`successful optimization candidate "${candidate.childRunId}" has no result`);
  }
  const evaluated = evaluateOptimizationCandidate({
    source: candidate.result.canonicalValue,
    schema: candidateDeclaration.child.resultSchema,
    metric: node.optimizationCheck.metric,
    invariants: node.optimizationCheck.invariants,
    bestMetric: prior?.bestMetric ?? baseline.metric,
    priorStagnation,
    maxConsecutiveNonImproving: node.optimizationCheck.maxConsecutiveNonImproving,
  });
  if (evaluated.decision === "rejected") {
    return {
      ...common,
      candidateValueHash: evaluated.valueHash,
      candidateMetric: evaluated.metric,
      candidateInvariants: evaluated.invariants,
      decision: "reject",
      reason: evaluated.reason,
      stagnation: evaluated.stagnation,
      stop: evaluated.stop,
      promotion: null,
      deltaEntries: null,
    };
  }

  let delta: Awaited<ReturnType<CandidateWorkspaceManager["captureCandidateDelta"]>>;
  try {
    delta = await manager.captureCandidateDelta({
      workspaceId: candidate.childRunId,
      sourceCwd,
      expectedSnapshotDigest: candidate.workspace.snapshotDigest,
      excludedPaths: protectedPaths,
    });
  } catch (error) {
    const captureReason = errorCodeValue(error);
    if (
      captureReason !== "candidate_no_change" &&
      captureReason !== "candidate_delta_limit_exceeded"
    ) {
      throw error;
    }
    const stagnation = priorStagnation + 1;
    return {
      ...common,
      candidateValueHash: evaluated.valueHash,
      candidateMetric: evaluated.metric,
      candidateInvariants: evaluated.invariants,
      decision: "reject",
      reason: captureReason,
      stagnation,
      stop: stagnation >= node.optimizationCheck.maxConsecutiveNonImproving,
      promotion: null,
      deltaEntries: null,
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(delta.entries), "utf8") > MAX_OPTIMIZATION_DELTA_EVIDENCE_BYTES
  ) {
    const stagnation = priorStagnation + 1;
    return {
      ...common,
      candidateValueHash: evaluated.valueHash,
      candidateMetric: evaluated.metric,
      candidateInvariants: evaluated.invariants,
      decision: "reject",
      reason: "candidate_delta_limit_exceeded",
      stagnation,
      stop: stagnation >= node.optimizationCheck.maxConsecutiveNonImproving,
      promotion: null,
      deltaEntries: null,
    };
  }
  const promotion: OptimizationPromotionBoundary = Object.freeze({
    promotionId: calculateOptimizationPromotionId(state.runId, node.id),
    workspaceId: delta.workspaceId,
    deltaDigest: delta.deltaDigest,
    baselineSnapshotDigest: delta.baselineSnapshotDigest,
    candidateSnapshotDigest: delta.candidateSnapshotDigest,
    entryCount: delta.entryCount,
    logicalBytes: delta.logicalBytes,
  });
  return {
    ...common,
    candidateValueHash: evaluated.valueHash,
    candidateMetric: evaluated.metric,
    candidateInvariants: evaluated.invariants,
    decision: "promote",
    reason: "improved",
    stagnation: 0,
    stop: false,
    promotion,
    deltaEntries: delta.entries,
  };
}

function candidateFailureReason(
  outcome: Exclude<ChildEvidence["outcome"], "succeeded">,
): "candidate_failed" | "candidate_cancelled" | "candidate_resource_exhausted" {
  switch (outcome) {
    case "failed":
      return "candidate_failed";
    case "cancelled":
      return "candidate_cancelled";
    case "resource_exhausted":
      return "candidate_resource_exhausted";
  }
}

function candidateWorkspaceManager(
  workspaceIsolator: WorkspaceIsolator | undefined,
): (WorkspaceIsolator & CandidateWorkspaceManager) | null {
  if (
    workspaceIsolator === undefined ||
    !("captureCandidateDelta" in workspaceIsolator) ||
    typeof workspaceIsolator.captureCandidateDelta !== "function" ||
    !("promoteCandidateDelta" in workspaceIsolator) ||
    typeof workspaceIsolator.promoteCandidateDelta !== "function" ||
    !("reconcileCandidatePromotion" in workspaceIsolator) ||
    typeof workspaceIsolator.reconcileCandidatePromotion !== "function"
  ) {
    return null;
  }
  return workspaceIsolator as WorkspaceIsolator & CandidateWorkspaceManager;
}

function optimizationCandidateEvidence(
  node: CompiledOptimizationCheckNode,
  state: RunState,
): ChildEvidence {
  const candidate = state.nodes[node.optimizationCheck.candidateNodeId];
  if (candidate?.status !== "succeeded" || candidate.evidence?.kind !== "child") {
    throw new Error(
      `optimization candidate "${node.optimizationCheck.candidateNodeId}" has no evidence`,
    );
  }
  return candidate.evidence;
}

function optimizationPromotionRequest(
  optimization: OptimizationCheckRunState,
  sourceCwd: string,
  protectedPaths: readonly string[],
): CandidatePromotionRequest {
  if (optimization.promotion === null) {
    throw new Error("optimization promotion request has no durable boundary");
  }
  return Object.freeze({
    promotionId: optimization.promotion.promotionId,
    workspaceId: optimization.promotion.workspaceId,
    sourceCwd,
    deltaDigest: optimization.promotion.deltaDigest,
    excludedPaths: protectedPaths,
  });
}

function optimizationSettlementEvent(
  node: CompiledOptimizationCheckNode,
  request: CandidatePromotionRequest,
  settlement: CandidatePromotionSettlement,
  base: ReturnType<typeof eventBase>,
): RunEvent {
  return {
    ...base,
    type: "node_optimization_promotion_settled",
    nodeId: node.id,
    attempt: 1,
    optimizationId: node.optimizationCheck.optimizationId,
    candidate: node.optimizationCheck.candidate,
    promotionId: request.promotionId,
    deltaDigest: request.deltaDigest,
    ...settlement,
  };
}

function optimizationPriorBestCandidate(
  node: CompiledOptimizationCheckNode,
  state: RunState,
): number | null {
  const priorId = node.optimizationCheck.priorCheckNodeId;
  if (priorId === undefined) {
    return null;
  }
  const control = state.nodes[priorId]?.control;
  if (control?.kind !== "optimization-check") {
    throw new Error(`optimization check "${node.id}" has no prior best candidate`);
  }
  return control.bestCandidate;
}

function requireOptimizationCandidateValue(value: string | null, nodeId: string): string {
  if (value === null) {
    throw new Error(`optimization check "${nodeId}" has no candidate value hash`);
  }
  return value;
}

function requireOptimizationCandidateMetric(value: number | null, nodeId: string): number {
  if (value === null) {
    throw new Error(`optimization check "${nodeId}" has no candidate metric`);
  }
  return value;
}

function optimizationFailureCode(error: unknown, fallback: string): string {
  const code = errorCodeValue(error);
  return code !== undefined && OPTIMIZATION_FAILURE_CODES.has(code) ? code : fallback;
}

const OPTIMIZATION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "candidate_delta_exists",
  "candidate_delta_limit_exceeded",
  "candidate_source_stale",
  "candidate_promotion_invalid",
  "candidate_promotion_missing",
  "candidate_promotion_rolled_back",
  "candidate_promotion_stale",
  "candidate_promotion_uncertain",
]);

function errorCodeValue(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function conditionSource(
  node: CompiledConditionNode,
  state: RunState,
): ReturnType<typeof controlSource> {
  return controlSource(node.id, node.condition.source, state);
}

function loopCheckSource(
  node: CompiledLoopCheckNode,
  state: RunState,
): ReturnType<typeof controlSource> {
  return controlSource(node.id, node.loopCheck.source, state);
}

function controlSource(
  controlNodeId: string,
  declaration: {
    readonly nodeId: string;
    readonly field: EvidenceSourceField;
  },
  state: RunState,
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = state.nodes[declaration.nodeId];
  if (source?.status !== "succeeded") {
    throw new Error(`control node "${controlNodeId}" source has no successful evidence`);
  }
  if (declaration.field === "result.value") {
    const result = typedResultSource(source);
    if (result !== null) {
      return result;
    }
    throw new Error(
      `control node "${controlNodeId}" source field is incompatible with its evidence`,
    );
  }
  if (source.evidence === null) {
    throw new Error(`control node "${controlNodeId}" source has no successful evidence`);
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stdout,
          hash: source.evidence.stdoutHash,
          truncated: source.evidence.stdoutTruncated,
        };
      }
      break;
    case "command.stderr":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stderr,
          hash: source.evidence.stderrHash,
          truncated: source.evidence.stderrTruncated,
        };
      }
      break;
    case "agent.text":
      if (source.evidence.kind === "agent") {
        return {
          attempt: source.attempt,
          value: source.evidence.text,
          hash: source.evidence.textHash,
          truncated: source.evidence.textTruncated,
        };
      }
      break;
    case "verifier.verdict":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.verdict,
          hash: createHash("sha256").update(source.evidence.verdict).digest("hex"),
          truncated: false,
        };
      }
      break;
    case "verifier.reason":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.reason,
          hash: source.evidence.reasonHash,
          truncated: false,
        };
      }
      break;
  }
  throw new Error(`control node "${controlNodeId}" source field is incompatible with its evidence`);
}

function verifierExecutionSources(
  node: ExecutableNode,
  state: RunState,
  workflowNodes: readonly CompiledNode[],
): readonly VerifierSourceInput[] | undefined {
  if (
    node.type !== "verifier" ||
    (node.verifier.kind !== "model" && node.verifier.kind !== "lean-proof")
  ) {
    return undefined;
  }
  const declarations =
    node.verifier.kind === "model"
      ? node.verifier.evidence
      : [node.verifier.specification, node.verifier.statement, node.verifier.proof];
  return Object.freeze(
    declarations.map((declaration, index) => {
      const source = verifierSource(node.id, declaration, state);
      const compiledSource = workflowNodes.find((candidate) => candidate.id === declaration.nodeId);
      const durableSource = state.nodes[declaration.nodeId]?.evidence;
      const proofModel =
        node.verifier.kind === "lean-proof" &&
        index === 2 &&
        compiledSource?.type === "agent" &&
        durableSource?.kind === "agent"
          ? {
              selectionRule: "exact-model-v1" as const,
              fallback: "deny" as const,
              provider: durableSource.provider,
              model: durableSource.model,
              thinking: compiledSource.agent.model.thinking,
            }
          : undefined;
      return Object.freeze({
        sourceNodeId: declaration.nodeId,
        sourceAttempt: source.attempt,
        sourceField: declaration.field,
        sourceHash: source.hash,
        value: source.value,
        truncated: source.truncated,
        ...(proofModel === undefined ? {} : { proofModel: Object.freeze(proofModel) }),
      });
    }),
  );
}

function proofFaithfulnessApprovalForNode(
  node: ExecutableNode,
  state: RunState,
): LeanProofFaithfulnessApprovalContext | undefined {
  if (node.type !== "verifier" || node.verifier.kind !== "lean-proof") return undefined;
  const approval = state.nodes[node.verifier.faithfulnessApprovalNodeId]?.workflowApproval;
  if (approval?.status !== "approved" || approval.actor === null || approval.decidedAt === null) {
    return undefined;
  }
  return Object.freeze({
    nodeId: node.verifier.faithfulnessApprovalNodeId,
    actor: approval.actor,
    approvedAt: approval.decidedAt,
    requestDigest: approval.requestDigest,
    evidence: Object.freeze(
      approval.request.evidence.map((observation) => Object.freeze({ ...observation })),
    ),
  });
}

function verifierSource(
  verifierNodeId: string,
  declaration: { readonly nodeId: string; readonly field: EvidenceSourceField },
  state: RunState,
): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: boolean;
} {
  const source = state.nodes[declaration.nodeId];
  if (source?.status !== "succeeded") {
    throw new Error(`verifier node "${verifierNodeId}" source has no successful evidence`);
  }
  if (declaration.field === "result.value") {
    const result = typedResultSource(source);
    if (result !== null) {
      return result;
    }
    throw new Error(
      `verifier node "${verifierNodeId}" source field is incompatible with its evidence`,
    );
  }
  if (source.evidence === null) {
    throw new Error(`verifier node "${verifierNodeId}" source has no successful evidence`);
  }
  switch (declaration.field) {
    case "command.stdout":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stdout,
          hash: source.evidence.stdoutHash,
          truncated: source.evidence.stdoutTruncated,
        };
      }
      break;
    case "command.stderr":
      if (source.evidence.kind === "command") {
        return {
          attempt: source.attempt,
          value: source.evidence.stderr,
          hash: source.evidence.stderrHash,
          truncated: source.evidence.stderrTruncated,
        };
      }
      break;
    case "agent.text":
      if (source.evidence.kind === "agent") {
        return {
          attempt: source.attempt,
          value: source.evidence.text,
          hash: source.evidence.textHash,
          truncated: source.evidence.textTruncated,
        };
      }
      break;
    case "verifier.verdict":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.verdict,
          hash: createHash("sha256").update(source.evidence.verdict).digest("hex"),
          truncated: false,
        };
      }
      break;
    case "verifier.reason":
      if (source.evidence.kind === "verifier") {
        return {
          attempt: source.attempt,
          value: source.evidence.reason,
          hash: source.evidence.reasonHash,
          truncated: false,
        };
      }
      break;
  }
  throw new Error(
    `verifier node "${verifierNodeId}" source field is incompatible with its evidence`,
  );
}

function typedResultSource(source: RunState["nodes"][string]): {
  readonly attempt: number;
  readonly value: string;
  readonly hash: string;
  readonly truncated: false;
} | null {
  if (source.control?.kind === "result") {
    return {
      attempt: source.attempt,
      value: source.control.canonicalValue,
      hash: source.control.valueHash,
      truncated: false,
    };
  }
  if (source.evidence?.kind === "child" && source.evidence.result !== null) {
    return {
      attempt: source.attempt,
      value: source.evidence.result.canonicalValue,
      hash: source.evidence.result.valueHash,
      truncated: false,
    };
  }
  return null;
}

function workflowIsTerminal(state: RunState): boolean {
  return Object.values(state.nodes).every(
    (node) => node.status === "succeeded" || node.status === "omitted",
  );
}

type TerminalRunState = RunState & {
  readonly status: "succeeded" | "failed" | "cancelled" | "resource_exhausted";
};

function runStateIsTerminal(state: RunState): state is TerminalRunState {
  return (
    state.status === "succeeded" ||
    state.status === "failed" ||
    state.status === "cancelled" ||
    state.status === "resource_exhausted"
  );
}

function hasSettlementExhaustion(state: RunState): boolean {
  return state.budget?.exhausted.some((item) => item.dimension !== "nodeStarts") === true;
}

function hasPendingStartExhaustion(state: RunState): boolean {
  return (
    state.budget?.exhausted.some((item) => item.dimension === "nodeStarts") === true &&
    Object.values(state.nodes).some((node) => node.status === "pending") &&
    !Object.values(state.nodes).some((node) => node.status === "failed")
  );
}

function boundNodeTimeout(node: CompiledCommandNode, state: RunState): CompiledCommandNode;
function boundNodeTimeout(node: CompiledAgentNode, state: RunState): CompiledAgentNode;
function boundNodeTimeout(node: CompiledVerifierNode, state: RunState): CompiledVerifierNode;
function boundNodeTimeout(node: ExecutableNode, state: RunState): ExecutableNode;
function boundNodeTimeout(node: CompiledNode, state: RunState): CompiledNode;
function boundNodeTimeout(node: CompiledNode, state: RunState): CompiledNode {
  const remaining = state.budget?.remaining.executionMs;
  if (remaining === undefined) {
    return node;
  }
  if (remaining <= 0) {
    throw new Error("execution budget must be available before bounding a node timeout");
  }
  if (node.type === "command") {
    if (node.command.timeoutMs <= remaining) {
      return node;
    }
    return Object.freeze({
      ...node,
      command: Object.freeze({ ...node.command, timeoutMs: remaining }),
    });
  }
  if (node.type === "verifier") {
    if (node.verifier.kind === "packaged-command" || node.verifier.kind === "packaged-model") {
      throw new Error(`verifier node "${node.id}" package was not resolved before timeout binding`);
    }
    const timeoutMs =
      node.verifier.kind === "command" ? node.verifier.command.timeoutMs : node.verifier.timeoutMs;
    if (timeoutMs <= remaining) {
      return node;
    }
    return Object.freeze({
      ...node,
      verifier: Object.freeze(
        node.verifier.kind === "command"
          ? {
              ...node.verifier,
              command: Object.freeze({ ...node.verifier.command, timeoutMs: remaining }),
            }
          : { ...node.verifier, timeoutMs: remaining },
      ),
    });
  }
  if (node.type !== "agent") {
    return node;
  }
  if (node.agent.timeoutMs <= remaining) {
    return node;
  }
  return Object.freeze({
    ...node,
    agent: Object.freeze({ ...node.agent, timeoutMs: remaining }),
  });
}

async function executeNode(
  node: CompiledNode,
  executor: NodeExecutor,
  context: Parameters<NodeExecutor["execute"]>[1],
  options: Omit<InternalRunWorkflowOptions, "runId">,
  now: () => Date,
): Promise<NodeExecutionOutcome> {
  if (node.type === "child") {
    return await executeChildNode(node, context, options, now);
  }
  try {
    const outcome = await executor.execute(node, context);
    validateAgentCapabilityOutcome(node, outcome, context.capabilitySnapshot);
    return outcome;
  } catch (error) {
    const message = boundedFailureMessage(error instanceof Error ? error.message : String(error));
    const failure: NodeFailure = {
      code: node.type === "verifier" ? "verifier_inconclusive" : "executor_error",
      message,
      retryable: false,
      sideEffectStatus: "uncertain",
    };
    return { status: "failed", error: failure, evidence: null };
  }
}

function validateAgentCapabilityOutcome(
  node: Exclude<CompiledNode, CompiledChildNode>,
  outcome: NodeExecutionOutcome,
  snapshot: CapabilitySnapshot | undefined,
): void {
  const acpEvidence =
    outcome.evidence?.kind === "agent"
      ? outcome.evidence.acp
      : outcome.evidence?.kind === "verifier" && outcome.evidence.driver === "model"
        ? outcome.evidence.acp
        : undefined;
  const selectedAcpAgent = snapshot?.acpAgent;
  const isModelExecution =
    node.type === "agent" ||
    (node.type === "verifier" &&
      (node.verifier.kind === "model" || node.verifier.kind === "packaged-model"));
  if (isModelExecution) {
    if (selectedAcpAgent === undefined && acpEvidence !== undefined) {
      throw new Error(`node "${node.id}" reported an undeclared ACP agent execution`);
    }
    if (
      selectedAcpAgent !== undefined &&
      (outcome.status === "succeeded" ||
        outcome.evidence?.kind === "agent" ||
        (outcome.evidence?.kind === "verifier" &&
          outcome.evidence.driver === "model" &&
          outcome.evidence.result !== "execution_failed")) &&
      acpEvidence === undefined
    ) {
      throw new Error(`node "${node.id}" omitted its selected ACP agent evidence`);
    }
    if (
      selectedAcpAgent !== undefined &&
      acpEvidence !== undefined &&
      (acpEvidence.agentDigest !== selectedAcpAgent.digest ||
        acpEvidence.agentName !== selectedAcpAgent.name ||
        acpEvidence.protocol !== selectedAcpAgent.protocol ||
        acpEvidence.compatibilityProfile !== selectedAcpAgent.compatibilityProfile ||
        acpEvidence.containmentProfile !== selectedAcpAgent.containmentProfile)
    ) {
      throw new Error(`node "${node.id}" ACP evidence does not match its selected runtime`);
    }
  }
  if (node.type !== "agent") {
    return;
  }
  const capabilities =
    outcome.evidence?.kind === "agent" ? outcome.evidence.capabilities : undefined;
  if (node.agent.skills.length === 0) {
    if (capabilities !== undefined) {
      throw new Error(`agent node "${node.id}" reported undeclared Agent Skills`);
    }
    return;
  }
  if (outcome.status === "failed" && outcome.evidence === null) {
    return;
  }
  if (snapshot === undefined || capabilities === undefined) {
    throw new Error(`agent node "${node.id}" omitted its selected Agent Skills evidence`);
  }
  const expected = createAgentCapabilityEvidence(snapshot, node.agent.skills, capabilities.reads);
  if (JSON.stringify(expected) !== JSON.stringify(capabilities)) {
    throw new Error(
      `agent node "${node.id}" reported Agent Skills evidence outside its declaration`,
    );
  }
}

async function executeChildNode(
  node: CompiledChildNode,
  context: Parameters<NodeExecutor["execute"]>[1],
  options: Omit<InternalRunWorkflowOptions, "runId">,
  now: () => Date,
  childCapabilitySnapshot: CapabilitySnapshot | undefined = context.capabilitySnapshot,
  childDelegationObjective?: string,
): Promise<NodeExecutionOutcome> {
  const store = childRunStore(options.store);
  if (store === null || options.workspaceIsolator === undefined) {
    return childFailure(
      "child_runtime_unavailable",
      "child workflows require a recoverable run store and workspace isolator",
    );
  }
  const link = createChildRunLink(context.runId, node, context.attempt);
  if (await store.exists(link.runId)) {
    return childFailure(
      "child_run_collision",
      `child run "${link.runId}" already exists before its parent attempt started`,
    );
  }

  let workspace: IsolatedWorkspace;
  try {
    workspace = await options.workspaceIsolator.create({
      workspaceId: link.runId,
      sourceCwd: context.cwd,
      excludedPaths: context.protectedPaths,
    });
  } catch (error) {
    return childFailure(
      "child_workspace_unavailable",
      `child workspace could not be created: ${boundedFailureMessage(error instanceof Error ? error.message : String(error))}`,
    );
  }

  const executionWorkspace: ExecutionWorkspaceProvenance = Object.freeze({
    backend: workspace.backend,
    snapshotDigest: workspace.snapshotDigest,
    parentRunId: context.runId,
    parentNodeId: node.id,
    parentAttempt: context.attempt,
  });
  const childState = await runWorkflowInternal(node.child.workflow, {
    runId: link.runId,
    cwd: workspace.cwd,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    protectedPaths: context.protectedPaths,
    store,
    executor: options.executor,
    ...(options.workspaceIsolator === undefined
      ? {}
      : { workspaceIsolator: options.workspaceIsolator }),
    executionWorkspace,
    ...(childCapabilitySnapshot === undefined
      ? {}
      : { capabilitySnapshot: childCapabilitySnapshot }),
    workProfile: options.workProfile ?? "standard",
    now,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(options.agentCommandApprovalDecisions === undefined
      ? {}
      : { agentCommandApprovalDecisions: options.agentCommandApprovalDecisions }),
    ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    ...(options.modelSessionStore === undefined
      ? {}
      : { modelSessionStore: options.modelSessionStore }),
    [effectiveHarnessChildPath]: [...(options[effectiveHarnessChildPath] ?? []), node.id],
    ...(childDelegationObjective === undefined
      ? {}
      : { [delegationObjective]: childDelegationObjective }),
  });
  return await settleChildState(node, childState, options.workspaceIsolator);
}

async function recoverChildNode(
  node: CompiledChildNode,
  attempt: number,
  options: InternalResumeWorkflowOptions,
  now: () => Date,
  childCapabilitySnapshot: CapabilitySnapshot | undefined = options.capabilitySnapshot,
  childDelegationObjective?: string,
): Promise<NodeExecutionOutcome> {
  const store = childRunStore(options.store);
  if (store === null || options.workspaceIsolator === undefined) {
    return childFailure(
      "child_runtime_unavailable",
      "child workflows require a recoverable run store and workspace isolator",
    );
  }
  const link = createChildRunLink(options.runId, node, attempt);
  if (!(await store.exists(link.runId))) {
    await options.workspaceIsolator.cleanup(link.runId);
    return await executeChildNode(
      node,
      {
        runId: options.runId,
        workflowId: node.child.workflow.id,
        attempt,
        cwd: resolve(options.cwd),
        ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
        protectedPaths: options.protectedPaths,
        ...(childCapabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: childCapabilitySnapshot }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      options,
      now,
      childCapabilitySnapshot,
      childDelegationObjective,
    );
  }

  let childState = reduceRunEvents(await store.read(link.runId));
  validateRecoveredChildIdentity(
    link,
    node,
    options.runId,
    attempt,
    options.workProfile ?? "standard",
    childState,
  );
  if (!runStateIsTerminal(childState)) {
    const workspace = await options.workspaceIsolator.reopen({
      workspaceId: link.runId,
      sourceCwd: resolve(options.cwd),
      excludedPaths: options.protectedPaths,
    });
    const provenance = childState.executionWorkspace;
    if (
      provenance === null ||
      provenance.backend !== workspace.backend ||
      provenance.snapshotDigest !== workspace.snapshotDigest
    ) {
      throw new Error(`child run "${link.runId}" workspace provenance has diverged`);
    }
    childState = await resumeWorkflowWithRelocation(
      node.child.workflow,
      {
        runId: link.runId,
        cwd: workspace.cwd,
        ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
        protectedPaths: options.protectedPaths,
        store,
        executor: options.executor,
        workspaceIsolator: options.workspaceIsolator,
        executionWorkspace: provenance,
        ...(childCapabilitySnapshot === undefined
          ? {}
          : { capabilitySnapshot: childCapabilitySnapshot }),
        workProfile: options.workProfile ?? "standard",
        ...(options.effectReconciler === undefined
          ? {}
          : { effectReconciler: options.effectReconciler }),
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.agentCommandApprovalDecisions === undefined
          ? {}
          : { agentCommandApprovalDecisions: options.agentCommandApprovalDecisions }),
        [effectiveHarnessChildPath]: [...(options[effectiveHarnessChildPath] ?? []), node.id],
        ...(childDelegationObjective === undefined
          ? {}
          : { [delegationObjective]: childDelegationObjective }),
      },
      workspace.relocatedFromCwd === undefined
        ? undefined
        : { fromCwd: workspace.relocatedFromCwd, toCwd: workspace.cwd },
    );
  }
  return await settleChildState(node, childState, options.workspaceIsolator);
}

function supplementalMemoryForAgent(
  snapshot: CapabilitySnapshot | undefined,
  childPath: readonly string[],
  agentNodeId: string,
): string | undefined {
  const effectiveHarness = snapshot?.effectiveHarness;
  if (effectiveHarness?.supplementalMemory === undefined) return undefined;
  const target = {
    workflowId: effectiveHarness.workflowId,
    childPath,
    agentNodeId,
  };
  const memory = renderSupplementalMemoryBlock(effectiveHarness.supplementalMemory, target);
  const relationships =
    effectiveHarness.supplementalMemoryRelationships === undefined
      ? undefined
      : renderSupplementalMemoryRelationshipBlock(
          effectiveHarness.supplementalMemoryRelationships,
          target,
        );
  return [memory, relationships].filter((item) => item !== undefined).join("\n") || undefined;
}

function phaseRoutingForNode(
  snapshot: CapabilitySnapshot | undefined,
  childPath: readonly string[],
  node: CompiledNode,
): PhaseRoutingDecision | undefined {
  const effectiveHarness = snapshot?.effectiveHarness;
  const profile = effectiveHarness?.phaseRoutingProfile;
  if (profile === undefined) return undefined;
  if (effectiveHarness === undefined) {
    throw new Error("phase-routing profile has no effective harness runtime");
  }
  const route = modelRouteForNode(node);
  if (route === undefined) {
    throw new Error(`phase-routing target node "${node.id}" is not model-backed`);
  }
  return createPhaseRoutingDecision({
    profile,
    target: { workflowId: effectiveHarness.workflowId, childPath, nodeId: node.id },
    route,
  });
}

function modelRouteForNode(node: CompiledNode) {
  if (node.type === "agent") return node.agent.model;
  if (node.type === "verifier" && node.verifier.kind === "model") return node.verifier.model;
  return undefined;
}

function assertPhaseRoutingRuntimeSupported(snapshot: CapabilitySnapshot | undefined): void {
  if (
    snapshot?.effectiveHarness?.phaseRoutingProfile !== undefined &&
    snapshot.acpAgent !== undefined
  ) {
    throw new Error(
      "phase-routing profiles cannot select an ACP runtime because its provider calls are opaque",
    );
  }
}

function goalWorkspaceForAgent(snapshot: CapabilitySnapshot | undefined): string | undefined {
  const goalWorkspace = snapshot?.goalWorkspace;
  return goalWorkspace === undefined ? undefined : renderGoalWorkspaceContext(goalWorkspace);
}

function delegationObjectiveSystemPrompt(objective: string | undefined): string | undefined {
  if (objective === undefined) return undefined;
  return [
    "You are executing a sealed Flow child workflow.",
    "Complete only this admitted delegation objective:",
    objective,
    "Return evidence through the child workflow's declared typed result.",
    "Do not delegate, request approval, or expand the admitted authority.",
  ].join("\n\n");
}

function validateRecoveredChildIdentity(
  link: ChildRunLink,
  node: CompiledChildNode,
  parentRunId: string,
  attempt: number,
  expectedWorkProfile: WorkProfile,
  state: RunState,
): void {
  const provenance = state.executionWorkspace;
  if (
    state.runId !== link.runId ||
    state.workflowId !== link.workflowId ||
    state.workflowDigest !== link.workflowDigest ||
    state.workProfile !== expectedWorkProfile ||
    !sameRunBudget(state.budget?.limits, node.child.workflow.budget) ||
    provenance === null ||
    provenance.parentRunId !== parentRunId ||
    provenance.parentNodeId !== node.id ||
    provenance.parentAttempt !== attempt
  ) {
    throw new Error(`child run "${link.runId}" does not match its durable parent link`);
  }
}

async function settleChildState(
  node: CompiledChildNode,
  childState: RunState,
  workspaceIsolator: WorkspaceIsolator,
): Promise<NodeExecutionOutcome> {
  if (!runStateIsTerminal(childState)) {
    return childFailure(
      "child_wait_unsupported",
      `child run "${childState.runId}" entered unsupported status "${childState.status}"`,
    );
  }

  if (node.optimizationCandidate !== undefined && childState.status === "succeeded") {
    return {
      status: "succeeded",
      evidence: childEvidence(node, childState, "retained"),
    };
  }

  let disposition: "discarded" | "retained" = "discarded";
  try {
    await workspaceIsolator.cleanup(childState.runId);
  } catch {
    disposition = "retained";
  }
  const evidence = childEvidence(node, childState, disposition);
  if (disposition === "retained") {
    return childFailure(
      "child_workspace_cleanup_failed",
      `child workspace "${childState.runId}" could not be discarded`,
      evidence,
    );
  }
  if (childState.status === "succeeded") {
    return { status: "succeeded", evidence };
  }
  if (node.optimizationCandidate !== undefined) {
    return { status: "succeeded", evidence };
  }
  return childFailure(
    childFailureCode(childState.status),
    childState.failureReason ??
      `child run "${childState.runId}" ended with status "${childState.status}"`,
    evidence,
  );
}

function childEvidence(
  node: CompiledChildNode,
  state: RunState,
  disposition: "discarded" | "retained",
): ChildEvidence {
  const provenance = state.executionWorkspace;
  if (provenance === null) {
    throw new Error(`child run "${state.runId}" has no workspace provenance`);
  }
  const resultState = state.nodes[node.child.resultNodeId];
  const result =
    resultState?.control?.kind === "result"
      ? Object.freeze({
          nodeId: node.child.resultNodeId,
          schemaDigest: resultState.control.schemaDigest,
          canonicalValue: resultState.control.canonicalValue,
          valueHash: resultState.control.valueHash,
        })
      : null;
  const finishedAt =
    state.finishedAt === null ? Date.parse(state.startedAt) : Date.parse(state.finishedAt);
  return Object.freeze({
    kind: "child",
    childRunId: state.runId,
    workflowId: state.workflowId,
    workflowDigest: state.workflowDigest,
    terminalSequence: state.lastSequence,
    outcome: requireChildTerminalStatus(state.status),
    result,
    resources: state.resources,
    ...(state.resourceAvailability === undefined
      ? {}
      : { resourceAvailability: state.resourceAvailability }),
    durationMs: Math.max(0, finishedAt - Date.parse(state.startedAt)),
    workspace: Object.freeze({
      backend: provenance.backend,
      snapshotDigest: provenance.snapshotDigest,
      disposition,
    }),
  });
}

function sameChildEvidenceProjection(actual: ChildEvidence, expected: ChildEvidence): boolean {
  return (
    actual.childRunId === expected.childRunId &&
    actual.workflowId === expected.workflowId &&
    actual.workflowDigest === expected.workflowDigest &&
    actual.terminalSequence === expected.terminalSequence &&
    actual.outcome === expected.outcome &&
    sameChildResult(actual.result, expected.result) &&
    actual.resources.nodeStarts === expected.resources.nodeStarts &&
    actual.resources.modelTokens === expected.resources.modelTokens &&
    actual.resources.modelCostUsdMicros === expected.resources.modelCostUsdMicros &&
    actual.resources.executionMs === expected.resources.executionMs &&
    actual.resources.artifactBytes === expected.resources.artifactBytes &&
    actual.resourceAvailability?.modelTokens === expected.resourceAvailability?.modelTokens &&
    actual.resourceAvailability?.modelCostUsdMicros ===
      expected.resourceAvailability?.modelCostUsdMicros &&
    actual.durationMs === expected.durationMs &&
    actual.workspace.backend === expected.workspace.backend &&
    actual.workspace.snapshotDigest === expected.workspace.snapshotDigest &&
    actual.workspace.disposition === expected.workspace.disposition
  );
}

function sameChildResult(left: ChildEvidence["result"], right: ChildEvidence["result"]): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.nodeId === right.nodeId &&
    left.schemaDigest === right.schemaDigest &&
    left.canonicalValue === right.canonicalValue &&
    left.valueHash === right.valueHash
  );
}

function requireChildTerminalStatus(status: RunState["status"]): ChildEvidence["outcome"] {
  if (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "resource_exhausted"
  ) {
    return status;
  }
  throw new Error(`child run is not terminal: ${status}`);
}

function childFailureCode(status: ChildEvidence["outcome"]): string {
  switch (status) {
    case "failed":
      return "child_run_failed";
    case "cancelled":
      return "child_run_cancelled";
    case "resource_exhausted":
      return "child_run_resource_exhausted";
    case "succeeded":
      return "child_run_failed";
  }
}

function childFailure(
  code: string,
  message: string,
  evidence: ChildEvidence | null = null,
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code,
      message: boundedFailureMessage(message),
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence,
  };
}

function childRunStore(
  store: RunEventStore,
): (RecoverableRunEventStore & { exists(runId: string): Promise<boolean> }) | null {
  return "claim" in store &&
    typeof store.claim === "function" &&
    "release" in store &&
    typeof store.release === "function" &&
    "exists" in store &&
    typeof store.exists === "function"
    ? (store as RecoverableRunEventStore & { exists(runId: string): Promise<boolean> })
    : null;
}

function abortedOutcome(
  signal: AbortSignal | undefined,
  evidence: NodeExecutionOutcome["evidence"] = null,
): NodeExecutionOutcome {
  return {
    status: "failed",
    error: {
      code: "workflow_aborted",
      message: abortReason(signal),
      retryable: false,
      sideEffectStatus: "uncertain",
    },
    evidence,
  };
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.length > 0) {
    return boundedFailureMessage(reason.message);
  }
  if (typeof reason === "string" && reason.length > 0) {
    return boundedFailureMessage(reason);
  }
  return "workflow execution was cancelled";
}

async function abortableApprovalDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (isAborted(signal)) {
    throw signal?.reason ?? new Error("agent command approval wait was cancelled");
  }
  await new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () =>
      finish(signal?.reason ?? new Error("agent command approval wait was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(error?: unknown): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolveDelay();
      } else {
        reject(error);
      }
    }
  });
}

function boundedFailureMessage(message: string): string {
  return message.length <= 16_384 ? message : `${message.slice(0, 16_350)}… [truncated]`;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first === undefined) {
    return second;
  }
  if (second === undefined || first === second) {
    return first;
  }
  return AbortSignal.any([first, second]);
}

function isExactAgentCommandApprovalDecision(
  decision: AgentCommandApprovalDecision,
  wait: AgentCommandApprovalWait,
): boolean {
  const validReason =
    decision.reason === undefined ||
    (decision.reason === decision.reason.trim() &&
      decision.reason.length > 0 &&
      decision.reason.length <= 4096);
  return (
    decision.version === 1 &&
    decision.runId === wait.request.runId &&
    decision.requestId === wait.requestId &&
    decision.requestDigest === wait.requestDigest &&
    decision.operationDigest === wait.request.operationDigest &&
    (decision.decision === "approve" || decision.decision === "deny") &&
    decision.actor === decision.actor.trim() &&
    isValidApprovalActor(decision.actor) &&
    validReason &&
    (decision.decision === "deny" || decision.reason === undefined) &&
    Number.isFinite(Date.parse(decision.submittedAt))
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) {
    throw new RunWorkflowAbortedError(abortReason(signal));
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cancellationAttribution(
  signal: AbortSignal | undefined,
): { readonly actor: string; readonly requestId: string } | undefined {
  return signal?.reason instanceof RunCancellation
    ? { actor: signal.reason.actor, requestId: signal.reason.requestId }
    : undefined;
}

function isValidCancellationActor(actor: string): boolean {
  return (
    actor.length > 0 &&
    actor.length <= 128 &&
    !Array.from(actor).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}
