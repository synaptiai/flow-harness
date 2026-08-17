import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import type { RunEvent, RunStartedEvent } from "../../../src/domain/run/events.js";
import { createStrictAcpStream } from "../../../src/infrastructure/acp/strict-acp-stream.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { LocalAcpSessionStore } from "../../../src/infrastructure/fs/local-acp-session-store.js";
import { LocalSupervisorStore } from "../../../src/infrastructure/fs/local-supervisor-store.js";
import { startSupervisorServer } from "../../../src/supervisor/daemon.js";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  type WorkerResponse,
} from "../../../src/supervisor/protocol.js";
import { type JobRecord, parseWorkerDescriptor } from "../../../src/supervisor/records.js";
import type { WorkerLauncher } from "../../../src/supervisor/service.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("flow acp", () => {
  it("rejects missing actor before configuration or transport creation", async () => {
    const capture = createCapture();
    let loadConfigCalls = 0;
    let transportCalls = 0;

    const exitCode = await main(["acp"], capture.io, {
      loadConfig: async () => {
        loadConfigCalls += 1;
        return resolveFlowConfig({});
      },
      createAcpByteTransport: () => {
        transportCalls += 1;
        throw new Error("transport must not be created");
      },
    });

    expect(exitCode).toBe(2);
    expect(capture.stderr[0]).toMatch(/^acp requires --actor <label>\n\nFlow/);
    expect(loadConfigCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it("does not expose a private bridge setup failure", async () => {
    const capture = createCapture();

    const exitCode = await main(["acp", "--actor", "editor-user"], capture.io, {
      loadConfig: async () => {
        throw new Error("PRIVATE_PROJECT_PATH");
      },
      createAcpByteTransport: () => {
        throw new Error("transport must not be created");
      },
    });

    expect(exitCode).toBe(1);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual(["Cannot start Flow ACP bridge"]);
    expect(JSON.stringify(capture)).not.toContain("PRIVATE_PROJECT_PATH");
  });

  it("replays and observes a durable run through strict ACP byte streams", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-acp-cli-"));
    temporaryDirectories.push(root);
    const projectRoot = await realpath(root);
    const runsDirectory = join(projectRoot, ".flow", "runs");
    const policy = resolveFlowConfig({ projectRoot });
    await appendEvents(runsDirectory, terminalRunEvents(SESSION_ID));
    await new LocalAcpSessionStore(runsDirectory).create({
      sessionId: SESSION_ID,
      projectRoot,
      policyDigest: policy.policyDigest,
      actor: "editor-user",
      createdAt: "2026-08-17T10:00:00.000Z",
    });
    const supervisor = await startSupervisorServer({
      store: new LocalSupervisorStore(runsDirectory),
      launcher: unavailableLauncher,
    });
    const clientToAgent = controllableBytePipe();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const updates: unknown[] = [];
    const peer = client({ name: "independent-test-editor" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        updates.push(params);
      },
    );
    const capture = createCapture();

    try {
      const server = main(
        ["acp", "--actor", "editor-user", "--runs-dir", runsDirectory],
        capture.io,
        {
          cwd: projectRoot,
          loadConfig: async () => policy,
          readTextFile: async () => {
            throw new Error("PRIVATE_LIVE_WORKFLOW_READ");
          },
          createAcpByteTransport: () => ({
            input: clientToAgent.readable,
            output: agentToClient.writable,
          }),
        },
      );
      const peerStream = createStrictAcpStream({
        input: agentToClient.readable,
        output: clientToAgent.writable,
      });

      await withDeadline(
        peer.connectWith(peerStream, async (connection) => {
          await withDeadline(
            connection.request(methods.agent.initialize, {
              protocolVersion: PROTOCOL_VERSION,
            }),
            "initialize",
          );
          await expect(
            withDeadline(
              connection.request(methods.agent.session.load, {
                sessionId: SESSION_ID,
                cwd: projectRoot,
                mcpServers: [],
              }),
              "load",
            ),
          ).resolves.toEqual({});
          await expect(
            withDeadline(
              connection.request(methods.agent.session.prompt, {
                sessionId: SESSION_ID,
                prompt: [{ type: "text", text: "/flow-continue" }],
              }),
              "continue",
            ),
          ).resolves.toEqual({ stopReason: "end_turn" });
        }),
        "peer shutdown",
      );
      clientToAgent.closeReadable();

      await expect(withDeadline(server, "server shutdown")).resolves.toBe(0);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toEqual([]);
      expect(updates).toContainEqual({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "flow-status:2",
          content: {
            type: "text",
            text: `Run ${SESSION_ID} is cancelled at sequence 2.`,
          },
        },
      });
      const encoded = JSON.stringify(updates);
      expect(encoded).not.toContain("contentBase64");
      expect(encoded).not.toContain("rawInput");
      expect(encoded).not.toContain("rawOutput");
    } finally {
      await supervisor.close();
    }
  });

  it("closes an empty durable session without inventing a run cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-acp-close-empty-"));
    temporaryDirectories.push(root);
    const projectRoot = await realpath(root);
    const runsDirectory = join(projectRoot, ".flow", "runs");
    const policy = resolveFlowConfig({ projectRoot });
    const supervisor = await startSupervisorServer({
      store: new LocalSupervisorStore(runsDirectory),
      launcher: unavailableLauncher,
    });
    const clientToAgent = controllableBytePipe();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const peer = client({ name: "independent-test-editor" });
    const capture = createCapture();

    try {
      const server = main(
        ["acp", "--actor", "editor-user", "--runs-dir", runsDirectory],
        capture.io,
        {
          cwd: projectRoot,
          loadConfig: async () => policy,
          createAcpByteTransport: () => ({
            input: clientToAgent.readable,
            output: agentToClient.writable,
          }),
        },
      );
      const peerStream = createStrictAcpStream({
        input: agentToClient.readable,
        output: clientToAgent.writable,
      });

      await withDeadline(
        peer.connectWith(peerStream, async (connection) => {
          await connection.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
          });
          const created = await connection.request(methods.agent.session.new, {
            cwd: projectRoot,
            mcpServers: [],
          });
          await expect(
            connection.request(methods.agent.session.close, { sessionId: created.sessionId }),
          ).resolves.toEqual({});
        }),
        "empty session close",
      );
      clientToAgent.closeReadable();

      await expect(withDeadline(server, "server shutdown")).resolves.toBe(0);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toEqual([]);
    } finally {
      clientToAgent.closeReadable();
      await supervisor.close();
    }
  });

  it("cross-binds an ACP workflow submission through the durable supervisor path", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-acp-submit-"));
    temporaryDirectories.push(root);
    const projectRoot = await realpath(root);
    const runsDirectory = join(projectRoot, ".flow", "runs");
    const workflowSource = "acp.workflow.yaml";
    const workflowPath = join(projectRoot, workflowSource);
    await writeFile(
      workflowPath,
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: acp-submission }
nodes:
  - id: step
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, "process.exit(0)"]
`,
      { encoding: "utf8", flag: "wx" },
    );
    const policy = resolveFlowConfig({ projectRoot });
    const supervisorStore = new LocalSupervisorStore(runsDirectory);
    const launcher = new TerminalWorkerLauncher(supervisorStore, runsDirectory);
    const supervisor = await startSupervisorServer({ store: supervisorStore, launcher });
    const clientToAgent = controllableBytePipe();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const peer = client({ name: "independent-test-editor" }).onNotification(
      methods.client.session.update,
      () => undefined,
    );
    const capture = createCapture();
    let loadConfigCalls = 0;
    let sessionId = "";
    let promptOutcome: unknown;

    try {
      const server = main(
        ["acp", "--actor", "editor-user", "--runs-dir", runsDirectory],
        capture.io,
        {
          cwd: projectRoot,
          loadConfig: async () => {
            loadConfigCalls += 1;
            if (loadConfigCalls > 1) {
              throw new Error("PRIVATE_POLICY_RELOAD");
            }
            return policy;
          },
          createAcpByteTransport: () => ({
            input: clientToAgent.readable,
            output: agentToClient.writable,
          }),
        },
      );
      const peerStream = createStrictAcpStream({
        input: agentToClient.readable,
        output: clientToAgent.writable,
      });

      await withDeadline(
        peer.connectWith(peerStream, async (connection) => {
          await connection.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
          });
          const created = await connection.request(methods.agent.session.new, {
            cwd: projectRoot,
            mcpServers: [],
          });
          sessionId = created.sessionId;
          const prompt = connection
            .request(methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: `/flow-run ${workflowSource}` }],
            })
            .catch((error: unknown) => error);
          await expect(
            withDeadline(
              Promise.race([
                launcher.launchStarted.then(() => "launched"),
                prompt.then(() => "prompt-settled"),
              ]),
              "worker launch",
            ),
          ).resolves.toBe("launched");
          await expect(
            Promise.race([prompt.then(() => "settled"), delay(50, "pending")]),
          ).resolves.toBe("pending");
          await launcher.publishRun(sessionId);
          promptOutcome = await prompt;
        }),
        "workflow submission",
      );
      clientToAgent.closeReadable();
      await expect(withDeadline(server, "server shutdown")).resolves.toBe(0);

      const descriptor = await new LocalAcpSessionStore(runsDirectory).read(sessionId, {
        projectRoot,
        policyDigest: policy.policyDigest,
      });
      expect(descriptor).toMatchObject({
        sessionId,
        runId: sessionId,
        projectRoot,
        policyDigest: policy.policyDigest,
        actor: "editor-user",
      });
      await expect(supervisorStore.readCommand(sessionId)).resolves.toMatchObject({
        type: "submit",
        commandId: sessionId,
        runId: sessionId,
        policyDigest: policy.policyDigest,
        sourceName: workflowPath,
        status: "completed",
      });
      await expect(new JsonlRunStore(runsDirectory).read(sessionId)).resolves.toEqual(
        terminalRunEvents(sessionId, "acp-submission"),
      );
      expect(launcher.jobs).toHaveLength(1);
      expect(loadConfigCalls).toBe(1);
      expect(capture.stdout).toEqual([]);
      expect(capture.stderr).toEqual([]);
      expect(promptOutcome).toEqual({ stopReason: "end_turn" });
    } finally {
      clientToAgent.closeReadable();
      await supervisor.close();
    }
  });
});

async function appendEvents(runsDirectory: string, events: readonly RunEvent[]): Promise<void> {
  const runId = events[0]?.runId;
  if (runId === undefined) {
    throw new Error("ACP test events require one run identity");
  }
  const store = new JsonlRunStore(runsDirectory);
  for (const event of events) {
    await store.append(event);
  }
  await store.release(runId);
}

function terminalRunEvents(runId: string, workflowId = "acp-workflow"): readonly RunEvent[] {
  return [
    runStartedEvent(runId, workflowId),
    {
      ...eventBase(runId, 2, workflowId),
      type: "run_cancelled",
      reason: "operator request",
      actor: "operator:test",
      requestId: "00000000-0000-4000-8000-000000000001",
    },
  ];
}

function runStartedEvent(runId: string, workflowId = "acp-workflow"): RunStartedEvent {
  return {
    ...eventBase(runId, 1, workflowId),
    type: "run_started",
    nodeIds: ["step"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: createHash("sha256").update(workflowId).digest("hex"),
  };
}

function eventBase(runId: string, sequence: number, workflowId = "acp-workflow") {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-17T10:00:0${sequence}.000Z`,
    runId,
    workflowId,
  };
}

class TerminalWorkerLauncher implements WorkerLauncher {
  readonly jobs: JobRecord[] = [];
  readonly launchStarted: Promise<void>;
  readonly #markLaunchStarted: () => void;

  constructor(
    private readonly store: LocalSupervisorStore,
    private readonly runsDirectory: string,
  ) {
    const launchStarted = deferred();
    this.launchStarted = launchStarted.promise;
    this.#markLaunchStarted = launchStarted.resolve;
  }

  async launch(job: JobRecord) {
    this.jobs.push(job);
    const descriptor = parseWorkerDescriptor({
      version: 1,
      workerId: job.workerId,
      jobId: job.jobId,
      runId: job.runId,
      pid: 4321,
      token: job.token,
      jobDigest: job.digest,
      socketPath: join(this.store.socketDirectory, "acp-worker.sock"),
      status: "running",
      runStatus: "running",
      startedAt: job.createdAt,
      updatedAt: job.createdAt,
    });
    await this.store.writeWorkerDescriptor(descriptor);
    this.#markLaunchStarted();
    return descriptor;
  }

  async publishRun(runId: string): Promise<void> {
    await appendEvents(this.runsDirectory, terminalRunEvents(runId, "acp-submission"));
  }

  async request(
    descriptor: Awaited<ReturnType<TerminalWorkerLauncher["launch"]>>,
  ): Promise<WorkerResponse> {
    return {
      version: SUPERVISOR_PROTOCOL_VERSION,
      requestId: "00000000-0000-4000-8000-000000000002",
      ok: true,
      result: {
        type: "identity",
        workerId: descriptor.workerId,
        runId: descriptor.runId,
        pid: descriptor.pid,
        jobDigest: descriptor.jobDigest,
        status: descriptor.status,
        runStatus: "running",
      },
    };
  }
}

const unavailableLauncher: WorkerLauncher = {
  async launch() {
    throw new Error("worker launch is not used by ACP replay tests");
  },
  async request() {
    throw new Error("worker request is not used by ACP replay tests");
  },
};

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

async function withDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`ACP test timed out during ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function delay<T>(milliseconds: number, value: T): Promise<T> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  return value;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Cannot create ACP integration deferred");
  }
  return { promise, resolve: resolvePromise };
}

function controllableBytePipe(): {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closeReadable: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController;
    },
  });
  return {
    readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        if (closed || controller === undefined) {
          throw new Error("test byte pipe is closed");
        }
        controller.enqueue(chunk.slice());
      },
      close() {
        if (!closed) {
          closed = true;
          controller?.close();
        }
      },
    }),
    closeReadable: () => {
      if (!closed) {
        closed = true;
        controller?.close();
      }
    },
  };
}
