import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { RecoverableRunEventStore } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { normalizeAgentCommandRequest } from "../../../src/domain/agent-command.js";
import {
  calculateAgentCommandApprovalRequestDigest,
  calculateCommandApprovalOperationDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import type { FlowPresentationDocument } from "../../../src/domain/presentation/flow-presentation.js";
import type { RunEvent, RunStartedEvent } from "../../../src/domain/run/events.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import type { InteractiveRunPresentationRenderer } from "../../../src/infrastructure/terminal/flow-terminal-renderer.js";
import { requestSupervisor, startSupervisorServer } from "../../../src/supervisor/daemon.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type WorkerRequest,
} from "../../../src/supervisor/protocol.js";
import {
  createActiveRunClaim,
  createJobRecord,
  createSubmissionCommandRecord,
  type WorkerDescriptor,
} from "../../../src/supervisor/records.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("flow tui", () => {
  it("rejects a non-interactive terminal before configuration or storage mutation", async () => {
    const capture = createCapture();
    let loadConfigCalls = 0;
    let createStoreCalls = 0;
    let rendererCalls = 0;

    const exitCode = await main(["tui", "run-1", "--actor", "operator:test"], capture.io, {
      isInteractiveTerminal: () => false,
      loadConfig: async () => {
        loadConfigCalls += 1;
        throw new Error("configuration must not be loaded");
      },
      createStore: () => {
        createStoreCalls += 1;
        throw new Error("run storage must not be opened");
      },
      createTerminalPresentationRenderer: () => {
        rendererCalls += 1;
        throw new Error("terminal renderer must not be constructed");
      },
    });

    expect(exitCode).toBe(2);
    expect(capture.stderr).toHaveLength(1);
    expect(capture.stderr[0]).toMatch(
      /^tui requires an interactive input and output terminal\n\nFlow — Provider-neutral/,
    );
    expect(loadConfigCalls).toBe(0);
    expect(createStoreCalls).toBe(0);
    expect(rendererCalls).toBe(0);
  });

  it("preserves pre-entry cancellation before configuration or supervisor mutation", async () => {
    const reason = new Error("operator cancelled terminal presentation");
    const controller = new AbortController();
    controller.abort(reason);
    const capture = createCapture();
    let loadConfigCalls = 0;
    let rendererCalls = 0;

    const exitCode = await main(["tui", "run-1", "--actor", "operator:test"], capture.io, {
      signal: controller.signal,
      isInteractiveTerminal: () => true,
      loadConfig: async () => {
        loadConfigCalls += 1;
        throw new Error("configuration must not be loaded");
      },
      createTerminalPresentationRenderer: () => {
        rendererCalls += 1;
        throw new Error("terminal renderer must not be constructed");
      },
    });

    expect(exitCode).toBe(1);
    expect(capture.stderr).toEqual([reason.message]);
    expect(loadConfigCalls).toBe(0);
    expect(rendererCalls).toBe(0);
  });

  it("replays a terminal run through the real supervisor event channel", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-terminal-run";
    await appendEvents(harness.runsDirectory, terminalRunEvents(runId));
    const renderer = new RecordingRenderer();
    const capture = createCapture();

    try {
      const exitCode = await main(
        ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({}),
          createTerminalPresentationRenderer: () => renderer,
        },
      );

      expect(exitCode, capture.stderr.join("\n")).toBe(1);
      expect(renderer.startCalls).toBe(1);
      expect(renderer.closeCalls).toBe(1);
      expect(renderer.documents).toHaveLength(1);
      expect(renderer.documents[0]).toMatchObject({
        apiVersion: "flow.synapti.ai/presentation/v1",
        run: { runId, sequence: 2, status: "cancelled" },
        actions: [],
      });
      expect(renderer.documents[0]?.layout).toBeUndefined();
    } finally {
      await harness.running.close();
    }
  });

  it("selects an exact presentation from an installed inert bundle", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-installed-presentation-run";
    await appendEvents(harness.runsDirectory, terminalRunEvents(runId));
    const bundle = createCapabilityBundleSource({
      name: "operations-presentation",
      version: "1.0.0",
      description: "Installed terminal presentation",
      packages: [
        { kind: "presentation-package", manifest: Buffer.from(presentationPackageSource()) },
      ],
    });
    await mkdir(join(harness.directory, ".flow"));
    await new LocalCapabilityPackageStore(harness.directory).install({
      source: "https://packages.example.test/operations-presentation.flowpkg",
      expectedSha256: bundle.bundle.digest.slice("sha256:".length),
      content: bundle.content,
    });
    const renderer = new RecordingRenderer();
    const capture = createCapture();

    try {
      const exitCode = await main(
        [
          "tui",
          runId,
          "--actor",
          "operator:test",
          "--runs-dir",
          harness.runsDirectory,
          "--presentation",
          "operations@1.0.0",
        ],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({ projectRoot: harness.directory }),
          createTerminalPresentationRenderer: () => renderer,
        },
      );

      expect(exitCode, capture.stderr.join("\n")).toBe(1);
      expect(renderer.documents[0]).toMatchObject({ layout: { density: "compact" } });
      expect(renderer.documents[0]?.sections[0]?.id).toBe("resource-facts");
      expect(renderer.documents[0]?.sections.at(-1)).toMatchObject({
        id: "presentation-package-content",
        title: "Package-provided information — operations@1.0.0",
      });
    } finally {
      await harness.running.close();
    }
  });

  it("freezes an exact presentation package before rendering the run", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-packaged-run";
    await appendEvents(harness.runsDirectory, terminalRunEvents(runId));
    await writePresentationPackage(harness.directory);
    const renderer = new RecordingRenderer();
    const capture = createCapture();

    try {
      const exitCode = await main(
        [
          "tui",
          runId,
          "--actor",
          "operator:test",
          "--runs-dir",
          harness.runsDirectory,
          "--presentation",
          "operations@1.0.0",
        ],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({ projectRoot: harness.directory }),
          createTerminalPresentationRenderer: () => {
            rmSync(join(harness.directory, ".flow", "presentations"), {
              recursive: true,
              force: true,
            });
            return renderer;
          },
        },
      );

      expect(exitCode, capture.stderr.join("\n")).toBe(1);
      expect(renderer.documents[0]).toMatchObject({ layout: { density: "compact" } });
      expect(renderer.documents[0]?.sections.map((section) => section.id)).toEqual([
        "resource-facts",
        "run-summary",
        "graph-progress",
        "node-table",
        "outcome-notice",
        "presentation-package-content",
      ]);
    } finally {
      await harness.running.close();
    }
  });

  it("rejects a missing presentation before supervisor or terminal mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-tui-missing-presentation-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, ".flow"));
    let rendererCalls = 0;
    const output = createCapture();

    expect(
      await main(
        ["tui", "run-1", "--actor", "operator:test", "--presentation", "missing@1.0.0"],
        output.io,
        {
          cwd: directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({ projectRoot: directory }),
          createTerminalPresentationRenderer: () => {
            rendererCalls += 1;
            throw new Error("renderer must not be created");
          },
        },
      ),
    ).toBe(1);
    expect(rendererCalls).toBe(0);
    expect(output.stderr).toEqual(["missing_package: presentation package is missing"]);
  });

  it("rejects invalid package content before supervisor or terminal mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-tui-invalid-content-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    await writePresentationPackage(directory);
    await writeFile(
      join(directory, ".flow", "presentations", "operations", "PRESENTATION.yaml"),
      presentationPackageSource().replace(
        "body: This text is package-provided information.",
        "body:\n                  path: /PRIVATE/package-note",
      ),
    );
    let rendererCalls = 0;
    const output = createCapture();

    expect(
      await main(
        [
          "tui",
          "run-1",
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
          "--presentation",
          "operations@1.0.0",
        ],
        output.io,
        {
          cwd: directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({ projectRoot: directory }),
          createTerminalPresentationRenderer: () => {
            rendererCalls += 1;
            throw new Error("renderer must not be constructed");
          },
        },
      ),
    ).toBe(1);
    expect(output.stderr).toEqual(["invalid_package: presentation package is invalid"]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE");
    expect(rendererCalls).toBe(0);
    await expect(
      access(new LocalSupervisorStore(runsDirectory).controlDirectory),
    ).rejects.toThrow();
  });

  it("rejects repeated presentation selection before configuration or terminal mutation", async () => {
    const output = createCapture();
    let loadConfigCalls = 0;
    let rendererCalls = 0;

    expect(
      await main(
        [
          "tui",
          "run-1",
          "--actor",
          "operator:test",
          "--presentation",
          "operations@1.0.0",
          "--presentation=private@2.0.0",
        ],
        output.io,
        {
          isInteractiveTerminal: () => true,
          loadConfig: async () => {
            loadConfigCalls += 1;
            throw new Error("configuration must not be loaded");
          },
          createTerminalPresentationRenderer: () => {
            rendererCalls += 1;
            throw new Error("renderer must not be constructed");
          },
        },
      ),
    ).toBe(2);
    expect(loadConfigCalls).toBe(0);
    expect(rendererCalls).toBe(0);
    expect(output.stderr.join("\n")).not.toContain("private@2.0.0");
  });

  it("follows a live run until the operator exits and restores the terminal once", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-live-run";
    await appendEvents(harness.runsDirectory, [runStartedEvent(runId)]);
    let onExit: (() => void) | undefined;
    const renderer = new RecordingRenderer(() => onExit?.());
    const capture = createCapture();

    try {
      const exitCode = await main(
        ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({}),
          createTerminalPresentationRenderer: (callbacks) => {
            onExit = callbacks.onExit;
            return renderer;
          },
        },
      );

      expect(exitCode, capture.stderr.join("\n")).toBe(0);
      expect(renderer.startCalls).toBe(1);
      expect(renderer.closeCalls).toBe(1);
      expect(renderer.documents).toHaveLength(1);
      expect(renderer.documents[0]).toMatchObject({
        run: { runId, sequence: 1, status: "running" },
        actions: [{ actionId: `cancel:${runId}`, runId, kind: "cancel" }],
      });
    } finally {
      await harness.running.close();
    }
  });

  it("settles a rejected action before restoring and never publishes its private error", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-rejected-action";
    await appendEvents(harness.runsDirectory, approvalRunEvents(runId, harness.directory));
    const baseStore = new JsonlRunStore(harness.runsDirectory);
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const privateError = new Error("PRIVATE_ACTION_REJECTION_AT_/PRIVATE/path");
    const delayedStore: RecoverableRunEventStore = {
      append: async (event) => await baseStore.append(event),
      read: async () => {
        markReadStarted?.();
        await readGate;
        throw privateError;
      },
      claim: async (id) => await baseStore.claim(id),
      release: async (id) => await baseStore.release(id),
      exists: async (id) => await baseStore.exists(id),
    };
    let closeCalls = 0;
    let actionError: unknown;
    const capture = createCapture();

    try {
      const execution = main(
        ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({}),
          createStore: () => delayedStore,
          createTerminalPresentationRenderer: (callbacks) => ({
            start() {},
            async render(document) {
              if (document.run.sequence === 2) {
                void callbacks.onAction("approve:approval-2").catch((error) => {
                  actionError = error;
                });
                callbacks.onExit();
              }
            },
            async close() {
              closeCalls += 1;
            },
          }),
        },
      );

      await readStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closeCallsBeforeSettlement = closeCalls;
      releaseRead?.();
      const exitCode = await execution;

      expect(closeCallsBeforeSettlement).toBe(0);
      expect(exitCode).toBe(0);
      expect(closeCalls).toBe(1);
      expect(actionError).toBe(privateError);
      expect(capture.stderr.join("\n")).not.toContain("PRIVATE_");
      expect(capture.stderr.join("\n")).not.toContain("/PRIVATE/");
    } finally {
      releaseRead?.();
      await harness.running.close();
    }
  });

  it("settles an owned action before restoring when the run becomes terminal", async () => {
    const harness = await createSupervisorHarness();
    const runId = "tui-terminal-during-action";
    await appendEvents(harness.runsDirectory, approvalRunEvents(runId, harness.directory));
    const baseStore = new JsonlRunStore(harness.runsDirectory);
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const delayedStore: RecoverableRunEventStore = {
      append: async (event) => await baseStore.append(event),
      read: async (id) => {
        markReadStarted?.();
        await readGate;
        return await baseStore.read(id);
      },
      claim: async (id) => await baseStore.claim(id),
      release: async (id) => await baseStore.release(id),
      exists: async (id) => await baseStore.exists(id),
    };
    let closeCalls = 0;
    const capture = createCapture();

    try {
      const execution = main(
        ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
        capture.io,
        {
          cwd: harness.directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({}),
          createStore: () => delayedStore,
          createTerminalPresentationRenderer: (callbacks) => ({
            start() {},
            async render(document) {
              if (document.run.sequence === 2) {
                void callbacks.onAction("approve:approval-2").catch(() => {});
              }
            },
            async close() {
              closeCalls += 1;
            },
          }),
        },
      );

      await readStarted;
      await baseStore.claim(runId);
      await baseStore.append({
        ...eventBase(runId, 3),
        type: "run_cancelled",
        reason: "independent operator request",
        actor: "operator:other",
        requestId: "00000000-0000-4000-8000-000000000002",
      });
      await baseStore.release(runId);
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      const closeCallsBeforeSettlement = closeCalls;
      releaseRead?.();
      const exitCode = await execution;

      expect(closeCallsBeforeSettlement).toBe(0);
      expect(exitCode, capture.stderr.join("\n")).toBe(1);
      expect(closeCalls).toBe(1);
    } finally {
      releaseRead?.();
      await harness.running.close();
    }
  });

  it.each([
    {
      decision: "approve" as const,
      expectedExitCode: 0,
      expectedStatus: "running",
      expectedTypes: ["run_started", "command_approval_requested", "command_approval_granted"],
    },
    {
      decision: "deny" as const,
      expectedExitCode: 1,
      expectedStatus: "failed",
      expectedTypes: [
        "run_started",
        "command_approval_requested",
        "command_approval_denied",
        "run_failed",
      ],
    },
  ])(
    "routes a $decision action through the existing durable approval control",
    async ({ decision, expectedExitCode, expectedStatus, expectedTypes }) => {
      const harness = await createSupervisorHarness();
      const runId = `tui-${decision}-run`;
      await appendEvents(harness.runsDirectory, approvalRunEvents(runId, harness.directory));
      const documents: FlowPresentationDocument[] = [];
      let startCalls = 0;
      let closeCalls = 0;
      const capture = createCapture();

      try {
        const exitCode = await main(
          ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
          capture.io,
          {
            cwd: harness.directory,
            isInteractiveTerminal: () => true,
            loadConfig: async () => resolveFlowConfig({}),
            createTerminalPresentationRenderer: (callbacks) => ({
              start() {
                startCalls += 1;
              },
              async render(document) {
                documents.push(document);
                if (documents.length === 1) {
                  await callbacks.onAction(`${decision}:approval-2`);
                } else if (decision === "approve") {
                  callbacks.onExit();
                }
              },
              async close() {
                closeCalls += 1;
              },
            }),
          },
        );

        expect(exitCode, capture.stderr.join("\n")).toBe(expectedExitCode);
        expect(startCalls).toBe(1);
        expect(closeCalls).toBe(1);
        expect(documents).toHaveLength(2);
        expect(documents[0]?.actions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actionId: `${decision}:approval-2`,
              kind: decision,
              requestId: "approval-2",
            }),
          ]),
        );
        expect(documents[1]).toMatchObject({ run: { runId, status: expectedStatus } });
        expect(
          (await new JsonlRunStore(harness.runsDirectory).read(runId)).map((event) => event.type),
        ).toEqual(expectedTypes);
      } finally {
        await harness.running.close();
      }
    },
  );

  it.each(["approve", "deny"] as const)(
    "routes an agent-command %s action through the immutable decision inbox",
    async (decision) => {
      const harness = await createSupervisorHarness();
      const runId = `tui-agent-${decision}`;
      await appendEvents(
        harness.runsDirectory,
        agentCommandApprovalEvents(runId, harness.directory),
      );
      let onExit: (() => void) | undefined;

      try {
        const exitCode = await main(
          ["tui", runId, "--actor", "operator:test", "--runs-dir", harness.runsDirectory],
          createCapture().io,
          {
            cwd: harness.directory,
            isInteractiveTerminal: () => true,
            loadConfig: async () => resolveFlowConfig({}),
            createTerminalPresentationRenderer: (callbacks) => {
              onExit = callbacks.onExit;
              return {
                start() {},
                async render(document) {
                  expect(document.actions).toContainEqual(
                    expect.objectContaining({
                      actionId: `${decision}:agent-approval-3`,
                      kind: decision,
                      requestId: "agent-approval-3",
                    }),
                  );
                  await callbacks.onAction(`${decision}:agent-approval-3`);
                  onExit?.();
                },
                async close() {},
              };
            },
          },
        );

        expect(exitCode).toBe(0);
        const receipt = JSON.parse(
          await readFile(
            join(
              harness.runsDirectory,
              runId,
              "agent-command-approvals",
              "agent-approval-3.decision.json",
            ),
            "utf8",
          ),
        );
        expect(receipt).toMatchObject({
          decision,
          actor: "operator:test",
          requestId: "agent-approval-3",
        });
        expect(
          (await new JsonlRunStore(harness.runsDirectory).read(runId)).map((event) => event.type),
        ).toEqual(["run_started", "node_started", "agent_command_approval_requested"]);
      } finally {
        await harness.running.close();
      }
    },
  );

  it("routes cancellation through the real supervisor control and durable run ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-tui-cancel-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const launcher = new CancellingLauncher(supervisorStore, runsDirectory);
    const runId = "tui-cancel-run";
    await appendEvents(runsDirectory, [runStartedEvent(runId)]);
    const job = createJobRecord({
      jobId: randomUUID(),
      workerId: randomUUID(),
      runId,
      mode: "run",
      sourceName: join(directory, "workflow.yaml"),
      workflowSource: `apiVersion: flow.synapti.ai/v1alpha1\nkind: Workflow\nmetadata: { id: tui-workflow }\nnodes:\n  - id: step\n    type: command\n    command: { executable: node, args: [--version] }\n`,
      cwd: directory,
      token: "a".repeat(64),
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    const claim = createActiveRunClaim({
      runId,
      jobId: job.jobId,
      workerId: job.workerId,
      claimedAt: job.createdAt,
    });
    await supervisorStore.recordCommand(
      createSubmissionCommandRecord({
        commandId: job.jobId,
        policyDigest: resolveFlowConfig({}).policyDigest,
        runId,
        mode: job.mode,
        sourceName: job.sourceName,
        workflowSource: job.workflowSource,
        cwd: job.cwd,
        recordedAt: job.createdAt,
      }),
    );
    await supervisorStore.reserveSubmission(job, claim);
    const descriptor: WorkerDescriptor = {
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId,
      pid: 4321,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(supervisorStore.socketDirectory, "tui-worker.sock"),
      status: "running",
      runStatus: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    };
    await supervisorStore.writeWorkerDescriptor(descriptor);
    launcher.descriptor = descriptor;
    const running = await startSupervisorServer({ store: supervisorStore, launcher });
    const documents: FlowPresentationDocument[] = [];
    let closeCalls = 0;

    try {
      const exitCode = await main(
        ["tui", runId, "--actor", "operator:test", "--runs-dir", runsDirectory],
        createCapture().io,
        {
          cwd: directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => resolveFlowConfig({}),
          createTerminalPresentationRenderer: (callbacks) => ({
            start() {},
            async render(document) {
              documents.push(document);
              if (documents.length === 1) {
                await callbacks.onAction(`cancel:${runId}`);
              }
            },
            async close() {
              closeCalls += 1;
            },
          }),
        },
      );

      expect(exitCode).toBe(1);
      expect(closeCalls).toBe(1);
      expect(documents).toHaveLength(2);
      expect(documents[0]?.actions).toContainEqual(
        expect.objectContaining({ actionId: `cancel:${runId}`, kind: "cancel", runId }),
      );
      expect(documents[1]).toMatchObject({ run: { runId, status: "cancelled" }, actions: [] });
      expect(launcher.cancelCommands).toHaveLength(1);
      expect(launcher.cancelCommands[0]).toMatchObject({
        type: "cancel",
        actor: "operator:test",
      });
      expect(launcher.cancelCommands[0]?.commandId).toMatch(
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
      );
      expect(
        (await new JsonlRunStore(runsDirectory).read(runId)).map((event) => event.type),
      ).toEqual(["run_started", "run_cancelled"]);
    } finally {
      await running.close();
    }
  });

  it("settles a queued resume cancellation without inventing a terminal ledger event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-tui-queued-cancel-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const launcher = new HoldingLauncher(supervisorStore);
    const policy = resolveFlowConfig({});
    const running = await startSupervisorServer({ store: supervisorStore, launcher, policy });
    const workflowSource = `apiVersion: flow.synapti.ai/v1alpha1\nkind: Workflow\nmetadata: { id: tui-workflow }\nnodes:\n  - id: step\n    type: command\n    command: { executable: node, args: [--version] }\n`;
    const activeCommandId = randomUUID();
    const queuedCommandId = randomUUID();
    const queuedRunId = "tui-queued-resume";
    await appendEvents(runsDirectory, [runStartedEvent(queuedRunId)]);

    try {
      const accepted = await requestSupervisor(supervisorStore, {
        type: "submit",
        policyDigest: policy.policyDigest,
        commandId: activeCommandId,
        mode: "run",
        runId: "tui-capacity-holder",
        sourceName: join(directory, "active.workflow.yaml"),
        workflowSource,
        cwd: directory,
      });
      expect(accepted).toMatchObject({ ok: true, result: { type: "accepted" } });
      const queued = await requestSupervisor(supervisorStore, {
        type: "submit",
        policyDigest: policy.policyDigest,
        commandId: queuedCommandId,
        mode: "resume",
        runId: queuedRunId,
        sourceName: join(directory, "queued.workflow.yaml"),
        workflowSource,
        cwd: directory,
      });
      expect(queued).toMatchObject({ ok: true, result: { type: "queued", queuePosition: 1 } });
      let closeCalls = 0;

      const exitCode = await main(
        ["tui", queuedRunId, "--actor", "operator:test", "--runs-dir", runsDirectory],
        createCapture().io,
        {
          cwd: directory,
          isInteractiveTerminal: () => true,
          loadConfig: async () => policy,
          createTerminalPresentationRenderer: (callbacks) => ({
            start() {},
            async render(document) {
              expect(document.actions).toContainEqual(
                expect.objectContaining({ actionId: `cancel:${queuedRunId}`, kind: "cancel" }),
              );
              await callbacks.onAction(`cancel:${queuedRunId}`);
            },
            async close() {
              closeCalls += 1;
            },
          }),
        },
      );

      expect(exitCode).toBe(0);
      expect(closeCalls).toBe(1);
      expect(
        (await new JsonlRunStore(runsDirectory).read(queuedRunId)).map((event) => event.type),
      ).toEqual(["run_started"]);
      await expect(supervisorStore.readActiveRunClaim(queuedRunId)).resolves.toBeNull();
      await expect(supervisorStore.readCommand(queuedCommandId)).resolves.toMatchObject({
        type: "submit",
        status: "rejected",
        reason: "cancelled",
      });
      expect(launcher.jobs).toHaveLength(1);
    } finally {
      await running.close();
    }
  });
});

class RecordingRenderer implements InteractiveRunPresentationRenderer {
  readonly documents: FlowPresentationDocument[] = [];
  startCalls = 0;
  closeCalls = 0;

  constructor(readonly afterFirstRender?: () => void) {}

  start(): void {
    this.startCalls += 1;
  }

  async render(document: FlowPresentationDocument): Promise<void> {
    this.documents.push(document);
    if (this.documents.length === 1) {
      this.afterFirstRender?.();
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

async function createSupervisorHarness() {
  const directory = await mkdtemp(join(tmpdir(), "flow-tui-"));
  temporaryDirectories.push(directory);
  const runsDirectory = join(directory, "runs");
  const store = new LocalSupervisorStore(runsDirectory);
  const running = await startSupervisorServer({ store, launcher: unavailableLauncher });
  return { directory, runsDirectory, running };
}

async function writePresentationPackage(root: string): Promise<void> {
  const directory = join(root, ".flow", "presentations", "operations");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "PRESENTATION.yaml"), presentationPackageSource());
}

function presentationPackageSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata: { name: operations, version: 1.0.0, description: Operator layout }
spec:
  messages:
    - version: v0.9
      createSurface: { surfaceId: flow-run, catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v2 }
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - { id: root, component: FlowLayout, density: compact, children: [group-1, package-notes] }
          - { id: group-1, component: FlowGroup, variant: stack, children: [resource-facts, run-summary, graph-progress, node-table, pending-approvals, outcome-notice] }
          - id: package-notes
            component: FlowPackageNotes
            notes:
              - title: Operator context
                body: This text is package-provided information.
          - { id: run-summary, component: FlowRunSummary }
          - { id: graph-progress, component: FlowGraphProgress }
          - { id: node-table, component: FlowNodeTable }
          - { id: resource-facts, component: FlowResourceFacts }
          - { id: pending-approvals, component: FlowPendingApprovals }
          - { id: outcome-notice, component: FlowOutcomeNotice }
`;
}

const unavailableLauncher: WorkerLauncher = {
  async launch() {
    throw new Error("worker launch is not used by terminal presentation tests");
  },
  async request() {
    throw new Error("worker request is not used by terminal presentation tests");
  },
};

class CancellingLauncher implements WorkerLauncher {
  readonly cancelCommands: Extract<WorkerRequest["command"], { type: "cancel" }>[] = [];
  descriptor: WorkerDescriptor | undefined;

  constructor(
    readonly store: LocalSupervisorStore,
    readonly runsDirectory: string,
  ) {}

  async launch(): Promise<WorkerDescriptor> {
    throw new Error("worker launch is not used by the cancellation presentation test");
  }

  async request(descriptor: WorkerDescriptor, command: WorkerRequest["command"]) {
    if (this.descriptor?.workerId !== descriptor.workerId) {
      throw new Error("unexpected worker request");
    }
    if (command.type === "identify") {
      return {
        version: SUPERVISOR_PROTOCOL_VERSION,
        requestId: randomUUID(),
        ok: true as const,
        result: {
          type: "identity" as const,
          workerId: descriptor.workerId,
          runId: descriptor.runId,
          pid: descriptor.pid,
          jobDigest: descriptor.jobDigest,
          status: descriptor.status,
          ...(descriptor.runStatus === undefined ? {} : { runStatus: descriptor.runStatus }),
        },
      };
    }
    this.cancelCommands.push(command);
    const runStore = new JsonlRunStore(this.runsDirectory);
    const events = await runStore.claim(descriptor.runId);
    const state = events.at(-1);
    if (state === undefined) {
      throw new Error("run ledger is empty");
    }
    await runStore.append({
      ...eventBase(descriptor.runId, state.sequence + 1),
      type: "run_cancelled",
      reason: command.reason ?? "operator request",
      actor: command.actor,
      requestId: command.commandId,
    });
    await runStore.release(descriptor.runId);
    await this.store.releaseActiveRunClaim(descriptor.runId, descriptor.jobId);
    return {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId: randomUUID(),
      ok: true as const,
      result: {
        type: "cancelled" as const,
        commandId: command.commandId,
        runId: descriptor.runId,
        runStatus: "cancelled" as const,
        phase: "active" as const,
        lastSequence: state.sequence + 1,
      },
    };
  }
}

class HoldingLauncher implements WorkerLauncher {
  readonly jobs: Parameters<WorkerLauncher["launch"]>[0][] = [];

  constructor(readonly store: LocalSupervisorStore) {}

  async launch(job: Parameters<WorkerLauncher["launch"]>[0]): Promise<WorkerDescriptor> {
    this.jobs.push(job);
    const descriptor: WorkerDescriptor = {
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 4322,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(this.store.socketDirectory, `${job.workerId}.sock`),
      status: "running",
      runStatus: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    };
    await this.store.writeWorkerDescriptor(descriptor);
    return descriptor;
  }

  async request(descriptor: WorkerDescriptor, command: WorkerRequest["command"]) {
    if (command.type !== "identify") {
      throw new Error("capacity holder accepts identity requests only");
    }
    return {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId: randomUUID(),
      ok: true as const,
      result: {
        type: "identity" as const,
        workerId: descriptor.workerId,
        runId: descriptor.runId,
        pid: descriptor.pid,
        jobDigest: descriptor.jobDigest,
        status: descriptor.status,
        ...(descriptor.runStatus === undefined ? {} : { runStatus: descriptor.runStatus }),
      },
    };
  }
}

async function appendEvents(runsDirectory: string, events: readonly RunEvent[]): Promise<void> {
  const store = new JsonlRunStore(runsDirectory);
  for (const event of events) {
    await store.append(event);
  }
  for (const runId of new Set(events.map((event) => event.runId))) {
    await store.release(runId);
  }
}

function terminalRunEvents(runId: string): readonly RunEvent[] {
  return [
    runStartedEvent(runId),
    {
      ...eventBase(runId, 2),
      type: "run_cancelled",
      reason: "operator request",
      actor: "operator:test",
      requestId: "00000000-0000-4000-8000-000000000001",
    },
  ];
}

function approvalRunEvents(runId: string, cwd: string): readonly RunEvent[] {
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
      ...runStartedEvent(runId),
      executionCwd: cwd,
      approvalRequirements: [{ nodeId: "step", grantTtlMs: 60_000 }],
    },
    {
      ...eventBase(runId, 2),
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

function agentCommandApprovalEvents(runId: string, cwd: string): readonly RunEvent[] {
  const request = createAgentCommandApprovalRequest({
    runId,
    workflowId: "tui-workflow",
    nodeId: "step",
    attempt: 1,
    cwd,
    command: normalizeAgentCommandRequest({ executable: "npm", args: ["test"] }),
    grantTtlMs: 300_000,
  });
  return [
    {
      ...runStartedEvent(runId),
      executionCwd: cwd,
      agentCommandApprovalRequirements: [{ nodeId: "step", grantTtlMs: 300_000 }],
    },
    {
      ...eventBase(runId, 2),
      type: "node_started",
      nodeId: "step",
      attempt: 1,
      commandProtocol: "flow.agent-commands/v1",
    },
    {
      ...eventBase(runId, 3),
      type: "agent_command_approval_requested",
      nodeId: "step",
      attempt: 1,
      requestId: "agent-approval-3",
      request,
      requestDigest: calculateAgentCommandApprovalRequestDigest(request),
    },
  ];
}

function runStartedEvent(runId: string): RunStartedEvent {
  return {
    ...eventBase(runId, 1),
    type: "run_started",
    nodeIds: ["step"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: createHash("sha256").update("tui-workflow").digest("hex"),
  };
}

function eventBase(runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-16T12:00:0${sequence}.000Z`,
    runId,
    workflowId: "tui-workflow",
  };
}

function createCapture(): {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
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
