import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LocalPrimeImageBuilder } from "../../../../src/infrastructure/oci/local-prime-image-builder.js";

describe("local Prime image builder", () => {
  it("uses an allowlisted context and derives identity from the built image", async () => {
    const fixture = await buildFixture();
    const imageId = `sha256:${"a".repeat(64)}`;
    const sbom = {
      node: [{ name: "prime-agent", version: "0.7.1" }],
      python: [{ name: "ipykernel", version: "6.30.1" }],
    };
    const sbomSha256 = createHash("sha256").update(JSON.stringify(sbom)).digest("hex");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    let contextWasAllowlisted = false;
    const run = vi.fn(async (args: readonly string[]) => {
      mutableCalls.push([...args]);
      if (args[0] === "build") {
        const iidFile = args[args.indexOf("--iidfile") + 1];
        const metadataFile = args[args.indexOf("--metadata-file") + 1];
        if (iidFile === undefined || metadataFile === undefined) {
          throw new Error("missing build output file");
        }
        await writeFile(iidFile, `${imageId}\n`);
        await writeFile(
          metadataFile,
          JSON.stringify({
            "containerimage.config.digest": imageId,
            "containerimage.digest": `sha256:${"f".repeat(64)}`,
          }),
        );
        const context = args.at(-1);
        if (context === undefined) {
          throw new Error("missing build context");
        }
        await expect(access(join(context, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        contextWasAllowlisted = true;
        return "";
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return JSON.stringify([
          {
            Id: imageId,
            Architecture: "amd64",
            Os: "linux",
            Config: {
              Env: ["NODE_ENV=production"],
              Entrypoint: ["/opt/flow/bin/flow-prime-supervisor"],
            },
            RootFS: { Type: "layers", Layers: [`sha256:${"b".repeat(64)}`] },
          },
        ]);
      }
      if (args[0] === "run") {
        return JSON.stringify({
          nodeVersion: "22.19.0",
          pythonVersion: "3.11.15",
          nodeClosureSha256: "c".repeat(64),
          primePackageContentSha256: "d".repeat(64),
          pythonClosureSha256: "e".repeat(64),
          sbom,
          sbomSha256,
        });
      }
      if (args[0] === "image" && args[1] === "rm") {
        return "";
      }
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    });
    const builder = new LocalPrimeImageBuilder({
      packageRoot: fixture,
      dockerExecutable: "/usr/bin/docker",
      temporaryRoot: await realpath(tmpdir()),
      run,
      nonce: () => "0123456789abcdef0123456789abcdef",
    });

    const result = await builder.build(1);

    expect(result).toMatchObject({
      image: {
        id: imageId,
        nodeVersion: "22.19.0",
        nodeClosureSha256: "c".repeat(64),
        pythonVersion: "3.11.15",
        pythonClosureSha256: "e".repeat(64),
        sbomSha256,
      },
      harnessPackageContentSha256: "d".repeat(64),
      harnessDependencyClosureSha256: "c".repeat(64),
    });
    expect(result.image.buildInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.image.ociManifestSha256).toBe("f".repeat(64));
    expect(result.image.platformConfigSha256).toBe("a".repeat(64));

    const build = mutableCalls.find((args) => args[0] === "build");
    expect(build).toEqual(
      expect.arrayContaining([
        "build",
        "--pull=false",
        "--no-cache",
        "--load",
        "--provenance=false",
        "--sbom=false",
        "--platform",
        "linux/amd64",
        "--iidfile",
      ]),
    );
    expect(contextWasAllowlisted).toBe(true);

    const probe = mutableCalls.find((args) => args[0] === "run");
    expect(probe).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--log-driver=none",
        "--read-only",
      ]),
    );
  });
});

async function buildFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-builder-")));
  const container = join(root, "prime-container");
  await mkdir(join(container, "cmd"), { recursive: true });
  await mkdir(join(container, "internal"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  const files: Record<string, string> = {
    Dockerfile: "FROM scratch\n",
    "go.mod": "module example.invalid/prime\n",
    "image-probe.mjs": "export {};\n",
    "package.json": '{"name":"prime-fixture"}\n',
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/prime-agent": {
          version: "0.7.1",
          resolved: "https://example.invalid/prime-agent-0.7.1.tgz",
          integrity:
            "sha512-BOT+mqCYeDpKYabk3HVP5T7HomlBUWiQOXZGnX/DYZwT4xvdQSeF7itt/tCU8nv82/30N7VJw5YdXssEyD3qGQ==",
        },
      },
    }),
    "python-requirements.in": "ipykernel\n",
    "python-requirements.lock": "ipykernel==6.30.1 --hash=sha256:abc\n",
    "seccomp.json": '{"defaultAction":"SCMP_ACT_ERRNO"}\n',
    "cmd/main.go": "package main\n",
    "internal/value.go": "package internal\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(container, path), content);
  }
  await writeFile(join(root, "dist", "driver.js"), "export {};\n");
  await writeFile(join(root, "secret.txt"), "MUST_NOT_ENTER_BUILD_CONTEXT\n");
  const nodeSha256 = createHash("sha256")
    .update(files["package-lock.json"] as string)
    .digest("hex");
  const pythonSha256 = createHash("sha256")
    .update(files["python-requirements.lock"] as string)
    .digest("hex");
  const seccompSha256 = createHash("sha256")
    .update(files["seccomp.json"] as string)
    .digest("hex");
  await writeFile(
    join(container, "build-inputs.json"),
    JSON.stringify({
      version: 1,
      platform: "linux/amd64",
      sourceDateEpoch: 1_786_127_940,
      baseImages: {
        golang: `golang@example@sha256:${"1".repeat(64)}`,
        node: `node@example@sha256:${"2".repeat(64)}`,
        python: `python@example@sha256:${"3".repeat(64)}`,
      },
      primeAgent: {
        version: "0.7.1",
        url: "https://example.invalid/prime-agent-0.7.1.tgz",
        sha256: "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb",
        integrity:
          "sha512-BOT+mqCYeDpKYabk3HVP5T7HomlBUWiQOXZGnX/DYZwT4xvdQSeF7itt/tCU8nv82/30N7VJw5YdXssEyD3qGQ==",
      },
      locks: { nodeSha256, pythonSha256 },
      seccomp: { base: "test", sha256: seccompSha256 },
    }),
  );
  return root;
}
