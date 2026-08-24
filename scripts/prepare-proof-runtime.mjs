import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLeanProofOciAttestation,
  parseLeanProofOciAttestation,
} from "../dist/infrastructure/oci/local-lean-proof-runtime-admission.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const proofRoot = join(repositoryRoot, "proof-container");
const projectRoot = projectPath(process.argv.slice(2));
const defaultDescriptorPath = join(projectRoot, ".flow", "proof-runtime", "attestation.json");
const maximumOutputBytes = 16_777_216;
const maximumAttestationBytes = 65_536;
const digestPattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const buildInputBytes = await readFile(join(proofRoot, "build-inputs.json"));
const buildInputs = JSON.parse(buildInputBytes.toString("utf8"));
const profileBytes = await readFile(join(proofRoot, "profile.json"));
const dependencyManifestDigest = sha256(buildInputBytes);
const profileDigest = sha256(profileBytes);
const descriptorPath = outputPath(process.argv.slice(2));

validateInputs(buildInputs);
await verifyLocalInputs();
await assertLinuxX64Docker();

if (process.argv.includes("--verify-only")) {
  const descriptor = parseLeanProofOciAttestation(await readPrivateDescriptor(descriptorPath));
  const inspection = await inspectImage(descriptor.runtime.imageDigest);
  assertImage(inspection, descriptor.runtime.imageDigest, descriptor.artifacts);
  const probe = await probeImage(descriptor.runtime.imageDigest, "verify");
  assertProbe(probe, descriptor.runtime, descriptor.artifacts);
  process.stdout.write(
    `${JSON.stringify({ descriptorPath, imageDigest: descriptor.runtime.imageDigest, verified: true })}\n`,
  );
  process.exit(0);
}

const zeroArtifacts = {
  supervisorSha256: "0".repeat(64),
  safeVerifySha256: "0".repeat(64),
  lean4exportSha256: "0".repeat(64),
  nanodaSha256: "0".repeat(64),
  mathlibManifestSha256: buildInputs.mathlib.manifestSha256,
};
const discovery = await buildImage("discovery", zeroArtifacts);
let artifacts;
try {
  artifacts = (await probeImage(discovery.imageDigest, "discovery")).artifacts;
} finally {
  await cleanupBuild(discovery);
}
const first = await buildImage("1", artifacts);
const second = await buildImage("2", artifacts);
try {
  if (first.imageDigest !== second.imageDigest) {
    throw new Error("Lean proof OCI clean builds produced different image identities");
  }
  const runtime = runtimeWithoutAttestation(first.imageDigest);
  assertProbe(await probeImage(first.imageDigest, "first"), runtime, artifacts);
  assertProbe(await probeImage(second.imageDigest, "second"), runtime, artifacts);
  const canonicalTag = `flow-lean-proof:sha256-${first.imageDigest.slice("sha256:".length)}`;
  await runDocker(["image", "tag", second.tag, canonicalTag]);
  const descriptor = createLeanProofOciAttestation({
    runtime,
    reproducibility: {
      firstImageDigest: first.imageDigest,
      secondImageDigest: second.imageDigest,
      identical: true,
    },
    builder: {
      buildkitImage: buildInputs.buildkit.image,
      buildkitImageDigest: buildInputs.buildkit.image.slice(
        buildInputs.buildkit.image.lastIndexOf("@") + 1,
      ),
    },
    artifacts,
  });
  await publishDescriptor(descriptorPath, descriptor);
  process.stdout.write(
    `${JSON.stringify({
      descriptorPath,
      imageDigest: descriptor.runtime.imageDigest,
      buildAttestationDigest: descriptor.attestationDigest,
      dependencyManifestDigest,
      profileDigest,
      canonicalTag,
    })}\n`,
  );
} finally {
  await cleanupBuild(first);
  await cleanupBuild(second);
}

async function buildImage(label, artifacts) {
  const nonce = randomUUID().replaceAll("-", "");
  const builder = `flow-proof-builder-${label}-${nonce}`;
  const tag = `flow-lean-proof:preparation-${label}-${nonce}`;
  let builderCreated = false;
  try {
    await runDocker([
      "buildx",
      "create",
      "--name",
      builder,
      "--driver",
      "docker-container",
      "--driver-opt",
      `image=${buildInputs.buildkit.image}`,
    ]);
    builderCreated = true;
    await runDocker(["buildx", "inspect", "--builder", builder, "--bootstrap"]);
    const buildArguments = {
      GO_IMAGE: buildInputs.baseImages.golang,
      RUST_IMAGE: buildInputs.baseImages.rust,
      DEBIAN_IMAGE: buildInputs.baseImages.debian,
      SOURCE_DATE_EPOCH: String(buildInputs.sourceDateEpoch),
      DEPENDENCY_MANIFEST_DIGEST: dependencyManifestDigest,
      PROFILE_DIGEST: profileDigest,
      SUPERVISOR_SHA256: artifacts.supervisorSha256,
      SAFE_VERIFY_SHA256: artifacts.safeVerifySha256,
      LEAN4EXPORT_SHA256: artifacts.lean4exportSha256,
      NANODA_SHA256: artifacts.nanodaSha256,
      MATHLIB_MANIFEST_SHA256: artifacts.mathlibManifestSha256,
    };
    const args = [
      "buildx",
      "build",
      "--builder",
      builder,
      "--platform",
      buildInputs.platform,
      "--no-cache",
      "--provenance=false",
      "--sbom=false",
    ];
    for (const [name, value] of Object.entries(buildArguments)) {
      args.push("--build-arg", `${name}=${value}`);
    }
    args.push("--output", `type=docker,name=${tag},rewrite-timestamp=true`, proofRoot);
    await runDocker(args, 3_600_000);
    const inspection = await inspectImage(tag);
    assertImage(inspection, undefined, artifacts);
    await runDocker(["buildx", "rm", "--force", builder], 120_000);
    builderCreated = false;
    return { builder, builderCreated, tag, imageDigest: inspection.Id };
  } catch (error) {
    await cleanupBuild({ builder, builderCreated, tag }).catch(() => undefined);
    throw error;
  }
}

async function cleanupBuild(build) {
  const errors = [];
  if (build.tag !== undefined) {
    await runDocker(["image", "rm", "--force", build.tag], 60_000).catch((error) =>
      errors.push(error),
    );
  }
  if (build.builderCreated) {
    await runDocker(["buildx", "rm", "--force", build.builder], 120_000).catch((error) =>
      errors.push(error),
    );
  }
  if (errors.length > 0) throw new AggregateError(errors, "Lean proof build cleanup failed");
}

async function probeImage(reference, label) {
  const name = `flow-proof-probe-${label}-${randomUUID().replaceAll("-", "")}`;
  try {
    const output = await runDocker([
      "run",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/workspace:rw,nosuid,nodev,noexec,size=16777216,mode=0700",
      "--entrypoint",
      "/opt/flow/bin/flow-proof-supervisor",
      reference,
      "--probe",
    ]);
    return JSON.parse(output);
  } finally {
    await runDocker(["container", "rm", "--force", name], 30_000).catch(() => undefined);
  }
}

async function inspectImage(reference) {
  const output = await runDocker(["image", "inspect", reference]);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker image inspection is invalid");
  }
  return parsed[0];
}

function assertImage(inspection, expectedImageDigest, artifacts) {
  if (
    typeof inspection !== "object" ||
    inspection === null ||
    !imageDigestPattern.test(inspection.Id) ||
    (expectedImageDigest !== undefined && inspection.Id !== expectedImageDigest) ||
    inspection.Os !== "linux" ||
    inspection.Architecture !== "amd64" ||
    inspection.Config?.User !== "0:10001" ||
    inspection.Config?.WorkingDir !== "/workspace" ||
    JSON.stringify(inspection.Config?.Entrypoint) !==
      JSON.stringify(["/opt/flow/bin/flow-proof-supervisor"])
  ) {
    throw new Error("Lean proof image does not have the exact Linux x64 identity");
  }
  const labels = inspection.Config?.Labels;
  const expectedLabels = {
    "ai.synapti.flow.proof.profile": profileDigest,
    "ai.synapti.flow.proof.dependencies": dependencyManifestDigest,
    "ai.synapti.flow.proof.supervisor": artifacts.supervisorSha256,
    "ai.synapti.flow.proof.safe-verify": artifacts.safeVerifySha256,
    "ai.synapti.flow.proof.lean4export": artifacts.lean4exportSha256,
    "ai.synapti.flow.proof.nanoda": artifacts.nanodaSha256,
    "ai.synapti.flow.proof.mathlib-manifest": artifacts.mathlibManifestSha256,
  };
  if (
    typeof labels !== "object" ||
    labels === null ||
    Object.entries(expectedLabels).some(([name, value]) => labels[name] !== value)
  ) {
    throw new Error("Lean proof image labels contradict its exact build inputs");
  }
}

function assertProbe(probe, runtime, artifacts) {
  if (
    probe?.version !== 1 ||
    probe.platform !== "linux" ||
    probe.architecture !== "x64" ||
    probe.leanVersion !== runtime.leanVersion ||
    probe.mathlibRevision !== runtime.mathlibRevision ||
    probe.safeVerifyRevision !== runtime.safeVerifyRevision ||
    probe.lean4exportRevision !== buildInputs.lean4export.revision ||
    probe.nanodaRevision !== runtime.nanodaRevision ||
    probe.profileDigest !== runtime.profileDigest ||
    probe.dependencyManifestDigest !== runtime.dependencyManifestDigest ||
    JSON.stringify(probe.allowedAxioms) !==
      JSON.stringify(["propext", "Quot.sound", "Classical.choice"]) ||
    JSON.stringify(probe.artifacts) !== JSON.stringify(artifacts)
  ) {
    throw new Error("Lean proof image probe contradicts its selected runtime identity");
  }
}

function runtimeWithoutAttestation(imageDigest) {
  return {
    version: 1,
    platform: "linux",
    architecture: "x64",
    imageDigest,
    dependencyManifestDigest,
    leanVersion: buildInputs.lean.version,
    mathlibRevision: buildInputs.mathlib.revision,
    safeVerifyRevision: buildInputs.safeVerify.revision,
    nanodaRevision: buildInputs.nanoda.revision,
    profileDigest,
  };
}

async function verifyLocalInputs() {
  const seccomp = await readFile(join(repositoryRoot, buildInputs.seccomp.source));
  if (sha256(seccomp) !== buildInputs.seccomp.sha256) {
    throw new Error("Lean proof seccomp source digest changed");
  }
  if (sha256(await readFile(join(proofRoot, "build-inputs.json"))) !== dependencyManifestDigest) {
    throw new Error("Lean proof dependency manifest digest changed during preparation");
  }
  const dockerfile = await readFile(join(proofRoot, "Dockerfile"), "utf8");
  const requiredRecipeInputs = [
    `ARG GO_IMAGE=${buildInputs.baseImages.golang}`,
    `ARG RUST_IMAGE=${buildInputs.baseImages.rust}`,
    `ARG DEBIAN_IMAGE=${buildInputs.baseImages.debian}`,
    `ARG SOURCE_DATE_EPOCH=${buildInputs.sourceDateEpoch}`,
    ...[
      buildInputs.lean,
      buildInputs.mathlib,
      buildInputs.safeVerify,
      buildInputs.lean4export,
      buildInputs.nanoda,
    ].flatMap((source) => [`--checksum=sha256:${source.sha256}`, source.url]),
  ];
  if (requiredRecipeInputs.some((input) => !dockerfile.includes(input))) {
    throw new Error("Lean proof Docker recipe contradicts its authoritative build manifest");
  }
}

async function assertLinuxX64Docker() {
  const output = JSON.parse(await runDocker(["info", "--format", "{{json .}}"]));
  if (output.OSType !== "linux" || output.Architecture !== "x86_64") {
    throw new Error("Lean proof preparation requires one Linux x64 Docker Engine");
  }
}

async function publishDescriptor(path, descriptor) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertOwnerDirectory(directory);
  await chmod(directory, 0o700);
  await assertOwnerDirectory(directory, true);
  const pending = `${path}.${randomUUID()}.pending`;
  let published = false;
  try {
    const handle = await open(
      pending,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(descriptor));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, path);
    published = true;
    await syncDirectory(directory);
  } finally {
    if (!published) await rm(pending, { force: true }).catch(() => undefined);
  }
}

async function readPrivateDescriptor(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== currentUid() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > maximumAttestationBytes
    ) {
      throw new Error("Lean proof runtime attestation is not an owner-private bounded file");
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.byteLength) {
      throw new Error("Lean proof runtime attestation ended before its recorded size");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}

async function assertOwnerDirectory(directory, requirePrivate = false) {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== currentUid() ||
    (requirePrivate && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("Lean proof runtime directory is not an owner-private directory");
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateInputs(value) {
  if (
    !exactKeys(value, [
      "version",
      "platform",
      "sourceDateEpoch",
      "buildkit",
      "baseImages",
      "lean",
      "mathlib",
      "safeVerify",
      "lean4export",
      "nanoda",
      "seccomp",
    ]) ||
    value?.version !== 1 ||
    value.platform !== "linux/amd64" ||
    !Number.isSafeInteger(value.sourceDateEpoch) ||
    value.sourceDateEpoch < 1 ||
    !exactKeys(value.baseImages, ["golang", "rust", "debian"]) ||
    !Object.values(value.baseImages).every((image) =>
      /^[a-z0-9./_-]+:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/.test(image),
    ) ||
    !/^moby\/buildkit:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/.test(value.buildkit?.image) ||
    value.lean?.version !== "4.33.1" ||
    value.lean.url !==
      "https://github.com/leanprover/lean4/releases/download/v4.33.1/lean-4.33.1-linux.tar.zst" ||
    value.mathlib?.revision !== "0df444a360eaa60ab8c11dca51a86af692955474" ||
    value.mathlib.url !==
      "https://codeload.github.com/leanprover-community/mathlib4/tar.gz/0df444a360eaa60ab8c11dca51a86af692955474" ||
    value.safeVerify?.revision !== "fb9c583eb0ea96426d94625f89b7842c9dc1c313" ||
    value.safeVerify.url !==
      "https://codeload.github.com/mistralai/LeanstralSafeVerify/tar.gz/fb9c583eb0ea96426d94625f89b7842c9dc1c313" ||
    value.lean4export?.revision !== "15f6055e299ad5b89345e533cc2192f4cc00f659" ||
    value.lean4export.url !==
      "https://codeload.github.com/leanprover/lean4export/tar.gz/15f6055e299ad5b89345e533cc2192f4cc00f659" ||
    value.nanoda?.revision !== "68d5ca9db226849b41a6fff59d796ff19d0a8840" ||
    value.nanoda.url !==
      "https://codeload.github.com/robsimmons/nanoda_lib/tar.gz/68d5ca9db226849b41a6fff59d796ff19d0a8840" ||
    value.seccomp.source !== "prime-container/seccomp.json" ||
    ![
      value.lean.sha256,
      value.mathlib.sha256,
      value.mathlib.manifestSha256,
      value.safeVerify.sha256,
      value.lean4export.sha256,
      value.nanoda.sha256,
      value.seccomp.sha256,
    ].every((digest) => digestPattern.test(digest))
  ) {
    throw new Error("Lean proof build inputs violate the fixed manifest contract");
  }
}

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function currentUid() {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Lean proof preparation requires a POSIX user identity");
  return uid;
}

function outputPath(args) {
  const index = args.indexOf("--output");
  if (index < 0) return defaultDescriptorPath;
  const value = args[index + 1];
  if (value === undefined || !resolve(value).startsWith(`${projectRoot}/`)) {
    throw new Error("Lean proof attestation output must be inside the selected project");
  }
  return resolve(value);
}

function projectPath(args) {
  const index = args.indexOf("--project-root");
  if (index < 0) return process.cwd();
  const value = args[index + 1];
  if (value === undefined) throw new Error("Lean proof preparation requires a project root");
  return resolve(value);
}

async function runDocker(args, timeoutMs = 120_000) {
  return run("docker", args, timeoutMs);
}

function run(executable, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const diagnostics = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= maximumOutputBytes) output.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes <= maximumOutputBytes) diagnostics.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (
        code === 0 &&
        outputBytes <= maximumOutputBytes &&
        diagnosticBytes <= maximumOutputBytes
      ) {
        resolvePromise(Buffer.concat(output).toString("utf8").trim());
        return;
      }
      rejectPromise(
        new Error(
          `${executable} command failed (${code ?? signal ?? "unknown"}): ${Buffer.concat(diagnostics).toString("utf8").slice(-4096)}`,
        ),
      );
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
