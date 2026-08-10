import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandSandbox } from "../../src/application/command-sandbox.js";
import type { HarnessEvaluationRequest } from "../../src/application/evaluation-adapter.js";
import { NativePiHarnessRegistry } from "../../src/infrastructure/pi/native-pi-harness-registry.js";
import { LocalExternalHarnessRuntime } from "../../src/infrastructure/process/local-external-harness-runtime.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("compiled external harness boundary", () => {
  it("runs the compiled native Pi driver without provider credentials", async () => {
    const packageRoot = resolve(import.meta.dirname, "../..");
    const driverPath = join(packageRoot, "dist/infrastructure/pi/native-pi-evaluation-driver.js");
    const protocolPath = join(packageRoot, "dist/domain/evaluation/external-harness-protocol.js");
    await Promise.all([access(driverPath), access(protocolPath)]);
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "TASK.md"), "Replace PENDING with DONE in RESULT.md.\n");
    await writeFile(join(workspace, "RESULT.md"), "PENDING\n");
    const registry = new NativePiHarnessRegistry({
      driverPath,
      protocolPath,
      runtimeSupportPaths: [join(packageRoot, "dist"), join(packageRoot, "node_modules")],
    });
    const profile = {
      id: "candidate",
      adapter: "pi-native-v1" as const,
      harness: { config: "pi-evaluation-v1" as const },
    };
    const identity = await registry.resolveIdentity(profile);
    let turns = 0;
    const runtime = new LocalExternalHarnessRuntime({
      registry,
      sandbox: directSandbox(),
      platform: "linux",
      inferenceBroker: {
        infer: async ({ body }) => {
          turns += 1;
          const request = JSON.parse(body) as { readonly context: Context };
          const hasToolResult = request.context.messages.some(
            (message) => message.role === "toolResult",
          );
          return JSON.stringify(hasToolResult ? terminalMessage() : editMessage());
        },
      },
    });

    const result = await runtime.execute({
      identity,
      evaluation: evaluationRequest(workspace),
      isolation: { projectRoot: root, protectedPaths: [root] },
    });

    expect(await readFile(join(workspace, "RESULT.md"), "utf8")).toBe("DONE\n");
    expect(turns).toBe(2);
    expect(result).toMatchObject({
      harness: {
        outcome: "completed",
        runtime: { exitCode: 0, treeTermination: "confirmed" },
      },
      metrics: { turns: 2, toolCalls: 1, toolErrors: 0 },
    });
  });

  it.skipIf(process.platform !== "linux")(
    "denies native Pi access to private host paths",
    async () => {
      const packageRoot = resolve(import.meta.dirname, "../..");
      const root = await temporaryDirectory();
      const project = join(root, "project");
      const state = join(root, "evaluation-state");
      const collection = join(root, ".project.flow-workspaces");
      const workspace = join(collection, "owner", "current", "workspace");
      const sibling = join(collection, "owner", "sibling", "workspace");
      await Promise.all([
        mkdir(project, { recursive: true }),
        mkdir(state, { recursive: true }),
        mkdir(workspace, { recursive: true }),
        mkdir(sibling, { recursive: true }),
      ]);
      const protectedFiles = [
        join(project, "project-private.txt"),
        join(state, "state-private.txt"),
        join(sibling, "sibling-private.txt"),
      ];
      await Promise.all([
        writeFile(join(workspace, "TASK.md"), "Replace PENDING with DONE in RESULT.md.\n"),
        writeFile(protectedFiles[0] as string, "SECRET_ALPHA_9271\n"),
        writeFile(protectedFiles[1] as string, "SECRET_BRAVO_3846\n"),
        writeFile(protectedFiles[2] as string, "SECRET_CHARLIE_5108\n"),
      ]);
      const registry = new NativePiHarnessRegistry({
        driverPath: join(packageRoot, "dist/infrastructure/pi/native-pi-evaluation-driver.js"),
        protocolPath: join(packageRoot, "dist/domain/evaluation/external-harness-protocol.js"),
        runtimeSupportPaths: [join(packageRoot, "dist"), join(packageRoot, "node_modules")],
      });
      const profile = {
        id: "candidate",
        adapter: "pi-native-v1" as const,
        harness: { config: "pi-evaluation-v1" as const },
      };
      const identity = await registry.resolveIdentity(profile);
      let turns = 0;
      let returnedContext = "";
      const runtime = new LocalExternalHarnessRuntime({
        registry,
        sandbox: createProductionCommandSandbox(),
        inferenceBroker: {
          infer: async ({ body }) => {
            turns += 1;
            if (turns === 1) {
              return JSON.stringify(privatePathProbeMessage(protectedFiles));
            }
            returnedContext = body;
            return JSON.stringify(terminalMessage());
          },
        },
      });

      const result = await runtime.execute({
        identity,
        evaluation: evaluationRequest(workspace),
        isolation: { projectRoot: project, protectedPaths: [project, state] },
      });

      expect(returnedContext).not.toMatch(
        /SECRET_ALPHA_9271|SECRET_BRAVO_3846|SECRET_CHARLIE_5108/,
      );
      await expect(readFile(protectedFiles[1] as string, "utf8")).resolves.toBe(
        "SECRET_BRAVO_3846\n",
      );
      expect(result).toMatchObject({
        harness: {
          outcome: "completed",
          runtime: { treeTermination: "confirmed" },
        },
        metrics: { toolCalls: 5, toolErrors: 5 },
      });
    },
  );
});

function directSandbox(): CommandSandbox {
  return {
    prepare: vi.fn<CommandSandbox["prepare"]>(async (request) => ({
      processContainment: "linux-pid-namespace" as const,
      launch: {
        executable: request.executable,
        args: request.args,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "0.0.70",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "0".repeat(64),
      },
      release: async () => undefined,
    })),
  };
}

function evaluationRequest(workspace: string): HarnessEvaluationRequest {
  const instruction = "Replace PENDING with DONE in RESULT.md.\n";
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "task",
      profileId: "candidate",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-trial-${"b".repeat(48)}`,
      cwd: workspace,
      backend: "reflink-copy-v1",
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: sha256(instruction) },
    controls: {
      model: { provider: "test-provider", id: "test-model", thinking: "off" },
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
  };
}

function editMessage(): AssistantMessage {
  return assistantMessage(
    [
      {
        type: "toolCall",
        id: "call-edit-result",
        name: "edit",
        arguments: {
          path: "RESULT.md",
          edits: [{ oldText: "PENDING\n", newText: "DONE\n" }],
        },
      },
    ],
    "toolUse",
  );
}

function terminalMessage(): AssistantMessage {
  return assistantMessage([{ type: "text", text: "The requested edit is complete." }], "stop");
}

function privatePathProbeMessage(paths: readonly string[]): AssistantMessage {
  const [projectPath, statePath, siblingPath] = paths;
  if (projectPath === undefined || statePath === undefined || siblingPath === undefined) {
    throw new Error("private path probe needs three paths");
  }
  return assistantMessage(
    [
      ...[projectPath, statePath, siblingPath, "/dev/fd/0"].map((path, index) => ({
        type: "toolCall" as const,
        id: `call-read-private-${String(index)}`,
        name: "read",
        arguments: { path },
      })),
      {
        type: "toolCall",
        id: "call-edit-private-state",
        name: "edit",
        arguments: {
          path: statePath,
          edits: [{ oldText: "UNKNOWN\n", newText: "CHANGED\n" }],
        },
      },
    ],
    "toolUse",
  );
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "host-provider",
    model: "host-model",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
    stopReason,
    timestamp: 1,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-compiled-external-harness-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
