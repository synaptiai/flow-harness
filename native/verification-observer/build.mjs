import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownRoot = dirname(fileURLToPath(import.meta.url));
// Capture the launcher identity before any asynchronous build preparation.
const launcherBytes = await regularBytes(ownRoot, "build.mjs", 131_072);
const commit = "44ab607c46f20381aeaf3e22ca0e0151d4c6b29c";
const sources = [
  [
    "upstream/apply-seccomp.c",
    "vendor/seccomp-src/apply-seccomp.c",
    "05604f3b077a91f96ec7c8f387bac7878d8ca1241cc0eebdc6f5aabc0f66a55e",
  ],
  [
    "upstream/seccomp-unix-block.c",
    "vendor/seccomp-src/seccomp-unix-block.c",
    "6802faf04898a488d0ba1d512ef23fc65a43545c017a8d516a567063a2b315dc",
  ],
  [
    "upstream/LICENSE",
    "LICENSE",
    "1210bc93eb85dd786c33192d5bcb7153a93922fa99fbc1512af6a7199cb41080",
  ],
];
const baseImage =
  "debian:bookworm-slim@sha256:362e64223cc0da95422b3b13c045186fc0a81250e765d31c025fbddf257f6143";
const buildkitImage =
  "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";
const expectedManifest = {
  version: 1,
  purpose: "unmodified-upstream-build-foundation",
  upstream: {
    repository: "https://github.com/anthropic-experimental/sandbox-runtime",
    commit,
    packageVersion: "0.0.70",
    license: "Apache-2.0",
  },
  sources: sources.map(([path, upstreamPath, sha256]) => ({ path, upstreamPath, sha256 })),
  build: {
    platform: "linux/amd64",
    baseImage,
    certificateImage:
      "golang:1.26.5-bookworm@sha256:1ecb7edf62a0408027bd5729dfd6b1b8766e578e8df93995b225dfd0944eb651",
    buildkitImage,
    aptSnapshot: "20260823T000000Z",
    sourceDateEpoch: 1785885248,
    packages: ["binutils", "ca-certificates", "gcc", "libc6-dev", "libseccomp-dev"],
    generatedHeader: "unix-block-bpf.h",
    artifact: "upstream-apply-seccomp",
  },
};
const requiredArtifacts = [
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
];
const observerInputNames = [
  "observer.patch",
  "observer-application.h",
  "observer-result.h",
  "host-bridge-guardian.c",
];
const observerArtifacts = [
  ...requiredArtifacts,
  "flow-observer-apply-seccomp",
  "flow-observer-apply-seccomp.o",
  "flow-host-bridge-guardian",
  "flow-host-bridge-guardian.o",
  "observer/apply-seccomp.c",
  "observer/upstream-apply-seccomp.c",
  "observer/source-manifest.json",
  ...observerInputNames.map((name) => `observer/${name}`),
];
const controlDirectory = "test-controls/false-normal";
const controlArtifacts = [
  "flow-observer-apply-seccomp-false-normal",
  "flow-observer-apply-seccomp-false-normal.o",
  "apply-seccomp.c",
  "observer-application.h",
  "observer-result.h",
  "mutation.json",
].map((name) => `${controlDirectory}/${name}`);

function falseNormalMutation(originalBytes) {
  // This complete function anchor prevents a similar suffix in another function
  // from becoming the mutation target. Source drift requires explicit review.
  const original = `static void flow_observer_worker_fail(int writer, pid_t cached_pid,
                                      const unsigned char correlation[32],
                                      uint32_t kind, int error, uint32_t phase) {
    (void)flow_observer_send(writer, correlation, kind,
                             (uint32_t)flow_observer_errno(error), phase);
    if (cached_pid > 1) (void)syscall(SYS_kill, cached_pid, SIGKILL);
    for (;;) __asm__ volatile("ud2");
}`;
  const replacement = original.replace(
    '    if (cached_pid > 1) (void)syscall(SYS_kill, cached_pid, SIGKILL);\n    for (;;) __asm__ volatile("ud2");',
    "    (void)cached_pid;\n    _exit(0);",
  );
  const text = originalBytes.toString("utf8");
  if (!Buffer.from(text).equals(originalBytes) || text.split(original).length !== 2)
    throw new Error("false-normal mutation anchor must occur exactly once");
  const bytes = Buffer.from(text.replace(original, replacement));
  return {
    bytes,
    evidence: {
      version: 1,
      purpose: "test-only-false-normal-negative-control",
      mutationId: "worker-fail-normal-zero-v1",
      originalHeaderSha256: sha256(originalBytes),
      mutantHeaderSha256: sha256(bytes),
      replacement: { original, replacement },
    },
  };
}

async function sourceCheck(root) {
  const canonicalRoot = await realpath(root);
  const names = (await readdir(join(canonicalRoot, "upstream"))).sort();
  if (
    JSON.stringify(names) !== JSON.stringify(["LICENSE", "apply-seccomp.c", "seccomp-unix-block.c"])
  )
    throw new Error("source integrity: upstream inventory mismatch");
  const manifestBytes = await regularBytes(canonicalRoot, "source-manifest.json", 65_536);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest))
    throw new Error("source integrity: manifest mismatch");
  const inputs = new Map([["source-manifest.json", manifestBytes]]);
  for (const [path, , digest] of sources) {
    const bytes = await regularBytes(canonicalRoot, path, 131_072);
    if (sha256(bytes) !== digest) throw new Error("source integrity: source bytes mismatch");
    inputs.set(path, bytes);
  }
  return { manifest, manifestSha256: sha256(manifestBytes), inputs };
}

async function freezeContext(root, destination, observer = false, controls = false) {
  const canonicalRoot = await realpath(root);
  const checked = await sourceCheck(canonicalRoot);
  const recipe = {};
  const observerInputs = {};
  let failureControls;
  const controlInputs = {};
  if (observer) {
    for (const name of observerInputNames) {
      const bytes = await regularBytes(canonicalRoot, name, 131_072);
      checked.inputs.set(`observer/${name}`, bytes);
      observerInputs[name] = sha256(bytes);
    }
  }
  if (controls) {
    const mutation = falseNormalMutation(checked.inputs.get("observer/observer-application.h"));
    failureControls = mutation.evidence;
    const generated = {
      "observer-application.h": mutation.bytes,
      "mutation.json": Buffer.from(`${JSON.stringify(failureControls, null, 2)}\n`),
    };
    for (const [name, bytes] of Object.entries(generated)) {
      const path = `${controlDirectory}/${name}`;
      checked.inputs.set(path, bytes);
      controlInputs[path] = sha256(bytes);
    }
  }
  for (const path of ["Dockerfile", "build.sh", "build.mjs"]) {
    const bytes =
      path === "build.mjs" ? launcherBytes : await regularBytes(canonicalRoot, path, 131_072);
    checked.inputs.set(path, bytes);
    recipe[path] = sha256(bytes);
  }
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, "upstream"), { mode: 0o700 });
  await mkdir(join(destination, "observer"), { mode: 0o700 });
  await mkdir(join(destination, "test-controls"), { mode: 0o700 });
  if (controls) await mkdir(join(destination, controlDirectory), { mode: 0o700 });
  for (const [path, bytes] of checked.inputs)
    await writeFile(join(destination, path), bytes, { flag: "wx", mode: 0o600 });
  const copied = await sourceCheck(destination);
  if (copied.manifestSha256 !== checked.manifestSha256)
    throw new Error("source integrity: frozen manifest mismatch");
  for (const [path, digest] of Object.entries(recipe))
    if (sha256(await regularBytes(destination, path, 131_072)) !== digest)
      throw new Error("source integrity: frozen recipe mismatch");
  for (const [name, digest] of Object.entries(observerInputs))
    if (sha256(await regularBytes(destination, `observer/${name}`, 131_072)) !== digest)
      throw new Error("source integrity: frozen observer input mismatch");
  for (const [path, digest] of Object.entries(controlInputs))
    if (sha256(await regularBytes(destination, path, 131_072)) !== digest)
      throw new Error("source integrity: frozen failure-control input mismatch");
  await writeFile(
    join(destination, "upstream.sha256"),
    sources.map(([path, , hash]) => `${hash}  ${path}\n`).join(""),
    { flag: "wx", mode: 0o600 },
  );
  return {
    manifest: checked.manifest,
    sourceManifestSha256: checked.manifestSha256,
    recipe,
    observerInputs,
    failureControls,
    controlInputs,
  };
}

async function regularBytes(root, relative, limit) {
  const path = join(root, relative);
  if ((await realpath(path)) !== path) throw new Error("source integrity: indirect path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw new Error("source integrity: invalid file");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      length !== Number(before.size) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      throw new Error("source integrity: unstable file");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function inventory(root, relative = "", result = {}, observer = false, controls = false) {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!/^[a-zA-Z0-9._+~-]+$/.test(entry.name))
      throw new Error("build comparison: invalid artifact name");
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (
        ![
          "licenses",
          "sources",
          "sources/glibc",
          ...(observer ? ["observer"] : []),
          ...(controls ? ["test-controls", controlDirectory] : []),
        ].includes(path)
      )
        throw new Error("build comparison: unexpected directory");
      await inventory(root, path, result, observer, controls);
    } else {
      if (!entry.isFile() || Object.keys(result).length >= 64)
        throw new Error("build comparison: invalid artifact");
      if (
        ![
          ...(observer ? observerArtifacts : requiredArtifacts),
          ...(controls ? controlArtifacts : []),
        ].includes(path) &&
        !/^sources\/glibc\/glibc_[a-zA-Z0-9.+~-]+\.(?:dsc|tar\.(?:xz|gz|bz2)(?:\.asc)?|diff\.gz)$/.test(
          path,
        )
      )
        throw new Error("build comparison: unexpected artifact");
      result[path] = sha256(await regularBytes(root, path, 134_217_728));
    }
  }
  return result;
}

async function compare(first, second, observer = false, controls = false) {
  const a = await inventory(await realpath(first), "", {}, observer, controls);
  const b = await inventory(await realpath(second), "", {}, observer, controls);
  if (
    (observer ? observerArtifacts : requiredArtifacts).some((path) => !(path in a)) ||
    (controls && controlArtifacts.some((path) => !(path in a))) ||
    !Object.keys(a).some((path) => path.startsWith("sources/glibc/") && path.endsWith(".dsc")) ||
    !Object.keys(a).some((path) =>
      /^sources\/glibc\/glibc_.*\.orig\.tar\.(?:xz|gz|bz2)$/.test(path),
    ) ||
    JSON.stringify(a) !== JSON.stringify(b)
  )
    throw new Error("build comparison: incomplete or different artifacts");
  return a;
}

// Trusted build diagnostics only: escaping is not secret redaction. Emit each
// failure before aggregation so a later cleanup error cannot hide its cause.
export function formatDockerFailure(output, code, signal, interrupted) {
  return JSON.stringify({
    event: "native-foundation-docker-failure",
    code,
    signal,
    interrupted,
    truncated: output.length > 16_384,
    outputTail: output.subarray(Math.max(0, output.length - 16_384)).toString("utf8"),
  });
}

function run(args, timeoutMs = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1_048_576) chunks.push(chunk);
        else {
          failed = true;
          child.kill("SIGKILL");
        }
      });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal !== null) {
        process.stderr.write(
          `${formatDockerFailure(Buffer.concat(chunks), code, signal, failed)}\n`,
        );
        reject(new Error("native foundation Docker operation failed"));
      } else resolveResult(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function build(output, observer = false, controls = false) {
  const platform = (await run(["info", "--format", "{{.OSType}}/{{.Architecture}}"])).trim();
  if (platform !== "linux/x86_64")
    throw new Error(
      "native foundation requires a Linux x64 Docker daemon; emulation is not qualified",
    );
  const parent = await realpath(dirname(resolve(output)));
  const destination = join(parent, resolve(output).split("/").at(-1));
  try {
    await lstat(destination);
    throw new Error("output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "flow-native-build-"));
  let builder;
  let completed = false;
  let artifactCount = 0;
  let failure;
  try {
    const context = join(scratch, "context");
    const frozen = await freezeContext(ownRoot, context, observer, controls);
    for (const pass of ["first", "second"]) {
      builder = `flow-native-${randomUUID()}`;
      await run([
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${buildkitImage}`,
      ]);
      await run(
        [
          "buildx",
          "build",
          "--builder",
          builder,
          "--platform",
          "linux/amd64",
          "--no-cache",
          "--provenance=false",
          "--sbom=false",
          ...(observer ? ["--build-arg", "FLOW_NATIVE_MODE=observer"] : []),
          ...(controls ? ["--build-arg", "FLOW_NATIVE_FAILURE_CONTROLS=false-normal-v1"] : []),
          "--output",
          `type=local,dest=${join(scratch, pass)}`,
          context,
        ],
        600_000,
      );
      await run(["buildx", "rm", "--force", builder]);
      builder = undefined;
    }
    const artifacts = await compare(
      join(scratch, "first"),
      join(scratch, "second"),
      observer,
      controls,
    );
    if (observer) {
      const preserved = {
        "observer/source-manifest.json": frozen.sourceManifestSha256,
        "observer/upstream-apply-seccomp.c": sources[0][2],
        ...Object.fromEntries(
          Object.entries(frozen.observerInputs).map(([name, digest]) => [
            `observer/${name}`,
            digest,
          ]),
        ),
      };
      for (const [path, digest] of Object.entries(preserved))
        if (artifacts[path] !== digest) throw new Error("observer build provenance mismatch");
    }
    if (controls) {
      const preserved = {
        ...frozen.controlInputs,
        [`${controlDirectory}/apply-seccomp.c`]: artifacts["observer/apply-seccomp.c"],
        [`${controlDirectory}/observer-result.h`]: frozen.observerInputs["observer-result.h"],
      };
      for (const [path, digest] of Object.entries(preserved))
        if (artifacts[path] !== digest)
          throw new Error("failure-control build provenance mismatch");
      if (
        artifacts[`${controlDirectory}/flow-observer-apply-seccomp-false-normal`] ===
        artifacts["flow-observer-apply-seccomp"]
      )
        throw new Error("failure-control binary must differ from genuine observer");
    }
    await mkdir(destination, { mode: 0o700 });
    for (const path of Object.keys(artifacts)) {
      await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
      await copyFile(
        join(scratch, "first", path),
        join(destination, path),
        constants.COPYFILE_EXCL,
      );
    }
    await writeFile(
      join(destination, "build-evidence.json"),
      `${JSON.stringify({ version: 1, purpose: controls ? "observer-application-result-build-with-test-failure-controls" : observer ? "observer-application-result-build" : frozen.manifest.purpose, sourceManifestSha256: frozen.sourceManifestSha256, recipe: frozen.recipe, build: observer ? { ...frozen.manifest.build, artifact: "flow-observer-apply-seccomp", packages: [...frozen.manifest.build.packages, "patch"] } : frozen.manifest.build, ...(observer ? { observerInputs: frozen.observerInputs } : {}), ...(controls ? { failureControls: frozen.failureControls } : {}), comparison: "two-clean-builds-identical", artifacts, observerQualification: "not-performed" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    completed = true;
    artifactCount = Object.keys(artifacts).length;
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (builder !== undefined) await run(["buildx", "rm", "--force", builder]);
      if (completed && failure === undefined) await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "build and cleanup failed");
    }
    if (!completed || failure !== undefined)
      process.stderr.write(
        `Native foundation build or cleanup incomplete; inspect owned scratch (possibly partial): ${scratch}\n`,
      );
  }
  if (failure !== undefined) throw failure;
  process.stdout.write(
    `${JSON.stringify({ built: true, observerQualified: false, artifactCount })}\n`,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    if (mode === "--check-sources" && args.length <= 1) {
      const checked = await sourceCheck(args[0] ?? ownRoot);
      process.stdout.write(
        `${JSON.stringify({ verified: true, sourceManifestSha256: checked.manifestSha256, sourceCount: sources.length })}\n`,
      );
    } else if (
      ["--compare", "--compare-observer", "--compare-observer-failure-controls"].includes(mode) &&
      args.length === 2
    ) {
      const artifacts = await compare(
        args[0],
        args[1],
        mode !== "--compare",
        mode === "--compare-observer-failure-controls",
      );
      process.stdout.write(
        `${JSON.stringify({ comparisonOnly: true, identical: true, artifactCount: Object.keys(artifacts).length })}\n`,
      );
    } else if (
      [
        "--freeze-context",
        "--freeze-observer-context",
        "--freeze-observer-failure-controls-context",
      ].includes(mode) &&
      args.length === 2
    ) {
      const observer = mode !== "--freeze-context";
      const controls = mode === "--freeze-observer-failure-controls-context";
      const frozen = await freezeContext(args[0], args[1], observer, controls);
      process.stdout.write(
        `${JSON.stringify({ frozenOnly: true, observerQualified: false, sourceManifestSha256: frozen.sourceManifestSha256, recipe: frozen.recipe, ...(observer ? { observerInputs: frozen.observerInputs } : {}), ...(controls ? { failureControls: frozen.failureControls } : {}) })}\n`,
      );
    } else if (mode === "--build" && args.length === 1) await build(args[0]);
    else if (mode === "--build-observer" && args.length === 1) await build(args[0], true);
    else if (mode === "--build-observer-failure-controls" && args.length === 1)
      await build(args[0], true, true);
    else
      throw new Error(
        "Use --check-sources [root], --freeze-context/--freeze-observer-context/--freeze-observer-failure-controls-context root NEW_DIRECTORY, --compare/--compare-observer/--compare-observer-failure-controls first second, or --build/--build-observer/--build-observer-failure-controls NEW_OUTPUT_DIRECTORY",
      );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "native foundation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
