import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("prompt candidate CLI", () => {
  it("exports tuning-only evidence, validates a candidate, and evaluates its exact projection", async () => {
    const project = await candidateEvaluationProject();
    const evaluations = join(project, "evaluations");
    const firstRun = capture();
    expect(
      await main(
        ["eval", "run", join(project, "source.evaluation.yaml"), "--evaluations-dir", evaluations],
        firstRun.io,
        { cwd: project, executor: evaluationExecutor() },
      ),
      firstRun.stderr.join("\n"),
    ).toBe(0);

    const evidencePath = join(project, "tuning-evidence.json");
    const exported = capture();
    expect(
      await main(
        [
          "eval",
          "tuning-evidence",
          "source-evaluation",
          "--evaluations-dir",
          evaluations,
          "--output",
          evidencePath,
        ],
        exported.io,
        { cwd: project },
      ),
      exported.stderr.join("\n"),
    ).toBe(0);
    const evidenceText = await readFile(evidencePath, "utf8");
    const evidence = JSON.parse(evidenceText);
    expect(evidence).toMatchObject({
      kind: "flow.tuning-evidence/v1",
      evaluation: { id: "source-evaluation", completedTrials: 4, scheduledTrials: 4 },
      tasks: [{ id: "tuning-task" }],
    });
    expect(evidenceText).not.toContain("holdout-secret");
    expect(evidenceText).not.toContain("RESULT.md");
    expect(evidenceText).not.toContain("runId");

    const refusedEvidence = capture();
    expect(
      await main(
        [
          "eval",
          "tuning-evidence",
          "source-evaluation",
          "--evaluations-dir",
          evaluations,
          "--output",
          evidencePath,
        ],
        refusedEvidence.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(refusedEvidence.stderr.join("\n")).toMatch(/exists|overwrite/i);
    expect(await readFile(evidencePath, "utf8")).toBe(evidenceText);

    const baselineText = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    const baselineDigest = calculateWorkflowDigest(compileWorkflowText(baselineText));
    const candidatePath = join(project, "better.prompt-candidate.yaml");
    const candidateSource = {
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "better-instructions", version: "1.0.0" },
      scope: { kind: "workflow", workflowId: "evaluated-profile" },
      baseline: {
        workflow: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: baselineDigest,
      },
      evidence: [
        {
          path: "tuning-evidence.json",
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
            value: "Read TASK.md, implement exactly what it asks, then verify the result.",
          },
        ],
      },
    };
    const candidateText = JSON.stringify(candidateSource);
    await writeFile(candidatePath, candidateText);

    const validation = capture();
    expect(
      await main(["candidate", "validate", candidatePath], validation.io, { cwd: project }),
    ).toBe(0);
    const validatedCandidate = JSON.parse(validation.stdout.join("\n"));
    expect(validatedCandidate).toMatchObject({
      valid: true,
      candidate: {
        id: "better-instructions",
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        changes: [{ nodeId: "implement" }],
      },
    });
    expect(validation.stdout.join("\n")).not.toContain("Read TASK.md, implement exactly");

    const candidatePlanPath = join(project, "candidate.evaluation.yaml");
    const sourcePlan = await readFile(join(project, "source.evaluation.yaml"), "utf8");
    await writeFile(
      candidatePlanPath,
      sourcePlan
        .replace("id: source-evaluation", "id: candidate-evaluation")
        .replace("workflow: candidate.workflow.yaml", "candidate: better.prompt-candidate.yaml"),
    );
    const planValidation = capture();
    expect(
      await main(["eval", "validate", candidatePlanPath], planValidation.io, { cwd: project }),
    ).toBe(0);
    expect(JSON.parse(planValidation.stdout.join("\n")).profiles[1]).toMatchObject({
      id: "candidate",
      candidateDigest: validatedCandidate.candidate.candidateDigest,
    });

    const observedPrompts: string[] = [];
    const candidateRun = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          candidatePlanPath,
          "--evaluation-id",
          "candidate-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        candidateRun.io,
        { cwd: project, executor: evaluationExecutor(observedPrompts) },
      ),
      candidateRun.stderr.join("\n"),
    ).toBe(0);
    expect(observedPrompts).toContain("Follow TASK.md exactly.");
    expect(observedPrompts).toContain(
      "Read TASK.md, implement exactly what it asks, then verify the result.",
    );
    expect(JSON.parse(candidateRun.stdout.join("\n")).header.profiles[1]).toMatchObject({
      candidate: {
        identity: { candidateDigest: validatedCandidate.candidate.candidateDigest },
      },
    });
    expect(await readFile(join(project, "baseline.workflow.yaml"), "utf8")).toBe(baselineText);

    const inspected = capture();
    expect(
      await main(
        ["eval", "inspect", "candidate-evaluation", "--evaluations-dir", evaluations],
        inspected.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(inspected.stdout.join("\n")).header.profiles[1]).toMatchObject({
      candidate: {
        identity: { candidateDigest: validatedCandidate.candidate.candidateDigest },
      },
    });

    const offlineExportPath = join(project, "candidate-evaluation.json");
    const offlineExport = capture();
    expect(
      await main(
        [
          "eval",
          "export",
          "candidate-evaluation",
          "--evaluations-dir",
          evaluations,
          "--output",
          offlineExportPath,
        ],
        offlineExport.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(offlineExportPath, "utf8")).header.profiles[1]).toMatchObject({
      candidate: {
        identity: { candidateDigest: validatedCandidate.candidate.candidateDigest },
      },
    });

    await writeFile(
      candidatePath,
      JSON.stringify({
        ...candidateSource,
        metadata: { ...candidateSource.metadata, version: "1.0.1" },
      }),
    );
    const driftedResume = capture();
    expect(
      await main(
        [
          "eval",
          "run",
          candidatePlanPath,
          "--evaluation-id",
          "candidate-evaluation",
          "--evaluations-dir",
          evaluations,
        ],
        driftedResume.io,
        { cwd: project, executor: evaluationExecutor() },
      ),
    ).toBe(1);
    expect(driftedResume.stderr.join("\n")).toMatch(/identity|plan digest/i);
    await writeFile(candidatePath, candidateText);

    const headerPath = join(evaluations, "candidate-evaluation", "plan.json");
    const tamperedHeader = JSON.parse(await readFile(headerPath, "utf8"));
    delete tamperedHeader.profiles[1].candidate;
    await writeFile(headerPath, `${JSON.stringify(tamperedHeader)}\n`);
    const tamperedInspect = capture();
    expect(
      await main(
        ["eval", "inspect", "candidate-evaluation", "--evaluations-dir", evaluations],
        tamperedInspect.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(tamperedInspect.stderr.join("\n")).toBe("corrupt: invalid evaluation public header");
  }, 20_000);
});

async function candidateEvaluationProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "flow-candidate-cli-"));
  temporaryDirectories.push(project);
  for (const task of ["tuning-task", "holdout-secret"]) {
    await mkdir(join(project, "fixtures", task), { recursive: true });
    await writeFile(join(project, "fixtures", task, "TASK.md"), "Create RESULT.md.\n");
    await writeFile(join(project, "fixtures", task, "RESULT.md"), "pending\n");
  }
  const workflow = workflowSource();
  await writeFile(join(project, "baseline.workflow.yaml"), workflow);
  await writeFile(join(project, "candidate.workflow.yaml"), workflow);
  await writeFile(
    join(project, "source.evaluation.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: source-evaluation }
suite:
  id: adaptive-suite
  version: 1.0.0
  tasks:
    - id: tuning-task
      partition: tuning
      fixture: fixtures/tuning-task
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: sha256, path: RESULT.md, value: ${sha256("verified\n")} }]
    - id: holdout-secret
      partition: holdout
      fixture: fixtures/holdout-secret
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: sha256, path: RESULT.md, value: ${sha256("verified\n")} }]
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
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
`,
  );
  return project;
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
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
      prompt: Follow TASK.md exactly.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function evaluationExecutor(observedPrompts: string[] = []): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type !== "agent") {
        throw new Error("unexpected executable node");
      }
      observedPrompts.push(node.agent.prompt);
      await writeFile(join(context.cwd, "RESULT.md"), "verified\n");
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: "test",
          model: "deterministic",
          text: '"done"',
          textHash: sha256('"done"'),
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
