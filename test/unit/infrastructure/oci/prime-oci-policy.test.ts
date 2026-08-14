import { describe, expect, it } from "vitest";

import { createPrimeOciRuntimePolicy } from "../../../../src/infrastructure/oci/prime-oci-policy.js";

describe("Prime OCI runtime policy", () => {
  it("creates the complete fixed version-one policy", () => {
    const policy = createPrimeOciRuntimePolicy("a".repeat(64));

    expect(policy).toMatchObject({
      runtimeName: "flow-prime-runc",
      maxActivePrimeContainers: 1,
      pidsMax: 64,
      memoryMaxBytes: 2_147_483_648,
      memorySwapMaxBytes: 0,
      cpuQuotaMicros: 200_000,
      cpuPeriodMicros: 100_000,
      workspaceBytes: 536_870_912,
      workspaceInodes: 8_192,
      network: "none",
      ipc: "none",
      logDriver: "none",
      healthcheck: "none",
      pull: "never",
      seccompSha256: "a".repeat(64),
      supervisorCapabilities: ["CHOWN", "DAC_READ_SEARCH", "FOWNER", "KILL", "SETGID", "SETUID"],
    });
    expect(policy.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(createPrimeOciRuntimePolicy("b".repeat(64)).digest).not.toBe(policy.digest);
  });

  it("rejects a malformed seccomp digest", () => {
    expect(() => createPrimeOciRuntimePolicy("not-a-digest")).toThrow(/seccomp.*digest/i);
  });
});
