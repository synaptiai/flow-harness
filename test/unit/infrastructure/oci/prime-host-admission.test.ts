import { describe, expect, it } from "vitest";

import { validatePrimeHostAdmission } from "../../../../src/infrastructure/oci/prime-host-admission.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime host admission", () => {
  it("accepts every exact policy boundary", () => {
    const policy = primeExternalHarnessIdentity().runtime.policy;

    expect(() => validatePrimeHostAdmission(exactObservation(), policy)).not.toThrow();
  });

  it.each([
    ["host memory", { hostMemoryAvailableBytes: 4_294_967_295 }],
    [
      "ancestor memory",
      { memoryAncestors: [{ maxBytes: 5_000_000_000, currentBytes: 705_032_705 }] },
    ],
    ["host PID", { hostPidLimit: 1_255 }],
    ["ancestor PID", { pidAncestors: [{ max: 511, current: 256 }] }],
    ["online CPU", { onlineCpuCount: 3 }],
    ["CPU set", { cpusetCpuCount: 3 }],
    ["ancestor CPU quota", { cpuAncestors: [{ quotaMicros: 399_999, periodMicros: 100_000 }] }],
    ["image byte rate", { imageReadBytesPerSecond: 134_217_727 }],
    ["image operation rate", { imageReadOperationsPerSecond: 8_191 }],
  ])("rejects one-under %s capacity", (_label, change) => {
    const policy = primeExternalHarnessIdentity().runtime.policy;

    expect(() => validatePrimeHostAdmission({ ...exactObservation(), ...change }, policy)).toThrow(
      /headroom|capacity|image/i,
    );
  });

  it("uses every ancestor and rejects missing controllers or slow probes", () => {
    const policy = primeExternalHarnessIdentity().runtime.policy;
    expect(() =>
      validatePrimeHostAdmission(
        {
          ...exactObservation(),
          memoryAncestors: [
            { maxBytes: null, currentBytes: 0 },
            { maxBytes: 4_294_967_296, currentBytes: 1 },
          ],
        },
        policy,
      ),
    ).toThrow(/memory/i);
    expect(() =>
      validatePrimeHostAdmission(
        { ...exactObservation(), controllers: ["cpu", "memory", "pids"] },
        policy,
      ),
    ).toThrow(/controller/i);
    expect(() =>
      validatePrimeHostAdmission(
        {
          ...exactObservation(),
          probeLatenciesMs: Array.from({ length: 16 }, (_, index) => (index < 15 ? 100 : 101)),
        },
        policy,
      ),
    ).toThrow(/latency/i);
  });
});

function exactObservation() {
  return {
    hostMemoryAvailableBytes: 4_294_967_296,
    memoryAncestors: [
      { maxBytes: null, currentBytes: 0 },
      { maxBytes: 5_000_000_000, currentBytes: 705_032_704 },
    ],
    hostPidLimit: 1_256,
    hostPidCurrent: 1_000,
    pidAncestors: [
      { max: null, current: 10 },
      { max: 512, current: 256 },
    ],
    onlineCpuCount: 4,
    cpusetCpuCount: 4,
    cpuAncestors: [
      { quotaMicros: null, periodMicros: 100_000 },
      { quotaMicros: 400_000, periodMicros: 100_000 },
    ],
    controllers: ["cpu", "io", "memory", "pids"],
    imageReadBytesPerSecond: 134_217_728,
    imageReadOperationsPerSecond: 8_192,
    probeLatenciesMs: Array.from({ length: 16 }, () => 100),
  } as const;
}
