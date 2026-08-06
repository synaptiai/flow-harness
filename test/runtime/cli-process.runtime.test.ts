import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(projectRoot, "dist", "cli", "main.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("compiled Flow process", () => {
  it("keeps the process alive until an uncooperative agent timeout is classified", async () => {
    const moduleUrl = new URL("../../dist/infrastructure/pi/pi-agent-executor.js", import.meta.url)
      .href;
    const script = `
      import { PiAgentExecutor } from ${JSON.stringify(moduleUrl)};
      const runner = { run: () => new Promise(() => {}) };
      const node = {
        id: "hung-agent",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt: "Never settles.",
          model: { provider: "test", id: "hung", thinking: "off" },
          tools: [],
          timeoutMs: 10
        }
      };
      const outcome = await new PiAgentExecutor(runner, undefined, 10).execute(node, {
        runId: "timeout-run",
        workflowId: "timeout-workflow",
        attempt: 1,
        cwd: process.cwd()
      });
      process.stdout.write(JSON.stringify(outcome));
    `;

    const execution = spawnCaptured(process.execPath, ["--input-type=module", "-e", script]);
    const result = await execution.completed;

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      error: { code: "pi_agent_timeout", sideEffectStatus: "uncertain" },
    });
  });

  it("handles SIGINT, persists failure, exits 130, and terminates the command process group", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "signal.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const grandchildStarted = join(directory, "grandchild-started.txt");
    const delayedWrite = join(directory, "orphaned.txt");
    const grandchildScript = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(grandchildStarted)}, "started"); setTimeout(() => fs.writeFileSync(${JSON.stringify(delayedWrite)}, "orphan"), 500); setInterval(() => {}, 1000);`;
    const commandScript = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    await writeFile(workflowPath, commandWorkflow("signal-workflow", commandScript), "utf8");

    const execution = spawnFlow([
      "run",
      workflowPath,
      "--run-id",
      "signal-run",
      "--runs-dir",
      runsDirectory,
    ]);
    await waitForFile(grandchildStarted);
    execution.child.kill("SIGINT");
    const result = await execution.completed;

    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      nodes: { execute: { error: { code: "command_aborted" } } },
    });
    const events = await readLedger(join(runsDirectory, "signal-run", "events.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_failed",
    ]);
    await delay(650);
    await expect(stat(delayedWrite)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one process to claim a shared run identifier", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "collision.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      commandWorkflow("collision-workflow", "setTimeout(() => {}, 250);"),
      "utf8",
    );
    const args = ["run", workflowPath, "--run-id", "shared-run", "--runs-dir", runsDirectory];

    const first = spawnFlow(args);
    const second = spawnFlow(args);
    const results = await Promise.all([first.completed, second.completed]);

    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.stderr).join("\n")).toContain("run_exists");
    const events = await readLedger(join(runsDirectory, "shared-run", "events.jsonl"));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);

    const inspect = spawnFlow(["inspect", "shared-run", "--runs-dir", runsDirectory]);
    const inspected = await inspect.completed;
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      runId: "shared-run",
      status: "succeeded",
    });
  });
});

function commandWorkflow(id: string, script: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
nodes:
  - id: execute
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args:
        - -e
        - ${JSON.stringify(script)}
      timeoutMs: 10000
`;
}

function spawnFlow(args: readonly string[]): {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
} {
  return spawnCaptured(process.execPath, [cliPath, ...args]);
}

function spawnCaptured(
  executable: string,
  args: readonly string[],
): {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
} {
  const child = spawn(executable, [...args], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<ProcessResult>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function readLedger(path: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
