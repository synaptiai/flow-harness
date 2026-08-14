import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  discoverContainerWorkspaceProtection,
  LocalContainerCommandSandbox,
  type LocalContainerCommandSandboxEngine,
} from "../../../../src/infrastructure/oci/local-container-command-sandbox.js";

describe("LocalContainerCommandSandbox", () => {
  it("passes the exact executable, argument vector, and canonical working directory without a shell", async () => {
    const release = vi.fn(async () => undefined);
    const beforeLaunch = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const observeWorkspaceSnapshot = vi.fn(async () => "c".repeat(64));
    const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>(async () => ({
      launch: {
        executable: "/usr/bin/flow-container-command",
        args: ["--lease", "lease-1"],
        env: { FLOW_CONTAINER_LEASE: "lease-1" },
      },
      identity: {
        backendVersion: "28.3.3",
        policyDigest: "a".repeat(64),
      },
      beforeLaunch,
      run,
      release,
    }));
    const sandbox = new LocalContainerCommandSandbox(
      { prepare },
      {
        platform: "linux",
        canonicalize: async (path) => (path.startsWith("/canonical/") ? path : `/canonical${path}`),
        discoverWorkspaceProtection: async () => ({
          maskedPaths: ["/canonical/workspace/.env"],
          readOnlyPaths: ["/canonical/workspace/.git"],
        }),
        observeWorkspaceSnapshot,
      },
    );
    const args = ["-e", "console.log('a; $(touch /tmp/forbidden)')"];

    const prepared = await sandbox.prepare({
      executable: "node",
      args,
      cwd: "/workspace",
      projectRoot: "/project",
      protectedPaths: ["/project/.flow"],
      runtimeSupportPaths: ["/runtime/node_modules"],
      runtimeEnvironment: { NODE_PATH: "/runtime/node_modules" },
    });

    expect(prepare).toHaveBeenCalledWith({
      executable: "node",
      args,
      cwd: "/canonical/workspace",
      projectRoot: "/canonical/project",
      protectedPaths: ["/canonical/project/.flow", "/canonical/workspace/.env"],
      readOnlyPaths: ["/canonical/workspace/.git"],
      workspaceSnapshotDigest: "c".repeat(64),
      runtimeSupportPaths: ["/canonical/runtime/node_modules"],
      runtimeEnvironment: { NODE_PATH: "/canonical/runtime/node_modules" },
    });
    expect(prepared).toMatchObject({
      processContainment: "linux-pid-namespace",
      launch: {
        executable: "/usr/bin/flow-container-command",
        args: ["--lease", "lease-1"],
        env: { FLOW_CONTAINER_LEASE: "lease-1" },
      },
      evidence: {
        backend: "docker-engine",
        backendVersion: "28.3.3",
        profile: "flow-container-v1",
        policyDigest: "a".repeat(64),
      },
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.launch)).toBe(true);
    expect(Object.isFrozen(prepared.launch.args)).toBe(true);
    expect(Object.isFrozen(prepared.evidence)).toBe(true);

    await prepared.beforeLaunch?.();
    expect(beforeLaunch).toHaveBeenCalledTimes(1);
    expect(observeWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    expect(observeWorkspaceSnapshot).toHaveBeenCalledWith({
      workspace: "/canonical/workspace",
      excludedPaths: ["/canonical/workspace/.env"],
      signal: undefined,
    });
    await expect(
      prepared.run?.({
        signal: AbortSignal.timeout(1_000),
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    await prepared.release();
    await prepared.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("protects project Flow state even when the caller supplies no protected paths", async () => {
    const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>(async () => ({
      launch: { executable: "/usr/bin/flow-container-command", args: [], env: {} },
      identity: { backendVersion: "28.3.3", policyDigest: "a".repeat(64) },
      release: async () => undefined,
    }));
    const sandbox = new LocalContainerCommandSandbox(
      { prepare },
      {
        platform: "linux",
        canonicalize: async (path) => `/canonical${path}`,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot: stableWorkspaceSnapshot,
      },
    );

    await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: "/project",
      projectRoot: "/project",
      protectedPaths: [],
    });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/canonical/project",
        projectRoot: "/canonical/project",
        protectedPaths: ["/canonical/project/.flow"],
      }),
    );
  });

  it("rejects a workspace that contains the configured project root", async () => {
    const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>();
    const sandbox = new LocalContainerCommandSandbox(
      { prepare },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot: stableWorkspaceSnapshot,
      },
    );

    await expect(
      sandbox.prepare({
        executable: "node",
        args: [],
        cwd: "/work",
        projectRoot: "/work/project",
        protectedPaths: [],
      }),
    ).rejects.toThrow("workspace must not contain the configured Flow project root");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails before engine preparation outside Linux", async () => {
    const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>();
    const sandbox = new LocalContainerCommandSandbox(
      { prepare },
      {
        platform: "darwin",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
      },
    );

    await expect(
      sandbox.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace",
        protectedPaths: [],
      }),
    ).rejects.toThrow("container command sandbox is supported only on Linux");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("settles an acquired engine lease when its public identity is invalid", async () => {
    const privateCause = new Error("PRIVATE_CONTAINER_CLEANUP");
    const release = vi.fn(async () => {
      throw privateCause;
    });
    const sandbox = new LocalContainerCommandSandbox(
      {
        async prepare() {
          return {
            launch: { executable: "/usr/bin/launcher", args: [], env: {} },
            identity: { backendVersion: "", policyDigest: "invalid" },
            release,
          };
        },
      },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot: stableWorkspaceSnapshot,
      },
    );

    await expect(
      sandbox.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace",
        protectedPaths: [],
      }),
    ).rejects.toThrow("Container command sandbox preparation and cleanup failed");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      privateCanary: "PRIVATE_WORKSPACE_PATH",
      expectedStage: "inspect workspace paths",
      request: {},
      options: {
        canonicalize: async () => {
          throw new Error("ENOENT realpath '/srv/PRIVATE_WORKSPACE_PATH'");
        },
        discoverWorkspaceProtection: emptyWorkspaceProtection,
      },
    },
    {
      privateCanary: "PRIVATE_PROTECTION_PATH",
      expectedStage: "inspect workspace protection",
      request: {},
      options: {
        canonicalize: async (path: string) => path,
        discoverWorkspaceProtection: async () => {
          throw new Error("EACCES readdir '/srv/PRIVATE_PROTECTION_PATH'");
        },
      },
    },
    {
      privateCanary: "PRIVATE_RUNTIME_PATH",
      expectedStage: "inspect runtime support",
      request: { runtimeSupportPaths: ["/srv/PRIVATE_RUNTIME_PATH"] },
      options: {
        canonicalize: async (path: string) => {
          if (path.includes("PRIVATE_RUNTIME_PATH")) {
            throw new Error("ENOENT realpath '/srv/PRIVATE_RUNTIME_PATH'");
          }
          return path;
        },
        discoverWorkspaceProtection: emptyWorkspaceProtection,
      },
    },
  ])(
    "keeps private host paths nested during $expectedStage",
    async ({ privateCanary, expectedStage, request, options }) => {
      const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>();
      const sandbox = new LocalContainerCommandSandbox(
        { prepare },
        {
          platform: "linux",
          ...options,
          observeWorkspaceSnapshot: stableWorkspaceSnapshot,
        },
      );

      const error = await sandbox
        .prepare({
          executable: "node",
          args: [],
          cwd: "/workspace",
          protectedPaths: [],
          ...request,
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `Container command sandbox inspection failed during ${expectedStage}`,
      );
      expect((error as Error).message).not.toContain(privateCanary);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("keeps a private engine preparation cause nested", async () => {
    const sandbox = new LocalContainerCommandSandbox(
      {
        prepare: async () => {
          throw new Error("Docker socket /srv/PRIVATE_DOCKER_SOCKET is unavailable");
        },
      },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot: stableWorkspaceSnapshot,
      },
    );

    const error = await sandbox
      .prepare({ executable: "node", args: [], cwd: "/workspace", protectedPaths: [] })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Container command sandbox inspection failed during prepare command container",
    );
    expect((error as Error).message).not.toContain("PRIVATE_DOCKER_SOCKET");
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("keeps a private engine currentness cause nested before launch", async () => {
    const release = vi.fn(async () => undefined);
    const sandbox = new LocalContainerCommandSandbox(
      {
        prepare: async () => ({
          launch: { executable: "/usr/bin/docker", args: [], env: {} },
          identity: { backendVersion: "28.3.3", policyDigest: "c".repeat(64) },
          beforeLaunch: async () => {
            throw new Error("Docker path /srv/PRIVATE_RUNTIME_PATH changed");
          },
          release,
        }),
      },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot: stableWorkspaceSnapshot,
      },
    );
    const prepared = await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace",
      protectedPaths: [],
    });

    const error = await prepared.beforeLaunch?.().catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Container command sandbox inspection failed during validate command container before launch",
    );
    expect((error as Error).message).not.toContain("PRIVATE_RUNTIME_PATH");
    expect((error as Error).cause).toBeInstanceOf(Error);
    await prepared.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("discovers credential, private-state, and read-only Git paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-workspace-protection-"));
    try {
      await Promise.all([
        mkdir(join(workspace, ".git")),
        mkdir(join(workspace, ".flow")),
        mkdir(join(workspace, "nested", ".private.flow-workspaces"), { recursive: true }),
        mkdir(join(workspace, "nested", "keys"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(workspace, ".env"), "PRIVATE_ENV_CANARY\n", "utf8"),
        writeFile(
          join(workspace, "nested", "keys", "provider.pem"),
          "PRIVATE_KEY_CANARY\n",
          "utf8",
        ),
        writeFile(join(workspace, "nested", "ordinary.txt"), "public\n", "utf8"),
      ]);

      const protection = await discoverContainerWorkspaceProtection(workspace);

      expect(protection).toEqual({
        maskedPaths: [
          join(workspace, ".env"),
          join(workspace, ".flow"),
          join(workspace, "nested", ".private.flow-workspaces"),
          join(workspace, "nested", "keys", "provider.pem"),
        ],
        readOnlyPaths: [join(workspace, ".git")],
      });
      expect(protection.maskedPaths).not.toContain(join(workspace, "nested", "ordinary.txt"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when sensitive-workspace discovery exceeds its entry bound", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-workspace-bound-"));
    try {
      await Promise.all([
        writeFile(join(workspace, "one.txt"), "one\n", "utf8"),
        writeFile(join(workspace, "two.txt"), "two\n", "utf8"),
      ]);

      await expect(
        discoverContainerWorkspaceProtection(workspace, { maxEntries: 1 }),
      ).rejects.toThrow("workspace protection scan exceeds its entry limit");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps Git metadata readable for directories and files while masking Git symlinks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-workspace-git-"));
    try {
      await mkdir(join(workspace, "nested"));
      await writeFile(join(workspace, ".git"), "gitdir: /outside/repository\n", "utf8");
      await symlink("/outside/repository", join(workspace, "nested", ".git"));

      await expect(discoverContainerWorkspaceProtection(workspace)).resolves.toEqual({
        maskedPaths: [join(workspace, "nested", ".git")],
        readOnlyPaths: [join(workspace, ".git")],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies one combined bound to masked and read-only workspace protections", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-workspace-path-bound-"));
    try {
      await mkdir(join(workspace, ".git"));
      await writeFile(join(workspace, ".env"), "PRIVATE_ENV_CANARY\n", "utf8");

      await expect(
        discoverContainerWorkspaceProtection(workspace, { maxProtectionPaths: 1 }),
      ).rejects.toThrow("workspace protection scan exceeds its path limit");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when workspace discovery exceeds its depth or retained-byte bound", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flow-container-workspace-scan-bounds-"));
    try {
      await mkdir(join(workspace, "nested"));
      await writeFile(join(workspace, ".env"), "PRIVATE_ENV_CANARY\n", "utf8");

      await expect(
        discoverContainerWorkspaceProtection(workspace, { maxDepth: 0 }),
      ).rejects.toThrow("workspace protection scan exceeds its depth limit");
      await expect(
        discoverContainerWorkspaceProtection(workspace, {
          maxProtectionBytes: Buffer.byteLength(join(workspace, ".env"), "utf8") - 1,
        }),
      ).rejects.toThrow("workspace protection scan exceeds its path byte limit");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves exact cancellation during discovery and starts no engine preparation", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_DISCOVERY_CANCELLED");
    const prepare = vi.fn<LocalContainerCommandSandboxEngine["prepare"]>();
    const discoverWorkspaceProtection = vi.fn(async (_workspace, limits) => {
      expect(limits?.signal).toBe(controller.signal);
      controller.abort(reason);
      return emptyWorkspaceProtection();
    });
    const sandbox = new LocalContainerCommandSandbox(
      { prepare },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection,
      },
    );

    await expect(
      sandbox.prepare({
        executable: "node",
        args: [],
        cwd: "/workspace",
        protectedPaths: [],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("preserves exact cancellation inside the production workspace scanner", async () => {
    const controller = new AbortController();
    const reason = new Error("PRIVATE_SCANNER_CANCELLED");
    controller.abort(reason);

    await expect(
      discoverContainerWorkspaceProtection("/workspace", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("rejects workspace snapshot drift before delegating launch authority", async () => {
    const engineBeforeLaunch = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const observeWorkspaceSnapshot = vi
      .fn()
      .mockResolvedValueOnce("a".repeat(64))
      .mockResolvedValueOnce("b".repeat(64));
    const sandbox = new LocalContainerCommandSandbox(
      {
        prepare: async () => ({
          launch: { executable: "/usr/bin/docker", args: [], env: {} },
          identity: { backendVersion: "28.3.3", policyDigest: "c".repeat(64) },
          beforeLaunch: engineBeforeLaunch,
          release,
        }),
      },
      {
        platform: "linux",
        canonicalize: async (path) => path,
        discoverWorkspaceProtection: emptyWorkspaceProtection,
        observeWorkspaceSnapshot,
      },
    );
    const prepared = await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: "/workspace",
      protectedPaths: [],
    });

    await expect(prepared.beforeLaunch?.()).rejects.toThrow(
      "container command workspace changed before launch",
    );
    expect(engineBeforeLaunch).not.toHaveBeenCalled();
  });
});

async function emptyWorkspaceProtection() {
  return { maskedPaths: Object.freeze([]), readOnlyPaths: Object.freeze([]) };
}

async function stableWorkspaceSnapshot() {
  return "c".repeat(64);
}
