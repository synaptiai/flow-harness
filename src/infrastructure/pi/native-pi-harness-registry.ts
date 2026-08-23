import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExternalHarnessIdentity,
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import { FLOW_SANDBOX_POLICY_DIGEST } from "../sandbox/srt-command-sandbox.js";
import type {
  ExternalHarnessDescriptor,
  ExternalHarnessLaunch,
} from "../process/external-harness-descriptor.js";

const MAX_TRUSTED_ARTIFACT_BYTES = 4 * 1_048_576;
export const MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES = 256 * 1_048_576;
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
type NativePiIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "pi-native-v1" }>;

export type NativePiHarnessLaunch = ExternalHarnessLaunch;
export type NativePiHarnessDescriptor = ExternalHarnessDescriptor;

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

  async resolveIdentity(profile: NativePiProfileSource): Promise<NativePiIdentity> {
    const identity = (await this.resolve(profile)).identity;
    if (identity.adapter !== "pi-native-v1") {
      throw new Error("native Pi registry produced the wrong adapter identity");
    }
    return identity;
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
        MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES,
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

interface TrustedRuntimeTree extends TrustedArtifact {
  readonly bytes: number;
  readonly files: number;
}

export interface TrustedPackageClosure extends TrustedRuntimeTree {
  readonly moduleSearchPaths: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta: Readonly<Record<string, { readonly optional: boolean }>>;
}

export async function readTrustedArtifact(
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

export async function readTrustedPackageClosure(
  root: string,
  expectedName: string,
  expectedVersion: string,
  label: string,
  observations: ArtifactObservations,
  options: {
    readonly bindResolutionGraph?: boolean;
    readonly includeMarkdown?: boolean;
    readonly includePeerDependencies?: boolean;
    readonly maxTotalBytes?: number;
    readonly maxTotalFiles?: number;
    readonly rejectUnselectedNestedPackages?: boolean;
    readonly resolutionRoot?: string;
  } = {},
): Promise<TrustedPackageClosure> {
  const packages = new Map<
    string,
    {
      readonly nodeId: string;
      readonly name: string;
      readonly version: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly files: number;
    }
  >();
  const edges: Array<{
    readonly from: string;
    readonly dependency: string;
    readonly kind: "required" | "optional" | "peer" | "optional-peer";
    readonly to: string;
  }> = [];
  const moduleSearchPaths = new Set<string>();
  const runtimeSupportPaths = new Set<string>();
  let closureBytes = 0;
  let closureFiles = 0;
  if (
    options.maxTotalBytes !== undefined &&
    (!Number.isSafeInteger(options.maxTotalBytes) || options.maxTotalBytes < 1)
  ) {
    throw new RangeError("package closure byte limit must be a positive safe integer");
  }
  if (
    options.maxTotalFiles !== undefined &&
    (!Number.isSafeInteger(options.maxTotalFiles) || options.maxTotalFiles < 1)
  ) {
    throw new RangeError("package closure file limit must be a positive safe integer");
  }
  const closureRoot = await realpath(root);
  const resolutionRoot =
    options.resolutionRoot === undefined
      ? parse(closureRoot).root
      : await realpath(options.resolutionRoot);
  const pathFromResolutionRoot = relative(resolutionRoot, closureRoot);
  if (
    pathFromResolutionRoot === ".." ||
    pathFromResolutionRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromResolutionRoot)
  ) {
    throw new Error(`${label} is outside its dependency-resolution root`);
  }
  const containingModuleRoot = containingNodeModulesRoot(closureRoot);
  if (containingModuleRoot !== undefined) {
    moduleSearchPaths.add(await realpath(containingModuleRoot));
  }

  async function visit(packageRootPath: string, optional: boolean): Promise<void> {
    let canonicalPackageRoot: string;
    try {
      canonicalPackageRoot = await realpath(packageRootPath);
    } catch (error) {
      if (optional) {
        return;
      }
      throw new Error(`${label} contains a missing dependency`, { cause: error });
    }
    if (packages.has(canonicalPackageRoot)) {
      return;
    }
    if (packages.size >= MAX_PACKAGE_CLOSURE_PACKAGES) {
      throw new Error(`${label} exceeds ${MAX_PACKAGE_CLOSURE_PACKAGES} packages`);
    }
    runtimeSupportPaths.add(canonicalPackageRoot);
    await observations.add(packageRootPath);
    const manifest = await readPackageManifest(canonicalPackageRoot, label, observations);
    const tree = await readTrustedRuntimeTree(
      canonicalPackageRoot,
      label,
      observations,
      true,
      options.includeMarkdown === true,
    );
    const nodeId = packageNodeId(closureRoot, canonicalPackageRoot);
    closureBytes += tree.bytes;
    closureFiles += tree.files;
    if (!Number.isSafeInteger(closureBytes) || closureBytes > (options.maxTotalBytes ?? Infinity)) {
      throw new Error(`${label} exceeds its runtime byte limit`);
    }
    if (!Number.isSafeInteger(closureFiles) || closureFiles > (options.maxTotalFiles ?? Infinity)) {
      throw new Error(`${label} exceeds its runtime file limit`);
    }
    packages.set(canonicalPackageRoot, {
      nodeId,
      name: manifest.name,
      version: manifest.version,
      sha256: tree.sha256,
      bytes: tree.bytes,
      files: tree.files,
    });
    for (const dependency of Object.keys(manifest.dependencies).sort()) {
      const dependencyRoot = await resolveDependencyRoot(
        canonicalPackageRoot,
        dependency,
        false,
        observations,
        resolutionRoot,
        moduleSearchPaths,
      );
      if (dependencyRoot === null) {
        throw new Error(`required package dependency ${dependency} is not installed`);
      }
      const canonicalDependencyRoot = await realpath(dependencyRoot);
      edges.push({
        from: nodeId,
        dependency,
        kind: "required",
        to: packageNodeId(closureRoot, canonicalDependencyRoot),
      });
      await visit(dependencyRoot, false);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies).sort()) {
      const dependencyRoot = await resolveDependencyRoot(
        canonicalPackageRoot,
        dependency,
        true,
        observations,
        resolutionRoot,
        moduleSearchPaths,
      );
      if (dependencyRoot !== null) {
        const canonicalDependencyRoot = await realpath(dependencyRoot);
        edges.push({
          from: nodeId,
          dependency,
          kind: "optional",
          to: packageNodeId(closureRoot, canonicalDependencyRoot),
        });
        await visit(dependencyRoot, true);
      }
    }
    if (options.includePeerDependencies === true) {
      for (const dependency of Object.keys(manifest.peerDependencies).sort()) {
        const optional = manifest.peerDependenciesMeta[dependency]?.optional === true;
        const dependencyRoot = await resolveDependencyRoot(
          canonicalPackageRoot,
          dependency,
          optional,
          observations,
          resolutionRoot,
          moduleSearchPaths,
        );
        if (dependencyRoot !== null) {
          const canonicalDependencyRoot = await realpath(dependencyRoot);
          edges.push({
            from: nodeId,
            dependency,
            kind: optional ? "optional-peer" : "peer",
            to: packageNodeId(closureRoot, canonicalDependencyRoot),
          });
          await visit(dependencyRoot, optional);
        }
      }
    }
  }

  await visit(closureRoot, false);
  if (options.rejectUnselectedNestedPackages === true) {
    await assertNoUnselectedNestedPackages(packages, label, observations);
  }
  const rootManifest = await readPackageManifest(closureRoot, label, observations);
  if (rootManifest.name !== expectedName || rootManifest.version !== expectedVersion) {
    throw new Error(`${label} does not match ${expectedName}@${expectedVersion}`);
  }
  const records = options.bindResolutionGraph
    ? {
        packages: [...packages.values()]
          .map(({ nodeId, name, version, sha256: digest }) => ({
            nodeId,
            name,
            version,
            sha256: digest,
          }))
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
        edges: edges.sort((left, right) =>
          `${left.from}:${left.kind}:${left.dependency}:${left.to}`.localeCompare(
            `${right.from}:${right.kind}:${right.dependency}:${right.to}`,
          ),
        ),
      }
    : [...packages.values()]
        .map(({ name, version, sha256: digest }) => ({ name, version, sha256: digest }))
        .sort((left, right) =>
          `${left.name}@${left.version}:${left.sha256}`.localeCompare(
            `${right.name}@${right.version}:${right.sha256}`,
          ),
        );
  return Object.freeze({
    path: closureRoot,
    sha256: sha256(JSON.stringify(records)),
    bytes: closureBytes,
    files: closureFiles,
    moduleSearchPaths: Object.freeze([...moduleSearchPaths]),
    runtimeSupportPaths: Object.freeze([...runtimeSupportPaths].sort()),
  });
}

async function assertNoUnselectedNestedPackages(
  packages: ReadonlyMap<string, unknown>,
  label: string,
  observations: ArtifactObservations,
): Promise<void> {
  let inspectedEntries = 0;
  for (const packagePath of packages.keys()) {
    await scanDirectory(packagePath);
  }

  async function scanDirectory(directory: string): Promise<void> {
    const before = await lstat(directory, { bigint: true });
    if (!before.isDirectory()) {
      throw new Error(`${label} contains an invalid package directory`);
    }
    observations.addObserved(directory, before);
    const handle = await opendir(directory);
    const children: Dirent<string>[] = [];
    for await (const child of handle) {
      children.push(child);
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_RUNTIME_OBSERVATIONS) {
        throw new Error(`${label} exceeds ${MAX_RUNTIME_OBSERVATIONS} nested-layout entries`);
      }
      if (!child.isDirectory()) {
        continue;
      }
      const childPath = join(directory, child.name);
      if (child.name === "node_modules") {
        await inspectPackageContainer(childPath);
      } else {
        await scanDirectory(childPath);
      }
    }
    const after = await lstat(directory, { bigint: true });
    if (!sameBigintFileIdentity(before, after)) {
      throw new Error(`${label} package directory changed while Flow read it`);
    }
  }

  async function inspectPackageContainer(container: string): Promise<void> {
    const before = await lstat(container, { bigint: true });
    if (!before.isDirectory()) {
      throw new Error(`${label} contains an invalid nested package container`);
    }
    observations.addObserved(container, before);
    const handle = await opendir(container);
    const children: Dirent<string>[] = [];
    for await (const child of handle) {
      children.push(child);
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_RUNTIME_OBSERVATIONS) {
        throw new Error(`${label} exceeds ${MAX_RUNTIME_OBSERVATIONS} nested-layout entries`);
      }
      const childPath = join(container, child.name);
      if (child.name.startsWith("@")) {
        if (!child.isDirectory()) {
          throw new Error(`${label} contains an invalid nested package scope`);
        }
        await observations.add(childPath);
        const scopeHandle = await opendir(childPath);
        const scopeChildren: Dirent<string>[] = [];
        for await (const scopeChild of scopeHandle) {
          scopeChildren.push(scopeChild);
        }
        for (const scopeChild of scopeChildren.sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          inspectedEntries += 1;
          if (inspectedEntries > MAX_RUNTIME_OBSERVATIONS) {
            throw new Error(`${label} exceeds ${MAX_RUNTIME_OBSERVATIONS} nested-layout entries`);
          }
          await assertSelectedNestedPackage(
            join(childPath, scopeChild.name),
            packages,
            label,
            observations,
          );
        }
        continue;
      }
      await assertSelectedNestedPackage(childPath, packages, label, observations);
    }
    const after = await lstat(container, { bigint: true });
    if (!sameBigintFileIdentity(before, after)) {
      throw new Error(`${label} nested package container changed while Flow read it`);
    }
  }
}

async function assertSelectedNestedPackage(
  path: string,
  packages: ReadonlyMap<string, unknown>,
  label: string,
  observations: ArtifactObservations,
): Promise<void> {
  await observations.add(path);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error) {
    throw new Error(`${label} contains an invalid nested package`, { cause: error });
  }
  if (!packages.has(canonicalPath)) {
    throw new Error(`${label} contains an unselected nested package`);
  }
}

function packageNodeId(root: string, packagePath: string): string {
  const path = relative(root, packagePath).split(sep).join("/");
  return path === "" ? "." : path;
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
    peerDependencies: stringRecord(record.peerDependencies),
    peerDependenciesMeta: peerDependencyMetaRecord(record.peerDependenciesMeta),
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

function peerDependencyMetaRecord(
  value: unknown,
): Readonly<Record<string, { readonly optional: boolean }>> {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package peer dependency metadata must be an object");
  }
  const result: Record<string, { readonly optional: boolean }> = {};
  for (const [name, metadata] of Object.entries(value)) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("package peer dependency metadata entry must be an object");
    }
    const optional = (metadata as Record<string, unknown>).optional;
    if (optional !== undefined && typeof optional !== "boolean") {
      throw new Error("package peer dependency optional flag must be a boolean");
    }
    result[name] = Object.freeze({ optional: optional === true });
  }
  return Object.freeze(result);
}

async function resolveDependencyRoot(
  root: string,
  packageName: string,
  optional: boolean,
  observations: ArtifactObservations,
  resolutionRoot: string,
  moduleSearchPaths: Set<string>,
): Promise<string | null> {
  let current = root;
  for (;;) {
    await observeDependencyResolutionContainers(current, packageName, observations);
    const candidate = join(current, "node_modules", ...packageName.split("/"));
    try {
      await realpath(candidate);
      moduleSearchPaths.add(await realpath(join(current, "node_modules")));
      return candidate;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    if (current === resolutionRoot) {
      break;
    }
    current = dirname(current);
  }
  if (optional) {
    return null;
  }
  throw new Error(`required package dependency ${packageName} is not installed`);
}

async function observeDependencyResolutionContainers(
  root: string,
  packageName: string,
  observations: ArtifactObservations,
): Promise<void> {
  let existing = root;
  const containerSegments = ["node_modules", ...packageName.split("/").slice(0, -1)];
  for (const segment of containerSegments) {
    const candidate = join(existing, segment);
    try {
      const stat = await lstat(candidate, { bigint: true });
      observations.addObserved(candidate, stat);
      existing = candidate;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      await observations.add(existing);
      return;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

export async function readTrustedRootSet(
  roots: readonly string[],
  label: string,
  observations: ArtifactObservations,
  options: { readonly rejectUnselectedNestedPackages?: boolean } = {},
): Promise<TrustedPackageClosure> {
  const records: string[] = [];
  const moduleSearchPaths = new Set<string>();
  const runtimeSupportPaths = new Set<string>();
  let bytes = 0;
  let files = 0;
  for (const root of roots) {
    const tree = await readTrustedPackageClosureFromUnknownRoot(root, label, observations, options);
    records.push(tree.sha256);
    bytes += tree.bytes;
    files += tree.files;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) {
      throw new Error(`${label} aggregate size exceeds a safe integer`);
    }
    tree.moduleSearchPaths.forEach((path) => {
      moduleSearchPaths.add(path);
    });
    tree.runtimeSupportPaths.forEach((path) => {
      runtimeSupportPaths.add(path);
    });
  }
  records.sort();
  return Object.freeze({
    path: "",
    sha256: sha256(JSON.stringify(records)),
    bytes,
    files,
    moduleSearchPaths: Object.freeze([...moduleSearchPaths]),
    runtimeSupportPaths: Object.freeze([...runtimeSupportPaths].sort()),
  });
}

async function readTrustedPackageClosureFromUnknownRoot(
  root: string,
  label: string,
  observations: ArtifactObservations,
  options: { readonly rejectUnselectedNestedPackages?: boolean },
): Promise<TrustedPackageClosure> {
  const canonicalRoot = await realpath(root);
  const manifest = await readPackageManifest(canonicalRoot, label, observations);
  return readTrustedPackageClosure(
    canonicalRoot,
    manifest.name,
    manifest.version,
    label,
    observations,
    options,
  );
}

function containingNodeModulesRoot(packageRootPath: string): string | undefined {
  let current = dirname(packageRootPath);
  const root = parse(current).root;
  for (;;) {
    if (current.endsWith(`${sep}node_modules`)) {
      return current;
    }
    if (current === root) {
      return undefined;
    }
    current = dirname(current);
  }
}

export async function readTrustedRuntimeTree(
  root: string,
  label: string,
  observations: ArtifactObservations,
  omitNodeModules = false,
  includeMarkdown = false,
): Promise<TrustedRuntimeTree> {
  await observations.add(root);
  const canonicalRoot = await realpath(root);
  const hash = createHash("sha256");
  let entries = 0;
  let totalBytes = 0;
  let files = 0;

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
      if (ignoredRuntimeFile(pathFromRoot, includeMarkdown)) {
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
      files += 1;
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
  return Object.freeze({
    path: canonicalRoot,
    sha256: hash.digest("hex"),
    bytes: totalBytes,
    files,
  });
}

function ignoredRuntimePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => [".bin", "docs", "examples", "test", "tests"].includes(segment));
}

function ignoredRuntimeFile(path: string, includeMarkdown: boolean): boolean {
  const name = path.split("/").at(-1) ?? path;
  return (
    name === "LICENSE" ||
    name.startsWith("README") ||
    name.startsWith("CHANGELOG") ||
    name.endsWith(".d.ts") ||
    extname(name) === ".map" ||
    (!includeMarkdown && extname(name) === ".md")
  );
}

export class ArtifactObservations {
  readonly #entries = new Map<string, BigIntStats>();

  async add(path: string): Promise<void> {
    this.addObserved(path, await lstat(path, { bigint: true }));
  }

  addObserved(path: string, stat: BigIntStats): void {
    if (!this.#entries.has(path) && this.#entries.size >= MAX_RUNTIME_OBSERVATIONS) {
      throw new Error(`external harness runtime exceeds ${MAX_RUNTIME_OBSERVATIONS} observations`);
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

export function packageRoot(path: string, packageName: string): string {
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

export function nodeModulesRoot(path: string): string {
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

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
