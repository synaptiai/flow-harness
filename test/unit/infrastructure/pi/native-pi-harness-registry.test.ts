import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { externalHarnessIdentityDigest } from "../../../../src/domain/evaluation/external-harness.js";
import { FLOW_SANDBOX_POLICY_DIGEST } from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";
import {
  NativePiHarnessRegistry,
  type NativePiHarnessRegistryOptions,
} from "../../../../src/infrastructure/pi/native-pi-harness-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native Pi harness registry", () => {
  it("binds the adapter to its executable dependency closure", async () => {
    const fixture = await registryFixture();
    const registry = new NativePiHarnessRegistry(fixture.options);

    const descriptor = await registry.resolve({
      id: "candidate",
      adapter: "pi-native-v1",
      harness: { config: "pi-evaluation-v1" },
    });

    expect(descriptor.identity).toMatchObject({
      version: 1,
      adapter: "pi-native-v1",
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
        policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
        platform: "linux",
        containment: "linux-pid-namespace",
      },
      driver: {
        id: "native-pi-evaluation-v1",
        artifactSha256: sha256("export const driver = 'native-pi';\n"),
        dependencyClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        node: {
          version: process.versions.node,
          executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      harness: {
        package: "@earendil-works/pi-coding-agent",
        version: "0.84.0",
        integrity:
          "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        config: "pi-evaluation-v1",
        configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      inference: {
        id: "flow-pi-inference-v1",
        version: 1,
        package: "@earendil-works/pi-ai",
        packageVersion: "0.84.0",
        packageIntegrity: expect.stringMatching(/^sha512-/),
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(descriptor.identityDigest).toBe(externalHarnessIdentityDigest(descriptor.identity));
    expect(descriptor.launch).toEqual({
      executable: await realpath(process.execPath),
      args: [await realpath(fixture.driverPath)],
      runtimeSupportPaths: [fixture.sourceRoot],
    });
  });

  it("rejects an admitted identity after a trusted artifact changes", async () => {
    const fixture = await registryFixture();
    const registry = new NativePiHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(fixture.driverPath, "export const driver = 'changed';\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after an installed dependency changes", async () => {
    const fixture = await registryFixture();
    const registry = new NativePiHarnessRegistry(fixture.options);
    const admitted = await registry.resolveIdentity(profile());
    await writeFile(join(fixture.piCodingAgentRoot, "index.js"), "export const pi = 2;\n", "utf8");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });
});

async function registryFixture() {
  const root = await temporaryDirectory();
  const sourceRoot = join(root, "source");
  const piCodingAgentRoot = join(root, "pi-coding-agent");
  const piAiRoot = join(root, "pi-ai");
  const sandboxRuntimeRoot = join(root, "sandbox-runtime");
  await Promise.all(
    [sourceRoot, piCodingAgentRoot, piAiRoot, sandboxRuntimeRoot].map((directory) =>
      mkdir(directory),
    ),
  );
  const driverPath = join(sourceRoot, "native-pi-driver.js");
  const protocolPath = join(sourceRoot, "external-harness-protocol.js");
  await Promise.all([
    writeFile(driverPath, "export const driver = 'native-pi';\n", "utf8"),
    writeFile(protocolPath, "export const protocol = 1;\n", "utf8"),
    writePackage(piCodingAgentRoot, "@earendil-works/pi-coding-agent", "0.84.0"),
    writePackage(piAiRoot, "@earendil-works/pi-ai", "0.84.0"),
    writePackage(sandboxRuntimeRoot, "@anthropic-ai/sandbox-runtime", "0.0.70"),
  ]);
  const options: NativePiHarnessRegistryOptions = {
    driverPath,
    protocolPath,
    nodeExecutable: process.execPath,
    runtimeSupportPaths: [sourceRoot],
    sourceRoot,
    localDependencyRoots: [],
    piCodingAgentRoot,
    piAiRoot,
    sandboxRuntimeRoot,
  };
  return { options, sourceRoot, driverPath, piCodingAgentRoot };
}

function profile() {
  return {
    id: "candidate",
    adapter: "pi-native-v1" as const,
    harness: { config: "pi-evaluation-v1" as const },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-native-pi-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writePackage(root: string, name: string, version: string): Promise<void> {
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({ name, version })}\n`, "utf8"),
    writeFile(join(root, "index.js"), `export const name = ${JSON.stringify(name)};\n`, "utf8"),
  ]);
}
