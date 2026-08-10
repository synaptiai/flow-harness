import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExternalHarnessRuntime } from "../../../src/application/external-harness-adapter.js";
import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { unavailableEvaluationMetrics } from "../../../src/domain/evaluation/records.js";
import { NativePiHarnessRegistry } from "../../../src/infrastructure/pi/native-pi-harness-registry.js";

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

  it("compares a Flow profile with the native Pi adapter boundary", async () => {
    const project = await externalEvaluationProject();
    const evaluations = join(project, "evaluations");
    const planDirectory = await mkdtemp(join(tmpdir(), "flow-external-plan-"));
    temporaryDirectories.push(planDirectory);
    const planPath = join(planDirectory, "external-evaluation.yaml");
    await mkdir(join(planDirectory, "fixtures/task"), { recursive: true });
    await Promise.all([
      writeFile(planPath, await readFile(join(project, "external-evaluation.yaml"))),
      writeFile(
        join(planDirectory, "baseline.workflow.yaml"),
        await readFile(join(project, "baseline.workflow.yaml")),
      ),
      writeFile(
        join(planDirectory, "fixtures/task/TASK.md"),
        await readFile(join(project, "fixtures/task/TASK.md")),
      ),
      writeFile(
        join(planDirectory, "fixtures/task/RESULT.md"),
        await readFile(join(project, "fixtures/task/RESULT.md")),
      ),
    ]);
    const registry = await externalRegistry(project);
    let isolation: Parameters<ExternalHarnessRuntime["execute"]>[0]["isolation"] | undefined;
    const runtime: ExternalHarnessRuntime = {
      execute: async (request) => {
        isolation = request.isolation;
        await writeFile(join(request.evaluation.workspace.cwd, "RESULT.md"), "verified\n");
        return {
          harness: {
            outcome: "completed",
            runId: "native-pi-session",
            reason: null,
            runtime: {
              adapter: "pi-native-v1",
              containment: "linux-pid-namespace",
              exitCode: 0,
              signal: null,
              timedOut: false,
              aborted: false,
              treeTermination: "confirmed",
            },
          },
          metrics: unavailableEvaluationMetrics(),
        };
      },
    };
    const output = capture();

    expect(
      await main(["eval", "run", planPath, "--evaluations-dir", evaluations], output.io, {
        cwd: project,
        executor: evaluationExecutor(),
        externalHarnessRegistry: registry,
        externalHarnessRuntime: runtime,
      }),
      [...output.stderr, ...output.stdout].join("\n"),
    ).toBe(0);
    expect(JSON.parse(output.stdout.join("\n"))).toMatchObject({
      records: [
        { profileId: "baseline", classification: "verified_success" },
        {
          profileId: "candidate",
          classification: "verified_success",
          harness: { runtime: { adapter: "pi-native-v1", treeTermination: "confirmed" } },
        },
      ],
    });
    const canonicalProject = await realpath(project);
    const canonicalPlanDirectory = await realpath(planDirectory);
    expect(isolation).toEqual({
      projectRoot: canonicalProject,
      protectedPaths: [
        canonicalPlanDirectory,
        join(evaluations, "external-harness-comparison"),
        join(canonicalProject, ".flow"),
      ],
    });

    const inspected = capture();
    expect(
      await main(
        ["eval", "inspect", "external-harness-comparison", "--evaluations-dir", evaluations],
        inspected.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(inspected.stdout.join("\n"))).toMatchObject({
      header: {
        profiles: [{ adapter: "flow-workflow-v1" }, { adapter: "pi-native-v1" }],
      },
    });

    const exportPath = join(project, "external-evidence.json");
    expect(
      await main(
        [
          "eval",
          "export",
          "external-harness-comparison",
          "--evaluations-dir",
          evaluations,
          "--output",
          exportPath,
        ],
        capture().io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(exportPath, "utf8"))).toEqual(
      JSON.parse(inspected.stdout.join("\n")),
    );

    const tuning = capture();
    expect(
      await main(
        [
          "eval",
          "tuning-evidence",
          "external-harness-comparison",
          "--evaluations-dir",
          evaluations,
          "--output",
          join(project, "unsupported-tuning.json"),
        ],
        tuning.io,
        { cwd: project },
      ),
    ).toBe(2);
    expect(tuning.stderr.join("\n")).toMatch(/tuning evidence.*external harness/i);
  });

  it("rejects an external profile without a configured Flow project root", async () => {
    const project = await externalEvaluationProject();
    const invocation = await mkdtemp(join(tmpdir(), "flow-external-invocation-"));
    temporaryDirectories.push(invocation);
    const registry = await externalRegistry(project);
    let runtimeCalled = false;
    const output = capture();

    expect(
      await main(
        [
          "eval",
          "run",
          join(project, "external-evaluation.yaml"),
          "--evaluations-dir",
          join(invocation, "evaluations"),
        ],
        output.io,
        {
          cwd: invocation,
          executor: evaluationExecutor(),
          externalHarnessRegistry: registry,
          externalHarnessRuntime: {
            execute: async () => {
              runtimeCalled = true;
              throw new Error("external runtime must not start");
            },
          },
        },
      ),
    ).toBe(2);
    expect(output.stderr.join("\n")).toMatch(/configured Flow project root/i);
    expect(runtimeCalled).toBe(false);
  });
});

async function evaluationProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "flow-evaluation-cli-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"), { recursive: true });
  await writeFile(
    join(project, ".flow/config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
  );
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

async function externalEvaluationProject(): Promise<string> {
  const project = await evaluationProject();
  await writeFile(join(project, "fixtures/task", "RESULT.md"), "PENDING\n");
  await writeFile(
    join(project, "external-evaluation.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: external-harness-comparison }
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
        assertions: [{ kind: sha256, path: RESULT.md, value: ${sha256("verified\n")} }]
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: pi-native-v1, harness: { config: pi-evaluation-v1 } }
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

async function externalRegistry(project: string): Promise<NativePiHarnessRegistry> {
  const sourceRoot = join(project, "trusted-source");
  const piCodingAgentRoot = join(project, "trusted-packages/pi-coding-agent");
  const piAiRoot = join(project, "trusted-packages/pi-ai");
  const sandboxRuntimeRoot = join(project, "trusted-packages/sandbox-runtime");
  await Promise.all(
    [sourceRoot, piCodingAgentRoot, piAiRoot, sandboxRuntimeRoot].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const driverPath = join(sourceRoot, "trusted-driver.js");
  const protocolPath = join(sourceRoot, "trusted-protocol.js");
  await Promise.all([
    writeFile(driverPath, "export const driver = 1;\n"),
    writeFile(protocolPath, "export const protocol = 1;\n"),
    writePackage(piCodingAgentRoot, "@earendil-works/pi-coding-agent", "0.84.0"),
    writePackage(piAiRoot, "@earendil-works/pi-ai", "0.84.0"),
    writePackage(sandboxRuntimeRoot, "@anthropic-ai/sandbox-runtime", "0.0.70"),
  ]);
  return new NativePiHarnessRegistry({
    driverPath,
    protocolPath,
    nodeExecutable: process.execPath,
    runtimeSupportPaths: [sourceRoot],
    sourceRoot,
    localDependencyRoots: [],
    piCodingAgentRoot,
    piAiRoot,
    sandboxRuntimeRoot,
  });
}

async function writePackage(root: string, name: string, version: string): Promise<void> {
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({ name, version })}\n`),
    writeFile(join(root, "index.js"), `export const name = ${JSON.stringify(name)};\n`),
  ]);
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
