import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LocalPrimeImageBuilder,
  primeImageBuildStageForDockerCommand,
  runLocalDockerCommand,
  verifyPrimeAgentArchiveBytes,
} from "../../../../src/infrastructure/oci/local-prime-image-builder.js";

const BUILDKIT_IMAGE =
  "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";
const BUILDKIT_IMAGE_ID = `sha256:${"9".repeat(64)}`;

describe("local Prime image builder", () => {
  it.each([
    [["buildx", "create"], "create BuildKit builder"],
    [["buildx", "inspect"], "bootstrap BuildKit builder"],
    [["container", "inspect"], "inspect BuildKit builder"],
    [["buildx", "build"], "build OCI image"],
    [["image", "ls"], "inspect image references"],
    [["image", "load"], "load OCI image"],
    [["image", "inspect"], "inspect loaded image"],
    [["run"], "probe built image"],
    [["image", "tag"], "tag canonical image"],
  ] as const)("assigns Docker command %j to stage %s", (command, expectedStage) => {
    expect(primeImageBuildStageForDockerCommand(command)).toBe(expectedStage);
  });

  it("classifies setup failure and removes its unjournaled operation root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-build-setup-")));
    const builder = new LocalPrimeImageBuilder({
      packageRoot: root,
      dockerExecutable: join(root, "docker"),
      dockerBuildxExecutable: join(root, "docker-buildx"),
      temporaryRoot: root,
      nonce: () => {
        throw new Error("private nonce source failed");
      },
    });

    await expect(builder.build(1)).rejects.toMatchObject({ stage: "stage build context" });
    expect((await readdir(root)).filter((entry) => entry.startsWith("flow-prime-image-"))).toEqual(
      [],
    );
  });

  it.each([
    [["buildx", "create"], "create BuildKit builder"],
    [["buildx", "inspect"], "bootstrap BuildKit builder"],
    [["container", "inspect"], "inspect BuildKit builder"],
    [["buildx", "build"], "build OCI image"],
    [["image", "ls"], "inspect image references"],
    [["image", "load"], "load OCI image"],
    [["image", "inspect"], "inspect loaded image"],
    [["run"], "probe built image"],
    [["image", "tag"], "tag canonical image"],
  ] as const)("reports builder command %j at stage %s", async (command, expectedStage) => {
    const { builder } = await createBuildHarness({ failCommand: command });

    await expect(builder.build(1)).rejects.toMatchObject({ stage: expectedStage });
  });

  it("retains a successful-build journal until failed Docker cleanup is recovered", async () => {
    const { builder, root, cleanupRun } = await createBuildHarness({
      cleanupBuildxRemoveFailures: 1,
    });

    await expect(builder.build(1)).rejects.toMatchObject({ stage: "clean build resources" });
    await builder.retireCreatedImagesExcept();
    const [operationDirectory] = (await readdir(root)).filter((entry) =>
      entry.startsWith("flow-prime-image-1-"),
    );
    expect(operationDirectory).toBeDefined();
    const journalPath = join(root, operationDirectory as string, "recovery.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    await writeFile(journalPath, JSON.stringify({ ...journal, pid: 2_147_483_647 }));

    await builder.recoverInterruptedBuilds();

    expect(cleanupRun).toHaveBeenCalledWith(
      ["buildx", "rm", "--force", "flow-prime-builder-1-0123456789abcdef0123456789abcdef"],
      expect.any(Object),
    );
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith("flow-prime-image-1-")),
    ).toEqual([]);
  });

  it("does not hide a distinct staged command failure after the signal aborts", async () => {
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled image load");
    const { builder } = await createBuildHarness({
      failCommand: ["image", "load"],
      abortCommand: { controller, reason: cancellation },
    });

    await expect(builder.build(1, controller.signal)).rejects.toMatchObject({
      stage: "load OCI image",
      cause: expect.objectContaining({ message: "private staged Docker command failed" }),
    });
  });

  it("preserves cancellation from the production Docker command wrapper", async () => {
    const root = await buildFixture();
    const toolsRoot = join(root, "host-tools");
    const dockerExecutable = join(toolsRoot, "docker");
    const dockerBuildxExecutable = join(toolsRoot, "docker-buildx");
    const commandMarker = join(root, "docker-command-started");
    await mkdir(toolsRoot);
    await writeFile(
      dockerExecutable,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(commandMarker)}, "started"); setInterval(() => {}, 10_000);\n`,
    );
    await writeFile(dockerBuildxExecutable, "verified-buildx-plugin\n");
    await chmod(dockerExecutable, 0o700);
    await chmod(dockerBuildxExecutable, 0o700);
    const controller = new AbortController();
    const cancellation = new Error("operator cancelled production Docker command");
    const builder = new LocalPrimeImageBuilder({
      packageRoot: root,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: root,
      cleanupRun: vi.fn(async () => ""),
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: vi.fn(async () => undefined),
    });
    const build = builder.build(1, controller.signal);
    await vi.waitFor(
      async () => {
        await expect(access(commandMarker)).resolves.toBeUndefined();
      },
      { timeout: 10_000, interval: 25 },
    );
    controller.abort(cancellation);

    await expect(build).rejects.toBe(cancellation);
  }, 15_000);

  it("preserves image-retirement and retirement-environment cleanup failures", async () => {
    const retirementCleanup = new Error("private retirement environment cleanup failed");
    const { builder } = await createBuildHarness({
      failRetirementImageRemove: true,
      removePath: async (path, options) => {
        if (String(path).includes("flow-prime-image-retirement-")) {
          throw retirementCleanup;
        }
        await rm(path, options);
      },
    });
    await builder.build(1);

    await expect(builder.retireCreatedImagesExcept()).rejects.toMatchObject({
      stage: "clean build resources",
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({ message: "private image retirement failed" }),
          retirementCleanup,
        ],
      }),
    });
  });

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
    await writeFile(executable, `#!${process.execPath}\nsetInterval(() => {}, 10_000);\n`);
    await chmod(executable, 0o700);

    await expect(runLocalDockerCommand(executable, [], root, undefined, 20)).rejects.toMatchObject({
      killed: true,
    });
  });

  it.runIf(process.platform === "linux")(
    "settles the complete Docker command process group before timeout rejection",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-docker-tree-timeout-")));
      const executable = join(root, "docker");
      const pidPath = join(root, "descendant.pid");
      await writeFile(
        executable,
        `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], {
  detached: false,
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
setInterval(() => {}, 10_000);
`,
      );
      await chmod(executable, 0o700);
      let descendantPid: number | undefined;

      try {
        await expect(
          runLocalDockerCommand(executable, [], root, undefined, 500),
        ).rejects.toMatchObject({ killed: true });
        descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(() => process.kill(descendantPid as number, 0)).toThrow(/ESRCH/);
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The production process-group kill already settled the descendant.
          }
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "settles the complete Docker command process group after a nonzero exit",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-docker-tree-error-")));
      const executable = join(root, "docker");
      const pidPath = join(root, "descendant.pid");
      await writeFile(
        executable,
        `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], {
  detached: false,
  stdio: "inherit",
});
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
process.exit(2);
`,
      );
      await chmod(executable, 0o700);
      let descendantPid: number | undefined;

      try {
        await expect(runLocalDockerCommand(executable, [], root)).rejects.toThrow(/failed/i);
        descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(() => process.kill(descendantPid as number, 0)).toThrow(/ESRCH/);
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The production process-group kill already settled the descendant.
          }
        }
      }
    },
  );

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
    const buildxSha256 = createHash("sha256").update("verified-buildx-plugin\n").digest("hex");
    const sbom = {
      node: [{ name: "prime-agent", version: "0.7.1" }],
      python: [{ name: "ipykernel", version: "6.30.1" }],
    };
    const sbomSha256 = createHash("sha256").update(JSON.stringify(sbom)).digest("hex");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    let contextWasAllowlisted = false;
    let builderPresent = true;
    const run = vi.fn(async (args: readonly string[], options: { environmentRoot: string }) => {
      mutableCalls.push([...args]);
      if (args[0] === "buildx" && args[1] === "create") {
        expect(args).toEqual([
          "buildx",
          "create",
          "--driver",
          "docker-container",
          "--driver-opt",
          `image=${BUILDKIT_IMAGE}`,
          "--name",
          "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
        ]);
        return "flow-prime-builder-1-0123456789abcdef0123456789abcdef\n";
      }
      if (args[0] === "buildx" && args[1] === "inspect") {
        expect(args).toEqual([
          "buildx",
          "inspect",
          "--bootstrap",
          "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
        ]);
        return "Name: flow-prime-builder-1-0123456789abcdef0123456789abcdef\n";
      }
      if (args[0] === "container" && args[1] === "ls") {
        return args.at(-1)?.includes("flow-prime-builder") === true && builderPresent
          ? `${"7".repeat(64)}\n`
          : "";
      }
      if (args[0] === "container" && args[1] === "inspect") {
        expect(args).toEqual([
          "container",
          "inspect",
          "buildx_buildkit_flow-prime-builder-1-0123456789abcdef0123456789abcdef0",
        ]);
        return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
      }
      if (args[0] === "buildx" && args[1] === "build") {
        await expect(
          readFile(join(options.environmentRoot, "cli-plugins", "docker-buildx"), "utf8"),
        ).resolves.toBe("verified-buildx-plugin\n");
        const metadataFile = args[args.indexOf("--metadata-file") + 1];
        if (metadataFile === undefined) {
          throw new Error("missing build output file");
        }
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
        await expect(
          readFile(join(context, "native", "node-hardening.c"), "utf8"),
        ).resolves.toContain("PR_SET_DUMPABLE");
        await expect(access(join(context, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        contextWasAllowlisted = true;
        return "";
      }
      if (args[0] === "image" && args[1] === "load") {
        return "Loaded image\n";
      }
      if (args[0] === "image" && args[1] === "ls") {
        return args.at(-1)?.includes("preparation") === true ? `${imageId}\n` : "";
      }
      if (args[0] === "image" && args[1] === "tag") {
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
      if (args[0] === "image" && args[1] === "save") {
        return "";
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
      if (args[0] === "buildx" && args[1] === "rm") {
        builderPresent = false;
        return "";
      }
      throw new Error(`unexpected Docker command: ${args.join(" ")}`);
    });
    const builder = new LocalPrimeImageBuilder({
      packageRoot: fixture,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: fixture,
      run,
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: vi.fn(async () => undefined),
      inspectImageArchive: vi.fn(async ({ archivePath, imageId: inspectedImageId }) => {
        expect(archivePath).toMatch(/prime-image\.docker\.tar$/);
        expect(inspectedImageId).toBe(imageId);
        return {
          archiveSha256: "7".repeat(64),
          layerSha256: ["8".repeat(64)],
          sbom,
          sbomSha256,
        };
      }),
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
      builder: {
        clientPath: dockerBuildxExecutable,
        clientSha256: buildxSha256,
        imageId: BUILDKIT_IMAGE_ID,
        imageReference: BUILDKIT_IMAGE,
      },
    });
    expect(result.image.buildInputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.image.ociManifestSha256).toBe("f".repeat(64));
    expect(result.image.platformConfigSha256).toBe("a".repeat(64));

    const build = mutableCalls.find((args) => args[0] === "buildx" && args[1] === "build");
    expect(build).toEqual(
      expect.arrayContaining([
        "buildx",
        "build",
        "--builder",
        "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
        "--pull=false",
        "--no-cache",
        expect.stringMatching(
          /^--output=type=docker,dest=.+\/prime-image\.docker\.tar,tar=true,compression=uncompressed,force-compression=true,rewrite-timestamp=true,oci-mediatypes=true$/,
        ),
        "--provenance=false",
        "--sbom=false",
        "--platform",
        "linux/amd64",
      ]),
    );
    expect(build).not.toContain("BUILDKIT_MULTI_PLATFORM=1");
    expect(build).not.toContain("--iidfile");
    expect(mutableCalls).toContainEqual([
      "image",
      "load",
      "--input",
      expect.stringMatching(/prime-image\.docker\.tar$/),
    ]);
    expect(mutableCalls.some((args) => args[0] === "image" && args[1] === "save")).toBe(false);
    expect(mutableCalls).toContainEqual([
      "image",
      "tag",
      imageId,
      `flow-prime-runtime:sha256-${"a".repeat(64)}`,
    ]);
    expect(mutableCalls).toContainEqual([
      "image",
      "rm",
      "--force",
      "flow-prime-runtime:preparation-1-0123456789abcdef0123456789abcdef",
    ]);
    expect(contextWasAllowlisted).toBe(true);
    expect(mutableCalls.at(0)).toEqual([
      "buildx",
      "create",
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${BUILDKIT_IMAGE}`,
      "--name",
      "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
    ]);
    expect(mutableCalls).toContainEqual([
      "buildx",
      "rm",
      "--force",
      "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
    ]);

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
    await builder.retireCreatedImagesExcept();
    expect(mutableCalls).toContainEqual([
      "image",
      "rm",
      "--force",
      `flow-prime-runtime:sha256-${"a".repeat(64)}`,
    ]);
  });

  it("uses an independent cleanup runner after the operation is cancelled", async () => {
    const fixture = await buildFixture();
    const dockerExecutable = join(fixture, "host-tools", "docker");
    const dockerBuildxExecutable = join(fixture, "host-tools", "docker-buildx");
    await mkdir(join(fixture, "host-tools"));
    await writeFile(dockerExecutable, "docker-client\n");
    await writeFile(dockerBuildxExecutable, "verified-buildx-plugin\n");
    await chmod(dockerExecutable, 0o700);
    await chmod(dockerBuildxExecutable, 0o700);
    const cleanupCalls: string[][] = [];
    let builderPresent = true;
    const operationRun = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "buildx" && args[1] === "create") {
        throw new Error("operation cancelled after Docker created the builder");
      }
      throw new Error("operation cancelled");
    });
    const cleanupRun = vi.fn(async (args: readonly string[]) => {
      cleanupCalls.push([...args]);
      if (args[0] === "container" && args[1] === "ls") {
        return args.at(-1)?.includes("flow-prime-builder") === true && builderPresent
          ? `${"7".repeat(64)}\n`
          : "";
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
      }
      if (args[0] === "buildx" && args[1] === "rm") {
        builderPresent = false;
      }
      return "";
    });
    const builder = new LocalPrimeImageBuilder({
      packageRoot: fixture,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: fixture,
      run: operationRun,
      cleanupRun,
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: vi.fn(async () => undefined),
    });

    await expect(builder.build(1)).rejects.toThrow(/create BuildKit builder/i);

    expect(cleanupCalls).toContainEqual([
      "buildx",
      "rm",
      "--force",
      "flow-prime-builder-1-0123456789abcdef0123456789abcdef",
    ]);
  });

  it("carries operator cancellation into a blocked Docker build command", async () => {
    const fixture = await buildFixture();
    const dockerExecutable = join(fixture, "host-tools", "docker");
    const dockerBuildxExecutable = join(fixture, "host-tools", "docker-buildx");
    await mkdir(join(fixture, "host-tools"));
    await writeFile(dockerExecutable, "docker-client\n");
    await writeFile(dockerBuildxExecutable, "verified-buildx-plugin\n");
    await chmod(dockerExecutable, 0o700);
    await chmod(dockerBuildxExecutable, 0o700);
    const controller = new AbortController();
    let releaseCommand!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const operationRun = vi.fn(
      async (
        _args: readonly string[],
        options: { readonly signal?: AbortSignal },
      ): Promise<string> => {
        releaseCommand();
        if (!(options.signal instanceof AbortSignal)) {
          throw new Error("operator signal is absent from Docker command");
        }
        const signal = options.signal;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "";
      },
    );
    const cleanupRun = vi.fn(async () => "");
    const builder = new LocalPrimeImageBuilder({
      packageRoot: fixture,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: fixture,
      run: operationRun,
      cleanupRun,
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: vi.fn(async () => undefined),
    });

    const build = builder.build(1, controller.signal);
    await commandStarted;
    controller.abort(new Error("operator cancelled blocked Docker command"));

    await expect(build).rejects.toThrow(/operator cancelled blocked Docker command/i);
    expect(cleanupRun).toHaveBeenCalled();
  });

  it("cancels blocked archive verification with the operator signal", async () => {
    const fixture = await buildFixture();
    const dockerExecutable = join(fixture, "host-tools", "docker");
    const dockerBuildxExecutable = join(fixture, "host-tools", "docker-buildx");
    await mkdir(join(fixture, "host-tools"));
    await writeFile(dockerExecutable, "docker-client\n");
    await writeFile(dockerBuildxExecutable, "verified-buildx-plugin\n");
    await chmod(dockerExecutable, 0o700);
    await chmod(dockerBuildxExecutable, 0o700);
    const controller = new AbortController();
    let releaseVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let builderPresent = true;
    const operationRun = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "buildx" && args[1] === "create") {
        return "";
      }
      if (args[0] === "buildx" && args[1] === "inspect") {
        return "";
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
      }
      throw new Error(`unexpected operation command: ${args.join(" ")}`);
    });
    const cleanupRun = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "container" && args[1] === "ls") {
        return builderPresent ? `${"7".repeat(64)}\n` : "";
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
      }
      if (args[0] === "buildx" && args[1] === "rm") {
        builderPresent = false;
      }
      return "";
    });
    const builder = new LocalPrimeImageBuilder({
      packageRoot: fixture,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: fixture,
      run: operationRun,
      cleanupRun,
      nonce: () => "0123456789abcdef0123456789abcdef",
      verifyPrimeArchive: async (input) => {
        releaseVerification();
        if (!("signal" in input) || !(input.signal instanceof AbortSignal)) {
          throw new Error("operator signal is absent from archive verification");
        }
        const signal = input.signal;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const build = builder.build(1, controller.signal);
    await verificationStarted;
    controller.abort(new Error("operator cancellation reached archive verification"));

    await expect(build).rejects.toThrow(/operator cancellation/i);
    expect(cleanupRun).toHaveBeenCalledWith(
      ["buildx", "rm", "--force", "flow-prime-builder-1-0123456789abcdef0123456789abcdef"],
      expect.any(Object),
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
  await mkdir(join(container, "native"), { recursive: true });
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
    "native/node-hardening.c": "#define PR_SET_DUMPABLE 4\n",
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
      buildkit: { image: BUILDKIT_IMAGE },
      seccomp: { base: "test", sha256: seccompSha256 },
    }),
  );
  return root;
}

async function createBuildHarness(
  options: {
    readonly failCommand?: readonly string[];
    readonly abortCommand?: {
      readonly controller: AbortController;
      readonly reason: Error;
    };
    readonly cleanupBuildxRemoveFailures?: number;
    readonly failRetirementImageRemove?: boolean;
    readonly removePath?: typeof rm;
  } = {},
) {
  const root = await buildFixture();
  const toolsRoot = join(root, "host-tools");
  const dockerExecutable = join(toolsRoot, "docker");
  const dockerBuildxExecutable = join(toolsRoot, "docker-buildx");
  await mkdir(toolsRoot);
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
  let failCommand = options.failCommand;
  let builderPresent = true;
  const run = vi.fn(async (args: readonly string[]) => {
    if (failCommand?.every((value, index) => args[index] === value)) {
      failCommand = undefined;
      options.abortCommand?.controller.abort(options.abortCommand.reason);
      throw new Error("private staged Docker command failed");
    }
    if (args[0] === "buildx" && args[1] === "build") {
      const metadataPath = args[args.indexOf("--metadata-file") + 1];
      if (metadataPath === undefined) {
        throw new Error("missing build metadata path");
      }
      await writeFile(
        metadataPath,
        JSON.stringify({
          "containerimage.config.digest": imageId,
          "containerimage.digest": `sha256:${"f".repeat(64)}`,
        }),
      );
      return "";
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
    }
    if (args[0] === "image" && args[1] === "ls") {
      return "";
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([
        {
          Id: imageId,
          Architecture: "amd64",
          Os: "linux",
          Config: {},
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
    return "";
  });
  let cleanupBuildxRemoveFailures = options.cleanupBuildxRemoveFailures ?? 0;
  const cleanupRun = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "container" && args[1] === "ls") {
      return args.at(-1)?.includes("flow-prime-builder") === true && builderPresent
        ? `${"7".repeat(64)}\n`
        : "";
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return JSON.stringify([{ Image: BUILDKIT_IMAGE_ID, Config: { Image: BUILDKIT_IMAGE } }]);
    }
    if (args[0] === "buildx" && args[1] === "rm") {
      if (cleanupBuildxRemoveFailures > 0) {
        cleanupBuildxRemoveFailures -= 1;
        throw new Error("private BuildKit cleanup failed");
      }
      builderPresent = false;
      return "";
    }
    if (
      options.failRetirementImageRemove === true &&
      args[0] === "image" &&
      args[1] === "rm" &&
      args[3]?.startsWith("flow-prime-runtime:sha256-") === true
    ) {
      throw new Error("private image retirement failed");
    }
    return "";
  });
  const builder = new LocalPrimeImageBuilder({
    packageRoot: root,
    dockerExecutable,
    dockerBuildxExecutable,
    temporaryRoot: root,
    run,
    cleanupRun,
    nonce: () => "0123456789abcdef0123456789abcdef",
    verifyPrimeArchive: vi.fn(async () => undefined),
    inspectImageArchive: vi.fn(async () => ({
      archiveSha256: "7".repeat(64),
      layerSha256: ["8".repeat(64)],
      sbom,
      sbomSha256,
    })),
    ...(options.removePath === undefined ? {} : { removePath: options.removePath }),
  });
  return { builder, root, cleanupRun };
}
