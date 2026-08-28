import { describe, expect, it } from "vitest";

import {
  calculateMergeGateDigest,
  type MergeGateInput,
} from "../../../src/domain/issue-lifecycle/merge-gate.js";

describe("merge gate digest", () => {
  it("matches the version-1 compatibility vector", () => {
    expect(calculateMergeGateDigest(mergeGate())).toBe(
      "60757b65cab6ea737860f3a2680028b7285348573df015ac812cd8247d34e83a",
    );
  });

  it("is canonical across object and set-like evidence ordering", () => {
    const gate = mergeGate();
    const reordered: MergeGateInput = {
      ...structuredClone(gate),
      requirements: {
        deterministicVerification: [...gate.requirements.deterministicVerification].reverse(),
        hostedChecks: [...gate.requirements.hostedChecks].reverse(),
      },
      deterministicVerification: [...gate.deterministicVerification].reverse(),
      hostedChecks: [...gate.hostedChecks].reverse(),
    };

    expect(calculateMergeGateDigest(gate)).toMatch(/^[a-f0-9]{64}$/);
    expect(calculateMergeGateDigest(reordered)).toBe(calculateMergeGateDigest(gate));
  });

  it.each([
    [
      "issue",
      (gate: MergeGateInput) => ({ ...gate, issue: { ...gate.issue, digest: "f".repeat(64) } }),
    ],
    [
      "base",
      (gate: MergeGateInput) => ({
        ...gate,
        base: {
          ...gate.base,
          commit: "f".repeat(40),
          observedCommit: "f".repeat(40),
        },
        pullRequest: { ...gate.pullRequest, baseCommit: "f".repeat(40) },
        negativeControl: { ...gate.negativeControl, baseCommit: "f".repeat(40) },
      }),
    ],
    [
      "pull request branches",
      (gate: MergeGateInput) => ({
        ...gate,
        base: { ...gate.base, branch: "release" },
        branch: "flow/issue-197-v2",
        pullRequest: {
          ...gate.pullRequest,
          baseBranch: "release",
          headBranch: "flow/issue-197-v2",
        },
      }),
    ],
    ["plan", (gate: MergeGateInput) => ({ ...gate, planDigest: "f".repeat(64) })],
    [
      "head",
      (gate: MergeGateInput) => ({
        ...gate,
        pullRequest: { ...gate.pullRequest, headCommit: "f".repeat(40) },
        implementation: { ...gate.implementation, candidateHead: "f".repeat(40) },
        negativeControl: { ...gate.negativeControl, candidateHead: "f".repeat(40) },
        deterministicVerification: gate.deterministicVerification.map((item) => ({
          ...item,
          headCommit: "f".repeat(40),
        })),
        review: { ...gate.review, headCommit: "f".repeat(40) },
        hostedChecks: gate.hostedChecks.map((item) => ({ ...item, headCommit: "f".repeat(40) })),
      }),
    ],
    [
      "review",
      (gate: MergeGateInput) => ({
        ...gate,
        review: { ...gate.review, reportDigest: "f".repeat(64) },
      }),
    ],
    [
      "checks",
      (gate: MergeGateInput) => ({
        ...gate,
        hostedChecks: gate.hostedChecks.map((check, index) =>
          index === 0 ? { ...check, runId: 999 } : check,
        ),
      }),
    ],
    [
      "hosted check source app",
      (gate: MergeGateInput) => ({
        ...gate,
        requirements: {
          ...gate.requirements,
          hostedChecks: gate.requirements.hostedChecks.map((check, index) =>
            index === 0
              ? {
                  ...check,
                  sourceApp: { id: 99_999, slug: "different-check-provider" },
                }
              : check,
          ),
        },
        hostedChecks: gate.hostedChecks.map((check, index) =>
          index === 0
            ? {
                ...check,
                sourceApp: { id: 99_999, slug: "different-check-provider" },
              }
            : check,
        ),
      }),
    ],
    [
      "conversation",
      (gate: MergeGateInput) => ({
        ...gate,
        conversation: { ...gate.conversation, commentsDigest: "f".repeat(64) },
      }),
    ],
    [
      "merge policy",
      (gate: MergeGateInput) => ({ ...gate, merge: { ...gate.merge, deleteBranch: false } }),
    ],
    ["sequence", (gate: MergeGateInput) => ({ ...gate, gateCreationSequence: 99 })],
  ])("changes when bound %s evidence changes", (_name, mutate) => {
    expect(calculateMergeGateDigest(mutate(mergeGate()))).not.toBe(
      calculateMergeGateDigest(mergeGate()),
    );
  });

  it("rejects incomplete, unsuccessful, stale, duplicate, or unknown evidence", () => {
    const gate = mergeGate();
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        hostedChecks: [{ ...firstHostedCheck(gate), conclusion: "failure" as "success" }],
      }),
    ).toThrow(/success/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        pullRequest: { ...gate.pullRequest, isDraft: true as false },
      }),
    ).toThrow(/false/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        review: { ...gate.review, headCommit: "f".repeat(40) },
      }),
    ).toThrow(/candidate head/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        conversation: { ...gate.conversation, unresolvedThreadCount: 1 as 0 },
      }),
    ).toThrow(/unresolved/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        hostedChecks: [firstHostedCheck(gate), firstHostedCheck(gate)],
      }),
    ).toThrow(/unique/i);
    expect(() => calculateMergeGateDigest({ ...gate, unknown: true } as MergeGateInput)).toThrow(
      /unrecognized key/i,
    );
  });

  it("requires the observed and pull request base to equal the frozen base", () => {
    const gate = mergeGate();
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        base: { ...gate.base, observedCommit: "c".repeat(40) },
        pullRequest: { ...gate.pullRequest, baseCommit: "c".repeat(40) },
      }),
    ).toThrow(/frozen base/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        pullRequest: { ...gate.pullRequest, baseCommit: "c".repeat(40) },
      }),
    ).toThrow(/frozen base/i);
  });

  it("requires the observed pull request branches to equal the frozen branches", () => {
    const gate = mergeGate();
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        pullRequest: { ...gate.pullRequest, headBranch: "flow/other" },
      }),
    ).toThrow(/head branch|Flow branch/i);
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        pullRequest: { ...gate.pullRequest, baseBranch: "release" },
      }),
    ).toThrow(/base branch/i);
  });

  it("rejects a derived Flow branch equal to the frozen base branch", () => {
    const gate = mergeGate();

    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        branch: gate.base.branch,
        pullRequest: { ...gate.pullRequest, headBranch: gate.base.branch },
      }),
    ).toThrow(/distinct|base branch/i);
  });

  it("canonicalizes repository identity before calculating the gate digest", () => {
    const canonical = mergeGate();
    const mixedCase = { ...mergeGate(), repositoryIdentity: "SynaptiAI/Flow-Harness" };

    expect(calculateMergeGateDigest(mixedCase)).toBe(calculateMergeGateDigest(canonical));
  });

  it.each([
    [
      "issue",
      (gate: MergeGateInput) => ({
        ...gate,
        issue: { ...gate.issue, number: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
    [
      "pull request",
      (gate: MergeGateInput) => ({
        ...gate,
        pullRequest: { ...gate.pullRequest, number: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
    [
      "check run",
      (gate: MergeGateInput) => ({
        ...gate,
        hostedChecks: gate.hostedChecks.map((check, index) =>
          index === 0 ? { ...check, runId: Number.MAX_SAFE_INTEGER + 1 } : check,
        ),
      }),
    ],
    [
      "source app",
      (gate: MergeGateInput) => ({
        ...gate,
        requirements: {
          ...gate.requirements,
          hostedChecks: gate.requirements.hostedChecks.map((check) => ({
            ...check,
            sourceApp: { ...check.sourceApp, id: Number.MAX_SAFE_INTEGER + 1 },
          })),
        },
        hostedChecks: gate.hostedChecks.map((check) => ({
          ...check,
          sourceApp: { ...check.sourceApp, id: Number.MAX_SAFE_INTEGER + 1 },
        })),
      }),
    ],
  ] as const)("rejects an unsafe %s identifier", (_name, mutate) => {
    expect(() => calculateMergeGateDigest(mutate(mergeGate()))).toThrow();
  });

  it.each(["node id with spaces", "node\u0007id", "node\u202eid", "x".repeat(257)])(
    "rejects unsafe GitHub node identity %s",
    (nodeId) => {
      const gate = mergeGate();

      expect(() => calculateMergeGateDigest({ ...gate, issue: { ...gate.issue, nodeId } })).toThrow(
        /nodeId|identity/i,
      );
      expect(() =>
        calculateMergeGateDigest({
          ...gate,
          pullRequest: { ...gate.pullRequest, nodeId },
        }),
      ).toThrow(/nodeId|identity/i);
    },
  );

  it("requires a canonical bounded source app identity for every hosted check", () => {
    const gate = mergeGate();
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        hostedChecks: [
          {
            ...firstHostedCheck(gate),
            sourceApp: { id: 0, slug: "github-actions" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      calculateMergeGateDigest({
        ...gate,
        hostedChecks: [
          {
            ...firstHostedCheck(gate),
            sourceApp: { id: 15_368, slug: "GitHub Actions" },
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    [
      "missing deterministic verification",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        deterministicVerification: gate.deterministicVerification.slice(0, 1),
      }),
    ],
    [
      "substituted deterministic verification",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        deterministicVerification: gate.deterministicVerification.map((item, index) =>
          index === 0 ? { ...item, id: "substitute" } : item,
        ),
      }),
    ],
    [
      "extra deterministic verification",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        deterministicVerification: [
          ...gate.deterministicVerification,
          {
            id: "extra",
            commandDigest: "f".repeat(64),
            evidenceDigest: "1".repeat(64),
            headCommit: gate.pullRequest.headCommit,
          },
        ],
      }),
    ],
    [
      "changed deterministic command",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        deterministicVerification: gate.deterministicVerification.map((item, index) =>
          index === 0 ? { ...item, commandDigest: "f".repeat(64) } : item,
        ),
      }),
    ],
    [
      "missing hosted check",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        hostedChecks: gate.hostedChecks.slice(0, 1),
      }),
    ],
    [
      "substituted hosted check",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        hostedChecks: gate.hostedChecks.map((item, index) =>
          index === 0 ? { ...item, name: "substitute" } : item,
        ),
      }),
    ],
    [
      "extra hosted check",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        hostedChecks: [
          ...gate.hostedChecks,
          {
            ...firstHostedCheck(gate),
            name: "extra",
            runId: 103,
            evidenceDigest: "f".repeat(64),
          },
        ],
      }),
    ],
    [
      "changed hosted-check source app",
      (gate: MergeGateInput): MergeGateInput => ({
        ...gate,
        hostedChecks: gate.hostedChecks.map((item, index) =>
          index === 0 ? { ...item, sourceApp: { id: 99_999, slug: "other-app" } } : item,
        ),
      }),
    ],
  ] as const)("rejects %s against the trusted requirements", (_name, mutate) => {
    expect(() => calculateMergeGateDigest(mutate(mergeGate()))).toThrow(/requirements/i);
  });

  it.each(["HEAD", "release.lock/main", "../main"])(
    "applies exact Git branch validation to %s",
    (branch) => {
      const gate = mergeGate();
      expect(() => calculateMergeGateDigest({ ...gate, base: { ...gate.base, branch } })).toThrow(
        /branch/i,
      );
      expect(() => calculateMergeGateDigest({ ...gate, branch })).toThrow(/branch/i);
    },
  );
});

function mergeGate(): MergeGateInput {
  const head = "a".repeat(40);
  return {
    version: 1,
    runId: "issue-run-01",
    githubHost: "github.com",
    repositoryIdentity: "synaptiai/flow-harness",
    issue: {
      nodeId: "I_kwDOExample",
      number: 197,
      state: "open",
      digest: "1".repeat(64),
      updatedAt: "2026-08-28T10:00:00.000Z",
    },
    base: { branch: "main", commit: "b".repeat(40), observedCommit: "b".repeat(40) },
    branch: "flow/issue-197",
    planDigest: "2".repeat(64),
    implementationWorkflowDigest: "3".repeat(64),
    reviewWorkflowDigest: "4".repeat(64),
    budgetDigest: "5".repeat(64),
    requirements: {
      deterministicVerification: [
        { id: "test", commandDigest: "8".repeat(64) },
        { id: "typecheck", commandDigest: "a".repeat(64) },
      ],
      hostedChecks: [
        { name: "test", sourceApp: { id: 15_368, slug: "github-actions" } },
        { name: "lint", sourceApp: { id: 15_368, slug: "github-actions" } },
      ],
    },
    pullRequest: {
      number: 201,
      nodeId: "PR_kwDOExample",
      state: "open",
      isDraft: false,
      headBranch: "flow/issue-197",
      headCommit: head,
      baseBranch: "main",
      baseCommit: "b".repeat(40),
    },
    merge: { method: "squash", deleteBranch: true },
    implementation: {
      flowRunId: "run-implementation",
      terminalSequence: 41,
      evidenceDigest: "6".repeat(64),
      candidateHead: head,
    },
    negativeControl: {
      baseCommit: "b".repeat(40),
      baseOutcome: "failed",
      candidateHead: head,
      candidateOutcome: "passed",
      evidenceDigest: "7".repeat(64),
    },
    deterministicVerification: [
      {
        id: "test",
        commandDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        headCommit: head,
      },
      {
        id: "typecheck",
        commandDigest: "a".repeat(64),
        evidenceDigest: "b".repeat(64),
        headCommit: head,
      },
    ],
    review: { reportDigest: "c".repeat(64), headCommit: head, verdict: "clear" },
    hostedChecks: [
      {
        name: "test",
        runId: 101,
        sourceApp: { id: 15_368, slug: "github-actions" },
        conclusion: "success",
        headCommit: head,
        evidenceDigest: "d".repeat(64),
      },
      {
        name: "lint",
        runId: 102,
        sourceApp: { id: 15_368, slug: "github-actions" },
        conclusion: "success",
        headCommit: head,
        evidenceDigest: "e".repeat(64),
      },
    ],
    conversation: {
      commentsDigest: "1".repeat(64),
      reviewsDigest: "2".repeat(64),
      threadsDigest: "3".repeat(64),
      unresolvedThreadCount: 0,
    },
    mergeability: { state: "mergeable", evidenceDigest: "4".repeat(64) },
    gateCreationSequence: 48,
  };
}

function firstHostedCheck(gate: MergeGateInput): MergeGateInput["hostedChecks"][number] {
  const first = gate.hostedChecks[0];
  if (first === undefined) throw new Error("expected hosted check fixture");
  return first;
}
