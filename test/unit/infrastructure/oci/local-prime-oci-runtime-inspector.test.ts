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
      dockerdExecutableSha256: "d".repeat(64),
      containerdExecutableSha256: "b".repeat(64),
      runcExecutableSha256: "c".repeat(64),
    });

    const result = await inspector.inspect();

    expect(result.runtime).toMatchObject({
      id: "docker-oci-v1",
      platform: "linux",
      architecture: "x64",
      client: { version: "28.3.3", executableSha256: "a".repeat(64) },
      engine: {
        serverVersion: "28.3.3",
        serverCommit: "dockerd-commit",
        dockerdSha256: "d".repeat(64),
        apiVersion: "1.51",
        kernelRelease: "6.11.0-1018-azure",
        containerdVersion: "1.7.27",
        containerdSha256: "b".repeat(64),
        runcVersion: "1.2.6",
        runcSha256: "c".repeat(64),
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
      dockerdExecutableSha256: "d".repeat(64),
      containerdExecutableSha256: "b".repeat(64),
      runcExecutableSha256: "c".repeat(64),
    });

    await expect(inspector.inspect()).rejects.toThrow(/cgroup driver/i);
  });

  it("rejects a selected runc path that differs from the observed executable", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) =>
        args[0] === "version" ? versionOutput() : infoOutput("systemd", "/opt/custom/runc"),
      local: async () => localObservation(seccompProfile),
      dockerExecutableSha256: "a".repeat(64),
      dockerdExecutableSha256: "d".repeat(64),
      containerdExecutableSha256: "b".repeat(64),
      runcExecutableSha256: "c".repeat(64),
    });

    await expect(inspector.inspect()).rejects.toThrow(/runc.*path/i);
  });

  it("rejects a matching Docker stack below the fixed API version", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput("1.48") : infoOutput("systemd")),
      local: async () => localObservation(seccompProfile, "1.48"),
      dockerExecutableSha256: "a".repeat(64),
      dockerdExecutableSha256: "d".repeat(64),
      containerdExecutableSha256: "b".repeat(64),
      runcExecutableSha256: "c".repeat(64),
    });

    await expect(inspector.inspect()).rejects.toThrow(/API version.*1\.51/i);
  });
});

function versionOutput(apiVersion = "1.51"): string {
  return JSON.stringify({
    Client: { Version: "28.3.3", ApiVersion: apiVersion, Os: "linux", Arch: "amd64" },
    Server: {
      Version: "28.3.3",
      GitCommit: "dockerd-commit",
      ApiVersion: apiVersion,
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

function infoOutput(cgroupDriver: string, runcPath = "/usr/bin/runc"): string {
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
    DefaultRuntime: "runc",
    Runtimes: { runc: { path: runcPath, runtimeArgs: [] } },
    Rootless: false,
  });
}

function localObservation(seccompProfile: Record<string, unknown>, apiVersion = "1.51") {
  return {
    daemonId: "daemon-private-id",
    socketPath: "/var/run/docker.sock" as const,
    socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
    apiVersion,
    cgroupPath: "/sys/fs/cgroup/flow-prime",
    corePattern: "core",
    globalLeasePath: "/var/lib/flow-prime/global-slot.json",
    imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    executables: {
      docker: { path: "/usr/bin/docker", sha256: "a".repeat(64) },
      dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
      containerd: { path: "/usr/bin/containerd", sha256: "b".repeat(64) },
      runc: { path: "/usr/bin/runc", sha256: "c".repeat(64) },
    },
    leaseTarget: "flow-prime-global-v1" as const,
    seccompProfile,
  };
}
