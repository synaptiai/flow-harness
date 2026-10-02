import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { OwnedTestScope } from "../../fixtures/owned-test-scope.js";
import { ownedTest } from "../../fixtures/owned-test-scope.js";

const foundation = fileURLToPath(
  new URL("../../../native/verification-observer/", import.meta.url),
);
const execFile = promisify(execFileCallback);

it(
  "rejects altered upstream C bytes even when source metadata still looks valid",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    await writeFile(join(root, "upstream/apply-seccomp.c"), "altered source\n");
    await expect(checkSources(root)).rejects.toThrow("source integrity");
  }),
);

async function checkSources(root: string): Promise<void> {
  await command("--check-sources", root);
}

async function command(...args: string[]) {
  const result = await execFile(process.execPath, [join(foundation, "build.mjs"), ...args], {
    timeout: 3_000,
    maxBuffer: 65_536,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function copySources(scope: OwnedTestScope) {
  const root = await scope.temporaryDirectory("flow-native-source-");
  await mkdir(join(root, "upstream"));
  await copyFile(join(foundation, "source-manifest.json"), join(root, "source-manifest.json"));
  for (const name of ["apply-seccomp.c", "seccomp-unix-block.c", "LICENSE"])
    await copyFile(join(foundation, "upstream", name), join(root, "upstream", name));
  for (const name of ["Dockerfile", "build.sh"])
    await copyFile(join(foundation, name), join(root, name));
  return root;
}

it(
  "binds frozen context evidence to the copied bytes after the original recipe changes",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    const parent = await scope.temporaryDirectory("flow-native-freeze-");
    const context = join(parent, "context");
    const expected = await readFile(join(root, "Dockerfile"));
    const result = await command("--freeze-context", root, context);
    await writeFile(join(root, "Dockerfile"), "changed after freezing\n");
    expect(await readFile(join(context, "Dockerfile"))).toEqual(expected);
    expect(result.recipe).toMatchObject({
      Dockerfile: createHash("sha256").update(expected).digest("hex"),
      "build.mjs": createHash("sha256")
        .update(await readFile(join(foundation, "build.mjs")))
        .digest("hex"),
    });
    expect(result.sourceManifestSha256).toBe(
      createHash("sha256")
        .update(await readFile(join(context, "source-manifest.json")))
        .digest("hex"),
    );
    expect(result).toMatchObject({ frozenOnly: true, observerQualified: false });
  }),
);

it(
  "rejects unrecorded upstream files before freezing a build context",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    await writeFile(join(root, "upstream/extra.h"), "unrecorded\n");
    await expect(checkSources(root)).rejects.toThrow("upstream inventory");
  }),
);

it("verifies the actual vendored upstream bytes without invoking Docker", async () => {
  expect(await command("--check-sources")).toMatchObject({ verified: true, sourceCount: 3 });
});

it(
  "does not let altered source hashes self-authorize altered upstream code",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    const manifestPath = join(root, "source-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sources: { sha256: string }[];
    };
    const source = manifest.sources[0];
    if (source === undefined) throw new Error("Missing source fixture");
    source.sha256 = "a".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(checkSources(root)).rejects.toThrow("manifest mismatch");
  }),
);

it(
  "rejects changed build provenance before any Docker invocation",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    const manifestPath = join(root, "source-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      build: { baseImage: string };
    };
    manifest.build.baseImage = "debian:latest";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(checkSources(root)).rejects.toThrow("manifest mismatch");
  }),
);

it(
  "rejects a symlink even when it resolves to the exact approved source bytes",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    const path = join(root, "upstream/apply-seccomp.c");
    await rm(path);
    await symlink(join(foundation, "upstream/apply-seccomp.c"), path);
    await expect(checkSources(root)).rejects.toThrow("indirect path");
  }),
);

const artifactNames = [
  "upstream-apply-seccomp",
  "upstream-apply-seccomp.o",
  "unix-block.bpf",
  "unix-block-bpf.h",
  "toolchain.txt",
  "licenses/SRT-LICENSE",
  "licenses/libc-copyright",
  "licenses/libgcc-copyright",
  "licenses/libseccomp-copyright",
  "licenses/LGPL-2.1",
  "licenses/GPL-2",
  "licenses/GPL-3",
  "sources/glibc/glibc_test.dsc",
  "sources/glibc/glibc_test.orig.tar.xz",
];

async function comparisonFixture(scope: OwnedTestScope) {
  const root = await scope.temporaryDirectory("flow-native-comparison-");
  for (const directory of ["licenses", "sources/glibc"])
    await mkdir(join(root, directory), { recursive: true });
  // Synthetic bytes exercise comparison only; they are not executable build evidence.
  for (const path of artifactNames)
    await writeFile(join(root, path), `synthetic comparison fixture: ${path}\n`);
  return root;
}

it(
  "rejects missing libc source tarballs even if both descriptors match",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    for (const root of [first, second])
      await rm(join(root, "sources/glibc/glibc_test.orig.tar.xz"));
    await expect(command("--compare", first, second)).rejects.toThrow("incomplete");
  }),
);

it(
  "compares complete byte-identical trees without claiming native qualification",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    expect(await command("--compare", first, second)).toEqual({
      comparisonOnly: true,
      identical: true,
      artifactCount: artifactNames.length,
    });
  }),
);

it(
  "rejects a changed generated header across two build trees",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    await writeFile(join(second, "unix-block-bpf.h"), "different\n");
    await expect(command("--compare", first, second)).rejects.toThrow("different artifacts");
  }),
);

it(
  "rejects identically incomplete build trees",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    for (const root of [first, second]) await rm(join(root, "upstream-apply-seccomp.o"));
    await expect(command("--compare", first, second)).rejects.toThrow("incomplete");
  }),
);

it(
  "rejects unexpected build outputs instead of silently excluding them",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    await writeFile(join(first, "unexpected"), "preserve\n");
    await expect(command("--compare", first, second)).rejects.toThrow("unexpected artifact");
  }),
);

it(
  "rejects symlink build outputs",
  ownedTest(async (scope) => {
    const first = await comparisonFixture(scope);
    const second = await comparisonFixture(scope);
    await rm(join(first, "unix-block.bpf"));
    await symlink(join(second, "unix-block.bpf"), join(first, "unix-block.bpf"));
    await expect(command("--compare", first, second)).rejects.toThrow("invalid artifact");
  }),
);

it("keeps the Docker recipe on the recorded base, snapshot, platform, and epoch", async () => {
  const manifest = JSON.parse(await readFile(join(foundation, "source-manifest.json"), "utf8")) as {
    build: { baseImage: string; aptSnapshot: string; sourceDateEpoch: number };
  };
  const dockerfile = await readFile(join(foundation, "Dockerfile"), "utf8");
  expect(dockerfile).toContain(`FROM ${manifest.build.baseImage} AS build`);
  expect(dockerfile).toContain(`/archive/debian/${manifest.build.aptSnapshot}`);
  expect(dockerfile).toContain(`SOURCE_DATE_EPOCH=${manifest.build.sourceDateEpoch}`);
  expect(dockerfile).not.toContain("http://");
  expect(dockerfile).toContain('test "$(dpkg --print-architecture)" = amd64');
  const recipe = await readFile(join(foundation, "build.sh"), "utf8");
  expect(recipe).toContain('test "$(uname -m)" = x86_64');
  expect(recipe).toContain("--build-id=none");
  expect(recipe).toContain("--download-only");
});
