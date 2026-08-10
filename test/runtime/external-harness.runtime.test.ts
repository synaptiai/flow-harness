import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandSandbox } from "../../src/application/command-sandbox.js";
import type { HarnessEvaluationRequest } from "../../src/application/evaluation-adapter.js";
import { NativeOmpHarnessRegistry } from "../../src/infrastructure/omp/native-omp-harness-registry.js";
import {
  ArtifactObservations,
  NativePiHarnessRegistry,
  readTrustedPackageClosure,
} from "../../src/infrastructure/pi/native-pi-harness-registry.js";
import { LocalExternalHarnessRuntime } from "../../src/infrastructure/process/local-external-harness-runtime.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";
import { FLOW_SANDBOX_POLICY_DIGEST } from "../../src/infrastructure/sandbox/srt-command-sandbox.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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

  it.skipIf(process.platform !== "linux")(
    "denies native OMP access to private host paths",
    async () => {
      const packageRoot = resolve(import.meta.dirname, "../..");
      const root = await temporaryDirectory();
      const project = join(root, "project");
      const state = join(root, "evaluation-state");
      const collection = join(root, ".project.flow-workspaces");
      const workspace = join(collection, "owner", "current", "workspace");
      const sibling = join(collection, "owner", "sibling", "workspace");
      const preloadMarker = join(workspace, "ambient-preload-ran.txt");
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
        writeFile(join(workspace, "TASK.md"), "Inspect the declared private paths.\n"),
        writeFile(join(workspace, "bunfig.toml"), 'preload = ["./ambient-preload.ts"]\n'),
        writeFile(
          join(workspace, "ambient-preload.ts"),
          'await Bun.write("ambient-preload-ran.txt", "PRELOAD_RAN\\n");\n',
        ),
        writeFile(protectedFiles[0] as string, "OMP_SECRET_ALPHA_9271\n"),
        writeFile(protectedFiles[1] as string, "OMP_SECRET_BRAVO_3846\n"),
        writeFile(protectedFiles[2] as string, "OMP_SECRET_CHARLIE_5108\n"),
      ]);
      const registry = new NativeOmpHarnessRegistry({
        driverPath: join(packageRoot, "dist/infrastructure/omp/native-omp-evaluation-driver.js"),
        protocolPath: join(packageRoot, "dist/domain/evaluation/external-harness-protocol.js"),
        sourceRoot: join(packageRoot, "dist"),
        runtimeSupportPaths: [join(packageRoot, "dist"), join(packageRoot, "node_modules")],
      });
      const identity = await registry.resolveIdentity({
        id: "candidate",
        adapter: "omp-native-v1",
        harness: { config: "omp-evaluation-v1" },
      });
      let turns = 0;
      let returnedContext = "";
      const runtime = new LocalExternalHarnessRuntime({
        registry,
        sandbox: createProductionCommandSandbox(),
        inferenceBroker: {
          infer: async ({ body }) => {
            turns += 1;
            if (turns === 1) {
              return JSON.stringify(ompPrivatePathProbeMessage(protectedFiles));
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
        /OMP_SECRET_ALPHA_9271|OMP_SECRET_BRAVO_3846|OMP_SECRET_CHARLIE_5108/,
      );
      await expect(access(preloadMarker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result).toMatchObject({
        harness: {
          outcome: "completed",
          runtime: { treeTermination: "confirmed" },
        },
        metrics: { toolCalls: 4, toolErrors: 4 },
      });
    },
  );

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "loads an ancestor OMP peer through the production SRT read boundary",
    async () => {
      const root = await mkdtemp(join(homedir(), ".flow-omp-peer-"));
      temporaryDirectories.push(root);
      const project = join(root, "project");
      const workspace = join(project, "workspace");
      const subjectRoot = join(project, "node_modules", "subject");
      const peerRoot = join(root, "node_modules", "peer-runtime");
      const unselectedRoot = join(root, "node_modules", "unselected");
      const unselectedSecret = join(unselectedRoot, "private.txt");
      const driverPath = join(subjectRoot, "driver.ts");
      const resultPath = join(workspace, "RESULT.md");
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(subjectRoot, { recursive: true }),
        mkdir(peerRoot, { recursive: true }),
        mkdir(unselectedRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(subjectRoot, "package.json"),
          `${JSON.stringify({
            name: "subject",
            version: "1.0.0",
            peerDependencies: { "peer-runtime": "1.0.0", "late-peer": "1.0.0" },
            peerDependenciesMeta: { "late-peer": { optional: true } },
          })}\n`,
        ),
        writeFile(
          join(peerRoot, "package.json"),
          `${JSON.stringify({ name: "peer-runtime", version: "1.0.0", type: "module" })}\n`,
        ),
        writeFile(join(peerRoot, "index.js"), "export const peerValue = 'PEER_READY';\n"),
        writeFile(unselectedSecret, "UNSELECTED_SECRET\n"),
        writeFile(
          driverPath,
          'import { peerValue } from "peer-runtime";\n' +
            "let siblingRead = false;\n" +
            "try { await Bun.file(process.argv[3]).text(); siblingRead = true; } catch {}\n" +
            'await Bun.write(process.argv[2], String(peerValue) + ":" + String(siblingRead) + "\\n");\n',
        ),
      ]);
      const closure = await readTrustedPackageClosure(
        subjectRoot,
        "subject",
        "1.0.0",
        "OMP ancestor-peer runtime fixture",
        new ArtifactObservations(),
        { bindResolutionGraph: true, includePeerDependencies: true },
      );
      const bunExecutable =
        process.env.FLOW_BUN_EXECUTABLE?.trim() || join(homedir(), ".bun", "bin", "bun");
      const sandbox = createProductionCommandSandbox();
      const prepared = await sandbox.prepare({
        executable: bunExecutable,
        args: [
          "--no-env-file",
          "--no-install",
          "--config=/dev/null",
          driverPath,
          resultPath,
          unselectedSecret,
        ],
        cwd: workspace,
        projectRoot: project,
        protectedPaths: [],
        runtimeSupportPaths: [...closure.runtimeSupportPaths, bunExecutable],
        runtimeEnvironment: { NODE_PATH: closure.moduleSearchPaths.join(delimiter) },
      });
      try {
        await execFileAsync(prepared.launch.executable, [...prepared.launch.args], {
          cwd: workspace,
          env: prepared.launch.env,
        });
      } finally {
        await prepared.release();
      }

      await expect(readFile(resultPath, "utf8")).resolves.toBe("PEER_READY:false\n");
    },
  );

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "rejects an unselected package nested under a selected runtime root",
    async () => {
      const root = await mkdtemp(join(homedir(), ".flow-omp-nested-package-"));
      temporaryDirectories.push(root);
      const subjectRoot = join(root, "node_modules", "subject");
      const nestedRoot = join(subjectRoot, "dist", "node_modules", "unselected");
      await mkdir(nestedRoot, { recursive: true });
      await Promise.all([
        writeFile(
          join(subjectRoot, "package.json"),
          `${JSON.stringify({ name: "subject", version: "1.0.0" })}\n`,
        ),
        writeFile(join(nestedRoot, "private.txt"), "UNSELECTED_SECRET\n"),
      ]);

      await expect(
        readTrustedPackageClosure(
          subjectRoot,
          "subject",
          "1.0.0",
          "OMP nested-package runtime fixture",
          new ArtifactObservations(),
          {
            bindResolutionGraph: true,
            includePeerDependencies: true,
            rejectUnselectedNestedPackages: true,
          },
        ),
      ).rejects.toThrow(/unselected nested package/i);
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
        policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
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

function ompPrivatePathProbeMessage(paths: readonly string[]) {
  const [projectPath, statePath, siblingPath] = paths;
  if (projectPath === undefined || statePath === undefined || siblingPath === undefined) {
    throw new Error("private path probe needs three paths");
  }
  return assistantMessage(
    [
      ...[projectPath, statePath, siblingPath].map((path, index) => ({
        type: "toolCall" as const,
        id: `call-omp-read-private-${String(index)}`,
        name: "read",
        arguments: { i: "test the private path boundary", path },
      })),
      {
        type: "toolCall",
        id: "call-omp-edit-private-state",
        name: "edit",
        arguments: {
          i: "test the private edit boundary",
          path: statePath,
          old_string: "UNKNOWN\n",
          new_string: "CHANGED\n",
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
