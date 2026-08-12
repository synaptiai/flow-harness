import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ENTRIES = 131_072;
const MAX_LOGICAL_BYTES = 2_147_483_648;
const MAX_FILE_BYTES = 536_870_912;
const MAX_METADATA_BYTES = 1_048_576;

export async function createRuntimeInventory(input) {
  const node = await scanTree(input.nodeRoot);
  const prime = await scanTree(input.primeRoot);
  const python = await scanTree(input.pythonRoot);
  const flowDist = await scanTree(input.flowDistRoot);
  const artifacts = Object.freeze({
    driverSha256: await hashRegularFile(input.artifacts.driver),
    flowDistSha256: flowDist.sha256,
    kernelProxySha256: await hashRegularFile(input.artifacts.kernelProxy),
    noIoResourceLoaderSha256: await hashRegularFile(input.artifacts.noIoResourceLoader),
    pythonLauncherSha256: await hashRegularFile(input.artifacts.pythonLauncher),
    supervisorSha256: await hashRegularFile(input.artifacts.supervisor),
  });
  const sbom = Object.freeze({
    node: await nodePackageInventory(input.nodeRoot, node.files),
    python: await pythonPackageInventory(input.pythonRoot, python.files),
  });
  return Object.freeze({
    nodeVersion: process.versions.node,
    pythonVersion: await readPythonVersion(input.pythonRoot),
    nodeClosureSha256: node.sha256,
    primePackageContentSha256: prime.sha256,
    pythonClosureSha256: python.sha256,
    artifacts,
    sbom,
    sbomSha256: sha256(canonicalize(sbom)),
  });
}

async function hashRegularFile(path) {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > BigInt(MAX_FILE_BYTES)) {
    throw new Error("Prime image artifact is not one bounded regular file");
  }
  return sha256(await readStableFile(path, metadata));
}

async function scanTree(inputRoot) {
  const requestedRoot = resolve(inputRoot);
  const root = await realpath(requestedRoot);
  if (root !== requestedRoot || !(await lstat(root)).isDirectory()) {
    throw new Error("Prime image probe root is not one canonical directory");
  }
  const entries = [];
  const files = [];
  let logicalBytes = 0;
  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath =
        relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      validateRelativePath(relativePath);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isDirectory()) {
        entries.push(`d\0${relativePath}\0${Number(metadata.mode & 0o777n).toString(8)}\n`);
        await walk(path, relativePath);
      } else if (metadata.isFile()) {
        if (metadata.size > BigInt(MAX_FILE_BYTES)) {
          throw new Error("Prime image probe file exceeds its byte limit");
        }
        const bytes = await readStableFile(path, metadata);
        logicalBytes += bytes.byteLength;
        if (logicalBytes > MAX_LOGICAL_BYTES) {
          throw new Error("Prime image probe closure exceeds its logical-byte limit");
        }
        entries.push(
          `f\0${relativePath}\0${Number(metadata.mode & 0o777n).toString(8)}\0${bytes.byteLength}\0${sha256(bytes)}\n`,
        );
        files.push(Object.freeze({ path, relativePath, bytes: bytes.byteLength }));
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(path, "utf8");
        const resolvedTarget = isAbsolute(target)
          ? resolve(target)
          : resolve(dirname(path), target);
        const fromRoot = relative(root, resolvedTarget);
        if (
          fromRoot === ".." ||
          fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
        ) {
          throw new Error("Prime image probe symbolic link escapes its closure");
        }
        entries.push(`l\0${relativePath}\0${target}\n`);
      } else {
        throw new Error("Prime image probe closure contains a special file");
      }
      if (entries.length > MAX_ENTRIES) {
        throw new Error("Prime image probe closure exceeds its entry limit");
      }
    }
  }
  await walk(root, "");
  return Object.freeze({ sha256: sha256(entries.join("")), files: Object.freeze(files) });
}

async function readStableFile(path, before) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Prime image probe file changed while read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function nodePackageInventory(root, files) {
  const packages = [];
  for (const file of files) {
    if (basename(file.path) !== "package.json") {
      continue;
    }
    const manifest = parseBoundedJson(await readFile(file.path), "Node package manifest");
    if (typeof manifest.name === "string" && typeof manifest.version === "string") {
      packages.push({
        name: boundedIdentity(manifest.name),
        version: boundedIdentity(manifest.version),
      });
    }
  }
  return uniquePackages(packages, root);
}

async function pythonPackageInventory(root, files) {
  const packages = [];
  for (const file of files) {
    if (basename(file.path) !== "METADATA" || !dirname(file.path).endsWith(".dist-info")) {
      continue;
    }
    if (file.bytes > MAX_METADATA_BYTES) {
      throw new Error("Python package metadata exceeds its byte limit");
    }
    const metadata = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file.path));
    const name = /^Name:\s*([^\r\n]+)$/im.exec(metadata)?.[1];
    const version = /^Version:\s*([^\r\n]+)$/im.exec(metadata)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error("Python package metadata omits its name or version");
    }
    packages.push({ name: boundedIdentity(name.trim()), version: boundedIdentity(version.trim()) });
  }
  return uniquePackages(packages, root);
}

async function readPythonVersion(root) {
  const configuration = await readFile(join(root, "pyvenv.cfg"), "utf8");
  const version = /^version\s*=\s*([^\r\n]+)$/im.exec(configuration)?.[1]?.trim();
  if (version === undefined || !/^3\.11\.\d+$/.test(version)) {
    throw new Error("Prime Python environment has an invalid version");
  }
  return version;
}

function uniquePackages(packages, label) {
  const unique = new Map();
  for (const item of packages) {
    unique.set(`${item.name}\0${item.version}`, Object.freeze(item));
  }
  const values = [...unique.values()].sort((left, right) =>
    `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`, "en"),
  );
  if (values.length > 8_192) {
    throw new Error(`${label} package inventory exceeds its count limit`);
  }
  return Object.freeze(values);
}

function parseBoundedJson(bytes, label) {
  if (bytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function boundedIdentity(value) {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
  if (value.length < 1 || value.length > 256 || hasControlCharacter) {
    throw new Error("Prime image package identity is outside its bounds");
  }
  return value;
}

function validateRelativePath(path) {
  const bytes = Buffer.byteLength(path, "utf8");
  if (
    bytes < 1 ||
    bytes > 4_095 ||
    path.split("/").some((part) => Buffer.byteLength(part, "utf8") > 255)
  ) {
    throw new Error("Prime image probe path exceeds its Linux bounds");
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const inventory = await createRuntimeInventory({
    nodeRoot: "/opt/flow/node/node_modules",
    primeRoot: "/opt/flow/node/node_modules/prime-agent",
    pythonRoot: "/opt/flow/python",
    flowDistRoot: "/opt/flow/node/flow-dist",
    artifacts: {
      driver:
        "/opt/flow/node/flow-dist/infrastructure/prime/native-prime-agent-evaluation-driver.js",
      kernelProxy: "/opt/flow/bin/flow-prime-kernel-proxy",
      noIoResourceLoader: "/opt/flow/node/flow-dist/infrastructure/prime/no-io-resource-loader.js",
      pythonLauncher: "/opt/flow/bin/flow-prime-python",
      supervisor: "/opt/flow/bin/flow-prime-supervisor",
    },
  });
  process.stdout.write(`${canonicalize(inventory)}\n`);
}
