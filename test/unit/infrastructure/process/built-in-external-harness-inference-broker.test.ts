import { describe, expect, it, vi } from "vitest";

import { BuiltInExternalHarnessInferenceBroker } from "../../../../src/infrastructure/process/built-in-external-harness-inference-broker.js";
import type { ExternalHarnessInferenceRequest } from "../../../../src/infrastructure/process/local-external-harness-runtime.js";

describe("built-in external harness inference broker", () => {
  it("routes requests by the admitted adapter", async () => {
    const pi = { infer: vi.fn(async () => "pi"), close: vi.fn() };
    const omp = { infer: vi.fn(async () => "omp"), close: vi.fn() };
    const broker = new BuiltInExternalHarnessInferenceBroker({ pi, omp });

    await expect(broker.infer(request("pi-native-v1"))).resolves.toBe("pi");
    await expect(broker.infer(request("omp-native-v1"))).resolves.toBe("omp");
    expect(pi.infer).toHaveBeenCalledOnce();
    expect(omp.infer).toHaveBeenCalledOnce();
  });
});

function request(adapter: "pi-native-v1" | "omp-native-v1"): ExternalHarnessInferenceRequest {
  return {
    identity: { adapter } as ExternalHarnessInferenceRequest["identity"],
    evaluation: {
      planDigest: "a",
      trial: { trialId: "b" },
    } as ExternalHarnessInferenceRequest["evaluation"],
    requestId: "request",
    body: "{}",
  };
}
