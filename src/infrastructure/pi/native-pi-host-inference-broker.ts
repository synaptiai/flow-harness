import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type Context,
  getSupportedThinkingLevels,
  type Model,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import { MAX_EXTERNAL_HARNESS_FRAME_BYTES } from "../../domain/evaluation/external-harness-protocol.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "../process/local-external-harness-runtime.js";

const inferenceBodySchema = z
  .object({
    version: z.literal(1),
    context: z
      .object({
        systemPrompt: z
          .string()
          .max(256 * 1_024)
          .optional(),
        messages: z.array(z.record(z.string(), z.unknown())).max(512),
        tools: z.array(z.record(z.string(), z.unknown())).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export interface NativePiHostModelRuntime {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage>;
}

export interface NativePiHostInferenceBrokerOptions {
  readonly createModelRuntime?: (signal?: AbortSignal) => Promise<NativePiHostModelRuntime>;
}

export class NativePiHostInferenceBroker implements ExternalHarnessInferenceBroker {
  readonly #createModelRuntime: (signal?: AbortSignal) => Promise<NativePiHostModelRuntime>;
  readonly #sessions = new Map<
    string,
    {
      readonly runtime: Promise<NativePiHostModelRuntime>;
      tokens: number;
      costUsdMicros: number;
    }
  >();

  constructor(options: NativePiHostInferenceBrokerOptions = {}) {
    this.#createModelRuntime =
      options.createModelRuntime ??
      ((signal) =>
        ModelRuntime.create({
          allowModelNetwork: false,
          ...(signal === undefined ? {} : { signal }),
        }));
  }

  async infer(request: ExternalHarnessInferenceRequest, signal?: AbortSignal): Promise<string> {
    if (Buffer.byteLength(request.body, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new Error(`inference request exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
    }
    let raw: unknown;
    try {
      raw = parseStrictJson(request.body, {
        maxDepth: 64,
        maxNodes: 200_000,
        valueLabel: "external harness inference request",
      });
    } catch (error) {
      throw new Error("external harness inference request is not strict JSON", { cause: error });
    }
    const parsed = inferenceBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("external harness inference request violates the closed broker schema", {
        cause: parsed.error,
      });
    }
    if (signal?.aborted === true) {
      throw new Error("external harness inference was cancelled");
    }
    const key = trialKey(request.evaluation.planDigest, request.evaluation.trial.trialId);
    let session = this.#sessions.get(key);
    if (session === undefined) {
      session = {
        runtime: this.#createModelRuntime(signal),
        tokens: 0,
        costUsdMicros: 0,
      };
      this.#sessions.set(key, session);
    }
    const runtime = await session.runtime;
    const controls = request.evaluation.controls;
    const model = runtime.getModel(controls.model.provider, controls.model.id);
    if (model === undefined) {
      throw new Error(
        `evaluation model "${controls.model.provider}/${controls.model.id}" is not available`,
      );
    }
    if (!getSupportedThinkingLevels(model).includes(controls.model.thinking)) {
      throw new Error(
        `evaluation thinking level "${controls.model.thinking}" is not supported by the selected model`,
      );
    }
    const remainingTokens = controls.budget.maxModelTokens - session.tokens;
    if (remainingTokens <= 0) {
      throw new Error("evaluation model-token budget is exhausted");
    }
    const options: ModelsSimpleStreamOptions = {
      maxTokens: Math.min(model.maxTokens, remainingTokens),
      maxRetries: 0,
      ...(controls.model.thinking === "off" ? {} : { reasoning: controls.model.thinking }),
      ...(signal === undefined ? {} : { signal }),
    };
    const message = await runtime.completeSimple(
      model,
      parsed.data.context as unknown as Context,
      options,
    );
    session.tokens += message.usage.totalTokens;
    const costUsdMicros = Math.ceil(message.usage.cost.total * 1_000_000);
    session.costUsdMicros += costUsdMicros;
    if (session.tokens > controls.budget.maxModelTokens) {
      throw new Error("provider result exceeds the evaluation model-token budget");
    }
    if (session.costUsdMicros > controls.budget.maxCostUsdMicros) {
      throw new Error("provider result exceeds the evaluation model-cost budget");
    }
    const response = JSON.stringify(message);
    if (Buffer.byteLength(response, "utf8") > MAX_EXTERNAL_HARNESS_FRAME_BYTES) {
      throw new Error(`inference response exceeds ${MAX_EXTERNAL_HARNESS_FRAME_BYTES} bytes`);
    }
    return response;
  }

  async close(evaluation: ExternalHarnessInferenceRequest["evaluation"]): Promise<void> {
    this.#sessions.delete(trialKey(evaluation.planDigest, evaluation.trial.trialId));
  }
}

function trialKey(planDigest: string, trialId: string): string {
  return `${planDigest}:${trialId}`;
}
