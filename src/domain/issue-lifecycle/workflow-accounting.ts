import { z } from "zod";

import {
  addRunResources,
  emptyRunResources,
  RUN_BUDGET_DIMENSIONS,
  type RunResourceConsumption,
  runBudgetLimitsSchema,
} from "../run/budget.js";

const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = nonNegativeInteger.positive();
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const ISSUE_REVIEW_CONTEXT_MEDIA_TYPE = "application/vnd.flow.issue-review-context+json";
export const issueReviewContextBlobSchema = z
  .object({
    version: z.literal(1),
    mediaType: z.literal(ISSUE_REVIEW_CONTEXT_MEDIA_TYPE),
    byteLength: positiveInteger,
    digest,
  })
  .strict();

export const issueWorkflowEnvelopeSchema = runBudgetLimitsSchema.required();
export const issueWorkflowRolePoolsSchema = z
  .object({
    implementation: issueWorkflowEnvelopeSchema,
    review: issueWorkflowEnvelopeSchema,
  })
  .strict();
export const issueWorkflowResourcesSchema = z
  .object({
    nodeStarts: nonNegativeInteger,
    modelTokens: nonNegativeInteger,
    modelCostUsdMicros: nonNegativeInteger,
    executionMs: nonNegativeInteger,
    artifactBytes: nonNegativeInteger,
  })
  .strict();
export const issueWorkflowAvailabilitySchema = z
  .object({
    nodeStarts: z.enum(["complete", "unavailable"]),
    modelTokens: z.enum(["complete", "unavailable"]),
    modelCostUsdMicros: z.enum(["complete", "unavailable"]),
    executionMs: z.enum(["complete", "unavailable"]),
    artifactBytes: z.enum(["complete", "unavailable"]),
  })
  .strict();

/** Candidate/report eligibility and cycle progression are enforced by the issue reducer. */
export const issueWorkflowDispatchSchema = z
  .object({
    version: z.literal(1),
    dispatchId: identifier,
    parentIssueRunId: identifier,
    ordinal: positiveInteger,
    role: z.enum(["implementation", "review"]),
    cycle: nonNegativeInteger,
    flowRunId: identifier,
    frozenContractDigest: digest,
    templateWorkflowDigest: digest,
    executionWorkflowDigest: digest,
    workspaceIdentityDigest: digest,
    candidateHead: commit.nullable(),
    reportDigest: digest.nullable(),
    envelope: issueWorkflowEnvelopeSchema,
    contextBlob: issueReviewContextBlobSchema.optional(),
  })
  .strict();

/** The host derives this receipt from the exact terminal nested ledger, never model output. */
export const issueWorkflowSettlementSchema = z
  .object({
    version: z.literal(1),
    dispatchId: identifier,
    flowRunId: identifier,
    executionWorkflowDigest: digest,
    terminalSequence: positiveInteger,
    ledgerDigest: digest,
    status: z.enum(["succeeded", "failed", "cancelled", "resource_exhausted"]),
    resources: issueWorkflowResourcesSchema,
    availability: issueWorkflowAvailabilitySchema,
  })
  .strict();

export type IssueWorkflowEnvelope = Readonly<z.infer<typeof issueWorkflowEnvelopeSchema>>;
export type IssueWorkflowRole = "implementation" | "review";
export type IssueWorkflowRolePools = Readonly<Record<IssueWorkflowRole, IssueWorkflowEnvelope>>;
export type IssueWorkflowAvailability = Readonly<z.infer<typeof issueWorkflowAvailabilitySchema>>;
export type IssueWorkflowDispatch = DeepReadonly<z.infer<typeof issueWorkflowDispatchSchema>>;
export type IssueWorkflowSettlement = DeepReadonly<z.infer<typeof issueWorkflowSettlementSchema>>;

export interface IssueWorkflowAccountingState {
  readonly version: 1;
  readonly parentIssueRunId: string;
  readonly frozenContractDigest: string;
  readonly pools: IssueWorkflowRolePools;
  readonly consumed: Readonly<Record<IssueWorkflowRole, RunResourceConsumption>>;
  readonly availability: Readonly<Record<IssueWorkflowRole, IssueWorkflowAvailability>>;
  readonly pending: IssueWorkflowDispatch | null;
  readonly settled: readonly {
    readonly dispatch: IssueWorkflowDispatch;
    readonly settlement: IssueWorkflowSettlement;
  }[];
}

const accountingInputSchema = z
  .object({
    parentIssueRunId: identifier,
    frozenContractDigest: digest,
    pools: issueWorkflowRolePoolsSchema,
  })
  .strict();
const roles: readonly IssueWorkflowRole[] = ["implementation", "review"];
const accountingStateSchema = z
  .object({
    version: z.literal(1),
    ...accountingInputSchema.shape,
    consumed: z
      .object({
        implementation: issueWorkflowResourcesSchema,
        review: issueWorkflowResourcesSchema,
      })
      .strict(),
    availability: z
      .object({
        implementation: issueWorkflowAvailabilitySchema,
        review: issueWorkflowAvailabilitySchema,
      })
      .strict(),
    pending: issueWorkflowDispatchSchema.nullable(),
    settled: z.array(
      z
        .object({
          dispatch: issueWorkflowDispatchSchema,
          settlement: issueWorkflowSettlementSchema,
        })
        .strict(),
    ),
  })
  .strict();

export function createIssueWorkflowAccounting(input: unknown): IssueWorkflowAccountingState {
  const parsed = accountingInputSchema.parse(input);
  return deepFreeze({
    version: 1 as const,
    ...parsed,
    consumed: { implementation: emptyRunResources(), review: emptyRunResources() },
    availability: { implementation: completeAvailability(), review: completeAvailability() },
    pending: null,
    settled: [],
  });
}

/** Reserve one full envelope. A pending dispatch prevents all other nested execution. */
export function prepareIssueWorkflowDispatch(
  state: IssueWorkflowAccountingState,
  input: unknown,
): IssueWorkflowAccountingState {
  return prepareDispatch(validateAccountingState(state), input);
}

function prepareDispatch(
  state: IssueWorkflowAccountingState,
  input: unknown,
): IssueWorkflowAccountingState {
  const dispatch = issueWorkflowDispatchSchema.parse(input);
  if (state.pending !== null) {
    throw new Error("pending workflow dispatch must settle before another reservation");
  }
  if (
    dispatch.parentIssueRunId !== state.parentIssueRunId ||
    dispatch.frozenContractDigest !== state.frozenContractDigest
  ) {
    throw new Error("workflow dispatch identity does not match the frozen parent");
  }
  if (dispatch.ordinal !== state.settled.length + 1) {
    throw new Error("workflow dispatch ordinal must be the exact next value");
  }
  if (
    state.settled.some(
      (entry) =>
        entry.dispatch.dispatchId === dispatch.dispatchId ||
        entry.dispatch.flowRunId === dispatch.flowRunId,
    )
  ) {
    throw new Error("duplicate workflow dispatch or nested run identity cannot be reused");
  }
  for (const role of roles) {
    if (
      RUN_BUDGET_DIMENSIONS.some((dimension) => state.availability[role][dimension] !== "complete")
    ) {
      throw new Error(
        "workflow resource accounting is unavailable; no further dispatch is admitted",
      );
    }
    const limits = envelopeResources(state.pools[role]);
    if (
      RUN_BUDGET_DIMENSIONS.some(
        (dimension) => state.consumed[role][dimension] >= limits[dimension],
      )
    ) {
      throw new Error("aggregate workflow budget is exhausted; no further dispatch is admitted");
    }
  }
  const reserved = addRunResources(
    state.consumed[dispatch.role],
    envelopeResources(dispatch.envelope),
  );
  const limits = envelopeResources(state.pools[dispatch.role]);
  if (RUN_BUDGET_DIMENSIONS.some((dimension) => reserved[dimension] > limits[dimension])) {
    throw new Error("full workflow envelope exceeds remaining role budget capacity");
  }
  return deepFreeze({ ...state, pending: dispatch });
}

/** Charge actual terminal usage once, including failures and overshoot, without resetting a pool. */
export function settleIssueWorkflowDispatch(
  state: IssueWorkflowAccountingState,
  input: unknown,
): IssueWorkflowAccountingState {
  return settleDispatch(validateAccountingState(state), input);
}

function settleDispatch(
  state: IssueWorkflowAccountingState,
  input: unknown,
): IssueWorkflowAccountingState {
  const settlement = issueWorkflowSettlementSchema.parse(input);
  const pending = state.pending;
  if (pending === null) {
    throw new Error("workflow settlement requires a pending prepared dispatch");
  }
  if (
    settlement.dispatchId !== pending.dispatchId ||
    settlement.flowRunId !== pending.flowRunId ||
    settlement.executionWorkflowDigest !== pending.executionWorkflowDigest
  ) {
    throw new Error("workflow settlement identity does not match its prepared dispatch");
  }
  const consumed = addRunResources(state.consumed[pending.role], settlement.resources);
  const availability = mergeAvailability(state.availability[pending.role], settlement.availability);
  return deepFreeze({
    ...state,
    consumed: { ...state.consumed, [pending.role]: consumed },
    availability: { ...state.availability, [pending.role]: availability },
    pending: null,
    settled: [...state.settled, { dispatch: pending, settlement }],
  });
}

/** Check supplied projections against receipts; the owning issue ledger authenticates history. */
function validateAccountingState(
  input: IssueWorkflowAccountingState,
): IssueWorkflowAccountingState {
  const parsed = accountingStateSchema.parse(input);
  let replayed = createIssueWorkflowAccounting({
    parentIssueRunId: parsed.parentIssueRunId,
    frozenContractDigest: parsed.frozenContractDigest,
    pools: parsed.pools,
  });
  for (const entry of parsed.settled) {
    replayed = settleDispatch(prepareDispatch(replayed, entry.dispatch), entry.settlement);
  }
  if (parsed.pending !== null) replayed = prepareDispatch(replayed, parsed.pending);
  for (const role of roles) {
    for (const dimension of RUN_BUDGET_DIMENSIONS) {
      if (
        replayed.consumed[role][dimension] !== parsed.consumed[role][dimension] ||
        replayed.availability[role][dimension] !== parsed.availability[role][dimension]
      ) {
        throw new Error("workflow accounting projection does not match receipt replay");
      }
    }
  }
  return replayed;
}

function envelopeResources(envelope: IssueWorkflowEnvelope): RunResourceConsumption {
  return {
    nodeStarts: envelope.maxNodeStarts,
    modelTokens: envelope.maxModelTokens,
    modelCostUsdMicros: envelope.maxCostUsdMicros,
    executionMs: envelope.maxExecutionMs,
    artifactBytes: envelope.maxArtifactBytes,
  };
}

function completeAvailability(): IssueWorkflowAvailability {
  return {
    nodeStarts: "complete",
    modelTokens: "complete",
    modelCostUsdMicros: "complete",
    executionMs: "complete",
    artifactBytes: "complete",
  };
}

function mergeAvailability(
  current: IssueWorkflowAvailability,
  next: IssueWorkflowAvailability,
): IssueWorkflowAvailability {
  const merged = { ...current };
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    if (next[dimension] === "unavailable") merged[dimension] = "unavailable";
  }
  return merged;
}

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
