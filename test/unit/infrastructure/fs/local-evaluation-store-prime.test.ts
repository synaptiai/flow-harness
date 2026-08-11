import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateEvaluationPlanDigest,
  createEvaluationSchedule,
  type EvaluationPlanIdentity,
} from "../../../../src/domain/evaluation/plan.js";
import {
  createEvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../../src/domain/evaluation/records.js";
import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  LocalEvaluationStore,
  type PublicEvaluationHeader,
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";
import {
  type PrimeExternalHarnessIdentity,
  primeExternalHarnessIdentity,
} from "../../../fixtures/evaluation/prime-external-harness-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Prime evaluation store replay", () => {
  it("rejects every redigested Prime identity leaf mutation", async () => {
    const baseIdentity = primeExternalHarnessIdentity();
    const paths = primitiveLeafPaths(baseIdentity);
    expect(paths.length).toBeGreaterThan(80);

    for (const [index, path] of paths.entries()) {
      const { root, admitted } = await admittedPrimeEvaluation(baseIdentity);
      const evaluations = join(root, "evaluations");
      const store = new LocalEvaluationStore(evaluations);
      const evaluationId = `prime-identity-${String(index)}`;
      const header = createPublicEvaluationHeader(
        admitted,
        evaluationId,
        "2026-08-11T11:00:00.000Z",
      );
      await store.create(header);
      const changedIdentity = mutateLeaf(baseIdentity, path);
      const changedHeader = replacePrimeIdentity(header, changedIdentity);
      await writeFile(
        join(evaluations, evaluationId, "plan.json"),
        `${JSON.stringify(changedHeader)}\n`,
      );

      await expect(
        new LocalEvaluationStore(evaluations).claim(evaluationId, admitted.planDigest),
        path.join("."),
      ).rejects.toThrow(/plan|identity|header|changed|invalid|corrupt/i);
    }
  }, 30_000);

  it("rejects wrong or missing runtime evidence for a completed Prime trial", async () => {
    const { root, admitted } = await admittedPrimeEvaluation(primeExternalHarnessIdentity());
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    const header = createPublicEvaluationHeader(
      admitted,
      "prime-runtime-adapter",
      "2026-08-11T11:00:00.000Z",
    );
    await store.create(header);
    await store.claim(header.evaluationId, admitted.planDigest);
    const baseline = trialRecord(admitted, 0, null);
    await store.append(header.evaluationId, baseline);

    for (const runtime of [piRuntime(), ompRuntime(), undefined] as const) {
      const candidate = trialRecord(admitted, 1, baseline.recordDigest, runtime);
      await expect(store.append(header.evaluationId, candidate)).rejects.toThrow(
        /adapter|runtime|profile|external/i,
      );
    }
    await store.release(header.evaluationId);
  });
});

async function admittedPrimeEvaluation(identity: PrimeExternalHarnessIdentity) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-store-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, "fixture"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "fixture", "TASK.md"), "Keep RESULT.md unchanged.\n"),
    writeFile(join(root, "fixture", "RESULT.md"), "verified\n"),
    writeFile(join(root, "baseline.workflow.yaml"), workflowSource()),
    writeFile(join(root, "evaluation.yaml"), evaluationSource()),
  ]);
  return {
    root,
    admitted: await admitLocalEvaluationPlan(join(root, "evaluation.yaml"), {
      resolveExternalHarnessIdentity: async () => identity,
    }),
  };
}

function replacePrimeIdentity(
  header: PublicEvaluationHeader,
  harness: PrimeExternalHarnessIdentity,
): PublicEvaluationHeader {
  const profiles: EvaluationPlanIdentity["profiles"] = header.profiles.map((profile) => {
    if (profile.adapter === "prime-agent-native-v1") {
      return { id: profile.id, adapter: profile.adapter, harness };
    }
    if (profile.adapter !== "flow-workflow-v1") {
      throw new Error("Prime replay fixture contains an unexpected adapter");
    }
    return {
      id: profile.id,
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
        ...(profile.workflow.sourceKind === undefined
          ? {}
          : { sourceKind: profile.workflow.sourceKind }),
      },
      ...(profile.candidate === undefined ? {} : { candidate: profile.candidate }),
    };
  });
  const identity: EvaluationPlanIdentity = {
    version: 1,
    apiVersion: header.apiVersion,
    id: header.planId,
    suite: header.suite,
    profiles,
    controls: header.controls,
    seeds: header.seeds,
    order: header.order,
    comparison: header.comparison,
  };
  const planDigest = calculateEvaluationPlanDigest(identity);
  return {
    ...header,
    planDigest,
    profiles: [...profiles],
    schedule: [
      ...createEvaluationSchedule(
        planDigest,
        header.suite.tasks.map((task) => task.id),
        profiles.map((profile) => profile.id),
        header.seeds,
      ),
    ],
  };
}

function primitiveLeafPaths(value: unknown, prefix: readonly (string | number)[] = []) {
  const paths: (string | number)[][] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      paths.push(...primitiveLeafPaths(item, [...prefix, index]));
    });
    return paths;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      paths.push(...primitiveLeafPaths(item, [...prefix, key]));
    }
    return paths;
  }
  paths.push([...prefix]);
  return paths;
}

function mutateLeaf(
  base: PrimeExternalHarnessIdentity,
  path: readonly (string | number)[],
): PrimeExternalHarnessIdentity {
  const copy = structuredClone(base) as unknown as Record<string, unknown>;
  let parent: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[segment];
  }
  const final = path.at(-1);
  if (final === undefined) {
    throw new Error("Prime identity mutation path is empty");
  }
  const record = parent as Record<string | number, unknown>;
  const current = record[final];
  record[final] = changedPrimitive(current);
  return copy as unknown as PrimeExternalHarnessIdentity;
}

function changedPrimitive(value: unknown): unknown {
  if (typeof value === "boolean") {
    return !value;
  }
  if (typeof value === "number") {
    return value + 1;
  }
  if (typeof value !== "string") {
    throw new Error("Prime identity leaf is not one supported primitive");
  }
  if (/^[a-f0-9]{64}$/.test(value)) {
    return `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
  }
  if (/^sha256:[a-f0-9]{64}$/.test(value)) {
    return `sha256:${value[7] === "a" ? "b" : "a"}${value.slice(8)}`;
  }
  if (value.startsWith("sha512-")) {
    return `${value.slice(0, 7)}${value[7] === "A" ? "B" : "A"}${value.slice(8)}`;
  }
  return `${value}-changed`;
}

function trialRecord(
  admitted: Awaited<ReturnType<typeof admitLocalEvaluationPlan>>,
  index: number,
  previousDigest: string | null,
  runtime?: ReturnType<typeof piRuntime> | ReturnType<typeof ompRuntime>,
) {
  const schedule = admitted.schedule[index];
  if (schedule === undefined) {
    throw new Error("Prime replay fixture has no scheduled trial");
  }
  return createEvaluationTrialRecord({
    schedule,
    planDigest: admitted.planDigest,
    previousDigest,
    startedAt: "2026-08-11T11:00:00.000Z",
    completedAt: "2026-08-11T11:00:01.000Z",
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
      runId: `prime-${schedule.trialId}`,
      reason: null,
      ...(runtime === undefined ? {} : { runtime }),
    },
    verification: {
      outcome: "accepted",
      verifierDigest: admitted.suite.tasks[0]?.verifier.digest ?? "f".repeat(64),
      assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
    },
    metrics: unavailableEvaluationMetrics(),
  });
}

function piRuntime() {
  return {
    adapter: "pi-native-v1" as const,
    containment: "linux-pid-namespace" as const,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    treeTermination: "confirmed" as const,
  };
}

function ompRuntime() {
  return {
    ...piRuntime(),
    adapter: "omp-native-v1" as const,
  };
}

function evaluationSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: prime-replay }
suite:
  id: prime-replay-suite
  version: 1.0.0
  tasks:
    - id: keep-result
      partition: holdout
      fixture: fixture
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: exists, path: RESULT.md }]
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: prime-agent-native-v1, harness: { config: prime-agent-rlm-evaluation-v1 } }
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
metadata: { id: prime-replay-baseline }
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
