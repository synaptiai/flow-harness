import { describe, expect, it, vi } from "vitest";

import {
  calculateContainerCommandConfigurationDigest,
  parseContainerCommandIntent,
} from "../../../../src/infrastructure/oci/container-command-intent.js";
import {
  LocalDockerContainerCommandEngine,
  type LocalDockerContainerCommandEngineOptions,
  type LocalDockerContainerCommandRuntimeDescriptor,
} from "../../../../src/infrastructure/oci/local-docker-container-command-engine.js";

const CONTAINER_ID = "c".repeat(64);
const WORKSPACE_SNAPSHOT_DIGEST = "7".repeat(64);

describe("LocalDockerContainerCommandEngine", () => {
  it("rescans durable orphans before a later prepare after an earlier clean scan", async () => {
    const events: string[] = [];
    const orphan = ownedOrphan();
    const claim = {
      intent: orphan,
      release: vi.fn(async () => {
        events.push("release-claim");
      }),
      complete: vi.fn(async () => {
        events.push("complete-claim");
      }),
    };
    let recoveryScan = 0;
    const claimOrphans = vi.fn(async () =>
      recoveryScan++ === 0 ? Object.freeze([]) : Object.freeze([claim]),
    );
    const removed = new Set<string>();
    const created = new Map<
      string,
      { readonly configuration: Record<string, unknown>; readonly name: string }
    >();
    const createIds = ["e".repeat(64), "f".repeat(64)];
    const api = {
      createContainer: vi.fn(async (name: string, input: Record<string, unknown>) => {
        const id = createIds.shift();
        if (id === undefined) {
          throw new Error("unexpected extra container creation");
        }
        events.push(`create-${created.size + 1}`);
        created.set(id, { configuration: structuredClone(input), name });
        return id;
      }),
      inspectContainer: vi.fn(async (reference: string) => {
        if (reference === orphan.containerId) {
          events.push(removed.has(reference) ? "confirm-orphan-absence" : "inspect-orphan");
          return removed.has(reference)
            ? null
            : {
                Id: reference,
                Name: `/${orphan.containerName}`,
                Image: orphan.runtime.imageId,
                Config: orphan.configuration,
                HostConfig: orphan.configuration.HostConfig,
              };
        }
        const current = created.get(reference);
        if (current === undefined || removed.has(reference)) {
          return null;
        }
        return {
          Id: reference,
          Name: `/${current.name}`,
          Image: descriptor().imageId,
          Config: current.configuration,
          HostConfig: current.configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async (reference: string) => {
        if (reference === orphan.containerId) {
          events.push("stop-orphan");
        }
      }),
      removeContainer: vi.fn(async (reference: string) => {
        if (reference === orphan.containerId) {
          events.push("remove-orphan");
        }
        removed.add(reference);
      }),
    };
    const nonces = ["b".repeat(32), "c".repeat(32)];
    const ownerNonces = ["a".repeat(64), "b".repeat(64)];
    let privateDirectory = 0;
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => nonces.shift() ?? "d".repeat(32),
      createPrivateDirectory: async () => `/private/new-docker-config-${++privateDirectory}`,
      removePrivateDirectory: async (path: string) => {
        if (path === orphan.privateDirectory) {
          events.push("remove-orphan-private");
        }
      },
      durability: {
        createOwnerNonce: () => ownerNonces.shift() ?? "c".repeat(64),
        readProcessOwner: async () => ({
          bootId: "123e4567-e89b-42d3-a456-426614174000",
          pid: 9999,
          startTicks: "111111",
        }),
        isOwnerAlive: async () => false,
        store: {
          claimOrphans,
          writeIntent: async () => undefined,
          writeOwned: async () => undefined,
          remove: async () => undefined,
        },
      },
    });

    const first = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });
    await first.release();
    events.length = 0;

    const second = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-2",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(claimOrphans).toHaveBeenCalledTimes(2);
    expect(events.slice(0, 7)).toEqual([
      "inspect-orphan",
      "stop-orphan",
      "remove-orphan",
      "confirm-orphan-absence",
      "remove-orphan-private",
      "complete-claim",
      "create-2",
    ]);
    await second.release();
  });

  it("settles one claimed owned orphan before creating a new command container", async () => {
    const events: string[] = [];
    const oldId = "d".repeat(64);
    const oldConfiguration = { Image: descriptor().imageId, HostConfig: {} };
    const orphan = parseContainerCommandIntent({
      version: 1,
      state: "owned",
      ownerNonce: "e".repeat(64),
      containerName: `flow-command-${"f".repeat(32)}`,
      owner: {
        bootId: "123e4567-e89b-42d3-a456-426614174000",
        pid: 1234,
        startTicks: "987654",
      },
      runtime: {
        engineVersion: descriptor().engineVersion,
        apiVersion: descriptor().apiVersion,
        socketPath: descriptor().socketPath,
        imageId: descriptor().imageId,
        runtimeName: descriptor().runtimeName,
        policyDigest: descriptor().policyDigest,
      },
      privateDirectory: "/private/orphan-docker-config",
      configuration: oldConfiguration,
      configurationDigest: calculateContainerCommandConfigurationDigest(oldConfiguration),
      containerId: oldId,
    });
    let oldRemoved = false;
    let newConfiguration: Record<string, unknown> | undefined;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        events.push("create-new");
        newConfiguration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async (reference: string) => {
        if (reference === oldId) {
          events.push(oldRemoved ? "confirm-old-absence" : "inspect-old");
          return oldRemoved
            ? null
            : {
                Id: oldId,
                Name: `/${orphan.containerName}`,
                Image: orphan.runtime.imageId,
                Config: oldConfiguration,
                HostConfig: oldConfiguration.HostConfig,
              };
        }
        if (newConfiguration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: newConfiguration,
          HostConfig: newConfiguration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async (reference: string) => {
        if (reference === oldId) {
          events.push("stop-old");
        }
      }),
      removeContainer: vi.fn(async (reference: string) => {
        if (reference === oldId) {
          events.push("remove-old");
          oldRemoved = true;
        }
      }),
    };
    const claim = {
      intent: orphan,
      release: vi.fn(async () => {
        events.push("release-claim");
      }),
      complete: vi.fn(async () => {
        events.push("complete-claim");
      }),
    };
    const options = {
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/new-docker-config",
      removePrivateDirectory: async (path: string) => {
        events.push(path === orphan.privateDirectory ? "remove-old-private" : "remove-new-private");
      },
      durability: {
        createOwnerNonce: () => "a".repeat(64),
        readProcessOwner: async () => ({
          bootId: "123e4567-e89b-42d3-a456-426614174000",
          pid: 9999,
          startTicks: "111111",
        }),
        isOwnerAlive: async () => false,
        store: {
          claimOrphans: vi.fn(async () => [claim]),
          writeIntent: vi.fn(async () => {
            events.push("write-new-intent");
          }),
          writeOwned: vi.fn(async () => {
            events.push("write-new-owned");
          }),
          remove: vi.fn(async () => undefined),
        },
      },
    };
    const engine = new LocalDockerContainerCommandEngine(options);

    await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(events.slice(0, 7)).toEqual([
      "inspect-old",
      "stop-old",
      "remove-old",
      "confirm-old-absence",
      "remove-old-private",
      "complete-claim",
      "write-new-intent",
    ]);
    expect(events).toContain("create-new");
    expect(claim.release).not.toHaveBeenCalled();
  });

  it("releases the recovery claim and blocks Docker mutation when durable runtime identity drifts", async () => {
    const orphan = ownedOrphan({ policyDigest: "9".repeat(64) });
    const claim = {
      intent: orphan,
      release: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    const api = {
      createContainer: vi.fn(),
      inspectContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
    };
    const engine = recoveryEngine(api, claim);

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      }),
    ).rejects.toThrow("durable command container runtime identity changed");

    expect(claim.release).toHaveBeenCalledTimes(1);
    expect(claim.complete).not.toHaveBeenCalled();
    expect(api.inspectContainer).not.toHaveBeenCalled();
    expect(api.createContainer).not.toHaveBeenCalled();
    expect(api.stopContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).not.toHaveBeenCalled();
  });

  it("does not remove a foreign container that occupies a durable orphan name", async () => {
    const orphan = ownedOrphan();
    const claim = {
      intent: orphan,
      release: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
    };
    const api = {
      createContainer: vi.fn(),
      inspectContainer: vi.fn(async () => ({
        Id: orphan.containerId,
        Name: `/${orphan.containerName}`,
        Image: `sha256:${"e".repeat(64)}`,
        Config: orphan.configuration,
        HostConfig: orphan.configuration.HostConfig,
      })),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
    };
    const engine = recoveryEngine(api, claim);

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      }),
    ).rejects.toThrow("created command container identity does not match admission");

    expect(claim.release).toHaveBeenCalledTimes(1);
    expect(claim.complete).not.toHaveBeenCalled();
    expect(api.stopContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).not.toHaveBeenCalled();
    expect(api.createContainer).not.toHaveBeenCalled();
  });

  it("uses one exact named-create fence to settle an orphaned intent record", async () => {
    const owned = ownedOrphan();
    const oldId = "d".repeat(64);
    const orphan = parseContainerCommandIntent({
      ...owned,
      state: "intent",
      containerId: undefined,
    });
    const events: string[] = [];
    let published = false;
    let removed = false;
    let newConfiguration: Record<string, unknown> | undefined;
    let createCalls = 0;
    const api = {
      createContainer: vi.fn(async (name: string, input: Record<string, unknown>) => {
        createCalls += 1;
        if (createCalls === 1) {
          events.push("fence-create");
          expect(name).toBe(orphan.containerName);
          expect(input).toEqual(orphan.configuration);
          published = true;
          return oldId;
        }
        events.push("create-new");
        newConfiguration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async (reference: string) => {
        if (reference === orphan.containerName || reference === oldId) {
          events.push(
            reference === orphan.containerName
              ? "inspect-old-name"
              : removed
                ? "confirm-old-absence"
                : "inspect-old-id",
          );
          if (!published || removed) {
            return null;
          }
          return {
            Id: oldId,
            Name: `/${orphan.containerName}`,
            Image: orphan.runtime.imageId,
            Config: orphan.configuration,
            HostConfig: orphan.configuration.HostConfig,
          };
        }
        events.push("inspect-new-id");
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: newConfiguration,
          HostConfig: newConfiguration?.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => {
        events.push("stop");
      }),
      removeContainer: vi.fn(async () => {
        events.push("remove");
        removed = true;
      }),
    };
    const claim = {
      intent: orphan,
      release: vi.fn(async () => undefined),
      complete: vi.fn(async () => {
        events.push("complete");
      }),
    };
    const engine = recoveryEngine(api, claim);

    await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(events.slice(0, 8)).toEqual([
      "inspect-old-name",
      "fence-create",
      "inspect-old-id",
      "stop",
      "remove",
      "confirm-old-absence",
      "complete",
      "create-new",
    ]);
    expect(api.createContainer).toHaveBeenCalledTimes(2);
    expect(claim.release).not.toHaveBeenCalled();
  });

  it("publishes durable intent before create and removes it only after confirmed absence", async () => {
    const events: string[] = [];
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        events.push("create");
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        events.push(removed ? "confirm-absence" : "inspect-created");
        if (removed || configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => {
        events.push("stop");
      }),
      removeContainer: vi.fn(async () => {
        events.push("remove");
        removed = true;
      }),
    };
    const writeIntent = vi.fn(async () => {
      events.push("write-intent");
    });
    const writeOwned = vi.fn(async () => {
      events.push("write-owned");
    });
    const removeIntent = vi.fn(async () => {
      events.push("remove-intent");
    });
    const options = {
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => {
        events.push("remove-private-directory");
      },
      durability: {
        createOwnerNonce: () => "a".repeat(64),
        readProcessOwner: async () => ({
          bootId: "123e4567-e89b-42d3-a456-426614174000",
          pid: 1234,
          startTicks: "987654",
        }),
        store: { writeIntent, writeOwned, remove: removeIntent },
      },
    };
    const engine = new LocalDockerContainerCommandEngine(options);

    const lease = await engine.prepare({
      executable: "node",
      args: ["-e", "console.log('PRIVATE_DURABLE_COMMAND')"],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(events).toEqual(["write-intent", "create", "inspect-created", "write-owned"]);
    expect(writeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "intent",
        ownerNonce: "a".repeat(64),
        containerName: `flow-command-${"b".repeat(32)}`,
        configuration: expect.objectContaining({
          Cmd: ["-e", "console.log('PRIVATE_DURABLE_COMMAND')"],
          Labels: expect.objectContaining({
            "flow.command-owner-nonce": "a".repeat(64),
          }),
        }),
      }),
    );
    expect(writeOwned).toHaveBeenCalledWith(
      expect.objectContaining({ state: "owned", containerId: CONTAINER_ID }),
    );

    await lease.release();
    expect(events).toEqual([
      "write-intent",
      "create",
      "inspect-created",
      "write-owned",
      "stop",
      "remove",
      "confirm-absence",
      "remove-private-directory",
      "remove-intent",
    ]);
  });

  it("retains durable recovery state when cleanup cannot prove absence", async () => {
    let configuration: Record<string, unknown> | undefined;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => ({
        Id: CONTAINER_ID,
        Name: `/flow-command-${"b".repeat(32)}`,
        Image: descriptor().imageId,
        Config: configuration,
        HostConfig: configuration?.HostConfig,
      })),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        throw new Error("PRIVATE_PERSISTENT_REMOVE");
      }),
    };
    const removeIntent = vi.fn(async () => undefined);
    const removePrivateDirectory = vi.fn(async () => undefined);
    const options = {
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory,
      durability: {
        createOwnerNonce: () => "a".repeat(64),
        readProcessOwner: async () => ({
          bootId: "123e4567-e89b-42d3-a456-426614174000",
          pid: 1234,
          startTicks: "987654",
        }),
        store: {
          writeIntent: vi.fn(async () => undefined),
          writeOwned: vi.fn(async () => undefined),
          remove: removeIntent,
        },
      },
    };
    const engine = new LocalDockerContainerCommandEngine(options);
    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    await expect(lease.release()).rejects.toThrow("Container command cleanup is not proved");

    expect(api.removeContainer).toHaveBeenCalledTimes(2);
    expect(api.inspectContainer).toHaveBeenCalledTimes(3);
    expect(removeIntent).not.toHaveBeenCalled();
    expect(removePrivateDirectory).not.toHaveBeenCalled();
  });

  it("submits and inspects a fixed shell-free container policy before returning its launcher", async () => {
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (removed) {
          return null;
        }
        if (configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removed = true;
      }),
    };
    const current = vi.fn(async () => undefined);
    const seccompProfile = {
      defaultAction: "SCMP_ACT_ERRNO",
      defaultErrnoRet: 1,
      syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }],
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => ({
        ...descriptor(),
        seccompProfile,
        assertCurrent: current,
      }),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });
    const privateArgument = "console.log('PRIVATE; $(id)')";

    const lease = await engine.prepare({
      executable: "node",
      args: ["-e", privateArgument],
      cwd: "/workspace/run-1",
      projectRoot: "/project",
      protectedPaths: ["/project/.flow", "/workspace/run-1/.env", "/workspace/run-2"],
      readOnlyPaths: ["/workspace/run-1/.git"],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      runtimeSupportPaths: ["/runtime/node_modules"],
      runtimeEnvironment: { NODE_PATH: "/runtime/node_modules" },
    });

    expect(api.createContainer).toHaveBeenCalledWith(
      `flow-command-${"b".repeat(32)}`,
      expect.objectContaining({
        Image: descriptor().imageId,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Entrypoint: ["node"],
        Cmd: ["-e", privateArgument],
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Labels: expect.objectContaining({
          "flow.workspace-snapshot-digest": WORKSPACE_SNAPSHOT_DIGEST,
        }),
        HostConfig: expect.objectContaining({
          NetworkMode: "none",
          Runtime: "flow-prime-runc",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          CapAdd: [],
          SecurityOpt: ["no-new-privileges", `seccomp=${JSON.stringify(seccompProfile)}`],
          PidsLimit: 64,
          Ulimits: [
            { Name: "nofile", Soft: 1_024, Hard: 1_024 },
            { Name: "fsize", Soft: 33_554_432, Hard: 33_554_432 },
            { Name: "core", Soft: 0, Hard: 0 },
          ],
          Binds: [
            "/workspace/run-1:/workspace:rw",
            "/runtime/node_modules:/runtime/node_modules:ro",
          ],
          MaskedPaths: expect.arrayContaining(["/workspace/.env"]),
          ReadonlyPaths: [
            "/proc/bus",
            "/proc/fs",
            "/proc/irq",
            "/proc/sys",
            "/proc/sysrq-trigger",
            "/workspace/.git",
          ],
        }),
      }),
      undefined,
    );
    expect(current).toHaveBeenCalledTimes(2);
    expect(lease.launch).toEqual({
      executable: "/usr/bin/docker",
      args: ["--host", "unix:///var/run/docker.sock", "start", "--attach", CONTAINER_ID],
      env: {
        DOCKER_API_VERSION: "1.51",
        DOCKER_CONFIG: "/private/docker-config",
        HOME: "/private/docker-config",
      },
    });
    if (configuration === undefined) {
      throw new Error("container policy test did not capture the submitted configuration");
    }
    expect(lease.identity).toEqual({
      backendVersion: "28.3.3",
      policyDigest: calculateContainerCommandConfigurationDigest(configuration),
    });
    expect(lease.identity.policyDigest).not.toBe(descriptor().policyDigest);

    await lease.beforeLaunch?.();
    expect(current).toHaveBeenCalledTimes(3);
    await lease.release();
    expect(api.stopContainer).toHaveBeenCalledWith(CONTAINER_ID, 5, undefined);
    expect(api.removeContainer).toHaveBeenCalledWith(CONTAINER_ID, undefined);
    expect(api.inspectContainer).toHaveBeenLastCalledWith(CONTAINER_ID, undefined);
  });

  it("submits every admitted image environment entry before Docker merges image configuration", async () => {
    const imageEnvironment = [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=22.19.0",
      "YARN_VERSION=1.22.22",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NODE_ENV=production",
      "PRIME_AGENT_KERNEL_FORKSERVER=0",
    ];
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (removed || configuration === undefined) {
          return null;
        }
        const inspected = structuredClone(configuration);
        inspected.Env = mergeDockerImageEnvironment(
          inspected.Env as readonly string[],
          imageEnvironment,
        );
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: inspected,
          HostConfig: inspected.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removed = true;
      }),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(configuration?.Env).toEqual([
      "PRIME_AGENT_KERNEL_FORKSERVER=0",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=22.19.0",
      "YARN_VERSION=1.22.22",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "NODE_ENV=production",
      "HOME=/tmp",
    ]);
    await lease.release();
  });

  it("masks protected state nested inside the workspace", async () => {
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (removed || configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removed = true;
      }),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace",
      protectedPaths: ["/workspace/.flow", "/workspace/.flow/runs/current", "/workspace/TASK.md"],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    expect(api.createContainer).toHaveBeenCalledWith(
      `flow-command-${"b".repeat(32)}`,
      expect.objectContaining({
        HostConfig: expect.objectContaining({
          MaskedPaths: expect.arrayContaining(["/workspace/.flow", "/workspace/TASK.md"]),
        }),
      }),
      undefined,
    );
    if (configuration === undefined) {
      throw new Error("container mask test did not capture the submitted configuration");
    }
    const hostConfiguration = configuration.HostConfig as {
      readonly MaskedPaths: readonly string[];
    };
    expect(hostConfiguration.MaskedPaths).not.toContain("/workspace/.flow/runs/current");
    await lease.release();
  });

  it.each(["/workspace", "/"])(
    "rejects protected state at or above the workspace before Docker mutation: %s",
    async (protectedPath) => {
      const api = {
        createContainer: vi.fn(),
        inspectContainer: vi.fn(),
        stopContainer: vi.fn(),
        removeContainer: vi.fn(),
      };
      const createPrivateDirectory = vi.fn(async () => "/private/docker-config");
      const engine = new LocalDockerContainerCommandEngine({
        resolveDescriptor: async () => descriptor(),
        createApi: () => api,
        createNonce: () => "b".repeat(32),
        createPrivateDirectory,
        removePrivateDirectory: async () => undefined,
      });

      await expect(
        engine.prepare({
          executable: "node",
          args: [],
          cwd: "/workspace",
          protectedPaths: [protectedPath],
          workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
        }),
      ).rejects.toThrow("workspace overlaps protected state");
      expect(createPrivateDirectory).not.toHaveBeenCalled();
      expect(api.createContainer).not.toHaveBeenCalled();
    },
  );

  it("rejects a runtime support bind that overlaps protected state", async () => {
    const api = {
      createContainer: vi.fn(),
      inspectContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace",
        protectedPaths: ["/runtime/node_modules/private"],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
        runtimeSupportPaths: ["/runtime/node_modules"],
      }),
    ).rejects.toThrow("runtime support overlaps protected state");
    expect(api.createContainer).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "memory",
      mutate: (hostConfig: Record<string, unknown>) => {
        hostConfig.Memory = 1;
      },
    },
    {
      label: "read-only workspace paths",
      mutate: (hostConfig: Record<string, unknown>) => {
        hostConfig.ReadonlyPaths = ["/proc/bus"];
      },
    },
  ])("rejects $label policy drift immediately before launch", async ({ mutate }) => {
    let configuration: Record<string, unknown> | undefined;
    let drifted = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (configuration === undefined) {
          return null;
        }
        const inspection = structuredClone(configuration);
        if (drifted) {
          mutate(inspection.HostConfig as Record<string, unknown>);
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: inspection,
          HostConfig: inspection.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => undefined),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });
    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace",
      protectedPaths: [],
      readOnlyPaths: ["/workspace/.git"],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    drifted = true;
    await expect(lease.beforeLaunch?.()).rejects.toThrow(
      "created command container control policy does not match admission",
    );
    expect(api.inspectContainer).toHaveBeenCalledTimes(2);
  });

  it("reconciles a lost create response to a full ID and cleans the owned container", async () => {
    const transportError = new Error("PRIVATE_LOST_CREATE_RESPONSE");
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const containerName = `flow-command-${"b".repeat(32)}`;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        throw transportError;
      }),
      inspectContainer: vi.fn(async (reference: string) => {
        if (removed || configuration === undefined) {
          return null;
        }
        if (reference !== containerName && reference !== CONTAINER_ID) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/${containerName}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removed = true;
      }),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      }),
    ).rejects.toBe(transportError);
    expect(api.removeContainer).toHaveBeenCalledWith(CONTAINER_ID, undefined);
    expect(api.inspectContainer).toHaveBeenCalledWith(containerName, undefined);
    expect(removed).toBe(true);
  });

  it("uses one currentness-guarded named-create fence after a recovery miss", async () => {
    const transportError = new Error("PRIVATE_LOST_CREATE_RESPONSE");
    const events: string[] = [];
    let configuration: Record<string, unknown> | undefined;
    let createCalls = 0;
    let published = false;
    let removed = false;
    const containerName = `flow-command-${"b".repeat(32)}`;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        createCalls += 1;
        events.push(`create-${createCalls}`);
        configuration = structuredClone(input);
        if (createCalls === 1) {
          throw transportError;
        }
        published = true;
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async (reference: string) => {
        events.push(reference === containerName ? "inspect-name" : "inspect-id");
        if (!published || removed || configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/${containerName}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => {
        events.push("stop");
      }),
      removeContainer: vi.fn(async () => {
        events.push("remove");
        removed = true;
      }),
    };
    let currentnessCalls = 0;
    const current = vi.fn(async () => {
      currentnessCalls += 1;
      events.push(`current-${currentnessCalls}`);
    });
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => ({ ...descriptor(), assertCurrent: current }),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      }),
    ).rejects.toBe(transportError);
    expect(events).toEqual([
      "current-1",
      "create-1",
      "inspect-name",
      "current-2",
      "create-2",
      "inspect-id",
      "stop",
      "remove",
      "inspect-id",
    ]);
    expect(api.createContainer).toHaveBeenCalledTimes(2);
    expect(api.removeContainer).toHaveBeenCalledWith(CONTAINER_ID, undefined);
  });

  it("does not clean a foreign container that occupies the generated name", async () => {
    const transportError = new Error("PRIVATE_LOST_CREATE_RESPONSE");
    let configuration: Record<string, unknown> | undefined;
    const containerName = `flow-command-${"b".repeat(32)}`;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        throw transportError;
      }),
      inspectContainer: vi.fn(async () => ({
        Id: CONTAINER_ID,
        Name: `/${containerName}`,
        Image: `sha256:${"e".repeat(64)}`,
        Config: configuration,
        HostConfig: configuration?.HostConfig,
      })),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => undefined),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    const error = await engine
      .prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(transportError);
    expect((error as AggregateError).errors[1]).toEqual(
      new Error("created command container identity does not match admission"),
    );
    expect(api.createContainer).toHaveBeenCalledTimes(1);
    expect(api.stopContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).not.toHaveBeenCalled();
  });

  it("blocks the named-create fence when currentness changes after a lost response", async () => {
    const transportError = new Error("PRIVATE_LOST_CREATE_RESPONSE");
    const currentnessError = new Error("PRIVATE_RUNTIME_DRIFT");
    const api = {
      createContainer: vi.fn(async () => {
        throw transportError;
      }),
      inspectContainer: vi.fn(async () => null),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => undefined),
    };
    let currentnessCalls = 0;
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => ({
        ...descriptor(),
        assertCurrent: async () => {
          currentnessCalls += 1;
          if (currentnessCalls === 2) {
            throw currentnessError;
          }
        },
      }),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
    });

    const error = await engine
      .prepare({
        executable: "node",
        args: [],
        cwd: "/workspace/run-1",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([transportError, currentnessError]);
    expect(api.createContainer).toHaveBeenCalledTimes(1);
    expect(api.inspectContainer).toHaveBeenCalledTimes(1);
    expect(api.stopContainer).not.toHaveBeenCalled();
    expect(api.removeContainer).not.toHaveBeenCalled();
  });

  it("uses an independent cleanup signal after command cancellation", async () => {
    let configuration: Record<string, unknown> | undefined;
    let removed = false;
    const operation = new AbortController();
    const cleanup = new AbortController();
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (removed || configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removed = true;
      }),
    };
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
      createCleanupSignal: () => cleanup.signal,
    });

    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      signal: operation.signal,
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });
    operation.abort(new Error("PRIVATE_COMMAND_CANCELLED"));

    await lease.release();

    expect(api.stopContainer).toHaveBeenCalledWith(CONTAINER_ID, 5, cleanup.signal);
    expect(api.removeContainer).toHaveBeenCalledWith(CONTAINER_ID, cleanup.signal);
    expect(api.inspectContainer).toHaveBeenLastCalledWith(CONTAINER_ID, cleanup.signal);
    expect(removed).toBe(true);
  });

  it("retries one transient cleanup failure and resolves only after confirmed absence", async () => {
    let configuration: Record<string, unknown> | undefined;
    let removeCalls = 0;
    let removed = false;
    const api = {
      createContainer: vi.fn(async (_name: string, input: Record<string, unknown>) => {
        configuration = structuredClone(input);
        return CONTAINER_ID;
      }),
      inspectContainer: vi.fn(async () => {
        if (removed || configuration === undefined) {
          return null;
        }
        return {
          Id: CONTAINER_ID,
          Name: `/flow-command-${"b".repeat(32)}`,
          Image: descriptor().imageId,
          Config: configuration,
          HostConfig: configuration.HostConfig,
        };
      }),
      stopContainer: vi.fn(async () => undefined),
      removeContainer: vi.fn(async () => {
        removeCalls += 1;
        if (removeCalls === 1) {
          throw new Error("PRIVATE_TRANSIENT_REMOVE");
        }
        removed = true;
      }),
    };
    const cleanupSignals = [new AbortController(), new AbortController()];
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => descriptor(),
      createApi: () => api,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory: async () => "/private/docker-config",
      removePrivateDirectory: async () => undefined,
      createCleanupSignal: vi
        .fn()
        .mockReturnValueOnce(cleanupSignals[0]?.signal)
        .mockReturnValueOnce(cleanupSignals[1]?.signal),
    });
    const lease = await engine.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace/run-1",
      protectedPaths: [],
      workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
    });

    await lease.release();

    expect(api.stopContainer).toHaveBeenCalledTimes(2);
    expect(api.removeContainer).toHaveBeenCalledTimes(2);
    expect(api.inspectContainer).toHaveBeenCalledTimes(3);
    expect(api.removeContainer).toHaveBeenNthCalledWith(1, CONTAINER_ID, cleanupSignals[0]?.signal);
    expect(api.removeContainer).toHaveBeenNthCalledWith(2, CONTAINER_ID, cleanupSignals[1]?.signal);
    expect(removed).toBe(true);
  });

  it("validates the complete Docker configuration before creating private state", async () => {
    const createPrivateDirectory = vi.fn(async () => "/private/docker-config");
    const createApi = vi.fn(() => ({
      createContainer: vi.fn(),
      inspectContainer: vi.fn(),
      stopContainer: vi.fn(),
      removeContainer: vi.fn(),
    }));
    const engine = new LocalDockerContainerCommandEngine({
      resolveDescriptor: async () => ({
        ...descriptor(),
        seccompProfile: { oversized: "x".repeat(1_048_576) },
      }),
      createApi,
      createNonce: () => "b".repeat(32),
      createPrivateDirectory,
      removePrivateDirectory: async () => undefined,
    });

    await expect(
      engine.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace",
        protectedPaths: [],
        workspaceSnapshotDigest: WORKSPACE_SNAPSHOT_DIGEST,
      }),
    ).rejects.toThrow("seccomp profile exceeds its byte limit");
    expect(createApi).not.toHaveBeenCalled();
    expect(createPrivateDirectory).not.toHaveBeenCalled();
  });
});

function descriptor(): LocalDockerContainerCommandRuntimeDescriptor {
  return {
    engineVersion: "28.3.3",
    apiVersion: "1.51",
    socketPath: "/var/run/docker.sock",
    dockerExecutable: "/usr/bin/docker",
    imageId: `sha256:${"d".repeat(64)}`,
    runtimeName: "flow-prime-runc",
    policyDigest: "a".repeat(64),
    seccompProfile: {},
    user: { uid: 1000, gid: 1000 },
    limits: {
      stopGraceMs: 5_000,
      pidsMax: 64,
      memoryMaxBytes: 1_073_741_824,
      memorySwapMaxBytes: 0,
      cpuQuotaMicros: 100_000,
      cpuPeriodMicros: 100_000,
      openFilesMax: 1_024,
      fileSizeMaxBytes: 33_554_432,
      coreSizeMaxBytes: 0,
      temporaryBytes: 67_108_864,
      temporaryInodes: 4_096,
    },
    assertCurrent: async () => undefined,
  };
}

function mergeDockerImageEnvironment(
  submitted: readonly string[],
  image: readonly string[],
): readonly string[] {
  const submittedNames = new Set(submitted.map((entry) => entry.slice(0, entry.indexOf("="))));
  return [
    ...submitted,
    ...image.filter((entry) => !submittedNames.has(entry.slice(0, entry.indexOf("=")))),
  ];
}

function ownedOrphan(overrides: { readonly policyDigest?: string } = {}) {
  const configuration = { Image: descriptor().imageId, HostConfig: {} };
  return parseContainerCommandIntent({
    version: 1,
    state: "owned",
    ownerNonce: "e".repeat(64),
    containerName: `flow-command-${"f".repeat(32)}`,
    owner: {
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: 1234,
      startTicks: "987654",
    },
    runtime: {
      engineVersion: descriptor().engineVersion,
      apiVersion: descriptor().apiVersion,
      socketPath: descriptor().socketPath,
      imageId: descriptor().imageId,
      runtimeName: descriptor().runtimeName,
      policyDigest: overrides.policyDigest ?? descriptor().policyDigest,
    },
    privateDirectory: "/private/orphan-docker-config",
    configuration,
    configurationDigest: calculateContainerCommandConfigurationDigest(configuration),
    containerId: "d".repeat(64),
  });
}

function recoveryEngine(
  api: ReturnType<LocalDockerContainerCommandEngineOptions["createApi"]>,
  claim: {
    readonly intent: ReturnType<typeof ownedOrphan>;
    release(): Promise<void>;
    complete(): Promise<void>;
  },
): LocalDockerContainerCommandEngine {
  return new LocalDockerContainerCommandEngine({
    resolveDescriptor: async () => descriptor(),
    createApi: () => api,
    createNonce: () => "b".repeat(32),
    createPrivateDirectory: async () => "/private/new-docker-config",
    removePrivateDirectory: async () => undefined,
    durability: {
      createOwnerNonce: () => "a".repeat(64),
      readProcessOwner: async () => ({
        bootId: "123e4567-e89b-42d3-a456-426614174000",
        pid: 9999,
        startTicks: "111111",
      }),
      isOwnerAlive: async () => false,
      store: {
        claimOrphans: async () => [claim],
        writeIntent: async () => undefined,
        writeOwned: async () => undefined,
        remove: async () => undefined,
      },
    },
  });
}
