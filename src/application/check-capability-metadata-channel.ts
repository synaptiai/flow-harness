import { parseSignedCapabilityMetadataEnvelope } from "../domain/capability/signed-capability-metadata-envelope.js";
import type { SigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import { createCapabilityMetadataCandidate } from "./capability-metadata-candidate.js";
import {
  type CapabilityMetadataCandidateStore,
  CapabilityMetadataCandidateStoreError,
  type StageCapabilityMetadataCandidateResult,
} from "./capability-metadata-candidate-store.js";
import type { CapabilityMetadataChannel } from "./capability-metadata-channel.js";
import type { CapabilityMetadataState } from "./capability-package-store.js";
import type { SignedCapabilityMetadataVerifier } from "./verify-signed-capability-metadata.js";

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_TIMEOUT_MS = 5 * 60_000;

export type CapabilityMetadataCheckStage = "compare active metadata" | "complete metadata check";

export class CapabilityMetadataCheckError extends Error {
  override readonly name = "CapabilityMetadataCheckError";
  readonly code = "capability_metadata_check_failed" as const;

  constructor(readonly stage: CapabilityMetadataCheckStage) {
    super(`Capability metadata check failed during ${stage}`);
  }
}

export interface ActiveCapabilityMetadataReader {
  inspectMetadata(signal?: AbortSignal): Promise<CapabilityMetadataState | null>;
}

export interface CapabilityMetadataChannelCheckerDependencies {
  readonly channel: CapabilityMetadataChannel;
  readonly verifier: SignedCapabilityMetadataVerifier;
  readonly activeMetadata: ActiveCapabilityMetadataReader;
  readonly candidates: CapabilityMetadataCandidateStore;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

export interface CheckCapabilityMetadataChannelInput extends SigstoreCapabilityPublisherPolicy {
  readonly channel: string;
  readonly signal?: AbortSignal;
}

export interface CapabilityMetadataChannelChecker {
  check(
    input: CheckCapabilityMetadataChannelInput,
  ): Promise<StageCapabilityMetadataCandidateResult>;
}

export function createCapabilityMetadataChannelChecker(
  dependencies: CapabilityMetadataChannelCheckerDependencies,
): CapabilityMetadataChannelChecker {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
    throw new RangeError(`metadata check timeout must be between 1 and ${MAX_CHECK_TIMEOUT_MS}ms`);
  }
  return Object.freeze({
    async check(
      input: CheckCapabilityMetadataChannelInput,
    ): Promise<StageCapabilityMetadataCandidateResult> {
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal =
        input.signal === undefined
          ? deadlineSignal
          : AbortSignal.any([input.signal, deadlineSignal]);
      try {
        throwIfCheckAborted(operationSignal, input.signal, deadlineSignal);
        const checkedAt = new Date(dependencies.now().getTime());
        const envelopeBytes = await dependencies.channel.read(input.channel, operationSignal);
        throwIfCheckAborted(operationSignal, input.signal, deadlineSignal);
        const envelope = parseSignedCapabilityMetadataEnvelope(envelopeBytes);
        const verified = await dependencies.verifier.verify({
          metadata: envelope.metadataBytes(),
          sigstoreBundle: envelope.sigstoreBundleBytes(),
          certificateIssuer: input.certificateIssuer,
          certificateIdentity: input.certificateIdentity,
          now: checkedAt,
          signal: operationSignal,
        });
        throwIfCheckAborted(operationSignal, input.signal, deadlineSignal);
        const active = await dependencies.activeMetadata.inspectMetadata(operationSignal);
        throwIfCheckAborted(operationSignal, input.signal, deadlineSignal);
        requireNewerThanActive(active, verified.metadata, verified.authority);
        const metadata = verified.metadataBytes();
        const sigstoreBundle = verified.sigstoreBundleBytes();
        const candidate = createCapabilityMetadataCandidate({
          metadata: verified.metadata,
          metadataBytes: metadata,
          sigstoreBundle,
          authority: verified.authority,
        });
        return await dependencies.candidates.stage({
          candidate,
          metadata,
          sigstoreBundle,
          observation: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            kind: "CapabilityMetadataCheckObservation",
            checkedAt: checkedAt.toISOString(),
            channel: input.channel,
            envelopeBytes: envelope.bytes,
            envelopeDigest: envelope.digest,
          },
          signal: operationSignal,
        });
      } catch (error) {
        if (
          error instanceof CapabilityMetadataCandidateStoreError &&
          error.stage === "settle candidate commit"
        ) {
          throw error;
        }
        if (input.signal?.aborted === true) {
          throw input.signal.reason;
        }
        if (deadlineSignal.aborted) {
          throw new CapabilityMetadataCheckError("complete metadata check");
        }
        throw error;
      }
    },
  });
}

function requireNewerThanActive(
  active: CapabilityMetadataState | null,
  candidate: {
    readonly name: string;
    readonly version: number;
    readonly bytes: number;
    readonly digest: string;
  },
  authority: {
    readonly kind: "sigstore-keyless-v0.3";
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
  },
): void {
  if (active === null) {
    return;
  }
  const sameAuthority =
    active.name === candidate.name &&
    active.authority.kind === authority.kind &&
    active.authority.certificateIssuer === authority.certificateIssuer &&
    active.authority.certificateIdentity === authority.certificateIdentity;
  if (
    !sameAuthority ||
    candidate.version < active.version ||
    (candidate.version === active.version &&
      (candidate.digest !== active.metadataDigest || candidate.bytes !== active.metadataBytes))
  ) {
    throw new CapabilityMetadataCheckError("compare active metadata");
  }
}

function throwIfCheckAborted(
  operationSignal: AbortSignal,
  operatorSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): void {
  if (operatorSignal?.aborted === true) {
    throw operatorSignal.reason;
  }
  if (deadlineSignal.aborted || operationSignal.aborted) {
    throw new CapabilityMetadataCheckError("complete metadata check");
  }
}
