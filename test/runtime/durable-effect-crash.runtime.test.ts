import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("compiled durable effect crash windows", () => {
  it.each([
    {
      mode: "before_rename",
      exitCode: 81,
      expectedContent: "export const value = 1;\n",
      expectedEvents: ["run_started", "node_started", "node_effect_prepared"],
    },
    {
      mode: "after_rename",
      exitCode: 82,
      expectedContent: "export const value = 2;\n",
      expectedEvents: ["run_started", "node_started", "node_effect_prepared"],
    },
    {
      mode: "after_directory_sync",
      exitCode: 84,
      expectedContent: "export const value = 2;\n",
      expectedEvents: ["run_started", "node_started", "node_effect_prepared"],
    },
    {
      mode: "settlement_rejected",
      exitCode: 85,
      expectedContent: "export const value = 2;\n",
      expectedEvents: ["run_started", "node_started", "node_effect_prepared"],
    },
    {
      mode: "after_settle",
      exitCode: 83,
      expectedContent: "export const value = 2;\n",
      expectedEvents: [
        "run_started",
        "node_started",
        "node_effect_prepared",
        "node_effect_settled",
      ],
    },
  ] as const)("persists truthful state when the process exits $mode", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), `flow-effect-${scenario.mode}-`));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const runs = join(root, "runs");
    const target = join(workspace, "source.ts");
    await mkdir(workspace, { recursive: true });
    await writeFile(target, "export const value = 1;\n", "utf8");

    const result = await runCrashChild(scenario.mode, workspace, runs, target);

    expect(result.code, result.stderr).toBe(scenario.exitCode);
    expect(result.signal).toBeNull();
    expect(await readFile(target, "utf8")).toBe(scenario.expectedContent);
    const events = await readLedger(
      join(runs, `crash-${scenario.mode.replace("_", "-")}`, "events.jsonl"),
    );
    expect(events.map((event) => event.type)).toEqual(scenario.expectedEvents);
    expect(events[1]).toMatchObject({
      type: "node_started",
      effectProtocol: "flow.effects/v1",
    });
    expect(events[2]).toMatchObject({
      type: "node_effect_prepared",
      effectId: "effect-3",
      descriptor: { target: await realpath(target) },
    });
    if (scenario.mode === "after_settle") {
      expect(events[3]).toMatchObject({
        type: "node_effect_settled",
        effectId: "effect-3",
        outcome: "committed",
        reason: "directory_synced",
      });
    }
  });
});

async function runCrashChild(
  mode:
    | "before_rename"
    | "after_rename"
    | "after_directory_sync"
    | "settlement_rejected"
    | "after_settle",
  workspace: string,
  runs: string,
  target: string,
): Promise<ProcessResult> {
  const moduleUrls = {
    workflow: new URL("../../dist/application/run-workflow.js", import.meta.url).href,
    policy: new URL("../../dist/domain/policy/broker.js", import.meta.url).href,
    compiler: new URL("../../dist/domain/workflow/compiler.js", import.meta.url).href,
    editor: new URL("../../dist/infrastructure/fs/hash-anchored-edit.js", import.meta.url).href,
    store: new URL("../../dist/infrastructure/fs/jsonl-run-store.js", import.meta.url).href,
    recorder: new URL("../../dist/infrastructure/pi/agent-effect-recorder.js", import.meta.url)
      .href,
    tools: new URL("../../dist/infrastructure/pi/workspace-agent-tools.js", import.meta.url).href,
  };
  const script = `
    import { createHash } from "node:crypto";
    import { open } from "node:fs/promises";
    import { runWorkflow } from ${JSON.stringify(moduleUrls.workflow)};
    import { PolicyBroker } from ${JSON.stringify(moduleUrls.policy)};
    import { compileWorkflowText } from ${JSON.stringify(moduleUrls.compiler)};
    import { editHashAnchoredTextFile } from ${JSON.stringify(moduleUrls.editor)};
    import { JsonlRunStore } from ${JSON.stringify(moduleUrls.store)};
    import { AgentEffectRecorder } from ${JSON.stringify(moduleUrls.recorder)};
    import { createWorkspaceAgentTools } from ${JSON.stringify(moduleUrls.tools)};

    const mode = ${JSON.stringify(mode)};
    const workspace = ${JSON.stringify(workspace)};
    const runs = ${JSON.stringify(runs)};
    const target = ${JSON.stringify(target)};
    const runId = ${JSON.stringify(`crash-${mode.replace("_", "-")}`)};
    const sha256 = value => createHash("sha256").update(value).digest("hex");

    class CrashStore extends JsonlRunStore {
      async append(event) {
        if (mode === "settlement_rejected" && event.type === "node_effect_settled") {
          throw new Error("injected settlement append rejection");
        }
        await super.append(event);
        if (mode === "after_settle" && event.type === "node_effect_settled") {
          process.exit(83);
        }
      }
    }

    const workflow = compileWorkflowText(\`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: crash-effect-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Update the exported value.
      model: { provider: test, id: deterministic }
      tools: [edit]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
\`);

    const executor = {
      async execute(node, context) {
        if (node.type !== "agent" || context.effectJournal === undefined) {
          throw new Error("crash barrier was not reached from a writable agent");
        }
        const attribution = {
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId: node.id,
          attempt: context.attempt,
        };
        const policy = new PolicyBroker(attribution, ["filesystem.write"]);
        const effects = new AgentEffectRecorder(attribution, context.effectJournal);
        const editFile = async (editTarget, request, options) => {
          if (mode === "before_rename") {
            return await editHashAnchoredTextFile(editTarget, request, {
              ...options,
              rename: async () => process.exit(81),
            });
          }
          if (mode === "after_rename") {
            return await editHashAnchoredTextFile(editTarget, request, {
              ...options,
              syncDirectory: async () => process.exit(82),
            });
          }
          if (mode === "after_directory_sync") {
            return await editHashAnchoredTextFile(editTarget, request, {
              ...options,
              syncDirectory: async directory => {
                const directoryHandle = await open(directory, "r");
                try {
                  await directoryHandle.sync();
                } finally {
                  await directoryHandle.close();
                }
                process.exit(84);
              },
            });
          }
          return await editHashAnchoredTextFile(editTarget, request, options);
        };
        const tools = await createWorkspaceAgentTools(workspace, ["edit"], policy, {
          effectRecorder: effects,
          editFile,
        });
        await tools.definitions[0].execute(
          "crash-edit",
          {
            path: target,
            expectedSha256: sha256("export const value = 1;\\n"),
            edits: [{ oldText: "value = 1", newText: "value = 2" }],
          },
          undefined,
          undefined,
          {},
        );
        throw new Error("crash barrier did not terminate the process");
      },
    };

    try {
      await runWorkflow(workflow, {
        runId,
        cwd: workspace,
        protectedPaths: [],
        store: new CrashStore(runs),
        executor,
      });
      process.exit(98);
    } catch (error) {
      if (mode === "settlement_rejected") {
        process.exit(85);
      }
      throw error;
    }
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function readLedger(path: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
