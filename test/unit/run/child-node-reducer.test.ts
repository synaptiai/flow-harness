import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type ChildEvidence,
  calculateChildRunId,
  parseRunEvent,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";

describe("durable child run replay", () => {
  it("replays an exact child link, typed result, cleanup outcome, and resource import", () => {
    const state = reduceRunEvents(successfulEvents());

    expect(state).toMatchObject({
      status: "succeeded",
      resources: {
        nodeStarts: 3,
        modelTokens: 30,
        modelCostUsdMicros: 400,
        executionMs: 25,
        artifactBytes: 50,
      },
      nodes: {
        delegate: {
          status: "succeeded",
          childRun: childLink,
          evidence: {
            kind: "child",
            outcome: "succeeded",
            result: {
              nodeId: "publish",
              canonicalValue: "true",
              valueHash: sha256("true"),
            },
            workspace: {
              backend: "reflink-copy-v1",
              snapshotDigest: "a".repeat(64),
              disposition: "discarded",
            },
          },
        },
      },
    });
  });

  it("parses the bounded child link and evidence contracts", () => {
    expect(parseRunEvent(started())).toMatchObject({
      controlGraph: { nodes: [expect.objectContaining({ type: "child" })] },
    });
    expect(parseRunEvent(nodeStarted(2))).toMatchObject({
      type: "node_started",
      child: childLink,
    });
    expect(parseRunEvent(nodeSucceeded(3))).toMatchObject({
      evidence: { kind: "child", childRunId: childLink.runId },
    });
  });

  it.each([
    ["run id", { runId: "child-forged" }, /child.*link|run id/i],
    ["workflow digest", { workflowDigest: "f".repeat(64) }, /child.*link|workflow digest/i],
    ["result schema", { resultSchemaDigest: "f".repeat(64) }, /child.*link|schema/i],
  ])("rejects a start with a forged child %s", (_name, change, error) => {
    expect(() =>
      reduceRunEvents([
        started(),
        { ...nodeStarted(2), child: { ...childLink, ...change } },
      ] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it.each([
    ["run id", { childRunId: "child-forged" }, /child.*evidence|run id/i],
    [
      "canonical result",
      { result: { ...childResult, canonicalValue: "false" } },
      /canonical|hash/i,
    ],
    ["result hash", { result: { ...childResult, valueHash: "f".repeat(64) } }, /hash/i],
    [
      "negative resources",
      { resources: { ...childResources, nodeStarts: -1 } },
      /greater than or equal to 0|resource/i,
    ],
  ])("rejects child evidence with a forged %s", (_name, change, error) => {
    expect(() =>
      reduceRunEvents([
        started(),
        nodeStarted(2),
        {
          ...nodeSucceeded(3),
          evidence: { ...childEvidence, ...change },
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it.each([
    [
      "retained workspace without a cleanup failure",
      "child_run_failed",
      { outcome: "failed", workspace: { ...childEvidence.workspace, disposition: "retained" } },
    ],
    [
      "cleanup failure with a discarded workspace",
      "child_workspace_cleanup_failed",
      { outcome: "failed", workspace: childEvidence.workspace },
    ],
    [
      "terminal outcome that disagrees with the failure code",
      "child_run_failed",
      { outcome: "cancelled", workspace: childEvidence.workspace },
    ],
  ])("rejects a forged %s", (_name, errorCode, change) => {
    expect(() =>
      reduceRunEvents([
        started(),
        nodeStarted(2),
        nodeFailed(3, errorCode, { ...childEvidence, ...change } as ChildEvidence),
      ] as unknown as RunEvent[]),
    ).toThrowError(/child.*(cleanup|outcome|failure)|workspace.*disposition/i);
  });
});

const childSchemaDigest = sha256('{"type":"boolean"}');
const childLink = {
  runId: calculateChildRunId("parent-run", "delegate", 1),
  workflowId: "child-analysis",
  workflowDigest: "c".repeat(64),
  resultNodeId: "publish",
  resultSchemaDigest: childSchemaDigest,
  isolationBackend: "reflink-copy-v1",
} as const;
const childResult = {
  nodeId: "publish",
  schemaDigest: childSchemaDigest,
  canonicalValue: "true",
  valueHash: sha256("true"),
} as const;
const childResources = {
  nodeStarts: 2,
  modelTokens: 30,
  modelCostUsdMicros: 400,
  executionMs: 25,
  artifactBytes: 50,
} as const;
const childEvidence = {
  kind: "child" as const,
  childRunId: childLink.runId,
  workflowId: childLink.workflowId,
  workflowDigest: childLink.workflowDigest,
  terminalSequence: 6,
  outcome: "succeeded" as const,
  result: childResult,
  resources: childResources,
  durationMs: 20,
  workspace: {
    backend: childLink.isolationBackend,
    snapshotDigest: "a".repeat(64),
    disposition: "discarded" as const,
  },
};

function successfulEvents(): RunEvent[] {
  return [
    started(),
    nodeStarted(2),
    nodeSucceeded(3),
    { ...base(4), type: "run_succeeded" },
  ] as unknown as RunEvent[];
}

function started() {
  return {
    ...base(1),
    type: "run_started" as const,
    nodeIds: ["delegate"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1" as const,
    workflowDigest: "d".repeat(64),
    controlGraph: {
      nodes: [
        {
          nodeId: "delegate",
          type: "child" as const,
          dependsOn: [],
          child: {
            workflowId: childLink.workflowId,
            workflowDigest: childLink.workflowDigest,
            resultNodeId: childLink.resultNodeId,
            resultSchema: { type: "boolean" as const },
            resultSchemaDigest: childLink.resultSchemaDigest,
          },
        },
      ],
    },
  };
}

function nodeStarted(sequence: number) {
  return {
    ...base(sequence),
    type: "node_started" as const,
    nodeId: "delegate",
    attempt: 1,
    child: childLink,
  };
}

function nodeSucceeded(sequence: number) {
  return {
    ...base(sequence),
    type: "node_succeeded" as const,
    nodeId: "delegate",
    attempt: 1,
    evidence: childEvidence,
  };
}

function nodeFailed(sequence: number, code: string, evidence: ChildEvidence) {
  return {
    ...base(sequence),
    type: "node_failed" as const,
    nodeId: "delegate",
    attempt: 1,
    error: {
      code,
      message: "forged child failure",
      retryable: false,
      sideEffectStatus: "none" as const,
    },
    evidence,
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T00:00:0${sequence}.000Z`,
    runId: "parent-run",
    workflowId: "parent-workflow",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
