import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { externalHarnessIdentityDigest } from "../../../src/domain/evaluation/external-harness.js";
import { createPrimeOciRuntimePolicy } from "../../../src/infrastructure/oci/prime-oci-policy.js";
import type { NativePrimeHarnessDescriptor } from "../../../src/infrastructure/prime/native-prime-harness-registry.js";
import type { PrimeExternalHarnessIdentity } from "../../fixtures/evaluation/prime-external-harness-identity.js";
import { primeExternalHarnessIdentity } from "../../fixtures/evaluation/prime-external-harness-identity.js";
import {
  startVerifiedPrimeContainer,
  type VerifiedPrimeContainerTransport,
} from "../../fixtures/prime/prime-container-runtime.js";
import {
  runVerifiedPrimeSession,
  verifiedPrimeSessionTimeoutError,
} from "../../fixtures/prime/verified-prime-session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("verified Prime container runtime helper", () => {
  it.each([
    [
      0,
      undefined,
      "verified Prime session exceeded 2000ms with inference request count 0 and driver progress none",
    ],
    [
      1,
      "sdk-prompt-started",
      "verified Prime session exceeded 2000ms with inference request count 1 and driver progress sdk-prompt-started",
    ],
    [
      3,
      "inference-response-received",
      "verified Prime session exceeded 2000ms with inference request count 3 and driver progress inference-response-received",
    ],
  ] as const)(
    "reports the closed inference phase when a session times out after %i requests",
    (count, progress, message) => {
      expect(verifiedPrimeSessionTimeoutError(2_000, count, progress)).toEqual(new Error(message));
    },
  );

  it("creates the verified container through the production Docker API policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-"));
    temporaryDirectories.push(root);
    const seccompProfile = {};
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, seccompProfile);
    const fixture = dockerFixture();
    const assertCurrent = vi.fn(async () => undefined);

    const transport = await startVerifiedPrimeContainer(identity, {
      api: fixture.api,
      assertCurrent,
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      seccompProfile,
      temporaryRoot: root,
    });
    await transport.closeInput();
    await transport.release();

    expect(transport.containerId).toBe(fixture.containerId);
    expect(fixture.api.createContainer).toHaveBeenCalledOnce();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.api.createContainer.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(assertCurrent.mock.invocationCallOrder[1]).toBeLessThan(
      fixture.api.startContainer.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(fixture.state.containerName).toMatch(/^flow-prime-[a-f0-9]{32}$/);
    if (fixture.state.configuration === undefined) {
      throw new Error("verified Prime helper did not submit a Docker configuration");
    }
    expect(fixture.state.configuration).toMatchObject({
      Image: `sha256:${"b".repeat(64)}`,
      HostConfig: {
        NetworkMode: "none",
        Runtime: "flow-prime-runc",
        SecurityOpt: ["no-new-privileges", "seccomp={}"],
        BlkioDeviceReadBps: [{ Path: "/dev/test-image", Rate: 67_108_864 }],
        BlkioDeviceReadIOps: [{ Path: "/dev/test-image", Rate: 4_096 }],
        MaskedPaths: expect.arrayContaining([
          "/proc/cmdline",
          "/proc/sys",
          "/sys/class/dmi/id",
          "/sys/devices/virtual/dmi/id",
        ]),
      },
    });
    expect(
      (
        fixture.state.configuration.HostConfig as {
          readonly SecurityOpt: readonly string[];
        }
      ).SecurityOpt.some((value) => value.startsWith("mask=")),
    ).toBe(false);
    expect(fixture.api.attachContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.api.startContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.api.stopContainer).toHaveBeenCalledWith(fixture.containerId, 5, undefined);
    expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.attachment.release).toHaveBeenCalledOnce();
  });

  it("rejects a seccomp profile that contradicts the runtime identity before create", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-seccomp-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture();
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});

    await expect(
      startVerifiedPrimeContainer(identity, {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: { defaultAction: "SCMP_ACT_ALLOW" },
        temporaryRoot: root,
      }),
    ).rejects.toThrow(/seccomp.*contradicts/i);
    expect(fixture.api.createContainer).not.toHaveBeenCalled();
  });

  it("accepts a canonically equivalent seccomp profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-seccomp-order-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture();
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, { alpha: 1, beta: 2 });

    const transport = await startVerifiedPrimeContainer(identity, {
      api: fixture.api,
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      seccompProfile: { beta: 2, alpha: 1 },
      temporaryRoot: root,
    });
    await transport.release();
    expect(fixture.api.createContainer).toHaveBeenCalledOnce();
  });

  it("does not remove by name when currentness fails before create", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-currentness-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture();

    await expect(
      startVerifiedPrimeContainer(verifiedIdentity(`sha256:${"b".repeat(64)}`, {}), {
        api: fixture.api,
        assertCurrent: async () => {
          throw new Error("private currentness failure");
        },
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      }),
    ).rejects.toThrow(/private currentness failure/i);
    expect(fixture.api.createContainer).not.toHaveBeenCalled();
    expect(fixture.api.stopContainer).not.toHaveBeenCalled();
    expect(fixture.api.removeContainer).not.toHaveBeenCalled();
  });

  it("reconciles a lost create response and removes only the recovered full ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-lost-create-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture({ createErrorAfterPublication: new Error("lost response") });

    await expect(
      startVerifiedPrimeContainer(verifiedIdentity(`sha256:${"b".repeat(64)}`, {}), {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      }),
    ).rejects.toThrow(/lost response/i);
    expect(fixture.api.inspectContainer).toHaveBeenCalledWith(
      fixture.state.containerName,
      undefined,
    );
    expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.state.removed).toBe(true);
  });

  it("uses the named-create fence when the first recovery lookup misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-create-fence-"));
    temporaryDirectories.push(root);
    const assertCurrent = vi.fn(async () => undefined);
    const fixture = dockerFixture({
      createErrorAfterPublication: new Error("lost response"),
      recoveryMisses: 1,
    });

    const error = await startVerifiedPrimeContainer(
      verifiedIdentity(`sha256:${"b".repeat(64)}`, {}),
      {
        api: fixture.api,
        assertCurrent,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      },
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.api.createContainer).toHaveBeenCalledTimes(2);
    expect(assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.api.createContainer.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(assertCurrent.mock.invocationCallOrder[1]).toBeLessThan(
      fixture.api.createContainer.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(fixture.api.inspectContainer).toHaveBeenCalledTimes(3);
    expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.state.removed).toBe(true);
  });

  it("does not retry the named create after recovery currentness fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-create-fence-currentness-"));
    temporaryDirectories.push(root);
    const currentnessError = new Error("private recovery currentness failure");
    const assertCurrent = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(currentnessError);
    const fixture = dockerFixture({
      createErrorAfterPublication: new Error("lost response"),
      recoveryMisses: 1,
    });

    const error = await startVerifiedPrimeContainer(
      verifiedIdentity(`sha256:${"b".repeat(64)}`, {}),
      {
        api: fixture.api,
        assertCurrent,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      },
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[1]).toBe(currentnessError);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(fixture.api.createContainer).toHaveBeenCalledOnce();
    expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
    expect(fixture.state.removed).toBe(true);
  });

  it("does not remove a foreign container that occupies the recovery name", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-foreign-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture({
      createErrorAfterPublication: new Error("lost response"),
      foreignRecovery: true,
    });

    await expect(
      startVerifiedPrimeContainer(verifiedIdentity(`sha256:${"b".repeat(64)}`, {}), {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      }),
    ).rejects.toThrow(/not reconciled/i);
    expect(fixture.api.stopContainer).not.toHaveBeenCalled();
    expect(fixture.api.removeContainer).not.toHaveBeenCalled();
  });

  it.each([
    ["post-create inspection", { createInspectionError: true }, false],
    ["attach", { attachError: new Error("private attach failure") }, false],
    ["start", { startError: new Error("private start failure") }, true],
  ] as const)(
    "removes the container after a %s failure",
    async (_label, options, releasesAttachment) => {
      const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-setup-"));
      temporaryDirectories.push(root);
      const fixture = dockerFixture(options);
      const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});

      await expect(
        startVerifiedPrimeContainer(identity, {
          api: fixture.api,
          imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
          seccompProfile: {},
          temporaryRoot: root,
        }),
      ).rejects.toThrow();

      expect(fixture.api.removeContainer).toHaveBeenCalledWith(fixture.containerId, undefined);
      expect(fixture.api.inspectContainer).toHaveBeenLastCalledWith(fixture.containerId, undefined);
      expect(fixture.attachment.release).toHaveBeenCalledTimes(releasesAttachment ? 1 : 0);
    },
  );

  it("retries cleanup after a transient removal failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-retry-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture({ removeFailures: 1 });
    const transport = await startVerifiedPrimeContainer(
      verifiedIdentity(`sha256:${"b".repeat(64)}`, {}),
      {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      },
    );

    await expect(transport.release()).rejects.toThrow(/cleanup failed/i);
    await expect(transport.forceRemove()).resolves.toBeUndefined();
    expect(fixture.api.removeContainer).toHaveBeenCalledTimes(2);
    expect(fixture.state.removed).toBe(true);
  });

  it("retries cleanup after setup fails and the first removal is transient", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-setup-retry-"));
    temporaryDirectories.push(root);
    const fixture = dockerFixture({
      startError: new Error("private start failure"),
      removeFailures: 1,
    });

    await expect(
      startVerifiedPrimeContainer(verifiedIdentity(`sha256:${"b".repeat(64)}`, {}), {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      }),
    ).rejects.toThrow(/private start failure/i);
    expect(fixture.api.removeContainer).toHaveBeenCalledTimes(2);
    expect(fixture.state.removed).toBe(true);
  });

  it("preserves setup and cleanup failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-aggregate-"));
    temporaryDirectories.push(root);
    const setupError = new Error("private start failure");
    const cleanupError = new Error("private removal failure");
    const fixture = dockerFixture({ startError: setupError, removeFailures: 3, cleanupError });

    const error = await startVerifiedPrimeContainer(
      verifiedIdentity(`sha256:${"b".repeat(64)}`, {}),
      {
        api: fixture.api,
        imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
        seccompProfile: {},
        temporaryRoot: root,
      },
    ).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(setupError);
    expect((error as AggregateError).errors.slice(1)).toHaveLength(2);
    for (const failure of (error as AggregateError).errors.slice(1)) {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toContain(cleanupError);
    }
  });

  it("preserves a session failure before its final cleanup failure", async () => {
    const primaryError = new Error("private protocol failure");
    const cleanupError = new Error("private container cleanup failure");
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});
    const transport: VerifiedPrimeContainerTransport = {
      containerId: "a".repeat(64),
      containerName: `flow-prime-${"c".repeat(32)}`,
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      output: (async function* () {
        yield await Promise.reject<Uint8Array>(primaryError);
      })(),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      forceRemove: vi.fn(async () => {
        throw cleanupError;
      }),
    };

    const error = await runVerifiedPrimeSession({
      instruction: "Fail before readiness.\n",
      responses: [],
      testDependencies: {
        resolveDescriptor: async () => descriptorFor(identity, {}),
        startContainer: async () => transport,
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primaryError, cleanupError, cleanupError]);
    expect(transport.forceRemove).toHaveBeenCalledTimes(2);
  });

  it("retries transient container cleanup before returning the session failure", async () => {
    const primaryError = new Error("private protocol failure");
    const transientCleanupError = new Error("private transient cleanup failure");
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});
    const forceRemove = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(transientCleanupError)
      .mockResolvedValueOnce(undefined);
    const transport: VerifiedPrimeContainerTransport = {
      ...stubTransport(forceRemove),
      output: (async function* () {
        yield await Promise.reject<Uint8Array>(primaryError);
      })(),
    };

    const error = await runVerifiedPrimeSession({
      instruction: "Fail before readiness.\n",
      responses: [],
      testDependencies: {
        resolveDescriptor: async () => descriptorFor(identity, {}),
        startContainer: async () => transport,
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBe(primaryError);
    expect(forceRemove).toHaveBeenCalledTimes(2);
  });

  it.each(["startup", "callback"] as const)(
    "removes the session workspace and container after a %s failure",
    async (failurePoint) => {
      const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});
      const cleanup = vi.fn(async () => undefined);
      let workspace: string | undefined;
      const transport = stubTransport(cleanup);

      await expect(
        runVerifiedPrimeSession({
          instruction: "Fail while acquiring session resources.\n",
          responses: [],
          ...(failurePoint === "callback"
            ? {
                onContainerStarted: async () => {
                  throw new Error("private callback failure");
                },
              }
            : {}),
          testDependencies: {
            onWorkspaceCreated: (path) => {
              workspace = path;
            },
            resolveDescriptor: async () => descriptorFor(identity, {}),
            startContainer: async () => {
              if (failurePoint === "startup") {
                throw new Error("private startup failure");
              }
              return transport;
            },
          },
        }),
      ).rejects.toThrow(new RegExp(`private ${failurePoint} failure`, "i"));
      expect(workspace).toBeDefined();
      await expect(access(workspace as string)).rejects.toMatchObject({ code: "ENOENT" });
      expect(cleanup).toHaveBeenCalledTimes(failurePoint === "callback" ? 1 : 0);
    },
  );

  it("preserves startup and workspace-cleanup failures", async () => {
    const startupError = new Error("private startup failure");
    const workspaceCleanupError = new Error("private workspace cleanup failure");
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});

    const error = await runVerifiedPrimeSession({
      instruction: "Fail while starting.\n",
      responses: [],
      testDependencies: {
        removeWorkspace: async () => {
          throw workspaceCleanupError;
        },
        resolveDescriptor: async () => descriptorFor(identity, {}),
        startContainer: async () => {
          throw startupError;
        },
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([startupError, workspaceCleanupError]);
  });

  it("cleans the workspace and preserves an undefined rejection", async () => {
    const identity = verifiedIdentity(`sha256:${"b".repeat(64)}`, {});
    let workspace: string | undefined;

    const outcome = await runVerifiedPrimeSession({
      instruction: "Reject without an Error object.\n",
      responses: [],
      testDependencies: {
        onWorkspaceCreated: (path) => {
          workspace = path;
        },
        resolveDescriptor: async () => descriptorFor(identity, {}),
        startContainer: () => Promise.reject(undefined),
      },
    }).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );

    expect(outcome).toEqual({ reason: undefined, status: "rejected" });
    expect(workspace).toBeDefined();
    await expect(access(workspace as string)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface DockerFixtureOptions {
  readonly attachError?: Error;
  readonly cleanupError?: Error;
  readonly createErrorAfterPublication?: Error;
  readonly createInspectionError?: boolean;
  readonly foreignRecovery?: boolean;
  readonly recoveryMisses?: number;
  readonly removeFailures?: number;
  readonly startError?: Error;
}

function dockerFixture(options: DockerFixtureOptions = {}) {
  const containerId = "a".repeat(64);
  const attachment = {
    output: (async function* () {})(),
    write: vi.fn(async () => undefined),
    closeInput: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const state: {
    configuration?: Record<string, unknown>;
    containerName?: string;
    inspectCalls: number;
    recoveryMisses: number;
    removeFailures: number;
    removed: boolean;
  } = {
    inspectCalls: 0,
    recoveryMisses: options.recoveryMisses ?? 0,
    removeFailures: options.removeFailures ?? 0,
    removed: false,
  };
  const api = {
    createContainer: vi.fn(async (name: string, value: Record<string, unknown>) => {
      state.containerName = name;
      state.configuration = value;
      if (options.createErrorAfterPublication !== undefined) {
        throw options.createErrorAfterPublication;
      }
      return containerId;
    }),
    inspectContainer: vi.fn(async (reference: string) => {
      state.inspectCalls += 1;
      if (reference === state.containerName && state.recoveryMisses > 0) {
        state.recoveryMisses -= 1;
        return null;
      }
      if (state.removed || state.configuration === undefined || state.containerName === undefined) {
        return null;
      }
      if (options.createInspectionError === true && state.inspectCalls === 1) {
        return null;
      }
      const inspection = {
        Id: containerId,
        Name: `/${state.containerName}`,
        Image: state.configuration.Image,
        Config: state.configuration,
        HostConfig: state.configuration.HostConfig,
      };
      if (options.foreignRecovery === true && reference === state.containerName) {
        return { ...inspection, Image: `sha256:${"0".repeat(64)}` };
      }
      return inspection;
    }),
    attachContainer: vi.fn(async () => {
      if (options.attachError !== undefined) {
        throw options.attachError;
      }
      return attachment;
    }),
    startContainer: vi.fn(async () => {
      if (options.startError !== undefined) {
        throw options.startError;
      }
    }),
    stopContainer: vi.fn(async () => undefined),
    removeContainer: vi.fn(async () => {
      if (state.removeFailures > 0) {
        state.removeFailures -= 1;
        throw options.cleanupError ?? new Error("private transient removal failure");
      }
      state.removed = true;
    }),
  };
  return { api, attachment, containerId, state };
}

function verifiedIdentity(
  imageId: string,
  seccompProfile: Readonly<Record<string, unknown>>,
): PrimeExternalHarnessIdentity {
  const base = primeExternalHarnessIdentity();
  const seccompSha256 = createHash("sha256").update(canonicalize(seccompProfile)).digest("hex");
  return {
    ...base,
    runtime: { ...base.runtime, policy: createPrimeOciRuntimePolicy(seccompSha256) },
    image: { ...base.image, id: imageId },
  };
}

function stubTransport(forceRemove: () => Promise<void>): VerifiedPrimeContainerTransport {
  return {
    containerId: "a".repeat(64),
    containerName: `flow-prime-${"c".repeat(32)}`,
    imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
    output: (async function* () {})(),
    write: vi.fn(async () => undefined),
    closeInput: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    forceRemove,
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("test fixture contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function descriptorFor(
  identity: PrimeExternalHarnessIdentity,
  seccompProfile: Readonly<Record<string, unknown>>,
): NativePrimeHarnessDescriptor {
  return {
    identity,
    identityDigest: externalHarnessIdentityDigest(identity),
    localRuntime: {
      daemonId: "verified-prime-test",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 1, uid: 0, gid: 0, mode: 0o660 },
      apiVersion: identity.runtime.engine.apiVersion,
      cgroupPath: "/sys/fs/cgroup",
      corePattern: "core",
      globalLeasePath: "/var/tmp/flow-prime-test-slot.json",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      executables: {
        docker: { path: "/usr/bin/docker", sha256: identity.runtime.client.executableSha256 },
        dockerd: { path: "/usr/bin/dockerd", sha256: identity.runtime.engine.dockerdSha256 },
        containerd: {
          path: "/usr/bin/containerd",
          sha256: identity.runtime.engine.containerdSha256,
        },
        runc: { path: "/usr/bin/runc", sha256: identity.runtime.engine.runcSha256 },
      },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile,
    },
    assertCurrent: async () => undefined,
  };
}
