import { describe, expect, it } from "vitest";

import {
  calculateIssuePrivateEvidenceDigest,
  parseIssuePrivateEvidence,
} from "../../../src/domain/issue-lifecycle/private-evidence.js";
import { createIssuePrivateBlobReference } from "../../../src/domain/issue-lifecycle/private-manifest.js";

describe("private issue lifecycle evidence", () => {
  it("parses a typed candidate verification record and freezes detached artifacts", () => {
    const input = evidence();
    const parsed = parseIssuePrivateEvidence(input);

    first(input.artifacts).role = "changed";
    expect(parsed.artifacts[0]?.role).toBe("command-output");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.scope)).toBe(true);
    expect(calculateIssuePrivateEvidenceDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes digest when semantic scope or artifact identity changes", () => {
    const input = evidence();
    expect(
      calculateIssuePrivateEvidenceDigest({
        ...input,
        scope: { ...input.scope, checkId: "typecheck" },
      }),
    ).not.toBe(calculateIssuePrivateEvidenceDigest(input));

    expect(
      calculateIssuePrivateEvidenceDigest({
        ...input,
        artifacts: [{ role: "command-output", blob: blob("different") }],
      }),
    ).not.toBe(calculateIssuePrivateEvidenceDigest(input));
  });

  it("accepts existing workflow-run identity syntax for nested-run provenance", () => {
    const input = evidence();
    expect(() =>
      parseIssuePrivateEvidence({
        ...input,
        kind: "implementation",
        scope: {
          kind: "implementation",
          candidateHead: "a".repeat(40),
          flowRunId: "Nested_Run_01",
          executionWorkflowDigest: "b".repeat(64),
          terminalSequence: 3,
        },
      }),
    ).not.toThrow();
  });

  it("rejects unknown, duplicate, unbounded, and kind-mismatched evidence", () => {
    const input = evidence();
    expect(() => parseIssuePrivateEvidence({ ...input, secret: "x" })).toThrow(/unrecognized/i);
    expect(() =>
      parseIssuePrivateEvidence({
        ...input,
        artifacts: [first(input.artifacts), first(input.artifacts)],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseIssuePrivateEvidence({
        ...input,
        artifacts: Array.from({ length: 33 }, (_, index) => ({
          role: `artifact-${index}`,
          blob: blob(String(index)),
        })),
      }),
    ).toThrow(/32/i);
    expect(() =>
      parseIssuePrivateEvidence({
        ...input,
        kind: "merge-proof",
      }),
    ).toThrow();
  });

  it("rejects artifact references whose declared bytes exceed the run-wide storage ceiling", () => {
    const input = evidence();
    expect(() =>
      parseIssuePrivateEvidence({
        ...input,
        artifacts: Array.from({ length: 9 }, (_, index) => ({
          role: `artifact-${index}`,
          blob: {
            version: 1,
            mediaType: "application/octet-stream",
            byteLength: 33_554_432,
            digest: index.toString(16).padStart(64, "0"),
          },
        })),
      }),
    ).toThrow(/268435456|total/i);
  });
});

function evidence() {
  return {
    version: 1 as const,
    runId: "issue-run-197-aabbccdd",
    recordedAt: "2026-08-28T12:00:00.000Z",
    kind: "verification" as const,
    scope: {
      kind: "verification" as const,
      candidateHead: "a".repeat(40),
      checkId: "test",
      commandDigest: "b".repeat(64),
    },
    artifacts: [{ role: "command-output", blob: blob("output") }],
  };
}

function blob(value: string) {
  return createIssuePrivateBlobReference({
    mediaType: "text/plain; charset=utf-8",
    bytes: new TextEncoder().encode(value),
  });
}

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("test fixture requires one value");
  return value;
}
