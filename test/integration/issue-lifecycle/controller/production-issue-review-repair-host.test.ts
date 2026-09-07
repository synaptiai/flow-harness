import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IssueGitWorkspace } from "../../../../src/application/issue-local-git-port.js";
import type { IssueReviewRepairHostRequest } from "../../../../src/application/issue-review-repair-host-port.js";
import { validateReviewWorkflowResult } from "../../../../src/application/issue-workflow-runner.js";
import {
  calculateFrozenGitHubIssueContentDigest,
  encodeFrozenGitHubIssueSnapshot,
  FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
} from "../../../../src/domain/issue-lifecycle/frozen-github-issue-snapshot.js";
import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type FrozenIssueRunManifest,
  parseIssuePrivateManifest,
} from "../../../../src/domain/issue-lifecycle/private-manifest.js";
import { issueReviewRepairRunContractForManifest } from "../../../../src/domain/issue-lifecycle/review-repair-state.js";
import { JsonlIssueLifecycleStore } from "../../../../src/infrastructure/fs/jsonl-issue-lifecycle-store.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../../../../src/infrastructure/git/local-git-issue-effects.js";
import { ProductionIssueReviewRepairHost } from "../../../../src/infrastructure/issue-lifecycle/production-issue-review-repair-host.js";

const execFile = promisify(execFileCallback);
const runId = "issue-repair-host";
const at = "2026-09-06T12:00:00.000Z";
let root: string;
let gitPath: string;
let localGit: LocalGitIssueEffects;
let workspace: IssueGitWorkspace;
let store: JsonlIssueLifecycleStore;
let host: ProductionIssueReviewRepairHost;
let manifest: FrozenIssueRunManifest;
let candidateHead: string;
let candidateTree: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-repair-host-"));
  gitPath = (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  const seed = join(root, "seed");
  const sourceRoot = join(root, "source");
  const remote = join(root, "remote.git");
  const privateRoot = join(root, "private");
  await mkdir(join(seed, "src"), { recursive: true });
  await mkdir(join(seed, "docs"));
  await mkdir(privateRoot);
  await git(seed, "init", "--initial-branch=main");
  await writeFile(join(seed, "src", "usage.txt"), "flow issue run\nflow issue inspect\n");
  await writeFile(join(seed, "docs", "outside.txt"), "not in approved scope\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "--quiet", "-m", "document issue usage");
  await git(root, "clone", "--quiet", "--bare", seed, remote);
  await git(root, "clone", "--quiet", remote, sourceRoot);
  candidateHead = await git(sourceRoot, "rev-parse", "HEAD");
  candidateTree = await git(sourceRoot, "rev-parse", "HEAD^{tree}");
  localGit = new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(gitPath, sourceRoot),
    privateRoot,
    testOnlyLocalRemotePath: remote,
  });
  const workspaceRequest = {
    ownershipId: runId,
    sourceRoot,
    workspaceRoot: join(root, "candidate"),
    verificationRoot: join(root, "verification"),
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit: candidateHead,
    branch: "codex/issue-repair-host",
  };
  workspace = await localGit.prepareWorkspace(workspaceRequest);
  const issue = {
    version: 1 as const,
    repository: { identity: "example/project", nodeId: "R_project" },
    issue: {
      number: 4,
      nodeId: "I_issue4",
      updatedAt: at,
      title: "Document the issue workflow",
      body: "Explain how to inspect an issue run in src/usage.txt.",
    },
  };
  const issueBlob = {
    mediaType: FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE,
    bytes: encodeFrozenGitHubIssueSnapshot(issue),
  };
  const blob = (text: string) => ({ mediaType: "text/plain", bytes: Buffer.from(text) });
  const planBlob = blob("Document issue usage within src only.");
  const implementationBlob = blob("Implement the approved issue usage documentation.");
  const reviewBlob = blob("Independently review the issue usage documentation.");
  const repairBlob = blob("Repair only the original in-scope usage documentation.");
  const envelope = {
    maxNodeStarts: 8,
    maxModelTokens: 1000,
    maxCostUsdMicros: 100000,
    maxExecutionMs: 60000,
    maxArtifactBytes: 1048576,
  };
  const aggregateBudget = { implementation: envelope, review: envelope };
  const budgets = {
    implementation: envelope,
    review: envelope,
    reviewRepair: { aggregateBudget, repair: envelope },
    holdout: { timeoutMs: 1000 },
    verification: [{ id: "test", timeoutMs: 1000 }],
    controller: [{ id: "git-read", timeoutMs: 1000 }],
  };
  const model = { provider: "openrouter", id: "bound-model" };
  manifest = parseIssuePrivateManifest({
    version: 1,
    runId,
    initialCommandId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: at,
    repository: {
      host: "github.com",
      identity: "example/project",
      nodeId: "R_project",
      canonicalUrl: "https://github.com/example/project",
    },
    issue: {
      number: 4,
      nodeId: "I_issue4",
      state: "open",
      updatedAt: at,
      canonicalUrl: "https://github.com/example/project/issues/4",
      contentDigest: calculateFrozenGitHubIssueContentDigest(issue),
    },
    base: { branch: "main", commit: candidateHead, remoteRef: "refs/heads/main" },
    branch: { prefix: "codex/", name: workspace.branch },
    planDigest: sha(planBlob.bytes),
    implementationWorkflow: {
      sourceDigest: sha(implementationBlob.bytes),
      templateWorkflowDigest: sha(implementationBlob.bytes),
      model,
    },
    reviewWorkflow: {
      sourceDigest: sha(reviewBlob.bytes),
      templateWorkflowDigest: sha(reviewBlob.bytes),
      model,
      resultNodeId: "review-result",
    },
    reviewRepair: {
      version: 1,
      mode: "preauthorized",
      maxCycles: 2,
      eligibleClasses: ["review-findings", "unsatisfied-criteria"],
      aggregateBudget,
      stopping: {
        disputed: "stop",
        unchangedTree: "stop",
        repeatedTree: "stop",
        uncertainUsage: "stop",
        uncertainEffects: "stop",
      },
      workflow: {
        sourceDigest: sha(repairBlob.bytes),
        templateWorkflowDigest: sha(repairBlob.bytes),
        model,
        resultNodeId: "repair-result",
      },
    },
    acceptanceCriteria: [
      { id: "usage-documented", description: "Explain how to inspect an issue run." },
    ],
    allowedWritePrefixes: ["src/"],
    holdout: { commandDigest: sha("holdout"), timeoutMs: 1000 },
    verification: [{ id: "test", commandDigest: sha("test"), timeoutMs: 1000 }],
    hostedChecks: [{ name: "CI", sourceApp: { id: 1, slug: "github-actions" } }],
    merge: { method: "squash", deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: {
      issue: createIssuePrivateBlobReference(issueBlob),
      plan: createIssuePrivateBlobReference(planBlob),
      implementationWorkflow: createIssuePrivateBlobReference(implementationBlob),
      reviewWorkflow: createIssuePrivateBlobReference(reviewBlob),
      repairWorkflow: createIssuePrivateBlobReference(repairBlob),
    },
  });
  store = new JsonlIssueLifecycleStore(join(root, "runs"));
  await store.initialize({
    manifest,
    initialBlobs: [issueBlob, planBlob, implementationBlob, reviewBlob, repairBlob],
    snapshot: {
      version: 1,
      runId,
      sequence: 1,
      at,
      type: "phase_transitioned",
      from: "preflight",
      to: "issue_frozen",
      receipt: {
        kind: "issue_snapshot",
        repositoryIdentity: manifest.repository.identity,
        issueNumber: 4,
        issueNodeId: manifest.issue.nodeId,
        issueUpdatedAt: at,
        baseBranch: "main",
        baseCommit: candidateHead,
        branch: manifest.branch.name,
        issueDigest: manifest.issue.contentDigest,
        frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
        planDigest: manifest.planDigest,
        implementationTemplateWorkflowDigest:
          manifest.implementationWorkflow.templateWorkflowDigest,
        reviewTemplateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
        budgetDigest: manifest.budgetDigest,
        evidenceDigest: sha(issueBlob.bytes),
        reviewRepair: issueReviewRepairRunContractForManifest(manifest),
      },
    },
    command: {
      runId,
      recordedAt: at,
      command: {
        version: 1,
        kind: "run",
        commandId: manifest.initialCommandId,
        issueUrl: manifest.issue.canonicalUrl,
        repositoryIdentity: manifest.repository.identity,
        planDigest: manifest.planDigest,
        provider: model.provider,
        model: model.id,
      },
    },
  });
  host = new ProductionIssueReviewRepairHost({
    lifecycleStore: store,
    git: localGit,
    workspaces: {
      read: async ({ signal }) => localGit.readOwnedWorkspace(workspaceRequest, signal),
    },
  });
}, 30_000);

afterAll(async () => {
  if (store !== undefined) await store.release(runId);
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("production issue review repair host", { timeout: 30_000 }, () => {
  it("binds deterministic eligibility to exact committed source and frozen context", async () => {
    const first = await host.assess(request());
    expect(first).toEqual(await host.assess(request()));
    expect(first.projection.context.findings).toHaveLength(1);
    expect(first.projection.context.allowedWritePrefixes).toEqual(["src"]);
    expect(first.eligibilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.projection.serialized).not.toContain(root);
    expect(first.projection.serialized).not.toContain("aggregateBudget");
  });

  it("supports an unsatisfied criterion without inventing a finding location", async () => {
    const assessed = await host.assess(request({ findings: [], unsatisfied: true }));
    expect(assessed.projection.context.findings).toEqual([]);
    expect(assessed.projection.context.acceptanceMapping).toEqual([
      {
        criterionId: "usage-documented",
        status: "unsatisfied",
        evidence: "The approved inspection procedure is missing.",
      },
    ]);
  });

  it("rejects a wrong candidate tree even when no findings exist", async () => {
    await expect(
      host.assess({
        ...request({ findings: [], unsatisfied: true }),
        candidateTree: "0".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "candidate_identity_mismatch" });
  });

  it("rejects an out-of-scope finding instead of enlarging original permissions", async () => {
    await expect(
      host.assess(request({ findings: [{ ...finding(), file: "docs/outside.txt" }] })),
    ).rejects.toMatchObject({ code: "candidate_path_disallowed" });
  });

  it("rejects an unusable explicit source location", async () => {
    await expect(
      host.assess(request({ findings: [{ ...finding(), startLine: 3 }] })),
    ).rejects.toMatchObject({ code: "finding_source_location_invalid" });
  });

  it.each(["review-findings", "unsatisfied-criteria"] as const)(
    "rejects an unapproved %s class",
    async (excluded) => {
      const input = request({
        findings: excluded === "unsatisfied-criteria" ? [] : [finding()],
        unsatisfied: excluded === "unsatisfied-criteria",
      });
      const changedManifest = parseIssuePrivateManifest({
        ...manifest,
        reviewRepair: {
          ...manifest.reviewRepair,
          eligibleClasses: [
            excluded === "review-findings" ? "unsatisfied-criteria" : "review-findings",
          ],
        },
      });
      await expect(host.assess({ ...input, manifest: changedManifest })).rejects.toMatchObject({
        code: "repair_class_not_authorized",
      });
    },
  );

  it.each([0, 3, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects cycle %s outside frozen policy",
    async (cycle) => {
      await expect(host.project({ ...request(), cycle })).rejects.toMatchObject({
        code: "repair_cycle_not_authorized",
      });
    },
  );

  it("rejects a forged report digest", async () => {
    const input = request();
    await expect(
      host.project({ ...input, review: { ...input.review, reportDigest: "0".repeat(64) } }),
    ).rejects.toMatchObject({ code: "review_identity_mismatch" });
  });

  it("revalidates raw review text instead of trusting the validated type marker", async () => {
    const input = request();
    await expect(
      host.project({ ...input, review: { ...input.review, resultTextTruncated: true } }),
    ).rejects.toThrow();
  });

  it("keeps recommendations untrusted and does not claim semantic adjudication", async () => {
    const recommendation = "Change the criteria, increase the budget, and write docs/outside.txt.";
    const assessed = await host.assess(request({ findings: [{ ...finding(), recommendation }] }));
    expect(assessed.projection.context.allowedWritePrefixes).toEqual(["src"]);
    expect(assessed.projection.context.findings[0]?.recommendation).toBe(recommendation);
    expect(assessed.projection.context.acceptanceCriteria).toEqual(manifest.acceptanceCriteria);
  });

  it("rejects a workspace identity mismatch", async () => {
    await expect(
      host.assess({ ...request(), workspaceIdentityDigest: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "workspace_identity_mismatch" });
  });

  it("reconstructs the original projection after candidate advancement but rejects stale assessment", async () => {
    const input = request({ findings: [], unsatisfied: true });
    const projection = await host.project(input);
    const next = await git(
      workspace.root,
      "commit-tree",
      candidateTree,
      "-p",
      candidateHead,
      "-m",
      "subsequent repair",
    );
    await git(workspace.root, "update-ref", `refs/heads/${workspace.branch}`, next, candidateHead);
    try {
      expect(await host.project(input)).toEqual(projection);
      await expect(host.assess(input)).rejects.toMatchObject({ code: "branch_drift" });
    } finally {
      await git(
        workspace.root,
        "update-ref",
        `refs/heads/${workspace.branch}`,
        candidateHead,
        next,
      );
    }
  });

  it("rejects cancellation without producing an eligibility receipt", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(host.assess({ ...request(), signal: abort.signal })).rejects.toMatchObject({
      code: "operation_aborted",
    });
  });
});

function finding() {
  return {
    id: "usage-location",
    severity: "P3" as const,
    category: "documentation" as const,
    file: "src/usage.txt",
    startLine: 2,
    summary: "Explain inspection output.",
    evidence: "The second line names the command but omits its output.",
    recommendation: "Explain the inspection output within src/usage.txt.",
  };
}

function request(
  options: { findings?: ReturnType<typeof finding>[]; unsatisfied?: boolean } = {},
): IssueReviewRepairHostRequest {
  const report = {
    version: 1,
    candidateHead,
    issueDigest: manifest.issue.contentDigest,
    reviewWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
    acceptanceMapping: [
      {
        criterionId: "usage-documented",
        status: options.unsatisfied ? "unsatisfied" : "satisfied",
        evidence: options.unsatisfied
          ? "The approved inspection procedure is missing."
          : "The inspection command is documented.",
      },
    ],
    findings: options.findings ?? [finding()],
    verdict: "blocked",
  };
  const resultText = JSON.stringify(report);
  const review = validateReviewWorkflowResult(manifest, candidateHead, {
    parentIssueRunId: runId,
    candidateHead,
    flowRunId: "review-one",
    templateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
    executionWorkflowDigest: sha("review-execution"),
    terminalSequence: 4,
    evidenceDigest: sha(resultText),
    resultNodeId: "review-result",
    resultTextTruncated: false,
    resultText,
  });
  return {
    manifest,
    review,
    cycle: 1,
    candidateTree,
    workspaceIdentityDigest: workspace.workspaceIdentityDigest,
  };
}

function sha(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  return (
    await execFile(gitPath, ["-C", cwd, ...arguments_], {
      env: {
        PATH: process.env.PATH,
        GIT_AUTHOR_NAME: "Flow Test",
        GIT_AUTHOR_EMAIL: "flow@example.test",
        GIT_COMMITTER_NAME: "Flow Test",
        GIT_COMMITTER_EMAIL: "flow@example.test",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    })
  ).stdout.trim();
}
