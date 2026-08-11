import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { LocalPrimeOciRuntimeInspector } from "../../../../src/infrastructure/oci/local-prime-oci-runtime-inspector.js";

describe("local Prime OCI runtime inspector", () => {
  it("binds the fixed Linux Docker runtime and keeps host details private", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const seccompSha256 = createHash("sha256").update(JSON.stringify(seccompProfile)).digest("hex");
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        if (args[0] === "version") {
          return versionOutput();
        }
        if (args[0] === "info") {
          return infoOutput("systemd");
        }
        throw new Error("unexpected Docker inspection command");
      },
      local: async () => localObservation(seccompProfile),
      dockerExecutableSha256: "a".repeat(64),
    });

    const result = await inspector.inspect();

    expect(result.runtime).toMatchObject({
      id: "docker-oci-v1",
      platform: "linux",
      architecture: "x64",
      client: { version: "28.3.3", executableSha256: "a".repeat(64) },
      engine: {
        serverVersion: "28.3.3",
        apiVersion: "1.51",
        kernelRelease: "6.11.0-1018-azure",
        containerdVersion: "1.7.27",
        runcVersion: "1.2.6",
        cgroupVersion: 2,
        cgroupDriver: "systemd",
        storageDriver: "overlay2",
        rootless: false,
      },
      policy: { seccompSha256 },
    });
    expect(result.daemonId).toBe("daemon-private-id");
    expect(result.local.socketPath).toBe("/var/run/docker.sock");
  });

  it("rejects a Docker engine without the fixed cgroup driver", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput() : infoOutput("cgroupfs")),
      local: async () => localObservation(seccompProfile),
      dockerExecutableSha256: "a".repeat(64),
    });

    await expect(inspector.inspect()).rejects.toThrow(/cgroup driver/i);
  });
});

function versionOutput(): string {
  return JSON.stringify({
    Client: { Version: "28.3.3", ApiVersion: "1.51", Os: "linux", Arch: "amd64" },
    Server: {
      Version: "28.3.3",
      ApiVersion: "1.51",
      Os: "linux",
      Arch: "amd64",
      KernelVersion: "6.11.0-1018-azure",
      Components: [
        { Name: "containerd", Version: "v1.7.27", Details: { GitCommit: "containerd-commit" } },
        { Name: "runc", Version: "1.2.6", Details: { GitCommit: "runc-commit" } },
      ],
    },
  });
}

function infoOutput(cgroupDriver: string): string {
  return JSON.stringify({
    ID: "daemon-private-id",
    Driver: "overlay2",
    CgroupDriver: cgroupDriver,
    CgroupVersion: "2",
    KernelVersion: "6.11.0-1018-azure",
    OSType: "linux",
    Architecture: "x86_64",
    SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
    ContainerdCommit: { ID: "containerd-commit" },
    RuncCommit: { ID: "runc-commit" },
    Rootless: false,
  });
}

function localObservation(seccompProfile: Record<string, unknown>) {
  return {
    daemonId: "daemon-private-id",
    socketPath: "/var/run/docker.sock" as const,
    socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
    apiVersion: "1.51",
    cgroupPath: "/sys/fs/cgroup/flow-prime",
    corePattern: "core",
    globalLeasePath: "/var/lib/flow-prime/global-slot.json",
    imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    leaseTarget: "flow-prime-global-v1" as const,
    seccompProfile,
  };
}
