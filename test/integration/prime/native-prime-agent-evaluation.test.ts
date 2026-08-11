import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePrimeOciImageIdentity } from "../../../src/domain/evaluation/external-harness.js";
import {
  AttachedPrimeOciOperator,
  type PrimeOciAttachedTransport,
} from "../../../src/infrastructure/oci/attached-prime-oci-operator.js";
import { DurablePrimeWorkspacePublisher } from "../../../src/infrastructure/oci/durable-prime-workspace-publisher.js";
import type { PrimeOciOperationInput } from "../../../src/infrastructure/oci/local-prime-oci-harness-runtime.js";
import {
  createLocalPrimeOciFixtureSource,
  StagedPrimeOciResultSink,
} from "../../../src/infrastructure/oci/local-prime-workspace-transfer.js";
import type { NativePrimeHarnessDescriptor } from "../../../src/infrastructure/prime/native-prime-harness-registry.js";
import { NativePrimeHostInferenceBroker } from "../../../src/infrastructure/prime/native-prime-host-inference-broker.js";
import {
  createPrimeContainerManifestSha256,
  type PrimeContainerManifestEntry,
} from "../../../src/infrastructure/prime/prime-container-protocol.js";
import { primeExternalHarnessIdentity } from "../../fixtures/evaluation/prime-external-harness-identity.js";

const linux = process.platform === "linux" && process.arch === "x64";
const instruction = "Use IPython twice. Keep state. Write the final value to RESULT.md.\n";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linux)("real native Prime Agent evaluation", () => {
  it("keeps one persistent IPython kernel across two tool calls", async () => {
    const image = readVerifiedImage();
    const workspace = await mkdtemp(join(tmpdir(), "flow-prime-real-session-"));
    temporaryDirectories.push(workspace);
    const instructionPath = join(workspace, "TASK.md");
    await writeFile(instructionPath, instruction, "utf8");
    const instructionMetadata = await lstat(instructionPath);
    const entry: PrimeContainerManifestEntry = {
      path: "TASK.md",
      type: "file",
      mode: instructionMetadata.mode & 0o777,
      size: Buffer.byteLength(instruction),
      sha256: sha256(instruction),
    };
    const snapshotDigest = createPrimeContainerManifestSha256([entry]);
    const identity = Object.freeze({ ...primeExternalHarnessIdentity(), image });
    const descriptor = descriptorFor(identity);
    const request = operationRequest(identity, workspace, snapshotDigest);
    const fixture = await createLocalPrimeOciFixtureSource({
      root: workspace,
      instructionPath: "TASK.md",
      expectedSnapshotDigest: snapshotDigest,
    });
    const publisher = new DurablePrimeWorkspacePublisher();
    const resultSink = new StagedPrimeOciResultSink({
      targetRoot: workspace,
      publish: (publication) => publisher.publish(publication),
    });
    const hostRequests: string[] = [];
    const responses = [
      assistantToolCall("call-prime-1", "counter = 40\ncounter", "response-prime-1", 1),
      assistantToolCall(
        "call-prime-2",
        'counter += 2\nfrom pathlib import Path\nPath("RESULT.md").write_text(str(counter), encoding="utf-8")\ncounter',
        "response-prime-2",
        2,
      ),
      assistantText("The task is complete.", "response-prime-3", 3),
    ];
    const delegate = {
      infer: vi.fn(async ({ body }: { readonly body: string }) => {
        hostRequests.push(body);
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("real Prime session requested an unexpected model turn");
        }
        return JSON.stringify(response);
      }),
    };
    const broker = new NativePrimeHostInferenceBroker({ delegate });
    const transport = startPrimeContainer(image.id);
    const checkpoints: string[] = [];
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("real Prime session exceeded 90 seconds")),
      90_000,
    );
    timeout.unref?.();

    try {
      const evidence = await new AttachedPrimeOciOperator({
        fixture,
        resultSink,
        inferenceBroker: broker,
        validateReadiness: () => undefined,
      }).operate({
        request,
        descriptor,
        containerId: transport.containerName,
        transport,
        checkpoint: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
        signal: controller.signal,
      });

      await transport.release();
      expect(await readFile(join(workspace, "RESULT.md"), "utf8")).toBe("42");
      expect(hostRequests).toHaveLength(3);
      expect(hostRequests[1]).toContain("40");
      expect(hostRequests[2]).toContain("42");
      expect(checkpoints).toEqual(["terminal", "exported"]);
      expect(evidence.harness).toEqual({
        outcome: "completed",
        runId: expect.any(String),
        reason: null,
      });
      expect(evidence.settlement).toEqual({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        kernelRequests: 1,
      });
      expect(evidence.finishMetrics({ startedAtMs: 1, endedAtMs: 2 })).toMatchObject({
        turns: 3,
        toolCalls: 2,
        toolErrors: 0,
        wallTimeMs: 1,
      });
    } finally {
      clearTimeout(timeout);
      await transport.forceRemove();
    }
  }, 120_000);
});

function readVerifiedImage() {
  const path = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (path === undefined) {
    throw new Error("real Prime session requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const source = readFileSync(path, "utf8");
  const value = JSON.parse(source) as { readonly image?: unknown };
  if (value.image === undefined) {
    throw new Error("real Prime session received an invalid verified image result");
  }
  return parsePrimeOciImageIdentity(value.image);
}

function operationRequest(
  identity: ReturnType<typeof primeExternalHarnessIdentity>,
  workspace: string,
  snapshotDigest: string,
): PrimeOciOperationInput["request"] {
  const trialId = `trial-${"b".repeat(48)}`;
  return {
    identity,
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId,
        position: 1,
        taskId: "persistent-kernel",
        profileId: "prime",
        seed: 7,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-${trialId}`,
        cwd: workspace,
        backend: "reflink-copy-v1",
        snapshotDigest,
      },
      instruction: { path: "TASK.md", sha256: sha256(instruction) },
      controls: {
        model: { provider: "test-provider", id: "test-model", thinking: "off" },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 4_096,
          maxCostUsdMicros: 100_000,
          maxExecutionMs: 90_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
    },
    isolation: { projectRoot: workspace, protectedPaths: [] },
  };
}

function descriptorFor(
  identity: ReturnType<typeof primeExternalHarnessIdentity>,
): NativePrimeHarnessDescriptor {
  return {
    identity,
    identityDigest: "e".repeat(64),
    localRuntime: {
      daemonId: "real-prime-test",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 1, uid: 0, gid: 0, mode: 0o660 },
      apiVersion: identity.runtime.engine.apiVersion,
      cgroupPath: "/sys/fs/cgroup",
      corePattern: "core",
      globalLeasePath: "/var/tmp/flow-prime-test-slot.json",
      imageDevice: { path: "/dev/null", major: 1, minor: 3 },
      imageProbe: {
        executablePath: "/usr/bin/dd",
        executableSha256: "f".repeat(64),
        readBytesPerSecond: identity.runtime.policy.minImageReadBytesPerSecond,
        readOperationsPerSecond: identity.runtime.policy.minImageReadOperationsPerSecond,
      },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile: {},
    },
    assertCurrent: async () => undefined,
  };
}

function startPrimeContainer(imageId: string): PrimeOciAttachedTransport & {
  readonly containerName: string;
  forceRemove(): Promise<void>;
} {
  const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const containerName = `flow-prime-real-${randomUUID()}`;
  const child = spawn(
    docker,
    [
      "run",
      "--rm",
      "--interactive",
      "--pull=never",
      "--platform=linux/amd64",
      `--name=${containerName}`,
      "--user=0:10003",
      "--network=none",
      "--ipc=none",
      "--read-only",
      "--log-driver=none",
      "--no-healthcheck",
      "--pids-limit=64",
      "--memory=2147483648",
      "--memory-swap=2147483648",
      "--cpu-period=100000",
      "--cpu-quota=200000",
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=DAC_READ_SEARCH",
      "--cap-add=FOWNER",
      "--cap-add=KILL",
      "--cap-add=SETGID",
      "--cap-add=SETUID",
      "--security-opt=no-new-privileges",
      "--ulimit=nofile=256:256",
      "--ulimit=nproc=64:64",
      "--ulimit=fsize=268435456:268435456",
      "--ulimit=core=0:0",
      "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=536870912,nr_inodes=8192,mode=0710",
      "--tmpfs=/run/flow-node:rw,nosuid,nodev,noexec,size=16777216,nr_inodes=256,mode=0700",
      "--tmpfs=/run/flow-supervisor:rw,nosuid,nodev,noexec,size=16777216,nr_inodes=256,mode=0700",
      imageId,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } },
  );
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  return {
    containerName,
    output: child.stdout,
    write: async (bytes, signal) => {
      throwIfAborted(signal);
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(Buffer.from(bytes), (error) => {
          if (error === null || error === undefined) {
            resolveWrite();
          } else {
            rejectWrite(error);
          }
        });
      });
    },
    closeInput: async () => {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    },
    release: async () => {
      const code = await exited;
      if (code !== 0) {
        throw new Error(
          `real Prime container exited with ${String(code)}: ${Buffer.concat(errors).toString("utf8")}`,
        );
      }
    },
    forceRemove: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const cleanup = spawn(docker, ["rm", "--force", containerName], {
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" },
        });
        await new Promise<void>((resolveCleanup) => cleanup.once("exit", () => resolveCleanup()));
      }
    },
  };
}

function assistantToolCall(id: string, code: string, responseId: string, timestamp: number) {
  return assistantMessage(
    [{ type: "toolCall", id, name: "ipython", arguments: { code } }],
    "toolUse",
    responseId,
    timestamp,
  );
}

function assistantText(text: string, responseId: string, timestamp: number) {
  return assistantMessage([{ type: "text", text }], "stop", responseId, timestamp);
}

function assistantMessage(
  content: readonly Record<string, unknown>[],
  stopReason: "stop" | "toolUse",
  responseId: string,
  timestamp: number,
) {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    responseId,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime test aborted");
  }
}
