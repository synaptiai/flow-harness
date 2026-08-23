import { describe, expect, it, vi } from "vitest";

import {
  ACP_AGENT_SANDBOX_POLICY_DIGEST,
  ACP_AGENT_SANDBOX_PROFILE,
  SrtCommandSandbox,
  type SrtRuntimeConfig,
  type SrtSandboxManager,
} from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";

const projectRoot = "/Users/alice/project";
const attemptDirectory = "/private/tmp/flow-acp-attempt";
const backendTemp = "/private/tmp/flow-acp-backend";
const executable = "/opt/acp/opencode";

describe("SRT ACP agent sandbox", () => {
  it("builds one-provider containment without exposing an ambient credential", async () => {
    const manager = new FakeSrtManager();
    const sandbox = createSandbox(manager);

    const prepared = await sandbox.prepareAcpAgent({
      executable,
      args: ["--stdio"],
      cwd: attemptDirectory,
      projectRoot,
      protectedPaths: [`${projectRoot}/.flow`, `${projectRoot}/private-runs`],
      runtimeSupportPaths: [executable],
      providerDomain: "api.openai.com",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
    });

    expect(manager.initializedConfig).toMatchObject({
      network: {
        allowedDomains: ["api.openai.com"],
        deniedDomains: [],
        strictAllowlist: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        tlsTerminate: {},
      },
      credentials: {
        envVars: [
          {
            name: "OPENAI_API_KEY",
            mode: "mask",
            injectHosts: ["api.openai.com"],
          },
        ],
      },
    });
    expect(manager.initializedConfig?.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        "/Users/alice",
        projectRoot,
        `${projectRoot}/.flow`,
        `${projectRoot}/private-runs`,
      ]),
    );
    expect(manager.initializedConfig?.filesystem.allowRead).toEqual(
      expect.arrayContaining([attemptDirectory, backendTemp, executable]),
    );
    expect(manager.initializedConfig?.filesystem.allowWrite).toEqual([
      attemptDirectory,
      backendTemp,
    ]);
    expect(manager.initializedConfig?.filesystem.denyWrite).toEqual(
      expect.arrayContaining([projectRoot, executable]),
    );
    expect(prepared.launch.env).toEqual({
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      TMPDIR: backendTemp,
      TMP: backendTemp,
      TEMP: backendTemp,
    });
    expect(JSON.stringify(prepared.launch)).not.toContain("selected-secret");
    expect(JSON.stringify(prepared.launch)).not.toContain("ambient-secret");
    expect(prepared.evidence).toEqual({
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      profile: ACP_AGENT_SANDBOX_PROFILE,
      policyDigest: ACP_AGENT_SANDBOX_POLICY_DIGEST,
    });

    await prepared.release();
    expect(manager.cleanupCalls).toBe(1);
    expect(manager.resetCalls).toBe(1);
  });

  it("rejects a missing selected credential before acquiring global sandbox state", async () => {
    const manager = new FakeSrtManager();
    const sandbox = createSandbox(manager, { OPENAI_API_KEY: undefined });

    await expect(
      sandbox.prepareAcpAgent({
        executable,
        args: [],
        cwd: attemptDirectory,
        projectRoot,
        protectedPaths: [],
        runtimeSupportPaths: [executable],
        providerDomain: "api.openai.com",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
      }),
    ).rejects.toThrow("selected ACP provider credential is unavailable");

    expect(manager.checkCalls).toBe(0);
    expect(manager.initializeCalls).toBe(0);
  });

  it.each([
    {
      label: "attempt directory inside the Flow project",
      cwd: `${projectRoot}/.flow/acp-attempt`,
      runtimeSupportPaths: [executable],
      message: /attempt directory must be private/i,
    },
    {
      label: "runtime closure inside the Flow project",
      cwd: attemptDirectory,
      runtimeSupportPaths: [`${projectRoot}/node_modules/acp-agent`],
      message: /runtime support must be outside/i,
    },
  ])("rejects $label before launch", async ({ cwd, runtimeSupportPaths, message }) => {
    const manager = new FakeSrtManager();
    const sandbox = createSandbox(manager);

    await expect(
      sandbox.prepareAcpAgent({
        executable,
        args: [],
        cwd,
        projectRoot,
        protectedPaths: [],
        runtimeSupportPaths,
        providerDomain: "api.openai.com",
        credentialEnvironmentVariable: "OPENAI_API_KEY",
      }),
    ).rejects.toThrow(message);

    expect(manager.initializeCalls).toBe(0);
    expect(manager.wrapCalls).toBe(0);
  });

  it("serializes ACP behind an active command on the same manager coordinator", async () => {
    const manager = new FakeSrtManager();
    const sandbox = createSandbox(manager);
    const command = await sandbox.prepare({
      executable: "/usr/bin/node",
      args: [],
      cwd: projectRoot,
      protectedPaths: [],
    });

    let acpSettled = false;
    const acpPromise = sandbox.prepareAcpAgent({
      executable,
      args: [],
      cwd: attemptDirectory,
      projectRoot,
      protectedPaths: [],
      runtimeSupportPaths: [executable],
      providerDomain: "api.openai.com",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
    });
    void acpPromise.finally(() => {
      acpSettled = true;
    });
    await waitForChecks(manager, 2);
    await Promise.resolve();

    expect(acpSettled).toBe(false);
    expect(manager.initializeCalls).toBe(1);

    await command.release();
    const acp = await acpPromise;
    expect(manager.initializeCalls).toBe(2);
    expect(manager.resetCalls).toBe(1);
    await acp.release();
    expect(manager.resetCalls).toBe(2);
  });
});

function createSandbox(
  manager: FakeSrtManager,
  environmentOverrides: Readonly<Record<string, string | undefined>> = {},
): SrtCommandSandbox {
  return new SrtCommandSandbox(manager, {
    backendVersion: "0.0.70",
    platform: "darwin",
    environment: {
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "selected-secret",
      ANTHROPIC_API_KEY: "ambient-secret",
      NODE_OPTIONS: "--require=must-not-load",
      HTTP_PROXY: "http://credential@proxy.invalid",
      ...environmentOverrides,
    },
    homeDirectory: "/Users/alice",
    canonicalize: async (path) => path,
    createTemporaryDirectory: async () => backendTemp,
    removeTemporaryDirectory: vi.fn(async () => undefined),
    discoverPrivateWorkspaceCollections: async () => [],
    discoverPrivateWorkspaceCollectionAncestors: async () => [],
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
  readonly dependencies = { errors: [] as string[], warnings: [] as string[] };
  initializedConfig: SrtRuntimeConfig | undefined;
  checkCalls = 0;
  initializeCalls = 0;
  wrapCalls = 0;
  cleanupCalls = 0;
  resetCalls = 0;

  checkDependencies() {
    this.checkCalls += 1;
    return this.dependencies;
  }

  async initialize(config: SrtRuntimeConfig): Promise<void> {
    this.initializeCalls += 1;
    this.initializedConfig = config;
  }

  async wrapWithSandboxArgv(
    _command: string,
    _binShell: string,
    _customConfig: SrtRuntimeConfig | undefined,
    _signal: AbortSignal | undefined,
    _cwd: string,
  ): Promise<{ readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv }> {
    this.wrapCalls += 1;
    return { argv: ["/bin/bash", "-c", "wrapped"], env: {} };
  }

  cleanupAfterCommand(): void {
    this.cleanupCalls += 1;
  }

  async reset(): Promise<void> {
    this.resetCalls += 1;
  }
}
