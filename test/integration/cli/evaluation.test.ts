import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("evaluation CLI", () => {
  it("validates without mutation, then runs, inspects, and exports offline evidence", async () => {
    const project = await evaluationProject();
    const evaluations = join(project, "evaluations");
    const planPath = join(project, "evaluation.yaml");
    const validation = capture();

    expect(await main(["eval", "validate", planPath], validation.io, { cwd: project })).toBe(0);
    expect(JSON.parse(validation.stdout.join("\n"))).toMatchObject({
      valid: true,
      id: "harness-comparison",
      scheduledTrials: 2,
    });
    await expect(stat(evaluations)).rejects.toMatchObject({ code: "ENOENT" });

    const run = capture();
    expect(
      await main(["eval", "run", planPath, "--evaluations-dir", evaluations], run.io, {
        cwd: project,
        executor: evaluationExecutor(),
      }),
      [...run.stderr, ...run.stdout].join("\n"),
    ).toBe(0);
    const runEvidence = JSON.parse(run.stdout.join("\n"));
    expect(runEvidence, JSON.stringify(runEvidence.records, null, 2)).toMatchObject({
      header: { evaluationId: "harness-comparison" },
      records: [
        { classification: "verified_success", profileId: "baseline" },
        { classification: "verified_success", profileId: "candidate" },
      ],
      report: {
        scheduledTrials: 2,
        committedTrials: 2,
        comparison: { verdict: "not_superior", completePairs: 1 },
      },
    });

    const inspect = capture();
    expect(
      await main(
        ["eval", "inspect", "harness-comparison", "--evaluations-dir", evaluations],
        inspect.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(inspect.stdout.join("\n"))).toEqual(runEvidence);

    const output = join(project, "evaluation-export.json");
    const exported = capture();
    expect(
      await main(
        [
          "eval",
          "export",
          "harness-comparison",
          "--evaluations-dir",
          evaluations,
          "--output",
          output,
        ],
        exported.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(runEvidence);

    const refused = capture();
    expect(
      await main(
        [
          "eval",
          "export",
          "harness-comparison",
          "--evaluations-dir",
          evaluations,
          "--output",
          output,
        ],
        refused.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(refused.stderr.join("\n")).toMatch(/exists|overwrite/i);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(runEvidence);
  });
});

async function evaluationProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "flow-evaluation-cli-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, "fixtures/task"), { recursive: true });
  await writeFile(join(project, "fixtures/task", "TASK.md"), "Create RESULT.md.\n");
  const workflow = `apiVersion: flow.synapti.ai/v1alpha1
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
  await writeFile(join(project, "baseline.workflow.yaml"), workflow);
  await writeFile(join(project, "candidate.workflow.yaml"), workflow);
  await writeFile(
    join(project, "evaluation.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: harness-comparison }
suite:
  id: foundation-suite
  version: 1.0.0
  tasks:
    - id: task
      partition: holdout
      fixture: fixtures/task
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: exists, path: RESULT.md }]
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

function evaluationExecutor(): NodeExecutor {
  return {
    execute: async (node, context) => {
      if (node.type !== "agent") {
        throw new Error("unexpected executable node");
      }
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
