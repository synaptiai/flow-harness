import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRuntimeInventory } from "../../../prime-container/image-probe.mjs";

describe("Prime image inventory probe", () => {
  it("hashes installed Node and Python closures with a canonical inventory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const fixture = await probeFixture(root);
    const { nodeRoot, primeRoot, pythonRoot } = fixture;
    await mkdir(join(primeRoot, "dist"), { recursive: true });
    await mkdir(join(nodeRoot, "zod"), { recursive: true });
    await mkdir(join(pythonRoot, "lib", "example-1.2.3.dist-info"), { recursive: true });
    await writeFile(join(primeRoot, "package.json"), '{"name":"prime-agent","version":"0.7.1"}\n');
    await writeFile(join(primeRoot, "dist", "index.js"), "export {};\n");
    await writeFile(join(nodeRoot, "zod", "package.json"), '{"name":"zod","version":"4.4.3"}\n');
    await writeFile(
      join(pythonRoot, "lib", "example-1.2.3.dist-info", "METADATA"),
      "Name: example\nVersion: 1.2.3\n",
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
