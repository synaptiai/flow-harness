import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { GitHubIssueHostAdmissionErrorCode } from "../../../src/application/github-issue-ports.js";
import {
  deriveIssueExternalEffectId,
  type IssueLifecyclePhaseReceipt,
  parseIssueLifecycleEvent,
} from "../../../src/domain/issue-lifecycle/events.js";
import { parseGitHubIssuePlanText } from "../../../src/domain/issue-lifecycle/plan.js";
import { parseIssueReviewReport } from "../../../src/domain/issue-lifecycle/review.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const admissionErrorCodes = {
  executable_unavailable: true,
  repository_identity_invalid: true,
  repository_unavailable: true,
  repository_dirty: true,
  repository_detached: true,
  flow_runtime_not_ignored: true,
  repository_origin_unsupported: true,
  repository_identity_mismatch: true,
  command_failed: true,
  command_timed_out: true,
  command_output_limit_exceeded: true,
  command_response_invalid: true,
  github_authentication_failed: true,
  github_repository_not_found: true,
  github_repository_identity_mismatch: true,
  github_issue_not_found: true,
  github_issue_not_open: true,
  github_issue_identity_mismatch: true,
  operation_aborted: true,
} satisfies Record<GitHubIssueHostAdmissionErrorCode, true>;
const receiptFixtures = [
  {
    kind: "issue_snapshot",
    repositoryIdentity: "example/widgets",
    issueNumber: 42,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    branch: "flow/issue-42",
    issueDigest: "b".repeat(64),
    evidenceDigest: "c".repeat(64),
  },
  {
    kind: "workspace",
    workspaceIdentityDigest: "a".repeat(64),
    evidenceDigest: "b".repeat(64),
  },
  { kind: "implementation_started", iteration: 1, evidenceDigest: "a".repeat(64) },
  {
    kind: "implementation",
    candidateHead: "a".repeat(40),
    flowRunId: "implementation-run",
    evidenceDigest: "b".repeat(64),
  },
  {
    kind: "verification",
    candidateHead: "a".repeat(40),
    evidenceDigest: "b".repeat(64),
  },
  {
    kind: "review",
    candidateHead: "a".repeat(40),
    reportDigest: "b".repeat(64),
    evidenceDigest: "c".repeat(64),
  },
  {
    kind: "publication",
    candidateHead: "a".repeat(40),
    branch: "flow/issue-42",
    baseBranch: "main",
    pullRequestNumber: 42,
    pullRequestNodeId: "PR_node",
    evidenceDigest: "b".repeat(64),
  },
  {
    kind: "merge_gate",
    repositoryIdentity: "example/widgets",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    branch: "flow/issue-42",
    pullRequestNumber: 42,
    pullRequestNodeId: "PR_node",
    candidateHead: "a".repeat(40),
    checksDigest: "b".repeat(64),
    gateDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
  },
  {
    kind: "gate_invalidated",
    candidateHead: "a".repeat(40),
    gateDigest: "b".repeat(64),
    evidenceDigest: "c".repeat(64),
  },
  {
    kind: "merge_approval",
    candidateHead: "a".repeat(40),
    gateDigest: "b".repeat(64),
    actorDigest: "c".repeat(64),
    evidenceDigest: "d".repeat(64),
  },
  {
    kind: "merge",
    candidateHead: "a".repeat(40),
    gateDigest: "b".repeat(64),
    mergeCommit: "c".repeat(40),
    evidenceDigest: "d".repeat(64),
  },
] as const satisfies readonly IssueLifecyclePhaseReceipt[];
const appliedEffectResultFixtures = [
  { kind: "workspace", workspaceIdentityDigest: "a".repeat(64) },
  { kind: "commit", candidateHead: "a".repeat(40) },
  { kind: "push", candidateHead: "a".repeat(40), branch: "flow/issue-42" },
  {
    kind: "pull_request",
    repositoryIdentity: "example/widgets",
    candidateHead: "a".repeat(40),
    headBranch: "flow/issue-42",
    baseBranch: "main",
    pullRequestNumber: 42,
    pullRequestNodeId: "PR_node",
    isDraft: true,
  },
  {
    kind: "pull_request_ready",
    repositoryIdentity: "example/widgets",
    candidateHead: "a".repeat(40),
    headBranch: "flow/issue-42",
    baseBranch: "main",
    pullRequestNumber: 42,
    pullRequestNodeId: "PR_node",
    isDraft: false,
  },
  {
    kind: "merge",
    candidateHead: "a".repeat(40),
    gateDigest: "b".repeat(64),
    mergeCommit: "c".repeat(40),
  },
] as const;

describe("GitHub issue lifecycle documentation contracts", () => {
  it("parses the public plan and review examples with production admission", async () => {
    const [guide, specification] = await Promise.all([
      readDocument("docs/guides/github-issue-lifecycle.md"),
      readDocument("docs/specs/github-issue-lifecycle.md"),
    ]);

    const plans = [
      parseGitHubIssuePlanText(extractFence(guide, "## Write the lifecycle plan", "yaml")),
      parseGitHubIssuePlanText(extractFence(specification, "The complete shape is:", "yaml")),
    ];
    for (const plan of plans) {
      expect(plan).toMatchObject({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "GitHubIssuePlan",
        hostedChecks: {
          required: [{ name: "CI / test", sourceApp: { id: 15_368, slug: "github-actions" } }],
        },
      });
    }
    expect(
      parseIssueReviewReport(
        JSON.parse(
          extractFence(specification, "The structured result has this strict JSON shape:", "json"),
        ),
        ["criterion-id"],
        {
          candidateHead: "a".repeat(40),
          issueDigest: "b".repeat(64),
          reviewWorkflowDigest: "c".repeat(64),
        },
      ),
    ).toMatchObject({ verdict: "blocked" });
  });

  it("documents every exact public admission error code without aliases", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const section = extractSection(specification, "### Public admission error codes");
    const documentedCodes = [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]);

    expect(documentedCodes.sort()).toEqual(Object.keys(admissionErrorCodes).sort());
  });

  it("documents a canonical dot-prefixed repository name", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const plan = extractFence(specification, "The complete shape is:", "yaml").replace(
      "owner/repository",
      "owner/.github",
    );

    expect(parseGitHubIssuePlanText(plan).repository.expected).toBe("owner/.github");
    expect(specification).toContain("`owner/.github` is valid");
  });

  it("documents every exact required phase-receipt field", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const documentedFields = documentedReceiptFields(specification);

    for (const [index, receipt] of receiptFixtures.entries()) {
      const event = parseIssueLifecycleEvent({
        version: 1,
        runId: "documentation-contract",
        sequence: index + 1,
        at: new Date(Date.UTC(2026, 7, 28, 12, 0, index)).toISOString(),
        type: "phase_transitioned",
        from: "preflight",
        to: "issue_frozen",
        receipt,
      });
      if (event.type !== "phase_transitioned") throw new Error("expected phase event fixture");

      expect(documentedFields.get(receipt.kind), receipt.kind).toEqual(
        Object.keys(event.receipt)
          .filter((field) => field !== "kind")
          .sort(),
      );
    }
  });

  it("documents every exact applied external-effect result field", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const documentedFields = documentedEffectResultFields(specification);

    for (const [index, result] of appliedEffectResultFixtures.entries()) {
      const operationDigest = String(index + 1).repeat(64);
      const event = parseIssueLifecycleEvent({
        version: 1,
        runId: "documentation-contract",
        sequence: index + 1,
        at: new Date(Date.UTC(2026, 7, 28, 13, 0, index)).toISOString(),
        type: "external_effect_settled",
        effectId: deriveIssueExternalEffectId(result.kind, operationDigest),
        outcome: "applied",
        observationDigest: "f".repeat(64),
        result,
      });
      if (event.type !== "external_effect_settled" || event.outcome !== "applied") {
        throw new Error("expected applied external-effect fixture");
      }

      expect(documentedFields.get(result.kind), result.kind).toEqual(
        Object.keys(event.result).sort(),
      );
    }
  });

  it("documents and enforces that a not-applied effect has no result", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const operationDigest = "a".repeat(64);
    const input = {
      version: 1,
      runId: "documentation-contract",
      sequence: 1,
      at: "2026-08-28T13:00:00.000Z",
      type: "external_effect_settled",
      effectId: deriveIssueExternalEffectId("workspace", operationDigest),
      outcome: "not_applied",
      observationDigest: "b".repeat(64),
    } as const;

    expect(parseIssueLifecycleEvent(input)).not.toHaveProperty("result");
    expect(() =>
      parseIssueLifecycleEvent({
        ...input,
        result: { kind: "workspace", workspaceIdentityDigest: "c".repeat(64) },
      }),
    ).toThrow(/unrecognized key|result/i);
    expect(specification).toContain("A `not_applied` settlement has no `result`.");
  });

  it("documents the deterministic external-effect identifier", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const operationDigest = "a".repeat(64);

    expect(deriveIssueExternalEffectId("pull_request_ready", operationDigest)).toBe(
      `effect-pull-request-ready-${operationDigest}`,
    );
    expect(specification).toContain("`effect-<kind-with-hyphens>-<operationDigest>`");
  });

  it("maps gate invalidation only to reverification", async () => {
    const specification = await readDocument("docs/specs/github-issue-lifecycle.md");
    const stateMachine = extractSection(specification, "## Lifecycle state machine");
    const targets = [
      ...stateMachine.matchAll(
        /^\s*merge_approval_required --> ([a-z_]+): gate invalidated\s*$/gmu,
      ),
    ].map((match) => match[1]);

    expect(targets).toEqual(["verifying"]);
  });

  it("labels every lifecycle document unavailable until the CLI registers the preview", async () => {
    const documents = await Promise.all([
      readDocument("docs/guides/github-issue-lifecycle.md"),
      readDocument("docs/specs/github-issue-lifecycle.md"),
      readDocument("docs/operations/github-issue-lifecycle.md"),
    ]);

    for (const document of documents) {
      expect(document).toContain("## Availability");
      expect(document).toContain("does not register `flow issue`");
    }
  });
});

async function readDocument(path: string): Promise<string> {
  return await readFile(resolve(repositoryRoot, path), "utf8");
}

function extractFence(source: string, marker: string, language: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Documentation marker not found: ${marker}`);
  const opening = `\`\`\`${language}\n`;
  const openingIndex = source.indexOf(opening, markerIndex);
  if (openingIndex < 0) throw new Error(`Documentation fence not found after: ${marker}`);
  const contentStart = openingIndex + opening.length;
  const contentEnd = source.indexOf("\n```", contentStart);
  if (contentEnd < 0) throw new Error(`Documentation fence is not closed after: ${marker}`);
  return source.slice(contentStart, contentEnd);
}

function extractSection(source: string, heading: string): string {
  const headingIndex = source.indexOf(`${heading}\n`);
  if (headingIndex < 0) throw new Error(`Documentation heading not found: ${heading}`);
  const contentStart = headingIndex + heading.length + 1;
  const nextHeading = source.indexOf("\n## ", contentStart);
  return source.slice(contentStart, nextHeading < 0 ? source.length : nextHeading);
}

function documentedReceiptFields(source: string): ReadonlyMap<string, readonly string[]> {
  const section = extractSection(source, "## Event and effect contract");
  const rows = [...section.matchAll(/^\| [^|]+ \| `([^`]+)` \| ([^|]+) \|$/gmu)];
  return new Map(
    rows.map((row) => [
      row[1] ?? "",
      [...(row[2] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "").sort(),
    ]),
  );
}

function documentedEffectResultFields(source: string): ReadonlyMap<string, readonly string[]> {
  const section = extractSection(source, "## Event and effect contract");
  const tableStart = section.indexOf("An applied settlement must bind");
  const tableEnd = section.indexOf("A `not_applied` settlement", tableStart);
  if (tableStart < 0 || tableEnd < 0) throw new Error("Applied effect-result table not found");
  const table = section.slice(tableStart, tableEnd);
  const rows = [...table.matchAll(/^\| `([^`]+)` \| ([^|]+) \|$/gmu)];
  return new Map(
    rows.map((row) => [
      row[1] ?? "",
      [...(row[2] ?? "").matchAll(/`([^`]+)`/gu)]
        .map((match) => match[1] ?? "")
        .filter((value) => value !== "true" && value !== "false")
        .sort(),
    ]),
  );
}
