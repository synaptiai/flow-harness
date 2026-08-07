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
  it("forces termination when a provider leaves a referenced handle behind", async () => {
    const moduleUrl = new URL("../../dist/cli/main.js", import.meta.url).href;
    const script = `
      import { armForcedExit, flushProcessOutput, writeProcessOutput } from ${JSON.stringify(moduleUrl)};
      setInterval(() => {}, 1000);
      writeProcessOutput(process.stdout, "x".repeat(1_000_000) + "END\\n");
      await flushProcessOutput();
      process.exitCode = 7;
      armForcedExit(7, 25);
    `;

    const execution = spawnCaptured(process.execPath, ["--input-type=module", "-e", script], 100);
    const result = await execution.completed;

    expect(result.code).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).toHaveLength(1_000_004);
    expect(result.stdout.endsWith("END\n")).toBe(true);
  });

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

  it("handles SIGINT, persists cancellation, exits 130, and terminates the command process group", async () => {
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
      "--cwd",
      directory,
    ]);
    await waitForFile(grandchildStarted);
    execution.child.kill("SIGINT");
    const result = await execution.completed;

    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "cancelled",
      nodes: { execute: { error: { code: "command_aborted" } } },
    });
    const events = await readLedger(join(runsDirectory, "signal-run", "events.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_cancelled",
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
    const args = [
      "run",
      workflowPath,
      "--run-id",
      "shared-run",
      "--runs-dir",
      runsDirectory,
      "--cwd",
      directory,
    ];

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

  it("persists approval across CLI processes and executes only after resume", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "approval.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const marker = join(directory, "approved-command-ran.txt");
    await writeFile(
      workflowPath,
      approvalWorkflow(
        "runtime-approval",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
      ),
      "utf8",
    );

    const run = await spawnFlow([
      "run",
      workflowPath,
      "--run-id",
      "runtime-approval",
      "--runs-dir",
      runsDirectory,
      "--cwd",
      directory,
    ]).completed;
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "waiting_for_approval" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const approved = await spawnFlow([
      "approve",
      "runtime-approval",
      "approval-2",
      "--actor",
      "runtime:test",
      "--runs-dir",
      runsDirectory,
    ]).completed;
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.stdout)).toMatchObject({
      status: "running",
      nodes: { execute: { approval: { status: "granted", actor: "runtime:test" } } },
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const resumed = await spawnFlow([
      "resume",
      workflowPath,
      "--run-id",
      "runtime-approval",
      "--runs-dir",
      runsDirectory,
      "--cwd",
      directory,
    ]).completed;
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "succeeded",
      nodes: { execute: { approval: { status: "consumed" } } },
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("ran");
    const events = await readLedger(join(runsDirectory, "runtime-approval", "events.jsonl"));
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_granted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("runs detached work beyond the client and replays it from another CLI", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "detached.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const marker = join(directory, "detached-finished.txt");
    await writeFile(
      workflowPath,
      commandWorkflow(
        "detached-workflow",
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "done"), 500)`,
      ),
      "utf8",
    );

    try {
      const submitted = await spawnFlow([
        "run",
        workflowPath,
        "--detach",
        "--run-id",
        "detached-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ]).completed;
      expect(submitted.code, submitted.stderr).toBe(0);
      expect(JSON.parse(submitted.stdout)).toMatchObject({
        type: "accepted",
        runId: "detached-run",
      });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

      const firstPage = await spawnFlow([
        "events",
        "detached-run",
        "--after",
        "0",
        "--limit",
        "2",
        "--runs-dir",
        runsDirectory,
      ]).completed;
      expect(firstPage.code, firstPage.stderr).toBe(0);
      expect(JSON.parse(firstPage.stdout)).toMatchObject({
        cursor: 2,
        terminal: false,
        events: [
          { sequence: 1, type: "run_started" },
          { sequence: 2, type: "node_started" },
        ],
      });

      await waitForFile(marker);
      await waitForRunStatus(runsDirectory, "detached-run", "succeeded");
      const secondPage = await spawnFlow([
        "events",
        "detached-run",
        "--after",
        "2",
        "--limit",
        "2",
        "--runs-dir",
        runsDirectory,
      ]).completed;
      expect(secondPage.code, secondPage.stderr).toBe(0);
      expect(JSON.parse(secondPage.stdout)).toMatchObject({
        cursor: 4,
        terminal: true,
        events: [
          { sequence: 3, type: "node_succeeded" },
          { sequence: 4, type: "run_succeeded" },
        ],
      });

      const status = await spawnFlow(["supervisor", "status", "--runs-dir", runsDirectory])
        .completed;
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ type: "status", workers: [] });
    } finally {
      await spawnFlow(["supervisor", "shutdown", "--runs-dir", runsDirectory]).completed.catch(
        () => undefined,
      );
    }
  });

  it("coalesces concurrent supervisor auto-start into one generation", async () => {
    const directory = await createTemporaryDirectory();
    const runsDirectory = join(directory, "runs");

    try {
      const statuses = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const result = await spawnFlow(["supervisor", "status", "--runs-dir", runsDirectory])
            .completed;
          expect(result.code, result.stderr).toBe(0);
          return JSON.parse(result.stdout) as { generation: string; pid: number };
        }),
      );

      expect(new Set(statuses.map((status) => status.generation)).size).toBe(1);
      expect(new Set(statuses.map((status) => status.pid)).size).toBe(1);
    } finally {
      await spawnFlow(["supervisor", "shutdown", "--runs-dir", runsDirectory]).completed.catch(
        () => undefined,
      );
    }
  });

  it("cancels a detached process tree from a second CLI with attribution", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "detached-cancel.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const started = join(directory, "detached-started.txt");
    const release = join(directory, "detached-release.txt");
    const orphaned = join(directory, "detached-orphaned.txt");
    await writeFile(
      workflowPath,
      commandWorkflow(
        "detached-cancel-workflow",
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "started"); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) fs.writeFileSync(${JSON.stringify(orphaned)}, "orphan"); }, 20);`,
      ),
      "utf8",
    );

    try {
      const submitted = await spawnFlow([
        "run",
        workflowPath,
        "--detach",
        "--run-id",
        "detached-cancel-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ]).completed;
      expect(submitted.code, submitted.stderr).toBe(0);
      await waitForFile(started);

      const cancellationCommandId = "019fd722-4144-7a72-9c86-6f9af022b2e8";
      const cancelled = await spawnFlow([
        "cancel",
        "detached-cancel-run",
        "--actor",
        "runtime:test",
        "--reason",
        "Stop the detached command.",
        "--command-id",
        cancellationCommandId,
        "--runs-dir",
        runsDirectory,
      ]).completed;
      expect(cancelled.code, cancelled.stderr).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({
        type: "cancelled",
        commandId: cancellationCommandId,
        runId: "detached-cancel-run",
        runStatus: "cancelled",
      });

      const events = await readLedger(join(runsDirectory, "detached-cancel-run", "events.jsonl"));
      expect(events.at(-1)).toMatchObject({
        type: "run_cancelled",
        actor: "runtime:test",
        requestId: cancellationCommandId,
        reason: "Stop the detached command.",
      });
      await writeFile(release, "release", "utf8");
      await delay(250);
      await expect(stat(orphaned)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await spawnFlow(["supervisor", "shutdown", "--runs-dir", runsDirectory]).completed.catch(
        () => undefined,
      );
    }
  });

  it("adopts a live worker after the supervisor process is replaced", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "supervisor-restart.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const started = join(directory, "restart-started.txt");
    const release = join(directory, "restart-release.txt");
    const finished = join(directory, "restart-finished.txt");
    await writeFile(
      workflowPath,
      commandWorkflow(
        "supervisor-restart-workflow",
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "started"); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); fs.writeFileSync(${JSON.stringify(finished)}, "finished"); } }, 20);`,
      ),
      "utf8",
    );

    try {
      const submitted = await spawnFlow([
        "run",
        workflowPath,
        "--detach",
        "--run-id",
        "supervisor-restart-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ]).completed;
      expect(submitted.code, submitted.stderr).toBe(0);
      await waitForFile(started);

      const before = await spawnFlow(["supervisor", "status", "--runs-dir", runsDirectory])
        .completed;
      expect(before.code, before.stderr).toBe(0);
      const firstStatus = JSON.parse(before.stdout) as {
        generation: string;
        pid: number;
        workers: unknown[];
      };
      expect(firstStatus.workers).toHaveLength(1);
      process.kill(firstStatus.pid, "SIGTERM");
      await waitForProcessExit(firstStatus.pid);

      const after = await spawnFlow(["supervisor", "status", "--runs-dir", runsDirectory])
        .completed;
      expect(after.code, after.stderr).toBe(0);
      const replacement = JSON.parse(after.stdout) as {
        generation: string;
        pid: number;
        workers: Array<{ status: string; runId: string }>;
      };
      expect(replacement.generation).not.toBe(firstStatus.generation);
      expect(replacement.pid).not.toBe(firstStatus.pid);
      expect(replacement.workers).toEqual([
        expect.objectContaining({ runId: "supervisor-restart-run", status: "running" }),
      ]);

      await writeFile(release, "release", "utf8");
      await waitForFile(finished);
      await waitForRunStatus(runsDirectory, "supervisor-restart-run", "succeeded");
      const events = await readLedger(
        join(runsDirectory, "supervisor-restart-run", "events.jsonl"),
      );
      expect(events.map((event) => event.type)).toEqual([
        "run_started",
        "node_started",
        "node_succeeded",
        "run_succeeded",
      ]);
    } finally {
      await spawnFlow(["supervisor", "shutdown", "--runs-dir", runsDirectory]).completed.catch(
        () => undefined,
      );
    }
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

function approvalWorkflow(id: string, script: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
nodes:
  - id: execute
    type: command
    approval: { mode: required, grantTtlMs: 300000 }
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
  pauseStdoutMs = 0,
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
  if (pauseStdoutMs > 0) {
    child.stdout?.pause();
    setTimeout(() => child.stdout?.resume(), pauseStdoutMs).unref();
  }
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

async function waitForRunStatus(
  runsDirectory: string,
  runId: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const inspected = await spawnFlow(["inspect", runId, "--runs-dir", runsDirectory]).completed;
    if (inspected.code === 0 && JSON.parse(inspected.stdout).status === expectedStatus) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for run "${runId}" to reach "${expectedStatus}"`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
