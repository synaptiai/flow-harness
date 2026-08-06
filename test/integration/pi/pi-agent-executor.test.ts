import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
} from "../../../src/infrastructure/pi/pi-agent-executor.js";
import type { CompiledAgentNode } from "../../../src/domain/workflow/types.js";

describe("embedded Pi SDK integration", () => {
  it("executes through the real ModelRuntime and createAgentSession with an in-process provider", async () => {
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    runtime.registerProvider("flow-test", {
      name: "Flow deterministic test provider",
      api: "openai-completions",
      baseUrl: "https://flow.test.invalid/v1",
      apiKey: "test-only-key",
      models: [
        {
          id: "deterministic",
          name: "Deterministic",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4_096,
          maxTokens: 256,
        },
      ],
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "pending",
          timestamp: Date.now(),
        };

        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          const block = { type: "text" as const, text: "FLOW_SDK_OK" };
          message.content.push(block);
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: block.text,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: block.text,
            partial: message,
          });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    const executor = new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime));

    const outcome = await executor.execute(agentNode(), {
      runId: "sdk-run",
      workflowId: "sdk-workflow",
      attempt: 1,
      cwd: process.cwd(),
    });

    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: "flow-test",
        model: "deterministic",
        text: "FLOW_SDK_OK",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        textTruncated: false,
      },
    });
  });
});

function agentNode(): CompiledAgentNode {
  return {
    id: "sdk-agent",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Reply with the deterministic marker.",
      model: { provider: "flow-test", id: "deterministic", thinking: "off" },
      tools: [],
      timeoutMs: 5_000,
    },
  };
}
