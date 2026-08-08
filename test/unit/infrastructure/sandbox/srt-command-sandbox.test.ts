import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    expect(
      (prepared as typeof prepared & { readonly processContainment: string }).processContainment,
    ).toBe("process-group");
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

  it("advertises verified Linux PID-namespace containment", async () => {
    const manager = new FakeSrtManager();
    manager.descriptor = [
      "/bin/bash",
      "-c",
      quoteSrtArgs([
        "/usr/bin/bwrap",
        "--new-session",
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-user",
        "--cap-drop",
        "ALL",
        "--proc",
        "/proc",
        "--",
        "/bin/bash",
        "-c",
        "'/usr/bin/node' '-e' 'process.exit(0)'",
      ]),
    ];
    const prepared = await createSandbox(manager, { platform: "linux" }).prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    expect(
      (prepared as typeof prepared & { readonly processContainment: string }).processContainment,
    ).toBe("linux-pid-namespace");
    await prepared.release();
  });

  it.each([
    "/usr/bin/bwrap --new-session -- true",
    "bwrap --unshare-pid --die-with-parent -- true",
    "echo --unshare-pid --die-with-parent -- true",
    "/usr/bin/bwrap --new-session --unshare-pid --die-with-parent ; /workspace/escape -- true",
    "/usr/bin/bwrap --new-session --die-with-parent --setenv X --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /bin/bash -c true",
  ])(
    "rejects degraded Linux descriptor %s before returning spawn authority",
    async (descriptor) => {
      const manager = new FakeSrtManager();
      manager.descriptor = ["/bin/bash", "-c", descriptor];

      await expect(
        createSandbox(manager, { platform: "linux" }).prepare({
          executable: "node",
          args: [],
          cwd: workspace,
          protectedPaths: [],
        }),
      ).rejects.toThrow(/PID namespace|descendant containment/i);
    },
  );

  it("rejects a substituted outer Linux launcher before returning spawn authority", async () => {
    const manager = new FakeSrtManager();
    manager.descriptor = [
      "/workspace/escape",
      "-c",
      "/usr/bin/bwrap --new-session --unshare-pid --die-with-parent -- true",
    ];

    await expect(
      createSandbox(manager, { platform: "linux" }).prepare({
        executable: "node",
        args: [],
        cwd: workspace,
        protectedPaths: [],
      }),
    ).rejects.toThrow(/launch descriptor|PID namespace|descendant containment/i);
  });

  it("rejects a workspace-controlled bubblewrap executable from PATH", async () => {
    const temporaryWorkspace = await mkdtemp(join(tmpdir(), "flow-fake-bwrap-"));
    const fakeBwrap = join(temporaryWorkspace, "bwrap");
    await writeFile(fakeBwrap, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fakeBwrap, 0o755);
    const manager = new FakeSrtManager();
    const sandbox = new SrtCommandSandbox(manager, {
      backendVersion: "0.0.70",
      platform: "linux",
      environment: { PATH: temporaryWorkspace },
      homeDirectory: temporaryWorkspace,
      canonicalize: async (path) => path,
      createTemporaryDirectory: async () => join(temporaryWorkspace, "private-temp"),
      removeTemporaryDirectory: async () => undefined,
      cleanupTimeoutMs: 100,
    });

    try {
      await expect(
        sandbox.prepare({
          executable: "node",
          args: [],
          cwd: temporaryWorkspace,
          protectedPaths: [],
        }),
      ).rejects.toThrow(/trusted root-owned bubblewrap|outside the workspace/i);

      expect(manager.checkCalls).toBe(0);
      expect(manager.initializeCalls).toBe(0);
    } finally {
      await rm(temporaryWorkspace, { recursive: true, force: true });
    }
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

  it("shares one backend session across same-policy concurrent commands", async () => {
    const manager = new FakeSrtManager();
    const firstSandbox = createSandbox(manager);
    const secondSandbox = createSandbox(manager, { privateTemp: "/private/tmp/flow-command-two" });
    const first = await firstSandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    const second = await secondSandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    await first.release();
    expect(manager.initializeCalls).toBe(1);
    expect(manager.cleanupCalls).toBe(1);
    expect(manager.resetCalls).toBe(0);
    await second.release();

    expect(manager.cleanupCalls).toBe(2);
    expect(manager.resetCalls).toBe(1);
    expect(manager.customConfigs.map((config) => config?.filesystem.allowWrite)).toEqual([
      [workspace, privateTemp],
      [workspace, "/private/tmp/flow-command-two"],
    ]);
  });

  it("serializes a different concurrent workspace on the shared backend", async () => {
    const manager = new FakeSrtManager();
    const first = await createSandbox(manager).prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });

    let secondSettled = false;
    const secondPromise = createSandbox(manager, {
      privateTemp: "/private/tmp/flow-command-two",
    }).prepare({
      executable: "node",
      args: [],
      cwd: "/Users/alice/other-project",
      protectedPaths: [],
    });
    void secondPromise.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await waitForChecks(manager, 2);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(manager.initializeCalls).toBe(1);

    await first.release();
    const second = await secondPromise;
    expect(manager.initializeCalls).toBe(2);
    expect(manager.resetCalls).toBe(1);
    await second.release();
    expect(manager.resetCalls).toBe(2);
  });

  it("cancels a different-workspace command while it waits for the shared backend", async () => {
    const manager = new FakeSrtManager();
    const first = await createSandbox(manager).prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });
    const controller = new AbortController();
    const second = createSandbox(manager, {
      privateTemp: "/private/tmp/flow-command-two",
    }).prepare({
      executable: "node",
      args: [],
      cwd: "/Users/alice/other-project",
      protectedPaths: [],
      signal: controller.signal,
    });

    await waitForChecks(manager, 2);
    controller.abort("cancelled while queued");
    await expect(second).rejects.toThrow(/cancel/i);
    await first.release();
    expect(manager.initializeCalls).toBe(1);
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

  it("resets a partial initialization and permits a later clean session", async () => {
    const manager = new FakeSrtManager();
    manager.initializeError = new Error("initialization failed");
    const sandbox = createSandbox(manager);

    await expect(
      sandbox.prepare({ executable: "node", args: [], cwd: workspace, protectedPaths: [] }),
    ).rejects.toThrow("initialization failed");
    expect(manager.resetCalls).toBe(1);

    manager.initializeError = undefined;
    const prepared = await sandbox.prepare({
      executable: "node",
      args: [],
      cwd: workspace,
      protectedPaths: [],
    });
    await prepared.release();

    expect(manager.initializeCalls).toBe(2);
    expect(manager.resetCalls).toBe(2);
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

function quoteSrtArgs(values: readonly string[]): string {
  return values
    .map((value) =>
      /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(value)
        ? value
        : `'${value.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
}

function createSandbox(
  manager: FakeSrtManager,
  overrides: {
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
    readonly privateTemp?: string;
    readonly seccompApplyPath?: string;
    readonly canonicalize?: (path: string) => Promise<string>;
    readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
    readonly resolveTrustedBwrapPath?: (workspace: string) => Promise<string>;
  } = {},
): SrtCommandSandbox {
  const selectedPrivateTemp = overrides.privateTemp ?? privateTemp;
  const platform = overrides.platform ?? "darwin";
  return new SrtCommandSandbox(manager, {
    backendVersion: "0.0.70",
    platform,
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
    ...(platform === "linux"
      ? {
          resolveTrustedBwrapPath:
            overrides.resolveTrustedBwrapPath ?? (async () => "/usr/bin/bwrap"),
        }
      : {}),
    cleanupTimeoutMs: 100,
  });
}

async function waitForChecks(manager: FakeSrtManager, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && manager.checkCalls < expected; attempt += 1) {
    await Promise.resolve();
  }
  expect(manager.checkCalls).toBe(expected);
}

class FakeSrtManager implements SrtSandboxManager {
  dependencies = { errors: [] as string[], warnings: [] as string[] };
  initializedConfig: SrtRuntimeConfig | undefined;
  wrappedCommand: string | undefined;
  wrapCwd: string | undefined;
  wrapError: Error | undefined;
  initializeError: Error | undefined;
  cleanupError: Error | undefined;
  readonly customConfigs: Array<SrtRuntimeConfig | undefined> = [];
  checkCalls = 0;
  initializeCalls = 0;
  wrapCalls = 0;
  cleanupCalls = 0;
  resetCalls = 0;
  descriptor: readonly string[] = ["/bin/bash", "-c", "wrapped"];

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
    if (this.initializeError !== undefined) {
      throw this.initializeError;
    }
  }

  async wrapWithSandboxArgv(
    command: string,
    _binShell: string,
    customConfig: SrtRuntimeConfig | undefined,
    _signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<{ readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }> {
    this.wrapCalls += 1;
    this.customConfigs.push(customConfig);
    this.wrappedCommand = command;
    this.wrapCwd = cwd;
    if (this.wrapError !== undefined) {
      throw this.wrapError;
    }
    return {
      argv: this.descriptor,
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
