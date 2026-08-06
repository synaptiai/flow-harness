import { describe, expect, it } from "vitest";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

import type { NodeExecutionContext } from "../../../../src/application/ports.js";
import type { CompiledAgentNode } from "../../../../src/domain/workflow/types.js";
import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
  type PiAgentRunRequest,
  type PiAgentRunner,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";

const context: NodeExecutionContext = {
  runId: "run-agent",
  workflowId: "agent-workflow",
  attempt: 1,
  cwd: process.cwd(),
};

describe("PiAgentExecutor", () => {
  it("passes the exact model and tool allowlist to the embedded runner", async () => {
    let request: PiAgentRunRequest | undefined;
    const runner: PiAgentRunner = {
      async run(input) {
        request = input;
        return { text: "Analyzed the repository.", stopReason: "stop" };
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
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
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
                resolve({ text: "", stopReason: "aborted", errorMessage: "aborted" });
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
      evidence: null,
    });
    expect(cleanupFinished).toBe(true);
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
      tools: ["read", "ls"],
      maxOutputBytes: 65_536,
    });

    expect(result).toEqual({
      text: "",
      textHash: createHash("sha256").update("").digest("hex"),
      textTruncated: false,
      stopReason: "error",
      errorMessage: "provider stream failed",
    });
    expect(sessionOptions?.noTools).toBe("all");
    expect(sessionOptions?.tools).toEqual(["flow_read", "flow_ls"]);
    expect(sessionOptions?.customTools?.map((tool) => tool.name)).toEqual(["flow_read", "flow_ls"]);
    expect(sessionOptions?.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getSkills().skills).toEqual([]);
    expect(sessionOptions?.resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
    expect(disposed).toBe(true);
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

function agentNode(timeoutMs = 300_000): CompiledAgentNode {
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
      tools: ["read", "ls"],
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
    ...(signal === undefined ? {} : { signal }),
  };
}
