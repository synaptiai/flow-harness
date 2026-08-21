import { describe, expect, it } from "vitest";

import {
  encodePackageReleaseEvidence,
  FLOW_PACKAGE_NAME,
  FLOW_PACKAGE_REPOSITORY,
  MAX_PACKAGE_RELEASE_ARCHIVE_BYTES,
  MAX_PACKAGE_RELEASE_EVIDENCE_BYTES,
  MAX_PACKAGE_RELEASE_FILES,
  MAX_PACKAGE_RELEASE_PATH_BYTES,
  MAX_PACKAGE_RELEASE_UNPACKED_BYTES,
  PackageReleaseEvidenceError,
  type PackageReleaseEvidenceInput,
  parsePackageReleaseEvidence,
} from "../../../src/domain/release/package-release-evidence.js";

describe("package release evidence", () => {
  it("round-trips one canonical complete package identity", () => {
    const input = evidenceFixture();
    const encoded = encodePackageReleaseEvidence(input);
    const parsed = parsePackageReleaseEvidence(encoded);

    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.files)).toBe(true);
    expect(encoded.at(-1)).not.toBe(0x0a);
  });

  it.each([
    ["archive bytes", "archive", MAX_PACKAGE_RELEASE_ARCHIVE_BYTES],
    ["unpacked bytes", "unpacked", MAX_PACKAGE_RELEASE_UNPACKED_BYTES],
  ] as const)("accepts the exact %s limit and rejects one byte more", (_label, kind, limit) => {
    const exact = withMeasuredBytes(evidenceFixture(), kind, limit);
    expect(parsePackageReleaseEvidence(encodePackageReleaseEvidence(exact))).toEqual(exact);

    expectReleaseError(() =>
      encodePackageReleaseEvidence(withMeasuredBytes(exact, kind, limit + 1)),
    );
  });

  it("accepts the exact file-count limit and rejects one more entry", () => {
    const exact = withGeneratedFiles(evidenceFixture(), MAX_PACKAGE_RELEASE_FILES);
    expect(parsePackageReleaseEvidence(encodePackageReleaseEvidence(exact))).toEqual(exact);

    expectReleaseError(() =>
      encodePackageReleaseEvidence(
        withGeneratedFiles(evidenceFixture(), MAX_PACKAGE_RELEASE_FILES + 1),
      ),
    );
  });

  it("counts portable paths in UTF-8 bytes at the exact boundary", () => {
    const exactPath = `docs/a${"é".repeat(509)}`;
    expect(Buffer.byteLength(exactPath, "utf8")).toBe(MAX_PACKAGE_RELEASE_PATH_BYTES);
    const exact = withAdditionalFile(evidenceFixture(), exactPath);
    expect(parsePackageReleaseEvidence(encodePackageReleaseEvidence(exact))).toEqual(exact);

    const tooLongPath = `${exactPath}b`;
    expect(Buffer.byteLength(tooLongPath, "utf8")).toBe(MAX_PACKAGE_RELEASE_PATH_BYTES + 1);
    expectReleaseError(() =>
      encodePackageReleaseEvidence(withAdditionalFile(evidenceFixture(), tooLongPath)),
    );
  });

  it.each([
    "/absolute",
    "../escape",
    "docs//empty",
    "docs/./dot",
    "docs/../parent",
    "docs\\windows",
    "docs/control\u0000",
    "unowned/file.txt",
  ])("rejects an unsafe or unowned package path without disclosing it: %s", (path) => {
    expectReleaseError(
      () => encodePackageReleaseEvidence(withAdditionalFile(evidenceFixture(), path)),
      path,
    );
  });

  it.each([
    ["a duplicate path", duplicateFirstFile],
    [
      "an unsorted path list",
      (value: PackageReleaseEvidenceInput) => ({ ...value, files: [...value.files].reverse() }),
    ],
    [
      "a missing required file",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        files: value.files.filter((file) => file.path !== "LICENSE"),
      }),
    ],
    [
      "a mismatched entry count",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        archive: { ...value.archive, entryCount: value.archive.entryCount + 1 },
      }),
    ],
    [
      "a mismatched unpacked size",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        archive: { ...value.archive, unpackedBytes: value.archive.unpackedBytes + 1 },
      }),
    ],
    [
      "a mismatched archive name",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        archive: { ...value.archive, fileName: "PRIVATE.tgz" },
      }),
    ],
    [
      "a noncanonical file mode",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        files: value.files.map((file, index) => (index === 0 ? { ...file, mode: 0o777 } : file)),
      }),
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    expectReleaseError(() => encodeUnsafe(mutate(evidenceFixture())));
  });

  it.each([
    [
      "wrong package",
      (value: PackageReleaseEvidenceInput) => ({ ...value, packageName: "PRIVATE/package" }),
    ],
    [
      "wrong repository",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        sourceRepository: "https://PRIVATE.invalid/repository",
      }),
    ],
    [
      "invalid revision",
      (value: PackageReleaseEvidenceInput) => ({ ...value, sourceRevision: "PRIVATE_REVISION" }),
    ],
    [
      "invalid version",
      (value: PackageReleaseEvidenceInput) => ({ ...value, packageVersion: "01.0.0" }),
    ],
    [
      "invalid digest",
      (value: PackageReleaseEvidenceInput) => ({
        ...value,
        archive: { ...value.archive, sha512: "PRIVATE_DIGEST" },
      }),
    ],
  ] as const)("rejects %s with a value-free error", (_label, mutate) => {
    expectReleaseError(() => encodeUnsafe(mutate(evidenceFixture())), "PRIVATE");
  });

  it("rejects duplicate keys, noncanonical JSON, and oversized input", () => {
    const encoded = encodePackageReleaseEvidence(evidenceFixture());
    const duplicate = Buffer.from(
      encoded
        .toString("utf8")
        .replace(
          '"apiVersion":"flow.synapti.ai/v1alpha1"',
          '"apiVersion":"flow.synapti.ai/v1alpha1","apiVersion":"PRIVATE"',
        ),
    );
    expectReleaseError(() => parsePackageReleaseEvidence(duplicate), "PRIVATE", "parse evidence");
    expectReleaseError(
      () => parsePackageReleaseEvidence(Buffer.concat([encoded, Buffer.from("\n")])),
      undefined,
      "validate evidence",
    );
    expectReleaseError(
      () => parsePackageReleaseEvidence(Buffer.alloc(MAX_PACKAGE_RELEASE_EVIDENCE_BYTES + 1, 0x20)),
      undefined,
      "parse evidence",
    );
  });
});

function evidenceFixture(): PackageReleaseEvidenceInput {
  const files = sortFiles([
    { path: "LICENSE", bytes: 1, mode: 0o644 },
    { path: "README.md", bytes: 2, mode: 0o644 },
    { path: "SECURITY.md", bytes: 3, mode: 0o644 },
    { path: "SUPPORT.md", bytes: 4, mode: 0o644 },
    { path: "THIRD_PARTY_NOTICES.md", bytes: 5, mode: 0o644 },
    { path: "npm-shrinkwrap.json", bytes: 6, mode: 0o644 },
    { path: "dist/cli/launcher.js", bytes: 7, mode: 0o644 },
    { path: "examples/verify-foundation.workflow.yaml", bytes: 8, mode: 0o644 },
    { path: "package.json", bytes: 9, mode: 0o644 },
  ]);
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PackageReleaseEvidence",
    packageName: FLOW_PACKAGE_NAME,
    packageVersion: "0.1.0-alpha.1",
    sourceRepository: FLOW_PACKAGE_REPOSITORY,
    sourceRevision: "a".repeat(40),
    archive: {
      fileName: "synaptiai-flow-harness-0.1.0-alpha.1.tgz",
      bytes: 128,
      unpackedBytes: sumFileBytes(files),
      entryCount: files.length,
      sha512: "b".repeat(128),
    },
    files,
  };
}

function withMeasuredBytes(
  input: PackageReleaseEvidenceInput,
  kind: "archive" | "unpacked",
  bytes: number,
): PackageReleaseEvidenceInput {
  if (kind === "archive") {
    return { ...input, archive: { ...input.archive, bytes } };
  }
  const files = input.files.map((file, index) =>
    index === 0 ? { ...file, bytes: bytes - sumFileBytes(input.files.slice(1)) } : file,
  );
  return { ...input, archive: { ...input.archive, unpackedBytes: bytes }, files };
}

function withGeneratedFiles(
  input: PackageReleaseEvidenceInput,
  count: number,
): PackageReleaseEvidenceInput {
  const files = [...input.files];
  for (let index = files.length; index < count; index += 1) {
    files.push({
      path: `docs/generated/${String(index).padStart(5, "0")}.txt`,
      bytes: 1,
      mode: 0o644,
    });
  }
  const sorted = sortFiles(files);
  return {
    ...input,
    archive: { ...input.archive, entryCount: sorted.length, unpackedBytes: sumFileBytes(sorted) },
    files: sorted,
  };
}

function withAdditionalFile(
  input: PackageReleaseEvidenceInput,
  path: string,
): PackageReleaseEvidenceInput {
  const files = sortFiles([...input.files, { path, bytes: 1, mode: 0o644 }]);
  return {
    ...input,
    archive: { ...input.archive, entryCount: files.length, unpackedBytes: sumFileBytes(files) },
    files,
  };
}

function sortFiles(
  files: PackageReleaseEvidenceInput["files"],
): PackageReleaseEvidenceInput["files"] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function sumFileBytes(files: PackageReleaseEvidenceInput["files"]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

function expectReleaseError(
  operation: () => unknown,
  privateCanary?: string,
  stage = "validate evidence",
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageReleaseEvidenceError);
    expect(error).toMatchObject({ message: `Package release failed during ${stage}` });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (privateCanary !== undefined) {
      expect((error as Error).message).not.toContain(privateCanary);
    }
    return;
  }
  throw new Error("expected package release evidence to fail");
}

function encodeUnsafe(input: unknown): Buffer {
  return encodePackageReleaseEvidence(input as PackageReleaseEvidenceInput);
}

function duplicateFirstFile(value: PackageReleaseEvidenceInput): PackageReleaseEvidenceInput {
  const first = value.files[0];
  if (first === undefined) {
    throw new Error("test fixture must contain a package file");
  }
  return { ...value, files: [...value.files, first] };
}
