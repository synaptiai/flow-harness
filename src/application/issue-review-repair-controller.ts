import { calculateIssueLifecycleDomainDigest } from "../domain/issue-lifecycle/private-manifest.js";
import { requireSuccessfulIssueChild } from "../domain/issue-lifecycle/review-repair-state.js";
import type { IssueWorkflowDispatch } from "../domain/issue-lifecycle/workflow-accounting.js";
import { type ClaimedIssueController, IssueControllerError } from "./continue-github-issue.js";
import type {
  IssueImplementationWorkflowRequest,
  IssueRepairWorkflowRequest,
  IssueReviewWorkflowRequest,
  IssueWorkflowPreparation,
} from "./github-issue-controller-ports.js";
import { validateReviewWorkflowResult } from "./issue-workflow-runner.js";

type WorkflowRequest =
  | IssueImplementationWorkflowRequest
  | IssueReviewWorkflowRequest
  | IssueRepairWorkflowRequest;

/** Reserve before execution and reconcile usage before interpreting any outcome. */
export async function runAccountedIssueWorkflow(
  controller: ClaimedIssueController,
  request: WorkflowRequest,
): Promise<unknown> {
  const workflows = controller.dependencies.workflows;
  const repair = controller.state.reviewRepair;
  if (repair === undefined)
    throw new IssueControllerError("repair_policy_missing", "frozen repair policy is required");
  const expectedRole = request.kind === "review" ? "review" : "implementation";
  const expectedCycle = request.kind === "implementation" ? 0 : (request.cycle ?? 0);
  const prior =
    repair.accounting.pending ??
    repair.accounting.settled.find(
      ({ dispatch }) => dispatch.cycle === expectedCycle && dispatch.role === expectedRole,
    )?.dispatch;
  const preparation =
    request.kind === "implementation"
      ? await workflows.prepareImplementation?.({
          ...request,
          ...(prior === undefined ? {} : { dispatch: prior }),
        })
      : request.kind === "review"
        ? await workflows.prepareReview?.({
            ...request,
            ...(prior === undefined ? {} : { dispatch: prior }),
          })
        : await workflows.prepareRepair?.({
            ...request,
            ...(prior === undefined ? {} : { dispatch: prior }),
          });
  if (preparation === undefined || workflows.readWorkflowSettlement === undefined) {
    throw new IssueControllerError(
      "repair_adapter_missing",
      "complete review repair adapters are required",
    );
  }
  const ordinal = repair.accounting.settled.length + 1;
  const dispatch: IssueWorkflowDispatch = prior ?? {
    ...preparation,
    ordinal,
    dispatchId: `dispatch-${digest({ preparation, ordinal })}`,
  };
  if (prior === undefined) {
    await controller.append({ type: "workflow_dispatch_prepared", dispatch });
  } else if (!samePreparation(prior, preparation)) {
    throw new IssueControllerError(
      "workflow_dispatch_mismatch",
      "reconstructed workflow does not match the reserved child",
    );
  }
  const bound = { ...request, dispatch };
  const before = await workflows.readWorkflowSettlement(bound);
  if (before.kind === "incomplete") {
    throw new IssueControllerError(
      "workflow_accounting_pending",
      "incomplete child requires reconciliation; no new execution is authorized",
    );
  }
  if (before.kind === "terminal") {
    await settleOrCompare(controller, dispatch, before.settlement);
  } else if (controller.state.reviewRepair?.accounting.pending === null) {
    throw new IssueControllerError("workflow_ledger_missing", "settled child ledger is missing");
  }
  let result: unknown;
  let executionError: unknown;
  let threw = false;
  try {
    result =
      request.kind === "implementation"
        ? await workflows.runImplementation({ ...request, dispatch })
        : request.kind === "review"
          ? await workflows.runReview({ ...request, dispatch })
          : await workflows.runRepair?.({ ...request, dispatch });
  } catch (error) {
    threw = true;
    executionError = error;
  }
  const after = await workflows.readWorkflowSettlement(bound);
  if (after.kind !== "terminal") {
    throw new IssueControllerError(
      "workflow_accounting_pending",
      "child outcome cannot settle without terminal usage evidence",
      {
        ...(threw ? { cause: executionError } : {}),
      },
    );
  }
  await settleOrCompare(controller, dispatch, after.settlement);
  if (threw) throw executionError;
  requireSuccessfulIssueChild(
    controller.state,
    request.kind === "review" ? "review" : "implementation",
  );
  return result;
}

/** Rebuild only from the frozen issue and exact immutable review; do not reopen reviewed authority. */
export async function createIssueRepairWorkflowRequest(
  controller: ClaimedIssueController,
): Promise<IssueRepairWorkflowRequest> {
  const repair = controller.state.reviewRepair;
  const selection = repair?.selection;
  const host = controller.dependencies.repair;
  if (
    repair === undefined ||
    selection === undefined ||
    host === undefined ||
    repair.workspaceIdentityDigest === undefined
  ) {
    throw new IssueControllerError(
      "repair_selection_missing",
      "repair requires a selected review and owned workspace",
    );
  }
  const review = validateReviewWorkflowResult(
    controller.manifest,
    selection.candidateHead,
    await controller.dependencies.workflows.readReviewResult({
      runId: controller.manifest.runId,
      flowRunId: selection.reviewFlowRunId,
      candidateHead: selection.candidateHead,
    }),
  );
  const settledReview = repair.accounting.settled.find(
    (entry) =>
      entry.dispatch.flowRunId === selection.reviewFlowRunId && entry.dispatch.role === "review",
  );
  if (
    review.flowRunId !== selection.reviewFlowRunId ||
    review.evidenceDigest !== settledReview?.settlement.ledgerDigest ||
    review.reportDigest !== selection.reportDigest ||
    review.executionWorkflowDigest !== selection.reviewExecutionWorkflowDigest ||
    review.terminalSequence !== selection.reviewTerminalSequence
  ) {
    throw new IssueControllerError("repair_review_mismatch", "selected review evidence changed");
  }
  const projection = await host.project({
    manifest: controller.manifest,
    review,
    cycle: selection.cycle,
    candidateTree: selection.candidateTree,
    workspaceIdentityDigest: repair.workspaceIdentityDigest,
  });
  if (projection.digest !== selection.contextDigest) {
    throw new IssueControllerError("repair_context_mismatch", "selected repair context changed");
  }
  return {
    kind: "repair",
    runId: controller.manifest.runId,
    manifest: controller.manifest,
    frozenContractDigest: controller.frozenContractDigest,
    cycle: selection.cycle,
    candidateHead: selection.candidateHead,
    workspaceIdentityDigest: repair.workspaceIdentityDigest,
    projection,
    ...controller.operation(),
  };
}

/** Cancellation can read a terminal receipt even when the execution signal is already aborted. */
export async function reconcilePendingIssueWorkflow(
  controller: ClaimedIssueController,
): Promise<boolean> {
  const dispatch = controller.state.reviewRepair?.accounting.pending;
  if (dispatch == null) return true;
  const reader = controller.dependencies.workflows.readWorkflowSettlement;
  if (reader === undefined)
    throw new IssueControllerError(
      "repair_adapter_missing",
      "workflow settlement adapter is required",
    );
  const common = {
    runId: controller.manifest.runId,
    manifest: controller.manifest,
    frozenContractDigest: controller.frozenContractDigest,
    pollCancellation: async () => {},
  };
  const request: WorkflowRequest =
    dispatch.role === "review"
      ? {
          ...common,
          kind: "review",
          cycle: dispatch.cycle,
          candidateHead: dispatch.candidateHead ?? "",
        }
      : dispatch.cycle === 0
        ? {
            ...common,
            kind: "implementation",
            iteration: 1,
            workspaceIdentityDigest: dispatch.workspaceIdentityDigest,
          }
        : await createIssueRepairWorkflowRequest(controller);
  const observation = await reader.call(controller.dependencies.workflows, {
    ...request,
    dispatch,
  });
  if (observation.kind !== "terminal") return false;
  await settleOrCompare(controller, dispatch, observation.settlement);
  return true;
}

async function settleOrCompare(
  controller: ClaimedIssueController,
  dispatch: IssueWorkflowDispatch,
  settlement: import("../domain/issue-lifecycle/workflow-accounting.js").IssueWorkflowSettlement,
) {
  if (controller.state.reviewRepair?.accounting.pending !== null) {
    await controller.append({ type: "workflow_dispatch_settled", settlement });
    return;
  }
  const stored = controller.state.reviewRepair.accounting.settled.find(
    (entry) => entry.dispatch.dispatchId === dispatch.dispatchId,
  );
  if (stored === undefined || digest(stored.settlement) !== digest(settlement)) {
    throw new IssueControllerError(
      "workflow_settlement_changed",
      "terminal child evidence changed after settlement",
    );
  }
}

function samePreparation(dispatch: IssueWorkflowDispatch, preparation: IssueWorkflowPreparation) {
  const { dispatchId: _id, ordinal: _ordinal, ...stored } = dispatch;
  return digest(stored) === digest(preparation);
}

function digest(value: unknown) {
  return calculateIssueLifecycleDomainDigest("flow.issue.workflow-dispatch.v1", value);
}
