#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_RELEASE_RECORD_BYTES = 1024 * 1024;
const MAX_RELEASE_NOTES_BYTES = 256 * 1024;

class PreviewNpmReleaseVerificationError extends Error {}

try {
  const options = parseArguments(process.argv.slice(2));
  const release = parseObject(await readBoundedFile(options.releaseJson, MAX_RELEASE_RECORD_BYTES));
  const releaseNotes = await readBoundedFile(options.releaseNotes, MAX_RELEASE_NOTES_BYTES);
  verifyExpectedIdentity(options);
  verifyRelease(release, releaseNotes, options);
  process.stdout.write(
    `Verified immutable preview release ${options.expectedTag} at ${options.expectedRevision}.\n`,
  );
} catch {
  process.stderr.write("Preview npm stage release record is invalid.\n");
  process.exitCode = 1;
}

function parseArguments(args) {
  const names = [
    "--release-json",
    "--release-notes",
    "--expected-tag",
    "--expected-title",
    "--expected-archive",
    "--expected-attestation",
    "--expected-revision",
  ];
  if (args.length !== names.length * 2) {
    throw new PreviewNpmReleaseVerificationError();
  }
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.includes(name) || values.has(name) || value === undefined || value.length === 0) {
      throw new PreviewNpmReleaseVerificationError();
    }
    values.set(name, value);
  }
  return Object.freeze({
    releaseJson: values.get("--release-json"),
    releaseNotes: values.get("--release-notes"),
    expectedTag: values.get("--expected-tag"),
    expectedTitle: values.get("--expected-title"),
    expectedArchive: values.get("--expected-archive"),
    expectedAttestation: values.get("--expected-attestation"),
    expectedRevision: values.get("--expected-revision"),
  });
}

function verifyExpectedIdentity(options) {
  if (!/^v0\.1\.0-alpha\.[1-9]\d*$/u.test(options.expectedTag)) {
    throw new PreviewNpmReleaseVerificationError();
  }
  const version = options.expectedTag.slice(1);
  if (
    options.expectedTitle !== `Flow ${version}` ||
    options.expectedArchive !== `synapti-flow-harness-${version}.tgz` ||
    options.expectedAttestation !== `flow-harness-${version}.intoto.jsonl` ||
    !/^[a-f0-9]{40}$/u.test(options.expectedRevision)
  ) {
    throw new PreviewNpmReleaseVerificationError();
  }
}

function verifyRelease(release, releaseNotes, options) {
  if (
    release.tagName !== options.expectedTag ||
    release.name !== options.expectedTitle ||
    release.body !== releaseNotes ||
    release.isDraft !== false ||
    release.isImmutable !== true ||
    release.isPrerelease !== true ||
    release.targetCommitish !== options.expectedRevision ||
    typeof release.publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(release.publishedAt) ||
    !Array.isArray(release.assets) ||
    release.assets.length !== 3
  ) {
    throw new PreviewNpmReleaseVerificationError();
  }

  const expectedAssets = new Set([
    options.expectedArchive,
    "package-release-evidence.json",
    options.expectedAttestation,
  ]);
  const observedAssets = new Set();
  for (const asset of release.assets) {
    if (
      !isObject(asset) ||
      typeof asset.name !== "string" ||
      !expectedAssets.has(asset.name) ||
      observedAssets.has(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1
    ) {
      throw new PreviewNpmReleaseVerificationError();
    }
    observedAssets.add(asset.name);
  }
  if (observedAssets.size !== expectedAssets.size) {
    throw new PreviewNpmReleaseVerificationError();
  }
}

async function readBoundedFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new PreviewNpmReleaseVerificationError();
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      content.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new PreviewNpmReleaseVerificationError();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } finally {
    await handle.close();
  }
}

function parseObject(source) {
  const value = JSON.parse(source);
  if (!isObject(value)) throw new PreviewNpmReleaseVerificationError();
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
