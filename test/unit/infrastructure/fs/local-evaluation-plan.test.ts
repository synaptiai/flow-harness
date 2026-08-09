import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local evaluation plan admission", () => {
  it("admits immutable fixture, instruction, verifier, workflow, and schedule identities", async () => {
    const project = await evaluationProject();

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));

    expect(admitted).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "harness-comparison",
      suite: {
        id: "foundation-suite",
        version: "1.0.0",
        tasks: [
          {
            id: "edit-readme",
            partition: "holdout",
            fixture: {
              sourceCwd: join(project, "fixtures/edit-readme"),
              entryCount: 2,
              logicalBytes: expect.any(Number),
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              instructionPath: "TASK.md",
              instructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            verifier: {
              kind: "filesystem-v1",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              assertions: [{ kind: "exists", path: "RESULT.md" }],
            },
          },
        ],
      },
      profiles: [
        {
          id: "baseline",
          adapter: "flow-workflow-v1",
          workflow: {
            workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        {
          id: "candidate",
          adapter: "flow-workflow-v1",
          workflow: {
            workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ],
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admitted.schedule).toHaveLength(4);
    expect(admitted.schedule.map((trial) => trial.profileId)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("keeps plan identity portable across different absolute project roots", async () => {
    const first = await evaluationProject();
    const second = await evaluationProject();

    const [left, right] = await Promise.all([
      admitLocalEvaluationPlan(join(first, "evaluation.yaml")),
      admitLocalEvaluationPlan(join(second, "evaluation.yaml")),
    ]);

    expect(left.planDigest).toBe(right.planDigest);
    expect(left.suite.tasks[0]?.fixture.digest).toBe(right.suite.tasks[0]?.fixture.digest);
  });

  it("rejects workflow model and budget drift from the declared controls", async () => {
    const modelDrift = await evaluationProject({ modelId: "other-model" });
    await expect(admitLocalEvaluationPlan(join(modelDrift, "evaluation.yaml"))).rejects.toThrow(
      /model.*controls/i,
    );

    const thinkingDrift = await evaluationProject();
    const highThinking = workflowSource("deterministic", 8).replace(
      "model: { provider: test, id: deterministic }",
      "model: { provider: test, id: deterministic, thinking: high }",
    );
    await writeFile(join(thinkingDrift, "baseline.workflow.yaml"), highThinking);
    await expect(admitLocalEvaluationPlan(join(thinkingDrift, "evaluation.yaml"))).rejects.toThrow(
      /model.*controls|thinking/i,
    );

    const budgetDrift = await evaluationProject({ maxNodeStarts: 9 });
    await expect(admitLocalEvaluationPlan(join(budgetDrift, "evaluation.yaml"))).rejects.toThrow(
      /budget.*controls/i,
    );
  });

  it("rejects path escapes, symbolic links, and mutable special entries", async () => {
    const escapedProject = await evaluationProject({ workflowPath: "../outside.workflow.yaml" });
    await expect(admitLocalEvaluationPlan(join(escapedProject, "evaluation.yaml"))).rejects.toThrow(
      /canonical portable relative path/i,
    );

    const linked = await evaluationProject();
    await symlink("README.md", join(linked, "fixtures/edit-readme", "ALIAS.md"));
    await expect(admitLocalEvaluationPlan(join(linked, "evaluation.yaml"))).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("rejects profiles without a controlled model and uncaptured capability or retry semantics", async () => {
    const noModel = await evaluationProject();
    const commandOnly = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-only }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: prepare
    type: command
    command: { executable: /usr/bin/true, args: [] }
`;
    await writeFile(join(noModel, "baseline.workflow.yaml"), commandOnly);
    await expect(admitLocalEvaluationPlan(join(noModel, "evaluation.yaml"))).rejects.toThrow(
      /model-bearing|controlled model/i,
    );

    const capability = await evaluationProject();
    const capabilitySource = workflowSource("deterministic", 8).replace(
      "      tools: [read, edit]",
      "      tools: [read, edit]\n      skills: [review]",
    );
    await writeFile(join(capability, "baseline.workflow.yaml"), capabilitySource);
    await expect(admitLocalEvaluationPlan(join(capability, "evaluation.yaml"))).rejects.toThrow(
      /capabilit|skills/i,
    );

    const recovery = await evaluationProject();
    const recoverySource = workflowSource("deterministic", 8).replace(
      "      tools: [read, edit]",
      "      tools: [read, edit]\n      recovery: { mode: fresh, maxAttempts: 2 }",
    );
    await writeFile(join(recovery, "baseline.workflow.yaml"), recoverySource);
    await expect(admitLocalEvaluationPlan(join(recovery, "evaluation.yaml"))).rejects.toThrow(
      /recovery|retry/i,
    );
  });

  it("rejects fixture entries the workspace isolator cannot reproduce", async () => {
    const project = await evaluationProject();
    await mkdir(join(project, "fixtures/edit-readme", ".flow"));
    await writeFile(join(project, "fixtures/edit-readme", ".flow", "ambient"), "hidden\n");

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrow(
      /\.flow|isolation/i,
    );
  });
});

async function evaluationProject(
  overrides: {
    readonly modelId?: string;
    readonly maxNodeStarts?: number;
    readonly workflowPath?: string;
  } = {},
): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-admission-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, "fixtures/edit-readme"), { recursive: true });
  await writeFile(join(project, "fixtures/edit-readme", "TASK.md"), "Create RESULT.md.\n");
  await writeFile(join(project, "fixtures/edit-readme", "README.md"), "# Fixture\n");
  const workflow = workflowSource(
    overrides.modelId ?? "deterministic",
    overrides.maxNodeStarts ?? 8,
  );
  await writeFile(join(project, "baseline.workflow.yaml"), workflow);
  await writeFile(
    join(project, "candidate.workflow.yaml"),
    workflow.replace("id: baseline", "id: candidate"),
  );
  await writeFile(join(project, "evaluation.yaml"), planSource(overrides.workflowPath));
  return project;
}

function workflowSource(modelId: string, maxNodeStarts: number): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: baseline }
budget:
  maxNodeStarts: ${maxNodeStarts}
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Follow TASK.md exactly.
      model: { provider: test, id: ${modelId} }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}

function planSource(workflowPath = "baseline.workflow.yaml"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: harness-comparison }
suite:
  id: foundation-suite
  version: 1.0.0
  tasks:
    - id: edit-readme
      partition: holdout
      fixture: fixtures/edit-readme
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - { kind: exists, path: RESULT.md }
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: ${workflowPath} }
  - { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }
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
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}
