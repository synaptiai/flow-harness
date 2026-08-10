import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalPrimeOciAttestationStore } from "../../../../src/infrastructure/oci/local-prime-oci-attestation.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local Prime OCI attestation", () => {
  it("loads one strict private descriptor and detects later drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(root, "oci-attestation.json");
    await mkdir(join(root, "state"));
    const identity = primeExternalHarnessIdentity();
    const descriptor = descriptorFixture(identity);
    await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    const store = new LocalPrimeOciAttestationStore({
      descriptorPath,
      observeSocket: async () => descriptor.local.socket,
    });

    const admitted = await store.read();

    expect(admitted.runtime).toEqual(descriptor.runtime);
    expect(admitted.image).toEqual(identity.image);
    expect(admitted.localRuntime).toMatchObject({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      imageProbe: {
        executablePath: "/usr/bin/dd",
        executableSha256: "b".repeat(64),
        readBytesPerSecond: 134_217_728,
        readOperationsPerSecond: 8_192,
      },
    });
    await expect(admitted.assertCurrent()).resolves.toBeUndefined();

    await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, daemonId: "changed" })}\n`);
    await expect(admitted.assertCurrent()).rejects.toThrow(/attestation.*changed/i);
  });

  it("rejects a seccomp document or socket identity that contradicts the descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(root, "oci-attestation.json");
    const identity = primeExternalHarnessIdentity();
    const descriptor = descriptorFixture(identity);
    await writeFile(
      descriptorPath,
      `${JSON.stringify({
        ...descriptor,
        local: { ...descriptor.local, seccompProfile: { defaultAction: "SCMP_ACT_ALLOW" } },
      })}\n`,
    );
    await expect(
      new LocalPrimeOciAttestationStore({
        descriptorPath,
        observeSocket: async () => descriptor.local.socket,
      }).read(),
    ).rejects.toThrow(/seccomp/i);

    await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    await expect(
      new LocalPrimeOciAttestationStore({
        descriptorPath,
        observeSocket: async () => ({ ...descriptor.local.socket, inode: 99 }),
      }).read(),
    ).rejects.toThrow(/socket.*changed/i);
  });

  it("rejects prepared image capacity below either public minimum", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(root, "oci-attestation.json");
    const identity = primeExternalHarnessIdentity();
    const descriptor = descriptorFixture(identity);

    for (const imageProbe of [
      { ...descriptor.local.imageProbe, readBytesPerSecond: 134_217_727 },
      { ...descriptor.local.imageProbe, readOperationsPerSecond: 8_191 },
    ]) {
      await writeFile(
        descriptorPath,
        `${JSON.stringify({
          ...descriptor,
          local: { ...descriptor.local, imageProbe },
        })}\n`,
      );
      await expect(
        new LocalPrimeOciAttestationStore({
          descriptorPath,
          observeSocket: async () => descriptor.local.socket,
        }).read(),
      ).rejects.toThrow(/image capacity.*below/i);
    }
  });
});

function descriptorFixture(identity: ReturnType<typeof primeExternalHarnessIdentity>) {
  const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
  const runtime = {
    ...identity.runtime,
    policy: {
      ...identity.runtime.policy,
      seccompSha256: createHash("sha256").update(JSON.stringify(seccompProfile)).digest("hex"),
    },
  };
  return {
    version: 1,
    runtime,
    image: identity.image,
    harnessPackageContentSha256: identity.harness.packageContentSha256,
    harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
    daemonId: "daemon-test-id",
    local: {
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
      apiVersion: "1.51",
      cgroupPath: "/sys/fs/cgroup/flow-prime",
      corePattern: "core",
      globalLeasePath: "/var/lib/flow-prime/global-slot.json",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      imageProbe: {
        executablePath: "/usr/bin/dd",
        executableSha256: "b".repeat(64),
        readBytesPerSecond: 134_217_728,
        readOperationsPerSecond: 8_192,
      },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile,
    },
  };
}
