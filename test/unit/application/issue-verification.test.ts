import { describe, expect, it } from "vitest";

import {
  assessGitHubObservation,
  buildIssueMergeGate,
  validateIssueVerificationResult,
} from "../../../src/application/issue-verification.js";
import { parseGitHubLifecycleObservation } from "../../../src/domain/issue-lifecycle/github-observation.js";
import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  parseIssuePrivateManifest,
} from "../../../src/domain/issue-lifecycle/private-manifest.js";
import { parseIssueReviewReport } from "../../../src/domain/issue-lifecycle/review.js";

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const at = "2026-08-28T12:00:00.000Z";

describe("issue verification", () => {
  it("accepts only a failing frozen-base holdout and exact-head passing candidate evidence", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const result = verification(candidateHead);
    const deterministicResult = result.deterministic[0];
    if (deterministicResult === undefined) throw new Error("verification fixture is empty");

    expect(validateIssueVerificationResult(manifest, candidateHead, result)).toEqual(result);
    expect(() =>
      validateIssueVerificationResult(manifest, candidateHead, {
        ...result,
        negativeControl: { ...result.negativeControl, baseOutcome: "passed" },
      }),
    ).toThrow(/base holdout must fail/);
    expect(() =>
      validateIssueVerificationResult(manifest, candidateHead, {
        ...result,
        deterministic: [{ ...deterministicResult, headCommit: commit("d") }],
      }),
    ).toThrow(/exact candidate head/);
  });

  it("accepts a delete-only candidate when logical bytes include removed base content", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const result = verification(candidateHead);

    expect(
      validateIssueVerificationResult(manifest, candidateHead, {
        ...result,
        candidateDelta: {
          ...result.candidateDelta,
          pathCount: 1,
          logicalBytes: 128,
          relevant: true,
        },
      }).candidateDelta,
    ).toMatchObject({ pathCount: 1, logicalBytes: 128, relevant: true });
  });

  it("waits for incomplete required checks and rejects same-name checks from another app", () => {
    const manifest = frozenManifest();
    const pending = observation(commit("c"), {
      status: "in_progress",
      conclusion: null,
    });
    expect(assessGitHubObservation(manifest, 7, commit("c"), pending)).toEqual({
      status: "waiting",
      reason: "required_checks_incomplete",
    });

    const collision = observation(commit("c"));
    const requiredCheck = collision.checks.nodes[0];
    if (requiredCheck === undefined) throw new Error("check fixture is empty");
    const unexpected = {
      ...collision,
      checks: {
        ...collision.checks,
        totalCount: 2,
        nodes: [
          ...collision.checks.nodes,
          { ...requiredCheck, runId: 88, sourceApp: { id: 9, slug: "other" } },
        ],
        pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 2 }],
      },
    };
    expect(() => assessGitHubObservation(manifest, 7, commit("c"), unexpected)).toThrow(
      /unexpected source app/,
    );
  });

  it("uses each reviewer's latest submitted state when checking merge blockers", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const observed = observation(candidateHead);
    const reviews = [
      {
        nodeId: "RV_first",
        authorDigest: sha("8"),
        bodyDigest: sha("9"),
        state: "changes_requested" as const,
        submittedAt: "2026-08-28T11:58:00.000Z",
        commit: candidateHead,
      },
      {
        nodeId: "RV_second",
        authorDigest: sha("8"),
        bodyDigest: sha("7"),
        state: "approved" as const,
        submittedAt: "2026-08-28T11:59:00.000Z",
        commit: candidateHead,
      },
    ];
    const revised = {
      ...observed,
      conversations: {
        ...observed.conversations,
        reviews: {
          totalCount: reviews.length,
          nodes: reviews,
          pages: [
            {
              requestCursor: null,
              endCursor: null,
              hasNextPage: false,
              nodeCount: reviews.length,
            },
          ],
        },
      },
    };

    expect(assessGitHubObservation(manifest, 7, candidateHead, revised).status).toBe("ready");
  });

  it("builds a deterministic gate from complete exact-head evidence", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const observed = observation(candidateHead);
    const review = parseIssueReviewReport(
      {
        version: 1,
        candidateHead,
        issueDigest: manifest.issue.contentDigest,
        reviewWorkflowDigest: sha("f"),
        acceptanceMapping: [
          { criterionId: "criterion-one", status: "satisfied", evidence: "Verified." },
        ],
        findings: [],
        verdict: "clear",
      },
      manifest.acceptanceCriteria.map((criterion) => criterion.id),
      {
        candidateHead,
        issueDigest: manifest.issue.contentDigest,
        reviewWorkflowDigest: sha("f"),
      },
    );

    const gate = buildIssueMergeGate({
      manifest,
      frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
      sequence: 18,
      candidateHead,
      implementation: {
        flowRunId: "implementation-run",
        executionWorkflowDigest: sha("e"),
        terminalSequence: 4,
        evidenceDigest: sha("1"),
      },
      verification: verification(candidateHead),
      review: {
        flowRunId: "review-run",
        executionWorkflowDigest: sha("f"),
        terminalSequence: 3,
        evidenceDigest: sha("2"),
        reportDigest: sha("3"),
        report: review,
      },
      observation: observed,
    });

    expect(gate.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(gate.input.pullRequest).toMatchObject({ number: 7, headCommit: candidateHead });
    expect(gate.input.hostedChecks).toHaveLength(1);
    expect(gate.input.conversation.unresolvedThreadCount).toBe(0);
  });
});

function frozenManifest() {
  const budgets = {
    implementation: workflowBudget(),
    review: workflowBudget(),
    holdout: { timeoutMs: 1_000 },
    verification: [{ id: "quality", timeoutMs: 2_000 }],
    controller: [{ id: "github", timeoutMs: 3_000 }],
  };
  const blob = {
    version: 1 as const,
    mediaType: "application/json",
    byteLength: 1,
    digest: sha("a"),
  };
  return parseIssuePrivateManifest({
    version: 1,
    runId: "issue-run-1",
    initialCommandId: "11111111-1111-4111-8111-111111111111",
    createdAt: at,
    repository: {
      host: "github.com",
      identity: "owner/repo",
      nodeId: "R_repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
    issue: {
      number: 4,
      nodeId: "I_issue",
      state: "open",
      updatedAt: at,
      canonicalUrl: "https://github.com/owner/repo/issues/4",
      contentDigest: sha("b"),
    },
    base: { branch: "main", commit: commit("a"), remoteRef: "refs/heads/main" },
    branch: { prefix: "codex/", name: "codex/issue-4" },
    planDigest: sha("c"),
    implementationWorkflow: {
      sourceDigest: sha("d"),
      templateWorkflowDigest: sha("e"),
      model: { provider: "openai", id: "gpt-5" },
    },
    reviewWorkflow: {
      sourceDigest: sha("f"),
      templateWorkflowDigest: sha("1"),
      model: { provider: "openai", id: "gpt-5" },
      resultNodeId: "review-result",
    },
    acceptanceCriteria: [{ id: "criterion-one", description: "The criterion is met." }],
    allowedWritePrefixes: ["src"],
    holdout: { commandDigest: sha("2"), timeoutMs: 1_000 },
    verification: [{ id: "quality", commandDigest: sha("3"), timeoutMs: 2_000 }],
    hostedChecks: [{ name: "test", sourceApp: { id: 1, slug: "github-actions" } }],
    merge: { method: "squash", deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: {
      issue: blob,
      plan: blob,
      implementationWorkflow: blob,
      reviewWorkflow: blob,
    },
  });
}

function workflowBudget() {
  return {
    maxNodeStarts: 10,
    maxModelTokens: 10_000,
    maxCostUsdMicros: 1_000_000,
    maxExecutionMs: 60_000,
    maxArtifactBytes: 1_000_000,
  };
}

function verification(candidateHead: string) {
  return {
    negativeControl: {
      baseCommit: commit("a"),
      baseOutcome: "failed" as const,
      candidateHead,
      candidateOutcome: "passed" as const,
      evidenceDigest: sha("4"),
    },
    deterministic: [
      {
        id: "quality",
        commandDigest: sha("3"),
        evidenceDigest: sha("5"),
        headCommit: candidateHead,
      },
    ],
    candidateDelta: {
      baseCommit: commit("a"),
      candidateHead,
      pathCount: 2,
      logicalBytes: 512,
      relevant: true,
      evidenceDigest: sha("6"),
    },
    evidenceDigest: sha("7"),
  };
}

function observation(
  candidateHead: string,
  check: { status: "completed" | "in_progress"; conclusion: "success" | null } = {
    status: "completed",
    conclusion: "success",
  },
) {
  return parseGitHubLifecycleObservation({
    version: 1,
    repositoryIdentity: "owner/repo",
    repositoryNodeId: "R_repo",
    observedAt: at,
    issue: {
      number: 4,
      nodeId: "I_issue",
      state: "open",
      updatedAt: at,
      contentDigest: sha("b"),
    },
    base: { branch: "main", commit: commit("a") },
    pullRequest: {
      number: 7,
      nodeId: "PR_seven",
      state: "open",
      isDraft: false,
      headBranch: "codex/issue-4",
      headCommit: candidateHead,
      baseBranch: "main",
      baseCommit: commit("a"),
      mergeability: "mergeable",
    },
    checks: {
      totalCount: 1,
      nodes: [
        {
          runId: 77,
          name: "test",
          sourceApp: { id: 1, slug: "github-actions" },
          status: check.status,
          conclusion: check.conclusion,
          headCommit: candidateHead,
          startedAt: at,
          completedAt: check.status === "completed" ? at : null,
        },
      ],
      pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 1 }],
    },
    conversations: {
      comments: emptyCollection(),
      reviews: emptyCollection(),
      threads: emptyCollection(),
    },
  });
}

function emptyCollection() {
  return {
    totalCount: 0,
    nodes: [],
    pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 0 }],
  };
}
