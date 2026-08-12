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
          activeTimeMicros: null,
          kernelRequests: 1,
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
    expect(resultSink.publishResult).not.toHaveBeenCalled();
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
    expect(evidence.settlement).toEqual({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      kernelRequests: 1,
    });
    await evidence.publishResult();
    expect(resultSink.publishResult).toHaveBeenCalledOnce();
    expect(evidence.finishMetrics({ startedAtMs: 10.2, endedAtMs: 25.8 })).toEqual({
      ...unavailableEvaluationMetrics(),
      costUsdMicros: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      turns: 0,
      toolCalls: 0,
      toolErrors: null,
      wallTimeMs: 16,
      activeTimeMs: null,
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
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "ipython",
          arguments: { code: "raise RuntimeError('expected')" },
        },
      ],
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
      stopReason: "toolUse",
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
          metrics: {
            ...unavailableEvaluationMetrics(),
            turns: 1,
            toolCalls: 1,
            toolErrors: 1,
          },
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
          kernelRequests: 1,
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
      toolCalls: 1,
      toolErrors: 1,
      wallTimeMs: 1,
    });
  });

  it("rejects child-supplied active-time evidence in version one", async () => {
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "ready" }),
        driverFrame(1, "ready", { trialId, identityDigest }),
        driverFrame(2, "terminal", {
          harness: { outcome: "completed", runId: "prime-session", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
        frame(PrimeContainerFrameType.Terminal),
        frame(PrimeContainerFrameType.ResultStart, transferStart([])),
        frame(PrimeContainerFrameType.ResultComplete),
        frame(PrimeContainerFrameType.Settlement, {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          activeTimeMicros: 1,
          kernelRequests: 1,
        }),
      ]),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([], new Map()),
      resultSink: sink(),
      inferenceBroker: { infer: vi.fn() },
      validateReadiness: vi.fn(async () => undefined),
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    await expect(
      operator.operate(operationInput(async () => undefined, transport)),
    ).rejects.toThrow(/settlement.*closed schema/i);
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

  it("does not wait forever for a non-cooperative inference after cancellation", async () => {
    const controller = new AbortController();
    const fixtureEntry = fileEntry("TASK.md", "Task\n");
    const transport: PrimeOciAttachedTransport = {
      output: outputFrames([
        frame(PrimeContainerFrameType.Readiness, { version: 1, status: "ready" }),
        driverFrame(1, "ready", { trialId, identityDigest }),
        driverInferenceFrame(
          2,
          JSON.stringify({
            version: 1,
            model: { provider: "test", modelId: "test" },
            messages: [],
            settings: { maxTokens: 1, temperature: 0, thinkingLevel: "off" },
            timestamp: 1,
          }),
        ),
      ]),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const resultSink = sink();
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([fixtureEntry], new Map([[fixtureEntry.path, Buffer.from("Task\n")]])),
      resultSink,
      inferenceBroker: {
        infer: vi.fn(() => {
          controller.abort(new Error("Prime inference cancelled"));
          return new Promise<string>(() => undefined);
        }),
      },
      validateReadiness: vi.fn(async () => undefined),
      sessionIdFactory: () => sessionId,
      secretHexFactory: () => secretHex,
    });

    await expect(
      operator.operate({
        ...operationInput(async () => undefined, transport),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/inference cancelled/i);
    expect(resultSink.abort).toHaveBeenCalledOnce();
  });

  it("does not wait forever for silent transport output after cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("Prime output wait cancelled");
    let markNextStarted: () => void = () => undefined;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    const returnOutput = vi.fn(async () => ({ done: true as const, value: undefined }));
    const outputIterator: AsyncIterator<Uint8Array> = {
      next: () => {
        markNextStarted();
        return new Promise<IteratorResult<Uint8Array>>(() => undefined);
      },
      return: returnOutput,
    };
    const resultSink = sink();
    const transport: PrimeOciAttachedTransport = {
      output: { [Symbol.asyncIterator]: () => outputIterator },
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const broker = { infer: vi.fn(), close: vi.fn(async () => undefined) };
    const operator = new AttachedPrimeOciOperator({
      fixture: fixture([], new Map()),
      resultSink,
      inferenceBroker: broker,
      validateReadiness: vi.fn(async () => undefined),
    });
    const operation = operator.operate({
      ...operationInput(async () => undefined, transport),
      signal: controller.signal,
    });

    await nextStarted;
    controller.abort(cancellation);
    const outcome = await Promise.race([
      operation.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).not.toBe("hung");
    expect(errorGraphText(outcome)).toContain(cancellation.message);
    expect(returnOutput).toHaveBeenCalledOnce();
    expect(resultSink.abort).toHaveBeenCalledOnce();
    expect(transport.closeInput).toHaveBeenCalledOnce();
    expect(broker.close).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, "PRIVATE_TRANSPORT_REJECTION"])(
    "normalizes a non-Error transport-write rejection without skipping cleanup",
    async (rejection) => {
      const checkpoints: string[] = [];
      const resultSink = sink();
      const outputIterator = vi.fn(() => outputFrames([])[Symbol.asyncIterator]());
      const transport: PrimeOciAttachedTransport = {
        output: { [Symbol.asyncIterator]: outputIterator },
        write: vi.fn(async () => {
          throw rejection;
        }),
        closeInput: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      };
      const broker = {
        infer: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const operator = new AttachedPrimeOciOperator({
        fixture: fixture([], new Map()),
        resultSink,
        inferenceBroker: broker,
        validateReadiness: vi.fn(async () => undefined),
      });

      const error = await operator
        .operate(
          operationInput(async (checkpoint) => {
            checkpoints.push(checkpoint);
          }, transport),
        )
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Prime OCI transport write failed");
      expect((error as Error).cause).toBeUndefined();
      expect(errorGraphText(error)).not.toContain("PRIVATE_TRANSPORT_REJECTION");
      expect(resultSink.abort).toHaveBeenCalledWith(error);
      expect(transport.closeInput).toHaveBeenCalledOnce();
      expect(broker.close).toHaveBeenCalledOnce();
      expect(outputIterator).not.toHaveBeenCalled();
      expect(checkpoints).toEqual([]);
    },
  );

  it.each([null, undefined, "PRIVATE_OPERATION_REJECTION"])(
    "normalizes a non-Error operation rejection without retaining its value",
    async (rejection) => {
      const checkpoints: string[] = [];
      const resultSink = sink();
      const transport: PrimeOciAttachedTransport = {
        output: (async function* () {
          yield await Promise.reject<Uint8Array>(rejection);
        })(),
        write: vi.fn(async () => undefined),
        closeInput: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      };
      const broker = {
        infer: vi.fn(),
        close: vi.fn(async () => undefined),
      };
      const operator = new AttachedPrimeOciOperator({
        fixture: fixture([], new Map()),
        resultSink,
        inferenceBroker: broker,
        validateReadiness: vi.fn(async () => undefined),
      });

      const error = await operator
        .operate(
          operationInput(async (checkpoint) => {
            checkpoints.push(checkpoint);
          }, transport),
        )
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Prime OCI operation failed");
      expect((error as Error).cause).toBeUndefined();
      expect(errorGraphText(error)).not.toContain("PRIVATE_OPERATION_REJECTION");
      expect(resultSink.abort).toHaveBeenCalledWith(error);
      expect(transport.closeInput).toHaveBeenCalledOnce();
      expect(broker.close).toHaveBeenCalledOnce();
      expect(checkpoints).toEqual([]);
    },
  );

  it.each([
    {
      cleanupStage: "result abort",
      publicMessage: "Prime OCI result abort failed",
      rejection: "PRIVATE_RESULT_ABORT",
    },
    {
      cleanupStage: "input close",
      publicMessage: "Prime OCI transport input close failed",
      rejection: null,
    },
    {
      cleanupStage: "broker close",
      publicMessage: "Prime OCI inference broker close failed",
      rejection: undefined,
    },
  ])(
    "normalizes a non-Error $cleanupStage rejection and completes later cleanup",
    async ({ cleanupStage, publicMessage, rejection }) => {
      const primaryError = new Error("fixed primary operation failure");
      const resultSink = sink();
      if (cleanupStage === "result abort") {
        vi.mocked(resultSink.abort).mockRejectedValueOnce(rejection);
      }
      const transport: PrimeOciAttachedTransport = {
        output: (async function* () {
          yield await Promise.reject<Uint8Array>(primaryError);
        })(),
        write: vi.fn(async () => undefined),
        closeInput: vi.fn(async () => {
          if (cleanupStage === "input close") {
            throw rejection;
          }
        }),
        release: vi.fn(async () => undefined),
      };
      const broker = {
        infer: vi.fn(),
        close: vi.fn(async () => {
          if (cleanupStage === "broker close") {
            throw rejection;
          }
        }),
      };
      const operator = new AttachedPrimeOciOperator({
        fixture: fixture([], new Map()),
        resultSink,
        inferenceBroker: broker,
        validateReadiness: vi.fn(async () => undefined),
      });

      const error = await operator
        .operate(operationInput(async () => undefined, transport))
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect((error as AggregateError).errors[0]).toBe(primaryError);
      expect((error as AggregateError).errors[1]).toMatchObject({ message: publicMessage });
      expect(((error as AggregateError).errors[1] as Error).cause).toBeUndefined();
      expect(errorGraphText(error)).not.toContain("PRIVATE_RESULT_ABORT");
      expect(resultSink.abort).toHaveBeenCalledOnce();
      expect(transport.closeInput).toHaveBeenCalledOnce();
      expect(broker.close).toHaveBeenCalledOnce();
    },
  );
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
        executables: {
          docker: { path: "/usr/bin/docker", sha256: identity.runtime.client.executableSha256 },
          dockerd: { path: "/usr/bin/dockerd", sha256: identity.runtime.engine.dockerdSha256 },
          containerd: {
            path: "/usr/bin/containerd",
            sha256: identity.runtime.engine.containerdSha256,
          },
          runc: { path: "/usr/bin/runc", sha256: identity.runtime.engine.runcSha256 },
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
  readonly publishResult: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
} {
  return {
    begin: vi.fn(async () => undefined),
    addEntry: vi.fn(async () => undefined),
    addChunk: vi.fn(async () => undefined),
    endFile: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    publishResult: vi.fn(async () => undefined),
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

function errorGraphText(error: unknown): string {
  const values: string[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof Error) {
      values.push(current.message);
      pending.push(current.cause);
      if (current instanceof AggregateError) {
        pending.push(...current.errors);
      }
    } else if (typeof current === "string") {
      values.push(current);
    }
  }
  return values.join("\n");
}
