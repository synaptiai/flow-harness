import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { externalHarnessIdentityDigest } from "../../../../src/domain/evaluation/external-harness.js";
import {
  NativeOmpHarnessRegistry,
  type NativeOmpHarnessRegistryOptions,
} from "../../../../src/infrastructure/omp/native-omp-harness-registry.js";
import { nodeModulesRoot } from "../../../../src/infrastructure/pi/native-pi-harness-registry.js";
import { FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST } from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native OMP harness registry", () => {
  it("binds OMP, its dependency closure, and the Bun executable", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);

    const descriptor = await registry.resolve(profile());

    expect(descriptor.identity).toMatchObject({
      version: 1,
      adapter: "omp-native-v1",
      adapterContractVersion: "1.0.0",
      protocol: {
        id: "flow-external-harness-jsonl-v1",
        maxFrameBytes: 1_048_576,
        digest: sha256("export const protocol = 1;\n"),
      },
      runtime: {
        id: "srt-process-v1",
        package: "@anthropic-ai/sandbox-runtime",
        version: "0.0.70",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyDigest: FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST,
        platform: "linux",
        containment: "linux-pid-namespace",
      },
      driver: {
        id: "native-omp-evaluation-v1",
        artifactSha256: sha256("export const driver = 'native-omp';\n"),
        dependencyClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bun: {
          version: "1.3.14",
          executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      harness: {
        package: "@oh-my-pi/pi-coding-agent",
        version: "17.2.12",
        integrity:
          "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        config: "omp-evaluation-v1",
        configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      inference: {
        id: "flow-omp-inference-v1",
        version: 1,
        package: "@oh-my-pi/pi-ai",
        packageVersion: "17.2.12",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(descriptor.identityDigest).toBe(externalHarnessIdentityDigest(descriptor.identity));
    expect(descriptor.launch).toMatchObject({
      executable: await realpath(fixture.bunExecutable),
      args: [
        "--no-env-file",
        "--no-install",
        "--config=/dev/null",
        await realpath(fixture.driverPath),
      ],
    });
    expect(descriptor.launch.runtimeSupportPaths).toEqual(
      expect.arrayContaining([fixture.sourceRoot, await realpath(fixture.bunExecutable)]),
    );
  });

  it("exposes the selected ancestor peer without its resolution container", async () => {
    const fixture = await registryFixture();
    const descriptor = await new NativeOmpHarnessRegistry(fixture.options).resolve(profile());

    expect(descriptor.launch.runtimeSupportPaths).toContain(
      await realpath(fixture.ancestorPeerDependencyRoot),
    );
    expect(descriptor.launch.runtimeSupportPaths).not.toContain(
      await realpath(join(fixture.root, "node_modules")),
    );
    expect(descriptor.launch.environment?.NODE_PATH?.split(delimiter)).toContain(
      await realpath(join(fixture.root, "node_modules")),
    );
  });

  it("does not expose the default installed OMP package container", async () => {
    const fixture = await registryFixture();
    const { runtimeSupportPaths: _runtimeSupportPaths, ...options } = fixture.options;
    const descriptor = await new NativeOmpHarnessRegistry(options).resolve(profile());
    const installedOmpContainer = nodeModulesRoot(
      fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent")),
    );

    expect(descriptor.launch.runtimeSupportPaths).not.toContain(installedOmpContainer);
  });

  it("rejects an admitted identity after the driver changes", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(fixture.driverPath, "export const driver = 'changed';\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after an OMP dependency changes", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(join(fixture.ompRoot, "index.ts"), "export const omp = 2;\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after a deep unselected package appears", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    const nestedRoot = join(fixture.ompRoot, "dist", "node_modules", "unselected");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(nestedRoot, "private.txt"), "UNSELECTED_SECRET\n");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(
      /identity.*changed|unselected nested package/i,
    );
  });

  it("rejects an admitted identity after an imported OMP Markdown prompt changes", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(fixture.ompPromptPath, "Changed runtime prompt.\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an OMP AI package with the wrong name", async () => {
    const fixture = await registryFixture();
    await writePackage(fixture.ompAiRoot, "wrong-ai", "17.2.12");

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /OMP AI.*@oh-my-pi\/pi-ai@17\.2\.12/i,
    );
  });

  it("rejects an OMP AI package with the wrong version", async () => {
    const fixture = await registryFixture();
    await writePackage(fixture.ompAiRoot, "@oh-my-pi/pi-ai", "17.2.11");

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /OMP AI.*@oh-my-pi\/pi-ai@17\.2\.12/i,
    );
  });

  it("binds each dependency edge to the package bytes that Bun resolves", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    const left = await readFile(fixture.leftDependencyPath, "utf8");
    const right = await readFile(fixture.rightDependencyPath, "utf8");
    await Promise.all([
      writeFile(fixture.leftDependencyPath, right, "utf8"),
      writeFile(fixture.rightDependencyPath, left, "utf8"),
    ]);

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after a nearer dependency is installed", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writePackage(fixture.nearDependencyRoot, "shared", "1.0.0");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after an optional dependency is installed", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writePackage(fixture.optionalDependencyRoot, "late-optional", "1.0.0");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after a nearer peer dependency is installed", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writePackage(fixture.nearPeerDependencyRoot, "peer-runtime", "1.0.0");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after selected peer dependency bytes change", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(fixture.ancestorPeerDependencyPath, "export const peer = 2;\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after an optional peer dependency is installed", async () => {
    const fixture = await registryFixture();
    const registry = new NativeOmpHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writePackage(fixture.optionalPeerDependencyRoot, "late-peer", "1.0.0");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects a non-Bun executable", async () => {
    const fixture = await registryFixture();
    await writeFile(fixture.bunExecutable, "#!/bin/sh\nprintf '1.3.14\\n'\n", "utf8");

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /not a Linux ELF binary/i,
    );
  });

  it("rejects Bun before version 1.3.14", async () => {
    const fixture = await registryFixture();
    await writeFakeBun(fixture.bunExecutable, "1.3.13");

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /requires Bun 1\.3\.14 or later/i,
    );
  });

  it("rejects Bun bytes that have no trusted release attestation", async () => {
    const fixture = await registryFixture();
    await writeFakeBun(fixture.bunExecutable, "1.4.0");

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /trusted official Bun release/i,
    );
  });

  it("admits a newer Bun release only with an exact executable attestation", async () => {
    const fixture = await registryFixture();
    const bytes = fakeBunBytes("1.4.0");
    await writeFile(fixture.bunExecutable, bytes);

    const identity = await new NativeOmpHarnessRegistry({
      ...fixture.options,
      bunReleaseAttestations: {
        [sha256(bytes)]: {
          version: "1.4.0",
          platform: "linux",
          architecture: testArchitecture(),
        },
      },
    }).resolveIdentity(profile());

    expect(identity.driver.bun.version).toBe("1.4.0");
  });

  it("rejects Bun that is attested for a different CPU architecture", async () => {
    const fixture = await registryFixture();
    const otherArchitecture = testArchitecture() === "x64" ? "arm64" : "x64";

    await expect(
      new NativeOmpHarnessRegistry({
        ...fixture.options,
        bunReleaseAttestations: {
          [sha256(fakeBunBytes("1.3.14"))]: {
            version: "1.3.14",
            platform: "linux",
            architecture: otherArchitecture,
          },
        },
      }).resolve(profile()),
    ).rejects.toThrow(/current Linux architecture/i);
  });

  it("rejects a trusted Bun file that the current user cannot execute", async () => {
    const fixture = await registryFixture();
    await chmod(fixture.bunExecutable, 0o401);

    await expect(new NativeOmpHarnessRegistry(fixture.options).resolve(profile())).rejects.toThrow(
      /not executable/i,
    );
  });
});

async function registryFixture() {
  const root = await temporaryDirectory();
  const sourceRoot = join(root, "source");
  const ompRoot = join(root, "pi-coding-agent");
  const ompAiRoot = join(root, "pi-ai");
  const sandboxRuntimeRoot = join(root, "sandbox-runtime");
  const leftDependencyRoot = join(ompRoot, "node_modules", "left");
  const rightDependencyRoot = join(ompRoot, "node_modules", "right");
  const ancestorDependencyRoot = join(root, "node_modules", "shared");
  const nearDependencyRoot = join(ompRoot, "node_modules", "shared");
  const optionalDependencyRoot = join(ompRoot, "node_modules", "late-optional");
  const ancestorPeerDependencyRoot = join(root, "node_modules", "peer-runtime");
  const nearPeerDependencyRoot = join(ompRoot, "node_modules", "peer-runtime");
  const optionalPeerDependencyRoot = join(ompRoot, "node_modules", "late-peer");
  const ancestorPeerDependencyPath = join(ancestorPeerDependencyRoot, "index.ts");
  await Promise.all(
    [
      sourceRoot,
      ompRoot,
      ompAiRoot,
      sandboxRuntimeRoot,
      leftDependencyRoot,
      rightDependencyRoot,
      ancestorDependencyRoot,
      ancestorPeerDependencyRoot,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  const driverPath = join(sourceRoot, "native-omp-driver.ts");
  const protocolPath = join(sourceRoot, "external-harness-protocol.ts");
  const bunExecutable = join(root, "bun");
  const ompPromptPath = join(ompRoot, "prompts", "tools", "read.md");
  const leftDependencyPath = join(leftDependencyRoot, "index.js");
  const rightDependencyPath = join(rightDependencyRoot, "index.js");
  await mkdir(join(ompRoot, "prompts", "tools"), { recursive: true });
  await Promise.all([
    writeFile(driverPath, "export const driver = 'native-omp';\n", "utf8"),
    writeFile(protocolPath, "export const protocol = 1;\n", "utf8"),
    writeFakeBun(bunExecutable, "1.3.14"),
    writePackage(
      ompRoot,
      "@oh-my-pi/pi-coding-agent",
      "17.2.12",
      {
        left: "npm:shared@1.0.0",
        right: "npm:shared@1.0.0",
        shared: "1.0.0",
      },
      { "late-optional": "1.0.0" },
      { "peer-runtime": "1.0.0", "late-peer": "1.0.0" },
      { "late-peer": { optional: true } },
    ),
    writePackage(ompAiRoot, "@oh-my-pi/pi-ai", "17.2.12"),
    writePackage(sandboxRuntimeRoot, "@anthropic-ai/sandbox-runtime", "0.0.70"),
    writePackage(leftDependencyRoot, "shared", "1.0.0"),
    writePackage(rightDependencyRoot, "shared", "1.0.0"),
    writePackage(ancestorDependencyRoot, "shared", "1.0.0"),
    writePackage(ancestorPeerDependencyRoot, "peer-runtime", "1.0.0"),
    writeFile(leftDependencyPath, "export const selected = 'left';\n", "utf8"),
    writeFile(rightDependencyPath, "export const selected = 'right';\n", "utf8"),
    writeFile(ompPromptPath, "Read the requested file.\n", "utf8"),
  ]);
  await chmod(bunExecutable, 0o755);
  const bunReleaseAttestations = {
    [sha256(fakeBunBytes("1.3.14"))]: {
      version: "1.3.14",
      platform: "linux" as const,
      architecture: testArchitecture(),
    },
  };
  const options: NativeOmpHarnessRegistryOptions = {
    driverPath,
    protocolPath,
    bunExecutable,
    runtimeSupportPaths: [sourceRoot],
    sourceRoot,
    localDependencyRoots: [],
    ompCodingAgentRoot: ompRoot,
    ompAiRoot,
    sandboxRuntimeRoot,
    bunReleaseAttestations,
  };
  return {
    options,
    root,
    sourceRoot,
    driverPath,
    bunExecutable,
    ompRoot,
    ompAiRoot,
    ompPromptPath,
    leftDependencyPath,
    rightDependencyPath,
    nearDependencyRoot,
    optionalDependencyRoot,
    nearPeerDependencyRoot,
    optionalPeerDependencyRoot,
    ancestorPeerDependencyPath,
    ancestorPeerDependencyRoot,
  };
}

function profile() {
  return {
    id: "candidate",
    adapter: "omp-native-v1" as const,
    harness: { config: "omp-evaluation-v1" as const },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-native-omp-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writePackage(
  root: string,
  name: string,
  version: string,
  dependencies: Readonly<Record<string, string>> = {},
  optionalDependencies: Readonly<Record<string, string>> = {},
  peerDependencies: Readonly<Record<string, string>> = {},
  peerDependenciesMeta: Readonly<Record<string, { readonly optional?: boolean }>> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify({
        name,
        version,
        dependencies,
        optionalDependencies,
        peerDependencies,
        peerDependenciesMeta,
      })}\n`,
      "utf8",
    ),
    writeFile(join(root, "index.ts"), `export const name = ${JSON.stringify(name)};\n`, "utf8"),
  ]);
}

async function writeFakeBun(path: string, version: string): Promise<void> {
  await writeFile(path, fakeBunBytes(version));
}

function fakeBunBytes(version: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(`\0Bun v${version} (0d9b296a) Linux x64\0`, "latin1"),
  ]);
}

function testArchitecture(): "x64" | "arm64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}
