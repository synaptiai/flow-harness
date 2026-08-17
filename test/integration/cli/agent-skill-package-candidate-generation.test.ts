import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  type AgentSkillPackageSnapshot,
  createAgentCapabilityEvidence,
} from "../../../src/domain/capability/agent-skills.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
  sha256,
} from "../../fixtures/agent-skill-package-candidate-generation.js";
import {
  promptCandidateTuningEvidence,
  promptCandidateWorkflowText,
} from "../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Agent Skill package candidate generation CLI", () => {
  it("publishes one reviewable package directory and re-admits it without activation", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor }),
      output.stderr.join("\n"),
    ).toBe(0);

    const manifest = JSON.parse(await readFile(join(fixture.outputPath, "CANDIDATE.json"), "utf8"));
    expect(manifest).toMatchObject({
      kind: "AgentSkillPackageCandidate",
      metadata: { id: "generated-review-helper", version: "1.0.0" },
      scope: {
        workflowId: "adaptive-workflow",
        nodeId: "implement",
        skillName: "review-helper",
      },
      package: {
        path: "skill/review-helper",
        packageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      generation: {
        provider: "test",
        model: "deterministic",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(await readFile(join(fixture.outputPath, "skill/review-helper/SKILL.md"), "utf8")).toBe(
      `---\nname: review-helper\ndescription: "Review an implementation against the task."\nlicense: "MIT"\ncompatibility: "Flow 1.x"\nmetadata:\n  "owner": "synapti"\n  "tier": "review"\nallowed-tools: "Read"\n---\n# Review helper\n\nRead the checklist and report evidence-backed findings.\n`,
    );
    expect(
      await readFile(
        join(fixture.outputPath, "skill/review-helper/references/checklist.md"),
        "utf8",
      ),
    ).toBe("# Checklist\n\n- Check correctness.\n- Check privacy.\n");

    const publicOutput = output.stdout.join("\n");
    expect(JSON.parse(publicOutput)).toMatchObject({
      generated: true,
      output: "generated-review-helper",
      candidate: {
        kind: "agent-skill-package-candidate",
        id: "generated-review-helper",
        version: "1.0.0",
        skill: "review-helper",
        paths: ["SKILL.md", "references/checklist.md"],
        provider: "test",
        model: "deterministic",
        limits: { turns: 1, maxOutputBytes: 65_536, maxOutputTokens: 8_192 },
      },
    });
    expect(publicOutput).not.toContain("Read the checklist");
    expect(publicOutput).not.toContain(Buffer.from("Read the checklist").toString("base64"));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await expect(access(join(fixture.root, ".flow", "activations"))).rejects.toThrow();

    const validation = capture();
    expect(
      await main(["candidate", "validate", fixture.outputPath], validation.io, {
        cwd: fixture.root,
      }),
      validation.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(validation.stdout.join("\n"))).toMatchObject({
      valid: true,
      candidate: {
        kind: "agent-skill-package-candidate",
        package: {
          name: "review-helper",
          packageDigest: manifest.package.packageDigest,
        },
      },
    });

    const observed: Array<{ readonly packages: number; readonly checklist: string | null }> = [];
    const evaluations = join(fixture.root, "evaluations");
    const evaluation = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          fixture.planPath,
          "--evaluation-id",
          "generated-package-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        evaluation.io,
        { cwd: fixture.root, executor: evaluationExecutor(observed) },
      ),
      evaluation.stderr.join("\n"),
    ).toBe(0);
    expect(observed).toEqual([
      { packages: 0, checklist: null },
      {
        packages: 1,
        checklist: "# Checklist\n\n- Check correctness.\n- Check privacy.\n",
      },
      {
        packages: 1,
        checklist: "# Checklist\n\n- Check correctness.\n- Check privacy.\n",
      },
      { packages: 0, checklist: null },
    ]);
    const evaluationEvidence = JSON.parse(evaluation.stdout.join("\n"));
    expect(
      evaluationEvidence.records.map(
        (record: {
          profileId: string;
          harness: { outcome: string; reason: string | null };
          verification: { outcome: string };
          metrics: { policyViolations: number | null };
        }) => ({
          profileId: record.profileId,
          harness: record.harness.outcome,
          reason: record.harness.reason,
          verification: record.verification.outcome,
          policyViolations: record.metrics.policyViolations,
        }),
      ),
    ).toEqual([
      {
        profileId: "baseline",
        harness: "completed",
        reason: null,
        verification: "rejected",
        policyViolations: 0,
      },
      {
        profileId: "candidate",
        harness: "completed",
        reason: null,
        verification: "accepted",
        policyViolations: 0,
      },
      {
        profileId: "candidate",
        harness: "completed",
        reason: null,
        verification: "accepted",
        policyViolations: 0,
      },
      {
        profileId: "baseline",
        harness: "completed",
        reason: null,
        verification: "rejected",
        policyViolations: 0,
      },
    ]);
    expect(evaluationEvidence.report.comparison).toMatchObject({
      verdict: "superior",
      completePairs: 2,
      comparablePairs: 2,
      pairedSuccessDelta: 1,
      confidenceInterval: expect.objectContaining({ lower: expect.any(Number) }),
      constraints: {
        falseCompletionRate: true,
        policyViolations: true,
        verifiedSuccessRegression: true,
      },
    });

    const dryRun = capture();
    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.outputPath,
          "--evaluation",
          "generated-package-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "release-operator",
          "--dry-run",
        ],
        dryRun.io,
        { cwd: fixture.root },
      ),
      dryRun.stderr.join("\n"),
    ).toBe(0);
    const preview = JSON.parse(dryRun.stdout.join("\n"));
    expect(preview).toMatchObject({
      activation: {
        kind: "agent-skill-package-activation",
        selection: "candidate",
        skill: { name: "review-helper", digest: manifest.package.packageDigest },
      },
      proposal: { proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const applied = capture();
    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.outputPath,
          "--evaluation",
          "generated-package-evaluation",
          "--evaluations-dir",
          evaluations,
          "--actor",
          "release-operator",
          "--expected-digest",
          preview.proposal.proposalDigest,
        ],
        applied.io,
        { cwd: fixture.root },
      ),
      applied.stderr.join("\n"),
    ).toBe(0);

    await rm(fixture.outputPath, { recursive: true });
    await rm(fixture.baselinePath);
    await rm(fixture.evidencePath);
    await rm(fixture.blueprintPath);
    const activatedObserved: Array<{
      readonly packages: number;
      readonly checklist: string | null;
    }> = [];
    const run = capture();
    expect(
      await main(
        ["run", "activation:adaptive-workflow", "--run-id", "generated-package-run"],
        run.io,
        { cwd: fixture.root, executor: evaluationExecutor(activatedObserved) },
      ),
      run.stderr.join("\n"),
    ).toBe(0);
    expect(activatedObserved).toContainEqual({
      packages: 1,
      checklist: "# Checklist\n\n- Check correctness.\n- Check privacy.\n",
    });
    expect(run.stdout.join("\n")).not.toContain("Check privacy");

    const rollbackPreviewOutput = capture();
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
        rollbackPreviewOutput.io,
        { cwd: fixture.root },
      ),
      rollbackPreviewOutput.stderr.join("\n"),
    ).toBe(0);
    const rollbackPreview = JSON.parse(rollbackPreviewOutput.stdout.join("\n"));
    expect(rollbackPreview).toMatchObject({
      proposal: {
        target: { kind: "agent-skill-package-activation", selection: "baseline" },
      },
    });
    const rollbackApplyOutput = capture();
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
          "--expected-digest",
          rollbackPreview.proposal.proposalDigest,
        ],
        rollbackApplyOutput.io,
        { cwd: fixture.root },
      ),
      rollbackApplyOutput.stderr.join("\n"),
    ).toBe(0);
    const baselineObserved: Array<{
      readonly packages: number;
      readonly checklist: string | null;
    }> = [];
    const baselineRun = capture();
    expect(
      await main(
        ["run", "activation:adaptive-workflow", "--run-id", "generated-package-baseline-run"],
        baselineRun.io,
        { cwd: fixture.root, executor: evaluationExecutor(baselineObserved) },
      ),
      baselineRun.stderr.join("\n"),
    ).toBe(0);
    expect(baselineObserved).toEqual([{ packages: 0, checklist: null }]);
  });

  it("rejects a mixed blueprint and resource mode before model execution", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(
      await main([...generationArgs(fixture), "--skill", "review-helper"], output.io, {
        cwd: fixture.root,
        executor,
      }),
    ).toBe(2);
    expect(output.stderr.join("\n")).toContain("exactly one");
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("rejects an existing review directory before model execution", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();
    await mkdir(fixture.outputPath);

    expect(await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor })).toBe(1);
    expect(output.stderr.join("\n")).toContain("output_exists");
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

function generationExecutor(): NodeExecutor & {
  execute: ReturnType<typeof vi.fn<NodeExecutor["execute"]>>;
} {
  return {
    execute: vi.fn<NodeExecutor["execute"]>(async (node) => {
      if (node.type !== "agent") {
        throw new Error("Agent Skill package generation used a non-agent node");
      }
      expect(node.agent.tools).toEqual([]);
      expect(node.agent.skills).toEqual([]);
      expect(node.agent.toolPackages).toEqual([]);
      return {
        status: "succeeded",
        evidence: generationEvidence(agentSkillPackageGenerationResponse),
      };
    }),
  };
}

function generationEvidence(text: string): AgentEvidence {
  return {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 5,
    usage: {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      costUsdMicros: 10,
    },
    activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
    policyDecisions: [],
    effectReceipts: [],
  };
}

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-skill-package-cli-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".flow"), { recursive: true });
  await writeFile(
    join(root, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
    "utf8",
  );
  const generation = agentSkillPackageCandidateGenerationFixture();
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "private-tuning-evidence.json");
  const blueprintPath = join(root, "review-helper.blueprint.json");
  const outputPath = join(root, "generated-review-helper");
  await mkdir(join(root, "fixtures", "review-task"), { recursive: true });
  await writeFile(join(root, "fixtures", "review-task", "TASK.md"), "Create RESULT.md.\n");
  await writeFile(join(root, "fixtures", "review-task", "RESULT.md"), "pending\n");
  const planPath = join(root, "evaluation.yaml");
  const baselineText = packageWorkflowText();
  const evidence = promptCandidateTuningEvidence(
    calculateWorkflowDigest(compileWorkflowText(baselineText, "baseline.workflow.yaml")),
  );
  await writeFile(baselinePath, baselineText, "utf8");
  await writeFile(evidencePath, JSON.stringify(evidence), "utf8");
  await writeFile(blueprintPath, generation.blueprintText, "utf8");
  await writeFile(planPath, evaluationPlanSource(), "utf8");
  return { root, baselinePath, evidencePath, blueprintPath, outputPath, planPath };
}

function packageWorkflowText(): string {
  return JSON.stringify({
    ...(JSON.parse(promptCandidateWorkflowText()) as Record<string, unknown>),
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 10_000,
      maxCostUsd: 1,
      maxExecutionMs: 300_000,
      maxArtifactBytes: 1_048_576,
    },
  });
}

function generationArgs(fixture: Awaited<ReturnType<typeof localFixture>>): string[] {
  return [
    "candidate",
    "generate",
    fixture.baselinePath,
    fixture.evidencePath,
    "--output",
    fixture.outputPath,
    "--id",
    "generated-review-helper",
    "--version",
    "1.0.0",
    "--blueprint",
    fixture.blueprintPath,
    "--provider",
    "test",
    "--model",
    "deterministic",
  ];
}

function evaluationPlanSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: generated-package-evaluation }
suite:
  id: generated-package-suite
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
  - { id: candidate, adapter: flow-workflow-v1, candidate: generated-review-helper }
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
seeds: [11, 12]
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

function evaluationExecutor(
  observed: Array<{ readonly packages: number; readonly checklist: string | null }>,
): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type !== "agent") {
        throw new Error("Agent Skill package evaluation requires an agent node");
      }
      const packages = context.capabilitySnapshot?.packages ?? [];
      const skill = packages.find(
        (item): item is AgentSkillPackageSnapshot => item.kind === "agent-skill",
      );
      const checklist = skill?.files.find((file) => file.path === "references/checklist.md");
      if (node.id === "implement") {
        observed.push({
          packages: packages.length,
          checklist:
            checklist === undefined
              ? null
              : Buffer.from(checklist.contentBase64, "base64").toString("utf8"),
        });
      }
      await writeFile(
        join(context.cwd, "RESULT.md"),
        skill === undefined ? "failed\n" : "verified\n",
      );
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
          ...(context.capabilitySnapshot === undefined || node.agent.skills.length === 0
            ? {}
            : {
                capabilities: createAgentCapabilityEvidence(
                  context.capabilitySnapshot,
                  node.agent.skills,
                ),
              }),
        },
      };
    },
  };
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
