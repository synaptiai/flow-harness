import { describe, expect, it } from "vitest";

import {
  calculateIssueLifecycleCommandDigest,
  parseIssueLifecycleCommand,
} from "../../../src/domain/issue-lifecycle/commands.js";

describe("issue lifecycle idempotent commands", () => {
  it.each([runCommand(), resumeCommand(), cancelCommand(), mergeCommand()])(
    "parses, canonicalizes, freezes, and digests $kind commands",
    (input) => {
      const parsed = parseIssueLifecycleCommand(input);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(calculateIssueLifecycleCommandDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("canonicalizes an admitted issue URL and repository casing", () => {
    const canonical = parseIssueLifecycleCommand(runCommand());
    const mixed = parseIssueLifecycleCommand({
      ...runCommand(),
      issueUrl: "https://github.com/SynaptiAI/Flow-Harness/issues/197/",
    });

    expect(mixed).toMatchObject({
      issueUrl: "https://github.com/synaptiai/flow-harness/issues/197",
      repositoryIdentity: "synaptiai/flow-harness",
    });
    expect(calculateIssueLifecycleCommandDigest(mixed)).toBe(
      calculateIssueLifecycleCommandDigest(canonical),
    );
  });

  it("makes byte-equivalent retries stable and changed input conflicting", () => {
    const first = mergeCommand();
    expect(calculateIssueLifecycleCommandDigest(structuredClone(first))).toBe(
      calculateIssueLifecycleCommandDigest(first),
    );
    expect(
      calculateIssueLifecycleCommandDigest({ ...first, expectedHead: "f".repeat(40) }),
    ).not.toBe(calculateIssueLifecycleCommandDigest(first));
  });

  it.each([
    ["uppercase UUID", { ...resumeCommand(), commandId: resumeCommand().commandId.toUpperCase() }],
    ["nil UUID", { ...resumeCommand(), commandId: "00000000-0000-0000-0000-000000000000" }],
    ["unknown input", { ...resumeCommand(), force: true }],
    ["unsafe actor", { ...cancelCommand(), actor: " operator " }],
    ["empty reason", { ...cancelCommand(), reason: "" }],
    ["unsafe pull request number", { ...mergeCommand(), expectedPullRequest: 0 }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseIssueLifecycleCommand(input)).toThrow();
  });
});

function runCommand() {
  return {
    version: 1 as const,
    kind: "run" as const,
    commandId: "123e4567-e89b-42d3-a456-426614174000",
    issueUrl: "https://github.com/synaptiai/flow-harness/issues/197",
    repositoryIdentity: "synaptiai/flow-harness",
    planDigest: "a".repeat(64),
    provider: "openai",
    model: "gpt-5.6-sol",
  };
}

function resumeCommand() {
  return {
    version: 1 as const,
    kind: "resume" as const,
    commandId: "223e4567-e89b-42d3-a456-426614174000",
    runId: "issue-run-197-aabbccdd",
  };
}

function cancelCommand() {
  return {
    version: 1 as const,
    kind: "cancel" as const,
    commandId: "323e4567-e89b-42d3-a456-426614174000",
    runId: "issue-run-197-aabbccdd",
    actor: "local:operator",
    reason: "operator stopped the run",
  };
}

function mergeCommand() {
  return {
    version: 1 as const,
    kind: "merge" as const,
    commandId: "423e4567-e89b-42d3-a456-426614174000",
    runId: "issue-run-197-aabbccdd",
    actor: "local:operator",
    expectedPullRequest: 198,
    expectedHead: "b".repeat(40),
    expectedGateDigest: "c".repeat(64),
  };
}
