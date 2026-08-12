import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRuntimeInventory } from "../../../prime-container/image-probe.mjs";
import { nodePackageIdentityCases } from "../../fixtures/prime/node-package-identity-cases.js";
import { invalidUtf8PythonPackageMetadata } from "../../fixtures/prime/package-metadata-cases.js";

describe("Prime image inventory probe", () => {
  it("hashes installed Node and Python closures with a canonical inventory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    const { nodeRoot, primeRoot, pythonRoot } = fixture;
    await mkdir(join(primeRoot, "dist"), { recursive: true });
    await mkdir(join(nodeRoot, "zod"), { recursive: true });
    await mkdir(join(pythonRoot, "lib", "example-1.2.3.dist-info"), { recursive: true });
    await mkdir(join(pythonRoot, "lib", "example-1.2.3.dist-info", "nested"), {
      recursive: true,
    });
    await writeFile(join(primeRoot, "package.json"), '{"name":"prime-agent","version":"0.7.1"}\n');
    await writeFile(join(primeRoot, "dist", "index.js"), "export {};\n");
    await writeFile(join(nodeRoot, "zod", "package.json"), '{"name":"zod","version":"4.4.3"}\n');
    await writeFile(
      join(pythonRoot, "lib", "example-1.2.3.dist-info", "METADATA"),
      "Name: example\nVersion: 1.2.3\n",
    );
    await writeFile(
      join(pythonRoot, "lib", "example-1.2.3.dist-info", "nested", "METADATA"),
      "Name: nested\nVersion: 9.9.9\n",
    );
    await writeFile(join(pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");

    const first = await createRuntimeInventory(fixture);
    const second = await createRuntimeInventory(fixture);

    expect(first).toEqual(second);
    expect(first.nodeVersion).toBe(process.versions.node);
    expect(first.pythonVersion).toBe("3.11.15");
    expect(first.nodeClosureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.primePackageContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.pythonClosureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.artifacts).toMatchObject({
      driverSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      flowDistSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      kernelProxySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      noIoResourceLoaderSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pythonLauncherSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      supervisorSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.sbom).toEqual({
      node: [
        { name: "prime-agent", version: "0.7.1" },
        { name: "zod", version: "4.4.3" },
      ],
      python: [{ name: "example", version: "1.2.3" }],
    });
    expect(first.sbomSha256).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(fixture.artifacts.supervisor, "changed supervisor\n");
    const changedSupervisor = await createRuntimeInventory(fixture);
    expect(changedSupervisor.artifacts.supervisorSha256).not.toBe(first.artifacts.supervisorSha256);
    expect(changedSupervisor.artifacts.flowDistSha256).toBe(first.artifacts.flowDistSha256);

    await writeFile(fixture.artifacts.driver, "changed driver\n");
    const changedDriver = await createRuntimeInventory(fixture);
    expect(changedDriver.artifacts.driverSha256).not.toBe(first.artifacts.driverSha256);
    expect(changedDriver.artifacts.flowDistSha256).not.toBe(first.artifacts.flowDistSha256);
  });

  it("enforces the exact unique package identity limit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    await writeFile(
      join(fixture.primeRoot, "package.json"),
      '{"name":"prime-agent","version":"0.7.1"}\n',
    );
    await writeFile(join(fixture.pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");

    for (let index = 0; index < 8_191; index += 1) {
      const packageRoot = join(fixture.nodeRoot, `package-${index}`);
      await mkdir(packageRoot);
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: `package-${index}`, version: "1.0.0" }),
      );
    }
    const exact = await createRuntimeInventory(fixture);
    expect(exact.sbom.node).toHaveLength(8_192);
    expect(exact.sbom.python).toEqual([]);

    const overRoot = join(fixture.nodeRoot, "package-8191");
    await mkdir(overRoot);
    await writeFile(
      join(overRoot, "package.json"),
      JSON.stringify({ name: "package-8191", version: "1.0.0" }),
    );
    await expect(createRuntimeInventory(fixture)).rejects.toThrow(
      /package inventory.*count limit/i,
    );
  }, 30_000);

  it.each(nodePackageIdentityCases)(
    "matches the archive inventory when a Node package $label",
    async (testCase) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
      const fixture = await probeFixture(root);
      const packageRoot = join(fixture.nodeRoot, "fixture");
      await mkdir(packageRoot);
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(testCase.manifest));
      await writeFile(join(fixture.pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");
      const inspection = createRuntimeInventory(fixture);

      if (testCase.outcome === "reject") {
        await expect(inspection).rejects.toThrow(/package identity.*bounds/i);
      } else {
        const inspected = await inspection;
        expect(inspected.sbom.node).toEqual(
          testCase.outcome === "accept" ? [testCase.identity] : [],
        );
      }
    },
  );

  it("matches the archive inventory by deduplicating Node package identities", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    const identity = { name: "duplicate", version: "1.2.3" };
    for (const directory of ["first", "second"]) {
      const packageRoot = join(fixture.nodeRoot, directory);
      await mkdir(packageRoot);
      await writeFile(join(packageRoot, "package.json"), JSON.stringify(identity));
    }
    await writeFile(join(fixture.pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");

    const inspected = await createRuntimeInventory(fixture);
    expect(inspected.sbom.node).toEqual([identity]);
  });

  it("matches the archive inventory by rejecting invalid UTF-8 Python metadata", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    const metadataRoot = join(fixture.pythonRoot, "invalid.dist-info");
    await mkdir(metadataRoot);
    await writeFile(join(metadataRoot, "METADATA"), invalidUtf8PythonPackageMetadata);
    await writeFile(join(fixture.pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");

    await expect(createRuntimeInventory(fixture)).rejects.toThrow(/not valid.*utf-8/i);
  });

  it.each(["node", "python"] as const)(
    "enforces the exact %s package metadata byte limit",
    async (kind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
      const fixture = await probeFixture(root);
      await writeFile(join(fixture.pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");
      const base =
        kind === "node"
          ? JSON.stringify({ name: "bounded-node", version: "1.0.0" })
          : "Name: bounded-python\nVersion: 1.0.0\n";
      const metadataPath =
        kind === "node"
          ? join(fixture.nodeRoot, "bounded", "package.json")
          : join(fixture.pythonRoot, "bounded.dist-info", "METADATA");
      await mkdir(dirname(metadataPath), { recursive: true });
      const exact = `${base}${" ".repeat(1_048_576 - Buffer.byteLength(base))}`;
      await writeFile(metadataPath, exact);

      const inspected = await createRuntimeInventory(fixture);
      expect(inspected.sbom[kind]).toHaveLength(1);

      await writeFile(metadataPath, `${exact} `);
      await expect(createRuntimeInventory(fixture)).rejects.toThrow(/exceeds.*byte limit/i);
    },
  );

  it("rejects a symbolic link that escapes an installed closure", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    const { primeRoot, pythonRoot } = fixture;
    await writeFile(join(primeRoot, "package.json"), '{"name":"prime-agent","version":"0.7.1"}\n');
    await writeFile(join(pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");
    await symlink("../../../outside", join(primeRoot, "linked-package.json"));

    await expect(createRuntimeInventory(fixture)).rejects.toThrow(/symbolic link.*escapes/i);
  });
});

async function probeFixture(root: string) {
  const nodeRoot = join(root, "node_modules");
  const primeRoot = join(nodeRoot, "prime-agent");
  const pythonRoot = join(root, "python");
  const flowDistRoot = join(root, "flow-dist");
  const primeDistRoot = join(flowDistRoot, "infrastructure", "prime");
  const binRoot = join(root, "bin");
  await Promise.all([
    mkdir(primeRoot, { recursive: true }),
    mkdir(pythonRoot, { recursive: true }),
    mkdir(primeDistRoot, { recursive: true }),
    mkdir(binRoot, { recursive: true }),
  ]);
  const artifacts = {
    driver: join(primeDistRoot, "native-prime-agent-evaluation-driver.js"),
    kernelProxy: join(binRoot, "flow-prime-kernel-proxy"),
    noIoResourceLoader: join(primeDistRoot, "no-io-resource-loader.js"),
    pythonLauncher: join(binRoot, "flow-prime-python"),
    supervisor: join(binRoot, "flow-prime-supervisor"),
  };
  await Promise.all(Object.values(artifacts).map((path) => writeFile(path, `artifact:${path}\n`)));
  return { nodeRoot, primeRoot, pythonRoot, flowDistRoot, artifacts };
}
