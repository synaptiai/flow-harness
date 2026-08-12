import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExternalHarnessIdentity,
  externalHarnessIdentityDigest,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import type { PrimeOciLocalRuntimeAttestation } from "../oci/local-prime-oci-attestation.js";
import {
  ArtifactObservations,
  readTrustedArtifact,
  readTrustedRuntimeTree,
  sha256,
} from "../pi/native-pi-harness-registry.js";
import { NATIVE_PRIME_EVALUATION_CONFIG } from "./native-prime-evaluation-config.js";

const NATIVE_PRIME_ADAPTER_CONTRACT_VERSION = "1.0.0";
const PRIME_AGENT_VERSION = "0.7.1";
const PRIME_AGENT_ARCHIVE_SHA256 =
  "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb";

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
  readonly artifacts: {
    readonly driverSha256: string;
    readonly flowDistSha256: string;
    readonly kernelProxySha256: string;
    readonly noIoResourceLoaderSha256: string;
    readonly pythonLauncherSha256: string;
    readonly supervisorSha256: string;
  };
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

export interface NativePrimeHarnessDescriptor {
  readonly identity: NativePrimeIdentity;
  readonly identityDigest: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

export interface NativePrimeHarnessRegistryOptions {
  readonly cwd?: string;
  readonly protocolPath?: string;
  readonly outerProtocolPath?: string;
  readonly inferenceBrokerPath?: string;
  readonly sourceRoot?: string;
  readonly hostOciRoot?: string;
  readonly productionRuntimePath?: string;
  readonly attestationPath?: string;
  readonly resolveOciIdentity?: () => Promise<PrimeOciIdentityAttestation>;
}

interface PrimeArtifactPaths {
  readonly protocolPath: string;
  readonly outerProtocolPath: string;
  readonly inferenceBrokerPath: string;
  readonly sourceRoot: string;
  readonly hostOciRoot: string;
  readonly productionRuntimePath: string;
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
      protocolPath: options.protocolPath ?? defaults.protocolPath,
      outerProtocolPath: options.outerProtocolPath ?? defaults.outerProtocolPath,
      inferenceBrokerPath: options.inferenceBrokerPath ?? defaults.inferenceBrokerPath,
      sourceRoot: options.sourceRoot ?? defaults.sourceRoot,
      hostOciRoot: options.hostOciRoot ?? defaults.hostOciRoot,
      productionRuntimePath: options.productionRuntimePath ?? defaults.productionRuntimePath,
    });
    this.#resolveOciIdentity =
      options.resolveOciIdentity ??
      (options.attestationPath === undefined
        ? createProjectAttestationResolver(options.cwd ?? process.cwd())
        : createLocalAttestationResolver(options.attestationPath));
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
    const [protocol, outerProtocol, broker, source, hostOci, productionRuntime, attestation] =
      await Promise.all([
        readTrustedArtifact(this.#paths.protocolPath, "external harness protocol", observations),
        readTrustedArtifact(
          this.#paths.outerProtocolPath,
          "Prime outer protocol parser",
          observations,
        ),
        readTrustedArtifact(
          this.#paths.inferenceBrokerPath,
          "Prime inference broker",
          observations,
        ),
        readTrustedRuntimeTree(
          this.#paths.sourceRoot,
          "native Prime local source closure",
          observations,
        ),
        readTrustedRuntimeTree(
          this.#paths.hostOciRoot,
          "native Prime host OCI closure",
          observations,
        ),
        readTrustedArtifact(
          this.#paths.productionRuntimePath,
          "Prime production runtime router",
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
        supervisorSha256: attestation.artifacts.supervisorSha256,
      },
      runtime: attestation.runtime,
      image: attestation.image,
      driver: {
        id: "native-prime-agent-evaluation-v1",
        artifactSha256: attestation.artifacts.driverSha256,
        dependencyClosureSha256: sha256(
          [
            attestation.artifacts.flowDistSha256,
            source.sha256,
            hostOci.sha256,
            productionRuntime.sha256,
          ].join(":"),
        ),
        kernelProxySha256: attestation.artifacts.kernelProxySha256,
        pythonLauncherSha256: attestation.artifacts.pythonLauncherSha256,
        noIoResourceLoaderSha256: attestation.artifacts.noIoResourceLoaderSha256,
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

    const assertCurrent = async (signal?: AbortSignal) => {
      if (!(await observations.isCurrent())) {
        throw new Error("external harness identity changed after evaluation plan admission");
      }
      await attestation.assertCurrent(signal);
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

function createProjectAttestationResolver(cwd: string): () => Promise<PrimeOciIdentityAttestation> {
  return async () => createLocalAttestationResolver(await resolvePrimeOciAttestationPath(cwd))();
}

export async function resolvePrimeOciAttestationPath(cwd: string): Promise<string> {
  const { loadEffectiveFlowConfig } = await import("../fs/flow-config-store.js");
  const configuration = await loadEffectiveFlowConfig({ cwd });
  if (configuration.projectRoot === null) {
    throw new Error("Prime OCI attestation requires a configured Flow project root");
  }
  return resolve(
    configuration.projectRoot,
    ".flow",
    "runtime",
    "prime-agent",
    "oci-attestation.json",
  );
}

function defaultArtifactPaths(): PrimeArtifactPaths {
  const registryPath = fileURLToPath(import.meta.url);
  const extension = extname(registryPath);
  const sourceRoot = dirname(registryPath);
  return {
    protocolPath: join(
      sourceRoot,
      "../../domain/evaluation",
      `external-harness-protocol${extension}`,
    ),
    outerProtocolPath: join(sourceRoot, `prime-container-protocol${extension}`),
    inferenceBrokerPath: join(sourceRoot, `native-prime-host-inference-broker${extension}`),
    sourceRoot,
    hostOciRoot: resolve(sourceRoot, "../oci"),
    productionRuntimePath: resolve(
      sourceRoot,
      "../runtime",
      `production-external-harness-runtime${extension}`,
    ),
  };
}
