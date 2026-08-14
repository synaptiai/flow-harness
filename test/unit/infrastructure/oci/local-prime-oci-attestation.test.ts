import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  LocalPrimeOciAttestationStore,
  observePrimeOciExecutable,
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
  it("rejects an executable that loses effective execute permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-executable-"));
    temporaryDirectories.push(root);
    const executable = join(await realpath(root), "runc");
    await writeFile(executable, "fixed runtime bytes\n", { mode: 0o700 });

    await expect(observePrimeOciExecutable(executable)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await chmod(executable, 0o600);
    await expect(observePrimeOciExecutable(executable)).rejects.toThrow(/EACCES|permission/i);
  });

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

  it.each([
    ["world-writable", { uid: 0, mode: 0o666 }],
    ["foreign-owned", { uid: 501, mode: 0o660 }],
  ])("rejects a %s Docker socket", async (_name, change) => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(root, "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    const socket = { ...descriptor.local.socket, ...change };
    await writeFile(
      descriptorPath,
      `${JSON.stringify({ ...descriptor, local: { ...descriptor.local, socket } })}\n`,
    );

    await expect(
      new LocalPrimeOciAttestationStore({
        descriptorPath,
        observeSocket: async () => socket,
        observeExecutable: async (path) => executableDigest(descriptor, path),
        assertRuntimeCurrent: async () => undefined,
      }).read(),
    ).rejects.toThrow(/socket.*policy|root-owned/i);
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

  it("reconciles a transient directory sync failure after replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(await realpath(root), "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    await publishLocalPrimeOciAttestation(descriptorPath, descriptor);
    let syncCalls = 0;

    await publishLocalPrimeOciAttestation(
      descriptorPath,
      { ...descriptor, daemonId: "replacement-daemon" },
      undefined,
      {
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 2) {
            throw new Error("simulated parent sync failure");
          }
        },
      },
    );

    expect(syncCalls).toBeGreaterThanOrEqual(4);
    expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toMatchObject({
      daemonId: "replacement-daemon",
    });
    expect((await readdir(root)).filter((name) => name !== "oci-attestation.json")).toEqual([]);
  });

  it("requires a successful directory sync after an initial publication error", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(await realpath(root), "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    let syncCalls = 0;

    await publishLocalPrimeOciAttestation(descriptorPath, descriptor, undefined, {
      syncDirectory: async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          throw new Error("simulated initial parent sync failure");
        }
      },
    });

    expect(syncCalls).toBe(2);
    expect(JSON.parse(await readFile(descriptorPath, "utf8"))).toMatchObject({ version: 1 });
  });

  it("reports uncertain initial publication when directory sync cannot settle", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(await realpath(root), "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());

    await expect(
      publishLocalPrimeOciAttestation(descriptorPath, descriptor, undefined, {
        syncDirectory: async () => {
          throw new Error("persistent parent sync failure");
        },
      }),
    ).rejects.toThrow(/uncertain/i);
  });

  it("removes a validated attestation hard-link temporary before replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(await realpath(root), "oci-attestation.json");
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    await publishLocalPrimeOciAttestation(descriptorPath, descriptor);
    await link(
      descriptorPath,
      join(root, ".oci-attestation.json.11111111-1111-4111-8111-111111111111.tmp"),
    );

    await publishLocalPrimeOciAttestation(descriptorPath, {
      ...descriptor,
      daemonId: "replacement-daemon",
    });

    expect(await readdir(root)).toEqual(["oci-attestation.json"]);
  });

  it("does not retire a live publication temporary during a descriptor read", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-attestation-"));
    temporaryDirectories.push(root);
    const descriptorPath = join(await realpath(root), "oci-attestation.json");
    const temporaryPath = join(
      root,
      ".oci-attestation.json.11111111-1111-4111-8111-111111111111.tmp",
    );
    const descriptor = descriptorFixture(primeExternalHarnessIdentity());
    await publishLocalPrimeOciAttestation(descriptorPath, descriptor);
    await link(descriptorPath, temporaryPath);
    const store = new LocalPrimeOciAttestationStore({
      descriptorPath,
      observeSocket: async () => descriptor.local.socket,
      observeExecutable: async (path) => executableDigest(descriptor, path),
      assertRuntimeCurrent: async () => undefined,
    });

    await expect(store.read()).resolves.toBeDefined();
    await expect(readFile(temporaryPath, "utf8")).resolves.toContain('"version":1');
  });

  it.each(["docker", "dockerd", "containerd", "runc"] as const)(
    "rejects changed %s bytes with stable reported versions",
    async (executableName) => {
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
          changed && path === descriptor.local.executables[executableName].path
            ? "0".repeat(64)
            : executableDigest(descriptor, path),
        assertRuntimeCurrent: async () => undefined,
      }).read();

      changed = true;

      await expect(admitted.assertCurrent()).rejects.toThrow(/executable.*changed/i);
    },
  );
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
    builder: {
      clientPath: "/usr/libexec/docker/cli-plugins/docker-buildx",
      clientSha256: "8".repeat(64),
      imageId: `sha256:${"9".repeat(64)}`,
      imageReference:
        "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec",
    },
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
        dockerd: { path: "/usr/bin/dockerd", sha256: runtime.engine.dockerdSha256 },
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
