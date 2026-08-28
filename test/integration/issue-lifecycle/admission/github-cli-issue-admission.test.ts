import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type PinnedGitHubIssueHostExecutable,
  pinGitHubIssueHostExecutable,
} from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { GitHubCliIssueAdmission } from "../../../../src/infrastructure/github/github-cli-issue-admission.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub CLI issue admission", () => {
  it("returns bounded repository metadata and one open issue using fixed arguments", async () => {
    const fixture = await createFakeGh({ response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    const result = await admission.inspectOpenIssue(
      {
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      },
      undefined,
    );

    expect(result).toEqual({
      repository: {
        host: "github.com",
        owner: "example",
        name: "project",
        nodeId: "R_fixture",
        canonicalUrl: "https://github.com/example/project",
        defaultBranch: "main",
      },
      issue: {
        host: "github.com",
        owner: "example",
        name: "project",
        nodeId: "I_fixture",
        number: 197,
        state: "OPEN",
        title: "Bounded fixture",
        body: "Implement the bounded fixture.",
        updatedAt: "2026-08-28T10:30:00.000Z",
        canonicalUrl: "https://github.com/example/project/issues/197",
      },
    });
    expect((await readFile(fixture.argumentsLog, "utf8")).trim().split("\n")).toEqual([
      JSON.stringify(["auth", "status", "--active", "--hostname", "github.com"]),
      JSON.stringify([
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "--input",
        "-",
      ]),
    ]);
    expect(JSON.parse(await readFile(fixture.stdinLog, "utf8"))).toMatchObject({
      variables: {
        owner: "example",
        name: "project",
        number: 197,
      },
    });
  });

  it("admits a leading-dot repository with exact GitHub response parity", async () => {
    const response = validResponse() as {
      data: {
        repository: {
          name: string;
          url: string;
          issue: { url: string };
        };
      };
    };
    response.data.repository.name = ".github";
    response.data.repository.url = "https://github.com/example/.github";
    response.data.repository.issue.url = "https://github.com/example/.github/issues/197";
    const fixture = await createFakeGh({ response });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: ".github" },
        number: 197,
      }),
    ).resolves.toMatchObject({
      repository: { name: ".github", canonicalUrl: "https://github.com/example/.github" },
      issue: { canonicalUrl: "https://github.com/example/.github/issues/197" },
    });
  });

  it("preserves untrusted issue content as data without executing it", async () => {
    const root = await temporaryDirectory("flow-gh-content-");
    const marker = join(root, "executed");
    const title = `$(touch ${marker})`;
    const body = `; touch ${marker}; github_pat_secret`;
    const fixture = await createFakeGh({ response: validResponse({ title, body }), root });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    const result = await admission.inspectOpenIssue(
      {
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      },
      undefined,
    );

    expect(result.issue).toMatchObject({ title, body });
    await expect(readOptional(marker)).resolves.toBeNull();
  });

  it("does not pass ambient repository selectors to the GitHub CLI", async () => {
    const previousRepository = process.env.GH_REPO;
    const previousModelCommand = process.env.FLOW_MODEL_COMMAND;
    process.env.GH_REPO = "attacker/redirected";
    process.env.FLOW_MODEL_COMMAND = "touch pwned";
    const fixture = await createFakeGh({ response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    try {
      await admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      );
      expect(JSON.parse(await readFile(fixture.environmentLog, "utf8"))).toEqual({});
    } finally {
      if (previousRepository === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previousRepository;
      if (previousModelCommand === undefined) delete process.env.FLOW_MODEL_COMMAND;
      else process.env.FLOW_MODEL_COMMAND = previousModelCommand;
    }
  });

  it("does not pass ambient proxy or certificate configuration to credential-bearing commands", async () => {
    const names = ["ALL_PROXY", "HTTPS_PROXY", "SSL_CERT_DIR", "SSL_CERT_FILE"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) process.env[name] = `attacker-${name.toLowerCase()}`;
    const fixture = await createFakeGh({ response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    try {
      await admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      });
      expect(JSON.parse(await readFile(fixture.environmentLog, "utf8"))).toEqual({});
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects invalid identity before invoking the GitHub CLI", async () => {
    const fixture = await createFakeGh({ response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "owner;rm", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "repository_identity_invalid" });
    await expect(readOptional(fixture.argumentsLog)).resolves.toBeNull();
  });

  it("rejects a failed authentication without retaining command diagnostics", async () => {
    const secret = "github_pat_secret";
    const fixture = await createFakeGh({ authFailure: secret, response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    const error = await captureError(() =>
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    );

    expect(error).toMatchObject({ code: "github_authentication_failed" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("bounds authentication diagnostics without retaining them", async () => {
    const secret = `github_pat_secret${"x".repeat(70_000)}`;
    const fixture = await createFakeGh({ authFailure: secret, response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    const error = await captureError(() =>
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    );

    expect(error).toMatchObject({ code: "command_output_limit_exceeded" });
    expect(String(error)).not.toContain("github_pat_secret");
  });

  it("rejects a closed issue", async () => {
    const fixture = await createFakeGh({
      response: validResponse({ state: "CLOSED" }),
    });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "github_issue_not_open" });
  });

  it("maps a missing repository to a stable repository-not-found code", async () => {
    const fixture = await createFakeGh({ response: { data: { repository: null } } });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      }),
    ).rejects.toMatchObject({ code: "github_repository_not_found" });
  });

  it("maps a missing issue to a stable issue-not-found code", async () => {
    const response = validResponse() as ReturnType<typeof validResponse> & {
      data: { repository: { issue: unknown } };
    };
    response.data.repository.issue = null;
    const fixture = await createFakeGh({ response });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      }),
    ).rejects.toMatchObject({ code: "github_issue_not_found" });
  });

  it("maps a GitHub API command failure without retaining diagnostics", async () => {
    const secret = "github_pat_secret";
    const fixture = await createFakeGh({ apiFailure: secret, response: validResponse() });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    const error = await captureError(() =>
      admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      }),
    );

    expect(error).toMatchObject({ code: "command_failed" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("maps an aborted GitHub admission without invoking the executable", async () => {
    const fixture = await createFakeGh({ response: validResponse() });
    const controller = new AbortController();
    controller.abort(new Error("github_pat_secret"));
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "operation_aborted" });
    await expect(readOptional(fixture.argumentsLog)).resolves.toBeNull();
  });

  it("rejects a replaced GitHub CLI before exposing its credential environment", async () => {
    const fixture = await createFakeGh({ response: validResponse() });
    await writeFile(fixture.executable.path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue({
        repository: { host: "github.com", owner: "example", name: "project" },
        number: 197,
      }),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
    await expect(readOptional(fixture.environmentLog)).resolves.toBeNull();
  });

  it("rejects repository metadata that does not match the requested repository", async () => {
    const response = validResponse() as ReturnType<typeof validResponse> & {
      data: { repository: { owner: { login: string } } };
    };
    response.data.repository.owner.login = "different";
    const fixture = await createFakeGh({ response });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "github_repository_identity_mismatch" });
  });

  it("rejects issue metadata that does not match the requested issue", async () => {
    const response = validResponse() as ReturnType<typeof validResponse> & {
      data: { repository: { issue: { number: number } } };
    };
    response.data.repository.issue.number = 198;
    const fixture = await createFakeGh({ response });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "github_issue_identity_mismatch" });
  });

  it.each(["R node", "R_\u0007node", "R_\u202enode", "x".repeat(257)])(
    "rejects unsafe GitHub node identity %s",
    async (nodeId) => {
      const response = validResponse() as ReturnType<typeof validResponse> & {
        data: { repository: { id: string } };
      };
      response.data.repository.id = nodeId;
      const fixture = await createFakeGh({ response });
      const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

      await expect(
        admission.inspectOpenIssue({
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        }),
      ).rejects.toMatchObject({ code: "command_response_invalid" });
    },
  );

  it("rejects repository metadata without an archival observation", async () => {
    const response = validResponse() as ReturnType<typeof validResponse> & {
      data: { repository: { isArchived?: boolean } };
    };
    delete response.data.repository.isArchived;
    const fixture = await createFakeGh({ response });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "command_response_invalid" });
  });

  it("rejects output that exceeds the fixed response bound", async () => {
    const fixture = await createFakeGh({ rawResponse: "x".repeat(600_000) });
    const admission = new GitHubCliIssueAdmission({ ghExecutable: fixture.executable });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "command_output_limit_exceeded" });
  });

  it("enforces the fixed process deadline", async () => {
    const fixture = await createFakeGh({ response: validResponse() });
    const admission = new GitHubCliIssueAdmission({
      ghExecutable: fixture.executable,
      timeoutMs: 1,
    });

    await expect(
      admission.inspectOpenIssue(
        {
          repository: { host: "github.com", owner: "example", name: "project" },
          number: 197,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "command_timed_out" });
  });
});

interface FakeGhOptions {
  readonly apiFailure?: string;
  readonly authFailure?: string;
  readonly rawResponse?: string;
  readonly response?: unknown;
  readonly root?: string;
}

async function createFakeGh(options: FakeGhOptions): Promise<{
  readonly executable: PinnedGitHubIssueHostExecutable;
  readonly argumentsLog: string;
  readonly environmentLog: string;
  readonly stdinLog: string;
}> {
  const root = options.root ?? (await temporaryDirectory("flow-fake-gh-"));
  const executableDirectory = join(root, "bin");
  await mkdir(executableDirectory);
  const executable = join(executableDirectory, "gh");
  const argumentsLog = join(root, "args.jsonl");
  const environmentLog = join(root, "env.json");
  const stdinLog = join(root, "stdin.json");
  const source = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argumentsLog = ${JSON.stringify(argumentsLog)};
const environmentLog = ${JSON.stringify(environmentLog)};
const stdinLog = ${JSON.stringify(stdinLog)};
appendFileSync(argumentsLog, JSON.stringify(process.argv.slice(2)) + "\\n");
writeFileSync(environmentLog, JSON.stringify({
  ...(process.env.GH_REPO === undefined ? {} : { GH_REPO: process.env.GH_REPO }),
  ...(process.env.GIT_DIR === undefined ? {} : { GIT_DIR: process.env.GIT_DIR }),
  ...(process.env.FLOW_MODEL_COMMAND === undefined ? {} : { FLOW_MODEL_COMMAND: process.env.FLOW_MODEL_COMMAND }),
  ...(process.env.ALL_PROXY === undefined ? {} : { ALL_PROXY: process.env.ALL_PROXY }),
  ...(process.env.HTTPS_PROXY === undefined ? {} : { HTTPS_PROXY: process.env.HTTPS_PROXY }),
  ...(process.env.SSL_CERT_DIR === undefined ? {} : { SSL_CERT_DIR: process.env.SSL_CERT_DIR }),
  ...(process.env.SSL_CERT_FILE === undefined ? {} : { SSL_CERT_FILE: process.env.SSL_CERT_FILE }),
}));
if (process.argv[2] === "auth") {
  ${options.authFailure === undefined ? "process.exit(0);" : `writeFileSync(2, ${JSON.stringify(options.authFailure)}); process.exit(1);`}
}
${options.apiFailure === undefined ? "" : `writeFileSync(2, ${JSON.stringify(options.apiFailure)}); process.exit(1);`}
const input = readFileSync(0, "utf8");
writeFileSync(stdinLog, input);
process.stdout.write(${JSON.stringify(options.rawResponse ?? JSON.stringify(options.response))});
`;
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o700);
  return {
    executable: await pinGitHubIssueHostExecutable(
      executable,
      await temporaryDirectory("flow-gh-project-"),
    ),
    argumentsLog,
    environmentLog,
    stdinLog,
  };
}

function validResponse(
  issue: Partial<{ readonly body: string; readonly state: string; readonly title: string }> = {},
): unknown {
  return {
    data: {
      repository: {
        id: "R_fixture",
        name: "project",
        owner: { login: "example" },
        url: "https://github.com/example/project",
        isArchived: false,
        defaultBranchRef: { name: "main" },
        issue: {
          id: "I_fixture",
          number: 197,
          state: issue.state ?? "OPEN",
          title: issue.title ?? "Bounded fixture",
          body: issue.body ?? "Implement the bounded fixture.",
          updatedAt: "2026-08-28T10:30:00.000Z",
          url: "https://github.com/example/project/issues/197",
        },
      },
    },
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
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
