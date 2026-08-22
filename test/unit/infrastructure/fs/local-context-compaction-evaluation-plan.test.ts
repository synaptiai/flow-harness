import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { admitLocalContextCompactionEvaluationPlan } from "../../../../src/infrastructure/fs/local-context-compaction-evaluation-plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local context compaction evaluation plan", () => {
  it("admits immutable fixture, workflow, constraint, and balanced schedule identities", async () => {
    const project = await evaluationProject();

    const admitted = await admitLocalContextCompactionEvaluationPlan(
      join(project, "compaction-evaluation.yaml"),
    );
    await rm(join(project, "compaction-evaluation.yaml"));

    expect(admitted).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "reference-first-compaction",
      suite: {
        id: "context-compaction-holdout",
        version: "1.0.0",
        tasks: [
          {
            id: "preserve-release-policy",
            partition: "holdout",
            fixture: {
              sourceCwd: join(project, "fixtures/release-policy"),
              provenance: "fixtures/release-policy",
              instructionPath: "TASK.md",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            protectedConstraints: ["Never change release policy."],
            constraintAssertionIndexes: [0],
          },
        ],
      },
      profile: {
        adapter: "flow-workflow-v1",
        workflow: {
          provenance: "agent.workflow.yaml",
          sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admitted.schedule).toHaveLength(18);
    expect(admitted.schedule.slice(0, 3).map((trial) => trial.profileId)).toEqual([
      "none",
      "references",
      "references-and-summary",
    ]);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("rejects child workflows whose independent sessions cannot be measured", async () => {
    const project = await evaluationProject();
    await writeFile(join(project, "agent.workflow.yaml"), childWorkflowSource());

    await expect(
      admitLocalContextCompactionEvaluationPlan(join(project, "compaction-evaluation.yaml")),
    ).rejects.toThrow(/child workflows are not measured/i);
  });
});

async function evaluationProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-compaction-evaluation-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, "fixtures/release-policy"), { recursive: true });
  await writeFile(
    join(project, "fixtures/release-policy", "TASK.md"),
    "Preserve release-policy.txt and create RESULT.md.\n",
  );
  await writeFile(join(project, "fixtures/release-policy", "release-policy.txt"), "protected\n");
  await writeFile(join(project, "agent.workflow.yaml"), workflowSource());
  await writeFile(join(project, "compaction-evaluation.yaml"), planSource());
  return project;
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: compaction-agent }
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
      prompt: Follow TASK.md exactly.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}

function childWorkflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: compaction-agent }
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
        metadata: { id: child-agent }
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
              prompt: Follow TASK.md exactly.
              model: { provider: test, id: deterministic }
              tools: [read, edit]
          - id: publish
            type: result
            dependsOn: [implement]
            result:
              source: { nodeId: implement, field: agent.text }
              schema: { type: string, maxLength: 4096 }
  - id: publish
    type: result
    dependsOn: [delegate]
    result:
      source: { nodeId: delegate, field: result.value }
      schema: { type: string, maxLength: 4096 }
`;
}

function planSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ContextCompactionEvaluationPlan
metadata: { id: reference-first-compaction }
suite:
  id: context-compaction-holdout
  version: 1.0.0
  tasks:
    - id: preserve-release-policy
      partition: holdout
      fixture: fixtures/release-policy
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - { kind: sha256, path: release-policy.txt, value: 6f4ed9e0c19c90d2fa9c2426ecb1bb3affdc657f41cd5e6da5b378eebc4d9fc5 }
      protectedConstraints: [Never change release policy.]
      constraintAssertionIndexes: [0]
profile: { adapter: flow-workflow-v1, workflow: agent.workflow.yaml }
controls:
  model: { provider: test, id: deterministic, thinking: medium }
  budget:
    maxNodeStarts: 8
    maxModelTokens: 10000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 300000
    maxArtifactBytes: 1048576
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
  compaction:
    minimumReductionBytes: 1024
    summaryOutputTokenLimits: [512, 256]
seeds: [11, 12, 13, 14, 15, 16]
modes: [none, references, references-and-summary]
order: six-order-balanced-v1
comparison:
  minimumPairedTrials: 6
  maxVerifiedSuccessRegression: 0
  maxTotalTokenIncreaseRate: 0.1
  maxConstraintLosses: 0
`;
}
