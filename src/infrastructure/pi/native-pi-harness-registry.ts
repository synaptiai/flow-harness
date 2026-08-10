import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExternalHarnessIdentity,
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import { FLOW_SANDBOX_POLICY_DIGEST } from "../sandbox/srt-command-sandbox.js";

const MAX_TRUSTED_ARTIFACT_BYTES = 4 * 1_048_576;
const MAX_NODE_EXECUTABLE_BYTES = 256 * 1_048_576;
const MAX_RUNTIME_TREE_BYTES = 512 * 1_048_576;
const MAX_RUNTIME_TREE_ENTRIES = 50_000;
const MAX_PACKAGE_CLOSURE_PACKAGES = 1_024;
const MAX_RUNTIME_OBSERVATIONS = 200_000;
const NATIVE_PI_ADAPTER_CONTRACT_VERSION = "1.0.0";
const SRT_VERSION = "0.0.70";
const PI_VERSION = "0.84.0";
const PI_INTEGRITY =
  "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==";
const PI_AI_VERSION = "0.84.0";
const PI_AI_INTEGRITY =
  "sha512-N9RDk8q0eglGiy+NqTZ3Ev2j+6oFNXSAJa8b0CYhvWB9HGiKZjsoCESXkUvMDLybrn0wXp75sdsoBzEtHxk9kA==";

export const NATIVE_PI_EVALUATION_CONFIG = Object.freeze({
  version: 1,
  id: "pi-evaluation-v1",
  tools: Object.freeze(["read", "edit"]),
  session: "memory",
  settings: "memory",
  contextFiles: "deny",
  extensions: "deny",
  skills: "deny",
  promptTemplates: "deny",
  retry: 0,
  compaction: "off",
});

type NativePiProfileSource = Extract<EvaluationProfileSource, { readonly adapter: "pi-native-v1" }>;

export interface NativePiHarnessLaunch {
  readonly executable: string;
  readonly args: readonly [string];
  readonly runtimeSupportPaths: readonly string[];
}

export interface NativePiHarnessDescriptor {
  readonly identity: ExternalHarnessIdentity;
  readonly identityDigest: string;
  readonly launch: NativePiHarnessLaunch;
  assertCurrent(): Promise<void>;
}

export interface NativePiHarnessRegistryOptions {
  readonly driverPath?: string;
  readonly protocolPath?: string;
  readonly nodeExecutable?: string;
  readonly runtimeSupportPaths?: readonly string[];
  readonly sourceRoot?: string;
  readonly localDependencyRoots?: readonly string[];
  readonly piCodingAgentRoot?: string;
  readonly piAiRoot?: string;
  readonly sandboxRuntimeRoot?: string;
}

export class NativePiHarnessRegistry {
  #cached:
    | {
        readonly descriptor: NativePiHarnessDescriptor;
        readonly observations: ArtifactObservations;
      }
    | undefined;
  readonly #driverPath: string;
  readonly #localDependencyRoots: readonly string[];
  readonly #nodeExecutable: string;
  readonly #piAiRoot: string;
  readonly #piCodingAgentRoot: string;
  readonly #protocolPath: string;
  readonly #runtimeSupportPaths: readonly string[];
  readonly #sandboxRuntimeRoot: string;
  readonly #sourceRoot: string;

  constructor(options: NativePiHarnessRegistryOptions = {}) {
    const defaults = defaultArtifactPaths();
    this.#driverPath = options.driverPath ?? defaults.driverPath;
    this.#protocolPath = options.protocolPath ?? defaults.protocolPath;
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#sourceRoot =
      options.sourceRoot ??
      (options.driverPath === undefined ? defaults.sourceRoot : dirname(this.#driverPath));
    this.#localDependencyRoots = Object.freeze([
      ...(options.localDependencyRoots ?? defaults.localDependencyRoots),
    ]);
    this.#piCodingAgentRoot = options.piCodingAgentRoot ?? defaults.piCodingAgentRoot;
    this.#piAiRoot = options.piAiRoot ?? defaults.piAiRoot;
    this.#sandboxRuntimeRoot = options.sandboxRuntimeRoot ?? defaults.sandboxRuntimeRoot;
    this.#runtimeSupportPaths = Object.freeze([
      ...new Set(options.runtimeSupportPaths ?? defaults.runtimeSupportPaths),
    ]);
  }

  async resolve(profile: NativePiProfileSource): Promise<NativePiHarnessDescriptor> {
    if (profile.adapter !== "pi-native-v1" || profile.harness.config !== "pi-evaluation-v1") {
      throw new Error("native Pi registry received an unsupported profile selection");
    }
    return this.#currentDescriptor();
  }

  async resolveIdentity(profile: NativePiProfileSource): Promise<ExternalHarnessIdentity> {
    return (await this.resolve(profile)).identity;
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativePiHarnessDescriptor> {
    const admitted = parseExternalHarnessIdentity(identity);
    const current = await this.#currentDescriptor();
    if (externalHarnessIdentityDigest(admitted) !== current.identityDigest) {
      throw new Error("external harness identity changed after evaluation plan admission");
    }
    return current;
  }

  async #currentDescriptor(): Promise<NativePiHarnessDescriptor> {
    if (this.#cached !== undefined && (await this.#cached.observations.isCurrent())) {
      return this.#cached.descriptor;
    }
    const observations = new ArtifactObservations();
    await observations.add(this.#nodeExecutable);
    const canonicalNodeExecutable = await realpath(this.#nodeExecutable);
    if (canonicalNodeExecutable !== (await realpath(process.execPath))) {
      throw new Error("native Pi registry cannot verify a different Node executable version");
    }
    const [
      driver,
      protocol,
      source,
      localDependencies,
      sandboxRuntime,
      piCodingAgent,
      piAi,
      nodeExecutable,
    ] = await Promise.all([
      readTrustedArtifact(this.#driverPath, "native Pi driver", observations),
      readTrustedArtifact(this.#protocolPath, "external harness protocol", observations),
      readTrustedRuntimeTree(this.#sourceRoot, "native Pi local source closure", observations),
      readTrustedRootSet(
        this.#localDependencyRoots,
        "native Pi local package closure",
        observations,
      ),
      readTrustedPackageClosure(
        this.#sandboxRuntimeRoot,
        "@anthropic-ai/sandbox-runtime",
        SRT_VERSION,
        "sandbox runtime package closure",
        observations,
      ),
      readTrustedPackageClosure(
        this.#piCodingAgentRoot,
        "@earendil-works/pi-coding-agent",
        PI_VERSION,
        "Pi coding-agent package closure",
        observations,
      ),
      readTrustedPackageClosure(
        this.#piAiRoot,
        "@earendil-works/pi-ai",
        PI_AI_VERSION,
        "Pi AI package closure",
        observations,
      ),
      readTrustedArtifact(
        canonicalNodeExecutable,
        "Node executable",
        observations,
        MAX_NODE_EXECUTABLE_BYTES,
      ),
    ]);
    const identity = parseExternalHarnessIdentity({
      version: 1,
      adapter: "pi-native-v1",
      adapterContractVersion: NATIVE_PI_ADAPTER_CONTRACT_VERSION,
      protocol: {
        id: "flow-external-harness-jsonl-v1",
        maxFrameBytes: 1_048_576,
        digest: protocol.sha256,
      },
      runtime: {
        id: "srt-process-v1",
        package: "@anthropic-ai/sandbox-runtime",
        version: SRT_VERSION,
        packageContentSha256: sandboxRuntime.sha256,
        policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
        platform: "linux",
        containment: "linux-pid-namespace",
      },
      driver: {
        id: "native-pi-evaluation-v1",
        artifactSha256: driver.sha256,
        dependencyClosureSha256: sha256(`${source.sha256}:${localDependencies.sha256}`),
        node: {
          version: process.versions.node,
          executableSha256: nodeExecutable.sha256,
        },
      },
      harness: {
        package: "@earendil-works/pi-coding-agent",
        version: PI_VERSION,
        integrity: PI_INTEGRITY,
        packageContentSha256: piCodingAgent.sha256,
        config: "pi-evaluation-v1",
        configDigest: sha256(JSON.stringify(NATIVE_PI_EVALUATION_CONFIG)),
      },
      inference: {
        id: "flow-pi-inference-v1",
        version: 1,
        package: "@earendil-works/pi-ai",
        packageVersion: PI_AI_VERSION,
        packageIntegrity: PI_AI_INTEGRITY,
        packageContentSha256: piAi.sha256,
      },
    });
    const descriptor = Object.freeze({
      identity,
      identityDigest: externalHarnessIdentityDigest(identity),
      launch: Object.freeze({
        executable: canonicalNodeExecutable,
        args: Object.freeze([driver.path] as const),
        runtimeSupportPaths: this.#runtimeSupportPaths,
      }),
      assertCurrent: async () => {
        if (!(await observations.isCurrent())) {
          throw new Error("external harness identity changed after evaluation plan admission");
        }
      },
    });
    this.#cached = Object.freeze({ descriptor, observations });
    return descriptor;
  }
}

interface TrustedArtifact {
  readonly path: string;
  readonly sha256: string;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

async function readTrustedArtifact(
  path: string,
  label: string,
  observations: ArtifactObservations,
  maxBytes = MAX_TRUSTED_ARTIFACT_BYTES,
): Promise<TrustedArtifact> {
  await observations.add(path);
  const canonicalPath = await realpath(path);
  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} cannot be opened without following links`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error(`${label} is not a regular file`);
    }
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(total) !== before.size || !sameBigintFileIdentity(before, after)) {
      throw new Error(`${label} changed while Flow read it`);
    }
    observations.addObserved(canonicalPath, after);
    return Object.freeze({ path: canonicalPath, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}

async function readTrustedText(
  path: string,
  label: string,
  observations: ArtifactObservations,
): Promise<string> {
  await observations.add(path);
  const canonicalPath = await realpath(path);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_TRUSTED_ARTIFACT_BYTES)) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1_024, MAX_TRUSTED_ARTIFACT_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_TRUSTED_ARTIFACT_BYTES) {
        throw new Error(`${label} exceeds ${MAX_TRUSTED_ARTIFACT_BYTES} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(total) !== before.size || !sameBigintFileIdentity(before, after)) {
      throw new Error(`${label} changed while Flow read it`);
    }
    observations.addObserved(canonicalPath, after);
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTrustedPackageClosure(
  root: string,
  expectedName: string,
  expectedVersion: string,
  label: string,
  observations: ArtifactObservations,
): Promise<TrustedArtifact> {
  const packages = new Map<
    string,
    { readonly name: string; readonly version: string; readonly sha256: string }
  >();

  async function visit(packageRootPath: string, optional: boolean): Promise<void> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(packageRootPath);
    } catch (error) {
      if (optional) {
        return;
      }
      throw new Error(`${label} contains a missing dependency`, { cause: error });
    }
    if (packages.has(canonicalRoot)) {
      return;
    }
    if (packages.size >= MAX_PACKAGE_CLOSURE_PACKAGES) {
      throw new Error(`${label} exceeds ${MAX_PACKAGE_CLOSURE_PACKAGES} packages`);
    }
    await observations.add(packageRootPath);
    const manifest = await readPackageManifest(canonicalRoot, label, observations);
    const tree = await readTrustedRuntimeTree(canonicalRoot, label, observations, true);
    packages.set(canonicalRoot, {
      name: manifest.name,
      version: manifest.version,
      sha256: tree.sha256,
    });
    for (const dependency of Object.keys(manifest.dependencies).sort()) {
      const dependencyRoot = await resolveDependencyRoot(canonicalRoot, dependency, false);
      if (dependencyRoot === null) {
        throw new Error(`required package dependency ${dependency} is not installed`);
      }
      await visit(dependencyRoot, false);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies).sort()) {
      const dependencyRoot = await resolveDependencyRoot(canonicalRoot, dependency, true);
      if (dependencyRoot !== null) {
        await visit(dependencyRoot, true);
      }
    }
  }

  const canonicalRoot = await realpath(root);
  await visit(canonicalRoot, false);
  const rootManifest = await readPackageManifest(canonicalRoot, label, observations);
  if (rootManifest.name !== expectedName || rootManifest.version !== expectedVersion) {
    throw new Error(`${label} does not match ${expectedName}@${expectedVersion}`);
  }
  const records = [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}:${left.sha256}`.localeCompare(
      `${right.name}@${right.version}:${right.sha256}`,
    ),
  );
  return Object.freeze({ path: canonicalRoot, sha256: sha256(JSON.stringify(records)) });
}

async function readPackageManifest(
  root: string,
  label: string,
  observations: ArtifactObservations,
): Promise<PackageManifest> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readTrustedText(join(root, "package.json"), `${label} manifest`, observations),
    );
  } catch (error) {
    throw new Error(`${label} manifest is not valid JSON`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} manifest must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(`${label} manifest needs a package name and version`);
  }
  return Object.freeze({
    name: record.name,
    version: record.version,
    dependencies: stringRecord(record.dependencies),
    optionalDependencies: stringRecord(record.optionalDependencies),
  });
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package dependency map must be an object");
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") {
      throw new Error("package dependency version must be a string");
    }
    result[name] = version;
  }
  return Object.freeze(result);
}

async function resolveDependencyRoot(
  root: string,
  packageName: string,
  optional: boolean,
): Promise<string | null> {
  let current = root;
  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    const candidate = join(current, "node_modules", ...packageName.split("/"));
    try {
      await realpath(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    current = dirname(current);
  }
  if (optional) {
    return null;
  }
  throw new Error(`required package dependency ${packageName} is not installed`);
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function readTrustedRootSet(
  roots: readonly string[],
  label: string,
  observations: ArtifactObservations,
): Promise<TrustedArtifact> {
  const records: string[] = [];
  for (const root of roots) {
    const tree = await readTrustedPackageClosureFromUnknownRoot(root, label, observations);
    records.push(tree.sha256);
  }
  records.sort();
  return Object.freeze({ path: "", sha256: sha256(JSON.stringify(records)) });
}

async function readTrustedPackageClosureFromUnknownRoot(
  root: string,
  label: string,
  observations: ArtifactObservations,
): Promise<TrustedArtifact> {
  const canonicalRoot = await realpath(root);
  const manifest = await readPackageManifest(canonicalRoot, label, observations);
  return readTrustedPackageClosure(
    canonicalRoot,
    manifest.name,
    manifest.version,
    label,
    observations,
  );
}

async function readTrustedRuntimeTree(
  root: string,
  label: string,
  observations: ArtifactObservations,
  omitNodeModules = false,
): Promise<TrustedArtifact> {
  await observations.add(root);
  const canonicalRoot = await realpath(root);
  const hash = createHash("sha256");
  let entries = 0;
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory()) {
      throw new Error(`${label} contains a non-directory traversal root`);
    }
    const children: Dirent<string>[] = [];
    const handle = await opendir(directory);
    for await (const child of handle) {
      children.push(child);
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_RUNTIME_TREE_ENTRIES) {
        throw new Error(`${label} exceeds ${MAX_RUNTIME_TREE_ENTRIES} entries`);
      }
      if (omitNodeModules && child.name === "node_modules" && child.isDirectory()) {
        continue;
      }
      const path = join(directory, child.name);
      const pathFromRoot = relative(canonicalRoot, path).split(sep).join("/");
      if (child.isDirectory()) {
        if (ignoredRuntimePath(pathFromRoot)) {
          continue;
        }
        await visit(path);
        continue;
      }
      if (child.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link`);
      }
      if (!child.isFile()) {
        throw new Error(`${label} contains a special filesystem entry`);
      }
      const stat = await lstat(path, { bigint: true });
      if (ignoredRuntimeFile(pathFromRoot)) {
        continue;
      }
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`${label} contains an invalid file size`);
      }
      totalBytes += size;
      if (totalBytes > MAX_RUNTIME_TREE_BYTES) {
        throw new Error(`${label} exceeds ${MAX_RUNTIME_TREE_BYTES} runtime bytes`);
      }
      const artifact = await readTrustedArtifact(
        path,
        `${label} entry`,
        observations,
        MAX_RUNTIME_TREE_BYTES,
      );
      hash.update(`${pathFromRoot}\0${(Number(stat.mode) & 0o777).toString(8)}\0${size}\0`);
      hash.update(artifact.sha256);
      hash.update("\0");
    }
    const after = await lstat(directory, { bigint: true });
    if (!sameBigintFileIdentity(before, after)) {
      throw new Error(`${label} changed while Flow read it`);
    }
    observations.addObserved(directory, after);
  }

  await visit(canonicalRoot);
  return Object.freeze({ path: canonicalRoot, sha256: hash.digest("hex") });
}

function ignoredRuntimePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => [".bin", "docs", "examples", "test", "tests"].includes(segment));
}

function ignoredRuntimeFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return (
    name === "LICENSE" ||
    name.startsWith("README") ||
    name.startsWith("CHANGELOG") ||
    name.endsWith(".d.ts") ||
    [".map", ".md"].includes(extname(name))
  );
}

class ArtifactObservations {
  readonly #entries = new Map<string, BigIntStats>();

  async add(path: string): Promise<void> {
    this.addObserved(path, await lstat(path, { bigint: true }));
  }

  addObserved(path: string, stat: BigIntStats): void {
    if (!this.#entries.has(path) && this.#entries.size >= MAX_RUNTIME_OBSERVATIONS) {
      throw new Error(`native Pi runtime exceeds ${MAX_RUNTIME_OBSERVATIONS} observations`);
    }
    this.#entries.set(path, stat);
  }

  async isCurrent(): Promise<boolean> {
    const entries = [...this.#entries.entries()];
    for (let offset = 0; offset < entries.length; offset += 256) {
      const batch = entries.slice(offset, offset + 256);
      const current = await Promise.all(
        batch.map(async ([path, expected]) => {
          try {
            return sameBigintFileIdentity(expected, await lstat(path, { bigint: true }));
          } catch {
            return false;
          }
        }),
      );
      if (current.some((value) => !value)) {
        return false;
      }
    }
    return true;
  }
}

function sameBigintFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function defaultArtifactPaths(): {
  readonly driverPath: string;
  readonly protocolPath: string;
  readonly runtimeSupportPaths: readonly string[];
  readonly sourceRoot: string;
  readonly localDependencyRoots: readonly string[];
  readonly piCodingAgentRoot: string;
  readonly piAiRoot: string;
  readonly sandboxRuntimeRoot: string;
} {
  const registryPath = fileURLToPath(import.meta.url);
  const extension = extname(registryPath);
  const sourceRoot = resolve(dirname(registryPath), "../..");
  const driverPath = join(dirname(registryPath), `native-pi-evaluation-driver${extension}`);
  const protocolPath = join(
    sourceRoot,
    "domain",
    "evaluation",
    `external-harness-protocol${extension}`,
  );
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const sandboxRuntimeEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
  const zodEntry = fileURLToPath(import.meta.resolve("zod"));
  return Object.freeze({
    driverPath,
    protocolPath,
    runtimeSupportPaths: Object.freeze([sourceRoot, nodeModulesRoot(piEntry)]),
    sourceRoot,
    localDependencyRoots: Object.freeze([packageRoot(zodEntry, "zod")]),
    piCodingAgentRoot: packageRoot(piEntry, "@earendil-works/pi-coding-agent"),
    piAiRoot: packageRoot(piAiEntry, "@earendil-works/pi-ai"),
    sandboxRuntimeRoot: packageRoot(sandboxRuntimeEntry, "@anthropic-ai/sandbox-runtime"),
  });
}

function packageRoot(path: string, packageName: string): string {
  const suffix = join(...packageName.split("/"));
  let current = dirname(path);
  const root = parse(current).root;
  while (current !== root) {
    if (current.endsWith(`${sep}${suffix}`)) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`${packageName} does not resolve from its package root`);
}

function nodeModulesRoot(path: string): string {
  let current = dirname(path);
  const root = parse(current).root;
  while (current !== root) {
    if (current.endsWith("node_modules")) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error("Pi package does not resolve from a node_modules directory");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
