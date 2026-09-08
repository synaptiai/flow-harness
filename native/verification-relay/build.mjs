import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureRelaySources } from "./source-check.mjs";

const execFile = promisify(execFileCallback);
const ownRoot = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recipeNames = [
  "Dockerfile",
  "build.sh",
  "build.mjs",
  "source-check.mjs",
  "source-manifest.json",
];
const builderImage =
  "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec";

export async function freezeRelayContext(source, output) {
  const checked = await captureRelaySources(source);
  const inputs = new Map([...checked.inputs].map(([name, bytes]) => [`sources/${name}`, bytes]));
  for (const name of recipeNames) {
    const bytes = await readFile(join(ownRoot, name));
    if (bytes.length > 131_072) throw new Error("relay recipe exceeds capture limit");
    inputs.set(name, bytes);
  }
  if (digest(inputs.get("source-manifest.json")) !== checked.sourceManifestSha256)
    throw new Error("relay source manifest changed during preparation");
  const manifest = JSON.parse(inputs.get("source-manifest.json").toString("utf8"));
  inputs.set(
    "inputs.sha256",
    Buffer.from(
      [...checked.inputs].map(([name, bytes]) => `${digest(bytes)}  sources/${name}\n`).join(""),
    ),
  );
  const patched = Object.entries(manifest.muslPatchedFiles);
  if (
    patched.length !== 4 ||
    patched.some(
      ([path, hash]) =>
        !/^src\/[a-z]+\/[a-z0-9_]+\.[ch]$/.test(path) || !/^[a-f0-9]{64}$/.test(hash),
    )
  )
    throw new Error("invalid trusted patched-source manifest");
  inputs.set(
    "musl-patched.sha256",
    Buffer.from(patched.map(([path, hash]) => `${hash}  ${path}\n`).join("")),
  );
  const destination = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, "sources"), { mode: 0o700 });
  for (const [name, bytes] of inputs)
    await writeFile(join(destination, name), bytes, { flag: "wx", mode: 0o600 });
  return {
    sourceManifestSha256: checked.sourceManifestSha256,
    inputs: Object.fromEntries([...inputs].map(([name, bytes]) => [name, digest(bytes)])),
    sourceNames: [...checked.inputs.keys()],
    baselineOnly: true,
    relayQualified: false,
  };
}

async function docker(args, timeout = 30_000) {
  try {
    const result = await execFile("docker", args, {
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4_194_304,
    });
    return result.stdout;
  } catch (error) {
    // Build input is reviewed public source. Escape and bound diagnostics.
    process.stderr.write(
      `${JSON.stringify({ event: "relay-build-docker-failure", code: error.code, signal: error.signal, outputTail: String(error.stderr ?? "").slice(-16_384) })}\n`,
    );
    throw new Error("relay baseline Docker operation failed");
  }
}

async function captureArtifacts(root, expected) {
  const result = new Map();
  let total = 0;
  const directories = new Set(
    [...expected].flatMap((name) => {
      const parts = name.split("/");
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  async function walk(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(name)) await walk(name);
      else if (entry.isFile() && expected.has(name)) {
        const stat = await lstat(join(root, name));
        if (stat.size > 33_554_432 || total + stat.size > 67_108_864)
          throw new Error("relay artifact capture limit exceeded");
        const bytes = await readFile(join(root, name));
        total += bytes.length;
        if (bytes.length !== stat.size) throw new Error("relay artifact changed during capture");
        result.set(name, bytes);
      } else throw new Error("unexpected relay build artifact");
    }
  }
  await walk("");
  if (result.size !== expected.size) throw new Error("missing relay build artifact");
  return result;
}

export async function buildRelayBaseline(source, output) {
  const platform = (await docker(["info", "--format", "{{.OSType}}/{{.Architecture}}"])).trim();
  if (process.platform !== "linux" || process.arch !== "x64" || platform !== "linux/x86_64")
    throw new Error(
      "relay baseline requires native Linux x64 and a Linux x64 Docker daemon; emulation is not qualified",
    );
  const destination = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
  try {
    await lstat(destination);
    throw new Error("relay output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "flow-relay-build-"));
  let builder;
  let complete = false;
  try {
    const context = join(scratch, "context");
    const frozen = await freezeRelayContext(source, context);
    for (const pass of ["first", "second"]) {
      builder = `flow-relay-${randomUUID()}`;
      await docker([
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${builderImage}`,
      ]);
      await docker(
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
      await docker(["buildx", "rm", "--force", builder]);
      builder = undefined;
    }
    const expected = new Set([
      "socat-static-baseline",
      "libc.a",
      "relay.link-map",
      "elf-header.txt",
      "elf-program-headers.txt",
      "elf-dynamic.txt",
      "toolchain.txt",
      "config/musl-config.mak",
      "config/socat-config.h",
      "config/socat-Makefile",
      "licenses/musl-COPYRIGHT",
      "licenses/socat-COPYING",
      "licenses/gcc-copyright",
      "licenses/GPL-3",
      ...frozen.sourceNames.map((name) => `sources/${name}`),
      ...[...recipeNames, "inputs.sha256", "musl-patched.sha256"].map((name) => `recipe/${name}`),
    ]);
    const first = await captureArtifacts(join(scratch, "first"), expected);
    const second = await captureArtifacts(join(scratch, "second"), expected);
    for (const [name, bytes] of first)
      if (!bytes.equals(second.get(name))) throw new Error("relay baseline clean builds differ");
    for (const [name, hash] of Object.entries(frozen.inputs)) {
      const artifact = name.startsWith("sources/") ? name : `recipe/${name}`;
      if (digest(first.get(artifact)) !== hash)
        throw new Error("relay baseline provenance mismatch");
    }
    await mkdir(destination, { mode: 0o700 });
    for (const [name, bytes] of first) {
      await mkdir(dirname(join(destination, name)), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, name), bytes, {
        flag: "wx",
        mode: name === "socat-static-baseline" ? 0o700 : 0o600,
      });
    }
    const evidence = {
      version: 1,
      purpose: "static-relay-comparison-baseline",
      ...frozen,
      comparison: "two-clean-builds-identical",
      builderImage,
      artifacts: Object.fromEntries([...first].map(([name, bytes]) => [name, digest(bytes)])),
    };
    await writeFile(
      join(destination, "build-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    complete = true;
    return evidence;
  } finally {
    try {
      if (builder !== undefined) await docker(["buildx", "rm", "--force", builder]);
      if (complete) await rm(scratch, { recursive: true });
    } finally {
      if (!complete || builder !== undefined)
        process.stderr.write(`Relay build evidence retained at owned scratch: ${scratch}\n`);
    }
  }
}
