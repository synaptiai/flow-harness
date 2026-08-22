import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ArtifactInspection } from "../../../src/application/artifact-store.js";
import {
  type ArtifactReference,
  createArtifactReference,
} from "../../../src/domain/artifact/reference.js";
import {
  projectReferenceFirstToolResult,
  type ReferenceProjectionIdentity,
} from "../../../src/domain/run/context-compaction.js";

const identity: ReferenceProjectionIdentity = {
  runId: "run-1",
  workflowId: "workflow-1",
  nodeId: "analyze",
  attempt: 1,
};

describe("reference-first context projection", () => {
  it("replaces a large command result only after its same-attempt artifact is available", async () => {
    const fullStdout = "x".repeat(16_384);
    const stdoutArtifact = artifact("stdout", fullStdout);
    const result = await projectReferenceFirstToolResult({
      text: `status: failed\nstdout:\n${"x".repeat(8_192)}\nstderr:\none failed`,
      details: commandOutcome(stdoutArtifact),
      identity,
      minimumOriginalBytes: 1,
      inspectArtifact: async (reference) => inspection(reference, stdoutArtifact),
    });

    expect(result.status).toBe("projected");
    expect(result.reason).toBe("reference_projection");
    expect(result.projectedBytes).toBeLessThan(result.originalBytes);
    expect(result.artifactReferences).toEqual([stdoutArtifact]);
    expect(result.text).not.toContain("x".repeat(1_024));

    const surface = JSON.parse(result.text) as Record<string, unknown>;
    expect(surface).toMatchObject({
      version: 1,
      kind: "flow.reference-tool-result",
      status: "failed",
      error: {
        code: "command_failed",
        message: "command exited with code 1",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: {
        executable: "npm",
        args: ["test"],
        exitCode: 1,
        stderr: { text: "one failed", truncated: false },
        stdout: {
          artifact: {
            reference: stdoutArtifact.reference,
            digest: stdoutArtifact.descriptor.digest,
            size: stdoutArtifact.descriptor.size,
          },
          truncated: true,
        },
      },
    });
  });

  it("does not discover an artifact by parsing display text", async () => {
    const stdoutArtifact = artifact("stdout", "x".repeat(16_384));
    const text = `stdout artifact: ${stdoutArtifact.reference}\n${"x".repeat(8_192)}`;

    const result = await projectReferenceFirstToolResult({
      text,
      details: undefined,
      identity,
      minimumOriginalBytes: 1,
      inspectArtifact: async () => {
        throw new Error("structured details did not authorize inspection");
      },
    });

    expect(result).toMatchObject({
      status: "retained",
      reason: "structured_details_invalid",
      text,
      artifactReferences: [],
    });
  });

  it.each([
    ["cross-run", artifact("stdout", "x".repeat(16_384), { runId: "run-other" })],
    ["cross-attempt", artifact("stdout", "x".repeat(16_384), { attempt: 2 })],
  ])("retains the prior surface for a %s artifact", async (_name, stdoutArtifact) => {
    const text = `status: succeeded\n${"x".repeat(8_192)}`;

    const result = await projectReferenceFirstToolResult({
      text,
      details: commandOutcome(stdoutArtifact),
      identity,
      minimumOriginalBytes: 1,
      inspectArtifact: async (reference) => inspection(reference, stdoutArtifact),
    });

    expect(result).toMatchObject({
      status: "retained",
      reason: "artifact_invalid",
      text,
      artifactReferences: [],
    });
  });

  it.each(["missing", "changed", "pruned"] as const)(
    "retains the prior surface when the artifact is %s",
    async (availability) => {
      const fullStdout = "x".repeat(16_384);
      const stdoutArtifact = artifact("stdout", fullStdout);
      const text = `status: succeeded\n${"x".repeat(8_192)}`;

      const result = await projectReferenceFirstToolResult({
        text,
        details: commandOutcome(stdoutArtifact),
        identity,
        minimumOriginalBytes: 1,
        inspectArtifact: async () => ({
          reference: stdoutArtifact,
          retention: "retained",
          availability,
        }),
      });

      expect(result).toMatchObject({
        status: "retained",
        reason: "artifact_unavailable",
        text,
        artifactReferences: [],
      });
    },
  );

  it("retains a valid projection when the complete replacement is not smaller", async () => {
    const fullStdout = "full output";
    const stdoutArtifact = artifact("stdout", fullStdout, {}, 1);
    const text = "short";

    const result = await projectReferenceFirstToolResult({
      text,
      details: commandOutcome(stdoutArtifact, {
        stdout: "x",
        stdoutRetainedHash: sha256("x"),
        stdoutRetainedBytes: 1,
      }),
      identity,
      minimumOriginalBytes: 1,
      inspectArtifact: async (reference) => inspection(reference, stdoutArtifact),
    });

    expect(result).toMatchObject({
      status: "retained",
      reason: "not_smaller",
      text,
      artifactReferences: [],
    });
    expect(result.projectedBytes).toBeGreaterThanOrEqual(result.originalBytes);
  });
});

function artifact(
  stream: "stdout" | "stderr",
  content: string,
  producerOverride: Partial<ArtifactReference["producer"]> = {},
  retainedBytes = 8_192,
): ArtifactReference {
  if (Buffer.byteLength(content, "utf8") <= retainedBytes) {
    retainedBytes = Buffer.byteLength(content, "utf8") - 1;
  }
  return createArtifactReference({
    descriptor: {
      digest: `sha256:${sha256(content)}`,
      size: Buffer.byteLength(content, "utf8"),
      mediaType: "application/octet-stream",
    },
    producer: {
      kind: "agent-command",
      runId: identity.runId,
      workflowId: identity.workflowId,
      nodeId: identity.nodeId,
      attempt: identity.attempt,
      commandId: "command-1",
      commandSequence: 1,
      stream,
      ...producerOverride,
    },
  });
}

function commandOutcome(
  stdoutArtifact: ArtifactReference,
  overrides: Record<string, unknown> = {},
): unknown {
  const stdout = "x".repeat(8_192);
  return {
    status: "failed",
    error: {
      code: "command_failed",
      message: "command exited with code 1",
      retryable: false,
      sideEffectStatus: "none",
    },
    evidence: {
      kind: "command",
      executable: "npm",
      args: ["test"],
      exitCode: 1,
      signal: null,
      stdout,
      stderr: "one failed",
      stdoutHash: stdoutArtifact.descriptor.digest.slice("sha256:".length),
      stderrHash: sha256("one failed"),
      stdoutRetainedHash: sha256(stdout),
      stderrRetainedHash: sha256("one failed"),
      stdoutRetainedBytes: Buffer.byteLength(stdout),
      stderrRetainedBytes: Buffer.byteLength("one failed"),
      stdoutTruncated: true,
      stderrTruncated: false,
      stdoutArtifact,
      timedOut: false,
      aborted: false,
      durationMs: 5,
      processContainment: "linux-pid-namespace",
      terminationStatus: "not-required",
      sandbox: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "a".repeat(64),
      },
      ...overrides,
    },
  };
}

function inspection(reference: string, artifactReference: ArtifactReference): ArtifactInspection {
  expect(reference).toBe(artifactReference.reference);
  return {
    reference: artifactReference,
    retention: "retained",
    availability: "available",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
