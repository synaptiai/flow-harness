import { isDeepStrictEqual } from "node:util";

import {
  type CapabilityBundle,
  parseCapabilityBundle,
} from "../domain/capability/capability-bundles.js";
import { validateSigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../domain/capability/verifier-packages.js";
import type {
  CapabilityPublisherVerification,
  InstallCapabilityBundleFromRepositoryInput,
  InstallCapabilityBundleResult,
} from "./capability-package-store.js";
import type { PublicCapabilityRepositoryCandidate } from "./capability-repository-candidate.js";
import {
  MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
  MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
} from "./capability-repository-scheduler.js";
import type { CapabilityRepositoryCheckPublication } from "./capability-repository-store.js";
import type { ReopenedCapabilityRepositoryCandidate } from "./reopen-capability-repository-candidate.js";

export const MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS = 1_000;
export const CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION =
  "flow.synapti.ai/v1alpha1" as const;

export type CapabilityRepositoryFirstActivationStage =
  | "validate activation policy"
  | "read activation state"
  | "publish activation state"
  | "read installed package"
  | "wait interval"
  | "observe clock"
  | "check repository"
  | "select candidate"
  | "verify candidate package"
  | "install candidate"
  | "settle activation"
  | "report status";

export class CapabilityRepositoryFirstActivationError extends Error {
  override readonly name = "CapabilityRepositoryFirstActivationError";
  readonly code = "capability_repository_first_activation_failed" as const;

  constructor(readonly stage: CapabilityRepositoryFirstActivationStage) {
    super(`Capability repository first activation failed during ${stage}`);
  }
}

export interface CapabilityRepositoryFirstActivationAuthorization {
  readonly packageName: string;
  readonly version: string;
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
}

export interface CapabilityRepositoryFirstActivationInput
  extends CapabilityRepositoryFirstActivationAuthorization {
  readonly intervalMs: number;
  readonly maxChecks: number;
  readonly signal: AbortSignal;
}

interface CapabilityRepositoryFirstActivationStateBase {
  readonly apiVersion: typeof CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION;
  readonly kind: "CapabilityRepositoryFirstActivation";
  readonly authorization: CapabilityRepositoryFirstActivationAuthorization;
  readonly intervalMs: number;
  readonly maxChecks: number;
  readonly attempts: number;
  readonly createdAt: string;
  readonly lastObservedAt: string;
}

export interface CapabilityRepositoryFirstActivationWaitingState
  extends CapabilityRepositoryFirstActivationStateBase {
  readonly status: "waiting";
}

export interface CapabilityRepositoryFirstActivationReceipt {
  readonly candidateDigest: `sha256:${string}`;
  readonly checkedAt: string;
  readonly source: string;
  readonly bundle: Readonly<{
    readonly name: string;
    readonly version: string;
    readonly bytes: number;
    readonly digest: string;
  }>;
  readonly publisher: CapabilityPublisherVerification;
}

export interface CapabilityRepositoryFirstActivationPreparedState
  extends CapabilityRepositoryFirstActivationStateBase {
  readonly status: "prepared";
  readonly receipt: CapabilityRepositoryFirstActivationReceipt;
}

export interface CapabilityRepositoryFirstActivationSettledState
  extends CapabilityRepositoryFirstActivationStateBase {
  readonly status: "settled";
  readonly receipt: CapabilityRepositoryFirstActivationReceipt;
  readonly settledAt: string;
}

export type CapabilityRepositoryFirstActivationStateContent =
  | CapabilityRepositoryFirstActivationWaitingState
  | CapabilityRepositoryFirstActivationPreparedState
  | CapabilityRepositoryFirstActivationSettledState;

export type CapabilityRepositoryFirstActivationState =
  CapabilityRepositoryFirstActivationStateContent & {
    readonly recordDigest: `sha256:${string}`;
  };

export interface CapabilityRepositoryFirstActivationStatePort {
  read(
    authorization: CapabilityRepositoryFirstActivationAuthorization,
    signal: AbortSignal,
  ): Promise<CapabilityRepositoryFirstActivationState | undefined>;
  publish(input: {
    readonly expectedRecordDigest: `sha256:${string}` | null;
    readonly state: CapabilityRepositoryFirstActivationStateContent;
    readonly signal: AbortSignal;
  }): Promise<CapabilityRepositoryFirstActivationState>;
}

export interface InstalledCapabilityRepositoryFirstActivationPackage {
  readonly entry: Readonly<{
    readonly name: string;
    readonly version: string;
    readonly source: string;
    readonly digest: string;
    readonly bytes: number;
    readonly publisher?: CapabilityPublisherVerification;
  }>;
  readonly bundle: CapabilityBundle;
}

export type CapabilityRepositoryFirstActivationInstallOutcome =
  | Readonly<{
      readonly outcome: "settled";
      readonly result: InstallCapabilityBundleResult;
    }>
  | Readonly<{
      readonly outcome: "commit_uncertain";
    }>
  | Readonly<{
      readonly outcome: "settlement_uncertain";
    }>;

export interface CapabilityRepositoryFirstActivationDependencies {
  readonly state: CapabilityRepositoryFirstActivationStatePort;
  readonly readInstalled: (
    packageName: string,
    signal: AbortSignal,
  ) => Promise<readonly InstalledCapabilityRepositoryFirstActivationPackage[]>;
  readonly check: (signal: AbortSignal) => Promise<CapabilityRepositoryCheckPublication>;
  readonly reopen: (input: {
    readonly candidateDigest: string;
    readonly certificateIssuer: string;
    readonly certificateIdentity: string;
    readonly signal: AbortSignal;
  }) => Promise<ReopenedCapabilityRepositoryCandidate>;
  readonly install: (
    input: InstallCapabilityBundleFromRepositoryInput,
  ) => Promise<CapabilityRepositoryFirstActivationInstallOutcome>;
  readonly settlePackageMutation?: (signal: AbortSignal) => Promise<void>;
  readonly now: () => Date;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observe: (status: CapabilityRepositoryFirstActivationStatus) => void | Promise<void>;
}

export type CapabilityRepositoryFirstActivationStatus =
  | Readonly<{
      readonly outcome: "activation_started";
      readonly attempts: number;
      readonly maximumAttempts: number;
    }>
  | Readonly<{
      readonly outcome: "check_failed" | "candidate_unavailable";
      readonly attempts: number;
      readonly maximumAttempts: number;
    }>
  | Readonly<{
      readonly outcome: "activated";
      readonly attempts: number;
      readonly package: Readonly<{
        readonly name: string;
        readonly version: string;
        readonly digest: string;
      }>;
    }>
  | Readonly<{
      readonly outcome: "already_activated";
      readonly attempts: number;
      readonly package: Readonly<{
        readonly name: string;
        readonly version: string;
        readonly digest: string;
      }>;
    }>
  | Readonly<{
      readonly outcome: "attempts_exhausted";
      readonly attempts: number;
    }>;

export type CapabilityRepositoryFirstActivationResult =
  | Extract<CapabilityRepositoryFirstActivationStatus, { readonly outcome: "activated" }>
  | Extract<CapabilityRepositoryFirstActivationStatus, { readonly outcome: "already_activated" }>
  | Extract<CapabilityRepositoryFirstActivationStatus, { readonly outcome: "attempts_exhausted" }>;

export async function runCapabilityRepositoryFirstActivation(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  input: CapabilityRepositoryFirstActivationInput,
): Promise<CapabilityRepositoryFirstActivationResult> {
  validateInput(input);
  input.signal.throwIfAborted();
  const authorization = activationAuthorization(input);
  const installed = await readInstalled(dependencies, input.packageName, input.signal);
  let state = await readState(dependencies, authorization, input.signal);

  if (state === undefined) {
    if (installed.length !== 0) {
      throw new CapabilityRepositoryFirstActivationError("read installed package");
    }
    const createdAt = readClock(dependencies.now);
    state = await publishState(
      dependencies,
      null,
      {
        apiVersion: CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION,
        kind: "CapabilityRepositoryFirstActivation",
        status: "waiting",
        authorization,
        intervalMs: input.intervalMs,
        maxChecks: input.maxChecks,
        attempts: 0,
        createdAt,
        lastObservedAt: createdAt,
      },
      input.signal,
    );
  } else {
    requireMatchingState(state, input);
    if (state.status === "settled") {
      const installedOnly = installed[0];
      if (
        installed.length !== 1 ||
        installedOnly === undefined ||
        !isExactFirstActivationReceipt(installedOnly, state.receipt)
      ) {
        throw new CapabilityRepositoryFirstActivationError("read installed package");
      }
      return await reportAlreadyActivated(dependencies, state, input.signal);
    }
    if (state.status === "prepared") {
      const installedOnly = installed[0];
      if (
        installed.length === 1 &&
        installedOnly !== undefined &&
        isExactFirstActivationReceipt(installedOnly, state.receipt)
      ) {
        const settlementSignal = new AbortController().signal;
        await settlePackageMutation(dependencies, settlementSignal);
        const settled = await settlePreparedState(dependencies, state, settlementSignal);
        input.signal.throwIfAborted();
        return await reportAlreadyActivated(dependencies, settled, input.signal);
      }
      if (installed.length !== 0) {
        throw new CapabilityRepositoryFirstActivationError("read installed package");
      }
      return await resumePreparedActivation(dependencies, state, input.signal);
    }
    if (installed.length !== 0) {
      throw new CapabilityRepositoryFirstActivationError("read installed package");
    }
    if (state.attempts >= state.maxChecks) {
      return await reportExhaustion(dependencies, state.attempts, input.signal);
    }
  }
  await reportStatus(
    dependencies,
    {
      outcome: "activation_started",
      attempts: state.attempts,
      maximumAttempts: input.maxChecks,
    },
    input.signal,
  );

  let checked: CapabilityRepositoryCheckPublication;
  let selected: PublicCapabilityRepositoryCandidate;
  let completedAt: string;
  let attemptState: CapabilityRepositoryFirstActivationState;
  for (;;) {
    try {
      await dependencies.wait(input.intervalMs, input.signal);
    } catch {
      input.signal.throwIfAborted();
      throw new CapabilityRepositoryFirstActivationError("wait interval");
    }
    input.signal.throwIfAborted();

    const attemptedAt = readClock(dependencies.now);
    requireMonotonicClock(state.lastObservedAt, attemptedAt);
    attemptState = await publishState(
      dependencies,
      state.recordDigest,
      {
        ...withoutRecordDigest(state),
        attempts: state.attempts + 1,
        lastObservedAt: attemptedAt,
      },
      input.signal,
    );
    if (attemptState.status !== "waiting") {
      throw new CapabilityRepositoryFirstActivationError("publish activation state");
    }
    try {
      checked = await dependencies.check(input.signal);
      input.signal.throwIfAborted();
    } catch {
      input.signal.throwIfAborted();
      completedAt = readClock(dependencies.now);
      requireMonotonicClock(attemptState.lastObservedAt, completedAt);
      state = await publishCompletedWaitingState(
        dependencies,
        attemptState,
        completedAt,
        input.signal,
      );
      await reportStatus(
        dependencies,
        {
          outcome: "check_failed",
          attempts: state.attempts,
          maximumAttempts: state.maxChecks,
        },
        input.signal,
      );
      if (state.attempts >= state.maxChecks) {
        return await reportExhaustion(dependencies, state.attempts, input.signal);
      }
      continue;
    }
    completedAt = readClock(dependencies.now);
    requireMonotonicClock(attemptState.lastObservedAt, completedAt);

    const matching = exactCandidates(checked.candidates, authorization);
    if (matching.length === 0) {
      state = await publishCompletedWaitingState(
        dependencies,
        attemptState,
        completedAt,
        input.signal,
      );
      await reportStatus(
        dependencies,
        {
          outcome: "candidate_unavailable",
          attempts: state.attempts,
          maximumAttempts: state.maxChecks,
        },
        input.signal,
      );
      if (state.attempts >= state.maxChecks) {
        return await reportExhaustion(dependencies, state.attempts, input.signal);
      }
      continue;
    }
    if (matching.length !== 1 || matching[0] === undefined) {
      throw new CapabilityRepositoryFirstActivationError("select candidate");
    }
    selected = matching[0];
    break;
  }
  let reopened: ReopenedCapabilityRepositoryCandidate;
  try {
    reopened = await dependencies.reopen({
      candidateDigest: selected.candidateDigest,
      certificateIssuer: authorization.certificateIssuer,
      certificateIdentity: authorization.certificateIdentity,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
  } catch {
    input.signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("verify candidate package");
  }
  const bundle = requireAdmissibleReopenedCandidate(reopened, selected, authorization);
  const receipt = activationReceipt(reopened, checked.checkedAt, bundle);
  const preparedState = await publishState(
    dependencies,
    attemptState.recordDigest,
    {
      ...withoutRecordDigest(attemptState),
      status: "prepared",
      attempts: attemptState.attempts,
      lastObservedAt: completedAt,
      receipt,
    },
    input.signal,
  );
  if (preparedState.status !== "prepared") {
    throw new CapabilityRepositoryFirstActivationError("publish activation state");
  }

  const immediatelyInstalled = await readInstalled(dependencies, input.packageName, input.signal);
  if (immediatelyInstalled.length !== 0) {
    throw new CapabilityRepositoryFirstActivationError("read installed package");
  }

  return await installPreparedCandidate(
    dependencies,
    preparedState,
    reopened.capabilityBundle,
    bundle,
    input.signal,
  );
}

function validateInput(input: CapabilityRepositoryFirstActivationInput): void {
  try {
    if (
      !verifierPackageNameSchema.safeParse(input.packageName).success ||
      !verifierPackageVersionSchema.safeParse(input.version).success ||
      !Number.isSafeInteger(input.intervalMs) ||
      input.intervalMs < MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS ||
      input.intervalMs > MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS ||
      !Number.isSafeInteger(input.maxChecks) ||
      input.maxChecks < 1 ||
      input.maxChecks > MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS
    ) {
      throw new Error("first activation input is invalid");
    }
    validateSigstoreCapabilityPublisherPolicy({
      certificateIssuer: input.certificateIssuer,
      certificateIdentity: input.certificateIdentity,
    });
  } catch {
    throw new CapabilityRepositoryFirstActivationError("validate activation policy");
  }
}

function activationAuthorization(
  input: CapabilityRepositoryFirstActivationInput,
): CapabilityRepositoryFirstActivationAuthorization {
  return Object.freeze({
    packageName: input.packageName,
    version: input.version,
    certificateIssuer: input.certificateIssuer,
    certificateIdentity: input.certificateIdentity,
  });
}

async function readState(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  authorization: CapabilityRepositoryFirstActivationAuthorization,
  signal: AbortSignal,
): Promise<CapabilityRepositoryFirstActivationState | undefined> {
  try {
    const state = await dependencies.state.read(authorization, signal);
    signal.throwIfAborted();
    return state;
  } catch {
    signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("read activation state");
  }
}

async function publishState(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  expectedRecordDigest: `sha256:${string}` | null,
  state: CapabilityRepositoryFirstActivationStateContent,
  signal: AbortSignal,
): Promise<CapabilityRepositoryFirstActivationState> {
  try {
    const published = await dependencies.state.publish({ expectedRecordDigest, state, signal });
    signal.throwIfAborted();
    if (!isExactPublishedState(published, state)) {
      throw new Error("published first activation state changed");
    }
    return published;
  } catch {
    signal.throwIfAborted();
    try {
      const recovered = await dependencies.state.read(state.authorization, signal);
      signal.throwIfAborted();
      if (recovered !== undefined && isExactPublishedState(recovered, state)) {
        return recovered;
      }
    } catch {
      signal.throwIfAborted();
    }
    throw new CapabilityRepositoryFirstActivationError("publish activation state");
  }
}

function isExactPublishedState(
  published: CapabilityRepositoryFirstActivationState,
  expected: CapabilityRepositoryFirstActivationStateContent,
): boolean {
  return (
    /^sha256:[a-f0-9]{64}$/.test(published.recordDigest) &&
    isDeepStrictEqual(withoutRecordDigest(published), expected)
  );
}

async function readInstalled(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  packageName: string,
  signal: AbortSignal,
): Promise<readonly InstalledCapabilityRepositoryFirstActivationPackage[]> {
  try {
    const installed = await dependencies.readInstalled(packageName, signal);
    signal.throwIfAborted();
    return installed;
  } catch {
    signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("read installed package");
  }
}

function exactCandidates(
  candidates: readonly PublicCapabilityRepositoryCandidate[],
  authorization: CapabilityRepositoryFirstActivationAuthorization,
): readonly PublicCapabilityRepositoryCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.bundle.name === authorization.packageName &&
      candidate.bundle.version === authorization.version &&
      candidate.publisher.certificateIssuer === authorization.certificateIssuer &&
      candidate.publisher.certificateIdentity === authorization.certificateIdentity,
  );
}

async function publishCompletedWaitingState(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & { readonly status: "waiting" },
  completedAt: string,
  signal: AbortSignal,
): Promise<CapabilityRepositoryFirstActivationState> {
  return await publishState(
    dependencies,
    state.recordDigest,
    {
      ...withoutRecordDigest(state),
      status: "waiting",
      lastObservedAt: completedAt,
    },
    signal,
  );
}

async function reportExhaustion(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  attempts: number,
  signal: AbortSignal,
): Promise<Extract<CapabilityRepositoryFirstActivationResult, { outcome: "attempts_exhausted" }>> {
  const result = Object.freeze({ outcome: "attempts_exhausted" as const, attempts });
  await reportStatus(dependencies, result, signal);
  return result;
}

function requireMatchingState(
  state: CapabilityRepositoryFirstActivationState,
  input: CapabilityRepositoryFirstActivationInput,
): void {
  const createdAt = new Date(state.createdAt);
  const lastObservedAt = new Date(state.lastObservedAt);
  if (
    state.apiVersion !== CAPABILITY_REPOSITORY_FIRST_ACTIVATION_API_VERSION ||
    state.kind !== "CapabilityRepositoryFirstActivation" ||
    !isDeepStrictEqual(state.authorization, activationAuthorization(input)) ||
    state.intervalMs !== input.intervalMs ||
    state.maxChecks !== input.maxChecks ||
    !Number.isSafeInteger(state.attempts) ||
    state.attempts < 0 ||
    state.attempts > state.maxChecks ||
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== state.createdAt ||
    !Number.isFinite(lastObservedAt.getTime()) ||
    lastObservedAt.toISOString() !== state.lastObservedAt ||
    lastObservedAt.getTime() < createdAt.getTime()
  ) {
    throw new CapabilityRepositoryFirstActivationError("read activation state");
  }
}

async function settlePreparedState(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & { readonly status: "prepared" },
  signal: AbortSignal,
): Promise<CapabilityRepositoryFirstActivationState & { readonly status: "settled" }> {
  const settledAt = state.lastObservedAt;
  const { recordDigest: _recordDigest, ...prepared } = state;
  const settled = await publishState(
    dependencies,
    state.recordDigest,
    { ...prepared, status: "settled", settledAt },
    signal,
  );
  if (settled.status !== "settled") {
    throw new CapabilityRepositoryFirstActivationError("settle activation");
  }
  return settled;
}

async function resumePreparedActivation(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & { readonly status: "prepared" },
  signal: AbortSignal,
): Promise<Extract<CapabilityRepositoryFirstActivationResult, { outcome: "activated" }>> {
  let reopened: ReopenedCapabilityRepositoryCandidate;
  try {
    reopened = await dependencies.reopen({
      candidateDigest: state.receipt.candidateDigest,
      certificateIssuer: state.authorization.certificateIssuer,
      certificateIdentity: state.authorization.certificateIdentity,
      signal,
    });
    signal.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("verify candidate package");
  }
  const bundle = requirePreparedCandidate(reopened, state);
  const installed = await readInstalled(dependencies, state.authorization.packageName, signal);
  if (installed.length !== 0) {
    throw new CapabilityRepositoryFirstActivationError("read installed package");
  }
  return await installPreparedCandidate(
    dependencies,
    state,
    reopened.capabilityBundle,
    bundle,
    signal,
  );
}

async function installPreparedCandidate(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & { readonly status: "prepared" },
  content: Uint8Array,
  bundle: CapabilityBundle,
  callerSignal: AbortSignal,
): Promise<Extract<CapabilityRepositoryFirstActivationResult, { outcome: "activated" }>> {
  const settlementSignal = new AbortController().signal;
  let preparedState = state;
  let installOutcome: CapabilityRepositoryFirstActivationInstallOutcome;
  try {
    installOutcome = await dependencies.install({
      source: preparedState.receipt.source,
      expectedSha256: preparedState.receipt.bundle.digest.slice("sha256:".length),
      content,
      publisher: preparedState.receipt.publisher,
      signal: callerSignal,
      trustedClockHighWater: preparedState.lastObservedAt,
      advanceTrustedClockHighWater: async (observedAt) => {
        preparedState = await advancePreparedClockHighWater(
          dependencies,
          preparedState,
          observedAt,
          settlementSignal,
        );
      },
      assertCurrent: async (activeSignal) => {
        let current: ReopenedCapabilityRepositoryCandidate;
        try {
          current = await dependencies.reopen({
            candidateDigest: preparedState.receipt.candidateDigest,
            certificateIssuer: preparedState.authorization.certificateIssuer,
            certificateIdentity: preparedState.authorization.certificateIdentity,
            signal: activeSignal,
          });
          activeSignal.throwIfAborted();
          requirePreparedCandidate(current, preparedState);
        } catch {
          activeSignal.throwIfAborted();
          throw new CapabilityRepositoryFirstActivationError("verify candidate package");
        }
      },
    });
  } catch {
    callerSignal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("install candidate");
  }

  let committed =
    installOutcome.outcome === "settled" &&
    isExactInstalledResult(installOutcome.result, preparedState.receipt);
  if (
    installOutcome.outcome === "commit_uncertain" ||
    installOutcome.outcome === "settlement_uncertain"
  ) {
    try {
      const observed = await dependencies.readInstalled(
        state.authorization.packageName,
        settlementSignal,
      );
      const observedOnly = observed[0];
      committed =
        observed.length === 1 &&
        observedOnly !== undefined &&
        isExactFirstActivationReceipt(observedOnly, preparedState.receipt);
    } catch {
      committed = false;
    }
  }
  if (!committed) {
    if (installOutcome.outcome !== "settled") {
      throw new CapabilityRepositoryFirstActivationError("settle activation");
    }
    callerSignal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("install candidate");
  }

  if (installOutcome.outcome === "commit_uncertain") {
    await settlePackageMutation(dependencies, settlementSignal);
  }
  if (installOutcome.outcome === "settlement_uncertain") {
    await settlePackageMutation(dependencies, settlementSignal);
    await settlePreparedState(dependencies, preparedState, settlementSignal);
    throw new CapabilityRepositoryFirstActivationError("settle activation");
  }

  const settled = await settlePreparedState(dependencies, preparedState, settlementSignal);
  callerSignal.throwIfAborted();
  const result = activatedResult(settled.attempts, bundle);
  await reportStatus(dependencies, result, callerSignal);
  return result;
}

async function advancePreparedClockHighWater(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & { readonly status: "prepared" },
  observedAt: string,
  signal: AbortSignal,
): Promise<CapabilityRepositoryFirstActivationState & { readonly status: "prepared" }> {
  const observed = new Date(observedAt);
  if (
    !Number.isFinite(observed.getTime()) ||
    observed.toISOString() !== observedAt ||
    observed.getTime() < Date.parse(state.lastObservedAt)
  ) {
    throw new CapabilityRepositoryFirstActivationError("observe clock");
  }
  if (observedAt === state.lastObservedAt) {
    return state;
  }
  const { recordDigest: _recordDigest, ...prepared } = state;
  const advanced = await publishState(
    dependencies,
    state.recordDigest,
    { ...prepared, lastObservedAt: observedAt },
    signal,
  );
  if (advanced.status !== "prepared") {
    throw new CapabilityRepositoryFirstActivationError("publish activation state");
  }
  return advanced;
}

async function settlePackageMutation(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  signal: AbortSignal,
): Promise<void> {
  if (dependencies.settlePackageMutation === undefined) {
    throw new CapabilityRepositoryFirstActivationError("settle activation");
  }
  try {
    await dependencies.settlePackageMutation(signal);
    signal.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("settle activation");
  }
}

function requirePreparedCandidate(
  reopened: ReopenedCapabilityRepositoryCandidate,
  state: CapabilityRepositoryFirstActivationPreparedState,
): CapabilityBundle {
  try {
    const bundle = parseCapabilityBundle(reopened.capabilityBundle);
    const identity = reopened.identity;
    if (
      identity.candidateDigest !== state.receipt.candidateDigest ||
      identity.target.source !== state.receipt.source ||
      identity.bundle.name !== state.receipt.bundle.name ||
      identity.bundle.version !== state.receipt.bundle.version ||
      identity.bundle.bytes !== state.receipt.bundle.bytes ||
      identity.bundle.digest !== state.receipt.bundle.digest ||
      !isDeepStrictEqual(identity.publisher, state.receipt.publisher) ||
      bundle.name !== state.receipt.bundle.name ||
      bundle.version !== state.receipt.bundle.version ||
      bundle.bytes !== state.receipt.bundle.bytes ||
      bundle.digest !== state.receipt.bundle.digest ||
      !isAdmissibleInertBundle(bundle)
    ) {
      throw new Error("prepared candidate changed");
    }
    return bundle;
  } catch {
    throw new CapabilityRepositoryFirstActivationError("verify candidate package");
  }
}

async function reportAlreadyActivated(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  state: CapabilityRepositoryFirstActivationState & {
    readonly status: "prepared" | "settled";
    readonly receipt: CapabilityRepositoryFirstActivationReceipt;
  },
  signal: AbortSignal,
): Promise<
  Extract<CapabilityRepositoryFirstActivationResult, { readonly outcome: "already_activated" }>
> {
  const result = Object.freeze({
    outcome: "already_activated" as const,
    attempts: state.attempts,
    package: Object.freeze({
      name: state.receipt.bundle.name,
      version: state.receipt.bundle.version,
      digest: state.receipt.bundle.digest,
    }),
  });
  await reportStatus(dependencies, result, signal);
  return result;
}

function activatedResult(
  attempts: number,
  bundle: Pick<CapabilityBundle, "name" | "version" | "digest">,
): Extract<CapabilityRepositoryFirstActivationResult, { outcome: "activated" }> {
  return Object.freeze({
    outcome: "activated" as const,
    attempts,
    package: Object.freeze({ name: bundle.name, version: bundle.version, digest: bundle.digest }),
  });
}

function requireAdmissibleReopenedCandidate(
  reopened: ReopenedCapabilityRepositoryCandidate,
  selected: PublicCapabilityRepositoryCandidate,
  authorization: CapabilityRepositoryFirstActivationAuthorization,
): CapabilityBundle {
  try {
    const bundle = parseCapabilityBundle(reopened.capabilityBundle);
    const identity = reopened.identity;
    if (
      identity.candidateDigest !== selected.candidateDigest ||
      identity.bundle.name !== authorization.packageName ||
      identity.bundle.version !== authorization.version ||
      identity.bundle.bytes !== bundle.bytes ||
      identity.bundle.digest !== bundle.digest ||
      identity.publisher.certificateIssuer !== authorization.certificateIssuer ||
      identity.publisher.certificateIdentity !== authorization.certificateIdentity ||
      !isAdmissibleInertBundle(bundle)
    ) {
      throw new Error("candidate contradicts first activation authority");
    }
    return bundle;
  } catch {
    throw new CapabilityRepositoryFirstActivationError("verify candidate package");
  }
}

function isAdmissibleInertBundle(bundle: CapabilityBundle): boolean {
  const allowedKinds = new Set([
    "agent-skill",
    "verifier-package",
    "tool-package",
    "workflow-package",
    "presentation-package",
  ]);
  return bundle.packages.every((item) => allowedKinds.has(item.kind));
}

function activationReceipt(
  reopened: ReopenedCapabilityRepositoryCandidate,
  checkedAt: string,
  bundle: CapabilityBundle,
): CapabilityRepositoryFirstActivationReceipt {
  const parsedCheckedAt = new Date(checkedAt);
  if (!Number.isFinite(parsedCheckedAt.getTime()) || parsedCheckedAt.toISOString() !== checkedAt) {
    throw new CapabilityRepositoryFirstActivationError("verify candidate package");
  }
  return Object.freeze({
    candidateDigest: reopened.identity.candidateDigest,
    checkedAt,
    source: reopened.identity.target.source,
    bundle: Object.freeze({
      name: bundle.name,
      version: bundle.version,
      bytes: bundle.bytes,
      digest: bundle.digest,
    }),
    publisher: Object.freeze({ ...reopened.identity.publisher }),
  });
}

function isExactInstalledResult(
  result: InstallCapabilityBundleResult,
  receipt: CapabilityRepositoryFirstActivationReceipt,
): boolean {
  return (
    (result.status === "installed" || result.status === "already_installed") &&
    result.bundle.name === receipt.bundle.name &&
    result.bundle.version === receipt.bundle.version &&
    result.bundle.bytes === receipt.bundle.bytes &&
    result.bundle.digest === receipt.bundle.digest
  );
}

function readClock(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new CapabilityRepositoryFirstActivationError("observe clock");
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CapabilityRepositoryFirstActivationError("observe clock");
  }
  return new Date(value.getTime()).toISOString();
}

function requireMonotonicClock(previous: string, current: string): void {
  if (Date.parse(current) < Date.parse(previous)) {
    throw new CapabilityRepositoryFirstActivationError("observe clock");
  }
}

async function reportStatus(
  dependencies: CapabilityRepositoryFirstActivationDependencies,
  status: CapabilityRepositoryFirstActivationStatus,
  signal: AbortSignal,
): Promise<void> {
  try {
    await dependencies.observe(Object.freeze(status));
    signal.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    throw new CapabilityRepositoryFirstActivationError("report status");
  }
}

function withoutRecordDigest(
  state: CapabilityRepositoryFirstActivationState,
): CapabilityRepositoryFirstActivationStateContent {
  const { recordDigest: _recordDigest, ...content } = state;
  return content;
}

export function isExactFirstActivationReceipt(
  installed: InstalledCapabilityRepositoryFirstActivationPackage,
  receipt: CapabilityRepositoryFirstActivationReceipt,
): boolean {
  return (
    installed.entry.name === receipt.bundle.name &&
    installed.entry.version === receipt.bundle.version &&
    installed.entry.source === receipt.source &&
    installed.entry.digest === receipt.bundle.digest &&
    installed.entry.bytes === receipt.bundle.bytes &&
    installed.entry.publisher !== undefined &&
    isDeepStrictEqual(installed.entry.publisher, receipt.publisher) &&
    installed.bundle.name === receipt.bundle.name &&
    installed.bundle.version === receipt.bundle.version &&
    installed.bundle.digest === receipt.bundle.digest &&
    installed.bundle.bytes === receipt.bundle.bytes
  );
}
