import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createEvaluationSchedule } from "../../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../../src/domain/evaluation/records.js";
import { createTuningEvidencePacket } from "../../../../src/domain/evaluation/tuning-evidence.js";
import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import { createPublicEvaluationHeader } from "../../../../src/infrastructure/fs/local-evaluation-store.js";

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

  it("preserves the legacy direct-workflow plan identity", async () => {
    const project = await evaluationProject();
    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const header = createPublicEvaluationHeader(admitted, "direct-evaluation");

    expect(header.profiles.every((profile) => profile.workflow.sourceKind === undefined)).toBe(
      true,
    );
  });

  it("admits a prompt-candidate profile as an exact projected workflow identity", async () => {
    const project = await evaluationProject();
    const baselineText = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    const baselineDigest = calculateWorkflowDigest(compileWorkflowText(baselineText));
    const evidence = tuningEvidence(baselineDigest);
    const evidenceText = JSON.stringify(evidence);
    await writeFile(join(project, "tuning.json"), evidenceText);
    await writeFile(
      join(project, "better.prompt-candidate.yaml"),
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "PromptCandidate",
        metadata: { id: "better-instructions", version: "1.0.0" },
        scope: { kind: "workflow", workflowId: "baseline" },
        baseline: {
          workflow: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: baselineDigest,
        },
        evidence: [
          {
            path: "tuning.json",
            sourceSha256: sha256(evidenceText),
            evidenceDigest: evidence.evidenceDigest,
            planDigest: evidence.evaluation.planDigest,
          },
        ],
        changes: {
          prompts: [
            {
              nodeId: "implement",
              expectedSha256: sha256("Follow TASK.md exactly."),
              value: "Read TASK.md, implement it carefully, and verify the result.",
            },
          ],
        },
      }),
    );
    const direct = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace("workflow: candidate.workflow.yaml", "candidate: better.prompt-candidate.yaml"),
    );

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const candidate = admitted.profiles[1];
    expect(candidate.candidate).toMatchObject({
      id: "better-instructions",
      candidateVersion: "1.0.0",
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      baseline: { workflowDigest: baselineDigest },
      changes: [{ nodeId: "implement" }],
    });
    expect(candidate.workflow.compiled.nodes[0]).toMatchObject({
      type: "agent",
      agent: { prompt: "Read TASK.md, implement it carefully, and verify the result." },
    });
    expect(candidate.workflow.sourcePath).toBeNull();
    expect(candidate.workflow.sourceKind).toBe("prompt-candidate-projection");
    expect(admitted.planDigest).not.toBe(direct.planDigest);
    expect(
      createPublicEvaluationHeader(admitted, "candidate-evaluation").profiles[1],
    ).toMatchObject({
      id: "candidate",
      candidate: {
        provenance: "better.prompt-candidate.yaml",
        identity: {
          candidateDigest: candidate.candidate?.candidateDigest,
          baseline: { workflowDigest: baselineDigest },
          evidence: [{ evidenceDigest: evidence.evidenceDigest }],
          changes: [{ nodeId: "implement" }],
        },
      },
      workflow: { sourceKind: "prompt-candidate-projection" },
    });
  });

  it("requires a candidate projection to overlay the declared comparison baseline", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project, "overlay-baseline.workflow.yaml");
    const directBaseline = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    await writeFile(
      join(project, "baseline.workflow.yaml"),
      directBaseline.replace("Follow TASK.md exactly.", "Use a different baseline prompt."),
    );

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrowError(
      /comparison baseline|exact baseline|overlay/i,
    );
  });

  it("rejects a prompt candidate selected on the comparison baseline profile", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project);
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan
        .replace(
          "- { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }",
          "- { id: baseline, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }",
        )
        .replace(
          "- { id: candidate, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }",
          "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
        ),
    );

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrowError(
      /comparison candidate profile|candidate source/i,
    );
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

function tuningEvidence(workflowDigest: string) {
  const planDigest = "a".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["tuning-task"],
    ["baseline", "other"],
    [1],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "9".repeat(64),
      },
      harness: { outcome: "completed", runId: "run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1,
        activeTimeMs: 1,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return createTuningEvidencePacket({
    evaluationId: "source-evaluation",
    planDigest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [{ id: "tuning-task", partition: "tuning" }],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest },
      { id: "other", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
    ],
    schedule,
    records,
  });
}

async function configureCandidateProfile(
  project: string,
  baselineProvenance = "baseline.workflow.yaml",
): Promise<void> {
  const baselineText = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
  if (baselineProvenance !== "baseline.workflow.yaml") {
    await writeFile(join(project, baselineProvenance), baselineText);
  }
  const baselineDigest = calculateWorkflowDigest(compileWorkflowText(baselineText));
  const evidence = tuningEvidence(baselineDigest);
  const evidenceText = JSON.stringify(evidence);
  await writeFile(join(project, "tuning.json"), evidenceText);
  await writeFile(
    join(project, "better.prompt-candidate.yaml"),
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "better-instructions", version: "1.0.0" },
      scope: { kind: "workflow", workflowId: "baseline" },
      baseline: {
        workflow: baselineProvenance,
        sourceSha256: sha256(baselineText),
        workflowDigest: baselineDigest,
      },
      evidence: [
        {
          path: "tuning.json",
          sourceSha256: sha256(evidenceText),
          evidenceDigest: evidence.evidenceDigest,
          planDigest: evidence.evaluation.planDigest,
        },
      ],
      changes: {
        prompts: [
          {
            nodeId: "implement",
            expectedSha256: sha256("Follow TASK.md exactly."),
            value: "Read TASK.md, implement it carefully, and verify the result.",
          },
        ],
      },
    }),
  );
  const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
  await writeFile(
    join(project, "evaluation.yaml"),
    plan.replace("workflow: candidate.workflow.yaml", "candidate: better.prompt-candidate.yaml"),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
