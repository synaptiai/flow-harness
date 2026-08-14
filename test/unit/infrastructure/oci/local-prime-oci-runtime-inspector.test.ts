import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PrimeDockerCommandAbortError } from "../../../../src/infrastructure/oci/local-prime-image-builder.js";
import { LocalPrimeOciRuntimeInspector } from "../../../../src/infrastructure/oci/local-prime-oci-runtime-inspector.js";

describe("local Prime OCI runtime inspector", () => {
  it("uses one coherent Docker snapshot for local and identity inspection", async () => {
    const events: string[] = [];
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        const command = args[0];
        if (command !== "version" && command !== "info") {
          throw new Error("unexpected Docker inspection command");
        }
        events.push(command);
        return command === "version" ? versionOutput() : infoOutput("systemd");
      },
      local: async (snapshot) => {
        events.push("local");
        expect(snapshot.version.Server.ApiVersion).toBe("1.51");
        expect(snapshot.information.ID).toBe("daemon-private-id");
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.version.Server)).toBe(true);
        expect(Object.isFrozen(snapshot.version.Server.Components)).toBe(true);
        const firstComponent = snapshot.version.Server.Components[0];
        expect(firstComponent).toBeDefined();
        expect(Object.isFrozen(firstComponent)).toBe(true);
        expect(() => {
          if (firstComponent === undefined) {
            throw new Error("the Docker version fixture omits its first component");
          }
          firstComponent.Version = "99.99.99";
        }).toThrow(TypeError);
        return localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });
      },
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).resolves.toMatchObject({
      runtime: { engine: { containerdVersion: "1.7.27" } },
    });
    expect(events).toEqual(["version", "info", "local"]);
  });

  it("preserves only the owned Docker cancellation reason", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled runtime inspection");
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        if (args[0] === "version") {
          controller.abort(cancellation);
          throw new PrimeDockerCommandAbortError(cancellation);
        }
        return infoOutput("systemd");
      },
      local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
      expectedExecutables: expectedExecutables(),
      signal: controller.signal,
    });

    await expect(inspector.inspect()).rejects.toBe(cancellation);
  });

  it("keeps a distinct post-abort Docker failure in its fixed stage", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled runtime inspection");
    const distinctFailure = new Error("private distinct Docker failure");
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        if (args[0] === "version") {
          controller.abort(cancellation);
          throw distinctFailure;
        }
        return infoOutput("systemd");
      },
      local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
      expectedExecutables: expectedExecutables(),
      signal: controller.signal,
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "query Docker identity version",
      cause: distinctFailure,
    });
  });

  it.each([
    ["version", "query Docker identity version", "private Docker version query failure"],
    ["info", "query Docker identity information", "private Docker information query failure"],
  ] as const)(
    "separates a Docker %s query failure from response decoding",
    async (command, stage, privateMessage) => {
      const privateFailure = new Error(privateMessage);
      const inspector = new LocalPrimeOciRuntimeInspector({
        run: async (args) => {
          if (args[0] === command) {
            throw privateFailure;
          }
          return args[0] === "version" ? versionOutput() : infoOutput("systemd");
        },
        local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
        expectedExecutables: expectedExecutables(),
      });

      const inspection = inspector.inspect();
      await expect(inspection).rejects.toMatchObject({ stage, cause: privateFailure });
      await expect(inspection).rejects.not.toThrow(privateMessage);
    },
  );

  it.each([
    ["version", "parse Docker identity version response", "private-version-response"],
    ["info", "parse Docker identity information response", "private-information-response"],
  ] as const)(
    "separates a malformed Docker %s response from its successful query",
    async (command, stage, privateResponse) => {
      const inspector = new LocalPrimeOciRuntimeInspector({
        run: async (args) => {
          if (args[0] === command) {
            return privateResponse;
          }
          return args[0] === "version" ? versionOutput() : infoOutput("systemd");
        },
        local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
        expectedExecutables: expectedExecutables(),
      });

      const inspection = inspector.inspect();
      await expect(inspection).rejects.toMatchObject({ stage, cause: expect.any(Error) });
      await expect(inspection).rejects.not.toThrow(privateResponse);
    },
  );

  it.each([
    ["version", "validate Docker identity version response schema"],
    ["info", "validate Docker identity information response schema"],
  ] as const)("separates a Docker %s schema failure from JSON parsing", async (command, stage) => {
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        if (args[0] === command) {
          return '{"private":"schema-canary"}';
        }
        return args[0] === "version" ? versionOutput() : infoOutput("systemd");
      },
      local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
      expectedExecutables: expectedExecutables(),
    });

    const inspection = inspector.inspect();
    await expect(inspection).rejects.toMatchObject({ stage, cause: expect.any(Error) });
    await expect(inspection).rejects.not.toThrow(/schema-canary|private/);
  });

  it.each([
    ["version", "bound Docker identity version response"],
    ["info", "bound Docker identity information response"],
  ] as const)("separates a Docker %s byte-bound failure", async (command, stage) => {
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => {
        if (args[0] === command) {
          return "x".repeat(1_048_577);
        }
        return args[0] === "version" ? versionOutput() : infoOutput("systemd");
      },
      local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({ stage, cause: expect.any(Error) });
  });

  it.each(["version", "info"] as const)(
    "accepts a valid Docker %s response at the exact byte limit",
    async (command) => {
      const inspector = new LocalPrimeOciRuntimeInspector({
        run: async (args) => {
          const source = args[0] === "version" ? versionOutput() : infoOutput("systemd");
          return args[0] === command ? source.padEnd(1_048_576, " ") : source;
        },
        local: async () => localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
        expectedExecutables: expectedExecutables(),
      });

      await expect(inspector.inspect()).resolves.toBeDefined();
    },
  );

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
      expectedExecutables: expectedExecutables(),
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

  it("accepts bounded non-selected Docker runtime metadata", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const info = JSON.parse(infoOutput("systemd")) as Record<string, unknown>;
    const runtimes = info.Runtimes as Record<string, Record<string, unknown>>;
    runtimes["io.containerd.runc.v2"] = { runtimeType: "io.containerd.runc.v2" };
    runtimes.runc = { path: "runc", runtimeArgs: ["--debug"] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput() : JSON.stringify(info)),
      local: async () => localObservation(seccompProfile),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).resolves.toMatchObject({ daemonId: "daemon-private-id" });
  });

  it.each([
    [
      "validate Docker API identity",
      (input: RuntimeInspectionInput) => {
        const client = input.version.Client as Record<string, unknown>;
        client.ApiVersion = "1.50";
      },
    ],
    [
      "validate Docker kernel identity",
      (input: RuntimeInspectionInput) => {
        input.info.KernelVersion = "changed-kernel";
      },
    ],
    [
      "validate Docker daemon identity",
      (input: RuntimeInspectionInput) => {
        input.info.ID = "changed-daemon";
      },
    ],
    [
      "validate Docker cgroup policy",
      (input: RuntimeInspectionInput) => {
        input.info.CgroupDriver = "cgroupfs";
      },
    ],
    [
      "validate selected Docker runtime",
      (input: RuntimeInspectionInput) => {
        const runtimes = input.info.Runtimes as Record<string, Record<string, unknown>>;
        runtimes["flow-prime-runc"] = { path: "/opt/changed/runc", runtimeArgs: [] };
      },
    ],
    [
      "validate runtime executable identity",
      (input: RuntimeInspectionInput) => {
        input.local.executables.docker.sha256 = "f".repeat(64);
      },
    ],
    [
      "validate low-level runtime identity",
      (input: RuntimeInspectionInput) => {
        input.info.RuncCommit = { ID: "changed-runc-commit" };
      },
    ],
    [
      "construct Docker runtime identity",
      (input: RuntimeInspectionInput) => {
        const server = input.version.Server as Record<string, unknown>;
        server.Version = "not-semver";
      },
    ],
  ] as const)("reports %s without exposing its private cause", async (stage, mutate) => {
    const input = runtimeInspectionInput();
    mutate(input);
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => JSON.stringify(args[0] === "version" ? input.version : input.info),
      local: async () => input.local,
      expectedExecutables: expectedExecutables(),
    });

    const inspection = inspector.inspect();
    await expect(inspection).rejects.toMatchObject({
      stage,
      cause: expect.any(Error),
    });
    await expect(inspection).rejects.not.toThrow(/changed-|not-semver|cgroupfs|\/opt\/changed/i);
  });

  it("rejects a Docker engine without the fixed cgroup driver", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput() : infoOutput("cgroupfs")),
      local: async () => localObservation(seccompProfile),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "validate Docker cgroup policy",
      cause: expect.objectContaining({ message: expect.stringMatching(/cgroup driver/i) }),
    });
  });

  it("rejects a selected runc path that differs from the observed executable", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) =>
        args[0] === "version" ? versionOutput() : infoOutput("systemd", "/opt/custom/runc"),
      local: async () => localObservation(seccompProfile),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "validate selected Docker runtime",
      cause: expect.objectContaining({ message: expect.stringMatching(/runc.*path/i) }),
    });
  });

  it.each([
    [
      "default runtime",
      (value: Record<string, unknown>) => {
        value.DefaultRuntime = "runc";
      },
    ],
    [
      "selected runtime name",
      (value: Record<string, unknown>) => {
        value.Runtimes = { "other-runc": { path: "/usr/bin/runc", runtimeArgs: [] } };
      },
    ],
    [
      "selected runtime path",
      (value: Record<string, unknown>) => {
        value.Runtimes = {
          "flow-prime-runc": { runtimeType: "io.containerd.runc.v2", runtimeArgs: [] },
        };
      },
    ],
    [
      "runtime argument",
      (value: Record<string, unknown>) => {
        const runtimes = value.Runtimes as Record<string, Record<string, unknown>>;
        runtimes["flow-prime-runc"] = {
          ...runtimes["flow-prime-runc"],
          runtimeArgs: ["--root=/tmp/changed"],
        };
      },
    ],
  ])("rejects a changed %s", async (_label, mutate) => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const info = JSON.parse(infoOutput("systemd")) as Record<string, unknown>;
    mutate(info);
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput() : JSON.stringify(info)),
      local: async () => localObservation(seccompProfile),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "validate Docker identity information response schema",
      cause: expect.objectContaining({
        message: expect.stringMatching(/Docker identity information response.*closed schema/i),
      }),
    });
  });

  it("rejects a matching Docker stack below the fixed API version", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) => (args[0] === "version" ? versionOutput("1.48") : infoOutput("systemd")),
      local: async () => localObservation(seccompProfile, "1.48"),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "validate Docker API identity",
      cause: expect.objectContaining({ message: expect.stringMatching(/API version.*1\.51/i) }),
    });
  });

  it("rejects a stock runc component in place of the selected Prime runtime", async () => {
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const version = JSON.parse(versionOutput()) as Record<string, unknown>;
    const server = version.Server as Record<string, unknown>;
    const components = server.Components as Array<Record<string, unknown>>;
    const selected = components.find((component) => component.Name === "flow-prime-runc");
    if (selected === undefined) {
      throw new Error("the fixture omits the selected Prime runtime component");
    }
    selected.Name = "runc";
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) =>
        args[0] === "version" ? JSON.stringify(version) : infoOutput("systemd"),
      local: async () => localObservation(seccompProfile),
      expectedExecutables: expectedExecutables(),
    });

    await expect(inspector.inspect()).rejects.toMatchObject({
      stage: "validate low-level runtime identity",
      cause: expect.objectContaining({ message: expect.stringMatching(/flow-prime-runc/i) }),
    });
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
        {
          Name: "flow-prime-runc",
          Version: "1.2.6",
          Details: { GitCommit: "runc-commit" },
        },
      ],
    },
  });
}

function infoOutput(cgroupDriver: string, runcPath = "/usr/bin/runc"): string {
  return JSON.stringify({
    ID: "daemon-private-id",
    DockerRootDir: "/var/lib/docker",
    Driver: "overlay2",
    CgroupDriver: cgroupDriver,
    CgroupVersion: "2",
    KernelVersion: "6.11.0-1018-azure",
    OSType: "linux",
    Architecture: "x86_64",
    SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
    ContainerdCommit: { ID: "containerd-commit" },
    RuncCommit: { ID: "runc-commit" },
    DefaultRuntime: "flow-prime-runc",
    Runtimes: { "flow-prime-runc": { path: runcPath, runtimeArgs: [] } },
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

interface RuntimeInspectionInput {
  readonly info: Record<string, unknown>;
  readonly local: ReturnType<typeof localObservation>;
  readonly version: Record<string, unknown>;
}

function runtimeInspectionInput(): RuntimeInspectionInput {
  return {
    info: JSON.parse(infoOutput("systemd")) as Record<string, unknown>,
    local: structuredClone(localObservation({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] })),
    version: JSON.parse(versionOutput()) as Record<string, unknown>,
  };
}

function expectedExecutables() {
  return localObservation({}).executables;
}
