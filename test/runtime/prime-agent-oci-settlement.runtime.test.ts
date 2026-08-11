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
  it.each([
    ["cancellation", () => new AbortController(), "native Prime cancellation"],
    ["timeout", () => new AbortController(), "native Prime timeout"],
  ] as const)(
    "removes the full process tree after %s",
    async (_name, createController, reason) => {
      const controller = createController();
      let containerId: string | undefined;
      let inferenceStarted: (() => void) | undefined;
      const brokerReady = new Promise<void>((resolveReady) => {
        inferenceStarted = resolveReady;
      });
      const execution = runVerifiedPrimeSession({
        instruction: "Start one model turn and wait for host settlement.",
        responses: [primeAssistantToolCall("settlement-call", "1 + 1", 1)],
        signal: controller.signal,
        onContainerStarted: (container) => {
          containerId = container.containerId;
        },
        onInferenceRequest: async ({ signal }) => {
          inferenceStarted?.();
          await waitForAbort(signal);
        },
      });

      await brokerReady;
      controller.abort(new Error(reason));
      await expect(execution).rejects.toThrow(reason);

      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      await expectDockerObjectAbsent(requireContainerId(containerId));
    },
    120_000,
  );
});

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
