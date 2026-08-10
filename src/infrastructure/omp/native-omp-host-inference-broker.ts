import { z } from "zod";

import { MAX_EXTERNAL_HARNESS_FRAME_BYTES } from "../../domain/evaluation/external-harness-protocol.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import { NativePiHostInferenceBroker } from "../pi/native-pi-host-inference-broker.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "../process/local-external-harness-runtime.js";

const BROKER_PROVIDER = "flow-host-broker";
const BROKER_MODEL = "flow-host-model";
const BROKER_API = "flow-host-inference-v1";

const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
    textSignature: z.string().max(16_384).optional(),
  })
  .strict();
const thinkingContentSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string().max(MAX_EXTERNAL_HARNESS_FRAME_BYTES),
    thinkingSignature: z
      .string()
      .max(64 * 1_024)
      .optional(),
    redacted: z.boolean().optional(),
  })
  .strict();
const toolCallSchema = z
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
  .strict();
const costSchema = z
  .object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  })
  .strict();
const ompUsageSchema = z
  .object({
    input: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheRead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reasoningTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cost: costSchema,
  })
  .strict();
const hostUsageSchema = z
  .object({
    input: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheRead: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cacheWrite1h: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    reasoning: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cost: costSchema,
  })
  .strict();
const userMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(textContentSchema).max(256)]),
    timestamp: z.number().finite(),
  })
  .strict();
const developerMessageSchema = z
  .object({
    role: z.literal("developer"),
    content: z.union([z.string(), z.array(textContentSchema).max(256)]),
    timestamp: z.number().finite(),
  })
  .strict();
const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z
      .array(
        z.discriminatedUnion("type", [textContentSchema, thinkingContentSchema, toolCallSchema]),
      )
      .max(128),
    api: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    responseId: z.string().max(512).optional(),
    usage: ompUsageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    timestamp: z.number().finite(),
  })
  .strict();
const toolResultMessageSchema = z
  .object({
    role: z.literal("toolResult"),
    toolCallId: z.string().min(1).max(256),
    toolName: z.enum(["read", "edit"]),
    content: z.array(textContentSchema).max(256),
    isError: z.boolean(),
    timestamp: z.number().finite(),
  })
  .strict();
const inferenceBodySchema = z
  .object({
    version: z.literal(1),
    context: z
      .object({
        systemPrompt: z
          .array(z.string().max(256 * 1_024))
          .max(32)
          .optional(),
        messages: z
          .array(
            z.discriminatedUnion("role", [
              userMessageSchema,
              developerMessageSchema,
              assistantMessageSchema,
              toolResultMessageSchema,
            ]),
          )
          .max(512),
        tools: z
          .array(
            z
              .object({
                name: z.enum(["read", "edit"]),
                description: z
                  .string()
                  .min(1)
                  .max(64 * 1_024),
                parameters: z.record(z.string(), z.unknown()),
                strict: z.boolean().optional(),
              })
              .strict(),
          )
          .max(2)
          .optional(),
      })
      .strict(),
  })
  .strict();
const hostAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z
      .array(
        z.discriminatedUnion("type", [textContentSchema, thinkingContentSchema, toolCallSchema]),
      )
      .max(128),
    api: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    responseModel: z.string().max(256).optional(),
    responseId: z.string().max(512).optional(),
    usage: hostUsageSchema,
    stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
    errorMessage: z.string().max(16_384).optional(),
    rawStopReason: z.string().max(256).optional(),
    timestamp: z.number().finite(),
  })
  .strict();

export interface NativeOmpHostInferenceBrokerOptions {
  readonly delegate?: ExternalHarnessInferenceBroker;
}

export class NativeOmpHostInferenceBroker implements ExternalHarnessInferenceBroker {
  readonly #delegate: ExternalHarnessInferenceBroker;

  constructor(options: NativeOmpHostInferenceBrokerOptions = {}) {
    this.#delegate = options.delegate ?? new NativePiHostInferenceBroker();
  }

  async infer(request: ExternalHarnessInferenceRequest, signal?: AbortSignal): Promise<string> {
    if (request.identity.adapter !== "omp-native-v1") {
      throw new Error("native OMP broker received a request for a different adapter");
    }
    const parsed = parseInferenceBody(request.body);
    if (parsed.context.messages.some((message) => message.role === "developer")) {
      throw new Error("native OMP broker does not admit developer messages");
    }
    const forwardedBody = JSON.stringify({
      version: 1,
      context: {
        ...(parsed.context.systemPrompt === undefined
          ? {}
          : { systemPrompt: parsed.context.systemPrompt.join("\n") }),
        messages: parsed.context.messages.map((message) => {
          if (message.role !== "assistant") {
            return message;
          }
          const { reasoningTokens, ...usage } = message.usage;
          return {
            ...message,
            usage: {
              ...usage,
              ...(reasoningTokens === undefined ? {} : { reasoning: reasoningTokens }),
            },
          };
        }),
        ...(parsed.context.tools === undefined ? {} : { tools: parsed.context.tools }),
      },
    });
    if (Buffer.byteLength(forwardedBody, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new Error(`OMP host request exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
    }
    const rawResponse = await this.#delegate.infer(
      Object.freeze({ ...request, body: forwardedBody }),
      signal,
    );
    const hostMessage = parseHostMessage(rawResponse);
    const { reasoning, cacheWrite1h: _cacheWrite1h, ...usage } = hostMessage.usage;
    const response = JSON.stringify({
      ...hostMessage,
      api: BROKER_API,
      provider: BROKER_PROVIDER,
      model: BROKER_MODEL,
      usage: {
        ...usage,
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      },
    });
    if (Buffer.byteLength(response, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new Error(`OMP host response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
    }
    return response;
  }

  async close(evaluation: ExternalHarnessInferenceRequest["evaluation"]): Promise<void> {
    await this.#delegate.close?.(evaluation);
  }
}

function parseInferenceBody(body: string): z.infer<typeof inferenceBodySchema> {
  if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`OMP inference request exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  const raw = parseJson(body, "OMP inference request");
  const parsed = inferenceBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("OMP inference request violates the closed broker schema", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseHostMessage(body: string): z.infer<typeof hostAssistantMessageSchema> {
  if (Buffer.byteLength(body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
    throw new Error(`OMP host response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
  }
  const raw = parseJson(body, "OMP host response");
  const parsed = hostAssistantMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("OMP host response violates the closed assistant schema", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseJson(body: string, label: string): unknown {
  try {
    return parseStrictJson(body, {
      maxDepth: 64,
      maxNodes: 200_000,
      valueLabel: label,
    });
  } catch (error) {
    throw new Error(`${label} is not strict JSON`, { cause: error });
  }
}
