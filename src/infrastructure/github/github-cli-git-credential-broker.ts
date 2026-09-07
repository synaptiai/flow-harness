import type { PinnedGitHubIssueHostExecutable } from "../git/fixed-host-executables.js";
import { StrictHostProcess } from "../git/strict-host-process.js";
import { githubCliEnvironment } from "./github-cli-issue-lifecycle-adapter.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOKEN_BYTES = 8_192;
const MAX_STDERR_BYTES = 65_536;

export type GitHubCliGitCredentialBrokerErrorCode =
  | "authentication_failed"
  | "operation_aborted"
  | "token_invalid";

export class GitHubCliGitCredentialBrokerError extends Error {
  override readonly name = "GitHubCliGitCredentialBrokerError";

  constructor(readonly code: GitHubCliGitCredentialBrokerErrorCode) {
    super(`GitHub CLI Git credential admission failed: ${code}`);
  }
}

export interface GitHubGitCredentialBroker {
  authorizationHeader(signal?: AbortSignal): Promise<string>;
}

export interface GitHubCliGitCredentialBrokerOptions {
  readonly ghExecutable: PinnedGitHubIssueHostExecutable;
  readonly timeoutMs?: number;
}

/** Projects the active GitHub CLI token into one in-memory HTTPS authorization header. */
export class GitHubCliGitCredentialBroker implements GitHubGitCredentialBroker {
  readonly #process: StrictHostProcess;

  constructor(options: GitHubCliGitCredentialBrokerOptions) {
    this.#process = new StrictHostProcess({
      executable: options.ghExecutable,
      environment: githubCliEnvironment(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStdoutBytes: MAX_TOKEN_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
  }

  async authorizationHeader(signal?: AbortSignal): Promise<string> {
    const result = await this.#process.run({
      cwd: "/",
      arguments: ["auth", "token", "--hostname", "github.com"],
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.termination === "abort") {
      throw new GitHubCliGitCredentialBrokerError("operation_aborted");
    }
    if (result.termination !== "exit" || result.exitCode !== 0) {
      throw new GitHubCliGitCredentialBrokerError("authentication_failed");
    }
    const token = parseToken(result.stdout);
    const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    return `Authorization: Basic ${encoded}`;
  }
}

function parseToken(output: Buffer): string {
  if (
    output.byteLength < 2 ||
    output.byteLength > MAX_TOKEN_BYTES ||
    output.includes(0) ||
    output.includes(13)
  ) {
    throw new GitHubCliGitCredentialBrokerError("token_invalid");
  }
  const source = output.toString("utf8");
  const token = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (
    token.length === 0 ||
    token.includes("\n") ||
    token !== token.trim() ||
    /[\p{Cc}\p{Cf}\s]/u.test(token)
  ) {
    throw new GitHubCliGitCredentialBrokerError("token_invalid");
  }
  return token;
}
