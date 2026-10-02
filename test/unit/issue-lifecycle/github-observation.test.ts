import { describe, expect, it } from "vitest";

import {
  calculateGitHubLifecycleObservationDigest,
  calculateIssueMergeProofDigest,
  parseGitHubLifecycleObservation,
  verifyIssueMergeProof,
} from "../../../src/domain/issue-lifecycle/github-observation.js";

describe("GitHub lifecycle observations", () => {
  it("binds a complete exact-head snapshot and freezes a detached value", () => {
    const input = observation();
    const parsed = parseGitHubLifecycleObservation(input);

    first(input.checks.nodes).name = "changed";
    expect(parsed.checks.nodes[0]?.name).toBe("CI / test");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.conversations.threads.nodes)).toBe(true);
    expect(calculateGitHubLifecycleObservationDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires complete, contiguous pagination for every observed collection", () => {
    const input = observation();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        checks: {
          ...input.checks,
          pages: [{ requestCursor: null, endCursor: "cursor-1", hasNextPage: true, nodeCount: 1 }],
        },
      }),
    ).toThrow(/final page|pagination/i);
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        conversations: {
          ...input.conversations,
          comments: {
            ...input.conversations.comments,
            pages: [
              { requestCursor: null, endCursor: "cursor-1", hasNextPage: true, nodeCount: 0 },
              {
                requestCursor: "wrong-cursor",
                endCursor: null,
                hasNextPage: false,
                nodeCount: 0,
              },
            ],
          },
        },
      }),
    ).toThrow(/cursor chain/i);
  });

  it("rejects repeated pagination cursors and observations that predate their contents", () => {
    const input = observation();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        conversations: {
          ...input.conversations,
          comments: {
            totalCount: 0,
            nodes: [],
            pages: [
              { requestCursor: null, endCursor: "cursor-1", hasNextPage: true, nodeCount: 0 },
              {
                requestCursor: "cursor-1",
                endCursor: "cursor-1",
                hasNextPage: true,
                nodeCount: 0,
              },
              {
                requestCursor: "cursor-1",
                endCursor: null,
                hasNextPage: false,
                nodeCount: 0,
              },
            ],
          },
        },
      }),
    ).toThrow(/repeat|unique|loop/i);
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        observedAt: "2026-08-28T11:32:00.000Z",
      }),
    ).toThrow(/observation time/i);
  });

  it("rejects stale check heads, duplicate run IDs, and incomplete collection counts", () => {
    const input = observation();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        checks: {
          ...input.checks,
          nodes: input.checks.nodes.map((check) => ({ ...check, headCommit: "f".repeat(40) })),
        },
      }),
    ).toThrow(/head/i);
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        checks: {
          ...input.checks,
          nodes: [first(input.checks.nodes), first(input.checks.nodes)],
        },
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        conversations: {
          ...input.conversations,
          reviews: { ...input.conversations.reviews, totalCount: 2 },
        },
      }),
    ).toThrow(/total count/i);
  });

  it("represents valid pending checks and reviews without treating them as successful", () => {
    const input = observation();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        checks: collection(
          [
            {
              ...first(input.checks.nodes),
              status: "waiting",
              conclusion: null,
              completedAt: null,
            },
          ],
          1,
        ),
        conversations: {
          ...input.conversations,
          reviews: collection(
            [
              {
                ...first(input.conversations.reviews.nodes),
                state: "pending",
                submittedAt: null,
              },
            ],
            1,
          ),
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        checks: collection(
          [
            {
              ...first(input.checks.nodes),
              conclusion: "startup_failure",
            },
          ],
          1,
        ),
      }),
    ).not.toThrow();
  });

  it("requires the immutable repository node identity", () => {
    const input = observation();
    expect(
      calculateGitHubLifecycleObservationDigest({
        ...input,
        repositoryNodeId: "R_different",
      }),
    ).not.toBe(calculateGitHubLifecycleObservationDigest(input));
  });

  it("classifies a nonexistent calendar timestamp through the stable schema error", () => {
    const input = observation();
    expect(() =>
      parseGitHubLifecycleObservation({
        ...input,
        observedAt: "2026-99-99T12:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ name: "GitHubLifecycleObservationError" }));
  });
});

describe("method-specific merge proofs", () => {
  it.each([mergeProof(), squashProof(), rebaseProof()])(
    "verifies and digests a complete $method proof",
    (input) => {
      const proof = verifyIssueMergeProof(input);
      expect(Object.isFrozen(proof)).toBe(true);
      expect(calculateIssueMergeProofDigest(proof)).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("rejects a merge result that is not reachable from the observed base", () => {
    expect(() =>
      verifyIssueMergeProof({ ...mergeProof(), mergeCommitReachableFromObservedBase: false }),
    ).toThrow(/reachable/i);
  });

  it("requires the approved candidate and frozen base as merge parents", () => {
    const input = mergeProof();
    expect(() =>
      verifyIssueMergeProof({
        ...input,
        proof: { kind: "merge", parents: [input.frozenBaseCommit, "f".repeat(40)] },
      }),
    ).toThrow(/candidate.*parent/i);
  });

  it("requires squash tree equivalence and rebase patch-and-tree equivalence", () => {
    expect(() =>
      verifyIssueMergeProof({
        ...squashProof(),
        proof: { ...squashProof().proof, mergeCommitTree: "f".repeat(40) },
      }),
    ).toThrow(/tree/i);
    expect(() =>
      verifyIssueMergeProof({
        ...rebaseProof(),
        proof: { ...rebaseProof().proof, mergedPatchDigest: "f".repeat(64) },
      }),
    ).toThrow(/patch/i);
  });

  it("requires a requested branch deletion but permits repository auto-deletion", () => {
    expect(() =>
      verifyIssueMergeProof({
        ...squashProof(),
        deleteBranchRequested: true,
        branchDeleted: false,
      }),
    ).toThrow(/branch deletion/i);
    expect(() =>
      verifyIssueMergeProof({
        ...squashProof(),
        deleteBranchRequested: false,
        branchDeleted: true,
      }),
    ).not.toThrow();
  });

  it("rejects a merge identity equal to the frozen base or approved candidate", () => {
    expect(() =>
      verifyIssueMergeProof({ ...mergeProof(), mergeCommit: mergeProof().candidateHead }),
    ).toThrow(/merge commit.*distinct/i);
    expect(() =>
      verifyIssueMergeProof({ ...squashProof(), mergeCommit: squashProof().frozenBaseCommit }),
    ).toThrow(/merge commit.*distinct/i);
  });
});

function observation() {
  const head = "b".repeat(40);
  return {
    version: 1 as const,
    repositoryIdentity: "synaptiai/flow-harness",
    repositoryNodeId: "R_kgDOExample",
    observedAt: "2026-08-28T12:00:00.000Z",
    issue: {
      number: 197,
      nodeId: "I_kwDOExample",
      state: "open" as const,
      updatedAt: "2026-08-28T11:00:00.000Z",
      contentDigest: "1".repeat(64),
    },
    base: { branch: "main", commit: "a".repeat(40) },
    pullRequest: {
      number: 198,
      nodeId: "PR_kwDOExample",
      state: "open" as const,
      isDraft: false,
      headBranch: "flow/issue-197-aabbccdd",
      headCommit: head,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      mergeability: "mergeable" as const,
    },
    checks: collection(
      [
        {
          runId: 1001,
          name: "CI / test",
          sourceApp: { id: 15_368, slug: "github-actions" },
          status: "completed" as const,
          conclusion: "success" as const,
          headCommit: head,
          startedAt: "2026-08-28T11:30:00.000Z",
          completedAt: "2026-08-28T11:35:00.000Z",
        },
      ],
      1,
    ),
    conversations: {
      comments: collection([], 0),
      reviews: collection(
        [
          {
            nodeId: "PRR_example",
            authorDigest: "2".repeat(64),
            bodyDigest: "3".repeat(64),
            state: "approved" as const,
            submittedAt: "2026-08-28T11:40:00.000Z",
            commit: head,
          },
        ],
        1,
      ),
      threads: collection(
        [
          {
            nodeId: "PRRT_example",
            isResolved: true,
            isOutdated: false,
            commentsDigest: "4".repeat(64),
          },
        ],
        1,
      ),
    },
  };
}

function collection<T>(nodes: T[], totalCount: number) {
  return {
    totalCount,
    nodes,
    pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: nodes.length }],
  };
}

function mergeProof() {
  return {
    ...proofCommon(),
    method: "merge" as const,
    proof: {
      kind: "merge" as const,
      parents: ["a".repeat(40), "b".repeat(40)],
    },
  };
}

function squashProof() {
  return {
    ...proofCommon(),
    method: "squash" as const,
    proof: {
      kind: "squash" as const,
      parent: "a".repeat(40),
      candidateTree: "c".repeat(40),
      mergeCommitTree: "c".repeat(40),
    },
  };
}

function rebaseProof() {
  return {
    ...proofCommon(),
    method: "rebase" as const,
    proof: {
      kind: "rebase" as const,
      firstParent: "a".repeat(40),
      candidateTree: "c".repeat(40),
      mergedTree: "c".repeat(40),
      candidatePatchDigest: "d".repeat(64),
      mergedPatchDigest: "d".repeat(64),
      rewrittenCommitCount: 2,
    },
  };
}

function proofCommon() {
  return {
    version: 1 as const,
    repositoryIdentity: "synaptiai/flow-harness",
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_kwDOExample",
    gateDigest: "e".repeat(64),
    frozenBaseCommit: "a".repeat(40),
    candidateHead: "b".repeat(40),
    mergeCommit: "d".repeat(40),
    observedBaseCommit: "e".repeat(40),
    mergeCommitReachableFromObservedBase: true as const,
    evidenceDigest: "f".repeat(64),
    deleteBranchRequested: true,
    branchDeleted: true,
  };
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("test fixture requires one value");
  return value;
}
