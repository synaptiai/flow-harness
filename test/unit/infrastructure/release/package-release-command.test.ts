import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES,
  PACKAGE_RELEASE_COMMAND_TIMEOUT_MS,
  PackageReleaseCommandError,
  runPackageReleaseCommand,
} from "../../../../src/infrastructure/release/package-release-command.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package release command", () => {
  it("runs bounded npm pack and publishes the resulting artifact", async () => {
    const repositoryRoot = await temporaryRoot();
    const archive = Buffer.from("exact preview archive");
    const execute = vi.fn(
      async (command: string, args: readonly string[], _options: ExecuteOptions) => {
        if (command === "git" && args[0] === "rev-parse") return { stdout: `${"e".repeat(40)}\n` };
        if (command === "git" && args[0] === "status") return { stdout: "" };
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing pack destination");
        await writeFile(join(destination, "synaptiai-flow-harness-0.1.0-alpha.1.tgz"), archive);
        return { stdout: JSON.stringify([packReportFixture(archive)]) };
      },
    );

    const result = await runPackageReleaseCommand(
      ["--output", "release/package", "--revision", "e".repeat(40)],
      { execute, repositoryRoot },
    );

    expect(result.settlement).toBe("created");
    expect(await readFile(result.archivePath)).toEqual(archive);
    expect(execute).toHaveBeenCalledTimes(5);
    const [command, args, options] =
      execute.mock.calls.find(([calledCommand]) => calledCommand === "npm") ?? [];
    expect(command).toBe("npm");
    expect(args?.slice(0, 5)).toEqual([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      expect.any(String),
    ]);
    expect(options).toMatchObject({
      cwd: repositoryRoot,
      timeout: PACKAGE_RELEASE_COMMAND_TIMEOUT_MS,
      maxBuffer: PACKAGE_RELEASE_COMMAND_MAX_OUTPUT_BYTES,
    });
    expect(options?.env.npm_config_cache).toContain("npm-cache");
  });

  it.each(
    [
      [],
      ["--output", "release/package"],
      ["--revision", "e".repeat(40), "--output", "release/package"],
      ["--output", "", "--revision", "e".repeat(40)],
      ["--output", "release/package", "--revision", "PRIVATE_REVISION"],
      ["--output", "release/package", "--revision", "e".repeat(40), "PRIVATE_EXTRA"],
    ].map((args) => [args]),
  )("rejects invalid command arguments before invoking npm: %j", async (args) => {
    const repositoryRoot = await temporaryRoot();
    const execute = vi.fn<Execute>();

    await expectCommandError(
      () => runPackageReleaseCommand(args, { execute, repositoryRoot }),
      "parse release command",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects ambiguous pack output and removes the temporary workspace", async () => {
    const repositoryRoot = await temporaryRoot();
    const archive = Buffer.from("exact preview archive");
    const execute: Execute = async (_command, args) => {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing pack destination");
      await writeFile(join(destination, "first.tgz"), archive);
      await writeFile(join(destination, "second.tgz"), archive);
      return { stdout: JSON.stringify([packReportFixture(archive)]) };
    };

    await expectCommandError(() =>
      runPackageReleaseCommand(["--output", "release/package", "--revision", "e".repeat(40)], {
        execute: withCleanSource(execute),
        repositoryRoot,
      }),
    );
    expect(await readdir(repositoryRoot)).toEqual([]);
  });

  it("rejects duplicate pack-report keys and private process failures", async () => {
    const repositoryRoot = await temporaryRoot();
    const archive = Buffer.from("exact preview archive");
    const duplicate: Execute = async (_command, args) => {
      const destination = args.at(-1);
      if (destination === undefined) throw new Error("missing pack destination");
      await writeFile(join(destination, "synaptiai-flow-harness-0.1.0-alpha.1.tgz"), archive);
      const report = JSON.stringify([packReportFixture(archive)]).replace(
        '"name":"@synaptiai/flow-harness"',
        '"name":"@synaptiai/flow-harness","name":"PRIVATE_PACKAGE"',
      );
      return { stdout: report };
    };
    await expectCommandError(() =>
      runPackageReleaseCommand(["--output", "release/package", "--revision", "e".repeat(40)], {
        execute: withCleanSource(duplicate),
        repositoryRoot,
      }),
    );

    await expectCommandError(() =>
      runPackageReleaseCommand(["--output", "release/package", "--revision", "e".repeat(40)], {
        execute: withCleanSource(async () => Promise.reject("PRIVATE_PROCESS_FAILURE")),
        repositoryRoot,
      }),
    );
  });

  it.each([
    ["a different revision", `${"f".repeat(40)}\n`, ""],
    ["a dirty source tree", `${"e".repeat(40)}\n`, "?? PRIVATE_FILE\n"],
  ])("rejects %s before npm pack", async (_label, head, status) => {
    const repositoryRoot = await temporaryRoot();
    const execute = vi.fn<Execute>(async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { stdout: head };
      if (command === "git" && args[0] === "status") return { stdout: status };
      throw new Error("npm must not run");
    });

    await expectCommandError(
      () =>
        runPackageReleaseCommand(["--output", "release/package", "--revision", "e".repeat(40)], {
          execute,
          repositoryRoot,
        }),
      "inspect release source",
    );
    expect(execute.mock.calls.some(([command]) => command === "npm")).toBe(false);
  });

  it.each([
    ["the revision changes", `${"f".repeat(40)}\n`, ""],
    ["the source becomes dirty", `${"e".repeat(40)}\n`, "?? PRIVATE_AFTER_PACK\n"],
  ])(
    "rejects when %s after npm pack and before publication",
    async (_label, finalHead, finalStatus) => {
      const repositoryRoot = await temporaryRoot();
      const archive = Buffer.from("exact preview archive");
      let sourceInspection = 0;
      const execute = vi.fn<Execute>(async (command, args) => {
        if (command === "git" && args[0] === "rev-parse") {
          sourceInspection += 1;
          return { stdout: sourceInspection === 1 ? `${"e".repeat(40)}\n` : finalHead };
        }
        if (command === "git" && args[0] === "status") {
          return { stdout: sourceInspection === 1 ? "" : finalStatus };
        }
        const destination = args.at(-1);
        if (destination === undefined) throw new Error("missing pack destination");
        await writeFile(join(destination, "synaptiai-flow-harness-0.1.0-alpha.1.tgz"), archive);
        return { stdout: JSON.stringify([packReportFixture(archive)]) };
      });

      await expectCommandError(
        () =>
          runPackageReleaseCommand(["--output", "release/package", "--revision", "e".repeat(40)], {
            execute,
            repositoryRoot,
          }),
        "inspect release source",
      );
      expect(execute.mock.calls.filter(([command]) => command === "npm")).toHaveLength(1);
      expect(await readdir(repositoryRoot)).toEqual([]);
    },
  );
});

interface ExecuteOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv & { readonly npm_config_cache: string };
  readonly maxBuffer: number;
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

type Execute = (
  command: string,
  args: readonly string[],
  options: ExecuteOptions,
) => Promise<{ readonly stdout: string }>;

function withCleanSource(executeNpm: Execute): Execute {
  return async (command, args, options) => {
    if (command === "git" && args[0] === "rev-parse") {
      return { stdout: `${"e".repeat(40)}\n` };
    }
    if (command === "git" && args[0] === "status") {
      return { stdout: "" };
    }
    return await executeNpm(command, args, options);
  };
}

function packReportFixture(archive: Buffer): object {
  const files = [
    { path: "LICENSE", size: 1, mode: 0o644 },
    { path: "README.md", size: 2, mode: 0o644 },
    { path: "SECURITY.md", size: 3, mode: 0o644 },
    { path: "SUPPORT.md", size: 4, mode: 0o644 },
    { path: "THIRD_PARTY_NOTICES.md", size: 5, mode: 0o644 },
    { path: "npm-shrinkwrap.json", size: 6, mode: 0o644 },
    { path: "dist/cli/launcher.js", size: 7, mode: 0o644 },
    { path: "examples/verify-foundation.workflow.yaml", size: 8, mode: 0o644 },
    { path: "package.json", size: 9, mode: 0o644 },
  ];
  return {
    id: "@synaptiai/flow-harness@0.1.0-alpha.1",
    name: "@synaptiai/flow-harness",
    version: "0.1.0-alpha.1",
    size: archive.byteLength,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    shasum: createHash("sha1").update(archive).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    filename: "synaptiai-flow-harness-0.1.0-alpha.1.tgz",
    files,
    entryCount: files.length,
    bundled: [],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-release-command-test-"));
  roots.push(root);
  return root;
}

async function expectCommandError(
  operation: () => Promise<unknown>,
  stage = "build package artifact",
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageReleaseCommandError);
    expect(error).toMatchObject({ message: `Package release failed during ${stage}` });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE");
    return;
  }
  throw new Error("expected package release command to fail");
}
