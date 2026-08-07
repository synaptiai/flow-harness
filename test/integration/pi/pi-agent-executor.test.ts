import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EmbeddedPiAgentRunner,
  PiAgentExecutor,
} from "../../../src/infrastructure/pi/pi-agent-executor.js";
import type { CompiledAgentNode } from "../../../src/domain/workflow/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("embedded Pi SDK integration", () => {
  it("executes through the real ModelRuntime and createAgentSession with an in-process provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "flow-pi-sdk-"));
    temporaryDirectories.push(cwd);
    const target = join(cwd, "source.ts");
    const before = "const value = 1;\n";
    const after = "const value = 2;\n";
    await writeFile(target, before, "utf8");
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
      streamSimple: (model, context) => {
        const stream = createAssistantMessageEventStream();
        const invocation = context.messages.filter(
          (message) => message.role === "assistant",
        ).length;
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
          if (invocation < 2) {
            const version =
              invocation === 0 ? undefined : extractReadVersionFromContext(context.messages);
            const toolCall = {
              type: "toolCall" as const,
              id: `flow-sdk-call-${invocation + 1}`,
              name: invocation === 0 ? "flow_read" : "flow_edit",
              arguments:
                invocation === 0
                  ? { path: "source.ts" }
                  : {
                      path: "source.ts",
                      expectedSha256: version,
                      edits: [{ oldText: "value = 1", newText: "value = 2" }],
                    },
            };
            message.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: message,
            });
            message.stopReason = "toolUse";
            stream.push({ type: "done", reason: "toolUse", message });
          } else {
            const block = { type: "text" as const, text: "FLOW_SDK_EDIT_OK" };
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
          }
          stream.end();
        });
        return stream;
      },
    });
    const executor = new PiAgentExecutor(new EmbeddedPiAgentRunner(async () => runtime));

    const outcome = await executor.execute(agentNode(["read", "edit"]), {
      runId: "sdk-run",
      workflowId: "sdk-workflow",
      attempt: 1,
      cwd,
      protectedPaths: [],
    });

    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider: "flow-test",
        model: "deterministic",
        text: "FLOW_SDK_EDIT_OK",
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        textTruncated: false,
        policyDecisions: [
          expect.objectContaining({ action: "filesystem.read", outcome: "allowed" }),
          expect.objectContaining({ action: "filesystem.read", outcome: "allowed" }),
          expect.objectContaining({ action: "filesystem.write", outcome: "allowed" }),
        ],
        effectReceipts: [
          expect.objectContaining({
            kind: "filesystem.edit",
            beforeSha256: sha256(before),
            afterSha256: sha256(after),
            outcome: "committed",
          }),
        ],
      },
    });
    expect(await readFile(target, "utf8")).toBe(after);
  });
});

function agentNode(tools: CompiledAgentNode["agent"]["tools"] = []): CompiledAgentNode {
  return {
    id: "sdk-agent",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Read source.ts, change value 1 to 2, then report the deterministic marker.",
      model: { provider: "flow-test", id: "deterministic", thinking: "off" },
      tools,
      timeoutMs: 5_000,
    },
  };
}

function extractReadVersionFromContext(
  messages: readonly { readonly role: string; readonly content?: unknown }[],
): string {
  const readResult = [...messages]
    .reverse()
    .find(
      (message): message is { readonly role: "toolResult"; readonly content: unknown } =>
        message.role === "toolResult",
    );
  const match = JSON.stringify(readResult?.content).match(/sha256:([a-f0-9]{64})/);
  if (match?.[1] === undefined) {
    throw new Error("real Pi session did not return the Flow read version marker");
  }
  return match[1];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
