import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { trySubmitAgentCommandApprovalDecision } from "../../../src/application/command-approval.js";
import type { CommandSandbox } from "../../../src/application/command-sandbox.js";
import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { compileWorkflowFromSnapshot } from "../../../src/application/workflow-package-admission.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutor,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import {
  calculateAgentCommandDigest,
  normalizeAgentCommandRequest,
} from "../../../src/domain/agent-command.js";
import {
  createAgentCapabilityEvidence,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import type { VerifierPackageSnapshotInput } from "../../../src/domain/capability/verifier-packages.js";
import type { WorkflowPackageSnapshotInput } from "../../../src/domain/capability/workflow-packages.js";
import { reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore, RunStoreError } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalAgentCommandApprovalChannel } from "../../../src/infrastructure/fs/local-agent-command-approval-channel.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { PiAgentExecutor } from "../../../src/infrastructure/pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../../../src/infrastructure/process/command-node-executor.js";
import { createProductionNodeEffectReconciler } from "../../../src/infrastructure/runtime/production-effect-reconciler.js";
import { createActiveRunClaim, createJobRecord } from "../../../src/supervisor/records.js";
import { executeWorkerJob, requestWorker } from "../../../src/supervisor/worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("detached run worker", () => {
  it("executes a packaged root entirely from the frozen detached snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-workflow-package-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const source = workflowSource().trim();
    const capabilitySnapshot = createCapabilitySnapshot(
      [],
      [],
      [],
      [workflowPackageInput("worker-root", source)],
    );
    const rootPackage = capabilitySnapshot.packages[0];
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-workflow-package",
      mode: "run",
      sourceName: "workflow:worker-root@1.0.0",
      workflowSource: source,
      cwd: directory,
      token: "7".repeat(64),
      createdAt: "2026-08-08T12:10:00.000Z",
      capabilitySnapshot,
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
        async execute(node) {
          return { status: "succeeded", evidence: successfulCommandEvidence(node.id) };
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4329,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });

    await expect(worker).resolves.toBe(0);
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: capabilitySnapshot.digest },
      workflowPackageRequirements: [
        {
          name: "worker-root",
          version: "1.0.0",
          digest: rootPackage?.digest,
        },
      ],
    });
    expect(reduceRunEvents(events).status).toBe("succeeded");
  });

  it("resumes a packaged root worker from durable snapshot bytes after live source disappears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-workflow-resume-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    await supervisorStore.initialize();
    const source = workflowSource().trim();
    const capabilitySnapshot = createCapabilitySnapshot(
      [],
      [],
      [],
      [workflowPackageInput("resume-root", source)],
    );
    const compiled = compileWorkflowFromSnapshot({
      source,
      sourceName: "workflow:resume-root@1.0.0",
      capabilitySnapshot,
    });
    const durableStore = new JsonlRunStore(runsDirectory);
    let crashBeforeNodeStart = true;
    const crashStore: RecoverableRunEventStore = {
      async append(event) {
        if (event.type === "node_started" && crashBeforeNodeStart) {
          crashBeforeNodeStart = false;
          throw new Error("simulated crash before packaged node start");
        }
        await durableStore.append(event);
      },
      async read(runId) {
        return await durableStore.read(runId);
      },
      async claim(runId) {
        return await durableStore.claim(runId);
      },
      async release(runId) {
        await durableStore.release(runId);
      },
    };
    await expect(
      runWorkflow(compiled, {
        runId: "worker-workflow-resume",
        cwd: directory,
        protectedPaths: [runsDirectory],
        store: crashStore,
        executor: {
          async execute() {
            throw new Error("executor must not run before the simulated crash");
          },
        },
        capabilitySnapshot,
      }),
    ).rejects.toThrow(/simulated crash/i);

    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-workflow-resume",
      mode: "resume",
      sourceName: "workflow:resume-root@1.0.0",
      workflowSource: source,
      cwd: directory,
      token: "6".repeat(64),
      createdAt: "2026-08-08T12:11:00.000Z",
      capabilitySnapshot,
    });
    await supervisorStore.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const worker = executeWorkerJob(job.jobId, {
      store: supervisorStore,
      executor: {
        async execute(node) {
          return { status: "succeeded", evidence: successfulCommandEvidence(node.id) };
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4330,
    });
    const descriptor = await waitForDescriptor(supervisorStore, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });

    await expect(worker).resolves.toBe(0);
    const events = await durableStore.read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "run_resumed",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(reduceRunEvents(events)).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: { digest: capabilitySnapshot.digest },
      workflowPackageRequirements: [
        { name: "resume-root", version: "1.0.0", digest: capabilitySnapshot.packages[0]?.digest },
      ],
    });
  });

  it("persists and replays a durable agent command through a detached worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-agent-command-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-agent-command",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: detachedAgentCommandWorkflowSource(),
      cwd: directory,
      token: "9".repeat(64),
      createdAt: "2026-08-08T12:45:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: detachedAgentCommandExecutor(),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4399,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId },
    });
    await expect(worker).resolves.toBe(0);

    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["node_agent_command_prepared", "node_agent_command_settled"]),
    );
    expect(reduceRunEvents(events).nodes.execute).toMatchObject({
      status: "succeeded",
      commandProtocol: "flow.agent-commands/v1",
      commands: [
        {
          settlement: {
            outcome: {
              status: "succeeded",
              evidence: {
                stdout: "detached-command",
                sandbox: { profile: "workspace-write-network-deny-v1" },
              },
            },
          },
        },
      ],
    });
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
  });

  it("keeps a detached agent tool live until its exact sidecar decision is committed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-agent-approval-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-agent-approval",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: detachedAgentCommandWorkflowSource(true),
      cwd: directory,
      token: "8".repeat(64),
      createdAt: "2026-08-08T12:46:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: detachedAgentCommandExecutor(),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4400,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await requestWorker(descriptor, { type: "identify" });
    const pending = await waitForPendingAgentApproval(runsDirectory, job.runId);

    expect(pending.status).toBe("waiting_for_approval");
    await expect(
      trySubmitAgentCommandApprovalDecision({
        runId: job.runId,
        requestId: "agent-approval-3",
        actor: "operator:test",
        decision: "approve",
        store: new JsonlRunStore(runsDirectory),
        sink: new LocalAgentCommandApprovalChannel(runsDirectory, 2),
      }),
    ).resolves.toMatchObject({
      kind: "agent_command_approval_decision_submitted",
      requestId: "agent-approval-3",
    });
    await expect(worker).resolves.toBe(0);

    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent_command_approval_requested",
        "agent_command_approval_granted",
        "node_agent_command_prepared",
        "node_agent_command_settled",
      ]),
    );
    expect(reduceRunEvents(events).nodes.execute).toMatchObject({
      status: "succeeded",
      agentCommandApprovals: [
        {
          status: "consumed",
          actor: "operator:test",
          consumedByCommandId: "command-5",
        },
      ],
    });
  });

  it("enforces and replays an exact detached artifact budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-artifact-budget-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-artifact-budget",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: detached-artifact-budget }
budget: { maxArtifactBytes: 2 }
nodes:
  - id: produce
    type: command
    command: { executable: node, args: [produce] }
`,
      cwd: directory,
      token: "8".repeat(64),
      createdAt: "2026-08-08T11:45:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const executor: NodeExecutor = {
      async execute(node) {
        const stdout = "é";
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.type === "command" ? node.command.executable : "node",
            args: node.type === "command" ? node.command.args : [],
            exitCode: 0,
            signal: null,
            stdout,
            stderr: "",
            stdoutHash: sha256(stdout),
            stderrHash: sha256(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4325,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId },
    });
    await expect(worker).resolves.toBe(1);

    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_budget_exhausted",
    ]);
    expect(reduceRunEvents(events)).toMatchObject({
      status: "resource_exhausted",
      resources: { artifactBytes: 2 },
      budget: {
        limits: { maxArtifactBytes: 2 },
        remaining: { artifactBytes: 0 },
        exhausted: [{ dimension: "artifactBytes", limit: 2, consumed: 2 }],
      },
    });
  });

  it("publishes and replays a typed result through a detached worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-result-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-result",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: typedResultWorkflowSource(),
      cwd: directory,
      token: "e".repeat(64),
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const source = '{ "accepted": true, "score": 1 }';
    const commandExecutor: CommandExecutor = {
      async execute(node) {
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.command.executable,
            args: node.command.args,
            exitCode: 0,
            signal: null,
            stdout: source,
            stderr: "",
            stdoutHash: sha256(source),
            stderrHash: sha256(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };
    const agentExecutor: AgentExecutor = {
      async execute() {
        throw new Error("detached typed result unexpectedly invoked a model");
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: new NodeExecutorRouter(commandExecutor, agentExecutor),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4326,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "node_result_published",
      "run_succeeded",
    ]);
    expect(events[3]).toMatchObject({
      type: "node_result_published",
      sourceNodeId: "produce",
      sourceField: "command.stdout",
      canonicalValue: '{"accepted":true,"score":1}',
      valueHash: sha256('{"accepted":true,"score":1}'),
    });
    expect(reduceRunEvents(events)).toMatchObject({
      status: "succeeded",
      resources: { nodeStarts: 1 },
      nodes: {
        publish: {
          status: "succeeded",
          control: { kind: "result", canonicalValue: '{"accepted":true,"score":1}' },
        },
      },
    });
  });

  it("uses the frozen detached job capability snapshot after live package source drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-skills-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const originalContent = Buffer.from("ORIGINAL DETACHED INSTRUCTIONS\n");
    const capabilitySnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review code when selected.",
        metadata: { version: "1" },
        requestedTools: ["Read"],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [{ path: "SKILL.md", content: originalContent }],
      },
    ]);
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-skills",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: skilledWorkflowSource(),
      cwd: directory,
      token: "9".repeat(64),
      createdAt: "2026-08-08T12:15:00.000Z",
      capabilitySnapshot,
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const livePackage = join(directory, ".flow", "skills", "review");
    await mkdir(livePackage, { recursive: true });
    await writeFile(join(livePackage, "SKILL.md"), "CHANGED LIVE INSTRUCTIONS\n", "utf8");
    let observedContent: string | undefined;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
          throw new Error(`unexpected detached capability node "${node.type}"`);
        }
        const selectedPackage = context.capabilitySnapshot.packages[0];
        const frozenFile =
          selectedPackage?.kind === "agent-skill" ? selectedPackage.files[0] : undefined;
        if (frozenFile === undefined) {
          throw new Error("detached capability snapshot has no file");
        }
        observedContent = Buffer.from(frozenFile.contentBase64, "base64").toString("utf8");
        const text = JSON.stringify("reviewed");
        return {
          status: "succeeded",
          evidence: {
            kind: "agent",
            provider: "test",
            model: "deterministic",
            text,
            textHash: sha256(text),
            textTruncated: false,
            durationMs: 1,
            policyDecisions: [],
            effectReceipts: [],
            capabilities: createAgentCapabilityEvidence(
              context.capabilitySnapshot,
              node.agent.skills,
            ),
          },
        };
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4328,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    expect(observedContent).toBe(originalContent.toString("utf8"));
    expect(observedContent).not.toContain("CHANGED LIVE");
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: capabilitySnapshot.digest },
    });
    expect(reduceRunEvents(events).status).toBe("succeeded");
  });

  it("uses the frozen detached verifier package after its live manifest drifts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-verifier-package-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const capabilitySnapshot = createCapabilitySnapshot(
      [],
      [
        verifierPackageInput("release-tests", "1.0.0", {
          kind: "command",
          command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
        }),
      ],
    );
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-verifier-package",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: packagedVerifierWorkflowSource(),
      cwd: directory,
      token: "8".repeat(64),
      createdAt: "2026-08-08T12:20:00.000Z",
      capabilitySnapshot,
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const livePackage = join(directory, ".flow", "verifiers", "release-tests");
    await mkdir(livePackage, { recursive: true });
    await writeFile(
      join(livePackage, "VERIFIER.yaml"),
      `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: release-tests, version: 1.0.0, description: Drifted. }
spec:
  kind: command
  command: { executable: node, args: [--help], timeoutMs: 30000 }
`,
      "utf8",
    );
    let observedArgs: readonly string[] | undefined;
    const command: CommandExecutor = {
      async execute(node, context) {
        observedArgs = node.command.args;
        expect(context.verifierPackage).toEqual({
          name: "release-tests",
          version: "1.0.0",
          digest: capabilitySnapshot.packages[0]?.digest,
        });
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.command.executable,
            args: node.command.args,
            exitCode: 0,
            signal: null,
            stdout: "v22.0.0",
            stderr: "",
            stdoutHash: sha256("v22.0.0"),
            stderrHash: sha256(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: new NodeExecutorRouter(command, {
        async execute() {
          throw new Error("detached command verifier unexpectedly invoked a model");
        },
      }),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4329,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    expect(observedArgs).toEqual(["--version"]);
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: capabilitySnapshot.digest },
      verifierPackageRequirements: [
        { nodeId: "verify", name: "release-tests", version: "1.0.0", kind: "command" },
      ],
    });
    expect(events[2]).toMatchObject({
      type: "node_succeeded",
      evidence: {
        kind: "verifier",
        package: {
          name: "release-tests",
          version: "1.0.0",
          digest: capabilitySnapshot.packages[0]?.digest,
        },
      },
    });
  });

  it("uses the frozen detached tool package after its live manifest drifts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-tool-package-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const capabilitySnapshot = createCapabilitySnapshot(
      [],
      [],
      [toolPackageInput("project-report", "1.2.3", "/usr/bin/printf")],
    );
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-tool-package",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: toolPackageWorkflowSource(),
      cwd: directory,
      token: "7".repeat(64),
      createdAt: "2026-08-08T12:25:00.000Z",
      capabilitySnapshot,
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const livePackage = join(directory, ".flow", "tools", "project-report");
    await mkdir(livePackage, { recursive: true });
    await writeFile(
      join(livePackage, "TOOL.yaml"),
      toolPackageManifest("project-report", "1.2.3", "false"),
      "utf8",
    );
    let observedExecutable: string | undefined;
    const executor: NodeExecutor = {
      async execute(node, context) {
        if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
          throw new Error(`unexpected detached tool package node "${node.type}"`);
        }
        const selected = context.capabilitySnapshot.packages.find(
          (item) => item.kind === "tool-package",
        );
        if (selected === undefined) {
          throw new Error("detached capability snapshot has no tool package");
        }
        observedExecutable = selected.definition.driver.executable;
        const text = JSON.stringify("inspected");
        return {
          status: "succeeded",
          evidence: {
            kind: "agent",
            provider: "test",
            model: "deterministic",
            text,
            textHash: sha256(text),
            textTruncated: false,
            durationMs: 1,
            policyDecisions: [],
            effectReceipts: [],
          },
        };
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4330,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    expect(observedExecutable).toBe("/usr/bin/printf");
    expect(observedExecutable).not.toBe("false");
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events[0]).toMatchObject({
      type: "run_started",
      capabilitySnapshot: { digest: capabilitySnapshot.digest },
      toolPackageRequirements: [
        {
          nodeId: "inspect",
          packages: [{ name: "project-report", version: "1.2.3" }],
        },
      ],
    });
    expect(reduceRunEvents(events).status).toBe("succeeded");
  });

  it("runs a separately-ledgered isolated child through a detached worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-child-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-child",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: childWorkflowSource(),
      cwd: directory,
      token: "a".repeat(64),
      createdAt: "2026-08-08T12:30:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const executor: NodeExecutor = {
      async execute(node) {
        if (node.type !== "command") {
          throw new Error(`unexpected worker child node "${node.type}"`);
        }
        const stdout = '"ok"';
        return {
          status: "succeeded",
          evidence: {
            ...successfulCommandEvidence(node.id),
            stdout,
            stdoutHash: sha256(stdout),
          },
        };
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4327,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    const runStore = new JsonlRunStore(runsDirectory);
    const parentState = reduceRunEvents(await runStore.read(job.runId));
    const childRunId = parentState.nodes.delegate?.childRun?.runId;
    expect(childRunId).toMatch(/^child-[a-f0-9]{48}$/);
    if (childRunId === undefined) {
      throw new Error("detached parent did not persist its child run link");
    }
    expect(parentState).toMatchObject({
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
    expect(reduceRunEvents(await runStore.read(childRunId)).status).toBe("succeeded");
    await expect(stat(join(runsDirectory, ".workspaces", childRunId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
  });

  it("promotes a bounded optimization through the detached production composition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-optimization-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-optimization",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: optimizationWorkflowSource(),
      cwd: directory,
      token: "b".repeat(64),
      createdAt: "2026-08-08T12:45:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: optimizationExecutor(),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4328,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    const runStore = new JsonlRunStore(runsDirectory);
    const state = reduceRunEvents(await runStore.read(job.runId));
    const candidateRunId = state.nodes["optimize--c1--candidate"]?.childRun?.runId;
    expect(candidateRunId).toMatch(/^child-[a-f0-9]{48}$/);
    if (candidateRunId === undefined) {
      throw new Error("detached optimization did not persist its candidate child link");
    }
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
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
  });

  it("persists typed verifier evidence through a detached worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-verifier-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-verifier",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: verifierWorkflowSource(),
      cwd: directory,
      token: "f".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const commandExecutor: CommandExecutor = {
      async execute(node) {
        const stdout = "verified";
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.command.executable,
            args: node.command.args,
            exitCode: 0,
            signal: null,
            stdout,
            stderr: "",
            stdoutHash: sha256(stdout),
            stderrHash: sha256(""),
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            durationMs: 1,
          },
        };
      },
    };
    const agentExecutor: AgentExecutor = {
      async execute() {
        throw new Error("detached command verifier unexpectedly invoked a model");
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: new NodeExecutorRouter(commandExecutor, agentExecutor),
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4325,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { runId: job.runId, status: "running" },
    });
    await expect(worker).resolves.toBe(0);

    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(events[2]).toMatchObject({
      type: "node_succeeded",
      evidence: {
        kind: "verifier",
        driver: "command",
        verdict: "accepted",
        command: { stdout: "verified" },
      },
    });
  });

  it("authenticates control, preserves cancellation evidence, and releases its claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-run",
      mode: "run",
      sourceName: "/workspace/workflow.yaml",
      workflowSource: workflowSource(),
      cwd: directory,
      token: "a".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    let markExecutionStarted: (() => void) | undefined;
    let executionHasStarted = false;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const executor: NodeExecutor = {
      async execute(node, context) {
        executionHasStarted = true;
        markExecutionStarted?.();
        return await new Promise((resolve) => {
          context.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                status: "failed",
                error: {
                  code: "command_aborted",
                  message: "command was cancelled",
                  retryable: false,
                  sideEffectStatus: "uncertain",
                },
                evidence: {
                  kind: "command",
                  executable: node.type === "command" ? node.command.executable : "unexpected",
                  args: [],
                  exitCode: null,
                  signal: "SIGTERM",
                  stdout: "partial output",
                  stderr: "",
                  stdoutHash: createHash("sha256").update("partial output").digest("hex"),
                  stderrHash: createHash("sha256").update("").digest("hex"),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  timedOut: false,
                  durationMs: 10,
                },
              }),
            { once: true },
          );
        });
      },
    };

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor,
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4321,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    expect(executionHasStarted).toBe(false);

    const identity = await requestWorker(descriptor, { type: "identify" });
    expect(identity).toMatchObject({
      ok: true,
      result: {
        type: "identity",
        workerId: job.workerId,
        runId: job.runId,
        pid: 4321,
        jobDigest: job.digest,
        status: "running",
      },
    });
    await executionStarted;

    await expect(
      requestWorker({ ...descriptor, token: "b".repeat(64) }, { type: "identify" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });

    const commandId = randomUUID();
    const cancellation = await requestWorker(descriptor, {
      type: "cancel",
      commandId,
      actor: "operator:test",
      reason: "Stop the test run.",
    });
    const workerExitCode = await worker;
    expect(cancellation, JSON.stringify(cancellation)).toMatchObject({
      ok: true,
      result: {
        type: "cancelled",
        commandId,
        runId: job.runId,
        runStatus: "cancelled",
      },
    });

    expect(workerExitCode).toBe(1);
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_failed",
      "run_cancelled",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "run_cancelled",
      actor: "operator:test",
      requestId: commandId,
      cancelledNodeId: "execute",
    });
    await expect(store.readActiveRunClaim(job.runId)).resolves.toBeNull();
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "cancelled",
      exitCode: 1,
    });
  });

  it("releases a detached approval node wait with its exact durable request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-approval-node-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId: "worker-approval-node",
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: approvalNodeWorkflowSource(),
      cwd: directory,
      token: "e".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );

    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
        async execute(node) {
          if (node.type === "approval") {
            throw new Error("approval node reached detached executor");
          }
          return { status: "succeeded", evidence: successfulCommandEvidence(node.id) };
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4324,
    });

    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { status: "running", runId: job.runId },
    });
    await expect(worker).resolves.toBe(3);
    const events = await new JsonlRunStore(runsDirectory).read(job.runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_succeeded",
      "workflow_approval_requested",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "workflow_approval_requested",
      nodeId: "review",
      requestId: "approval-4",
      request: {
        prompt: "Approve the detached evidence.",
        evidence: [{ sourceNodeId: "plan", sourceField: "command.stdout" }],
      },
    });
    await expect(store.readActiveRunClaim(job.runId)).resolves.toBeNull();
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "waiting_for_approval",
      exitCode: 3,
    });
  });

  it("preserves an uncertain resumed run after durably reconciling its open edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-reconcile-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const target = join(directory, "source.ts");
    await writeFile(target, "after\n", { mode: 0o640 });
    await chmod(target, 0o640);
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const source = recoveryWorkflowSource();
    const compiled = compileWorkflowText(source);
    const runId = "worker-reconcile";
    const runStore = new JsonlRunStore(runsDirectory);
    await runStore.append({
      ...runEventBase(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: directory,
    });
    await runStore.append({
      ...runEventBase(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    });
    await runStore.append({
      ...runEventBase(compiled.id, runId, 3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target,
        operationDigest: "b".repeat(64),
        beforeSha256: sha256("before\n"),
        afterSha256: sha256("after\n"),
        mode: 0o640,
      },
    });
    await runStore.release(runId);

    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId,
      mode: "resume",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: source,
      cwd: directory,
      token: "c".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
        async execute() {
          throw new Error("an uncertain resume must not execute a node");
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4322,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { status: "running", runId },
    });

    await expect(worker).resolves.toBe(1);
    const events = await new JsonlRunStore(runsDirectory).read(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_reconciled",
    ]);
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "running",
      recoveryErrorCode: "uncertain_operation",
      exitCode: 1,
    });
    await expect(store.readActiveRunClaim(runId)).resolves.toBeNull();
  });

  it("completes an opted-in proof-safe retry as fresh attempt two", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-worker-retry-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const store = new LocalSupervisorStore(runsDirectory);
    await store.initialize();
    const source = proofSafeRetryWorkflowSource();
    const compiled = compileWorkflowText(source);
    const runId = "worker-proof-safe-retry";
    const runStore = new JsonlRunStore(runsDirectory);
    await runStore.append({
      ...runEventBase(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
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
    await runStore.append({
      ...runEventBase(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
    });
    await runStore.release(runId);
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId,
      mode: "resume",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: source,
      cwd: directory,
      token: "d".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    await store.reserveSubmission(
      job,
      createActiveRunClaim({
        runId: job.runId,
        jobId: job.jobId,
        workerId: job.workerId,
        claimedAt: job.createdAt,
      }),
    );
    const calls: Array<{ nodeId: string; attempt: number }> = [];
    const worker = executeWorkerJob(job.jobId, {
      store,
      executor: {
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
                  textHash: sha256("analysis"),
                  textTruncated: false,
                  durationMs: 1,
                  policyDecisions: [],
                  effectReceipts: [],
                },
              }
            : {
                status: "succeeded",
                evidence: successfulCommandEvidence(node.id),
              };
        },
      },
      effectReconciler: createProductionNodeEffectReconciler(),
      createRunStore: (root) => new JsonlRunStore(root),
      pid: 4323,
    });
    const descriptor = await waitForDescriptor(store, job.workerId);
    await expect(requestWorker(descriptor, { type: "identify" })).resolves.toMatchObject({
      ok: true,
      result: { status: "running", runId },
    });

    await expect(worker).resolves.toBe(0);
    expect(calls).toEqual([
      { nodeId: "implement", attempt: 2 },
      { nodeId: "verify", attempt: 1 },
    ]);
    const events = await new JsonlRunStore(runsDirectory).read(runId);
    expect(events.map((event) => event.type)).toEqual([
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
    await expect(store.readWorkerDescriptor(job.workerId)).resolves.toMatchObject({
      status: "terminal",
      runStatus: "succeeded",
      exitCode: 0,
    });
    await expect(store.readActiveRunClaim(runId)).resolves.toBeNull();
  });
});

async function waitForDescriptor(store: LocalSupervisorStore, workerId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await store.readWorkerDescriptor(workerId);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "not_found")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for worker descriptor");
}

async function waitForPendingAgentApproval(runsDirectory: string, runId: string) {
  const deadline = Date.now() + 5_000;
  const store = new JsonlRunStore(runsDirectory);
  while (Date.now() < deadline) {
    try {
      const state = reduceRunEvents(await store.read(runId));
      if (state.status === "waiting_for_approval") {
        return state;
      }
    } catch (error) {
      if (
        !(
          error instanceof RunStoreError &&
          (error.code === "not_found" ||
            (error.code === "corrupt" && error.message.endsWith("the ledger is empty")))
        )
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for detached agent command approval");
}

function workflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-test }
nodes:
  - id: execute
    type: command
    command:
      executable: node
      args: [--version]
      timeoutMs: 10000
`;
}

function workflowPackageInput(name: string, workflow: string): WorkflowPackageSnapshotInput {
  const indented = workflow
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return {
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: ${name}
  version: 1.0.0
  description: Detached worker workflow.
spec:
  workflow: |-
${indented}
`),
    },
  };
}

function verifierWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-verifier }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: command
      command: { executable: node, args: [--version] }
`;
}

function packagedVerifierWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-packaged-verifier }
nodes:
  - id: verify
    type: verifier
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
`;
}

function typedResultWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-result }
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

function skilledWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-skills }
nodes:
  - id: review
    type: agent
    agent:
      prompt: Review.
      model: { provider: test, id: deterministic }
      tools: [read]
      skills: [review]
  - id: publish
    type: result
    dependsOn: [review]
    result:
      source: { nodeId: review, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function toolPackageWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-tool-package }
nodes:
  - id: inspect
    type: agent
    agent:
      prompt: Inspect the project.
      model: { provider: test, id: deterministic }
      tools: [read]
      toolPackages:
        - { name: project-report, version: 1.2.3 }
  - id: publish
    type: result
    dependsOn: [inspect]
    result:
      source: { nodeId: inspect, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function childWorkflowSource(): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-child-inner }
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
metadata: { id: worker-child-parent }
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

function optimizationWorkflowSource(): string {
  const candidate = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-optimization-candidate }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 10000
  maxArtifactBytes: 100000
nodes:
  - id: improve
    type: command
    command: { executable: node, args: [improve] }
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
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-optimization }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 1000000
nodes:
  - id: measure
    type: command
    command: { executable: node, args: [measure] }
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
`;
}

function optimizationExecutor(): NodeExecutor {
  return {
    async execute(node, context) {
      const stdout =
        node.id === "measure"
          ? '{"score":10,"tests-passed":true}'
          : '{"score":8,"tests-passed":true}';
      if (node.id === "improve") {
        await writeFile(join(context.cwd, "optimized.txt"), "score=8\n", "utf8");
      }
      return {
        status: "succeeded",
        evidence: {
          ...successfulCommandEvidence(node.id),
          stdout,
          stdoutHash: sha256(stdout),
        },
      };
    },
  };
}

function detachedAgentCommandWorkflowSource(requireApproval = false): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-agent-command }
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
${
  requireApproval
    ? `      toolApproval:
        exec: { mode: required, grantTtlMs: 300000 }
`
    : ""
}
  - id: verify
    type: command
    dependsOn: [execute]
    command: { executable: ${JSON.stringify(process.execPath)}, args: [--version] }
`;
}

function detachedAgentCommandExecutor(): NodeExecutor {
  const commandExecutor = new CommandNodeExecutor({ sandbox: detachedAgentCommandSandbox });
  const agentExecutor = new PiAgentExecutor({
    async run(input) {
      if (input.commandRecorder === undefined) {
        throw new Error("agent command recorder was not injected");
      }
      const request = normalizeAgentCommandRequest({
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("detached-command")'],
        timeoutMs: 5_000,
      });
      const decision = input.policyBroker.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest: calculateAgentCommandDigest(request),
      });
      const outcome = await input.commandRecorder.execute(request, decision, input.signal);
      return { text: outcome.evidence?.stdout ?? "command failed", stopReason: "stop" as const };
    },
  });
  return new NodeExecutorRouter(commandExecutor, agentExecutor);
}

const detachedAgentCommandSandbox: CommandSandbox = {
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
        policyDigest: "e".repeat(64),
      },
      release: async () => undefined,
    };
  },
};

function recoveryWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-reconciliation }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`;
}

function approvalNodeWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-approval-node }
nodes:
  - id: plan
    type: command
    command: { executable: node, args: [plan] }
  - id: review
    type: approval
    dependsOn: [plan]
    approval:
      prompt: Approve the detached evidence.
      evidence: [{ nodeId: plan, field: command.stdout }]
  - id: verify
    type: command
    dependsOn: [review]
    command: { executable: node, args: [verify] }
`;
}

function proofSafeRetryWorkflowSource(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: worker-proof-safe-retry }
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
}

function successfulCommandEvidence(nodeId: string) {
  return {
    kind: "command" as const,
    executable: "node",
    args: [nodeId],
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    stdoutHash: sha256("ok"),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function verifierPackageInput(
  name: string,
  version: string,
  definition: VerifierPackageSnapshotInput["definition"],
): VerifierPackageSnapshotInput {
  if (definition.kind !== "command") {
    throw new Error("detached verifier fixture requires a command package");
  }
  return {
    kind: "verifier-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} verifier.`,
    trust: "project-explicit",
    provenance: `.flow/verifiers/${name}`,
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} verifier. }
spec:
  kind: command
  command: { executable: ${definition.command.executable}, args: [${definition.command.args.join(", ")}], timeoutMs: ${definition.command.timeoutMs} }
`),
    },
  };
}

function toolPackageInput(
  name: string,
  version: string,
  executable: string,
): ToolPackageSnapshotInput {
  return {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version,
    description: `Reusable ${name} tool.`,
    trust: "project-explicit",
    provenance: `.flow/tools/${name}`,
    definition: {
      tool: {
        name: "create_project_report",
        description: "Print a selected report subject.",
        inputs: [{ name: "subject", description: "Report subject.", type: "string" }],
      },
      driver: {
        kind: "command",
        version: "v1",
        profile: "posix-printf-v1",
        executable,
        args: ["%s", "{input:subject}"],
        timeoutMs: 10_000,
      },
      permissions: ["process.execute"],
    },
    manifest: { content: Buffer.from(toolPackageManifest(name, version, executable)) },
  };
}

function toolPackageManifest(name: string, version: string, executable: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: ${name}, version: ${version}, description: Reusable ${name} tool. }
spec:
  tool:
    name: create_project_report
    description: Print a selected report subject.
    inputs:
      - { name: subject, description: Report subject., type: string }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: ${executable}
    args: ["%s", "{input:subject}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function runEventBase(workflowId: string, runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId,
    workflowId,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
