import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
});

async function appendEvents(runsDirectory: string, events: readonly RunEvent[]): Promise<void> {
  const store = new JsonlRunStore(runsDirectory);
  for (const event of events) {
    await store.append(event);
  }
  await store.release(SESSION_ID);
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
    workflowDigest: createHash("sha256").update("acp-workflow").digest("hex"),
  };
}

function eventBase(runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-17T10:00:0${sequence}.000Z`,
    runId,
    workflowId: "acp-workflow",
  };
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
