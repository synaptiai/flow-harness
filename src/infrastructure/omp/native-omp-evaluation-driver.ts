import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  ModelRegistry,
  replaceEditSchema,
  SessionManager,
  Settings,
  type ProviderConfigInput,
  type ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import {
  type ConfiguredThinkingLevel,
  parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";
import { defineTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import {
  AuthStorage,
  type AuthCredential,
  type AuthCredentialStore,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type StoredAuthCredential,
  type as ompType,
} from "@oh-my-pi/pi-ai";
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

const BROKER_PROVIDER = "flow-host-broker";
const BROKER_MODEL = "flow-host-model";
const BROKER_API = "flow-host-inference-v1";
const REDACTED_THINKING_SIGNATURE_PREFIX = "flow-omp-redacted-v1:";
const VISIBLE_THINKING_SIGNATURE_PREFIX = "flow-omp-visible-v1:";

const readParameters = ompType({ path: "string" });
const usageSchema = z
  .object({
    input: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheRead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reasoningTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
  .strict();
const assistantContentSchema = z.discriminatedUnion("type", [
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
      name: z.enum(["read", "edit"]),
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
    content: z.array(assistantContentSchema).max(128),
    api: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    responseModel: z.string().max(256).optional(),
    responseId: z.string().max(512).optional(),
    usage: usageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().max(16_384).optional(),
    rawStopReason: z.string().max(256).optional(),
    timestamp: z.number().finite(),
  })
  .strict();

export interface NativeOmpEvaluationSessionInput {
  readonly evaluation: ExternalHarnessEvaluationInput;
  readonly instructionText: string;
  readonly infer: (body: string, signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
}

export interface NativeOmpEvaluationSessionResult {
  readonly harness: EvaluationHarnessOutcome;
  readonly metrics: EvaluationMetrics;
}

export async function runNativeOmpEvaluationSession(
  input: NativeOmpEvaluationSessionInput,
): Promise<NativeOmpEvaluationSessionResult> {
  throwIfAborted(input.signal);
  const started = process.hrtime.bigint();
  const workspace = await realpath(input.evaluation.workspace.cwd);
  const authStorage = new AuthStorage(new EmptyAuthCredentialStore(), {
    configValueResolver: async () => undefined,
    usageFetch: async () => {
      throw new Error("native OMP credential storage cannot use the network");
    },
  });
  const modelRegistry = new ModelRegistry(authStorage, undefined, {
    ignoreLocalModelConfig: true,
    fetch: async () => {
      throw new Error("native OMP model discovery cannot use the network");
    },
  });
  let model: Model<string> | undefined;
  modelRegistry.registerProvider(BROKER_PROVIDER, {
    api: BROKER_API,
    apiKey: "flow-internal-broker",
    baseUrl: "flow://host-inference",
    streamSimple: (_model, context, options) => {
      if (model === undefined) {
        throw new Error("native OMP broker model is unavailable during inference");
      }
      return brokerStream(model, context, options?.signal ?? input.signal, input.infer);
    },
    models: [brokerModelDefinition(input.evaluation)],
  });
  model = modelRegistry.find(BROKER_PROVIDER, BROKER_MODEL);
  if (model === undefined) {
    authStorage.close();
    throw new Error("native OMP broker model is unavailable after registration");
  }
  const selected = model;
  const settings = Settings.isolated({
    "compaction.enabled": false,
    "compaction.midTurnEnabled": false,
    "edit.mode": "replace",
    "images.autoResize": false,
    includeWorkspaceTree: false,
    "lsp.enabled": false,
    "memory.backend": "off",
    "retry.enabled": false,
    "retry.maxRetries": 0,
    "retry.modelFallback": false,
    "retry.usageAwareFallback": false,
  });
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: workspace,
    authStorage,
    modelRegistry,
    model: selected,
    thinkingLevel: ompThinkingLevel(input.evaluation.controls.model.thinking),
    deadline: Date.now() + input.evaluation.controls.budget.maxExecutionMs,
    systemPrompt: lockedSystemPrompt(),
    customTools: workspaceToolDefinitions(workspace),
    toolNames: ["read", "edit"],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    settings,
    sessionManager: SessionManager.inMemory(workspace),
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [],
    preloadedExtensionPaths: [],
    preloadedCustomToolPaths: [],
    skills: [],
    rules: [],
    contextFiles: [],
    workspaceTree: {
      rootPath: workspace,
      rendered: "",
      truncated: false,
      totalLines: 0,
      agentsMdFiles: [],
    },
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    autoApprove: true,
    hasUI: false,
  });
  const expectedThinking = ompThinkingLevel(input.evaluation.controls.model.thinking);
  if (session.thinkingLevel !== expectedThinking) {
    await session.dispose();
    authStorage.close();
    throw new Error(
      `OMP applied thinking level "${session.thinkingLevel}" instead of "${expectedThinking}"`,
    );
  }
  let toolErrors = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.isError) {
      toolErrors += 1;
    }
  });
  let abortPromise: Promise<void> | undefined;
  const abortSession = () => {
    abortPromise ??= session.abort().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", abortSession, { once: true });
  try {
    let promptError: unknown;
    try {
      await session.prompt(taskPrompt(input.instructionText), { expandPromptTemplates: false });
    } catch (error) {
      promptError = error;
    }
    const stats = session.getSessionStats();
    const metrics = metricsFromStats(stats, toolErrors, elapsedMs(started));
    const finalMessage = session.state.messages.at(-1);
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
    if (finalMessage?.role !== "assistant") {
      return Object.freeze({
        harness: Object.freeze({
          outcome: "missing_output",
          runId: stats.sessionId,
          reason: "OMP session ended without a terminal assistant message",
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
          ? (finalMessage.errorMessage ?? `OMP stopped with ${finalMessage.stopReason}`)
          : null,
      }),
      metrics,
    });
  } finally {
    input.signal?.removeEventListener("abort", abortSession);
    await abortPromise;
    unsubscribe();
    await session.dispose();
    authStorage.close();
  }
}

function workspaceToolDefinitions(workspace: string) {
  const invoke = async (
    path: string,
    params: Record<string, unknown>,
    ctx: Parameters<ToolDefinition["execute"]>[4],
  ) => {
    await assertWorkspaceFile(path, workspace);
    if (ctx.invokeTool === undefined) {
      throw new Error("OMP native tool delegation is unavailable");
    }
    return ctx.invokeTool(params);
  };
  const readTool = {
    name: "read",
    label: "Read",
    description: "Read one existing file in the trial workspace.",
    parameters: readParameters,
    approval: "read",
    strict: true,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      invoke(params.path, params, ctx),
  } satisfies ToolDefinition<typeof readParameters>;
  const editTool = {
    name: "edit",
    label: "Edit",
    description: "Replace exact text in one existing file in the trial workspace.",
    parameters: replaceEditSchema,
    approval: "write",
    strict: true,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      invoke(params.path, params, ctx),
  } satisfies ToolDefinition<typeof replaceEditSchema>;
  return [defineTool(readTool), defineTool(editTool)];
}

async function assertWorkspaceFile(path: string, workspace: string): Promise<void> {
  if (path.includes("://")) {
    throw new Error("native OMP tool paths must be local file paths");
  }
  const canonical = await realpath(resolve(workspace, path));
  if (!isAtOrWithin(canonical, workspace)) {
    throw new Error("native OMP tool path is outside the trial workspace");
  }
}

function isAtOrWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function brokerStream(
  model: Model<string>,
  context: Context,
  signal: AbortSignal | undefined,
  infer: NativeOmpEvaluationSessionInput["infer"],
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = emptyAssistantMessage(model, "stop");
  stream.push({ type: "start", partial });
  void (async () => {
    try {
      throwIfAborted(signal);
      const body = JSON.stringify({ version: 1, context: projectBrokerContext(context) });
      if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
        throw new Error(`OMP inference context exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
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
      const message: AssistantMessage = {
        ...emptyAssistantMessage(model, signal?.aborted === true ? "aborted" : "error"),
        errorMessage: boundedReason(error),
      };
      stream.push({
        type: "error",
        reason: message.stopReason as "aborted" | "error",
        error: message,
      });
    }
  })();
  return stream;
}

function projectBrokerContext(context: Context): Record<string, unknown> {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: [...context.systemPrompt] }),
    messages: context.messages.map(projectBrokerMessage),
    ...(context.tools === undefined
      ? {}
      : {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(tool.strict === undefined ? {} : { strict: tool.strict }),
          })),
        }),
  };
}

function projectBrokerMessage(message: Message): Record<string, unknown> {
  if (message.role === "user" || message.role === "developer") {
    return {
      role: message.role,
      content: projectTextContent(message.content),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: projectTextContent(message.content),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  const content = message.content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      };
    }
    if (block.type === "thinking") {
      if (block.thinkingSignature?.startsWith(REDACTED_THINKING_SIGNATURE_PREFIX) === true) {
        const thinkingSignature = block.thinkingSignature.slice(
          REDACTED_THINKING_SIGNATURE_PREFIX.length,
        );
        if (thinkingSignature.length === 0) {
          throw new Error(
            "native OMP context contains redacted thinking without an opaque payload",
          );
        }
        return {
          type: "thinking",
          thinking: "",
          thinkingSignature,
          redacted: true,
        };
      }
      const thinkingSignature = block.thinkingSignature?.startsWith(
        VISIBLE_THINKING_SIGNATURE_PREFIX,
      )
        ? block.thinkingSignature.slice(VISIBLE_THINKING_SIGNATURE_PREFIX.length)
        : block.thinkingSignature;
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
      };
    }
    if (block.type === "redactedThinking") {
      return {
        type: "thinking",
        thinking: "",
        thinkingSignature: block.data,
        redacted: true,
      };
    }
    if (block.type === "toolCall") {
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
        ...(block.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: block.thoughtSignature }),
      };
    }
    throw new Error("native OMP context contains an unsupported assistant content block");
  });
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    usage: message.usage,
    stopReason: message.stopReason,
    timestamp: message.timestamp,
  };
}

function projectTextContent(
  content: Extract<Message, { role: "user" | "developer" | "toolResult" }>["content"],
): string | readonly Record<string, unknown>[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) => {
    if (block.type !== "text") {
      throw new Error("native OMP broker context supports text content only");
    }
    return {
      type: "text",
      text: block.text,
      ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
    };
  });
}

function emitAssistantContent(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  message: AssistantMessage,
): void {
  partial.usage = message.usage;
  partial.stopReason = message.stopReason;
  for (const block of message.content) {
    const contentIndex = partial.content.length;
    partial.content.push(block);
    if (block.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
      continue;
    }
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial });
      continue;
    }
    if (block.type === "redactedThinking") {
      continue;
    }
    if (block.type !== "thinking") {
      throw new Error("native OMP broker returned an unsupported assistant content block");
    }
    stream.push({ type: "thinking_start", contentIndex, partial });
    stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
    stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
  }
}

function parseBrokerMessage(response: string, model: Model<string>): AssistantMessage {
  if (Buffer.byteLength(response, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`OMP inference response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(response, {
      maxDepth: 64,
      maxNodes: 200_000,
      valueLabel: "native OMP broker response",
    });
  } catch (error) {
    throw new Error("native OMP broker response is not strict JSON", { cause: error });
  }
  const parsed = assistantMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("native OMP broker response is not a valid assistant message", {
      cause: parsed.error,
    });
  }
  const content: AssistantMessage["content"] = parsed.data.content.map(
    (block): AssistantMessage["content"][number] => {
      if (block.type === "text") {
        return {
          type: "text",
          text: block.text,
          ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
        };
      }
      if (block.type === "toolCall") {
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          ...(block.thoughtSignature === undefined
            ? {}
            : { thoughtSignature: block.thoughtSignature }),
        };
      }
      if (block.redacted === true) {
        if (block.thinkingSignature === undefined || block.thinkingSignature.length === 0) {
          throw new Error("native OMP broker returned redacted thinking without an opaque payload");
        }
        return {
          type: "thinking",
          thinking: "",
          thinkingSignature: `${REDACTED_THINKING_SIGNATURE_PREFIX}${block.thinkingSignature}`,
        };
      }
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature === undefined
          ? {}
          : {
              thinkingSignature: `${VISIBLE_THINKING_SIGNATURE_PREFIX}${block.thinkingSignature}`,
            }),
      };
    },
  );
  const usage: AssistantMessage["usage"] = {
    input: parsed.data.usage.input,
    output: parsed.data.usage.output,
    cacheRead: parsed.data.usage.cacheRead,
    cacheWrite: parsed.data.usage.cacheWrite,
    ...(parsed.data.usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: parsed.data.usage.reasoningTokens }),
    totalTokens: parsed.data.usage.totalTokens,
    cost: {
      input: parsed.data.usage.cost.input,
      output: parsed.data.usage.cost.output,
      cacheRead: parsed.data.usage.cost.cacheRead,
      cacheWrite: parsed.data.usage.cost.cacheWrite,
      total: parsed.data.usage.cost.total,
    },
  };
  return Object.freeze({
    role: parsed.data.role,
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    ...(parsed.data.responseId === undefined ? {} : { responseId: parsed.data.responseId }),
    usage,
    stopReason: parsed.data.stopReason,
    ...(parsed.data.errorMessage === undefined ? {} : { errorMessage: parsed.data.errorMessage }),
    timestamp: parsed.data.timestamp,
  });
}

function brokerModelDefinition(evaluation: ExternalHarnessEvaluationInput) {
  const definition = {
    id: BROKER_MODEL,
    name: "Flow host model",
    api: BROKER_API,
    baseUrl: "flow://host-inference",
    reasoning: true,
    input: ["text"],
    supportsTools: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.max(128_000, evaluation.controls.budget.maxModelTokens * 4),
    maxTokens: evaluation.controls.budget.maxModelTokens,
  } satisfies NonNullable<ProviderConfigInput["models"]>[number];
  return Object.freeze(definition);
}

function ompThinkingLevel(
  thinking: ExternalHarnessEvaluationInput["controls"]["model"]["thinking"],
): ConfiguredThinkingLevel {
  const parsed = parseConfiguredThinkingLevel(thinking);
  if (parsed === undefined || parsed === "auto") {
    throw new Error(`native OMP does not support the ${thinking} thinking level`);
  }
  return parsed;
}

function emptyAssistantMessage(
  model: Model<string>,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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

function lockedSystemPrompt(): string[] {
  return [
    "You are the native OMP profile in one Flow evaluation trial.",
    "Use only the read and edit tools to complete the supplied task.",
    "Do not inspect Flow state or provider configuration.",
    "Flow verifies the workspace after this session.",
  ];
}

function taskPrompt(instructionText: string): string {
  return [
    "Complete the following evaluation task in the current workspace.",
    "Use only the supplied tools.",
    "<task>",
    instructionText,
    "</task>",
  ].join("\n");
}

function metricsFromStats(
  stats: ReturnType<Awaited<ReturnType<typeof createAgentSession>>["session"]["getSessionStats"]>,
  toolErrors: number,
  wallTimeMs: number,
): EvaluationMetrics {
  return Object.freeze({
    costUsdMicros: Math.ceil(stats.cost * 1_000_000 - Number.EPSILON),
    inputTokens: stats.tokens.input,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    outputTokens: stats.tokens.output,
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

class EmptyAuthCredentialStore implements AuthCredentialStore {
  close(): void {}

  listAuthCredentials(): StoredAuthCredential[] {
    return [];
  }

  updateAuthCredential(_id: number, _credential: AuthCredential): void {
    throw new Error("native OMP credential storage is read-only");
  }

  deleteAuthCredential(_id: number, _disabledCause: string): void {
    throw new Error("native OMP credential storage is read-only");
  }

  tryDisableAuthCredentialIfMatches(): boolean {
    return false;
  }

  replaceAuthCredentialsForProvider(): StoredAuthCredential[] {
    throw new Error("native OMP credential storage is read-only");
  }

  upsertAuthCredentialForProvider(): StoredAuthCredential[] {
    throw new Error("native OMP credential storage is read-only");
  }

  deleteAuthCredentialsForProvider(): void {
    throw new Error("native OMP credential storage is read-only");
  }

  getCache(): string | null {
    return null;
  }

  setCache(): void {}

  cleanExpiredCache(): void {}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error(abortReason(signal));
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason.message
    : String(reason ?? "native OMP session cancelled");
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable native OMP error";
  }
}

function elapsedMs(started: bigint): number {
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  return Math.ceil(Math.max(0, elapsed));
}

class ParentProtocolChannel {
  #driverSequence = 0;
  #parentSequence = 1;

  constructor(
    readonly hello: Extract<ExternalHarnessParentFrame, { type: "hello" }>,
    readonly lines: AsyncIterator<string>,
  ) {}

  async sendReady(): Promise<void> {
    await this.#send("ready", {
      trialId: this.hello.payload.trialId,
      identityDigest: this.hello.payload.identityDigest,
    });
  }

  async infer(body: string): Promise<string> {
    const requestId = randomUUID();
    await this.#send("inference_request", {
      requestId,
      body,
      bodySha256: sha256(body),
    });
    const next = await this.lines.next();
    if (next.done === true) {
      throw new Error("parent control channel closed during inference");
    }
    const frame = parseExternalHarnessParentLine(next.value, this.hello.payload.secretHex);
    this.#parentSequence += 1;
    if (
      frame.sessionId !== this.hello.sessionId ||
      frame.sequence !== this.#parentSequence ||
      frame.type !== "inference_response" ||
      frame.payload.requestId !== requestId
    ) {
      throw new Error("parent inference response contradicts the active request");
    }
    return frame.payload.body;
  }

  async sendTerminal(result: NativeOmpEvaluationSessionResult): Promise<void> {
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
    await writeStdoutLine(JSON.stringify(frame));
  }
}

async function runDriverProcess(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) {
    throw new Error("parent control channel closed before hello");
  }
  const hello = parseExternalHarnessParentLine(first.value);
  if (hello.type !== "hello" || hello.sequence !== 1) {
    throw new Error("first parent frame must be hello sequence 1");
  }
  const channel = new ParentProtocolChannel(hello, lines);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("external harness process was terminated"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    await channel.sendReady();
    const result = await runNativeOmpEvaluationSession({
      evaluation: hello.payload.evaluation,
      instructionText: hello.payload.instructionText,
      infer: (body) => channel.infer(body),
      signal: controller.signal,
    });
    await channel.sendTerminal(result);
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    input.close();
    process.stdin.unref();
  }
}

async function writeStdoutLine(line: string): Promise<void> {
  if (Buffer.byteLength(line, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`driver frame exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  await new Promise<void>((resolvePromise, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error === null || error === undefined) {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMainModule()) {
  void runDriverProcess().catch((error: unknown) => {
    process.stderr.write(`${boundedReason(error)}\n`);
    process.exitCode = 1;
  });
}
