import { describe, expect, it } from "vitest";

import {
  createInitialIssueLifecycleState,
  deriveIssueExternalEffectId,
  ISSUE_EXTERNAL_EFFECT_KINDS,
  ISSUE_LIFECYCLE_ACTIVE_PHASES,
  type IssueExternalEffectKind,
  type IssueExternalEffectResult,
  type IssueLifecycleEvent,
  type IssueLifecyclePhase,
  type IssueLifecyclePhaseReceipt,
  type IssueLifecycleState,
  parseIssueLifecycleEvent,
  projectPublicIssueLifecycleState,
  reduceIssueLifecycleEvent,
} from "../../../src/domain/issue-lifecycle/events.js";

const RUN_ID = "issue-run-01";
const STARTED_AT = "2026-08-28T10:00:00.000Z";
const CANDIDATE_HEAD = "a".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const DIGEST = "f".repeat(64);
const OTHER_DIGEST = "e".repeat(64);
const PULL_REQUEST_NUMBER = 2;
const PULL_REQUEST_NODE_ID = "PR_node";
const BRANCH = "flow/issue-1";
const BASE_BRANCH = "main";
const BASE_COMMIT = "b".repeat(40);
const OTHER_BASE_COMMIT = "9".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
const ISSUE_NODE_ID = "I_node";
const ISSUE_UPDATED_AT = "2026-08-28T10:00:00.000Z";
const FROZEN_CONTRACT_DIGEST = "1".repeat(64);
const PLAN_DIGEST = "2".repeat(64);
const IMPLEMENTATION_TEMPLATE_WORKFLOW_DIGEST = "3".repeat(64);
const REVIEW_TEMPLATE_WORKFLOW_DIGEST = "4".repeat(64);
const BUDGET_DIGEST = "5".repeat(64);
const EXECUTION_WORKFLOW_DIGEST = "6".repeat(64);

describe("issue lifecycle events", () => {
  it("rejects phase progress without restart-safe typed evidence", () => {
    const state = initialState();
    const event = transition(state, "issue_frozen");
    if (event.type !== "phase_transitioned") throw new Error("expected transition fixture");
    const { receipt: _receipt, ...withoutReceipt } = event;

    expect(() => reduceIssueLifecycleEvent(state, withoutReceipt as IssueLifecycleEvent)).toThrow(
      /receipt/i,
    );
  });

  it("replays the complete exact-identity lifecycle with applied external effects", () => {
    const state = advanceTo("merged");

    expect(state).toMatchObject({
      phase: "merged",
      settledEffectCount: 6,
      receiptCount: 10,
      frozenBranch: BRANCH,
      frozenIssueNumber: 1,
      frozenBaseBranch: BASE_BRANCH,
      frozenBaseCommit: BASE_COMMIT,
      frozenIssueNodeId: ISSUE_NODE_ID,
      frozenIssueUpdatedAt: ISSUE_UPDATED_AT,
      frozenIssueDigest: DIGEST,
      frozenContractDigest: FROZEN_CONTRACT_DIGEST,
      frozenPlanDigest: PLAN_DIGEST,
      frozenImplementationTemplateWorkflowDigest: IMPLEMENTATION_TEMPLATE_WORKFLOW_DIGEST,
      frozenReviewTemplateWorkflowDigest: REVIEW_TEMPLATE_WORKFLOW_DIGEST,
      frozenBudgetDigest: BUDGET_DIGEST,
      candidateHead: CANDIDATE_HEAD,
      publication: {
        candidateHead: CANDIDATE_HEAD,
        branch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        pullRequestNodeId: PULL_REQUEST_NODE_ID,
      },
      mergeGate: {
        baseBranch: BASE_BRANCH,
        baseCommit: BASE_COMMIT,
        branch: BRANCH,
      },
      approvedMerge: { candidateHead: CANDIDATE_HEAD, gateDigest: DIGEST },
    });
    expect(state).not.toHaveProperty("phaseReceipts");
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("requires applied workspace, publication, and merge effects before progress", () => {
    let state = advanceTo("issue_frozen");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"))).toThrow(
      /requires applied external effects: workspace/i,
    );

    state = settleEffect(state, "workspace", "not_applied");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"))).toThrow(
      /workspace/i,
    );

    state = settleEffect(state, "workspace");
    state = reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"));
    expect(state.phase).toBe("workspace_prepared");

    state = advanceTo("implementing");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "verifying"))).toThrow(
      /commit/i,
    );
    state = settleEffect(state, "commit");
    expect(reduceIssueLifecycleEvent(state, transition(state, "verifying")).phase).toBe(
      "verifying",
    );

    state = advanceTo("publishing");
    state = settleEffect(state, "push");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"))).toThrow(
      /pull_request.*pull_request_ready/i,
    );
    state = settleEffect(state, "pull_request");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"))).toThrow(
      /pull_request_ready/i,
    );
    state = settleEffect(state, "pull_request_ready");
    state = reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"));
    expect(state.phase).toBe("waiting_for_ci");

    state = advanceTo("merging");
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "merged"))).toThrow(/merge/i);
    state = settleEffect(state, "merge");
    expect(reduceIssueLifecycleEvent(state, transition(state, "merged")).phase).toBe("merged");
  });

  it("requires an applied settlement to contain the typed result for its prepared effect", () => {
    let state = advanceTo("issue_frozen");
    state = reduceIssueLifecycleEvent(state, prepareEffect(state, "workspace"));

    expect(() =>
      reduceIssueLifecycleEvent(state, {
        ...baseEvent(state),
        type: "external_effect_settled",
        effectId: state.pendingEffect?.effectId ?? "missing",
        outcome: "applied",
        observationDigest: "b".repeat(64),
      } as IssueLifecycleEvent),
    ).toThrow(/result/i);
    expect(() =>
      reduceIssueLifecycleEvent(state, {
        ...baseEvent(state),
        type: "external_effect_settled",
        effectId: state.pendingEffect?.effectId ?? "missing",
        outcome: "applied",
        observationDigest: "b".repeat(64),
        result: { kind: "commit", candidateHead: CANDIDATE_HEAD },
      } as IssueLifecycleEvent),
    ).toThrow(/prepared effect/i);
  });

  it("prohibits a typed result when an external effect was not applied", () => {
    let state = advanceTo("issue_frozen");
    state = reduceIssueLifecycleEvent(state, prepareEffect(state, "workspace"));

    expect(() =>
      reduceIssueLifecycleEvent(state, {
        ...baseEvent(state),
        type: "external_effect_settled",
        effectId: state.pendingEffect?.effectId ?? "missing",
        outcome: "not_applied",
        observationDigest: "b".repeat(64),
        result: { kind: "workspace", workspaceIdentityDigest: DIGEST },
      } as IssueLifecycleEvent),
    ).toThrow(/unrecognized key|result/i);
  });

  it("rejects a prepared effect whose identifier is not derived from its kind and operation", () => {
    const state = advanceTo("issue_frozen");

    expect(() =>
      reduceIssueLifecycleEvent(state, {
        ...prepareEffect(state, "workspace"),
        effectId: "effect-workspace-wrong",
      } as IssueLifecycleEvent),
    ).toThrow(/effect identifier/i);
  });

  it("binds the workspace receipt to the applied workspace identity", () => {
    let state = advanceTo("issue_frozen");
    state = settleEffect(state, "workspace", "applied", {
      kind: "workspace",
      workspaceIdentityDigest: OTHER_DIGEST,
    });

    expect(() => reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"))).toThrow(
      /workspace.*result/i,
    );
  });

  it("binds the implementation receipt to the durably applied candidate commit", () => {
    let state = advanceTo("implementing");
    state = settleEffect(state, "commit", "applied", {
      kind: "commit",
      candidateHead: OTHER_HEAD,
    });

    expect(() => reduceIssueLifecycleEvent(state, transition(state, "verifying"))).toThrow(
      /implementation.*commit/i,
    );
  });

  it.each(["HEAD", "flow//issue-1", "flow/issue-1.lock"])(
    "rejects invalid frozen branch %s in the issue snapshot",
    (branch) => {
      const state = initialState();
      const receipt = receiptOfKind(state, "issue_frozen", "issue_snapshot");

      expectTransitionRejected(
        state,
        "issue_frozen",
        { ...receipt, branch } as IssueLifecyclePhaseReceipt,
        /branch/i,
      );
    },
  );

  it.each(["HEAD", "release//next", "release/next.lock"])(
    "rejects invalid frozen base branch %s in the issue snapshot",
    (baseBranch) => {
      const state = initialState();
      const receipt = receiptOfKind(state, "issue_frozen", "issue_snapshot");

      expectTransitionRejected(
        state,
        "issue_frozen",
        { ...receipt, baseBranch } as IssueLifecyclePhaseReceipt,
        /baseBranch|branch/i,
      );
    },
  );

  it("rejects a derived Flow branch equal to the frozen base branch", () => {
    const state = initialState();
    const receipt = receiptOfKind(state, "issue_frozen", "issue_snapshot");

    expectTransitionRejected(
      state,
      "issue_frozen",
      { ...receipt, branch: receipt.baseBranch } as IssueLifecyclePhaseReceipt,
      /distinct|base branch/i,
    );
  });

  it("canonicalizes repository identities before freezing and comparing them", () => {
    const initial = initialState();
    const snapshot = receiptOfKind(initial, "issue_frozen", "issue_snapshot");
    const frozen = reduceIssueLifecycleEvent(
      initial,
      transitionWithReceipt(initial, "issue_frozen", {
        ...snapshot,
        repositoryIdentity: "Owner/Repo",
      }),
    );
    expect(frozen.frozenRepositoryIdentity).toBe("owner/repo");
    expect(frozen.latestReceipt).toMatchObject({ repositoryIdentity: "owner/repo" });

    const waiting = advanceTo("waiting_for_ci");
    const gate = receiptOfKind(waiting, "merge_approval_required", "merge_gate");
    const gated = reduceIssueLifecycleEvent(
      waiting,
      transitionWithReceipt(waiting, "merge_approval_required", {
        ...gate,
        repositoryIdentity: "Owner/Repo",
      }),
    );
    expect(gated.mergeGate).toBeDefined();
    expect(gated.latestReceipt).toMatchObject({ repositoryIdentity: "owner/repo" });
  });

  it("rejects noncanonicalizable repository identities in receipts", () => {
    const initial = initialState();
    expectTransitionRejected(
      initial,
      "issue_frozen",
      {
        ...receiptOfKind(initial, "issue_frozen", "issue_snapshot"),
        repositoryIdentity: "owner/repo/other",
      },
      /repository/i,
    );

    const waiting = advanceTo("waiting_for_ci");
    expectTransitionRejected(
      waiting,
      "merge_approval_required",
      {
        ...receiptOfKind(waiting, "merge_approval_required", "merge_gate"),
        repositoryIdentity: "https://github.com/owner/repo",
      },
      /repository/i,
    );
  });

  it("rejects an applied push result for a branch other than the frozen branch", () => {
    const state = advanceTo("publishing");

    expect(() =>
      settleEffect(state, "push", "applied", {
        kind: "push",
        candidateHead: CANDIDATE_HEAD,
        branch: "flow/other",
      }),
    ).toThrow(/frozen branch/i);
  });

  it("rejects an invalid branch in an applied push result", () => {
    const state = advanceTo("publishing");

    expect(() =>
      settleEffect(state, "push", "applied", {
        kind: "push",
        candidateHead: CANDIDATE_HEAD,
        branch: "HEAD",
      }),
    ).toThrow(/branch/i);
  });

  it("rejects a pull request observed on branches outside the frozen authority", () => {
    let state = advanceTo("publishing");
    state = settleEffect(state, "push");

    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        headBranch: "flow/other",
      }),
    ).toThrow(/frozen branch/i);
    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        baseBranch: "release",
      }),
    ).toThrow(/frozen base branch/i);
    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        repositoryIdentity: "other/repo",
      }),
    ).toThrow(/frozen repository identity/i);
  });

  it("requires draft pull request creation before a distinct ready-for-review effect", () => {
    let state = advanceTo("publishing");
    state = settleEffect(state, "push");

    expect(() =>
      reduceIssueLifecycleEvent(state, prepareEffect(state, "pull_request_ready")),
    ).toThrow(/draft pull request/i);
    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        isDraft: false,
      } as unknown as IssueExternalEffectResult),
    ).toThrow(/isDraft|true/i);

    state = settleEffect(state, "pull_request");
    expect(() =>
      settleEffect(state, "pull_request_ready", "applied", {
        ...pullRequestReadyEffectResult(),
        candidateHead: OTHER_HEAD,
      }),
    ).toThrow(/draft pull request identity/i);
    expect(() =>
      settleEffect(state, "pull_request_ready", "applied", {
        ...pullRequestReadyEffectResult(),
        isDraft: true,
      } as unknown as IssueExternalEffectResult),
    ).toThrow(/isDraft|false/i);
  });

  it("requires and replays publication effects in push, draft, ready order", () => {
    let state = advanceTo("publishing");

    expect(() => reduceIssueLifecycleEvent(state, prepareEffect(state, "pull_request"))).toThrow(
      /applied push/i,
    );
    state = settleEffect(state, "push");
    state = settleEffect(state, "pull_request");
    state = settleEffect(state, "pull_request_ready");

    expect(state.appliedEffects.map(({ effectKind }) => effectKind)).toEqual([
      "push",
      "pull_request",
      "pull_request_ready",
    ]);
    expect(reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci")).phase).toBe(
      "waiting_for_ci",
    );
  });

  it("reuses one ready pull request after a candidate repair without recreating it", () => {
    let state = advanceTo("waiting_for_ci");
    const originalPublication = state.publication;

    state = reduceIssueLifecycleEvent(state, transition(state, "implementing"));
    expect(state.publication).toEqual(originalPublication);
    state = settleEffect(state, "commit", "applied", {
      kind: "commit",
      candidateHead: OTHER_HEAD,
    });
    state = reduceIssueLifecycleEvent(
      state,
      transitionWithReceipt(state, "verifying", {
        ...receiptOfKind(state, "verifying", "implementation"),
        candidateHead: OTHER_HEAD,
      }),
    );
    state = reduceIssueLifecycleEvent(
      state,
      transitionWithReceipt(state, "reviewing", {
        ...receiptOfKind(state, "reviewing", "verification"),
        candidateHead: OTHER_HEAD,
      }),
    );
    state = reduceIssueLifecycleEvent(
      state,
      transitionWithReceipt(state, "publishing", {
        ...receiptOfKind(state, "publishing", "review"),
        candidateHead: OTHER_HEAD,
      }),
    );
    state = settleEffect(state, "push", "applied", {
      kind: "push",
      candidateHead: OTHER_HEAD,
      branch: BRANCH,
    });

    expect(() => reduceIssueLifecycleEvent(state, prepareEffect(state, "pull_request"))).toThrow(
      /already exists|existing pull request/i,
    );
    state = settleEffect(state, "pull_request_ready", "applied", {
      ...pullRequestReadyEffectResult(),
      candidateHead: OTHER_HEAD,
    });
    state = reduceIssueLifecycleEvent(
      state,
      transitionWithReceipt(state, "waiting_for_ci", {
        ...receiptOfKind(state, "waiting_for_ci", "publication"),
        candidateHead: OTHER_HEAD,
      }),
    );

    expect(state.publication).toEqual({
      candidateHead: OTHER_HEAD,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestNodeId: PULL_REQUEST_NODE_ID,
    });
    expect(state.settledEffectCount).toBe(8);
  });

  it.each([
    ["repository", { repositoryIdentity: "other/repo" }],
    ["candidate", { candidateHead: OTHER_HEAD }],
    ["head branch", { headBranch: "flow/other" }],
    ["base branch", { baseBranch: "release" }],
    ["number", { pullRequestNumber: 99 }],
    ["node", { pullRequestNodeId: "PR_other" }],
  ] as const)("binds ready-for-review to the draft pull request %s identity", (_name, changed) => {
    let state = advanceTo("publishing");
    state = settleEffect(state, "push");
    state = settleEffect(state, "pull_request");

    expect(() =>
      settleEffect(state, "pull_request_ready", "applied", {
        ...pullRequestReadyEffectResult(),
        ...changed,
      }),
    ).toThrow(/draft pull request identity/i);
  });

  it.each([
    ["push candidate", "push", { kind: "push", candidateHead: OTHER_HEAD, branch: BRANCH }],
    [
      "pull request candidate",
      "pull_request",
      {
        kind: "pull_request",
        repositoryIdentity: "owner/repo",
        candidateHead: OTHER_HEAD,
        headBranch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        pullRequestNodeId: PULL_REQUEST_NODE_ID,
        isDraft: true,
      },
    ],
    [
      "pull request number",
      "pull_request",
      {
        kind: "pull_request",
        repositoryIdentity: "owner/repo",
        candidateHead: CANDIDATE_HEAD,
        headBranch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: 99,
        pullRequestNodeId: PULL_REQUEST_NODE_ID,
        isDraft: true,
      },
    ],
    [
      "pull request node",
      "pull_request",
      {
        kind: "pull_request",
        repositoryIdentity: "owner/repo",
        candidateHead: CANDIDATE_HEAD,
        headBranch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        pullRequestNodeId: "PR_other",
        isDraft: true,
      },
    ],
    [
      "ready pull request candidate",
      "pull_request_ready",
      {
        ...pullRequestReadyEffectResult(),
        candidateHead: OTHER_HEAD,
      },
    ],
  ] as const)("binds publication to the applied %s result", (_label, effectKind, result) => {
    let state = advanceTo("publishing");
    const pullRequestIdentity =
      effectKind === "pull_request" || effectKind === "pull_request_ready" ? result : undefined;
    for (const kind of ["push", "pull_request", "pull_request_ready"] as const) {
      const appliedResult =
        kind === "pull_request" && pullRequestIdentity !== undefined
          ? { ...pullRequestIdentity, kind: "pull_request" as const, isDraft: true as const }
          : kind === "pull_request_ready" && pullRequestIdentity !== undefined
            ? {
                ...pullRequestIdentity,
                kind: "pull_request_ready" as const,
                isDraft: false as const,
              }
            : kind === effectKind
              ? result
              : effectResult(kind);
      state = settleEffect(state, kind, "applied", appliedResult as IssueExternalEffectResult);
    }

    expect(() => reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"))).toThrow(
      /publication.*result/i,
    );
  });

  it.each([
    [
      "candidate",
      {
        kind: "merge",
        candidateHead: OTHER_HEAD,
        gateDigest: DIGEST,
        mergeCommit: MERGE_COMMIT,
        deleteBranchRequested: true,
        branchDeleted: true,
        proofDigest: DIGEST,
      },
    ],
    [
      "gate",
      {
        kind: "merge",
        candidateHead: CANDIDATE_HEAD,
        gateDigest: OTHER_DIGEST,
        mergeCommit: MERGE_COMMIT,
        deleteBranchRequested: true,
        branchDeleted: true,
        proofDigest: DIGEST,
      },
    ],
    [
      "merge commit",
      {
        kind: "merge",
        candidateHead: CANDIDATE_HEAD,
        gateDigest: DIGEST,
        mergeCommit: OTHER_HEAD,
        deleteBranchRequested: true,
        branchDeleted: true,
        proofDigest: DIGEST,
      },
    ],
    [
      "branch deletion",
      {
        kind: "merge",
        candidateHead: CANDIDATE_HEAD,
        gateDigest: DIGEST,
        mergeCommit: MERGE_COMMIT,
        deleteBranchRequested: true,
        branchDeleted: false,
        proofDigest: DIGEST,
      },
    ],
  ] as const)("binds the merge receipt to the applied %s result", (_label, result) => {
    let state = advanceTo("merging");
    if (_label === "branch deletion") {
      expect(() => settleEffect(state, "merge", "applied", result)).toThrow(/branch policy/i);
      return;
    }
    state = settleEffect(state, "merge", "applied", result);

    expect(() => reduceIssueLifecycleEvent(state, transition(state, "merged"))).toThrow(
      /merge.*result/i,
    );
  });

  it("rejects a final merge receipt that misreports the branch deletion outcome", () => {
    let state = advanceTo("merging");
    state = settleEffect(state, "merge");

    expectTransitionRejected(
      state,
      "merged",
      { ...receiptOfKind(state, "merged", "merge"), branchDeleted: false },
      /branch deletion policy|merge.*result/i,
    );
  });

  it("records repository auto-delete without claiming that Flow requested deletion", () => {
    let state = advanceTo("waiting_for_ci");
    state = reduceIssueLifecycleEvent(
      state,
      transitionWithReceipt(state, "merge_approval_required", {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        deleteBranch: false,
      }),
    );
    state = reduceIssueLifecycleEvent(state, transition(state, "merging"));
    state = settleEffect(state, "merge", "applied", {
      kind: "merge",
      candidateHead: CANDIDATE_HEAD,
      gateDigest: DIGEST,
      mergeCommit: MERGE_COMMIT,
      deleteBranchRequested: false,
      branchDeleted: true,
      proofDigest: DIGEST,
    });

    expect(
      reduceIssueLifecycleEvent(
        state,
        transitionWithReceipt(state, "merged", {
          ...receiptOfKind(state, "merged", "merge"),
          deleteBranchRequested: false,
          branchDeleted: true,
        }),
      ).phase,
    ).toBe("merged");

    let wrongRequestState = advanceTo("waiting_for_ci");
    wrongRequestState = reduceIssueLifecycleEvent(
      wrongRequestState,
      transitionWithReceipt(wrongRequestState, "merge_approval_required", {
        ...receiptOfKind(wrongRequestState, "merge_approval_required", "merge_gate"),
        deleteBranch: false,
      }),
    );
    const merging = reduceIssueLifecycleEvent(
      wrongRequestState,
      transition(wrongRequestState, "merging"),
    );
    expect(() =>
      settleEffect(merging, "merge", "applied", {
        kind: "merge",
        candidateHead: CANDIDATE_HEAD,
        gateDigest: DIGEST,
        mergeCommit: MERGE_COMMIT,
        deleteBranchRequested: true,
        branchDeleted: true,
        proofDigest: DIGEST,
      }),
    ).toThrow(/branch policy/i);
  });

  it("authorizes each external effect only in its owning phase", () => {
    const allowed = new Map<IssueLifecyclePhase, readonly IssueExternalEffectKind[]>([
      ["issue_frozen", ["workspace"]],
      ["implementing", ["commit"]],
      ["publishing", ["push", "pull_request", "pull_request_ready"]],
      ["merging", ["merge"]],
    ]);

    for (const phase of ISSUE_LIFECYCLE_ACTIVE_PHASES) {
      const state = advanceTo(phase);
      for (const effectKind of ISSUE_EXTERNAL_EFFECT_KINDS) {
        let preparedState = state;
        if (
          phase === "publishing" &&
          (effectKind === "pull_request" || effectKind === "pull_request_ready")
        ) {
          preparedState = settleEffect(preparedState, "push");
        }
        if (phase === "publishing" && effectKind === "pull_request_ready") {
          preparedState = settleEffect(preparedState, "pull_request");
        }
        const event = prepareEffect(preparedState, effectKind);
        if (allowed.get(phase)?.includes(effectKind) === true) {
          expect(reduceIssueLifecycleEvent(preparedState, event).pendingEffect?.effectKind).toBe(
            effectKind,
          );
        } else {
          expect(() => reduceIssueLifecycleEvent(preparedState, event)).toThrow(/not permitted/i);
        }
      }
    }
  });

  it("does not repeat an already-applied effect in the same phase", () => {
    const state = settleEffect(advanceTo("implementing"), "commit");

    expect(() => reduceIssueLifecycleEvent(state, prepareEffect(state, "commit"))).toThrow(
      /already applied/i,
    );
  });

  it("recovers an uncertain external acknowledgement only through exact settlement", () => {
    let state = advanceTo("issue_frozen");
    state = reduceIssueLifecycleEvent(state, prepareEffect(state, "workspace"));
    state = reduceIssueLifecycleEvent(state, {
      ...baseEvent(state),
      type: "external_state_uncertain",
      effectId: state.pendingEffect?.effectId ?? "missing",
      code: "acknowledgement_lost",
      evidenceDigest: DIGEST,
    });

    expect(state.phase).toBe("external_state_uncertain");
    expect(() =>
      reduceIssueLifecycleEvent(state, {
        ...baseEvent(state),
        type: "external_effect_settled",
        effectId: "other-effect",
        outcome: "not_applied",
        observationDigest: "c".repeat(64),
      }),
    ).toThrow(/does not match/i);

    state = reduceIssueLifecycleEvent(state, {
      ...baseEvent(state),
      type: "external_effect_settled",
      effectId: state.pendingEffect?.effectId ?? "missing",
      outcome: "not_applied",
      observationDigest: "c".repeat(64),
    });
    expect(state.phase).toBe("issue_frozen");
    expect(state.pendingEffect).toBeUndefined();
    expect(() => reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"))).toThrow(
      /workspace/i,
    );
  });

  it("rejects stale candidate identity at verification, review, and publication", () => {
    let state = advanceTo("verifying");
    expectTransitionRejected(
      state,
      "reviewing",
      { ...receiptOfKind(state, "reviewing", "verification"), candidateHead: OTHER_HEAD },
      /candidate head/i,
    );
    state = reduceIssueLifecycleEvent(state, transition(state, "reviewing"));

    expectTransitionRejected(
      state,
      "publishing",
      { ...receiptOfKind(state, "publishing", "review"), candidateHead: OTHER_HEAD },
      /candidate head/i,
    );
    state = reduceIssueLifecycleEvent(state, transition(state, "publishing"));
    state = settlePublicationEffects(state);

    expectTransitionRejected(
      state,
      "waiting_for_ci",
      { ...receiptOfKind(state, "waiting_for_ci", "publication"), candidateHead: OTHER_HEAD },
      /candidate head/i,
    );
    expectTransitionRejected(
      state,
      "waiting_for_ci",
      { ...receiptOfKind(state, "waiting_for_ci", "publication"), branch: "flow/other" },
      /frozen branch/i,
    );
    expectTransitionRejected(
      state,
      "waiting_for_ci",
      { ...receiptOfKind(state, "waiting_for_ci", "publication"), branch: "HEAD" },
      /branch/i,
    );
    expectTransitionRejected(
      state,
      "waiting_for_ci",
      { ...receiptOfKind(state, "waiting_for_ci", "publication"), baseBranch: "release" },
      /frozen base branch/i,
    );
  });

  it("rejects stale pull request and gate identity through final merge", () => {
    let state = advanceTo("waiting_for_ci");
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        candidateHead: OTHER_HEAD,
      },
      /candidate head/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        pullRequestNumber: 99,
      },
      /pull request identity/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        pullRequestNodeId: "PR_other",
      },
      /pull request identity/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        repositoryIdentity: "other/repo",
      },
      /repository identity/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        baseBranch: "release",
      } as IssueLifecyclePhaseReceipt,
      /frozen base branch/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        baseCommit: OTHER_BASE_COMMIT,
      } as IssueLifecyclePhaseReceipt,
      /frozen base commit/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        baseBranch: "HEAD",
      } as IssueLifecyclePhaseReceipt,
      /baseBranch|branch/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        branch: "flow/other",
      } as IssueLifecyclePhaseReceipt,
      /frozen branch/i,
    );
    expectTransitionRejected(
      state,
      "merge_approval_required",
      {
        ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
        branch: "HEAD",
      } as IssueLifecyclePhaseReceipt,
      /branch/i,
    );
    state = reduceIssueLifecycleEvent(state, transition(state, "merge_approval_required"));

    expectTransitionRejected(
      state,
      "merging",
      { ...receiptOfKind(state, "merging", "merge_approval"), candidateHead: OTHER_HEAD },
      /current merge gate/i,
    );
    expectTransitionRejected(
      state,
      "merging",
      { ...receiptOfKind(state, "merging", "merge_approval"), gateDigest: OTHER_DIGEST },
      /current merge gate/i,
    );
    state = reduceIssueLifecycleEvent(state, transition(state, "merging"));
    state = settleEffect(state, "merge");

    expectTransitionRejected(
      state,
      "merged",
      { ...receiptOfKind(state, "merged", "merge"), candidateHead: OTHER_HEAD },
      /approved candidate and gate/i,
    );
    expectTransitionRejected(
      state,
      "merged",
      { ...receiptOfKind(state, "merged", "merge"), gateDigest: OTHER_DIGEST },
      /approved candidate and gate/i,
    );
  });

  it("invalidates candidate authority on every implementation repair loop", () => {
    for (const repairPhase of ["verifying", "reviewing", "waiting_for_ci"] as const) {
      const state = advanceTo(repairPhase);
      expectTransitionRejected(
        state,
        "implementing",
        {
          ...receiptOfKind(state, "implementing", "implementation_started"),
          iteration: state.implementationIteration,
        },
        /iteration must advance/i,
      );

      const repaired = reduceIssueLifecycleEvent(state, transition(state, "implementing"));
      expect(repaired).toMatchObject({
        phase: "implementing",
        implementationIteration: 2,
        frozenBranch: BRANCH,
        frozenIssueNumber: 1,
        frozenBaseBranch: BASE_BRANCH,
        frozenBaseCommit: BASE_COMMIT,
        frozenIssueDigest: DIGEST,
        frozenContractDigest: FROZEN_CONTRACT_DIGEST,
      });
      expect(repaired.candidateHead).toBeUndefined();
      if (repairPhase === "waiting_for_ci") expect(repaired.publication).toBeDefined();
      else expect(repaired.publication).toBeUndefined();
      expect(repaired.mergeGate).toBeUndefined();
      expect(repaired.approvedMerge).toBeUndefined();
      expect(() => reduceIssueLifecycleEvent(repaired, transition(repaired, "verifying"))).toThrow(
        /commit/i,
      );
    }
  });

  it("preserves exact candidate and PR identity while invalidating a stale gate", () => {
    let state = advanceTo("merge_approval_required");
    expectTransitionRejected(
      state,
      "verifying",
      { ...receiptOfKind(state, "verifying", "gate_invalidated"), candidateHead: OTHER_HEAD },
      /current merge gate/i,
    );
    expectTransitionRejected(
      state,
      "verifying",
      { ...receiptOfKind(state, "verifying", "gate_invalidated"), gateDigest: OTHER_DIGEST },
      /current merge gate/i,
    );

    state = reduceIssueLifecycleEvent(state, transition(state, "verifying"));
    expect(state.candidateHead).toBe(CANDIDATE_HEAD);
    expect(state.frozenBranch).toBe(BRANCH);
    expect(state.frozenBaseBranch).toBe(BASE_BRANCH);
    expect(state.frozenBaseCommit).toBe(BASE_COMMIT);
    expect(state.publication).toMatchObject({
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestNodeId: PULL_REQUEST_NODE_ID,
    });
    expect(state.mergeGate).toBeUndefined();

    state = reduceIssueLifecycleEvent(state, transition(state, "reviewing"));
    state = reduceIssueLifecycleEvent(state, transition(state, "publishing"));
    state = settlePublicationEffects(state);
    expectTransitionRejected(
      state,
      "waiting_for_ci",
      {
        ...receiptOfKind(state, "waiting_for_ci", "publication"),
        pullRequestNodeId: "PR_replacement",
      },
      /existing pull request identity/i,
    );
    expect(reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci")).phase).toBe(
      "waiting_for_ci",
    );
  });

  it("retains constant-space receipt state across repeated gate invalidation", () => {
    let state = advanceTo("merge_approval_required");
    for (let cycle = 0; cycle < 128; cycle += 1) {
      state = reduceIssueLifecycleEvent(state, transition(state, "verifying"));
      state = reduceIssueLifecycleEvent(state, transition(state, "reviewing"));
      state = reduceIssueLifecycleEvent(state, transition(state, "publishing"));
      state = settlePublicationEffects(state);
      state = reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"));
      state = reduceIssueLifecycleEvent(state, transition(state, "merge_approval_required"));
    }

    expect(state.receiptCount).toBe(8 + 128 * 5);
    expect(state.latestReceipt?.kind).toBe("merge_gate");
    expect(state).not.toHaveProperty("phaseReceipts");
    expect(JSON.stringify(state).length).toBeLessThan(3_000);
  });

  it("rejects gaps, cross-run events, illegal transitions, and terminal mutations", () => {
    const initial = initialState();
    expect(() =>
      reduceIssueLifecycleEvent(initial, { ...transition(initial, "issue_frozen"), sequence: 2 }),
    ).toThrow(/sequence/i);
    expect(() =>
      reduceIssueLifecycleEvent(initial, {
        ...transition(initial, "issue_frozen"),
        runId: "other",
      }),
    ).toThrow(/run identity/i);
    expect(() => reduceIssueLifecycleEvent(initial, transition(initial, "implementing"))).toThrow(
      /illegal.*transition/i,
    );

    const cancelled = reduceIssueLifecycleEvent(initial, {
      ...baseEvent(initial),
      type: "run_cancelled",
      actorDigest: "d".repeat(64),
      reasonDigest: "e".repeat(64),
    });
    expect(() =>
      reduceIssueLifecycleEvent(cancelled, {
        ...baseEvent(cancelled),
        type: "run_cancelled",
        actorDigest: DIGEST,
      }),
    ).toThrow(/terminal/i);
  });

  it("accepts equal event timestamps but rejects clock regression", () => {
    const state = initialState();
    const sameTimestamp = {
      ...transition(state, "issue_frozen"),
      at: state.lastEventAt,
    };
    const advanced = reduceIssueLifecycleEvent(state, sameTimestamp);

    expect(advanced.lastEventAt).toBe(state.lastEventAt);
    expect(() =>
      reduceIssueLifecycleEvent(advanced, {
        ...prepareEffect(advanced, "workspace"),
        at: "2026-08-28T09:59:59.999Z",
      }),
    ).toThrow(/must not regress/i);
  });

  it.each([
    ["issue number", "issue_snapshot", "issueNumber"],
    ["publication pull request number", "publication", "pullRequestNumber"],
    ["merge gate pull request number", "merge_gate", "pullRequestNumber"],
  ] as const)("rejects an unsafe %s", (_name, kind, field) => {
    const target =
      kind === "issue_snapshot"
        ? { state: initialState(), to: "issue_frozen" as const }
        : kind === "publication"
          ? {
              state: settlePublicationEffects(advanceTo("publishing")),
              to: "waiting_for_ci" as const,
            }
          : { state: advanceTo("waiting_for_ci"), to: "merge_approval_required" as const };
    const receipt = receiptOfKind(target.state, target.to, kind);

    expectTransitionRejected(
      target.state,
      target.to,
      { ...receipt, [field]: Number.MAX_SAFE_INTEGER + 1 } as IssueLifecyclePhaseReceipt,
      /number|safe/i,
    );
  });

  it.each(["PR node", "PR_\u0007node", "PR_\u202enode", "x".repeat(257)])(
    "rejects unsafe pull request node identity %s",
    (pullRequestNodeId) => {
      const state = advanceTo("waiting_for_ci");

      expectTransitionRejected(
        state,
        "merge_approval_required",
        {
          ...receiptOfKind(state, "merge_approval_required", "merge_gate"),
          pullRequestNodeId,
        },
        /node|identity/i,
      );
    },
  );

  it("rejects unsafe pull request identifiers in applied results", () => {
    let state = advanceTo("publishing");
    state = settleEffect(state, "push");

    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        pullRequestNumber: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/number|safe/i);
    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        pullRequestNodeId: "PR_\u0007node",
      }),
    ).toThrow(/node|identity/i);
    expect(() =>
      settleEffect(state, "pull_request", "applied", {
        ...pullRequestEffectResult(),
        repositoryIdentity: "owner/repo/other",
      }),
    ).toThrow(/repository/i);
  });

  it("canonicalizes the repository identity in an applied pull request result", () => {
    let state = advanceTo("publishing");
    state = settleEffect(state, "push");
    state = settleEffect(state, "pull_request", "applied", {
      ...pullRequestEffectResult(),
      repositoryIdentity: "Owner/Repo",
    });

    expect(state.appliedEffects.at(-1)?.result).toMatchObject({
      kind: "pull_request",
      repositoryIdentity: "owner/repo",
    });
  });

  it("strictly validates events and projects content-free bounded public state", () => {
    expect(() =>
      parseIssueLifecycleEvent({
        version: 1,
        runId: RUN_ID,
        sequence: 1,
        at: "2026-08-28T10:00:01.000Z",
        type: "run_failed",
        code: "verification_failed",
        evidenceDigest: DIGEST,
        secret: "must not pass",
      }),
    ).toThrow(/unrecognized key/i);

    let state = advanceTo("issue_frozen");
    state = reduceIssueLifecycleEvent(state, prepareEffect(state, "workspace"));
    const projected = projectPublicIssueLifecycleState(state);

    expect(projected).toEqual({
      version: 1,
      runId: RUN_ID,
      phase: "issue_frozen",
      sequence: 2,
      lastEventAt: eventTime(2),
      pendingEffect: {
        effectId: `effect-workspace-${"a".repeat(64)}`,
        effectKind: "workspace",
        operationDigest: "a".repeat(64),
        preparedSequence: 2,
      },
      settledEffectCount: 0,
      receiptCount: 1,
      latestReceipt: receiptFor(initialState(), "issue_frozen"),
    });
    expect(projected).not.toHaveProperty("candidateHead");
    expect(projected).not.toHaveProperty("frozenBaseBranch");
    expect(projected).not.toHaveProperty("frozenBaseCommit");
    expect(projected).not.toHaveProperty("publication");
    expect(projected).not.toHaveProperty("appliedEffects");
    expect(JSON.stringify(projected)).not.toMatch(/secret|reason|content|absolute/i);
  });

  it("requires private-evidence digests for uncertain and failed outcomes", () => {
    let state = advanceTo("issue_frozen");
    state = reduceIssueLifecycleEvent(state, prepareEffect(state, "workspace"));

    expect(() =>
      parseIssueLifecycleEvent({
        ...baseEvent(state),
        type: "external_state_uncertain",
        effectId: state.pendingEffect?.effectId ?? "missing",
        code: "acknowledgement_lost",
      }),
    ).toThrow(/evidenceDigest/i);
    expect(() =>
      parseIssueLifecycleEvent({
        ...baseEvent(initialState()),
        type: "run_failed",
        code: "verification_failed",
      }),
    ).toThrow(/evidenceDigest/i);
  });

  it("projects an exact merge approval only while that gate is current", () => {
    let state = advanceTo("merge_approval_required");
    expect(projectPublicIssueLifecycleState(state).mergeApproval).toEqual({
      pullRequestNumber: PULL_REQUEST_NUMBER,
      headCommit: CANDIDATE_HEAD,
      gateDigest: DIGEST,
    });

    state = reduceIssueLifecycleEvent(state, transition(state, "merging"));
    expect(projectPublicIssueLifecycleState(state).mergeApproval).toBeUndefined();
  });
});

function initialState(): IssueLifecycleState {
  return createInitialIssueLifecycleState(RUN_ID, STARTED_AT);
}

function advanceTo(target: IssueLifecyclePhase): IssueLifecycleState {
  let state = initialState();
  if (target === "preflight") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "issue_frozen"));
  if (target === "issue_frozen") return state;
  state = settleEffect(state, "workspace");
  state = reduceIssueLifecycleEvent(state, transition(state, "workspace_prepared"));
  if (target === "workspace_prepared") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "implementing"));
  if (target === "implementing") return state;
  state = settleEffect(state, "commit");
  state = reduceIssueLifecycleEvent(state, transition(state, "verifying"));
  if (target === "verifying") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "reviewing"));
  if (target === "reviewing") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "publishing"));
  if (target === "publishing") return state;
  state = settlePublicationEffects(state);
  state = reduceIssueLifecycleEvent(state, transition(state, "waiting_for_ci"));
  if (target === "waiting_for_ci") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "merge_approval_required"));
  if (target === "merge_approval_required") return state;
  state = reduceIssueLifecycleEvent(state, transition(state, "merging"));
  if (target === "merging") return state;
  state = settleEffect(state, "merge");
  return reduceIssueLifecycleEvent(state, transition(state, "merged"));
}

function settlePublicationEffects(state: IssueLifecycleState): IssueLifecycleState {
  let current = settleEffect(state, "push");
  if (state.publication !== undefined) {
    return settleEffect(current, "pull_request_ready");
  }
  current = settleEffect(current, "pull_request");
  return settleEffect(current, "pull_request_ready");
}

function settleEffect(
  state: IssueLifecycleState,
  effectKind: IssueExternalEffectKind,
  outcome: "applied" | "not_applied" = "applied",
  result = effectResult(effectKind),
): IssueLifecycleState {
  const prepared = reduceIssueLifecycleEvent(state, prepareEffect(state, effectKind));
  return reduceIssueLifecycleEvent(prepared, {
    ...baseEvent(prepared),
    type: "external_effect_settled",
    effectId: prepared.pendingEffect?.effectId ?? "missing",
    outcome,
    observationDigest: "b".repeat(64),
    ...(outcome === "applied" ? { result } : {}),
  } as IssueLifecycleEvent);
}

function prepareEffect(
  state: IssueLifecycleState,
  effectKind: IssueExternalEffectKind,
): IssueLifecycleEvent {
  return {
    ...baseEvent(state),
    type: "external_effect_prepared",
    effectId: deriveIssueExternalEffectId(effectKind, "a".repeat(64)),
    effectKind,
    operationDigest: "a".repeat(64),
  };
}

function effectResult(effectKind: IssueExternalEffectKind) {
  switch (effectKind) {
    case "workspace":
      return { kind: "workspace" as const, workspaceIdentityDigest: DIGEST };
    case "commit":
      return { kind: "commit" as const, candidateHead: CANDIDATE_HEAD };
    case "push":
      return { kind: "push" as const, candidateHead: CANDIDATE_HEAD, branch: BRANCH };
    case "pull_request":
      return {
        kind: "pull_request" as const,
        repositoryIdentity: "owner/repo",
        candidateHead: CANDIDATE_HEAD,
        headBranch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        pullRequestNodeId: PULL_REQUEST_NODE_ID,
        isDraft: true as const,
      };
    case "pull_request_ready":
      return {
        kind: "pull_request_ready" as const,
        repositoryIdentity: "owner/repo",
        candidateHead: CANDIDATE_HEAD,
        headBranch: BRANCH,
        baseBranch: BASE_BRANCH,
        pullRequestNumber: PULL_REQUEST_NUMBER,
        pullRequestNodeId: PULL_REQUEST_NODE_ID,
        isDraft: false as const,
      };
    case "merge":
      return {
        kind: "merge" as const,
        candidateHead: CANDIDATE_HEAD,
        gateDigest: DIGEST,
        mergeCommit: MERGE_COMMIT,
        deleteBranchRequested: true,
        branchDeleted: true,
        proofDigest: DIGEST,
      };
  }
}

function pullRequestEffectResult(): Extract<
  IssueExternalEffectResult,
  { readonly kind: "pull_request" }
> {
  const result = effectResult("pull_request");
  if (result.kind !== "pull_request") throw new Error("expected pull request result fixture");
  return result;
}

function pullRequestReadyEffectResult(): Extract<
  IssueExternalEffectResult,
  { readonly kind: "pull_request_ready" }
> {
  const result = effectResult("pull_request_ready");
  if (result.kind !== "pull_request_ready") {
    throw new Error("expected ready pull request result fixture");
  }
  return result;
}

function expectTransitionRejected(
  state: IssueLifecycleState,
  to: Extract<IssueLifecycleEvent, { type: "phase_transitioned" }>["to"],
  receipt: IssueLifecyclePhaseReceipt,
  expected: RegExp,
): void {
  expect(() => reduceIssueLifecycleEvent(state, transitionWithReceipt(state, to, receipt))).toThrow(
    expected,
  );
}

function transitionWithReceipt(
  state: IssueLifecycleState,
  to: Extract<IssueLifecycleEvent, { type: "phase_transitioned" }>["to"],
  receipt: IssueLifecyclePhaseReceipt,
): IssueLifecycleEvent {
  const event = transition(state, to);
  if (event.type !== "phase_transitioned") throw new Error("expected transition fixture");
  return { ...event, receipt };
}

function transition(
  state: IssueLifecycleState,
  to: Extract<IssueLifecycleEvent, { type: "phase_transitioned" }>["to"],
): IssueLifecycleEvent {
  if (
    state.phase === "external_state_uncertain" ||
    state.phase === "merged" ||
    state.phase === "failed" ||
    state.phase === "cancelled"
  ) {
    throw new Error("test fixture cannot transition terminal or uncertain state");
  }
  return {
    ...baseEvent(state),
    type: "phase_transitioned",
    from: state.phase,
    to,
    receipt: receiptFor(state, to),
  };
}

function receiptFor(
  state: IssueLifecycleState,
  to: IssueLifecyclePhase,
): IssueLifecyclePhaseReceipt {
  const from = state.phase;
  if (from === "preflight") {
    return {
      kind: "issue_snapshot",
      repositoryIdentity: "owner/repo",
      issueNumber: 1,
      issueNodeId: ISSUE_NODE_ID,
      issueUpdatedAt: ISSUE_UPDATED_AT,
      baseBranch: BASE_BRANCH,
      baseCommit: BASE_COMMIT,
      branch: BRANCH,
      issueDigest: DIGEST,
      frozenContractDigest: FROZEN_CONTRACT_DIGEST,
      planDigest: PLAN_DIGEST,
      implementationTemplateWorkflowDigest: IMPLEMENTATION_TEMPLATE_WORKFLOW_DIGEST,
      reviewTemplateWorkflowDigest: REVIEW_TEMPLATE_WORKFLOW_DIGEST,
      budgetDigest: BUDGET_DIGEST,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "issue_frozen") {
    return { kind: "workspace", workspaceIdentityDigest: DIGEST, evidenceDigest: DIGEST };
  }
  if (to === "implementing") {
    return {
      kind: "implementation_started",
      iteration: state.implementationIteration + 1,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "implementing") {
    return {
      kind: "implementation",
      candidateHead: CANDIDATE_HEAD,
      flowRunId: "flow-run-01",
      executionWorkflowDigest: EXECUTION_WORKFLOW_DIGEST,
      terminalSequence: 21,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "verifying") {
    return { kind: "verification", candidateHead: CANDIDATE_HEAD, evidenceDigest: DIGEST };
  }
  if (from === "reviewing") {
    return {
      kind: "review",
      candidateHead: CANDIDATE_HEAD,
      flowRunId: "review-run-01",
      executionWorkflowDigest: EXECUTION_WORKFLOW_DIGEST,
      terminalSequence: 13,
      reportDigest: DIGEST,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "publishing") {
    return {
      kind: "publication",
      candidateHead: CANDIDATE_HEAD,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestNodeId: PULL_REQUEST_NODE_ID,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "waiting_for_ci") {
    return {
      kind: "merge_gate",
      repositoryIdentity: "owner/repo",
      baseBranch: BASE_BRANCH,
      baseCommit: BASE_COMMIT,
      branch: BRANCH,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestNodeId: PULL_REQUEST_NODE_ID,
      candidateHead: CANDIDATE_HEAD,
      checksDigest: DIGEST,
      gateDigest: DIGEST,
      deleteBranch: true,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "merge_approval_required" && to === "verifying") {
    return {
      kind: "gate_invalidated",
      candidateHead: CANDIDATE_HEAD,
      gateDigest: DIGEST,
      evidenceDigest: DIGEST,
    };
  }
  if (from === "merge_approval_required") {
    return {
      kind: "merge_approval",
      candidateHead: CANDIDATE_HEAD,
      gateDigest: DIGEST,
      actorDigest: DIGEST,
      evidenceDigest: DIGEST,
    };
  }
  return {
    kind: "merge",
    candidateHead: CANDIDATE_HEAD,
    gateDigest: DIGEST,
    mergeCommit: MERGE_COMMIT,
    deleteBranchRequested: true,
    branchDeleted: true,
    evidenceDigest: DIGEST,
  };
}

function receiptOfKind<Kind extends IssueLifecyclePhaseReceipt["kind"]>(
  state: IssueLifecycleState,
  to: IssueLifecyclePhase,
  kind: Kind,
): Extract<IssueLifecyclePhaseReceipt, { readonly kind: Kind }> {
  const receipt = receiptFor(state, to);
  if (receipt.kind !== kind) {
    throw new Error(`expected ${kind} receipt fixture, received ${receipt.kind}`);
  }
  return receipt as Extract<IssueLifecyclePhaseReceipt, { readonly kind: Kind }>;
}

function baseEvent(state: IssueLifecycleState) {
  return {
    version: 1 as const,
    runId: state.runId,
    sequence: state.sequence + 1,
    at: eventTime(state.sequence + 1),
  };
}

function eventTime(sequence: number): string {
  return new Date(Date.parse(STARTED_AT) + sequence * 1_000).toISOString();
}
