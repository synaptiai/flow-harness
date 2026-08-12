import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  PrimeDockerCommandAbortError,
  PrimeImageBuildStageError,
} from "../../../../src/infrastructure/oci/local-prime-image-builder.js";
import { LocalPrimeOciRuntimeInspector } from "../../../../src/infrastructure/oci/local-prime-oci-runtime-inspector.js";
import {
  type PrimeOciInspectionStage,
  PrimeOciInspectionStageError,
  type PrimeOciPreparationError,
  type PrimeOciRuntimeInspection,
  preparePrimeOciRuntime,
  withPrimeOciInspectionStage,
} from "../../../../src/infrastructure/oci/prime-oci-preparation.js";
import {
  createProductionPrimeOciPreparationDependencies,
  globalLeaseDirectoryRepairs,
  inspectPrimeOciBootstrapExecutables,
  inspectPrimeOciManagedRuntimeExecutables,
  observeLocalRuntime,
  type PrimeOciLocalRuntimeObservationOperations,
  reconcilePrimePreparationImages,
  runPrimePreparationWithCleanup,
} from "../../../../src/infrastructure/oci/production-prime-oci-preparation.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

describe("Prime OCI runtime preparation", () => {
  it("reports one fixed preflight stage before starting either clean build", async () => {
    const privateFailure = new Error("private image device path");
    const build = vi.fn(async () => preparedBuild());

    const preparation = preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      {
        preflightRuntime: async () => {
          throw new PrimeOciInspectionStageError("inspect image backing device", privateFailure);
        },
        build,
        inspectRuntime: async () => runtimeInspection(),
        publish: vi.fn(),
      },
    );

    await expect(preparation).rejects.toMatchObject({
      code: "inspection_failed",
      message: "Prime OCI runtime inspection failed during inspect image backing device",
    });
    await expect(preparation).rejects.not.toThrow(/private image device path/i);
    expect(build).not.toHaveBeenCalled();
  });

  it("reports a piped core policy as the fixed host-core stage", async () => {
    const build = vi.fn(async () => preparedBuild());
    const inspected = runtimeInspection();

    await expect(
      preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        {
          preflightRuntime: async () => ({
            ...inspected,
            local: { ...inspected.local, corePattern: "|/usr/share/apport/apport" },
          }),
          build,
          inspectRuntime: async () => inspected,
          publish: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      code: "inspection_failed",
      message: "Prime OCI runtime inspection failed during inspect host core policy",
    });
    expect(build).not.toHaveBeenCalled();
  });

  it.each([
    "read Docker version",
    "read Docker information",
    "inspect Docker socket",
    "inspect host core policy",
    "inspect host cgroup",
    "prepare global lease root",
    "inspect image backing device",
    "inspect runtime executables",
    "inspect seccomp policy",
  ] as const)("binds production observation failure to %s", async (stage) => {
    const privateFailure = new Error(`private ${stage} diagnostic`);
    const build = vi.fn(async () => preparedBuild());
    const preparation = preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      {
        preflightRuntime: async () => {
          await observeLocalRuntime(
            localRuntimeObservationInput(),
            localRuntimeObservationOperations(stage, privateFailure),
          );
          return runtimeInspection();
        },
        build,
        inspectRuntime: async () => runtimeInspection(),
        publish: vi.fn(),
      },
    );

    await expect(preparation).rejects.toMatchObject({
      code: "inspection_failed",
      message: `Prime OCI runtime inspection failed during ${stage}`,
      cause: { stage, cause: privateFailure },
    });
    await expect(preparation).rejects.not.toThrow(privateFailure.message);
    expect(build).not.toHaveBeenCalled();
  });

  it("accepts bounded non-selected Docker runtime metadata", async () => {
    const operations = localRuntimeObservationOperations();

    await expect(
      observeLocalRuntime(localRuntimeObservationInput(), {
        ...operations,
        readDockerInformation: async () =>
          JSON.stringify({
            ID: "daemon-test-id",
            DockerRootDir: "/var/lib/docker",
            OSType: "linux",
            Architecture: "x86_64",
            DefaultRuntime: "flow-prime-runc",
            Runtimes: {
              "flow-prime-runc": { path: "/usr/bin/runc", runtimeArgs: [] },
              "io.containerd.runc.v2": { runtimeType: "io.containerd.runc.v2" },
              runc: { path: "runc", runtimeArgs: ["--debug"] },
            },
          }),
        inspectRuntimeExecutables: async () => ({
          docker: { path: "/usr/bin/docker", sha256: "a".repeat(64) },
          dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
          containerd: { path: "/usr/bin/containerd", sha256: "b".repeat(64) },
          runc: { path: "/usr/bin/runc", sha256: "c".repeat(64) },
        }),
      }),
    ).resolves.toMatchObject({ daemonId: "daemon-test-id" });
  });

  it("rejects a selected Prime runtime without its absolute executable path", async () => {
    const operations = localRuntimeObservationOperations();
    const inspectRuntimeExecutables = vi.fn(operations.inspectRuntimeExecutables);

    await expect(
      observeLocalRuntime(localRuntimeObservationInput(), {
        ...operations,
        readDockerInformation: async () =>
          JSON.stringify({
            ID: "daemon-test-id",
            DockerRootDir: "/var/lib/docker",
            OSType: "linux",
            Architecture: "x86_64",
            DefaultRuntime: "flow-prime-runc",
            Runtimes: {
              "flow-prime-runc": { runtimeType: "io.containerd.runc.v2", runtimeArgs: [] },
            },
          }),
        inspectRuntimeExecutables,
      }),
    ).rejects.toMatchObject({
      stage: "read Docker information",
      cause: expect.objectContaining({ message: expect.stringMatching(/closed schema/i) }),
    });
    expect(inspectRuntimeExecutables).not.toHaveBeenCalled();
  });

  it.each([
    [
      "bootstrap",
      (operation: () => Promise<never>) =>
        inspectPrimeOciBootstrapExecutables(undefined, operation),
    ],
    [
      "managed runtime",
      (operation: () => Promise<never>) => inspectPrimeOciManagedRuntimeExecutables(operation),
    ],
  ] as const)(
    "binds the %s executable setup failure to its fixed stage",
    async (_name, inspect) => {
      const privateFailure = new Error("private executable setup diagnostic");
      const result = inspect(async () => {
        throw privateFailure;
      });

      await expect(result).rejects.toMatchObject({
        stage: "inspect runtime executables",
        cause: privateFailure,
      });
      await expect(result).rejects.not.toThrow(privateFailure.message);
    },
  );

  it("repeats authoritative inspection after both clean builds", async () => {
    const events: string[] = [];
    let inspectionNumber = 0;

    await preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      createProductionPrimeOciPreparationDependencies({
        builder: {
          build: async (buildNumber) => {
            events.push(`build ${buildNumber}`);
            return preparedBuild();
          },
        },
        inspector: {
          inspect: async () => {
            inspectionNumber += 1;
            events.push(inspectionNumber === 1 ? "preflight" : "authoritative inspection");
            return runtimeInspection();
          },
        },
        signal: undefined,
        publish: async () => {
          events.push("publish");
        },
      }),
    );

    expect(events).toEqual([
      "preflight",
      "build 1",
      "build 2",
      "authoritative inspection",
      "publish",
    ]);
  });

  it("rejects executable drift after both builds before publication", async () => {
    const publish = vi.fn();
    let observationNumber = 0;
    const inspector = new LocalPrimeOciRuntimeInspector({
      run: async (args) =>
        args[0] === "version" ? runtimeInspectorVersionOutput() : runtimeInspectorInfoOutput(),
      local: async () => {
        observationNumber += 1;
        const inspected = runtimeInspection();
        return {
          daemonId: inspected.daemonId,
          ...inspected.local,
          executables: {
            ...inspected.local.executables,
            docker: {
              ...inspected.local.executables.docker,
              sha256: (observationNumber === 1 ? "a" : "f").repeat(64),
            },
          },
        };
      },
      expectedExecutables: runtimeInspection().local.executables,
    });

    const preparation = preparePrimeOciRuntime(
      { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
      createProductionPrimeOciPreparationDependencies({
        builder: { build: async () => preparedBuild() },
        inspector,
        signal: undefined,
        publish,
      }),
    );

    await expect(preparation).rejects.toMatchObject({
      code: "inspection_failed",
      message: "Prime OCI runtime inspection failed during validate runtime executable identity",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["docker", "dockerd", "containerd", "runc"] as const)(
    "rejects same-byte %s path drift after both builds before publication",
    async (executable) => {
      const publish = vi.fn();
      let observationNumber = 0;
      const expected = runtimeInspection().local.executables;
      const inspector = new LocalPrimeOciRuntimeInspector({
        run: async (args) =>
          args[0] === "version" ? runtimeInspectorVersionOutput() : runtimeInspectorInfoOutput(),
        local: async () => {
          observationNumber += 1;
          const inspected = runtimeInspection();
          return {
            daemonId: inspected.daemonId,
            ...inspected.local,
            executables: {
              ...inspected.local.executables,
              [executable]: {
                ...inspected.local.executables[executable],
                path:
                  observationNumber === 1
                    ? inspected.local.executables[executable].path
                    : `/opt/changed/${executable}`,
              },
            },
          };
        },
        expectedExecutables: expected,
      });

      const preparation = preparePrimeOciRuntime(
        { descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json" },
        createProductionPrimeOciPreparationDependencies({
          builder: { build: async () => preparedBuild() },
          inspector,
          signal: undefined,
          publish,
        }),
      );

      await expect(preparation).rejects.toMatchObject({
        code: "inspection_failed",
        message: `Prime OCI runtime inspection failed during ${
          executable === "runc"
            ? "validate selected Docker runtime"
            : "validate runtime executable identity"
        }`,
      });
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("preserves owned Docker cancellation through preflight staging", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled Docker preflight");

    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      {
        preflightRuntime: () =>
          withPrimeOciInspectionStage(
            "read Docker version",
            async () => {
              controller.abort(cancellation);
              throw new PrimeDockerCommandAbortError(cancellation);
            },
            controller.signal,
          ),
        build: async () => preparedBuild(),
        inspectRuntime: async () => runtimeInspection(),
        publish: vi.fn(),
      },
    );

    await expect(preparation).rejects.toBe(cancellation);
  });

  it("preserves cancellation when a staged operation aborts and resolves", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled a resolving inspection");
    const nextMutation = vi.fn();

    const inspection = withPrimeOciInspectionStage(
      "read Docker version",
      async () => {
        controller.abort(cancellation);
        return "completed after cancellation";
      },
      controller.signal,
    ).then(nextMutation);

    await expect(inspection).rejects.toBe(cancellation);
    expect(nextMutation).not.toHaveBeenCalled();
  });

  it("preserves a non-Error cancellation through nested inspection stages", async () => {
    const controller = new AbortController();
    const inspection = withPrimeOciInspectionStage(
      "validate Docker runtime identity",
      () =>
        withPrimeOciInspectionStage(
          "inspect host cgroup",
          async () => {
            controller.abort("operator-stop");
            return "/sys/fs/cgroup/flow-prime";
          },
          controller.signal,
        ),
      controller.signal,
    );

    await expect(inspection).rejects.toMatchObject({
      name: "AbortError",
      message: "Prime OCI runtime preparation was cancelled",
      cause: "operator-stop",
    });
    await expect(inspection).rejects.not.toBeInstanceOf(PrimeOciInspectionStageError);
  });

  it("preserves owned Docker cancellation during authoritative production inspection", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled authoritative inspection");
    const publish = vi.fn();
    let inspectionNumber = 0;

    const preparation = preparePrimeOciRuntime(
      {
        descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
        signal: controller.signal,
      },
      createProductionPrimeOciPreparationDependencies({
        builder: { build: async () => preparedBuild() },
        inspector: {
          inspect: async () => {
            inspectionNumber += 1;
            if (inspectionNumber === 1) {
              return runtimeInspection();
            }
            controller.abort(cancellation);
            throw new PrimeDockerCommandAbortError(cancellation);
          },
        },
        signal: controller.signal,
        publish,
      }),
    );

    await expect(preparation).rejects.toBe(cancellation);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    [
      "bootstrap BuildKit builder",
      "Prime OCI clean build 1 failed during bootstrap BuildKit builder",
    ],
    [
      "scan system image AWS access keys",
      "Prime OCI clean build 1 failed during scan system image AWS access keys",
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

function localRuntimeObservationInput(): Parameters<typeof observeLocalRuntime>[0] {
  return {
    packageRoot: "/package",
    dockerExecutable: "/usr/bin/docker",
    run: async () => {
      throw new Error("the injected observation operation must handle Docker reads");
    },
    signal: undefined,
  };
}

function localRuntimeObservationOperations(
  failedStage?: PrimeOciInspectionStage,
  failure?: Error,
): PrimeOciLocalRuntimeObservationOperations {
  const observe = async <Value>(stage: PrimeOciInspectionStage, value: Value): Promise<Value> => {
    if (stage === failedStage) {
      if (failure === undefined) {
        throw new Error("an injected observation failure requires one private cause");
      }
      throw failure;
    }
    return value;
  };
  return {
    readDockerVersion: async () =>
      observe("read Docker version", JSON.stringify({ Server: { ApiVersion: "1.51" } })),
    readDockerInformation: async () =>
      observe(
        "read Docker information",
        JSON.stringify({
          ID: "daemon-test-id",
          DockerRootDir: "/var/lib/docker",
          OSType: "linux",
          Architecture: "x86_64",
          DefaultRuntime: "flow-prime-runc",
          Runtimes: { "flow-prime-runc": { path: "/usr/bin/runc", runtimeArgs: [] } },
        }),
      ),
    inspectDockerSocket: async () =>
      observe("inspect Docker socket", {
        device: 1,
        inode: 2,
        uid: 0,
        gid: 999,
        mode: 0o660,
      }),
    inspectHostCorePolicy: async () => observe("inspect host core policy", "core"),
    inspectHostCgroup: async () => observe("inspect host cgroup", "/sys/fs/cgroup/flow-prime"),
    prepareGlobalLeaseRoot: async () =>
      observe("prepare global lease root", "/var/tmp/flow-prime/global-slot.json"),
    inspectImageBackingDevice: async () =>
      observe("inspect image backing device", { path: "/dev/sda1", major: 8, minor: 1 }),
    inspectRuntimeExecutables: async () =>
      observe("inspect runtime executables", {
        docker: { path: "/usr/bin/docker", sha256: "a".repeat(64) },
        dockerd: { path: "/usr/bin/dockerd", sha256: "d".repeat(64) },
        containerd: { path: "/usr/bin/containerd", sha256: "b".repeat(64) },
        runc: { path: "/usr/bin/runc", sha256: "c".repeat(64) },
      }),
    inspectSeccompPolicy: async () =>
      observe("inspect seccomp policy", { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] }),
  };
}

function runtimeInspectorVersionOutput(): string {
  return JSON.stringify({
    Client: { Version: "28.3.3", ApiVersion: "1.51", Os: "linux", Arch: "amd64" },
    Server: {
      Version: "28.3.3",
      GitCommit: "dockerd-commit",
      ApiVersion: "1.51",
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

function runtimeInspectorInfoOutput(): string {
  return JSON.stringify({
    ID: "daemon-test-id",
    Driver: "overlay2",
    CgroupDriver: "systemd",
    CgroupVersion: "2",
    KernelVersion: "6.11.0-1018-azure",
    OSType: "linux",
    Architecture: "x86_64",
    SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
    ContainerdCommit: { ID: "containerd-commit" },
    RuncCommit: { ID: "runc-commit" },
    DefaultRuntime: "flow-prime-runc",
    Runtimes: { "flow-prime-runc": { path: "/usr/bin/runc", runtimeArgs: [] } },
    Rootless: false,
  });
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
