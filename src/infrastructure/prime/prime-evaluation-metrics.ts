import { z } from "zod";

import type { EvaluationMetrics } from "../../domain/evaluation/records.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const responseSchema = z
  .object({
    role: z.literal("assistant"),
    content: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text") }).passthrough(),
          z.object({ type: z.literal("thinking") }).passthrough(),
          z
            .object({
              type: z.literal("toolCall"),
              id: z.string().min(1).max(256),
              name: z.literal("ipython"),
              arguments: z.record(z.string(), z.unknown()),
            })
            .passthrough(),
        ]),
      )
      .max(128),
    api: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    responseId: z.string().max(512).optional(),
    usage: z
      .object({
        input: safeInteger,
        output: safeInteger,
        cacheRead: safeInteger,
        cacheWrite: safeInteger,
        totalTokens: safeInteger,
        cost: z
          .object({
            input: z.number().finite().nonnegative(),
            output: z.number().finite().nonnegative(),
            cacheRead: z.number().finite().nonnegative(),
            cacheWrite: z.number().finite().nonnegative(),
            total: z.number().finite().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().max(16_384).optional(),
    timestamp: z.number().finite(),
  })
  .strict()
  .superRefine((response, context) => {
    const expectedTotal =
      response.usage.input +
      response.usage.output +
      response.usage.cacheRead +
      response.usage.cacheWrite;
    if (!Number.isSafeInteger(expectedTotal) || response.usage.totalTokens !== expectedTotal) {
      context.addIssue({
        code: "custom",
        path: ["usage", "totalTokens"],
        message: "assistant token total contradicts its token classes",
      });
    }
  });

export type PrimeIntervention =
  | "operator-cancel"
  | "timeout-stop"
  | "policy-kill"
  | "recovery-termination";

export interface PrimeEvaluationMetricsLimits {
  readonly maxModelTurns: number;
  readonly maxIpythonCalls: number;
}

export class PrimeEvaluationMetricsLedger {
  #activeTimeMicros: number | null = null;
  #cacheReadTokens = 0;
  #cacheWriteTokens = 0;
  #costUsdMicros = 0;
  #inputTokens = 0;
  #interventions = 0;
  #lifecycleComplete = true;
  #outputTokens = 0;
  #recoveryAttempts = 0;
  #recoveryFailed = false;
  #toolCalls = 0;
  #toolErrors = 0;
  #toolErrorsAvailable = true;
  #toolResults = 0;
  #transcriptComplete = true;
  #turns = 0;

  constructor(
    private readonly limits: PrimeEvaluationMetricsLimits = {
      maxModelTurns: Number.MAX_SAFE_INTEGER,
      maxIpythonCalls: Number.MAX_SAFE_INTEGER,
    },
  ) {}

  recordBrokerResponse(body: string): void {
    const parsed = responseSchema.safeParse(
      parseStrictJson(body, {
        maxDepth: 64,
        maxNodes: 200_000,
        valueLabel: "Prime assistant response",
      }),
    );
    if (!parsed.success) {
      throw new Error("Prime assistant response is invalid", { cause: parsed.error });
    }
    const response = parsed.data;
    const toolCalls = response.content.filter((content) => content.type === "toolCall").length;
    const nextTurns = checkedAdd(this.#turns, 1, "Prime turn total");
    const nextToolCalls = checkedAdd(this.#toolCalls, toolCalls, "Prime tool-call total");
    if (nextTurns > this.limits.maxModelTurns) {
      throw new Error("Prime model turn limit is exceeded");
    }
    if (nextToolCalls > this.limits.maxIpythonCalls) {
      throw new Error("Prime IPython call limit is exceeded");
    }
    this.#costUsdMicros = checkedAdd(
      this.#costUsdMicros,
      checkedCeil(response.usage.cost.total * 1_000_000, "Prime response cost"),
      "Prime response cost total",
    );
    this.#inputTokens = checkedAdd(
      this.#inputTokens,
      response.usage.input,
      "Prime input token total",
    );
    this.#cacheReadTokens = checkedAdd(
      this.#cacheReadTokens,
      response.usage.cacheRead,
      "Prime cache-read token total",
    );
    this.#cacheWriteTokens = checkedAdd(
      this.#cacheWriteTokens,
      response.usage.cacheWrite,
      "Prime cache-write token total",
    );
    this.#outputTokens = checkedAdd(
      this.#outputTokens,
      response.usage.output,
      "Prime output token total",
    );
    this.#turns = nextTurns;
    this.#toolCalls = nextToolCalls;
  }

  reconcileTerminalMetrics(input: {
    readonly turns: number | null;
    readonly toolCalls: number | null;
    readonly toolErrors: number | null;
  }): void {
    if (input.turns !== null && input.turns !== this.#turns) {
      throw new Error("Prime signed terminal turn total contradicts the host ledger");
    }
    if (input.toolCalls !== null && input.toolCalls !== this.#toolCalls) {
      throw new Error("Prime signed terminal tool-call total contradicts the host ledger");
    }
    if (input.toolErrors === null) {
      this.#toolErrorsAvailable = false;
      return;
    }
    if (!Number.isSafeInteger(input.toolErrors) || input.toolErrors < 0) {
      throw new Error("Prime signed terminal tool-error total is invalid");
    }
    if (input.toolErrors > this.#toolCalls) {
      throw new Error("Prime signed terminal tool-error total exceeds the tool-call total");
    }
    this.#toolErrors = input.toolErrors;
  }

  recordIpythonResult(isError: boolean): void {
    if (this.#toolResults >= this.#toolCalls) {
      throw new Error("Prime IPython tool result has no matching tool call");
    }
    this.#toolResults = checkedAdd(this.#toolResults, 1, "Prime tool-result total");
    if (isError) {
      this.#toolErrors = checkedAdd(this.#toolErrors, 1, "Prime tool-error total");
    }
  }

  recordIntervention(_event: PrimeIntervention): void {
    this.#interventions = checkedAdd(this.#interventions, 1, "Prime intervention total");
  }

  recordRecovery(outcome: "succeeded" | "failed"): void {
    this.#recoveryAttempts = checkedAdd(this.#recoveryAttempts, 1, "Prime recovery-attempt total");
    this.#recoveryFailed ||= outcome === "failed";
  }

  markTranscriptIncomplete(): void {
    this.#transcriptComplete = false;
  }

  markLifecycleIncomplete(): void {
    this.#lifecycleComplete = false;
  }

  finish(input: {
    readonly startedAtMs: number | null;
    readonly endedAtMs: number | null;
    readonly activeTimeMicros: number | null;
  }): EvaluationMetrics {
    this.#activeTimeMicros = input.activeTimeMicros;
    const transcript = this.#transcriptComplete;
    const lifecycle = this.#lifecycleComplete;
    return Object.freeze({
      costUsdMicros: transcript ? this.#costUsdMicros : null,
      inputTokens: transcript ? this.#inputTokens : null,
      cacheReadTokens: transcript ? this.#cacheReadTokens : null,
      cacheWriteTokens: transcript ? this.#cacheWriteTokens : null,
      outputTokens: transcript ? this.#outputTokens : null,
      turns: transcript ? this.#turns : null,
      toolCalls: transcript ? this.#toolCalls : null,
      toolErrors: transcript && this.#toolErrorsAvailable ? this.#toolErrors : null,
      wallTimeMs:
        lifecycle && input.startedAtMs !== null && input.endedAtMs !== null
          ? durationMs(input.startedAtMs, input.endedAtMs)
          : null,
      activeTimeMs:
        lifecycle && this.#activeTimeMicros !== null
          ? checkedCeil(this.#activeTimeMicros / 1_000, "Prime active time")
          : null,
      interventions: lifecycle ? this.#interventions : null,
      policyViolations: null,
      recoveryAttempts: lifecycle ? this.#recoveryAttempts : null,
      recoveryOutcome: lifecycle
        ? this.#recoveryAttempts === 0
          ? "not_attempted"
          : this.#recoveryFailed
            ? "failed"
            : "succeeded"
        : null,
    });
  }
}

function durationMs(startedAtMs: number, endedAtMs: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    throw new Error("Prime wall-time evidence is invalid");
  }
  return checkedCeil(endedAtMs - startedAtMs, "Prime wall time");
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return result;
}

function checkedCeil(value: number, label: string): number {
  const result = Math.ceil(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return result;
}
