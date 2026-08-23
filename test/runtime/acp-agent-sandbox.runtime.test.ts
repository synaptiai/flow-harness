import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AcpAgentSandbox } from "../../src/application/acp-agent-sandbox.js";
import type { CompiledAgentNode } from "../../src/domain/workflow/types.js";
import { AcpAgentExecutor } from "../../src/infrastructure/acp/acp-agent-executor.js";
import {
  ANTHROPIC_SANDBOX_RUNTIME_VERSION,
  anthropicSandboxRuntimeManager,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../../src/infrastructure/sandbox/anthropic-sandbox-runtime-manager.js";
import { SrtCommandSandbox } from "../../src/infrastructure/sandbox/srt-command-sandbox.js";
import { acpAgentCapabilitySnapshot } from "../fixtures/acp-agent.js";

const linuxX64 = process.platform === "linux" && process.arch === "x64";
const temporaryDirectories: string[] = [];
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/acp-agent/process-agent.mjs",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linuxX64)("ACP agent SRT runtime", () => {
  it("executes ACP inside the hosted Linux PID namespace profile", async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-project-")));
    const privateHome = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-home-")));
    const protectedRoot = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-protected-")));
    const attemptDirectory = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-attempt-")));
    temporaryDirectories.push(projectRoot, privateHome, protectedRoot, attemptDirectory);
    await mkdir(join(projectRoot, ".flow"));
    await writeFile(join(projectRoot, "source.txt"), "PRIVATE_PROJECT_STATE", "utf8");
    await writeFile(join(projectRoot, ".flow", "private.txt"), "PRIVATE_FLOW_STATE", "utf8");
    await writeFile(join(privateHome, "private.txt"), "PRIVATE_HOME_STATE", "utf8");
    const protectedFile = join(protectedRoot, "private.txt");
    await writeFile(protectedFile, "PRIVATE_PROTECTED_STATE", "utf8");
    const environment = {
      ...process.env,
      OPENAI_API_KEY: "PRIVATE_SELECTED_CREDENTIAL",
      FLOW_AMBIENT_PRIVATE: "PRIVATE_AMBIENT_CREDENTIAL",
    };
    const seccompApplyPath = resolveAnthropicSandboxRuntimeSeccompPath();
    const srt = new SrtCommandSandbox(anthropicSandboxRuntimeManager, {
      backendVersion: ANTHROPIC_SANDBOX_RUNTIME_VERSION,
      environment,
      homeDirectory: privateHome,
      ...(seccompApplyPath === undefined ? {} : { seccompApplyPath }),
    });
    const runtimeSupportPaths = await Promise.all([
      realpath(process.execPath),
      realpath(fixturePath),
      realpath(join(process.cwd(), "node_modules")),
    ]);
    const containmentOptions = Buffer.from(
      JSON.stringify({
        projectFile: join(projectRoot, "source.txt"),
        projectWrite: join(projectRoot, "written.txt"),
        homeFile: join(privateHome, "private.txt"),
        homeWrite: join(privateHome, "written.txt"),
        protectedFile,
      }),
      "utf8",
    ).toString("base64url");
    const sandbox: AcpAgentSandbox = {
      prepareAcpAgent: async (request) =>
        await srt.prepareAcpAgent({
          ...request,
          executable: process.execPath,
          args: [fixturePath, "containment", containmentOptions],
          runtimeSupportPaths,
        }),
    };
    let cleanupRequested = false;
    const executor = new AcpAgentExecutor({
      sandbox,
      assertCurrent: async () => undefined,
      createAttemptDirectory: async () => attemptDirectory,
      removeAttemptDirectory: async (path) => {
        expect(path).toBe(attemptDirectory);
        cleanupRequested = true;
      },
      terminationGraceMs: 250,
      terminationConfirmationMs: 2_000,
    });

    const outcome = await executor.execute(agentNode(), {
      runId: "hosted-linux-acp",
      workflowId: "hosted-linux-acp",
      attempt: 1,
      cwd: projectRoot,
      projectRoot,
      protectedPaths: [protectedFile, join(projectRoot, ".flow", "private.txt")],
      capabilitySnapshot: acpAgentCapabilitySnapshot(),
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        text: "ACP containment verified",
        acp: {
          executor: "local-acp-process-v1",
          processContainment: "linux-pid-namespace",
          terminationStatus: "confirmed",
          sandbox: {
            backend: "anthropic-sandbox-runtime",
            backendVersion: ANTHROPIC_SANDBOX_RUNTIME_VERSION,
            profile: "acp-prompt-only-v1",
          },
        },
      },
    });
    expect(cleanupRequested).toBe(true);
    expect(
      JSON.parse(await readFile(join(attemptDirectory, "containment-probe.json"), "utf8")),
    ).toEqual({
      projectReadDenied: true,
      projectWriteDenied: true,
      homeReadDenied: true,
      homeWriteDenied: true,
      protectedReadDenied: true,
      protectedWriteDenied: true,
      selectedCredentialAbsent: true,
      ambientCredentialAbsent: true,
      networkDenied: true,
      privateWriteSucceeded: true,
      resistantChildAlive: true,
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_SELECTED_CREDENTIAL");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_AMBIENT_CREDENTIAL");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROJECT_STATE");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_HOME_STATE");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_PROTECTED_STATE");
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_FLOW_STATE");
  }, 60_000);
});

function agentNode(): CompiledAgentNode {
  return {
    id: "agent-1",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Return one bounded result.",
      model: { provider: "openai", id: "gpt-5.6-codex", thinking: "high" },
      tools: [],
      skills: [],
      toolPackages: [],
      timeoutMs: 20_000,
    },
  };
}
