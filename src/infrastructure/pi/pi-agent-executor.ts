import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHash, type Hash } from "node:crypto";

import type {
  AgentExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../application/ports.js";
import type { AgentEvidence, NodeFailure } from "../../domain/run/events.js";
import type {
  AgentToolName,
  CompiledAgentNode,
  ThinkingLevel,
} from "../../domain/workflow/types.js";
import { createWorkspaceReadTools } from "./workspace-read-tools.js";

export interface PiAgentRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly tools: readonly AgentToolName[];
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface PiAgentRunResult {
  readonly text: string;
  readonly stopReason: PiTerminalStopReason;
  readonly errorMessage?: string;
  readonly outputLimitExceeded?: boolean;
  readonly textHash?: string;
  readonly textTruncated?: boolean;
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
    readonly maxOutputBytes = 65_536,
  ) {
    if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 0) {
      throw new RangeError("abortGraceMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 65_536) {
      throw new RangeError("maxOutputBytes must be between 1 and 65536");
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
        maxOutputBytes: this.maxOutputBytes,
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
      const normalized = normalizeAgentResult(result, this.maxOutputBytes);
      const evidence: AgentEvidence = {
        kind: "agent",
        provider: node.agent.model.provider,
        model: node.agent.model.id,
        text: normalized.text,
        textHash: normalized.textHash,
        textTruncated: normalized.textTruncated,
        durationMs: Math.max(0, this.now() - startedAt),
      };
      if (normalized.outputLimitExceeded) {
        return agentFailure(
          "pi_agent_output_limit",
          `agent output exceeded ${this.maxOutputBytes} UTF-8 bytes`,
          "none",
          evidence,
        );
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
          boundedMessage(
            result.errorMessage ?? `Pi session ended with stop reason "${result.stopReason}"`,
          ),
        );
      }

      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: node.agent.model.provider,
          model: node.agent.model.id,
          text: normalized.text,
          textHash: normalized.textHash,
          textTruncated: normalized.textTruncated,
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
        boundedMessage(error instanceof Error ? error.message : String(error)),
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
    const tools = await createWorkspaceReadTools(request.cwd, request.tools);
    throwIfAborted(request.signal);
    const { session } = await this.createSession({
      cwd: request.cwd,
      modelRuntime,
      model,
      thinkingLevel: request.thinking,
      noTools: "all",
      tools: [...tools.names],
      customTools: [...tools.definitions],
      resourceLoader,
      sessionManager: SessionManager.inMemory(request.cwd),
      settingsManager: SettingsManager.inMemory(),
    });

    if (isAborted(request.signal)) {
      await session.abort().catch(() => undefined);
      session.dispose();
      throw new PiAgentAbortError(abortMessage(request.signal));
    }

    const output = new BoundedAgentOutput(request.maxOutputBytes);
    let abortPromise: Promise<void> | undefined;
    const abortSession = () => {
      abortPromise ??= session.abort().catch(() => undefined);
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        output.add(event.assistantMessageEvent.delta);
        if (output.truncated) {
          abortSession();
        }
      }
    });
    const abortHandler = abortSession;
    request.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      try {
        await session.prompt(request.prompt, { expandPromptTemplates: false });
      } catch (error) {
        if (!output.truncated) {
          throw error;
        }
      }
      const finalMessage = session.state.messages.at(-1);
      if (finalMessage?.role !== "assistant") {
        return {
          ...output.result(),
          stopReason: output.truncated ? "aborted" : "error",
          ...(output.truncated
            ? { outputLimitExceeded: true }
            : { errorMessage: "Pi session ended without a terminal assistant message" }),
        };
      }
      return {
        ...output.result(),
        stopReason: finalMessage.stopReason,
        ...(output.truncated ? { outputLimitExceeded: true } : {}),
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
  evidence: AgentEvidence | null = null,
): NodeExecutionOutcome {
  const failure: NodeFailure = {
    code,
    message: boundedMessage(message),
    retryable: false,
    sideEffectStatus,
  };
  return { status: "failed", error: failure, evidence };
}

interface NormalizedAgentResult {
  readonly text: string;
  readonly textHash: string;
  readonly textTruncated: boolean;
  readonly outputLimitExceeded: boolean;
}

function normalizeAgentResult(
  result: PiAgentRunResult,
  maxOutputBytes: number,
): NormalizedAgentResult {
  const output = new BoundedAgentOutput(maxOutputBytes);
  output.add(result.text);
  const bounded = output.result();
  const textTruncated = result.textTruncated === true || bounded.textTruncated;
  return {
    text: bounded.text,
    textHash:
      result.textHash !== undefined && /^[a-f0-9]{64}$/.test(result.textHash)
        ? result.textHash
        : bounded.textHash,
    textTruncated,
    outputLimitExceeded: result.outputLimitExceeded === true || textTruncated,
  };
}

class BoundedAgentOutput {
  readonly #hash: Hash = createHash("sha256");
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;
  #digest: string | undefined;

  constructor(readonly maxBytes: number) {}

  get truncated(): boolean {
    return this.#totalBytes > this.maxBytes;
  }

  add(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    this.#hash.update(chunk);
    this.#totalBytes += chunk.length;
    const remaining = this.maxBytes - this.#capturedBytes;
    if (remaining <= 0) {
      return;
    }
    const captured = chunk.subarray(0, remaining);
    this.#chunks.push(captured);
    this.#capturedBytes += captured.length;
  }

  result(): Pick<AgentEvidence, "text" | "textHash" | "textTruncated"> {
    this.#digest ??= this.#hash.digest("hex");
    return {
      text: decodeBoundedUtf8(Buffer.concat(this.#chunks), this.maxBytes),
      textHash: this.#digest,
      textTruncated: this.truncated,
    };
  }
}

function decodeBoundedUtf8(buffer: Buffer, maxBytes: number): string {
  let end = buffer.length;
  while (end > 0) {
    const text = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(text, "utf8") <= maxBytes) {
      return text;
    }
    end -= 1;
  }
  return "";
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 16_384) {
    return message;
  }
  return `${bytes.subarray(0, 16_300).toString("utf8")}… [truncated]`;
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
