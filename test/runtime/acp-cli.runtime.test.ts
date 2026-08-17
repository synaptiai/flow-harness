import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { RunEvent, RunStartedEvent } from "../../src/domain/run/events.js";
import { JsonlRunStore } from "../../src/infrastructure/fs/jsonl-run-store.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repositoryRoot, "dist", "cli", "main.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("compiled Flow ACP bridge", () => {
  it("interoperates with an independent ACP v1 peer and survives process restart", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-runtime-")));
    temporaryDirectories.push(root);
    const runsDirectory = join(root, ".flow", "runs");
    const first = startBridge(root, runsDirectory);
    let sessionId: string;

    try {
      const peer = client({ name: "PRIVATE_INDEPENDENT_EDITOR" });
      sessionId = await withDeadline(
        peer.connectWith(first.stream, async (connection) => {
          await initialize(connection);
          const created = await connection.request(methods.agent.session.new, {
            cwd: root,
            mcpServers: [],
          });
          await expect(
            connection.request(methods.agent.session.list, { cwd: root }),
          ).resolves.toMatchObject({
            sessions: [{ sessionId: created.sessionId, cwd: root }],
          });
          return created.sessionId;
        }),
        "first ACP peer",
      );
      first.closeInput();
      await expect(withDeadline(first.completed, "first bridge exit")).resolves.toMatchObject({
        code: 0,
        stderr: "",
      });
    } finally {
      first.terminate();
    }

    await appendEvents(runsDirectory, terminalRunEvents(sessionId));
    const updates: unknown[] = [];
    const second = startBridge(root, runsDirectory);
    try {
      const peer = client({ name: "restart-editor" }).onNotification(
        methods.client.session.update,
        ({ params }) => {
          updates.push(params);
        },
      );
      await withDeadline(
        peer.connectWith(second.stream, async (connection) => {
          await initialize(connection);
          await expect(
            connection.request(methods.agent.session.list, { cwd: root }),
          ).resolves.toMatchObject({ sessions: [{ sessionId }] });
          await expect(
            connection.request(methods.agent.session.load, {
              sessionId,
              cwd: root,
              mcpServers: [],
            }),
          ).resolves.toEqual({});
          await expect(
            connection.request(methods.agent.session.resume, {
              sessionId,
              cwd: root,
              mcpServers: [],
            }),
          ).resolves.toEqual({});
        }),
        "restarted ACP peer",
      );
      second.closeInput();
      await expect(withDeadline(second.completed, "restarted bridge exit")).resolves.toMatchObject({
        code: 0,
        stderr: "",
      });
    } finally {
      second.terminate();
    }

    expect(updates).toContainEqual({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "flow-status:2",
        content: { type: "text", text: `Run ${sessionId} is cancelled at sequence 2.` },
      },
    });
    const publicOutput = JSON.stringify(updates);
    expect(publicOutput).not.toContain("PRIVATE_");
    expect(publicOutput).not.toContain("contentBase64");
    expect(publicOutput).not.toContain("rawInput");
    expect(publicOutput).not.toContain("rawOutput");
  });
});

function startBridge(
  cwd: string,
  runsDirectory: string,
): {
  readonly completed: Promise<{ readonly code: number | null; readonly stderr: string }>;
  readonly closeInput: () => void;
  readonly stream: ReturnType<typeof ndJsonStream>;
  readonly terminate: () => void;
} {
  const child = spawn(
    process.execPath,
    [cliPath, "acp", "--actor", "runtime-editor", "--runs-dir", runsDirectory],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stderr = captureStderr(child);
  const completed = new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolveProcess, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveProcess({ code, stderr: stderr.read() }));
    },
  );
  return {
    completed,
    closeInput: () => child.stdin.end(),
    stream: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}

function captureStderr(child: ChildProcessWithoutNullStreams): { readonly read: () => string } {
  let contents = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    contents = `${contents}${chunk}`.slice(0, 65_537);
  });
  return { read: () => contents };
}

async function initialize(connection: {
  request: (method: "initialize", params: { protocolVersion: number }) => Promise<unknown>;
}): Promise<void> {
  await connection.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
}

async function appendEvents(runsDirectory: string, events: readonly RunEvent[]): Promise<void> {
  const store = new JsonlRunStore(runsDirectory);
  for (const event of events) {
    await store.append(event);
  }
  await store.release(events[0]?.runId ?? "missing-run");
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
    workflowDigest: createHash("sha256").update("acp-runtime-workflow").digest("hex"),
  };
}

function eventBase(runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-17T10:00:0${sequence}.000Z`,
    runId,
    workflowId: "acp-runtime-workflow",
  };
}

async function withDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`ACP runtime timed out during ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
