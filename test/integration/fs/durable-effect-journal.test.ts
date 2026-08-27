import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { reduceRunEvents } from "../../../src/domain/run/events.js";
import { EMPTY_DIRECTORY_STATE_SHA256 } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import type { CompiledNode } from "../../../src/domain/workflow/types.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { AgentEffectRecorder } from "../../../src/infrastructure/pi/agent-effect-recorder.js";
import { createWorkspaceAgentTools } from "../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable filesystem effect journal", () => {
  it("reopens an edited run with prepared, settled, and terminal evidence intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-durable-effects-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const runs = join(root, "runs");
    const target = join(workspace, "source.ts");
    const before = "export const value = 1;\n";
    const after = "export const value = 2;\n";
    await mkdir(workspace, { recursive: true });
    await writeFile(target, before, { encoding: "utf8", flag: "wx" });
    const expectedMode = (await stat(target)).mode & 0o777;
    const runId = "durable-edit-run";

    const state = await runWorkflow(workflow(), {
      runId,
      cwd: workspace,
      protectedPaths: [],
      store: new JsonlRunStore(runs),
      executor: editingExecutor(target, before),
      now: incrementingClock(),
    });

    expect(state.status).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe(after);

    const reopenedEvents = await new JsonlRunStore(runs).read(runId);
    expect(reopenedEvents.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_settled",
      "node_succeeded",
      "node_started",
      "node_succeeded",
      "run_succeeded",
    ]);
    expect(reopenedEvents[1]).toMatchObject({
      type: "node_started",
      effectProtocol: "flow.effects/v1",
    });
    expect(reopenedEvents[2]).toMatchObject({
      type: "node_effect_prepared",
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target: await realpath(target),
        beforeSha256: sha256(before),
        afterSha256: sha256(after),
        mode: expectedMode,
      },
    });
    expect(reopenedEvents[3]).toMatchObject({
      type: "node_effect_settled",
      effectId: "effect-3",
      outcome: "committed",
      reason: "directory_synced",
    });

    const reopenedState = reduceRunEvents(reopenedEvents);
    expect(reopenedState.nodes.implement).toMatchObject({
      status: "succeeded",
      effects: [
        {
          effectId: "effect-3",
          settlement: { outcome: "committed", reason: "directory_synced" },
        },
      ],
      evidence: {
        effectReceipts: [
          {
            sequence: 1,
            target: await realpath(target),
            beforeSha256: sha256(before),
            afterSha256: sha256(after),
            outcome: "committed",
          },
        ],
      },
    });
  });

  it("reopens a created run with its absent pre-state and terminal receipt intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-durable-create-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const runs = join(root, "runs");
    const target = join(workspace, "MIGRATIONS.md");
    const content = "# Migrations\n";
    await mkdir(workspace, { recursive: true });
    const runId = "durable-create-run";

    const state = await runWorkflow(createWorkflow(), {
      runId,
      cwd: workspace,
      protectedPaths: [],
      store: new JsonlRunStore(runs),
      executor: creatingExecutor(target, content),
      now: incrementingClock(),
    });

    expect(state.status).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe(content);
    const reopenedEvents = await new JsonlRunStore(runs).read(runId);
    expect(reopenedEvents[2]).toMatchObject({
      type: "node_effect_prepared",
      descriptor: {
        kind: "filesystem.create",
        target: await realpath(target),
        beforeSha256: null,
        afterSha256: sha256(content),
        mode: 0o644,
      },
    });
    expect(reduceRunEvents(reopenedEvents).nodes.implement?.evidence).toMatchObject({
      effectReceipts: [
        {
          kind: "filesystem.create",
          beforeSha256: null,
          afterSha256: sha256(content),
          outcome: "committed",
        },
      ],
    });
  });

  it("reopens a directory-created run with its empty-state receipt intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-durable-mkdir-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const runs = join(root, "runs");
    const target = join(workspace, "synthesize");
    await mkdir(workspace, { recursive: true });
    const runId = "durable-mkdir-run";

    const state = await runWorkflow(mkdirWorkflow(), {
      runId,
      cwd: workspace,
      protectedPaths: [],
      store: new JsonlRunStore(runs),
      executor: mkdirExecutor(target),
      now: incrementingClock(),
    });

    expect(state.status).toBe("succeeded");
    expect(await readdir(target)).toEqual([]);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    const reopenedEvents = await new JsonlRunStore(runs).read(runId);
    expect(reopenedEvents[2]).toMatchObject({
      type: "node_effect_prepared",
      descriptor: {
        kind: "filesystem.mkdir",
        target: await realpath(target),
        beforeSha256: null,
        afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
        mode: 0o755,
      },
    });
    expect(reduceRunEvents(reopenedEvents).nodes.implement?.evidence).toMatchObject({
      effectReceipts: [
        {
          kind: "filesystem.mkdir",
          beforeSha256: null,
          afterSha256: EMPTY_DIRECTORY_STATE_SHA256,
          outcome: "committed",
        },
      ],
    });
  });
});

function mkdirExecutor(target: string): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type === "command") {
        return await executeEdit(node, context, target, "unused");
      }
      if (context.effectJournal === undefined) {
        throw new Error("integration workflow did not supply a writable agent journal");
      }
      const attribution = {
        runId: context.runId,
        workflowId: context.workflowId,
        nodeId: node.id,
        attempt: context.attempt,
      } as const;
      const policy = new PolicyBroker(attribution, ["filesystem.write"]);
      const effects = new AgentEffectRecorder(attribution, context.effectJournal);
      const tools = await createWorkspaceAgentTools(context.cwd, ["mkdir"], policy, {
        effectRecorder: effects,
      });
      const mkdirTool = tools.definitions[0];
      if (mkdirTool === undefined) {
        throw new Error("Flow mkdir tool was not registered");
      }
      await mkdirTool.execute(
        "integration-mkdir",
        { path: target },
        undefined,
        undefined,
        {} as never,
      );
      const text = "mkdir complete";
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: "test",
          model: "deterministic",
          text,
          textHash: sha256(text),
          textTruncated: false,
          durationMs: 1,
          policyDecisions: policy.close(),
          effectReceipts: effects.close(),
        },
      };
    },
  };
}

function creatingExecutor(target: string, content: string): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type === "command") {
        return await executeEdit(node, context, target, "unused");
      }
      if (context.effectJournal === undefined) {
        throw new Error("integration workflow did not supply a writable agent journal");
      }
      const attribution = {
        runId: context.runId,
        workflowId: context.workflowId,
        nodeId: node.id,
        attempt: context.attempt,
      } as const;
      const policy = new PolicyBroker(attribution, ["filesystem.write"]);
      const effects = new AgentEffectRecorder(attribution, context.effectJournal);
      const tools = await createWorkspaceAgentTools(context.cwd, ["create"], policy, {
        effectRecorder: effects,
      });
      const create = tools.definitions[0];
      if (create === undefined) {
        throw new Error("Flow create tool was not registered");
      }
      await create.execute(
        "integration-create",
        { path: target, content },
        undefined,
        undefined,
        {} as never,
      );
      const text = "create complete";
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: "test",
          model: "deterministic",
          text,
          textHash: sha256(text),
          textTruncated: false,
          durationMs: 1,
          policyDecisions: policy.close(),
          effectReceipts: effects.close(),
        },
      };
    },
  };
}

function editingExecutor(target: string, before: string): NodeExecutor {
  return {
    execute: async (node, context) => await executeEdit(node, context, target, before),
  };
}

async function executeEdit(
  node: CompiledNode,
  context: NodeExecutionContext,
  target: string,
  before: string,
): Promise<NodeExecutionOutcome> {
  if (node.type === "command") {
    const stdout = "verified\n";
    return {
      status: "succeeded",
      evidence: {
        kind: "command",
        executable: node.command.executable,
        args: node.command.args,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        stdoutHash: sha256(stdout),
        stderrHash: sha256(""),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    };
  }
  if (context.effectJournal === undefined) {
    throw new Error("integration workflow did not supply a writable agent journal");
  }
  const attribution = {
    runId: context.runId,
    workflowId: context.workflowId,
    nodeId: node.id,
    attempt: context.attempt,
  } as const;
  const policy = new PolicyBroker(attribution, ["filesystem.write"]);
  const effects = new AgentEffectRecorder(attribution, context.effectJournal);
  const tools = await createWorkspaceAgentTools(context.cwd, ["edit"], policy, {
    effectRecorder: effects,
  });
  const edit = tools.definitions[0];
  if (edit === undefined) {
    throw new Error("Flow edit tool was not registered");
  }

  await edit.execute(
    "integration-edit",
    {
      path: target,
      expectedSha256: sha256(before),
      edits: [{ oldText: "value = 1", newText: "value = 2" }],
    },
    undefined,
    undefined,
    {} as never,
  );
  const text = "edit complete";
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text,
      textHash: sha256(text),
      textTruncated: false,
      durationMs: 1,
      policyDecisions: policy.close(),
      effectReceipts: effects.close(),
    },
  };
}

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: durable-effect-workflow }
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
`);
}

function createWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: durable-create-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Create the migration guide.
      model: { provider: test, id: deterministic }
      tools: [create]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function mkdirWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: durable-mkdir }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Create the package directory.
      model: { provider: test, id: deterministic }
      tools: [mkdir]
  - id: verify
    type: command
    dependsOn: [implement]
    command: { executable: node, args: [--version] }
`);
}

function incrementingClock() {
  let seconds = 0;
  return () => {
    seconds += 1;
    return new Date(`2026-08-07T10:20:${String(seconds).padStart(2, "0")}.000Z`);
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
