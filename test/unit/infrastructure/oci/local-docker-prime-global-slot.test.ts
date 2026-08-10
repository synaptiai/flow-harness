import { describe, expect, it, vi } from "vitest";

import { LocalDockerPrimeGlobalSlotEngine } from "../../../../src/infrastructure/oci/local-docker-prime-global-slot.js";
import type { PrimeGlobalSlotLease } from "../../../../src/infrastructure/oci/prime-global-admission.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("local Docker Prime global slot", () => {
  it("creates one fixed non-running lock and returns exact private identity", async () => {
    const fixture = engineFixture();

    await expect(fixture.engine.create(intent())).resolves.toEqual(fixture.lock);
    expect(fixture.api.createContainer).toHaveBeenCalledWith(
      "flow-prime-global-v1",
      expect.objectContaining({
        Image: primeExternalHarnessIdentity().image.id,
        OpenStdin: false,
        Tty: false,
        Healthcheck: { Test: ["NONE"] },
        HostConfig: expect.objectContaining({
          NetworkMode: "none",
          IpcMode: "none",
          ReadonlyRootfs: true,
          LogConfig: { Type: "none", Config: {} },
          RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        }),
      }),
      undefined,
    );
  });

  it("rejects a changed image, label, or running lock", async () => {
    for (const change of ["image", "label", "running"] as const) {
      const fixture = engineFixture(change);
      await expect(fixture.engine.inspect("flow-prime-global-v1")).rejects.toThrow(
        /global slot.*policy|lock.*policy/i,
      );
    }
  });
});

function engineFixture(change?: "image" | "label" | "running") {
  const lease = intent();
  const lock = {
    objectId: "d".repeat(64),
    ownerNonce: lease.ownerNonce,
    policyDigest: lease.policyDigest,
    daemonId: lease.daemonId,
  };
  const config = {
    Image: primeExternalHarnessIdentity().image.id,
    Labels: {
      "flow.prime-slot-version": "1",
      "flow.prime-slot-owner": change === "label" ? "short" : lease.ownerNonce,
      "flow.prime-slot-policy": lease.policyDigest,
      "flow.prime-slot-daemon": lease.daemonId,
    },
    OpenStdin: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    Healthcheck: { Test: ["NONE"] },
  };
  const inspection = {
    Id: lock.objectId,
    Name: "/flow-prime-global-v1",
    Image:
      change === "image" ? `sha256:${"e".repeat(64)}` : primeExternalHarnessIdentity().image.id,
    Config: config,
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "none",
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
    State: { Running: change === "running" },
  };
  const api = {
    createContainer: vi.fn(async () => lock.objectId),
    inspectContainer: vi.fn(async () => inspection),
    removeContainer: vi.fn(async () => undefined),
  };
  return {
    api,
    lock,
    engine: new LocalDockerPrimeGlobalSlotEngine({
      api,
      identity: primeExternalHarnessIdentity(),
      daemonId: lease.daemonId,
    }),
  };
}

function intent(): PrimeGlobalSlotLease {
  return {
    version: 1,
    state: "intent",
    lockName: "flow-prime-global-v1",
    ownerNonce: "a".repeat(64),
    policyDigest: primeExternalHarnessIdentity().runtime.policy.digest,
    daemonId: "daemon-test-id",
  };
}
