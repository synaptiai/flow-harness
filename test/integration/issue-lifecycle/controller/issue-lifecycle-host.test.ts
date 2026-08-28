import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IssueExternalEffectPreparation } from "../../../../src/application/github-issue-controller-ports.js";
import type {
  FrozenGitHubIssueIdentity,
  GitHubExternalEffectResult,
  GitHubIssueLifecycleEvidence,
  GitHubOpenIssueObservation,
  GitHubRemoteMergeOutcome,
} from "../../../../src/application/github-issue-ports.js";
import type {
  IssueGitCommitObservation,
  IssueGitPatchSeriesObservation,
  IssueGitWorkspace,
} from "../../../../src/application/issue-local-git-port.js";
import type {
  IssueExternalEffectResult,
  IssueLifecycleEvent,
  IssueLifecycleState,
  PendingIssueExternalEffect,
} from "../../../../src/domain/issue-lifecycle/events.js";
import {
  calculateIssueExternalEffectOperationDigest,
  type IssueExternalEffectDescriptor,
} from "../../../../src/domain/issue-lifecycle/external-effects.js";
import {
  parseGitHubLifecycleObservation,
  verifyIssueMergeProof,
} from "../../../../src/domain/issue-lifecycle/github-observation.js";
import {
  calculateIssueBudgetDigest,
  createIssuePrivateBlobReference,
  type FrozenIssueRunManifest,
  parseIssuePrivateManifest,
} from "../../../../src/domain/issue-lifecycle/private-manifest.js";
import {
  calculateIssueCandidateTreeDigest,
  calculateIssueHostCommitMessageDigest,
  encodeFrozenGitHubIssueSnapshot,
  IssueLifecycleHost,
  renderIssueHostCommitMessage,
  renderIssueHostPullRequest,
} from "../../../../src/infrastructure/github/issue-lifecycle-host.js";

const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const MERGE = "c".repeat(40);
const TREE = "d".repeat(40);
const BASE_TREE = "e".repeat(40);
const DIGEST = "1".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("IssueLifecycleHost", () => {
  it("renders deterministic host-owned commit and pull request content", async () => {
    const fixture = await hostFixture();

    expect(renderIssueHostCommitMessage(fixture.manifest)).toBe("Implement issue #197\n");
    expect(renderIssueHostPullRequest(fixture.manifest)).toEqual({
      title: "Implement issue #197",
      body: "Closes #197\n\nCreated by the Flow harness for frozen run `issue-197-test`.\n",
    });
    expect(calculateIssueHostCommitMessageDigest(fixture.manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reconstructs a prepared commit descriptor solely from frozen and observable state", async () => {
    const fixture = await hostFixture();
    await fixture.localGit.prepareWorkspace(fixture.workspaceRequest);
    const preparation: IssueExternalEffectPreparation = {
      kind: "commit",
      commandId: "11111111-1111-4111-8111-111111111111",
      workspaceIdentityDigest: fixture.localGit.workspace.workspaceIdentityDigest,
      parentCommit: BASE,
      candidateTreeDigest: calculateIssueCandidateTreeDigest(TREE),
      messageDigest: calculateIssueHostCommitMessageDigest(fixture.manifest),
    };
    const described = await fixture.host.describe(preparation, fixture.manifest);
    const pending = pendingEffect(described);

    const recovered = await fixture.host.recover(
      fixture.manifest,
      state({ pendingEffect: pending }),
      pending,
    );

    expect(recovered).toEqual(described);
  });

  it("reconciles workspace creation before and after the exact local mutation", async () => {
    const fixture = await hostFixture();
    const descriptor = await fixture.host.describe(
      { kind: "workspace", commandId: "11111111-1111-4111-8111-111111111111" },
      fixture.manifest,
    );

    await expect(fixture.host.reconcile(descriptor, operation())).resolves.toMatchObject({
      status: "not_applied",
    });
    await fixture.host.execute(descriptor, operation());
    expect(fixture.localGit.lastPrepareRequest).toMatchObject({
      workspaceRoot: join(fixture.workspaceParent, "issue-197-test"),
      frozenBaseRoot: join(fixture.workspaceParent, "issue-197-test-base"),
    });
    await expect(fixture.host.reconcile(descriptor, operation())).resolves.toMatchObject({
      status: "applied",
      result: {
        kind: "workspace",
        workspaceIdentityDigest: fixture.localGit.workspace.workspaceIdentityDigest,
      },
    });
  });

  it("reconciles exact commit and push results without repeating either mutation", async () => {
    const fixture = await hostFixture();
    await fixture.localGit.prepareWorkspace(fixture.workspaceRequest);
    const commit = await fixture.host.describe(
      {
        kind: "commit",
        commandId: "11111111-1111-4111-8111-111111111111",
        workspaceIdentityDigest: fixture.localGit.workspace.workspaceIdentityDigest,
        parentCommit: BASE,
        candidateTreeDigest: calculateIssueCandidateTreeDigest(TREE),
        messageDigest: calculateIssueHostCommitMessageDigest(fixture.manifest),
      },
      fixture.manifest,
    );

    expect((await fixture.host.reconcile(commit, operation())).status).toBe("not_applied");
    await fixture.host.execute(commit, operation());
    await expect(fixture.host.reconcile(commit, operation())).resolves.toMatchObject({
      status: "applied",
      result: { kind: "commit", candidateHead: CANDIDATE },
    });

    const push = await fixture.host.describe(
      {
        kind: "push",
        commandId: "11111111-1111-4111-8111-111111111111",
        candidateHead: CANDIDATE,
        expectedRemoteHead: null,
      },
      fixture.manifest,
    );
    expect((await fixture.host.reconcile(push, operation())).status).toBe("not_applied");
    await fixture.host.execute(push, operation());
    await expect(fixture.host.reconcile(push, operation())).resolves.toMatchObject({
      status: "applied",
      result: { kind: "push", candidateHead: CANDIDATE },
    });
    expect(fixture.localGit.commitMutations).toBe(1);
    expect(fixture.localGit.pushMutations).toBe(1);
  });

  it("reconciles draft and ready publication with exact deterministic content digests", async () => {
    const fixture = await hostFixture();
    const draft = await fixture.host.describe(
      {
        kind: "pull_request",
        commandId: "11111111-1111-4111-8111-111111111111",
        candidateHead: CANDIDATE,
      },
      fixture.manifest,
    );

    expect((await fixture.host.reconcile(draft, operation())).status).toBe("not_applied");
    await fixture.host.execute(draft, operation());
    const observedDraft = await fixture.host.reconcile(draft, operation());
    expect(observedDraft).toMatchObject({
      status: "applied",
      result: { kind: "pull_request", pullRequestNodeId: "PR_fixture", isDraft: true },
    });
    expect(fixture.github.lastExpected?.pullRequest).toBeUndefined();
    expect(fixture.github.lastDraftInput?.effect).toMatchObject({
      titleDigest: fixture.github.lastDraftInput?.expectedTitleDigest,
      bodyDigest: fixture.github.lastDraftInput?.expectedBodyDigest,
    });

    const ready = await fixture.host.describe(
      {
        kind: "pull_request_ready",
        commandId: "11111111-1111-4111-8111-111111111111",
        candidateHead: CANDIDATE,
        pullRequestNumber: 198,
        pullRequestNodeId: "PR_fixture",
      },
      fixture.manifest,
    );
    expect((await fixture.host.reconcile(ready, operation())).status).toBe("not_applied");
    await fixture.host.execute(ready, operation());
    await expect(fixture.host.reconcile(ready, operation())).resolves.toMatchObject({
      status: "applied",
      result: { kind: "pull_request_ready", isDraft: false },
    });
    expect(fixture.github.lastExpected?.pullRequest).toMatchObject({
      nodeId: "PR_fixture",
      titleDigest: fixture.github.lastDraftInput?.expectedTitleDigest,
      bodyDigest: fixture.github.lastDraftInput?.expectedBodyDigest,
    });
  });

  it("observes the exact persisted pull request identity and stores content-free evidence", async () => {
    const fixture = await hostFixture();
    fixture.store.events = [pullRequestAppliedEvent()];
    fixture.github.pullRequest = { number: 198, nodeId: "PR_fixture", isDraft: false };

    const observation = await fixture.host.observe({
      runId: fixture.manifest.runId,
      manifest: fixture.manifest,
      pullRequestNumber: 198,
      candidateHead: CANDIDATE,
      ...operation(),
    });

    expect(observation.pullRequest).toMatchObject({ number: 198, nodeId: "PR_fixture" });
    expect(fixture.github.lastExpected?.pullRequest).toMatchObject({ nodeId: "PR_fixture" });
    expect(fixture.store.blobs.length).toBeGreaterThan(0);
    expect(
      Buffer.concat(fixture.store.blobs.map((blob) => Buffer.from(blob.bytes))).toString(),
    ).not.toContain("private issue body");
  });

  it.each(["merge", "squash", "rebase"] as const)(
    "constructs an exact %s merge proof from remote outcome and local topology",
    async (method) => {
      const fixture = await hostFixture(method);
      await fixture.localGit.prepareWorkspace(fixture.workspaceRequest);
      fixture.store.events = [pullRequestAppliedEvent()];
      fixture.github.pullRequest = { number: 198, nodeId: "PR_fixture", isDraft: false };
      fixture.github.merged = true;
      fixture.localGit.configureMerge(method);

      const proof = verifyIssueMergeProof(
        await fixture.host.proveMerge({
          runId: fixture.manifest.runId,
          manifest: fixture.manifest,
          pullRequestNumber: 198,
          pullRequestNodeId: "PR_fixture",
          candidateHead: CANDIDATE,
          gateDigest: "9".repeat(64),
          ...operation(),
        }),
      );

      expect(proof).toMatchObject({
        method,
        candidateHead: CANDIDATE,
        mergeCommit: MERGE,
        mergeCommitReachableFromObservedBase: true,
        branchDeleted: true,
        proof: { kind: method },
      });
      expect(
        fixture.store.blobs.some(
          (blob) => blob.mediaType === "application/vnd.synapti.flow.github-evidence.v1+json",
        ),
      ).toBe(true);
    },
  );

  it("rejects a squash outcome whose merge tree differs from the approved candidate", async () => {
    const fixture = await hostFixture("squash");
    await fixture.localGit.prepareWorkspace(fixture.workspaceRequest);
    fixture.store.events = [pullRequestAppliedEvent()];
    fixture.github.pullRequest = { number: 198, nodeId: "PR_fixture", isDraft: false };
    fixture.github.merged = true;
    fixture.localGit.configureMerge("squash");
    fixture.localGit.commits.set(MERGE, { commit: MERGE, tree: "f".repeat(40), parents: [BASE] });

    await expect(
      fixture.host.proveMerge({
        runId: fixture.manifest.runId,
        manifest: fixture.manifest,
        pullRequestNumber: 198,
        pullRequestNodeId: "PR_fixture",
        candidateHead: CANDIDATE,
        gateDigest: "9".repeat(64),
        ...operation(),
      }),
    ).rejects.toMatchObject({ code: "merge_proof_invalid" });
  });
});

async function hostFixture(method: "merge" | "squash" | "rebase" = "squash") {
  const root = await mkdtemp(join(tmpdir(), "flow-issue-host-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  const workspaceParent = join(root, "workspaces");
  await Promise.all([mkdir(sourceRoot), mkdir(workspaceParent)]);
  const openIssue = openIssueObservation();
  const issueBytes = encodeFrozenGitHubIssueSnapshot(openIssue, DIGEST);
  const manifest = frozenManifest(method, issueBytes);
  const store = new FakeStore(manifest, issueBytes);
  const localGit = new FakeLocalGit(sourceRoot, workspaceParent);
  const github = new FakeGitHub(openIssue, manifest);
  const host = new IssueLifecycleHost({
    store,
    localGit,
    github,
    sourceRoot,
    workspaceParent,
  });
  return {
    host,
    store,
    localGit,
    github,
    manifest,
    workspaceParent,
    workspaceRequest: localGit.workspaceRequest,
  };
}

class FakeStore {
  events: IssueLifecycleEvent[] = [];
  readonly blobs: Array<{ readonly mediaType: string; readonly bytes: Uint8Array }> = [];

  constructor(
    readonly manifest: FrozenIssueRunManifest,
    readonly issueBytes: Uint8Array,
  ) {}

  async readManifest() {
    return this.manifest;
  }

  async read() {
    return this.events;
  }

  async readBlob() {
    return { mediaType: this.manifest.artifacts.issue.mediaType, bytes: this.issueBytes };
  }

  async putBlob(_runId: string, input: { readonly mediaType: string; readonly bytes: Uint8Array }) {
    this.blobs.push({ mediaType: input.mediaType, bytes: Uint8Array.from(input.bytes) });
    return createIssuePrivateBlobReference(input);
  }
}

class FakeLocalGit {
  readonly workspace: IssueGitWorkspace;
  readonly workspaceRequest;
  readonly commits = new Map<string, IssueGitCommitObservation>([
    [BASE, { commit: BASE, tree: BASE_TREE, parents: [] }],
    [CANDIDATE, { commit: CANDIDATE, tree: TREE, parents: [BASE] }],
  ]);
  branchHead = BASE;
  remoteHead: string | null = null;
  prepared = false;
  commitMutations = 0;
  pushMutations = 0;
  patchDigest = "8".repeat(64);
  lastPrepareRequest: unknown;

  constructor(sourceRoot: string, workspaceParent: string) {
    const root = join(workspaceParent, "issue-197-test");
    const frozenBaseRoot = join(workspaceParent, "issue-197-test-base");
    this.workspace = {
      version: 1,
      ownershipId: "issue-197-test",
      sourceRoot,
      root,
      frozenBaseRoot,
      commonGitDirectory: join(sourceRoot, ".git"),
      gitDirectory: join(sourceRoot, ".git", "worktrees", "issue-197-test"),
      frozenBaseGitDirectory: join(sourceRoot, ".git", "worktrees", "issue-197-test-base"),
      repositoryIdentity: "example/project",
      originCanonicalUrl: "https://github.com/example/project",
      branch: "flow/issue-197-test",
      baseBranch: "main",
      baseCommit: BASE,
      workspaceIdentityDigest: "7".repeat(64),
    };
    this.workspaceRequest = {
      ownershipId: this.workspace.ownershipId,
      sourceRoot,
      workspaceRoot: root,
      frozenBaseRoot,
      repositoryIdentity: this.workspace.repositoryIdentity,
      baseBranch: this.workspace.baseBranch,
      baseCommit: this.workspace.baseCommit,
      branch: this.workspace.branch,
    };
  }

  async prepareWorkspace(_request?: unknown) {
    this.lastPrepareRequest = _request;
    await mkdir(this.workspace.root, { recursive: true });
    await mkdir(this.workspace.frozenBaseRoot, { recursive: true });
    this.prepared = true;
    return this.workspace;
  }

  async inspectCandidate() {
    return {
      branch: this.workspace.branch,
      head: this.branchHead,
      baseCommit: BASE,
      tree: TREE,
      changedPaths: ["src/feature.ts"],
      logicalBytes: 32,
      workspaceIdentityDigest: this.workspace.workspaceIdentityDigest,
    };
  }

  async commitCandidate() {
    this.commitMutations += 1;
    this.branchHead = CANDIDATE;
    return { candidateHead: CANDIDATE, tree: TREE, parent: BASE };
  }

  async pushCandidate() {
    this.pushMutations += 1;
    this.remoteHead = CANDIDATE;
    return { branch: this.workspace.branch, candidateHead: CANDIDATE };
  }

  async inspectCommit(request: { readonly commit: string }) {
    const commit = this.commits.get(request.commit);
    if (commit === undefined) throw new Error("missing commit");
    return commit;
  }

  async isAncestor(request: { readonly ancestor: string; readonly descendant: string }) {
    return (
      request.ancestor === request.descendant ||
      (request.ancestor === BASE && [CANDIDATE, MERGE].includes(request.descendant)) ||
      (request.ancestor === MERGE && request.descendant === MERGE)
    );
  }

  async inspectRemoteBranch(request: { readonly branch: string }) {
    return {
      branch: request.branch,
      head: request.branch === this.workspace.branch ? this.remoteHead : MERGE,
    };
  }

  async fetchRemoteBranch(request: { readonly branch: string; readonly expectedHead: string }) {
    return { branch: request.branch, head: request.expectedHead };
  }

  async inspectPatchSeries(request: { readonly baseCommit: string; readonly headCommit: string }) {
    return {
      firstParent: request.baseCommit,
      headCommit: request.headCommit,
      commitCount: 1,
      digest: this.patchDigest,
    } satisfies IssueGitPatchSeriesObservation;
  }

  async inspectFrozenBase() {
    return {
      head: BASE,
      tree: BASE_TREE,
      status: "clean" as const,
      workspaceIdentityDigest: this.workspace.workspaceIdentityDigest,
    };
  }

  async resetFrozenBase() {
    return await this.inspectFrozenBase();
  }

  async cleanupWorkspace() {}

  configureMerge(method: "merge" | "squash" | "rebase") {
    this.commits.set(MERGE, {
      commit: MERGE,
      tree: TREE,
      parents: method === "merge" ? [BASE, CANDIDATE] : [BASE],
    });
  }
}

class FakeGitHub {
  pullRequest: { number: number; nodeId: string; isDraft: boolean } | undefined;
  merged = false;
  lastExpected:
    | (FrozenGitHubIssueIdentity & {
        readonly pullRequest: {
          readonly number: number;
          readonly nodeId: string;
          readonly titleDigest: string;
          readonly bodyDigest: string;
        };
      })
    | undefined;
  lastDraftInput:
    | {
        readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
        readonly expectedTitleDigest: string;
        readonly expectedBodyDigest: string;
      }
    | undefined;

  constructor(
    readonly openIssue: GitHubOpenIssueObservation,
    readonly manifest: FrozenIssueRunManifest,
  ) {}

  async inspectOpenIssue() {
    return this.openIssue;
  }

  async observeDraftPullRequest(input: {
    readonly expected: FrozenGitHubIssueIdentity;
    readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
  }) {
    this.lastDraftInput = {
      effect: input.effect,
      expectedTitleDigest: input.effect.titleDigest,
      expectedBodyDigest: input.effect.bodyDigest,
    };
    return this.pullRequest === undefined ? null : this.draftResult(true);
  }

  async ensureDraftPullRequest(input: {
    readonly expected: FrozenGitHubIssueIdentity;
    readonly effect: Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }>;
  }) {
    this.lastDraftInput = {
      effect: input.effect,
      expectedTitleDigest: input.effect.titleDigest,
      expectedBodyDigest: input.effect.bodyDigest,
    };
    this.pullRequest = { number: 198, nodeId: "PR_fixture", isDraft: true };
    return this.draftResult(false);
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
    this.lastExpected = expected;
    return {
      observation: parseGitHubLifecycleObservation(
        githubObservation(expected, this.pullRequest?.isDraft ?? false),
      ),
      evidence: evidence(),
    };
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
  }) {
    this.lastExpected = input.expected;
    this.pullRequest = { number: 198, nodeId: "PR_fixture", isDraft: false };
    return { ...this.readyResult(), reconciled: false };
  }

  async mergeExactPullRequest() {
    this.merged = true;
    return { outcome: this.mergeOutcome(), evidence: evidence(), reconciled: false };
  }

  async observeMergeOutcome(input: {
    readonly expected: FrozenGitHubIssueIdentity & {
      readonly pullRequest: {
        readonly number: number;
        readonly nodeId: string;
        readonly titleDigest: string;
        readonly bodyDigest: string;
      };
    };
  }) {
    this.lastExpected = input.expected;
    return this.merged
      ? { outcome: this.mergeOutcome(), evidence: evidence(), reconciled: true }
      : null;
  }

  private draftResult(reconciled: boolean): GitHubExternalEffectResult<"pull_request"> {
    return {
      result: pullRequestResult("pull_request", true),
      evidence: evidence(),
      reconciled,
    };
  }

  private readyResult(): Omit<GitHubExternalEffectResult<"pull_request_ready">, "reconciled"> {
    return {
      result: pullRequestResult("pull_request_ready", false),
      evidence: evidence(),
    };
  }

  private mergeOutcome(): GitHubRemoteMergeOutcome {
    const content = renderIssueHostPullRequest(this.manifest);
    return {
      repositoryIdentity: this.manifest.repository.identity,
      repositoryNodeId: this.manifest.repository.nodeId,
      pullRequestNumber: 198,
      pullRequestNodeId: "PR_fixture",
      pullRequestTitleDigest: sha256(content.title),
      pullRequestBodyDigest: sha256(content.body),
      issueNumber: this.manifest.issue.number,
      issueNodeId: this.manifest.issue.nodeId,
      issueState: "closed",
      issueUpdatedAt: "2026-08-28T13:00:00.000Z",
      issueContentDigest: this.manifest.issue.contentDigest,
      candidateHead: CANDIDATE,
      baseBranch: this.manifest.base.branch,
      observedBaseCommit: MERGE,
      mergeCommit: MERGE,
      mergedAt: "2026-08-28T13:00:00.000Z",
      branchDeleted: true,
    };
  }
}

function pendingEffect(descriptor: IssueExternalEffectDescriptor): PendingIssueExternalEffect {
  const operationDigest = calculateIssueExternalEffectOperationDigest(descriptor);
  return {
    effectId: `commit-${operationDigest.slice(0, 24)}`,
    effectKind: descriptor.kind,
    operationDigest,
    preparedSequence: 4,
  };
}

function state(overrides: Partial<IssueLifecycleState> = {}): IssueLifecycleState {
  return {
    version: 1,
    runId: "issue-197-test",
    phase: "external_state_uncertain",
    sequence: 4,
    startedAt: "2026-08-28T11:00:00.000Z",
    lastEventAt: "2026-08-28T11:00:00.000Z",
    settledEffectCount: 1,
    receiptCount: 2,
    appliedEffects: [],
    implementationIteration: 1,
    frozenRepositoryIdentity: "example/project",
    frozenIssueNumber: 197,
    frozenIssueNodeId: "I_fixture",
    frozenIssueUpdatedAt: "2026-08-28T11:00:00.000Z",
    frozenIssueDigest: DIGEST,
    frozenBaseBranch: "main",
    frozenBaseCommit: BASE,
    frozenBranch: "flow/issue-197-test",
    recoveryPhase: "implementing",
    ...overrides,
  };
}

function operation() {
  return { pollCancellation: async () => {} };
}

function pullRequestAppliedEvent(): IssueLifecycleEvent {
  return {
    version: 1,
    runId: "issue-197-test",
    sequence: 8,
    at: "2026-08-28T12:00:00.000Z",
    type: "external_effect_settled",
    effectId: "pull-request-fixture",
    outcome: "applied",
    observationDigest: DIGEST,
    result: pullRequestResult("pull_request", true),
  };
}

function pullRequestResult(
  kind: "pull_request",
  isDraft: true,
): Extract<IssueExternalEffectResult, { readonly kind: "pull_request" }>;
function pullRequestResult(
  kind: "pull_request_ready",
  isDraft: false,
): Extract<IssueExternalEffectResult, { readonly kind: "pull_request_ready" }>;
function pullRequestResult(
  kind: "pull_request" | "pull_request_ready",
  isDraft: boolean,
): IssueExternalEffectResult {
  return {
    kind,
    repositoryIdentity: "example/project",
    candidateHead: CANDIDATE,
    headBranch: "flow/issue-197-test",
    baseBranch: "main",
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_fixture",
    isDraft,
  } as IssueExternalEffectResult;
}

function evidence(): GitHubIssueLifecycleEvidence {
  return {
    mediaType: "application/vnd.synapti.flow.github-evidence.v1+json",
    bytes: new TextEncoder().encode('{"kind":"normalized"}'),
  };
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

function openIssueObservation(): GitHubOpenIssueObservation {
  return {
    repository: {
      host: "github.com",
      owner: "example",
      name: "project",
      nodeId: "R_fixture",
      canonicalUrl: "https://github.com/example/project",
      defaultBranch: "main",
      configuredBase: { branch: "main", commit: BASE },
    },
    issue: {
      host: "github.com",
      owner: "example",
      name: "project",
      nodeId: "I_fixture",
      number: 197,
      state: "OPEN",
      title: "Private issue title",
      body: "private issue body",
      updatedAt: "2026-08-28T11:00:00.000Z",
      canonicalUrl: "https://github.com/example/project/issues/197",
    },
  };
}

function frozenManifest(
  method: "merge" | "squash" | "rebase",
  issueBytes: Uint8Array,
): FrozenIssueRunManifest {
  const budgets = {
    implementation: budget(1),
    review: budget(2),
    holdout: { timeoutMs: 120_000 },
    verification: [{ id: "test", timeoutMs: 300_000 }],
    controller: [{ id: "effect", timeoutMs: 300_000 }],
  };
  const blob = (mediaType: string, text: string) =>
    createIssuePrivateBlobReference({ mediaType, bytes: new TextEncoder().encode(text) });
  return parseIssuePrivateManifest({
    version: 1,
    runId: "issue-197-test",
    initialCommandId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-28T11:00:00.000Z",
    repository: {
      host: "github.com",
      identity: "example/project",
      nodeId: "R_fixture",
      canonicalUrl: "https://github.com/example/project",
    },
    issue: {
      number: 197,
      nodeId: "I_fixture",
      state: "open",
      updatedAt: "2026-08-28T11:00:00.000Z",
      canonicalUrl: "https://github.com/example/project/issues/197",
      contentDigest: DIGEST,
    },
    base: { branch: "main", commit: BASE, remoteRef: "refs/heads/main" },
    branch: { prefix: "flow/issue-", name: "flow/issue-197-test" },
    planDigest: "2".repeat(64),
    implementationWorkflow: {
      sourceDigest: "3".repeat(64),
      templateWorkflowDigest: "4".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
    },
    reviewWorkflow: {
      sourceDigest: "5".repeat(64),
      templateWorkflowDigest: "6".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
      resultNodeId: "review-result",
    },
    acceptanceCriteria: ["criterion-one"],
    allowedWritePrefixes: ["src/"],
    holdout: { commandDigest: "7".repeat(64), timeoutMs: 120_000 },
    verification: [{ id: "test", commandDigest: "8".repeat(64), timeoutMs: 300_000 }],
    hostedChecks: [{ name: "CI / test", sourceApp: { id: 15_368, slug: "github-actions" } }],
    merge: { method, deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: {
      issue: createIssuePrivateBlobReference({
        mediaType: "application/vnd.synapti.flow.github-issue-snapshot.v1+json",
        bytes: issueBytes,
      }),
      plan: blob("application/json", "{}"),
      implementationWorkflow: blob("application/yaml", "id: implementation\n"),
      reviewWorkflow: blob("application/yaml", "id: review\n"),
    },
  });
}

function budget(seed: number) {
  return {
    maxNodeStarts: seed * 10,
    maxModelTokens: seed * 1_000,
    maxCostUsdMicros: seed * 100_000,
    maxExecutionMs: seed * 60_000,
    maxArtifactBytes: seed * 1_024,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
