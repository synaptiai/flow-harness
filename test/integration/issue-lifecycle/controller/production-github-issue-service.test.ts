import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { cancelGitHubIssue } from "../../../../src/application/cancel-github-issue.js";
import type {
  CommandSandbox,
  CommandSandboxRequest,
} from "../../../../src/application/command-sandbox.js";
import { replayIssueLifecycleState } from "../../../../src/application/continue-github-issue.js";
import type {
  FrozenGitHubIssueIdentity,
  GitHubExternalEffectResult,
  GitHubIssueAdmissionPort,
  GitHubIssueLifecycleEvidence,
  GitHubIssueLifecyclePort,
  GitHubOpenIssueObservation,
  GitHubRemoteMergeOutcome,
} from "../../../../src/application/github-issue-ports.js";
import { mergeGitHubIssue } from "../../../../src/application/merge-github-issue.js";
import type { NodeExecutionOutcome, NodeExecutor } from "../../../../src/application/ports.js";
import { resumeGitHubIssue } from "../../../../src/application/resume-github-issue.js";
import { runGitHubIssue } from "../../../../src/application/run-github-issue.js";
import type {
  GitHubIssueCliRequest,
  GitHubIssueCliService,
} from "../../../../src/cli/github-issue.js";
import type {
  IssueExternalEffectResult,
  PublicIssueLifecycleState,
} from "../../../../src/domain/issue-lifecycle/events.js";
import { projectPublicIssueLifecycleState } from "../../../../src/domain/issue-lifecycle/events.js";
import type { IssueExternalEffectDescriptor } from "../../../../src/domain/issue-lifecycle/external-effects.js";
import { parseGitHubLifecycleObservation } from "../../../../src/domain/issue-lifecycle/github-observation.js";
import type { FrozenIssueRunManifest } from "../../../../src/domain/issue-lifecycle/private-manifest.js";
import type { CompiledNode } from "../../../../src/domain/workflow/types.js";
import { JsonlIssueLifecycleStore } from "../../../../src/infrastructure/fs/jsonl-issue-lifecycle-store.js";
import { JsonlModelSessionStore } from "../../../../src/infrastructure/fs/jsonl-model-session-store.js";
import { LocalArtifactStore } from "../../../../src/infrastructure/fs/local-artifact-store.js";
import { ensureOwnedPrivateDirectory } from "../../../../src/infrastructure/fs/owned-private-directory.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../../../../src/infrastructure/git/local-git-issue-effects.js";
import { LocalGitRepositoryAdmission } from "../../../../src/infrastructure/git/local-git-repository-admission.js";
import { LocalIssueReviewEvidence } from "../../../../src/infrastructure/git/local-issue-review-evidence.js";
import { LocalIssueVerification } from "../../../../src/infrastructure/git/local-issue-verification.js";
import { IssueLifecycleHost } from "../../../../src/infrastructure/github/issue-lifecycle-host.js";
import {
  ProductionIssueRunFreezer,
  ProductionIssueWorkflowRunner,
} from "../../../../src/infrastructure/issue-lifecycle/production-issue-runner.js";
import { createProductionNodeEffectReconciler } from "../../../../src/infrastructure/runtime/production-effect-reconciler.js";
import { createProductionWorkspaceIsolator } from "../../../../src/infrastructure/runtime/production-workspace-isolator.js";

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
  it("publishes, resumes, gates, and squash-merges through real Git", async () => {
    const fixture = await createFixture();
    const github = new DeterministicGitHub(fixture.remote, fixture.baseCommit);
    const executor = new DeterministicIssueNodeExecutor(fixture.projectRoot, RUN_ID);
    const sandbox = new DirectProcessSandbox();
    const firstService = await createDeterministicService(fixture, github, executor, sandbox);
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
    expect(github.observedHeads).toHaveLength(observationsBeforeFailedPreflight);

    github.markChecksGreen();
    const secondService = await createDeterministicService(fixture, github, executor, sandbox);
    const resumed = requireIssueState(
      await secondService.execute({
        kind: "resume",
        runId: RUN_ID,
        commandId: "223e4567-e89b-42d3-a456-426614174000",
      }),
    );
    const inspected = await secondService.execute({ kind: "inspect", runId: RUN_ID });

    expect(resumed).toMatchObject({ runId: RUN_ID, phase: "merge_approval_required" });
    expect(inspected).toEqual(resumed);
    expect(executor.executionCount).toBe(executionsBeforeRecovery);
    expect(verificationProcessesBeforeRecovery).toBe(9);
    expect(sandbox.requests).toHaveLength(12);
    expect(github.draftCreationCount).toBe(1);
    expect(github.readyTransitionCount).toBe(1);
    expect(github.observedHeads.length).toBeGreaterThanOrEqual(3);
    expect(new Set(github.observedHeads)).toEqual(new Set([remoteHead]));

    if (resumed.mergeApproval === undefined) throw new Error("expected exact merge approval");
    const merged = requireIssueState(
      await secondService.execute({
        kind: "merge",
        runId: RUN_ID,
        commandId: "423e4567-e89b-42d3-a456-426614174000",
        actor: "flow-test-operator",
        expectedPullRequest: resumed.mergeApproval.pullRequestNumber,
        expectedHead: resumed.mergeApproval.headCommit,
        expectedGateDigest: resumed.mergeApproval.gateDigest,
      }),
    );
    if (merged.phase === "external_state_uncertain") {
      const events = await secondService.execute({
        kind: "events",
        runId: RUN_ID,
        afterSequence: Math.max(0, merged.sequence - 4),
        limit: 10,
      });
      throw new Error(`merge proof remained uncertain: ${JSON.stringify(events)}`);
    }

    expect(merged).toMatchObject({ runId: RUN_ID, phase: "merged" });
    expect(executor.executionCount).toBe(executionsBeforeRecovery);
    expect(github.mergeCount).toBe(1);
    expect(await git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(
      github.requiredMergeCommit(),
    );
    expect(await git(fixture.remote, "show", "refs/heads/main:src/implemented.txt")).toBe(
      "implemented by the deterministic model boundary",
    );
    await expect(
      git(fixture.remote, "rev-parse", `refs/heads/flow/issue-6-${COMMAND_ID.slice(0, 8)}`),
    ).rejects.toThrow();
    await expect(
      import("node:fs/promises").then(
        async ({ access }) => await access(join(fixture.projectRoot, ".flow", "artifacts")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(
        await readFile(
          join(
            fixture.projectRoot,
            ".flow",
            "issue-runs",
            "artifact-store",
            ".flow",
            "artifacts",
            "catalog.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ version: 1, references: [{ retention: "retained" }] });
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

async function createDeterministicService(
  fixture: Fixture,
  github: DeterministicGitHub,
  executor: NodeExecutor,
  sandbox: CommandSandbox,
): Promise<GitHubIssueCliService> {
  const projectRoot = await realpath(fixture.projectRoot);
  const durableRoot = join(projectRoot, ".flow", "issue-runs");
  const artifactRoot = join(durableRoot, "artifact-store");
  const hostRoot = join(
    await realpath(tmpdir()),
    `flow-issue-host-${process.getuid?.() ?? 0}`,
    createHash("sha256").update(projectRoot).digest("hex").slice(0, 32),
  );
  await ensureOwnedPrivateDirectory(durableRoot);
  await ensureOwnedPrivateDirectory(artifactRoot);
  await ensureOwnedPrivateDirectory(join(hostRoot, ".."));
  await ensureOwnedPrivateDirectory(hostRoot);
  await ensureOwnedPrivateDirectory(join(hostRoot, "worktrees"));

  const store = new JsonlIssueLifecycleStore(durableRoot);
  const localGit = new LocalGitIssueEffects({
    gitExecutable: fixture.executables.git,
    privateRoot: hostRoot,
    timeoutMs: 60_000,
    testOnlyLocalRemotePath: fixture.remote,
  });
  const host = new IssueLifecycleHost({
    store,
    localGit,
    github,
    sourceRoot: projectRoot,
    workspaceParent: join(hostRoot, "worktrees"),
  });
  const verification = new LocalIssueVerification({
    git: localGit,
    workspaceProvider: host,
    privateStore: store,
    sandbox,
  });
  const workflows = new ProductionIssueWorkflowRunner({
    nestedRunRoot: join(durableRoot, "nested-runs"),
    lifecycleStore: store,
    workspaces: host,
    git: localGit,
    reviewEvidence: new LocalIssueReviewEvidence({
      git: localGit,
      gitExecutable: fixture.executables.git,
      privateStore: store,
      verification,
    }),
    executor,
    modelSessionStore: new JsonlModelSessionStore(join(durableRoot, "model-sessions")),
    artifactStore: new LocalArtifactStore(artifactRoot),
    effectReconciler: createProductionNodeEffectReconciler(),
    workspaceIsolator: createProductionWorkspaceIsolator(
      join(durableRoot, "nested-runs"),
      [],
      hostRoot,
      hostRoot,
    ),
  });
  const runtime = Object.freeze({
    repository: store,
    workflows,
    verification,
    github: host,
    effects: host,
  });
  const repositoryAdmission = new LocalGitRepositoryAdmission({
    gitExecutable: fixture.executables.git,
    testOnlyLocalRemotePath: fixture.remote,
  });
  const freezer = new ProductionIssueRunFreezer({
    projectRoot,
    planPath: ".flow/github-issue.plan.yaml",
    controllerTimeouts: [
      { id: "git-read", timeoutMs: 60_000 },
      { id: "github-read", timeoutMs: 30_000 },
      { id: "git-write", timeoutMs: 60_000 },
      { id: "github-write", timeoutMs: 30_000 },
    ],
    repositoryAdmission,
    githubAdmission: github,
  });

  return {
    async execute(request: GitHubIssueCliRequest): Promise<unknown> {
      switch (request.kind) {
        case "run": {
          const plan = await readFile(join(projectRoot, request.planPath));
          return await runGitHubIssue(
            {
              version: 1,
              kind: "run",
              commandId: request.commandId,
              issueUrl: request.issueUrl,
              repositoryIdentity: "example/project",
              planDigest: createHash("sha256").update(plan).digest("hex"),
              provider: request.provider,
              model: request.model,
            },
            { ...runtime, freezer },
          );
        }
        case "resume":
          return await resumeGitHubIssue(
            { version: 1, kind: "resume", runId: request.runId, commandId: request.commandId },
            runtime,
          );
        case "merge":
          return await mergeGitHubIssue(
            {
              version: 1,
              kind: "merge",
              runId: request.runId,
              commandId: request.commandId,
              actor: request.actor,
              expectedPullRequest: request.expectedPullRequest,
              expectedHead: request.expectedHead,
              expectedGateDigest: request.expectedGateDigest,
            },
            runtime,
          );
        case "cancel":
          return await cancelGitHubIssue(
            {
              version: 1,
              kind: "cancel",
              runId: request.runId,
              commandId: request.commandId,
              actor: request.actor,
              ...(request.reason === undefined ? {} : { reason: request.reason }),
            },
            runtime,
          );
        case "inspect":
          return projectPublicIssueLifecycleState(
            replayIssueLifecycleState(
              await store.readManifest(request.runId),
              await store.read(request.runId),
            ),
          );
        case "events":
          return await store.readPage({
            runId: request.runId,
            afterSequence: request.afterSequence,
            limit: request.limit,
          });
        case "validate":
        case "doctor":
          throw new Error("deterministic lifecycle service does not expose CLI preflight");
      }
    },
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
        if (context.artifactStore === undefined) {
          throw new Error("production issue workflow omitted its private artifact store");
        }
        await context.artifactStore.retain({
          bytes: new TextEncoder().encode("deterministic private artifact"),
          mediaType: "text/plain",
          producer: {
            kind: "agent-command",
            runId: context.runId,
            workflowId: context.workflowId,
            nodeId: node.id,
            attempt: context.attempt,
            commandId: "deterministic-artifact",
            commandSequence: 1,
            stream: "stdout",
          },
        });
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
  mergeCount = 0;
  readyTransitionCount = 0;
  readonly observedHeads: string[] = [];
  #checksGreen = false;
  #mergeOutcome: GitHubRemoteMergeOutcome | null = null;
  #pullRequest: {
    readonly number: number;
    readonly nodeId: string;
    readonly isDraft: boolean;
  } | null = null;

  constructor(
    private readonly remote: string,
    private readonly baseCommit: string,
  ) {}

  markChecksGreen(): void {
    this.#checksGreen = true;
  }

  requiredMergeCommit(): string {
    if (this.#mergeOutcome === null) throw new Error("merge outcome is unavailable");
    return this.#mergeOutcome.mergeCommit;
  }

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
    await git(this.remote, "update-ref", "refs/pull/12/head", input.expected.headCommit);
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
        githubObservation(expected, this.#pullRequest?.isDraft ?? true, this.#checksGreen),
      ),
      evidence: githubEvidence(),
    };
  }

  async mergeExactPullRequest(
    input: Parameters<GitHubIssueLifecyclePort["mergeExactPullRequest"]>[0],
  ) {
    this.mergeCount += 1;
    const tree = await git(this.remote, "rev-parse", `${input.expected.headCommit}^{tree}`);
    const mergeCommit = await git(
      this.remote,
      "commit-tree",
      tree,
      "-p",
      this.baseCommit,
      "-m",
      "Deterministic squash merge",
    );
    await git(this.remote, "update-ref", "refs/heads/main", mergeCommit, this.baseCommit);
    await git(
      this.remote,
      "update-ref",
      "-d",
      `refs/heads/${input.expected.headBranch}`,
      input.expected.headCommit,
    );
    this.#mergeOutcome = {
      repositoryIdentity: input.expected.repositoryIdentity,
      repositoryNodeId: input.expected.repositoryNodeId,
      pullRequestNumber: input.expected.pullRequest.number,
      pullRequestNodeId: input.expected.pullRequest.nodeId,
      pullRequestTitleDigest: input.expected.pullRequest.titleDigest,
      pullRequestBodyDigest: input.expected.pullRequest.bodyDigest,
      issueNumber: input.expected.issue.number,
      issueNodeId: input.expected.issue.nodeId,
      issueState: "closed",
      issueUpdatedAt: "2026-08-28T13:00:00.000Z",
      issueContentDigest: input.expected.issue.contentDigest,
      candidateHead: input.expected.headCommit,
      baseBranch: input.expected.base.branch,
      observedBaseCommit: mergeCommit,
      mergeCommit,
      mergedAt: "2026-08-28T13:00:00.000Z",
      branchDeleted: true,
    };
    return { outcome: this.#mergeOutcome, evidence: githubEvidence(), reconciled: false };
  }

  async observeMergeOutcome() {
    return this.#mergeOutcome === null
      ? null
      : { outcome: this.#mergeOutcome, evidence: githubEvidence(), reconciled: true };
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
  checksGreen: boolean,
) {
  const pages = [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 0 }];
  const emptyCollection = { totalCount: 0, nodes: [], pages };
  const checks = checksGreen
    ? {
        totalCount: 1,
        nodes: [
          {
            runId: 1,
            name: "CI / test",
            sourceApp: { id: 15_368, slug: "github-actions" },
            status: "completed" as const,
            conclusion: "success" as const,
            headCommit: expected.headCommit,
            startedAt: "2026-08-28T12:00:00.000Z",
            completedAt: "2026-08-28T12:01:00.000Z",
          },
        ],
        pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 1 }],
      }
    : emptyCollection;
  return {
    version: 1,
    repositoryIdentity: expected.repositoryIdentity,
    repositoryNodeId: expected.repositoryNodeId,
    observedAt: "2026-08-28T12:02:00.000Z",
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
    checks,
    conversations: {
      comments: emptyCollection,
      reviews: emptyCollection,
      threads: emptyCollection,
    },
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
    readonly expectedResult?: { readonly candidateHead?: unknown };
    readonly candidate?: { readonly candidateHead?: unknown };
  } | null;
  const expectedHead = content?.expectedResult?.candidateHead;
  const candidateHead = content?.candidate?.candidateHead;
  if (
    typeof expectedHead !== "string" ||
    !/^[a-f0-9]{40}$/.test(expectedHead) ||
    candidateHead !== expectedHead
  ) {
    throw new Error("review prompt omitted the exact candidate head");
  }
  return expectedHead;
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

function requireIssueState(value: unknown): PublicIssueLifecycleState {
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !("phase" in value) ||
    typeof value.phase !== "string"
  ) {
    throw new Error("production service returned an invalid public issue lifecycle state");
  }
  return value as PublicIssueLifecycleState;
}
