import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../application/ports.js";
import type { NodeFailure } from "../../domain/run/events.js";
import type {
  AgentToolName,
  CompiledAgentNode,
  ThinkingLevel,
} from "../../domain/workflow/types.js";

export interface PiAgentRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools: readonly AgentToolName[];
  readonly signal?: AbortSignal;
}

export interface PiAgentRunResult {
  readonly text: string;
  readonly stopReason: PiTerminalStopReason;
  readonly errorMessage?: string;
}

export type PiTerminalStopReason =
  | "aborted"
  | "deferred"
  | "error"
  | "length"
  | "pending"
  | "stop"
  | "toolUse";

export interface PiAgentRunner {
  run(request: PiAgentRunRequest): Promise<PiAgentRunResult>;
}

export class PiAgentExecutor implements AgentExecutor {
  constructor(
    readonly runner: PiAgentRunner = new EmbeddedPiAgentRunner(),
    readonly now: () => number = performance.now.bind(performance),
    readonly abortGraceMs = 5_000,
  ) {
    if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 0) {
      throw new RangeError("abortGraceMs must be a non-negative safe integer");
    }
  }

  async execute(
    node: CompiledAgentNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    const startedAt = this.now();
    if (isAborted(context.signal)) {
      return agentFailure("pi_agent_aborted", "agent execution was cancelled before start");
    }

    const timeoutController = new AbortController();
    const combinedSignal =
      context.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([context.signal, timeoutController.signal]);
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let removeExternalAbortListener: () => void = () => undefined;
    try {
      const runPromise = this.runner.run({
        cwd: context.cwd,
        prompt: node.agent.prompt,
        provider: node.agent.model.provider,
        model: node.agent.model.id,
        thinking: node.agent.model.thinking,
        tools: node.agent.tools,
        signal: combinedSignal,
      });
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          timeoutController.abort(new Error("Flow agent timeout"));
          resolve("timeout");
        }, node.agent.timeoutMs);
      });
      const externalAbort = new Promise<"external_abort">((resolve) => {
        const signal = context.signal;
        if (signal === undefined) {
          return;
        }
        const handleAbort = () => resolve("external_abort");
        signal.addEventListener("abort", handleAbort, { once: true });
        removeExternalAbortListener = () => signal.removeEventListener("abort", handleAbort);
        if (signal.aborted) {
          handleAbort();
        }
      });
      const settled = await Promise.race([
        runPromise.then((result) => ({ kind: "result" as const, result })),
        timeout.then(() => ({ kind: "timeout" as const })),
        externalAbort.then(() => ({ kind: "external_abort" as const })),
      ]);

      if (settled.kind === "timeout") {
        const cleanupSettled = await settlesWithin(runPromise, this.abortGraceMs);
        return agentFailure(
          "pi_agent_timeout",
          cleanupSettled
            ? `agent exceeded timeout of ${node.agent.timeoutMs}ms`
            : `agent exceeded timeout of ${node.agent.timeoutMs}ms and abort cleanup did not settle within ${this.abortGraceMs}ms`,
          cleanupSettled ? "none" : "uncertain",
        );
      }
      if (settled.kind === "external_abort") {
        const cleanupSettled = await settlesWithin(runPromise, this.abortGraceMs);
        const message = abortMessage(context.signal);
        return agentFailure(
          "pi_agent_aborted",
          cleanupSettled
            ? message
            : `${message}; abort cleanup did not settle within ${this.abortGraceMs}ms`,
          cleanupSettled ? "none" : "uncertain",
        );
      }
      const result = settled.result;
      if (isAborted(context.signal)) {
        return agentFailure("pi_agent_aborted", abortMessage(context.signal));
      }
      if (result.stopReason !== "stop") {
        const code =
          result.stopReason === "aborted"
            ? "pi_agent_aborted"
            : result.stopReason === "error"
              ? "pi_agent_error"
              : "pi_agent_incomplete";
        return agentFailure(
          code,
          result.errorMessage ?? `Pi session ended with stop reason "${result.stopReason}"`,
        );
      }

      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: node.agent.model.provider,
          model: node.agent.model.id,
          text: result.text,
          durationMs: Math.max(0, this.now() - startedAt),
        },
      };
    } catch (error) {
      if (timedOut) {
        return agentFailure(
          "pi_agent_timeout",
          `agent exceeded timeout of ${node.agent.timeoutMs}ms`,
        );
      }
      if (isAborted(context.signal)) {
        return agentFailure("pi_agent_aborted", abortMessage(context.signal));
      }
      return agentFailure(
        "pi_agent_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      removeExternalAbortListener();
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

export class EmbeddedPiAgentRunner implements PiAgentRunner {
  constructor(
    readonly createModelRuntime: (signal?: AbortSignal) => Promise<ModelRuntime> = (signal) =>
      ModelRuntime.create({
        allowModelNetwork: false,
        ...(signal === undefined ? {} : { signal }),
      }),
    readonly createSession: typeof createAgentSession = createAgentSession,
  ) {}

  async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
    throwIfAborted(request.signal);

    const modelRuntime = await this.createModelRuntime(request.signal);
    throwIfAborted(request.signal);
    const model = modelRuntime.getModel(request.provider, request.model);
    if (model === undefined) {
      throw new Error(`Pi model "${request.provider}/${request.model}" is not available`);
    }

    const resourceLoader = createLockedResourceLoader();
    const { session } = await this.createSession({
      cwd: request.cwd,
      modelRuntime,
      model,
      thinkingLevel: request.thinking,
      tools: [...request.tools],
      resourceLoader,
      sessionManager: SessionManager.inMemory(request.cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    if (isAborted(request.signal)) {
      await session.abort().catch(() => undefined);
      session.dispose();
      throw new PiAgentAbortError(abortMessage(request.signal));
    }

    let text = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });
    let abortPromise: Promise<void> | undefined;
    const abortHandler = () => {
      abortPromise ??= session.abort().catch(() => undefined);
    };
    request.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      const finalMessage = session.state.messages.at(-1);
      if (finalMessage?.role !== "assistant") {
        return {
          text,
          stopReason: "error",
          errorMessage: "Pi session ended without a terminal assistant message",
        };
      }
      return {
        text,
        stopReason: finalMessage.stopReason,
        ...(finalMessage.errorMessage === undefined
          ? {}
          : { errorMessage: finalMessage.errorMessage }),
      };
    } finally {
      request.signal?.removeEventListener("abort", abortHandler);
      await abortPromise;
      unsubscribe();
      session.dispose();
    }
  }
}

class PiAgentAbortError extends Error {
  override readonly name = "PiAgentAbortError";
}

function agentFailure(
  code: string,
  message: string,
  sideEffectStatus: NodeFailure["sideEffectStatus"] = "none",
): NodeExecutionOutcome {
  const failure: NodeFailure = {
    code,
    message,
    retryable: false,
    sideEffectStatus,
  };
  return { status: "failed", error: failure, evidence: null };
}

function createLockedResourceLoader(): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      [
        "You are executing one bounded node in a Flow workflow.",
        "Use only the tools provided to complete the node prompt.",
        "Do not choose, skip, or claim authority over workflow transitions.",
        "Your response is diagnostic node output; Flow verifies completion independently.",
      ].join("\n"),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) {
    throw new PiAgentAbortError(abortMessage(signal));
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "agent execution was cancelled";
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (settled: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
