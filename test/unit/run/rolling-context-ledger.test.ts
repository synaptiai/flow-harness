import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateModelSessionDigest,
  calculatePortableHistoryIdentity,
  createModelSession,
  createModelSessionEvent,
  type ModelRequestIdentity,
  type ModelSessionEventInput,
  type ModelSessionState,
  modelSessionSummary,
  reduceModelSessionEvents,
  selectContextCompactionRange,
  selectRollingContextRange,
} from "../../../src/domain/run/model-session.js";

const identity = { runId: "run-rolling", workflowId: "workflow-rolling", nodeId: "agent" };
const bindings = {
  provider: "openai",
  model: "gpt-5.6",
  apiAdapter: "openai-responses",
  contextWindowTokens: 272_000,
  maxOutputTokens: 128_000,
  thinking: "high",
  runtimeVersion: "pi-0.84.0",
  system: { sha256: "1".repeat(64), bytes: 100 },
  toolCatalog: { sha256: "2".repeat(64), bytes: 200, count: 2 },
  authority: { sha256: "3".repeat(64) },
  routingSha256: null,
} as const;
const policy = {
  sha256: "4".repeat(64),
  pressureThresholdPercent: 85,
  protectedConstraints: { sha256: calculateModelSessionDigest([]), count: 0 },
} as const;

describe("rolling context ledger", () => {
  it("retains two exact completed requests in the rolling range", () => {
    const state = sessionWithSettledRequests(4);

    expect(selectContextCompactionRange(state)?.lastRequest).toBe(3);
    expect(
      selectContextCompactionRange(state, {
        recentRequestCount: 2,
        allowErrorToolResults: true,
      })?.lastRequest,
    ).toBe(2);
  });

  it("rejects a reference projection whose byte identity does not match the tool result", () => {
    let state = sessionWithSettledRequests(0);
    state = append(state, {
      type: "model_request_prepared",
      attempt: 1,
      turn: 1,
      request: 1,
      identity: requestIdentity(state, 1),
    });
    state = append(state, {
      type: "model_message_committed",
      attempt: 1,
      turn: 1,
      request: 1,
      text: "Inspect the command evidence.",
      stopReason: "toolUse",
    });
    state = append(state, {
      type: "tool_call_committed",
      attempt: 1,
      turn: 1,
      request: 1,
      toolCallId: "command-1",
      toolName: "flow_exec",
      argumentsJson: "{}",
    });
    const reference = `artifact:${"a".repeat(64)}`;
    const projectedText = JSON.stringify({
      version: 1,
      kind: "flow.reference-tool-result",
      artifact: reference,
    });

    expect(() =>
      append(state, {
        type: "tool_result_committed",
        attempt: 1,
        turn: 1,
        request: 1,
        toolCallId: "command-1",
        toolName: "flow_exec",
        text: "full result ".repeat(100),
        isError: false,
        referenceProjection: {
          text: projectedText,
          originalBytes: 1,
          projectedBytes: Buffer.byteLength(projectedText),
          artifactReferences: [reference],
        },
      }),
    ).toThrow(/reference projection byte identity/i);
  });

  it("atomically accepts and reconstructs a private rolling checkpoint", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const started = rollingStart(state, 1, 1, 4_096);
    state = append(state, started);
    state = append(state, summaryCapacityCheck(state, 1, 1, 4_096));
    const checkpoint = acceptedCheckpoint(started, "Exact private summary surface.");
    state = append(state, {
      type: "rolling_context_epoch_settled",
      attempt: 1,
      epoch: 1,
      generationAttempt: 1,
      settlement: { outcome: "accepted", reason: "accepted", checkpoint },
    });

    expect(state.rollingEpochCount).toBe(1);
    expect(state.acceptedRollingEpochCount).toBe(1);
    expect(state.currentRollingCheckpoint?.summaryText).toBe("Exact private summary surface.");
    expect(state.activeRollingEpoch).toBeNull();

    const publicSummary = modelSessionSummary(state);
    expect(publicSummary).toMatchObject({
      capacityCheckCount: 2,
      latestCapacityCheck: {
        check: 2,
        operation: { kind: "summary", epoch: 1, generationAttempt: 1 },
        status: "measured",
        method: "provider_exact",
        uncertainty: "exact",
        decision: "admitted",
        outputAllowanceTokens: 4_096,
      },
      rollingEpochCount: 1,
      rollingGenerationCount: 1,
      acceptedRollingEpochCount: 1,
      interruptedRollingEpochCount: 0,
      activeRollingEpoch: null,
      currentRollingCheckpoint: {
        summarySha256: checkpoint.summary.sha256,
        summaryBytes: checkpoint.summary.bytes,
        sourceSha256: checkpoint.cumulativeRange.sha256,
        renderedSurfaceSha256: checkpoint.renderedSurface.sha256,
        bindingsSha256: calculateModelSessionDigest(checkpoint.bindings),
        policySha256: checkpoint.policy.sha256,
      },
    });
    expect(JSON.stringify(publicSummary)).not.toContain("Exact private summary surface.");

    const replayed = reduceModelSessionEvents(state.events.map((event) => ({ ...event })));
    expect(replayed.currentRollingCheckpoint).toEqual(state.currentRollingCheckpoint);
  });

  it("rejects a changed accepted summary and leaves the prior state authoritative", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const started = rollingStart(state, 1, 1, 4_096);
    state = append(state, started);
    state = append(state, summaryCapacityCheck(state, 1, 1, 4_096));
    const checkpoint = acceptedCheckpoint(started, "Exact private summary surface.");

    expect(() =>
      append(state, {
        type: "rolling_context_epoch_settled",
        attempt: 1,
        epoch: 1,
        generationAttempt: 1,
        settlement: {
          outcome: "accepted",
          reason: "accepted",
          checkpoint: {
            ...checkpoint,
            summaryText: "Changed summary surface.",
          },
        },
      }),
    ).toThrow(/summary identity/i);
    expect(state.currentRollingCheckpoint).toBeNull();
    expect(state.activeRollingEpoch).not.toBeNull();
  });

  it("advances a later checkpoint with only the newly eligible delta", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const firstStart = rollingStart(state, 1, 1, 4_096);
    state = append(state, firstStart);
    state = append(state, summaryCapacityCheck(state, 1, 1, 4_096));
    state = append(state, {
      type: "rolling_context_epoch_settled",
      attempt: 1,
      epoch: 1,
      generationAttempt: 1,
      settlement: {
        outcome: "accepted",
        reason: "accepted",
        checkpoint: acceptedCheckpoint(firstStart, "First private summary."),
      },
    });
    const firstRange = state.currentRollingCheckpoint?.cumulativeRange;
    if (firstRange === undefined) throw new Error("first checkpoint missing");
    state = completeAdmittedTask(state);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const secondStart = rollingStart(state, 2, 1, 4_096);

    expect(secondStart.cumulativeRange.firstSequence).toBe(firstRange.firstSequence);
    expect(secondStart.cumulativeRange.lastSequence).toBeGreaterThan(firstRange.lastSequence);
    expect(secondStart.deltaRange.firstSequence).toBeGreaterThan(firstRange.lastSequence);
    expect(secondStart.deltaRange.eventCount).toBeLessThan(secondStart.cumulativeRange.eventCount);
  });

  it("allows absolute overflow to trigger one bounded reduction epoch", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "over_capacity"));

    state = append(state, rollingStart(state, 1, 1, 4_096));

    expect(state.activeRollingEpoch).toMatchObject({ epoch: 1, generationAttempt: 1 });
  });

  it("permits one smaller second generation only after a typed rejection", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const first = rollingStart(state, 1, 1, 4_096);
    state = append(state, first);
    state = append(state, summaryCapacityCheck(state, 1, 1, 4_096));
    state = append(state, {
      type: "rolling_context_epoch_settled",
      attempt: 1,
      epoch: 1,
      generationAttempt: 1,
      settlement: { outcome: "rejected", reason: "invalid_output" },
    });

    expect(() => append(state, rollingStart(state, 1, 2, 4_096))).toThrow(/smaller/i);
    state = append(state, rollingStart(state, 1, 2, 2_048));
    expect(state.activeRollingEpoch).toMatchObject({ epoch: 1, generationAttempt: 2 });
    expect(state.rollingEpochCount).toBe(1);
    expect(state.rollingGenerationCount).toBe(2);
  });

  it("requires an admitted summary capacity check before accepting its settlement", () => {
    let state = sessionWithSettledRequests(3);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    const started = rollingStart(state, 1, 1, 4_096);
    state = append(state, started);

    expect(() =>
      append(state, {
        type: "rolling_context_epoch_settled",
        attempt: 1,
        epoch: 1,
        generationAttempt: 1,
        settlement: {
          outcome: "accepted",
          reason: "accepted",
          checkpoint: acceptedCheckpoint(started, "Summary."),
        },
      }),
    ).toThrow(/summary admission/i);
  });

  it("permits eight epochs and rejects a ninth with a stable replay failure", () => {
    let state = sessionWithSettledRequests(3);
    for (let epoch = 1; epoch <= 8; epoch += 1) {
      state = append(state, taskCapacityCheck(state, "reduction_required"));
      state = append(state, rollingStart(state, epoch, 1, 4_096));
      state = append(state, summaryCapacityCheck(state, epoch, 1, 4_096));
      state = append(state, {
        type: "rolling_context_epoch_settled",
        attempt: 1,
        epoch,
        generationAttempt: 1,
        settlement: { outcome: "rejected", reason: "invalid_output" },
      });
      state = completeAdmittedTask(state);
    }

    expect(state.rollingEpochCount).toBe(8);
    state = append(state, taskCapacityCheck(state, "reduction_required"));
    expect(() => append(state, rollingStart(state, 9, 1, 4_096))).toThrow(/eight epochs/i);
  });
});

function sessionWithSettledRequests(count: number): ModelSessionState {
  let state = createModelSession(identity, "2026-08-27T00:00:00.000Z").state;
  state = append(state, { type: "attempt_started", attempt: 1 });
  state = append(state, {
    type: "user_message_committed",
    attempt: 1,
    origin: "primary_prompt",
    text: "Complete the objective without changing authority.",
  });
  for (let request = 1; request <= count; request += 1) {
    state = append(state, {
      type: "model_request_prepared",
      attempt: 1,
      turn: request,
      request,
      identity: requestIdentity(state, request),
    });
    state = append(state, {
      type: "model_message_committed",
      attempt: 1,
      turn: request,
      request,
      text: `Completed response ${request}.`,
      stopReason: "stop",
    });
    state = append(state, {
      type: "model_request_settled",
      attempt: 1,
      turn: request,
      request,
      outcome: "completed",
    });
  }
  return state;
}

function append(state: ModelSessionState, input: ModelSessionEventInput): ModelSessionState {
  const event = createModelSessionEvent(state, input, "2026-08-27T00:00:01.000Z");
  return reduceModelSessionEvents([...state.events, event]);
}

function requestIdentity(state: ModelSessionState, request: number): ModelRequestIdentity {
  return {
    version: 1,
    provider: bindings.provider,
    model: bindings.model,
    apiAdapter: bindings.apiAdapter,
    thinking: bindings.thinking,
    runtimeVersion: bindings.runtimeVersion,
    system: bindings.system,
    toolCatalog: bindings.toolCatalog,
    authority: bindings.authority,
    portableHistory: calculatePortableHistoryIdentity(state),
    runtimeSurface: { sha256: "5".repeat(64), bytes: 1_000 + request },
    attempt: 1,
    turn: request,
    request,
  };
}

function taskCapacityCheck(
  state: ModelSessionState,
  decision: "admitted" | "reduction_required" | "over_capacity",
): ModelSessionEventInput {
  const request =
    state.events.filter((event) => event.type === "model_request_prepared").length + 1;
  return {
    type: "model_request_capacity_checked",
    check: state.capacityCheckCount + 1,
    attempt: 1,
    operation: { kind: "task", turn: request, request },
    apiAdapter: bindings.apiAdapter,
    providerPayload: payloadIdentity("6"),
    measurement: {
      status: "measured",
      method: "provider_exact",
      evaluation: {
        contextWindowTokens: 272_000,
        outputAllowanceTokens: 128_000,
        safetyReserveTokens: 16_384,
        usableInputTokens: 127_616,
        pressureThresholdPercent: 85,
        measuredInputTokens:
          decision === "admitted" ? 100_000 : decision === "reduction_required" ? 108_474 : 127_617,
        absoluteSafe: decision !== "over_capacity",
        underPressure: decision !== "admitted",
        decision,
      },
    },
  };
}

function summaryCapacityCheck(
  state: ModelSessionState,
  epoch: number,
  generationAttempt: number,
  outputAllowanceTokens: number,
): ModelSessionEventInput {
  return {
    type: "model_request_capacity_checked",
    check: state.capacityCheckCount + 1,
    attempt: 1,
    operation: { kind: "summary", epoch, generationAttempt },
    apiAdapter: bindings.apiAdapter,
    providerPayload: payloadIdentity("7"),
    measurement: {
      status: "measured",
      method: "provider_exact",
      evaluation: {
        contextWindowTokens: 272_000,
        outputAllowanceTokens,
        safetyReserveTokens: 16_384,
        usableInputTokens: 272_000 - outputAllowanceTokens - 16_384,
        pressureThresholdPercent: 85,
        measuredInputTokens: 1_000,
        absoluteSafe: true,
        underPressure: false,
        decision: "admitted",
      },
    },
  };
}

function completeAdmittedTask(state: ModelSessionState): ModelSessionState {
  const request =
    state.events.filter((event) => event.type === "model_request_prepared").length + 1;
  state = append(state, taskCapacityCheck(state, "admitted"));
  state = append(state, {
    type: "model_request_prepared",
    attempt: 1,
    turn: request,
    request,
    providerPayload: payloadIdentity("6"),
    identity: requestIdentity(state, request),
  });
  state = append(state, {
    type: "model_message_committed",
    attempt: 1,
    turn: request,
    request,
    text: `Completed response ${request}.`,
    stopReason: "stop",
  });
  return append(state, {
    type: "model_request_settled",
    attempt: 1,
    turn: request,
    request,
    outcome: "completed",
  });
}

function rollingStart(
  state: ModelSessionState,
  epoch: number,
  generationAttempt: number,
  outputTokenLimit: number,
) {
  const selection = selectRollingContextRange(state);
  if (selection === null) throw new Error("test session has no rolling range");
  const request =
    state.events.filter((event) => event.type === "model_request_prepared").length + 1;
  return {
    type: "rolling_context_epoch_started" as const,
    attempt: 1,
    epoch,
    generationAttempt,
    task: { turn: request, request },
    sourceHead: state.head,
    cumulativeRange: selection.cumulativeRange,
    deltaRange: selection.deltaRange,
    referenceSurface: { sha256: "8".repeat(64), bytes: 10_000, estimatedTokens: 2_500 },
    outputTokenLimit,
    bindings,
    policy,
  };
}

function acceptedCheckpoint(started: ReturnType<typeof rollingStart>, summaryText: string) {
  const bytes = Buffer.byteLength(summaryText, "utf8");
  return {
    version: 1 as const,
    summaryText,
    summary: { sha256: sha256(summaryText), bytes, estimatedTokens: Math.ceil(bytes / 4) },
    cumulativeRange: started.cumulativeRange,
    renderedSurface: { sha256: "9".repeat(64), bytes: 5_000, estimatedTokens: 1_250 },
    surface: { beforeBytes: 10_000, afterBytes: 5_000, minimumReductionBytes: 4_096 },
    constraints: {
      sha256: policy.protectedConstraints.sha256,
      checked: 0,
      retained: 0,
    },
    bindings,
    policy,
    usage: {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 10,
    },
  };
}

function payloadIdentity(digit: string) {
  return { sha256: digit.repeat(64), bytes: 512 };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
