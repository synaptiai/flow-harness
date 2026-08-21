import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { createSemanticQueryReceipt } from "../../../src/domain/semantic/semantic-code.js";

describe("semantic receipt replay", () => {
  it("retains canonical semantic receipts in terminal agent evidence", () => {
    const receipt = semanticReceipt(1);

    const state = reduceRunEvents(events([receipt]));

    expect(state.nodes.analyze?.evidence).toMatchObject({
      kind: "agent",
      semanticReceipts: [receipt],
    });
  });

  it("rejects forged content and noncontiguous semantic receipt sequences", () => {
    const receipt = semanticReceipt(1);
    const forged = {
      ...receipt,
      result: {
        operation: "hover" as const,
        hover: {
          path: "src/example.ts",
          range: range(0, 0, 0, 1),
          format: "plaintext" as const,
          value: "PRIVATE_FORGED_RESULT",
        },
      },
    };

    expect(() => reduceRunEvents(events([forged]))).toThrow(/semantic receipt is invalid/i);
    expect(() => reduceRunEvents(events([semanticReceipt(1), semanticReceipt(3)]))).toThrow(
      /semantic receipt sequence must be contiguous/i,
    );
  });
});

function events(semanticReceipts: readonly unknown[]): RunEvent[] {
  return [
    {
      ...base(1),
      type: "run_started",
      nodeIds: ["analyze"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "e".repeat(64),
    },
    { ...base(2), type: "node_started", nodeId: "analyze", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "analyze",
      attempt: 1,
      evidence: {
        kind: "agent",
        provider: "test",
        model: "deterministic",
        text: "done",
        textHash: sha256("done"),
        textTruncated: false,
        durationMs: 1,
        policyDecisions: [],
        effectReceipts: [],
        semanticReceipts,
      },
    },
  ] as RunEvent[];
}

function semanticReceipt(sequence: number) {
  return createSemanticQueryReceipt({
    sequence,
    request: {
      operation: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    },
    projectDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    languageServerDigest: "c".repeat(64),
    sandbox: {
      backend: "sandbox-runtime",
      backendVersion: "1.2.3",
      profile: "workspace-readonly-network-deny-v1",
      policyDigest: "d".repeat(64),
    },
    result: { operation: "hover", hover: null },
  });
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-21T15:00:0${sequence}.000Z`,
    runId: "semantic-run",
    workflowId: "semantic-workflow",
  };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
