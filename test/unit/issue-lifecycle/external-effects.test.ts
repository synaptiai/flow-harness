import { describe, expect, it } from "vitest";

import {
  calculateIssueExternalEffectOperationDigest,
  parseIssueExternalEffectDescriptor,
} from "../../../src/domain/issue-lifecycle/external-effects.js";

describe("issue lifecycle external-effect descriptors", () => {
  it.each([
    workspaceEffect(),
    commitEffect(),
    pushEffect(),
    pullRequestEffect(),
    readyEffect(),
    mergeEffect(),
  ])("parses, freezes, and digests $kind intent", (input) => {
    const parsed = parseIssueExternalEffectDescriptor(input);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(calculateIssueExternalEffectOperationDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses a different digest domain for each effect kind", () => {
    const push = pushEffect();
    const ready = readyEffect();
    expect(calculateIssueExternalEffectOperationDigest(push)).not.toBe(
      calculateIssueExternalEffectOperationDigest(ready),
    );
  });

  it("binds merge intent to the exact approved gate and deletion policy", () => {
    const input = mergeEffect();
    expect(
      calculateIssueExternalEffectOperationDigest({ ...input, gateDigest: "f".repeat(64) }),
    ).not.toBe(calculateIssueExternalEffectOperationDigest(input));
    expect(calculateIssueExternalEffectOperationDigest({ ...input, deleteBranch: false })).not.toBe(
      calculateIssueExternalEffectOperationDigest(input),
    );
  });

  it("binds every effect to the immutable frozen-run manifest", () => {
    const input = pushEffect();
    expect(
      calculateIssueExternalEffectOperationDigest({
        ...input,
        frozenContractDigest: "f".repeat(64),
      }),
    ).not.toBe(calculateIssueExternalEffectOperationDigest(input));
  });

  it("keeps semantic operation identity stable across controller command retries", () => {
    const input = pushEffect();
    expect(
      calculateIssueExternalEffectOperationDigest({
        ...input,
        commandId: "223e4567-e89b-42d3-a456-426614174000",
      }),
    ).toBe(calculateIssueExternalEffectOperationDigest(input));
  });

  it("binds commit intent to the exact isolated workspace", () => {
    const input = commitEffect();
    expect(
      calculateIssueExternalEffectOperationDigest({
        ...input,
        workspaceIdentityDigest: "f".repeat(64),
      }),
    ).not.toBe(calculateIssueExternalEffectOperationDigest(input));
  });

  it.each([
    ["unknown fields", { ...pushEffect(), rawArgv: ["--force"] }],
    ["a non-UUID command", { ...pushEffect(), commandId: "retry" }],
    ["an invalid branch", { ...pushEffect(), branch: "../main" }],
    ["a base/candidate branch collision", { ...pullRequestEffect(), headBranch: "main" }],
    ["a draft-ready mismatch", { ...readyEffect(), isDraft: true }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseIssueExternalEffectDescriptor(input)).toThrow();
  });
});

function common() {
  return {
    version: 1 as const,
    runId: "issue-run-197-aabbccdd",
    commandId: "123e4567-e89b-42d3-a456-426614174000",
    repositoryIdentity: "synaptiai/flow-harness",
    frozenContractDigest: "0".repeat(64),
  };
}

function workspaceEffect() {
  return {
    ...common(),
    kind: "workspace" as const,
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    branch: "flow/issue-197-aabbccdd",
    workspacePathDigest: "1".repeat(64),
  };
}

function commitEffect() {
  return {
    ...common(),
    kind: "commit" as const,
    branch: "flow/issue-197-aabbccdd",
    workspaceIdentityDigest: "1".repeat(64),
    parentCommit: "a".repeat(40),
    candidateTreeDigest: "2".repeat(64),
    messageDigest: "3".repeat(64),
  };
}

function pushEffect() {
  return {
    ...common(),
    kind: "push" as const,
    branch: "flow/issue-197-aabbccdd",
    candidateHead: "b".repeat(40),
    expectedRemoteHead: "a".repeat(40),
  };
}

function pullRequestEffect() {
  return {
    ...common(),
    kind: "pull_request" as const,
    issueNumber: 197,
    issueNodeId: "I_kwDOExample",
    headBranch: "flow/issue-197-aabbccdd",
    headCommit: "b".repeat(40),
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    titleDigest: "4".repeat(64),
    bodyDigest: "5".repeat(64),
    isDraft: true as const,
  };
}

function readyEffect() {
  return {
    ...common(),
    kind: "pull_request_ready" as const,
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_kwDOExample",
    headBranch: "flow/issue-197-aabbccdd",
    headCommit: "b".repeat(40),
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    isDraft: false as const,
  };
}

function mergeEffect() {
  return {
    ...common(),
    kind: "merge" as const,
    pullRequestNumber: 198,
    pullRequestNodeId: "PR_kwDOExample",
    candidateHead: "b".repeat(40),
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    gateDigest: "6".repeat(64),
    method: "squash" as const,
    deleteBranch: true,
  };
}
