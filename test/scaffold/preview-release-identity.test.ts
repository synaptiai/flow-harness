import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const resolverPath = fileURLToPath(
  new URL("../../scripts/resolve-preview-release-identity.mjs", import.meta.url),
);
const fixtureRoots: string[] = [];

describe("preview release identity", () => {
  afterEach(async () => {
    await Promise.all(
      fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("derives every public name from the reviewed package manifest", async () => {
    const root = await createFixture();

    const jsonResult = await runResolver(root);
    expect(jsonResult).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify(
        {
          packageName: "@synaptiai/flow-harness",
          packageVersion: "0.1.0-alpha.2",
          releaseTag: "v0.1.0-alpha.2",
          archiveName: "synaptiai-flow-harness-0.1.0-alpha.2.tgz",
          attestationName: "flow-harness-0.1.0-alpha.2.intoto.jsonl",
          releaseTitle: "Flow 0.1.0-alpha.2",
          releaseNotesPath: "docs/releases/0.1.0-alpha.2.md",
          npmDistTag: "preview",
        },
        undefined,
        2,
      )}\n`,
    });

    const outputResult = await runResolver(root, ["--github-output"]);
    expect(outputResult).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        "package-name=@synaptiai/flow-harness",
        "package-version=0.1.0-alpha.2",
        "release-tag=v0.1.0-alpha.2",
        "archive-name=synaptiai-flow-harness-0.1.0-alpha.2.tgz",
        "attestation-name=flow-harness-0.1.0-alpha.2.intoto.jsonl",
        "release-title=Flow 0.1.0-alpha.2",
        "release-notes-path=docs/releases/0.1.0-alpha.2.md",
        "npm-dist-tag=preview",
        "",
      ].join("\n"),
    });
  });

  it.each([
    ["top-level shrinkwrap version", { shrinkwrapVersion: "0.1.0-alpha.1" }],
    ["installed-root shrinkwrap version", { rootVersion: "0.1.0-alpha.1" }],
    ["installed-root package name", { rootName: "@example/other" }],
  ] as const)("rejects a mismatched %s", async (_label, options) => {
    const root = await createFixture(options);

    const result = await runResolver(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("doesn't match package.json");
  });

  it("rejects an unsupported package identity before producing outputs", async () => {
    const root = await createFixture({
      packageName: "@example/flow-harness",
      rootName: "@example/flow-harness",
      shrinkwrapName: "@example/flow-harness",
    });

    const result = await runResolver(root, ["--github-output"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Preview release package name is unsupported.\n",
    });
  });

  it.each(["0.1.0", "0.1.0-alpha.02", "0.2.0-alpha.1", "0.1.0-beta.1"])(
    "rejects unsupported prerelease version %s",
    async (version) => {
      const root = await createFixture({
        version,
        shrinkwrapVersion: version,
        rootVersion: version,
      });

      const result = await runResolver(root);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Preview release version is unsupported.\n");
    },
  );

  it("rejects release notes whose heading doesn't match the manifest", async () => {
    const root = await createFixture({
      notes: "# Flow 0.1.0-alpha.1 release notes\n\nStale release notes.\n",
    });

    const result = await runResolver(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Preview release notes heading doesn't match package.json.\n");
  });

  it("rejects linked release metadata", async () => {
    const root = await createFixture();
    const notesPath = join(root, "docs", "releases", "0.1.0-alpha.2.md");
    const targetPath = join(root, "notes-target.md");
    await writeFile(targetPath, "# Flow 0.1.0-alpha.2 release notes\n", "utf8");
    await rm(notesPath);
    await symlink(targetPath, notesPath);

    const result = await runResolver(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "Preview release metadata must be a regular file without symbolic links.\n",
    );
  });

  it("rejects oversized release metadata", async () => {
    const root = await createFixture({
      notes: `# Flow 0.1.0-alpha.2 release notes\n${"x".repeat(300_000)}`,
    });

    const result = await runResolver(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Preview release metadata exceeds its byte limit.\n");
  });
});

interface FixtureOptions {
  readonly notes?: string;
  readonly packageName?: string;
  readonly rootName?: string;
  readonly rootVersion?: string;
  readonly shrinkwrapName?: string;
  readonly shrinkwrapVersion?: string;
  readonly version?: string;
}

async function createFixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-preview-identity-"));
  fixtureRoots.push(root);
  const packageName = options.packageName ?? "@synaptiai/flow-harness";
  const version = options.version ?? "0.1.0-alpha.2";
  const releaseDirectory = join(root, "docs", "releases");
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: packageName, version }, undefined, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(root, "npm-shrinkwrap.json"),
      `${JSON.stringify(
        {
          name: options.shrinkwrapName ?? packageName,
          version: options.shrinkwrapVersion ?? version,
          lockfileVersion: 3,
          packages: {
            "": {
              name: options.rootName ?? packageName,
              version: options.rootVersion ?? version,
            },
          },
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      join(releaseDirectory, `${version}.md`),
      options.notes ?? `# Flow ${version} release notes\n\nCheckpoint notes.\n`,
      "utf8",
    ),
  ]);
  return root;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runResolver(root: string, args: readonly string[] = []): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [resolverPath, "--root", root, ...args],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}
