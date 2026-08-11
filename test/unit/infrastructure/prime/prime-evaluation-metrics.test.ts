import { describe, expect, it } from "vitest";

import { PrimeEvaluationMetricsLedger } from "../../../../src/infrastructure/prime/prime-evaluation-metrics.js";

describe("Prime evaluation metrics", () => {
  it("uses checked host evidence and per-response cost rounding", () => {
    const ledger = new PrimeEvaluationMetricsLedger();
    ledger.recordBrokerResponse(
      assistantResponse({
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        cost: 0.000_000_1,
        toolCalls: 1,
      }),
    );
    ledger.recordBrokerResponse(
      assistantResponse({
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 2,
        cost: 0.000_000_1,
        toolCalls: 0,
      }),
    );
    ledger.recordIpythonResult(false);
    ledger.recordIntervention("timeout-stop");
    ledger.recordRecovery("succeeded");

    expect(
      ledger.finish({
        startedAtMs: 10.2,
        endedAtMs: 25.8,
        activeTimeMicros: 12_001,
      }),
    ).toEqual({
      costUsdMicros: 2,
      inputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 7,
      turns: 2,
      toolCalls: 1,
      toolErrors: 0,
      wallTimeMs: 16,
      activeTimeMs: 13,
      interventions: 1,
      policyViolations: null,
      recoveryAttempts: 1,
      recoveryOutcome: "succeeded",
    });
  });

  it("counts only declared intervention events", () => {
    const ledger = new PrimeEvaluationMetricsLedger();
    ledger.recordBrokerResponse(assistantResponse({ toolCalls: 1 }));
    ledger.recordIpythonResult(true);
    ledger.recordIntervention("operator-cancel");
    ledger.recordIntervention("timeout-stop");
    ledger.recordIntervention("policy-kill");
    ledger.recordIntervention("recovery-termination");

    expect(ledger.finish({ startedAtMs: 1, endedAtMs: 2, activeTimeMicros: null })).toMatchObject({
      toolCalls: 1,
      toolErrors: 1,
      interventions: 4,
      recoveryAttempts: 0,
      recoveryOutcome: "not_attempted",
    });
  });

  it("uses null when transcript or lifecycle evidence is incomplete", () => {
    const ledger = new PrimeEvaluationMetricsLedger();
    ledger.markTranscriptIncomplete();
    ledger.markLifecycleIncomplete();

    expect(ledger.finish({ startedAtMs: null, endedAtMs: null, activeTimeMicros: null })).toEqual({
      costUsdMicros: null,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      turns: null,
      toolCalls: null,
      toolErrors: null,
      wallTimeMs: null,
      activeTimeMs: null,
      interventions: null,
      policyViolations: null,
      recoveryAttempts: null,
      recoveryOutcome: null,
    });
  });

  it("rejects malformed responses, mismatched tool results, and overflow", () => {
    const malformed = new PrimeEvaluationMetricsLedger();
    expect(() => malformed.recordBrokerResponse("{}")).toThrow(/assistant|response/i);

    const mismatch = new PrimeEvaluationMetricsLedger();
    expect(() => mismatch.recordIpythonResult(false)).toThrow(/tool result/i);

    const duplicateResult = new PrimeEvaluationMetricsLedger();
    duplicateResult.recordBrokerResponse(assistantResponse({ toolCalls: 1 }));
    duplicateResult.recordIpythonResult(false);
    expect(() => duplicateResult.recordIpythonResult(false)).toThrow(/tool result/i);

    const overflow = new PrimeEvaluationMetricsLedger();
    overflow.recordBrokerResponse(
      assistantResponse({ input: Number.MAX_SAFE_INTEGER, toolCalls: 0 }),
    );
    expect(() =>
      overflow.recordBrokerResponse(assistantResponse({ input: 1, toolCalls: 0 })),
    ).toThrow(/safe integer|overflow/i);
  });

  it("enforces model-turn and IPython-call limits before the next response is accepted", () => {
    const turns = new PrimeEvaluationMetricsLedger({ maxModelTurns: 2, maxIpythonCalls: 2 });
    turns.recordBrokerResponse(assistantResponse());
    turns.recordBrokerResponse(assistantResponse());
    expect(() => turns.recordBrokerResponse(assistantResponse())).toThrow(/model.*turn.*limit/i);

    const calls = new PrimeEvaluationMetricsLedger({ maxModelTurns: 2, maxIpythonCalls: 2 });
    calls.recordBrokerResponse(assistantResponse({ toolCalls: 2 }));
    expect(() => calls.recordBrokerResponse(assistantResponse({ toolCalls: 1 }))).toThrow(
      /IPython.*call.*limit/i,
    );
  });

  it("uses the signed terminal tool-error count and checks related totals", () => {
    const ledger = new PrimeEvaluationMetricsLedger({ maxModelTurns: 2, maxIpythonCalls: 2 });
    ledger.recordBrokerResponse(assistantResponse({ toolCalls: 2 }));
    ledger.reconcileTerminalMetrics({ turns: 1, toolCalls: 2, toolErrors: 1 });

    expect(ledger.finish({ startedAtMs: 0, endedAtMs: 1, activeTimeMicros: null })).toMatchObject({
      turns: 1,
      toolCalls: 2,
      toolErrors: 1,
    });

    expect(() =>
      ledger.reconcileTerminalMetrics({ turns: 2, toolCalls: 2, toolErrors: 1 }),
    ).toThrow(/turn/i);
    expect(() =>
      ledger.reconcileTerminalMetrics({ turns: 1, toolCalls: 2, toolErrors: 3 }),
    ).toThrow(/tool-error/i);
  });
});

function assistantResponse(
  options: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cost?: number;
    readonly toolCalls?: number;
  } = {},
): string {
  const toolCalls = options.toolCalls ?? 0;
  return JSON.stringify({
    role: "assistant",
    content: Array.from({ length: toolCalls }, (_, index) => ({
      type: "toolCall",
      id: `call-${index}`,
      name: "ipython",
      arguments: { code: "print('ok')" },
    })),
    api: "flow-host-inference-v1",
    provider: "flow-host-broker",
    model: "flow-host-model",
    usage: {
      input: options.input ?? 0,
      output: options.output ?? 0,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: options.cacheWrite ?? 0,
      totalTokens:
        (options.input ?? 0) +
        (options.output ?? 0) +
        (options.cacheRead ?? 0) +
        (options.cacheWrite ?? 0),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: options.cost ?? 0,
      },
    },
    stopReason: toolCalls > 0 ? "toolUse" : "stop",
    timestamp: 1,
  });
}
