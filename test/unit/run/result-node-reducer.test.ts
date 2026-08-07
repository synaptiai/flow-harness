import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRunEvent, reduceRunEvents, type RunEvent } from "../../../src/domain/run/events.js";
import {
  calculateResultSchemaDigest,
  resultSourceTruncationMessage,
} from "../../../src/domain/result/typed-result.js";
import type { CompiledResultSchema } from "../../../src/domain/workflow/types.js";

describe("durable typed result replay", () => {
  it("reconstructs a resource-neutral result bound to source and schema identity", () => {
    const state = reduceRunEvents(successfulEvents());

    expect(state).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 1, modelTokens: 0 },
      nodes: {
        publish: {
          status: "succeeded",
          attempt: 1,
          evidence: null,
          control: {
            kind: "result",
            sourceNodeId: "produce",
            sourceAttempt: 1,
            sourceField: "command.stdout",
            sourceHash: sha256('{ "ok": true }'),
            schemaDigest: calculateResultSchemaDigest(schema),
            canonicalValue: '{"ok":true}',
            valueHash: sha256('{"ok":true}'),
          },
        },
      },
    });
    expect(Object.isFrozen(state.nodes.publish?.control)).toBe(true);
  });

  it("parses a strict result control graph and publication event", () => {
    expect(parseRunEvent(started())).toMatchObject({
      type: "run_started",
      controlGraph: { nodes: [expect.anything(), expect.objectContaining({ type: "result" })] },
    });
    expect(parseRunEvent(published(4))).toMatchObject({
      type: "node_result_published",
      canonicalValue: '{"ok":true}',
    });
  });

  it("rejects a persisted result schema that exceeds the workflow depth bound", () => {
    let oversizedSchema: CompiledResultSchema = { type: "boolean" };
    for (let depth = 0; depth < 8; depth += 1) {
      oversizedSchema = { type: "array", items: oversizedSchema, maxItems: 1 };
    }
    const event = started();
    const resultNode = event.controlGraph.nodes[1];
    if (resultNode?.type !== "result") {
      throw new Error("test fixture must contain a result node");
    }

    expect(() =>
      parseRunEvent({
        ...event,
        controlGraph: {
          nodes: [
            event.controlGraph.nodes[0],
            {
              ...resultNode,
              result: {
                ...resultNode.result,
                schema: oversizedSchema,
                schemaDigest: calculateResultSchemaDigest(oversizedSchema),
              },
            },
          ],
        },
      }),
    ).toThrow(/result schema depth.*8/i);
  });

  it.each([
    ["source node", { sourceNodeId: "publish" }, /source node/i],
    ["source attempt", { sourceAttempt: 2 }, /source attempt/i],
    ["source field", { sourceField: "command.stderr" }, /source field/i],
    ["source hash", { sourceHash: "f".repeat(64) }, /source hash/i],
    ["schema digest", { schemaDigest: "f".repeat(64) }, /schema digest/i],
    ["canonical value", { canonicalValue: '{"ok":false}' }, /canonical value/i],
    ["value hash", { valueHash: "f".repeat(64) }, /value hash/i],
  ])("rejects a publication with a forged %s", (_name, change, error) => {
    expect(() =>
      reduceRunEvents([
        ...throughSource(),
        { ...published(4), ...change },
      ] as unknown as RunEvent[]),
    ).toThrowError(error);
  });

  it("rejects publication when the durable source does not satisfy the schema", () => {
    expect(() =>
      reduceRunEvents([
        started(),
        nodeStarted(2),
        sourceSucceeded(3, "not-json"),
        { ...published(4), sourceHash: sha256("not-json") },
      ] as unknown as RunEvent[]),
    ).toThrowError(/invalid|canonical/i);
  });

  it("rejects publication before its source has durable evidence", () => {
    expect(() => reduceRunEvents([started(), published(2)] as RunEvent[])).toThrowError(
      /dependency.*has not succeeded/i,
    );
  });

  it("rejects starting a result node through the executable event protocol", () => {
    expect(() =>
      reduceRunEvents([
        ...throughSource(),
        { ...base(4), type: "node_started", nodeId: "publish", attempt: 1 },
      ] as RunEvent[]),
    ).toThrowError(/control node.*cannot start/i);
  });

  it("replays the exact typed validation failure and rejects changed classification", () => {
    const events = [started(), nodeStarted(2), sourceSucceeded(3, "not-json")];
    const failure = {
      ...base(4),
      type: "node_control_failed" as const,
      nodeId: "publish",
      attempt: 1 as const,
      error: {
        code: "result_invalid_json",
        message: "invalid literal at offset 0",
        retryable: false,
        sideEffectStatus: "none" as const,
      },
    };

    expect(reduceRunEvents([...events, failure] as RunEvent[]).nodes.publish).toMatchObject({
      status: "failed",
      error: failure.error,
    });
    expect(() =>
      reduceRunEvents([
        ...events,
        { ...failure, error: { ...failure.error, code: "result_schema_mismatch" } },
      ] as RunEvent[]),
    ).toThrowError(/classification|failure/i);
  });

  it("replays only the exact truncation failure", () => {
    const events = [started(), nodeStarted(2), sourceSucceeded(3, '{"ok":true}', true)];
    const failure = {
      ...base(4),
      type: "node_control_failed" as const,
      nodeId: "publish",
      attempt: 1 as const,
      error: {
        code: "result_source_truncated",
        message: resultSourceTruncationMessage("publish", "command.stdout"),
        retryable: false,
        sideEffectStatus: "none" as const,
      },
    };

    expect(reduceRunEvents([...events, failure] as RunEvent[]).nodes.publish?.status).toBe(
      "failed",
    );
    expect(() =>
      reduceRunEvents([
        ...events,
        { ...failure, error: { ...failure.error, retryable: true } },
      ] as RunEvent[]),
    ).toThrowError(/truncation|side-effect-free/i);
  });
});

const schema: CompiledResultSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

function successfulEvents(): RunEvent[] {
  return [...throughSource(), published(4), { ...base(5), type: "run_succeeded" }] as RunEvent[];
}

function throughSource(): RunEvent[] {
  return [started(), nodeStarted(2), sourceSucceeded(3, '{ "ok": true }')] as RunEvent[];
}

function started() {
  return {
    ...base(1),
    type: "run_started" as const,
    nodeIds: ["produce", "publish"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1" as const,
    workflowDigest: "d".repeat(64),
    controlGraph: {
      nodes: [
        { nodeId: "produce", type: "command" as const, dependsOn: [] },
        {
          nodeId: "publish",
          type: "result" as const,
          dependsOn: ["produce"],
          result: {
            source: { nodeId: "produce", field: "command.stdout" as const },
            schema,
            schemaDigest: calculateResultSchemaDigest(schema),
          },
        },
      ],
    },
  };
}

function nodeStarted(sequence: number) {
  return { ...base(sequence), type: "node_started" as const, nodeId: "produce", attempt: 1 };
}

function sourceSucceeded(sequence: number, stdout: string, truncated = false) {
  return {
    ...base(sequence),
    type: "node_succeeded" as const,
    nodeId: "produce",
    attempt: 1,
    evidence: {
      kind: "command" as const,
      executable: "node",
      args: [],
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutHash: sha256(stdout),
      stderrHash: sha256(""),
      stdoutTruncated: truncated,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}

function published(sequence: number) {
  return {
    ...base(sequence),
    type: "node_result_published" as const,
    nodeId: "publish",
    attempt: 1 as const,
    sourceNodeId: "produce",
    sourceAttempt: 1,
    sourceField: "command.stdout" as const,
    sourceHash: sha256('{ "ok": true }'),
    schemaDigest: calculateResultSchemaDigest(schema),
    canonicalValue: '{"ok":true}',
    valueHash: sha256('{"ok":true}'),
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-08T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId: "run-result",
    workflowId: "typed-result",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
