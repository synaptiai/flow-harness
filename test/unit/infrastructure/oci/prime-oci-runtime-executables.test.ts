import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveDockerManagedContainerdExecutable,
  resolveDockerManagedRuntimeExecutables,
} from "../../../../src/infrastructure/oci/prime-oci-runtime-executables.js";

describe("Prime OCI runtime executable resolution", () => {
  it("accepts a valid single-digit PID record without a trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-pid-record-"));
    const pidPath = join(root, "containerd.pid");
    await writeFile(pidPath, "7", { encoding: "utf8", mode: 0o644 });

    try {
      await expect(
        resolveDockerManagedContainerdExecutable({
          pidPaths: [pidPath],
          readDockerDaemonPid: async () => 3,
          readParentPid: async () => 3,
          resolveProcessExecutable: async (pid) =>
            pid === 7 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
          readProcessArguments: async () => [
            "/usr/bin/dockerd",
            "--host=unix:///var/run/docker.sock",
          ],
          readDockerDaemonConfiguration: async () => null,
        }),
      ).resolves.toBe("/usr/bin/containerd");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the protected root observation for root-owned daemon executables", async () => {
    const result = await resolveDockerManagedRuntimeExecutables({
      pidPaths: ["/run/docker/containerd/containerd.pid"],
      readPidRecord: async () => 41,
      readDockerDaemonPid: async () => 17,
      readParentPid: async () => 17,
      readProcessArguments: async () => ["/usr/bin/dockerd", "--host=unix:///var/run/docker.sock"],
      readDockerDaemonConfiguration: async () => null,
      readRuntimeObservation: async () => ({
        version: 1,
        dockerPid: 17,
        containerdPid: 41,
        dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
        containerd: { path: "/usr/bin/containerd", sha256: "c".repeat(64) },
      }),
    });

    expect(result).toEqual({
      containerd: "/usr/bin/containerd",
      dockerd: "/usr/bin/dockerd",
      containerdSha256: "c".repeat(64),
      dockerdSha256: "d".repeat(64),
    });
  });

  it("rejects a protected observation for another daemon process", async () => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        readProcessArguments: async () => [
          "/usr/bin/dockerd",
          "--host=unix:///var/run/docker.sock",
        ],
        readDockerDaemonConfiguration: async () => null,
        readRuntimeObservation: async () => ({
          version: 1,
          dockerPid: 18,
          containerdPid: 41,
          dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
          containerd: { path: "/usr/bin/containerd", sha256: "c".repeat(64) },
        }),
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it("binds a containerd process that is a direct child of the admitted Docker daemon", async () => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async (pid) =>
          pid === 41
            ? ["/usr/bin/containerd", "--config", "/var/run/docker/containerd/daemon/config.toml"]
            : ["/usr/bin/dockerd", "--host=unix:///var/run/docker.sock"],
        readDockerDaemonConfiguration: async () => null,
      }),
    ).resolves.toBe("/usr/bin/containerd");
  });

  it("rejects a conventional PID record for a containerd that the admitted daemon did not start", async () => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 1,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/lib/systemd/systemd",
        readProcessArguments: async () => [],
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it.each([
    ["one argument", ["/usr/bin/dockerd", "--containerd=/run/containerd/containerd.sock"]],
    ["two arguments", ["/usr/bin/dockerd", "--containerd", "/run/containerd/containerd.sock"]],
  ])("rejects a custom containerd endpoint in %s", async (_label, dockerdArguments) => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async (pid) =>
          pid === 41 ? ["/usr/bin/containerd"] : dockerdArguments,
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it.each([
    ["namespace equals", ["/usr/bin/dockerd", "--containerd-namespace=changed"]],
    ["namespace separate", ["/usr/bin/dockerd", "--containerd-namespace", "changed"]],
    ["plugin namespace equals", ["/usr/bin/dockerd", "--containerd-plugins-namespace=changed"]],
    [
      "plugin namespace separate",
      ["/usr/bin/dockerd", "--containerd-plugins-namespace", "changed"],
    ],
  ])("rejects a custom containerd %s option", async (_label, dockerdArguments) => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async () => dockerdArguments,
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it("rejects a containerd parent that differs from the canonical Docker daemon PID", async () => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 18,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async () => [
          "/usr/bin/dockerd",
          "--host=unix:///var/run/docker.sock",
        ],
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it.each(["containerd", "hosts", "exec-root", "pidfile"])(
    "rejects the authority-moving %s daemon configuration key",
    async (key) => {
      await expect(
        resolveDockerManagedContainerdExecutable({
          pidPaths: ["/run/docker/containerd/containerd.pid"],
          readPidRecord: async () => 41,
          readDockerDaemonPid: async () => 17,
          readParentPid: async () => 17,
          resolveProcessExecutable: async (pid) =>
            pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
          readProcessArguments: async () => [
            "/usr/bin/dockerd",
            "--host=unix:///var/run/docker.sock",
          ],
          readDockerDaemonConfiguration: async () => ({ [key]: "changed" }),
        }),
      ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
    },
  );

  it("rejects socket activation because it does not prove the canonical socket owner", async () => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async () => ["/usr/bin/dockerd", "--host=fd://"],
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });

  it.each([
    ["missing host", ["/usr/bin/dockerd"]],
    ["attached shorthand", ["/usr/bin/dockerd", "-Htcp://0.0.0.0:2375"]],
    ["equals shorthand", ["/usr/bin/dockerd", "-H=tcp://0.0.0.0:2375"]],
    ["separate shorthand", ["/usr/bin/dockerd", "-H", "tcp://0.0.0.0:2375"]],
    [
      "repeated hosts",
      ["/usr/bin/dockerd", "--host=unix:///var/run/docker.sock", "-Htcp://0.0.0.0:2375"],
    ],
  ])("rejects %s Docker host authority", async (_label, dockerdArguments) => {
    await expect(
      resolveDockerManagedContainerdExecutable({
        pidPaths: ["/run/docker/containerd/containerd.pid"],
        readPidRecord: async () => 41,
        readDockerDaemonPid: async () => 17,
        readParentPid: async () => 17,
        resolveProcessExecutable: async (pid) =>
          pid === 41 ? "/usr/bin/containerd" : "/usr/bin/dockerd",
        readProcessArguments: async () => dockerdArguments,
        readDockerDaemonConfiguration: async () => null,
      }),
    ).rejects.toThrow(/Docker-managed containerd.*resolved/i);
  });
});
