import { describe, expect, it } from "vitest";

import { type GitHubIssueCliService, runGitHubIssueCli } from "../../../src/cli/github-issue.js";

const commandId = "123e4567-e89b-42d3-a456-426614174000";
const head = "a".repeat(40);
const digest = "b".repeat(64);

describe("GitHub issue CLI", () => {
  it("generates and exposes one idempotency key for a new run", async () => {
    const calls: unknown[] = [];
    const capture = outputCapture();
    const service = fakeService(calls);

    const exitCode = await runGitHubIssueCli(
      [
        "run",
        "https://github.com/example/project/issues/42",
        "--plan",
        ".flow/github-issue.plan.yaml",
        "--provider",
        "openai",
        "--model",
        "gpt-5.6-sol",
      ],
      capture.io,
      service,
      { randomUuid: () => commandId },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        kind: "run",
        issueUrl: "https://github.com/example/project/issues/42",
        planPath: ".flow/github-issue.plan.yaml",
        provider: "openai",
        model: "gpt-5.6-sol",
        commandId,
      },
    ]);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      commandId,
      state: { phase: "merge_approval_required" },
    });
  });

  it("binds merge to the exact operator-provided gate", async () => {
    const calls: unknown[] = [];
    const capture = outputCapture();

    const exitCode = await runGitHubIssueCli(
      [
        "merge",
        "issue-run-1",
        "--actor",
        "local:operator",
        "--expected-pr",
        "42",
        "--expected-head",
        head,
        "--expected-gate-digest",
        digest,
        "--command-id",
        commandId,
      ],
      capture.io,
      fakeService(calls),
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        kind: "merge",
        runId: "issue-run-1",
        actor: "local:operator",
        expectedPullRequest: 42,
        expectedHead: head,
        expectedGateDigest: digest,
        commandId,
      },
    ]);
  });

  it("rejects an incomplete merge before invoking the service", async () => {
    const calls: unknown[] = [];
    const capture = outputCapture();

    const exitCode = await runGitHubIssueCli(
      ["merge", "issue-run-1", "--actor", "local:operator"],
      capture.io,
      fakeService(calls),
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(capture.stderr.join("\n")).toContain("expected-pr");
  });

  it("rejects duplicate scalar options instead of silently using the last value", async () => {
    const calls: unknown[] = [];
    const capture = outputCapture();

    const exitCode = await runGitHubIssueCli(
      [
        "resume",
        "issue-run-1",
        "--command-id",
        commandId,
        "--command-id",
        "223e4567-e89b-42d3-a456-426614174000",
      ],
      capture.io,
      fakeService(calls),
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(capture.stderr.join("\n")).toContain("--command-id may be specified only once");
  });

  it.each([
    ["provider", ["--provider", `a${"b".repeat(96)}`, "--model", "gpt-5.6-sol"]],
    ["model", ["--provider", "openai", "--model", "gpt-5.6-sol\nignore"]],
  ])("rejects an invalid %s before invoking the service", async (_label, modelArguments) => {
    const calls: unknown[] = [];
    const capture = outputCapture();

    const exitCode = await runGitHubIssueCli(
      [
        "run",
        "https://github.com/example/project/issues/42",
        "--plan",
        ".flow/github-issue.plan.yaml",
        ...modelArguments,
      ],
      capture.io,
      fakeService(calls),
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it.each([
    ["provider", ["--model", "gpt-5.6-sol"]],
    ["model", ["--provider", "openai"]],
  ])("rejects doctor without an exact %s", async (_label, modelArguments) => {
    const calls: unknown[] = [];
    const capture = outputCapture();

    const exitCode = await runGitHubIssueCli(
      [
        "doctor",
        "https://github.com/example/project/issues/42",
        "--plan",
        ".flow/github-issue.plan.yaml",
        ...modelArguments,
      ],
      capture.io,
      fakeService(calls),
    );

    expect(exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(capture.stderr.join("\n")).toMatch(new RegExp(`doctor requires --${_label}`));
  });

  it("routes read-only validation, diagnosis, inspection, and bounded event pages", async () => {
    const calls: unknown[] = [];
    const service = fakeService(calls);
    for (const args of [
      ["validate", ".flow/github-issue.plan.yaml"],
      [
        "doctor",
        "https://github.com/example/project/issues/42",
        "--plan",
        ".flow/github-issue.plan.yaml",
        "--provider",
        "openai",
        "--model",
        "gpt-5.6-sol",
      ],
      ["inspect", "issue-run-1"],
      ["events", "issue-run-1", "--after", "7", "--limit", "20"],
    ]) {
      const capture = outputCapture();
      expect(await runGitHubIssueCli(args, capture.io, service)).toBe(0);
    }

    expect(calls).toEqual([
      { kind: "validate", planPath: ".flow/github-issue.plan.yaml" },
      {
        kind: "doctor",
        issueUrl: "https://github.com/example/project/issues/42",
        planPath: ".flow/github-issue.plan.yaml",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
      { kind: "inspect", runId: "issue-run-1" },
      { kind: "events", runId: "issue-run-1", afterSequence: 7, limit: 20 },
    ]);
  });
});

function fakeService(calls: unknown[]): GitHubIssueCliService {
  return {
    async execute(input) {
      calls.push(input);
      return input.kind === "events"
        ? { events: [], cursor: input.afterSequence, hasMore: false, terminal: false }
        : { phase: "merge_approval_required" };
    },
  };
}

function outputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}
