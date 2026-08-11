import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  LocalPrimeOciAttestationStore,
  publishLocalPrimeOciAttestation,
} from "../../../../src/infrastructure/oci/local-prime-oci-attestation.js";
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
      observeExecutable: async (path) => executableDigest(descriptor, path),
      assertRuntimeCurrent: async () => undefined,
    });

    const admitted = await store.read();

    expect(admitted.runtime).toEqual(descriptor.runtime);
    expect(admitted.image).toEqual(identity.image);
    expect(admitted.artifacts).toEqual(descriptor.artifacts);
    expect(admitted.localRuntime).toMatchObject({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
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
        observeExecutable: async (path) => executableDigest(descriptor, path),
        assertRuntimeCurrent: async () => undefined,
      }).read(),
    ).rejects.toThrow(/seccomp/i);

    await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    await expect(
      new LocalPrimeOciAttestationStore({
        descriptorPath,
        observeSocket: async () => ({ ...descriptor.local.socket, inode: 99 }),
        observeExecutable: async (path) => executableDigest(descriptor, path),
        assertRuntimeCurrent: async () => undefined,
      }).read(),
    ).rejects.toThrow(/socket.*changed/i);
  });

  it("publishes and replaces one complete canonical descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(
      await realpath(root),
      "runtime",
      "prime-agent",
      "oci-attestation.json",
    );
    const identity = primeExternalHarnessIdentity();
    const descriptor = descriptorFixture(identity);

    await publishLocalPrimeOciAttestation(descriptorPath, descriptor);
    await publishLocalPrimeOciAttestation(descriptorPath, {
      ...descriptor,
      daemonId: "replacement-daemon",
    });

    const content = await readFile(descriptorPath, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content)).toMatchObject({
      version: 1,
      daemonId: "replacement-daemon",
    });
    const stored = await new LocalPrimeOciAttestationStore({
      descriptorPath,
      observeSocket: async () => descriptor.local.socket,
      observeExecutable: async (path) => executableDigest(descriptor, path),
      assertRuntimeCurrent: async () => undefined,
    }).read();
    expect(stored.localRuntime.daemonId).toBe("replacement-daemon");
  });

  it("rejects a changed OCI executable with stable reported versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(root, "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
    let changed = false;
    const admitted = await new LocalPrimeOciAttestationStore({
      descriptorPath,
      observeSocket: async () => descriptor.local.socket,
      observeExecutable: async (path) =>
        changed && path === descriptor.local.executables.runc.path
          ? "0".repeat(64)
          : executableDigest(descriptor, path),
      assertRuntimeCurrent: async () => undefined,
    }).read();

    changed = true;

    await expect(admitted.assertCurrent()).rejects.toThrow(/executable.*changed/i);
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
    artifacts: {
      driverSha256: "1".repeat(64),
      flowDistSha256: "2".repeat(64),
      kernelProxySha256: "3".repeat(64),
      noIoResourceLoaderSha256: "4".repeat(64),
      pythonLauncherSha256: "5".repeat(64),
      supervisorSha256: "6".repeat(64),
    },
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
      executables: {
        docker: { path: "/usr/bin/docker", sha256: runtime.client.executableSha256 },
        containerd: { path: "/usr/bin/containerd", sha256: runtime.engine.containerdSha256 },
        runc: { path: "/usr/bin/runc", sha256: runtime.engine.runcSha256 },
      },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile,
    },
  };
}

function executableDigest(descriptor: ReturnType<typeof descriptorFixture>, path: string): string {
  const executable = Object.values(descriptor.local.executables).find(
    (candidate) => candidate.path === path,
  );
  if (executable === undefined) {
    throw new Error("unexpected executable path");
  }
  return executable.sha256;
}
