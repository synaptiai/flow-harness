import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessRuntime } from "../../../../src/application/external-harness-adapter.js";
import { unavailableEvaluationMetrics } from "../../../../src/domain/evaluation/records.js";
import { BuiltInExternalHarnessRuntime } from "../../../../src/infrastructure/process/built-in-external-harness-runtime.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("built-in external harness runtime", () => {
  it("routes Pi and OMP execution to the process runtime", async () => {
    const processRuntime = runtime("process");
    const createPrime = vi.fn(() => runtime("prime"));
    const builtIn = new BuiltInExternalHarnessRuntime({ processRuntime, createPrime });

    await builtIn.execute(runtimeRequest("pi-native-v1"));
    await builtIn.execute(runtimeRequest("omp-native-v1"));

    expect(processRuntime.execute).toHaveBeenCalledTimes(2);
    expect(createPrime).not.toHaveBeenCalled();
  });

  it("lazily routes Prime execution and recovery to one OCI runtime", async () => {
    const processRuntime = runtime("process");
    const primeRuntime = runtime("prime");
    const createPrime = vi.fn(() => primeRuntime);
    const builtIn = new BuiltInExternalHarnessRuntime({ processRuntime, createPrime });
    const request = runtimeRequest("prime-agent-native-v1");
    const attempt = {
      version: 1 as const,
      planDigest: "a".repeat(64),
      position: 1,
      trialId: `trial-${"b".repeat(48)}`,
      taskId: "task",
      profileId: "candidate",
      adapter: "prime-agent-native-v1" as const,
      startedAt: "2026-08-10T10:00:00.000Z",
      workspace: { backend: "reflink-copy-v1" as const, snapshotDigest: "c".repeat(64) },
    };

    await builtIn.execute(request);
    await builtIn.recoverAttempt({
      identity: request.identity,
      attempt,
      workspaceRoot: "/evaluation/workspace",
      updateOciLease: vi.fn(async () => undefined),
    });

    expect(createPrime).toHaveBeenCalledTimes(1);
    expect(primeRuntime.execute).toHaveBeenCalledTimes(1);
    expect(primeRuntime.recoverAttempt).toHaveBeenCalledTimes(1);
    expect(processRuntime.execute).not.toHaveBeenCalled();
  });

  it("rejects process recovery and a Prime runtime without recovery", async () => {
    const processRuntime = runtime("process");
    const builtIn = new BuiltInExternalHarnessRuntime({
      processRuntime,
      createPrime: () => ({ execute: vi.fn() }),
    });
    const attempt = {
      version: 1 as const,
      planDigest: "a".repeat(64),
      position: 1,
      trialId: `trial-${"b".repeat(48)}`,
      taskId: "task",
      profileId: "candidate",
      adapter: "prime-agent-native-v1" as const,
      startedAt: "2026-08-10T10:00:00.000Z",
      workspace: { backend: "reflink-copy-v1" as const, snapshotDigest: "c".repeat(64) },
    };

    await expect(
      builtIn.recoverAttempt({
        identity: runtimeRequest("pi-native-v1").identity,
        attempt,
        workspaceRoot: "/evaluation/workspace",
        updateOciLease: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/Prime/i);
    await expect(
      builtIn.recoverAttempt({
        identity: primeExternalHarnessIdentity(),
        attempt,
        workspaceRoot: "/evaluation/workspace",
        updateOciLease: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/recovery.*available/i);
  });
});

function runtime(label: string): Required<ExternalHarnessRuntime> {
  return {
    execute: vi.fn(async () => ({
      harness: { outcome: "completed" as const, runId: label, reason: null },
      metrics: unavailableEvaluationMetrics(),
    })),
    recoverAttempt: vi.fn(async ({ attempt }) => attempt),
  };
}

function runtimeRequest(adapter: "pi-native-v1" | "omp-native-v1" | "prime-agent-native-v1") {
  return {
    identity:
      adapter === "prime-agent-native-v1"
        ? primeExternalHarnessIdentity()
        : ({ adapter } as Parameters<ExternalHarnessRuntime["execute"]>[0]["identity"]),
    evaluation: {} as Parameters<ExternalHarnessRuntime["execute"]>[0]["evaluation"],
    isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
  };
}
