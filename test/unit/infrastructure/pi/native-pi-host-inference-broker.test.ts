import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessInferenceRequest } from "../../../../src/infrastructure/process/local-external-harness-runtime.js";
import {
  NativePiHostInferenceBroker,
  type NativePiHostModelRuntime,
} from "../../../../src/infrastructure/pi/native-pi-host-inference-broker.js";

describe("native Pi host inference broker", () => {
  it("uses the admitted model route and zero-retry controls", async () => {
    const model = testModel();
    const message = assistantMessage();
    const completeSimple = vi.fn(async () => message);
    const runtime: NativePiHostModelRuntime = {
      getModel: () => model,
      completeSimple,
    };
    const broker = new NativePiHostInferenceBroker({
      createModelRuntime: async () => runtime,
    });
    const context: Context = {
      systemPrompt: "Use only the supplied tools.",
      messages: [{ role: "user", content: "Create RESULT.md.", timestamp: 1 }],
      tools: [],
    };

    const response = await broker.infer(inferenceRequest(JSON.stringify({ version: 1, context })));

    expect(JSON.parse(response)).toEqual(message);
    expect(completeSimple).toHaveBeenCalledWith(model, context, {
      maxTokens: 4_096,
      maxRetries: 0,
      reasoning: "medium",
    });
  });

  it("rejects a child-selected model route before provider execution", async () => {
    const completeSimple = vi.fn();
    const broker = new NativePiHostInferenceBroker({
      createModelRuntime: async () => ({ getModel: () => testModel(), completeSimple }),
    });

    await expect(
      broker.infer(
        inferenceRequest(
          JSON.stringify({
            version: 1,
            provider: "attacker-provider",
            model: "attacker-model",
            context: { messages: [] },
          }),
        ),
      ),
    ).rejects.toThrow(/closed|schema|route/i);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("enforces the model-token budget across all turns in one trial", async () => {
    const message = assistantMessage();
    const completeSimple = vi.fn<NativePiHostModelRuntime["completeSimple"]>(async () => message);
    const broker = new NativePiHostInferenceBroker({
      createModelRuntime: async () => ({ getModel: () => testModel(), completeSimple }),
    });
    const request = inferenceRequest(JSON.stringify({ version: 1, context: { messages: [] } }));
    const boundedRequest = {
      ...request,
      evaluation: {
        ...request.evaluation,
        controls: {
          ...request.evaluation.controls,
          budget: { ...request.evaluation.controls.budget, maxModelTokens: 20 },
        },
      },
    };

    await expect(broker.infer(boundedRequest)).resolves.toEqual(JSON.stringify(message));
    await expect(broker.infer(boundedRequest)).rejects.toThrow(/token budget/i);
    expect(completeSimple.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 20 });
    expect(completeSimple.mock.calls[1]?.[2]).toMatchObject({ maxTokens: 8 });
  });
});

function inferenceRequest(body: string): ExternalHarnessInferenceRequest {
  return {
    identity: {
      version: 1,
      adapter: "pi-native-v1",
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
        policyDigest: "2".repeat(64),
        platform: "linux",
        containment: "linux-pid-namespace",
      },
      driver: {
        id: "native-pi-evaluation-v1",
        artifactSha256: "3".repeat(64),
        dependencyClosureSha256: "3".repeat(64),
        node: { version: "22.19.0", executableSha256: "3".repeat(64) },
      },
      harness: {
        package: "@earendil-works/pi-coding-agent",
        version: "0.84.0",
        integrity: `sha512-${"A".repeat(86)}==`,
        packageContentSha256: "4".repeat(64),
        config: "pi-evaluation-v1",
        configDigest: "4".repeat(64),
      },
      inference: {
        id: "flow-pi-inference-v1",
        version: 1,
        package: "@earendil-works/pi-ai",
        packageVersion: "0.84.0",
        packageIntegrity: `sha512-${"B".repeat(86)}==`,
        packageContentSha256: "5".repeat(64),
      },
    },
    evaluation: {
      planDigest: "5".repeat(64),
      trial: {
        trialId: `trial-${"6".repeat(48)}`,
        position: 1,
        taskId: "task",
        profileId: "candidate",
        seed: 7,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-trial-${"6".repeat(48)}`,
        cwd: "/tmp/workspace",
        backend: "reflink-copy-v1",
        snapshotDigest: "7".repeat(64),
      },
      instruction: { path: "TASK.md", sha256: "8".repeat(64) },
      controls: {
        model: { provider: "host-provider", id: "host-model", thinking: "medium" },
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
    requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71",
    body,
  };
}

function testModel(): Model<string> {
  return {
    id: "host-model",
    name: "Host Model",
    api: "test-api",
    provider: "host-provider",
    baseUrl: "https://provider.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "test-api",
    provider: "host-provider",
    model: "host-model",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}
