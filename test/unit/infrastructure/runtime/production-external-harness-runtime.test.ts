import { describe, expect, it, vi } from "vitest";

import type { ExternalHarnessRuntime } from "../../../../src/application/external-harness-adapter.js";
import { unavailableEvaluationMetrics } from "../../../../src/domain/evaluation/records.js";
import { createProductionExternalHarnessRuntime } from "../../../../src/infrastructure/runtime/production-external-harness-runtime.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("production external harness runtime", () => {
  it("keeps process execution separate and creates one lazy Prime OCI runtime", async () => {
    const processRuntime = runtime("process");
    const primeRuntime = runtime("prime");
    const createPrimeRuntime = vi.fn(() => primeRuntime);
    const production = createProductionExternalHarnessRuntime(
      {
        resolveAdmitted: vi.fn(),
      },
      { processRuntime, createPrimeRuntime },
    );

    await production.execute(processRequest());
    expect(processRuntime.execute).toHaveBeenCalledOnce();
    expect(createPrimeRuntime).not.toHaveBeenCalled();

    await production.execute(primeRequest());
    await production.execute(primeRequest());
    expect(createPrimeRuntime).toHaveBeenCalledOnce();
    expect(primeRuntime.execute).toHaveBeenCalledTimes(2);
  });
});

function runtime(runId: string): Required<ExternalHarnessRuntime> {
  return {
    execute: vi.fn(async () => ({
      harness: { outcome: "completed" as const, runId, reason: null },
      metrics: unavailableEvaluationMetrics(),
    })),
    recoverAttempt: vi.fn(async ({ attempt }) => attempt),
  };
}

function processRequest() {
  return {
    identity: { adapter: "pi-native-v1" } as Parameters<
      ExternalHarnessRuntime["execute"]
    >[0]["identity"],
    evaluation: {} as Parameters<ExternalHarnessRuntime["execute"]>[0]["evaluation"],
    isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
  };
}

function primeRequest() {
  return {
    identity: primeExternalHarnessIdentity(),
    evaluation: {} as Parameters<ExternalHarnessRuntime["execute"]>[0]["evaluation"],
    isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
  };
}
