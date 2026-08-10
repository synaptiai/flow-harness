import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessIdentity } from "../../../../src/domain/evaluation/external-harness.js";
import { NativeOmpHostInferenceBroker } from "../../../../src/infrastructure/omp/native-omp-host-inference-broker.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "../../../../src/infrastructure/process/local-external-harness-runtime.js";

describe("native OMP host inference broker", () => {
  it("projects an OMP context through the existing host provider boundary", async () => {
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () => JSON.stringify(hostAssistantMessage())),
    };
    const broker = new NativeOmpHostInferenceBroker({ delegate });

    const response = JSON.parse(await broker.infer(inferenceRequest())) as {
      readonly api: string;
      readonly provider: string;
      readonly model: string;
      readonly responseModel?: string;
      readonly responseId?: string;
      readonly rawStopReason?: string;
      readonly usage: { readonly reasoningTokens?: number };
    };

    expect(delegate.infer).toHaveBeenCalledOnce();
    const forwarded = vi.mocked(delegate.infer).mock.calls[0]?.[0];
    expect(JSON.parse(forwarded?.body ?? "null")).toEqual({
      version: 1,
      context: {
        systemPrompt: "First rule.\nSecond rule.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Edit RESULT.md." }],
            timestamp: 1,
          },
        ],
        tools: [
          {
            name: "edit",
            description: "Edit one file.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
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
      responseModel: "provider-model-2026-08-10",
      responseId: "response-123",
      rawStopReason: "tool_use",
      usage: { reasoningTokens: 3 },
    });
  });

  it("rejects a request for a different adapter", async () => {
    const broker = new NativeOmpHostInferenceBroker({
      delegate: { infer: vi.fn() },
    });
    const request = inferenceRequest();
    const wrong = {
      ...request,
      identity: { ...request.identity, adapter: "pi-native-v1" },
    } as ExternalHarnessInferenceRequest;

    await expect(broker.infer(wrong)).rejects.toThrow(/OMP.*adapter/i);
  });

  it("forwards bounded assistant continuity fields on a later turn", async () => {
    const delegate: ExternalHarnessInferenceBroker = {
      infer: vi.fn(async () => JSON.stringify(hostAssistantMessage())),
    };
    const broker = new NativeOmpHostInferenceBroker({ delegate });
    const request = inferenceRequest();
    const body = JSON.parse(request.body) as {
      context: { messages: Record<string, unknown>[] };
    };
    body.context.messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "I will edit.", textSignature: "signed-text" },
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
      responseId: "response-123",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    });

    await broker.infer({ ...request, body: JSON.stringify(body) });

    const forwarded = JSON.parse(vi.mocked(delegate.infer).mock.calls[0]?.[0].body ?? "null") as {
      context: { messages: readonly Record<string, unknown>[] };
    };
    expect(forwarded.context.messages.at(-1)).toMatchObject({
      role: "assistant",
      responseId: "response-123",
      content: [
        { type: "text", textSignature: "signed-text" },
        { type: "thinking", thinkingSignature: "opaque-reasoning", redacted: true },
      ],
    });
  });
});

function inferenceRequest(): ExternalHarnessInferenceRequest {
  return {
    identity: ompIdentity(),
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId: `trial-${"b".repeat(48)}`,
        position: 1,
        taskId: "task",
        profileId: "omp",
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
        systemPrompt: ["First rule.", "Second rule."],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Edit RESULT.md." }],
            timestamp: 1,
          },
        ],
        tools: [
          {
            name: "edit",
            description: "Edit one file.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
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
        id: "call-edit",
        name: "edit",
        arguments: { i: "edit result", path: "RESULT.md" },
      },
    ],
    api: "host-api",
    provider: "host-provider",
    model: "host-model",
    responseModel: "provider-model-2026-08-10",
    responseId: "response-123",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 1,
      cacheWrite: 2,
      reasoning: 3,
      totalTokens: 17,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "toolUse",
    rawStopReason: "tool_use",
    timestamp: 1,
  };
}

function ompIdentity(): Extract<ExternalHarnessIdentity, { readonly adapter: "omp-native-v1" }> {
  return {
    version: 1,
    adapter: "omp-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-omp-evaluation-v1",
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      bun: { version: "1.3.14", executableSha256: "6".repeat(64) },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent",
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "7".repeat(64),
      dependencyClosureSha256: "8".repeat(64),
      config: "omp-evaluation-v1",
      configDigest: "9".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1",
      version: 1,
      package: "@oh-my-pi/pi-ai",
      packageVersion: "17.2.12",
      packageContentSha256: "0".repeat(64),
    },
  };
}
