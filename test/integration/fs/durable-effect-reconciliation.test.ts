import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { resumeWorkflow } from "../../../src/application/run-workflow.js";
import { reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { createProductionNodeEffectReconciler } from "../../../src/infrastructure/runtime/production-effect-reconciler.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable effect reconciliation", () => {
  it("reopens an observed edit from JSONL and never duplicates the observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-reconcile-jsonl-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const target = join(directory, "source.ts");
    await writeFile(target, "after\n", { mode: 0o640 });
    await chmod(target, 0o640);
    const compiled = workflow();
    const runId = "durable-reconciliation";
    const store = new JsonlRunStore(runsDirectory);
    await store.append({
      ...base(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: resolve(directory),
    });
    await store.append({
      ...base(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    });
    await store.append({
      ...base(compiled.id, runId, 3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.edit",
        target,
        operationDigest: "b".repeat(64),
        beforeSha256: sha256("before\n"),
        afterSha256: sha256("after\n"),
        mode: 0o640,
      },
    });
    await store.release(runId);

    const options = {
      cwd: directory,
      protectedPaths: [runsDirectory],
      runId,
      executor: forbiddenExecutor(),
      effectReconciler: createProductionNodeEffectReconciler(),
    } as const;
    await expect(
      resumeWorkflow(compiled, { ...options, store: new JsonlRunStore(runsDirectory) }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    const reopened = new JsonlRunStore(runsDirectory);
    const events = await reopened.read(runId);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "node_started",
      "node_effect_prepared",
      "node_effect_reconciled",
    ]);
    expect(reduceRunEvents(events).nodes.implement?.effects[0]).toMatchObject({
      settlement: null,
      reconciliation: {
        outcome: "applied",
        reason: "target_matches_after",
        observedSha256: sha256("after\n"),
        observedMode: 0o640,
      },
    });
    expect(await readFile(target, "utf8")).toBe("after\n");

    await expect(resumeWorkflow(compiled, { ...options, store: reopened })).rejects.toMatchObject({
      code: "uncertain_operation",
    });
    expect(await reopened.read(runId)).toHaveLength(4);
  });

  it("reopens an exact created file from JSONL and classifies it as applied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-reconcile-create-jsonl-"));
    temporaryDirectories.push(directory);
    const runsDirectory = join(directory, "runs");
    const target = join(directory, "MIGRATIONS.md");
    await writeFile(target, "# Migrations\n", { mode: 0o644 });
    const compiled = createWorkflow();
    const runId = "durable-create-reconciliation";
    const store = new JsonlRunStore(runsDirectory);
    await store.append({
      ...base(compiled.id, runId, 1),
      type: "run_started",
      nodeIds: compiled.nodes.map((node) => node.id),
      workflowApiVersion: compiled.apiVersion,
      workflowDigest: createHash("sha256").update(JSON.stringify(compiled)).digest("hex"),
      executionCwd: resolve(directory),
    });
    await store.append({
      ...base(compiled.id, runId, 2),
      type: "node_started",
      nodeId: "implement",
      attempt: 1,
      effectProtocol: "flow.effects/v1",
    });
    await store.append({
      ...base(compiled.id, runId, 3),
      type: "node_effect_prepared",
      nodeId: "implement",
      attempt: 1,
      effectId: "effect-3",
      effectSequence: 1,
      descriptor: {
        kind: "filesystem.create",
        target,
        operationDigest: "b".repeat(64),
        beforeSha256: null,
        afterSha256: sha256("# Migrations\n"),
        mode: 0o644,
      },
    });
    await store.release(runId);

    await expect(
      resumeWorkflow(compiled, {
        cwd: directory,
        protectedPaths: [runsDirectory],
        runId,
        store: new JsonlRunStore(runsDirectory),
        executor: forbiddenExecutor(),
        effectReconciler: createProductionNodeEffectReconciler(),
      }),
    ).rejects.toMatchObject({ code: "uncertain_operation" });

    const events = await new JsonlRunStore(runsDirectory).read(runId);
    expect(reduceRunEvents(events).nodes.implement?.effects[0]?.reconciliation).toMatchObject({
      outcome: "applied",
      reason: "target_matches_after",
      observedSha256: sha256("# Migrations\n"),
      observedMode: 0o644,
    });
  });
});

function forbiddenExecutor(): NodeExecutor {
  return {
    async execute() {
      throw new Error("recovery must not invoke the node executor");
    },
  };
}

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: durable-reconciliation }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Implement the requested change.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
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
metadata: { id: durable-create-reconciliation }
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

function base(workflowId: string, runId: string, sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-07T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    runId,
    workflowId,
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
