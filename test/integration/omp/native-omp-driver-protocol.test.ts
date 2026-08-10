import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExternalHarnessProtocolSession,
  signExternalHarnessParentFrame,
} from "../../../src/domain/evaluation/external-harness-protocol.js";

const temporaryDirectories: string[] = [];
const bunExecutable =
  process.env.FLOW_BUN_EXECUTABLE?.trim() || join(homedir(), ".bun", "bin", "bun");
const driverPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/infrastructure/omp/native-omp-evaluation-driver.ts",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native OMP driver protocol", () => {
  it("runs one OMP edit through signed private process frames", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-native-omp-protocol-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, "RESULT.md"), "PENDING\n", "utf8");
    const sessionId = randomUUID();
    const secretHex = randomBytes(32).toString("hex");
    const trialId = `trial-${"b".repeat(48)}`;
    const identityDigest = "e".repeat(64);
    const protocol = new ExternalHarnessProtocolSession({
      sessionId,
      secretHex,
      trialId,
      identityDigest,
    });
    const child = spawn(bunExecutable, [driverPath], {
      cwd: workspace,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const evaluation = evaluationInput(workspace, trialId);
    const hello = signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: 1,
        sessionId,
        type: "hello",
        payload: {
          secretHex,
          trialId,
          identityDigest,
          evaluation,
          instructionText: "Replace PENDING with DONE in RESULT.md.",
        },
      },
      secretHex,
    );
    child.stdin.write(`${JSON.stringify(hello)}\n`);

    let parentSequence = 1;
    let inferenceCount = 0;
    let terminal: ReturnType<ExternalHarnessProtocolSession["acceptDriverLine"]> | undefined;
    while (terminal?.type !== "terminal") {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error(`OMP driver closed early: ${Buffer.concat(stderr).toString("utf8")}`);
      }
      const event = protocol.acceptDriverLine(next.value);
      if (event.type === "inference_request") {
        inferenceCount += 1;
        const context = JSON.parse(event.body) as {
          readonly context: { readonly messages: readonly { readonly role: string }[] };
        };
        const hasToolResult = context.context.messages.some(
          (message) => message.role === "toolResult",
        );
        const body = JSON.stringify(hasToolResult ? terminalMessage() : editMessage());
        protocol.completeInference(event.requestId);
        parentSequence += 1;
        const response = signExternalHarnessParentFrame(
          {
            version: 1,
            sequence: parentSequence,
            sessionId,
            type: "inference_response",
            payload: {
              requestId: event.requestId,
              body,
              bodySha256: sha256(body),
            },
          },
          secretHex,
        );
        child.stdin.write(`${JSON.stringify(response)}\n`);
      }
      terminal = event;
    }
    child.stdin.end();
    const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    expect(exitCode, Buffer.concat(stderr).toString("utf8")).toBe(0);
    expect(inferenceCount).toBe(2);
    expect(await readFile(join(workspace, "RESULT.md"), "utf8")).toBe("DONE\n");
    expect(terminal).toMatchObject({
      type: "terminal",
      harness: { outcome: "completed" },
      metrics: { turns: 2, toolCalls: 1, toolErrors: 0 },
    });
  }, 40_000);
});

function evaluationInput(workspace: string, trialId: string) {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId,
      position: 1,
      taskId: "task",
      profileId: "omp",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-${trialId}`,
      cwd: workspace,
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "d".repeat(64) },
    controls: {
      model: { provider: "provider", id: "model", thinking: "off" as const },
      budget: {
        maxNodeStarts: 8,
        maxModelTokens: 4_096,
        maxCostUsdMicros: 100_000,
        maxExecutionMs: 30_000,
        maxArtifactBytes: 1_048_576,
      },
      network: "deny" as const,
      retry: { providerRetries: 0 as const, harnessRetries: 0 as const },
    },
  };
}

function editMessage() {
  return assistantMessage(
    [
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
  );
}

function terminalMessage() {
  return assistantMessage([{ type: "text", text: "The requested edit is complete." }], "stop");
}

function assistantMessage(content: readonly Record<string, unknown>[], stopReason: string) {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
