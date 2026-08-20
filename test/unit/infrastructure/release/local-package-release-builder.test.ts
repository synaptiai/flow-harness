import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parsePackageReleaseEvidence } from "../../../../src/domain/release/package-release-evidence.js";
import {
  buildLocalPackageRelease,
  LocalPackageReleaseBuilderError,
} from "../../../../src/infrastructure/release/local-package-release-builder.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local package release builder", () => {
  it("publishes one settled archive and canonical evidence directory", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    const archive = Buffer.from("exact preview archive");

    const result = await buildLocalPackageRelease(
      { outputDirectory, sourceRevision: "d".repeat(40) },
      {
        buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }),
        beforeCommit: async () => {
          await expect(stat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        },
      },
    );

    expect(result).toEqual({
      archivePath: join(outputDirectory, "synaptiai-flow-harness-0.1.0-alpha.1.tgz"),
      evidencePath: join(outputDirectory, "package-release-evidence.json"),
      settlement: "created",
    });
    expect((await readdir(outputDirectory)).sort()).toEqual([
      "package-release-evidence.json",
      "synaptiai-flow-harness-0.1.0-alpha.1.tgz",
    ]);
    expect(await readFile(result.archivePath)).toEqual(archive);
    expect(parsePackageReleaseEvidence(await readFile(result.evidencePath))).toMatchObject({
      sourceRevision: "d".repeat(40),
      archive: { bytes: archive.byteLength },
    });
  });

  it("recognizes an exact retry without replacing the settled directory", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    const archive = Buffer.from("exact preview archive");
    const dependencies = {
      buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }),
    };
    await buildLocalPackageRelease(
      { outputDirectory, sourceRevision: "d".repeat(40) },
      dependencies,
    );
    const before = await stat(outputDirectory, { bigint: true });

    const retried = await buildLocalPackageRelease(
      { outputDirectory, sourceRevision: "d".repeat(40) },
      dependencies,
    );
    const after = await stat(outputDirectory, { bigint: true });

    expect(retried.settlement).toBe("current");
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  });

  it("preserves a conflicting target without replacing its canary", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    await mkdir(outputDirectory);
    const canary = join(outputDirectory, "PRIVATE_CANARY");
    await writeFile(canary, "PRIVATE_CONTENT");
    const archive = Buffer.from("exact preview archive");

    await expectBuilderError(() =>
      buildLocalPackageRelease(
        { outputDirectory, sourceRevision: "d".repeat(40) },
        { buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }) },
      ),
    );
    expect(await readFile(canary, "utf8")).toBe("PRIVATE_CONTENT");
  });

  it("removes private staging after a build or validation failure", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");

    await expectBuilderError(
      () =>
        buildLocalPackageRelease(
          { outputDirectory, sourceRevision: "d".repeat(40) },
          { buildArchive: async () => Promise.reject("PRIVATE_BUILD_FAILURE") },
        ),
      "build package artifact",
    );
    expect(await readdir(root)).toEqual([]);

    const archive = Buffer.from("exact preview archive");
    await expectBuilderError(
      () =>
        buildLocalPackageRelease(
          { outputDirectory, sourceRevision: "d".repeat(40) },
          {
            buildArchive: async () => ({
              archive,
              packOutput: [{ ...packReportFixture(archive), integrity: "PRIVATE_INTEGRITY" }],
            }),
          },
        ),
      "build package artifact",
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a target introduced immediately before commit", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    const archive = Buffer.from("exact preview archive");

    await expectBuilderError(() =>
      buildLocalPackageRelease(
        { outputDirectory, sourceRevision: "d".repeat(40) },
        {
          buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }),
          beforeCommit: async () => {
            await mkdir(outputDirectory);
            await writeFile(join(outputDirectory, "PRIVATE_RACE_CANARY"), "preserved");
          },
        },
      ),
    );
    expect(await readFile(join(outputDirectory, "PRIVATE_RACE_CANARY"), "utf8")).toBe("preserved");
    expect((await readdir(root)).filter((entry) => entry.includes("staging"))).toEqual([]);
  });

  it("stops a cancellation before commit without publishing later state", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    const archive = Buffer.from("exact preview archive");
    const controller = new AbortController();

    await expectBuilderError(() =>
      buildLocalPackageRelease(
        { outputDirectory, sourceRevision: "d".repeat(40), signal: controller.signal },
        {
          buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }),
          beforeCommit: async () => controller.abort("PRIVATE_ABORT_REASON"),
        },
      ),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("reports settlement uncertainty without deleting an already renamed artifact", async () => {
    const root = await temporaryRoot();
    const outputDirectory = join(root, "release");
    const archive = Buffer.from("exact preview archive");

    await expectBuilderError(
      () =>
        buildLocalPackageRelease(
          { outputDirectory, sourceRevision: "d".repeat(40) },
          {
            buildArchive: async () => ({ archive, packOutput: [packReportFixture(archive)] }),
            syncDirectory: async (directory) => {
              if (directory === root) {
                throw new Error("PRIVATE_SYNC_FAILURE");
              }
            },
          },
        ),
      "settle package artifact",
    );
    expect(
      await readFile(join(outputDirectory, "synaptiai-flow-harness-0.1.0-alpha.1.tgz")),
    ).toEqual(archive);
  });
});

interface PackReport {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly shasum: string;
  readonly integrity: string;
  readonly filename: string;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly mode: number;
  }[];
  readonly entryCount: number;
  readonly bundled: readonly string[];
}

function packReportFixture(archive: Buffer): PackReport {
  const files = [
    { path: "LICENSE", size: 1, mode: 0o644 },
    { path: "README.md", size: 2, mode: 0o644 },
    { path: "SECURITY.md", size: 3, mode: 0o644 },
    { path: "SUPPORT.md", size: 4, mode: 0o644 },
    { path: "THIRD_PARTY_NOTICES.md", size: 5, mode: 0o644 },
    { path: "dist/cli/launcher.js", size: 6, mode: 0o644 },
    { path: "examples/verify-foundation.workflow.yaml", size: 7, mode: 0o644 },
    { path: "package.json", size: 8, mode: 0o644 },
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
  const root = await mkdtemp(join(tmpdir(), "flow-release-builder-test-"));
  roots.push(root);
  return root;
}

async function expectBuilderError(
  operation: () => Promise<unknown>,
  stage = "publish package artifact",
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalPackageReleaseBuilderError);
    expect(error).toMatchObject({ message: `Package release failed during ${stage}` });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE");
    return;
  }
  throw new Error("expected local package release builder to fail");
}
