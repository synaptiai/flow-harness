import { dirname, join, resolve } from "node:path";

import {
  type ExternalHarnessIdentity,
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import {
  ArtifactObservations,
  readTrustedArtifact,
  readTrustedRuntimeTree,
  sha256,
} from "../pi/native-pi-harness-registry.js";
import type { PrimeOciLocalRuntimeAttestation } from "../oci/local-prime-oci-attestation.js";

const NATIVE_PRIME_ADAPTER_CONTRACT_VERSION = "1.0.0";
const PRIME_AGENT_VERSION = "0.7.1";
const PRIME_AGENT_ARCHIVE_SHA256 =
  "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb";

export const NATIVE_PRIME_EVALUATION_CONFIG = Object.freeze({
  version: 1,
  id: "prime-agent-rlm-evaluation-v1",
  tools: Object.freeze(["ipython"]),
  session: "memory",
  settings: "memory",
  resourceLoader: "no-io",
  includeGoals: false,
  extensions: "deny",
  skills: "deny",
  schedules: "deny",
  mcp: "deny",
  rules: "deny",
  promptTemplates: "deny",
  agentStorage: "memory",
  autonomousMode: "off",
  prewarm: false,
  forkserver: "off",
  retry: 0,
  compaction: "off",
  rlmDepth: 0,
  maxModelTurns: 64,
});

type NativePrimeProfileSource = Extract<
  EvaluationProfileSource,
  { readonly adapter: "prime-agent-native-v1" }
>;
type NativePrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface PrimeOciIdentityAttestation {
  readonly runtime: NativePrimeIdentity["runtime"];
  readonly image: NativePrimeIdentity["image"];
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(): Promise<void>;
}

export interface NativePrimeHarnessDescriptor {
  readonly identity: NativePrimeIdentity;
  readonly identityDigest: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(): Promise<void>;
}

export interface NativePrimeHarnessRegistryOptions {
  readonly driverPath?: string;
  readonly protocolPath?: string;
  readonly outerProtocolPath?: string;
  readonly supervisorPath?: string;
  readonly kernelProxyPath?: string;
  readonly pythonLauncherPath?: string;
  readonly noIoResourceLoaderPath?: string;
  readonly inferenceBrokerPath?: string;
  readonly sourceRoot?: string;
  readonly attestationPath?: string;
  readonly resolveOciIdentity?: () => Promise<PrimeOciIdentityAttestation>;
}

interface PrimeArtifactPaths {
  readonly driverPath: string;
  readonly protocolPath: string;
  readonly outerProtocolPath: string;
  readonly supervisorPath: string;
  readonly kernelProxyPath: string;
  readonly pythonLauncherPath: string;
  readonly noIoResourceLoaderPath: string;
  readonly inferenceBrokerPath: string;
  readonly sourceRoot: string;
}

export class NativePrimeHarnessRegistry {
  #cached:
    | {
        readonly descriptor: NativePrimeHarnessDescriptor;
        readonly observations: ArtifactObservations;
        readonly attestation: PrimeOciIdentityAttestation;
      }
    | undefined;
  readonly #paths: PrimeArtifactPaths;
  readonly #resolveOciIdentity: () => Promise<PrimeOciIdentityAttestation>;

  constructor(options: NativePrimeHarnessRegistryOptions = {}) {
    const defaults = defaultArtifactPaths();
    this.#paths = Object.freeze({
      driverPath: options.driverPath ?? defaults.driverPath,
      protocolPath: options.protocolPath ?? defaults.protocolPath,
      outerProtocolPath: options.outerProtocolPath ?? defaults.outerProtocolPath,
      supervisorPath: options.supervisorPath ?? defaults.supervisorPath,
      kernelProxyPath: options.kernelProxyPath ?? defaults.kernelProxyPath,
      pythonLauncherPath: options.pythonLauncherPath ?? defaults.pythonLauncherPath,
      noIoResourceLoaderPath: options.noIoResourceLoaderPath ?? defaults.noIoResourceLoaderPath,
      inferenceBrokerPath: options.inferenceBrokerPath ?? defaults.inferenceBrokerPath,
      sourceRoot:
        options.sourceRoot ??
        (options.driverPath === undefined ? defaults.sourceRoot : dirname(options.driverPath)),
    });
    this.#resolveOciIdentity =
      options.resolveOciIdentity ??
      createLocalAttestationResolver(
        options.attestationPath ??
          resolve(process.cwd(), ".flow", "runtime", "prime-agent", "oci-attestation.json"),
      );
  }

  async resolve(profile: NativePrimeProfileSource): Promise<NativePrimeHarnessDescriptor> {
    if (
      profile.adapter !== "prime-agent-native-v1" ||
      profile.harness.config !== "prime-agent-rlm-evaluation-v1"
    ) {
      throw new Error("native Prime registry received an unsupported profile selection");
    }
    return this.#currentDescriptor();
  }

  async resolveIdentity(profile: NativePrimeProfileSource): Promise<NativePrimeIdentity> {
    return (await this.resolve(profile)).identity;
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativePrimeHarnessDescriptor> {
    const admitted = parseExternalHarnessIdentity(identity);
    if (admitted.adapter !== "prime-agent-native-v1") {
      throw new Error("native Prime registry received a different adapter identity");
    }
    const current = await this.#currentDescriptor();
    if (externalHarnessIdentityDigest(admitted) !== current.identityDigest) {
      throw new Error("external harness identity changed after evaluation plan admission");
    }
    return current;
  }

  async #currentDescriptor(): Promise<NativePrimeHarnessDescriptor> {
    if (this.#cached !== undefined && (await this.#cached.observations.isCurrent())) {
      await this.#cached.attestation.assertCurrent();
      return this.#cached.descriptor;
    }

    const observations = new ArtifactObservations();
    const [
      driver,
      protocol,
      outerProtocol,
      supervisor,
      kernelProxy,
      pythonLauncher,
      loader,
      broker,
      source,
      attestation,
    ] = await Promise.all([
      readTrustedArtifact(this.#paths.driverPath, "native Prime driver", observations),
      readTrustedArtifact(this.#paths.protocolPath, "external harness protocol", observations),
      readTrustedArtifact(
        this.#paths.outerProtocolPath,
        "Prime outer protocol parser",
        observations,
      ),
      readTrustedArtifact(this.#paths.supervisorPath, "Prime supervisor", observations),
      readTrustedArtifact(this.#paths.kernelProxyPath, "Prime kernel proxy", observations),
      readTrustedArtifact(this.#paths.pythonLauncherPath, "Prime Python launcher", observations),
      readTrustedArtifact(
        this.#paths.noIoResourceLoaderPath,
        "Prime no-I/O resource loader",
        observations,
      ),
      readTrustedArtifact(this.#paths.inferenceBrokerPath, "Prime inference broker", observations),
      readTrustedRuntimeTree(
        this.#paths.sourceRoot,
        "native Prime local source closure",
        observations,
      ),
      this.#resolveOciIdentity(),
    ]);

    const identity = parseExternalHarnessIdentity({
      version: 1,
      adapter: "prime-agent-native-v1",
      adapterContractVersion: NATIVE_PRIME_ADAPTER_CONTRACT_VERSION,
      protocol: {
        id: "flow-external-harness-jsonl-v1",
        maxFrameBytes: 1_048_576,
        digest: protocol.sha256,
      },
      outerProtocol: {
        id: "flow-prime-container-v1",
        version: 1,
        maxPayloadBytes: 1_048_576,
        maxEncodedFrameBytes: 1_048_581,
        maxFileChunkBytes: 65_536,
        maxEntries: 4_096,
        maxPathBytes: 4_095,
        maxPathComponentBytes: 255,
        maxFileBytes: 268_435_456,
        maxLogicalBytes: 268_435_456,
        maxTransferFrames: 16_385,
        maxChunkFrames: 8_191,
        maxEncodedTransferBytes: 318_767_104,
        maxDriverFrames: 512,
        maxDriverBytes: 138_412_032,
        maxStreamBytes: 457_179_136,
        maxModelTurns: 64,
        maxIpythonCalls: 64,
        hostParserSha256: outerProtocol.sha256,
        supervisorSha256: supervisor.sha256,
      },
      runtime: attestation.runtime,
      image: attestation.image,
      driver: {
        id: "native-prime-agent-evaluation-v1",
        artifactSha256: driver.sha256,
        dependencyClosureSha256: sha256(
          `${source.sha256}:${protocol.sha256}:${outerProtocol.sha256}`,
        ),
        kernelProxySha256: kernelProxy.sha256,
        pythonLauncherSha256: pythonLauncher.sha256,
        noIoResourceLoaderSha256: loader.sha256,
        configDigest: sha256(JSON.stringify(NATIVE_PRIME_EVALUATION_CONFIG)),
      },
      harness: {
        package: "prime-agent",
        version: PRIME_AGENT_VERSION,
        archiveSha256: PRIME_AGENT_ARCHIVE_SHA256,
        packageContentSha256: attestation.harnessPackageContentSha256,
        dependencyClosureSha256: attestation.harnessDependencyClosureSha256,
        config: "prime-agent-rlm-evaluation-v1",
      },
      inference: {
        id: "flow-prime-inference-v1",
        version: 1,
        brokerSha256: broker.sha256,
      },
    });
    if (identity.adapter !== "prime-agent-native-v1") {
      throw new Error("native Prime registry produced the wrong identity variant");
    }

    const assertCurrent = async () => {
      if (!(await observations.isCurrent())) {
        throw new Error("external harness identity changed after evaluation plan admission");
      }
      await attestation.assertCurrent();
    };
    const descriptor = Object.freeze({
      identity,
      identityDigest: externalHarnessIdentityDigest(identity),
      localRuntime: attestation.localRuntime,
      assertCurrent,
    });
    this.#cached = Object.freeze({ descriptor, observations, attestation });
    return descriptor;
  }
}

function createLocalAttestationResolver(path: string): () => Promise<PrimeOciIdentityAttestation> {
  return async () => {
    const { LocalPrimeOciAttestationStore } = await import("../oci/local-prime-oci-attestation.js");
    return new LocalPrimeOciAttestationStore({ descriptorPath: path }).read();
  };
}

function defaultArtifactPaths(): PrimeArtifactPaths {
  const sourceRoot = resolve(import.meta.dirname);
  const packageRoot = resolve(sourceRoot, "../../..");
  return {
    driverPath: join(sourceRoot, "native-prime-agent-evaluation-driver.js"),
    protocolPath: join(sourceRoot, "../../domain/evaluation/external-harness-protocol.js"),
    outerProtocolPath: join(sourceRoot, "prime-container-protocol.js"),
    supervisorPath: join(packageRoot, "prime-container", "flow-prime-supervisor"),
    kernelProxyPath: join(packageRoot, "prime-container", "flow-prime-kernel-proxy"),
    pythonLauncherPath: join(packageRoot, "prime-container", "flow-prime-python"),
    noIoResourceLoaderPath: join(sourceRoot, "no-io-resource-loader.js"),
    inferenceBrokerPath: join(sourceRoot, "native-prime-host-inference-broker.js"),
    sourceRoot,
  };
}
