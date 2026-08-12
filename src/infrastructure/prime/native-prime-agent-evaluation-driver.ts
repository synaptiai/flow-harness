import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  type ExternalHarnessEvaluationInput,
  type ExternalHarnessParentFrame,
  MAX_EXTERNAL_HARNESS_FRAME_BYTES,
  parseExternalHarnessParentLine,
  signExternalHarnessDriverFrame,
} from "../../domain/evaluation/external-harness-protocol.js";
import type {
  EvaluationHarnessOutcome,
  EvaluationMetrics,
} from "../../domain/evaluation/records.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import { NATIVE_PRIME_EVALUATION_CONFIG } from "./native-prime-evaluation-config.js";
import { createNoIoPrimeResourceLoader } from "./no-io-resource-loader.js";

const BROKER_PROVIDER = "flow-host-broker";
const BROKER_MODEL = "flow-host-model";
const BROKER_API = "flow-host-inference-v1";
const PRIME_KERNEL_PROXY_PATH = "/opt/flow/bin/flow-prime-kernel-proxy";

type NativePrimeDriverStage =
  | "read-supervisor-input"
  | "write-supervisor-output"
  | "resolve-workspace"
  | "load-sdk"
  | "initialize-sdk"
  | "create-ipython-tool"
  | "create-sdk-session"
  | "validate-sdk-session"
  | "observe-sdk-session"
  | "dispose-sdk-session";

class NativePrimeDriverStageError extends Error {
  constructor(
    readonly stage: NativePrimeDriverStage,
    error: unknown,
  ) {
    super(boundedReason(error));
    this.name = "NativePrimeDriverStageError";
  }
}

const contentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
      textSignature: z.string().max(16_384).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thinking"),
      thinking: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
      thinkingSignature: z
        .string()
        .max(64 * 1_024)
        .optional(),
      redacted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolCall"),
      id: z.string().min(1).max(256),
      name: z.literal("ipython"),
      arguments: z.record(z.string(), z.unknown()),
      thoughtSignature: z
        .string()
        .max(64 * 1_024)
        .optional(),
    })
    .strict(),
]);
const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(contentSchema).max(128),
    api: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    responseId: z.string().max(512).optional(),
    usage: z
      .object({
        input: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        output: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        cacheRead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        cacheWrite: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
  .strict();

export interface NativePrimeSessionEvent {
  readonly type: string;
  readonly isError?: boolean;
}

export interface NativePrimeSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: NativePrimeSessionEvent) => void): () => void;
  getSessionStats(): {
    readonly sessionId: string;
    readonly assistantMessages: number;
    readonly toolCalls: number;
  };
  lastAssistantMessage():
    | {
        readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
        readonly errorMessage?: string;
      }
    | undefined;
}

export interface NativePrimeSessionFactoryInput {
  readonly evaluation: ExternalHarnessEvaluationInput;
  readonly workspace: string;
  readonly infer: (body: string, signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
  readonly loadSdk?: () => Promise<NativePrimeSdkBindings>;
}

interface PrimeEventStream {
  push(event: Record<string, unknown>): void;
}

interface PrimeSdkSession {
  readonly thinkingLevel: string;
  prompt(text: string, options: Record<string, unknown>): Promise<void>;
  abort(): Promise<void>;
  disposeAsync(): Promise<void>;
  subscribe(listener: (event: NativePrimeSessionEvent) => void): () => void;
  getSessionStats(): ReturnType<NativePrimeSession["getSessionStats"]>;
  readonly state: {
    readonly messages: readonly {
      readonly role: string;
      readonly stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
      readonly errorMessage?: string;
    }[];
  };
}

export interface NativePrimeSdkBindings {
  readonly AuthStorage: {
    inMemory(
      data?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): {
      close(): void;
    };
  };
  readonly ModelRegistry: {
    inMemory(authStorage: unknown): {
      registerProvider(name: string, config: Record<string, unknown>): void;
      find(provider: string, model: string): unknown;
      setOnOAuthProvidersReset(callback: () => void): void;
    };
  };
  readonly SettingsManager: {
    inMemory(settings: Record<string, unknown>): unknown;
  };
  readonly SessionManager: {
    inMemory(cwd: string): unknown;
  };
  readonly createExtensionRuntime: () => unknown;
  readonly createIpythonToolDefinition: (cwd: string, options: Record<string, unknown>) => unknown;
  readonly createAssistantMessageEventStream: () => PrimeEventStream;
  readonly createAgentSession: (
    options: Record<string, unknown>,
  ) => Promise<{ readonly session: PrimeSdkSession }>;
}

export type NativePrimeSessionFactory = (
  input: NativePrimeSessionFactoryInput,
) => Promise<NativePrimeSession>;

export interface NativePrimeEvaluationSessionInput {
  readonly evaluation: ExternalHarnessEvaluationInput;
  readonly instructionText: string;
  readonly infer: (body: string, signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
  readonly createSession?: NativePrimeSessionFactory;
}

export interface NativePrimeEvaluationSessionResult {
  readonly harness: EvaluationHarnessOutcome;
  readonly metrics: EvaluationMetrics;
}

export interface NativePrimeDriverProtocolInput {
  readonly lines: AsyncIterator<string>;
  readonly writeLine: (line: string) => Promise<void>;
  readonly createSession?: NativePrimeSessionFactory;
  readonly signal?: AbortSignal;
}

export async function runNativePrimeEvaluationSession(
  input: NativePrimeEvaluationSessionInput,
): Promise<NativePrimeEvaluationSessionResult> {
  throwIfAborted(input.signal);
  const started = process.hrtime.bigint();
  const workspace = await withNativePrimeDriverStage("resolve-workspace", () =>
    realpath(input.evaluation.workspace.cwd),
  );
  throwIfAborted(input.signal);
  const createSession = input.createSession ?? createNativePrimeSdkSession;
  const session = await withNativePrimeDriverStage("create-sdk-session", () =>
    createSession({
      evaluation: input.evaluation,
      workspace,
      infer: input.infer,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  );
  let toolErrors = 0;
  const unsubscribe = withNativePrimeDriverSyncStage("observe-sdk-session", () =>
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.isError === true) {
        toolErrors += 1;
      }
    }),
  );
  let abortPromise: Promise<void> | undefined;
  const abortSession = () => {
    abortPromise ??= session.abort().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abortSession, { once: true });
  try {
    let promptError: unknown;
    try {
      await session.prompt(taskPrompt(input.instructionText));
    } catch (error) {
      promptError = error;
    }
    const stats = withNativePrimeDriverSyncStage("observe-sdk-session", () =>
      session.getSessionStats(),
    );
    const metrics = metricsFromStats(stats, toolErrors, elapsedMs(started));
    if (input.signal?.aborted === true) {
      return Object.freeze({
        harness: Object.freeze({
          outcome: "cancelled",
          runId: stats.sessionId,
          reason: abortReason(input.signal),
        }),
        metrics,
      });
    }
    if (promptError !== undefined) {
      return Object.freeze({
        harness: Object.freeze({
          outcome: "failed",
          runId: stats.sessionId,
          reason: boundedReason(promptError),
        }),
        metrics,
      });
    }
    const finalMessage = withNativePrimeDriverSyncStage("observe-sdk-session", () =>
      session.lastAssistantMessage(),
    );
    if (finalMessage === undefined) {
      return Object.freeze({
        harness: Object.freeze({
          outcome: "missing_output",
          runId: stats.sessionId,
          reason: "Prime session ended without a terminal assistant message",
        }),
        metrics,
      });
    }
    const failed = finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted";
    return Object.freeze({
      harness: Object.freeze({
        outcome: failed ? "failed" : "completed",
        runId: stats.sessionId,
        reason: failed
          ? (finalMessage.errorMessage ?? `Prime stopped with ${finalMessage.stopReason}`)
          : null,
      }),
      metrics,
    });
  } finally {
    input.signal?.removeEventListener("abort", abortSession);
    await abortPromise;
    unsubscribe();
    await withNativePrimeDriverStage("dispose-sdk-session", () => session.dispose());
  }
}

export async function runNativePrimeDriverProtocol(
  input: NativePrimeDriverProtocolInput,
): Promise<void> {
  const hello = await withNativePrimeDriverStage("read-supervisor-input", async () => {
    const first = await input.lines.next();
    if (first.done === true) {
      throw new Error("private supervisor channel closed before hello");
    }
    const parsed = parseExternalHarnessParentLine(first.value);
    if (parsed.type !== "hello" || parsed.sequence !== 1) {
      throw new Error("first supervisor frame must be hello sequence 1");
    }
    return parsed;
  });
  const channel = new PrimeSupervisorProtocolChannel(hello, input.lines, input.writeLine);
  await withNativePrimeDriverStage("write-supervisor-output", () => channel.sendReady());
  const result = await runNativePrimeEvaluationSession({
    evaluation: hello.payload.evaluation,
    instructionText: hello.payload.instructionText,
    infer: (body, signal) => channel.infer(body, signal),
    ...(input.createSession === undefined ? {} : { createSession: input.createSession }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  await withNativePrimeDriverStage("write-supervisor-output", () => channel.sendTerminal(result));
}

class PrimeSupervisorProtocolChannel {
  #driverSequence = 0;
  #parentSequence = 1;

  constructor(
    readonly hello: Extract<ExternalHarnessParentFrame, { type: "hello" }>,
    readonly lines: AsyncIterator<string>,
    readonly writeLine: (line: string) => Promise<void>,
  ) {}

  async sendReady(): Promise<void> {
    await this.#send("ready", {
      trialId: this.hello.payload.trialId,
      identityDigest: this.hello.payload.identityDigest,
    });
  }

  async infer(body: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const requestId = randomUUID();
    await this.#send("inference_request", {
      requestId,
      body,
      bodySha256: sha256(body),
    });
    const next = await this.lines.next();
    if (next.done === true) {
      throw new Error("private supervisor channel closed during inference");
    }
    const frame = parseExternalHarnessParentLine(next.value, this.hello.payload.secretHex);
    this.#parentSequence += 1;
    if (
      frame.sessionId !== this.hello.sessionId ||
      frame.sequence !== this.#parentSequence ||
      frame.type !== "inference_response" ||
      frame.payload.requestId !== requestId
    ) {
      throw new Error("supervisor inference response contradicts the active request");
    }
    throwIfAborted(signal);
    return frame.payload.body;
  }

  async sendTerminal(result: NativePrimeEvaluationSessionResult): Promise<void> {
    await this.#send("terminal", result);
  }

  async #send(type: "ready" | "inference_request" | "terminal", payload: unknown): Promise<void> {
    this.#driverSequence += 1;
    const frame = signExternalHarnessDriverFrame(
      {
        version: 1,
        sequence: this.#driverSequence,
        sessionId: this.hello.sessionId,
        type,
        payload,
      },
      this.hello.payload.secretHex,
    );
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new Error(`Prime driver frame exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
    }
    await this.writeLine(line);
  }
}

export async function createNativePrimeSdkSession(
  input: NativePrimeSessionFactoryInput,
): Promise<NativePrimeSession> {
  const sdk = await withNativePrimeDriverStage("load-sdk", () =>
    (input.loadSdk ?? loadNativePrimeSdk)(),
  );
  const authStorage = withNativePrimeDriverSyncStage("initialize-sdk", () =>
    sdk.AuthStorage.inMemory({}, { usePrimeCliConfig: false }),
  );
  try {
    const initialized = withNativePrimeDriverSyncStage("initialize-sdk", () => {
      const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
      modelRegistry.registerProvider(BROKER_PROVIDER, {
        api: BROKER_API,
        apiKey: "flow-internal-broker",
        baseUrl: "flow://host-inference",
        streamSimple: (
          model: Record<string, unknown>,
          context: Record<string, unknown>,
          options?: { readonly signal?: AbortSignal },
        ) => createBrokerStream(sdk, model, context, options?.signal ?? input.signal, input.infer),
        models: [brokerModelDefinition(input.evaluation)],
      });
      const selectedModel = modelRegistry.find(BROKER_PROVIDER, BROKER_MODEL);
      if (selectedModel === undefined) {
        throw new Error("native Prime broker model is unavailable after registration");
      }
      return {
        modelRegistry,
        selectedModel,
        settingsManager: sdk.SettingsManager.inMemory(NATIVE_PRIME_EVALUATION_CONFIG.settings),
        resourceLoader: createNoIoPrimeResourceLoader(sdk.createExtensionRuntime(), {
          systemPrompt: lockedSystemPrompt(),
        }),
        mcpManager: noOpMcpManager(),
      };
    });
    const ipython = withNativePrimeDriverSyncStage("create-ipython-tool", () =>
      sdk.createIpythonToolDefinition(input.workspace, {
        python: PRIME_KERNEL_PROXY_PATH,
      }),
    );
    const { session } = await withNativePrimeDriverStage("create-sdk-session", () =>
      sdk.createAgentSession({
        cwd: input.workspace,
        agentDir: input.workspace,
        authStorage,
        modelRegistry: initialized.modelRegistry,
        model: initialized.selectedModel,
        thinkingLevel: input.evaluation.controls.model.thinking,
        settingsManager: initialized.settingsManager,
        sessionManager: sdk.SessionManager.inMemory(input.workspace),
        resourceLoader: initialized.resourceLoader,
        mcpManager: initialized.mcpManager,
        customTools: [ipython],
        ...NATIVE_PRIME_EVALUATION_CONFIG.sessionOptions,
      }),
    );
    if (session.thinkingLevel !== input.evaluation.controls.model.thinking) {
      await session.disposeAsync();
      throw new NativePrimeDriverStageError(
        "validate-sdk-session",
        new Error(
          `Prime applied thinking level "${session.thinkingLevel}" instead of "${input.evaluation.controls.model.thinking}"`,
        ),
      );
    }
    return adaptSdkSession(session, authStorage);
  } catch (error) {
    authStorage.close();
    throw error;
  }
}

export function nativePrimeDriverFailureDiagnostic(error: unknown): string {
  return `Prime driver stage failure: ${
    error instanceof NativePrimeDriverStageError ? error.stage : "unexpected"
  }`;
}

async function withNativePrimeDriverStage<T>(
  stage: NativePrimeDriverStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NativePrimeDriverStageError) {
      throw error;
    }
    throw new NativePrimeDriverStageError(stage, error);
  }
}

function withNativePrimeDriverSyncStage<T>(stage: NativePrimeDriverStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativePrimeDriverStageError) {
      throw error;
    }
    throw new NativePrimeDriverStageError(stage, error);
  }
}

async function loadNativePrimeSdk(): Promise<NativePrimeSdkBindings> {
  const agentModuleName = "prime-agent";
  const aiModuleName = "@earendil-works/pi-ai";
  const [agent, ai] = await Promise.all([import(agentModuleName), import(aiModuleName)]);
  return {
    AuthStorage: agent.AuthStorage,
    ModelRegistry: agent.ModelRegistry,
    SettingsManager: agent.SettingsManager,
    SessionManager: agent.SessionManager,
    createExtensionRuntime: agent.createExtensionRuntime,
    createIpythonToolDefinition: agent.createIpythonToolDefinition,
    createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
    createAgentSession: agent.createAgentSession,
  } as NativePrimeSdkBindings;
}

function adaptSdkSession(
  session: PrimeSdkSession,
  authStorage: { close(): void },
): NativePrimeSession {
  let disposed = false;
  return Object.freeze({
    prompt: (text: string) =>
      session.prompt(text, {
        expandPromptTemplates: false,
        internalPrompt: true,
        suppressAutonomousContinuation: true,
      }),
    abort: () => session.abort(),
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        await session.disposeAsync();
      } finally {
        authStorage.close();
      }
    },
    subscribe: (listener: (event: NativePrimeSessionEvent) => void) => session.subscribe(listener),
    getSessionStats: () => session.getSessionStats(),
    lastAssistantMessage: () => {
      const last = session.state.messages.at(-1);
      if (last?.role !== "assistant" || last.stopReason === undefined) {
        return undefined;
      }
      return {
        stopReason: last.stopReason,
        ...(last.errorMessage === undefined ? {} : { errorMessage: last.errorMessage }),
      };
    },
  });
}

function noOpMcpManager() {
  return Object.freeze({
    registerUserProviders: () => undefined,
    getDisabledBuiltinSkillOverrides: () => [],
    hostHandlers: () => ({}),
    refresh: () => undefined,
  });
}

function createBrokerStream(
  sdk: NativePrimeSdkBindings,
  model: Record<string, unknown>,
  context: Record<string, unknown>,
  signal: AbortSignal | undefined,
  infer: NativePrimeSessionFactoryInput["infer"],
): PrimeEventStream {
  const stream = sdk.createAssistantMessageEventStream();
  const partial = emptyAssistantMessage(model, "stop");
  stream.push({ type: "start", partial });
  void (async () => {
    try {
      throwIfAborted(signal);
      const body = JSON.stringify({ version: 1, context: projectBrokerContext(context) });
      if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
        throw new Error(
          `Prime inference context exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`,
        );
      }
      const response = await infer(body, signal);
      const message = parseBrokerMessage(response, model);
      emitAssistantContent(stream, partial, message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    } catch (error) {
      const message = {
        ...emptyAssistantMessage(model, signal?.aborted === true ? "aborted" : "error"),
        errorMessage: boundedReason(error),
      };
      stream.push({ type: "error", reason: message.stopReason, error: message });
    }
  })();
  return stream;
}

function projectBrokerContext(context: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const tools = Array.isArray(context.tools) ? context.tools : undefined;
  return {
    ...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}),
    messages: messages.map(projectBrokerMessage),
    ...(tools === undefined
      ? {}
      : {
          tools: tools.map((tool) => {
            const value = asRecord(tool, "Prime broker tool");
            return {
              name: value.name,
              description: value.description,
              parameters: value.parameters,
              ...(value.strict === undefined ? {} : { strict: value.strict }),
            };
          }),
        }),
  };
}

function projectBrokerMessage(message: unknown): Record<string, unknown> {
  const value = asRecord(message, "Prime broker message");
  if (value.role === "user") {
    return { role: "user", content: projectTextContent(value.content), timestamp: value.timestamp };
  }
  if (value.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      content: projectTextContent(value.content),
      isError: value.isError,
      timestamp: value.timestamp,
    };
  }
  if (value.role !== "assistant" || !Array.isArray(value.content)) {
    throw new Error("native Prime broker context contains an unsupported message");
  }
  return {
    role: "assistant",
    content: value.content.map((block) => {
      const content = asRecord(block, "Prime assistant content");
      if (content.type !== "text" && content.type !== "thinking" && content.type !== "toolCall") {
        throw new Error("native Prime broker context contains unsupported assistant content");
      }
      return content;
    }),
    api: value.api,
    provider: value.provider,
    model: value.model,
    ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
    usage: value.usage,
    stopReason: value.stopReason,
    timestamp: value.timestamp,
  };
}

function projectTextContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw new Error("native Prime broker context contains invalid text content");
  }
  return content.map((block) => {
    const value = asRecord(block, "Prime text content");
    if (value.type !== "text" || typeof value.text !== "string") {
      throw new Error("native Prime broker context supports text content only");
    }
    return value;
  });
}

function parseBrokerMessage(response: string, model: Record<string, unknown>) {
  if (Buffer.byteLength(response, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`Prime inference response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  const parsed = assistantMessageSchema.safeParse(
    parseStrictJson(response, {
      maxDepth: 64,
      maxNodes: 200_000,
      valueLabel: "native Prime broker response",
    }),
  );
  if (!parsed.success) {
    throw new Error("native Prime broker response is not a valid assistant message", {
      cause: parsed.error,
    });
  }
  return {
    ...parsed.data,
    api: String(model.api),
    provider: String(model.provider),
    model: String(model.id),
  };
}

function emitAssistantContent(
  stream: PrimeEventStream,
  partial: Record<string, unknown> & { content: unknown[] },
  message: z.infer<typeof assistantMessageSchema>,
): void {
  partial.usage = message.usage;
  partial.stopReason = message.stopReason;
  for (const block of message.content) {
    const contentIndex = partial.content.length;
    partial.content.push(block);
    if (block.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
    } else if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial });
    } else {
      stream.push({ type: "thinking_start", contentIndex, partial });
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
    }
  }
}

function emptyAssistantMessage(model: Record<string, unknown>, stopReason: string) {
  return {
    role: "assistant",
    content: [] as unknown[],
    api: String(model.api),
    provider: String(model.provider),
    model: String(model.id),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function brokerModelDefinition(evaluation: ExternalHarnessEvaluationInput) {
  return Object.freeze({
    id: BROKER_MODEL,
    name: "Flow host model",
    api: BROKER_API,
    baseUrl: "flow://host-inference",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.max(128_000, evaluation.controls.budget.maxModelTokens * 4),
    maxTokens: evaluation.controls.budget.maxModelTokens,
  });
}

function lockedSystemPrompt(): string {
  return [
    "You are the native Prime Agent profile in one Flow evaluation trial.",
    "Use only the IPython tool to complete the supplied task.",
    "Do not inspect Flow state or provider configuration.",
    "Flow verifies the workspace after this session.",
  ].join("\n");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function metricsFromStats(
  stats: ReturnType<NativePrimeSession["getSessionStats"]>,
  toolErrors: number,
  wallTimeMs: number,
): EvaluationMetrics {
  return Object.freeze({
    costUsdMicros: null,
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolErrors,
    wallTimeMs,
    activeTimeMs: null,
    interventions: null,
    policyViolations: null,
    recoveryAttempts: 0,
    recoveryOutcome: "not_attempted",
  });
}

function taskPrompt(instructionText: string): string {
  return [
    "Complete the evaluation task in the current workspace.",
    "Use only the IPython tool.",
    "Do not describe a result that you did not create.",
    "",
    "Task instruction:",
    instructionText,
  ].join("\n");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error(abortReason(signal));
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return boundedReason(reason ?? new Error("operator cancelled the Prime session"));
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable Prime session error";
  }
}

function elapsedMs(started: bigint): number {
  const duration = Number((process.hrtime.bigint() - started) / 1_000_000n);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runDriverProcess(): Promise<void> {
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const input = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Prime driver was terminated"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    await runNativePrimeDriverProtocol({
      lines: input[Symbol.asyncIterator](),
      writeLine: (line) => writeSocketLine(socket, line),
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    input.close();
    socket.end();
  }
}

async function writeSocketLine(socket: Socket, line: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    socket.write(`${line}\n`, (error) => {
      if (error === null || error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMainModule()) {
  void runDriverProcess().catch((error: unknown) => {
    process.stderr.write(`${nativePrimeDriverFailureDiagnostic(error)}\n`);
    process.exitCode = 1;
  });
}
