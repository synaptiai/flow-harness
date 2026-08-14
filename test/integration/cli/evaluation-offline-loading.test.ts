import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { CliIo } from "../../../src/cli/main.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import type { ExternalHarnessIdentity } from "../../../src/domain/evaluation/external-harness.js";
import {
  createEvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../src/domain/evaluation/records.js";
import { admitLocalEvaluationPlan } from "../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  LocalEvaluationStore,
} from "../../../src/infrastructure/fs/local-evaluation-store.js";

vi.mock("../../../src/infrastructure/runtime/production-external-harness-runtime.js", () => {
  throw new Error("offline command loaded the production external harness runtime");
});
vi.mock("@oh-my-pi/pi-ai", () => {
  throw new Error("offline command loaded the OMP inference package");
});
vi.mock("@oh-my-pi/pi-coding-agent", () => {
  throw new Error("offline command loaded the OMP harness package");
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

it("inspects and exports stored OMP evidence without loading external runtime packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-offline-evaluation-"));
  temporaryDirectories.push(root);
  const evaluations = join(root, "evaluations");
  const planPath = resolve(
    import.meta.dirname,
    "../../../examples/evaluation/native-omp-comparison.evaluation.yaml",
  );
  const admitted = await admitLocalEvaluationPlan(planPath, {
    resolveExternalHarnessIdentity: async (profile) =>
      profile.adapter === "pi-native-v1" ? nativePiIdentity() : nativeOmpIdentity(),
  });
  const store = new LocalEvaluationStore(evaluations);
  const header = createPublicEvaluationHeader(
    admitted,
    "offline-omp-evidence",
    "2026-08-10T10:00:00.000Z",
  );
  await store.create(header);
  await store.claim(header.evaluationId, header.planDigest);
  let previousDigest: string | null = null;
  for (const schedule of admitted.schedule) {
    const profile = admitted.profiles.find((item) => item.id === schedule.profileId);
    if (
      profile === undefined ||
      profile.adapter === "flow-workflow-v1" ||
      profile.adapter === "prime-agent-native-v1"
    ) {
      throw new Error("offline OMP fixture has an invalid external profile");
    }
    const record = createEvaluationTrialRecord({
      schedule,
      planDigest: admitted.planDigest,
      previousDigest,
      startedAt: "2026-08-10T10:00:00.000Z",
      completedAt: "2026-08-10T10:00:01.000Z",
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
        runtime: {
          adapter: profile.adapter,
          containment: "linux-pid-namespace",
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          treeTermination: "confirmed",
        },
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
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };

  expect(
    await main(["eval", "inspect", header.evaluationId, "--evaluations-dir", evaluations], io, {
      cwd: root,
      loadConfig: async () => effectiveConfig(root),
    }),
  ).toBe(0);
  const inspected = JSON.parse(stdout.join("\n"));
  expect(inspected.header.profiles.map((profile: { adapter: string }) => profile.adapter)).toEqual(
    expect.arrayContaining(["pi-native-v1", "omp-native-v1"]),
  );
  expect(
    inspected.records.map(
      (record: { harness: { runtime?: { adapter: string } } }) => record.harness.runtime?.adapter,
    ),
  ).toEqual(expect.arrayContaining(["pi-native-v1", "omp-native-v1"]));
  const output = join(root, "offline-omp-evidence.json");
  expect(
    await main(
      ["eval", "export", header.evaluationId, "--evaluations-dir", evaluations, "--output", output],
      io,
      {
        cwd: root,
        loadConfig: async () => effectiveConfig(root),
      },
    ),
  ).toBe(0);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual(inspected);
  expect(stderr).toEqual([]);
  expect(stderr.join("\n")).not.toMatch(/loaded the production external harness runtime/i);
}, 20_000);

function nativePiIdentity(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "pi-native-v1" }
> {
  return {
    version: 1,
    adapter: "pi-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-pi-evaluation-v1",
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      node: { version: "22.19.0", executableSha256: "6".repeat(64) },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      integrity:
        "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
      packageContentSha256: "7".repeat(64),
      config: "pi-evaluation-v1",
      configDigest: "8".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1",
      version: 1,
      package: "@earendil-works/pi-ai",
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "9".repeat(64),
    },
  };
}

function nativeOmpIdentity(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "omp-native-v1" }
> {
  return {
    version: 1,
    adapter: "omp-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "a".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "b".repeat(64),
      policyDigest: "c".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-omp-evaluation-v1",
      artifactSha256: "d".repeat(64),
      dependencyClosureSha256: "e".repeat(64),
      bun: { version: "1.3.14", executableSha256: "f".repeat(64) },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent",
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "0".repeat(64),
      dependencyClosureSha256: "1".repeat(64),
      config: "omp-evaluation-v1",
      configDigest: "2".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1",
      version: 1,
      package: "@oh-my-pi/pi-ai",
      packageVersion: "17.2.12",
      packageContentSha256: "3".repeat(64),
    },
  };
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}
