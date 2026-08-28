import { describe, expect, it } from "vitest";

import {
  validateImplementationWorkflowResult,
  validateReviewWorkflowResult,
} from "../../../src/application/issue-workflow-runner.js";
import {
  calculateIssueBudgetDigest,
  parseIssuePrivateManifest,
} from "../../../src/domain/issue-lifecycle/private-manifest.js";

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);

describe("issue workflow result boundaries", () => {
  it("binds implementation output to the parent run, iteration, workspace, and frozen template", () => {
    const manifest = frozenManifest();
    const output = implementationResult();
    expect(validateImplementationWorkflowResult(manifest, 1, sha("9"), output)).toEqual(output);

    expect(() => validateImplementationWorkflowResult(manifest, 2, sha("9"), output)).toThrow(
      /iteration/,
    );
    expect(() => validateImplementationWorkflowResult(manifest, 1, sha("8"), output)).toThrow(
      /workspace/,
    );
  });

  it("extracts an exact untruncated review report from the frozen result node", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const raw = reviewResult(candidateHead);
    const result = validateReviewWorkflowResult(manifest, candidateHead, raw);

    expect(result.report.verdict).toBe("clear");
    expect(result.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      validateReviewWorkflowResult(manifest, candidateHead, {
        ...raw,
        resultTextTruncated: true,
      }),
    ).toThrow(/untruncated/);
    expect(() =>
      validateReviewWorkflowResult(manifest, candidateHead, {
        ...raw,
        resultNodeId: "other-node",
      }),
    ).toThrow(/result node/);
  });

  it("rejects a syntactically clear report that binds another candidate", () => {
    const manifest = frozenManifest();
    const candidateHead = commit("c");
    const raw = reviewResult(commit("d"));
    expect(() => validateReviewWorkflowResult(manifest, candidateHead, raw)).toThrow(
      /candidate head/,
    );
  });
});

function implementationResult() {
  return {
    parentIssueRunId: "issue-run-1",
    iteration: 1,
    flowRunId: "nested-implementation-1",
    templateWorkflowDigest: sha("e"),
    executionWorkflowDigest: sha("4"),
    terminalSequence: 8,
    evidenceDigest: sha("5"),
    workspaceIdentityDigest: sha("9"),
    candidateTreeDigest: sha("6"),
    commitMessageDigest: sha("7"),
  };
}

function reviewResult(reportHead: string) {
  return {
    parentIssueRunId: "issue-run-1",
    candidateHead: commit("c"),
    flowRunId: "nested-review-1",
    templateWorkflowDigest: sha("1"),
    executionWorkflowDigest: sha("8"),
    terminalSequence: 4,
    evidenceDigest: sha("9"),
    resultNodeId: "review-result",
    resultTextTruncated: false,
    resultText: JSON.stringify({
      version: 1,
      candidateHead: reportHead,
      issueDigest: sha("b"),
      reviewWorkflowDigest: sha("8"),
      acceptanceMapping: [
        { criterionId: "criterion-one", status: "satisfied", evidence: "Verified." },
      ],
      findings: [],
      verdict: "clear",
    }),
  };
}

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
    createdAt: "2026-08-28T12:00:00.000Z",
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
      updatedAt: "2026-08-28T12:00:00.000Z",
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
    acceptanceCriteria: ["criterion-one"],
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
