import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { PrimeImageBuildStageError } from "../../../../src/infrastructure/oci/local-prime-image-builder.js";
import {
  type PrimeOciPreparationError,
  type PrimeOciRuntimeInspection,
  preparePrimeOciRuntime,
} from "../../../../src/infrastructure/oci/prime-oci-preparation.js";
import {
  globalLeaseDirectoryRepairs,
  reconcilePrimePreparationImages,
  runPrimePreparationWithCleanup,
} from "../../../../src/infrastructure/oci/production-prime-oci-preparation.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime OCI runtime preparation", () => {
  it.each([
    [
      "bootstrap BuildKit builder",
      "Prime OCI clean build 1 failed during bootstrap BuildKit builder",
    ],
    [
      "scan image archive AWS access keys",
      "Prime OCI clean build 1 failed during scan image archive AWS access keys",
    ],
  ] as const)(
    "reports fixed image-build stage %s without exposing the nested failure",
    async (stage, message) => {
      const preparation = preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        {
          build: async () => {
            throw new PrimeImageBuildStageError(stage, new Error("private Docker response body"));
          },
          inspectRuntime: vi.fn(),
          publish: vi.fn(),
        },
      );

      await expect(preparation).rejects.toMatchObject({ code: "build_failed", message });
      await expect(preparation).rejects.not.toThrow(/private Docker response body/i);
    },
  );

  it("does not repair an exact shared global lease directory", () => {
    expect(globalLeaseDirectoryRepairs({ gid: 999, mode: 0o2770 }, 999)).toEqual({
      group: false,
      mode: false,
    });
    expect(globalLeaseDirectoryRepairs({ gid: 998, mode: 0o2770 }, 999)).toEqual({
      group: true,
      mode: false,
    });
    expect(globalLeaseDirectoryRepairs({ gid: 999, mode: 0o770 }, 999)).toEqual({
      group: false,
      mode: true,
    });
  });

  it("publishes one descriptor after two identical builds", async () => {
    const identity = primeExternalHarnessIdentity();
    const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
    const runtime = {
      ...identity.runtime,
      policy: {
        ...identity.runtime.policy,
        seccompSha256: createHash("sha256").update(JSON.stringify(seccompProfile)).digest("hex"),
      },
    };
    const build = vi.fn(async () => ({
      image: identity.image,
      builder: builderIdentity(),
      artifacts: imageArtifacts(),
      harnessPackageContentSha256: identity.harness.packageContentSha256,
      harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
    }));
    const publish = vi.fn(async () => undefined);

    const result = await preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      {
        build,
        inspectRuntime: async () => ({
          runtime,
          daemonId: "daemon-test-id",
          local: {
            socketPath: "/var/run/docker.sock",
            socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
            apiVersion: runtime.engine.apiVersion,
            cgroupPath: "/sys/fs/cgroup/flow-prime",
            corePattern: "core",
            globalLeasePath: "/var/lib/flow-prime/global-slot.json",
            imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
            executables: {
              docker: { path: "/usr/bin/docker", sha256: runtime.client.executableSha256 },
              dockerd: { path: "/usr/bin/dockerd", sha256: runtime.engine.dockerdSha256 },
              containerd: {
                path: "/usr/bin/containerd",
                sha256: runtime.engine.containerdSha256,
              },
              runc: { path: "/usr/bin/runc", sha256: runtime.engine.runcSha256 },
            },
            leaseTarget: "flow-prime-global-v1",
            seccompProfile,
          },
        }),
        publish,
      },
    );

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, 1);
    expect(build).toHaveBeenNthCalledWith(2, 2);
    expect(result.descriptorPath).toBe("/project/.flow/runtime/prime-agent/oci-attestation.json");
    expect(result.imageId).toBe(identity.image.id);
    expect(publish).toHaveBeenCalledWith(
      "/project/.flow/runtime/prime-agent/oci-attestation.json",
      expect.objectContaining({
        version: 1,
        runtime,
        image: identity.image,
        builder: builderIdentity(),
        artifacts: imageArtifacts(),
        daemonId: "daemon-test-id",
      }),
      undefined,
    );
  });

  it("rejects a reproducibility difference before publication", async () => {
    const identity = primeExternalHarnessIdentity();
    const publish = vi.fn(async () => undefined);
    let buildNumber = 0;

    await expect(
      preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        {
          build: async () => {
            buildNumber += 1;
            return {
              image: {
                ...identity.image,
                sbomSha256: (buildNumber === 1 ? "1" : "2").repeat(64),
              },
              builder: builderIdentity(),
              artifacts: imageArtifacts(),
              harnessPackageContentSha256: identity.harness.packageContentSha256,
              harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
            };
          },
          inspectRuntime: async () => {
            throw new Error("runtime inspection must not start");
          },
          publish,
        },
      ),
    ).rejects.toMatchObject({
      code: "non_reproducible",
    } satisfies Partial<PrimeOciPreparationError>);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects one executable hash difference before runtime inspection", async () => {
    const identity = primeExternalHarnessIdentity();
    let buildNumber = 0;
    const inspectRuntime = vi.fn();

    await expect(
      preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        {
          build: async () => {
            buildNumber += 1;
            return {
              image: identity.image,
              builder: builderIdentity(),
              artifacts: {
                ...imageArtifacts(),
                supervisorSha256: (buildNumber === 1 ? "6" : "7").repeat(64),
              },
              harnessPackageContentSha256: identity.harness.packageContentSha256,
              harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
            };
          },
          inspectRuntime,
          publish: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ code: "non_reproducible" });
    expect(inspectRuntime).not.toHaveBeenCalled();
  });

  it("does not continue or publish after cancellation at a preparation boundary", async () => {
    const identity = primeExternalHarnessIdentity();
    const controller = new AbortController();
    const publish = vi.fn(async () => undefined);
    const build = vi.fn(async () => {
      controller.abort(new Error("operator cancelled preparation"));
      return {
        image: identity.image,
        builder: builderIdentity(),
        artifacts: imageArtifacts(),
        harnessPackageContentSha256: identity.harness.packageContentSha256,
        harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
      };
    });

    await expect(
      preparePrimeOciRuntime(
        {
          descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
          signal: controller.signal,
        },
        { build, inspectRuntime: vi.fn(), publish },
      ),
    ).rejects.toThrow(/cancelled preparation/i);
    expect(build).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves cancellation raised while a clean build is blocked", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled blocked clean build");
    let releaseBuild!: () => void;
    const buildStarted = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const build = vi.fn(async (): Promise<never> => {
      releaseBuild();
      return await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
    });
    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      { build, inspectRuntime: vi.fn(), publish: vi.fn() },
    );
    await buildStarted;
    controller.abort(cancellation);

    await expect(preparation).rejects.toBe(cancellation);
  });

  it("does not hide cleanup failure after a cancelled clean build", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled clean build");
    const cleanup = new Error("private cleanup failure");
    const cleanupFailure = new PrimeImageBuildStageError(
      "clean build resources",
      new AggregateError([cancellation, cleanup]),
    );

    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      {
        build: async () => {
          controller.abort(cancellation);
          throw cleanupFailure;
        },
        inspectRuntime: vi.fn(),
        publish: vi.fn(),
      },
    );

    await expect(preparation).rejects.toMatchObject({
      code: "build_failed",
      message: "Prime OCI clean build 1 failed during clean build resources",
      cause: cleanupFailure,
    });
  });

  it("preserves exact cancellation raised during runtime inspection", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled blocked runtime inspection");
    let releaseInspection!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      {
        build: async () => preparedBuild(),
        inspectRuntime: async (): Promise<never> => {
          releaseInspection();
          return await new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          });
        },
        publish: vi.fn(),
      },
    );
    await inspectionStarted;
    controller.abort(cancellation);

    await expect(preparation).rejects.toBe(cancellation);
  });

  it("preserves cancellation observed after successful runtime inspection", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled before publication");

    await expect(
      preparePrimeOciRuntime(
        {
          descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
          signal: controller.signal,
        },
        {
          build: async () => preparedBuild(),
          inspectRuntime: async () => {
            controller.abort(cancellation);
            return runtimeInspection();
          },
          publish: vi.fn(),
        },
      ),
    ).rejects.toBe(cancellation);
  });

  it("preserves exact cancellation raised during publication", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled blocked publication");
    let releasePublication!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      {
        build: async () => preparedBuild(),
        inspectRuntime: async () => runtimeInspection(),
        publish: async (): Promise<never> => {
          releasePublication();
          return await new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          });
        },
      },
    );
    await publicationStarted;
    controller.abort(cancellation);

    await expect(preparation).rejects.toBe(cancellation);
  });

  it("does not hide a distinct publication failure after cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled publication");
    const publicationFailure = new Error("private uncertain publication failure");

    await expect(
      preparePrimeOciRuntime(
        {
          descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
          signal: controller.signal,
        },
        {
          build: async () => preparedBuild(),
          inspectRuntime: async () => runtimeInspection(),
          publish: async () => {
            controller.abort(cancellation);
            throw publicationFailure;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "publish_failed",
      cause: publicationFailure,
    });
  });

  it("preserves primary and cleanup failures under one fixed cleanup stage", async () => {
    const primary = new PrimeImageBuildStageError(
      "bootstrap BuildKit builder",
      new Error("private primary detail"),
    );
    const cleanup = new Error("private cleanup detail");

    await expect(
      runPrimePreparationWithCleanup(
        async () => {
          throw primary;
        },
        async () => {
          throw cleanup;
        },
      ),
    ).rejects.toMatchObject({
      stage: "clean build resources",
      cause: expect.objectContaining({ errors: [primary, cleanup] }),
    });
  });

  it("assigns successful-operation cleanup failure to the fixed cleanup stage", async () => {
    const cleanup = new Error("private cleanup detail");

    await expect(
      runPrimePreparationWithCleanup(
        async () => "prepared",
        async () => {
          throw cleanup;
        },
      ),
    ).rejects.toMatchObject({
      stage: "clean build resources",
      cause: expect.objectContaining({ errors: [cleanup] }),
    });
  });

  it("preserves new images when failed publication cannot reconcile the descriptor", async () => {
    const primary = new Error("private uncertain publication failure");
    const reconciliation = new Error("private descriptor reconciliation failure");
    const retireExcept = vi.fn(async () => undefined);

    await expect(
      runPrimePreparationWithCleanup(
        async () => {
          throw primary;
        },
        async (_prepared, primaryError) =>
          reconcilePrimePreparationImages({
            primaryError,
            readVisibleImageId: async () => {
              throw reconciliation;
            },
            retireExcept,
          }),
      ),
    ).rejects.toMatchObject({
      stage: "clean build resources",
      cause: expect.objectContaining({ errors: [primary, reconciliation] }),
    });
    expect(retireExcept).not.toHaveBeenCalled();
  });
});

function imageArtifacts() {
  return {
    driverSha256: "1".repeat(64),
    flowDistSha256: "2".repeat(64),
    kernelProxySha256: "3".repeat(64),
    noIoResourceLoaderSha256: "4".repeat(64),
    pythonLauncherSha256: "5".repeat(64),
    supervisorSha256: "6".repeat(64),
  };
}

function builderIdentity() {
  return {
    clientPath: "/usr/libexec/docker/cli-plugins/docker-buildx",
    clientSha256: "8".repeat(64),
    imageId: `sha256:${"9".repeat(64)}`,
    imageReference:
      "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec",
  };
}

function preparedBuild() {
  const identity = primeExternalHarnessIdentity();
  return {
    image: identity.image,
    builder: builderIdentity(),
    artifacts: imageArtifacts(),
    harnessPackageContentSha256: identity.harness.packageContentSha256,
    harnessDependencyClosureSha256: identity.harness.dependencyClosureSha256,
  };
}

function runtimeInspection(): PrimeOciRuntimeInspection {
  const identity = primeExternalHarnessIdentity();
  const seccompProfile = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] };
  const runtime = {
    ...identity.runtime,
    policy: {
      ...identity.runtime.policy,
      seccompSha256: createHash("sha256").update(JSON.stringify(seccompProfile)).digest("hex"),
    },
  };
  return {
    runtime,
    daemonId: "daemon-test-id",
    local: {
      socketPath: "/var/run/docker.sock" as const,
      socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
      apiVersion: runtime.engine.apiVersion,
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
