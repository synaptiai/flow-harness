import { describe, expect, it, vi } from "vitest";

import {
  ExternalHarnessEvaluationAdapter,
  NativePiEvaluationAdapter,
  type ExternalHarnessRuntime,
} from "../../../src/application/external-harness-adapter.js";
import type { HarnessEvaluationRequest } from "../../../src/application/evaluation-adapter.js";
import type { ExternalHarnessIdentity } from "../../../src/domain/evaluation/external-harness.js";
import { unavailableEvaluationMetrics } from "../../../src/domain/evaluation/records.js";

describe("external harness evaluation adapter", () => {
  it("runs the admitted native Pi identity with the exact evaluation request", async () => {
    const identity = externalIdentity();
    const request = evaluationRequest();
    const controller = new AbortController();
    const execute = vi.fn<ExternalHarnessRuntime["execute"]>(async () => ({
      harness: { outcome: "completed", runId: "pi-session", reason: null },
      metrics: unavailableEvaluationMetrics(),
    }));
    const adapter = new NativePiEvaluationAdapter(
      { id: "candidate", adapter: "pi-native-v1", harness: identity },
      { execute },
      {
        isolation: { projectRoot: "/project", protectedPaths: ["/project", "/state"] },
        signal: controller.signal,
      },
    );

    await expect(adapter.run(request)).resolves.toMatchObject({
      harness: { outcome: "completed", runId: "pi-session" },
    });
    expect(execute).toHaveBeenCalledWith(
      {
        identity,
        evaluation: request,
        isolation: { projectRoot: "/project", protectedPaths: ["/project", "/state"] },
      },
      controller.signal,
    );
  });

  it("runs an admitted OMP identity through the same application boundary", async () => {
    const identity = ompIdentity();
    const request = evaluationRequest();
    const execute = vi.fn<ExternalHarnessRuntime["execute"]>(async () => ({
      harness: { outcome: "completed", runId: "omp-session", reason: null },
      metrics: unavailableEvaluationMetrics(),
    }));
    const adapter = new ExternalHarnessEvaluationAdapter(
      { id: "candidate", adapter: "omp-native-v1", harness: identity },
      { execute },
      { isolation: { projectRoot: "/project", protectedPaths: ["/project"] } },
    );

    await expect(adapter.run(request)).resolves.toMatchObject({
      harness: { outcome: "completed", runId: "omp-session" },
    });
    expect(adapter.kind).toBe("omp-native-v1");
    expect(execute).toHaveBeenCalledWith(
      {
        identity,
        evaluation: request,
        isolation: { projectRoot: "/project", protectedPaths: ["/project"] },
      },
      undefined,
    );
  });

  it("rejects a trial for a different profile before it starts the runtime", async () => {
    const execute = vi.fn<ExternalHarnessRuntime["execute"]>();
    const adapter = new NativePiEvaluationAdapter(
      { id: "candidate", adapter: "pi-native-v1", harness: externalIdentity() },
      { execute },
      { isolation: { projectRoot: "/project", protectedPaths: ["/project"] } },
    );

    await expect(
      adapter.run({
        ...evaluationRequest(),
        trial: { ...evaluationRequest().trial, profileId: "baseline" },
      }),
    ).resolves.toMatchObject({
      harness: {
        outcome: "crashed",
        reason: expect.stringMatching(/candidate.*baseline/i),
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("converts a runtime failure into bounded unavailable evidence", async () => {
    const execute = vi
      .fn<ExternalHarnessRuntime["execute"]>()
      .mockRejectedValue(new Error(`runtime failed: ${"x".repeat(8_192)}`));
    const adapter = new NativePiEvaluationAdapter(
      { id: "candidate", adapter: "pi-native-v1", harness: externalIdentity() },
      { execute },
      {
        isolation: { projectRoot: "/project", protectedPaths: ["/project"] },
        clockMs: monotonicClock(),
      },
    );

    const result = await adapter.run(evaluationRequest());

    expect(result.harness).toMatchObject({ outcome: "crashed", runId: null });
    expect(result.harness.reason?.length).toBeLessThanOrEqual(4_096);
    expect(result.metrics).toEqual({ ...unavailableEvaluationMetrics(), wallTimeMs: 7 });
  });
});

function externalIdentity(): Extract<
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
      digest: "a".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "b".repeat(64),
      policyDigest: "b".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-pi-evaluation-v1",
      artifactSha256: "c".repeat(64),
      dependencyClosureSha256: "c".repeat(64),
      node: { version: "22.19.0", executableSha256: "c".repeat(64) },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      integrity: `sha512-${"A".repeat(86)}==`,
      packageContentSha256: "d".repeat(64),
      config: "pi-evaluation-v1",
      configDigest: "d".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1",
      version: 1,
      package: "@earendil-works/pi-ai",
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "e".repeat(64),
    },
  };
}

function ompIdentity(): Extract<ExternalHarnessIdentity, { readonly adapter: "omp-native-v1" }> {
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
      policyDigest: "b".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-omp-evaluation-v1",
      artifactSha256: "c".repeat(64),
      dependencyClosureSha256: "c".repeat(64),
      bun: { version: "1.3.14", executableSha256: "c".repeat(64) },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent",
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "d".repeat(64),
      dependencyClosureSha256: "d".repeat(64),
      config: "omp-evaluation-v1",
      configDigest: "d".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1",
      version: 1,
      package: "@oh-my-pi/pi-ai",
      packageVersion: "17.2.12",
      packageContentSha256: "e".repeat(64),
    },
  };
}

function evaluationRequest(): HarnessEvaluationRequest {
  return {
    planDigest: "e".repeat(64),
    trial: {
      trialId: `trial-${"f".repeat(48)}`,
      position: 1,
      taskId: "task",
      profileId: "candidate",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-trial-${"f".repeat(48)}`,
      cwd: "/tmp/evaluation-workspace",
      backend: "reflink-copy-v1",
      snapshotDigest: "1".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "2".repeat(64) },
    controls: {
      model: { provider: "test-provider", id: "test-model", thinking: "off" },
      budget: {
        maxNodeStarts: 8,
        maxModelTokens: 4_096,
        maxCostUsdMicros: 100_000,
        maxExecutionMs: 30_000,
        maxArtifactBytes: 1_048_576,
      },
      network: "deny",
      retry: { providerRetries: 0, harnessRetries: 0 },
    },
  };
}

function monotonicClock(): () => number {
  const values = [10, 17];
  return () => values.shift() ?? 17;
}
