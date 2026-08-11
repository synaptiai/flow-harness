import { describe, expect, it } from "vitest";

import { resolveDockerManagedContainerdExecutable } from "../../../../src/infrastructure/oci/prime-oci-runtime-executables.js";

describe("Prime OCI runtime executable resolution", () => {
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
