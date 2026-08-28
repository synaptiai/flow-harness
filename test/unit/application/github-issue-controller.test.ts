import { describe, expect, it } from "vitest";
import { cancelGitHubIssue } from "../../../src/application/cancel-github-issue.js";
import type {
  IssueControllerCommandRecord,
  IssueControllerCommandRecordInput,
  IssueControllerCommandSettlement,
  IssueControllerDependencies,
  IssueControllerRepository,
  IssueControllerRunInitialization,
  IssueExternalEffectPreparation,
} from "../../../src/application/github-issue-controller-ports.js";
import { mergeGitHubIssue } from "../../../src/application/merge-github-issue.js";
import { runGitHubIssue } from "../../../src/application/run-github-issue.js";
import type { IssueLifecycleCommand } from "../../../src/domain/issue-lifecycle/commands.js";
import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../../../src/domain/issue-lifecycle/commands.js";
import type {
  IssueExternalEffectResult,
  IssueLifecycleEvent,
} from "../../../src/domain/issue-lifecycle/events.js";
import type { IssueExternalEffectDescriptor } from "../../../src/domain/issue-lifecycle/external-effects.js";
import type { IssueMergeProof } from "../../../src/domain/issue-lifecycle/github-observation.js";
import {
  parseGitHubLifecycleObservation,
  verifyIssueMergeProof,
} from "../../../src/domain/issue-lifecycle/github-observation.js";
import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  type FrozenIssueRunManifest,
  parseIssuePrivateManifest,
} from "../../../src/domain/issue-lifecycle/private-manifest.js";

const sha = (character: string): string => character.repeat(64);
const commit = (character: string): string => character.repeat(40);
const at = "2026-08-28T12:00:00.000Z";
const issueRunId = "issue-11111111-1111-4111-8111-111111111111";

describe("foreground GitHub issue controller", () => {
  it("runs implementation, verification, review, and publication but stops before merge", async () => {
    const harness = scriptedHarness();
    const command = runCommand();

    const state = await runGitHubIssue(command, harness.dependencies);

    expect(state.phase).toBe("merge_approval_required");
    expect(state.mergeApproval).toMatchObject({ pullRequestNumber: 7, headCommit: commit("c") });
    expect(harness.executedEffects).toEqual([
      "workspace",
      "commit",
      "push",
      "pull_request",
      "pull_request_ready",
    ]);
    expect(harness.workflowRequests).toEqual([
      { kind: "implementation", runId: issueRunId, iteration: 1 },
      { kind: "review", runId: issueRunId, candidateHead: commit("c") },
    ]);
    expect(harness.repository.events.map((event) => event.type)).toContain(
      "external_effect_prepared",
    );
    expect(harness.repository.settlements.get(command.commandId)?.outcome).toBe("completed");
  });

  it("replays a settled run command without repeating workflows or effects", async () => {
    const harness = scriptedHarness();
    const command = runCommand();
    let freezeCalls = 0;
    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      freezer: {
        freeze: async (runCommand, operation) => {
          freezeCalls += 1;
          if (freezeCalls > 1) throw new Error("freezer must not run during replay");
          return await harness.dependencies.freezer.freeze(runCommand, operation);
        },
      },
    };
    const first = await runGitHubIssue(command, dependencies);
    const effectCount = harness.executedEffects.length;
    const workflowCount = harness.workflowRequests.length;

    const replay = await runGitHubIssue(command, dependencies);

    expect(replay).toEqual(first);
    expect(freezeCalls).toBe(1);
    expect(harness.executedEffects).toHaveLength(effectCount);
    expect(harness.workflowRequests).toHaveLength(workflowCount);
  });

  it("gives an unsettled replay the same terminal failure and settlement semantics", async () => {
    const harness = scriptedHarness();
    const command = runCommand();
    harness.repository.nextClaimError = new Error("simulated crash after initialization");
    await expect(runGitHubIssue(command, harness.dependencies)).rejects.toThrow(
      "simulated crash after initialization",
    );
    expect(harness.repository.settlements.has(command.commandId)).toBe(false);

    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      freezer: {
        freeze: async () => {
          throw new Error("freezer must not run during unsettled replay");
        },
      },
      workflows: {
        ...harness.dependencies.workflows,
        runImplementation: async () => {
          throw Object.assign(new Error("replayed workflow failed"), {
            code: "workflow_failed",
          });
        },
      },
    };

    await expect(runGitHubIssue(command, dependencies)).rejects.toThrow("replayed workflow failed");

    expect(harness.repository.events.at(-1)).toMatchObject({
      type: "run_failed",
      code: "controller_failed",
    });
    expect(harness.repository.settlements.get(command.commandId)).toMatchObject({
      outcome: "failed",
      code: "workflow_failed",
    });
    expect(harness.repository.releaseCount).toBe(1);
  });

  it("records and settles an explicit cancellation without invoking a merge", async () => {
    const harness = scriptedHarness();
    await runGitHubIssue(runCommand(), harness.dependencies);
    const command = parseIssueLifecycleCommand({
      version: 1,
      kind: "cancel",
      commandId: "44444444-4444-4444-8444-444444444444",
      runId: issueRunId,
      actor: "operator@example.test",
      reason: "Stop this run.",
    });

    const result = await cancelGitHubIssue(command, harness.dependencies);

    expect(result.status).toBe("cancelled");
    expect(harness.repository.settlements.get(command.commandId)?.outcome).toBe("completed");
    expect(harness.executedEffects).not.toContain("merge");

    const replay = await cancelGitHubIssue(command, harness.dependencies);
    expect(replay).toEqual(result);
  });

  it("consumes and settles only the oldest pending cancellation", async () => {
    const harness = scriptedHarness();
    const oldest = parseIssueLifecycleCommand({
      version: 1,
      kind: "cancel",
      commandId: "55555555-5555-4555-8555-555555555555",
      runId: issueRunId,
      actor: "first-operator",
    });
    const later = parseIssueLifecycleCommand({
      version: 1,
      kind: "cancel",
      commandId: "66666666-6666-4666-8666-666666666666",
      runId: issueRunId,
      actor: "second-operator",
    });
    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      workflows: {
        ...harness.dependencies.workflows,
        runImplementation: async (request) => {
          await harness.repository.recordCommand({
            runId: request.runId,
            recordedAt: "2026-08-28T12:00:01.000Z",
            command: oldest,
          });
          await harness.repository.recordCommand({
            runId: request.runId,
            recordedAt: "2026-08-28T12:00:02.000Z",
            command: later,
          });
          await request.pollCancellation();
          throw new Error("cancellation polling must not return");
        },
      },
    };

    const state = await runGitHubIssue(runCommand(), dependencies);

    expect(state.phase).toBe("cancelled");
    expect(harness.repository.settlements.get(oldest.commandId)?.outcome).toBe("completed");
    expect(harness.repository.settlements.has(later.commandId)).toBe(false);
  });

  it("records a content-free terminal failure and always releases ownership", async () => {
    const harness = scriptedHarness();
    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      verification: {
        verify: async () => {
          throw Object.assign(new Error("sensitive diagnostic detail"), {
            code: "verification_failed",
          });
        },
      },
    };

    await expect(runGitHubIssue(runCommand(), dependencies)).rejects.toThrow(
      "sensitive diagnostic detail",
    );

    expect(harness.repository.events.at(-1)).toMatchObject({
      type: "run_failed",
      code: "controller_failed",
    });
    expect(JSON.stringify(harness.repository.events)).not.toContain("sensitive diagnostic detail");
    expect(harness.repository.settlements.get(runCommand().commandId)).toMatchObject({
      outcome: "failed",
      code: "verification_failed",
    });
    expect(harness.repository.releaseCount).toBe(1);
  });

  it("stops on blocked review without autonomously starting another implementation", async () => {
    const harness = scriptedHarness();
    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      workflows: {
        ...harness.dependencies.workflows,
        runReview: async (request) => ({
          parentIssueRunId: request.runId,
          candidateHead: request.candidateHead,
          flowRunId: "blocked-review",
          templateWorkflowDigest: request.manifest.reviewWorkflow.templateWorkflowDigest,
          executionWorkflowDigest: sha("8"),
          terminalSequence: 4,
          evidenceDigest: sha("1"),
          resultNodeId: request.manifest.reviewWorkflow.resultNodeId,
          resultTextTruncated: false,
          resultText: JSON.stringify({
            version: 1,
            candidateHead: request.candidateHead,
            issueDigest: request.manifest.issue.contentDigest,
            reviewWorkflowDigest: sha("8"),
            acceptanceMapping: [
              {
                criterionId: "criterion-one",
                status: "unsatisfied",
                evidence: "Criterion is not satisfied.",
              },
            ],
            findings: [],
            verdict: "blocked",
          }),
        }),
      },
    };

    const state = await runGitHubIssue(runCommand(), dependencies);

    expect(state).toMatchObject({ phase: "failed", terminal: { code: "review_blocked" } });
    expect(
      harness.workflowRequests.filter((request) => request.kind === "implementation"),
    ).toHaveLength(1);
    expect(harness.repository.settlements.get(runCommand().commandId)).toMatchObject({
      outcome: "failed",
      code: "review_blocked",
    });
  });

  it("keeps a malbound applied effect observation out of durable applied history", async () => {
    const harness = scriptedHarness();
    const dependencies: IssueControllerDependencies = {
      ...harness.dependencies,
      effects: {
        ...harness.dependencies.effects,
        reconcile: async (descriptor, operation) => {
          const observed = await harness.dependencies.effects.reconcile(descriptor, operation);
          if (observed.status !== "applied" || observed.result.kind !== "push") return observed;
          return {
            ...observed,
            result: { ...observed.result, candidateHead: commit("d") },
          };
        },
      },
    };

    await expect(runGitHubIssue(runCommand(), dependencies)).rejects.toThrow(
      "no recovery expected",
    );

    expect(
      harness.repository.events.some(
        (event) =>
          event.type === "external_state_uncertain" && event.code === "effect_observation_invalid",
      ),
    ).toBe(true);
    expect(
      harness.repository.events.some(
        (event) =>
          event.type === "external_effect_settled" &&
          event.outcome === "applied" &&
          event.result.kind === "push",
      ),
    ).toBe(false);
  });

  it("requires a fresh exact gate command and proves the resulting merge", async () => {
    const harness = scriptedHarness();
    const waiting = await runGitHubIssue(runCommand(), harness.dependencies);
    if (waiting.mergeApproval === undefined) throw new Error("expected merge approval checkpoint");
    const command = parseIssueLifecycleCommand({
      version: 1,
      kind: "merge",
      commandId: "22222222-2222-4222-8222-222222222222",
      runId: issueRunId,
      actor: "operator@example.test",
      expectedPullRequest: waiting.mergeApproval.pullRequestNumber,
      expectedHead: waiting.mergeApproval.headCommit,
      expectedGateDigest: waiting.mergeApproval.gateDigest,
    }) as Extract<IssueLifecycleCommand, { readonly kind: "merge" }>;

    const merged = await mergeGitHubIssue(command, harness.dependencies);

    expect(merged.phase).toBe("merged");
    expect(harness.executedEffects.at(-1)).toBe("merge");
    expect(harness.mergeProofRequests).toHaveLength(1);
    expect(harness.repository.settlements.get(command.commandId)?.outcome).toBe("completed");
  });

  it("invalidates approval instead of merging when fresh GitHub evidence changes", async () => {
    const harness = scriptedHarness();
    const waiting = await runGitHubIssue(runCommand(), harness.dependencies);
    if (waiting.mergeApproval === undefined) throw new Error("expected merge approval checkpoint");
    harness.observationRevision = 2;
    const command = parseIssueLifecycleCommand({
      version: 1,
      kind: "merge",
      commandId: "33333333-3333-4333-8333-333333333333",
      runId: issueRunId,
      actor: "operator@example.test",
      expectedPullRequest: waiting.mergeApproval.pullRequestNumber,
      expectedHead: waiting.mergeApproval.headCommit,
      expectedGateDigest: waiting.mergeApproval.gateDigest,
    }) as Extract<IssueLifecycleCommand, { readonly kind: "merge" }>;

    const state = await mergeGitHubIssue(command, harness.dependencies);

    expect(state.phase).toBe("merge_approval_required");
    expect(state.mergeApproval?.gateDigest).not.toBe(command.expectedGateDigest);
    expect(harness.executedEffects).not.toContain("merge");
    expect(harness.workflowRequests.filter((request) => request.kind === "review")).toHaveLength(2);
    expect(harness.repository.settlements.get(command.commandId)).toMatchObject({
      outcome: "rejected",
      code: "gate_invalidated",
    });
  });
});

function scriptedHarness() {
  const manifest = frozenManifest();
  const repository = new MemoryIssueControllerRepository();
  const applied = new Map<string, IssueExternalEffectResult>();
  const executedEffects: string[] = [];
  const workflowRequests: Array<Record<string, unknown>> = [];
  const mergeProofRequests: unknown[] = [];
  const reviewResults = new Map<string, unknown>();
  let observationRevision = 1;
  let clockTick = 0;

  const dependencies: IssueControllerDependencies = {
    repository,
    freezer: {
      freeze: async () => ({ manifest, initialBlobs: [], evidenceDigest: sha("9") }),
    },
    workflows: {
      runImplementation: async (request) => {
        workflowRequests.push({
          kind: "implementation",
          runId: request.runId,
          iteration: request.iteration,
        });
        return {
          parentIssueRunId: request.runId,
          iteration: request.iteration,
          flowRunId: `implementation-${request.iteration}`,
          templateWorkflowDigest: manifest.implementationWorkflow.templateWorkflowDigest,
          executionWorkflowDigest: sha("4"),
          terminalSequence: 8,
          evidenceDigest: sha("5"),
          workspaceIdentityDigest: request.workspaceIdentityDigest,
          candidateTreeDigest: sha("6"),
          commitMessageDigest: sha("7"),
        };
      },
      runReview: async (request) => {
        workflowRequests.push({
          kind: "review",
          runId: request.runId,
          candidateHead: request.candidateHead,
        });
        const result = {
          parentIssueRunId: request.runId,
          candidateHead: request.candidateHead,
          flowRunId: `review-${workflowRequests.length}`,
          templateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
          executionWorkflowDigest: sha("8"),
          terminalSequence: 4,
          evidenceDigest: sha("1"),
          resultNodeId: manifest.reviewWorkflow.resultNodeId,
          resultTextTruncated: false,
          resultText: JSON.stringify({
            version: 1,
            candidateHead: request.candidateHead,
            issueDigest: manifest.issue.contentDigest,
            reviewWorkflowDigest: sha("8"),
            acceptanceMapping: [
              { criterionId: "criterion-one", status: "satisfied", evidence: "Verified." },
            ],
            findings: [],
            verdict: "clear",
          }),
        };
        reviewResults.set(result.flowRunId, result);
        return result;
      },
      readReviewResult: async (request) => reviewResults.get(request.flowRunId),
    },
    verification: {
      verify: async (request) => verification(request.candidateHead),
    },
    github: {
      observe: async (request) =>
        parseGitHubLifecycleObservation(observation(request.candidateHead, observationRevision)),
      proveMerge: async (request) => {
        mergeProofRequests.push(request);
        return mergeProof(request.gateDigest);
      },
    },
    effects: {
      describe: async (request) => describeEffect(request, manifest),
      recover: async () => {
        throw new Error("no recovery expected");
      },
      reconcile: async (descriptor) => {
        const result = applied.get(descriptor.kind);
        return result === undefined
          ? { status: "not_applied" as const, observationDigest: sha("2") }
          : { status: "applied" as const, observationDigest: sha("3"), result };
      },
      execute: async (descriptor) => {
        executedEffects.push(descriptor.kind);
        applied.set(descriptor.kind, effectResult(descriptor));
      },
    },
    now: () => new Date(Date.parse(at) + ++clockTick),
  };

  return {
    dependencies,
    repository,
    executedEffects,
    workflowRequests,
    mergeProofRequests,
    get observationRevision() {
      return observationRevision;
    },
    set observationRevision(value: number) {
      observationRevision = value;
    },
  };
}

class MemoryIssueControllerRepository implements IssueControllerRepository {
  readonly events: IssueLifecycleEvent[] = [];
  readonly settlements = new Map<string, IssueControllerCommandSettlement>();
  manifest?: FrozenIssueRunManifest;
  readonly commands = new Map<string, IssueControllerCommandRecord>();
  releaseCount = 0;
  nextClaimError?: Error;

  async initialize(input: IssueControllerRunInitialization): Promise<void> {
    if (this.manifest !== undefined)
      throw Object.assign(new Error("run exists"), { code: "run_exists" });
    this.manifest = input.manifest;
    this.events.push(input.snapshot);
    await this.recordCommand(input.command);
  }
  async append(event: IssueLifecycleEvent): Promise<void> {
    this.events.push(event);
  }
  async claim(): Promise<readonly IssueLifecycleEvent[]> {
    if (this.nextClaimError !== undefined) {
      const error = this.nextClaimError;
      this.nextClaimError = undefined;
      throw error;
    }
    return this.events;
  }
  async release(): Promise<void> {
    this.releaseCount += 1;
  }
  async exists(): Promise<boolean> {
    return this.manifest !== undefined;
  }
  async read(): Promise<readonly IssueLifecycleEvent[]> {
    return this.events;
  }
  async readManifest(): Promise<FrozenIssueRunManifest> {
    if (this.manifest === undefined) throw new Error("missing manifest");
    return this.manifest;
  }
  async recordCommand(
    input: IssueControllerCommandRecordInput,
  ): Promise<IssueControllerCommandRecord> {
    const command = parseIssueLifecycleCommand(input.command);
    const prior = this.commands.get(command.commandId);
    if (prior !== undefined) return prior;
    const record: IssueControllerCommandRecord = {
      version: 1 as const,
      runId: input.runId,
      recordedAt: input.recordedAt,
      commandDigest: calculateIssueLifecycleCommandDigest(command),
      command,
    };
    this.commands.set(command.commandId, record);
    return record;
  }
  async readCommand(_runId: string, commandId: string): Promise<IssueControllerCommandRecord> {
    const record = this.commands.get(commandId);
    if (record === undefined) throw new Error("missing command");
    return record;
  }
  async settleCommand(
    _runId: string,
    commandId: string,
    settlement: IssueControllerCommandSettlement,
  ): Promise<IssueControllerCommandRecord> {
    const record = await this.readCommand(_runId, commandId);
    const settled = { ...record, settlement };
    this.commands.set(commandId, settled);
    this.settlements.set(commandId, settlement);
    return settled;
  }
  async readPendingCancellation(): Promise<IssueControllerCommandRecord | undefined> {
    return [...this.commands.values()]
      .filter((record) => record.command.kind === "cancel" && record.settlement === undefined)
      .sort((left, right) =>
        left.recordedAt === right.recordedAt
          ? left.command.commandId.localeCompare(right.command.commandId)
          : left.recordedAt.localeCompare(right.recordedAt),
      )[0];
  }
}

function describeEffect(
  request: IssueExternalEffectPreparation,
  manifest: FrozenIssueRunManifest,
): IssueExternalEffectDescriptor {
  const common = {
    version: 1 as const,
    runId: manifest.runId,
    commandId: request.commandId,
    repositoryIdentity: manifest.repository.identity,
    frozenContractDigest: calculateIssuePrivateManifestDigest(manifest),
  };
  switch (request.kind) {
    case "workspace":
      return {
        ...common,
        kind: "workspace",
        baseBranch: manifest.base.branch,
        baseCommit: manifest.base.commit,
        branch: manifest.branch.name,
        workspacePathDigest: sha("1"),
      } as IssueExternalEffectDescriptor;
    case "commit":
      return {
        ...common,
        kind: "commit",
        branch: manifest.branch.name,
        workspaceIdentityDigest: request.workspaceIdentityDigest,
        parentCommit: request.parentCommit,
        candidateTreeDigest: request.candidateTreeDigest,
        messageDigest: request.messageDigest,
      } as IssueExternalEffectDescriptor;
    case "push":
      return {
        ...common,
        kind: "push",
        branch: manifest.branch.name,
        candidateHead: request.candidateHead,
        expectedRemoteHead: request.expectedRemoteHead,
      } as IssueExternalEffectDescriptor;
    case "pull_request":
      return {
        ...common,
        kind: "pull_request",
        issueNumber: manifest.issue.number,
        issueNodeId: manifest.issue.nodeId,
        headBranch: manifest.branch.name,
        headCommit: request.candidateHead,
        baseBranch: manifest.base.branch,
        baseCommit: manifest.base.commit,
        titleDigest: sha("2"),
        bodyDigest: sha("3"),
        isDraft: true,
      } as IssueExternalEffectDescriptor;
    case "pull_request_ready":
      return {
        ...common,
        kind: "pull_request_ready",
        pullRequestNumber: 7,
        pullRequestNodeId: "PR_seven",
        headBranch: manifest.branch.name,
        headCommit: request.candidateHead,
        baseBranch: manifest.base.branch,
        baseCommit: manifest.base.commit,
        isDraft: false,
      } as IssueExternalEffectDescriptor;
    case "merge":
      return {
        ...common,
        kind: "merge",
        pullRequestNumber: 7,
        pullRequestNodeId: "PR_seven",
        candidateHead: request.candidateHead,
        baseBranch: manifest.base.branch,
        baseCommit: manifest.base.commit,
        gateDigest: request.gateDigest,
        method: manifest.merge.method,
        deleteBranch: manifest.merge.deleteBranch,
      } as IssueExternalEffectDescriptor;
  }
}

function effectResult(descriptor: IssueExternalEffectDescriptor): IssueExternalEffectResult {
  switch (descriptor.kind) {
    case "workspace":
      return { kind: descriptor.kind, workspaceIdentityDigest: sha("9") };
    case "commit":
      return { kind: descriptor.kind, candidateHead: commit("c") };
    case "push":
      return { kind: descriptor.kind, candidateHead: commit("c"), branch: "codex/issue-4" };
    case "pull_request":
      return pullRequestResult(descriptor.kind, true);
    case "pull_request_ready":
      return pullRequestResult(descriptor.kind, false);
    case "merge":
      return {
        kind: descriptor.kind,
        candidateHead: commit("c"),
        gateDigest: descriptor.gateDigest,
        mergeCommit: commit("d"),
        deleteBranchRequested: true,
        branchDeleted: true,
      } as IssueExternalEffectResult;
  }
}

function pullRequestResult(kind: "pull_request" | "pull_request_ready", isDraft: boolean) {
  return {
    kind,
    repositoryIdentity: "owner/repo",
    candidateHead: commit("c"),
    headBranch: "codex/issue-4",
    baseBranch: "main",
    pullRequestNumber: 7,
    pullRequestNodeId: "PR_seven",
    isDraft,
  } as IssueExternalEffectResult;
}

function runCommand(): Extract<IssueLifecycleCommand, { readonly kind: "run" }> {
  return parseIssueLifecycleCommand({
    version: 1,
    kind: "run",
    commandId: "11111111-1111-4111-8111-111111111111",
    issueUrl: "https://github.com/owner/repo/issues/4",
    repositoryIdentity: "owner/repo",
    planDigest: sha("c"),
    provider: "openai",
    model: "gpt-5",
  }) as Extract<IssueLifecycleCommand, { readonly kind: "run" }>;
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

function observation(candidateHead: string, revision: number) {
  const comments =
    revision === 1
      ? []
      : [
          {
            nodeId: "C_one",
            authorDigest: sha("a"),
            bodyDigest: sha("b"),
            createdAt: at,
            updatedAt: at,
          },
        ];
  return {
    version: 1 as const,
    repositoryIdentity: "owner/repo",
    repositoryNodeId: "R_repo",
    observedAt: at,
    issue: {
      number: 4,
      nodeId: "I_issue",
      state: "open" as const,
      updatedAt: at,
      contentDigest: sha("b"),
    },
    base: { branch: "main", commit: commit("a") },
    pullRequest: {
      number: 7,
      nodeId: "PR_seven",
      state: "open" as const,
      isDraft: false,
      headBranch: "codex/issue-4",
      headCommit: candidateHead,
      baseBranch: "main",
      baseCommit: commit("a"),
      mergeability: "mergeable" as const,
    },
    checks: {
      totalCount: 1,
      nodes: [
        {
          runId: 77,
          name: "test",
          sourceApp: { id: 1, slug: "github-actions" },
          status: "completed" as const,
          conclusion: "success" as const,
          headCommit: candidateHead,
          startedAt: at,
          completedAt: at,
        },
      ],
      pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 1 }],
    },
    conversations: {
      comments: {
        totalCount: comments.length,
        nodes: comments,
        pages: [
          { requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: comments.length },
        ],
      },
      reviews: emptyCollection(),
      threads: emptyCollection(),
    },
  };
}

function mergeProof(gateDigest: string): IssueMergeProof {
  return verifyIssueMergeProof({
    version: 1,
    repositoryIdentity: "owner/repo",
    pullRequestNumber: 7,
    pullRequestNodeId: "PR_seven",
    gateDigest,
    frozenBaseCommit: commit("a"),
    candidateHead: commit("c"),
    mergeCommit: commit("d"),
    observedBaseCommit: commit("d"),
    mergeCommitReachableFromObservedBase: true,
    evidenceDigest: sha("8"),
    method: "squash",
    proof: {
      kind: "squash",
      parent: commit("a"),
      candidateTree: commit("e"),
      mergeCommitTree: commit("e"),
    },
    deleteBranchRequested: true,
    branchDeleted: true,
  });
}

function emptyCollection() {
  return {
    totalCount: 0,
    nodes: [],
    pages: [{ requestCursor: null, endCursor: null, hasNextPage: false, nodeCount: 0 }],
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
    runId: issueRunId,
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
    acceptanceCriteria: ["criterion-one"],
    allowedWritePrefixes: ["src"],
    holdout: { commandDigest: sha("2"), timeoutMs: 1_000 },
    verification: [{ id: "quality", commandDigest: sha("3"), timeoutMs: 2_000 }],
    hostedChecks: [{ name: "test", sourceApp: { id: 1, slug: "github-actions" } }],
    merge: { method: "squash", deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: { issue: blob, plan: blob, implementationWorkflow: blob, reviewWorkflow: blob },
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
