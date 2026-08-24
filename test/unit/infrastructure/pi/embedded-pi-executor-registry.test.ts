import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { calculateDelegationExecutorIdentityDigest } from "../../../../src/domain/adaptation/delegation-evaluation.js";
import {
  EmbeddedPiExecutorRegistry,
  type EmbeddedPiExecutorRegistryOptions,
} from "../../../../src/infrastructure/pi/embedded-pi-executor-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("embedded Pi executor registry", () => {
  it("admits the default pinned embedded Pi installation", async () => {
    const descriptor = await new EmbeddedPiExecutorRegistry().resolve();

    expect(descriptor.identity.kind).toBe("embedded-pi-v1");
  }, 60_000);

  it("binds the current Node, Flow, harness, and inference installation", async () => {
    const fixture = await registryFixture();
    const descriptor = await new EmbeddedPiExecutorRegistry(fixture.options).resolve();

    expect(descriptor.identity).toMatchObject({
      version: 1,
      kind: "embedded-pi-v1",
      adapterContractVersion: "1.0.0",
      node: {
        version: process.versions.node,
        executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      harness: {
        package: "@earendil-works/pi-coding-agent",
        version: "0.84.0",
        integrity:
          "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      inference: {
        package: "@earendil-works/pi-ai",
        version: "0.84.0",
        integrity:
          "sha512-N9RDk8q0eglGiy+NqTZ3Ev2j+6oFNXSAJa8b0CYhvWB9HGiKZjsoCESXkUvMDLybrn0wXp75sdsoBzEtHxk9kA==",
        packageContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      dependencyClosureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const { identityDigest, ...content } = descriptor.identity;
    expect(identityDigest).toBe(calculateDelegationExecutorIdentityDigest(content));
  });

  it("rejects execution after the admitted Flow source changes", async () => {
    const fixture = await registryFixture();
    const descriptor = await new EmbeddedPiExecutorRegistry(fixture.options).resolve();
    await writeFile(join(fixture.sourceRoot, "runtime.js"), "export const runtime = 2;\n");

    await expect(descriptor.assertCurrent()).rejects.toThrow(/identity.*changed/i);
  });

  it("rejects an admitted identity after an installed Pi package changes", async () => {
    const fixture = await registryFixture();
    const registry = new EmbeddedPiExecutorRegistry(fixture.options);
    const admitted = (await registry.resolve()).identity;
    await writeFile(join(fixture.piCodingAgentRoot, "index.js"), "export const pi = 2;\n");

    await expect(registry.resolveAdmitted(admitted)).rejects.toThrow(/identity.*changed/i);
  });

  it("does not accept a different durable executor identity", async () => {
    const fixture = await registryFixture();
    const registry = new EmbeddedPiExecutorRegistry(fixture.options);
    const current = (await registry.resolve()).identity;
    const { identityDigest: _identityDigest, ...content } = current;
    const changedContent = {
      ...content,
      node: { ...content.node, executableSha256: "0".repeat(64) },
    };
    const changed = {
      ...changedContent,
      identityDigest: calculateDelegationExecutorIdentityDigest(changedContent),
    };

    await expect(registry.resolveAdmitted(changed)).rejects.toThrow(/identity.*changed/i);
  });
});

async function registryFixture() {
  const root = await temporaryDirectory();
  const sourceRoot = join(root, "source");
  const localDependencyRoot = join(root, "local-dependency");
  const piCodingAgentRoot = join(root, "pi-coding-agent");
  const piAiRoot = join(root, "pi-ai");
  await Promise.all([
    mkdir(sourceRoot),
    writePackage(localDependencyRoot, "local-dependency", "1.0.0"),
    writePackage(piCodingAgentRoot, "@earendil-works/pi-coding-agent", "0.84.0"),
    writePackage(piAiRoot, "@earendil-works/pi-ai", "0.84.0"),
  ]);
  await writeFile(join(sourceRoot, "runtime.js"), "export const runtime = 1;\n");
  const options: EmbeddedPiExecutorRegistryOptions = {
    nodeExecutable: process.execPath,
    sourceRoot,
    localDependencyRoots: [localDependencyRoot],
    piCodingAgentRoot,
    piAiRoot,
  };
  return { options, sourceRoot, piCodingAgentRoot };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-embedded-pi-registry-")));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePackage(root: string, name: string, version: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({ name, version })}\n`),
    writeFile(join(root, "index.js"), `export const name = ${JSON.stringify(name)};\n`),
  ]);
}
