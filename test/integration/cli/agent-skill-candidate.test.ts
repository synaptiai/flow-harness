import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  type AgentSkillPackageSnapshot,
  createAgentCapabilityEvidence,
} from "../../../src/domain/capability/agent-skills.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { loadEffectiveFlowConfig } from "../../../src/infrastructure/fs/flow-config-store.js";
import {
  discoverProjectAgentSkills,
  snapshotSelectedAgentSkills,
} from "../../../src/infrastructure/fs/local-agent-skill-catalog.js";
import { promptCandidateTuningEvidence } from "../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Agent Skill candidate CLI", () => {
  it("validates, evaluates, and durably inspects one paired immutable skill projection", async () => {
    const fixture = await candidateEvaluationProject();
    const validation = capture();
    const treeBeforeValidation = await snapshotTree(fixture.project);

    expect(
      await main(["candidate", "validate", fixture.candidatePath], validation.io, {
        cwd: fixture.project,
      }),
      validation.stderr.join("\n"),
    ).toBe(0);
    const validated = JSON.parse(validation.stdout.join("\n"));
    expect(validated).toMatchObject({
      valid: true,
      candidate: {
        kind: "agent-skill-candidate",
        id: "better-review",
        baseline: {
          skill: { name: "review", packageDigest: fixture.baselineSkillDigest },
        },
        projectedSkill: { packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(validation.stdout.join("\n")).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");
    expect(validation.stdout.join("\n")).not.toContain(fixture.project);
    expect(await snapshotTree(fixture.project)).toEqual(treeBeforeValidation);

    const planValidation = capture();
    expect(
      await main(["eval", "validate", fixture.planPath], planValidation.io, {
        cwd: fixture.project,
      }),
      planValidation.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(planValidation.stdout.join("\n")).profiles).toEqual([
      expect.objectContaining({
        id: "baseline",
        capabilitySnapshotDigest: validated.candidate.baseline.skill.capabilityDigest,
      }),
      expect.objectContaining({
        id: "candidate",
        candidateDigest: validated.candidate.candidateDigest,
        capabilitySnapshotDigest: validated.candidate.projectedSkill.capabilityDigest,
      }),
    ]);

    const observed: Array<{ readonly digest: string; readonly resource: string }> = [];
    const evaluations = join(fixture.project, "evaluations");
    const execution = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          fixture.planPath,
          "--evaluation-id",
          "skill-candidate-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        execution.io,
        {
          cwd: fixture.project,
          executor: evaluationExecutor(observed, async () => {
            await rm(join(fixture.project, ".flow", "skills", "review"), { recursive: true });
            await rm(fixture.candidatePath);
            await rm(join(fixture.project, "baseline.workflow.yaml"));
            await rm(join(fixture.project, "tuning.json"));
            await mkdir(join(fixture.project, ".flow", "skills", "review"), { recursive: true });
            await writeFile(
              join(fixture.project, ".flow", "skills", "review", "SKILL.md"),
              "---\nname: review\ndescription: PRIVATE LIVE COLLISION\n---\n",
            );
            await writeFile(
              join(fixture.project, ".flow", "skills", "review", "reference.md"),
              "PRIVATE LIVE COLLISION\n",
            );
          }),
        },
      ),
      execution.stderr.join("\n"),
    ).toBe(0);
    expect(observed).toEqual([
      {
        digest: validated.candidate.baseline.skill.capabilityDigest,
        resource: "Check evidence.\n",
      },
      {
        digest: validated.candidate.projectedSkill.capabilityDigest,
        resource: "PRIVATE CANDIDATE REVIEW INSTRUCTIONS\n",
      },
    ]);
    expect(execution.stdout.join("\n")).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");
    expect(execution.stdout.join("\n")).not.toContain("PRIVATE LIVE COLLISION");

    const inspected = capture();
    expect(
      await main(
        ["eval", "inspect", "skill-candidate-evaluation", "--evaluations-dir", evaluations],
        inspected.io,
        { cwd: fixture.project },
      ),
      inspected.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(inspected.stdout.join("\n")).header.profiles).toEqual([
      expect.objectContaining({
        id: "baseline",
        capabilitySnapshotDigest: validated.candidate.baseline.skill.capabilityDigest,
      }),
      expect.objectContaining({
        id: "candidate",
        capabilitySnapshotDigest: validated.candidate.projectedSkill.capabilityDigest,
        workflow: expect.objectContaining({
          sourceKind: "agent-skill-candidate-projection",
        }),
        candidate: expect.objectContaining({
          identity: expect.objectContaining({
            kind: "agent-skill-candidate",
            candidateDigest: validated.candidate.candidateDigest,
          }),
        }),
      }),
    ]);
    expect(inspected.stdout.join("\n")).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");
    expect(inspected.stdout.join("\n")).not.toContain("PRIVATE LIVE COLLISION");
    expect(inspected.stdout.join("\n")).not.toContain(fixture.project);

    const exported = capture();
    const exportPath = join(fixture.project, "evaluation-export.json");
    expect(
      await main(
        [
          "eval",
          "export",
          "skill-candidate-evaluation",
          "--evaluations-dir",
          evaluations,
          "--output",
          exportPath,
        ],
        exported.io,
        { cwd: fixture.project },
      ),
      exported.stderr.join("\n"),
    ).toBe(0);
    const exportText = await readFile(exportPath, "utf8");
    expect(exportText).toContain(validated.candidate.candidateDigest);
    expect(exportText).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");
    expect(exportText).not.toContain("PRIVATE LIVE COLLISION");
    expect(exportText).not.toContain(fixture.project);
  }, 20_000);

  it("activates a superior skill projection and runs it after every live source is removed", async () => {
    const fixture = await candidateEvaluationProject();
    const evaluations = join(fixture.project, "activation-evaluations");
    const observed: Array<{ readonly digest: string; readonly resource: string }> = [];
    const evaluation = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          fixture.planPath,
          "--evaluation-id",
          "skill-activation-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        evaluation.io,
        {
          cwd: fixture.project,
          executor: evaluationExecutor(observed, undefined, (resource) =>
            resource.includes("PRIVATE CANDIDATE") ? "verified\n" : "baseline failed\n",
          ),
        },
      ),
      evaluation.stderr.join("\n"),
    ).toBe(0);

    const dryRun = capture();
    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.candidatePath,
          "--evaluation",
          "skill-activation-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        dryRun.io,
        { cwd: fixture.project },
      ),
      dryRun.stderr.join("\n"),
    ).toBe(0);
    const preview = JSON.parse(dryRun.stdout.join("\n"));
    expect(preview).toMatchObject({
      dryRun: true,
      activation: {
        kind: "agent-skill-activation",
        selection: "candidate",
        workflowId: "skill-evaluation-workflow",
        skill: { name: "review", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
      proposal: { action: "activate", proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(dryRun.stdout.join("\n")).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");

    const applied = capture();
    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.candidatePath,
          "--evaluation",
          "skill-activation-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "release-operator",
          "--expected-digest",
          preview.proposal.proposalDigest,
        ],
        applied.io,
        { cwd: fixture.project },
      ),
      applied.stderr.join("\n"),
    ).toBe(0);

    const inspectedActivation = capture();
    expect(
      await main(["activation", "inspect", "skill-evaluation-workflow"], inspectedActivation.io, {
        cwd: fixture.project,
      }),
      inspectedActivation.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(inspectedActivation.stdout.join("\n"))).toMatchObject({
      workflowId: "skill-evaluation-workflow",
      active: {
        kind: "agent-skill-activation",
        selection: "candidate",
        candidateId: "better-review",
        candidateVersion: "1.0.0",
        candidate: {
          scope: { skillName: "review" },
          projectedSkill: { packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
        skill: { name: "review", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(inspectedActivation.stdout.join("\n")).not.toContain("contentBase64");
    expect(inspectedActivation.stdout.join("\n")).not.toContain(
      "PRIVATE CANDIDATE REVIEW INSTRUCTIONS",
    );

    await rm(fixture.candidatePath);
    await rm(join(fixture.project, "baseline.workflow.yaml"));
    await rm(join(fixture.project, "tuning.json"));
    await rm(join(fixture.project, ".flow", "skills", "review"), { recursive: true });
    const runObserved: Array<{ readonly digest: string; readonly resource: string }> = [];
    const run = capture();
    expect(
      await main(
        ["run", "activation:skill-evaluation-workflow", "--run-id", "activated-skill-run"],
        run.io,
        { cwd: fixture.project, executor: evaluationExecutor(runObserved) },
      ),
      run.stderr.join("\n"),
    ).toBe(0);
    expect(runObserved).toEqual([
      {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        resource: "PRIVATE CANDIDATE REVIEW INSTRUCTIONS\n",
      },
    ]);
    expect(run.stdout.join("\n")).not.toContain("PRIVATE CANDIDATE REVIEW INSTRUCTIONS");

    const baselinePreviewOutput = capture();
    expect(
      await main(
        [
          "activation",
          "rollback",
          "skill-evaluation-workflow",
          "--to",
          "baseline",
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        baselinePreviewOutput.io,
        { cwd: fixture.project },
      ),
      baselinePreviewOutput.stderr.join("\n"),
    ).toBe(0);
    const baselinePreview = JSON.parse(baselinePreviewOutput.stdout.join("\n"));
    expect(baselinePreview).toMatchObject({
      proposal: {
        target: { kind: "agent-skill-activation", selection: "baseline" },
      },
    });
    const baselineApplyOutput = capture();
    expect(
      await main(
        [
          "activation",
          "rollback",
          "skill-evaluation-workflow",
          "--to",
          "baseline",
          "--actor",
          "release-operator",
          "--expected-digest",
          baselinePreview.proposal.proposalDigest,
        ],
        baselineApplyOutput.io,
        { cwd: fixture.project },
      ),
      baselineApplyOutput.stderr.join("\n"),
    ).toBe(0);

    const baselineObserved: Array<{ readonly digest: string; readonly resource: string }> = [];
    const baselineRun = capture();
    expect(
      await main(
        ["run", "activation:skill-evaluation-workflow", "--run-id", "activated-skill-baseline-run"],
        baselineRun.io,
        { cwd: fixture.project, executor: evaluationExecutor(baselineObserved) },
      ),
      baselineRun.stderr.join("\n"),
    ).toBe(0);
    expect(baselineObserved).toEqual([
      {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        resource: "Check evidence.\n",
      },
    ]);

    const candidatePreviewOutput = capture();
    expect(
      await main(
        [
          "activation",
          "rollback",
          "skill-evaluation-workflow",
          "--to",
          "agent-skill:better-review@1.0.0",
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        candidatePreviewOutput.io,
        { cwd: fixture.project },
      ),
      candidatePreviewOutput.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(candidatePreviewOutput.stdout.join("\n"))).toMatchObject({
      proposal: {
        target: {
          kind: "agent-skill-activation",
          candidateId: "better-review",
          candidateVersion: "1.0.0",
          selection: "candidate",
        },
      },
    });

    const cancelledRollback = capture();
    const rollbackController = new AbortController();
    const rollbackReason = new Error("operator cancelled Agent Skill rollback");
    rollbackController.abort(rollbackReason);
    expect(
      await main(
        [
          "activation",
          "rollback",
          "skill-evaluation-workflow",
          "--to",
          "agent-skill:better-review@1.0.0",
          "--actor",
          "release-operator",
          "--expected-digest",
          JSON.parse(candidatePreviewOutput.stdout.join("\n")).proposal.proposalDigest,
        ],
        cancelledRollback.io,
        { cwd: fixture.project, signal: rollbackController.signal },
      ),
    ).toBe(1);
    expect(cancelledRollback.stderr).toEqual([rollbackReason.message]);
    const afterCancelledRollback = capture();
    expect(
      await main(
        ["activation", "inspect", "skill-evaluation-workflow"],
        afterCancelledRollback.io,
        { cwd: fixture.project },
      ),
    ).toBe(0);
    expect(JSON.parse(afterCancelledRollback.stdout.join("\n"))).toMatchObject({
      active: { kind: "agent-skill-activation", selection: "baseline" },
      head: { generation: 2 },
    });

    const invalidTargetOutput = capture();
    expect(
      await main(
        [
          "activation",
          "rollback",
          "skill-evaluation-workflow",
          "--to",
          "agent-skill:better-review@1.0.0@PRIVATE_TARGET",
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        invalidTargetOutput.io,
        { cwd: fixture.project },
      ),
    ).toBe(2);
    expect(invalidTargetOutput.stdout).toEqual([]);
    expect(invalidTargetOutput.stderr.join("\n")).toContain(
      "activation rollback target must be baseline",
    );
    expect(invalidTargetOutput.stderr.join("\n")).not.toContain("PRIVATE_TARGET");
  }, 20_000);

  it("keeps invalid baseline diagnostics private and validation read-only", async () => {
    const fixture = await candidateEvaluationProject();
    const privateWorkflow = JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "Workflow",
      metadata: { id: "skill-evaluation-workflow" },
      budget: {
        maxNodeStarts: 1,
        maxModelTokens: 1,
        maxCostUsd: 1,
        maxExecutionMs: 1,
        maxArtifactBytes: 1,
      },
      nodes: [
        {
          id: "PRIVATE_NODE",
          type: "result",
          dependsOn: ["PRIVATE_MISSING"],
          result: { source: { nodeId: "PRIVATE_MISSING", field: "result.value" } },
        },
      ],
    });
    await writeFile(join(fixture.project, "baseline.workflow.yaml"), privateWorkflow);
    const source = JSON.parse(await readFile(fixture.candidatePath, "utf8"));
    source.baseline.workflow.sourceSha256 = sha256(privateWorkflow);
    await writeFile(fixture.candidatePath, JSON.stringify(source));
    const before = await snapshotTree(fixture.project);
    const output = capture();

    expect(
      await main(["candidate", "validate", fixture.candidatePath], output.io, {
        cwd: fixture.project,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual(["invalid_source: candidate baseline workflow is invalid"]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE");
    expect(output.stderr.join("\n")).not.toContain(fixture.project);
    expect(await snapshotTree(fixture.project)).toEqual(before);
  });

  it("preserves cancellation before activation mutation", async () => {
    const fixture = await candidateEvaluationProject();
    const evaluations = join(fixture.project, "cancelled-activation-evaluations");
    const evaluation = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          fixture.planPath,
          "--evaluation-id",
          "cancelled-activation-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        evaluation.io,
        {
          cwd: fixture.project,
          executor: evaluationExecutor([], undefined, (resource) =>
            resource.includes("PRIVATE CANDIDATE") ? "verified\n" : "baseline failed\n",
          ),
        },
      ),
      evaluation.stderr.join("\n"),
    ).toBe(0);
    const controller = new AbortController();
    const reason = new Error("operator cancelled Agent Skill activation");
    const output = capture();

    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.candidatePath,
          "--evaluation",
          "cancelled-activation-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        output.io,
        {
          cwd: fixture.project,
          signal: controller.signal,
          loadConfig: async (options) => {
            const config = await loadEffectiveFlowConfig(options);
            queueMicrotask(() => controller.abort(reason));
            return config;
          },
        },
      ),
    ).toBe(1);
    expect(output.stderr).toEqual([reason.message]);
    await expect(
      readFile(join(fixture.project, ".flow", "activations", "index.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      name: "candidate activation",
      args: [
        "candidate",
        "activate",
        "candidate.json",
        "--evaluation",
        "evaluation-1",
        "--actor",
        "release-operator",
        "--dry-run",
      ],
    },
    {
      name: "activation rollback",
      args: [
        "activation",
        "rollback",
        "adaptive-workflow",
        "--to",
        "baseline",
        "--actor",
        "release-operator",
        "--dry-run",
      ],
    },
  ])("gives $name cancellation precedence over a simultaneous config failure", async ({ args }) => {
    const fixture = await candidateEvaluationProject();
    const controller = new AbortController();
    const reason = new Error("operator cancelled before activation configuration settled");
    const output = capture();

    expect(
      await main(args, output.io, {
        cwd: fixture.project,
        signal: controller.signal,
        loadConfig: async () => {
          controller.abort(reason);
          throw new Error("PRIVATE_CONFIG_FAILURE");
        },
      }),
    ).toBe(1);
    expect(output.stderr).toEqual([reason.message]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE_CONFIG_FAILURE");
  });

  it("does not start activation configuration after cancellation", async () => {
    const fixture = await candidateEvaluationProject();
    const controller = new AbortController();
    const reason = new Error("operator cancelled before activation configuration");
    controller.abort(reason);
    let configCalls = 0;
    const output = capture();

    expect(
      await main(
        [
          "activation",
          "rollback",
          "adaptive-workflow",
          "--to",
          "baseline",
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        output.io,
        {
          cwd: fixture.project,
          signal: controller.signal,
          loadConfig: async () => {
            configCalls += 1;
            throw new Error("PRIVATE_CONFIG_CALL");
          },
        },
      ),
    ).toBe(1);
    expect(configCalls).toBe(0);
    expect(output.stderr).toEqual([reason.message]);
  });

  it("cancels after plan admission without publishing an evaluation", async () => {
    const fixture = await candidateEvaluationProject();
    const evaluations = join(fixture.project, "cancelled-evaluations");
    const controller = new AbortController();
    const reason = new Error("operator cancelled before evaluation publication");
    const output = capture();

    expect(
      await main(
        [
          "eval",
          "run",
          fixture.planPath,
          "--evaluation-id",
          "cancelled-skill-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        output.io,
        {
          cwd: fixture.project,
          signal: controller.signal,
          loadConfig: async (options) => {
            const config = await loadEffectiveFlowConfig(options);
            controller.abort(reason);
            return config;
          },
        },
      ),
    ).toBe(1);
    expect(output.stderr).toEqual([reason.message]);
    await expect(
      readFile(join(evaluations, "cancelled-skill-evaluation", "plan.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases evaluation ownership when post-claim setup fails", async () => {
    const fixture = await candidateEvaluationProject();
    const evaluations = join(fixture.project, "setup-failure-evaluations");
    const args = [
      "eval",
      "run",
      fixture.planPath,
      "--evaluation-id",
      "setup-failure-skill-evaluation",
      "--evaluations-dir",
      evaluations,
    ] as const;
    const reason = new Error("PRIVATE_SETUP_FAILURE");
    const failed = capture();

    expect(
      await main(args, failed.io, {
        cwd: fixture.project,
        createWorkspaceIsolator: () => {
          throw reason;
        },
      }),
    ).toBe(1);
    expect(failed.stderr).toEqual([reason.message]);

    const resumed = capture();
    await expect(
      main(args, resumed.io, {
        cwd: fixture.project,
        executor: evaluationExecutor([]),
      }),
    ).resolves.toBe(0);
    expect(resumed.stderr).toEqual([]);
  });
});

async function candidateEvaluationProject() {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-agent-skill-candidate-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "skills", "review"), { recursive: true });
  await writeFile(
    join(project, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
  );
  await writeFile(
    join(project, ".flow", "skills", "review", "SKILL.md"),
    `---
name: review
description: Review the result against the task.
metadata:
  owner: synapti
allowed-tools: Read
---
# Review

Check correctness.
`,
  );
  const baselineResource = "Check evidence.\n";
  await writeFile(join(project, ".flow", "skills", "review", "reference.md"), baselineResource);
  await mkdir(join(project, "fixtures", "review-task"), { recursive: true });
  await writeFile(join(project, "fixtures", "review-task", "TASK.md"), "Create RESULT.md.\n");
  await writeFile(join(project, "fixtures", "review-task", "RESULT.md"), "pending\n");
  const workflowText = workflowSource();
  const workflowDigest = calculateWorkflowDigest(compileWorkflowText(workflowText));
  await writeFile(join(project, "baseline.workflow.yaml"), workflowText);
  const evidence = promptCandidateTuningEvidence(workflowDigest);
  const evidenceText = JSON.stringify(evidence);
  await writeFile(join(project, "tuning.json"), evidenceText);
  const snapshot = await snapshotSelectedAgentSkills(await discoverProjectAgentSkills(project), [
    "review",
  ]);
  const skill = snapshot.packages[0];
  if (skill === undefined) {
    throw new Error("Agent Skill CLI fixture has no baseline package");
  }
  const candidatePath = join(project, "better.agent-skill-candidate.yaml");
  await writeFile(
    candidatePath,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AgentSkillCandidate",
      metadata: { id: "better-review", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-skill",
        workflowId: "skill-evaluation-workflow",
        skillName: "review",
      },
      baseline: {
        workflow: {
          path: "baseline.workflow.yaml",
          sourceSha256: sha256(workflowText),
          workflowDigest,
        },
        skill: { path: ".flow/skills/review", packageDigest: skill.digest },
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
        resources: [
          {
            path: "reference.md",
            expectedSha256: sha256(baselineResource),
            value: "PRIVATE CANDIDATE REVIEW INSTRUCTIONS\n",
          },
        ],
      },
    }),
  );
  const planPath = join(project, "evaluation.yaml");
  await writeFile(planPath, evaluationPlanSource());
  return { project, candidatePath, planPath, baselineSkillDigest: skill.digest };
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: skill-evaluation-workflow }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: review
    type: agent
    agent:
      prompt: Review TASK.md.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
      skills: [review]
  - id: publish
    type: result
    dependsOn: [review]
    result:
      source: { nodeId: review, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function evaluationPlanSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: skill-candidate-evaluation }
suite:
  id: skill-suite
  version: 1.0.0
  tasks:
    - id: review-task
      partition: holdout
      fixture: fixtures/review-task
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: sha256, path: RESULT.md, value: ${sha256("verified\n")} }]
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: flow-workflow-v1, candidate: better.agent-skill-candidate.yaml }
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
seeds: [11]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 1
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}

function evaluationExecutor(
  observed: Array<{ readonly digest: string; readonly resource: string }>,
  afterFirstExecution?: () => Promise<void>,
  resultForResource: (resource: string) => string = () => "verified\n",
): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type !== "agent" || context.capabilitySnapshot === undefined) {
        throw new Error("Agent Skill evaluation requires one bound agent snapshot");
      }
      const skill = context.capabilitySnapshot.packages.find(
        (item): item is AgentSkillPackageSnapshot => item.kind === "agent-skill",
      );
      const resource = skill?.files.find((file) => file.path === "reference.md");
      if (skill === undefined || resource === undefined) {
        throw new Error("Agent Skill evaluation snapshot is incomplete");
      }
      observed.push({
        digest: context.capabilitySnapshot.digest,
        resource: Buffer.from(resource.contentBase64, "base64").toString("utf8"),
      });
      if (observed.length === 1) {
        await afterFirstExecution?.();
      }
      const resourceText = Buffer.from(resource.contentBase64, "base64").toString("utf8");
      await writeFile(join(context.cwd, "RESULT.md"), resultForResource(resourceText));
      const text = '"done"';
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
          usage: {
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1,
            costUsdMicros: 1,
          },
          activity: { turns: 1, toolCalls: 1, toolErrors: 0 },
          policyDecisions: [],
          effectReceipts: [],
          capabilities: createAgentCapabilityEvidence(context.capabilitySnapshot, ["review"]),
        },
      };
    },
  };
}

async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        await visit(path, relativePath);
      } else {
        snapshot[relativePath] = (await readFile(path)).toString("base64");
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
