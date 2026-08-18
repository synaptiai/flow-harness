import { compareExactSemanticVersions } from "../domain/capability/capability-bundle-replacement.js";
import { validateSigstoreCapabilityPublisherPolicy } from "../domain/capability/sigstore-capability-verifier.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../domain/capability/verifier-packages.js";
import type { CapabilityPublisherVerification } from "./capability-package-store.js";
import type { PublicCapabilityRepositoryCandidate } from "./capability-repository-candidate.js";
import {
  type CapabilityRepositorySchedulerStatus,
  runCapabilityRepositoryScheduler,
} from "./capability-repository-scheduler.js";
import type { CapabilityRepositoryCheckPublication } from "./capability-repository-store.js";
import type {
  ReplaceCapabilityRepositoryCandidateInput,
  ReplaceCapabilityRepositoryCandidateResult,
} from "./replace-capability-repository-candidate.js";

export type CapabilityRepositoryWatcherUpdatePolicy = "patch" | "minor";

export type CapabilityRepositoryWatcherStage =
  | "validate watcher policy"
  | "read installed package"
  | "check repository"
  | "replace candidate"
  | "report status"
  | "settle watcher ownership";

export class CapabilityRepositoryWatcherError extends Error {
  override readonly name = "CapabilityRepositoryWatcherError";
  readonly code = "capability_repository_watcher_failed" as const;

  constructor(readonly stage: CapabilityRepositoryWatcherStage) {
    super(`Capability repository watcher failed during ${stage}`);
  }
}

export interface InstalledCapabilityRepositoryWatcherPackage {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly publisher?: CapabilityPublisherVerification;
}

export interface CapabilityRepositoryWatcherDependencies {
  readonly readInstalled: (
    packageName: string,
    signal: AbortSignal,
  ) => Promise<InstalledCapabilityRepositoryWatcherPackage | undefined>;
  readonly check: (signal: AbortSignal) => Promise<CapabilityRepositoryCheckPublication>;
  readonly replace: (
    input: ReplaceCapabilityRepositoryCandidateInput,
  ) => Promise<ReplaceCapabilityRepositoryCandidateResult>;
}

export type CapabilityRepositoryWatcherStatus =
  | ({ readonly kind: "scheduler" } & CapabilityRepositorySchedulerStatus)
  | ({ readonly kind: "reconciliation" } & CapabilityRepositoryWatcherResult);

export interface RunCapabilityRepositoryWatcherDependencies
  extends CapabilityRepositoryWatcherDependencies {
  readonly now: () => Date;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly observe: (status: CapabilityRepositoryWatcherStatus) => void | Promise<void>;
}

export interface ReconcileCapabilityRepositoryWatcherInput {
  readonly packageName: string;
  readonly certificateIssuer: string;
  readonly certificateIdentity: string;
  readonly updatePolicy?: CapabilityRepositoryWatcherUpdatePolicy;
  readonly signal: AbortSignal;
}

export interface RunCapabilityRepositoryWatcherInput
  extends ReconcileCapabilityRepositoryWatcherInput {
  readonly intervalMs: number;
  readonly previousCompletedAt?: string;
}

export type CapabilityRepositoryWatcherResult =
  | {
      readonly outcome: "no_update" | "policy_blocked";
      readonly checkedAt: string;
      readonly package: Readonly<{ readonly name: string; readonly version: string }>;
    }
  | {
      readonly outcome: "already_current";
      readonly checkedAt: string;
      readonly package: Readonly<{
        readonly name: string;
        readonly previousVersion: string;
        readonly version: string;
        readonly digest: string;
      }>;
    }
  | {
      readonly outcome: "replaced";
      readonly checkedAt: string;
      readonly package: Readonly<{
        readonly name: string;
        readonly previousVersion: string;
        readonly version: string;
        readonly digest: string;
      }>;
      readonly cleanup: "retained";
    };

export async function runCapabilityRepositoryWatcher(
  dependencies: RunCapabilityRepositoryWatcherDependencies,
  input: RunCapabilityRepositoryWatcherInput,
): Promise<never> {
  return await runCapabilityRepositoryScheduler({
    intervalMs: input.intervalMs,
    ...(input.previousCompletedAt === undefined
      ? {}
      : { previousCompletedAt: input.previousCompletedAt }),
    signal: input.signal,
    now: dependencies.now,
    wait: dependencies.wait,
    check: async (signal) => {
      const result = await reconcileCapabilityRepositoryWatcher(dependencies, {
        packageName: input.packageName,
        certificateIssuer: input.certificateIssuer,
        certificateIdentity: input.certificateIdentity,
        ...(input.updatePolicy === undefined ? {} : { updatePolicy: input.updatePolicy }),
        signal,
      });
      await reportWatcherStatus(
        dependencies,
        Object.freeze({ kind: "reconciliation" as const, ...result }),
        signal,
      );
    },
    shouldRetryCheckFailure: (error) =>
      error instanceof CapabilityRepositoryWatcherError && error.stage === "check repository",
    observe: async (status) => {
      await reportWatcherStatus(
        dependencies,
        Object.freeze({ kind: "scheduler" as const, ...status }),
        input.signal,
      );
    },
  });
}

export async function reconcileCapabilityRepositoryWatcher(
  dependencies: CapabilityRepositoryWatcherDependencies,
  input: ReconcileCapabilityRepositoryWatcherInput,
): Promise<CapabilityRepositoryWatcherResult> {
  const policy = validateInput(input);
  throwIfAborted(input.signal);

  let installed: InstalledCapabilityRepositoryWatcherPackage | undefined;
  try {
    installed = await dependencies.readInstalled(input.packageName, input.signal);
    throwIfAborted(input.signal);
    if (!isExpectedInstalledPackage(installed, input)) {
      throw new Error("installed package does not match watcher authority");
    }
  } catch (error) {
    throwClosed(error, "read installed package", input.signal);
  }

  let checked: CapabilityRepositoryCheckPublication;
  try {
    checked = await dependencies.check(input.signal);
    throwIfAborted(input.signal);
  } catch (error) {
    throwClosed(error, "check repository", input.signal);
  }

  const matching = checked.candidates.filter(
    (candidate) =>
      candidate.bundle.name === installed.name &&
      candidate.publisher.certificateIssuer === input.certificateIssuer &&
      candidate.publisher.certificateIdentity === input.certificateIdentity,
  );
  const newer = matching.filter(
    (candidate) => compareExactSemanticVersions(candidate.bundle.version, installed.version) > 0,
  );
  const admissible = newer.filter((candidate) =>
    admitsAutomaticVersion(policy, installed.version, candidate.bundle.version),
  );
  const selected = greatestCandidate(admissible);
  if (selected === undefined) {
    return Object.freeze({
      outcome: newer.length === 0 ? "no_update" : "policy_blocked",
      checkedAt: checked.checkedAt,
      package: Object.freeze({ name: installed.name, version: installed.version }),
    });
  }

  throwIfAborted(input.signal);
  let replaced: ReplaceCapabilityRepositoryCandidateResult;
  try {
    replaced = await dependencies.replace({
      candidateDigest: selected.candidateDigest,
      expectedCurrentVersion: installed.version,
      certificateIssuer: input.certificateIssuer,
      certificateIdentity: input.certificateIdentity,
      signal: input.signal,
    });
  } catch (error) {
    throwReplacementFailure(error, input.signal);
  }

  const packageResult = Object.freeze({
    name: replaced.bundle.name,
    previousVersion: installed.version,
    version: replaced.bundle.version,
    digest: replaced.bundle.digest,
  });
  return replaced.status === "replaced"
    ? Object.freeze({
        outcome: "replaced" as const,
        checkedAt: checked.checkedAt,
        package: packageResult,
        cleanup: replaced.cleanup,
      })
    : Object.freeze({
        outcome: "already_current" as const,
        checkedAt: checked.checkedAt,
        package: packageResult,
      });
}

function validateInput(
  input: ReconcileCapabilityRepositoryWatcherInput,
): CapabilityRepositoryWatcherUpdatePolicy {
  const policy = input.updatePolicy ?? "patch";
  try {
    if (
      !verifierPackageNameSchema.safeParse(input.packageName).success ||
      (policy !== "patch" && policy !== "minor")
    ) {
      throw new Error("watcher input is invalid");
    }
    validateSigstoreCapabilityPublisherPolicy({
      certificateIssuer: input.certificateIssuer,
      certificateIdentity: input.certificateIdentity,
    });
  } catch {
    throw new CapabilityRepositoryWatcherError("validate watcher policy");
  }
  return policy;
}

function isExpectedInstalledPackage(
  installed: InstalledCapabilityRepositoryWatcherPackage | undefined,
  input: ReconcileCapabilityRepositoryWatcherInput,
): installed is InstalledCapabilityRepositoryWatcherPackage & {
  readonly publisher: CapabilityPublisherVerification;
} {
  return (
    installed !== undefined &&
    installed.name === input.packageName &&
    verifierPackageVersionSchema.safeParse(installed.version).success &&
    /^sha256:[a-f0-9]{64}$/.test(installed.digest) &&
    installed.publisher?.kind === "sigstore-keyless-v0.3" &&
    installed.publisher.certificateIssuer === input.certificateIssuer &&
    installed.publisher.certificateIdentity === input.certificateIdentity
  );
}

function admitsAutomaticVersion(
  policy: CapabilityRepositoryWatcherUpdatePolicy,
  current: string,
  candidate: string,
): boolean {
  if (
    !verifierPackageVersionSchema.safeParse(current).success ||
    !verifierPackageVersionSchema.safeParse(candidate).success
  ) {
    return false;
  }
  const currentCore = semanticVersionCore(current);
  const candidateCore = semanticVersionCore(candidate);
  return (
    candidateCore.major === currentCore.major &&
    (policy === "minor" || candidateCore.minor === currentCore.minor)
  );
}

function semanticVersionCore(version: string): { readonly major: string; readonly minor: string } {
  const core = version.split(/[+-]/, 1)[0]?.split(".") ?? [];
  return { major: core[0] ?? "", minor: core[1] ?? "" };
}

function greatestCandidate(
  candidates: readonly PublicCapabilityRepositoryCandidate[],
): PublicCapabilityRepositoryCandidate | undefined {
  let greatest: PublicCapabilityRepositoryCandidate | undefined;
  let greatestIsAmbiguous = false;
  for (const candidate of candidates) {
    if (greatest === undefined) {
      greatest = candidate;
      greatestIsAmbiguous = false;
      continue;
    }
    const comparison = compareExactSemanticVersions(
      candidate.bundle.version,
      greatest.bundle.version,
    );
    if (comparison > 0) {
      greatest = candidate;
      greatestIsAmbiguous = false;
    } else if (comparison === 0 && candidate.candidateDigest !== greatest.candidateDigest) {
      greatestIsAmbiguous = true;
    }
  }
  return greatestIsAmbiguous ? undefined : greatest;
}

function throwClosed(
  error: unknown,
  stage: CapabilityRepositoryWatcherStage,
  signal: AbortSignal,
): never {
  throwIfAborted(signal);
  if (error instanceof CapabilityRepositoryWatcherError) {
    throw error;
  }
  throw new CapabilityRepositoryWatcherError(stage);
}

function throwReplacementFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted && error === signal.reason) {
    throw error;
  }
  if (error instanceof CapabilityRepositoryWatcherError) {
    throw error;
  }
  throw new CapabilityRepositoryWatcherError("replace candidate");
}

async function reportWatcherStatus(
  dependencies: Pick<RunCapabilityRepositoryWatcherDependencies, "observe">,
  status: CapabilityRepositoryWatcherStatus,
  signal: AbortSignal,
): Promise<void> {
  try {
    await dependencies.observe(status);
  } catch (error) {
    throwClosed(error, "report status", signal);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
