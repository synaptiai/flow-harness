import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPinnedGitHubIssueHostExecutableCurrent,
  resolveGitHubIssueHostExecutables,
} from "../../../../src/infrastructure/git/fixed-host-executables.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub issue host executable resolution", () => {
  it("resolves only canonical executable Git and GitHub CLI files", async () => {
    const directory = await createExecutableDirectory(["git", "gh"]);
    const projectRoot = await temporaryDirectory("flow-host-project-");
    const executables = await resolveGitHubIssueHostExecutables({
      projectRoot,
      searchPath: directory,
    });

    expect(executables.git.path).toBe(await realpath(join(directory, "git")));
    expect(executables.gh.path).toBe(await realpath(join(directory, "gh")));
    expect(Object.isFrozen(executables.git)).toBe(true);
    expect(Object.isFrozen(executables.gh)).toBe(true);
  });

  it("does not treat similarly named attacker files as host commands", async () => {
    const directory = await createExecutableDirectory(["git;touch-pwned", "gh;touch-pwned"]);
    const projectRoot = await temporaryDirectory("flow-host-project-");

    await expect(
      resolveGitHubIssueHostExecutables({ projectRoot, searchPath: directory }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("rejects a relative search directory before filesystem lookup", async () => {
    const projectRoot = await temporaryDirectory("flow-host-project-");
    await expect(
      resolveGitHubIssueHostExecutables({ projectRoot, searchPath: "relative/bin" }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("rejects executables contained by the target project", async () => {
    const project = await temporaryDirectory("flow-host-project-");
    const directory = join(project, "bin");
    await mkdir(directory);
    await writeExecutables(directory, ["git", "gh"]);

    await expect(
      resolveGitHubIssueHostExecutables({ projectRoot: project, searchPath: directory }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("rejects group-writable canonical executable directories", async () => {
    const directory = await createExecutableDirectory(["git", "gh"]);
    const projectRoot = await temporaryDirectory("flow-host-project-");
    await chmod(directory, 0o775);

    await expect(
      resolveGitHubIssueHostExecutables({ projectRoot, searchPath: directory }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("admits Homebrew-style group-writable search symlinks to protected canonical targets", async () => {
    const root = await temporaryDirectory("flow-homebrew-");
    const projectRoot = await temporaryDirectory("flow-host-project-");
    const searchDirectory = join(root, "bin");
    const targetDirectory = join(root, "Cellar", "flow-tools", "1.0.0", "bin");
    await mkdir(searchDirectory);
    await mkdir(targetDirectory, { recursive: true });
    await chmod(searchDirectory, 0o775);
    await writeExecutables(targetDirectory, ["git", "gh"]);
    await symlink(join(targetDirectory, "git"), join(searchDirectory, "git"));
    await symlink(join(targetDirectory, "gh"), join(searchDirectory, "gh"));

    const executables = await resolveGitHubIssueHostExecutables({
      projectRoot,
      searchPath: searchDirectory,
    });

    expect(executables.git.path).toBe(await realpath(join(targetDirectory, "git")));
    expect(executables.gh.path).toBe(await realpath(join(targetDirectory, "gh")));
  });

  it("skips missing and unsafe PATH entries before a trusted executable directory", async () => {
    const root = await temporaryDirectory("flow-host-search-");
    const projectRoot = await temporaryDirectory("flow-host-project-");
    const unsafe = join(root, "unsafe");
    const safe = join(root, "safe");
    await mkdir(unsafe);
    await chmod(unsafe, 0o777);
    await mkdir(safe);
    await writeExecutables(safe, ["git", "gh"]);

    const executables = await resolveGitHubIssueHostExecutables({
      projectRoot,
      searchPath: [join(root, "missing"), unsafe, safe].join(delimiter),
    });

    expect(executables.git.path).toBe(await realpath(join(safe, "git")));
    expect(executables.gh.path).toBe(await realpath(join(safe, "gh")));
  });

  it("rejects repository executables when invoked from a nested project directory", async () => {
    const projectRoot = await temporaryDirectory("flow-host-project-");
    const nestedInvocation = join(projectRoot, "packages", "app");
    const repositoryBin = join(projectRoot, "bin");
    await mkdir(nestedInvocation, { recursive: true });
    await mkdir(repositoryBin);
    await writeExecutables(repositoryBin, ["git", "gh"]);

    await expect(
      resolveGitHubIssueHostExecutables({ projectRoot, searchPath: repositoryBin }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("invalidates a pin when its trusted search directory becomes writable", async () => {
    const directory = await createExecutableDirectory(["git", "gh"]);
    const projectRoot = await temporaryDirectory("flow-host-project-");
    const executables = await resolveGitHubIssueHostExecutables({
      projectRoot,
      searchPath: directory,
    });
    await chmod(directory, 0o777);

    await expect(isPinnedGitHubIssueHostExecutableCurrent(executables.gh)).resolves.toBe(false);
  });
});

async function createExecutableDirectory(names: readonly string[]): Promise<string> {
  const directory = await temporaryDirectory("flow-host-executables-");
  await writeExecutables(directory, names);
  return directory;
}

async function writeExecutables(directory: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const path = join(directory, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path, 0o700);
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
