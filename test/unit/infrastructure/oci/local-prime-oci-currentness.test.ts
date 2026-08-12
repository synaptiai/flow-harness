import { describe, expect, it } from "vitest";
import {
  DockerUnixApiClient,
  type DockerUnixApiTransport,
} from "../../../../src/infrastructure/oci/docker-unix-api-client.js";
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
    let serverCommit = "dockerd-commit";
    let versionOverride: string | undefined;
    let cgroupPath = local.cgroupPath;
    let imageDevice = local.imageDevice;
    let imageInspections = 0;
    const transport: DockerUnixApiTransport = {
      request: async (request) => {
        if (request.path === "/v1.51/version") {
          return { statusCode: 200, body: versionOverride ?? engineVersionSource(serverCommit) };
        }
        if (request.path === "/v1.51/info") {
          return { statusCode: 200, body: info };
        }
        if (request.path.startsWith("/v1.51/images/") && request.path.endsWith("/json")) {
          imageInspections += 1;
          return imagePresent
            ? {
                statusCode: 200,
                body: JSON.stringify({ Id: primeExternalHarnessIdentity().image.id }),
              }
            : { statusCode: 404, body: "" };
        }
        throw new Error(`unexpected Docker API request: ${request.path}`);
      },
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });
    const runtime = (
      await new LocalPrimeOciRuntimeInspector({
        run: async (args) => (args[0] === "version" ? versionSource(serverCommit, "28.3.2") : info),
        local: async () => local,
        expectedExecutables: local.executables,
      }).inspect()
    ).runtime;
    const input = {
      runtime,
      image: primeExternalHarnessIdentity().image,
      local,
      client,
      readCorePattern: async () => corePattern,
      readCurrentCgroup: async () => cgroupPath,
      resolveImageDevice: async () => imageDevice,
      resolveRuntimeExecutables: async () => ({
        containerd: local.executables.containerd.path,
        dockerd: local.executables.dockerd.path,
      }),
    };

    await expect(assertPrimeOciRuntimeCurrent(input)).resolves.toBeUndefined();
    expect(imageInspections).toBe(1);

    const exactVersion = JSON.parse(engineVersionSource(serverCommit)) as Record<string, unknown>;
    exactVersion.PrivatePadding = "";
    const exactBase = JSON.stringify(exactVersion);
    exactVersion.PrivatePadding = "x".repeat(1_048_576 - Buffer.byteLength(exactBase));
    versionOverride = JSON.stringify(exactVersion);
    expect(Buffer.byteLength(versionOverride)).toBe(1_048_576);
    await expect(assertPrimeOciRuntimeCurrent(input)).resolves.toBeUndefined();
    expect(imageInspections).toBe(2);

    for (const [source, stage] of [
      ["x".repeat(1_048_577), "query Docker identity version"],
      ["private malformed Engine version", "parse Docker Engine version response"],
      [
        '{"private":"Engine-version-schema-canary"}',
        "validate Docker Engine version response schema",
      ],
    ] as const) {
      versionOverride = source;
      const currentness = assertPrimeOciRuntimeCurrent(input);
      await expect(currentness).rejects.toMatchObject({ stage, cause: expect.any(Error) });
      await expect(currentness).rejects.not.toThrow(/private|canary/);
      expect(imageInspections).toBe(2);
    }
    versionOverride = undefined;

    for (const mutate of runtimeDriftMutations()) {
      const changedInfo = JSON.parse(infoSource("overlay2")) as Record<string, unknown>;
      mutate(changedInfo);
      info = JSON.stringify(changedInfo);
      await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toMatchObject({
        stage: "validate Docker identity information response schema",
        cause: expect.objectContaining({
          message: expect.stringMatching(/Docker identity information response.*closed schema/i),
        }),
      });
      expect(imageInspections).toBe(2);
    }
    info = infoSource("overlay2");

    imageDevice = { path: "/dev/changed-image", major: 8, minor: 2 };
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/image.*device/i);

    const privateDeviceFailure = new Error("ENOENT: realpath '/srv/customer-private/docker-root'");
    const privateDeviceCheck = assertPrimeOciRuntimeCurrent({
      ...input,
      resolveImageDevice: async () => {
        throw privateDeviceFailure;
      },
    });
    await expect(privateDeviceCheck).rejects.toMatchObject({
      message: "Prime OCI runtime inspection failed during inspect image backing device",
      cause: privateDeviceFailure,
    });
    await expect(privateDeviceCheck).rejects.not.toThrow(/customer-private/i);

    imageDevice = local.imageDevice;
    cgroupPath = "/sys/fs/cgroup/another-service";
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/cgroup/i);

    cgroupPath = local.cgroupPath;

    await expect(
      assertPrimeOciRuntimeCurrent({
        ...input,
        resolveRuntimeExecutables: async () => ({
          containerd: "/opt/custom/containerd",
          dockerd: local.executables.dockerd.path,
        }),
      }),
    ).rejects.toThrow(/containerd.*path/i);

    await expect(
      assertPrimeOciRuntimeCurrent({
        ...input,
        resolveRuntimeExecutables: async () => ({
          containerd: local.executables.containerd.path,
          dockerd: "/opt/custom/dockerd",
        }),
      }),
    ).rejects.toThrow(/dockerd.*path/i);

    await expect(
      assertPrimeOciRuntimeCurrent({
        ...input,
        resolveRuntimeExecutables: async () => ({
          containerd: local.executables.containerd.path,
          dockerd: local.executables.dockerd.path,
          containerdSha256: "8".repeat(64),
          dockerdSha256: local.executables.dockerd.sha256,
        }),
      }),
    ).rejects.toThrow(/containerd.*executable.*changed/i);

    serverCommit = "changed-dockerd-commit";
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/runtime.*changed/i);
    serverCommit = "dockerd-commit";

    info = infoSource("btrfs");
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/runtime.*changed/i);

    info = infoSource("overlay2");
    imagePresent = false;
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/image.*changed/i);

    imagePresent = true;
    corePattern = "changed-core";
    await expect(assertPrimeOciRuntimeCurrent(input)).rejects.toThrow(/core.*changed/i);
  });

  it("applies the Engine adapter bound after an injected current-state read", async () => {
    const local = localObservation();
    const runtime = (
      await new LocalPrimeOciRuntimeInspector({
        run: async (args) =>
          args[0] === "version" ? versionSource("dockerd-commit") : infoSource("overlay2"),
        local: async () => local,
        expectedExecutables: local.executables,
      }).inspect()
    ).runtime;
    let version = engineVersionAtBytes("dockerd-commit", 1_048_576);
    let imageInspections = 0;
    const client: PrimeOciCurrentStateClient = {
      readVersion: async () => version,
      readInfo: async () => infoSource("overlay2"),
      inspectImage: async (imageId) => {
        imageInspections += 1;
        return { Id: imageId };
      },
    };
    const input = {
      runtime,
      image: primeExternalHarnessIdentity().image,
      local,
      client,
      readCorePattern: async () => local.corePattern,
      readCurrentCgroup: async () => local.cgroupPath,
      resolveImageDevice: async () => local.imageDevice,
      resolveRuntimeExecutables: async () => ({
        containerd: local.executables.containerd.path,
        dockerd: local.executables.dockerd.path,
      }),
    };

    await expect(assertPrimeOciRuntimeCurrent(input)).resolves.toBeUndefined();
    expect(imageInspections).toBe(1);

    version = engineVersionAtBytes("dockerd-commit", 1_048_577);
    const currentness = assertPrimeOciRuntimeCurrent(input);
    await expect(currentness).rejects.toMatchObject({
      stage: "bound Docker Engine version response",
      cause: expect.any(Error),
    });
    await expect(currentness).rejects.not.toThrow(/private-engine-bound-canary/);
    expect(imageInspections).toBe(1);
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
      dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
      containerd: { path: "/usr/bin/containerd", sha256: "6".repeat(64) },
      runc: { path: "/usr/bin/runc", sha256: "7".repeat(64) },
    },
    leaseTarget: "flow-prime-global-v1" as const,
    seccompProfile: { digest: policy.seccompSha256 },
  };
}

function versionSource(serverCommit: string, clientVersion = "28.3.3"): string {
  return JSON.stringify({
    Client: { Version: clientVersion, ApiVersion: "1.51", Os: "linux", Arch: "amd64" },
    Server: {
      Version: "28.3.3",
      GitCommit: serverCommit,
      ApiVersion: "1.51",
      Os: "linux",
      Arch: "amd64",
      KernelVersion: "6.11.0-1018-azure",
      Components: [
        { Name: "containerd", Version: "1.7.27", Details: { GitCommit: "containerd-commit" } },
        {
          Name: "flow-prime-runc",
          Version: "1.2.6",
          Details: { GitCommit: "runc-commit" },
        },
      ],
    },
  });
}

function engineVersionSource(serverCommit: string): string {
  const source = JSON.parse(versionSource(serverCommit)) as {
    readonly Server: Record<string, unknown>;
  };
  return JSON.stringify(source.Server);
}

function engineVersionAtBytes(serverCommit: string, bytes: number): string {
  const source = JSON.parse(engineVersionSource(serverCommit)) as Record<string, unknown>;
  source.PrivatePadding = "private-engine-bound-canary";
  const base = JSON.stringify(source);
  const padding = bytes - Buffer.byteLength(base);
  if (padding < 0) {
    throw new Error("the requested Engine version fixture is below its base size");
  }
  source.PrivatePadding = `${source.PrivatePadding}${"x".repeat(padding)}`;
  const result = JSON.stringify(source);
  if (Buffer.byteLength(result) !== bytes) {
    throw new Error("the Engine version fixture has the wrong byte size");
  }
  return result;
}

function infoSource(driver: string): string {
  return JSON.stringify({
    ID: "daemon-test-id",
    DockerRootDir: "/var/lib/docker",
    Driver: driver,
    CgroupDriver: "systemd",
    CgroupVersion: 2,
    KernelVersion: "6.11.0-1018-azure",
    OSType: "linux",
    Architecture: "amd64",
    SecurityOptions: ["name=seccomp,profile=builtin", "name=apparmor"],
    ContainerdCommit: { ID: "containerd-commit" },
    RuncCommit: { ID: "runc-commit" },
    DefaultRuntime: "flow-prime-runc",
    Runtimes: { "flow-prime-runc": { path: "/usr/bin/runc", runtimeArgs: [] } },
    Rootless: false,
  });
}

function runtimeDriftMutations(): readonly ((value: Record<string, unknown>) => void)[] {
  return [
    (value) => {
      value.DefaultRuntime = "runc";
    },
    (value) => {
      value.Runtimes = { "other-runc": { path: "/usr/bin/runc", runtimeArgs: [] } };
    },
    (value) => {
      const runtimes = value.Runtimes as Record<string, Record<string, unknown>>;
      runtimes["flow-prime-runc"] = {
        ...runtimes["flow-prime-runc"],
        runtimeArgs: ["--root=/tmp/changed"],
      };
    },
  ];
}
