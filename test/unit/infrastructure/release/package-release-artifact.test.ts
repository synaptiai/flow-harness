import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  FLOW_PACKAGE_NAME,
  parsePackageReleaseEvidence,
} from "../../../../src/domain/release/package-release-evidence.js";
import {
  PackageReleaseArtifactError,
  preparePackageReleaseEvidence,
} from "../../../../src/infrastructure/release/package-release-artifact.js";

describe("package release artifact preparation", () => {
  it("binds one npm pack report to the exact archive bytes and source revision", () => {
    const archive = Buffer.from("exact preview archive");
    const report = packReportFixture(archive);

    const encoded = preparePackageReleaseEvidence({
      archive,
      packOutput: [report],
      sourceRevision: "c".repeat(40),
    });
    const evidence = parsePackageReleaseEvidence(encoded);

    expect(evidence).toMatchObject({
      packageName: FLOW_PACKAGE_NAME,
      packageVersion: report.version,
      sourceRevision: "c".repeat(40),
      archive: {
        fileName: report.filename,
        bytes: archive.byteLength,
        unpackedBytes: report.unpackedSize,
        entryCount: report.entryCount,
        sha512: createHash("sha512").update(archive).digest("hex"),
      },
      files: [...report.files]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((file) => ({
          path: file.path,
          bytes: file.size,
          mode: file.mode,
        })),
    });
  });

  it("canonicalizes npm file order before encoding release evidence", () => {
    const archive = Buffer.from("exact preview archive");
    const report = packReportFixture(archive);
    const encoded = preparePackageReleaseEvidence({
      archive,
      packOutput: [{ ...report, files: [...report.files].reverse() }],
      sourceRevision: "c".repeat(40),
    });

    const paths = parsePackageReleaseEvidence(encoded).files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
  });

  it.each([
    ["zero reports", () => []],
    ["multiple reports", (report: PackReport) => [report, report]],
    ["an unexpected package", (report: PackReport) => [{ ...report, name: "PRIVATE/package" }]],
    ["an inconsistent id", (report: PackReport) => [{ ...report, id: "PRIVATE_ID" }]],
    [
      "an inconsistent archive size",
      (report: PackReport) => [{ ...report, size: report.size + 1 }],
    ],
    ["an inconsistent SHA-1", (report: PackReport) => [{ ...report, shasum: "0".repeat(40) }]],
    [
      "an inconsistent integrity",
      (report: PackReport) => [
        { ...report, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` },
      ],
    ],
    [
      "a bundled dependency",
      (report: PackReport) => [{ ...report, bundled: ["PRIVATE_DEPENDENCY"] }],
    ],
    [
      "an unknown report property",
      (report: PackReport) => [{ ...report, privateValue: "PRIVATE_REPORT" }],
    ],
    [
      "an unknown file property",
      (report: PackReport) => [
        {
          ...report,
          files: report.files.map((file, index) =>
            index === 0 ? { ...file, privateValue: "PRIVATE_FILE" } : file,
          ),
        },
      ],
    ],
  ] as const)("rejects %s with a fixed private error", (_label, mutate) => {
    const archive = Buffer.from("exact preview archive");
    const report = packReportFixture(archive);
    expectArtifactError(() =>
      preparePackageReleaseEvidence({
        archive,
        packOutput: mutate(report),
        sourceRevision: "c".repeat(40),
      }),
    );
  });

  it("rejects an invalid source revision without retaining it as a cause", () => {
    const archive = Buffer.from("exact preview archive");
    expectArtifactError(() =>
      preparePackageReleaseEvidence({
        archive,
        packOutput: [packReportFixture(archive)],
        sourceRevision: "PRIVATE_REVISION",
      }),
    );
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
    { path: "npm-shrinkwrap.json", size: 6, mode: 0o644 },
    { path: "dist/cli/launcher.js", size: 7, mode: 0o644 },
    { path: "examples/verify-foundation.workflow.yaml", size: 8, mode: 0o644 },
    { path: "package.json", size: 9, mode: 0o644 },
  ];
  return {
    id: "@synapti/flow-harness@0.1.0-alpha.1",
    name: "@synapti/flow-harness",
    version: "0.1.0-alpha.1",
    size: archive.byteLength,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    shasum: createHash("sha1").update(archive).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    filename: "synapti-flow-harness-0.1.0-alpha.1.tgz",
    files,
    entryCount: files.length,
    bundled: [],
  };
}

function expectArtifactError(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageReleaseArtifactError);
    expect(error).toMatchObject({
      message: "Package release failed during inspect packed artifact",
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE");
    return;
  }
  throw new Error("expected packed artifact inspection to fail");
}
