import { describe, expect, it } from "vitest";

import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  MAX_ISSUE_PRIVATE_BLOB_BYTES,
  parseIssuePrivateManifest,
  verifyIssuePrivateBlob,
} from "../../../src/domain/issue-lifecycle/private-manifest.js";

describe("private issue-run manifest", () => {
  it("binds every frozen identity and returns a detached deeply frozen value", () => {
    const input = manifest();
    const parsed = parseIssuePrivateManifest(input);

    input.repository.identity = "attacker/changed";
    expect(parsed.repository.identity).toBe("synaptiai/flow-harness");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.verification)).toBe(true);
    expect(Object.isFrozen(parsed.artifacts.issue)).toBe(true);
    expect(calculateIssuePrivateManifestDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("derives the budget digest from both workflow ceilings and every fixed timeout", () => {
    const input = manifest();
    const original = calculateIssueBudgetDigest(input.budgets);
    const changedWorkflow = structuredClone(input.budgets);
    changedWorkflow.implementation.maxModelTokens += 1;
    const changedCommand = structuredClone(input.budgets);
    first(changedCommand.controller).timeoutMs += 1;

    expect(calculateIssueBudgetDigest(changedWorkflow)).not.toBe(original);
    expect(calculateIssueBudgetDigest(changedCommand)).not.toBe(original);
    expect(() => parseIssuePrivateManifest({ ...input, budgetDigest: "f".repeat(64) })).toThrow(
      /budget digest/i,
    );
  });

  it("canonicalizes set-like manifest fields before digesting", () => {
    const input = manifest();
    const reordered = structuredClone(input);
    reordered.allowedWritePrefixes.reverse();
    reordered.verification.reverse();
    reordered.hostedChecks.reverse();
    reordered.budgets.verification.reverse();
    reordered.budgets.controller.reverse();
    reordered.budgetDigest = calculateIssueBudgetDigest(reordered.budgets);

    expect(calculateIssuePrivateManifestDigest(reordered)).toBe(
      calculateIssuePrivateManifestDigest(input),
    );
  });

  it("preserves the authoritative acceptance-criterion order in the manifest digest", () => {
    const input = manifest();
    const reordered = structuredClone(input);
    reordered.acceptanceCriteria.reverse();

    expect(calculateIssuePrivateManifestDigest(reordered)).not.toBe(
      calculateIssuePrivateManifestDigest(input),
    );
  });

  it("accepts the workflow goal contract's exact criterion identifier bounds", () => {
    const input = manifest();
    expect(() =>
      parseIssuePrivateManifest({
        ...input,
        acceptanceCriteria: [{ id: `a${"b".repeat(95)}`, description: "A complete requirement." }],
      }),
    ).not.toThrow();
    expect(() =>
      parseIssuePrivateManifest({
        ...input,
        acceptanceCriteria: [{ id: `a${"b".repeat(96)}`, description: "A complete requirement." }],
      }),
    ).toThrow(/96/);
  });

  it("binds criterion descriptions and rejects duplicate criterion identities", () => {
    const input = manifest();
    const changed = structuredClone(input);
    first(changed.acceptanceCriteria).description = "A materially different requirement.";

    expect(calculateIssuePrivateManifestDigest(changed)).not.toBe(
      calculateIssuePrivateManifestDigest(input),
    );
    expect(() =>
      parseIssuePrivateManifest({
        ...input,
        acceptanceCriteria: [
          first(input.acceptanceCriteria),
          { id: first(input.acceptanceCriteria).id, description: "Duplicate identity." },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it("creates media-bound, byte-exact private blob references", () => {
    const bytes = new TextEncoder().encode("private issue content");
    const json = createIssuePrivateBlobReference({ mediaType: "application/json", bytes });
    const text = createIssuePrivateBlobReference({ mediaType: "text/plain; charset=utf-8", bytes });

    expect(json).toMatchObject({ version: 1, mediaType: "application/json", byteLength: 21 });
    expect(json.digest).not.toBe(text.digest);
    expect(Object.isFrozen(json)).toBe(true);
    expect(() => verifyIssuePrivateBlob({ mediaType: json.mediaType, bytes }, json)).not.toThrow();
    expect(() =>
      verifyIssuePrivateBlob(
        { mediaType: json.mediaType, bytes: new TextEncoder().encode("different") },
        json,
      ),
    ).toThrow(/reference/i);
    expect(() =>
      createIssuePrivateBlobReference({
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(MAX_ISSUE_PRIVATE_BLOB_BYTES + 1),
      }),
    ).toThrow(String(MAX_ISSUE_PRIVATE_BLOB_BYTES));
  });

  it.each([
    ["unknown field", (value: ReturnType<typeof manifest>) => ({ ...value, extra: true })],
    [
      "unsafe run identifier",
      (value: ReturnType<typeof manifest>) => ({ ...value, runId: "../run" }),
    ],
    [
      "noncanonical base ref",
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        base: { ...value.base, remoteRef: "main" },
      }),
    ],
    [
      "base and candidate branch collision",
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        branch: { ...value.branch, name: value.base.branch },
      }),
    ],
    [
      "duplicate verification identity",
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        verification: [first(value.verification), first(value.verification)],
      }),
    ],
    [
      "unbound verification timeout",
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        verification: value.verification.map((item) => ({ ...item, timeoutMs: 99_999 })),
      }),
    ],
    [
      "a nonexistent calendar timestamp",
      (value: ReturnType<typeof manifest>) => ({
        ...value,
        createdAt: "2026-99-99T12:00:00.000Z",
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => parseIssuePrivateManifest(mutate(manifest()))).toThrowError(
      expect.objectContaining({ name: "IssuePrivateManifestError" }),
    );
  });
});

function manifest() {
  const issue = blob("application/vnd.flow.github-issue+json", "issue");
  const plan = blob("application/vnd.flow.github-issue-plan+yaml", "plan");
  const implementationWorkflow = blob("application/vnd.flow.workflow+yaml", "implementation");
  const reviewWorkflow = blob("application/vnd.flow.workflow+yaml", "review");
  const budgets = {
    implementation: completeBudget(1),
    review: completeBudget(2),
    holdout: { timeoutMs: 120_000 },
    verification: [
      { id: "test", timeoutMs: 300_000 },
      { id: "typecheck", timeoutMs: 120_000 },
    ],
    controller: [
      { id: "git-read", timeoutMs: 30_000 },
      { id: "github-read", timeoutMs: 60_000 },
      { id: "github-write", timeoutMs: 120_000 },
    ],
  };
  return {
    version: 1 as const,
    runId: "issue-run-197-aabbccdd",
    initialCommandId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-08-28T12:00:00.000Z",
    repository: {
      host: "github.com" as const,
      identity: "SynaptiAI/Flow-Harness",
      nodeId: "R_kgDOExample",
      canonicalUrl: "https://github.com/synaptiai/flow-harness",
    },
    issue: {
      number: 197,
      nodeId: "I_kwDOExample",
      state: "open" as const,
      updatedAt: "2026-08-28T11:00:00.000Z",
      canonicalUrl: "https://github.com/synaptiai/flow-harness/issues/197",
      contentDigest: "1".repeat(64),
    },
    base: {
      branch: "main",
      commit: "a".repeat(40),
      remoteRef: "refs/heads/main",
    },
    branch: { prefix: "flow/issue-", name: "flow/issue-197-aabbccdd" },
    planDigest: "2".repeat(64),
    implementationWorkflow: {
      sourceDigest: "3".repeat(64),
      templateWorkflowDigest: "4".repeat(64),
      capabilitySnapshotDigest: "5".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
    },
    reviewWorkflow: {
      sourceDigest: "6".repeat(64),
      templateWorkflowDigest: "7".repeat(64),
      capabilitySnapshotDigest: "8".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
      resultNodeId: "review-result",
    },
    acceptanceCriteria: [
      { id: "criterion-one", description: "The first criterion is met." },
      { id: "criterion-two", description: "The second criterion is met." },
    ],
    allowedWritePrefixes: ["src/", "test/"],
    holdout: { commandDigest: "9".repeat(64), timeoutMs: 120_000 },
    verification: [
      { id: "test", commandDigest: "a".repeat(64), timeoutMs: 300_000 },
      { id: "typecheck", commandDigest: "b".repeat(64), timeoutMs: 120_000 },
    ],
    hostedChecks: [
      { name: "CI / test", sourceApp: { id: 15_368, slug: "github-actions" } },
      { name: "CI / typecheck", sourceApp: { id: 15_368, slug: "github-actions" } },
    ],
    merge: { method: "squash" as const, deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: { issue, plan, implementationWorkflow, reviewWorkflow },
  };
}

function blob(mediaType: string, value: string) {
  return createIssuePrivateBlobReference({ mediaType, bytes: new TextEncoder().encode(value) });
}

function completeBudget(seed: number) {
  return {
    maxNodeStarts: seed * 10,
    maxModelTokens: seed * 1_000,
    maxCostUsdMicros: seed * 100_000,
    maxExecutionMs: seed * 60_000,
    maxArtifactBytes: seed * 1_024,
  };
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("test fixture requires one value");
  return value;
}
