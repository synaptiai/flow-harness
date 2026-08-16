import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { calculateCommandApprovalOperationDigest } from "../../src/domain/approval/command-approval.js";
import type { RunEvent } from "../../src/domain/run/events.js";
import { JsonlRunStore } from "../../src/infrastructure/fs/jsonl-run-store.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(projectRoot, "dist", "cli", "main.js");
const temporaryDirectories: string[] = [];
const supportsHostedPty = process.platform === "linux" && process.arch === "x64";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("compiled Flow terminal presentation", () => {
  it.runIf(supportsHostedPty)(
    "renders and restores the alternate screen in a Linux x64 pseudo-terminal",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "flow-tui-pty-"));
      temporaryDirectories.push(directory);
      const runsDirectory = join(directory, "runs");
      const runId = "tui-pty-run";
      const store = new JsonlRunStore(runsDirectory);
      for (const event of approvalEvents(runId, directory)) {
        await store.append(event);
      }
      await store.release(runId);

      try {
        const command = [
          "stty cols 100 rows 30;",
          `exec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} tui ${shellQuote(runId)}`,
          `--actor ${shellQuote("runtime:test")}`,
          `--runs-dir ${shellQuote(runsDirectory)}`,
        ].join(" ");
        let latestOutput = "";
        let interaction: Promise<void> | undefined;
        let interactionError: unknown;
        const result = await spawnCaptured(
          "script",
          ["--quiet", "--return", "--command", command, "/dev/null"],
          (output, child) => {
            latestOutput = output;
            if (interaction === undefined && output.includes("Actions")) {
              writeInput(child, "\r");
              interaction = (async () => {
                await waitForCondition(async () =>
                  (await new JsonlRunStore(runsDirectory).read(runId)).some(
                    (event) => event.type === "command_approval_granted",
                  ),
                );
                await waitForCondition(() => latestOutput.includes("running"));
                writeInput(child, "q");
              })().catch((error) => {
                interactionError = error;
                child.kill("SIGKILL");
              });
            }
          },
        );
        await interaction;
        if (interactionError !== undefined) {
          throw interactionError;
        }

        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain("\u001b[?1049h");
        expect(result.stdout).toContain("Flow run");
        expect(result.stdout).toContain("waiting_for_approval");
        expect(result.stdout).toContain("running");
        expect(result.stdout).toContain("\u001b[?1049l");
        expect(result.stdout.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
          result.stdout.indexOf("\u001b[?1049h"),
        );
        expect(
          (await new JsonlRunStore(runsDirectory).read(runId)).map((event) => event.type),
        ).toEqual(["run_started", "command_approval_requested", "command_approval_granted"]);
      } finally {
        await spawnCaptured(process.execPath, [
          cliPath,
          "supervisor",
          "shutdown",
          "--runs-dir",
          runsDirectory,
        ]).catch(() => undefined);
      }
    },
  );
});

function approvalEvents(runId: string, cwd: string): readonly RunEvent[] {
  const base = {
    version: 1 as const,
    runId,
    workflowId: "tui-pty-workflow",
  };
  const operation = {
    version: 1 as const,
    action: "process.execute" as const,
    cwd,
    executable: "node",
    args: ["--version"],
    timeoutMs: 10_000,
  };
  return [
    {
      ...base,
      sequence: 1,
      at: "2026-08-16T12:00:01.000Z",
      type: "run_started",
      nodeIds: ["step"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: createHash("sha256").update("tui-pty-workflow").digest("hex"),
      executionCwd: cwd,
      approvalRequirements: [{ nodeId: "step", grantTtlMs: 60_000 }],
    },
    {
      ...base,
      sequence: 2,
      at: "2026-08-16T12:00:02.000Z",
      type: "command_approval_requested",
      nodeId: "step",
      attempt: 1,
      requestId: "approval-2",
      grantTtlMs: 60_000,
      operation,
      operationDigest: calculateCommandApprovalOperationDigest(operation),
    },
  ];
}

async function spawnCaptured(
  executable: string,
  args: readonly string[],
  onOutput?: (output: string, child: ReturnType<typeof spawn>) => void,
) {
  const child = spawn(executable, [...args], {
    cwd: projectRoot,
    env: { ...process.env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    onOutput?.(stdout, child);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeInput(child: ReturnType<typeof spawn>, input: string): void {
  if (child.stdin === null) {
    throw new Error("pseudo-terminal input is unavailable");
  }
  child.stdin.write(input);
}

async function waitForCondition(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(25);
  }
  throw new Error("pseudo-terminal interaction did not settle before its deadline");
}
