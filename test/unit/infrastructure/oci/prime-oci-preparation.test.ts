import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  preparePrimeOciRuntime,
  type PrimeOciPreparationError,
} from "../../../../src/infrastructure/oci/prime-oci-preparation.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime OCI runtime preparation", () => {
  it("publishes one descriptor after two identical builds", async () => {
    const identity = primeExternalHarnessIdentity();
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const runtime = {
      ...identity.runtime,
      policy: {
        ...identity.runtime.policy,
        seccompSha256: createHash("sha256").update(JSON.stringify(seccompProfile)).digest("hex"),
      },
    };
    const build = vi.fn(async () => ({
      image: identity.image,
      harnessPackageContentSha256: identity.harness.packageContentSha256,
      harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
    }));
    const publish = vi.fn(async () => undefined);

    const result = await preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      {
        build,
        inspectRuntime: async () => ({
          runtime,
          daemonId: "daemon-test-id",
          local: {
            socketPath: "/var/run/docker.sock",
            socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
            apiVersion: runtime.engine.apiVersion,
            cgroupPath: "/sys/fs/cgroup/flow-prime",
            corePattern: "core",
            globalLeasePath: "/var/lib/flow-prime/global-slot.json",
            imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
            imageProbe: {
              executablePath: "/usr/bin/dd",
              executableSha256: "b".repeat(64),
              readBytesPerSecond: runtime.policy.minImageReadBytesPerSecond,
              readOperationsPerSecond: runtime.policy.minImageReadOperationsPerSecond,
            },
            leaseTarget: "flow-prime-global-v1",
            seccompProfile,
          },
        }),
        publish,
      },
    );

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, 1);
    expect(build).toHaveBeenNthCalledWith(2, 2);
    expect(result.descriptorPath).toBe("/project/.flow/runtime/prime-agent/oci-attestation.json");
    expect(result.imageId).toBe(identity.image.id);
    expect(publish).toHaveBeenCalledWith(
      "/project/.flow/runtime/prime-agent/oci-attestation.json",
      expect.objectContaining({
        version: 1,
        runtime,
        image: identity.image,
        daemonId: "daemon-test-id",
      }),
    );
  });

  it("rejects a reproducibility difference before publication", async () => {
    const identity = primeExternalHarnessIdentity();
    const publish = vi.fn(async () => undefined);
    let buildNumber = 0;

    await expect(
      preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        {
          build: async () => {
            buildNumber += 1;
            return {
              image: {
                ...identity.image,
                sbomSha256: (buildNumber === 1 ? "1" : "2").repeat(64),
              },
              harnessPackageContentSha256: identity.harness.packageContentSha256,
              harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
            };
          },
          inspectRuntime: async () => {
            throw new Error("runtime inspection must not start");
          },
          publish,
        },
      ),
    ).rejects.toMatchObject({
      code: "non_reproducible",
    } satisfies Partial<PrimeOciPreparationError>);
    expect(publish).not.toHaveBeenCalled();
  });
});
