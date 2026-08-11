import { describe, expect, it } from "vitest";
import {
  assertPrimeOciRuntimeCurrent,
  type PrimeOciCurrentStateClient,
} from "../../../../src/infrastructure/oci/local-prime-oci-currentness.js";
import { LocalPrimeOciRuntimeInspector } from "../../../../src/infrastructure/oci/local-prime-oci-runtime-inspector.js";
import { createPrimeOciRuntimePolicy } from "../../../../src/infrastructure/oci/prime-oci-policy.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("local Prime OCI currentness", () => {
  it("rejects engine, image, or core-policy drift before an authority transition", async () => {
    const local = localObservation();
    let info = infoSource("overlay2");
    let imagePresent = true;
    let corePattern = "core";
    const client: PrimeOciCurrentStateClient = {
      readVersion: async () => versionSource(),
      readInfo: async () => info,
      inspectImage: async (imageId) => (imagePresent ? { Id: imageId } : null),
    };
    const runtime = (
      await new LocalPrimeOciRuntimeInspector({
        run: async (args) => (args[0] === "version" ? versionSource() : info),
        local: async () => local,
        dockerExecutableSha256: local.executables.docker.sha256,
        containerdExecutableSha256: local.executables.containerd.sha256,
        runcExecutableSha256: local.executables.runc.sha256,
      }).inspect()
    ).runtime;
    const input = {
      runtime,
      image: primeExternalHarnessIdentity().image,
      local,
      client,
      readCorePattern: async () => corePattern,
    };

    await expect(assertPrimeOciRuntimeCurrent(input)).resolves.toBeUndefined();

    info = infoSource("btrfs");
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/runtime.*changed/i);

    info = infoSource("overlay2");
    imagePresent = false;
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/image.*changed/i);

    imagePresent = true;
    corePattern = "changed-core";
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/core.*changed/i);
  });
});

function localObservation() {
  const policy = createPrimeOciRuntimePolicy("a".repeat(64));
  return {
    daemonId: "daemon-test-id",
    socketPath: "/var/run/docker.sock" as const,
    socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
    apiVersion: "1.51",
    cgroupPath: "/sys/fs/cgroup/flow-prime",
    corePattern: "core",
    globalLeasePath: "/var/lib/flow-prime/global-slot.json",
    imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    executables: {
      docker: { path: "/usr/bin/docker", sha256: "4".repeat(64) },
      containerd: { path: "/usr/bin/containerd", sha256: "6".repeat(64) },
      runc: { path: "/usr/bin/runc", sha256: "7".repeat(64) },
    },
    leaseTarget: "flow-prime-global-v1" as const,
    seccompProfile: { digest: policy.seccompSha256 },
  };
}

function versionSource(): string {
  return JSON.stringify({
    Client: { Version: "28.3.3", ApiVersion: "1.51", Os: "linux", Arch: "amd64" },
    Server: {
      Version: "28.3.3",
      ApiVersion: "1.51",
      Os: "linux",
      Arch: "amd64",
      KernelVersion: "6.11.0-1018-azure",
      Components: [
        { Name: "containerd", Version: "1.7.27", Details: { GitCommit: "containerd-commit" } },
        { Name: "runc", Version: "1.2.6", Details: { GitCommit: "runc-commit" } },
      ],
    },
  });
}

function infoSource(driver: string): string {
  return JSON.stringify({
    ID: "daemon-test-id",
    Driver: driver,
    CgroupDriver: "systemd",
    CgroupVersion: 2,
    KernelVersion: "6.11.0-1018-azure",
    OSType: "linux",
    Architecture: "amd64",
    SecurityOptions: ["name=seccomp,profile=builtin", "name=apparmor"],
    ContainerdCommit: { ID: "containerd-commit" },
    RuncCommit: { ID: "runc-commit" },
    Rootless: false,
  });
}
