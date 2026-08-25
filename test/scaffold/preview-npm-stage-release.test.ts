import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const verifierPath = fileURLToPath(
  new URL("../../scripts/verify-preview-npm-release.mjs", import.meta.url),
);
const roots: string[] = [];
const revision = "a".repeat(40);
const notes = "# Flow 0.1.0-alpha.4 release notes\n\nVerified checkpoint.\n";
const archiveName = "synapti-flow-harness-0.1.0-alpha.4.tgz";
const attestationName = "flow-harness-0.1.0-alpha.4.intoto.jsonl";

describe("preview npm stage release verification", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("accepts one immutable prerelease with exact names, target, notes, and assets", async () => {
    const root = await createFixture(releaseFixture());

    await expect(runVerifier(root)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Verified immutable preview release v0.1.0-alpha.4 at ${revision}.\n`,
    });
  });

  it.each([
    ["draft release", { isDraft: true }],
    ["mutable release", { isImmutable: false }],
    ["non-prerelease", { isPrerelease: false }],
    ["wrong tag", { tagName: "v0.1.0-alpha.5" }],
    ["wrong title", { name: "Flow private release" }],
    ["wrong target", { targetCommitish: "b".repeat(40) }],
    ["missing publication", { publishedAt: null }],
    ["wrong notes", { body: "Different notes." }],
    ["extra asset", { assets: [...releaseFixture().assets, { name: "extra.txt", size: 1 }] }],
    [
      "empty asset",
      { assets: [{ name: archiveName, size: 0 }, ...releaseFixture().assets.slice(1)] },
    ],
  ] as const)("rejects a %s", async (_label, change) => {
    const root = await createFixture({ ...releaseFixture(), ...change });

    await expect(runVerifier(root)).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Preview npm stage release record is invalid.\n",
    });
  });

  it("rejects a linked release record", async () => {
    const root = await createFixture(releaseFixture());
    const record = join(root, "release.json");
    const target = join(root, "release-target.json");
    await writeFile(target, `${JSON.stringify(releaseFixture())}\n`, "utf8");
    await rm(record);
    await symlink(target, record);

    await expect(runVerifier(root)).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "Preview npm stage release record is invalid.\n",
    });
  });

  it("rejects an oversized release record", async () => {
    const root = await createFixture(releaseFixture());
    await writeFile(
      join(root, "release.json"),
      `${JSON.stringify({ ...releaseFixture(), padding: "x".repeat(1024 * 1024) })}\n`,
      "utf8",
    );

    await expect(runVerifier(root)).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "Preview npm stage release record is invalid.\n",
    });
  });
});

function releaseFixture() {
  return {
    tagName: "v0.1.0-alpha.4",
    name: "Flow 0.1.0-alpha.4",
    body: notes,
    isDraft: false,
    isImmutable: true,
    isPrerelease: true,
    publishedAt: "2026-08-25T20:00:00Z",
    targetCommitish: revision,
    assets: [
      { name: archiveName, size: 100 },
      { name: "package-release-evidence.json", size: 200 },
      { name: attestationName, size: 300 },
    ],
  };
}

async function createFixture(release: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-preview-npm-release-"));
  roots.push(root);
  await Promise.all([
    writeFile(join(root, "release.json"), `${JSON.stringify(release)}\n`, "utf8"),
    writeFile(join(root, "release-notes.md"), notes, "utf8"),
  ]);
  return root;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runVerifier(root: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        verifierPath,
        "--release-json",
        join(root, "release.json"),
        "--release-notes",
        join(root, "release-notes.md"),
        "--expected-tag",
        "v0.1.0-alpha.4",
        "--expected-title",
        "Flow 0.1.0-alpha.4",
        "--expected-archive",
        archiveName,
        "--expected-attestation",
        attestationName,
        "--expected-revision",
        revision,
      ],
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
