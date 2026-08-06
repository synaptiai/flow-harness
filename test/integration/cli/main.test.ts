import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { main, type CliIo } from "../../../src/cli/main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("flow CLI integration", () => {
  it("validates a workflow with structured graph rules", async () => {
    const fixture = join(
      process.cwd(),
      "test",
      "fixtures",
      "workflows",
      "valid-command.workflow.yaml",
    );
    const capture = createCapture();

    const exitCode = await main(["validate", fixture], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain('Workflow "verify-foundation" is valid');
  });

  it("rejects an invalid workflow before executor or run-store side effects", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "invalid.workflow.yaml");
    await writeFile(workflowPath, "kind: NotAWorkflow\n", "utf8");
    let executorCalls = 0;
    const executor: NodeExecutor = {
      async execute() {
        executorCalls += 1;
        throw new Error("executor must not be called");
      },
    };
    const capture = createCapture();

    const exitCode = await main(["run", workflowPath], capture.io, {
      cwd: directory,
      executor,
    });

    expect(exitCode).toBe(2);
    expect(executorCalls).toBe(0);
    await expect(stat(join(directory, ".flow"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(capture.stderr.join("\n")).toContain("invalid_schema");
  });

  it("runs and inspects a command workflow through the production path", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "command.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-command }
nodes:
  - id: verify
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [--version]
`,
      "utf8",
    );
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "cli-run", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory },
    );

    expect(runExitCode).toBe(0);
    expect(JSON.parse(runCapture.stdout.join("\n"))).toMatchObject({
      runId: "cli-run",
      status: "succeeded",
    });

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "cli-run", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );

    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(
      JSON.parse(runCapture.stdout.join("\n")),
    );
  });

  it("persists failure and terminates the command group when execution is cancelled", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "cancel.workflow.yaml");
    const delayedWrite = join(directory, "orphaned.txt");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cancel-command }
nodes:
  - id: long-command
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args:
        - -e
        - ${JSON.stringify(`const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(delayedWrite)}, "orphan"), 400); setInterval(() => {}, 1000);`)}
      timeoutMs: 10000
`,
      "utf8",
    );
    const controller = new AbortController();
    const capture = createCapture();

    const runPromise = main(
      ["run", workflowPath, "--run-id", "cancel-run", "--runs-dir", runsDirectory],
      capture.io,
      { cwd: directory, signal: controller.signal },
    );
    await delay(50);
    controller.abort();
    const exitCode = await runPromise;

    expect(exitCode).toBe(1);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      status: "failed",
      failedNodeId: "long-command",
      nodes: {
        "long-command": {
          status: "failed",
          error: { code: "command_aborted" },
        },
      },
    });
    await delay(450);
    await expect(stat(delayedWrite)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists and replays a failed command without executing its dependent", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "failure.workflow.yaml");
    const forbiddenWrite = join(directory, "dependent-ran.txt");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: failed-command }
nodes:
  - id: failing
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, "process.exit(9)"]
  - id: forbidden-dependent
    type: command
    dependsOn: [failing]
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(forbiddenWrite)}, "ran")`)}]
`,
      "utf8",
    );
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "failed-run", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory },
    );

    expect(runExitCode).toBe(1);
    const runState = JSON.parse(runCapture.stdout.join("\n"));
    expect(runState).toMatchObject({
      status: "failed",
      failedNodeId: "failing",
      nodes: {
        failing: { status: "failed", error: { code: "command_failed" } },
        "forbidden-dependent": { status: "pending" },
      },
    });
    await expect(stat(forbiddenWrite)).rejects.toMatchObject({ code: "ENOENT" });

    const ledger = await readFile(join(runsDirectory, "failed-run", "events.jsonl"), "utf8");
    expect(
      ledger
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual(["run_started", "node_started", "node_failed", "run_failed"]);

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "failed-run", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );
    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(runState);
  });
});

function createCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
