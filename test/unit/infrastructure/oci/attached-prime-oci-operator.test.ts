import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  parseExternalHarnessParentLine,
  signExternalHarnessDriverFrame,
} from "../../../../src/domain/evaluation/external-harness-protocol.js";
import { unavailableEvaluationMetrics } from "../../../../src/domain/evaluation/records.js";
import {
  AttachedPrimeOciOperator,
  type PrimeOciAttachedTransport,
  type PrimeOciFixtureSource,
  type PrimeOciResultSink,
} from "../../../../src/infrastructure/oci/attached-prime-oci-operator.js";
import type { PrimeOciOperationInput } from "../../../../src/infrastructure/oci/local-prime-oci-harness-runtime.js";
import {
  createPrimeContainerManifestSha256,
  encodePrimeContainerFrame,
  PrimeContainerFrameDecoder,
  PrimeContainerFrameType,
  type PrimeContainerManifestEntry,
} from "../../../../src/infrastructure/prime/prime-container-protocol.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

const sessionId = "018f4ee8-9d67-7ca1-a31f-4f3f2388e934";
const secretHex = "1".repeat(64);
const identityDigest = "e".repeat(64);
const trialId = `trial-${"b".repeat(48)}`;

describe("attached Prime OCI operator", () => {
  it("moves one validated fixture and result through the authenticated protocol", async () => {
    const fixtureEntry = fileEntry("TASK.md", "Task\n");
    const resultEntry = fileEntry("RESULT.md", "DONE\n");
    const writes: Buffer[] = [];
    const checkpoints: string[] = [];
    const readiness = vi.fn(async () => undefined);
    const resultSink = sink();
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "ready" }),
        driverFrame(1, "ready", { trialId, identityDigest }),
        driverFrame(2, "terminal", {
          harness: { outcome: "completed", runId: "prime-session", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
        frame(PrimeContainerFrameType.Terminal),
        frame(PrimeContainerFrameType.ResultStart, transferStart([resultEntry])),
        frame(PrimeContainerFrameType.ResultEntry, resultEntry),
        encodePrimeContainerFrame(PrimeContainerFrameType.ResultChunk, Buffer.from("DONE\n")),
        frame(PrimeContainerFrameType.ResultFileEnd),
        frame(PrimeContainerFrameType.ResultComplete),
        frame(PrimeContainerFrameType.Settlement, {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          activeTimeMicros: 1_234,
        }),
      ]),
      write: vi.fn(async (bytes) => {
        writes.push(Buffer.from(bytes));
      }),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([fixtureEntry], new Map([[fixtureEntry.path, Buffer.from("Task\n")]])),
      resultSink,
      inferenceBroker: { infer: vi.fn() },
      validateReadiness: readiness,
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    const evidence = await operator.operate(
      operationInput(async (checkpoint) => {
        checkpoints.push(checkpoint);
      }, transport),
    );

    expect(readiness).toHaveBeenCalledOnce();
    expect(checkpoints).toEqual(["terminal", "exported"]);
    expect(resultSink.commit).toHaveBeenCalledWith([resultEntry], undefined);
    expect(resultSink.abort).not.toHaveBeenCalled();
    expect(transport.closeInput).toHaveBeenCalledOnce();
    expect(decodeTypes(writes)).toEqual([
      PrimeContainerFrameType.AttestationChallenge,
      PrimeContainerFrameType.FixtureStart,
      PrimeContainerFrameType.FixtureEntry,
      PrimeContainerFrameType.FixtureChunk,
      PrimeContainerFrameType.FixtureFileEnd,
      PrimeContainerFrameType.FixtureComplete,
      PrimeContainerFrameType.Bootstrap,
    ]);
    const bootstrap = decodeFrames(writes).find(
      (item) => item.type === PrimeContainerFrameType.Bootstrap,
    );
    expect(
      parseExternalHarnessParentLine(bootstrap?.payload.toString("utf8") ?? "").payload,
    ).toMatchObject({ evaluation: { workspace: { cwd: "/workspace" } } });
    expect(evidence.harness).toEqual({
      outcome: "completed",
      runId: "prime-session",
      reason: null,
    });
    expect(evidence.settlement).toEqual({ exitCode: 0, timedOut: false, aborted: false });
    expect(evidence.finishMetrics({ startedAtMs: 10.2, endedAtMs: 25.8 })).toEqual({
      ...unavailableEvaluationMetrics(),
      costUsdMicros: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      wallTimeMs: 16,
      activeTimeMs: 2,
      interventions: 0,
      recoveryAttempts: 0,
      recoveryOutcome: "not_attempted",
    });
  });

  it("routes inference through the host broker and records host response metrics", async () => {
    const fixtureEntry = fileEntry("TASK.md", "Task\n");
    const resultEntry = fileEntry("RESULT.md", "DONE\n");
    const inferenceBody = JSON.stringify({ version: 1, context: { messages: [] } });
    const responseBody = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "flow-host-inference-v1",
      provider: "flow-host-broker",
      model: "flow-host-model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000001 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const writes: Buffer[] = [];
    const broker = {
      infer: vi.fn(async () => responseBody),
      close: vi.fn(async () => undefined),
    };
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "ready" }),
        driverFrame(1, "ready", { trialId, identityDigest }),
        driverInferenceFrame(2, inferenceBody),
        driverFrame(3, "terminal", {
          harness: { outcome: "completed", runId: "prime-session", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
        frame(PrimeContainerFrameType.Terminal),
        frame(PrimeContainerFrameType.ResultStart, transferStart([resultEntry])),
        frame(PrimeContainerFrameType.ResultEntry, resultEntry),
        encodePrimeContainerFrame(PrimeContainerFrameType.ResultChunk, Buffer.from("DONE\n")),
        frame(PrimeContainerFrameType.ResultFileEnd),
        frame(PrimeContainerFrameType.ResultComplete),
        frame(PrimeContainerFrameType.Settlement, {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          activeTimeMicros: null,
        }),
      ]),
      write: vi.fn(async (bytes) => {
        writes.push(Buffer.from(bytes));
      }),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([fixtureEntry], new Map([[fixtureEntry.path, Buffer.from("Task\n")]])),
      resultSink: sink(),
      inferenceBroker: broker,
      validateReadiness: vi.fn(async () => undefined),
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    const evidence = await operator.operate(operationInput(async () => undefined, transport));

    expect(broker.infer).toHaveBeenCalledOnce();
    expect(broker.close).toHaveBeenCalledOnce();
    const parentResponse = decodeFrames(writes).findLast(
      (item) => item.type === PrimeContainerFrameType.Driver,
    );
    expect(parentResponse).toBeDefined();
    expect(
      parseExternalHarnessParentLine(parentResponse?.payload.toString("utf8") ?? "", secretHex),
    ).toMatchObject({ type: "inference_response", payload: { body: responseBody } });
    expect(evidence.finishMetrics({ startedAtMs: 0, endedAtMs: 1 })).toMatchObject({
      costUsdMicros: 1,
      inputTokens: 1,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputTokens: 2,
      turns: 1,
      wallTimeMs: 1,
    });
  });

  it("does not send fixture bytes or the secret after readiness rejection", async () => {
    const fixtureEntry = fileEntry("TASK.md", "Task\n");
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "changed" }),
      ]),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const resultSink = sink();
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([fixtureEntry], new Map([[fixtureEntry.path, Buffer.from("Task\n")]])),
      resultSink,
      inferenceBroker: { infer: vi.fn() },
      validateReadiness: vi.fn(async () => {
        throw new Error("effective policy changed");
      }),
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    await expect(
      operator.operate(operationInput(async () => undefined, transport)),
    ).rejects.toThrow(/policy changed/i);
    expect(
      decodeTypes((transport.write as ReturnType<typeof vi.fn>).mock.calls.map(([bytes]) => bytes)),
    ).toEqual([PrimeContainerFrameType.AttestationChallenge]);
    expect(resultSink.abort).toHaveBeenCalledOnce();
  });

  it("rejects changed result bytes before commit and before the exported checkpoint", async () => {
    const fixtureEntry = fileEntry("TASK.md", "Task\n");
    const resultEntry = fileEntry("RESULT.md", "DONE\n");
    const checkpoints: string[] = [];
    const resultSink = sink();
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "ready" }),
        driverFrame(1, "ready", { trialId, identityDigest }),
        driverFrame(2, "terminal", {
          harness: { outcome: "completed", runId: "prime-session", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
        frame(PrimeContainerFrameType.Terminal),
        frame(PrimeContainerFrameType.ResultStart, transferStart([resultEntry])),
        frame(PrimeContainerFrameType.ResultEntry, resultEntry),
        encodePrimeContainerFrame(PrimeContainerFrameType.ResultChunk, Buffer.from("FAIL\n")),
        frame(PrimeContainerFrameType.ResultFileEnd),
      ]),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([fixtureEntry], new Map([[fixtureEntry.path, Buffer.from("Task\n")]])),
      resultSink,
      inferenceBroker: { infer: vi.fn() },
      validateReadiness: vi.fn(async () => undefined),
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    await expect(
      operator.operate(
        operationInput(async (checkpoint) => {
          checkpoints.push(checkpoint);
        }, transport),
      ),
    ).rejects.toThrow(/sha-256/i);
    expect(checkpoints).toEqual(["terminal"]);
    expect(resultSink.commit).not.toHaveBeenCalled();
    expect(resultSink.abort).toHaveBeenCalledOnce();
  });

  it("does not wait forever for a non-cooperative broker close after cancellation", async () => {
    const controller = new AbortController();
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([]),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([], new Map()),
      resultSink: sink(),
      inferenceBroker: {
        infer: vi.fn(),
        close: vi.fn(() => {
          controller.abort(new Error("Prime operation cancelled during broker close"));
          return new Promise<void>(() => undefined);
        }),
      },
      validateReadiness: vi.fn(async () => undefined),
    });
    const input = {
      ...operationInput(async () => undefined, transport),
      signal: controller.signal,
    };

    const outcome = await Promise.race([
      operator.operate(input).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).toBe("rejected");
  });
});

function operationInput(
  checkpoint: PrimeOciOperationInput["checkpoint"],
  transport: PrimeOciAttachedTransport,
): PrimeOciOperationInput {
  const identity = primeExternalHarnessIdentity();
  return {
    request: {
      identity,
      evaluation: {
        planDigest: "a".repeat(64),
        trial: {
          trialId,
          position: 1,
          taskId: "task",
          profileId: "candidate",
          seed: 11,
          repetition: 1,
        },
        workspace: {
          workspaceId: `workspace-${trialId}`,
          cwd: "/host/private/evaluations/workspace",
          backend: "reflink-copy-v1",
          snapshotDigest: "c".repeat(64),
        },
        instruction: { path: "TASK.md", sha256: "d".repeat(64) },
        controls: {
          model: { provider: "test", id: "model", thinking: "off" },
          budget: {
            maxNodeStarts: 8,
            maxModelTokens: 4_096,
            maxCostUsdMicros: 100_000,
            maxExecutionMs: 30_000,
            maxArtifactBytes: 1_048_576,
          },
          network: "deny",
          retry: { providerRetries: 0, harnessRetries: 0 },
        },
        durability: { updateOciLease: async () => undefined },
      },
      isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
    },
    descriptor: {
      identity,
      identityDigest,
      localRuntime: {
        daemonId: "daemon-test-id",
        socketPath: "/var/run/docker.sock",
        socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
        apiVersion: "1.51",
        cgroupPath: "/sys/fs/cgroup/flow-prime",
        corePattern: "core",
        globalLeasePath: "/var/lib/flow-prime/global-slot.json",
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        imageProbe: {
          executablePath: "/usr/bin/dd",
          executableSha256: "b".repeat(64),
          readBytesPerSecond: 134_217_728,
          readOperationsPerSecond: 8_192,
        },
        leaseTarget: "flow-prime-global-v1",
        seccompProfile: { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] },
      },
      assertCurrent: vi.fn(async () => undefined),
    },
    containerId: "f".repeat(64),
    transport,
    checkpoint,
  };
}

function fixture(
  entries: readonly PrimeContainerManifestEntry[],
  contents: ReadonlyMap<string, Buffer>,
): PrimeOciFixtureSource {
  return {
    start: transferStart(entries),
    instructionText: "Task\n",
    async *parts() {
      for (const entry of entries) {
        yield { type: "entry" as const, entry };
        if (entry.type === "file") {
          yield { type: "chunk" as const, bytes: contents.get(entry.path) ?? Buffer.alloc(0) };
          yield { type: "file-end" as const };
        }
      }
    },
  };
}

function sink(): PrimeOciResultSink & {
  readonly commit: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
} {
  return {
    begin: vi.fn(async () => undefined),
    addEntry: vi.fn(async () => undefined),
    addChunk: vi.fn(async () => undefined),
    endFile: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
}

function fileEntry(path: string, content: string): PrimeContainerManifestEntry {
  const bytes = Buffer.from(content);
  return {
    path,
    type: "file",
    mode: 0o644,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function transferStart(entries: readonly PrimeContainerManifestEntry[]) {
  return {
    entryCount: entries.length,
    totalBytes: entries.reduce(
      (total, entry) => total + (entry.type === "file" ? entry.size : 0),
      0,
    ),
    manifestSha256: createPrimeContainerManifestSha256(entries),
  };
}

function frame(type: PrimeContainerFrameType, payload?: unknown): Buffer {
  return encodePrimeContainerFrame(
    type,
    payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload)),
  );
}

function driverFrame(sequence: number, type: "ready" | "terminal", payload: unknown): Buffer {
  return encodePrimeContainerFrame(
    PrimeContainerFrameType.Driver,
    Buffer.from(
      JSON.stringify(
        signExternalHarnessDriverFrame(
          { version: 1, sequence, sessionId, type, payload },
          secretHex,
        ),
      ),
    ),
  );
}

function driverInferenceFrame(sequence: number, body: string): Buffer {
  return encodePrimeContainerFrame(
    PrimeContainerFrameType.Driver,
    Buffer.from(
      JSON.stringify(
        signExternalHarnessDriverFrame(
          {
            version: 1,
            sequence,
            sessionId,
            type: "inference_request",
            payload: {
              requestId: "018f4ee8-9d67-7ca1-a31f-4f3f2388e935",
              body,
              bodySha256: createHash("sha256").update(body).digest("hex"),
            },
          },
          secretHex,
        ),
      ),
    ),
  );
}

async function* outputFrames(frames: readonly Buffer[]): AsyncIterable<Uint8Array> {
  yield Buffer.concat(frames);
}

function decodeTypes(writes: readonly Buffer[]): PrimeContainerFrameType[] {
  return decodeFrames(writes).map((item) => item.type);
}

function decodeFrames(writes: readonly Buffer[]) {
  const decoder = new PrimeContainerFrameDecoder();
  const frames = writes.flatMap((write) => decoder.push(write));
  decoder.finish();
  return frames;
}
