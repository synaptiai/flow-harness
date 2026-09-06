import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IssueGitWorkspace } from "../../../../src/application/issue-local-git-port.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../../../../src/infrastructure/git/local-git-issue-effects.js";
import { MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES } from "../../../../src/infrastructure/git/strict-host-process.js";

const execFile = promisify(execFileCallback);
const regularSource = "one\r\ntwo\nthree";
let root: string;
let gitPath: string;
let effects: LocalGitIssueEffects;
let workspace: IssueGitWorkspace;
let candidateHead: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flow-finding-source-"));
  gitPath = (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const privateRoot = join(root, "private");
  await mkdir(join(seed, "src", "directory"), { recursive: true });
  await mkdir(join(seed, "src-neighbor"));
  await mkdir(privateRoot);
  await git(seed, "init", "--initial-branch=main");
  await writeFile(join(seed, "src", "regular.txt"), regularSource);
  await writeFile(join(seed, "src", "executable.txt"), "executable text\n");
  await writeFile(join(seed, "src", "trailing.txt"), "one\ntwo\n");
  await writeFile(join(seed, "src", "empty.txt"), "");
  await writeFile(join(seed, "src", "binary.txt"), "one\0two\n");
  await writeFile(join(seed, "src", "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(seed, "src", "max.txt"), "a".repeat(MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES));
  await writeFile(
    join(seed, "src", "over.txt"),
    "a".repeat(MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES + 1),
  );
  await writeFile(join(seed, "src", "méta[glob]*:name.txt"), "literal\n");
  await writeFile(join(seed, "src", "directory", "child.txt"), "nested\n");
  await writeFile(join(seed, "src-neighbor", "outside.txt"), "outside\n");
  await symlink("regular.txt", join(seed, "src", "link.txt"));
  await git(seed, "add", ".");
  await git(seed, "update-index", "--chmod=+x", "src/executable.txt");
  await git(seed, "commit", "--quiet", "-m", "finding source base");
  const first = await git(seed, "rev-parse", "HEAD");
  await git(seed, "update-index", "--add", "--cacheinfo", `160000,${first},src/gitlink`);
  await git(seed, "commit", "--quiet", "-m", "include non-regular object");
  await git(root, "clone", "--quiet", "--bare", seed, remote);
  await git(root, "clone", "--quiet", remote, source);
  candidateHead = await git(source, "rev-parse", "HEAD");
  effects = new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(gitPath, root),
    privateRoot,
    testOnlyLocalRemotePath: remote,
  });
  workspace = await effects.prepareWorkspace({
    ownershipId: "finding-source",
    sourceRoot: source,
    workspaceRoot: join(root, "candidate"),
    verificationRoot: join(root, "verification"),
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit: candidateHead,
    branch: "codex/finding-source",
  });
}, 30_000);

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe("exact committed finding source", { timeout: 30_000 }, () => {
  it("inspects the exact committed candidate without requiring any finding location", async () => {
    await expect(
      effects.inspectCommit({
        workspace,
        commit: candidateHead,
        expectedCandidateHead: candidateHead,
      }),
    ).resolves.toMatchObject({
      commit: candidateHead,
      tree: await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`),
    });
  });

  it("rejects an exact-candidate commit observation of an unowned descendant head", async () => {
    const tree = await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`);
    const other = await git(
      workspace.root,
      "commit-tree",
      tree,
      "-p",
      candidateHead,
      "-m",
      "unowned descendant",
    );
    await expect(
      effects.inspectCommit({ workspace, commit: other, expectedCandidateHead: other }),
    ).rejects.toMatchObject({ code: "branch_drift" });
  });

  it("rejects a requested commit inconsistent with expected candidate identity", async () => {
    const prior = await git(workspace.root, "rev-parse", `${candidateHead}^`);
    await expect(
      effects.inspectCommit({ workspace, commit: prior, expectedCandidateHead: candidateHead }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a zero-finding candidate observation outside the frozen base ancestry", async () => {
    const tree = await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`);
    const unrelated = await git(
      workspace.root,
      "commit-tree",
      tree,
      "-m",
      "unrelated zero-finding candidate",
    );
    await git(
      workspace.root,
      "update-ref",
      `refs/heads/${workspace.branch}`,
      unrelated,
      candidateHead,
    );
    try {
      await expect(
        effects.inspectCommit({ workspace, commit: unrelated, expectedCandidateHead: unrelated }),
      ).rejects.toMatchObject({ code: "base_drift" });
    } finally {
      await git(
        workspace.root,
        "update-ref",
        `refs/heads/${workspace.branch}`,
        candidateHead,
        unrelated,
      );
    }
  });

  it("returns content-free metadata from the committed blob despite a dirty working copy", async () => {
    await writeFile(join(workspace.root, "src", "regular.txt"), "uncommitted replacement\n");
    try {
      const observed = await effects.inspectFindingSource(request("src/regular.txt", 2, 3));
      expect(observed).toEqual({
        candidateHead,
        workspaceIdentityDigest: workspace.workspaceIdentityDigest,
        file: "src/regular.txt",
        blob: await git(workspace.root, "rev-parse", `${candidateHead}:src/regular.txt`),
        mode: "100644",
        byteLength: Buffer.byteLength(regularSource),
        lineCount: 3,
        startLine: 2,
        endLine: 3,
      });
      expect(JSON.stringify(observed)).not.toContain(regularSource);
      expect(await git(workspace.root, "status", "--porcelain")).toContain("src/regular.txt");
    } finally {
      await writeFile(join(workspace.root, "src", "regular.txt"), regularSource);
    }
  });

  it("uses literal Git paths for metacharacters and non-ASCII names", async () => {
    await expect(
      effects.inspectFindingSource(request("src/méta[glob]*:name.txt", 1)),
    ).resolves.toMatchObject({
      file: "src/méta[glob]*:name.txt",
      lineCount: 1,
      startLine: 1,
      endLine: 1,
    });
  });

  it("accepts the exact existing host byte ceiling", async () => {
    await expect(effects.inspectFindingSource(request("src/max.txt", 1))).resolves.toMatchObject({
      byteLength: MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES,
      lineCount: 1,
    });
  });

  it("accepts an executable regular text blob without executing it", async () => {
    await expect(
      effects.inspectFindingSource(request("src/executable.txt", 1)),
    ).resolves.toMatchObject({ mode: "100755", lineCount: 1 });
  });

  it("rejects a committed blob one byte above the existing host ceiling", async () => {
    await expect(effects.inspectFindingSource(request("src/over.txt", 1))).rejects.toMatchObject({
      code: "finding_source_byte_limit_exceeded",
    });
  });

  it.each(["src/link.txt", "src/gitlink", "src/directory"])(
    "rejects non-regular committed object %s",
    async (file) => {
      await expect(effects.inspectFindingSource(request(file, 1))).rejects.toMatchObject({
        code: "finding_source_not_regular",
      });
    },
  );

  it.each(["src/binary.txt", "src/invalid.txt"])(
    "rejects non-text committed blob %s",
    async (file) => {
      await expect(effects.inspectFindingSource(request(file, 1))).rejects.toMatchObject({
        code: "finding_source_not_text",
      });
    },
  );

  it("rejects a missing committed path", async () => {
    await expect(effects.inspectFindingSource(request("src/missing.txt", 1))).rejects.toMatchObject(
      { code: "finding_source_missing" },
    );
  });

  it("rejects a sibling outside the original allowed prefix", async () => {
    await expect(
      effects.inspectFindingSource(request("src-neighbor/outside.txt", 1)),
    ).rejects.toMatchObject({ code: "candidate_path_disallowed" });
  });

  it.each([
    "../src/regular.txt",
    "/src/regular.txt",
    "src/../regular.txt",
    "src\\regular.txt",
    "src//regular.txt",
    "src/regular.txt\0",
    "src/regular.txt\n",
    "src/.flow/private.txt",
    "src/.git/config",
  ])("rejects unsafe project path %j", async (file) => {
    await expect(effects.inspectFindingSource(request(file, 1))).rejects.toMatchObject({
      code: "candidate_path_disallowed",
    });
  });

  it.each([
    ["src/empty.txt", 1, undefined],
    ["src/trailing.txt", 3, undefined],
    ["src/regular.txt", 1, 4],
    ["src/regular.txt", 3, 2],
    ["src/regular.txt", 0, undefined],
    ["src/regular.txt", 1.5, undefined],
    ["src/regular.txt", Number.MAX_SAFE_INTEGER + 1, undefined],
    ["src/regular.txt", undefined, 1],
  ] as const)(
    "rejects invalid committed source location %s:%s-%s",
    async (file, startLine, endLine) => {
      await expect(
        effects.inspectFindingSource({
          ...request(file, 1),
          startLine: startLine as number,
          ...(endLine === undefined ? {} : { endLine }),
        }),
      ).rejects.toMatchObject({ code: "finding_source_location_invalid" });
    },
  );

  it("rejects a candidate head that is not the current owned branch head", async () => {
    const tree = await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`);
    const unownedHead = await git(
      workspace.root,
      "commit-tree",
      tree,
      "-p",
      candidateHead,
      "-m",
      "not the owned head",
    );
    await expect(
      effects.inspectFindingSource({
        ...request("src/regular.txt", 1),
        candidateHead: unownedHead,
      }),
    ).rejects.toMatchObject({ code: "branch_drift" });
  });

  it("rejects a forged workspace identity", async () => {
    await expect(
      effects.inspectFindingSource({
        ...request("src/regular.txt", 1),
        workspace: { ...workspace, workspaceIdentityDigest: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "workspace_not_owned" });
  });

  it("rejects an owned branch head detached from the frozen base ancestry", async () => {
    const tree = await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`);
    const unrelated = await git(workspace.root, "commit-tree", tree, "-m", "unrelated candidate");
    await git(
      workspace.root,
      "update-ref",
      `refs/heads/${workspace.branch}`,
      unrelated,
      candidateHead,
    );
    try {
      await expect(
        effects.inspectFindingSource({
          ...request("src/regular.txt", 1),
          candidateHead: unrelated,
        }),
      ).rejects.toMatchObject({ code: "base_drift" });
    } finally {
      await git(
        workspace.root,
        "update-ref",
        `refs/heads/${workspace.branch}`,
        candidateHead,
        unrelated,
      );
    }
  });

  it("ignores Git replacement refs when identifying committed source", async () => {
    const original = await git(workspace.root, "rev-parse", `${candidateHead}:src/regular.txt`);
    const replacement = await git(workspace.root, "rev-parse", `${candidateHead}:src/trailing.txt`);
    await git(workspace.root, "replace", original, replacement);
    try {
      await expect(
        effects.inspectFindingSource(request("src/regular.txt", 3)),
      ).resolves.toMatchObject({
        blob: original,
        lineCount: 3,
        byteLength: Buffer.byteLength(regularSource),
      });
    } finally {
      await git(workspace.root, "replace", "--delete", original);
    }
  });

  it("honors cancellation before inspecting committed source", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      effects.inspectFindingSource({ ...request("src/regular.txt", 1), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "operation_aborted" });
  });

  it("rejects candidate branch drift that occurs while the real blob is being read", async () => {
    const tree = await git(workspace.root, "rev-parse", `${candidateHead}^{tree}`);
    const racedHead = await git(
      workspace.root,
      "commit-tree",
      tree,
      "-p",
      candidateHead,
      "-m",
      "concurrent candidate",
    );
    const wrapper = join(root, "git-finding-race");
    await writeFile(
      wrapper,
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const original = spawnSync(${JSON.stringify(gitPath)}, args, { encoding: null, env: process.env });
if (original.status === 0 && args.includes("cat-file") && args.includes("blob")) {
  const changed = spawnSync(${JSON.stringify(gitPath)}, ["-C", ${JSON.stringify(workspace.root)}, "update-ref", ${JSON.stringify(`refs/heads/${workspace.branch}`)}, ${JSON.stringify(racedHead)}, ${JSON.stringify(candidateHead)}], { env: process.env });
  if (changed.status !== 0) process.exit(91);
}
process.stdout.write(original.stdout);
process.stderr.write(original.stderr);
process.exit(original.status ?? 92);
`,
      { mode: 0o700 },
    );
    const racingEffects = new LocalGitIssueEffects({
      gitExecutable: await pinGitHubIssueHostExecutable(wrapper, workspace.sourceRoot),
      privateRoot: join(root, "private"),
      testOnlyLocalRemotePath: join(root, "remote.git"),
    });
    try {
      await expect(
        racingEffects.inspectFindingSource(request("src/regular.txt", 1)),
      ).rejects.toMatchObject({ code: "branch_drift" });
    } finally {
      await git(
        workspace.root,
        "update-ref",
        `refs/heads/${workspace.branch}`,
        candidateHead,
        racedHead,
      );
    }
  });
});

function request(file: string, startLine: number, endLine?: number) {
  return {
    workspace,
    candidateHead,
    file,
    startLine,
    allowedWritePrefixes: ["src"],
    ...(endLine === undefined ? {} : { endLine }),
  };
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFile(gitPath, ["-C", cwd, ...arguments_], {
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Flow Test",
      GIT_AUTHOR_EMAIL: "flow@example.test",
      GIT_COMMITTER_NAME: "Flow Test",
      GIT_COMMITTER_EMAIL: "flow@example.test",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  return result.stdout.trim();
}
