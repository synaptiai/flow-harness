import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import type { FlowPresentationDocument } from "../../../src/domain/presentation/flow-presentation.js";
import type { RunEvent, RunStartedEvent } from "../../../src/domain/run/events.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { startSupervisorServer } from "../../../src/supervisor/daemon.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("flow web", () => {
  it("rejects missing actor grammar before configuration or host work", async () => {
    const output = captureIo();
    let loadConfigCalls = 0;

    const exitCode = await main(["web", "run-1"], output.io, {
      loadConfig: async () => {
        loadConfigCalls += 1;
        throw new Error("configuration must not be loaded");
      },
    });

    expect(exitCode).toBe(2);
    expect(output.stderr).toHaveLength(1);
    expect(output.stderr[0]).toMatch(/^web requires --actor <label>\n\nFlow —/);
    expect(loadConfigCalls).toBe(0);
  });

  it("rejects an invalid exact presentation before constructing the browser host", async () => {
    const output = captureIo();
    let hostCalls = 0;
    const overrides = {
      loadConfig: async () => resolveFlowConfig({}),
      createBrowserPresentationHost: () => {
        hostCalls += 1;
        throw new Error("browser host must not be constructed");
      },
    } as Parameters<typeof main>[2] & {
      readonly createBrowserPresentationHost: () => never;
    };

    const exitCode = await main(
      ["web", "run-1", "--actor", "operator:test", "--presentation", "PRIVATE_INVALID"],
      output.io,
      overrides,
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toEqual([
      "presentation selection must use <name>@<exact-semantic-version>",
    ]);
    expect(hostCalls).toBe(0);
  });

  it("preserves exact cancellation when configuration rejects after the abort", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_WEB_CANCELLATION");
    const output = captureIo();

    const exitCode = await main(["web", "run-1", "--actor", "operator:test"], output.io, {
      signal: controller.signal,
      loadConfig: async () => {
        controller.abort(reason);
        throw new Error("PRIVATE_CONFIGURATION_FAILURE");
      },
    });

    expect(exitCode).toBe(1);
    expect(output.stderr).toEqual([reason.message]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_CONFIGURATION_FAILURE");
  });

  it("replays a durable run through the real supervisor and closes the browser host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-web-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const running = await startSupervisorServer({
      store: supervisorStore,
      launcher: unavailableLauncher,
    });
    const runId = "web-terminal-run";
    await appendEvents(runsDirectory, terminalRunEvents(runId));
    const host = new RecordingBrowserHost();
    const output = captureIo();
    const overrides = {
      cwd: directory,
      loadConfig: async () => resolveFlowConfig({}),
      createBrowserPresentationHost: () => host,
    } as Parameters<typeof main>[2] & {
      readonly createBrowserPresentationHost: () => RecordingBrowserHost;
    };

    try {
      const exitCode = await main(
        ["web", runId, "--actor", "operator:test", "--runs-dir", runsDirectory],
        output.io,
        overrides,
      );

      expect(exitCode, output.stderr.join("\n")).toBe(1);
      expect(output.stdout).toEqual(["http://127.0.0.1:43101/#private-session"]);
      expect(host.startCalls).toBe(1);
      expect(host.closeCalls).toBe(1);
      expect(host.documents).toHaveLength(1);
      expect(host.documents[0]).toMatchObject({
        run: { runId, sequence: 2, status: "cancelled" },
      });
    } finally {
      await running.close();
    }
  });

  it("applies one exact inert presentation package before browser rendering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-web-presentation-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const running = await startSupervisorServer({
      store: supervisorStore,
      launcher: unavailableLauncher,
    });
    const runId = "web-packaged-run";
    await appendEvents(runsDirectory, terminalRunEvents(runId));
    await writePresentationPackage(directory);
    const host = new RecordingBrowserHost();
    const output = captureIo();

    try {
      const exitCode = await main(
        [
          "web",
          runId,
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
          loadConfig: async () => resolveFlowConfig({ projectRoot: directory }),
          createBrowserPresentationHost: () => host,
        },
      );

      expect(exitCode, output.stderr.join("\n")).toBe(1);
      expect(host.documents).toHaveLength(1);
      expect(host.documents[0]).toMatchObject({ layout: { density: "compact" } });
      expect(host.documents[0]?.sections.map((section) => section.id)).toEqual([
        "resource-facts",
        "run-summary",
        "graph-progress",
        "node-table",
        "outcome-notice",
        "presentation-package-content",
      ]);
      expect(host.documents[0]?.sections.at(-1)).toMatchObject({
        title: "Package-provided information — operations@1.0.0",
        components: expect.arrayContaining([
          { kind: "notice", tone: "info", text: "This text is package-provided information." },
        ]),
      });
    } finally {
      await running.close();
    }
  });

  it("rejects a missing run privately before supervisor or browser-host mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-web-missing-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    let hostCalls = 0;
    const output = captureIo();
    const overrides = {
      cwd: directory,
      loadConfig: async () => resolveFlowConfig({}),
      createBrowserPresentationHost: () => {
        hostCalls += 1;
        throw new Error("browser host must not be constructed");
      },
    } as Parameters<typeof main>[2] & {
      readonly createBrowserPresentationHost: () => never;
    };

    const exitCode = await main(
      ["web", "PRIVATE_MISSING_RUN", "--actor", "operator:test", "--runs-dir", runsDirectory],
      output.io,
      overrides,
    );

    expect(exitCode).toBe(1);
    expect(output.stderr).toEqual(["Cannot open Flow browser presentation: run is unavailable"]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_MISSING_RUN");
    expect(hostCalls).toBe(0);
    await expect(
      access(new LocalSupervisorStore(runsDirectory).controlDirectory),
    ).rejects.toThrow();
  });

  it("rejects an invalid actor before supervisor or browser-host mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-web-actor-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const runId = "web-invalid-actor";
    await appendEvents(runsDirectory, terminalRunEvents(runId));
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    let hostCalls = 0;
    const output = captureIo();
    const overrides = {
      cwd: directory,
      loadConfig: async () => resolveFlowConfig({}),
      createBrowserPresentationHost: () => {
        hostCalls += 1;
        throw new Error("browser host must not be constructed");
      },
    } as Parameters<typeof main>[2] & {
      readonly createBrowserPresentationHost: () => never;
    };

    try {
      const exitCode = await main(
        ["web", runId, "--actor", "x".repeat(129), "--runs-dir", runsDirectory],
        output.io,
        overrides,
      );

      expect(exitCode).toBe(1);
      expect(output.stderr).toEqual(["Cannot steer Flow run presentation: actor is invalid"]);
      expect(hostCalls).toBe(0);
      await expect(access(supervisorStore.controlDirectory)).rejects.toThrow();
    } finally {
      if (await pathExists(supervisorStore.controlDirectory)) {
        await main(
          ["supervisor", "shutdown", "--runs-dir", runsDirectory],
          captureIo().io,
          overrides,
        );
      }
    }
  });

  it("preserves startup failure when browser-host cleanup also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-web-start-failure-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const running = await startSupervisorServer({
      store: supervisorStore,
      launcher: unavailableLauncher,
    });
    const runId = "web-start-failure";
    await appendEvents(runsDirectory, terminalRunEvents(runId));
    const output = captureIo();

    try {
      const exitCode = await main(
        ["web", runId, "--actor", "operator:test", "--runs-dir", runsDirectory],
        output.io,
        {
          cwd: directory,
          loadConfig: async () => resolveFlowConfig({}),
          createBrowserPresentationHost: () => ({
            async start() {
              throw new Error("PRIVATE_START_FAILURE");
            },
            async render() {},
            async close() {
              throw new Error("PRIVATE_CLOSE_FAILURE");
            },
          }),
        },
      );

      expect(exitCode).toBe(1);
      expect(output.stderr).toEqual([
        "Cannot open Flow browser presentation: startup and cleanup failed",
      ]);
      expect(output.stderr.join("\n")).not.toMatch(/PRIVATE_START_FAILURE|PRIVATE_CLOSE_FAILURE/);
    } finally {
      await running.close();
    }
  });
});

class RecordingBrowserHost {
  readonly documents: FlowPresentationDocument[] = [];
  startCalls = 0;
  closeCalls = 0;

  async start(): Promise<{ readonly url: string }> {
    this.startCalls += 1;
    return { url: "http://127.0.0.1:43101/#private-session" };
  }

  async render(document: FlowPresentationDocument): Promise<void> {
    this.documents.push(document);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const unavailableLauncher: WorkerLauncher = {
  async launch() {
    throw new Error("worker launch is not used by browser presentation tests");
  },
  async request() {
    throw new Error("worker request is not used by browser presentation tests");
  },
};

async function appendEvents(runsDirectory: string, events: readonly RunEvent[]): Promise<void> {
  const store = new JsonlRunStore(runsDirectory);
  for (const event of events) {
    await store.append(event);
  }
  await store.release(events[0]?.runId ?? "missing");
}

async function writePresentationPackage(root: string): Promise<void> {
  const directory = join(root, ".flow", "presentations", "operations");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "PRESENTATION.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata: { name: operations, version: 1.0.0, description: Browser operator layout }
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
`,
  );
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

function runStartedEvent(runId: string): RunStartedEvent {
  return {
    ...eventBase(runId, 1),
    type: "run_started",
    nodeIds: ["step"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: createHash("sha256").update("web-workflow").digest("hex"),
  };
}

function eventBase(runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-16T12:00:0${sequence}.000Z`,
    runId,
    workflowId: "web-workflow",
  };
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
