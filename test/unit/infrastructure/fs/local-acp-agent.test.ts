import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_ACP_AGENT_EXECUTABLE_BYTES } from "../../../../src/domain/capability/acp-agent.js";
import {
  admitLocalAcpAgentRuntime,
  assertLocalAcpAgentRuntimeCurrent,
  LocalAcpAgentAdmissionError,
} from "../../../../src/infrastructure/fs/local-acp-agent.js";
import {
  ArtifactObservations,
  readTrustedPackageClosure,
} from "../../../../src/infrastructure/pi/native-pi-harness-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local ACP agent admission", () => {
  it("admits an unchanged binary as one stable immutable runtime", async () => {
    const fixture = await binaryFixture();

    const first = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/opencode.json",
    });
    const second = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/opencode.json",
    });

    expect(second.snapshot).toEqual(first.snapshot);
    expect(first.snapshot.launch).toMatchObject({
      kind: "binary",
      executable: {
        path: fixture.executable,
        sha256: fixture.executableSha256,
        bytes: Buffer.byteLength(BINARY_CONTENT),
        device: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
        inode: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
      },
    });
    await expect(first.assertCurrent()).resolves.toBeUndefined();
  });

  it("rejects a missing, linked, special, or oversized executable", async () => {
    const fixture = await binaryFixture();
    const missing = join(fixture.root, "missing-agent");
    const linked = join(fixture.root, "linked-agent");
    const special = join(fixture.root, "special-agent");
    const oversized = join(fixture.root, "oversized-agent");
    await symlink(fixture.executable, linked);
    await mkdir(special);
    await writeFile(oversized, "x", "utf8");
    await truncate(oversized, MAX_ACP_AGENT_EXECUTABLE_BYTES + 1);
    await chmod(oversized, 0o755);

    for (const executable of [missing, linked, special, oversized]) {
      await writeBinaryManifest(fixture.manifestPath, executable, "a".repeat(64));
      await expect(
        admitLocalAcpAgentRuntime({
          manifestPath: fixture.manifestPath,
          provenance: ".flow/acp-agents/opencode.json",
        }),
      ).rejects.toThrow(/^local ACP agent admission failed$/);
    }
  });

  it("rejects a non-executable file and declared content mismatch", async () => {
    const fixture = await binaryFixture();
    await chmod(fixture.executable, 0o644);

    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/opencode.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);

    await chmod(fixture.executable, 0o755);
    await writeBinaryManifest(fixture.manifestPath, fixture.executable, "e".repeat(64));
    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/opencode.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);
  });

  it("detects replacement after binary admission", async () => {
    const fixture = await binaryFixture();
    const admitted = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/opencode.json",
    });
    await writeFile(fixture.executable, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(fixture.executable, 0o755);

    await expect(admitted.assertCurrent()).rejects.toThrow(
      /^local ACP agent identity changed after admission$/,
    );
  });

  it("reconstructs currentness from a durable snapshot for detached execution", async () => {
    const fixture = await binaryFixture();
    const admitted = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: "opencode.json",
    });

    await expect(
      assertLocalAcpAgentRuntimeCurrent(fixture.root, admitted.snapshot),
    ).resolves.toBeUndefined();

    await writeFile(fixture.manifestPath, "{}\n", "utf8");
    await expect(
      assertLocalAcpAgentRuntimeCurrent(fixture.root, admitted.snapshot),
    ).rejects.toThrow(/^local ACP agent identity changed after admission$/);
  });

  it("admits an exact Node executable and transitive package closure", async () => {
    const fixture = await nodePackageFixture();

    const admitted = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/codex-acp.json",
    });

    expect(admitted.snapshot.launch).toMatchObject({
      kind: "node-package",
      nodeExecutable: {
        path: fixture.nodeExecutable,
        sha256: fixture.nodeSha256,
      },
      nodeVersion: "v26.7.0",
      package: {
        root: fixture.packageRoot,
        resolutionRoot: fixture.root,
        name: "@zed-industries/codex-acp",
        version: "1.6.2",
        sha256: fixture.packageSha256,
        bytes: expect.any(Number),
        files: 2,
        device: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
        inode: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
        entrypoint: {
          path: "dist/cli.js",
          sha256: fixture.entrypointSha256,
          bytes: Buffer.byteLength(ENTRYPOINT_CONTENT),
        },
      },
    });
    await expect(admitted.assertCurrent()).resolves.toBeUndefined();
  });

  it("rejects linked package roots and linked package entries", async () => {
    const fixture = await nodePackageFixture();
    const linkedRoot = join(fixture.root, "linked-package");
    await symlink(fixture.packageRoot, linkedRoot);
    await writeNodePackageManifest(fixture, { packageRoot: linkedRoot });

    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/codex-acp.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);

    await writeNodePackageManifest(fixture);
    await symlink(
      join(fixture.packageRoot, "dist", "cli.js"),
      join(fixture.packageRoot, "link.js"),
    );
    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/codex-acp.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);
  });

  it("rejects a transitive package reached through a linked dependency", async () => {
    const fixture = await nodePackageFixture();
    const dependencyRoot = join(fixture.root, "linked-dependency");
    const dependencyLink = join(fixture.packageRoot, "node_modules", "linked-dependency");
    await Promise.all([
      mkdir(dependencyRoot, { recursive: true }),
      mkdir(join(fixture.packageRoot, "node_modules"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(dependencyRoot, "package.json"),
        `${JSON.stringify({ name: "linked-dependency", version: "1.0.0" })}\n`,
        "utf8",
      ),
      writeFile(join(dependencyRoot, "index.js"), "export const linked = true;\n", "utf8"),
      writeFile(
        join(fixture.packageRoot, "package.json"),
        `${JSON.stringify({
          name: "@zed-industries/codex-acp",
          version: "1.6.2",
          dependencies: { "linked-dependency": "1.0.0" },
        })}\n`,
        "utf8",
      ),
    ]);
    await symlink(dependencyRoot, dependencyLink);
    const closure = await readTrustedPackageClosure(
      fixture.packageRoot,
      "@zed-industries/codex-acp",
      "1.6.2",
      "test ACP package closure",
      new ArtifactObservations(),
      {
        bindResolutionGraph: true,
        includeMarkdown: true,
        includePeerDependencies: true,
        rejectUnselectedNestedPackages: true,
        resolutionRoot: fixture.root,
      },
    );
    await writeNodePackageManifest(fixture, { packageSha256: closure.sha256 });

    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/codex-acp.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);
  });

  it("rejects a missing entrypoint and package closure mismatch", async () => {
    const fixture = await nodePackageFixture();
    await writeNodePackageManifest(fixture, { entrypoint: "dist/missing.js" });
    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/codex-acp.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);

    await writeNodePackageManifest(fixture, { packageSha256: "e".repeat(64) });
    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/codex-acp.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);
  });

  it("detects package content drift after admission", async () => {
    const fixture = await nodePackageFixture();
    const admitted = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/codex-acp.json",
    });
    await writeFile(join(fixture.packageRoot, "dist", "cli.js"), "export const changed = true;\n");

    await expect(admitted.assertCurrent()).rejects.toThrow(
      /^local ACP agent identity changed after admission$/,
    );
  });

  it("rejects a linked or changed manifest", async () => {
    const fixture = await binaryFixture();
    const linkedManifest = join(fixture.root, "linked-manifest.json");
    await symlink(fixture.manifestPath, linkedManifest);

    await expect(
      admitLocalAcpAgentRuntime({
        manifestPath: linkedManifest,
        provenance: ".flow/acp-agents/opencode.json",
      }),
    ).rejects.toThrow(/^local ACP agent admission failed$/);

    const admitted = await admitLocalAcpAgentRuntime({
      manifestPath: fixture.manifestPath,
      provenance: ".flow/acp-agents/opencode.json",
    });
    await writeFile(fixture.manifestPath, "{}\n", "utf8");
    await expect(admitted.assertCurrent()).rejects.toThrow(
      /^local ACP agent identity changed after admission$/,
    );
  });

  it("returns one typed, bounded, secret-free diagnostic", async () => {
    const fixture = await binaryFixture();
    const secret = "sk-secret-must-not-escape";
    await writeBinaryManifest(fixture.manifestPath, fixture.executable, fixture.executableSha256, {
      credentialEnv: secret,
    });

    try {
      await admitLocalAcpAgentRuntime({
        manifestPath: fixture.manifestPath,
        provenance: ".flow/acp-agents/opencode.json",
      });
      throw new Error("expected admission failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAcpAgentAdmissionError);
      expect((error as Error).message).toBe("local ACP agent admission failed");
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain(fixture.root);
      expect((error as Error).message.length).toBeLessThanOrEqual(64);
    }
  });
});

const BINARY_CONTENT = "#!/bin/sh\nexit 0\n";
const NODE_CONTENT = "#!/bin/sh\nexit 0\n";
const ENTRYPOINT_CONTENT = "export const agent = true;\n";

async function binaryFixture() {
  const root = await temporaryDirectory();
  const executable = join(root, "opencode");
  const manifestPath = join(root, "opencode.json");
  await writeFile(executable, BINARY_CONTENT, "utf8");
  await chmod(executable, 0o755);
  const executableSha256 = await fileSha256(executable);
  await writeBinaryManifest(manifestPath, executable, executableSha256);
  return { root, executable, executableSha256, manifestPath };
}

async function writeBinaryManifest(
  manifestPath: string,
  executable: string,
  executableSha256: string,
  overrides: { readonly credentialEnv?: string } = {},
): Promise<void> {
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name: "opencode" },
      spec: {
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: { kind: "binary", executable, executableSha256, args: ["--stdio"] },
        modelMappings: [
          { provider: "openai", model: "gpt-5.6-codex", agentModel: "gpt-5.6-codex" },
        ],
        providerAuthorities: [
          {
            provider: "openai",
            domain: "api.openai.com",
            credentialEnv: overrides.credentialEnv ?? "OPENAI_API_KEY",
          },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "complete", costUsd: "unavailable" },
        configuration: testConfiguration(),
      },
    }),
    "utf8",
  );
}

async function nodePackageFixture() {
  const root = await temporaryDirectory();
  const nodeExecutable = join(root, "node");
  const packageRoot = join(root, "codex-acp");
  const entrypoint = join(packageRoot, "dist", "cli.js");
  const manifestPath = join(root, "codex-acp.json");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    writeFile(nodeExecutable, NODE_CONTENT, "utf8"),
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "@zed-industries/codex-acp", version: "1.6.2" })}\n`,
      "utf8",
    ),
    writeFile(entrypoint, ENTRYPOINT_CONTENT, "utf8"),
  ]);
  await chmod(nodeExecutable, 0o755);
  const observations = new ArtifactObservations();
  const closure = await readTrustedPackageClosure(
    packageRoot,
    "@zed-industries/codex-acp",
    "1.6.2",
    "test ACP package closure",
    observations,
    {
      bindResolutionGraph: true,
      includeMarkdown: true,
      includePeerDependencies: true,
      rejectUnselectedNestedPackages: true,
      resolutionRoot: root,
    },
  );
  const fixture = {
    root,
    nodeExecutable,
    nodeSha256: await fileSha256(nodeExecutable),
    packageRoot,
    packageSha256: closure.sha256,
    entrypointSha256: await fileSha256(entrypoint),
    manifestPath,
  };
  await writeNodePackageManifest(fixture);
  return fixture;
}

async function writeNodePackageManifest(
  fixture: Awaited<ReturnType<typeof nodePackageFixture>>,
  overrides: {
    readonly packageRoot?: string;
    readonly packageSha256?: string;
    readonly entrypoint?: string;
  } = {},
): Promise<void> {
  await writeFile(
    fixture.manifestPath,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AcpAgent",
      metadata: { name: "codex-acp" },
      spec: {
        protocol: "acp-v1",
        compatibilityProfile: "prompt-only-v1",
        launch: {
          kind: "node-package",
          nodeExecutable: fixture.nodeExecutable,
          nodeExecutableSha256: fixture.nodeSha256,
          nodeVersion: "v26.7.0",
          packageRoot: overrides.packageRoot ?? fixture.packageRoot,
          packageResolutionRoot: fixture.root,
          packageName: "@zed-industries/codex-acp",
          packageVersion: "1.6.2",
          packageSha256: overrides.packageSha256 ?? fixture.packageSha256,
          packageEntrypoint: overrides.entrypoint ?? "dist/cli.js",
          args: ["--stdio"],
        },
        modelMappings: [
          { provider: "openai", model: "gpt-5.6-codex", agentModel: "gpt-5.6-codex" },
        ],
        providerAuthorities: [
          { provider: "openai", domain: "api.openai.com", credentialEnv: "OPENAI_API_KEY" },
        ],
        containmentProfile: "acp-prompt-only-v1",
        usage: { modelTokens: "unavailable", costUsd: "unavailable" },
        configuration: testConfiguration(),
      },
    }),
    "utf8",
  );
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-local-acp-agent-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function testConfiguration() {
  return {
    assignments: [
      { configId: "model", source: "model" },
      {
        configId: "thinking",
        source: "thinking",
        mappings: [
          { thinking: "off", value: "off" },
          { thinking: "medium", value: "medium" },
          { thinking: "high", value: "high" },
        ],
      },
    ],
  };
}
