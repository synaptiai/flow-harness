import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExternalHarnessProtocolSession,
  signExternalHarnessParentFrame,
} from "../../../src/domain/evaluation/external-harness-protocol.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("compiled native Prime driver protocol", () => {
  it("completes one signed inference exchange in a separate process", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "flow-prime-driver-protocol-"));
    temporaryDirectories.push(workspace);
    const sessionId = "018f4ee8-9d67-7ca1-a31f-4f3f2388e934";
    const secretHex = "1".repeat(64);
    const trialId = `trial-${"b".repeat(48)}`;
    const identityDigest = "e".repeat(64);
    const verifier = new ExternalHarnessProtocolSession({
      sessionId,
      secretHex,
      trialId,
      identityDigest,
    });
    const child = spawn(
      process.execPath,
      [resolve(repositoryRoot, "test/fixtures/prime/native-prime-driver-runner.mjs")],
      {
        cwd: repositoryRoot,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const lines = output[Symbol.asyncIterator]();
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
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
          evaluation: evaluationInput(workspace, trialId),
          instructionText: "Use IPython to complete the task.",
        },
      },
      secretHex,
    );
    child.stdin.write(`${JSON.stringify(hello)}\n`);

    const ready = verifier.acceptDriverLine(await nextLine(lines, child, errors));
    expect(ready).toEqual({ type: "ready", trialId, identityDigest });
    expectProgress(
      verifier.acceptDriverLine(await nextLine(lines, child, errors)),
      "sdk-prompt-started",
    );
    const request = verifier.acceptDriverLine(await nextLine(lines, child, errors));
    expect(request.type).toBe("inference_request");
    if (request.type !== "inference_request") {
      throw new Error("compiled Prime driver did not request inference");
    }
    expect(JSON.parse(request.body)).toEqual({
      version: 1,
      context: { messages: [] },
    });
    const responseBody = '{"message":"done"}';
    child.stdin.write(
      `${JSON.stringify(
        signExternalHarnessParentFrame(
          {
            version: 1,
            sequence: 2,
            sessionId,
            type: "inference_response",
            payload: {
              requestId: request.requestId,
              body: responseBody,
              bodySha256: sha256(responseBody),
            },
          },
          secretHex,
        ),
      )}\n`,
    );
    verifier.completeInference(request.requestId);

    expectProgress(
      verifier.acceptDriverLine(await nextLine(lines, child, errors)),
      "inference-response-received",
    );
    expectProgress(
      verifier.acceptDriverLine(await nextLine(lines, child, errors)),
      "sdk-prompt-settled",
    );
    expectProgress(
      verifier.acceptDriverLine(await nextLine(lines, child, errors)),
      "sdk-cleanup-started",
    );
    expectProgress(
      verifier.acceptDriverLine(await nextLine(lines, child, errors)),
      "sdk-cleanup-settled",
    );
    const terminal = verifier.acceptDriverLine(await nextLine(lines, child, errors));
    expect(terminal).toMatchObject({
      type: "terminal",
      harness: { outcome: "completed", runId: "compiled-prime-session", reason: null },
      metrics: { turns: 2, toolCalls: 1, toolErrors: 0 },
    });
    child.stdin.end();
    await expect(exitCode(child)).resolves.toBe(0);
    expect(Buffer.concat(errors).toString("utf8")).toBe("");
  });
});

function expectProgress(
  event: ReturnType<ExternalHarnessProtocolSession["acceptDriverLine"]>,
  message: string,
): void {
  expect(event).toEqual({ type: "event", category: "progress", message });
}

function evaluationInput(workspace: string, trialId: string) {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId,
      position: 1,
      taskId: "task",
      profileId: "prime",
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
      model: { provider: "test-provider", id: "test-model", thinking: "off" as const },
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

async function nextLine(
  lines: AsyncIterator<string>,
  child: ReturnType<typeof spawn>,
  errors: readonly Buffer[],
): Promise<string> {
  const next = await lines.next();
  if (next.done === true) {
    const code = child.exitCode ?? (await exitCode(child));
    throw new Error(
      `compiled Prime driver closed its output early with code ${String(code)}: ${Buffer.concat(errors).toString("utf8")}`,
    );
  }
  return next.value;
}

async function exitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
