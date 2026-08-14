import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const executeFile = promisify(execFile);
const linux = process.platform === "linux" && process.arch === "x64";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linux)("Prime OCI native settlement", () => {
  it("removes the full process tree after cancellation", async () => {
    const controller = new AbortController();
    const session = startBlockedSession({ signal: controller.signal });

    await session.brokerReady;
    controller.abort(new Error("native Prime cancellation"));
    await expect(session.execution).rejects.toThrow("native Prime cancellation");

    await expectDockerObjectAbsent(requireContainerId(session.containerId()));
  }, 120_000);

  it("removes the full process tree after the elapsed deadline", async () => {
    const session = startBlockedSession({ maxExecutionMs: 2_000 });

    await session.brokerReady;
    await expect(session.execution).rejects.toThrow("verified Prime session exceeded 2000ms");

    await expectDockerObjectAbsent(requireContainerId(session.containerId()));
  }, 120_000);
});

function startBlockedSession(input: {
  readonly maxExecutionMs?: number;
  readonly signal?: AbortSignal;
}) {
  let containerId: string | undefined;
  let inferenceStarted: (() => void) | undefined;
  const brokerReady = new Promise<void>((resolveReady) => {
    inferenceStarted = resolveReady;
  });
  const execution = runVerifiedPrimeSession({
    instruction: "Start one model turn and wait for host settlement.",
    responses: [primeAssistantToolCall("settlement-call", "1 + 1", 1)],
    ...input,
    onContainerStarted: (container) => {
      containerId = container.containerId;
    },
    onInferenceRequest: async ({ signal }) => {
      inferenceStarted?.();
      await waitForAbort(signal);
    },
  });
  return {
    brokerReady,
    execution,
    containerId: () => containerId,
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    throw new Error("Prime settlement broker did not receive a signal");
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function expectDockerObjectAbsent(containerId: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-settlement-inspect-"));
  temporaryDirectories.push(root);
  const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const options = {
    encoding: "utf8" as const,
    env: {
      HOME: root,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: root,
    },
  };
  await expect(executeFile(docker, ["inspect", containerId], options)).rejects.toThrow();
  await expect(executeFile(docker, ["top", containerId], options)).rejects.toThrow();
}

function requireContainerId(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Prime settlement test did not observe the container ID");
  }
  return value;
}
