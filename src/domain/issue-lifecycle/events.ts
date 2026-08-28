import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, isValidGitHubNodeId } from "./identity.js";
import { isValidExactGitBranchName } from "./plan.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const errorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const githubNodeIdSchema = z
  .string()
  .refine(isValidGitHubNodeId, "must be a bounded non-whitespace GitHub node identity");
const repositoryIdentitySchema = z.string().transform((value, context) => {
  try {
    return canonicalGitHubRepositoryIdentity(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value, "must be an exact UTC timestamp");

export const ISSUE_LIFECYCLE_ACTIVE_PHASES = Object.freeze([
  "preflight",
  "issue_frozen",
  "workspace_prepared",
  "implementing",
  "verifying",
  "reviewing",
  "publishing",
  "waiting_for_ci",
  "merge_approval_required",
  "merging",
] as const);
export const ISSUE_LIFECYCLE_TERMINAL_PHASES = Object.freeze([
  "merged",
  "failed",
  "cancelled",
] as const);
export const ISSUE_EXTERNAL_EFFECT_KINDS = Object.freeze([
  "workspace",
  "commit",
  "push",
  "pull_request",
  "pull_request_ready",
  "merge",
] as const);

const activePhaseSchema = z.enum(ISSUE_LIFECYCLE_ACTIVE_PHASES);
const ordinaryPhaseSchema = z.enum([
  ...ISSUE_LIFECYCLE_ACTIVE_PHASES,
  ...ISSUE_LIFECYCLE_TERMINAL_PHASES,
]);
const phaseSchema = z.enum([
  ...ISSUE_LIFECYCLE_ACTIVE_PHASES,
  ...ISSUE_LIFECYCLE_TERMINAL_PHASES,
  "external_state_uncertain",
]);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const branchIdentitySchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isValidExactGitBranchName, "must be a valid exact Git branch name");
const phaseReceiptBaseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("issue_snapshot"),
      repositoryIdentity: repositoryIdentitySchema,
      issueNumber: positiveSafeIntegerSchema,
      issueNodeId: githubNodeIdSchema,
      issueUpdatedAt: timestampSchema,
      baseBranch: branchIdentitySchema,
      baseCommit: commitSchema,
      branch: branchIdentitySchema,
      issueDigest: sha256Schema,
      frozenContractDigest: sha256Schema,
      planDigest: sha256Schema,
      implementationTemplateWorkflowDigest: sha256Schema,
      reviewTemplateWorkflowDigest: sha256Schema,
      budgetDigest: sha256Schema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace"),
      workspaceIdentityDigest: sha256Schema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("implementation_started"),
      iteration: z.number().int().positive().max(64),
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("implementation"),
      candidateHead: commitSchema,
      flowRunId: identifierSchema,
      executionWorkflowDigest: sha256Schema,
      terminalSequence: positiveSafeIntegerSchema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("verification"),
      candidateHead: commitSchema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      candidateHead: commitSchema,
      flowRunId: identifierSchema,
      executionWorkflowDigest: sha256Schema,
      terminalSequence: positiveSafeIntegerSchema,
      reportDigest: sha256Schema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("publication"),
      candidateHead: commitSchema,
      branch: branchIdentitySchema,
      baseBranch: branchIdentitySchema,
      pullRequestNumber: positiveSafeIntegerSchema,
      pullRequestNodeId: githubNodeIdSchema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge_gate"),
      repositoryIdentity: repositoryIdentitySchema,
      baseBranch: branchIdentitySchema,
      baseCommit: commitSchema,
      branch: branchIdentitySchema,
      pullRequestNumber: positiveSafeIntegerSchema,
      pullRequestNodeId: githubNodeIdSchema,
      candidateHead: commitSchema,
      checksDigest: sha256Schema,
      gateDigest: sha256Schema,
      deleteBranch: z.boolean(),
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("gate_invalidated"),
      candidateHead: commitSchema,
      gateDigest: sha256Schema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge_approval"),
      candidateHead: commitSchema,
      gateDigest: sha256Schema,
      actorDigest: sha256Schema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge"),
      candidateHead: commitSchema,
      gateDigest: sha256Schema,
      mergeCommit: commitSchema,
      deleteBranchRequested: z.boolean(),
      branchDeleted: z.boolean(),
      evidenceDigest: sha256Schema,
    })
    .strict(),
]);
const phaseReceiptSchema = phaseReceiptBaseSchema.superRefine((receipt, context) => {
  if (receipt.kind === "issue_snapshot" && receipt.branch === receipt.baseBranch) {
    context.addIssue({
      code: "custom",
      path: ["branch"],
      message: "derived Flow branch must be distinct from the frozen base branch",
    });
  }
});
const pullRequestIdentityResultFields = {
  repositoryIdentity: repositoryIdentitySchema,
  candidateHead: commitSchema,
  headBranch: branchIdentitySchema,
  baseBranch: branchIdentitySchema,
  pullRequestNumber: positiveSafeIntegerSchema,
  pullRequestNodeId: githubNodeIdSchema,
};
const appliedExternalEffectResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      workspaceIdentityDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit"),
      candidateHead: commitSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("push"),
      candidateHead: commitSchema,
      branch: branchIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request"),
      ...pullRequestIdentityResultFields,
      isDraft: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request_ready"),
      ...pullRequestIdentityResultFields,
      isDraft: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge"),
      candidateHead: commitSchema,
      gateDigest: sha256Schema,
      mergeCommit: commitSchema,
      deleteBranchRequested: z.boolean(),
      branchDeleted: z.boolean(),
      proofDigest: sha256Schema,
    })
    .strict(),
]);
const eventBase = {
  version: z.literal(1),
  runId: identifierSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: timestampSchema,
};
const issueLifecycleEventSchema = z.union([
  z
    .object({
      ...eventBase,
      type: z.literal("phase_transitioned"),
      from: activePhaseSchema,
      to: ordinaryPhaseSchema,
      receipt: phaseReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("external_effect_prepared"),
      effectId: identifierSchema,
      effectKind: z.enum(ISSUE_EXTERNAL_EFFECT_KINDS),
      operationDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("external_effect_settled"),
      effectId: identifierSchema,
      outcome: z.literal("applied"),
      observationDigest: sha256Schema,
      result: appliedExternalEffectResultSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("external_effect_settled"),
      effectId: identifierSchema,
      outcome: z.literal("not_applied"),
      observationDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("external_state_uncertain"),
      effectId: identifierSchema,
      code: errorCodeSchema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run_failed"),
      code: errorCodeSchema,
      evidenceDigest: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("run_cancelled"),
      actorDigest: sha256Schema,
      reasonDigest: sha256Schema.optional(),
    })
    .strict(),
]);

export type IssueLifecyclePhase = z.infer<typeof phaseSchema>;
export type IssueLifecycleEvent = z.infer<typeof issueLifecycleEventSchema>;
export type IssueLifecyclePhaseReceipt = z.infer<typeof phaseReceiptSchema>;
export type IssueExternalEffectKind = (typeof ISSUE_EXTERNAL_EFFECT_KINDS)[number];
export type IssueExternalEffectResult = z.infer<typeof appliedExternalEffectResultSchema>;

export interface PendingIssueExternalEffect {
  readonly effectId: string;
  readonly effectKind: IssueExternalEffectKind;
  readonly operationDigest: string;
  readonly preparedSequence: number;
}

export type AppliedIssueExternalEffect = {
  readonly [Kind in IssueExternalEffectKind]: {
    readonly effectId: string;
    readonly effectKind: Kind;
    readonly operationDigest: string;
    readonly observationDigest: string;
    readonly result: Extract<IssueExternalEffectResult, { readonly kind: Kind }>;
  };
}[IssueExternalEffectKind];

export interface IssueLifecycleState {
  readonly version: 1;
  readonly runId: string;
  readonly phase: IssueLifecyclePhase;
  readonly sequence: number;
  readonly startedAt: string;
  readonly lastEventAt: string;
  readonly pendingEffect?: PendingIssueExternalEffect;
  readonly settledEffectCount: number;
  readonly receiptCount: number;
  readonly latestReceipt?: IssueLifecyclePhaseReceipt;
  readonly recoveryPhase?: (typeof ISSUE_LIFECYCLE_ACTIVE_PHASES)[number];
  readonly terminalCode?: string;
  readonly appliedEffects: readonly AppliedIssueExternalEffect[];
  readonly implementationIteration: number;
  readonly frozenRepositoryIdentity?: string;
  readonly frozenIssueNumber?: number;
  readonly frozenIssueNodeId?: string;
  readonly frozenIssueUpdatedAt?: string;
  readonly frozenIssueDigest?: string;
  readonly frozenBaseBranch?: string;
  readonly frozenBaseCommit?: string;
  readonly frozenBranch?: string;
  readonly frozenContractDigest?: string;
  readonly frozenPlanDigest?: string;
  readonly frozenImplementationTemplateWorkflowDigest?: string;
  readonly frozenReviewTemplateWorkflowDigest?: string;
  readonly frozenBudgetDigest?: string;
  readonly candidateHead?: string;
  readonly publication?: {
    readonly candidateHead: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly pullRequestNumber: number;
    readonly pullRequestNodeId: string;
  };
  readonly mergeGate?: {
    readonly candidateHead: string;
    readonly baseBranch: string;
    readonly baseCommit: string;
    readonly branch: string;
    readonly pullRequestNumber: number;
    readonly pullRequestNodeId: string;
    readonly gateDigest: string;
    readonly deleteBranch: boolean;
  };
  readonly approvedMerge?: {
    readonly candidateHead: string;
    readonly gateDigest: string;
  };
}

type IssueLifecycleIdentityState = Pick<IssueLifecycleState, "implementationIteration"> &
  Pick<
    IssueLifecycleState,
    | "frozenRepositoryIdentity"
    | "frozenIssueNumber"
    | "frozenIssueNodeId"
    | "frozenIssueUpdatedAt"
    | "frozenIssueDigest"
    | "frozenBaseBranch"
    | "frozenBaseCommit"
    | "frozenBranch"
    | "frozenContractDigest"
    | "frozenPlanDigest"
    | "frozenImplementationTemplateWorkflowDigest"
    | "frozenReviewTemplateWorkflowDigest"
    | "frozenBudgetDigest"
    | "candidateHead"
    | "publication"
    | "mergeGate"
    | "approvedMerge"
  >;

export interface PublicIssueLifecycleState {
  readonly version: 1;
  readonly runId: string;
  readonly phase: IssueLifecyclePhase;
  readonly sequence: number;
  readonly lastEventAt: string;
  readonly pendingEffect?: PendingIssueExternalEffect;
  readonly settledEffectCount: number;
  readonly terminal?: { readonly code: string };
  readonly receiptCount: number;
  readonly latestReceipt?: IssueLifecyclePhaseReceipt;
  readonly mergeApproval?: {
    readonly pullRequestNumber: number;
    readonly headCommit: string;
    readonly gateDigest: string;
  };
}

const legalTransitions: Readonly<
  Record<(typeof ISSUE_LIFECYCLE_ACTIVE_PHASES)[number], readonly IssueLifecyclePhase[]>
> = {
  preflight: ["issue_frozen"],
  issue_frozen: ["workspace_prepared"],
  workspace_prepared: ["implementing"],
  implementing: ["verifying"],
  verifying: ["implementing", "reviewing"],
  reviewing: ["implementing", "publishing"],
  publishing: ["waiting_for_ci"],
  waiting_for_ci: ["implementing", "merge_approval_required"],
  merge_approval_required: ["verifying", "merging"],
  merging: ["merged"],
};

const allowedEffectsByPhase: Readonly<
  Record<(typeof ISSUE_LIFECYCLE_ACTIVE_PHASES)[number], readonly IssueExternalEffectKind[]>
> = {
  preflight: [],
  issue_frozen: ["workspace"],
  workspace_prepared: [],
  implementing: ["commit"],
  verifying: [],
  reviewing: [],
  publishing: ["push", "pull_request", "pull_request_ready"],
  waiting_for_ci: [],
  merge_approval_required: [],
  merging: ["merge"],
};

const requiredEffectsByTransition: Readonly<Record<string, readonly IssueExternalEffectKind[]>> = {
  "issue_frozen->workspace_prepared": ["workspace"],
  "implementing->verifying": ["commit"],
  "publishing->waiting_for_ci": ["push", "pull_request", "pull_request_ready"],
  "merging->merged": ["merge"],
};

export function createInitialIssueLifecycleState(
  runId: string,
  startedAt: string,
): IssueLifecycleState {
  const parsedRunId = identifierSchema.parse(runId);
  const parsedStartedAt = timestampSchema.parse(startedAt);
  return deepFreeze({
    version: 1,
    runId: parsedRunId,
    phase: "preflight",
    sequence: 0,
    startedAt: parsedStartedAt,
    lastEventAt: parsedStartedAt,
    settledEffectCount: 0,
    receiptCount: 0,
    appliedEffects: [],
    implementationIteration: 0,
  });
}

export function parseIssueLifecycleEvent(value: unknown): IssueLifecycleEvent {
  return deepFreeze(structuredClone(issueLifecycleEventSchema.parse(value)));
}

export function deriveIssueExternalEffectId(
  effectKind: IssueExternalEffectKind,
  operationDigest: string,
): string {
  const parsedKind = z.enum(ISSUE_EXTERNAL_EFFECT_KINDS).parse(effectKind);
  const parsedDigest = sha256Schema.parse(operationDigest);
  return identifierSchema.parse(`effect-${parsedKind.replaceAll("_", "-")}-${parsedDigest}`);
}

export function reduceIssueLifecycleEvent(
  current: IssueLifecycleState,
  input: IssueLifecycleEvent,
): IssueLifecycleState {
  const event = parseIssueLifecycleEvent(input);
  if (event.runId !== current.runId) throw new Error("event run identity does not match lifecycle");
  if (event.sequence !== current.sequence + 1) {
    throw new Error("event sequence must be the next append-only lifecycle sequence");
  }
  if (event.at < current.lastEventAt) throw new Error("event timestamp must not regress");
  if (ISSUE_LIFECYCLE_TERMINAL_PHASES.includes(current.phase as never)) {
    throw new Error(`terminal lifecycle phase ${current.phase} cannot accept more events`);
  }
  const common = { ...current, sequence: event.sequence, lastEventAt: event.at };

  switch (event.type) {
    case "phase_transitioned": {
      if (current.phase === "external_state_uncertain") {
        throw new Error("uncertain external state must be reconciled before a phase transition");
      }
      if (current.pendingEffect !== undefined) {
        throw new Error("pending external effect must settle before a phase transition");
      }
      if (event.from !== current.phase || !legalTransitions[current.phase].includes(event.to)) {
        throw new Error(`illegal lifecycle transition from ${event.from} to ${event.to}`);
      }
      requireReceiptForTransition(event.from, event.to, event.receipt);
      requireAppliedEffectsForTransition(current, event.from, event.to);
      const identity = advanceLifecycleIdentity(current, event.receipt);
      requireAppliedEffectResults(current, event.receipt);
      const {
        implementationIteration: _implementationIteration,
        frozenRepositoryIdentity: _frozenRepositoryIdentity,
        frozenIssueNumber: _frozenIssueNumber,
        frozenIssueNodeId: _frozenIssueNodeId,
        frozenIssueUpdatedAt: _frozenIssueUpdatedAt,
        frozenIssueDigest: _frozenIssueDigest,
        frozenBaseBranch: _frozenBaseBranch,
        frozenBaseCommit: _frozenBaseCommit,
        frozenBranch: _frozenBranch,
        frozenContractDigest: _frozenContractDigest,
        frozenPlanDigest: _frozenPlanDigest,
        frozenImplementationTemplateWorkflowDigest: _frozenImplementationTemplateWorkflowDigest,
        frozenReviewTemplateWorkflowDigest: _frozenReviewTemplateWorkflowDigest,
        frozenBudgetDigest: _frozenBudgetDigest,
        candidateHead: _candidateHead,
        publication: _publication,
        mergeGate: _mergeGate,
        approvedMerge: _approvedMerge,
        ...commonWithoutIdentity
      } = common;
      return deepFreeze({
        ...commonWithoutIdentity,
        ...identity,
        phase: event.to,
        receiptCount: current.receiptCount + 1,
        latestReceipt: event.receipt,
        appliedEffects: [],
      });
    }
    case "external_effect_prepared": {
      if (current.phase === "external_state_uncertain") {
        throw new Error("uncertain external state must be reconciled before preparing an effect");
      }
      if (current.pendingEffect !== undefined) {
        throw new Error("only one external effect may be pending");
      }
      const activePhase = activePhaseSchema.parse(current.phase);
      const allowedEffects = allowedEffectsByPhase[activePhase];
      if (!allowedEffects.includes(event.effectKind)) {
        throw new Error(`external effect ${event.effectKind} is not permitted in ${current.phase}`);
      }
      if (event.effectId !== deriveIssueExternalEffectId(event.effectKind, event.operationDigest)) {
        throw new Error("external effect identifier does not match its kind and operation digest");
      }
      if (current.appliedEffects.some((effect) => effect.effectKind === event.effectKind)) {
        throw new Error(
          `external effect ${event.effectKind} is already applied in ${current.phase}`,
        );
      }
      if (event.effectKind === "pull_request" && current.publication !== undefined) {
        throw new Error("the stable pull request already exists and must not be recreated");
      }
      if (event.effectKind === "pull_request" && appliedEffect(current, "push") === undefined) {
        throw new Error("draft pull request effect requires an applied push");
      }
      if (
        event.effectKind === "pull_request_ready" &&
        appliedEffect(current, "pull_request") === undefined &&
        current.publication === undefined
      ) {
        throw new Error("ready-for-review effect requires an applied draft pull request");
      }
      return deepFreeze({
        ...common,
        pendingEffect: {
          effectId: event.effectId,
          effectKind: event.effectKind,
          operationDigest: event.operationDigest,
          preparedSequence: event.sequence,
        },
      });
    }
    case "external_state_uncertain": {
      if (current.phase === "external_state_uncertain") {
        throw new Error("external state is already uncertain");
      }
      if (current.pendingEffect?.effectId !== event.effectId) {
        throw new Error("uncertain external effect does not match the prepared effect");
      }
      const recoveryPhase = activePhaseSchema.parse(current.phase);
      return deepFreeze({
        ...common,
        phase: "external_state_uncertain",
        recoveryPhase,
      });
    }
    case "external_effect_settled": {
      if (current.pendingEffect?.effectId !== event.effectId) {
        throw new Error("settled external effect does not match the prepared effect");
      }
      if (current.phase === "external_state_uncertain" && current.recoveryPhase === undefined) {
        throw new Error("uncertain external state has no recovery phase");
      }
      const phase = current.recoveryPhase ?? current.phase;
      const { pendingEffect: _pending, recoveryPhase: _recovery, ...withoutPending } = common;
      if (event.outcome === "applied" && event.result.kind !== current.pendingEffect.effectKind) {
        throw new Error("applied external effect result does not match the prepared effect");
      }
      if (event.outcome === "applied" && event.result.kind === "push") {
        requireFrozenBranch(current, event.result.branch, "push result");
      }
      if (
        event.outcome === "applied" &&
        (event.result.kind === "pull_request" || event.result.kind === "pull_request_ready")
      ) {
        if (event.result.kind === "pull_request_ready") {
          const draftPullRequest = appliedEffect(current, "pull_request");
          const matchesDraft =
            draftPullRequest !== undefined &&
            samePullRequestIdentity(draftPullRequest.result, event.result);
          const matchesExisting =
            draftPullRequest === undefined &&
            current.publication !== undefined &&
            samePublishedPullRequestIdentity(current.publication, event.result);
          if (!matchesDraft && !matchesExisting) {
            throw new Error(
              "ready pull request result does not match the applied draft pull request identity or existing pull request identity",
            );
          }
        }
        if (event.result.repositoryIdentity !== current.frozenRepositoryIdentity) {
          throw new Error("pull request result does not match the frozen repository identity");
        }
        requireFrozenBranch(current, event.result.headBranch, "pull request result head branch");
        requireFrozenBaseBranch(
          current,
          event.result.baseBranch,
          "pull request result base branch",
        );
      }
      if (event.outcome === "applied" && event.result.kind === "merge") {
        if (
          current.mergeGate === undefined ||
          event.result.deleteBranchRequested !== current.mergeGate.deleteBranch ||
          (event.result.deleteBranchRequested && !event.result.branchDeleted)
        ) {
          throw new Error("merge result does not match the approved gate and branch policy");
        }
      }
      const appliedEffects =
        event.outcome === "applied"
          ? [
              ...current.appliedEffects,
              bindAppliedExternalEffect(
                current.pendingEffect,
                event.observationDigest,
                event.result,
              ),
            ]
          : current.appliedEffects;
      return deepFreeze({
        ...withoutPending,
        phase,
        settledEffectCount: current.settledEffectCount + 1,
        appliedEffects,
      });
    }
    case "run_failed": {
      requireNoPendingEffect(current);
      return deepFreeze({ ...common, phase: "failed", terminalCode: event.code });
    }
    case "run_cancelled": {
      requireNoPendingEffect(current);
      return deepFreeze({ ...common, phase: "cancelled", terminalCode: "cancelled" });
    }
  }
}

export function projectPublicIssueLifecycleState(
  state: IssueLifecycleState,
): PublicIssueLifecycleState {
  const mergeApproval =
    state.phase === "merge_approval_required" && state.mergeGate !== undefined
      ? {
          pullRequestNumber: state.mergeGate.pullRequestNumber,
          headCommit: state.mergeGate.candidateHead,
          gateDigest: state.mergeGate.gateDigest,
        }
      : undefined;
  return deepFreeze({
    version: 1,
    runId: state.runId,
    phase: state.phase,
    sequence: state.sequence,
    lastEventAt: state.lastEventAt,
    ...(state.pendingEffect === undefined ? {} : { pendingEffect: { ...state.pendingEffect } }),
    settledEffectCount: state.settledEffectCount,
    receiptCount: state.receiptCount,
    ...(state.latestReceipt === undefined ? {} : { latestReceipt: state.latestReceipt }),
    ...(mergeApproval === undefined ? {} : { mergeApproval }),
    ...(state.terminalCode === undefined ? {} : { terminal: { code: state.terminalCode } }),
  });
}

function requireAppliedEffectsForTransition(
  state: IssueLifecycleState,
  from: (typeof ISSUE_LIFECYCLE_ACTIVE_PHASES)[number],
  to: IssueLifecyclePhase,
): void {
  const required =
    from === "publishing" && to === "waiting_for_ci" && state.publication !== undefined
      ? (["push", "pull_request_ready"] as const)
      : (requiredEffectsByTransition[`${from}->${to}`] ?? []);
  const missing = required.filter(
    (effectKind) => !state.appliedEffects.some((effect) => effect.effectKind === effectKind),
  );
  if (missing.length > 0) {
    throw new Error(
      `phase transition from ${from} to ${to} requires applied external effects: ${missing.join(", ")}`,
    );
  }
}

function requireAppliedEffectResults(
  state: IssueLifecycleState,
  receipt: IssueLifecyclePhaseReceipt,
): void {
  if (receipt.kind === "workspace") {
    const workspace = appliedEffect(state, "workspace");
    if (workspace?.result.workspaceIdentityDigest !== receipt.workspaceIdentityDigest) {
      throw new Error("workspace receipt does not match the applied workspace result");
    }
    return;
  }
  if (receipt.kind === "implementation") {
    const commit = appliedEffect(state, "commit");
    if (commit?.result.candidateHead !== receipt.candidateHead) {
      throw new Error("implementation receipt does not match the applied candidate commit");
    }
    return;
  }
  if (receipt.kind === "publication") {
    const push = appliedEffect(state, "push");
    const pullRequest = appliedEffect(state, "pull_request");
    const readyPullRequest = appliedEffect(state, "pull_request_ready");
    const commonMatches =
      push?.result.candidateHead === receipt.candidateHead &&
      push.result.branch === receipt.branch &&
      readyPullRequest?.result.repositoryIdentity === state.frozenRepositoryIdentity &&
      readyPullRequest?.result.candidateHead === receipt.candidateHead &&
      readyPullRequest.result.headBranch === receipt.branch &&
      readyPullRequest.result.baseBranch === receipt.baseBranch &&
      readyPullRequest.result.pullRequestNumber === receipt.pullRequestNumber &&
      readyPullRequest.result.pullRequestNodeId === receipt.pullRequestNodeId;
    const creationMatches =
      state.publication === undefined &&
      pullRequest !== undefined &&
      readyPullRequest !== undefined &&
      samePullRequestIdentity(pullRequest.result, readyPullRequest.result);
    const repairMatches =
      state.publication !== undefined &&
      pullRequest === undefined &&
      readyPullRequest !== undefined &&
      samePublishedPullRequestIdentity(state.publication, readyPullRequest.result);
    if (!commonMatches || (!creationMatches && !repairMatches)) {
      throw new Error("publication receipt does not match the applied publication results");
    }
    return;
  }
  if (receipt.kind === "merge") {
    const merge = appliedEffect(state, "merge");
    if (
      merge?.result.candidateHead !== receipt.candidateHead ||
      merge.result.gateDigest !== receipt.gateDigest ||
      merge.result.mergeCommit !== receipt.mergeCommit ||
      merge.result.deleteBranchRequested !== receipt.deleteBranchRequested ||
      merge.result.branchDeleted !== receipt.branchDeleted ||
      merge.result.proofDigest !== receipt.evidenceDigest ||
      state.mergeGate?.deleteBranch !== receipt.deleteBranchRequested ||
      (receipt.deleteBranchRequested && !receipt.branchDeleted)
    ) {
      throw new Error("merge receipt does not match the applied merge result");
    }
  }
}

function advanceLifecycleIdentity(
  state: IssueLifecycleState,
  receipt: IssueLifecyclePhaseReceipt,
): IssueLifecycleIdentityState {
  switch (receipt.kind) {
    case "issue_snapshot":
      return {
        implementationIteration: state.implementationIteration,
        frozenRepositoryIdentity: receipt.repositoryIdentity,
        frozenIssueNumber: receipt.issueNumber,
        frozenIssueNodeId: receipt.issueNodeId,
        frozenIssueUpdatedAt: receipt.issueUpdatedAt,
        frozenIssueDigest: receipt.issueDigest,
        frozenBaseBranch: receipt.baseBranch,
        frozenBaseCommit: receipt.baseCommit,
        frozenBranch: receipt.branch,
        frozenContractDigest: receipt.frozenContractDigest,
        frozenPlanDigest: receipt.planDigest,
        frozenImplementationTemplateWorkflowDigest: receipt.implementationTemplateWorkflowDigest,
        frozenReviewTemplateWorkflowDigest: receipt.reviewTemplateWorkflowDigest,
        frozenBudgetDigest: receipt.budgetDigest,
      };
    case "workspace":
      return currentLifecycleIdentity(state);
    case "implementation_started": {
      const expectedIteration = state.implementationIteration + 1;
      if (receipt.iteration !== expectedIteration) {
        throw new Error(`implementation iteration must advance to ${expectedIteration}`);
      }
      return {
        implementationIteration: receipt.iteration,
        ...(state.frozenRepositoryIdentity === undefined
          ? {}
          : { frozenRepositoryIdentity: state.frozenRepositoryIdentity }),
        ...(state.frozenIssueNumber === undefined
          ? {}
          : { frozenIssueNumber: state.frozenIssueNumber }),
        ...(state.frozenIssueNodeId === undefined
          ? {}
          : { frozenIssueNodeId: state.frozenIssueNodeId }),
        ...(state.frozenIssueUpdatedAt === undefined
          ? {}
          : { frozenIssueUpdatedAt: state.frozenIssueUpdatedAt }),
        ...(state.frozenIssueDigest === undefined
          ? {}
          : { frozenIssueDigest: state.frozenIssueDigest }),
        ...(state.frozenBaseBranch === undefined
          ? {}
          : { frozenBaseBranch: state.frozenBaseBranch }),
        ...(state.frozenBaseCommit === undefined
          ? {}
          : { frozenBaseCommit: state.frozenBaseCommit }),
        ...(state.frozenBranch === undefined ? {} : { frozenBranch: state.frozenBranch }),
        ...(state.frozenContractDigest === undefined
          ? {}
          : { frozenContractDigest: state.frozenContractDigest }),
        ...(state.frozenPlanDigest === undefined
          ? {}
          : { frozenPlanDigest: state.frozenPlanDigest }),
        ...(state.frozenImplementationTemplateWorkflowDigest === undefined
          ? {}
          : {
              frozenImplementationTemplateWorkflowDigest:
                state.frozenImplementationTemplateWorkflowDigest,
            }),
        ...(state.frozenReviewTemplateWorkflowDigest === undefined
          ? {}
          : { frozenReviewTemplateWorkflowDigest: state.frozenReviewTemplateWorkflowDigest }),
        ...(state.frozenBudgetDigest === undefined
          ? {}
          : { frozenBudgetDigest: state.frozenBudgetDigest }),
        ...(state.publication === undefined ? {} : { publication: state.publication }),
      };
    }
    case "implementation":
      return {
        ...currentLifecycleIdentity(state),
        candidateHead: receipt.candidateHead,
      };
    case "verification":
    case "review":
      requireCandidateHead(state, receipt.candidateHead, receipt.kind);
      return currentLifecycleIdentity(state);
    case "publication": {
      requireCandidateHead(state, receipt.candidateHead, receipt.kind);
      requireFrozenBranch(state, receipt.branch, "publication receipt");
      requireFrozenBaseBranch(state, receipt.baseBranch, "publication receipt");
      if (
        state.publication !== undefined &&
        (state.publication.branch !== receipt.branch ||
          state.publication.baseBranch !== receipt.baseBranch ||
          state.publication.pullRequestNumber !== receipt.pullRequestNumber ||
          state.publication.pullRequestNodeId !== receipt.pullRequestNodeId)
      ) {
        throw new Error("publication receipt does not match the existing pull request identity");
      }
      return {
        ...currentLifecycleIdentity(state),
        publication: {
          candidateHead: receipt.candidateHead,
          branch: receipt.branch,
          baseBranch: receipt.baseBranch,
          pullRequestNumber: receipt.pullRequestNumber,
          pullRequestNodeId: receipt.pullRequestNodeId,
        },
      };
    }
    case "merge_gate": {
      requireCandidateHead(state, receipt.candidateHead, receipt.kind);
      requireFrozenBranch(state, receipt.branch, "merge gate receipt");
      if (receipt.repositoryIdentity !== state.frozenRepositoryIdentity) {
        throw new Error("merge gate does not match the frozen repository identity");
      }
      if (receipt.baseBranch !== state.frozenBaseBranch) {
        throw new Error("merge gate does not match the frozen base branch");
      }
      if (receipt.baseCommit !== state.frozenBaseCommit) {
        throw new Error("merge gate does not match the frozen base commit");
      }
      if (
        state.publication === undefined ||
        state.publication.branch !== receipt.branch ||
        state.publication.baseBranch !== receipt.baseBranch ||
        state.publication.pullRequestNumber !== receipt.pullRequestNumber ||
        state.publication.pullRequestNodeId !== receipt.pullRequestNodeId
      ) {
        throw new Error("merge gate does not match the published pull request identity");
      }
      return {
        ...currentLifecycleIdentity(state),
        mergeGate: {
          candidateHead: receipt.candidateHead,
          baseBranch: receipt.baseBranch,
          baseCommit: receipt.baseCommit,
          branch: receipt.branch,
          pullRequestNumber: receipt.pullRequestNumber,
          pullRequestNodeId: receipt.pullRequestNodeId,
          gateDigest: receipt.gateDigest,
          deleteBranch: receipt.deleteBranch,
        },
      };
    }
    case "gate_invalidated":
      requireMergeGate(state, receipt.candidateHead, receipt.gateDigest, receipt.kind);
      return lifecycleIdentityWithoutGate(state);
    case "merge_approval":
      requireMergeGate(state, receipt.candidateHead, receipt.gateDigest, receipt.kind);
      return {
        ...currentLifecycleIdentity(state),
        approvedMerge: {
          candidateHead: receipt.candidateHead,
          gateDigest: receipt.gateDigest,
        },
      };
    case "merge":
      if (
        state.approvedMerge === undefined ||
        state.approvedMerge.candidateHead !== receipt.candidateHead ||
        state.approvedMerge.gateDigest !== receipt.gateDigest
      ) {
        throw new Error("merge receipt does not match the approved candidate and gate");
      }
      if (
        state.mergeGate?.deleteBranch !== receipt.deleteBranchRequested ||
        (receipt.deleteBranchRequested && !receipt.branchDeleted)
      ) {
        throw new Error("merge receipt does not match the approved branch deletion policy");
      }
      return currentLifecycleIdentity(state);
  }
}

function bindAppliedExternalEffect(
  pending: PendingIssueExternalEffect,
  observationDigest: string,
  result: IssueExternalEffectResult,
): AppliedIssueExternalEffect {
  const common = {
    effectId: pending.effectId,
    operationDigest: pending.operationDigest,
    observationDigest,
  };
  switch (result.kind) {
    case "workspace":
      return { ...common, effectKind: result.kind, result };
    case "commit":
      return { ...common, effectKind: result.kind, result };
    case "push":
      return { ...common, effectKind: result.kind, result };
    case "pull_request":
      return { ...common, effectKind: result.kind, result };
    case "pull_request_ready":
      return { ...common, effectKind: result.kind, result };
    case "merge":
      return { ...common, effectKind: result.kind, result };
  }
}

function samePullRequestIdentity(
  left: Extract<IssueExternalEffectResult, { readonly kind: "pull_request" }>,
  right: Extract<IssueExternalEffectResult, { readonly kind: "pull_request_ready" }>,
): boolean {
  return (
    left.repositoryIdentity === right.repositoryIdentity &&
    left.candidateHead === right.candidateHead &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestNodeId === right.pullRequestNodeId
  );
}

function samePublishedPullRequestIdentity(
  left: NonNullable<IssueLifecycleState["publication"]>,
  right: Extract<IssueExternalEffectResult, { readonly kind: "pull_request_ready" }>,
): boolean {
  return (
    left.branch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestNodeId === right.pullRequestNodeId
  );
}

function appliedEffect<Kind extends IssueExternalEffectKind>(
  state: IssueLifecycleState,
  effectKind: Kind,
): Extract<AppliedIssueExternalEffect, { readonly effectKind: Kind }> | undefined {
  return state.appliedEffects.find(
    (effect): effect is Extract<AppliedIssueExternalEffect, { readonly effectKind: Kind }> =>
      effect.effectKind === effectKind,
  );
}

function currentLifecycleIdentity(state: IssueLifecycleState): IssueLifecycleIdentityState {
  return {
    implementationIteration: state.implementationIteration,
    ...(state.frozenRepositoryIdentity === undefined
      ? {}
      : { frozenRepositoryIdentity: state.frozenRepositoryIdentity }),
    ...(state.frozenIssueNumber === undefined
      ? {}
      : { frozenIssueNumber: state.frozenIssueNumber }),
    ...(state.frozenIssueNodeId === undefined
      ? {}
      : { frozenIssueNodeId: state.frozenIssueNodeId }),
    ...(state.frozenIssueUpdatedAt === undefined
      ? {}
      : { frozenIssueUpdatedAt: state.frozenIssueUpdatedAt }),
    ...(state.frozenIssueDigest === undefined
      ? {}
      : { frozenIssueDigest: state.frozenIssueDigest }),
    ...(state.frozenBaseBranch === undefined ? {} : { frozenBaseBranch: state.frozenBaseBranch }),
    ...(state.frozenBaseCommit === undefined ? {} : { frozenBaseCommit: state.frozenBaseCommit }),
    ...(state.frozenBranch === undefined ? {} : { frozenBranch: state.frozenBranch }),
    ...(state.frozenContractDigest === undefined
      ? {}
      : { frozenContractDigest: state.frozenContractDigest }),
    ...(state.frozenPlanDigest === undefined ? {} : { frozenPlanDigest: state.frozenPlanDigest }),
    ...(state.frozenImplementationTemplateWorkflowDigest === undefined
      ? {}
      : {
          frozenImplementationTemplateWorkflowDigest:
            state.frozenImplementationTemplateWorkflowDigest,
        }),
    ...(state.frozenReviewTemplateWorkflowDigest === undefined
      ? {}
      : { frozenReviewTemplateWorkflowDigest: state.frozenReviewTemplateWorkflowDigest }),
    ...(state.frozenBudgetDigest === undefined
      ? {}
      : { frozenBudgetDigest: state.frozenBudgetDigest }),
    ...(state.candidateHead === undefined ? {} : { candidateHead: state.candidateHead }),
    ...(state.publication === undefined ? {} : { publication: state.publication }),
    ...(state.mergeGate === undefined ? {} : { mergeGate: state.mergeGate }),
    ...(state.approvedMerge === undefined ? {} : { approvedMerge: state.approvedMerge }),
  };
}

function lifecycleIdentityWithoutGate(state: IssueLifecycleState): IssueLifecycleIdentityState {
  return {
    implementationIteration: state.implementationIteration,
    ...(state.frozenRepositoryIdentity === undefined
      ? {}
      : { frozenRepositoryIdentity: state.frozenRepositoryIdentity }),
    ...(state.frozenIssueNumber === undefined
      ? {}
      : { frozenIssueNumber: state.frozenIssueNumber }),
    ...(state.frozenIssueNodeId === undefined
      ? {}
      : { frozenIssueNodeId: state.frozenIssueNodeId }),
    ...(state.frozenIssueUpdatedAt === undefined
      ? {}
      : { frozenIssueUpdatedAt: state.frozenIssueUpdatedAt }),
    ...(state.frozenIssueDigest === undefined
      ? {}
      : { frozenIssueDigest: state.frozenIssueDigest }),
    ...(state.frozenBaseBranch === undefined ? {} : { frozenBaseBranch: state.frozenBaseBranch }),
    ...(state.frozenBaseCommit === undefined ? {} : { frozenBaseCommit: state.frozenBaseCommit }),
    ...(state.frozenBranch === undefined ? {} : { frozenBranch: state.frozenBranch }),
    ...(state.frozenContractDigest === undefined
      ? {}
      : { frozenContractDigest: state.frozenContractDigest }),
    ...(state.frozenPlanDigest === undefined ? {} : { frozenPlanDigest: state.frozenPlanDigest }),
    ...(state.frozenImplementationTemplateWorkflowDigest === undefined
      ? {}
      : {
          frozenImplementationTemplateWorkflowDigest:
            state.frozenImplementationTemplateWorkflowDigest,
        }),
    ...(state.frozenReviewTemplateWorkflowDigest === undefined
      ? {}
      : { frozenReviewTemplateWorkflowDigest: state.frozenReviewTemplateWorkflowDigest }),
    ...(state.frozenBudgetDigest === undefined
      ? {}
      : { frozenBudgetDigest: state.frozenBudgetDigest }),
    ...(state.candidateHead === undefined ? {} : { candidateHead: state.candidateHead }),
    ...(state.publication === undefined ? {} : { publication: state.publication }),
  };
}

function requireCandidateHead(
  state: IssueLifecycleState,
  candidateHead: string,
  receiptKind: IssueLifecyclePhaseReceipt["kind"],
): void {
  if (state.candidateHead === undefined || state.candidateHead !== candidateHead) {
    throw new Error(`${receiptKind} receipt does not match the current candidate head`);
  }
}

function requireFrozenBranch(state: IssueLifecycleState, branch: string, source: string): void {
  if (state.frozenBranch === undefined || state.frozenBranch !== branch) {
    throw new Error(`${source} does not match the frozen branch`);
  }
}

function requireFrozenBaseBranch(state: IssueLifecycleState, branch: string, source: string): void {
  if (state.frozenBaseBranch === undefined || state.frozenBaseBranch !== branch) {
    throw new Error(`${source} does not match the frozen base branch`);
  }
}

function requireMergeGate(
  state: IssueLifecycleState,
  candidateHead: string,
  gateDigest: string,
  receiptKind: "gate_invalidated" | "merge_approval",
): void {
  if (
    state.mergeGate === undefined ||
    state.mergeGate.candidateHead !== candidateHead ||
    state.mergeGate.gateDigest !== gateDigest
  ) {
    throw new Error(`${receiptKind} receipt does not match the current merge gate`);
  }
}

function requireReceiptForTransition(
  from: (typeof ISSUE_LIFECYCLE_ACTIVE_PHASES)[number],
  to: IssueLifecyclePhase,
  receipt: IssueLifecyclePhaseReceipt,
): void {
  const expected =
    from === "preflight" && to === "issue_frozen"
      ? "issue_snapshot"
      : from === "issue_frozen" && to === "workspace_prepared"
        ? "workspace"
        : to === "implementing"
          ? "implementation_started"
          : from === "implementing" && to === "verifying"
            ? "implementation"
            : from === "verifying" && to === "reviewing"
              ? "verification"
              : from === "reviewing" && to === "publishing"
                ? "review"
                : from === "publishing" && to === "waiting_for_ci"
                  ? "publication"
                  : from === "waiting_for_ci" && to === "merge_approval_required"
                    ? "merge_gate"
                    : from === "merge_approval_required" && to === "verifying"
                      ? "gate_invalidated"
                      : from === "merge_approval_required" && to === "merging"
                        ? "merge_approval"
                        : from === "merging" && to === "merged"
                          ? "merge"
                          : undefined;
  if (expected === undefined || receipt.kind !== expected) {
    throw new Error(
      `phase transition from ${from} to ${to} requires a ${expected ?? "valid"} receipt`,
    );
  }
}

function requireNoPendingEffect(state: IssueLifecycleState): void {
  if (state.pendingEffect !== undefined) {
    throw new Error("pending external effect must settle before terminal transition");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
