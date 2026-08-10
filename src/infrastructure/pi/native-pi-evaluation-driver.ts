import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  createEditToolDefinition,
  createExtensionRuntime,
  createReadToolDefinition,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  InMemoryCredentialStore,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import {
  type ExternalHarnessEvaluationInput,
  type ExternalHarnessParentFrame,
  MAX_EXTERNAL_HARNESS_FRAME_BYTES,
  parseExternalHarnessParentLine,
  signExternalHarnessDriverFrame,
} from "../../domain/evaluation/external-harness-protocol.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type {
  EvaluationHarnessOutcome,
  EvaluationMetrics,
} from "../../domain/evaluation/records.js";

const BROKER_PROVIDER = "flow-host-broker";
const BROKER_MODEL = "flow-host-model";
const BROKER_API = "flow-host-inference-v1";

const usageSchema = z
  .object({
    input: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheRead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite1h: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    reasoning: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
    diagnostics: z.array(z.unknown()).max(64).optional(),
    usage: usageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().max(16_384).optional(),
    rawStopReason: z.string().max(256).optional(),
    timestamp: z.number().finite(),
  })
  .strict();

export interface NativePiEvaluationSessionInput {
  readonly evaluation: ExternalHarnessEvaluationInput;
  readonly instructionText: string;
  readonly infer: (body: string, signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
}

export interface NativePiEvaluationSessionResult {
  readonly harness: EvaluationHarnessOutcome;
  readonly metrics: EvaluationMetrics;
}

export async function runNativePiEvaluationSession(
  input: NativePiEvaluationSessionInput,
): Promise<NativePiEvaluationSessionResult> {
  throwIfAborted(input.signal);
  const started = process.hrtime.bigint();
  const workspace = await realpath(input.evaluation.workspace.cwd);
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const model = brokerModel(input.evaluation);
  modelRuntime.registerNativeProvider(brokerProvider(model, input.infer, input.signal));
  const selected = modelRuntime.getModel(BROKER_PROVIDER, BROKER_MODEL);
  if (selected === undefined) {
    throw new Error("native Pi broker model is unavailable after registration");
  }
  const { session } = await createAgentSession({
    cwd: workspace,
    modelRuntime,
    model: selected,
    thinkingLevel: input.evaluation.controls.model.thinking,
    noTools: "all",
    tools: ["read", "edit"],
    customTools: workspaceToolDefinitions(workspace),
    resourceLoader: lockedResourceLoader(),
    sessionManager: SessionManager.inMemory(workspace),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    }),
  });
  if (session.thinkingLevel !== input.evaluation.controls.model.thinking) {
    session.dispose();
    throw new Error(
      `Pi applied thinking level "${session.thinkingLevel}" instead of "${input.evaluation.controls.model.thinking}"`,
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
    const wallTimeMs = elapsedMs(started);
    const metrics = metricsFromStats(stats, toolErrors, wallTimeMs);
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
          reason: "Pi session ended without a terminal assistant message",
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
          ? (finalMessage.errorMessage ?? `Pi stopped with ${finalMessage.stopReason}`)
          : null,
      }),
      metrics,
    });
  } finally {
    input.signal?.removeEventListener("abort", abortSession);
    await abortPromise;
    unsubscribe();
    session.dispose();
  }
}

function workspaceToolDefinitions(workspace: string) {
  const resolveFile = async (path: string): Promise<string> => {
    const canonical = await realpath(path);
    if (!isAtOrWithin(canonical, workspace)) {
      throw new Error("native Pi tool path is outside the trial workspace");
    }
    return canonical;
  };
  const readFile = async (path: string): Promise<Buffer> => {
    const canonical = await resolveFile(path);
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  };
  return [
    defineTool(
      createReadToolDefinition(workspace, {
        autoResizeImages: false,
        operations: {
          access: async (path) => access(await resolveFile(path), constants.R_OK),
          readFile,
        },
      }),
    ),
    defineTool(
      createEditToolDefinition(workspace, {
        operations: {
          access: async (path) => access(await resolveFile(path), constants.R_OK | constants.W_OK),
          readFile,
          writeFile: async (path, content) => {
            const canonical = await resolveFile(path);
            const handle = await open(canonical, constants.O_WRONLY | constants.O_NOFOLLOW);
            try {
              await handle.truncate(0);
              await handle.writeFile(content, "utf8");
              await handle.sync();
            } finally {
              await handle.close();
            }
          },
        },
      }),
    ),
  ];
}

function isAtOrWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function brokerProvider(
  model: Model<string>,
  infer: NativePiEvaluationSessionInput["infer"],
  signal?: AbortSignal,
) {
  const stream = (
    _model: Model<string>,
    context: Context,
    options?: StreamOptions | SimpleStreamOptions,
  ) => brokerStream(model, context, options, infer, signal);
  const api: ProviderStreams = { stream, streamSimple: stream };
  return createProvider({
    id: BROKER_PROVIDER,
    name: "Flow host inference broker",
    auth: {
      apiKey: {
        name: "Flow internal broker marker",
        check: async () => ({ type: "api_key", source: "Flow host broker" }),
        resolve: async () => ({ auth: { apiKey: "flow-internal-broker" } }),
      },
    },
    models: [model],
    api,
  });
}

function brokerStream(
  model: Model<string>,
  context: Context,
  _options: StreamOptions | SimpleStreamOptions | undefined,
  infer: NativePiEvaluationSessionInput["infer"],
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = emptyAssistantMessage(model, "pending");
  stream.push({ type: "start", partial });
  void (async () => {
    try {
      throwIfAborted(signal);
      const body = JSON.stringify({ version: 1, context });
      if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
        throw new Error(`Pi inference context exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
      }
      const response = await infer(body, signal);
      const message = parseBrokerMessage(response, model);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        if (message.stopReason === "pending") {
          throw new Error("native Pi broker returned a non-terminal assistant message");
        }
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

function parseBrokerMessage(response: string, model: Model<string>): AssistantMessage {
  if (Buffer.byteLength(response, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`Pi inference response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = parseStrictJson(response, {
      maxDepth: 64,
      maxNodes: 200_000,
      valueLabel: "native Pi broker response",
    });
  } catch (error) {
    throw new Error("native Pi broker response is not strict JSON", { cause: error });
  }
  const parsed = assistantMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("native Pi broker response is not a valid assistant message", {
      cause: parsed.error,
    });
  }
  return Object.freeze({
    ...parsed.data,
    api: model.api,
    provider: model.provider,
    model: model.id,
  }) as AssistantMessage;
}

function brokerModel(evaluation: ExternalHarnessEvaluationInput): Model<string> {
  const model: Model<string> = {
    id: BROKER_MODEL,
    name: "Flow host model",
    api: BROKER_API,
    provider: BROKER_PROVIDER,
    baseUrl: "flow://host-inference",
    reasoning: true,
    thinkingLevelMap: {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Math.max(128_000, evaluation.controls.budget.maxModelTokens * 4),
    maxTokens: evaluation.controls.budget.maxModelTokens,
  };
  return Object.freeze(model);
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

function lockedResourceLoader(): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      [
        "You are the native Pi profile in one Flow evaluation trial.",
        "Use only the read and edit tools to complete the supplied task.",
        "Do not inspect Flow state or provider configuration.",
        "Flow verifies the workspace after this session.",
      ].join("\n"),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
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
  const costUsdMicros = Math.ceil(stats.cost * 1_000_000 - Number.EPSILON);
  return Object.freeze({
    costUsdMicros,
    inputTokens: stats.tokens.input,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    outputTokens: stats.tokens.output,
    turns: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolErrors,
    wallTimeMs,
    activeTimeMs: wallTimeMs,
    interventions: 0,
    policyViolations: null,
    recoveryAttempts: 0,
    recoveryOutcome: "not_attempted",
  });
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

  async sendTerminal(result: NativePiEvaluationSessionResult): Promise<void> {
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
    const result = await runNativePiEvaluationSession({
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error(abortReason(signal));
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "native Pi session cancelled");
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable native Pi error";
  }
}

function elapsedMs(started: bigint): number {
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
  return Math.ceil(Math.max(0, elapsed));
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
