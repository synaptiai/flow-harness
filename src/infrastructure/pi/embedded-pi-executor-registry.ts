import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  calculateDelegationExecutorIdentityDigest,
  type DelegationExecutorIdentity,
  parseDelegationExecutorIdentity,
} from "../../domain/adaptation/delegation-evaluation.js";
import {
  ArtifactObservations,
  MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES,
  packageRoot,
  readTrustedArtifact,
  readTrustedPackageClosure,
  readTrustedRootSet,
  readTrustedRuntimeTree,
  sha256,
} from "./native-pi-harness-registry.js";
import {
  PI_AI_INTEGRITY,
  PI_AI_VERSION,
  PI_CODING_AGENT_INTEGRITY,
  PI_CODING_AGENT_VERSION,
} from "./pi-package-pins.js";

const EMBEDDED_PI_ADAPTER_CONTRACT_VERSION = "1.0.0";

export interface EmbeddedPiExecutorDescriptor {
  readonly identity: DelegationExecutorIdentity;
  assertCurrent(): Promise<void>;
}

export interface EmbeddedPiExecutorRegistryOptions {
  readonly nodeExecutable?: string;
  readonly sourceRoot?: string;
  readonly localDependencyRoots?: readonly string[];
  readonly piCodingAgentRoot?: string;
  readonly piAiRoot?: string;
}

export class EmbeddedPiExecutorRegistry {
  #cached:
    | {
        readonly descriptor: EmbeddedPiExecutorDescriptor;
        readonly observations: ArtifactObservations;
      }
    | undefined;
  readonly #localDependencyRoots: readonly string[];
  readonly #nodeExecutable: string;
  readonly #piAiRoot: string;
  readonly #piCodingAgentRoot: string;
  readonly #sourceRoot: string;

  constructor(options: EmbeddedPiExecutorRegistryOptions = {}) {
    const defaults = defaultArtifactPaths();
    this.#nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.#sourceRoot = options.sourceRoot ?? defaults.sourceRoot;
    this.#localDependencyRoots = Object.freeze([
      ...(options.localDependencyRoots ?? defaults.localDependencyRoots),
    ]);
    this.#piCodingAgentRoot = options.piCodingAgentRoot ?? defaults.piCodingAgentRoot;
    this.#piAiRoot = options.piAiRoot ?? defaults.piAiRoot;
  }

  async resolve(): Promise<EmbeddedPiExecutorDescriptor> {
    return this.#currentDescriptor();
  }

  async resolveAdmitted(
    admittedIdentity: DelegationExecutorIdentity,
  ): Promise<EmbeddedPiExecutorDescriptor> {
    const admitted = parseDelegationExecutorIdentity(admittedIdentity);
    const current = await this.#currentDescriptor();
    if (admitted.identityDigest !== current.identity.identityDigest) {
      throw identityChanged();
    }
    return current;
  }

  async #currentDescriptor(): Promise<EmbeddedPiExecutorDescriptor> {
    if (this.#cached !== undefined && (await this.#cached.observations.isCurrent())) {
      return this.#cached.descriptor;
    }
    const observations = new ArtifactObservations();
    await observations.add(this.#nodeExecutable);
    const canonicalNodeExecutable = await realpath(this.#nodeExecutable);
    if (canonicalNodeExecutable !== (await realpath(process.execPath))) {
      throw new Error("embedded Pi registry cannot verify a different Node executable version");
    }
    const [source, localDependencies, piCodingAgent, piAi, nodeExecutable] = await Promise.all([
      readTrustedRuntimeTree(this.#sourceRoot, "embedded Pi Flow runtime closure", observations),
      readTrustedRootSet(
        this.#localDependencyRoots,
        "embedded Pi local dependency closure",
        observations,
      ),
      readTrustedPackageClosure(
        this.#piCodingAgentRoot,
        "@earendil-works/pi-coding-agent",
        PI_CODING_AGENT_VERSION,
        "embedded Pi coding-agent closure",
        observations,
      ),
      readTrustedPackageClosure(
        this.#piAiRoot,
        "@earendil-works/pi-ai",
        PI_AI_VERSION,
        "embedded Pi inference closure",
        observations,
      ),
      readTrustedArtifact(
        canonicalNodeExecutable,
        "embedded Pi Node executable",
        observations,
        MAX_EXTERNAL_HARNESS_EXECUTABLE_BYTES,
      ),
    ]);
    const content = {
      version: 1 as const,
      kind: "embedded-pi-v1" as const,
      adapterContractVersion: EMBEDDED_PI_ADAPTER_CONTRACT_VERSION,
      node: {
        version: process.versions.node,
        executableSha256: nodeExecutable.sha256,
      },
      harness: {
        package: "@earendil-works/pi-coding-agent" as const,
        version: PI_CODING_AGENT_VERSION,
        integrity: PI_CODING_AGENT_INTEGRITY,
        packageContentSha256: piCodingAgent.sha256,
      },
      inference: {
        package: "@earendil-works/pi-ai" as const,
        version: PI_AI_VERSION,
        integrity: PI_AI_INTEGRITY,
        packageContentSha256: piAi.sha256,
      },
      dependencyClosureSha256: sha256(`${source.sha256}:${localDependencies.sha256}`),
    };
    const identity = parseDelegationExecutorIdentity({
      ...content,
      identityDigest: calculateDelegationExecutorIdentityDigest(content),
    });
    const descriptor = Object.freeze({
      identity,
      assertCurrent: async () => {
        if (!(await observations.isCurrent())) throw identityChanged();
      },
    });
    this.#cached = Object.freeze({ descriptor, observations });
    return descriptor;
  }
}

function defaultArtifactPaths(): {
  readonly sourceRoot: string;
  readonly localDependencyRoots: readonly string[];
  readonly piCodingAgentRoot: string;
  readonly piAiRoot: string;
} {
  const registryPath = fileURLToPath(import.meta.url);
  const sourceRoot = resolve(dirname(registryPath), "../..");
  const piCodingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piAiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const localPackageNames = [
    "@agentclientprotocol/sdk",
    "@anthropic-ai/sandbox-runtime",
    "@sigstore/bundle",
    "@sigstore/protobuf-specs",
    "@sigstore/verify",
    "ajv",
    "tuf-js",
    "typebox",
    "yaml",
    "zod",
  ] as const;
  return Object.freeze({
    sourceRoot,
    localDependencyRoots: Object.freeze(
      localPackageNames.map((name) => packageRoot(fileURLToPath(import.meta.resolve(name)), name)),
    ),
    piCodingAgentRoot: packageRoot(piCodingAgentEntry, "@earendil-works/pi-coding-agent"),
    piAiRoot: packageRoot(piAiEntry, "@earendil-works/pi-ai"),
  });
}

function identityChanged(): Error {
  return new Error("embedded Pi executor identity changed after admission");
}
