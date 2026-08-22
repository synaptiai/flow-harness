import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("completes guided quick start through the production command sandbox", async () => {
    const directory = await createTemporaryDirectory();
    const readmePath = join(directory, "README.md");
    await writeFile(readmePath, "existing project documentation\n", "utf8");

    const quickstart = await spawnFlow(
      ["quickstart", directory, "--run-id", "runtime-quickstart"],
      directory,
    ).completed;

    expect(quickstart.code, quickstart.stderr).toBe(0);
    expect(quickstart.signal).toBeNull();
    expect(quickstart.stderr).toBe("");
    expect(JSON.parse(quickstart.stdout)).toEqual({
      version: 1,
      mode: "foundation",
      project: { publication: "created" },
      run: {
        id: "runtime-quickstart",
        status: "succeeded",
        evidence: ".flow/runs/runtime-quickstart/events.jsonl",
      },
      commands: {
        inspect: ["flow", "inspect", "runtime-quickstart"],
        browser: ["flow", "web", "runtime-quickstart", "--actor", "operator:quickstart"],
      },
    });
    await expect(readFile(readmePath, "utf8")).resolves.toBe("existing project documentation\n");
    const events = await readLedger(
      join(directory, ".flow", "runs", "runtime-quickstart", "events.jsonl"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);

    const inspect = await spawnFlow(["inspect", "runtime-quickstart"], directory).completed;
    expect(inspect.code, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      runId: "runtime-quickstart",
      status: "succeeded",
    });
  });

  it("treats permission loss as exit of the original same-user process", async () => {
    const lookup = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    try {
      await expect(waitForProcessExit(12_345)).resolves.toBeUndefined();
    } finally {
      lookup.mockRestore();
    }
  });

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
          skills: [],
          toolPackages: [],
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

  it("keeps the startup client alive until an uncooperative daemon is reaped", async () => {
    const directory = await createTemporaryDirectory();
    const fixturePath = join(directory, "uncooperative-supervisor.cjs");
    const pidPath = join(directory, "uncooperative-supervisor.pid");
    await writeFile(
      fixturePath,
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const storeUrl = new URL(
      "../../dist/infrastructure/fs/local-supervisor-store.js",
      import.meta.url,
    ).href;
    const daemonUrl = new URL("../../dist/supervisor/daemon.js", import.meta.url).href;
    const configUrl = new URL("../../dist/domain/config/resolver.js", import.meta.url).href;
    const runsDirectory = join(directory, "runs");
    const socketDirectory = join(directory, "sockets");
    const script = `
      import { LocalSupervisorStore } from ${JSON.stringify(storeUrl)};
      import { ensureSupervisor } from ${JSON.stringify(daemonUrl)};
      import { resolveFlowConfig } from ${JSON.stringify(configUrl)};
      const store = new LocalSupervisorStore(${JSON.stringify(runsDirectory)}, {
        socketDirectory: ${JSON.stringify(socketDirectory)}
      });
      try {
        await ensureSupervisor(store, ${JSON.stringify(fixturePath)}, resolveFlowConfig({}), {
          startupTimeoutMs: 100
        });
      } catch (error) {
        process.stdout.write(JSON.stringify({ name: error.name, pid: error.pid }));
      }
    `;
    let fixturePid: number | undefined;

    try {
      const result = await spawnCaptured(process.execPath, ["--input-type=module", "-e", script])
        .completed;

      expect(result.code, result.stderr).toBe(0);
      const timeout = JSON.parse(result.stdout) as { readonly name: string; readonly pid: number };
      expect(timeout).toMatchObject({
        name: "SupervisorStartupTimeoutError",
        pid: expect.any(Number),
      });
      fixturePid = timeout.pid;
      await expect(waitForProcessExit(fixturePid)).resolves.toBeUndefined();
    } finally {
      if (fixturePid === undefined) {
        await waitForFile(pidPath).catch(() => undefined);
        fixturePid = Number(await readFile(pidPath, "utf8").catch(() => "NaN"));
      }
      if (Number.isSafeInteger(fixturePid)) {
        killProcessGroupIfAlive(fixturePid);
      }
    }
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
    await Promise.race([
      waitForFile(grandchildStarted, 15_000),
      execution.completed.then((result) => {
        throw new Error(
          `Flow exited before the command grandchild started: ${JSON.stringify(result)}`,
        );
      }),
    ]);
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
      approvalWorkflow("collision-workflow", "throw new Error('approval must not execute');"),
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

    expect(results.map((result) => result.code).sort()).toEqual([1, 3]);
    expect(results.map((result) => result.stderr).join("\n")).toContain("run_exists");
    const events = await readLedger(join(runsDirectory, "shared-run", "events.jsonl"));
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "command_approval_requested",
    ]);

    const inspect = spawnFlow(["inspect", "shared-run", "--runs-dir", runsDirectory]);
    const inspected = await inspect.completed;
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      runId: "shared-run",
      status: "waiting_for_approval",
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

  it("delivers live agent-command denial from a separate CLI process to the attached owner", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-denial.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, agentCommandApprovalWorkflow(), "utf8");
    const cliUrl = new URL("../../dist/cli/main.js", import.meta.url).href;
    const routerUrl = new URL("../../dist/application/node-executor-router.js", import.meta.url)
      .href;
    const runWorkflowUrl = new URL("../../dist/application/run-workflow.js", import.meta.url).href;
    const agentCommandUrl = new URL("../../dist/domain/agent-command.js", import.meta.url).href;
    const piUrl = new URL("../../dist/infrastructure/pi/pi-agent-executor.js", import.meta.url)
      .href;
    const commandUrl = new URL(
      "../../dist/infrastructure/process/command-node-executor.js",
      import.meta.url,
    ).href;
    const ownerScript = `
      import { main } from ${JSON.stringify(cliUrl)};
      import { NodeExecutorRouter } from ${JSON.stringify(routerUrl)};
      import { AgentCommandApprovalDeniedError } from ${JSON.stringify(runWorkflowUrl)};
      import { calculateAgentCommandDigest, normalizeAgentCommandRequest } from ${JSON.stringify(agentCommandUrl)};
      import { PiAgentExecutor } from ${JSON.stringify(piUrl)};
      import { CommandNodeExecutor } from ${JSON.stringify(commandUrl)};
      const commandExecutor = new CommandNodeExecutor({
        sandbox: { prepare: async () => { throw new Error("denied command reached sandbox preparation"); } }
      });
      const agentExecutor = new PiAgentExecutor({
        async run(input) {
          const request = normalizeAgentCommandRequest({
            executable: process.execPath,
            args: ["-e", "process.exit(99)"],
            timeoutMs: 5000
          });
          const decision = input.policyBroker.authorize({
            action: "process.execute",
            target: request.executable,
            boundary: "inside",
            operationDigest: calculateAgentCommandDigest(request)
          });
          try {
            await input.commandRecorder.execute(request, decision, input.signal);
            throw new Error("denied command unexpectedly executed");
          } catch (error) {
            if (!(error instanceof AgentCommandApprovalDeniedError)) throw error;
            return { text: JSON.stringify(error.message), stopReason: "stop" };
          }
        }
      });
      const exitCode = await main(
        ["run", ${JSON.stringify(workflowPath)}, "--run-id", "runtime-agent-denial", "--runs-dir", ${JSON.stringify(runsDirectory)}, "--cwd", ${JSON.stringify(directory)}],
        undefined,
        { cwd: ${JSON.stringify(directory)}, executor: new NodeExecutorRouter(commandExecutor, agentExecutor) }
      );
      process.exitCode = exitCode;
    `;
    const owner = spawnCaptured(process.execPath, ["--input-type=module", "-e", ownerScript]);
    await waitForRunStatus(runsDirectory, "runtime-agent-denial", "waiting_for_approval");

    const denied = await spawnFlow([
      "deny",
      "runtime-agent-denial",
      "agent-approval-3",
      "--actor",
      "runtime:test",
      "--reason",
      "not authorized",
      "--runs-dir",
      runsDirectory,
    ]).completed;

    expect(denied.code, denied.stderr).toBe(0);
    expect(JSON.parse(denied.stdout)).toMatchObject({
      kind: "agent_command_approval_decision_submitted",
      requestId: "agent-approval-3",
      decision: "deny",
      actor: "runtime:test",
    });
    const ownerResult = await owner.completed;
    expect(ownerResult.code, ownerResult.stderr).toBe(0);
    expect(JSON.parse(ownerResult.stdout)).toMatchObject({
      status: "succeeded",
      nodes: {
        execute: {
          status: "succeeded",
          evidence: {
            text: JSON.stringify("agent command approval denied by runtime:test: not authorized"),
          },
          agentCommandApprovals: [
            {
              status: "denied",
              actor: "runtime:test",
              reason: "not authorized",
            },
          ],
        },
      },
    });
    const events = await readLedger(join(runsDirectory, "runtime-agent-denial", "events.jsonl"));
    expect(events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["node_agent_command_prepared", "node_agent_command_settled"]),
    );
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
        "--work-profile",
        "long",
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
          { sequence: 1, type: "run_started", workProfile: "long" },
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

  it("serves one terminal run through the compiled browser presentation CLI", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "browser.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      commandWorkflow("compiled-browser-workflow", "process.stdout.write('browser-ready');"),
      "utf8",
    );
    const run = await spawnFlow([
      "run",
      workflowPath,
      "--run-id",
      "compiled-browser-run",
      "--runs-dir",
      runsDirectory,
      "--cwd",
      directory,
    ]).completed;
    expect(run.code, run.stderr).toBe(0);
    const web = spawnFlow([
      "web",
      "compiled-browser-run",
      "--actor",
      "runtime:test",
      "--runs-dir",
      runsDirectory,
    ]);

    try {
      const sessionUrl = new URL(await waitForStdoutLine(web.child));
      const capability = sessionUrl.hash.slice(1);
      expect(sessionUrl.hostname).toBe("127.0.0.1");
      expect(capability).toMatch(/^[0-9a-f]{64}$/);
      const response = await fetch(`${sessionUrl.origin}/api/documents`, {
        headers: {
          authorization: `Bearer ${capability}`,
          origin: sessionUrl.origin,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      const line = (await response.text()).trim();
      expect(JSON.parse(line)).toMatchObject({
        apiVersion: "flow.synapti.ai/presentation/v1",
        run: {
          runId: "compiled-browser-run",
          workflowId: "compiled-browser-workflow",
          status: "succeeded",
        },
      });
      const result = await web.completed;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(sessionUrl.href);
    } finally {
      web.child.kill("SIGTERM");
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

  it("enforces project capacity with durable queue, rejection, and worker-free cancellation", async () => {
    const directory = await createTemporaryDirectory();
    const runsDirectory = join(directory, ".flow", "runs");
    const workflowPath = join(directory, "bounded.workflow.yaml");
    const initialized = await spawnFlow(["init", directory], directory).completed;
    expect(initialized.code, initialized.stderr).toBe(0);
    await writeFile(
      join(directory, ".flow", "config.yaml"),
      projectConfig({ maxActiveWorkers: 1, maxQueuedJobs: 1 }),
      "utf8",
    );
    await writeFile(
      workflowPath,
      commandWorkflow("bounded-workflow", "setInterval(() => {}, 1000);"),
      "utf8",
    );
    const submit = async (runId: string) =>
      await spawnFlow(
        ["run", workflowPath, "--detach", "--run-id", runId, "--cwd", directory],
        directory,
      ).completed;

    try {
      const accepted = await submit("bounded-active");
      const queued = await submit("bounded-queued");
      const rejected = await submit("bounded-rejected");

      expect(JSON.parse(accepted.stdout)).toMatchObject({ type: "accepted" });
      expect(JSON.parse(queued.stdout)).toMatchObject({ type: "queued", queuePosition: 1 });
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        type: "rejected",
        reason: "queue_full",
      });
      const status = await spawnFlow(["supervisor", "status"], directory).completed;
      expect(JSON.parse(status.stdout)).toMatchObject({
        limits: { maxActiveWorkers: 1, maxQueuedJobs: 1 },
        admission: { activeWorkers: 1, queuedJobs: 1 },
      });

      const queuedCancellation = await spawnFlow(
        ["cancel", "bounded-queued", "--actor", "runtime:test"],
        directory,
      ).completed;
      expect(JSON.parse(queuedCancellation.stdout)).toMatchObject({
        type: "cancelled",
        phase: "queued",
        lastSequence: null,
      });
      await expect(
        new Promise((resolvePromise, rejectPromise) => {
          stat(join(runsDirectory, "bounded-queued", "events.jsonl")).then(
            resolvePromise,
            rejectPromise,
          );
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const activeCancellation = await spawnFlow(
        ["cancel", "bounded-active", "--actor", "runtime:test"],
        directory,
      ).completed;
      expect(JSON.parse(activeCancellation.stdout)).toMatchObject({
        type: "cancelled",
        phase: "active",
      });
    } finally {
      await spawnFlow(["supervisor", "shutdown"], directory).completed.catch(() => undefined);
    }
  });

  it("requires explicit idle shutdown before rebinding changed project capacity", async () => {
    const directory = await createTemporaryDirectory();
    const initialized = await spawnFlow(["init", directory], directory).completed;
    expect(initialized.code, initialized.stderr).toBe(0);

    try {
      const initialStatus = await spawnFlow(["supervisor", "status"], directory).completed;
      expect(initialStatus.code, initialStatus.stderr).toBe(0);
      const firstPolicy = JSON.parse(initialStatus.stdout) as { policyDigest: string };
      await writeFile(
        join(directory, ".flow", "config.yaml"),
        projectConfig({ maxQueuedJobs: 1 }),
        "utf8",
      );

      const mismatched = await spawnFlow(["supervisor", "status"], directory).completed;
      expect(mismatched.code, mismatched.stderr).toBe(0);
      expect(JSON.parse(mismatched.stdout)).toMatchObject({
        policyDigest: firstPolicy.policyDigest,
        limits: { maxActiveWorkers: 1, maxQueuedJobs: 32 },
      });

      const shutdown = await spawnFlow(["supervisor", "shutdown"], directory).completed;
      expect(shutdown.code, shutdown.stderr).toBe(0);
      const rebound = await spawnFlow(["supervisor", "status"], directory).completed;
      expect(rebound.code, rebound.stderr).toBe(0);
      expect(JSON.parse(rebound.stdout)).toMatchObject({
        limits: { maxActiveWorkers: 1, maxQueuedJobs: 1 },
      });
      expect(JSON.parse(rebound.stdout).policyDigest).not.toBe(firstPolicy.policyDigest);
    } finally {
      await spawnFlow(["supervisor", "shutdown"], directory).completed.catch(() => undefined);
    }
  });

  it("cancels a detached process tree from a second CLI with attribution", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "detached-cancel.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const commandPidPath = join(directory, "detached-command.pid");
    const descendantPidPath = join(directory, "detached-descendant.pid");
    await writeFile(
      workflowPath,
      commandWorkflow(
        "detached-cancel-workflow",
        `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid)); const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid)); setInterval(() => {}, 1000);`,
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
      await Promise.all([waitForFile(commandPidPath), waitForFile(descendantPidPath)]);
      const commandPid = Number(await readFile(commandPidPath, "utf8"));
      const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      expect(Number.isSafeInteger(commandPid)).toBe(true);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);

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
      await Promise.all([waitForProcessExit(commandPid), waitForProcessExit(descendantPid)]);
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

function projectConfig(
  supervisor: Partial<{ readonly maxActiveWorkers: number; readonly maxQueuedJobs: number }>,
): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
supervisor:
${supervisor.maxActiveWorkers === undefined ? "" : `  maxActiveWorkers: ${supervisor.maxActiveWorkers}\n`}${supervisor.maxQueuedJobs === undefined ? "" : `  maxQueuedJobs: ${supervisor.maxQueuedJobs}\n`}`;
}

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

function agentCommandApprovalWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: runtime-agent-command-denial }
nodes:
  - id: execute
    type: agent
    agent:
      prompt: Request one command and handle a denial.
      model: { provider: test, id: deterministic, thinking: off }
      tools: [exec]
      toolApproval:
        exec: { mode: required, grantTtlMs: 300000 }
      timeoutMs: 10000
  - id: publish
    type: result
    dependsOn: [execute]
    result:
      source: { nodeId: execute, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function spawnFlow(
  args: readonly string[],
  cwd = projectRoot,
): {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
} {
  return spawnCaptured(process.execPath, [cliPath, ...args], 0, cwd);
}

function spawnCaptured(
  executable: string,
  args: readonly string[],
  pauseStdoutMs = 0,
  cwd = projectRoot,
): {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
} {
  const child = spawn(executable, [...args], {
    cwd,
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

async function waitForStdoutLine(child: ChildProcess): Promise<string> {
  const stream = child.stdout;
  if (stream === null) {
    throw new Error("child stdout is unavailable");
  }
  return await new Promise((resolveLine, reject) => {
    let pending = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child stdout"));
    }, 5_000);
    timeout.unref();
    const onData = (chunk: string | Buffer) => {
      pending += chunk.toString();
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline);
        cleanup();
        resolveLine(line);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("child exited before writing a line"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      child.off("close", onClose);
    };
    stream.on("data", onData);
    child.once("close", onClose);
  });
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

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
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
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ESRCH" || error.code === "EPERM")
      ) {
        return;
      }
      throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

function killProcessGroupIfAlive(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}
