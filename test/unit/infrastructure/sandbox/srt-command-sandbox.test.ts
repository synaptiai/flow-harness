import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FLOW_SANDBOX_PROFILE,
  SrtCommandSandbox,
  type SrtRuntimeConfig,
  type SrtSandboxManager,
} from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";

const workspace = "/Users/alice/project";
const protectedRunStore = "/Users/alice/project/custom-runs";
const privateTemp = "/private/tmp/flow-command-private";
const seccompApplyPath = "/Users/alice/flow-runtime/vendor/seccomp/x64/apply-seccomp";

describe("SrtCommandSandbox", () => {
  it("builds the fixed fail-closed profile and removes ambient credentials", async () => {
    const manager = new FakeSrtManager();
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    const sandbox = createSandbox(manager, { removeTemporaryDirectory });

    const prepared = await sandbox.prepare({
      executable: "/usr/bin/node",
      args: ["-e", "process.exit(0)", "$(printf injected)"],
      cwd: workspace,
      protectedPaths: [protectedRunStore],
    });

    expect(manager.initializedConfig).toEqual({
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        denyRead: ["/Users/alice"],
        allowRead: [workspace, privateTemp, seccompApplyPath],
        allowWrite: [workspace, privateTemp],
        denyWrite: [
          protectedRunStore,
          join(workspace, ".flow"),
          join(workspace, ".git"),
          join(workspace, ".env"),
          join(workspace, ".env.*"),
          join(workspace, "**/*.pem"),
          join(workspace, "**/*.key"),
        ],
        allowGitConfig: false,
      },
      allowAppleEvents: false,
      allowPty: false,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      seccomp: { applyPath: seccompApplyPath },
    });
    expect(manager.wrappedCommand).toBe(
      "'/usr/bin/node' '-e' 'process.exit(0)' '$(printf injected)'",
    );
    expect(manager.wrapCwd).toBe(workspace);
    expect(prepared.launch).toEqual({
      executable: "/bin/bash",
      args: ["-c", "wrapped"],
      env: {
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        CI: "true",
        TMPDIR: privateTemp,
        TMP: privateTemp,
        TEMP: privateTemp,
      },
    });
    expect(prepared.evidence).toEqual({
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      profile: FLOW_SANDBOX_PROFILE,
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await prepared.release();
    await prepared.release();

    expect(manager.cleanupCalls).toBe(1);
    expect(manager.resetCalls).toBe(1);
    expect(removeTemporaryDirectory).toHaveBeenCalledTimes(1);
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(privateTemp);
  });

  it.each([
    { errors: ["bubblewrap not installed"], warnings: [] },
    { errors: [], warnings: ["seccomp not available - unix socket access not restricted"] },
  ])(
    "fails before initialization for dependency result $errors $warnings",
    async (dependencies) => {
      const manager = new FakeSrtManager();
      manager.dependencies = dependencies;
      const sandbox = createSandbox(manager);

      await expect(
        sandbox.prepare({ executable: "node", args: [], cwd: workspace, protectedPaths: [] }),
      ).rejects.toThrow(dependencies.errors[0] ?? dependencies.warnings[0]);

      expect(manager.initializeCalls).toBe(0);
      expect(manager.wrapCalls).toBe(0);
    },
  );

  it("fails closed on unsupported Flow platforms even if the backend supports them", async () => {
    const manager = new FakeSrtManager();
    const sandbox = createSandbox(manager, { platform: "win32" });

    await expect(
      sandbox.prepare({ executable: "node", args: [], cwd: workspace, protectedPaths: [] }),
    ).rejects.toThrow("command sandbox is not supported on win32");

    expect(manager.checkCalls).toBe(0);
    expect(manager.initializeCalls).toBe(0);
  });

  it("rejects concurrent preparation across adapters sharing a process-global backend", async () => {
    const manager = new FakeSrtManager();
    const firstSandbox = createSandbox(manager);
    const secondSandbox = createSandbox(manager, { privateTemp: "/private/tmp/flow-command-two" });
    const first = await firstSandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    await expect(
      secondSandbox.prepare({ executable: "node", args: [], cwd: workspace, protectedPaths: [] }),
    ).rejects.toThrow("already active");

    await first.release();
    const second = await secondSandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });
    await second.release();
  });

  it("cleans partial state when initialization or wrapping fails", async () => {
    const manager = new FakeSrtManager();
    manager.wrapError = new Error("wrapper failed");
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    const sandbox = createSandbox(manager, { removeTemporaryDirectory });

    await expect(
      sandbox.prepare({ executable: "node", args: [], cwd: workspace, protectedPaths: [] }),
    ).rejects.toThrow("wrapper failed");

    expect(manager.cleanupCalls).toBe(0);
    expect(manager.resetCalls).toBe(1);
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(privateTemp);
  });

  it("attempts every cleanup step and reports release failure", async () => {
    const manager = new FakeSrtManager();
    manager.cleanupError = new Error("per-command cleanup failed");
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    const sandbox = createSandbox(manager, { removeTemporaryDirectory });
    const prepared = await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    await expect(prepared.release()).rejects.toThrow("per-command cleanup failed");

    expect(manager.cleanupCalls).toBe(1);
    expect(manager.resetCalls).toBe(1);
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(privateTemp);

    await expect(
      createSandbox(manager).prepare({
        executable: "node",
        args: [],
        cwd: workspace,
        protectedPaths: [],
      }),
    ).rejects.toThrow("unavailable after cleanup failure");
    expect(manager.checkCalls).toBe(1);
  });

  it("produces one policy digest across machine-specific paths", async () => {
    const first = createSandbox(new FakeSrtManager());
    const second = createSandbox(new FakeSrtManager(), {
      homeDirectory: "/home/other",
      privateTemp: "/tmp/different",
      canonicalize: async (path) => path.replace("/Users/alice", "/home/other"),
    });

    const firstPrepared = await first.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [protectedRunStore],
    });
    const secondPrepared = await second.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [protectedRunStore],
    });

    expect(firstPrepared.evidence.policyDigest).toBe(secondPrepared.evidence.policyDigest);
    await firstPrepared.release();
    await secondPrepared.release();
  });

  it("avoids a redundant runtime bind when the helper is already inside the workspace", async () => {
    const manager = new FakeSrtManager();
    const nestedSeccompPath = join(workspace, "..runtime", "apply-seccomp");
    const sandbox = createSandbox(manager, { seccompApplyPath: nestedSeccompPath });

    const prepared = await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    expect(manager.initializedConfig?.filesystem.allowRead).toEqual([workspace, privateTemp]);
    expect(manager.initializedConfig?.seccomp).toEqual({ applyPath: nestedSeccompPath });
    await prepared.release();
  });
});

function createSandbox(
  manager: FakeSrtManager,
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
    readonly privateTemp?: string;
    readonly seccompApplyPath?: string;
    readonly canonicalize?: (path: string) => Promise<string>;
    readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
  } = {},
): SrtCommandSandbox {
  const selectedPrivateTemp = overrides.privateTemp ?? privateTemp;
  return new SrtCommandSandbox(manager, {
    backendVersion: "0.0.70",
    platform: overrides.platform ?? "darwin",
    environment: {
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      CI: "true",
      FLOW_TEST_SECRET: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--require=must-not-load",
      HTTP_PROXY: "http://credential@proxy.invalid",
    },
    homeDirectory: overrides.homeDirectory ?? "/Users/alice",
    canonicalize: overrides.canonicalize ?? (async (path) => path),
    createTemporaryDirectory: async () => selectedPrivateTemp,
    seccompApplyPath: overrides.seccompApplyPath ?? seccompApplyPath,
    removeTemporaryDirectory: overrides.removeTemporaryDirectory ?? (async () => undefined),
    cleanupTimeoutMs: 100,
  });
}

class FakeSrtManager implements SrtSandboxManager {
  dependencies = { errors: [] as string[], warnings: [] as string[] };
  initializedConfig: SrtRuntimeConfig | undefined;
  wrappedCommand: string | undefined;
  wrapCwd: string | undefined;
  wrapError: Error | undefined;
  cleanupError: Error | undefined;
  checkCalls = 0;
  initializeCalls = 0;
  wrapCalls = 0;
  cleanupCalls = 0;
  resetCalls = 0;

  checkDependencies(): {
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } {
    this.checkCalls += 1;
    return this.dependencies;
  }

  async initialize(config: SrtRuntimeConfig): Promise<void> {
    this.initializeCalls += 1;
    this.initializedConfig = config;
  }

  async wrapWithSandboxArgv(
    command: string,
    _binShell: string,
    _customConfig: undefined,
    _signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<{ readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }> {
    this.wrapCalls += 1;
    this.wrappedCommand = command;
    this.wrapCwd = cwd;
    if (this.wrapError !== undefined) {
      throw this.wrapError;
    }
    return {
      argv: ["/bin/bash", "-c", "wrapped"],
      env: { FLOW_TEST_SECRET: "backend-must-not-leak" },
    };
  }

  cleanupAfterCommand(): void {
    this.cleanupCalls += 1;
    if (this.cleanupError !== undefined) {
      throw this.cleanupError;
    }
  }

  async reset(): Promise<void> {
    this.resetCalls += 1;
  }
}
