import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LocalPrimeImageBuilder,
  runLocalDockerCommand,
  verifyPrimeAgentArchiveBytes,
} from "../../../../src/infrastructure/oci/local-prime-image-builder.js";

describe("local Prime image builder", () => {
  it("verifies the Prime release archive with SHA-256 and npm integrity", () => {
    const archive = Buffer.from("fixed Prime archive\n");
    const identity = {
      sha256: createHash("sha256").update(archive).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    };

    expect(() => verifyPrimeAgentArchiveBytes(archive, identity)).not.toThrow();
    expect(() =>
      verifyPrimeAgentArchiveBytes(archive, { ...identity, sha256: "0".repeat(64) }),
    ).toThrow(/SHA-256/i);
    expect(() =>
      verifyPrimeAgentArchiveBytes(archive, { ...identity, integrity: "sha512-invalid" }),
    ).toThrow(/integrity/i);
  });

  it("bounds a Docker command that does not settle", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-docker-timeout-")));
    const executable = join(root, "docker");
    await writeFile(executable, "#!/bin/sh\nsleep 10\n");
    await chmod(executable, 0o700);

    await expect(runLocalDockerCommand(executable, [], root, undefined, 20)).rejects.toMatchObject({
      killed: true,
    });
  });

  it("uses an allowlisted context and derives identity from the built image", async () => {
    const fixture = await buildFixture();
    const dockerExecutable = join(fixture, "host-tools", "docker");
    const dockerBuildxExecutable = join(fixture, "host-tools", "docker-buildx");
    await mkdir(join(fixture, "host-tools"));
    await writeFile(dockerExecutable, "docker-client\n");
    await writeFile(dockerBuildxExecutable, "verified-buildx-plugin\n");
    await chmod(dockerExecutable, 0o700);
    await chmod(dockerBuildxExecutable, 0o700);
    const imageId = `sha256:${"a".repeat(64)}`;
    const sbom = {
      node: [{ name: "prime-agent", version: "0.7.1" }],
      python: [{ name: "ipykernel", version: "6.30.1" }],
    };
    const sbomSha256 = createHash("sha256").update(JSON.stringify(sbom)).digest("hex");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    let contextWasAllowlisted = false;
    const run = vi.fn(async (args: readonly string[], options: { environmentRoot: string }) => {
      mutableCalls.push([...args]);
      if (args[0] === "buildx" && args[1] === "build") {
        await expect(
          readFile(join(options.environmentRoot, "cli-plugins", "docker-buildx"), "utf8"),
        ).resolves.toBe("verified-buildx-plugin\n");
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
        expect((await stat(join(context, "Dockerfile"))).mtimeMs).toBe(1_786_127_940_000);
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
          artifacts: imageArtifacts(),
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
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: await realpath(tmpdir()),
      run,
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: vi.fn(async () => undefined),
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
      artifacts: imageArtifacts(),
    });
    expect(result.image.buildInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.image.ociManifestSha256).toBe("f".repeat(64));
    expect(result.image.platformConfigSha256).toBe("a".repeat(64));

    const build = mutableCalls.find((args) => args[0] === "buildx" && args[1] === "build");
    expect(build).toEqual(
      expect.arrayContaining([
        "buildx",
        "build",
        "--pull=false",
        "--no-cache",
        "--output=type=docker,rewrite-timestamp=true",
        "--provenance=false",
        "--sbom=false",
        "--platform",
        "linux/amd64",
        "--build-arg",
        "BUILDKIT_MULTI_PLATFORM=1",
        "--iidfile",
      ]),
    );
    expect(build).not.toContain("--load");
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

function imageArtifacts() {
  return {
    driverSha256: "1".repeat(64),
    flowDistSha256: "2".repeat(64),
    kernelProxySha256: "3".repeat(64),
    noIoResourceLoaderSha256: "4".repeat(64),
    pythonLauncherSha256: "5".repeat(64),
    supervisorSha256: "6".repeat(64),
  };
}

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
