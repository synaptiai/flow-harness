import type { Context } from "@oh-my-pi/pi-ai";

import type { ExternalHarnessEvaluationInput } from "../../../src/domain/evaluation/external-harness-protocol.js";
import { runNativeOmpEvaluationSession } from "../../../src/infrastructure/omp/native-omp-evaluation-driver.js";

const [workspace, scenario, firstOutsidePath, secondOutsidePath] = process.argv.slice(2);
if (workspace === undefined || (scenario !== "edit" && scenario !== "escape")) {
  throw new Error("usage: native-omp-session-runner <workspace> <edit|escape> [paths]");
}

const contexts: string[] = [];
const result = await runNativeOmpEvaluationSession({
  evaluation: evaluationInput(workspace),
  instructionText:
    scenario === "edit"
      ? "Replace PENDING with DONE in RESULT.md."
      : "Try to access files outside the workspace.",
  infer: async (body) => {
    contexts.push(body);
    const request = JSON.parse(body) as { readonly context: Context };
    const hasToolResult = request.context.messages.some((message) => message.role === "toolResult");
    if (hasToolResult) {
      return JSON.stringify(terminalMessage());
    }
    if (scenario === "edit") {
      return JSON.stringify(editMessage());
    }
    if (firstOutsidePath === undefined || secondOutsidePath === undefined) {
      throw new Error("escape scenario requires two outside paths");
    }
    return JSON.stringify(escapeMessage(firstOutsidePath, secondOutsidePath));
  },
});

process.stdout.write(`${JSON.stringify({ result, contexts })}\n`);

function evaluationInput(cwd: string): ExternalHarnessEvaluationInput {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "task",
      profileId: "candidate",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-trial-${"b".repeat(48)}`,
      cwd,
      backend: "reflink-copy-v1",
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "d".repeat(64) },
    controls: {
      model: { provider: "test-provider", id: "test-model", thinking: "off" },
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
  };
}

function editMessage() {
  return {
    ...assistantMessage(
      [
        {
          type: "text",
          text: "I will edit the requested file.",
          textSignature: "signed-provider-text",
        },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "opaque-provider-reasoning",
          redacted: true,
        },
        {
          type: "toolCall",
          id: "call-edit-result",
          name: "edit",
          arguments: {
            i: "replace the requested marker",
            path: "RESULT.md",
            old_string: "PENDING\n",
            new_string: "DONE\n",
          },
        },
      ],
      "toolUse",
    ),
    responseId: "response-123",
  };
}

function terminalMessage() {
  return assistantMessage([{ type: "text", text: "The requested edit is complete." }], "stop");
}

function escapeMessage(secretPath: string, protectedPath: string) {
  return assistantMessage(
    [
      {
        type: "toolCall",
        id: "call-read-outside",
        name: "read",
        arguments: { i: "test the read boundary", path: secretPath },
      },
      {
        type: "toolCall",
        id: "call-edit-outside",
        name: "edit",
        arguments: {
          i: "test the edit boundary",
          path: protectedPath,
          old_string: "UNCHANGED\n",
          new_string: "CHANGED\n",
        },
      },
    ],
    "toolUse",
  );
}

function assistantMessage(
  content: readonly Record<string, unknown>[],
  stopReason: "stop" | "toolUse",
) {
  return {
    role: "assistant",
    content,
    api: "flow-host-inference-v1",
    provider: "flow-host-broker",
    model: "flow-host-model",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
    stopReason,
    timestamp: 1,
  };
}
