import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const executeFile = promisify(execFile);
const linux = process.platform === "linux" && process.arch === "x64";
const marker = "FLOW_PRIVATE_PROTOCOL_MARKER_928451";

describe.skipIf(!linux)("Prime OCI daemon logging boundary", () => {
  it("keeps protocol and tool bytes out of Docker logs", async () => {
    let logOutput = "";
    let logCommandFailed = false;
    let inspectedLogDriver = "";
    const session = await runVerifiedPrimeSession({
      instruction: `Finish the task. Private marker: ${marker}.`,
      responses: [primeAssistantText("The logging test is complete.", 1)],
      onInferenceRequest: async ({ containerName }) => {
        const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
        const environment = {
          HOME: "/tmp",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          DOCKER_CONFIG: "/tmp",
        };
        inspectedLogDriver = (
          await executeFile(
            docker,
            ["inspect", "--format", "{{.HostConfig.LogConfig.Type}}", containerName],
            { encoding: "utf8", env: environment },
          )
        ).stdout.trim();
        try {
          const logs = await executeFile(docker, ["logs", containerName], {
            encoding: "utf8",
            env: environment,
          });
          logOutput = `${logs.stdout}${logs.stderr}`;
        } catch (error) {
          logCommandFailed = true;
          const output = error as { readonly stdout?: string; readonly stderr?: string };
          logOutput = `${output.stdout ?? ""}${output.stderr ?? ""}`;
        }
      },
    });
    try {
      expect(inspectedLogDriver).toBe("none");
      expect(logCommandFailed).toBe(true);
      expect(logOutput).not.toContain(marker);
      expect(session.evidence.harness.outcome).toBe("completed");
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
