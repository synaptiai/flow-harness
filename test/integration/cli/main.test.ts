import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";
import type { CommandSandbox } from "../../../src/application/command-sandbox.js";
import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import {
  type AgentCommandApprovalDecisionChannel,
  AgentCommandApprovalDecisionSourceError,
  type NodeExecutor,
} from "../../../src/application/ports.js";
import { AgentCommandApprovalDeniedError } from "../../../src/application/run-workflow.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import {
  calculateAgentCommandApprovalRequestDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";
import {
  calculateFlowPolicyDigest,
  FLOW_CONFIG_API_VERSION,
  parseOperatorConfig,
  resolveFlowConfig,
} from "../../../src/domain/config/resolver.js";
import {
  type RunEvent,
  type RunStartedEvent,
  type RunState,
  type RunStatus,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalAgentCommandApprovalChannel } from "../../../src/infrastructure/fs/local-agent-command-approval-channel.js";
import { PiAgentExecutor } from "../../../src/infrastructure/pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../../../src/infrastructure/process/command-node-executor.js";

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

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
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

  it("rejects invalid project configuration before supervisor or run-store mutation", async () => {
    const directory = await createTemporaryDirectory();
    await mkdir(join(directory, ".flow"));
    await writeFile(
      join(directory, ".flow", "config.yaml"),
      "apiVersion: flow.synapti.ai/v2\nkind: FlowProjectConfig\n",
      "utf8",
    );
    const capture = createCapture();

    const exitCode = await main(["supervisor", "status"], capture.io, { cwd: directory });

    expect(exitCode).toBe(2);
    expect(capture.stderr.join("\n")).toMatch(/invalid_config.*apiVersion/i);
    await expect(stat(join(directory, ".flow", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("constructs a foreground executor from the trusted sandbox profile", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "sandbox-profile.workflow.yaml");
    await writeFile(
      workflowPath,
      `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: sandbox-profile }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [--version] }
`,
      "utf8",
    );
    const config = resolveFlowConfig({
      projectRoot: directory,
      operator: {
        path: "/operator/config.yaml",
        config: parseOperatorConfig(
          {
            apiVersion: FLOW_CONFIG_API_VERSION,
            kind: "FlowOperatorConfig",
            sandbox: { profile: "container" },
          },
          "/operator/config.yaml",
        ),
      },
    });
    const selectedProfiles: { readonly profile: string; readonly projectRoot?: string }[] = [];
    const capture = createCapture();

    const exitCode = await main(["run", workflowPath], capture.io, {
      cwd: directory,
      loadConfig: async () => config,
      createNodeExecutor(profile, projectRoot) {
        selectedProfiles.push({
          profile,
          ...(projectRoot === undefined ? {} : { projectRoot }),
        });
        return successfulRecordingExecutor([]);
      },
    });

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    expect(selectedProfiles).toEqual([{ profile: "container", projectRoot: directory }]);
  });

  it("rejects a detached supervisor sandbox profile that contradicts its policy digest", async () => {
    const directory = await createTemporaryDirectory();
    const supervisor = { maxActiveWorkers: 1, maxQueuedJobs: 32 };
    const capture = createCapture();

    const exitCode = await main(
      [
        "__supervisor",
        "--runs-dir",
        join(directory, "runs"),
        "--startup-token",
        "startup-token",
        "--startup-owner-token",
        "startup-owner-token",
        "--policy-digest",
        calculateFlowPolicyDigest(supervisor, "native"),
        "--sandbox-profile",
        "container",
        "--max-active-workers",
        String(supervisor.maxActiveWorkers),
        "--max-queued-jobs",
        String(supervisor.maxQueuedJobs),
      ],
      capture.io,
      { cwd: directory },
    );

    expect(exitCode).toBe(2);
    expect(capture.stderr.join("\n")).toMatch(
      /--policy-digest does not match the supplied supervisor limits and sandbox profile/i,
    );
    await expect(stat(join(directory, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("protects project Flow state when execution uses a nested directory", async () => {
    const project = await createTemporaryDirectory();
    const canonicalProject = await realpath(project);
    const workspace = join(project, "workspace");
    const flowDirectory = join(project, ".flow");
    await mkdir(workspace);
    await mkdir(flowDirectory);
    await writeFile(
      join(flowDirectory, "config.yaml"),
      "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
      "utf8",
    );
    const workflowPath = join(workspace, "protected.workflow.yaml");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: protected-project-state }
nodes:
  - id: verify
    type: command
    command: { executable: ${JSON.stringify(process.execPath)}, args: [--version] }
`,
      "utf8",
    );
    let protectedPaths: readonly string[] = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        protectedPaths = context.protectedPaths;
        return { status: "succeeded", evidence: commandEvidence(node.id) };
      },
    };
    const capture = createCapture();

    const exitCode = await main(
      ["run", workflowPath, "--run-id", "protected-state", "--cwd", workspace],
      capture.io,
      { cwd: workspace, executor },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    expect(protectedPaths).toEqual([
      join(canonicalProject, ".flow", "runs"),
      join(canonicalProject, ".flow"),
    ]);
  });

  it("runs an isolated child through the attached production composition", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "child.workflow.yaml");
    const runsDirectory = join(directory, "custom-runs");
    const calls: string[] = [];
    await writeFile(workflowPath, childWorkflow("cli-child"), "utf8");
    const capture = createCapture();

    const exitCode = await main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-child-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      capture.io,
      { cwd: directory, executor: jsonStringRecordingExecutor(calls) },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    const state = JSON.parse(capture.stdout.join("\n"));
    const childRunId = state.nodes.delegate.childRun.runId as string;
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        delegate: {
          evidence: {
            kind: "child",
            childRunId,
            result: { canonicalValue: '"ok"' },
            workspace: { disposition: "discarded" },
          },
        },
      },
    });
    expect(calls).toEqual(["produce"]);
    await expect(new JsonlRunStore(runsDirectory).read(childRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_started", runId: childRunId }),
        expect.objectContaining({ type: "run_succeeded", runId: childRunId }),
      ]),
    );
    await expect(stat(join(runsDirectory, ".workspaces", childRunId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs, child-ledgers, and inspects a durable agent command through the attached CLI", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-child.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, childAgentCommandWorkflow("cli-agent-command"), "utf8");
    const runCapture = createCapture();

    const exitCode = await main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-agent-command-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      runCapture.io,
      { cwd: directory, executor: durableAgentCommandExecutor() },
    );

    expect(exitCode, [...runCapture.stderr, ...runCapture.stdout].join("\n")).toBe(0);
    const parentState = JSON.parse(runCapture.stdout.join("\n"));
    const childRunId = parentState.nodes.delegate.childRun.runId as string;
    const runStore = new JsonlRunStore(runsDirectory);
    const childEvents = await runStore.read(childRunId);
    const childState = reduceRunEvents(childEvents);
    expect(childEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["node_agent_command_prepared", "node_agent_command_settled"]),
    );
    expect(childState.nodes.execute).toMatchObject({
      status: "succeeded",
      commandProtocol: "flow.agent-commands/v1",
      commands: [
        {
          request: {
            executable: process.execPath,
            args: ["-e", 'process.stdout.write("child-command")'],
          },
          settlement: {
            outcome: {
              status: "succeeded",
              evidence: {
                stdout: "child-command",
                sandbox: { profile: "workspace-write-network-deny-v1" },
              },
            },
          },
        },
      ],
    });

    for (const [runId, expected] of [
      ["cli-agent-command-run", parentState],
      [childRunId, childState],
    ] as const) {
      const inspectCapture = createCapture();
      expect(
        await main(["inspect", runId, "--runs-dir", runsDirectory], inspectCapture.io, {
          cwd: directory,
        }),
      ).toBe(0);
      expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(expected);
    }
  });

  it("keeps an attached Pi tool call live until approve submits its exact sidecar", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-approval.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, agentCommandApprovalWorkflow(), "utf8");
    const runCapture = createCapture();
    const running = main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-live-agent-approval",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      runCapture.io,
      { cwd: directory, executor: durableAgentCommandExecutor() },
    );
    const waiting = await waitForRunStatus(
      runsDirectory,
      "cli-live-agent-approval",
      "waiting_for_approval",
    );
    expect(waiting.nodes.execute?.agentCommandApprovals[0]).toMatchObject({
      status: "pending",
      requestId: "agent-approval-3",
    });
    const approveCapture = createCapture();

    expect(
      await main(
        [
          "approve",
          "cli-live-agent-approval",
          "agent-approval-3",
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        approveCapture.io,
        { cwd: directory },
      ),
    ).toBe(0);
    expect(JSON.parse(approveCapture.stdout.join("\n"))).toMatchObject({
      kind: "agent_command_approval_decision_submitted",
      requestId: "agent-approval-3",
      decision: "approve",
    });
    await expect(running).resolves.toBe(0);
    expect(JSON.parse(runCapture.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      nodes: {
        execute: {
          agentCommandApprovals: [
            {
              status: "consumed",
              actor: "operator:test",
              consumedByCommandId: "command-5",
            },
          ],
        },
      },
    });
  });

  it("returns an external live denial to the attached agent without command preparation or spawn", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-denial.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, agentCommandApprovalWorkflow(), "utf8");
    const runCapture = createCapture();
    const running = main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-live-agent-denial",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      runCapture.io,
      { cwd: directory, executor: durableAgentCommandDenialAwareExecutor() },
    );
    const waiting = await waitForRunStatus(
      runsDirectory,
      "cli-live-agent-denial",
      "waiting_for_approval",
    );
    expect(waiting.nodes.execute?.agentCommandApprovals[0]).toMatchObject({
      status: "pending",
      requestId: "agent-approval-3",
    });
    const denyCapture = createCapture();

    expect(
      await main(
        [
          "deny",
          "cli-live-agent-denial",
          "agent-approval-3",
          "--actor",
          "operator:test",
          "--reason",
          "not authorized",
          "--runs-dir",
          runsDirectory,
        ],
        denyCapture.io,
        { cwd: directory },
      ),
    ).toBe(0);
    expect(JSON.parse(denyCapture.stdout.join("\n"))).toMatchObject({
      kind: "agent_command_approval_decision_submitted",
      requestId: "agent-approval-3",
      decision: "deny",
      actor: "operator:test",
    });
    await expect(running).resolves.toBe(0);
    const state = JSON.parse(runCapture.stdout.join("\n"));
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        execute: {
          status: "succeeded",
          evidence: {
            text: JSON.stringify("agent command approval denied by operator:test: not authorized"),
          },
          agentCommandApprovals: [
            {
              status: "denied",
              actor: "operator:test",
              reason: "not authorized",
            },
          ],
        },
      },
    });
    const events = await new JsonlRunStore(runsDirectory).read("cli-live-agent-denial");
    expect(events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["node_agent_command_prepared", "node_agent_command_settled"]),
    );
  });

  it("audits a mismatched real-channel receipt as invalid without preparing a command", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-invalid.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, agentCommandApprovalWorkflow(), "utf8");
    const channel = new LocalAgentCommandApprovalChannel(runsDirectory, 2);
    const runCapture = createCapture();
    const running = main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-agent-invalid-receipt",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      runCapture.io,
      {
        cwd: directory,
        executor: durableAgentCommandDenialAwareExecutor(),
        createAgentCommandApprovalChannel: () => channel,
      },
    );
    const waiting = await waitForRunStatus(
      runsDirectory,
      "cli-agent-invalid-receipt",
      "waiting_for_approval",
    );
    const pending = waiting.nodes.execute?.agentCommandApprovals[0];
    if (pending?.status !== "pending") {
      throw new Error("agent command approval fixture did not become pending");
    }

    await channel.submitDecision({
      version: 1,
      runId: "cli-agent-invalid-receipt",
      requestId: pending.requestId,
      requestDigest: "f".repeat(64),
      operationDigest: pending.operationDigest,
      decision: "approve",
      actor: "operator:forged",
      submittedAt: "2026-08-08T12:00:00.000Z",
    });

    await expect(running).resolves.toBe(1);
    const state = JSON.parse(runCapture.stdout.join("\n"));
    expect(state.nodes.execute).toMatchObject({
      status: "failed",
      commands: [],
      agentCommandApprovals: [
        {
          status: "cancelled",
          cancellationReason: "decision_invalid",
        },
      ],
    });
    const events = await new JsonlRunStore(runsDirectory).read("cli-agent-invalid-receipt");
    expect(events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining(["node_agent_command_prepared", "node_agent_command_settled"]),
    );
  });

  it("keeps a real-channel request open across a transient source outage", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "agent-command-transient.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, agentCommandApprovalWorkflow(), "utf8");
    const realChannel = new LocalAgentCommandApprovalChannel(runsDirectory, 2);
    let waitCalls = 0;
    const transientChannel: AgentCommandApprovalDecisionChannel = {
      submitDecision: (decision) => realChannel.submitDecision(decision),
      async waitForDecision(wait, signal) {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw new AgentCommandApprovalDecisionSourceError(
            "temporarily_unavailable",
            "simulated transient filesystem read failure",
            1,
          );
        }
        return await realChannel.waitForDecision(wait, signal);
      },
    };
    const runCapture = createCapture();
    const running = main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-agent-transient-channel",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      runCapture.io,
      {
        cwd: directory,
        executor: durableAgentCommandExecutor(),
        createAgentCommandApprovalChannel: () => transientChannel,
      },
    );
    await waitForRunStatus(runsDirectory, "cli-agent-transient-channel", "waiting_for_approval");
    const approveCapture = createCapture();

    expect(
      await main(
        [
          "approve",
          "cli-agent-transient-channel",
          "agent-approval-3",
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        approveCapture.io,
        { cwd: directory },
      ),
    ).toBe(0);
    await expect(running).resolves.toBe(0);
    expect(waitCalls).toBeGreaterThanOrEqual(2);
    const state = JSON.parse(runCapture.stdout.join("\n"));
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        execute: {
          agentCommandApprovals: [{ status: "consumed", actor: "operator:test" }],
        },
      },
    });
    const events = await new JsonlRunStore(runsDirectory).read("cli-agent-transient-channel");
    expect(events.map((event) => event.type)).not.toContain("agent_command_approval_cancelled");
  });

  it("promotes and inspects a bounded optimization through the attached production composition", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "optimization.workflow.yaml");
    const runsDirectory = join(directory, "custom-runs");
    await writeFile(workflowPath, optimizationWorkflow("cli-optimization"), "utf8");
    const capture = createCapture();

    const exitCode = await main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-optimization-run",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      capture.io,
      { cwd: directory },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    const state = JSON.parse(capture.stdout.join("\n"));
    const candidateRunId = state.nodes["optimize--c1--candidate"].childRun.runId as string;
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "optimize--c1--check": {
          optimization: {
            decision: "promote",
            settlement: { outcome: "committed" },
            cleanedAt: expect.any(String),
          },
          control: { kind: "optimization-check", outcome: "accepted", bestMetric: 8 },
        },
        optimize: {
          control: { kind: "optimization", bestCandidate: 1, stopReason: "max_candidates" },
        },
      },
    });
    await expect(readFile(join(directory, "optimized.txt"), "utf8")).resolves.toBe("score=8\n");
    await expect(stat(join(runsDirectory, ".workspaces", candidateRunId))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "cli-optimization-run", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );
    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(state);
  });

  it("runs sibling child commands across production SRT workspace sessions", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "sibling-children.workflow.yaml");
    const runsDirectory = join(directory, "custom-runs");
    await writeFile(workflowPath, siblingChildWorkflow(), "utf8");
    const capture = createCapture();

    const exitCode = await main(
      [
        "run",
        workflowPath,
        "--run-id",
        "cli-sibling-children",
        "--runs-dir",
        runsDirectory,
        "--cwd",
        directory,
      ],
      capture.io,
      { cwd: directory },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      nodes: {
        "child-a": {
          status: "succeeded",
          evidence: { kind: "child", result: { canonicalValue: "true" } },
        },
        "child-b": {
          status: "succeeded",
          evidence: { kind: "child", result: { canonicalValue: "true" } },
        },
      },
    });
  });

  it("runs and inspects the same durable typed result through the attached CLI", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "typed-result.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, typedResultWorkflow("cli-typed-result"), "utf8");
    const source = '{ "accepted": true, "score": 1 }';
    const executor: NodeExecutor = {
      async execute(node) {
        return {
          status: "succeeded",
          evidence: {
            ...commandEvidence(node.id),
            stdout: source,
            stdoutHash: createHash("sha256").update(source).digest("hex"),
          },
        };
      },
    };
    const runCapture = createCapture();

    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-typed-result", "--runs-dir", runsDirectory],
        runCapture.io,
        { cwd: directory, executor },
      ),
    ).toBe(0);
    const runState = JSON.parse(runCapture.stdout.join("\n"));
    expect(runState).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 1 },
      nodes: {
        publish: {
          status: "succeeded",
          control: {
            kind: "result",
            sourceNodeId: "produce",
            sourceField: "command.stdout",
            canonicalValue: '{"accepted":true,"score":1}',
          },
        },
      },
    });

    const inspectCapture = createCapture();
    expect(
      await main(["inspect", "cli-typed-result", "--runs-dir", runsDirectory], inspectCapture.io, {
        cwd: directory,
      }),
    ).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(runState);
    const ledger = await readFile(join(runsDirectory, "cli-typed-result", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_result_published",
      "run_succeeded",
    ]);
  });

  it("runs and inspects a typed command verifier through the production path", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "verifier.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-verifier }
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata: { id: typed-verification }
  outcome: The typed verifier accepts the command result.
  criteria:
    - id: verifier-passes
      description: The typed command verifier passes.
      verifier: { nodeId: verify }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command:
        executable: ${JSON.stringify(process.execPath)}
        args: [--version]
`,
      "utf8",
    );
    const runCapture = createCapture();

    const exitCode = await main(
      ["run", workflowPath, "--run-id", "cli-verifier", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory },
    );

    expect(exitCode, [...runCapture.stderr, ...runCapture.stdout].join("\n")).toBe(0);
    const runState = JSON.parse(runCapture.stdout.join("\n"));
    expect(runState).toMatchObject({
      status: "succeeded",
      goal: { status: "accepted", criteria: { "verifier-passes": { status: "accepted" } } },
      nodes: {
        verify: {
          status: "succeeded",
          evidence: {
            kind: "verifier",
            driver: "command",
            result: "completed",
            verdict: "accepted",
            command: { executable: process.execPath, args: ["--version"], exitCode: 0 },
          },
        },
      },
    });

    const inspectCapture = createCapture();
    expect(
      await main(["inspect", "cli-verifier", "--runs-dir", runsDirectory], inspectCapture.io, {
        cwd: directory,
      }),
    ).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(runState);
  });

  it("runs two mutually waiting command branches through one production SRT session", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "concurrent.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const leftMarker = join(directory, "left.started");
    const rightMarker = join(directory, "right.started");
    const waitForSibling = (ownMarker: string, siblingMarker: string) =>
      `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ownMarker)},"");` +
      `const deadline=Date.now()+2000;while(!fs.existsSync(${JSON.stringify(siblingMarker)})&&Date.now()<deadline){}` +
      `if(!fs.existsSync(${JSON.stringify(siblingMarker)}))process.exit(9);`;
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-concurrent-command }
concurrency: { maxNodes: 2 }
nodes:
  - id: root
    type: command
    command: { executable: ${JSON.stringify(process.execPath)}, args: [--version] }
  - id: left
    type: command
    dependsOn: [root]
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(waitForSibling(leftMarker, rightMarker))}]
  - id: right
    type: command
    dependsOn: [root]
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(waitForSibling(rightMarker, leftMarker))}]
  - id: join
    type: command
    dependsOn: [left, right]
    command: { executable: ${JSON.stringify(process.execPath)}, args: [--version] }
`,
      "utf8",
    );
    const capture = createCapture();

    const exitCode = await main(
      ["run", workflowPath, "--run-id", "cli-concurrent", "--runs-dir", runsDirectory],
      capture.io,
      { cwd: directory },
    );

    expect(exitCode, [...capture.stderr, ...capture.stdout].join("\n")).toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      concurrency: { maxNodes: 2 },
      nodes: {
        left: { status: "succeeded" },
        right: { status: "succeeded" },
        join: { status: "succeeded" },
      },
    });
    const ledger = await readFile(join(runsDirectory, "cli-concurrent", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_started",
      "node_succeeded",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("runs and inspects the credential-free bounded loop example", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(process.cwd(), "examples", "bounded-loop.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const statePath = join(directory, "flow-bounded-loop-example.state");
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "cli-bounded-loop", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory },
    );

    expect(runExitCode, [...runCapture.stderr, ...runCapture.stdout].join("\n")).toBe(0);
    const output = JSON.parse(runCapture.stdout.join("\n"));
    expect(output).toMatchObject({
      status: "succeeded",
      nodes: {
        "converge--i1--check": {
          control: { kind: "loop-check", iteration: 1, decision: "continue" },
        },
        "converge--i2--check": {
          control: { kind: "loop-check", iteration: 2, decision: "stop" },
        },
        "converge--i3--node--advance": { status: "omitted" },
        converge: {
          status: "succeeded",
          control: { kind: "loop", completedIterations: 2 },
        },
        verify: { status: "succeeded" },
      },
    });
    await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "cli-bounded-loop", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );
    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(output);

    const ledger = await readFile(join(runsDirectory, "cli-bounded-loop", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_loop_checked",
      "node_started",
      "node_succeeded",
      "node_loop_checked",
      "node_omitted",
      "node_omitted",
      "node_loop_completed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
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

  it("routes a live agent-tool approval through the immutable decision inbox", async () => {
    const directory = await createTemporaryDirectory();
    const runsDirectory = join(directory, "runs");
    const owner = new JsonlRunStore(runsDirectory);
    const request = createAgentCommandApprovalRequest({
      runId: "cli-agent-approval",
      workflowId: "agent-command-approval",
      nodeId: "implement",
      attempt: 1,
      cwd: directory,
      command: normalizeAgentCommandRequest({ executable: "npm", args: ["test"] }),
      grantTtlMs: 300_000,
    });
    const requestDigest = calculateAgentCommandApprovalRequestDigest(request);
    await owner.append({
      version: 1,
      sequence: 1,
      at: "2026-08-08T10:00:01.000Z",
      runId: "cli-agent-approval",
      workflowId: "agent-command-approval",
      type: "run_started",
      nodeIds: ["implement"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
      executionCwd: directory,
      agentCommandApprovalRequirements: [{ nodeId: "implement", grantTtlMs: 300_000 }],
    });
    await owner.append({
      version: 1,
      sequence: 2,
      at: "2026-08-08T10:00:02.000Z",
      runId: "cli-agent-approval",
      workflowId: "agent-command-approval",
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      commandProtocol: "flow.agent-commands/v1",
    });
    await owner.append({
      version: 1,
      sequence: 3,
      at: "2026-08-08T10:00:03.000Z",
      runId: "cli-agent-approval",
      workflowId: "agent-command-approval",
      type: "agent_command_approval_requested",
      nodeId: "implement",
      attempt: 1,
      requestId: "agent-approval-3",
      request,
      requestDigest,
    });
    const capture = createCapture();

    const exitCode = await main(
      [
        "approve",
        "cli-agent-approval",
        "agent-approval-3",
        "--actor",
        "operator:test",
        "--runs-dir",
        runsDirectory,
      ],
      capture.io,
      {
        cwd: directory,
        get executor(): NodeExecutor {
          throw new Error("approval must not initialize the execution plane");
        },
      },
    );

    expect(exitCode, capture.stderr.join("\n")).toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual({
      kind: "agent_command_approval_decision_submitted",
      runId: "cli-agent-approval",
      requestId: "agent-approval-3",
      decision: "approve",
      actor: "operator:test",
    });
    const receipt = JSON.parse(
      await readFile(
        join(
          runsDirectory,
          "cli-agent-approval",
          "agent-command-approvals",
          "agent-approval-3.decision.json",
        ),
        "utf8",
      ),
    );
    expect(receipt).toMatchObject({
      requestDigest,
      operationDigest: request.operationDigest,
      decision: "approve",
      actor: "operator:test",
    });
    expect((await owner.read("cli-agent-approval")).map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "agent_command_approval_requested",
    ]);
    await owner.release("cli-agent-approval");
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

  it("routes approve through a pending approval node and resumes downstream work", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "graph-approval.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(workflowPath, graphApprovalWorkflow("cli-graph-approval"), "utf8");
    const executorCalls: string[] = [];
    const executor = successfulRecordingExecutor(executorCalls);
    const runCapture = createCapture();

    expect(
      await main(
        ["run", workflowPath, "--run-id", "cli-graph-approval", "--runs-dir", runsDirectory],
        runCapture.io,
        { cwd: directory, executor },
      ),
    ).toBe(3);
    expect(executorCalls).toEqual(["plan"]);
    expect(JSON.parse(runCapture.stdout.join("\n"))).toMatchObject({
      status: "waiting_for_approval",
      nodes: {
        review: {
          workflowApproval: {
            status: "pending",
            requestId: "approval-4",
            request: { prompt: "Approve the verified plan." },
          },
        },
      },
    });

    const approveCapture = createCapture();
    expect(
      await main(
        [
          "approve",
          "cli-graph-approval",
          "approval-4",
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
      ),
    ).toBe(0);
    expect(JSON.parse(approveCapture.stdout.join("\n"))).toMatchObject({
      status: "running",
      nodes: {
        review: {
          status: "succeeded",
          workflowApproval: { status: "approved", actor: "operator:test" },
        },
      },
    });

    const resumeCapture = createCapture();
    expect(
      await main(
        ["resume", workflowPath, "--run-id", "cli-graph-approval", "--runs-dir", runsDirectory],
        resumeCapture.io,
        { cwd: directory, executor },
      ),
    ).toBe(0);
    expect(executorCalls).toEqual(["plan", "verify"]);
    const ledger = await readFile(
      join(runsDirectory, "cli-graph-approval", "events.jsonl"),
      "utf8",
    );
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "workflow_approval_requested",
      "workflow_approval_approved",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
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

  it("reports and inspects a resource-exhausted run with a non-zero exit", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "budget.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-budget }
budget:
  maxModelTokens: 2
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: test-provider, id: test-model }
  - id: verify
    type: command
    dependsOn: [analyze]
    command: { executable: npm, args: [test] }
`,
      "utf8",
    );
    const calls: string[] = [];
    const executor: NodeExecutor = {
      async execute(node) {
        calls.push(node.id);
        return node.type === "agent"
          ? {
              status: "succeeded",
              evidence: {
                kind: "agent",
                provider: "test-provider",
                model: "test-model",
                text: "analysis",
                textHash: createHash("sha256").update("analysis").digest("hex"),
                textTruncated: false,
                durationMs: 1,
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costUsdMicros: 3,
                },
                policyDecisions: [],
                effectReceipts: [],
              },
            }
          : { status: "succeeded", evidence: commandEvidence(node.id) };
      },
    };
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "cli-budget", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory, executor },
    );

    expect(runExitCode).toBe(1);
    expect(calls).toEqual(["analyze"]);
    const runState = JSON.parse(runCapture.stdout.join("\n"));
    expect(runState).toMatchObject({
      status: "resource_exhausted",
      resources: {
        nodeStarts: 1,
        modelTokens: 2,
        modelCostUsdMicros: 3,
        executionMs: 1,
      },
      budget: {
        limits: { maxModelTokens: 2 },
        remaining: { modelTokens: 0 },
        exhausted: [{ dimension: "modelTokens", limit: 2, consumed: 2 }],
      },
    });

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "cli-budget", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );
    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(runState);
    const ledger = await readFile(join(runsDirectory, "cli-budget", "events.jsonl"), "utf8");
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_budget_exhausted",
    ]);
  });

  it("reports and inspects exact UTF-8 artifact exhaustion", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "artifact-budget.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-artifact-budget }
budget: { maxArtifactBytes: 2 }
nodes:
  - id: produce
    type: command
    command: { executable: node, args: [produce] }
`,
      "utf8",
    );
    const executor: NodeExecutor = {
      async execute(node) {
        return { status: "succeeded", evidence: commandEvidence(node.id, "é") };
      },
    };
    const runCapture = createCapture();

    const runExitCode = await main(
      ["run", workflowPath, "--run-id", "cli-artifact-budget", "--runs-dir", runsDirectory],
      runCapture.io,
      { cwd: directory, executor },
    );

    expect(runExitCode).toBe(1);
    const runState = JSON.parse(runCapture.stdout.join("\n"));
    expect(runState).toMatchObject({
      status: "resource_exhausted",
      resources: { nodeStarts: 1, executionMs: 1, artifactBytes: 2 },
      budget: {
        limits: { maxArtifactBytes: 2 },
        remaining: { artifactBytes: 0 },
        exhausted: [{ dimension: "artifactBytes", limit: 2, consumed: 2 }],
      },
    });

    const inspectCapture = createCapture();
    expect(
      await main(
        ["inspect", "cli-artifact-budget", "--runs-dir", runsDirectory],
        inspectCapture.io,
        { cwd: directory },
      ),
    ).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toEqual(runState);
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

  it("resumes an opted-in read-only agent as a fresh numbered attempt", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "retry.workflow.yaml");
    const runsDirectory = join(directory, "runs");
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-proof-safe-retry }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Analyze the repository.
      model: { provider: test, id: deterministic }
      tools: [read]
      recovery: { mode: fresh, maxAttempts: 2 }
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
    await writeFile(workflowPath, source, "utf8");
    const workflow = compileWorkflowText(source, workflowPath);
    const store = new JsonlRunStore(runsDirectory);
    await store.append({
      ...runStartedEvent(workflow, "cli-proof-safe-retry"),
      executionCwd: directory,
      recoveryRequirements: [
        {
          nodeId: "implement",
          mode: "fresh",
          maxAttempts: 2,
          effectProtocol: "none",
        },
      ],
    });
    await store.append({
      ...eventBase("cli-proof-safe-retry", workflow.id, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
    });
    await store.release("cli-proof-safe-retry");
    const calls: Array<{ nodeId: string; attempt: number }> = [];
    const executor: NodeExecutor = {
      async execute(node, context) {
        calls.push({ nodeId: node.id, attempt: context.attempt });
        return node.type === "agent"
          ? {
              status: "succeeded",
              evidence: {
                kind: "agent",
                provider: "test",
                model: "deterministic",
                text: "analysis",
                textHash: createHash("sha256").update("analysis").digest("hex"),
                textTruncated: false,
                durationMs: 1,
                policyDecisions: [],
                effectReceipts: [],
              },
            }
          : { status: "succeeded", evidence: commandEvidence(node.id) };
      },
    };
    const capture = createCapture();

    const exitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-proof-safe-retry", "--runs-dir", runsDirectory],
      capture.io,
      { cwd: directory, executor },
    );

    expect(exitCode, capture.stderr.join("\n")).toBe(0);
    expect(calls).toEqual([
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    expect(JSON.parse(capture.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      nodes: {
        implement: {
          attempt: 2,
          interruptedAttempts: [{ attempt: 1, disposition: "fresh_retry" }],
        },
      },
    });
    const ledger = await readFile(
      join(runsDirectory, "cli-proof-safe-retry", "events.jsonl"),
      "utf8",
    );
    expect(ledgerTypes(ledger)).toEqual([
      "run_started",
      "node_started",
      "node_attempt_interrupted",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
  });

  it("reconciles an open durable edit and still refuses the unfinished node", async () => {
    const directory = await createTemporaryDirectory();
    const workflowPath = join(directory, "uncertain-edit.workflow.yaml");
    const target = join(directory, "source.ts");
    const runsDirectory = join(directory, "runs");
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: uncertain-edit }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Update the source.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
    await writeFile(workflowPath, source, "utf8");
    await writeFile(target, "export const value = 2;\n", "utf8");
    const workflow = compileWorkflowText(source, workflowPath);
    const store = new JsonlRunStore(runsDirectory);
    await store.append(runStartedEvent(workflow, "cli-uncertain-edit"));
    await store.append({
      ...eventBase("cli-uncertain-edit", workflow.id, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    });
    await store.append({
      ...eventBase("cli-uncertain-edit", workflow.id, 3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target,
        operationDigest: "b".repeat(64),
        beforeSha256: createHash("sha256").update("export const value = 1;\n").digest("hex"),
        afterSha256: createHash("sha256").update("export const value = 2;\n").digest("hex"),
        mode: 0o644,
      },
    });
    await store.release("cli-uncertain-edit");
    const ledgerPath = join(runsDirectory, "cli-uncertain-edit", "events.jsonl");
    const before = await readFile(ledgerPath, "utf8");

    const inspectCapture = createCapture();
    const inspectExitCode = await main(
      ["inspect", "cli-uncertain-edit", "--runs-dir", runsDirectory],
      inspectCapture.io,
      { cwd: directory },
    );

    expect(inspectExitCode).toBe(0);
    expect(JSON.parse(inspectCapture.stdout.join("\n"))).toMatchObject({
      status: "running",
      nodes: {
        implement: {
          status: "running",
          effectProtocol: "flow.effects/v1",
          effects: [
            {
              effectId: "effect-3",
              effectSequence: 1,
              descriptor: { target },
              settlement: null,
              reconciliation: null,
            },
          ],
        },
      },
    });

    let executorCalls = 0;
    const resumeCapture = createCapture();
    const resumeExitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-uncertain-edit", "--runs-dir", runsDirectory],
      resumeCapture.io,
      {
        cwd: directory,
        executor: {
          async execute() {
            executorCalls += 1;
            throw new Error("open edit attempt must not execute");
          },
        },
      },
    );

    expect(resumeExitCode).toBe(1);
    expect(resumeCapture.stderr.join("\n")).toContain("uncertain_operation");
    expect(executorCalls).toBe(0);
    expect(await readFile(target, "utf8")).toBe("export const value = 2;\n");
    const after = await readFile(ledgerPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(JSON.parse(after.trim().split("\n").at(-1) ?? "{}")).toMatchObject({
      sequence: 4,
      type: "node_effect_reconciled",
      nodeId: "implement",
      effectId: "effect-3",
      outcome: "applied",
      reason: "target_matches_after",
    });

    const repeatedCapture = createCapture();
    const repeatedExitCode = await main(
      ["resume", workflowPath, "--run-id", "cli-uncertain-edit", "--runs-dir", runsDirectory],
      repeatedCapture.io,
      {
        cwd: directory,
        executor: {
          async execute() {
            executorCalls += 1;
            throw new Error("repeated recovery must not execute");
          },
        },
      },
    );
    expect(repeatedExitCode).toBe(1);
    expect(repeatedCapture.stderr.join("\n")).toContain("uncertain_operation");
    expect(executorCalls).toBe(0);
    await expect(readFile(ledgerPath, "utf8")).resolves.toBe(after);
  });

  it("persists cancellation and terminates the command group", async () => {
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
      status: "cancelled",
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
): RunStartedEvent {
  return {
    ...eventBase(runId, workflow.id, 1),
    type: "run_started",
    nodeIds: workflow.nodes.map((node) => node.id),
    workflowApiVersion: workflow.apiVersion,
    workflowDigest: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
    ...(workflow.budget === undefined ? {} : { budget: workflow.budget }),
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

function commandEvidence(nodeId = "completed", stdout = "") {
  return {
    kind: "command" as const,
    executable: process.execPath,
    args: ["-e", nodeId],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: createHash("sha256").update(stdout).digest("hex"),
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

function graphApprovalWorkflow(id: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
nodes:
  - id: plan
    type: command
    command: { executable: node, args: [plan] }
  - id: review
    type: approval
    dependsOn: [plan]
    approval:
      prompt: Approve the verified plan.
      evidence:
        - { nodeId: plan, field: command.stdout }
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [verify] }
`;
}

function typedResultWorkflow(id: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema:
        type: object
        properties:
          accepted: { type: boolean }
          score: { type: integer, minimum: 0, maximum: 10 }
        required: [accepted, score]
`;
}

function childWorkflow(id: string): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id}-inner }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: string, maxLength: 1024 }
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;
}

function childAgentCommandWorkflow(id: string): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id}-inner }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: execute
    type: agent
    agent:
      prompt: Run the bounded command.
      model: { provider: test, id: deterministic }
      tools: [exec]
  - id: publish
    type: result
    dependsOn: [execute]
    result:
      source: { nodeId: execute, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;
}

function agentCommandApprovalWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-live-agent-approval }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: execute
    type: agent
    agent:
      prompt: Run the bounded command.
      model: { provider: test, id: deterministic }
      tools: [exec]
      toolApproval:
        exec: { mode: required, grantTtlMs: 300000 }
  - id: publish
    type: result
    dependsOn: [execute]
    result:
      source: { nodeId: execute, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function durableAgentCommandExecutor(): NodeExecutor {
  const commandExecutor = new CommandNodeExecutor({ sandbox: directAgentCommandSandbox });
  const agentExecutor = new PiAgentExecutor({
    async run(input) {
      if (input.commandRecorder === undefined) {
        throw new Error("agent command recorder was not injected");
      }
      const request = normalizeAgentCommandRequest({
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("child-command")'],
        timeoutMs: 5_000,
      });
      const decision = input.policyBroker.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest: calculateAgentCommandDigest(request),
      });
      const outcome = await input.commandRecorder.execute(request, decision, input.signal);
      return {
        text: JSON.stringify(outcome.evidence?.stdout ?? "command failed"),
        stopReason: "stop" as const,
      };
    },
  });
  return new NodeExecutorRouter(commandExecutor, agentExecutor);
}

function durableAgentCommandDenialAwareExecutor(): NodeExecutor {
  const commandExecutor = new CommandNodeExecutor({
    sandbox: {
      async prepare() {
        throw new Error("denied command must not reach sandbox preparation");
      },
    },
  });
  const agentExecutor = new PiAgentExecutor({
    async run(input) {
      if (input.commandRecorder === undefined) {
        throw new Error("agent command recorder was not injected");
      }
      const request = normalizeAgentCommandRequest({
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("denied-command")'],
        timeoutMs: 5_000,
      });
      const decision = input.policyBroker.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest: calculateAgentCommandDigest(request),
      });
      try {
        await input.commandRecorder.execute(request, decision, input.signal);
        throw new Error("denied command unexpectedly executed");
      } catch (error) {
        if (!(error instanceof AgentCommandApprovalDeniedError)) {
          throw error;
        }
        return { text: JSON.stringify(error.message), stopReason: "stop" as const };
      }
    },
  });
  return new NodeExecutorRouter(commandExecutor, agentExecutor);
}

const directAgentCommandSandbox: CommandSandbox = {
  async prepare(request) {
    return {
      processContainment: "linux-pid-namespace",
      launch: {
        executable: request.executable,
        args: request.args,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
      evidence: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "d".repeat(64),
      },
      release: async () => undefined,
    };
  },
};

function optimizationWorkflow(id: string): string {
  const improveScript = `
const fs = require("node:fs");
const value = { score: 8, "tests-passed": true };
fs.writeFileSync("optimized.txt", "score=8\\n");
process.stdout.write(JSON.stringify(value));
`.trim();
  const candidate = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id}-candidate }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: improve
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(improveScript)}]
  - id: publish
    type: result
    dependsOn: [improve]
    result:
      source: { nodeId: improve, field: command.stdout }
      schema:
        type: object
        properties:
          score: { type: number }
          tests-passed: { type: boolean }
        required: [score, tests-passed]
`.trim();
  const baselineScript = `
const fs = require("node:fs");
const value = { score: 10, "tests-passed": true };
fs.writeFileSync("optimized.txt", "score=10\\n");
process.stdout.write(JSON.stringify(value));
`.trim();
  const verifyScript = `
const fs = require("node:fs");
if (fs.readFileSync("optimized.txt", "utf8") !== "score=8\\n") process.exit(1);
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: measure
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(baselineScript)}]
  - id: baseline
    type: result
    dependsOn: [measure]
    result:
      source: { nodeId: measure, field: command.stdout }
      schema:
        type: object
        properties:
          score: { type: number }
          tests-passed: { type: boolean }
        required: [score, tests-passed]
  - id: optimize
    type: optimization
    dependsOn: [baseline]
    optimization:
      baseline: { nodeId: baseline, field: result.value }
      metric: { pointer: /score, direction: minimize }
      invariants: [{ pointer: /tests-passed, equals: true }]
      maxCandidates: 1
      stagnation: { maxConsecutiveNonImproving: 1 }
      rollback: previous-best
      candidate:
        resultNodeId: publish
        workflow: |
${candidate
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
  - id: finish
    type: command
    dependsOn: [optimize]
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify(verifyScript)}]
`;
}

function siblingChildWorkflow(): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-sibling-inner }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: produce
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify("process.stdout.write('true')")}]
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`.trim();
  const childNode = (id: string) => `  - id: ${id}
    type: child
    dependsOn: [bootstrap]
    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}`;
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: cli-sibling-children }
budget:
  maxNodeStarts: 32
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
concurrency: { maxNodes: 2 }
nodes:
  - id: bootstrap
    type: command
    command: { executable: ${JSON.stringify(process.execPath)}, args: [--version] }
${childNode("child-a")}
${childNode("child-b")}
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

function jsonStringRecordingExecutor(calls: string[]): NodeExecutor {
  return {
    async execute(node) {
      calls.push(node.id);
      const stdout = '"ok"';
      return {
        status: "succeeded",
        evidence: {
          ...commandEvidence(node.id),
          stdout,
          stdoutHash: createHash("sha256").update(stdout).digest("hex"),
        },
      };
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

async function waitForRunStatus(
  runsDirectory: string,
  runId: string,
  status: RunStatus,
  timeoutMs = 5_000,
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;
  const store = new JsonlRunStore(runsDirectory);
  while (Date.now() < deadline) {
    try {
      const state = reduceRunEvents(await store.read(runId));
      if (state.status === status) {
        return state;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "not_found")) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for run "${runId}" to reach "${status}"`);
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
