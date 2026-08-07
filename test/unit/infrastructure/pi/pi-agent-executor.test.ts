import { describe, expect, it } from "vitest";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

import type { NodeExecutionContext } from "../../../../src/application/ports.js";
import type { CompiledAgentNode } from "../../../../src/domain/workflow/types.js";
import { PolicyBroker } from "../../../../src/domain/policy/broker.js";
import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
  type PiAgentRunRequest,
  type PiAgentRunner,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";
import { AgentEffectRecorder } from "../../../../src/infrastructure/pi/agent-effect-recorder.js";

const context: NodeExecutionContext = {
  runId: "run-agent",
  workflowId: "agent-workflow",
  attempt: 1,
  cwd: process.cwd(),
  protectedPaths: [],
};

describe("PiAgentExecutor", () => {
  it("passes the exact model and tool allowlist to the embedded runner", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        input.policyBroker.authorize({
          action: "filesystem.read",
          target: `${input.cwd}/package.json`,
          boundary: "inside",
        });
        return {
          text: "Analyzed the repository.",
          stopReason: "stop",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 20,
            cacheWriteTokens: 2,
            costUsdMicros: 17,
          },
        };
      },
    };
    const executor = new PiAgentExecutor(runner, () => 100);

    const outcome = await executor.execute(agentNode(), context);

    expect(request).toMatchObject({
      cwd: process.cwd(),
      prompt: "Analyze the repository.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
      tools: ["read", "ls"],
      protectedPaths: [],
    });
    expect(request?.policyBroker.attribution).toEqual({
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.effectRecorder.attribution).toEqual({
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    });
    expect(outcome).toEqual({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        text: "Analyzed the repository.",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        textTruncated: false,
        durationMs: 0,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 20,
          cacheWriteTokens: 2,
          costUsdMicros: 17,
        },
        policyDecisions: [
          expect.objectContaining({
            sequence: 1,
            runId: "run-agent",
            workflowId: "agent-workflow",
            nodeId: "analyze",
            attempt: 1,
            action: "filesystem.read",
            outcome: "allowed",
          }),
        ],
        effectReceipts: [],
      },
    });
  });

  it("passes cancellation through without adding authority", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        receivedSignal = input.signal;
        return { text: "done", stopReason: "stop" };
      },
    };
    const executor = new PiAgentExecutor(runner);

    await executor.execute(agentNode(), { ...context, signal: controller.signal });

    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("turns runtime errors into a failed node without model-authored evidence", async () => {
    const runner: PiAgentRunner = {
      async run() {
        throw new Error("provider unavailable");
      },
    };
    const executor = new PiAgentExecutor(runner);

    const outcome = await executor.execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        message: "provider unavailable",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("preserves settled usage when the model finishes with an error", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return {
          text: "",
          stopReason: "error",
          errorMessage: "provider stream failed",
          usage: {
            inputTokens: 8,
            outputTokens: 1,
            cacheReadTokens: 3,
            cacheWriteTokens: 0,
            costUsdMicros: 9,
          },
        };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_error", message: "provider stream failed" },
      evidence: {
        kind: "agent",
        usage: {
          inputTokens: 8,
          outputTokens: 1,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          costUsdMicros: 9,
        },
      },
    });
  });

  it("preserves policy decisions when the runtime fails after a tool operation", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        input.policyBroker.authorize({
          action: "filesystem.list",
          target: input.cwd,
          boundary: "inside",
        });
        throw new Error("provider failed after tool use");
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_failed", message: "provider failed after tool use" },
      evidence: {
        kind: "agent",
        text: "",
        textTruncated: false,
        policyDecisions: [
          {
            sequence: 1,
            action: "filesystem.list",
            outcome: "allowed",
          },
        ],
      },
    });
  });

  it("preserves a committed edit receipt and side-effect status after provider failure", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        recordEditEffect(input, "committed");
        throw new Error("provider failed after edit");
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_failed",
        message: "provider failed after edit",
        sideEffectStatus: "committed",
      },
      evidence: {
        kind: "agent",
        effectReceipts: [
          {
            sequence: 1,
            kind: "filesystem.edit",
            outcome: "committed",
          },
        ],
      },
    });
  });

  it("fails a terminal agent result when an edit receipt is uncertain", async () => {
    const runner: PiAgentRunner = {
      async run(input) {
        recordEditEffect(input, "uncertain");
        return { text: "The edit may have committed.", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100).execute(
      agentNode(300_000, ["edit"]),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_effect_uncertain", sideEffectStatus: "uncertain" },
      evidence: {
        kind: "agent",
        text: "The edit may have committed.",
        effectReceipts: [{ outcome: "uncertain" }],
      },
    });
  });

  it("rejects Pi terminal error messages even when the session promise resolves", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "partial output", stopReason: "error", errorMessage: "stream failed" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toEqual({
      status: "failed",
      error: {
        code: "pi_agent_error",
        message: "stream failed",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
  });

  it("rejects Pi terminal aborted messages", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "partial output", stopReason: "aborted", errorMessage: "cancelled" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_aborted", message: "cancelled" },
      evidence: null,
    });
  });

  it("enforces the Flow-owned agent timeout", async () => {
    let cleanupFinished = false;
    const runner: PiAgentRunner = {
      run(input) {
        return new Promise((resolve) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleanupFinished = true;
                resolve({
                  text: "",
                  stopReason: "aborted",
                  errorMessage: "aborted",
                  usage: {
                    inputTokens: 2,
                    outputTokens: 1,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsdMicros: 4,
                  },
                });
              }, 10);
            },
            { once: true },
          );
        });
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(10), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_timeout" },
      evidence: {
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdMicros: 4,
        },
      },
    });
    expect(cleanupFinished).toBe(true);
  });

  it("waits for an active edit reservation when timeout abort rejection wins the race", async () => {
    const runner: PiAgentRunner = {
      run(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              const operationDigest = "d".repeat(64);
              const target = "/workspace/source.ts";
              input.policyBroker.authorize({
                action: "filesystem.write",
                target,
                boundary: "inside",
                operationDigest,
              });
              const reservation = input.effectRecorder.reserve({
                kind: "filesystem.edit",
                target,
                operationDigest,
              });
              reject(new Error("session rejected during abort"));
              setTimeout(() => {
                reservation.commit({
                  beforeSha256: "a".repeat(64),
                  afterSha256: "b".repeat(64),
                  outcome: "committed",
                });
              }, 20);
            },
            { once: true },
          );
        });
      },
    };

    const outcome = await new PiAgentExecutor(
      runner,
      performance.now.bind(performance),
      100,
    ).execute(agentNode(5, ["edit"]), context);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_timeout", sideEffectStatus: "committed" },
      evidence: { effectReceipts: [{ outcome: "committed" }] },
    });
  });

  it("bounds cleanup when a runner does not cooperate with abort", async () => {
    const runner: PiAgentRunner = {
      run() {
        return new Promise(() => undefined);
      },
    };
    const startedAt = performance.now();

    const outcome = await new PiAgentExecutor(
      runner,
      performance.now.bind(performance),
      10,
    ).execute(agentNode(10), context);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_timeout",
        sideEffectStatus: "uncertain",
        message: expect.stringContaining("abort cleanup did not settle"),
      },
      evidence: null,
    });
  });

  it("bounds non-cooperative cleanup after external cancellation", async () => {
    const controller = new AbortController();
    const runner: PiAgentRunner = {
      run() {
        return new Promise(() => undefined);
      },
    };
    const startedAt = performance.now();
    const execution = new PiAgentExecutor(runner, performance.now.bind(performance), 10).execute(
      agentNode(1_000),
      { ...context, signal: controller.signal },
    );

    setTimeout(() => controller.abort(new Error("operator cancelled")), 10);
    const outcome = await execution;

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_agent_aborted",
        sideEffectStatus: "uncertain",
        message: expect.stringContaining("operator cancelled"),
      },
      evidence: null,
    });
  });

  it("rejects an invalid abort cleanup grace period", () => {
    expect(() => new PiAgentExecutor(undefined, undefined, -1)).toThrowError(/abortGraceMs/i);
  });

  it("bounds oversized provider output and preserves its complete hash", async () => {
    const completeText = "x".repeat(8 * 1_048_576);
    const runner: PiAgentRunner = {
      async run() {
        return { text: completeText, stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100, 5_000, 1_024).execute(
      agentNode(),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_output_limit" },
      evidence: {
        kind: "agent",
        text: "x".repeat(1_024),
        textHash: createHash("sha256").update(completeText).digest("hex"),
        textTruncated: true,
      },
    });
  });

  it("bounds provider-authored error messages before persistence", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "", stopReason: "error", errorMessage: "e".repeat(100_000) };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), context);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.message.length).toBeLessThanOrEqual(16_384);
      expect(outcome.error.message).toContain("[truncated]");
    }
  });

  it("does not split a UTF-8 code point at the evidence boundary", async () => {
    const runner: PiAgentRunner = {
      async run() {
        return { text: "é", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner, () => 100, 5_000, 1).execute(
      agentNode(),
      context,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_output_limit" },
      evidence: { kind: "agent", text: "", textTruncated: true },
    });
  });

  it("rejects success returned after external cancellation", async () => {
    const controller = new AbortController();
    const runner: PiAgentRunner = {
      async run() {
        controller.abort(new Error("operator cancelled"));
        return { text: "late success", stopReason: "stop" };
      },
    };

    const outcome = await new PiAgentExecutor(runner).execute(agentNode(), {
      ...context,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_aborted", message: "operator cancelled" },
      evidence: null,
    });
  });
});

describe("EmbeddedPiAgentRunner", () => {
  it("reads the SDK terminal message and disables ambient Pi resources", async () => {
    let sessionOptions: Parameters<typeof createAgentSession>[0];
    let disposed = false;
    const fakeSession = {
      state: {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider stream failed",
          },
        ],
      },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async (options: Parameters<typeof createAgentSession>[0]) => {
      sessionOptions = options;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () =>
        ({
          getModel: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
        }) as never,
      createSession,
    );

    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "Analyze the repository.",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "medium",
      tools: ["read", "ls", "edit"],
      maxOutputBytes: 65_536,
      policyBroker: testPolicyBroker(),
      protectedPaths: [],
      effectRecorder: testEffectRecorder(),
    });

    expect(result).toEqual({
      text: "",
      textHash: createHash("sha256").update("").digest("hex"),
      textTruncated: false,
      stopReason: "error",
      errorMessage: "provider stream failed",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 2,
        costUsdMicros: 1234567,
      },
    });
    expect(sessionOptions?.noTools).toBe("all");
    expect(sessionOptions?.tools).toEqual(["flow_read", "flow_ls", "flow_edit"]);
    expect(sessionOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "flow_read",
      "flow_ls",
      "flow_edit",
    ]);
    expect(sessionOptions?.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
    expect(disposed).toBe(true);
  });

  it("returns settled session usage when prompting throws", async () => {
    let disposed = false;
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        throw new Error("provider request failed after billing");
      },
      abort: async () => undefined,
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const result = await runner.run(agentRequest());

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "provider request failed after billing",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 2,
        costUsdMicros: 1234567,
      },
    });
    expect(disposed).toBe(true);
  });

  it("rejects invalid provider usage instead of persisting it", async () => {
    const fakeSession = {
      state: { messages: [{ role: "assistant", stopReason: "stop" }] },
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      getSessionStats: () => ({ ...sessionStats(), cost: Number.NaN }),
      dispose: () => undefined,
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    await expect(runner.run(agentRequest())).rejects.toThrowError(/cost.*finite/i);
  });

  it("does not create a session when cancellation arrives during runtime setup", async () => {
    const controller = new AbortController();
    let releaseRuntime: () => void = () => undefined;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let createSessionCalls = 0;
    const createSession = (async () => {
      createSessionCalls += 1;
      throw new Error("session must not be created");
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(async () => {
      await runtimeReady;
      return { getModel: () => ({}) } as never;
    }, createSession);

    const run = runner.run(agentRequest(controller.signal));
    controller.abort(new Error("cancelled during runtime setup"));
    releaseRuntime();

    await expect(run).rejects.toThrowError(/cancelled during runtime setup/i);
    expect(createSessionCalls).toBe(0);
  });

  it("aborts and disposes without prompting when cancellation arrives during session setup", async () => {
    const controller = new AbortController();
    let releaseSession: () => void = () => undefined;
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let prompted = false;
    let aborted = false;
    let disposed = false;
    let sessionSetupStarted = false;
    const fakeSession = {
      state: { messages: [] },
      subscribe: () => () => undefined,
      prompt: async () => {
        prompted = true;
      },
      abort: async () => {
        aborted = true;
      },
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposed = true;
      },
    };
    const createSession = (async () => {
      sessionSetupStarted = true;
      await sessionReady;
      return { session: fakeSession };
    }) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const run = runner.run(agentRequest(controller.signal));
    while (!sessionSetupStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error("cancelled during session setup"));
    releaseSession();

    await expect(run).rejects.toThrowError(/cancelled during session setup/i);
    expect({ prompted, aborted, disposed }).toEqual({
      prompted: false,
      aborted: true,
      disposed: true,
    });
  });

  it("awaits active-session abort cleanup before disposal", async () => {
    const controller = new AbortController();
    let finishPrompt: () => void = () => undefined;
    const promptFinished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    let promptStarted = false;
    let abortFinished = false;
    let disposedAfterAbort = false;
    const messages: Array<Record<string, unknown>> = [];
    const fakeSession = {
      state: { messages },
      subscribe: () => () => undefined,
      prompt: async () => {
        promptStarted = true;
        await promptFinished;
      },
      abort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        abortFinished = true;
        messages.push({ role: "assistant", stopReason: "aborted" });
        finishPrompt();
      },
      getSessionStats: () => sessionStats(),
      dispose: () => {
        disposedAfterAbort = abortFinished;
      },
    };
    const createSession = (async () => ({
      session: fakeSession,
    })) as unknown as typeof createAgentSession;
    const runner = new EmbeddedPiAgentRunner(
      async () => ({ getModel: () => ({}) }) as never,
      createSession,
    );

    const run = runner.run(agentRequest(controller.signal));
    while (!promptStarted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error("operator cancelled"));
    const result = await run;

    expect(result.stopReason).toBe("aborted");
    expect(disposedAfterAbort).toBe(true);
  });
});

function agentNode(
  timeoutMs = 300_000,
  tools: CompiledAgentNode["agent"]["tools"] = ["read", "ls"],
): CompiledAgentNode {
  return {
    id: "analyze",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Analyze the repository.",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        thinking: "medium",
      },
      tools,
      timeoutMs,
    },
  };
}

function agentRequest(signal?: AbortSignal): PiAgentRunRequest {
  return {
    cwd: process.cwd(),
    prompt: "Analyze the repository.",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    thinking: "medium",
    tools: ["read", "ls"],
    maxOutputBytes: 65_536,
    policyBroker: testPolicyBroker(),
    protectedPaths: [],
    effectRecorder: testEffectRecorder(),
    ...(signal === undefined ? {} : { signal }),
  };
}

function sessionStats() {
  return {
    sessionFile: undefined,
    sessionId: "session-test",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: {
      input: 12,
      output: 5,
      cacheRead: 30,
      cacheWrite: 2,
      total: 49,
    },
    cost: 1.234567,
  };
}

function testEffectRecorder() {
  return new AgentEffectRecorder({
    runId: "run-agent",
    workflowId: "agent-workflow",
    nodeId: "analyze",
    attempt: 1,
  });
}

function recordEditEffect(request: PiAgentRunRequest, outcome: "committed" | "uncertain"): void {
  const target = `${request.cwd}/source.ts`;
  const operationDigest = "d".repeat(64);
  request.policyBroker.authorize({
    action: "filesystem.write",
    target,
    boundary: "inside",
    operationDigest,
  });
  request.effectRecorder.reserve({ kind: "filesystem.edit", target, operationDigest }).commit({
    beforeSha256: "a".repeat(64),
    afterSha256: "b".repeat(64),
    outcome,
  });
}

function testPolicyBroker(): PolicyBroker {
  return new PolicyBroker(
    {
      runId: "run-agent",
      workflowId: "agent-workflow",
      nodeId: "analyze",
      attempt: 1,
    },
    ["filesystem.read", "filesystem.list"],
  );
}
