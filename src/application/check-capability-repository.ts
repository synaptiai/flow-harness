import { createHash } from "node:crypto";
import {
  parseCapabilityPackageTargetCustom,
  parseCapabilityRepositoryIndex,
} from "../domain/capability/capability-repository.js";
import { parseSignedCapabilityBundleEnvelope } from "../domain/capability/signed-capability-bundle-envelope.js";
import type { SigstoreCapabilityVerifier } from "../domain/capability/sigstore-capability-verifier.js";
import type { CapabilityPublisherVerification } from "./capability-package-store.js";
import {
  CAPABILITY_REPOSITORY_INDEX_TARGET_PATH,
  type CapabilityRepositoryCandidate,
  createCapabilityRepositoryCandidate,
} from "./capability-repository-candidate.js";
import {
  type CapabilityRepositoryCheckPublication,
  type CapabilityRepositoryCheckPublisher,
  type CapabilityRepositoryStoredFile,
  type CapabilityRepositoryStoredIndex,
  MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES,
} from "./capability-repository-store.js";

export type {
  CapabilityRepositoryCheckPublication,
  CapabilityRepositoryCheckPublisher,
  PublishCapabilityRepositoryCheckInput,
} from "./capability-repository-store.js";

const DEFAULT_REPOSITORY_CHECK_TIMEOUT_MS = 2 * 60_000;
const MAX_REPOSITORY_CHECK_TIMEOUT_MS = 10 * 60_000;

export type CapabilityRepositoryCheckStage =
  | "refresh repository"
  | "read repository index"
  | "read package targets"
  | "read repository metadata"
  | "verify package targets"
  | "complete repository check";

export class CapabilityRepositoryCheckError extends Error {
  override readonly name = "CapabilityRepositoryCheckError";
  readonly code = "capability_repository_check_failed" as const;

  constructor(readonly stage: CapabilityRepositoryCheckStage) {
    super(`Capability repository check failed during ${stage}`);
  }
}

export interface CapabilityRepositoryCheckTarget {
  readonly path: string;
  readonly source: string;
  readonly length: number;
  readonly hashes: Readonly<Record<string, string>>;
  readonly custom: Readonly<Record<string, unknown>>;
  bytes(): Buffer;
}

export type CapabilityRepositoryCheckMetadataFile = CapabilityRepositoryStoredFile;

export interface CapabilityRepositoryCheckSession {
  readTarget(path: string, signal: AbortSignal): Promise<CapabilityRepositoryCheckTarget>;
  complete(signal: AbortSignal): Promise<{
    readonly metadata: readonly CapabilityRepositoryCheckMetadataFile[];
  }>;
  release(): Promise<void>;
}

export interface CapabilityRepositoryRefresher {
  refresh(signal: AbortSignal): Promise<CapabilityRepositoryCheckSession>;
}

export interface CapabilityRepositoryCheckerDependencies {
  readonly refresher: CapabilityRepositoryRefresher;
  readonly verifier: SigstoreCapabilityVerifier;
  readonly publisher: CapabilityRepositoryCheckPublisher;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

export interface CheckCapabilityRepositoryInput {
  readonly signal?: AbortSignal;
}

export interface CapabilityRepositoryChecker {
  check(input: CheckCapabilityRepositoryInput): Promise<CapabilityRepositoryCheckPublication>;
}

export function createCapabilityRepositoryChecker(
  dependencies: CapabilityRepositoryCheckerDependencies,
): CapabilityRepositoryChecker {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_REPOSITORY_CHECK_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_REPOSITORY_CHECK_TIMEOUT_MS
  ) {
    throw new RangeError(
      `repository check timeout must be between 1 and ${MAX_REPOSITORY_CHECK_TIMEOUT_MS}ms`,
    );
  }

  return Object.freeze({
    async check(
      input: CheckCapabilityRepositoryInput,
    ): Promise<CapabilityRepositoryCheckPublication> {
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal =
        input.signal === undefined
          ? deadlineSignal
          : AbortSignal.any([input.signal, deadlineSignal]);
      const checkedAt = captureCheckInstant(dependencies.now, input.signal, deadlineSignal);

      let session: CapabilityRepositoryCheckSession;
      try {
        throwIfCheckAborted(input.signal, deadlineSignal);
        session = await dependencies.refresher.refresh(operationSignal);
        throwIfCheckAborted(input.signal, deadlineSignal);
      } catch (error) {
        throwClosed(error, "refresh repository", input.signal, deadlineSignal);
      }

      let outcome:
        | { readonly ok: true; readonly value: CapabilityRepositoryCheckPublication }
        | { readonly ok: false; readonly error: unknown };
      try {
        let indexTarget: CapabilityRepositoryCheckTarget;
        let index: ReturnType<typeof parseCapabilityRepositoryIndex>;
        try {
          indexTarget = await session.readTarget(
            CAPABILITY_REPOSITORY_INDEX_TARGET_PATH,
            operationSignal,
          );
          throwIfCheckAborted(input.signal, deadlineSignal);
          const indexBytes = indexTarget.bytes();
          requireExactTarget(indexTarget, indexBytes, CAPABILITY_REPOSITORY_INDEX_TARGET_PATH);
          if (Object.keys(indexTarget.custom).length !== 0) {
            throw new Error("repository index target custom metadata is not empty");
          }
          index = parseCapabilityRepositoryIndex(indexBytes);
          if (index.packages.length > MAX_STAGED_CAPABILITY_REPOSITORY_CANDIDATES) {
            throw new Error("repository index exceeds staged candidate capacity");
          }
        } catch (error) {
          throwClosed(error, "read repository index", input.signal, deadlineSignal);
        }

        const selectedTargets: CapabilityRepositoryCheckTarget[] = [];
        try {
          for (const entry of index.packages) {
            const target = await session.readTarget(entry.targetPath, operationSignal);
            throwIfCheckAborted(input.signal, deadlineSignal);
            const targetBytes = target.bytes();
            requireExactTarget(target, targetBytes, entry.targetPath);
            selectedTargets.push(immutableTarget({ ...target, content: targetBytes }));
          }
        } catch (error) {
          throwClosed(error, "read package targets", input.signal, deadlineSignal);
        }

        let metadata: readonly CapabilityRepositoryCheckMetadataFile[];
        try {
          const completed = await session.complete(operationSignal);
          throwIfCheckAborted(input.signal, deadlineSignal);
          metadata = validateMetadataFiles(completed.metadata);
        } catch (error) {
          throwClosed(error, "read repository metadata", input.signal, deadlineSignal);
        }

        const candidates: CapabilityRepositoryCandidate[] = [];
        try {
          for (let indexPosition = 0; indexPosition < index.packages.length; indexPosition += 1) {
            const entry = index.packages[indexPosition];
            const target = selectedTargets[indexPosition];
            if (entry === undefined || target === undefined) {
              throw new Error("selected target does not match index position");
            }
            const targetCustom = parseCapabilityPackageTargetCustom(target.custom);
            const envelope = parseSignedCapabilityBundleEnvelope(target.bytes());
            const capabilityBundle = envelope.capabilityBundle();
            const sigstoreBundle = envelope.sigstoreBundle();
            const verified = dependencies.verifier.verify(
              capabilityBundle,
              sigstoreBundle,
              targetCustom.publisher,
            );
            throwIfCheckAborted(input.signal, deadlineSignal);
            const authority: CapabilityPublisherVerification = {
              kind: "sigstore-keyless-v0.3",
              certificateIssuer: verified.certificateIssuer,
              certificateIdentity: verified.certificateIdentity,
              signatureBundleDigest: sha256(sigstoreBundle),
            };
            candidates.push(
              createCapabilityRepositoryCandidate({
                repositoryMetadata: metadata.map(({ name, length, digest }) => ({
                  name,
                  length,
                  digest,
                })),
                index,
                entry,
                target: {
                  path: target.path,
                  source: target.source,
                  length: target.length,
                  hashes: target.hashes,
                  custom: target.custom,
                  content: target.bytes(),
                },
                authority,
              }),
            );
          }
        } catch (error) {
          throwClosed(error, "verify package targets", input.signal, deadlineSignal);
        }

        throwIfCheckAborted(input.signal, deadlineSignal);
        assertClockDidNotRollback(dependencies.now, checkedAt, input.signal, deadlineSignal);
        outcome = {
          ok: true,
          value: await dependencies.publisher.publish({
            checkedAt,
            metadata,
            index: storedIndex(indexTarget),
            candidates: Object.freeze(candidates),
            signal: operationSignal,
          }),
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        await session.release();
      } catch {
        if (outcome.ok) {
          throw new CapabilityRepositoryCheckError("complete repository check");
        }
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    },
  });
}

function storedIndex(target: CapabilityRepositoryCheckTarget): CapabilityRepositoryStoredIndex {
  const content = target.bytes();
  const sha256 = target.hashes.sha256;
  if (sha256 === undefined) {
    throw new CapabilityRepositoryCheckError("complete repository check");
  }
  return Object.freeze({
    path: CAPABILITY_REPOSITORY_INDEX_TARGET_PATH,
    length: target.length,
    hashes: Object.freeze({ sha256 }),
    bytes: () => Buffer.from(content),
  });
}

function captureCheckInstant(
  now: () => Date,
  operatorSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): string {
  throwIfCheckAborted(operatorSignal, deadlineSignal);
  try {
    const value = new Date(now().getTime());
    if (Number.isNaN(value.getTime())) {
      throw new Error("repository check clock is invalid");
    }
    return value.toISOString();
  } catch {
    throwIfCheckAborted(operatorSignal, deadlineSignal);
    throw new CapabilityRepositoryCheckError("complete repository check");
  }
}

function assertClockDidNotRollback(
  now: () => Date,
  checkedAt: string,
  operatorSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): void {
  throwIfCheckAborted(operatorSignal, deadlineSignal);
  try {
    const settledAt = new Date(now().getTime());
    if (!Number.isFinite(settledAt.getTime()) || settledAt.getTime() < Date.parse(checkedAt)) {
      throw new Error("repository check clock moved backward");
    }
  } catch {
    throwIfCheckAborted(operatorSignal, deadlineSignal);
    throw new CapabilityRepositoryCheckError("complete repository check");
  }
}

function requireExactTarget(
  target: CapabilityRepositoryCheckTarget,
  content: Buffer,
  expectedPath: string,
): void {
  const hashNames = Object.keys(target.hashes);
  if (
    target.path !== expectedPath ||
    target.length !== content.byteLength ||
    hashNames.length !== 1 ||
    hashNames[0] !== "sha256" ||
    target.hashes.sha256 !== sha256Hex(content)
  ) {
    throw new Error("verified target contradicts its descriptor");
  }
}

function immutableTarget(input: CapabilityRepositoryCheckTarget & { readonly content: Buffer }) {
  const content = Buffer.from(input.content);
  return Object.freeze({
    path: input.path,
    source: input.source,
    length: input.length,
    hashes: Object.freeze({ ...input.hashes }),
    custom: deepFreeze(normalizeJsonObject(input.custom)),
    bytes: () => Buffer.from(content),
  });
}

function validateMetadataFiles(
  files: readonly CapabilityRepositoryCheckMetadataFile[],
): readonly CapabilityRepositoryCheckMetadataFile[] {
  const result: CapabilityRepositoryCheckMetadataFile[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const previous = files[index - 1];
    if (file === undefined || (previous !== undefined && previous.name >= file.name)) {
      throw new Error("repository metadata files are not sorted and unique");
    }
    const content = file.bytes();
    if (file.length !== content.byteLength || file.digest !== sha256(content)) {
      throw new Error("repository metadata contradicts its descriptor");
    }
    result.push(
      Object.freeze({
        name: file.name,
        length: file.length,
        digest: file.digest,
        bytes: () => Buffer.from(content),
      }),
    );
  }
  if (result.length < 1) {
    throw new Error("repository metadata set is empty");
  }
  return Object.freeze(result);
}

function normalizeJsonObject(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfCheckAborted(
  operatorSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): void {
  if (operatorSignal?.aborted === true) {
    throw operatorSignal.reason;
  }
  if (deadlineSignal.aborted) {
    throw new CapabilityRepositoryCheckError("complete repository check");
  }
}

function throwClosed(
  error: unknown,
  stage: CapabilityRepositoryCheckStage,
  operatorSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): never {
  if (operatorSignal?.aborted === true) {
    throw operatorSignal.reason;
  }
  if (deadlineSignal.aborted) {
    throw new CapabilityRepositoryCheckError("complete repository check");
  }
  if (error instanceof CapabilityRepositoryCheckError) {
    throw error;
  }
  throw new CapabilityRepositoryCheckError(stage);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
