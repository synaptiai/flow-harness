import { describe, expect, it } from "vitest";

import {
  type GitHubIssuePlanError,
  MAX_GITHUB_ISSUE_PLAN_BYTES,
  parseGitHubIssuePlanText,
} from "../../../src/domain/issue-lifecycle/plan.js";

describe("GitHub issue plan", () => {
  it("parses and freezes the complete versioned operator contract", () => {
    const plan = parseGitHubIssuePlanText(validPlan(), "issue-plan.yaml");

    expect(plan).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "GitHubIssuePlan",
      repository: { expected: "synaptiai/flow-harness", baseBranch: "main" },
      branch: { prefix: "flow/issue-" },
      candidate: { allowedPathPrefixes: ["src/", "test/", "README.md"] },
      implementation: { workflow: "workflows/implement.workflow.yaml" },
      hostedChecks: {
        required: [
          { name: "test", sourceApp: { id: 15_368, slug: "github-actions" } },
          { name: "lint", sourceApp: { id: 15_368, slug: "github-actions" } },
        ],
      },
      review: {
        workflow: "workflows/review.workflow.yaml",
        resultNode: "review-result",
        blockingSeverities: ["P1", "P2", "P3"],
      },
      merge: { method: "squash", deleteBranch: true },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.verification)).toBe(true);
  });

  it("accepts strict JSON and rejects duplicate YAML keys and unknown fields", () => {
    expect(parseGitHubIssuePlanText(JSON.stringify(validPlanValue())).kind).toBe("GitHubIssuePlan");
    expect(() =>
      parseGitHubIssuePlanText(
        validPlan().replace("  baseBranch: main", "  baseBranch: main\n  baseBranch: trunk"),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "invalid_yaml" }),
    );
    expect(() =>
      parseGitHubIssuePlanText(
        validPlan().replace("kind: GitHubIssuePlan", "kind: GitHubIssuePlan\nunknown: true"),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "invalid_schema" }),
    );
  });

  it("accepts a canonical leading-dot GitHub repository", () => {
    expect(
      parseGitHubIssuePlanText(
        validPlan().replace("expected: synaptiai/flow-harness", "expected: SynaptiAI/.GitHub"),
      ).repository.expected,
    ).toBe("synaptiai/.github");
  });

  it("admits trusted .flow/workflows contracts but not other private Flow state", () => {
    const source = validPlan()
      .replace("workflows/implement.workflow.yaml", ".flow/workflows/implement.workflow.yaml")
      .replace("workflows/review.workflow.yaml", ".flow/workflows/review.workflow.yaml");
    expect(parseGitHubIssuePlanText(source).implementation.workflow).toBe(
      ".flow/workflows/implement.workflow.yaml",
    );
    expect(() =>
      parseGitHubIssuePlanText(
        source.replace(".flow/workflows/implement.workflow.yaml", ".flow/runs/private.yaml"),
      ),
    ).toThrow(/implementation.*workflow/i);
  });

  it("admits one private holdout stdin source only from .flow/verification", () => {
    const source = validPlan().replace(
      "holdout:\n  command:",
      "holdout:\n  stdin: { path: .flow/verification/holdout.py }\n  command:",
    );

    expect(parseGitHubIssuePlanText(source).holdout.stdin).toEqual({
      path: ".flow/verification/holdout.py",
    });
    expect(() =>
      parseGitHubIssuePlanText(
        source.replace(".flow/verification/holdout.py", ".flow/runs/private.py"),
      ),
    ).toThrow(/holdout.*stdin.*path/i);
    expect(() =>
      parseGitHubIssuePlanText(
        source.replace(".flow/verification/holdout.py", ".flow/verification/../private.py"),
      ),
    ).toThrow(/holdout.*stdin.*path/i);
  });

  it.each([
    [
      "repository mismatch syntax",
      "expected: synaptiai/flow-harness",
      "expected: https://github.com/synaptiai/flow-harness",
    ],
    ["unsafe base ref", "baseBranch: main", "baseBranch: ../main"],
    ["unsafe branch prefix", "prefix: flow/issue-", "prefix: flow//issue-"],
    [
      "absolute workflow",
      "workflow: workflows/implement.workflow.yaml",
      "workflow: /tmp/implement.yaml",
    ],
    [
      "traversing workflow",
      "workflow: workflows/implement.workflow.yaml",
      "workflow: workflows/../implement.yaml",
    ],
    ["forbidden candidate metadata", "    - src/", "    - .git/config"],
    ["empty candidate segment", "    - src/", "    - src//domain"],
    ["shell holdout", "executable: npm", "executable: npm && curl example.com"],
    [
      "empty hosted checks",
      "    - name: test\n      sourceApp: { id: 15368, slug: github-actions }\n    - name: lint\n      sourceApp: { id: 15368, slug: github-actions }",
      "    []",
    ],
    ["changed blocking policy", "blockingSeverities: [P1, P2, P3]", "blockingSeverities: [P1, P2]"],
  ])("rejects %s", (_name, before, after) => {
    expect(() => parseGitHubIssuePlanText(validPlan().replace(before, after))).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "invalid_schema" }),
    );
  });

  it.each([
    ["the reserved HEAD name", "HEAD"],
    ["a component ending in .lock", "release.lock/main"],
    ["a component that starts with a dot", "release/.hidden"],
    ["a trailing dot", "release."],
    ["the DEL control character", `release\u007f`],
    ["two consecutive dots", "release..candidate"],
    ["a space", "release candidate"],
    ["a tilde", "release~candidate"],
    ["a caret", "release^candidate"],
    ["a colon", "release:candidate"],
    ["a question mark", "release?candidate"],
    ["an asterisk", "release*candidate"],
    ["an opening bracket", "release[candidate"],
    ["reflog syntax", "release@{1}"],
    ["the single at sign", "@"],
    ["a backslash", "release\\candidate"],
  ])("rejects a base branch with %s", (_name, baseBranch) => {
    const value = validPlanValue() as { repository: { baseBranch: string } };
    value.repository.baseBranch = baseBranch;

    expect(() => parseGitHubIssuePlanText(JSON.stringify(value))).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "invalid_schema" }),
    );
  });

  it.each([
    ["a component ending in .lock", "flow.lock/issue-"],
    ["a component that starts with a dot", "flow/.hidden/issue-"],
    ["a trailing dot", "flow/issue."],
    ["the DEL control character", `flow/issue-\u007f`],
    ["two consecutive dots", "flow/issue.."],
    ["a space", "flow/issue candidate"],
    ["a tilde", "flow/issue~"],
    ["a caret", "flow/issue^"],
    ["a colon", "flow/issue:"],
    ["a question mark", "flow/issue?"],
    ["an asterisk", "flow/issue*"],
    ["an opening bracket", "flow/issue["],
    ["reflog syntax", "flow/@{issue-"],
    ["the single at sign", "@"],
    ["a backslash", "flow\\issue-"],
  ])("rejects a branch prefix with %s", (_name, prefix) => {
    const value = validPlanValue() as { branch: { prefix: string } };
    value.branch.prefix = prefix;

    expect(() => parseGitHubIssuePlanText(JSON.stringify(value))).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "invalid_schema" }),
    );
  });

  it("requires unique deterministic checks, candidate paths, and hosted check names", () => {
    expect(() =>
      parseGitHubIssuePlanText(
        validPlan().replace("  - id: typecheck\n    command:", "  - id: test\n    command:"),
      ),
    ).toThrow(/verification.*unique/i);
    expect(() =>
      parseGitHubIssuePlanText(validPlan().replace("    - name: lint", "    - name: test")),
    ).toThrow(/hosted.*unique/i);
    expect(() =>
      parseGitHubIssuePlanText(validPlan().replace("    - test/", "    - src/")),
    ).toThrow(/candidate.*unique/i);
  });

  it("requires an exact canonical source app for every hosted check", () => {
    const invalidId = validPlan().replace("id: 15368", "id: 0");
    const invalidSlug = validPlan().replace("slug: github-actions", "slug: GitHub-Actions");

    expect(() => parseGitHubIssuePlanText(invalidId)).toThrow(/hosted|sourceApp|id/i);
    expect(() => parseGitHubIssuePlanText(invalidSlug)).toThrow(/hosted|sourceApp|slug/i);
  });

  it("requires a negative-control holdout and rejects an unbounded document", () => {
    expect(() =>
      parseGitHubIssuePlanText(validPlan().replace(/holdout:\n(?: {2,}.*\n){4}/, "")),
    ).toThrow(/holdout/i);
    expect(() =>
      parseGitHubIssuePlanText(`${validPlan()}#${"x".repeat(MAX_GITHUB_ISSUE_PLAN_BYTES)}`),
    ).toThrowError(
      expect.objectContaining<Partial<GitHubIssuePlanError>>({ code: "limit_exceeded" }),
    );
  });
});

function validPlan(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: GitHubIssuePlan
repository:
  expected: synaptiai/flow-harness
  baseBranch: main
branch:
  prefix: flow/issue-
candidate:
  allowedPathPrefixes:
    - src/
    - test/
    - README.md
implementation:
  workflow: workflows/implement.workflow.yaml
holdout:
  command:
    executable: npm
    args: [run, test:holdout]
    timeoutMs: 120000
verification:
  - id: test
    command:
      executable: npm
      args: [test, --, --run]
      timeoutMs: 120000
  - id: typecheck
    command:
      executable: npm
      args: [run, typecheck]
      timeoutMs: 120000
hostedChecks:
  required:
    - name: test
      sourceApp: { id: 15368, slug: github-actions }
    - name: lint
      sourceApp: { id: 15368, slug: github-actions }
review:
  workflow: workflows/review.workflow.yaml
  resultNode: review-result
  blockingSeverities: [P1, P2, P3]
merge:
  method: squash
  deleteBranch: true
`;
}

function validPlanValue(): object {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "GitHubIssuePlan",
    repository: { expected: "synaptiai/flow-harness", baseBranch: "main" },
    branch: { prefix: "flow/issue-" },
    candidate: { allowedPathPrefixes: ["src/", "test/", "README.md"] },
    implementation: { workflow: "workflows/implement.workflow.yaml" },
    holdout: {
      command: { executable: "npm", args: ["run", "test:holdout"], timeoutMs: 120_000 },
    },
    verification: [
      {
        id: "test",
        command: { executable: "npm", args: ["test", "--", "--run"], timeoutMs: 120_000 },
      },
    ],
    hostedChecks: {
      required: [{ name: "test", sourceApp: { id: 15_368, slug: "github-actions" } }],
    },
    review: {
      workflow: "workflows/review.workflow.yaml",
      resultNode: "review-result",
      blockingSeverities: ["P1", "P2", "P3"],
    },
    merge: { method: "squash", deleteBranch: true },
  };
}
