import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { main, type CliIo } from "../../../src/cli/main.js";
import type { RunEvent } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";

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

  it("reports declared criterion count during validation", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "goal.workflow.yaml");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: goal-validation }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: verified-change }
  outcome: The change is accepted.
  criteria:
    - id: verification-passes
      description: Verification passes.
      verifier: { nodeId: verify }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [--version] }
`,
      "utf8",
    );
    const capture = createCapture();

    const exitCode = await main(["validate", workflowPath], capture.io, { cwd: directory });

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("nodes: 1, criteria: 1");
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
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: cli-verification }
  outcome: The command workflow is verified.
  criteria:
    - id: command-passes
      description: The verification command passes.
      verifier: { nodeId: verify }
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

    expect(runExitCode, [...runCapture.stderr, ...runCapture.stdout].join("\n")).toBe(0);
    expect(JSON.parse(runCapture.stdout.join("\n"))).toMatchObject({
      runId: "cli-run",
      status: "succeeded",
      goal: {
        status: "accepted",
        criteria: {
          "command-passes": {
            status: "accepted",
            decision: { runId: "cli-run", nodeId: "verify", attempt: 1 },
          },
        },
      },
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

  it("waits durably, records approval, and resumes the exact command", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "approval.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, approvalWorkflow("cli-approval"), "utf8");
    const executorCalls: string[] = [];
    const executor = successfulRecordingExecutor(executorCalls);
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "cli-approval", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory, executor },
    );

    expect(runExitCode).toBe(3);
    expect(executorCalls).toEqual([]);
    expect(JSON.parse(runCapture.stdout.join("\n"))).toMatchObject({
      status: "waiting_for_approval",
      nodes: {
        verify: {
          status: "pending",
          approval: {
            status: "pending",
            requestId: "approval-2",
            operation: { cwd: directory, executable: "node", args: ["--version"] },
          },
        },
      },
    });

    const inspectCapture = createCapture();
    expect(
      await main(["inspect", "cli-approval", "--runs-dir", runsDirectory], inspectCapture.io, {
        cwd: directory,
        executor,
      }),
    ).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(
      JSON.parse(runCapture.stdout.join("\n")),
    );

    const approveCapture = createCapture();
    const approveExitCode = await main(
      [
        "approve",
        "cli-approval",
        "approval-2",
        "--actor",
        "operator:test",
        "--runs-dir",
        runsDirectory,
      ],
      approveCapture.io,
      {
        cwd: directory,
        createStore: (rootDirectory) => new JsonlRunStore(rootDirectory),
        get executor(): NodeExecutor {
          throw new Error("approval must not initialize the execution plane");
        },
      },
    );

    expect(approveExitCode).toBe(0);
    expect(executorCalls).toEqual([]);
    expect(JSON.parse(approveCapture.stdout.join("\n"))).toMatchObject({
      status: "running",
      nodes: {
        verify: { approval: { status: "granted", actor: "operator:test" } },
      },
    });

    const resumeCapture = createCapture();
    const resumeExitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-approval", "--runs-dir", runsDirectory],
      resumeCapture.io,
      { cwd: directory, executor },
    );

    expect(resumeExitCode).toBe(0);
    expect(executorCalls).toEqual(["verify"]);
    expect(JSON.parse(resumeCapture.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      nodes: {
        verify: { status: "succeeded", approval: { status: "consumed" } },
      },
    });
    const ledger = await readFile(join(runsDirectory, "cli-approval", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_granted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("denies a durable approval without executing the command", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "denial.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, approvalWorkflow("cli-denial"), "utf8");
    const executorCalls: string[] = [];
    const executor = successfulRecordingExecutor(executorCalls);

    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-denial", "--runs-dir", runsDirectory],
        createCapture().io,
        { cwd: directory, executor },
      ),
    ).toBe(3);

    const denyCapture = createCapture();
    const denyExitCode = await main(
      [
        "deny",
        "cli-denial",
        "approval-2",
        "--actor",
        "operator:test",
        "--reason",
        "not authorized",
        "--runs-dir",
        runsDirectory,
      ],
      denyCapture.io,
      { cwd: directory, executor },
    );

    expect(denyExitCode).toBe(0);
    expect(executorCalls).toEqual([]);
    expect(JSON.parse(denyCapture.stdout.join("\n"))).toMatchObject({
      status: "failed",
      failedNodeId: "verify",
      nodes: {
        verify: {
          status: "failed",
          error: { code: "command_approval_denied" },
          approval: { status: "denied", actor: "operator:test", reason: "not authorized" },
        },
      },
    });
    const ledger = await readFile(join(runsDirectory, "cli-denial", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "command_approval_requested",
      "command_approval_denied",
      "run_failed",
    ]);
  });

  it("rejects malformed or stale approval commands without changing the ledger", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "stale-approval.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, approvalWorkflow("cli-stale-approval"), "utf8");
    const executor = successfulRecordingExecutor([]);
    await main(
      ["run", workflowPath, "--run-id", "cli-stale-approval", "--runs-dir", runsDirectory],
      createCapture().io,
      { cwd: directory, executor },
    );
    const ledgerPath = join(runsDirectory, "cli-stale-approval", "events.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const missingActor = createCapture();
    expect(
      await main(
        ["approve", "cli-stale-approval", "approval-2", "--runs-dir", runsDirectory],
        missingActor.io,
        { cwd: directory, executor },
      ),
    ).toBe(2);
    expect(missingActor.stderr.join("\n")).toContain("requires --actor");

    const stale = createCapture();
    expect(
      await main(
        [
          "approve",
          "cli-stale-approval",
          "approval-99",
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        stale.io,
        { cwd: directory, executor },
      ),
    ).toBe(1);
    expect(stale.stderr.join("\n")).toContain("request_mismatch");
    await expect(readFile(ledgerPath, "utf8")).resolves.toBe(before);
  });

  it("resumes pending work without re-executing a successful node", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "resume.workflow.yaml");
    const forbiddenWrite = join(directory, "successful-node-reran.txt");
    const resumedWrite = join(directory, "pending-node-ran.txt");
    const runsDirectory = join(directory, "runs");
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: resumable-command }
nodes:
  - id: completed
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(forbiddenWrite)}, "reran")`)}]
  - id: pending
    type: command
    dependsOn: [completed]
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(resumedWrite)}, "ran")`)}]
`;
    await writeFile(workflowPath, source, "utf8");
    const workflow = compileWorkflowText(source, workflowPath);
    const store = new JsonlRunStore(runsDirectory);
    for (const event of interruptedAfterFirstSuccess(workflow, "cli-resume")) {
      await store.append(event);
    }
    await store.release("cli-resume");
    const capture = createCapture();
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.id === "completed") {
          await writeFile(forbiddenWrite, "reran", "utf8");
        }
        if (node.id === "pending") {
          await writeFile(resumedWrite, "ran", "utf8");
        }
        return { status: "succeeded", evidence: commandEvidence(node.id) };
      },
    };

    const exitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-resume", "--runs-dir", runsDirectory],
      capture.io,
      { cwd: directory, executor },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      runId: "cli-resume",
      status: "succeeded",
      nodes: { completed: { status: "succeeded" }, pending: { status: "succeeded" } },
    });
    await expect(stat(forbiddenWrite)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resumedWrite, "utf8")).resolves.toBe("ran");
    const ledger = await readFile(join(runsDirectory, "cli-resume", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);

    const terminalCapture = createCapture();
    const terminalExitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-resume", "--runs-dir", runsDirectory],
      terminalCapture.io,
      { cwd: directory, executor },
    );
    expect(terminalExitCode).toBe(1);
    expect(terminalCapture.stderr.join("\n")).toContain("terminal_run");
    await expect(readFile(join(runsDirectory, "cli-resume", "events.jsonl"), "utf8")).resolves.toBe(
      ledger,
    );
  });

  it("resume reports an uncertain open attempt without appending or executing", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "uncertain.workflow.yaml");
    const forbiddenWrite = join(directory, "uncertain-node-reran.txt");
    const runsDirectory = join(directory, "runs");
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: uncertain-command }
nodes:
  - id: uncertain
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(forbiddenWrite)}, "reran")`)}]
`;
    await writeFile(workflowPath, source, "utf8");
    const workflow = compileWorkflowText(source, workflowPath);
    const store = new JsonlRunStore(runsDirectory);
    const started = runStartedEvent(workflow, "cli-uncertain");
    await store.append(started);
    await store.append({
      ...eventBase("cli-uncertain", workflow.id, 2),
      type: "node_started",
      nodeId: "uncertain",
      attempt: 1,
    });
    await store.release("cli-uncertain");
    const before = await readFile(join(runsDirectory, "cli-uncertain", "events.jsonl"), "utf8");
    const capture = createCapture();

    const exitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-uncertain", "--runs-dir", runsDirectory],
      capture.io,
      { cwd: directory },
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toContain("uncertain_operation");
    expect(capture.stderr.join("\n")).toContain('node "uncertain" attempt 1');
    await expect(stat(forbiddenWrite)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(runsDirectory, "cli-uncertain", "events.jsonl"), "utf8"),
    ).resolves.toBe(before);
  });

  it("persists failure and terminates the command group when execution is cancelled", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "cancel.workflow.yaml");
    const startedWrite = join(directory, "started.txt");
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
        - ${JSON.stringify(`const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(startedWrite)}, "started"); setTimeout(() => fs.writeFileSync(${JSON.stringify(delayedWrite)}, "orphan"), 400); setInterval(() => {}, 1000);`)}
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
    await waitForFile(startedWrite);
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

function interruptedAfterFirstSuccess(
  workflow: ReturnType<typeof compileWorkflowText>,
  runId: string,
): RunEvent[] {
  return [
    runStartedEvent(workflow, runId),
    {
      ...eventBase(runId, workflow.id, 2),
      type: "node_started",
      nodeId: "completed",
      attempt: 1,
    },
    {
      ...eventBase(runId, workflow.id, 3),
      type: "node_succeeded",
      nodeId: "completed",
      attempt: 1,
      evidence: commandEvidence(),
    },
  ];
}

function runStartedEvent(
  workflow: ReturnType<typeof compileWorkflowText>,
  runId: string,
): RunEvent {
  return {
    ...eventBase(runId, workflow.id, 1),
    type: "run_started",
    nodeIds: workflow.nodes.map((node) => node.id),
    workflowApiVersion: workflow.apiVersion,
    workflowDigest: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
    ...(workflow.goal === undefined ? {} : { goal: workflow.goal }),
  };
}

function eventBase(runId: string, workflowId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-06T15:00:0${sequence}.000Z`,
    runId,
    workflowId,
  };
}

function commandEvidence(nodeId = "completed") {
  return {
    kind: "command" as const,
    executable: process.execPath,
    args: ["-e", nodeId],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutHash: createHash("sha256").update("").digest("hex"),
    stderrHash: createHash("sha256").update("").digest("hex"),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function approvalWorkflow(id: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
nodes:
  - id: verify
    type: command
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [--version], timeoutMs: 10000 }
`;
}

function successfulRecordingExecutor(calls: string[]): NodeExecutor {
  return {
    async execute(node) {
      calls.push(node.id);
      return { status: "succeeded", evidence: commandEvidence(node.id) };
    },
  };
}

function ledgerTypes(ledger: string): string[] {
  return ledger
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).type as string);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for child start marker: ${path}`);
}
