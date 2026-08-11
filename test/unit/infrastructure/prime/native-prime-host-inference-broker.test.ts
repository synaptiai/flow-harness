import { describe, expect, it, vi } from "vitest";

import { NativePrimeHostInferenceBroker } from "../../../../src/infrastructure/prime/native-prime-host-inference-broker.js";
import { PrimeEvaluationMetricsLedger } from "../../../../src/infrastructure/prime/prime-evaluation-metrics.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "../../../../src/infrastructure/process/local-external-harness-runtime.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("native Prime host inference broker", () => {
  it("projects one IPython-only context through the host provider boundary", async () => {
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () => JSON.stringify(hostAssistantMessage())),
    };
    const broker = new NativePrimeHostInferenceBroker({ delegate });

    const response = JSON.parse(await broker.infer(inferenceRequest())) as {
      readonly api: string;
      readonly provider: string;
      readonly model: string;
      readonly responseId?: string;
      readonly usage: { readonly totalTokens: number };
    };

    expect(delegate.infer).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(delegate.infer).mock.calls[0]?.[0].body ?? "null")).toEqual({
      version: 1,
      context: {
        systemPrompt: "Use IPython to complete the task.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Create RESULT.md." }],
            timestamp: 1,
          },
        ],
        tools: [
          {
            name: "ipython",
            description: "Run code in the persistent Python kernel.",
            parameters: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      },
    });
    expect(response).toMatchObject({
      api: "flow-host-inference-v1",
      provider: "flow-host-broker",
      model: "flow-host-model",
      responseId: "response-prime-1",
      usage: { totalTokens: 17 },
    });
  });

  it("preserves bounded assistant continuity on the next model turn", async () => {
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () => JSON.stringify(hostAssistantMessage())),
    };
    const broker = new NativePrimeHostInferenceBroker({ delegate });
    const request = inferenceRequest();
    const body = JSON.parse(request.body) as {
      context: { messages: Record<string, unknown>[] };
    };
    body.context.messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the task.", textSignature: "signed-text" },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-reasoning",
          redacted: true,
        },
      ],
      api: "flow-host-inference-v1",
      provider: "flow-host-broker",
      model: "flow-host-model",
      responseId: "response-prime-1",
      usage: hostAssistantMessage().usage,
      stopReason: "stop",
      timestamp: 2,
    });

    await broker.infer({ ...request, body: JSON.stringify(body) });

    const forwarded = JSON.parse(vi.mocked(delegate.infer).mock.calls[0]?.[0].body ?? "null") as {
      context: { messages: readonly Record<string, unknown>[] };
    };
    expect(forwarded.context.messages.at(-1)).toMatchObject({
      role: "assistant",
      responseId: "response-prime-1",
      content: [
        { type: "text", textSignature: "signed-text" },
        { type: "thinking", thinkingSignature: "opaque-reasoning", redacted: true },
      ],
    });
  });

  it("projects optional host metadata before the Prime metrics ledger", async () => {
    const message = hostAssistantMessage();
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () =>
        JSON.stringify({
          ...message,
          responseModel: "resolved-host-model",
          rawStopReason: "tool_use",
          usage: {
            ...message.usage,
            cacheWrite1h: 3,
            reasoning: 5,
          },
        }),
      ),
    };
    const broker = new NativePrimeHostInferenceBroker({ delegate });
    const response = await broker.infer(inferenceRequest());
    const parsed = JSON.parse(response) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty("responseModel");
    expect(parsed).not.toHaveProperty("rawStopReason");
    expect(parsed.usage).not.toHaveProperty("cacheWrite1h");
    expect(parsed.usage).not.toHaveProperty("reasoning");
    expect(() => new PrimeEvaluationMetricsLedger().recordBrokerResponse(response)).not.toThrow();
  });

  it("rejects other adapters, developer messages, and non-IPython tools", async () => {
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () => JSON.stringify(hostAssistantMessage())),
    };
    const broker = new NativePrimeHostInferenceBroker({ delegate });
    const request = inferenceRequest();
    await expect(
      broker.infer({
        ...request,
        identity: { ...request.identity, adapter: "pi-native-v1" } as typeof request.identity,
      }),
    ).rejects.toThrow(/Prime.*adapter/i);

    const developer = JSON.parse(request.body) as {
      context: { messages: Record<string, unknown>[] };
    };
    developer.context.messages.push({ role: "developer", content: "hidden", timestamp: 2 });
    await expect(broker.infer({ ...request, body: JSON.stringify(developer) })).rejects.toThrow(
      /closed broker schema/i,
    );

    const otherTool = JSON.parse(request.body) as {
      context: { tools: Record<string, unknown>[] };
    };
    if (otherTool.context.tools[0] !== undefined) {
      otherTool.context.tools[0].name = "exec";
    }
    await expect(broker.infer({ ...request, body: JSON.stringify(otherTool) })).rejects.toThrow(
      /closed broker schema/i,
    );
    expect(delegate.infer).not.toHaveBeenCalled();
  });
});

function inferenceRequest(): ExternalHarnessInferenceRequest {
  return {
    identity: primeExternalHarnessIdentity(),
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId: `trial-${"b".repeat(48)}`,
        position: 1,
        taskId: "task",
        profileId: "prime",
        seed: 7,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-trial-${"b".repeat(48)}`,
        cwd: "/workspace",
        backend: "reflink-copy-v1",
        snapshotDigest: "c".repeat(64),
      },
      instruction: { path: "TASK.md", sha256: "d".repeat(64) },
      controls: {
        model: { provider: "provider", id: "model", thinking: "medium" },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 4_096,
          maxCostUsdMicros: 100_000,
          maxExecutionMs: 30_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
    },
    requestId: "00000000-0000-4000-8000-000000000001",
    body: JSON.stringify({
      version: 1,
      context: {
        systemPrompt: "Use IPython to complete the task.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Create RESULT.md." }],
            timestamp: 1,
          },
        ],
        tools: [
          {
            name: "ipython",
            description: "Run code in the persistent Python kernel.",
            parameters: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      },
    }),
  };
}

function hostAssistantMessage() {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-ipython",
        name: "ipython",
        arguments: { code: "print('ready')" },
      },
    ],
    api: "host-api",
    provider: "host-provider",
    model: "host-model",
    responseId: "response-prime-1",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      totalTokens: 17,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}
