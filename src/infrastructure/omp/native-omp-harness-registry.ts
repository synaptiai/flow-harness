import { createHash } from "node:crypto";
import { accessSync, constants, type BigIntStats } from "node:fs";
import { access, type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExternalHarnessIdentity,
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import type {
  ExternalHarnessDescriptor,
  ExternalHarnessLaunch,
} from "../process/external-harness-descriptor.js";
import {
  ArtifactObservations,
  MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES,
  packageRoot,
  readTrustedArtifact,
  readTrustedPackageClosure,
  readTrustedRootSet,
  readTrustedRuntimeTree,
  sha256,
} from "../pi/native-pi-harness-registry.js";
import { FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST } from "../sandbox/srt-command-sandbox.js";

const NATIVE_OMP_ADAPTER_CONTRACT_VERSION = "1.0.0";
const SRT_VERSION = "0.0.70";
const OMP_VERSION = "17.2.12";
const OMP_INTEGRITY =
  "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==";

type BunReleaseAttestation = {
  readonly version: string;
  readonly platform: "linux";
  readonly architecture: "x64" | "arm64";
};

const OFFICIAL_BUN_RELEASE_ATTESTATIONS: Readonly<Record<string, BunReleaseAttestation>> =
  Object.freeze({
    "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74": Object.freeze({
      version: "1.3.14",
      platform: "linux",
      architecture: "x64",
    }),
    "37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086": Object.freeze({
      version: "1.3.14",
      platform: "linux",
      architecture: "arm64",
    }),
  });

export const NATIVE_OMP_EVALUATION_CONFIG = Object.freeze({
  version: 1,
  id: "omp-evaluation-v1",
  tools: Object.freeze(["read", "edit"]),
  session: "memory",
  settings: "memory",
  contextFiles: "deny",
  extensions: "deny",
  skills: "deny",
  rules: "deny",
  promptTemplates: "deny",
  mcp: "deny",
  lsp: "deny",
  retry: 0,
  compaction: "off",
});

type NativeOmpProfileSource = Extract<
  EvaluationProfileSource,
  { readonly adapter: "omp-native-v1" }
>;
type NativeOmpIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "omp-native-v1" }>;

export type NativeOmpHarnessLaunch = ExternalHarnessLaunch;
export type NativeOmpHarnessDescriptor = ExternalHarnessDescriptor;

export interface NativeOmpHarnessRegistryOptions {
  readonly driverPath?: string;
  readonly protocolPath?: string;
  readonly bunExecutable?: string;
  readonly runtimeSupportPaths?: readonly string[];
  readonly sourceRoot?: string;
  readonly localDependencyRoots?: readonly string[];
  readonly ompCodingAgentRoot?: string;
  readonly ompAiRoot?: string;
  readonly sandboxRuntimeRoot?: string;
  readonly bunReleaseAttestations?: Readonly<Record<string, BunReleaseAttestation>>;
}

export class NativeOmpHarnessRegistry {
  #cached:
    | {
        readonly descriptor: NativeOmpHarnessDescriptor;
        readonly observations: ArtifactObservations;
      }
    | undefined;
  readonly #bunExecutable: string;
  readonly #bunReleaseAttestations: Readonly<Record<string, BunReleaseAttestation>>;
  readonly #driverPath: string;
  readonly #localDependencyRoots: readonly string[];
  readonly #ompAiRoot: string;
  readonly #ompCodingAgentRoot: string;
  readonly #protocolPath: string;
  readonly #runtimeSupportPaths: readonly string[];
  readonly #sandboxRuntimeRoot: string;
  readonly #sourceRoot: string;

  constructor(options: NativeOmpHarnessRegistryOptions = {}) {
    const defaults = defaultArtifactPaths();
    this.#driverPath = options.driverPath ?? defaults.driverPath;
    this.#protocolPath = options.protocolPath ?? defaults.protocolPath;
    this.#bunExecutable = options.bunExecutable ?? defaults.bunExecutable;
    this.#bunReleaseAttestations =
      options.bunReleaseAttestations ?? OFFICIAL_BUN_RELEASE_ATTESTATIONS;
    this.#sourceRoot =
      options.sourceRoot ??
      (options.driverPath === undefined ? defaults.sourceRoot : dirname(this.#driverPath));
    this.#localDependencyRoots = Object.freeze([
      ...(options.localDependencyRoots ?? defaults.localDependencyRoots),
    ]);
    this.#ompCodingAgentRoot = options.ompCodingAgentRoot ?? defaults.ompCodingAgentRoot;
    this.#ompAiRoot = options.ompAiRoot ?? defaults.ompAiRoot;
    this.#sandboxRuntimeRoot = options.sandboxRuntimeRoot ?? defaults.sandboxRuntimeRoot;
    this.#runtimeSupportPaths = Object.freeze([
      ...new Set(options.runtimeSupportPaths ?? [this.#sourceRoot]),
    ]);
  }

  async resolve(profile: NativeOmpProfileSource): Promise<NativeOmpHarnessDescriptor> {
    if (profile.adapter !== "omp-native-v1" || profile.harness.config !== "omp-evaluation-v1") {
      throw new Error("native OMP registry received an unsupported profile selection");
    }
    return this.#currentDescriptor();
  }

  async resolveIdentity(profile: NativeOmpProfileSource): Promise<NativeOmpIdentity> {
    const identity = (await this.resolve(profile)).identity;
    if (identity.adapter !== "omp-native-v1") {
      throw new Error("native OMP registry produced the wrong adapter identity");
    }
    return identity;
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativeOmpHarnessDescriptor> {
    const admitted = parseExternalHarnessIdentity(identity);
    if (admitted.adapter !== "omp-native-v1") {
      throw new Error("native OMP registry received a different adapter identity");
    }
    const current = await this.#currentDescriptor();
    if (externalHarnessIdentityDigest(admitted) !== current.identityDigest) {
      throw new Error("external harness identity changed after evaluation plan admission");
    }
    return current;
  }

  async #currentDescriptor(): Promise<NativeOmpHarnessDescriptor> {
    if (this.#cached !== undefined && (await this.#cached.observations.isCurrent())) {
      return this.#cached.descriptor;
    }
    const observations = new ArtifactObservations();
    const [
      driver,
      protocol,
      source,
      localDependencies,
      sandboxRuntime,
      ompPackage,
      ompClosure,
      ompAi,
      ompAiClosure,
      bun,
    ] = await Promise.all([
      readTrustedArtifact(this.#driverPath, "native OMP driver", observations),
      readTrustedArtifact(this.#protocolPath, "external harness protocol", observations),
      readTrustedRuntimeTree(this.#sourceRoot, "native OMP local source closure", observations),
      readTrustedRootSet(
        this.#localDependencyRoots,
        "native OMP local package closure",
        observations,
        { rejectUnselectedNestedPackages: true },
      ),
      readTrustedPackageClosure(
        this.#sandboxRuntimeRoot,
        "@anthropic-ai/sandbox-runtime",
        SRT_VERSION,
        "sandbox runtime package closure",
        observations,
      ),
      readTrustedRuntimeTree(
        this.#ompCodingAgentRoot,
        "OMP coding-agent package",
        observations,
        true,
        true,
      ),
      readTrustedPackageClosure(
        this.#ompCodingAgentRoot,
        "@oh-my-pi/pi-coding-agent",
        OMP_VERSION,
        "OMP coding-agent package closure",
        observations,
        {
          bindResolutionGraph: true,
          includeMarkdown: true,
          includePeerDependencies: true,
          rejectUnselectedNestedPackages: true,
        },
      ),
      readTrustedRuntimeTree(this.#ompAiRoot, "OMP AI package", observations, true, true),
      readTrustedPackageClosure(
        this.#ompAiRoot,
        "@oh-my-pi/pi-ai",
        OMP_VERSION,
        "OMP AI package closure",
        observations,
        {
          bindResolutionGraph: true,
          includeMarkdown: true,
          includePeerDependencies: true,
          rejectUnselectedNestedPackages: true,
        },
      ),
      readTrustedBunExecutable(this.#bunExecutable, observations, this.#bunReleaseAttestations),
    ]);
    const identity = parseExternalHarnessIdentity({
      version: 1,
      adapter: "omp-native-v1",
      adapterContractVersion: NATIVE_OMP_ADAPTER_CONTRACT_VERSION,
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
        policyDigest: FLOW_NODE_PATH_SANDBOX_POLICY_DIGEST,
        platform: "linux",
        containment: "linux-pid-namespace",
      },
      driver: {
        id: "native-omp-evaluation-v1",
        artifactSha256: driver.sha256,
        dependencyClosureSha256: sha256(`${source.sha256}:${localDependencies.sha256}`),
        bun: { version: bun.version, executableSha256: bun.sha256 },
      },
      harness: {
        package: "@oh-my-pi/pi-coding-agent",
        version: OMP_VERSION,
        integrity: OMP_INTEGRITY,
        packageContentSha256: ompPackage.sha256,
        dependencyClosureSha256: sha256(`${ompClosure.sha256}:${ompAiClosure.sha256}`),
        config: "omp-evaluation-v1",
        configDigest: sha256(JSON.stringify(NATIVE_OMP_EVALUATION_CONFIG)),
      },
      inference: {
        id: "flow-omp-inference-v1",
        version: 1,
        package: "@oh-my-pi/pi-ai",
        packageVersion: OMP_VERSION,
        packageContentSha256: ompAi.sha256,
      },
    });
    if (identity.adapter !== "omp-native-v1") {
      throw new Error("native OMP registry produced the wrong identity variant");
    }
    const descriptor = Object.freeze({
      identity,
      identityDigest: externalHarnessIdentityDigest(identity),
      launch: Object.freeze({
        executable: bun.path,
        args: Object.freeze(["--no-env-file", "--no-install", "--config=/dev/null", driver.path]),
        runtimeSupportPaths: Object.freeze([
          ...new Set([
            ...this.#runtimeSupportPaths,
            ...localDependencies.runtimeSupportPaths,
            ...ompClosure.runtimeSupportPaths,
            ...ompAiClosure.runtimeSupportPaths,
            bun.path,
          ]),
        ]),
        environment: Object.freeze({
          NODE_PATH: [
            ...new Set([
              ...localDependencies.moduleSearchPaths,
              ...ompClosure.moduleSearchPaths,
              ...ompAiClosure.moduleSearchPaths,
            ]),
          ].join(delimiter),
        }),
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

async function readTrustedBunExecutable(
  path: string,
  observations: ArtifactObservations,
  releaseAttestations: Readonly<Record<string, BunReleaseAttestation>>,
): Promise<{ readonly path: string; readonly sha256: string; readonly version: string }> {
  await observations.add(path);
  const canonicalPath = await realpath(path);
  let handle: FileHandle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("Bun executable cannot be opened without following links", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new Error("Bun executable is not a regular file");
    }
    if ((Number(before.mode) & 0o111) === 0) {
      throw new Error("Bun executable is not executable");
    }
    if (before.size > BigInt(MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES)) {
      throw new Error(`Bun executable exceeds ${MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES} bytes`);
    }
    const hash = createHash("sha256");
    const versions = new Set<string>();
    let firstBytes = Buffer.alloc(0);
    let searchTail = "";
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1_024, MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES) {
        throw new Error(`Bun executable exceeds ${MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES} bytes`);
      }
      const bytes = chunk.subarray(0, bytesRead);
      if (firstBytes.length < 4) {
        firstBytes = Buffer.concat([firstBytes, bytes]).subarray(0, 4);
      }
      hash.update(bytes);
      const searchable = `${searchTail}${bytes.toString("latin1")}`;
      for (const match of searchable.matchAll(
        /Bun v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?: \([0-9a-f]{7,40}\))? (?:Linux|macOS)/g,
      )) {
        if (match[1] !== undefined) {
          versions.add(match[1]);
        }
      }
      searchTail = searchable.slice(-256);
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(total) !== before.size || !sameFileIdentity(before, after)) {
      throw new Error("Bun executable changed while Flow read it");
    }
    if (!isSupportedExecutableFormat(firstBytes)) {
      throw new Error("Bun executable is not a Linux ELF binary");
    }
    if (versions.size !== 1) {
      throw new Error("Bun executable does not contain one valid release version");
    }
    const version = [...versions][0] as string;
    if (!isSupportedBunVersion(version)) {
      throw new Error("native OMP requires Bun 1.3.14 or later");
    }
    const digest = hash.digest("hex");
    const attestation = releaseAttestations[digest];
    if (
      attestation === undefined ||
      attestation.platform !== "linux" ||
      attestation.version !== version
    ) {
      throw new Error("Bun executable is not a trusted official Bun release");
    }
    if (attestation.architecture !== process.arch) {
      throw new Error("Bun executable does not match the current Linux architecture");
    }
    try {
      await access(canonicalPath, constants.X_OK);
    } catch (error) {
      throw new Error("Bun executable is not executable by the current Flow user", {
        cause: error,
      });
    }
    const pathAfter = await lstat(canonicalPath, { bigint: true });
    if (!sameFileIdentity(after, pathAfter)) {
      throw new Error("Bun executable changed while Flow checked execute access");
    }
    observations.addObserved(canonicalPath, after);
    return Object.freeze({ path: canonicalPath, sha256: digest, version });
  } finally {
    await handle.close();
  }
}

function isSupportedExecutableFormat(bytes: Buffer): boolean {
  return bytes.toString("hex") === "7f454c46";
}

function isSupportedBunVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 14)));
}

function sameFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
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
  readonly bunExecutable: string;
  readonly sourceRoot: string;
  readonly localDependencyRoots: readonly string[];
  readonly ompCodingAgentRoot: string;
  readonly ompAiRoot: string;
  readonly sandboxRuntimeRoot: string;
} {
  const registryPath = fileURLToPath(import.meta.url);
  const extension = extname(registryPath);
  const sourceRoot = resolve(dirname(registryPath), "../..");
  const driverPath = join(dirname(registryPath), `native-omp-evaluation-driver${extension}`);
  const protocolPath = join(
    sourceRoot,
    "domain",
    "evaluation",
    `external-harness-protocol${extension}`,
  );
  const ompEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"));
  const ompAiEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-ai"));
  const sandboxRuntimeEntry = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
  const zodEntry = fileURLToPath(import.meta.resolve("zod"));
  return Object.freeze({
    driverPath,
    protocolPath,
    bunExecutable: defaultBunExecutable(),
    sourceRoot,
    localDependencyRoots: Object.freeze([packageRoot(zodEntry, "zod")]),
    ompCodingAgentRoot: packageRoot(ompEntry, "@oh-my-pi/pi-coding-agent"),
    ompAiRoot: packageRoot(ompAiEntry, "@oh-my-pi/pi-ai"),
    sandboxRuntimeRoot: packageRoot(sandboxRuntimeEntry, "@anthropic-ai/sandbox-runtime"),
  });
}

function defaultBunExecutable(): string {
  const configured = process.env.FLOW_BUN_EXECUTABLE?.trim();
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new Error("FLOW_BUN_EXECUTABLE must be an absolute path");
    }
    return configured;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") {
      continue;
    }
    const candidate = join(directory, "bun");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next host PATH entry.
    }
  }
  return join(homedir(), ".bun", "bin", "bun");
}
