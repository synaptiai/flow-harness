import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type CommandApprovalOperation,
  calculateCommandApprovalOperationDigest,
} from "../../../src/domain/approval/command-approval.js";
import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("run resource and budget replay", () => {
  it("keeps legacy runs unbudgeted while reconstructing durable resources", () => {
    const state = reduceRunEvents([
      runStarted(undefined, ["verify"]),
      nodeStarted(2, "verify"),
      nodeSucceeded(3, "verify", commandEvidence(10.1)),
      runSucceeded(4),
    ] as RunEvent[]);

    expect(state).toMatchObject({
      status: "succeeded",
      resources: {
        nodeStarts: 1,
        modelTokens: 0,
        modelCostUsdMicros: 0,
        executionMs: 11,
      },
      budget: null,
    });
  });

  it("aggregates successful and failed evidence with checked integer accounting", () => {
    const state = reduceRunEvents([
      runStarted({
        maxNodeStarts: 4,
        maxModelTokens: 100,
        maxCostUsdMicros: 1000,
        maxExecutionMs: 100,
      }),
      nodeStarted(2, "prepare"),
      nodeSucceeded(3, "prepare", commandEvidence(10.1)),
      nodeStarted(4, "verify"),
      {
        ...base(5),
        type: "node_failed",
        nodeId: "verify",
        attempt: 1,
        error: {
          code: "model_failed",
          message: "provider returned an error after usage settled",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: agentEvidence(20.2, {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          costUsdMicros: 7,
        }),
      },
    ] as unknown as RunEvent[]);

    expect(state.resources).toEqual({
      nodeStarts: 2,
      modelTokens: 10,
      modelCostUsdMicros: 7,
      executionMs: 32,
      artifactBytes: 11,
    });
    expect(state.budget).toEqual({
      limits: {
        maxNodeStarts: 4,
        maxModelTokens: 100,
        maxCostUsdMicros: 1000,
        maxExecutionMs: 100,
      },
      remaining: {
        nodeStarts: 2,
        modelTokens: 90,
        modelCostUsdMicros: 993,
        executionMs: 68,
      },
      exhausted: [],
    });
    expect(Object.isFrozen(state.resources)).toBe(true);
    expect(Object.isFrozen(state.budget)).toBe(true);
    expect(Object.isFrozen(state.budget?.remaining)).toBe(true);
  });

  it("records an explicit terminal outcome at a model settlement boundary", () => {
    const state = reduceRunEvents([
      runStarted({ maxModelTokens: 10 }),
      nodeStarted(2, "verify"),
      nodeSucceeded(
        3,
        "verify",
        agentEvidence(5, {
          inputTokens: 6,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 3,
        }),
      ),
      {
        ...base(4),
        type: "run_budget_exhausted",
        exhausted: [{ dimension: "modelTokens", limit: 10, consumed: 10 }],
      },
    ] as unknown as RunEvent[]);

    expect(state).toMatchObject({
      status: "resource_exhausted",
      finishedAt: at(4),
      failureReason: "run budget exhausted: modelTokens consumed 10 of 10",
      budget: {
        remaining: { modelTokens: 0 },
        exhausted: [{ dimension: "modelTokens", limit: 10, consumed: 10 }],
      },
    });
  });

  it("allows success after the final permitted start but rejects another start", () => {
    const completed = [
      runStarted({ maxNodeStarts: 1 }, ["verify"]),
      nodeStarted(2, "verify"),
      nodeSucceeded(3, "verify", commandEvidence(1)),
    ] as unknown as RunEvent[];

    expect(reduceRunEvents([...completed, runSucceeded(4)]).status).toBe("succeeded");
    expect(() =>
      reduceRunEvents([
        runStarted({ maxNodeStarts: 1 }),
        nodeStarted(2, "prepare"),
        nodeSucceeded(3, "prepare", commandEvidence(1)),
        nodeStarted(4, "verify"),
      ] as unknown as RunEvent[]),
    ).toThrowError(/nodeStarts.*budget|budget.*nodeStarts/i);
  });

  it("rejects an approval request after the start budget is exhausted", () => {
    const started = {
      ...runStarted({ maxNodeStarts: 1 }),
      executionCwd: "/workspace",
      approvalRequirements: [{ nodeId: "verify", grantTtlMs: 60000 }],
    };
    const operation: CommandApprovalOperation = {
      version: 1,
      action: "process.execute",
      cwd: "/workspace",
      executable: "node",
      args: ["verify"],
      timeoutMs: 1000,
    };

    expect(() =>
      reduceRunEvents([
        started,
        nodeStarted(2, "prepare"),
        nodeSucceeded(3, "prepare", commandEvidence(1)),
        {
          ...base(4),
          type: "command_approval_requested",
          nodeId: "verify",
          attempt: 1,
          requestId: "approval-4",
          grantTtlMs: 60000,
          operation,
          operationDigest: calculateCommandApprovalOperationDigest(operation),
        },
      ] as unknown as RunEvent[]),
    ).toThrowError(/approval.*budget|budget.*approval/i);
  });

  it("rejects generic failure finalization after a budgeted failure exhausts a limit", () => {
    expect(() =>
      reduceRunEvents([
        runStarted({ maxModelTokens: 1 }, ["verify"]),
        nodeStarted(2, "verify"),
        {
          ...base(3),
          type: "node_failed",
          nodeId: "verify",
          attempt: 1,
          error: {
            code: "provider_failed",
            message: "provider failed",
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: agentEvidence(1, {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          }),
        },
        { ...base(4), type: "run_failed", failedNodeId: "verify", reason: "provider failed" },
      ] as unknown as RunEvent[]),
    ).toThrowError(/budget.*exhausted|resource.*exhausted/i);
  });

  it("rejects cancellation after committed evidence exhausts a settlement limit", () => {
    expect(() =>
      reduceRunEvents([
        runStarted({ maxModelTokens: 1 }, ["verify"]),
        nodeStarted(2, "verify"),
        nodeSucceeded(
          3,
          "verify",
          agentEvidence(1, {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          }),
        ),
        { ...base(4), type: "run_cancelled", reason: "operator cancelled after settlement" },
      ] as unknown as RunEvent[]),
    ).toThrowError(/budget.*exhausted|resource.*exhausted/i);
  });

  it("rejects cancellation when the start limit is exhausted with pending work", () => {
    expect(() =>
      reduceRunEvents([
        runStarted({ maxNodeStarts: 1 }),
        nodeStarted(2, "prepare"),
        nodeSucceeded(3, "prepare", commandEvidence(1)),
        { ...base(4), type: "run_cancelled", reason: "operator cancelled after commit" },
      ] as unknown as RunEvent[]),
    ).toThrowError(/budget.*exhausted|resource.*exhausted/i);
  });

  it.each([
    [
      "negative usage",
      () => [
        runStarted({ maxModelTokens: 10 }),
        nodeStarted(2, "verify"),
        nodeSucceeded(
          3,
          "verify",
          agentEvidence(1, {
            inputTokens: -1,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          }),
        ),
      ],
      /event schema is invalid/i,
    ],
    [
      "overflowing token components",
      () => [
        runStarted({ maxModelTokens: Number.MAX_SAFE_INTEGER }),
        nodeStarted(2, "verify"),
        nodeSucceeded(
          3,
          "verify",
          agentEvidence(1, {
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          }),
        ),
      ],
      /safe integer|overflow/i,
    ],
    [
      "premature exhaustion",
      () => [
        runStarted({ maxModelTokens: 10 }),
        {
          ...base(2),
          type: "run_budget_exhausted",
          exhausted: [{ dimension: "modelTokens", limit: 10, consumed: 0 }],
        },
      ],
      /not exhausted|does not match/i,
    ],
    [
      "forged exhaustion amount",
      () => [
        runStarted({ maxModelTokens: 10 }),
        nodeStarted(2, "verify"),
        nodeSucceeded(
          3,
          "verify",
          agentEvidence(1, {
            inputTokens: 10,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdMicros: 0,
          }),
        ),
        {
          ...base(4),
          type: "run_budget_exhausted",
          exhausted: [{ dimension: "modelTokens", limit: 10, consumed: 11 }],
        },
      ],
      /does not match/i,
    ],
  ])("rejects %s", (_case, events, message) => {
    expect(() => reduceRunEvents(events() as unknown as RunEvent[])).toThrowError(message);
  });
});

function runStarted(
  budget?: {
    readonly maxNodeStarts?: number;
    readonly maxModelTokens?: number;
    readonly maxCostUsdMicros?: number;
    readonly maxExecutionMs?: number;
  },
  nodeIds: readonly string[] = ["prepare", "verify"],
) {
  return {
    ...base(1),
    type: "run_started",
    nodeIds,
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "a".repeat(64),
    ...(budget === undefined ? {} : { budget }),
  };
}

function nodeStarted(sequence: number, nodeId: string) {
  return { ...base(sequence), type: "node_started", nodeId, attempt: 1 };
}

function nodeSucceeded(sequence: number, nodeId: string, evidence: unknown) {
  return { ...base(sequence), type: "node_succeeded", nodeId, attempt: 1, evidence };
}

function runSucceeded(sequence: number): RunEvent {
  return { ...base(sequence), type: "run_succeeded" };
}

function commandEvidence(durationMs: number) {
  return {
    kind: "command",
    executable: "node",
    args: ["--version"],
    exitCode: 0,
    signal: null,
    stdout: "v22",
    stderr: "",
    stdoutHash: sha256("v22"),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs,
  };
}

function agentEvidence(
  durationMs: number,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly costUsdMicros: number;
  },
) {
  return {
    kind: "agent",
    provider: "test-provider",
    model: "test-model",
    text: "analysis",
    textHash: sha256("analysis"),
    textTruncated: false,
    durationMs,
    usage,
    policyDecisions: [],
    effectReceipts: [],
  };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: at(sequence),
    runId: "run-budget",
    workflowId: "workflow-budget",
  };
}

function at(sequence: number): string {
  return `2026-08-07T16:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
