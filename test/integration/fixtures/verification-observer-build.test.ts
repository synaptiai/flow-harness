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

const observerInputs = ["observer.patch", "observer-application.h", "observer-result.h"];
const observerArtifacts = [
  "flow-observer-apply-seccomp",
  "flow-observer-apply-seccomp.o",
  "observer/apply-seccomp.c",
  "observer/upstream-apply-seccomp.c",
  "observer/source-manifest.json",
  ...observerInputs.map((name) => `observer/${name}`),
];

for (const mode of ["--build", "--build-observer", "--build-observer-failure-controls"]) {
  it(
    `dispatches ${mode} through Docker admission, not a synthetic successful build`,
    ownedTest(async (scope) => {
      const root = await scope.temporaryDirectory("flow-native-no-docker-");
      await expect(
        execFile(process.execPath, [join(foundation, "build.mjs"), mode, join(root, "output")], {
          env: { PATH: root },
          timeout: 3_000,
          maxBuffer: 65_536,
        }),
      ).rejects.toThrow("native foundation Docker operation failed");
    }),
  );
}

it(
  "freezes observer inputs separately without changing upstream manifest bytes",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    for (const name of observerInputs) await writeFile(join(root, name), `synthetic ${name}\n`);
    const parent = await scope.temporaryDirectory("flow-observer-freeze-");
    const context = join(parent, "context");
    const manifest = await readFile(join(root, "source-manifest.json"));
    const result = await command("--freeze-observer-context", root, context);
    expect(result).toMatchObject({ frozenOnly: true, observerQualified: false });
    expect(await readFile(join(context, "source-manifest.json"))).toEqual(manifest);
    for (const name of observerInputs) {
      const bytes = await readFile(join(root, name));
      await writeFile(join(root, name), "changed after freeze");
      expect(await readFile(join(context, "observer", name))).toEqual(bytes);
      expect(result.observerInputs).toMatchObject({
        [name]: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }),
);

it(
  "rejects a symlink observer header before freezing executable inputs",
  ownedTest(async (scope) => {
    const root = await copySources(scope);
    for (const name of observerInputs) await writeFile(join(root, name), `synthetic ${name}\n`);
    await rm(join(root, "observer-result.h"));
    await symlink(join(foundation, "observer-result.h"), join(root, "observer-result.h"));
    await expect(command("--freeze-observer-context", root, join(root, "context"))).rejects.toThrow(
      "indirect path",
    );
  }),
);

async function observerComparisonFixture(scope: OwnedTestScope) {
  const root = await comparisonFixture(scope);
  await mkdir(join(root, "observer"));
  // These inputs check inventory/comparison only, never compilation or native safety.
  for (const path of observerArtifacts) await writeFile(join(root, path), `synthetic ${path}\n`);
  return root;
}

it(
  "compares observer artifacts only in the explicit observer mode without qualification",
  ownedTest(async (scope) => {
    const first = await observerComparisonFixture(scope);
    const second = await observerComparisonFixture(scope);
    expect(await command("--compare-observer", first, second)).toMatchObject({
      comparisonOnly: true,
      identical: true,
      artifactCount: artifactNames.length + observerArtifacts.length,
    });
    await expect(command("--compare", first, second)).rejects.toThrow("unexpected");
  }),
);

for (const missing of observerArtifacts) {
  it(
    `requires observer provenance and relinkable artifact ${missing}`,
    ownedTest(async (scope) => {
      const first = await observerComparisonFixture(scope);
      const second = await observerComparisonFixture(scope);
      for (const root of [first, second]) await rm(join(root, missing));
      await expect(command("--compare-observer", first, second)).rejects.toThrow("incomplete");
    }),
  );
}

it(
  "rejects a changed patched translation unit between observer builds",
  ownedTest(async (scope) => {
    const first = await observerComparisonFixture(scope);
    const second = await observerComparisonFixture(scope);
    await writeFile(join(second, "observer/apply-seccomp.c"), "different\n");
    await expect(command("--compare-observer", first, second)).rejects.toThrow(
      "different artifacts",
    );
  }),
);

const controlDirectory = "test-controls/false-normal";
const controlArtifacts = [
  "flow-observer-apply-seccomp-false-normal",
  "flow-observer-apply-seccomp-false-normal.o",
  "apply-seccomp.c",
  "observer-application.h",
  "observer-result.h",
  "mutation.json",
].map((name) => `${controlDirectory}/${name}`);
const originalFailStop =
  '    if (cached_pid > 1) (void)syscall(SYS_kill, cached_pid, SIGKILL);\n    for (;;) __asm__ volatile("ud2");';
const falseNormal = "    (void)cached_pid;\n    _exit(0);";

async function actualObserverSources(scope: OwnedTestScope) {
  const root = await copySources(scope);
  for (const name of observerInputs) await copyFile(join(foundation, name), join(root, name));
  return root;
}

it(
  "derives a separately identified false-normal header from actual source without changing original inputs",
  ownedTest(async (scope) => {
    const root = await actualObserverSources(scope);
    const before = await readFile(join(root, "observer-application.h"));
    const destination = join(root, "frozen");
    const result = await command("--freeze-observer-failure-controls-context", root, destination);
    const expected = before.toString("utf8").replace(originalFailStop, falseNormal);
    expect(expected).not.toBe(before.toString("utf8"));
    expect(await readFile(join(root, "observer-application.h"))).toEqual(before);
    expect(await readFile(join(destination, "observer/observer-application.h"))).toEqual(before);
    expect(
      await readFile(join(destination, controlDirectory, "observer-application.h"), "utf8"),
    ).toBe(expected);
    const mutation = JSON.parse(
      await readFile(join(destination, controlDirectory, "mutation.json"), "utf8"),
    );
    expect(mutation).toEqual({
      version: 1,
      purpose: "test-only-false-normal-negative-control",
      mutationId: "worker-fail-normal-zero-v1",
      originalHeaderSha256: createHash("sha256").update(before).digest("hex"),
      mutantHeaderSha256: createHash("sha256").update(expected).digest("hex"),
      replacement: {
        original: expect.stringContaining(originalFailStop),
        replacement: expect.stringContaining(falseNormal),
      },
    });
    expect(mutation.replacement.original).toContain("static void flow_observer_worker_fail(");
    expect(mutation.replacement.replacement).toBe(
      mutation.replacement.original.replace(originalFailStop, falseNormal),
    );
    expect(result.failureControls).toEqual(mutation);
    expect(result).toMatchObject({ frozenOnly: true, observerQualified: false });
  }),
);

for (const invalid of ["missing", "duplicate", "wrong-function"] as const) {
  it(
    `rejects ${invalid} fail-stop mutation anchors before writing a build context`,
    ownedTest(async (scope) => {
      const root = await actualObserverSources(scope);
      const header = join(root, "observer-application.h");
      const original = await readFile(header, "utf8");
      const changed =
        invalid === "missing"
          ? original.replace(originalFailStop, falseNormal)
          : invalid === "duplicate"
            ? original + original
            : original.replace(
                "static void flow_observer_worker_fail(",
                "static void unrelated_worker_fail(",
              );
      await writeFile(header, changed);
      const destination = join(root, "frozen");
      await expect(
        command("--freeze-observer-failure-controls-context", root, destination),
      ).rejects.toThrow("false-normal mutation anchor");
      await expect(readFile(join(destination, "source-manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(header, "utf8")).toBe(changed);
    }),
  );
}

async function controlComparisonFixture(scope: OwnedTestScope) {
  const root = await observerComparisonFixture(scope);
  await mkdir(join(root, controlDirectory), { recursive: true });
  for (const path of controlArtifacts)
    await writeFile(join(root, path), `synthetic comparison only: ${path}\n`);
  return root;
}

it(
  "compares complete failure controls only in their explicit mode",
  ownedTest(async (scope) => {
    const first = await controlComparisonFixture(scope);
    const second = await controlComparisonFixture(scope);
    expect(await command("--compare-observer-failure-controls", first, second)).toEqual({
      comparisonOnly: true,
      identical: true,
      artifactCount: artifactNames.length + observerArtifacts.length + controlArtifacts.length,
    });
    await expect(command("--compare-observer", first, second)).rejects.toThrow("unexpected");
  }),
);

for (const missing of controlArtifacts) {
  it(
    `requires false-normal provenance and artifact ${missing}`,
    ownedTest(async (scope) => {
      const first = await controlComparisonFixture(scope);
      const second = await controlComparisonFixture(scope);
      for (const root of [first, second]) await rm(join(root, missing));
      await expect(command("--compare-observer-failure-controls", first, second)).rejects.toThrow(
        "incomplete",
      );
    }),
  );
}

it(
  "rejects different mutant header bytes across clean builds",
  ownedTest(async (scope) => {
    const first = await controlComparisonFixture(scope);
    const second = await controlComparisonFixture(scope);
    await writeFile(join(second, controlDirectory, "observer-application.h"), "different\n");
    await expect(command("--compare-observer-failure-controls", first, second)).rejects.toThrow(
      "different artifacts",
    );
  }),
);
