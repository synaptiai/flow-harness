import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PACKAGE_NAME = "@synaptiai/flow-harness";
const PREVIEW_VERSION_PATTERN = /^0\.1\.0-alpha\.[1-9]\d*$/u;
const PACKAGE_METADATA_LIMIT = 64 * 1024;
const SHRINKWRAP_METADATA_LIMIT = 1024 * 1024;
const RELEASE_NOTES_LIMIT = 256 * 1024;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class PreviewReleaseIdentityError extends Error {}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const identity = await resolveIdentity(options.root);
  process.stdout.write(
    options.githubOutput
      ? renderGitHubOutput(identity)
      : `${JSON.stringify(identity, undefined, 2)}\n`,
  );
}

async function resolveIdentity(root) {
  const manifest = parseObject(
    await readMetadata(join(root, "package.json"), PACKAGE_METADATA_LIMIT),
    "Preview release package manifest is invalid.",
  );
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new PreviewReleaseIdentityError("Preview release package name is unsupported.");
  }
  if (typeof manifest.version !== "string" || !PREVIEW_VERSION_PATTERN.test(manifest.version)) {
    throw new PreviewReleaseIdentityError("Preview release version is unsupported.");
  }

  const packageVersion = manifest.version;
  const shrinkwrap = parseObject(
    await readMetadata(join(root, "npm-shrinkwrap.json"), SHRINKWRAP_METADATA_LIMIT),
    "Preview release shrinkwrap is invalid.",
  );
  const rootPackage = isObject(shrinkwrap.packages) ? shrinkwrap.packages[""] : undefined;
  if (
    shrinkwrap.name !== EXPECTED_PACKAGE_NAME ||
    shrinkwrap.version !== packageVersion ||
    shrinkwrap.lockfileVersion !== 3 ||
    !isObject(rootPackage) ||
    rootPackage.name !== EXPECTED_PACKAGE_NAME ||
    rootPackage.version !== packageVersion
  ) {
    throw new PreviewReleaseIdentityError("Preview release shrinkwrap doesn't match package.json.");
  }

  const releaseNotesPath = `docs/releases/${packageVersion}.md`;
  const releaseTitle = `Flow ${packageVersion}`;
  const releaseNotes = await readMetadata(join(root, releaseNotesPath), RELEASE_NOTES_LIMIT);
  if (releaseNotes.split(/\r?\n/u, 1)[0] !== `# ${releaseTitle} release notes`) {
    throw new PreviewReleaseIdentityError(
      "Preview release notes heading doesn't match package.json.",
    );
  }

  return Object.freeze({
    packageName: EXPECTED_PACKAGE_NAME,
    packageVersion,
    releaseTag: `v${packageVersion}`,
    archiveName: `synaptiai-flow-harness-${packageVersion}.tgz`,
    attestationName: `flow-harness-${packageVersion}.intoto.jsonl`,
    releaseTitle,
    releaseNotesPath,
    npmDistTag: "preview",
  });
}

function parseArguments(args) {
  let root = DEFAULT_ROOT;
  let rootProvided = false;
  let githubOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--github-output" && !githubOutput) {
      githubOutput = true;
      continue;
    }
    if (argument === "--root" && !rootProvided) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new PreviewReleaseIdentityError("Preview release identity arguments are invalid.");
      }
      root = resolve(value);
      rootProvided = true;
      index += 1;
      continue;
    }
    throw new PreviewReleaseIdentityError("Preview release identity arguments are invalid.");
  }
  return Object.freeze({ githubOutput, root });
}

function renderGitHubOutput(identity) {
  const outputs = [
    ["package-name", identity.packageName],
    ["package-version", identity.packageVersion],
    ["release-tag", identity.releaseTag],
    ["archive-name", identity.archiveName],
    ["attestation-name", identity.attestationName],
    ["release-title", identity.releaseTitle],
    ["release-notes-path", identity.releaseNotesPath],
    ["npm-dist-tag", identity.npmDistTag],
  ];
  for (const [key, value] of outputs) {
    if (!/^[a-z0-9-]+$/u.test(key) || !/^[\x20-\x7e]+$/u.test(value) || value.length > 160) {
      throw new PreviewReleaseIdentityError("Preview release output is unsafe.");
    }
  }
  return `${outputs.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function parseObject(source, failureMessage) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new PreviewReleaseIdentityError(failureMessage);
  }
  if (!isObject(value)) {
    throw new PreviewReleaseIdentityError(failureMessage);
  }
  return value;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMetadata(path, byteLimit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isSystemError(error) && error.code === "ELOOP") {
      throw new PreviewReleaseIdentityError(
        "Preview release metadata must be a regular file without symbolic links.",
      );
    }
    throw new PreviewReleaseIdentityError("Preview release metadata is missing or unreadable.");
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new PreviewReleaseIdentityError(
        "Preview release metadata must be a regular file without symbolic links.",
      );
    }
    if (before.size > byteLimit) {
      throw new PreviewReleaseIdentityError("Preview release metadata exceeds its byte limit.");
    }

    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, byteLimit + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > byteLimit) {
        throw new PreviewReleaseIdentityError("Preview release metadata exceeds its byte limit.");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new PreviewReleaseIdentityError("Preview release metadata changed while it was read.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new PreviewReleaseIdentityError("Preview release metadata is not valid UTF-8.");
    }
  } finally {
    await handle.close();
  }
}

function isSystemError(error) {
  return error instanceof Error && "code" in error;
}

main().catch((error) => {
  const message =
    error instanceof PreviewReleaseIdentityError
      ? error.message
      : "Preview release identity resolution failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
