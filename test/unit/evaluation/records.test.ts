import { describe, expect, it } from "vitest";

import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import {
  createEvaluationTrialRecord,
  parseAcpQualificationObservation,
  parseDelegationEvaluationObservation,
  parseEvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";

const planDigest = "a".repeat(64);
const schedule = createEvaluationSchedule(planDigest, ["task"], ["baseline", "candidate"], [11]);

describe("evaluation trial records", () => {
  it("rejects ACP qualification observations with false usage or sandbox provenance", () => {
    const observation = {
      version: 1 as const,
      workflowDigest: "1".repeat(64),
      capabilitySnapshotDigest: "2".repeat(64),
      agent: { name: "qualified-agent", digest: "3".repeat(64) },
      result: { sha256: "4".repeat(64), bytes: 4 },
      durationMs: 12,
      activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
      policyViolations: 0,
      terminationStatus: "confirmed" as const,
      processContainment: "linux-pid-namespace" as const,
      sandbox: {
        backend: "test-sandbox",
        backendVersion: "1.0.0",
        profile: "acp-prompt-only-v1",
        policyDigest: "5".repeat(64),
      },
      usage: {
        modelTokens: { status: "complete" as const, totalTokens: 8 },
        costUsd: { status: "complete" as const, costUsdMicros: 12 },
      },
      usageProvenance: {
        modelTokens: "prompt-response" as const,
        costUsd: "session-usage-update" as const,
      },
    };

    expect(parseAcpQualificationObservation(observation)).toEqual(observation);
    expect(() =>
      parseAcpQualificationObservation({
        ...observation,
        usageProvenance: { ...observation.usageProvenance, modelTokens: "not-observed" },
      }),
    ).toThrow(/token provenance/i);
    expect(() =>
      parseAcpQualificationObservation({
        ...observation,
        sandbox: { ...observation.sandbox, profile: "other-profile" },
      }),
    ).toThrow(/prompt-only sandbox/i);
  });

  it("rejects contradictory or falsely complete delegation observations", () => {
    const observation = delegationObservation();

    expect(parseDelegationEvaluationObservation(observation)).toEqual(observation);
    expect(() =>
      parseDelegationEvaluationObservation({
        ...observation,
        mode: "baseline",
        authority: null,
      }),
    ).toThrow(/baseline.*invocation/i);
    expect(() =>
      parseDelegationEvaluationObservation({
        ...observation,
        invocation: {
          ...observation.invocation,
          child: {
            ...observation.invocation.child,
            resourceAvailability: {
              modelTokens: "unavailable",
              modelCostUsdMicros: "complete",
            },
          },
        },
      }),
    ).toThrow(/resource.*complete|complete.*resource/i);
  });

  it("classifies every terminal harness and verifier outcome without dropping failures", () => {
    const accepted = record(
      { outcome: "completed", runId: "run-accepted", reason: null },
      {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
    );
    expect(accepted.classification).toBe("verified_success");

    const rejected = record(
      { outcome: "completed", runId: "run-rejected", reason: null },
      {
        outcome: "rejected",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: false }],
      },
    );
    expect(rejected.classification).toBe("false_completion");

    const verifierError = record(
      { outcome: "completed", runId: "run-verifier-error", reason: null },
      {
        outcome: "error",
        verifierDigest: "b".repeat(64),
        assertions: [],
        reason: "workspace identity mismatch",
      },
    );
    expect(verifierError.classification).toBe("verifier_error");

    for (const outcome of [
      "failed",
      "timed_out",
      "crashed",
      "cancelled",
      "malformed_output",
      "missing_output",
    ] as const) {
      expect(
        record(
          { outcome, runId: null, reason: `${outcome} evidence` },
          { outcome: "not_run", verifierDigest: "b".repeat(64), assertions: [] },
        ),
      ).toMatchObject({ classification: "harness_failure", harness: { outcome } });
    }
  });

  it("rejects contradictory, temporally invalid, and tampered evidence", () => {
    expect(() =>
      record(
        { outcome: "completed", runId: "run-empty-accepted", reason: null },
        { outcome: "accepted", verifierDigest: "b".repeat(64), assertions: [] },
      ),
    ).toThrow(/accepted.*assertion|assertion.*accepted/i);
    expect(() =>
      record(
        { outcome: "completed", runId: "run-false-accepted", reason: null },
        {
          outcome: "accepted",
          verifierDigest: "b".repeat(64),
          assertions: [{ kind: "exists", path: "RESULT.md", outcome: false }],
        },
      ),
    ).toThrow(/accepted.*pass|pass.*accepted/i);
    expect(() =>
      record(
        { outcome: "completed", runId: "run-empty-rejected", reason: null },
        { outcome: "rejected", verifierDigest: "b".repeat(64), assertions: [] },
      ),
    ).toThrow(/rejected.*assertion|assertion.*rejected/i);
    expect(() =>
      record(
        { outcome: "completed", runId: "run-unexplained-error", reason: null },
        { outcome: "error", verifierDigest: "b".repeat(64), assertions: [] },
      ),
    ).toThrow(/error.*reason|reason.*error/i);
    expect(() =>
      record(
        { outcome: "completed", runId: null, reason: null },
        { outcome: "accepted", verifierDigest: "b".repeat(64), assertions: [] },
      ),
    ).toThrow(/run id/i);
    expect(() =>
      record(
        { outcome: "failed", runId: null, reason: "failed" },
        { outcome: "accepted", verifierDigest: "b".repeat(64), assertions: [] },
      ),
    ).toThrow(/not-run/i);

    const valid = record(
      { outcome: "completed", runId: "run-valid", reason: null },
      {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
    );
    expect(() => parseEvaluationTrialRecord({ ...valid, recordDigest: "c".repeat(64) })).toThrow(
      /digest/i,
    );
    expect(() =>
      createEvaluationTrialRecord({
        ...recordInput(),
        startedAt: "2026-08-09T10:00:02.000Z",
        completedAt: "2026-08-09T10:00:01.000Z",
        harness: { outcome: "failed", runId: null, reason: "failed" },
        verification: { outcome: "not_run", verifierDigest: "b".repeat(64), assertions: [] },
      }),
    ).toThrow(/precedes/i);
    expect(() =>
      createEvaluationTrialRecord({
        ...recordInput(),
        harness: { outcome: "failed", runId: null, reason: "failed" },
        verification: { outcome: "not_run", verifierDigest: "b".repeat(64), assertions: [] },
        metrics: { ...unavailableEvaluationMetrics(), toolCalls: 1, toolErrors: 2 },
      }),
    ).toThrow(/tool errors/i);
    expect(() =>
      createEvaluationTrialRecord({
        ...recordInput(),
        harness: { outcome: "failed", runId: null, reason: "failed" },
        verification: { outcome: "not_run", verifierDigest: "b".repeat(64), assertions: [] },
        metrics: {
          ...unavailableEvaluationMetrics(),
          recoveryAttempts: 0,
          recoveryOutcome: "succeeded",
        },
      }),
    ).toThrow(/recovery/i);
    expect(() =>
      createEvaluationTrialRecord({
        ...recordInput(),
        harness: { outcome: "failed", runId: null, reason: "failed" },
        verification: { outcome: "not_run", verifierDigest: "b".repeat(64), assertions: [] },
        metrics: {
          ...unavailableEvaluationMetrics(),
          recoveryAttempts: 1,
          recoveryOutcome: "not_attempted",
        },
      }),
    ).toThrow(/recovery/i);
    expect(() =>
      createEvaluationTrialRecord({
        ...recordInput(),
        environment: { ...recordInput().environment, workspaceSnapshotDigest: null },
        harness: { outcome: "completed", runId: "run-without-snapshot", reason: null },
        verification: {
          outcome: "accepted",
          verifierDigest: "b".repeat(64),
          assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
        },
      }),
    ).toThrow(/workspace.*snapshot|snapshot.*completed/i);
  });

  it("binds parent-observed external process termination evidence", () => {
    const valid = record(
      {
        outcome: "completed",
        runId: "pi-run",
        reason: null,
        runtime: {
          adapter: "pi-native-v1",
          containment: "linux-pid-namespace",
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          treeTermination: "confirmed",
        },
      },
      {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
    );

    expect(valid.harness.runtime).toMatchObject({
      adapter: "pi-native-v1",
      exitCode: 0,
      treeTermination: "confirmed",
    });
    expect(() =>
      record(
        {
          outcome: "completed",
          runId: "pi-run",
          reason: null,
          runtime: {
            adapter: "pi-native-v1",
            containment: "process-group",
            exitCode: null,
            signal: "SIGKILL",
            timedOut: true,
            aborted: false,
            treeTermination: "unconfirmed",
          },
        },
        {
          outcome: "accepted",
          verifierDigest: "b".repeat(64),
          assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
        },
      ),
    ).toThrow(/completed.*process|process.*completed|termination/i);
  });

  it("binds parent-observed Prime OCI settlement evidence", () => {
    const valid = record(
      {
        outcome: "completed",
        runId: "prime-run",
        reason: null,
        runtime: {
          adapter: "prime-agent-native-v1",
          containment: "docker-oci-v1",
          engineStatus: "verified",
          imageId: `sha256:${"c".repeat(64)}`,
          policyDigest: "d".repeat(64),
          exitCode: 0,
          timedOut: false,
          aborted: false,
          recoveryOutcome: "not_attempted",
          removal: "confirmed",
        },
      },
      {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
    );

    expect(valid.harness.runtime).toMatchObject({
      adapter: "prime-agent-native-v1",
      containment: "docker-oci-v1",
      engineStatus: "verified",
      exitCode: 0,
      recoveryOutcome: "not_attempted",
      removal: "confirmed",
    });
    expect(() =>
      record(
        {
          outcome: "completed",
          runId: "prime-run",
          reason: null,
          runtime: {
            adapter: "prime-agent-native-v1",
            containment: "docker-oci-v1",
            engineStatus: "verified",
            imageId: `sha256:${"c".repeat(64)}`,
            policyDigest: "d".repeat(64),
            exitCode: 0,
            timedOut: false,
            aborted: false,
            recoveryOutcome: "failed",
            removal: "unconfirmed",
          },
        },
        {
          outcome: "accepted",
          verifierDigest: "b".repeat(64),
          assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
        },
      ),
    ).toThrow(/completed.*removal|removal.*completed/i);
  });
});

function record(
  harness: Parameters<typeof createEvaluationTrialRecord>[0]["harness"],
  verification: Parameters<typeof createEvaluationTrialRecord>[0]["verification"],
) {
  return createEvaluationTrialRecord({ ...recordInput(), harness, verification });
}

function recordInput() {
  const item = schedule[0];
  if (item === undefined) {
    throw new Error("missing test schedule");
  }
  return {
    schedule: item,
    planDigest,
    previousDigest: null,
    startedAt: "2026-08-09T10:00:00.000Z",
    completedAt: "2026-08-09T10:00:01.000Z",
    environment: {
      platform: "linux" as const,
      architecture: "x64",
      nodeVersion: "v22.19.0",
      flowVersion: "0.0.0",
      workspaceBackend: "reflink-copy-v1" as const,
      workspaceSnapshotDigest: "d".repeat(64),
    },
    metrics: unavailableEvaluationMetrics(),
  };
}

function delegationObservation() {
  return {
    version: 1 as const,
    mode: "candidate" as const,
    workflowDigest: "1".repeat(64),
    packageClosureDigest: "2".repeat(64),
    manager: { nodeId: "manager", attempt: 1, outcome: "succeeded" as const },
    authority: {
      candidateDigest: "3".repeat(64),
      snapshotDigest: "4".repeat(64),
      executorIdentityDigest: "5".repeat(64),
      maxDepth: 1 as const,
      maxCalls: 1 as const,
    },
    invocation: {
      count: 1 as const,
      prepared: true,
      settled: true,
      receipt: true,
      child: {
        runId: "child-run",
        workflowId: "child-workflow",
        workflowDigest: "6".repeat(64),
        resultNodeId: "result",
        resultSchemaDigest: "7".repeat(64),
        resultValueHash: "8".repeat(64),
        terminalSequence: 4,
        outcome: "succeeded" as const,
        resources: {
          nodeStarts: 2,
          modelTokens: 20,
          modelCostUsdMicros: 10,
          executionMs: 30,
          artifactBytes: 4,
        },
        durationMs: 25,
        workspaceDisposition: "discarded" as const,
      },
    },
    constraints: { complete: true, violations: [] },
  };
}
