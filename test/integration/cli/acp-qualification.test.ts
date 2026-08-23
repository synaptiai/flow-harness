import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { calculateAcpAgentSessionBindingDigest } from "../../../src/domain/run/events.js";

const temporaryDirectories: string[] = [];
const canonicalResult = JSON.stringify(String(17 + 25));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ACP qualification CLI", () => {
  it("validates, qualifies, inspects, and exports two exact executors", async () => {
    const project = await qualificationProject();
    const plan = join(project, "acp-qualification.evaluation.yaml");
    const evaluations = join(project, "evaluations");
    const validation = captureIo();

    expect(
      await main(["eval", "validate", plan], validation.io, { cwd: project }),
      validation.stderr.join("\n"),
    ).toBe(0);
    const validationEvidence = JSON.parse(validation.stdout.join("\n"));
    expect(validationEvidence).toMatchObject({
      valid: true,
      purpose: "acp-interoperability-v1",
      scheduledTrials: 4,
      profiles: [
        {
          id: "first-agent",
          workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          capabilitySnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          id: "second-agent",
          workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          capabilitySnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(validationEvidence.profiles[0].workflowDigest).toBe(
      validationEvidence.profiles[1].workflowDigest,
    );
    expect(validationEvidence.profiles[0].capabilitySnapshotDigest).not.toBe(
      validationEvidence.profiles[1].capabilitySnapshotDigest,
    );

    const execution = captureIo();
    expect(
      await main(
        [
          "eval",
          "run",
          plan,
          "--evaluation-id",
          "acp-qualification",
          "--evaluations-dir",
          evaluations,
        ],
        execution.io,
        { cwd: project, executor: qualificationExecutor() },
      ),
      [...execution.stderr, ...execution.stdout].join("\n"),
    ).toBe(0);
    const runEvidence = JSON.parse(execution.stdout.join("\n"));
    expect(runEvidence).toMatchObject({
      header: {
        purpose: "acp-interoperability-v1",
        evaluationId: "acp-qualification",
      },
      records: [
        { classification: "verified_success" },
        { classification: "verified_success" },
        { classification: "verified_success" },
        { classification: "verified_success" },
      ],
      report: {
        scheduledTrials: 4,
        committedTrials: 4,
        qualification: {
          purpose: "acp-interoperability-v1",
          verdict: "qualified",
          requiredPairs: 2,
          scheduledPairs: 2,
          completePairs: 2,
          verifiedPairs: 2,
          outputVerification: { accepted: 4, rejected: 0, errors: 0, notRun: 0 },
          limitations: [],
          profiles: {
            "first-agent": {
              executor: { agentName: "first-agent" },
              usage: {
                modelTokensComplete: 2,
                costUsdComplete: 2,
                incomplete: 0,
              },
            },
            "second-agent": {
              executor: { agentName: "second-agent" },
              usage: {
                modelTokensComplete: 2,
                costUsdComplete: 2,
                incomplete: 0,
              },
            },
          },
        },
      },
    });
    const firstDigest =
      runEvidence.report.qualification.profiles["first-agent"].executor.agentDigest;
    const secondDigest =
      runEvidence.report.qualification.profiles["second-agent"].executor.agentDigest;
    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(firstDigest).not.toBe(secondDigest);
    expect(JSON.stringify(runEvidence)).not.toContain("decimal sum of 17 and 25");

    const inspection = captureIo();
    expect(
      await main(
        ["eval", "inspect", "acp-qualification", "--evaluations-dir", evaluations],
        inspection.io,
        { cwd: project },
      ),
    ).toBe(0);
    expect(JSON.parse(inspection.stdout.join("\n"))).toEqual(runEvidence);

    const output = join(project, "acp-qualification-export.json");
    const exported = captureIo();
    expect(
      await main(
        [
          "eval",
          "export",
          "acp-qualification",
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
  });
});

async function qualificationProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-qualification-cli-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "acp-agents"), { recursive: true });
  await mkdir(join(project, "fixtures", "acp-answer"), { recursive: true });
  await writeFile(
    join(project, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
  );
  await writeFile(
    join(project, "fixtures", "acp-answer", "TASK.md"),
    "Return a JSON string that contains the decimal sum of 17 and 25. Return no other content.\n",
  );
  await writeAgent(project, "first-agent");
  await writeAgent(project, "second-agent");
  await writeFile(join(project, "acp-qualification.workflow.yaml"), workflowSource());
  await writeFile(join(project, "acp-qualification.evaluation.yaml"), qualificationPlanSource());
  return project;
}

async function writeAgent(project: string, name: string): Promise<void> {
  const executable = join(project, ".flow", "acp-agents", name);
  const content = `#!/bin/sh\n# ${name}\nexit 0\n`;
  await writeFile(executable, content);
  await chmod(executable, 0o700);
  await writeFile(
    join(project, ".flow", "acp-agents", `${name}.json`),
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name },
      spec: {
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: {
          kind: "binary",
          executable,
          executableSha256: sha256(content),
          args: ["--stdio"],
        },
        modelMappings: [{ provider: "test", model: "deterministic", agentModel: "deterministic" }],
        providerAuthorities: [
          { provider: "test", domain: "provider.invalid", credentialEnv: "TEST_API_KEY" },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "complete", costUsd: "complete" },
        configuration: {
          assignments: [
            { configId: "model", source: "model" },
            {
              configId: "thinking",
              source: "thinking",
              mappings: [{ thinking: "medium", value: "medium" }],
            },
          ],
        },
      },
    }),
  );
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: acp-qualification }
budget:
  maxNodeStarts: 2
  maxModelTokens: 2000
  maxCostUsd: 1
  maxExecutionMs: 120000
  maxArtifactBytes: 65536
nodes:
  - id: answer
    type: agent
    agent:
      prompt: Follow TASK.md and return only the requested JSON value.
      model: { provider: test, id: deterministic, thinking: medium }
      tools: []
  - id: publish
    type: result
    dependsOn: [answer]
    result:
      source: { nodeId: answer, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}

function qualificationPlanSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
purpose: acp-interoperability-v1
metadata: { id: acp-interoperability }
suite:
  id: acp-qualification-suite
  version: 1.0.0
  tasks:
    - id: answer-contract
      partition: holdout
      fixture: fixtures/acp-answer
      instruction: TASK.md
      verifier:
        kind: agent-result-v1
        sha256: ${sha256(canonicalResult)}
        bytes: ${Buffer.byteLength(canonicalResult)}
profiles:
  - { id: first-agent, adapter: flow-workflow-v1, workflow: acp-qualification.workflow.yaml, acpAgent: .flow/acp-agents/first-agent.json }
  - { id: second-agent, adapter: flow-workflow-v1, workflow: acp-qualification.workflow.yaml, acpAgent: .flow/acp-agents/second-agent.json }
controls:
  model: { provider: test, id: deterministic, thinking: medium }
  budget:
    maxNodeStarts: 2
    maxModelTokens: 2000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 120000
    maxArtifactBytes: 65536
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: first-agent
  candidateProfileId: second-agent
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}

function qualificationExecutor(): NodeExecutor {
  return {
    async execute(node, context) {
      if (node.type !== "agent") throw new Error("ACP qualification fixture expected an agent");
      return successfulAcpOutcome(node.id, context);
    },
  };
}

function successfulAcpOutcome(nodeId: string, context: NodeExecutionContext): NodeExecutionOutcome {
  const snapshot = context.capabilitySnapshot?.acpAgent;
  if (snapshot === undefined) throw new Error("ACP qualification fixture has no agent snapshot");
  const sessionIdHash = sha256(`${snapshot.digest}:${context.runId}`);
  return {
    status: "succeeded",
    evidence: {
      kind: "agent",
      provider: "test",
      model: "deterministic",
      text: canonicalResult,
      textHash: sha256(canonicalResult),
      textTruncated: false,
      durationMs: 5,
      usageObservation: {
        modelTokens: { status: "complete", totalTokens: 8 },
        costUsd: { status: "complete", costUsdMicros: 12 },
      },
      activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
      policyDecisions: [],
      effectReceipts: [],
      acp: {
        version: 1,
        executor: "local-acp-process-v1",
        agentName: snapshot.name,
        agentDigest: snapshot.digest,
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        containmentProfile: "acp-prompt-only-v1",
        runtimeIdentity: "revalidated",
        credentialLease: "srt-host-scoped-sentinel",
        sessionIdHash,
        sessionBindingDigest: calculateAcpAgentSessionBindingDigest({
          runId: context.runId,
          workflowId: context.workflowId,
          nodeId,
          attempt: context.attempt,
          agentDigest: snapshot.digest,
          sessionIdHash,
        }),
        processContainment: "process-group",
        terminationStatus: "confirmed",
        sandbox: {
          backend: "deterministic-sandbox",
          backendVersion: "1.0.0",
          profile: "acp-prompt-only-v1",
          policyDigest: "c".repeat(64),
        },
        usageProvenance: {
          modelTokens: "prompt-response",
          costUsd: "session-usage-update",
        },
        updateCount: 1,
      },
    },
  };
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
