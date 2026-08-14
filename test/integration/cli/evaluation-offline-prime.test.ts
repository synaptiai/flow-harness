import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { CliIo } from "../../../src/cli/main.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import {
  createEvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";
import { admitLocalEvaluationPlan } from "../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  LocalEvaluationStore,
} from "../../../src/infrastructure/fs/local-evaluation-store.js";
import { primeExternalHarnessIdentity } from "../../fixtures/evaluation/prime-external-harness-identity.js";

vi.mock("../../../src/infrastructure/runtime/production-external-harness-runtime.js", () => {
  throw new Error("offline command loaded the production external harness runtime");
});
vi.mock("../../../src/infrastructure/oci/production-prime-oci-preparation.js", () => {
  throw new Error("offline command loaded the Prime OCI preparation runtime");
});
vi.mock("../../../src/infrastructure/prime/native-prime-agent-evaluation-driver.js", () => {
  throw new Error("offline command loaded the Prime Agent driver");
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

it("inspects and exports Prime evidence without loading OCI or private host authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-offline-prime-"));
  temporaryDirectories.push(root);
  const evaluations = join(root, "evaluations");
  const fixture = join(root, "fixture");
  await mkdir(fixture, { recursive: true });
  await Promise.all([
    writeFile(join(root, "baseline.workflow.yaml"), workflowSource()),
    writeFile(join(root, "evaluation.yaml"), evaluationSource()),
    writeFile(join(fixture, "TASK.md"), "Keep RESULT.md unchanged.\n"),
    writeFile(join(fixture, "RESULT.md"), "verified\n"),
  ]);
  const privateMarkers = [
    "PRIVATE_DOCKER_SOCKET_76",
    "PRIVATE_DAEMON_76",
    "PRIVATE_DEVICE_76",
    "PRIVATE_CONTAINER_76",
    "PRIVATE_LEASE_76",
  ];
  const attestationDirectory = join(root, ".flow", "runtime", "prime-agent");
  await mkdir(attestationDirectory, { recursive: true });
  await writeFile(
    join(attestationDirectory, "oci-attestation.json"),
    `${JSON.stringify({ privateMarkers })}\n`,
  );
  const admitted = await admitLocalEvaluationPlan(join(root, "evaluation.yaml"), {
    resolveExternalHarnessIdentity: async () => primeExternalHarnessIdentity(),
  });
  const store = new LocalEvaluationStore(evaluations);
  const header = createPublicEvaluationHeader(
    admitted,
    "offline-prime-evidence",
    "2026-08-11T10:00:00.000Z",
  );
  await store.create(header);
  await store.claim(header.evaluationId, header.planDigest);
  let previousDigest: string | null = null;
  for (const schedule of admitted.schedule) {
    const profile = admitted.profiles.find((item) => item.id === schedule.profileId);
    if (profile === undefined) {
      throw new Error("offline Prime fixture has no scheduled profile");
    }
    const record = createEvaluationTrialRecord({
      schedule,
      planDigest: admitted.planDigest,
      previousDigest,
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "22.19.0",
        flowVersion: "0.0.0",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "e".repeat(64),
      },
      harness: {
        outcome: "completed",
        runId: `offline-${schedule.trialId}`,
        reason: null,
        ...(profile.adapter === "prime-agent-native-v1"
          ? {
              runtime: {
                adapter: "prime-agent-native-v1" as const,
                containment: "docker-oci-v1" as const,
                engineStatus: "verified" as const,
                imageId: profile.harness.image.id,
                policyDigest: profile.harness.runtime.policy.digest,
                exitCode: 0,
                timedOut: false,
                aborted: false,
                recoveryOutcome: "not_attempted" as const,
                removal: "confirmed" as const,
              },
            }
          : {}),
      },
      verification: {
        outcome: "accepted",
        verifierDigest: admitted.suite.tasks[0]?.verifier.digest ?? "f".repeat(64),
        assertions: [
          {
            kind: "sha256",
            path: "RESULT.md",
            outcome: true,
            observedSha256: "8".repeat(64),
          },
        ],
      },
      metrics: unavailableEvaluationMetrics(),
    });
    await store.append(header.evaluationId, record);
    previousDigest = record.recordDigest;
  }
  await store.release(header.evaluationId);
  const { main } = await import("../../../src/cli/main.js");
  const io = capture();

  expect(
    await main(["eval", "inspect", header.evaluationId, "--evaluations-dir", evaluations], io.io, {
      cwd: root,
      loadConfig: async () => effectiveConfig(root),
    }),
  ).toBe(0);
  const inspected = JSON.parse(io.stdout.join("\n"));
  expect(inspected.header.profiles.map((profile: { adapter: string }) => profile.adapter)).toEqual(
    expect.arrayContaining(["flow-workflow-v1", "prime-agent-native-v1"]),
  );
  expect(inspected.records[1].harness.runtime).toMatchObject({
    adapter: "prime-agent-native-v1",
    containment: "docker-oci-v1",
    engineStatus: "verified",
    removal: "confirmed",
  });
  const output = join(root, "offline-prime-evidence.json");
  expect(
    await main(
      ["eval", "export", header.evaluationId, "--evaluations-dir", evaluations, "--output", output],
      io.io,
      { cwd: root, loadConfig: async () => effectiveConfig(root) },
    ),
  ).toBe(0);
  const exportedText = await readFile(output, "utf8");
  expect(JSON.parse(exportedText)).toEqual(inspected);
  for (const marker of privateMarkers) {
    expect(exportedText).not.toContain(marker);
  }
  expect(io.stderr).toEqual([]);
}, 20_000);

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

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox: { profile: "native" },
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}

function evaluationSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata:
  id: offline-prime-evidence
suite:
  id: offline-prime-suite
  version: 1.0.0
  tasks:
    - id: keep-result
      partition: holdout
      fixture: fixture
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - kind: sha256
            path: RESULT.md
            value: 8a8aa2ef3c30f50ae33eaf4212a66b3f0cf8751fa259bc0a6efc183f22b8cfca
profiles:
  - id: baseline
    adapter: flow-workflow-v1
    workflow: baseline.workflow.yaml
  - id: candidate
    adapter: prime-agent-native-v1
    harness:
      config: prime-agent-rlm-evaluation-v1
controls:
  model: { provider: test, id: model, thinking: off }
  budget:
    maxNodeStarts: 2
    maxModelTokens: 4096
    maxCostUsdMicros: 100000
    maxExecutionMs: 30000
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

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: offline-prime-baseline
budget:
  maxNodeStarts: 2
  maxModelTokens: 4096
  maxCostUsd: 0.1
  maxExecutionMs: 30000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Keep RESULT.md unchanged.
      model: { provider: test, id: model, thinking: off }
      tools: [read, edit]
      timeoutMs: 30000
  - id: result
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}
