import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Fetcher } from "tuf-js";
import { Updater } from "tuf-js";
import { DownloadHTTPError, DownloadLengthMismatchError } from "tuf-js/dist/error.js";
import {
  type CapabilityRepositoryMetadataDescriptor,
  createCapabilityRepositoryCandidate,
} from "../../application/capability-repository-candidate.js";
import type {
  AuthenticateCapabilityRepositoryGenerationInput,
  CapabilityRepositoryGenerationAuthenticator,
} from "../../application/capability-repository-store.js";
import {
  parseCapabilityPackageTargetCustom,
  parseCapabilityRepositoryIndex,
} from "../../domain/capability/capability-repository.js";
import { parseSignedCapabilityBundleEnvelope } from "../../domain/capability/signed-capability-bundle-envelope.js";
import type { SigstoreCapabilityVerifier } from "../../domain/capability/sigstore-capability-verifier.js";
import { assertUnambiguousTufMetadata } from "./tuf-metadata-contract.js";

const MAX_ROOT_BYTES = 512 * 1024;
const MAX_TIMESTAMP_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS_BYTES = 2 * 1024 * 1024;
const MAX_ROOT_ROTATIONS = 32;
const MAX_DELEGATIONS = 31;

export type CapabilityRepositoryGenerationAuthenticationStage =
  | "validate generation evidence"
  | "authenticate repository metadata"
  | "authenticate repository index"
  | "authenticate repository targets"
  | "authenticate repository publishers";

export class CapabilityRepositoryGenerationAuthenticationError extends Error {
  override readonly name = "CapabilityRepositoryGenerationAuthenticationError";
  readonly code = "capability_repository_generation_authentication_failed" as const;

  constructor(readonly stage: CapabilityRepositoryGenerationAuthenticationStage) {
    super(`Capability repository generation authentication failed during ${stage}`);
  }
}

export interface CapabilityRepositoryGenerationAuthenticatorOptions {
  readonly verifier: SigstoreCapabilityVerifier;
  readonly temporaryRoot?: string;
}

export function createCapabilityRepositoryGenerationAuthenticator(
  options: CapabilityRepositoryGenerationAuthenticatorOptions,
): CapabilityRepositoryGenerationAuthenticator {
  return Object.freeze({
    async authenticate(input: AuthenticateCapabilityRepositoryGenerationInput): Promise<void> {
      throwIfAborted(input.signal);
      const evidence = validateEvidence(input);
      try {
        for (const content of evidence.metadata.values()) {
          assertUnambiguousTufMetadata(content);
        }
      } catch (error) {
        throwClosed(error, "authenticate repository metadata", input.signal);
      }
      const staging = await mkdtemp(
        join(options.temporaryRoot ?? tmpdir(), "flow-repository-authentication-"),
      );
      try {
        const metadataDirectory = join(staging, "metadata");
        const targetDirectory = join(staging, "targets");
        await mkdir(metadataDirectory, { mode: 0o700 });
        await mkdir(targetDirectory, { mode: 0o700 });
        throwIfAborted(input.signal);
        await writeFile(join(metadataDirectory, "root.json"), evidence.trustedRoot, {
          flag: "wx",
          mode: 0o600,
        });
        throwIfAborted(input.signal);
        const metadataBaseUrl = new URL("metadata/", evidence.repositoryBaseUrl).toString();
        const targetBaseUrl = new URL("targets/", evidence.repositoryBaseUrl).toString();
        const fetcher = new OfflineRepositoryFetcher(
          staging,
          metadataBaseUrl,
          targetBaseUrl,
          evidence.metadata,
          input.signal,
        );
        let updater: Updater;
        try {
          updater = new Updater({
            metadataDir: metadataDirectory,
            metadataBaseUrl,
            targetDir: targetDirectory,
            targetBaseUrl,
            fetcher,
            config: {
              maxRootRotations: MAX_ROOT_ROTATIONS,
              maxDelegations: MAX_DELEGATIONS,
              rootMaxLength: MAX_ROOT_BYTES,
              timestampMaxLength: MAX_TIMESTAMP_BYTES,
              snapshotMaxLength: MAX_SNAPSHOT_BYTES,
              targetsMaxLength: MAX_TARGETS_BYTES,
              prefixTargetsWithHash: true,
              fetchRetries: 0,
              fetchRetry: false,
              userAgent: "flow-harness-offline",
            },
          });
          throwIfAborted(input.signal);
          if (evidence.index === undefined) {
            return;
          }
          await updater.refresh();
          throwIfAborted(input.signal);
        } catch (error) {
          throwClosed(error, "authenticate repository metadata", input.signal);
        }

        let index: ReturnType<typeof parseCapabilityRepositoryIndex>;
        try {
          const indexInfo = await updater.getTargetInfo(evidence.index.path);
          throwIfAborted(input.signal);
          if (
            indexInfo === undefined ||
            indexInfo.path !== evidence.index.path ||
            indexInfo.length !== evidence.index.content.byteLength ||
            !exactSha256Hashes(indexInfo.hashes, evidence.index.content) ||
            Object.keys(indexInfo.custom).length !== 0
          ) {
            throw new Error("repository index descriptor is inconsistent");
          }
          fetcher.provideTarget(evidence.index.content);
          await updater.downloadTarget(indexInfo, join(targetDirectory, "index.target"));
          fetcher.takeTargetUrl();
          throwIfAborted(input.signal);
          index = parseCapabilityRepositoryIndex(evidence.index.content);
        } catch (error) {
          throwClosed(error, "authenticate repository index", input.signal);
        }

        const descriptors = evidence.metadataDescriptors;
        for (const candidate of evidence.candidates) {
          let targetSource: string;
          let targetCustom: ReturnType<typeof parseCapabilityPackageTargetCustom>;
          try {
            const targetInfo = await updater.getTargetInfo(candidate.identity.target.path);
            throwIfAborted(input.signal);
            if (
              targetInfo === undefined ||
              targetInfo.path !== candidate.identity.target.path ||
              targetInfo.length !== candidate.envelope.byteLength ||
              !exactSha256Hashes(targetInfo.hashes, candidate.envelope)
            ) {
              throw new Error("candidate target descriptor is inconsistent");
            }
            fetcher.provideTarget(candidate.envelope);
            await updater.downloadTarget(
              targetInfo,
              join(
                targetDirectory,
                `${candidate.identity.candidateDigest.slice("sha256:".length)}.target`,
              ),
            );
            targetSource = fetcher.takeTargetUrl();
            targetCustom = parseCapabilityPackageTargetCustom(targetInfo.custom);
            throwIfAborted(input.signal);
          } catch (error) {
            throwClosed(error, "authenticate repository targets", input.signal);
          }

          try {
            const entry = index.packages.find(
              ({ name, version, targetPath }) =>
                name === candidate.identity.bundle.name &&
                version === candidate.identity.bundle.version &&
                targetPath === candidate.identity.target.path,
            );
            if (entry === undefined) {
              throw new Error("candidate is not selected by the authenticated index");
            }
            const envelope = parseSignedCapabilityBundleEnvelope(candidate.envelope);
            const capabilityBundle = envelope.capabilityBundle();
            const sigstoreBundle = envelope.sigstoreBundle();
            const verified = options.verifier.verify(
              capabilityBundle,
              sigstoreBundle,
              targetCustom.publisher,
            );
            throwIfAborted(input.signal);
            const reconstructed = createCapabilityRepositoryCandidate({
              repositoryMetadata: descriptors,
              index,
              entry,
              target: {
                path: candidate.identity.target.path,
                source: targetSource,
                length: candidate.envelope.byteLength,
                hashes: { sha256: sha256Hex(candidate.envelope) },
                custom: {
                  flow: {
                    apiVersion: "flow.synapti.ai/v1alpha1",
                    kind: "CapabilityPackageTarget",
                    name: targetCustom.name,
                    version: targetCustom.version,
                    publisher: targetCustom.publisher,
                  },
                },
                content: candidate.envelope,
              },
              authority: {
                kind: "sigstore-keyless-v0.3",
                certificateIssuer: verified.certificateIssuer,
                certificateIdentity: verified.certificateIdentity,
                signatureBundleDigest: `sha256:${sha256Hex(sigstoreBundle)}`,
              },
            });
            if (!isDeepStrictEqual(reconstructed.identity, candidate.identity)) {
              throw new Error("candidate identity is inconsistent");
            }
          } catch (error) {
            throwClosed(error, "authenticate repository publishers", input.signal);
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}

interface ValidatedEvidence {
  readonly repositoryBaseUrl: string;
  readonly trustedRoot: Buffer;
  readonly metadata: ReadonlyMap<string, Buffer>;
  readonly metadataDescriptors: readonly CapabilityRepositoryMetadataDescriptor[];
  readonly index?: {
    readonly path: "flow/capability-index.json";
    readonly content: Buffer;
  };
  readonly candidates: readonly {
    readonly identity: AuthenticateCapabilityRepositoryGenerationInput["candidates"][number]["identity"];
    readonly envelope: Buffer;
  }[];
}

function validateEvidence(
  input: AuthenticateCapabilityRepositoryGenerationInput,
): ValidatedEvidence {
  try {
    const repositoryBaseUrl = canonicalRepositoryBaseUrl(input.repositoryBaseUrl);
    const trustedRoot = input.trustedRoot.bytes();
    if (
      input.trustedRoot.name !== "root.json" ||
      input.trustedRoot.length !== trustedRoot.byteLength ||
      input.trustedRoot.digest !== `sha256:${sha256Hex(trustedRoot)}`
    ) {
      throw new Error("trusted root is inconsistent");
    }
    const metadata = new Map<string, Buffer>();
    const metadataDescriptors: CapabilityRepositoryMetadataDescriptor[] = [];
    for (const file of input.metadata) {
      const previous = metadataDescriptors.at(-1);
      const content = file.bytes();
      if (
        !isCanonicalMetadataName(file.name) ||
        (previous !== undefined && previous.name >= file.name) ||
        file.length !== content.byteLength ||
        file.digest !== `sha256:${sha256Hex(content)}` ||
        metadata.has(file.name)
      ) {
        throw new Error("repository metadata is inconsistent");
      }
      metadata.set(file.name, Buffer.from(content));
      metadataDescriptors.push({ name: file.name, length: file.length, digest: file.digest });
    }
    if (metadata.size < 1 || metadata.get("root.json") === undefined) {
      throw new Error("repository metadata is incomplete");
    }
    if (input.index === undefined) {
      if (
        input.checkedAt !== undefined ||
        input.candidates.length !== 0 ||
        metadata.size !== 1 ||
        !metadata.get("root.json")?.equals(trustedRoot)
      ) {
        throw new Error("initialized repository evidence is inconsistent");
      }
      return Object.freeze({
        repositoryBaseUrl,
        trustedRoot: Buffer.from(trustedRoot),
        metadata,
        metadataDescriptors: Object.freeze(metadataDescriptors),
        candidates: Object.freeze([]),
      });
    }
    if (input.checkedAt === undefined) {
      throw new Error("checked repository evidence has no check instant");
    }
    const indexContent = input.index.bytes();
    if (
      input.index.path !== "flow/capability-index.json" ||
      input.index.length !== indexContent.byteLength ||
      Object.keys(input.index.hashes).length !== 1 ||
      input.index.hashes.sha256 !== sha256Hex(indexContent)
    ) {
      throw new Error("repository index is inconsistent");
    }
    const candidates = input.candidates.map((candidate) => ({
      identity: candidate.identity,
      envelope: candidate.envelopeBytes(),
    }));
    return Object.freeze({
      repositoryBaseUrl,
      trustedRoot: Buffer.from(trustedRoot),
      metadata,
      metadataDescriptors: Object.freeze(metadataDescriptors),
      index: Object.freeze({ path: input.index.path, content: Buffer.from(indexContent) }),
      candidates: Object.freeze(candidates),
    });
  } catch (error) {
    throwClosed(error, "validate generation evidence", input.signal);
  }
}

class OfflineRepositoryFetcher implements Fetcher {
  readonly #staging: string;
  readonly #metadataBaseUrl: string;
  readonly #targetBaseUrl: string;
  readonly #metadata: ReadonlyMap<string, Buffer>;
  readonly #signal: AbortSignal | undefined;
  #target: Buffer | undefined;
  #targetUrl: string | undefined;

  constructor(
    staging: string,
    metadataBaseUrl: string,
    targetBaseUrl: string,
    metadata: ReadonlyMap<string, Buffer>,
    signal: AbortSignal | undefined,
  ) {
    this.#staging = staging;
    this.#metadataBaseUrl = metadataBaseUrl;
    this.#targetBaseUrl = targetBaseUrl;
    this.#metadata = metadata;
    this.#signal = signal;
  }

  async downloadBytes(url: string, maximumBytes: number): Promise<Buffer> {
    throwIfAborted(this.#signal);
    const name = metadataNameForUrl(url, this.#metadataBaseUrl);
    const content = name === undefined ? undefined : this.#metadata.get(name);
    if (content === undefined) {
      if (name !== undefined && /^[1-9][0-9]*\.root\.json$/.test(name)) {
        throw new DownloadHTTPError("offline root rotation is absent", 404);
      }
      throw new Error("offline metadata is absent");
    }
    if (content.byteLength > maximumBytes) {
      throw new DownloadLengthMismatchError("offline metadata exceeds its bound");
    }
    return Buffer.from(content);
  }

  async downloadFile<T>(
    url: string,
    maximumBytes: number,
    handler: (file: string) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(this.#signal);
    if (!url.startsWith(this.#targetBaseUrl) || this.#target === undefined) {
      throw new Error("offline target was not provisioned");
    }
    const content = this.#target;
    this.#target = undefined;
    if (content.byteLength > maximumBytes) {
      throw new DownloadLengthMismatchError("offline target exceeds its bound");
    }
    const path = join(this.#staging, `.target-${createHash("sha256").update(url).digest("hex")}`);
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      throwIfAborted(this.#signal);
      this.#targetUrl = url;
      return await handler(path);
    } finally {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }

  provideTarget(content: Buffer): void {
    if (this.#target !== undefined || this.#targetUrl !== undefined) {
      throw new Error("offline target settlement is incomplete");
    }
    this.#target = Buffer.from(content);
  }

  takeTargetUrl(): string {
    const value = this.#targetUrl;
    this.#targetUrl = undefined;
    if (value === undefined) {
      throw new Error("offline target URL was not observed");
    }
    return value;
  }
}

function metadataNameForUrl(url: string, metadataBaseUrl: string): string | undefined {
  if (!url.startsWith(metadataBaseUrl)) {
    return undefined;
  }
  const name = basename(new URL(url).pathname);
  if (/^[1-9][0-9]*\.root\.json$/.test(name) || name === "timestamp.json") {
    return name;
  }
  const versioned = /^[1-9][0-9]*\.(.+\.json)$/.exec(name);
  return versioned?.[1] ?? name;
}

function exactSha256Hashes(hashes: Readonly<Record<string, string>>, content: Buffer): boolean {
  return (
    Object.keys(hashes).length === 1 &&
    Object.hasOwn(hashes, "sha256") &&
    hashes.sha256 === sha256Hex(content)
  );
}

function canonicalRepositoryBaseUrl(input: string): string {
  const parsed = new URL(input);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.endsWith("/") ||
    parsed.toString() !== input
  ) {
    throw new Error("repository base URL is not canonical public HTTPS");
  }
  return input;
}

function isCanonicalMetadataName(name: string): boolean {
  return (
    Buffer.byteLength(name, "utf8") <= 256 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?\.json$/.test(name)
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

function throwClosed(
  error: unknown,
  stage: CapabilityRepositoryGenerationAuthenticationStage,
  signal: AbortSignal | undefined,
): never {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  if (error instanceof CapabilityRepositoryGenerationAuthenticationError) {
    throw error;
  }
  throw new CapabilityRepositoryGenerationAuthenticationError(stage);
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
