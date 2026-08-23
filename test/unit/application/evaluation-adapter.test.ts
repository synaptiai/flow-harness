import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "../../../src/application/artifact-store.js";
import {
  FlowWorkflowEvaluationAdapter,
  type HarnessEvaluationRequest,
} from "../../../src/application/evaluation-adapter.js";
import type { NodeExecutor } from "../../../src/application/ports.js";
import {
  type CapabilitySnapshot,
  createAgentCapabilityEvidence,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import type { ModelUsageObservation } from "../../../src/domain/run/budget.js";
import {
  calculatePortableHistoryIdentity,
  selectContextCompactionRange,
} from "../../../src/domain/run/model-session.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { JsonlModelSessionStore } from "../../../src/infrastructure/fs/jsonl-model-session-store.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";
import { ReflinkCopyWorkspaceIsolator } from "../../../src/infrastructure/fs/reflink-copy-workspace-isolator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Flow workflow evaluation adapter", () => {
  it("runs a public trial without verifier authority and translates durable telemetry", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const request = publicRequest(root);
    expect("verifier" in request).toBe(false);
    const clock = [100, 125];
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: successfulExecutor(),
        createStore: () => new JsonlRunStore(join(root, "runs")),
        clockMs: () => clock.shift() ?? 125,
      },
    );

    const result = await adapter.run(request);

    expect(result).toEqual({
      harness: {
        outcome: "completed",
        runId: `eval-${request.trial.trialId}`,
        reason: null,
      },
      metrics: {
        costUsdMicros: 17,
        inputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        outputTokens: 5,
        turns: 2,
        toolCalls: 1,
        toolErrors: 0,
        wallTimeMs: 25,
        activeTimeMs: 4,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    await expect(
      new JsonlRunStore(join(root, "runs")).read(`eval-${request.trial.trialId}`),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "run_succeeded" })]),
    );
  });

  it("keeps independently unavailable ACP usage dimensions out of evaluation metrics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: successfulExecutor(undefined, {
          modelTokens: { status: "complete", totalTokens: 8 },
          costUsd: { status: "unavailable" },
        }),
        createStore: () => new JsonlRunStore(join(root, "runs")),
      },
    );

    await expect(adapter.run(publicRequest(root))).resolves.toMatchObject({
      harness: { outcome: "completed" },
      metrics: {
        costUsdMicros: null,
        inputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
      },
    });
  });

  it("projects complete ACP usage observations into evaluation metrics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: successfulExecutor(undefined, {
          modelTokens: {
            status: "complete",
            totalTokens: 11,
            breakdown: {
              inputTokens: 4,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
              outputTokens: 4,
            },
          },
          costUsd: { status: "complete", costUsdMicros: 19 },
        }),
        createStore: () => new JsonlRunStore(join(root, "runs")),
      },
    );

    await expect(adapter.run(publicRequest(root))).resolves.toMatchObject({
      harness: { outcome: "completed" },
      metrics: {
        costUsdMicros: 19,
        inputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 4,
      },
    });
  });

  it("forwards the project artifact store into an evaluation trial", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const artifactStore = Object.freeze({}) as ArtifactStore;
    const observed: Array<ArtifactStore | undefined> = [];
    const delegate = successfulExecutor();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: {
          async execute(node, context) {
            observed.push(context.artifactStore);
            return await delegate.execute(node, context);
          },
        },
        createStore: () => new JsonlRunStore(join(root, "runs")),
        artifactStore,
      },
    );

    await expect(adapter.run(publicRequest(root))).resolves.toMatchObject({
      harness: { outcome: "completed" },
    });
    expect(observed).toEqual([artifactStore]);
  });

  it("binds one Flow-owned compaction mode and records measured zero evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const observed: unknown[] = [];
    const delegate = successfulExecutor();
    const modelSessionStore = new JsonlModelSessionStore(join(root, "model-sessions"));
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "references-and-summary",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: {
          async execute(node, context) {
            observed.push(context.contextCompaction);
            return await delegate.execute(node, context);
          },
        },
        createStore: () => new JsonlRunStore(join(root, "runs")),
        artifactStore: Object.freeze({}) as ArtifactStore,
        modelSessionStore,
        contextCompaction: {
          mode: "references-and-summary",
          protectedConstraints: ["Never change release policy."],
          minimumReductionBytes: 1_024,
          outputTokenLimits: [512, 256],
        },
      },
    );
    const request = publicRequest(root, "references-and-summary");

    const result = await adapter.run(request);

    expect(observed).toEqual([
      {
        mode: "references-and-summary",
        protectedConstraints: ["Never change release policy."],
        minimumReductionBytes: 1_024,
        outputTokenLimits: [512, 256],
      },
    ]);
    expect(result).toMatchObject({
      harness: { outcome: "completed" },
      metrics: {
        contextCompaction: {
          mode: "references-and-summary",
          providerRequestBytes: 0,
          providerRequestEstimatedTokens: 0,
          attempts: 0,
          accepted: 0,
          rejected: 0,
          interrupted: 0,
          summaryInputTokens: 0,
          summaryOutputTokens: 0,
          summaryCostUsdMicros: 0,
          artifactReopenAttempts: 0,
          artifactReopenSuccesses: 0,
        },
      },
    });
  });

  it("rejects reference-first evaluation without an artifact store", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "references",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: successfulExecutor(),
        createStore: () => new JsonlRunStore(join(root, "runs")),
        modelSessionStore: new JsonlModelSessionStore(join(root, "model-sessions")),
        contextCompaction: { mode: "references" },
      },
    );

    await expect(adapter.run(publicRequest(root, "references"))).resolves.toMatchObject({
      harness: {
        outcome: "crashed",
        reason: expect.stringMatching(/artifact store/i),
      },
    });
  });

  it("keeps summary usage unavailable when provider failure has no usage evidence", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const delegate = successfulExecutor();
    const modelSessionStore = new JsonlModelSessionStore(join(root, "model-sessions"));
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "references-and-summary",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: {
          async execute(node, context) {
            const journal = context.modelSession;
            if (journal === undefined) throw new Error("test requires a model-session journal");
            for (const request of [1, 2]) {
              await journal.append({
                type: "model_request_prepared",
                attempt: 1,
                turn: request,
                request,
                identity: {
                  version: 1,
                  provider: "test",
                  model: "deterministic",
                  apiAdapter: "messages-v1",
                  thinking: "medium",
                  runtimeVersion: "test-runtime",
                  system: { sha256: "1".repeat(64), bytes: 100 },
                  toolCatalog: { sha256: "2".repeat(64), bytes: 100, count: 0 },
                  authority: { sha256: "3".repeat(64) },
                  portableHistory: calculatePortableHistoryIdentity(journal.state),
                  runtimeSurface: { sha256: "4".repeat(64), bytes: 400 },
                  attempt: 1,
                  turn: request,
                  request,
                },
              });
              await journal.append({
                type: "model_message_committed",
                attempt: 1,
                turn: request,
                request,
                text: `Completed request ${request}.`,
                stopReason: "stop",
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costUsdMicros: 1,
                },
              });
              await journal.append({
                type: "model_request_settled",
                attempt: 1,
                turn: request,
                request,
                outcome: "completed",
              });
            }
            const selection = selectContextCompactionRange(journal.state);
            if (selection === null) throw new Error("test session has no compactable range");
            await journal.append({
              type: "context_compaction_started",
              attempt: 1,
              compaction: 1,
              generationAttempt: 1,
              mode: "references-and-summary",
              sourceHead: journal.state.head,
              range: selection.range,
              referenceSurface: { sha256: "5".repeat(64), bytes: 400, estimatedTokens: 100 },
              outputTokenLimit: 512,
            });
            await journal.append({
              type: "context_compaction_settled",
              attempt: 1,
              compaction: 1,
              generationAttempt: 1,
              settlement: { outcome: "rejected", reason: "provider_error" },
            });
            return await delegate.execute(node, context);
          },
        },
        createStore: () => new JsonlRunStore(join(root, "runs")),
        artifactStore: Object.freeze({}) as ArtifactStore,
        modelSessionStore,
        contextCompaction: {
          mode: "references-and-summary",
          protectedConstraints: ["Never change release policy."],
          minimumReductionBytes: 1_024,
          outputTokenLimits: [512, 256],
        },
      },
    );

    await expect(adapter.run(publicRequest(root, "references-and-summary"))).resolves.toMatchObject(
      {
        harness: { outcome: "completed" },
        metrics: {
          costUsdMicros: null,
          inputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
          contextCompaction: {
            attempts: 1,
            rejected: 1,
            summaryInputTokens: null,
            summaryOutputTokens: null,
            summaryCostUsdMicros: null,
          },
        },
      },
    );
  });

  it("binds an admitted Agent Skill snapshot to the evaluated workflow", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledSkillWorkflow();
    const capabilitySnapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review the result.",
        metadata: { owner: "synapti" },
        requestedTools: ["Read"],
        trust: "project-explicit",
        provenance: ".flow/skills/review",
        files: [
          {
            path: "SKILL.md",
            content: Buffer.from("---\nname: review\ndescription: Review the result.\n---\n"),
          },
        ],
      },
    ]);
    const observed: Array<unknown> = [];
    const executor = successfulExecutor(capabilitySnapshot);
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
        capabilitySnapshot,
      },
      {
        executor: {
          execute: async (node, context) => {
            observed.push(context.capabilitySnapshot);
            return executor.execute(node, context);
          },
        },
        createStore: () => new JsonlRunStore(join(root, "runs")),
      },
    );

    await expect(adapter.run(publicRequest(root))).resolves.toMatchObject({
      harness: { outcome: "completed" },
    });
    expect(observed).toEqual([capabilitySnapshot]);
  });

  it("converts workflow failure into a typed harness failure without inventing telemetry", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Create RESULT.md.\n");
    const workflow = compiledWorkflow();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: {
          execute: async () => ({
            status: "failed",
            error: {
              code: "model_failed",
              message: "provider unavailable",
              retryable: false,
              sideEffectStatus: "none",
            },
            evidence: null,
          }),
        },
        createStore: () => new JsonlRunStore(join(root, "runs")),
      },
    );

    await expect(adapter.run(publicRequest(root))).resolves.toMatchObject({
      harness: { outcome: "failed", reason: "provider unavailable" },
      metrics: {
        costUsdMicros: null,
        inputTokens: null,
        turns: null,
        toolCalls: null,
        toolErrors: null,
        activeTimeMs: null,
      },
    });
  });

  it("does not invoke the provider again when an uncommitted trial run already exists", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    await writeFile(join(root, "TASK.md"), "Edit RESULT.md.\n");
    const workflow = compiledWorkflow();
    const executor = successfulExecutor();
    const execute = vi.spyOn(executor, "execute");
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor,
        createStore: () => new JsonlRunStore(join(root, "runs")),
      },
    );
    const request = publicRequest(root);

    await expect(adapter.run(request)).resolves.toMatchObject({
      harness: { outcome: "completed" },
    });
    await expect(adapter.run(request)).resolves.toMatchObject({
      harness: { outcome: "crashed", reason: expect.stringMatching(/exists/i) },
      metrics: { costUsdMicros: null },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps child-only activity, policy, intervention, and recovery telemetry unavailable", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-adapter-")));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "TASK.md"), "Complete the child task.\n");
    const workflow = compiledChildWorkflow();
    const adapter = new FlowWorkflowEvaluationAdapter(
      {
        id: "candidate",
        adapter: "flow-workflow-v1",
        workflow: { compiled: workflow, workflowDigest: calculateWorkflowDigest(workflow) },
      },
      {
        executor: successfulExecutor(),
        createStore: () => new JsonlRunStore(join(root, "runs")),
        workspaceIsolator: new ReflinkCopyWorkspaceIsolator(join(root, "isolated")),
      },
    );

    await expect(adapter.run(publicRequest(workspace))).resolves.toMatchObject({
      harness: { outcome: "completed" },
      metrics: {
        inputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        turns: null,
        toolCalls: null,
        toolErrors: null,
        interventions: null,
        policyViolations: null,
        recoveryAttempts: null,
        recoveryOutcome: null,
      },
    });
  });
});

function compiledWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: evaluated-profile }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Follow TASK.md.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`);
}

function compiledSkillWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: evaluated-profile }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Follow TASK.md.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
      skills: [review]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`);
}

function compiledChildWorkflow() {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: evaluated-child-profile }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
        apiVersion: flow.synapti.ai/v1alpha1
        kind: Workflow
        metadata: { id: evaluated-child }
        budget:
          maxNodeStarts: 4
          maxModelTokens: 1000
          maxCostUsd: 0.1
          maxExecutionMs: 60000
          maxArtifactBytes: 524288
        nodes:
          - id: implement
            type: agent
            agent:
              prompt: Follow TASK.md.
              model: { provider: test, id: deterministic }
              tools: [read, edit]
          - id: publish
            type: result
            dependsOn: [implement]
            result:
              source: { nodeId: implement, field: agent.text }
              schema: { type: string, maxLength: 1024 }
  - id: publish
    type: result
    dependsOn: [delegate]
    result:
      source: { nodeId: delegate, field: result.value }
      schema: { type: string, maxLength: 1024 }
`);
}

function publicRequest(cwd: string, profileId = "candidate"): HarnessEvaluationRequest {
  return Object.freeze({
    planDigest: "a".repeat(64),
    trial: Object.freeze({
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "edit-readme",
      profileId,
      seed: 11,
      repetition: 1,
    }),
    workspace: Object.freeze({
      workspaceId: "evaluation-workspace",
      cwd,
      backend: "reflink-copy-v1",
      snapshotDigest: "c".repeat(64),
    }),
    instruction: Object.freeze({ path: "TASK.md", sha256: sha256("Create RESULT.md.\n") }),
    controls: Object.freeze({
      model: Object.freeze({ provider: "test", id: "deterministic", thinking: "medium" }),
      budget: Object.freeze({
        maxNodeStarts: 8,
        maxModelTokens: 10_000,
        maxCostUsdMicros: 1_000_000,
        maxExecutionMs: 300_000,
        maxArtifactBytes: 1_048_576,
      }),
      network: "deny" as const,
      retry: Object.freeze({ providerRetries: 0 as const, harnessRetries: 0 as const }),
    }),
  });
}

function successfulExecutor(
  capabilitySnapshot?: CapabilitySnapshot,
  usageObservation?: ModelUsageObservation,
): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type !== "agent") {
        throw new Error("unexpected executable node");
      }
      await writeFile(join(context.cwd, "RESULT.md"), "complete\n");
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: "test",
          model: "deterministic",
          text: '"complete"',
          textHash: sha256('"complete"'),
          textTruncated: false,
          durationMs: 4,
          ...(usageObservation === undefined
            ? {
                usage: {
                  inputTokens: 3,
                  cacheReadTokens: 1,
                  cacheWriteTokens: 2,
                  outputTokens: 5,
                  costUsdMicros: 17,
                },
              }
            : { usageObservation }),
          activity: { turns: 2, toolCalls: 1, toolErrors: 0 },
          policyDecisions: [],
          effectReceipts: [],
          ...(capabilitySnapshot === undefined
            ? {}
            : { capabilities: createAgentCapabilityEvidence(capabilitySnapshot, ["review"]) }),
        },
      };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
