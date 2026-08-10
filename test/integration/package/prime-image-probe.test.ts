import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRuntimeInventory } from "../../../prime-container/image-probe.mjs";

describe("Prime image inventory probe", () => {
  it("hashes installed Node and Python closures with a canonical inventory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const nodeRoot = join(root, "node_modules");
    const primeRoot = join(nodeRoot, "prime-agent");
    const pythonRoot = join(root, "python");
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

    const first = await createRuntimeInventory({ nodeRoot, primeRoot, pythonRoot });
    const second = await createRuntimeInventory({ nodeRoot, primeRoot, pythonRoot });

    expect(first).toEqual(second);
    expect(first.nodeVersion).toBe(process.versions.node);
    expect(first.pythonVersion).toBe("3.11.15");
    expect(first.nodeClosureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.primePackageContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.pythonClosureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sbom).toEqual({
      node: [
        { name: "prime-agent", version: "0.7.1" },
        { name: "zod", version: "4.4.3" },
      ],
      python: [{ name: "example", version: "1.2.3" }],
    });
    expect(first.sbomSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a symbolic link that escapes an installed closure", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-image-probe-")));
    const nodeRoot = join(root, "node_modules");
    const primeRoot = join(nodeRoot, "prime-agent");
    const pythonRoot = join(root, "python");
    await mkdir(primeRoot, { recursive: true });
    await mkdir(pythonRoot, { recursive: true });
    await writeFile(join(primeRoot, "package.json"), '{"name":"prime-agent","version":"0.7.1"}\n');
    await writeFile(join(pythonRoot, "pyvenv.cfg"), "version = 3.11.15\n");
    await symlink("../../../outside", join(primeRoot, "linked-package.json"));

    await expect(createRuntimeInventory({ nodeRoot, primeRoot, pythonRoot })).rejects.toThrow(
      /symbolic link.*escapes/i,
    );
  });
});
