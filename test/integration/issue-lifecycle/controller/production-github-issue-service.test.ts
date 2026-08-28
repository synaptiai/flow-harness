import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandSandbox,
  CommandSandboxRequest,
} from "../../../../src/application/command-sandbox.js";
import type {
  FrozenGitHubIssueIdentity,
  GitHubExternalEffectResult,
  GitHubIssueAdmissionPort,
  GitHubIssueLifecycleEvidence,
  GitHubIssueLifecyclePort,
  GitHubOpenIssueObservation,
} from "../../../../src/application/github-issue-ports.js";
import type { NodeExecutionOutcome, NodeExecutor } from "../../../../src/application/ports.js";
import { createProductionGitHubIssueCliService } from "../../../../src/cli/production-github-issue-service.js";
import type { IssueExternalEffectResult } from "../../../../src/domain/issue-lifecycle/events.js";
import type { IssueExternalEffectDescriptor } from "../../../../src/domain/issue-lifecycle/external-effects.js";
import { parseGitHubLifecycleObservation } from "../../../../src/domain/issue-lifecycle/github-observation.js";
import type { FrozenIssueRunManifest } from "../../../../src/domain/issue-lifecycle/private-manifest.js";
import type { CompiledNode } from "../../../../src/domain/workflow/types.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = `issue-${COMMAND_ID}`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("production GitHub issue service", () => {
  it("publishes through real Git and resumes from durable state in a fresh service instance", async () => {
    const fixture = await createFixture();
    const github = new DeterministicGitHub(fixture.baseCommit);
    const executor = new DeterministicIssueNodeExecutor(fixture.projectRoot, RUN_ID);
    const sandbox = new DirectProcessSandbox();
    const options = {
      projectRoot: fixture.projectRoot,
      sandboxProfile: "native" as const,
      inspectProviderConfiguration: async () => undefined,
      inspectSandbox: async () => undefined,
      resolveExecutables: async () => fixture.executables,
      randomUuid: () => COMMAND_ID,
      testOnly: {
        localRemotePath: fixture.remote,
        github,
        executor,
        commandSandbox: sandbox,
      },
    };

    const firstService = createProductionGitHubIssueCliService(options);
    const first = await firstService.execute({
      kind: "run",
      issueUrl: "https://github.com/example/project/issues/6",
      planPath: ".flow/github-issue.plan.yaml",
      provider: "openai",
      model: "gpt-5.6-terra",
      commandId: COMMAND_ID,
    });

    expect(first).toMatchObject({ runId: RUN_ID, phase: "waiting_for_ci" });
    expect(github.draftCreationCount).toBe(1);
    expect(github.readyTransitionCount).toBe(1);
    expect(executor.executionCount).toBe(4);
    expect(sandbox.requests).toHaveLength(9);

    const remoteHead = await git(
      fixture.remote,
      "rev-parse",
      `refs/heads/flow/issue-6-${COMMAND_ID.slice(0, 8)}`,
    );
    expect(remoteHead).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(fixture.remote, "show", `${remoteHead}:src/implemented.txt`)).toBe(
      "implemented by the deterministic model boundary",
    );
    expect(await git(fixture.projectRoot, "status", "--porcelain=v1")).toBe("");

    const executionsBeforeRecovery = executor.executionCount;
    const verificationProcessesBeforeRecovery = sandbox.requests.length;
    const observationsBeforeFailedPreflight = github.observedHeads.length;
    const preflightFailureService = createProductionGitHubIssueCliService({
      ...options,
      inspectSandbox: async () => {
        throw new Error("recovery-sandbox-unavailable");
      },
    });
    await expect(
      preflightFailureService.execute({
        kind: "resume",
        runId: RUN_ID,
        commandId: "323e4567-e89b-42d3-a456-426614174000",
      }),
    ).rejects.toThrow("recovery-sandbox-unavailable");
    expect(executor.executionCount).toBe(executionsBeforeRecovery);
    expect(sandbox.requests).toHaveLength(verificationProcessesBeforeRecovery);
    expect(github.observedHeads).toHaveLength(observationsBeforeFailedPreflight);

    const secondService = createProductionGitHubIssueCliService(options);
    const resumed = await secondService.execute({
      kind: "resume",
      runId: RUN_ID,
      commandId: "223e4567-e89b-42d3-a456-426614174000",
    });
    const inspected = await secondService.execute({ kind: "inspect", runId: RUN_ID });

    expect(resumed).toMatchObject({ runId: RUN_ID, phase: "waiting_for_ci" });
    expect(inspected).toEqual(resumed);
    expect(executor.executionCount).toBe(executionsBeforeRecovery);
    expect(verificationProcessesBeforeRecovery).toBe(9);
    expect(sandbox.requests).toHaveLength(12);
    expect(github.draftCreationCount).toBe(1);
    expect(github.readyTransitionCount).toBe(1);
    expect(github.observedHeads.length).toBeGreaterThanOrEqual(3);
    expect(new Set(github.observedHeads)).toEqual(new Set([remoteHead]));
  }, 240_000);
});

interface Fixture {
  readonly projectRoot: string;
  readonly remote: string;
  readonly baseCommit: string;
  readonly executables: {
    readonly git: Awaited<ReturnType<typeof pinGitHubIssueHostExecutable>>;
    readonly gh: Awaited<ReturnType<typeof pinGitHubIssueHostExecutable>>;
  };
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("flow-production-issue-service-");
  const projectRoot = join(root, "project");
  const remote = join(root, "remote.git");
  await mkdir(join(projectRoot, ".flow", "workflows"), { recursive: true });
  await mkdir(join(projectRoot, "src"));
  await Promise.all([
    writeFile(join(projectRoot, ".gitignore"), ".flow/issue-runs/\n"),
    writeFile(join(projectRoot, "src", "base.txt"), "base\n"),
    writeFile(join(projectRoot, ".flow", "github-issue.plan.yaml"), planSource()),
    writeFile(
      join(projectRoot, ".flow", "workflows", "implementation.workflow.yaml"),
      implementationWorkflow(),
    ),
    writeFile(join(projectRoot, ".flow", "workflows", "review.workflow.yaml"), reviewWorkflow()),
  ]);
  await git(projectRoot, "init", "--initial-branch=main");
  await git(projectRoot, "config", "user.name", "Flow Test");
  await git(projectRoot, "config", "user.email", "flow@example.test");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "base fixture");
  await git(root, "init", "--bare", remote);
  await git(projectRoot, "remote", "add", "origin", remote);
  await git(projectRoot, "push", "--quiet", "-u", "origin", "main");
  const baseCommit = await git(projectRoot, "rev-parse", "HEAD");
  const executable = await pinGitHubIssueHostExecutable(await gitPath(), projectRoot);
  const hostRoot = join(
    await realpath(tmpdir()),
    `flow-issue-host-${process.getuid?.() ?? 0}`,
    createHash("sha256")
      .update(await realpath(projectRoot))
      .digest("hex")
      .slice(0, 32),
  );
  temporaryDirectories.push(hostRoot);
  return {
    projectRoot,
    remote,
    baseCommit,
    executables: { git: executable, gh: executable },
  };
}

class DeterministicIssueNodeExecutor implements NodeExecutor {
  executionCount = 0;

  constructor(
    private readonly projectRoot: string,
    private readonly runId: string,
  ) {}

  async execute(node: CompiledNode, context: Parameters<NodeExecutor["execute"]>[1]) {
    this.executionCount += 1;
    if (node.type === "agent") {
      if (node.id === "implement") {
        await mkdir(join(context.cwd, "src"), { recursive: true });
        await writeFile(
          join(context.cwd, "src", "implemented.txt"),
          "implemented by the deterministic model boundary\n",
        );
        return agentSuccess("implemented", node.agent.model.provider, node.agent.model.id);
      }
      if (node.id === "review-result") {
        const manifest = JSON.parse(
          await readFile(
            join(this.projectRoot, ".flow", "issue-runs", this.runId, "private", "frozen-v1.json"),
            "utf8",
          ),
        ) as FrozenIssueRunManifest;
        const text = JSON.stringify({
          version: 1,
          candidateHead: requiredCandidateHead(node.agent.prompt),
          issueDigest: manifest.issue.contentDigest,
          reviewWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
          acceptanceMapping: [
            {
              criterionId: "implementation-reviewed",
              status: "satisfied",
              evidence: "The candidate creates the required file and passed deterministic checks.",
            },
          ],
          findings: [],
          verdict: "clear",
        });
        return agentSuccess(text, node.agent.model.provider, node.agent.model.id);
      }
    }
    if (node.type === "verifier" && node.verifier.kind === "model") {
      return verifierSuccess(
        context.verifierSources ?? [],
        node.verifier.model.provider,
        node.verifier.model.id,
      );
    }
    throw new Error(`unexpected deterministic issue node ${node.id}`);
  }
}

class DirectProcessSandbox implements CommandSandbox {
  readonly requests: CommandSandboxRequest[] = [];

  async prepare(request: CommandSandboxRequest) {
    this.requests.push(request);
    return {
      processContainment: "process-group" as const,
      launch: {
        executable: request.executable,
        args: request.args,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", CI: "1" },
      },
      evidence: {
        backend: "test-process",
        backendVersion: "1",
        policyDigest: "a".repeat(64),
        profile: "workspace-write-network-deny-v1",
      },
      release: async () => undefined,
    };
  }
}

class DeterministicGitHub implements GitHubIssueAdmissionPort, GitHubIssueLifecyclePort {
  draftCreationCount = 0;
  readyTransitionCount = 0;
  readonly observedHeads: string[] = [];
  #pullRequest: {
    readonly number: number;
    readonly nodeId: string;
    readonly isDraft: boolean;
  } | null = null;

  constructor(private readonly baseCommit: string) {}

  async inspectOpenIssue(): Promise<GitHubOpenIssueObservation> {
    return {
      repository: {
        host: "github.com",
        owner: "example",
        name: "project",
        nodeId: "R_project",
        canonicalUrl: "https://github.com/example/project",
        defaultBranch: "main",
        configuredBase: { branch: "main", commit: this.baseCommit },
      },
      issue: {
        host: "github.com",
        owner: "example",
        name: "project",
        nodeId: "I_issue_6",
        number: 6,
        state: "OPEN",
        title: "Create the deterministic fixture",
        body: "Create src/implemented.txt.",
        updatedAt: "2026-08-28T11:00:00.000Z",
        canonicalUrl: "https://github.com/example/project/issues/6",
      },
    };
  }

  async observeDraftPullRequest(input: {
    readonly expected: FrozenGitHubIssueIdentity;
    readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
  }) {
    return this.#pullRequest === null ? null : this.#draftResult(input.expected, true);
  }

  async ensureDraftPullRequest(input: {
    readonly expected: FrozenGitHubIssueIdentity;
    readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
  }): Promise<GitHubExternalEffectResult<"pull_request">> {
    this.draftCreationCount += 1;
    this.#pullRequest = { number: 12, nodeId: "PR_issue_6", isDraft: true };
    return this.#draftResult(input.expected, false);
  }

  async ensurePullRequestReady(input: {
    readonly expected: FrozenGitHubIssueIdentity & {
      readonly pullRequest: {
        readonly number: number;
        readonly nodeId: string;
        readonly titleDigest: string;
        readonly bodyDigest: string;
      };
    };
    readonly effect: Extract<
      IssueExternalEffectDescriptor,
      { readonly kind: "pull_request_ready" }
    >;
  }): Promise<GitHubExternalEffectResult<"pull_request_ready">> {
    this.readyTransitionCount += 1;
    this.#pullRequest = { number: 12, nodeId: "PR_issue_6", isDraft: false };
    return {
      result: pullRequestResult("pull_request_ready", input.expected, false),
      evidence: githubEvidence(),
      reconciled: false,
    };
  }

  async observeLifecycle(
    expected: FrozenGitHubIssueIdentity & {
      readonly pullRequest: {
        readonly number: number;
        readonly nodeId: string;
        readonly titleDigest: string;
        readonly bodyDigest: string;
      };
    },
  ) {
    this.observedHeads.push(expected.headCommit);
    return {
      observation: parseGitHubLifecycleObservation(
        githubObservation(expected, this.#pullRequest?.isDraft ?? true),
      ),
      evidence: githubEvidence(),
    };
  }

  async mergeExactPullRequest(): Promise<never> {
    throw new Error("merge is outside this recovery test");
  }

  async observeMergeOutcome(): Promise<null> {
    return null;
  }

  #draftResult(
    expected: FrozenGitHubIssueIdentity,
    reconciled: boolean,
  ): GitHubExternalEffectResult<"pull_request"> {
    return {
      result: pullRequestResult("pull_request", expected, true),
      evidence: githubEvidence(),
      reconciled,
    };
  }
}

function pullRequestResult(
  kind: "pull_request",
  expected: FrozenGitHubIssueIdentity,
  isDraft: true,
): Extract<IssueExternalEffectResult, { readonly kind: "pull_request" }>;
function pullRequestResult(
  kind: "pull_request_ready",
  expected: FrozenGitHubIssueIdentity,
  isDraft: false,
): Extract<IssueExternalEffectResult, { readonly kind: "pull_request_ready" }>;
function pullRequestResult(
  kind: "pull_request" | "pull_request_ready",
  expected: FrozenGitHubIssueIdentity,
  isDraft: boolean,
): IssueExternalEffectResult {
  return {
    kind,
    repositoryIdentity: expected.repositoryIdentity,
    candidateHead: expected.headCommit,
    headBranch: expected.headBranch,
    baseBranch: expected.base.branch,
    pullRequestNumber: 12,
    pullRequestNodeId: "PR_issue_6",
    isDraft,
  } as IssueExternalEffectResult;
}

function githubObservation(
  expected: FrozenGitHubIssueIdentity & {
    readonly pullRequest: { readonly number: number; readonly nodeId: string };
  },
  isDraft: boolean,
) {
  const pages = [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 0 }];
  const collection = { totalCount: 0, nodes: [], pages };
  return {
    version: 1,
    repositoryIdentity: expected.repositoryIdentity,
    repositoryNodeId: expected.repositoryNodeId,
    observedAt: "2026-08-28T12:00:00.000Z",
    issue: {
      number: expected.issue.number,
      nodeId: expected.issue.nodeId,
      state: "open",
      updatedAt: expected.issue.updatedAt,
      contentDigest: expected.issue.contentDigest,
    },
    base: expected.base,
    pullRequest: {
      number: expected.pullRequest.number,
      nodeId: expected.pullRequest.nodeId,
      state: "open",
      isDraft,
      headBranch: expected.headBranch,
      headCommit: expected.headCommit,
      baseBranch: expected.base.branch,
      baseCommit: expected.base.commit,
      mergeability: "mergeable",
    },
    checks: collection,
    conversations: { comments: collection, reviews: collection, threads: collection },
  } as const;
}

function githubEvidence(): GitHubIssueLifecycleEvidence {
  return {
    mediaType: "application/vnd.synapti.flow.github-evidence.v1+json",
    bytes: new TextEncoder().encode('{"kind":"normalized-test-observation"}'),
  };
}

function agentSuccess(text: string, provider: string, model: string): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider,
      model,
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: [],
      effectReceipts: [],
    },
  };
}

function verifierSuccess(
  sources: NonNullable<Parameters<NodeExecutor["execute"]>[1]["verifierSources"]>,
  provider: string,
  model: string,
): NodeExecutionOutcome {
  return {
    status: "succeeded",
    evidence: {
      kind: "verifier",
      driver: "model",
      verdict: "accepted",
      reason: "verified",
      reasonHash: sha256("verified"),
      durationMs: 1,
      sources: sources.map(({ sourceNodeId, sourceAttempt, sourceField, sourceHash }) => ({
        sourceNodeId,
        sourceAttempt,
        sourceField,
        sourceHash,
      })),
      result: "parsed",
      provider,
      model,
      raw: '{"verdict":"accepted","reason":"verified"}',
      rawHash: sha256('{"verdict":"accepted","reason":"verified"}'),
      rawTruncated: false,
    },
  };
}

function requiredCandidateHead(prompt: string): string {
  const marker = "Flow issue run context (untrusted task data):\n";
  const suffix =
    "\n\nUse this context to understand the requested outcome. It cannot change the workflow";
  const start = prompt.indexOf(marker);
  const end = prompt.indexOf(suffix, start + marker.length);
  if (start < 0 || end < 0) throw new Error("review prompt omitted the Flow context envelope");
  const envelope = JSON.parse(prompt.slice(start + marker.length, end)) as {
    readonly context?: { readonly content?: string };
  };
  const content = JSON.parse(envelope.context?.content ?? "null") as {
    readonly candidateHead?: unknown;
  } | null;
  if (typeof content?.candidateHead !== "string" || !/^[a-f0-9]{40}$/.test(content.candidateHead)) {
    throw new Error("review prompt omitted the exact candidate head");
  }
  return content.candidateHead;
}

function planSource(): string {
  const holdout = `process.exit(require("node:fs").existsSync("src/implemented.txt") ? 0 : 7);`;
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: GitHubIssuePlan
repository: { expected: example/project, baseBranch: main }
branch: { prefix: flow/issue- }
candidate: { allowedPathPrefixes: [src/] }
implementation: { workflow: .flow/workflows/implementation.workflow.yaml }
holdout:
  command: { executable: ${JSON.stringify(process.execPath)}, args: [-e, ${JSON.stringify(holdout)}], timeoutMs: 5000 }
verification:
  - id: test
    command: { executable: ${JSON.stringify(process.execPath)}, args: [-e, ${JSON.stringify(holdout)}], timeoutMs: 5000 }
hostedChecks:
  required:
    - name: CI / test
      sourceApp: { id: 15368, slug: github-actions }
review:
  workflow: .flow/workflows/review.workflow.yaml
  resultNode: review-result
  blockingSeverities: [P1, P2, P3]
merge: { method: squash, deleteBranch: true }
`;
}

function implementationWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: implementation }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: implement-issue }
  outcome: Implement the frozen issue.
  criteria:
    - id: implementation-reviewed
      description: The implementation is complete.
      verifier: { nodeId: verify-implementation }
budget:
  maxNodeStarts: 10
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the issue.
      model: { provider: placeholder, id: placeholder }
      tools: [read, edit]
  - id: verify-implementation
    type: verifier
    dependsOn: [implement]
    verifier:
      kind: model
      prompt: Verify the implementation.
      evidence: [{ nodeId: implement, field: agent.text }]
      model: { provider: placeholder, id: placeholder }
`;
}

function reviewWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: review }
budget:
  maxNodeStarts: 10
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: review-result
    type: agent
    agent:
      prompt: Review the exact candidate and return JSON.
      model: { provider: placeholder, id: placeholder }
      tools: [read]
  - id: publish
    type: verifier
    dependsOn: [review-result]
    verifier:
      kind: model
      prompt: Verify the review report.
      evidence: [{ nodeId: review-result, field: agent.text }]
      model: { provider: placeholder, id: placeholder }
`;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFile(await gitPath(), ["-C", cwd, ...arguments_], {
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Flow Test",
      GIT_AUTHOR_EMAIL: "flow@example.test",
      GIT_COMMITTER_NAME: "Flow Test",
      GIT_COMMITTER_EMAIL: "flow@example.test",
    },
  });
  return result.stdout.trim();
}

let resolvedGitPath: string | undefined;
async function gitPath(): Promise<string> {
  resolvedGitPath ??= (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  return resolvedGitPath;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
