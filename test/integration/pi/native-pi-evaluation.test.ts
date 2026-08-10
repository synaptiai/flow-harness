import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExternalHarnessEvaluationInput } from "../../../src/domain/evaluation/external-harness-protocol.js";
import { runNativePiEvaluationSession } from "../../../src/infrastructure/pi/native-pi-evaluation-driver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native Pi evaluation driver", () => {
  it("runs a real Pi edit session through a credential-free host broker", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, "RESULT.md"), "PENDING\n", "utf8");
    const infer = vi.fn(async (body: string) => {
      const request = JSON.parse(body) as { readonly context: Context };
      const hasToolResult = request.context.messages.some(
        (message) => message.role === "toolResult",
      );
      return JSON.stringify(hasToolResult ? terminalMessage() : editMessage());
    });

    const result = await runNativePiEvaluationSession({
      evaluation: evaluationInput(workspace),
      instructionText: "Replace PENDING with DONE in RESULT.md.",
      infer,
    });

    expect(await readFile(join(workspace, "RESULT.md"), "utf8")).toBe("DONE\n");
    expect(infer).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      harness: { outcome: "completed", runId: expect.any(String), reason: null },
      metrics: {
        turns: 2,
        toolCalls: 1,
        toolErrors: 0,
        policyViolations: null,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
  });

  it("denies read and edit paths outside the trial workspace", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const secretPath = join(root, "private.txt");
    const protectedPath = join(root, "protected.txt");
    await mkdir(workspace);
    await writeFile(secretPath, "PRIVATE_VALUE\n", "utf8");
    await writeFile(protectedPath, "UNCHANGED\n", "utf8");
    let secondContext = "";
    let turns = 0;
    const infer = vi.fn(async (body: string) => {
      turns += 1;
      if (turns === 1) {
        return JSON.stringify(escapeMessage(secretPath, protectedPath));
      }
      secondContext = body;
      return JSON.stringify(terminalMessage());
    });

    const result = await runNativePiEvaluationSession({
      evaluation: evaluationInput(workspace),
      instructionText: "Try to access files outside the workspace.",
      infer,
    });

    expect(await readFile(protectedPath, "utf8")).toBe("UNCHANGED\n");
    expect(secondContext).not.toContain("PRIVATE_VALUE");
    expect(result).toMatchObject({
      harness: { outcome: "completed" },
      metrics: { toolCalls: 2, toolErrors: 2 },
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-native-pi-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

function evaluationInput(workspace: string): ExternalHarnessEvaluationInput {
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
      cwd: workspace,
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

function editMessage(): AssistantMessage {
  return assistantMessage(
    [
      {
        type: "toolCall",
        id: "call-edit-result",
        name: "edit",
        arguments: {
          path: "RESULT.md",
          edits: [{ oldText: "PENDING\n", newText: "DONE\n" }],
        },
      },
    ],
    "toolUse",
  );
}

function terminalMessage(): AssistantMessage {
  return assistantMessage([{ type: "text", text: "The requested edit is complete." }], "stop");
}

function escapeMessage(secretPath: string, protectedPath: string): AssistantMessage {
  return assistantMessage(
    [
      {
        type: "toolCall",
        id: "call-read-outside",
        name: "read",
        arguments: { path: secretPath },
      },
      {
        type: "toolCall",
        id: "call-edit-outside",
        name: "edit",
        arguments: {
          path: protectedPath,
          edits: [{ oldText: "UNCHANGED\n", newText: "CHANGED\n" }],
        },
      },
    ],
    "toolUse",
  );
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
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
    stopReason,
    timestamp: 1,
  };
}
