import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IssueExternalEffectDescriptor } from "../../../../src/domain/issue-lifecycle/external-effects.js";
import { parseIssueExternalEffectDescriptor } from "../../../../src/domain/issue-lifecycle/external-effects.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { GitHubCliIssueLifecycleAdapter } from "../../../../src/infrastructure/github/github-cli-issue-lifecycle-adapter.js";

const temporaryDirectories: string[] = [];
const A = "a".repeat(40);
const B = "b".repeat(40);
const D = "d".repeat(40);
const DIGEST = "1".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("GitHub CLI issue lifecycle adapter", () => {
  it("implements admission over the same pinned strict GitHub transport", async () => {
    const fixture = await fakeGh([ok(), ok(admissionResponse())]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.inspectOpenIssue({
      repository: { host: "github.com", owner: "example", name: "project" },
      number: 197,
      baseBranch: "main",
    });

    expect(result).toMatchObject({
      repository: { nodeId: "R_fixture", configuredBase: { branch: "main", commit: A } },
      issue: { nodeId: "I_fixture", state: "OPEN" },
    });
    expect((await requests(fixture)).map((request) => request.arguments)).toEqual([
      ["auth", "status", "--active", "--hostname", "github.com"],
      graphqlArguments(),
    ]);
  });

  it("rejects invalid admission identity before invoking GitHub", async () => {
    const fixture = await fakeGh([ok()]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.inspectOpenIssue({
        repository: { host: "github.com", owner: "owner;rm", name: "project" },
        number: 197,
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "repository_identity_invalid" });
    expect(await readOptional(fixture.requestLog)).toBe("");
  });

  it("classifies changed pinned GitHub executable as unavailable", async () => {
    const fixture = await fakeGh([ok()]);
    const adapter = lifecycleAdapter(fixture);
    await writeFile(fixture.executable.path, `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");

    await expect(
      adapter.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("observes exact identities and complete empty collections without retaining raw prose", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok({ total_count: 0, check_runs: [] }),
      ok(connectionResponse("comments", [])),
      ok(connectionResponse("reviews", [])),
      ok(connectionResponse("reviewThreads", [])),
      ok(coreResponse()),
    ]);
    const adapter = new GitHubCliIssueLifecycleAdapter({
      ghExecutable: fixture.executable,
      cwd: fixture.root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });

    const result = await adapter.observeLifecycle({
      ...expected(),
      pullRequest: exactPullRequest(),
    });

    expect(result.observation).toMatchObject({
      repositoryIdentity: "example/project",
      repositoryNodeId: "R_fixture",
      issue: { number: 197, nodeId: "I_fixture", contentDigest: DIGEST },
      base: { branch: "main", commit: A },
      pullRequest: {
        number: 198,
        nodeId: "PR_fixture",
        headCommit: B,
        mergeability: "mergeable",
      },
    });
    const evidence = Buffer.from(result.evidence.bytes).toString("utf8");
    expect(evidence).not.toContain("private issue body");
    expect(evidence).not.toContain("private review body");
    expect(evidence).not.toContain("github_pat_");
    expect((await requests(fixture)).map((request) => request.arguments)).toEqual([
      ["auth", "status", "--active", "--hostname", "github.com"],
      graphqlArguments(),
      restArguments(`/repos/example/project/commits/${B}/check-runs?per_page=100&page=1`),
      graphqlArguments(),
      graphqlArguments(),
      graphqlArguments(),
      graphqlArguments(),
    ]);
  });

  it("follows every bounded page and rejects a repeated GraphQL cursor", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok({ total_count: 0, check_runs: [] }),
      ok(connectionResponse("comments", [], 0, true, "same")),
      ok(connectionResponse("comments", [], 0, true, "same")),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.observeLifecycle({
        ...expected(),
        pullRequest: exactPullRequest(),
      }),
    ).rejects.toMatchObject({ code: "pagination_cursor_loop" });
  });

  it("rejects head drift detected by the final exact-state observation", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok({ total_count: 0, check_runs: [] }),
      ok(connectionResponse("comments", [])),
      ok(connectionResponse("reviews", [])),
      ok(connectionResponse("reviewThreads", [])),
      ok(coreResponse({ headRefOid: "f".repeat(40) })),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.observeLifecycle({ ...expected(), pullRequest: exactPullRequest() }),
    ).rejects.toMatchObject({ code: "pull_request_collision" });
  });

  it("rejects required check names emitted by an unexpected GitHub App", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok({
        total_count: 1,
        check_runs: [checkRun({ app: { id: 999, slug: "attacker-app" } })],
      }),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.observeLifecycle({
        ...expected(),
        pullRequest: exactPullRequest(),
      }),
    ).rejects.toMatchObject({ code: "hosted_check_identity_collision" });
  });

  it("accepts documented extra REST fields while retaining only normalized check identity", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok({
        total_count: 1,
        check_runs: [
          checkRun({
            node_id: "CR_fixture",
            details_url: "https://github.com/example/project/actions/runs/1001",
            output: { title: "private check output", summary: "private summary" },
            app: {
              id: 15_368,
              slug: "github-actions",
              name: "GitHub Actions",
              owner: { login: "github" },
            },
          }),
        ],
      }),
      ok(connectionResponse("comments", [])),
      ok(connectionResponse("reviews", [])),
      ok(connectionResponse("reviewThreads", [])),
      ok(coreResponse()),
    ]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.observeLifecycle({
      ...expected(),
      pullRequest: exactPullRequest(),
    });

    expect(result.observation.checks.nodes).toEqual([
      expect.objectContaining({ runId: 1001, sourceApp: { id: 15_368, slug: "github-actions" } }),
    ]);
    expect(Buffer.from(result.evidence.bytes).toString("utf8")).not.toContain(
      "private check output",
    );
  });

  it("reconciles one exact draft pull request without creating another", async () => {
    const fixture = await fakeGh([ok(), ok(pullRequestSearchResponse([pullRequest()]))]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.ensureDraftPullRequest({
      expected: expected(),
      effect: draftEffect(),
      title: "Implement #197",
      body: "Closes #197",
    });

    expect(result).toMatchObject({
      reconciled: true,
      result: { kind: "pull_request", pullRequestNumber: 198, isDraft: true },
    });
    expect(await requests(fixture)).toHaveLength(2);
  });

  it("observes an absent draft intent without creating a pull request", async () => {
    const fixture = await fakeGh([ok(), ok(pullRequestSearchResponse([]))]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.observeDraftPullRequest({
      expected: expected(),
      effect: draftEffect(),
      title: "Implement #197",
      body: "Closes #197",
    });

    expect(result).toBeNull();
    expect(await requests(fixture)).toHaveLength(2);
  });

  it("observes one exact draft intent without mutating GitHub", async () => {
    const fixture = await fakeGh([ok(), ok(pullRequestSearchResponse([pullRequest()]))]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.observeDraftPullRequest({
      expected: expected(),
      effect: draftEffect(),
      title: "Implement #197",
      body: "Closes #197",
    });

    expect(result).toMatchObject({
      reconciled: true,
      result: { kind: "pull_request", pullRequestNodeId: "PR_fixture", isDraft: true },
    });
    expect(await requests(fixture)).toHaveLength(2);
  });

  it("creates one draft pull request through a fixed GraphQL mutation and proves it", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(pullRequestSearchResponse([])),
      ok(createPullRequestResponse()),
      ok(pullRequestSearchResponse([pullRequest()])),
    ]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.ensureDraftPullRequest({
      expected: expected(),
      effect: draftEffect(),
      title: "Implement #197",
      body: "Closes #197",
    });

    expect(result.reconciled).toBe(false);
    expect(result.result.pullRequestNodeId).toBe("PR_fixture");
    const recorded = await requests(fixture);
    expect(recorded).toHaveLength(4);
    expect(
      recorded.every((request) => !request.arguments.join(" ").includes("Implement #197")),
    ).toBe(true);
    expect(recorded[2]?.stdin).toContain("Implement #197");
  });

  it("classifies a lost draft-creation proof read as externally uncertain", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(pullRequestSearchResponse([])),
      ok(createPullRequestResponse()),
      { exitCode: 1, stderr: "private post-create error" },
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.ensureDraftPullRequest({
        expected: expected(),
        effect: draftEffect(),
        title: "Implement #197",
        body: "Closes #197",
      }),
    ).rejects.toMatchObject({ code: "external_state_uncertain" });
  });

  it("rejects multiple pull requests for the Flow branch without mutation", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(
        pullRequestSearchResponse([
          pullRequest(),
          { ...pullRequest(), id: "PR_other", number: 199 },
        ]),
      ),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.ensureDraftPullRequest({
        expected: expected(),
        effect: draftEffect(),
        title: "Implement #197",
        body: "Closes #197",
      }),
    ).rejects.toMatchObject({ code: "pull_request_ambiguous" });
    expect(await requests(fixture)).toHaveLength(2);
  });

  it("rejects a changed frozen issue before draft creation", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(pullRequestSearchResponse([], { issue: { ...issueIdentity(), title: "changed" } })),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.ensureDraftPullRequest({
        expected: expected(),
        effect: draftEffect(),
        title: "Implement #197",
        body: "Closes #197",
      }),
    ).rejects.toMatchObject({ code: "issue_changed" });
    expect(await requests(fixture)).toHaveLength(2);
  });

  it("marks only the exact draft ready and verifies its current head afterward", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok(markReadyResponse()),
      ok(coreResponse({ isDraft: false })),
    ]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.ensurePullRequestReady({
      expected: {
        ...expected(),
        pullRequest: exactPullRequest(),
      },
      effect: readyEffect(),
    });

    expect(result).toMatchObject({
      reconciled: false,
      result: { kind: "pull_request_ready", isDraft: false, candidateHead: B },
    });
  });

  it("classifies a lost readiness proof read as externally uncertain", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse()),
      ok(markReadyResponse()),
      { exitCode: 1, stderr: "private post-ready error" },
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.ensurePullRequestReady({
        expected: { ...expected(), pullRequest: exactPullRequest() },
        effect: readyEffect(),
      }),
    ).rejects.toMatchObject({ code: "external_state_uncertain" });
  });

  it("rejects pull request closing-instruction drift before merge mutation", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse({ isDraft: false, body: "Changed body" })),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.mergeExactPullRequest({
        expected: { ...expected(), pullRequest: exactPullRequest() },
        effect: mergeEffect(),
      }),
    ).rejects.toMatchObject({ code: "pull_request_collision" });
    expect((await requests(fixture)).some((request) => request.arguments[0] === "pr")).toBe(false);
  });

  it("uses exact-head ordinary merge arguments and returns normalized merged state", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse({ isDraft: false })),
      ok([]),
      ok(),
      ok(
        coreResponse({
          state: "MERGED",
          isDraft: false,
          merged: true,
          mergedAt: "2026-08-28T12:01:00.000Z",
          mergeCommit: { oid: D },
          baseRefOid: D,
          issueState: "CLOSED",
          branchRef: { name: "flow/issue-197-fixture", target: { oid: B } },
        }),
      ),
      ok(),
      ok(
        coreResponse({
          state: "MERGED",
          isDraft: false,
          merged: true,
          mergedAt: "2026-08-28T12:01:00.000Z",
          mergeCommit: { oid: D },
          baseRefOid: D,
          issueState: "CLOSED",
          branchRef: null,
        }),
      ),
    ]);
    const adapter = lifecycleAdapter(fixture);

    const result = await adapter.mergeExactPullRequest({
      expected: {
        ...expected(),
        pullRequest: exactPullRequest(),
      },
      effect: mergeEffect(),
    });

    expect(result).toMatchObject({
      reconciled: false,
      outcome: { mergeCommit: D, observedBaseCommit: D, branchDeleted: true },
    });
    expect((await requests(fixture))[3]?.arguments).toEqual([
      "pr",
      "merge",
      "198",
      "--repo",
      "example/project",
      "--squash",
      "--match-head-commit",
      B,
    ]);
    expect((await requests(fixture))[5]?.arguments).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "DELETE",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "/repos/example/project/git/refs/heads/flow%2Fissue-197-fixture",
    ]);
  });

  it("rejects unknown mergeability and merge-queue policy before mutation", async () => {
    for (const responses of [
      [ok(), ok(coreResponse({ mergeable: "UNKNOWN", isDraft: false }))],
      [ok(), ok(coreResponse({ isDraft: false })), ok([{ type: "merge_queue" }])],
    ]) {
      const fixture = await fakeGh(responses);
      const adapter = lifecycleAdapter(fixture);
      await expect(
        adapter.mergeExactPullRequest({
          expected: {
            ...expected(),
            pullRequest: exactPullRequest(),
          },
          effect: mergeEffect(),
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/mergeability_unknown|merge_queue_unsupported/),
      });
      expect((await requests(fixture)).some((request) => request.arguments[0] === "pr")).toBe(
        false,
      );
    }
  });

  it("finds merge-queue rules on later bounded rules pages", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ type: "required_status_checks" }));
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse({ isDraft: false })),
      ok(firstPage),
      ok([{ type: "merge_queue" }]),
    ]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.mergeExactPullRequest({
        expected: {
          ...expected(),
          pullRequest: exactPullRequest(),
        },
        effect: mergeEffect(),
      }),
    ).rejects.toMatchObject({ code: "merge_queue_unsupported" });
    expect((await requests(fixture)).some((request) => request.arguments[0] === "pr")).toBe(false);
  });

  it("does not prove completion while the frozen issue remains open after merge", async () => {
    const mergedButOpen = coreResponse({
      state: "MERGED",
      isDraft: false,
      merged: true,
      mergedAt: "2026-08-28T12:01:00.000Z",
      mergeCommit: { oid: D },
      baseRefOid: D,
      issueState: "OPEN",
      branchRef: null,
    });
    const fixture = await fakeGh([ok(), ok(mergedButOpen), ok(mergedButOpen), ok(mergedButOpen)]);
    const adapter = lifecycleAdapter(fixture);

    await expect(
      adapter.observeMergeOutcome({
        expected: { ...expected(), pullRequest: exactPullRequest() },
        effect: mergeEffect(),
      }),
    ).rejects.toMatchObject({ code: "external_state_uncertain" });
  });

  it("maps command failures to content-free uncertainty without exposing stderr", async () => {
    const fixture = await fakeGh([
      ok(),
      ok(coreResponse({ isDraft: false })),
      ok([]),
      { exitCode: 1, stderr: "github_pat_secret raw private failure" },
    ]);
    const adapter = lifecycleAdapter(fixture);

    const error = await captureError(() =>
      adapter.mergeExactPullRequest({
        expected: {
          ...expected(),
          pullRequest: exactPullRequest(),
        },
        effect: mergeEffect(),
      }),
    );

    expect(error).toMatchObject({ code: "external_state_uncertain" });
    expect(String(error)).not.toContain("github_pat_secret");
    expect(JSON.stringify(error)).not.toContain("raw private failure");
  });
});

interface FakeGhResponse {
  readonly exitCode?: number;
  readonly stdout?: unknown;
  readonly stderr?: string;
}

interface FakeGhFixture {
  readonly root: string;
  readonly executable: Awaited<ReturnType<typeof pinGitHubIssueHostExecutable>>;
  readonly requestLog: string;
}

function ok(stdout: unknown = ""): FakeGhResponse {
  return { stdout };
}

async function fakeGh(responses: readonly FakeGhResponse[]): Promise<FakeGhFixture> {
  const root = await mkdtemp(join(tmpdir(), "flow-github-adapter-"));
  temporaryDirectories.push(root);
  const projectRoot = await mkdtemp(join(tmpdir(), "flow-github-project-"));
  temporaryDirectories.push(projectRoot);
  const executable = join(root, "gh");
  const responsePath = join(root, "responses.json");
  const counterPath = join(root, "counter");
  const requestLog = join(root, "requests.jsonl");
  const script = `#!${process.execPath}\nconst fs=require("node:fs");const path=require("node:path");let stdin="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>stdin+=c);process.stdin.on("end",()=>{const root=path.dirname(process.argv[1]);const counterPath=path.join(root,"counter");const index=fs.existsSync(counterPath)?Number(fs.readFileSync(counterPath,"utf8")):0;const responses=JSON.parse(fs.readFileSync(path.join(root,"responses.json"),"utf8"));fs.writeFileSync(counterPath,String(index+1));fs.appendFileSync(path.join(root,"requests.jsonl"),JSON.stringify({arguments:process.argv.slice(2),stdin})+"\\n");const response=responses[index];if(!response){process.stderr.write("missing fixture response");process.exit(97);}if(response.stderr)process.stderr.write(response.stderr);if(response.stdout!==undefined)process.stdout.write(typeof response.stdout==="string"?response.stdout:JSON.stringify(response.stdout));process.exit(response.exitCode??0);});\n`;
  await writeFile(responsePath, JSON.stringify(responses), "utf8");
  await writeFile(counterPath, "0", "utf8");
  await writeFile(requestLog, "", "utf8");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o700);
  return {
    root,
    executable: await pinGitHubIssueHostExecutable(executable, projectRoot),
    requestLog,
  };
}

async function requests(
  fixture: FakeGhFixture,
): Promise<readonly { arguments: string[]; stdin: string }[]> {
  const source = await readFile(fixture.requestLog, "utf8");
  return source
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function lifecycleAdapter(fixture: FakeGhFixture): GitHubCliIssueLifecycleAdapter {
  return new GitHubCliIssueLifecycleAdapter({
    ghExecutable: fixture.executable,
    cwd: fixture.root,
    now: () => new Date("2026-08-28T12:02:00.000Z"),
  });
}

function expected() {
  return {
    repositoryIdentity: "example/project",
    repositoryNodeId: "R_fixture",
    issue: {
      number: 197,
      nodeId: "I_fixture",
      updatedAt: "2026-08-28T11:00:00.000Z",
      title: "Private issue title",
      body: "private issue body",
      contentDigest: DIGEST,
    },
    base: { branch: "main", commit: A },
    headBranch: "flow/issue-197-fixture",
    headCommit: B,
    hostedChecks: [{ name: "CI / test", sourceApp: { id: 15_368, slug: "github-actions" } }],
  } as const;
}

function exactPullRequest() {
  return {
    number: 198,
    nodeId: "PR_fixture",
    titleDigest: sha256("Implement #197"),
    bodyDigest: sha256("Closes #197"),
  } as const;
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_fixture",
    number: 198,
    state: "OPEN",
    isDraft: true,
    title: "Implement #197",
    body: "Closes #197",
    headRefName: "flow/issue-197-fixture",
    headRefOid: B,
    baseRefName: "main",
    baseRefOid: A,
    mergeable: "MERGEABLE",
    merged: false,
    mergedAt: null,
    mergeCommit: null,
    headRepository: repositoryIdentity(),
    baseRepository: repositoryIdentity(),
    autoMergeRequest: null,
    mergeQueueEntry: null,
    ...overrides,
  };
}

function coreResponse(overrides: Record<string, unknown> = {}) {
  const branchRef = Object.hasOwn(overrides, "branchRef")
    ? overrides.branchRef
    : { name: "flow/issue-197-fixture", target: { oid: B } };
  const { branchRef: _branchRef, issueState = "OPEN", ...pullRequestOverrides } = overrides;
  return {
    data: {
      repository: {
        ...repositoryIdentity(),
        isArchived: false,
        issue: { ...issueIdentity(), state: issueState },
        baseRef: { name: "main", target: { oid: overrides.baseRefOid ?? A } },
        branchRef,
        pullRequest: pullRequest(pullRequestOverrides),
      },
    },
  };
}

function admissionResponse() {
  return {
    data: {
      repository: {
        ...repositoryIdentity(),
        name: "project",
        owner: { login: "example" },
        isArchived: false,
        defaultBranchRef: { name: "main" },
        baseRef: { name: "main", target: { oid: A } },
        issue: issueIdentity(),
      },
    },
  };
}

function issueIdentity() {
  return {
    id: "I_fixture",
    number: 197,
    state: "OPEN",
    title: "Private issue title",
    body: "private issue body",
    updatedAt: "2026-08-28T11:00:00.000Z",
    url: "https://github.com/example/project/issues/197",
  };
}

function repositoryIdentity() {
  return {
    id: "R_fixture",
    nameWithOwner: "example/project",
    url: "https://github.com/example/project",
  };
}

function connectionResponse(
  field: "comments" | "reviews" | "reviewThreads",
  nodes: readonly unknown[],
  totalCount = nodes.length,
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      repository: {
        id: "R_fixture",
        pullRequest: {
          id: "PR_fixture",
          [field]: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } },
        },
      },
    },
  };
}

function pullRequestSearchResponse(
  nodes: readonly unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      repository: {
        ...repositoryIdentity(),
        isArchived: false,
        issue: issueIdentity(),
        baseRef: { name: "main", target: { oid: A } },
        branchRef: { name: "flow/issue-197-fixture", target: { oid: B } },
        ...overrides,
        pullRequests: {
          totalCount: nodes.length,
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

function createPullRequestResponse() {
  return {
    data: {
      createPullRequest: { pullRequest: { id: "PR_fixture", number: 198 } },
    },
  };
}

function markReadyResponse() {
  return {
    data: {
      markPullRequestReadyForReview: { pullRequest: { id: "PR_fixture", number: 198 } },
    },
  };
}

function checkRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    name: "CI / test",
    status: "completed",
    conclusion: "success",
    head_sha: B,
    started_at: "2026-08-28T11:30:00.000Z",
    completed_at: "2026-08-28T11:35:00.000Z",
    app: { id: 15_368, slug: "github-actions" },
    ...overrides,
  };
}

function draftEffect(): Extract<IssueExternalEffectDescriptor, { readonly kind: "pull_request" }> {
  const effect = parseIssueExternalEffectDescriptor({
    ...effectCommon(),
    kind: "pull_request",
    issueNumber: 197,
    issueNodeId: "I_fixture",
    headBranch: "flow/issue-197-fixture",
    headCommit: B,
    baseBranch: "main",
    baseCommit: A,
    titleDigest: sha256("Implement #197"),
    bodyDigest: sha256("Closes #197"),
    isDraft: true,
  });
  if (effect.kind !== "pull_request") throw new Error("expected draft effect fixture");
  return effect;
}

function readyEffect(): Extract<
  IssueExternalEffectDescriptor,
  { readonly kind: "pull_request_ready" }
> {
  const effect = parseIssueExternalEffectDescriptor({
    ...effectCommon(),
    kind: "pull_request_ready",
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_fixture",
    headBranch: "flow/issue-197-fixture",
    headCommit: B,
    baseBranch: "main",
    baseCommit: A,
    isDraft: false,
  });
  if (effect.kind !== "pull_request_ready") throw new Error("expected ready effect fixture");
  return effect;
}

function mergeEffect(): Extract<IssueExternalEffectDescriptor, { readonly kind: "merge" }> {
  const effect = parseIssueExternalEffectDescriptor({
    ...effectCommon(),
    kind: "merge",
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_fixture",
    candidateHead: B,
    baseBranch: "main",
    baseCommit: A,
    gateDigest: "2".repeat(64),
    method: "squash",
    deleteBranch: true,
  });
  if (effect.kind !== "merge") throw new Error("expected merge effect fixture");
  return effect;
}

function effectCommon() {
  return {
    version: 1,
    runId: "run-fixture",
    commandId: "123e4567-e89b-12d3-a456-426614174000",
    repositoryIdentity: "example/project",
    frozenContractDigest: "3".repeat(64),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function graphqlArguments(): string[] {
  return ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"];
}

function restArguments(path: string): string[] {
  return [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    path,
  ];
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
