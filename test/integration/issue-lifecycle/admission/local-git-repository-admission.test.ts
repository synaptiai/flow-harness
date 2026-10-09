import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubIssueHostAdmissionError } from "../../../../src/application/github-issue-ports.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitRepositoryAdmission } from "../../../../src/infrastructure/git/local-git-repository-admission.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("local Git repository admission", () => {
  it("returns a clean attached repository observation bound to origin", async () => {
    const repository = await createRepository("https://github.com/Example/Project.git");
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).resolves.toMatchObject({
      root: await realpath(repository),
      clean: true,
      flowRuntimeIgnored: true,
      branch: "main",
      origin: {
        host: "github.com",
        owner: "Example",
        name: "Project",
        canonicalUrl: "https://github.com/Example/Project",
      },
    });
  });

  it("admits a leading-dot repository name consistently with origin", async () => {
    const repository = await createRepository("https://github.com/Example/.github.git");
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(repository, {
        host: "github.com",
        owner: "example",
        name: ".github",
      }),
    ).resolves.toMatchObject({
      origin: {
        owner: "Example",
        name: ".github",
        canonicalUrl: "https://github.com/Example/.github",
      },
    });
  });

  it("admits only one exact constructor-bound local remote in tests", async () => {
    const localRemote = await temporaryDirectory("flow-git-admission-remote-");
    const repository = await createRepository(localRemote);
    const gitExecutable = await resolveGit();
    const expected = { host: "github.com" as const, owner: "example", name: "project" };

    await expect(
      new LocalGitRepositoryAdmission({
        gitExecutable,
        testOnlyLocalRemotePath: localRemote,
      }).inspect(repository, expected),
    ).resolves.toMatchObject({
      origin: {
        host: "github.com",
        owner: "example",
        name: "project",
        canonicalUrl: "https://github.com/example/project",
      },
    });
    await expect(
      new LocalGitRepositoryAdmission({
        gitExecutable,
        testOnlyLocalRemotePath: join(localRemote, "different.git"),
      }).inspect(repository, expected),
    ).rejects.toMatchObject({ code: "repository_origin_unsupported" });
    expect(
      () =>
        new LocalGitRepositoryAdmission({
          gitExecutable,
          testOnlyLocalRemotePath: "relative.git",
        }),
    ).toThrow("absolute normalized path");
  });

  it("rejects a dirty checkout with a stable content-free error", async () => {
    const repository = await createRepository("git@github.com:example/project.git");
    const secretPath = join(repository, "github_pat_secret.txt");
    await writeFile(secretPath, "secret", "utf8");
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    const error = await captureError(() =>
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    );

    expect(error).toBeInstanceOf(GitHubIssueHostAdmissionError);
    expect(error).toMatchObject({ code: "repository_dirty" });
    expect(String(error)).not.toContain(secretPath);
  });

  it("rejects a detached checkout", async () => {
    const repository = await createRepository("https://github.com/example/project");
    await execFile((await resolveGit()).path, [
      "-C",
      repository,
      "checkout",
      "--detach",
      "--quiet",
    ]);
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "repository_detached" });
  });

  it("rejects an origin that names a different repository", async () => {
    const repository = await createRepository("ssh://git@github.com/other/project.git");
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "repository_identity_mismatch" });
  });

  it.each([
    ["duplicate origin URL", "remote.origin.url", "https://github.com/other/project.git"],
    ["push URL", "remote.origin.pushurl", "https://github.com/other/project.git"],
    ["receive-pack override", "remote.origin.receivepack", "/tmp/not-a-receive-pack"],
    ["mirror mode", "remote.origin.mirror", "true"],
    ["URL fetch rewrite", "url.https://github.com/other/.insteadOf", "https://github.com/"],
    ["URL push rewrite", "url.https://github.com/other/.pushInsteadOf", "https://github.com/"],
  ])("rejects a repository-local %s during admission", async (_label, key, value) => {
    const repository = await createRepository("https://github.com/example/project.git");
    await execFile((await resolveGit(repository)).path, [
      "-C",
      repository,
      "config",
      "--add",
      key,
      value,
    ]);
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await resolveGit(repository),
    });

    await expect(
      admission.inspect(repository, {
        host: "github.com",
        owner: "example",
        name: "project",
      }),
    ).rejects.toMatchObject({ code: "repository_origin_unsupported" });
  });

  it("rejects a repository that could add Flow runtime evidence to the candidate diff", async () => {
    const repository = await createRepository("https://github.com/example/project", false);
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "flow_runtime_not_ignored" });
  });

  it("accepts a repository that ignores only the actual private issue-run root", async () => {
    const repository = await createRepository(
      "https://github.com/example/project",
      ".flow/issue-runs/\n",
    );
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).resolves.toMatchObject({ flowRuntimeIgnored: true });
  });

  it("rejects an ignore rule that covers only the former synthetic probe", async () => {
    const repository = await createRepository(
      "https://github.com/example/project",
      ".flow/issue-lifecycle-probe\n",
    );
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "flow_runtime_not_ignored" });
  });

  it("rejects tracked content beneath the private issue-run namespace", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const trackedEvidence = join(repository, ".flow", "issue-runs", "known-run", "events.jsonl");
    await mkdir(join(trackedEvidence, ".."), { recursive: true });
    await writeFile(trackedEvidence, "{}\n", "utf8");
    const git = (await resolveGit(repository)).path;
    await execFile(git, ["-C", repository, "add", "--force", trackedEvidence]);
    await execFile(git, ["-C", repository, "commit", "--quiet", "-m", "tracked evidence"]);
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await resolveGit(repository),
    });

    await expect(
      admission.inspect(repository, { host: "github.com", owner: "example", name: "project" }),
    ).rejects.toMatchObject({ code: "flow_runtime_not_ignored" });
  });

  it("rejects a symlinked private issue-run root", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const outside = await temporaryDirectory("flow-git-evidence-outside-");
    await mkdir(join(repository, ".flow"));
    await symlink(outside, join(repository, ".flow", "issue-runs"));
    const git = (await resolveGit(repository)).path;
    await execFile(git, ["-C", repository, "add", "--force", ".flow/issue-runs"]);
    await execFile(git, ["-C", repository, "commit", "--quiet", "-m", "symlink evidence"]);
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await resolveGit(repository),
    });

    await expect(
      admission.inspect(repository, { host: "github.com", owner: "example", name: "project" }),
    ).rejects.toMatchObject({ code: "flow_runtime_not_ignored" });
  });

  it("rejects dirty submodule worktrees", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const submodule = await createRepository("https://github.com/example/submodule");
    const git = (await resolveGit(repository)).path;
    await execFile(git, [
      "-c",
      "protocol.file.allow=always",
      "-C",
      repository,
      "submodule",
      "add",
      "--quiet",
      submodule,
      "vendor/submodule",
    ]);
    await execFile(git, ["-C", repository, "commit", "--quiet", "-am", "add submodule"]);
    await writeFile(join(repository, "vendor", "submodule", "dirty.txt"), "dirty\n", "utf8");
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await resolveGit(repository),
    });

    await expect(
      admission.inspect(repository, { host: "github.com", owner: "example", name: "project" }),
    ).rejects.toMatchObject({ code: "repository_dirty" });
  });

  it("disables repository-configured filesystem monitor commands during admission", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const hostileRoot = await temporaryDirectory("flow-hostile-fsmonitor-");
    const marker = join(hostileRoot, "executed");
    const hook = join(hostileRoot, "hook");
    await writeExecutable(hook, `#!/bin/sh\nprintf executed > '${marker}'\nexit 0\n`);
    await execFile((await resolveGit()).path, ["-C", repository, "config", "core.fsmonitor", hook]);
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        undefined,
      ),
    ).resolves.toMatchObject({ clean: true });
    await expect(readOptional(marker)).resolves.toBeNull();
  });

  it("maps an already-aborted admission to a stable code", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const controller = new AbortController();
    controller.abort(new Error("github_pat_secret"));
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    await expect(
      admission.inspect(
        repository,
        { host: "github.com", owner: "example", name: "project" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "operation_aborted" });
  });

  it("does not let ambient Git variables redirect repository observation", async () => {
    const repository = await createRepository("https://github.com/example/project");
    const attackerRepository = await createRepository("https://github.com/attacker/redirected");
    const previousGitDirectory = process.env.GIT_DIR;
    process.env.GIT_DIR = join(attackerRepository, ".git");
    const admission = new LocalGitRepositoryAdmission({ gitExecutable: await resolveGit() });

    try {
      await expect(
        admission.inspect(
          repository,
          { host: "github.com", owner: "example", name: "project" },
          undefined,
        ),
      ).resolves.toMatchObject({
        origin: { owner: "example", name: "project" },
      });
    } finally {
      if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDirectory;
    }
  });

  it("rejects repository identity drift between the initial and final observations", async () => {
    const repository = await temporaryDirectory("flow-git-drift-project-");
    const host = await temporaryDirectory("flow-git-drift-host-");
    const marker = join(repository, "branch-observed");
    const fakeGit = join(host, "git");
    await writeExecutable(
      fakeGit,
      `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--show-toplevel")) process.stdout.write(${JSON.stringify(`${repository}\n`)});
else if (args.includes("--abbrev-ref")) {
  if (existsSync(${JSON.stringify(marker)})) process.stdout.write("changed-branch\\n");
  else { writeFileSync(${JSON.stringify(marker)}, "seen"); process.stdout.write("main\\n"); }
} else if (args.includes("--verify")) process.stdout.write("${"a".repeat(40)}\\n");
else if (args.includes("config")) process.stdout.write("remote.origin.url\\nhttps://github.com/example/project\\0");
else if (args.includes("status") || args.includes("ls-files")) process.stdout.write("");
else if (args.includes("check-ignore")) process.exit(0);
else process.exit(1);
`,
    );
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await pinGitHubIssueHostExecutable(fakeGit, repository),
    });

    await expect(
      admission.inspect(repository, { host: "github.com", owner: "example", name: "project" }),
    ).rejects.toMatchObject({ code: "command_response_invalid" });
  }, 15_000);

  it("rejects invalid expected identity before invoking Git", async () => {
    const root = await temporaryDirectory("flow-git-admission-invalid-");
    const marker = join(root, "executed");
    const fakeGit = join(root, "git");
    await writeExecutable(fakeGit, `#!/bin/sh\nprintf invoked > '${marker}'\n`);
    const admission = new LocalGitRepositoryAdmission({
      gitExecutable: await pinGitHubIssueHostExecutable(
        fakeGit,
        await temporaryDirectory("flow-git-target-project-"),
      ),
    });

    await expect(
      admission.inspect(
        root,
        { host: "github.com", owner: "owner;touch-pwned", name: "project" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "repository_identity_invalid" });
    await expect(
      admission.inspect(
        root,
        { host: "github.com", owner: "example", name: ".github.git" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "repository_identity_invalid" });
    await expect(readOptional(marker)).resolves.toBeNull();
  });
});

async function createRepository(
  origin: string,
  ignoreFlowRuntime: string | false = ".flow/\n",
): Promise<string> {
  const repository = await temporaryDirectory("flow-git-admission-");
  const git = (await resolveGit(repository)).path;
  await execFile(git, ["init", "--initial-branch=main", repository]);
  await execFile(git, ["-C", repository, "config", "user.email", "flow@example.test"]);
  await execFile(git, ["-C", repository, "config", "user.name", "Flow Test"]);
  await writeFile(join(repository, "README.md"), "# fixture\n", "utf8");
  if (ignoreFlowRuntime) {
    await writeFile(join(repository, ".gitignore"), ignoreFlowRuntime, "utf8");
  }
  await execFile(git, [
    "-C",
    repository,
    "add",
    "README.md",
    ...(ignoreFlowRuntime ? [".gitignore"] : []),
  ]);
  await execFile(git, ["-C", repository, "commit", "--quiet", "-m", "fixture"]);
  await execFile(git, ["-C", repository, "remote", "add", "origin", origin]);
  return repository;
}

async function resolveGit(projectRoot = process.cwd()) {
  const path = (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  return await pinGitHubIssueHostExecutable(path, projectRoot);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: "utf8", mode: 0o700 });
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
