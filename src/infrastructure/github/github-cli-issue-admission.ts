import { z } from "zod";

import {
  type GitHubIssueAdmissionPort,
  GitHubIssueHostAdmissionError,
  type GitHubOpenIssueObservation,
} from "../../application/github-issue-ports.js";
import { isValidGitHubNodeId } from "../../domain/issue-lifecycle/identity.js";
import { isValidExactGitBranchName } from "../../domain/issue-lifecycle/plan.js";
import type { PinnedGitHubIssueHostExecutable } from "../git/fixed-host-executables.js";
import { assertRepositoryReference } from "../git/local-git-repository-admission.js";
import { runStrictReadProcess, StrictReadProcessError } from "../git/strict-read-process.js";

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_GITHUB_STDOUT_BYTES = 512 * 1_024;
const MAX_GITHUB_STDERR_BYTES = 64 * 1_024;
const nodeIdSchema = z
  .string()
  .refine(isValidGitHubNodeId, "must be a bounded non-whitespace GitHub node identity");
const repositoryNameSchema = z.string().min(1).max(100);
const ownerSchema = z.string().min(1).max(39);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const responseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            id: nodeIdSchema,
            name: repositoryNameSchema,
            owner: z.object({ login: ownerSchema }).strict(),
            url: z.string().url().max(512),
            isArchived: z.boolean(),
            defaultBranchRef: z
              .object({ name: z.string().min(1).max(255) })
              .strict()
              .nullable(),
            ref: z
              .object({
                name: z.string().min(1).max(255),
                target: z.object({ oid: commitSchema }).strict(),
              })
              .strict()
              .nullable(),
            issue: z
              .object({
                id: nodeIdSchema,
                number: z.number().int().positive().max(2_147_483_647),
                state: z.enum(["OPEN", "CLOSED"]),
                title: z.string().min(1).max(512),
                body: z.string().max(262_144),
                updatedAt: z.iso.datetime({ offset: true }),
                url: z.string().url().max(512),
              })
              .strict()
              .nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

const ISSUE_ADMISSION_QUERY = `query FlowIssueAdmission($owner: String!, $name: String!, $number: Int!, $baseRef: String!) {
  repository(owner: $owner, name: $name) {
    id
    name
    owner { login }
    url
    isArchived
    defaultBranchRef { name }
    ref(qualifiedName: $baseRef) { name target { oid } }
    issue(number: $number) {
      id
      number
      state
      title
      body
      updatedAt
      url
    }
  }
}`;

export interface GitHubCliIssueAdmissionOptions {
  readonly ghExecutable: PinnedGitHubIssueHostExecutable;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export class GitHubCliIssueAdmission implements GitHubIssueAdmissionPort {
  readonly #ghExecutable: PinnedGitHubIssueHostExecutable;
  readonly #timeoutMs: number;
  readonly #cwd: string;

  constructor(options: GitHubCliIssueAdmissionOptions) {
    this.#ghExecutable = options.ghExecutable;
    this.#timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
    this.#cwd = options.cwd ?? process.cwd();
  }

  async inspectOpenIssue(
    input: Parameters<GitHubIssueAdmissionPort["inspectOpenIssue"]>[0],
    signal?: AbortSignal,
  ): Promise<GitHubOpenIssueObservation> {
    assertRepositoryReference(input.repository);
    if (!Number.isSafeInteger(input.number) || input.number < 1 || input.number > 2_147_483_647) {
      throw new GitHubIssueHostAdmissionError("github_issue_identity_mismatch");
    }
    if (!isValidExactGitBranchName(input.baseBranch)) {
      throw new GitHubIssueHostAdmissionError("github_repository_identity_mismatch");
    }
    try {
      await this.#gh(["auth", "status", "--active", "--hostname", "github.com"], undefined, signal);
    } catch (error) {
      if (error instanceof StrictReadProcessError) {
        if (error.code === "command_failed") {
          throw new GitHubIssueHostAdmissionError("github_authentication_failed");
        }
        throw new GitHubIssueHostAdmissionError(error.code);
      }
      throw error;
    }

    let source: string;
    try {
      source = await this.#gh(
        ["api", "graphql", "--hostname", "github.com", "--method", "POST", "--input", "-"],
        JSON.stringify({
          query: ISSUE_ADMISSION_QUERY,
          variables: {
            owner: input.repository.owner,
            name: input.repository.name,
            number: input.number,
            baseRef: `refs/heads/${input.baseBranch}`,
          },
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof StrictReadProcessError) {
        throw new GitHubIssueHostAdmissionError(error.code);
      }
      throw error;
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(source));
    } catch {
      throw new GitHubIssueHostAdmissionError("command_response_invalid");
    }
    const repository = parsed.data.repository;
    if (repository === null) {
      throw new GitHubIssueHostAdmissionError("github_repository_not_found");
    }
    if (
      repository.owner.login.toLowerCase() !== input.repository.owner.toLowerCase() ||
      repository.name.toLowerCase() !== input.repository.name.toLowerCase() ||
      repository.url !== `https://github.com/${repository.owner.login}/${repository.name}` ||
      repository.isArchived === true ||
      repository.defaultBranchRef === null ||
      repository.ref === null ||
      repository.ref.name !== input.baseBranch
    ) {
      throw new GitHubIssueHostAdmissionError("github_repository_identity_mismatch");
    }
    const issue = repository.issue;
    if (issue === null) {
      throw new GitHubIssueHostAdmissionError("github_issue_not_found");
    }
    if (issue.number !== input.number) {
      throw new GitHubIssueHostAdmissionError("github_issue_identity_mismatch");
    }
    if (issue.state !== "OPEN") {
      throw new GitHubIssueHostAdmissionError("github_issue_not_open");
    }
    const canonicalIssueUrl = `${repository.url}/issues/${issue.number}`;
    if (issue.url !== canonicalIssueUrl) {
      throw new GitHubIssueHostAdmissionError("github_issue_identity_mismatch");
    }
    return Object.freeze({
      repository: Object.freeze({
        host: "github.com",
        owner: repository.owner.login,
        name: repository.name,
        nodeId: repository.id,
        canonicalUrl: repository.url,
        defaultBranch: repository.defaultBranchRef.name,
        configuredBase: Object.freeze({
          branch: repository.ref.name,
          commit: repository.ref.target.oid,
        }),
      }),
      issue: Object.freeze({
        host: "github.com",
        owner: repository.owner.login,
        name: repository.name,
        nodeId: issue.id,
        number: issue.number,
        state: issue.state,
        title: issue.title,
        body: issue.body,
        updatedAt: issue.updatedAt,
        canonicalUrl: issue.url,
      }),
    });
  }

  async #gh(
    arguments_: readonly string[],
    stdin: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return await runStrictReadProcess({
      executable: this.#ghExecutable,
      arguments: arguments_,
      cwd: this.#cwd,
      environment: githubCliEnvironment(),
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: MAX_GITHUB_STDOUT_BYTES,
      maxStderrBytes: MAX_GITHUB_STDERR_BYTES,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

function githubCliEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GH_HOST: "github.com",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PROMPT_DISABLED: "1",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
  for (const name of [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "XDG_CONFIG_HOME",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}
