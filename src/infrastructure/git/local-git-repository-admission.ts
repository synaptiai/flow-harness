import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  GitHubIssueHostAdmissionError,
  type GitHubRepositoryReference,
  type GitRepositoryAdmissionPort,
  type LocalGitRepositoryObservation,
} from "../../application/github-issue-ports.js";
import { canonicalGitHubRepositoryIdentity } from "../../domain/issue-lifecycle/identity.js";
import { parseExactLocalGitOriginConfiguration } from "./exact-local-git-origin-configuration.js";
import type { PinnedGitHubIssueHostExecutable } from "./fixed-host-executables.js";
import { runStrictReadProcess, StrictReadProcessError } from "./strict-read-process.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_STDOUT_BYTES = 65_536;
const MAX_GIT_STDERR_BYTES = 65_536;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface LocalGitRepositoryAdmissionOptions {
  readonly gitExecutable: PinnedGitHubIssueHostExecutable;
  readonly timeoutMs?: number;
  /** @internal Permits one exact local bare remote for real-repository tests. */
  readonly testOnlyLocalRemotePath?: string;
}

export class LocalGitRepositoryAdmission implements GitRepositoryAdmissionPort {
  readonly #gitExecutable: PinnedGitHubIssueHostExecutable;
  readonly #testOnlyLocalRemotePath: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: LocalGitRepositoryAdmissionOptions) {
    this.#gitExecutable = options.gitExecutable;
    if (
      options.testOnlyLocalRemotePath !== undefined &&
      (!isAbsolute(options.testOnlyLocalRemotePath) ||
        resolve(options.testOnlyLocalRemotePath) !== options.testOnlyLocalRemotePath ||
        options.testOnlyLocalRemotePath.includes("\0"))
    ) {
      throw new Error("test-only local Git remote must be an absolute normalized path");
    }
    this.#testOnlyLocalRemotePath = options.testOnlyLocalRemotePath;
    this.#timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  async inspect(
    invocationRoot: string,
    expectedRepository: GitHubRepositoryReference,
    signal?: AbortSignal,
  ): Promise<LocalGitRepositoryObservation> {
    assertRepositoryReference(expectedRepository);
    if (isSignalAborted(signal)) {
      throw new GitHubIssueHostAdmissionError("operation_aborted");
    }
    let cwd: string;
    try {
      cwd = await realpath(invocationRoot);
    } catch {
      throw new GitHubIssueHostAdmissionError("repository_unavailable");
    }

    try {
      const rootOutput = await this.#git(["rev-parse", "--show-toplevel"], cwd, signal);
      const rootPath = parseSingleLine(rootOutput);
      if (!isAbsolute(rootPath)) {
        throw new GitHubIssueHostAdmissionError("command_response_invalid");
      }
      const root = await realpath(rootPath);
      const initial = await this.#observeRepository(root, signal);
      if (initial.status.length !== 0) {
        throw new GitHubIssueHostAdmissionError("repository_dirty");
      }
      await this.#assertFlowRuntimeIgnored(root, signal);
      const final = await this.#observeRepository(root, signal);
      if (final.status.length !== 0) {
        throw new GitHubIssueHostAdmissionError("repository_dirty");
      }
      if (
        final.branchOutput !== initial.branchOutput ||
        final.headOutput !== initial.headOutput ||
        final.originConfigurationOutput !== initial.originConfigurationOutput
      ) {
        throw new GitHubIssueHostAdmissionError("command_response_invalid");
      }
      const branch = parseSingleLine(final.branchOutput);
      if (branch === "HEAD") {
        throw new GitHubIssueHostAdmissionError("repository_detached");
      }
      const head = parseSingleLine(final.headOutput);
      if (!COMMIT_PATTERN.test(head)) {
        throw new GitHubIssueHostAdmissionError("command_response_invalid");
      }
      let originSource: string;
      try {
        originSource = parseExactLocalGitOriginConfiguration(final.originConfigurationOutput);
      } catch {
        throw new GitHubIssueHostAdmissionError("repository_origin_unsupported");
      }
      const origin =
        this.#testOnlyLocalRemotePath !== undefined &&
        originSource === this.#testOnlyLocalRemotePath
          ? Object.freeze({
              ...expectedRepository,
              canonicalUrl: `https://github.com/${expectedRepository.owner}/${expectedRepository.name}`,
            })
          : parseGitHubOrigin(originSource);
      if (!sameRepository(origin, expectedRepository)) {
        throw new GitHubIssueHostAdmissionError("repository_identity_mismatch");
      }
      return Object.freeze({
        root,
        clean: true,
        flowRuntimeIgnored: true,
        branch,
        head,
        origin,
      });
    } catch (error) {
      if (error instanceof GitHubIssueHostAdmissionError) throw error;
      if (error instanceof StrictReadProcessError) {
        throw new GitHubIssueHostAdmissionError(error.code);
      }
      if (isSignalAborted(signal)) {
        throw new GitHubIssueHostAdmissionError("operation_aborted");
      }
      throw new GitHubIssueHostAdmissionError("repository_unavailable");
    }
  }

  async #git(arguments_: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
    return await runStrictReadProcess({
      executable: this.#gitExecutable,
      arguments: [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...arguments_,
      ],
      cwd,
      environment: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C",
      },
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: MAX_GIT_STDOUT_BYTES,
      maxStderrBytes: MAX_GIT_STDERR_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #observeRepository(
    root: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly status: string;
    readonly branchOutput: string;
    readonly headOutput: string;
    readonly originConfigurationOutput: string;
  }> {
    const branchOutput = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"], root, signal);
    const headOutput = await this.#git(["rev-parse", "--verify", "HEAD"], root, signal);
    const originConfigurationOutput = await this.#git(
      ["config", "--local", "--null", "--list"],
      root,
      signal,
    );
    const status = await this.#git(
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
      root,
      signal,
    );
    return { status, branchOutput, headOutput, originConfigurationOutput };
  }

  async #assertFlowRuntimeIgnored(root: string, signal?: AbortSignal): Promise<void> {
    try {
      const tracked = await this.#git(["ls-files", "--", ".flow/issue-runs"], root, signal);
      if (tracked.length !== 0) {
        throw new GitHubIssueHostAdmissionError("flow_runtime_not_ignored");
      }
      await assertSafeRuntimeAncestry(root);
      await this.#git(
        [
          "check-ignore",
          "--quiet",
          "--no-index",
          "--",
          ".flow/issue-runs/flow-admission-probe/events.jsonl",
        ],
        root,
        signal,
      );
    } catch (error) {
      if (error instanceof StrictReadProcessError && error.code === "command_failed") {
        throw new GitHubIssueHostAdmissionError("flow_runtime_not_ignored");
      }
      throw error;
    }
  }
}

async function assertSafeRuntimeAncestry(root: string): Promise<void> {
  for (const path of [join(root, ".flow"), join(root, ".flow", "issue-runs")]) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new GitHubIssueHostAdmissionError("flow_runtime_not_ignored");
      }
    } catch (error) {
      if (error instanceof GitHubIssueHostAdmissionError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw new GitHubIssueHostAdmissionError("flow_runtime_not_ignored");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function assertRepositoryReference(reference: GitHubRepositoryReference): void {
  if (reference.host !== "github.com") {
    throw new GitHubIssueHostAdmissionError("repository_identity_invalid");
  }
  try {
    canonicalGitHubRepositoryIdentity(`${reference.owner}/${reference.name}`);
  } catch {
    throw new GitHubIssueHostAdmissionError("repository_identity_invalid");
  }
}

function parseSingleLine(output: string): string {
  const value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (
    value.length < 1 ||
    value.length > 4_095 ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0")
  ) {
    throw new GitHubIssueHostAdmissionError("command_response_invalid");
  }
  return value;
}

function parseGitHubOrigin(source: string): GitHubRepositoryReference & {
  readonly canonicalUrl: string;
} {
  let owner: string | undefined;
  let name: string | undefined;
  const scpMatch = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(source);
  if (scpMatch !== null) {
    owner = scpMatch[1];
    name = scpMatch[2];
  } else {
    try {
      const url = new URL(source);
      if (
        (url.protocol !== "https:" && url.protocol !== "ssh:") ||
        url.hostname !== "github.com" ||
        url.port !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        (url.protocol === "https:" && url.username !== "") ||
        (url.protocol === "ssh:" && url.username !== "git") ||
        source.includes("%")
      ) {
        throw new Error("unsupported origin");
      }
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        [owner, name] = segments;
      }
    } catch {
      throw new GitHubIssueHostAdmissionError("repository_origin_unsupported");
    }
  }
  if (name?.endsWith(".git")) name = name.slice(0, -4);
  if (typeof owner !== "string" || typeof name !== "string") {
    throw new GitHubIssueHostAdmissionError("repository_origin_unsupported");
  }
  try {
    assertRepositoryReference({ host: "github.com", owner, name });
  } catch {
    throw new GitHubIssueHostAdmissionError("repository_origin_unsupported");
  }
  return Object.freeze({
    host: "github.com",
    owner,
    name,
    canonicalUrl: `https://github.com/${owner}/${name}`,
  });
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sameRepository(
  observed: GitHubRepositoryReference,
  expected: GitHubRepositoryReference,
): boolean {
  return (
    observed.host === expected.host &&
    observed.owner.toLowerCase() === expected.owner.toLowerCase() &&
    observed.name.toLowerCase() === expected.name.toLowerCase()
  );
}
