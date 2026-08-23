import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  evaluationReportInput,
  LocalEvaluationStore,
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";

const temporaryDirectories: string[] = [];
const expectedResult = JSON.stringify(String(17 + 25));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local ACP qualification plan admission", () => {
  it("binds two exact ACP executors to one workflow and one private result verifier", async () => {
    const project = await qualificationProject();

    const admitted = await admitLocalEvaluationPlan(join(project, "qualification.evaluation.yaml"));

    expect(admitted).toMatchObject({
      purpose: "acp-interoperability-v1",
      suite: {
        tasks: [
          {
            verifier: {
              kind: "agent-result-v1",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              sha256: sha256(expectedResult),
              bytes: Buffer.byteLength(expectedResult),
            },
          },
        ],
      },
      profiles: [
        {
          id: "codex-agent",
          workflow: { workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
          capabilitySnapshot: {
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            acpAgent: {
              name: "codex-agent",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        },
        {
          id: "opencode-agent",
          workflow: { workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
          capabilitySnapshot: {
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            acpAgent: {
              name: "opencode-agent",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        },
      ],
    });
    const [codex, opencode] = admitted.profiles;
    if (codex.adapter !== "flow-workflow-v1" || opencode.adapter !== "flow-workflow-v1") {
      throw new Error("qualification fixture did not admit two Flow profiles");
    }
    expect(codex.workflow.workflowDigest).toBe(opencode.workflow.workflowDigest);
    expect(codex.capabilitySnapshot?.digest).not.toBe(opencode.capabilitySnapshot?.digest);
    expect(codex.capabilitySnapshot?.acpAgent?.digest).not.toBe(
      opencode.capabilitySnapshot?.acpAgent?.digest,
    );
    expect(admitted.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects two profiles that resolve to the same exact ACP executor", async () => {
    const project = await qualificationProject();
    const source = await readFile(join(project, "qualification.evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "qualification.evaluation.yaml"),
      source.replace(
        "acpAgent: .flow/acp-agents/opencode.json",
        "acpAgent: .flow/acp-agents/codex.json",
      ),
      "utf8",
    );

    await expect(
      admitLocalEvaluationPlan(join(project, "qualification.evaluation.yaml")),
    ).rejects.toThrow(/distinct|different|ACP executor/i);
  });

  it("rejects a qualification workflow without one exact agent-to-result path", async () => {
    const project = await qualificationProject();
    const source = workflowSource();
    await writeFile(
      join(project, "qualification.workflow.yaml"),
      source
        .replace(
          "  - id: publish",
          `  - id: second-answer
    type: agent
    dependsOn: [answer]
    agent:
      prompt: Also follow TASK.md.
      model: { provider: openai, id: gpt-5.4, thinking: high }
      tools: []
  - id: publish`,
        )
        .replace(
          "  - id: publish\n    type: result\n    dependsOn: [answer]",
          "  - id: publish\n    type: result\n    dependsOn: [answer, second-answer]",
        ),
      "utf8",
    );

    await expect(
      admitLocalEvaluationPlan(join(project, "qualification.evaluation.yaml")),
    ).rejects.toThrow(/qualification.*result|agent.*result/i);
  });

  it("stores only the public ACP qualification identity and reconstructs report input", async () => {
    const project = await qualificationProject();
    const admitted = await admitLocalEvaluationPlan(join(project, "qualification.evaluation.yaml"));
    const header = createPublicEvaluationHeader(admitted, "acp-qualification");
    const store = new LocalEvaluationStore(join(project, ".flow", "evaluations"));

    await store.create(header);
    const reopened = await store.read("acp-qualification");
    const reportInput = evaluationReportInput(reopened.header);

    expect(reopened.header).toMatchObject({
      purpose: "acp-interoperability-v1",
      suite: { tasks: [{ verifier: { kind: "agent-result-v1", assertionCount: 1 } }] },
      profiles: [
        {
          capabilitySnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          acpAgent: { name: "codex-agent", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
        {
          capabilitySnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          acpAgent: { name: "opencode-agent", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
      ],
    });
    expect(reportInput).toMatchObject({
      purpose: "acp-interoperability-v1",
      profileWorkflowDigests: {
        "codex-agent": expect.stringMatching(/^[a-f0-9]{64}$/),
        "opencode-agent": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      profileCapabilitySnapshotDigests: {
        "codex-agent": expect.stringMatching(/^[a-f0-9]{64}$/),
        "opencode-agent": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      profileAcpAgents: {
        "codex-agent": {
          name: "codex-agent",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "opencode-agent": {
          name: "opencode-agent",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    const durable = await readFile(
      join(project, ".flow", "evaluations", "acp-qualification", "plan.json"),
      "utf8",
    );
    expect(durable).not.toContain("decimal sum of 17 and 25");
  });
});

async function qualificationProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-acp-qualification-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, "fixtures/answer"), { recursive: true });
  await mkdir(join(project, ".flow", "acp-agents"), { recursive: true });
  await writeFile(
    join(project, "fixtures/answer", "TASK.md"),
    "Return a JSON string that contains the decimal sum of 17 and 25. Return no other content.\n",
    "utf8",
  );
  await writeFile(join(project, "qualification.workflow.yaml"), workflowSource(), "utf8");
  await writeAgent(project, "codex-agent", "codex", "reasoning_effort");
  await writeAgent(project, "opencode-agent", "opencode", "effort");
  await writeFile(
    join(project, "qualification.evaluation.yaml"),
    qualificationPlanSource(),
    "utf8",
  );
  return project;
}

async function writeAgent(
  project: string,
  name: string,
  fileName: string,
  reasoningConfigId: string,
): Promise<void> {
  const executable = join(project, ".flow", "acp-agents", fileName);
  const executableContent = `#!/bin/sh\n# ${name}\nexit 0\n`;
  await writeFile(executable, executableContent, "utf8");
  await chmod(executable, 0o755);
  await writeFile(
    join(project, ".flow", "acp-agents", `${fileName}.json`),
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
          executableSha256: sha256(executableContent),
          args: ["--stdio"],
        },
        modelMappings: [{ provider: "openai", model: "gpt-5.4", agentModel: "gpt-5.4" }],
        providerAuthorities: [
          { provider: "openai", domain: "api.openai.com", credentialEnv: "OPENAI_API_KEY" },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "complete", costUsd: "complete" },
        configuration: {
          assignments: [
            { configId: "model", source: "model" },
            {
              configId: reasoningConfigId,
              source: "thinking",
              mappings: [
                { thinking: "off", value: "off" },
                { thinking: "high", value: "high" },
              ],
            },
          ],
        },
      },
    }),
    "utf8",
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
      prompt: Follow TASK.md and return only the requested text.
      model: { provider: openai, id: gpt-5.4, thinking: high }
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
      fixture: fixtures/answer
      instruction: TASK.md
      verifier:
        kind: agent-result-v1
        sha256: ${sha256(expectedResult)}
        bytes: ${Buffer.byteLength(expectedResult)}
profiles:
  - { id: codex-agent, adapter: flow-workflow-v1, workflow: qualification.workflow.yaml, acpAgent: .flow/acp-agents/codex.json }
  - { id: opencode-agent, adapter: flow-workflow-v1, workflow: qualification.workflow.yaml, acpAgent: .flow/acp-agents/opencode.json }
controls:
  model: { provider: openai, id: gpt-5.4, thinking: high }
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
  baselineProfileId: codex-agent
  candidateProfileId: opencode-agent
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
