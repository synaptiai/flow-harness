import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  encodePackageReleaseEvidence,
  FLOW_PACKAGE_NAME,
  FLOW_PACKAGE_REPOSITORY,
  type PackageReleaseEvidence,
  type PackageReleaseEvidenceFile,
} from "../../../../src/domain/release/package-release-evidence.js";
import {
  PackageReleaseVerificationError,
  verifyInstalledPackageRelease,
  verifyPackageReleaseArtifact,
} from "../../../../src/infrastructure/release/package-release-verifier.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package release verification", () => {
  it("accepts only evidence that binds the expected revision and archive bytes", () => {
    const archive = Buffer.from("exact preview archive");
    const evidenceBytes = evidenceFixture(archive).encoded;

    const evidence = verifyPackageReleaseArtifact({
      archive,
      evidenceBytes,
      expectedSourceRevision: "f".repeat(40),
    });

    expect(evidence).toMatchObject({
      packageVersion: "0.1.0-alpha.1",
      sourceRevision: "f".repeat(40),
      archive: { sha512: createHash("sha512").update(archive).digest("hex") },
    });
  });

  it.each([
    [
      "changed archive bytes",
      (archive: Buffer, encoded: Buffer) => ({
        archive: Buffer.concat([archive, Buffer.from("PRIVATE")]),
        evidenceBytes: encoded,
        revision: "f".repeat(40),
      }),
    ],
    [
      "changed evidence",
      (archive: Buffer, encoded: Buffer) => ({
        archive,
        evidenceBytes: Buffer.concat([encoded, Buffer.from("\n")]),
        revision: "f".repeat(40),
      }),
    ],
    [
      "wrong source revision",
      (archive: Buffer, encoded: Buffer) => ({
        archive,
        evidenceBytes: encoded,
        revision: "0".repeat(40),
      }),
    ],
  ] as const)("rejects %s with a fixed error", (_label, mutate) => {
    const archive = Buffer.from("exact preview archive");
    const input = mutate(archive, evidenceFixture(archive).encoded);
    expectVerificationError(
      () =>
        verifyPackageReleaseArtifact({
          archive: input.archive,
          evidenceBytes: input.evidenceBytes,
          expectedSourceRevision: input.revision,
        }),
      "verify package archive",
    );
  });

  it("accepts an exact installed package tree and public manifest", async () => {
    const root = await temporaryRoot();
    const fixture = evidenceFixture(Buffer.from("exact preview archive"));
    await writeInstalledFixture(root, fixture.contents);

    await expect(verifyInstalledPackageRelease(root, fixture.evidence)).resolves.toBeUndefined();
  });

  it.each([
    ["a missing file", async (root: string) => rm(join(root, "LICENSE"))],
    ["an extra file", async (root: string) => writeFile(join(root, "PRIVATE_EXTRA"), "PRIVATE")],
    [
      "changed file bytes",
      async (root: string) => writeFile(join(root, "README.md"), "PRIVATE_CHANGED"),
    ],
    [
      "an empty directory",
      async (root: string) => mkdir(join(root, "docs", "PRIVATE_EMPTY"), { recursive: true }),
    ],
    [
      "a symbolic-link file",
      async (root: string) => {
        await rm(join(root, "LICENSE"));
        await symlink("README.md", join(root, "LICENSE"));
      },
    ],
    ["a changed file mode", async (root: string) => chmod(join(root, "README.md"), 0o600)],
  ] as const)("rejects an installed tree with %s", async (_label, mutate) => {
    const root = await temporaryRoot();
    const fixture = evidenceFixture(Buffer.from("exact preview archive"));
    await writeInstalledFixture(root, fixture.contents);
    await mutate(root);

    await expectVerificationError(
      () => verifyInstalledPackageRelease(root, fixture.evidence),
      "verify installed package",
    );
  });

  it.each([
    ["name", "PRIVATE_PACKAGE"],
    ["version", "9.9.9-PRIVATE"],
    ["bin", { flow: "PRIVATE.js" }],
    ["engines", { node: ">=1" }],
    ["os", ["PRIVATE_OS"]],
    ["publishConfig", { access: "restricted" }],
  ] as const)("rejects a changed installed manifest field: %s", async (field, value) => {
    const root = await temporaryRoot();
    const archive = Buffer.from("exact preview archive");
    const manifest = { ...packageManifestFixture(), [field]: value };
    const fixture = evidenceFixture(archive, manifest);
    await writeInstalledFixture(root, fixture.contents);

    await expectVerificationError(
      () => verifyInstalledPackageRelease(root, fixture.evidence),
      "verify installed package",
    );
  });
});

function evidenceFixture(
  archive: Buffer,
  manifest: Record<string, unknown> = packageManifestFixture(),
): {
  readonly contents: ReadonlyMap<string, Buffer>;
  readonly encoded: Buffer;
  readonly evidence: PackageReleaseEvidence;
} {
  const contents = new Map<string, Buffer>([
    ["LICENSE", Buffer.from("license")],
    ["README.md", Buffer.from("readme")],
    ["SECURITY.md", Buffer.from("security")],
    ["SUPPORT.md", Buffer.from("support")],
    ["THIRD_PARTY_NOTICES.md", Buffer.from("notices")],
    ["npm-shrinkwrap.json", Buffer.from("shrinkwrap")],
    ["dist/cli/launcher.js", Buffer.from("launcher")],
    ["examples/verify-foundation.workflow.yaml", Buffer.from("workflow")],
    ["package.json", Buffer.from(JSON.stringify(manifest))],
  ]);
  const files = [...contents.entries()]
    .map(
      ([path, content]): PackageReleaseEvidenceFile => ({
        path,
        bytes: content.byteLength,
        mode: 0o644,
      }),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const encoded = encodePackageReleaseEvidence({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PackageReleaseEvidence",
    packageName: FLOW_PACKAGE_NAME,
    packageVersion: "0.1.0-alpha.1",
    sourceRepository: FLOW_PACKAGE_REPOSITORY,
    sourceRevision: "f".repeat(40),
    archive: {
      fileName: "synapti-flow-harness-0.1.0-alpha.1.tgz",
      bytes: archive.byteLength,
      unpackedBytes: files.reduce((total, file) => total + file.bytes, 0),
      entryCount: files.length,
      sha512: createHash("sha512").update(archive).digest("hex"),
    },
    files,
  });
  return {
    contents,
    encoded,
    evidence: verifyPackageReleaseArtifact({
      archive,
      evidenceBytes: encoded,
      expectedSourceRevision: "f".repeat(40),
    }),
  };
}

function packageManifestFixture(): Record<string, unknown> {
  return {
    name: "@synapti/flow-harness",
    version: "0.1.0-alpha.1",
    bin: { flow: "dist/cli/launcher.js" },
    engines: { node: ">=26.7.0" },
    os: ["darwin", "linux"],
    publishConfig: { access: "public" },
  };
}

async function writeInstalledFixture(
  root: string,
  contents: ReadonlyMap<string, Buffer>,
): Promise<void> {
  for (const [path, content] of contents) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await chmod(join(root, "dist", "cli", "launcher.js"), 0o777 & ~process.umask());
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-release-verifier-test-"));
  roots.push(root);
  return root;
}

async function expectVerificationError(
  operation: () => unknown | Promise<unknown>,
  stage: "verify package archive" | "verify installed package",
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PackageReleaseVerificationError);
    expect(error).toMatchObject({ message: `Package release failed during ${stage}` });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE");
    return;
  }
  throw new Error("expected package release verification to fail");
}
