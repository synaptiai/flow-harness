import { z } from "zod";

import { RUN_BUDGET_DIMENSIONS } from "../run/budget.js";
import type { IssueLifecycleState } from "./events.js";
import {
  calculateIssueCandidateTreeDigest,
  calculateIssueCommitMessageDigest,
} from "./issue-delivery-contract.js";
import type { FrozenIssueRunManifest } from "./private-manifest.js";
import { issueReviewRepairPolicySchema } from "./review-repair-policy.js";
import {
  createIssueWorkflowAccounting,
  type IssueWorkflowAccountingState,
  type IssueWorkflowDispatch,
  type IssueWorkflowEnvelope,
  issueWorkflowEnvelopeSchema,
  prepareIssueWorkflowDispatch,
} from "./workflow-accounting.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const limitKeys = {
  nodeStarts: "maxNodeStarts",
  modelTokens: "maxModelTokens",
  modelCostUsdMicros: "maxCostUsdMicros",
  executionMs: "maxExecutionMs",
  artifactBytes: "maxArtifactBytes",
} as const;

export const issueReviewRepairRunContractSchema = z
  .object({
    policy: issueReviewRepairPolicySchema,
    repairTemplateWorkflowDigest: digest,
    implementationEnvelope: issueWorkflowEnvelopeSchema,
    reviewEnvelope: issueWorkflowEnvelopeSchema,
    repairEnvelope: issueWorkflowEnvelopeSchema,
  })
  .strict()
  .superRefine((contract, context) => {
    for (const role of ["implementation", "review", "repair"] as const) {
      const pool = contract.policy.aggregateBudget[role === "repair" ? "implementation" : role];
      for (const key of Object.keys(pool) as (keyof IssueWorkflowEnvelope)[]) {
        if (contract[`${role}Envelope`][key] > pool[key]) {
          context.addIssue({ code: "custom", message: "child envelope exceeds frozen role pool" });
        }
      }
    }
  });

export const issueReviewRepairSelectionSchema = z
  .object({
    cycle: positiveInteger,
    candidateHead: commit,
    candidateTree: commit,
    reviewFlowRunId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/),
    reviewExecutionWorkflowDigest: digest,
    reviewTerminalSequence: positiveInteger,
    reportDigest: digest,
    repairTemplateWorkflowDigest: digest,
    eligibleClasses: issueReviewRepairPolicySchema.shape.eligibleClasses,
    eligibilityDigest: digest,
    contextDigest: digest,
  })
  .strict();

export type IssueReviewRepairRunContract = z.infer<typeof issueReviewRepairRunContractSchema>;
export type IssueReviewRepairSelection = z.infer<typeof issueReviewRepairSelectionSchema>;
export const issueImplementationCandidateSchema = z
  .object({
    candidateTree: commit,
    candidateTreeDigest: digest,
    commitMessageDigest: digest,
    flowRunId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/),
    executionWorkflowDigest: digest,
    terminalSequence: positiveInteger,
    evidenceDigest: digest,
  })
  .strict();
export type IssueImplementationCandidate = z.infer<typeof issueImplementationCandidateSchema>;
export interface IssueReviewRepairState {
  readonly contract: IssueReviewRepairRunContract;
  readonly accounting: IssueWorkflowAccountingState;
  readonly cycle: number;
  readonly seenTrees: readonly string[];
  readonly workspaceIdentityDigest?: string;
  readonly candidateTree?: string;
  readonly selection?: IssueReviewRepairSelection;
  readonly candidatePreparation?: IssueImplementationCandidate;
}

export function prepareIssueImplementationCandidate(
  state: IssueLifecycleState,
  candidate: IssueImplementationCandidate,
): IssueReviewRepairState {
  const repair = requireIssueRepairState(state);
  requireSuccessfulIssueChild(state, "implementation");
  if (repair.candidatePreparation !== undefined)
    throw new Error("implementation candidate is already prepared");
  const previous = repair.accounting.settled.at(-1);
  if (
    state.phase !== "implementing" ||
    state.pendingEffect !== undefined ||
    candidate.flowRunId !== previous?.dispatch.flowRunId ||
    candidate.executionWorkflowDigest !== previous.dispatch.executionWorkflowDigest ||
    candidate.terminalSequence !== previous.settlement.terminalSequence ||
    candidate.evidenceDigest !== previous.settlement.ledgerDigest ||
    candidate.candidateTreeDigest !== calculateIssueCandidateTreeDigest(candidate.candidateTree) ||
    state.frozenIssueNumber === undefined ||
    candidate.commitMessageDigest !== calculateIssueCommitMessageDigest(state.frozenIssueNumber)
  ) {
    throw new Error(
      "implementation candidate does not match the settled child and delivery identity",
    );
  }
  if (repair.seenTrees.includes(candidate.candidateTree))
    throw new Error("candidate tree is unchanged or repeated");
  return { ...repair, candidatePreparation: candidate };
}

/** Reconstruct the exact optional receipt contract; omission has no serialized footprint. */
export function issueReviewRepairRunContractForManifest(
  manifest: FrozenIssueRunManifest,
): IssueReviewRepairRunContract | undefined {
  if (manifest.reviewRepair === undefined) return undefined;
  const { workflow, ...policy } = manifest.reviewRepair;
  return issueReviewRepairRunContractSchema.parse({
    policy,
    repairTemplateWorkflowDigest: workflow.templateWorkflowDigest,
    implementationEnvelope: manifest.budgets.implementation,
    reviewEnvelope: manifest.budgets.review,
    repairEnvelope: manifest.budgets.reviewRepair?.repair,
  });
}

export function createIssueReviewRepairState(
  contract: IssueReviewRepairRunContract,
  runId: string,
  frozenContractDigest: string,
): IssueReviewRepairState {
  const parsed = issueReviewRepairRunContractSchema.parse(contract);
  return {
    contract: parsed,
    cycle: 0,
    seenTrees: [],
    accounting: createIssueWorkflowAccounting({
      parentIssueRunId: runId,
      frozenContractDigest,
      pools: parsed.policy.aggregateBudget,
    }),
  };
}

export function prepareIssueRepairDispatch(
  state: IssueLifecycleState,
  dispatch: IssueWorkflowDispatch,
): IssueReviewRepairState {
  const repair = requireIssueRepairState(state);
  if (repair.accounting.pending !== null) throw new Error("pending workflow dispatch must settle");
  if (state.pendingEffect !== undefined || state.phase === "external_state_uncertain") {
    throw new Error("external effect must be reconciled before workflow dispatch");
  }
  const expectedPhase = dispatch.role === "review" ? "reviewing" : "implementing";
  if ((dispatch.role === "review") !== (dispatch.contextBlob !== undefined)) {
    throw new Error("only review dispatch requires its immutable prepared context blob");
  }
  const isRepair = dispatch.role === "implementation" && repair.cycle > 0;
  const expectedTemplate =
    dispatch.role === "review"
      ? state.frozenReviewTemplateWorkflowDigest
      : isRepair
        ? repair.contract.repairTemplateWorkflowDigest
        : state.frozenImplementationTemplateWorkflowDigest;
  const expectedEnvelope =
    dispatch.role === "review"
      ? repair.contract.reviewEnvelope
      : isRepair
        ? repair.contract.repairEnvelope
        : repair.contract.implementationEnvelope;
  const expectedHead =
    dispatch.role === "review"
      ? state.candidateHead
      : isRepair
        ? repair.selection?.candidateHead
        : null;
  const expectedReport = isRepair ? repair.selection?.reportDigest : null;
  if (
    state.phase !== expectedPhase ||
    dispatch.cycle !== repair.cycle ||
    state.implementationIteration !== repair.cycle + 1 ||
    dispatch.workspaceIdentityDigest !== repair.workspaceIdentityDigest ||
    dispatch.templateWorkflowDigest !== expectedTemplate ||
    dispatch.candidateHead !== expectedHead ||
    dispatch.reportDigest !== expectedReport ||
    !sameEnvelope(dispatch.envelope, expectedEnvelope)
  ) {
    throw new Error(
      "workflow dispatch does not match frozen phase, cycle, workspace, source or envelope",
    );
  }
  if (
    repair.accounting.settled.some(
      ({ dispatch: previous }) =>
        previous.cycle === dispatch.cycle && previous.role === dispatch.role,
    )
  ) {
    throw new Error("workflow role already settled for this cycle; it cannot be restarted");
  }
  return { ...repair, accounting: prepareIssueWorkflowDispatch(repair.accounting, dispatch) };
}

export function selectIssueReviewRepair(
  state: IssueLifecycleState,
  selection: IssueReviewRepairSelection,
): IssueReviewRepairState {
  const repair = requireIssueRepairState(state);
  requireSuccessfulIssueChild(state, "review");
  const previous = repair.accounting.settled.at(-1);
  if (
    state.phase !== "reviewing" ||
    state.pendingEffect !== undefined ||
    state.publication !== undefined ||
    selection.cycle !== repair.cycle + 1 ||
    selection.cycle > repair.contract.policy.maxCycles ||
    state.implementationIteration !== repair.cycle + 1 ||
    selection.candidateHead !== state.candidateHead ||
    selection.candidateTree !== repair.candidateTree ||
    selection.reviewFlowRunId !== previous?.dispatch.flowRunId ||
    selection.reviewExecutionWorkflowDigest !== previous?.dispatch.executionWorkflowDigest ||
    selection.reviewTerminalSequence !== previous?.settlement.terminalSequence ||
    selection.repairTemplateWorkflowDigest !== repair.contract.repairTemplateWorkflowDigest ||
    !selection.eligibleClasses.every((kind) =>
      repair.contract.policy.eligibleClasses.includes(kind),
    )
  ) {
    throw new Error(
      "repair selection does not match the eligible current review and frozen cycle policy",
    );
  }
  return { ...repair, cycle: selection.cycle, selection };
}

export function requireSuccessfulIssueChild(
  state: IssueLifecycleState,
  role: "implementation" | "review",
): void {
  const repair = requireIssueRepairState(state);
  if (repair.accounting.pending !== null) throw new Error("pending workflow dispatch must settle");
  const last = repair.accounting.settled.at(-1);
  if (
    last?.dispatch.role !== role ||
    last.dispatch.cycle !== repair.cycle ||
    last.settlement.status !== "succeeded"
  ) {
    throw new Error(`successful ${role} settlement is required before progress`);
  }
  for (const poolRole of ["implementation", "review"] as const) {
    for (const dimension of RUN_BUDGET_DIMENSIONS) {
      if (
        repair.accounting.availability[poolRole][dimension] !== "complete" ||
        repair.accounting.consumed[poolRole][dimension] >
          repair.accounting.pools[poolRole][limitKeys[dimension]]
      ) {
        throw new Error("workflow usage is unavailable or exceeds aggregate authority");
      }
    }
  }
}

export function requireIssueRepairState(state: IssueLifecycleState): IssueReviewRepairState {
  if (state.reviewRepair === undefined)
    throw new Error("review repair was not authorized in the frozen run");
  return state.reviewRepair;
}

function sameEnvelope(left: IssueWorkflowEnvelope, right: IssueWorkflowEnvelope): boolean {
  return (Object.keys(right) as (keyof IssueWorkflowEnvelope)[]).every(
    (key) => left[key] === right[key],
  );
}
