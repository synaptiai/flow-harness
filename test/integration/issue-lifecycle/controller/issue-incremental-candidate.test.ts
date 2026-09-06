import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../../../../src/infrastructure/git/local-git-issue-effects.js";

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];
const identity = {
  name: "Flow Test",
  email: "flow@example.test",
  timestamp: "2026-09-06T12:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("incremental inspection after controller-owned commits", { timeout: 30_000 }, () => {
  it("recognizes an unchanged newly committed file without updating the ordinary index", async () => {
    const { effects, workspace, committed, originalIndex } = await fixture();
    expect(await git(workspace.root, "ls-files", "--others", "--exclude-standard")).toBe(
      "src/implemented.txt",
    );
    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: committed.candidateHead,
        allowedWritePrefixes: ["src"],
      }),
    ).resolves.toMatchObject({
      head: committed.candidateHead,
      tree: committed.tree,
      changedPaths: [],
      logicalBytes: 0,
    });
    expect(await readFile(join(workspace.gitDirectory, "index"))).toEqual(originalIndex);
  });

  it("records only the actual repair delta and commits it on the reviewed parent", async () => {
    const { effects, workspace, committed, originalIndex } = await fixture();
    await writeFile(join(workspace.root, "src", "implemented.txt"), "implemented and repaired\n");
    const repaired = await effects.inspectCandidate({
      workspace,
      baseCommit: committed.candidateHead,
      allowedWritePrefixes: ["src"],
    });
    expect(repaired.changedPaths).toEqual(["src/implemented.txt"]);
    const next = await effects.commitCandidate({
      workspace,
      parentCommit: committed.candidateHead,
      candidateTree: repaired.tree,
      allowedWritePrefixes: ["src"],
      identity,
      message: "fix: repair the implementation\n",
    });
    expect(next.parent).toBe(committed.candidateHead);
    expect(await git(workspace.root, "show", `${next.candidateHead}:src/implemented.txt`)).toBe(
      "implemented and repaired",
    );
    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: next.candidateHead,
        allowedWritePrefixes: ["src"],
      }),
    ).resolves.toMatchObject({ changedPaths: [], tree: next.tree });
    expect(await readFile(join(workspace.gitDirectory, "index"))).toEqual(originalIndex);
  });

  it("includes genuinely new files after the first committed candidate", async () => {
    const { effects, workspace, committed } = await fixture();
    await writeFile(join(workspace.root, "src", "regression.txt"), "new regression evidence\n");
    const observed = await effects.inspectCandidate({
      workspace,
      baseCommit: committed.candidateHead,
      allowedWritePrefixes: ["src"],
    });
    expect(observed.changedPaths).toEqual(["src/regression.txt"]);
    expect(await git(workspace.root, "show", `${observed.tree}:src/implemented.txt`)).toBe(
      "implemented",
    );
    expect(await git(workspace.root, "show", `${observed.tree}:src/regression.txt`)).toBe(
      "new regression evidence",
    );
  });

  it("rejects genuinely new files outside the original scope", async () => {
    const { effects, workspace, committed } = await fixture();
    await writeFile(join(workspace.root, "outside.txt"), "unapproved\n");
    await expect(
      effects.inspectCandidate({
        workspace,
        baseCommit: committed.candidateHead,
        allowedWritePrefixes: ["src"],
      }),
    ).rejects.toMatchObject({ code: "candidate_path_disallowed" });
  });

  it("detects deletion of a newly committed file absent from the ordinary index", async () => {
    const { effects, workspace, committed, originalIndex } = await fixture();
    await rm(join(workspace.root, "src", "implemented.txt"));
    const observed = await effects.inspectCandidate({
      workspace,
      baseCommit: committed.candidateHead,
      allowedWritePrefixes: ["src"],
    });
    expect(observed.changedPaths).toEqual(["src/implemented.txt"]);
    expect(await git(workspace.root, "ls-tree", "-r", "--name-only", observed.tree)).toBe(
      "src/base.txt",
    );
    expect(await readFile(join(workspace.gitDirectory, "index"))).toEqual(originalIndex);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-incremental-candidate-"));
  temporaryRoots.push(root);
  const seed = join(root, "seed");
  const sourceRoot = join(root, "source");
  const remote = join(root, "remote.git");
  const privateRoot = join(root, "private");
  await mkdir(join(seed, "src"), { recursive: true });
  await mkdir(privateRoot);
  await git(seed, "init", "--initial-branch=main");
  await writeFile(join(seed, "src", "base.txt"), "base\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "--quiet", "-m", "base");
  await git(root, "clone", "--quiet", "--bare", seed, remote);
  await git(root, "clone", "--quiet", remote, sourceRoot);
  const baseCommit = await git(sourceRoot, "rev-parse", "HEAD");
  const effects = new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(await executable(), sourceRoot),
    privateRoot,
    testOnlyLocalRemotePath: remote,
  });
  const workspace = await effects.prepareWorkspace({
    ownershipId: "incremental-candidate",
    sourceRoot,
    workspaceRoot: join(root, "candidate"),
    verificationRoot: join(root, "verification"),
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit,
    branch: "codex/incremental-candidate",
  });
  const originalIndex = await readFile(join(workspace.gitDirectory, "index"));
  await writeFile(join(workspace.root, "src", "implemented.txt"), "implemented\n");
  const candidate = await effects.inspectCandidate({
    workspace,
    baseCommit,
    allowedWritePrefixes: ["src"],
  });
  const committed = await effects.commitCandidate({
    workspace,
    parentCommit: baseCommit,
    candidateTree: candidate.tree,
    allowedWritePrefixes: ["src"],
    identity,
    message: "feat: implement the issue\n",
  });
  return { effects, workspace, committed, originalIndex };
}

let gitPath: string | undefined;
async function executable() {
  gitPath ??= (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  return gitPath;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  return (
    await execFile(await executable(), ["-C", cwd, ...arguments_], {
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
