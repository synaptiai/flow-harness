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

async function freezeContext(root, destination) {
  const canonicalRoot = await realpath(root);
  const checked = await sourceCheck(canonicalRoot);
  const recipe = {};
  for (const path of ["Dockerfile", "build.sh", "build.mjs"]) {
    const bytes =
      path === "build.mjs" ? launcherBytes : await regularBytes(canonicalRoot, path, 131_072);
    checked.inputs.set(path, bytes);
    recipe[path] = sha256(bytes);
  }
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, "upstream"), { mode: 0o700 });
  for (const [path, bytes] of checked.inputs)
    await writeFile(join(destination, path), bytes, { flag: "wx", mode: 0o600 });
  const copied = await sourceCheck(destination);
  if (copied.manifestSha256 !== checked.manifestSha256)
    throw new Error("source integrity: frozen manifest mismatch");
  for (const [path, digest] of Object.entries(recipe))
    if (sha256(await regularBytes(destination, path, 131_072)) !== digest)
      throw new Error("source integrity: frozen recipe mismatch");
  await writeFile(
    join(destination, "upstream.sha256"),
    sources.map(([path, , hash]) => `${hash}  ${path}\n`).join(""),
    { flag: "wx", mode: 0o600 },
  );
  return { manifest: checked.manifest, sourceManifestSha256: checked.manifestSha256, recipe };
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

async function inventory(root, relative = "", result = {}) {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!/^[a-zA-Z0-9._+~-]+$/.test(entry.name))
      throw new Error("build comparison: invalid artifact name");
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!["licenses", "sources", "sources/glibc"].includes(path))
        throw new Error("build comparison: unexpected directory");
      await inventory(root, path, result);
    } else {
      if (!entry.isFile() || Object.keys(result).length >= 64)
        throw new Error("build comparison: invalid artifact");
      if (
        !requiredArtifacts.includes(path) &&
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

async function compare(first, second) {
  const a = await inventory(await realpath(first));
  const b = await inventory(await realpath(second));
  if (
    requiredArtifacts.some((path) => !(path in a)) ||
    !Object.keys(a).some((path) => path.startsWith("sources/glibc/") && path.endsWith(".dsc")) ||
    !Object.keys(a).some((path) =>
      /^sources\/glibc\/glibc_.*\.orig\.tar\.(?:xz|gz|bz2)$/.test(path),
    ) ||
    JSON.stringify(a) !== JSON.stringify(b)
  )
    throw new Error("build comparison: incomplete or different artifacts");
  return a;
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
      if (failed || code !== 0 || signal !== null)
        reject(new Error("native foundation Docker operation failed"));
      else resolveResult(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function build(output) {
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
    const frozen = await freezeContext(ownRoot, context);
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
          "--output",
          `type=local,dest=${join(scratch, pass)}`,
          context,
        ],
        600_000,
      );
      await run(["buildx", "rm", "--force", builder]);
      builder = undefined;
    }
    const artifacts = await compare(join(scratch, "first"), join(scratch, "second"));
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
      `${JSON.stringify({ version: 1, purpose: frozen.manifest.purpose, sourceManifestSha256: frozen.sourceManifestSha256, recipe: frozen.recipe, build: frozen.manifest.build, comparison: "two-clean-builds-identical", artifacts, observerQualification: "not-performed" }, null, 2)}\n`,
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

try {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--check-sources" && args.length <= 1) {
    const checked = await sourceCheck(args[0] ?? ownRoot);
    process.stdout.write(
      `${JSON.stringify({ verified: true, sourceManifestSha256: checked.manifestSha256, sourceCount: sources.length })}\n`,
    );
  } else if (mode === "--compare" && args.length === 2) {
    const artifacts = await compare(args[0], args[1]);
    process.stdout.write(
      `${JSON.stringify({ comparisonOnly: true, identical: true, artifactCount: Object.keys(artifacts).length })}\n`,
    );
  } else if (mode === "--freeze-context" && args.length === 2) {
    const frozen = await freezeContext(args[0], args[1]);
    process.stdout.write(
      `${JSON.stringify({ frozenOnly: true, observerQualified: false, sourceManifestSha256: frozen.sourceManifestSha256, recipe: frozen.recipe })}\n`,
    );
  } else if (mode === "--build" && args.length === 1) await build(args[0]);
  else
    throw new Error(
      "Use --check-sources [root], --freeze-context root NEW_DIRECTORY, --compare first second, or --build NEW_OUTPUT_DIRECTORY",
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "native foundation failed"}\n`);
  process.exitCode = 1;
}
