import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import {
  LocalGitIssueEffects,
  LocalGitIssueError,
  normalizeGitHubIssueOrigin,
} from "../../../../src/infrastructure/git/local-git-issue-effects.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const BASE_MESSAGE = "base fixture";
const COMMIT_IDENTITY = Object.freeze({
  name: "Flow Controller",
  email: "flow@example.test",
  timestamp: "2026-08-28T12:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalGitIssueEffects", () => {
  it("normalizes equivalent GitHub origin spellings and rejects identity drift", () => {
    expect(normalizeGitHubIssueOrigin("https://github.com/Example/Project.git")).toEqual({
      repositoryIdentity: "example/project",
      canonicalUrl: "https://github.com/example/project",
    });
    expect(normalizeGitHubIssueOrigin("git@github.com:Example/Project.git")).toEqual({
      repositoryIdentity: "example/project",
      canonicalUrl: "https://github.com/example/project",
    });
    expect(normalizeGitHubIssueOrigin("ssh://git@github.com/Example/Project.git")).toEqual({
      repositoryIdentity: "example/project",
      canonicalUrl: "https://github.com/example/project",
    });
    expect(() => normalizeGitHubIssueOrigin("https://github.com/other/project.git")).not.toThrow();
    expect(() => normalizeGitHubIssueOrigin("file:///tmp/project.git")).toThrow(LocalGitIssueError);
  });

  it("creates and replays an exactly identified Flow-owned candidate worktree", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);

    const first = await effects.prepareWorkspace(workspaceRequest(fixture));
    const replay = await effects.prepareWorkspace(workspaceRequest(fixture));

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      sourceRoot: await realpath(fixture.source),
      root: await realpath(fixture.candidate),
      verificationRoot: await realpath(fixture.verificationWorktree),
      branch: "codex/issue-197-test",
      baseCommit: fixture.base,
    });
    expect(first.workspaceIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await git(fixture.candidate, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "codex/issue-197-test",
    );
    expect(await git(fixture.candidate, "rev-parse", "HEAD")).toBe(fixture.base);
    expect(await git(fixture.verificationWorktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "HEAD",
    );
    expect(await git(fixture.verificationWorktree, "rev-parse", "HEAD")).toBe(fixture.base);
  });

  it("does not adopt a lookalike path or a pre-existing branch", async () => {
    const pathFixture = await createFixture();
    await mkdir(pathFixture.candidate);
    const pathEffects = await createEffects(pathFixture);

    await expect(pathEffects.prepareWorkspace(workspaceRequest(pathFixture))).rejects.toMatchObject(
      { code: "workspace_not_owned" },
    );

    const basePathFixture = await createFixture();
    await mkdir(basePathFixture.verificationWorktree);
    await expect(
      (await createEffects(basePathFixture)).prepareWorkspace(workspaceRequest(basePathFixture)),
    ).rejects.toMatchObject({ code: "workspace_not_owned" });

    const branchFixture = await createFixture();
    await git(branchFixture.source, "branch", "codex/issue-197-test", branchFixture.base);
    const branchEffects = await createEffects(branchFixture);
    await expect(
      branchEffects.prepareWorkspace(workspaceRequest(branchFixture)),
    ).rejects.toMatchObject({ code: "branch_not_owned" });
  });

  it("recreates exact disposable verification commits without cross-check contamination", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    const beforeSource = await git(fixture.source, "rev-parse", "HEAD");

    await expect(
      effects.inspectVerificationWorktree({
        workspace,
        commit: fixture.base,
        cleanliness: "pristine",
      }),
    ).resolves.toMatchObject({
      head: fixture.base,
      status: "clean",
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
    await writeFile(join(workspace.verificationRoot, "ignored.log"), "holdout output\n");
    await expect(
      effects.inspectVerificationWorktree({
        workspace,
        commit: fixture.base,
        cleanliness: "pristine",
      }),
    ).rejects.toMatchObject({ code: "source_dirty" });
    await expect(
      effects.inspectVerificationWorktree({
        workspace,
        commit: fixture.base,
        cleanliness: "command-postcondition",
      }),
    ).resolves.toMatchObject({ head: fixture.base, status: "clean" });

    const reset = await effects.resetVerificationWorktree({
      workspace,
      commit: fixture.base,
    });

    expect(reset).toMatchObject({
      head: fixture.base,
      status: "clean",
      workspaceIdentityDigest: workspace.workspaceIdentityDigest,
    });
    await expect(lstat(join(workspace.verificationRoot, "ignored.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(fixture.source, "rev-parse", "HEAD")).toBe(beforeSource);
    expect(await git(workspace.root, "rev-parse", "HEAD")).toBe(fixture.base);

    await writeFile(join(workspace.root, "feature.txt"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["feature.txt"],
    });
    const committed = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["feature.txt"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });
    await expect(
      effects.resetVerificationWorktree({ workspace, commit: committed.candidateHead }),
    ).resolves.toMatchObject({ head: committed.candidateHead, status: "clean" });
    await writeFile(join(workspace.verificationRoot, "cross-check.log"), "first check\n");
    await expect(
      effects.inspectVerificationWorktree({
        workspace,
        commit: committed.candidateHead,
        cleanliness: "command-postcondition",
      }),
    ).resolves.toMatchObject({ head: committed.candidateHead, status: "clean" });
    await effects.resetVerificationWorktree({ workspace, commit: committed.candidateHead });
    await expect(lstat(join(workspace.verificationRoot, "cross-check.log"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(effects.prepareWorkspace(workspaceRequest(fixture))).resolves.toEqual(workspace);
  });

  it("rejects a substituted frozen-base Git metadata directory before reset", async () => {
    const fixture = await createFixture();
    const logPath = join(await temporaryDirectory("flow-git-substitution-"), "git.jsonl");
    const effects = await createEffects(fixture, {}, await writeGitWrapper(logPath));
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    const substitute = join(fixture.root, "substitute-base");
    await git(fixture.source, "worktree", "add", "--quiet", "--detach", substitute, fixture.base);
    await writeFile(
      join(workspace.verificationRoot, ".git"),
      await readFile(join(substitute, ".git"), "utf8"),
    );

    await expect(
      effects.resetVerificationWorktree({ workspace, commit: fixture.base }),
    ).rejects.toMatchObject({ code: "workspace_state_uncertain" });
    await expect(lstat(workspace.verificationRoot)).resolves.toBeDefined();
    const invocations = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      invocations.some(
        (arguments_) => arguments_.includes("worktree") && arguments_.includes("remove"),
      ),
    ).toBe(false);
  });

  it("rejects dirty, detached, base-drifted, and origin-drifted source repositories", async () => {
    const dirty = await createFixture();
    await writeFile(join(dirty.source, "dirty.txt"), "dirty\n");
    await expect(
      (await createEffects(dirty)).prepareWorkspace(workspaceRequest(dirty)),
    ).rejects.toMatchObject({ code: "source_dirty" });

    const detached = await createFixture();
    await git(detached.source, "checkout", "--detach", "--quiet");
    await expect(
      (await createEffects(detached)).prepareWorkspace(workspaceRequest(detached)),
    ).rejects.toMatchObject({ code: "source_detached" });

    const baseDrifted = await createFixture();
    await writeFile(join(baseDrifted.source, "drift.txt"), "drift\n");
    await git(baseDrifted.source, "add", "drift.txt");
    await git(baseDrifted.source, "commit", "--quiet", "-m", "drift");
    await git(baseDrifted.source, "push", "--quiet", "origin", "main");
    await expect(
      (await createEffects(baseDrifted)).prepareWorkspace(workspaceRequest(baseDrifted)),
    ).rejects.toMatchObject({ code: "base_drift" });

    const originDrifted = await createFixture();
    await git(originDrifted.source, "remote", "set-url", "origin", `${originDrifted.remote}-other`);
    await expect(
      (await createEffects(originDrifted)).prepareWorkspace(workspaceRequest(originDrifted)),
    ).rejects.toMatchObject({ code: "origin_drift" });
  });

  it.each([
    ["duplicate origin URL", "remote.origin.url", "https://github.com/other/project.git"],
    ["push URL", "remote.origin.pushurl", "https://github.com/other/project.git"],
    ["receive-pack override", "remote.origin.receivepack", "/tmp/not-a-receive-pack"],
    ["mirror mode", "remote.origin.mirror", "true"],
    ["URL fetch rewrite", "url.https://github.com/other/.insteadOf", "https://github.com/"],
    ["URL push rewrite", "url.https://github.com/other/.pushInsteadOf", "https://github.com/"],
  ])("rejects a repository-local %s before workspace mutation", async (_label, key, value) => {
    const fixture = await createFixture();
    await git(fixture.source, "config", "--add", key, value);

    await expect(
      (await createEffects(fixture)).prepareWorkspace(workspaceRequest(fixture)),
    ).rejects.toMatchObject({ code: "origin_drift" });
    await expect(lstat(fixture.candidate)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.verificationWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(fixture.privateRoot, "git-workspaces", "issue-197-test.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspects an allowed candidate delta and rejects disallowed or protected changes", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "export const ready = true;\n");

    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).resolves.toMatchObject({
      branch: "codex/issue-197-test",
      head: fixture.base,
      baseCommit: fixture.base,
      changedPaths: ["src/feature.ts"],
      logicalBytes: 27,
    });

    await writeFile(join(workspace.root, "README.md"), "not allowed\n");
    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_path_disallowed" });

    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: [".git"],
      }),
    ).rejects.toMatchObject({ code: "candidate_prefix_invalid" });
    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: [".GIT"],
      }),
    ).rejects.toMatchObject({ code: "candidate_prefix_invalid" });
  });

  it("rejects symlink escapes, Git filters, gitlinks, and bounded-delta overflow", async () => {
    const symlinkFixture = await createFixture();
    const symlinkEffects = await createEffects(symlinkFixture);
    const symlinkWorkspace = await symlinkEffects.prepareWorkspace(
      workspaceRequest(symlinkFixture),
    );
    const outside = await temporaryDirectory("flow-git-outside-");
    await symlink(outside, join(symlinkWorkspace.root, "src"));
    await expect(
      symlinkEffects.inspectCandidate({
        workspace: symlinkWorkspace,
        baseCommit: symlinkFixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_symlink_escape" });

    const filterFixture = await createFixture();
    const filterEffects = await createEffects(filterFixture);
    const filterWorkspace = await filterEffects.prepareWorkspace(workspaceRequest(filterFixture));
    await writeFile(
      join(filterWorkspace.root, ".gitattributes"),
      "src/filter.txt filter=hostile\n",
    );
    await mkdir(join(filterWorkspace.root, "src"));
    await writeFile(join(filterWorkspace.root, "src", "filter.txt"), "content\n");
    await expect(
      filterEffects.inspectCandidate({
        workspace: filterWorkspace,
        baseCommit: filterFixture.base,
        allowedWritePrefixes: [".gitattributes", "src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_filter_unsupported" });

    const gitlinkFixture = await createFixture();
    const gitlinkEffects = await createEffects(gitlinkFixture);
    const gitlinkWorkspace = await gitlinkEffects.prepareWorkspace(
      workspaceRequest(gitlinkFixture),
    );
    const object = await git(gitlinkWorkspace.root, "rev-parse", "HEAD");
    await git(
      gitlinkWorkspace.root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${object},vendor/submodule`,
    );
    await expect(
      gitlinkEffects.inspectCandidate({
        workspace: gitlinkWorkspace,
        baseCommit: gitlinkFixture.base,
        allowedWritePrefixes: ["vendor"],
      }),
    ).rejects.toMatchObject({ code: "candidate_gitlink_unsupported" });

    const boundedFixture = await createFixture();
    const boundedEffects = await createEffects(boundedFixture, { maxCandidatePaths: 1 });
    const boundedWorkspace = await boundedEffects.prepareWorkspace(
      workspaceRequest(boundedFixture),
    );
    await mkdir(join(boundedWorkspace.root, "src"));
    await writeFile(join(boundedWorkspace.root, "src", "one.ts"), "1");
    await writeFile(join(boundedWorkspace.root, "src", "two.ts"), "2");
    await expect(
      boundedEffects.inspectCandidate({
        workspace: boundedWorkspace,
        baseCommit: boundedFixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_path_limit_exceeded" });

    const bytesFixture = await createFixture();
    const bytesEffects = await createEffects(bytesFixture, { maxCandidateBytes: 4 });
    const bytesWorkspace = await bytesEffects.prepareWorkspace(workspaceRequest(bytesFixture));
    await mkdir(join(bytesWorkspace.root, "src"));
    await writeFile(join(bytesWorkspace.root, "src", "large.txt"), "12345");
    await expect(
      bytesEffects.inspectCandidate({
        workspace: bytesWorkspace,
        baseCommit: bytesFixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_byte_limit_exceeded" });

    const modulesFixture = await createFixture();
    const modulesEffects = await createEffects(modulesFixture);
    const modulesWorkspace = await modulesEffects.prepareWorkspace(
      workspaceRequest(modulesFixture),
    );
    await writeFile(join(modulesWorkspace.root, ".gitmodules"), '[submodule "x"]\n');
    await expect(
      modulesEffects.inspectCandidate({
        workspace: modulesWorkspace,
        baseCommit: modulesFixture.base,
        allowedWritePrefixes: [".gitmodules"],
      }),
    ).rejects.toMatchObject({ code: "candidate_gitlink_unsupported" });
  }, 30_000);

  it("counts removed base objects in a delete-only candidate budget", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await rm(join(workspace.root, "README.md"));

    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: ["README.md"],
      }),
    ).resolves.toMatchObject({
      changedPaths: ["README.md"],
      logicalBytes: Buffer.byteLength("# fixture\n"),
    });
  });

  it("rejects a disallowed mutation introduced between validation and tree creation", async () => {
    const fixture = await createFixture();
    let mutated = false;
    const effects = await createEffects(fixture, {
      testOnlyBeforePrivateIndexWrite: async () => {
        if (mutated) return;
        mutated = true;
        await writeFile(join(fixture.candidate, "outside.txt"), "raced\n");
      },
    });
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");

    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: fixture.base,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_path_disallowed" });
  });

  it("creates and replays a deterministic commit without changing the ordinary index", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "export const ready = true;\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const ordinaryIndexTree = await git(workspace.root, "write-tree");

    const request = {
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: implement issue fixture\n",
      identity: COMMIT_IDENTITY,
    } as const;
    const first = await effects.commitCandidate(request);
    const replay = await effects.commitCandidate(request);

    expect(replay).toEqual(first);
    expect(first.candidateHead).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(workspace.root, "rev-parse", "HEAD")).toBe(first.candidateHead);
    expect(await git(workspace.root, "write-tree")).toBe(ordinaryIndexTree);
    expect(
      await git(workspace.root, "show", "-s", "--format=%an <%ae>%n%aI", first.candidateHead),
    ).toBe("Flow Controller <flow@example.test>\n2026-08-28T12:00:00Z");
  });

  it("rejects a branch ref race instead of replacing the competing commit", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const competing = await createDetachedCommit(fixture.source, fixture.base, "competing");
    await git(
      fixture.source,
      "update-ref",
      "refs/heads/codex/issue-197-test",
      competing,
      fixture.base,
    );

    await expect(
      effects.commitCandidate({
        workspace,
        parentCommit: fixture.base,
        candidateTree: candidate.tree,
        allowedWritePrefixes: ["src"],
        message: "feat: candidate\n",
        identity: COMMIT_IDENTITY,
      }),
    ).rejects.toMatchObject({ code: "branch_drift" });
    expect(await git(fixture.source, "rev-parse", "refs/heads/codex/issue-197-test")).toBe(
      competing,
    );
  });

  it("pushes by exact expected remote head, replays, and rejects remote drift", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const commit = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });

    const request = {
      workspace,
      branch: workspace.branch,
      candidateHead: commit.candidateHead,
      expectedRemoteHead: null,
    } as const;
    await expect(effects.pushCandidate(request)).resolves.toEqual({
      branch: workspace.branch,
      candidateHead: commit.candidateHead,
    });
    await expect(effects.pushCandidate(request)).resolves.toEqual({
      branch: workspace.branch,
      candidateHead: commit.candidateHead,
    });

    const drift = await createDetachedCommit(fixture.source, fixture.base, "remote drift");
    await git(
      fixture.source,
      "push",
      "--quiet",
      "--force",
      fixture.remote,
      `${drift}:refs/heads/${workspace.branch}`,
    );
    await expect(
      effects.pushCandidate({
        workspace,
        branch: workspace.branch,
        candidateHead: commit.candidateHead,
        expectedRemoteHead: commit.candidateHead,
      }),
    ).rejects.toMatchObject({ code: "remote_drift" });
  });

  it("observes an exact remote branch without updating it", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));

    await expect(
      effects.inspectRemoteBranch({ workspace, branch: workspace.branch }),
    ).resolves.toEqual({ branch: workspace.branch, head: null });

    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const commit = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });
    await effects.pushCandidate({
      workspace,
      branch: workspace.branch,
      candidateHead: commit.candidateHead,
      expectedRemoteHead: null,
    });

    await expect(
      effects.inspectRemoteBranch({ workspace, branch: workspace.branch }),
    ).resolves.toEqual({ branch: workspace.branch, head: commit.candidateHead });
  });

  it("fetches only an exact remote branch head for topology proof", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));

    await expect(
      effects.fetchRemoteBranch({
        workspace,
        branch: "main",
        expectedHead: fixture.base,
      }),
    ).resolves.toEqual({ branch: "main", head: fixture.base });
    await expect(
      effects.fetchRemoteBranch({
        workspace,
        branch: "main",
        expectedHead: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "remote_drift" });
  });

  it("recovers only an exact pull-request head object without force authority", async () => {
    const fixture = await createFixture();
    const publisher = join(fixture.root, "publisher");
    await execFile(await gitPath(), ["clone", "--quiet", fixture.remote, publisher]);
    const candidateHead = await createDetachedCommit(publisher, fixture.base, "candidate fixture");
    await git(publisher, "push", "origin", `${candidateHead}:refs/pull/198/head`);
    const logPath = join(await temporaryDirectory("flow-git-pr-head-"), "argv.jsonl");
    const effects = await createEffects(fixture, {}, await writeGitWrapper(logPath));
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));

    await expect(
      git(workspace.root, "cat-file", "-e", `${candidateHead}^{commit}`),
    ).rejects.toThrow();
    await expect(
      effects.fetchPullRequestHead({
        workspace,
        pullRequestNumber: 198,
        expectedHead: candidateHead,
      }),
    ).resolves.toEqual({ pullRequestNumber: 198, head: candidateHead });
    await expect(git(workspace.root, "cat-file", "-e", `${candidateHead}^{commit}`)).resolves.toBe(
      "",
    );
    await expect(
      effects.fetchPullRequestHead({
        workspace,
        pullRequestNumber: 198,
        expectedHead: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "remote_drift" });

    const invocations = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const fetch = invocations.find(
      (arguments_) => arguments_.includes("fetch") && arguments_.includes("refs/pull/198/head"),
    );
    expect(fetch?.slice(-6)).toEqual([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      fixture.remote,
      "refs/pull/198/head",
    ]);
    expect(fetch).toContain("--no-optional-locks");
    expect(fetch?.some((argument) => argument.startsWith("--force"))).toBe(false);
    expect(fetch).toContain("protocol.file.allow=always");
  }, 30_000);

  it("computes the same ordered stable patch digest for equivalent rewritten commits", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const original = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: original\n",
      identity: COMMIT_IDENTITY,
    });
    const rewritten = await git(
      workspace.root,
      "commit-tree",
      candidate.tree,
      "-p",
      fixture.base,
      "-m",
      "different message",
    );

    const left = await effects.inspectPatchSeries({
      workspace,
      baseCommit: fixture.base,
      headCommit: original.candidateHead,
    });
    const right = await effects.inspectPatchSeries({
      workspace,
      baseCommit: fixture.base,
      headCommit: rewritten,
    });

    expect(left).toMatchObject({ firstParent: fixture.base, commitCount: 1 });
    expect(right.digest).toBe(left.digest);
  });

  it("creates a deterministic follow-up commit atop the prior owned candidate", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "first\n");
    const firstTree = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const first = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: firstTree.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: first\n",
      identity: COMMIT_IDENTITY,
    });
    await writeFile(join(workspace.root, "src", "feature.ts"), "second\n");
    const secondTree = await effects.inspectCandidate({
      workspace,
      baseCommit: first.candidateHead,
      allowedWritePrefixes: ["src"],
    });

    await expect(
      effects.commitCandidate({
        workspace,
        parentCommit: first.candidateHead,
        candidateTree: secondTree.tree,
        allowedWritePrefixes: ["src"],
        message: "feat: second\n",
        identity: COMMIT_IDENTITY,
      }),
    ).resolves.toMatchObject({ parent: first.candidateHead, tree: secondTree.tree });
  });

  it("uses one exact leased push with only the admitted local test protocol", async () => {
    const fixture = await createFixture();
    const logPath = join(await temporaryDirectory("flow-git-argv-"), "argv.jsonl");
    const wrapper = await writeGitWrapper(logPath);
    const effects = await createEffects(fixture, {}, wrapper);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    await mkdir(join(workspace.root, "src"));
    await writeFile(join(workspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await effects.inspectCandidate({
      workspace,
      baseCommit: fixture.base,
      allowedWritePrefixes: ["src"],
    });
    const commit = await effects.commitCandidate({
      workspace,
      parentCommit: fixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });
    await effects.pushCandidate({
      workspace,
      branch: workspace.branch,
      candidateHead: commit.candidateHead,
      expectedRemoteHead: null,
    });

    const invocations = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const push = invocations.find((arguments_) => arguments_.includes("push"));
    expect(push).toBeDefined();
    expect(push).toContain(`--force-with-lease=refs/heads/${workspace.branch}:`);
    expect(push).not.toContain("--force");
    expect(push).toContain("--no-signed");
    expect(push).toContain("--recurse-submodules=no");
    expect(push).toContain(fixture.remote);
    expect(push).not.toContain("origin");
    expect(push).toContain("protocol.file.allow=always");
  }, 60_000);

  it("reconciles successful worktree, ref, push, and cleanup effects after result loss", async () => {
    const workspaceFixture = await createFixture();
    const workspaceWrapper = await writeGitWrapper(
      join(await temporaryDirectory("flow-git-loss-"), "workspace.jsonl"),
      "worktree-add",
    );
    await expect(
      (await createEffects(workspaceFixture, {}, workspaceWrapper)).prepareWorkspace(
        workspaceRequest(workspaceFixture),
      ),
    ).resolves.toMatchObject({ branch: "codex/issue-197-test" });

    const commitFixture = await createFixture();
    const commitWrapper = await writeGitWrapper(
      join(await temporaryDirectory("flow-git-loss-"), "commit.jsonl"),
      "update-ref",
    );
    const commitEffects = await createEffects(commitFixture, {}, commitWrapper);
    const commitWorkspace = await commitEffects.prepareWorkspace(workspaceRequest(commitFixture));
    await mkdir(join(commitWorkspace.root, "src"));
    await writeFile(join(commitWorkspace.root, "src", "feature.ts"), "candidate\n");
    const candidate = await commitEffects.inspectCandidate({
      workspace: commitWorkspace,
      baseCommit: commitFixture.base,
      allowedWritePrefixes: ["src"],
    });
    const commit = await commitEffects.commitCandidate({
      workspace: commitWorkspace,
      parentCommit: commitFixture.base,
      candidateTree: candidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });
    expect(await git(commitWorkspace.root, "rev-parse", "HEAD")).toBe(commit.candidateHead);

    const pushFixture = await createFixture();
    const pushWrapper = await writeGitWrapper(
      join(await temporaryDirectory("flow-git-loss-"), "push.jsonl"),
      "push",
    );
    const pushEffects = await createEffects(pushFixture, {}, pushWrapper);
    const pushWorkspace = await pushEffects.prepareWorkspace(workspaceRequest(pushFixture));
    await mkdir(join(pushWorkspace.root, "src"));
    await writeFile(join(pushWorkspace.root, "src", "feature.ts"), "candidate\n");
    const pushCandidate = await pushEffects.inspectCandidate({
      workspace: pushWorkspace,
      baseCommit: pushFixture.base,
      allowedWritePrefixes: ["src"],
    });
    const pushCommit = await pushEffects.commitCandidate({
      workspace: pushWorkspace,
      parentCommit: pushFixture.base,
      candidateTree: pushCandidate.tree,
      allowedWritePrefixes: ["src"],
      message: "feat: candidate\n",
      identity: COMMIT_IDENTITY,
    });
    await expect(
      pushEffects.pushCandidate({
        workspace: pushWorkspace,
        branch: pushWorkspace.branch,
        candidateHead: pushCommit.candidateHead,
        expectedRemoteHead: null,
      }),
    ).resolves.toEqual({
      branch: pushWorkspace.branch,
      candidateHead: pushCommit.candidateHead,
    });

    const cleanupFixture = await createFixture();
    const cleanupWrapper = await writeGitWrapper(
      join(await temporaryDirectory("flow-git-loss-"), "cleanup.jsonl"),
      "worktree-remove",
    );
    const cleanupEffects = await createEffects(cleanupFixture, {}, cleanupWrapper);
    const cleanupWorkspace = await cleanupEffects.prepareWorkspace(
      workspaceRequest(cleanupFixture),
    );
    await expect(
      cleanupEffects.cleanupWorkspace({
        workspace: cleanupWorkspace,
        expectedBranchHead: cleanupFixture.base,
      }),
    ).resolves.toBeUndefined();
    await expect(
      cleanupEffects.cleanupWorkspace({
        workspace: cleanupWorkspace,
        expectedBranchHead: cleanupFixture.base,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("rejects host environment variables that can redirect Git authority", async () => {
    const fixture = await createFixture();
    await expect(
      createEffects(fixture, { environment: { GIT_DIR: fixture.remote } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reads exact commit topology and removes only its owned candidate workspace", async () => {
    const fixture = await createFixture();
    const effects = await createEffects(fixture);
    const workspace = await effects.prepareWorkspace(workspaceRequest(fixture));
    const base = await effects.inspectCommit({ workspace, commit: fixture.base });

    expect(base).toMatchObject({ commit: fixture.base, parents: [] });
    expect(base.tree).toMatch(/^[a-f0-9]{40}$/);
    await expect(
      effects.isAncestor({ workspace, ancestor: fixture.base, descendant: fixture.base }),
    ).resolves.toBe(true);

    await effects.cleanupWorkspace({ workspace, expectedBranchHead: fixture.base });
    await expect(lstat(fixture.candidate)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fixture.verificationWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.sentinel, "utf8")).resolves.toBe("preserve\n");
    await expect(
      effects.cleanupWorkspace({ workspace, expectedBranchHead: fixture.base }),
    ).resolves.toBeUndefined();

    const unowned = await createFixture();
    const forged = { ...workspace, root: unowned.candidate };
    await expect(
      (await createEffects(unowned)).cleanupWorkspace({
        workspace: forged,
        expectedBranchHead: fixture.base,
      }),
    ).rejects.toBeInstanceOf(LocalGitIssueError);
  });
});

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly remote: string;
  readonly privateRoot: string;
  readonly candidate: string;
  readonly verificationWorktree: string;
  readonly sentinel: string;
  readonly base: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("flow-local-git-effects-");
  const seed = join(root, "seed");
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const privateRoot = join(root, "private");
  const candidate = join(root, "candidate");
  const verificationWorktree = join(root, "frozen-base");
  const sentinel = join(root, "sentinel.txt");
  await mkdir(seed);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.email", "flow@example.test");
  await git(seed, "config", "user.name", "Flow Test");
  await writeFile(join(seed, "README.md"), "# fixture\n");
  await writeFile(join(seed, ".gitignore"), "*.log\n");
  await git(seed, "add", "README.md", ".gitignore");
  await git(seed, "commit", "--quiet", "-m", BASE_MESSAGE);
  await execFile(await gitPath(), ["clone", "--quiet", "--bare", seed, remote]);
  await execFile(await gitPath(), ["clone", "--quiet", remote, source]);
  await git(source, "config", "user.email", "flow@example.test");
  await git(source, "config", "user.name", "Flow Test");
  await mkdir(privateRoot);
  await writeFile(sentinel, "preserve\n");
  return {
    root,
    source,
    remote,
    privateRoot,
    candidate,
    verificationWorktree,
    sentinel,
    base: await git(source, "rev-parse", "HEAD"),
  };
}

function workspaceRequest(fixture: Fixture) {
  return {
    sourceRoot: fixture.source,
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit: fixture.base,
    branch: "codex/issue-197-test",
    workspaceRoot: fixture.candidate,
    verificationRoot: fixture.verificationWorktree,
    ownershipId: "issue-197-test",
  } as const;
}

async function createEffects(
  fixture: Fixture,
  limits: {
    readonly maxCandidatePaths?: number;
    readonly maxCandidateBytes?: number;
    readonly environment?: Readonly<Record<string, string>>;
    readonly testOnlyBeforePrivateIndexWrite?: () => Promise<void>;
  } = {},
  executablePath?: string,
): Promise<LocalGitIssueEffects> {
  return new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(
      executablePath ?? (await gitPath()),
      fixture.root,
    ),
    privateRoot: fixture.privateRoot,
    testOnlyLocalRemotePath: fixture.remote,
    ...limits,
  });
}

type ResultLossMode = "worktree-add" | "update-ref" | "push" | "worktree-remove";

async function writeGitWrapper(logPath: string, resultLossMode?: ResultLossMode): Promise<string> {
  const root = await temporaryDirectory("flow-git-wrapper-");
  const wrapper = join(root, "git");
  const marker = join(dirname(logPath), "result-lost");
  const source = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const input = readFileSync(0);
const result = spawnSync(${JSON.stringify(await gitPath())}, args, {
  env: process.env,
  input,
  maxBuffer: 2 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const command = args.find((value) => ["worktree", "update-ref", "push"].includes(value));
const losesResult =
  ${JSON.stringify(resultLossMode ?? null)} === "worktree-add" && command === "worktree" && args.includes("add") ||
  ${JSON.stringify(resultLossMode ?? null)} === "worktree-remove" && command === "worktree" && args.includes("remove") ||
  ${JSON.stringify(resultLossMode ?? null)} === "update-ref" && command === "update-ref" && !args.includes("-d") ||
  ${JSON.stringify(resultLossMode ?? null)} === "push" && command === "push";
if (losesResult && result.status === 0 && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, "lost");
  process.exit(23);
}
process.exit(result.status ?? 127);
`;
  await writeFile(wrapper, source, { encoding: "utf8", mode: 0o700 });
  return wrapper;
}

async function createDetachedCommit(repository: string, parent: string, message: string) {
  const tree = await git(repository, "rev-parse", `${parent}^{tree}`);
  return await git(repository, "commit-tree", tree, "-p", parent, "-m", message);
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
