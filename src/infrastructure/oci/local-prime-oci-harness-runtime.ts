import { performance } from "node:perf_hooks";

import type { HarnessEvaluationResult } from "../../application/evaluation-adapter.js";
import type {
  ExternalHarnessRuntime,
  ExternalHarnessRuntimeRequest,
} from "../../application/external-harness-adapter.js";
import {
  type EvaluationOciLease,
  type EvaluationTrialAttempt,
  parseEvaluationOciLease,
  parseEvaluationTrialAttempt,
} from "../../domain/evaluation/attempt.js";
import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type {
  EvaluationHarnessOutcome,
  EvaluationMetrics,
} from "../../domain/evaluation/records.js";
import { unavailableEvaluationMetrics } from "../../domain/evaluation/records.js";
import type { NativePrimeHarnessDescriptor } from "../prime/native-prime-harness-registry.js";
import type { PrimeOciAttachedTransport } from "./attached-prime-oci-operator.js";
import {
  PrimeOciContainerLifecycle,
  type PrimeOciEngine,
  type PrimeOciIntentLease,
  type PrimeOciLifecycleCheckpoint,
  PrimeOciUnsafeStateError,
} from "./prime-container-lifecycle.js";
import type { PrimeGlobalSlotLease } from "./prime-global-admission.js";

type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface PrimeOciRuntimeRegistry {
  resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativePrimeHarnessDescriptor>;
}

export interface PrimeOciGlobalAdmission {
  acquire(
    request: ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity },
    descriptor: NativePrimeHarnessDescriptor,
    signal?: AbortSignal,
  ): Promise<PrimeGlobalSlotLease>;
  release(lease: PrimeGlobalSlotLease, signal?: AbortSignal): Promise<void>;
  recover(
    request: {
      readonly identity: PrimeIdentity;
      readonly attempt: EvaluationTrialAttempt;
    },
    descriptor: NativePrimeHarnessDescriptor,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PrimeOciOperationInput {
  readonly request: ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity };
  readonly descriptor: NativePrimeHarnessDescriptor;
  readonly containerId: string;
  readonly transport: PrimeOciAttachedTransport;
  readonly checkpoint: (state: PrimeOciLifecycleCheckpoint) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly createCleanupSignal: () => AbortSignal;
}

export interface PrimeOciOperationEvidence {
  readonly harness: Omit<EvaluationHarnessOutcome, "runtime">;
  readonly settlement: {
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    readonly kernelRequests: number;
  };
  readonly publishResult: (signal?: AbortSignal) => Promise<void>;
  readonly abortResult: (error: unknown) => Promise<void>;
  readonly finishMetrics: (input: {
    readonly startedAtMs: number;
    readonly endedAtMs: number;
  }) => EvaluationMetrics;
}

export interface LocalPrimeOciHarnessRuntimeOptions {
  readonly registry: PrimeOciRuntimeRegistry;
  readonly globalAdmission: PrimeOciGlobalAdmission;
  readonly createEngine: (
    descriptor: NativePrimeHarnessDescriptor,
    signal?: AbortSignal,
  ) => Promise<PrimeOciEngine>;
  readonly createIntent: (
    request: ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity },
    descriptor: NativePrimeHarnessDescriptor,
    signal?: AbortSignal,
  ) => Promise<PrimeOciIntentLease>;
  readonly monitorHost?: (
    descriptor: NativePrimeHarnessDescriptor,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly operate: (input: PrimeOciOperationInput) => Promise<PrimeOciOperationEvidence>;
  readonly recoverWorkspace?: (workspaceRoot: string, signal?: AbortSignal) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly clockMs?: () => number;
  readonly deadlineFactory?: (maxMs: number) => PrimeOciExecutionDeadline;
  readonly cleanupSignalFactory?: (maxMs: number) => AbortSignal;
}

export interface PrimeOciExecutionDeadline {
  readonly signal: AbortSignal;
  readonly expired: boolean;
  dispose(): void;
}

export class LocalPrimeOciHarnessRuntime implements ExternalHarnessRuntime {
  readonly #platform: NodeJS.Platform;

  constructor(private readonly options: LocalPrimeOciHarnessRuntimeOptions) {
    this.#platform = options.platform ?? process.platform;
  }

  async execute(
    request: ExternalHarnessRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<HarnessEvaluationResult> {
    const clock = this.options.clockMs ?? (() => performance.now());
    const startedAtMs = clock();
    const primeRequest = this.#primeRequest(request);
    const deadline = (this.options.deadlineFactory ?? createDeadline)(
      primeRequest.evaluation.controls.budget.maxExecutionMs,
    );
    const operationSignal =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    const durability = primeRequest.evaluation.durability;
    if (durability === undefined) {
      deadline.dispose();
      throw new Error("Prime OCI execution requires durable lease updates");
    }
    try {
      const descriptor = await waitForAbortable(
        this.options.registry.resolveAdmitted(primeRequest.identity),
        operationSignal,
      );
      const globalLease = await this.options.globalAdmission.acquire(
        primeRequest,
        descriptor,
        operationSignal,
      );
      let finishResult: ((endedAtMs: number) => HarnessEvaluationResult) | undefined;
      let retainGlobalSlot = false;
      try {
        const engine = await waitForAbortable(
          this.options.createEngine(descriptor, operationSignal),
          operationSignal,
        );
        const intent = parseEvaluationOciLease(
          await waitForAbortable(
            this.options.createIntent(primeRequest, descriptor, operationSignal),
            operationSignal,
          ),
        );
        if (intent.state !== "intent") {
          throw new Error("Prime OCI execution must start with an intent lease");
        }
        if (intent.labels.trialId !== primeRequest.evaluation.trial.trialId) {
          throw new Error("Prime OCI intent lease contradicts the trial identity");
        }

        let evidence: PrimeOciOperationEvidence | undefined;
        let lifecycleError: unknown;
        let policyTerminationError: unknown;
        let cleanupSignal: AbortSignal | undefined;
        const createExecutionCleanupSignal = (): AbortSignal => {
          cleanupSignal ??= (this.options.cleanupSignalFactory ?? createCleanupSignal)(
            primeRequest.identity.runtime.policy.cleanupGraceMs,
          );
          return cleanupSignal;
        };
        try {
          await new PrimeOciContainerLifecycle(engine).run({
            intent: intent as PrimeOciIntentLease,
            update: durability.updateOciLease,
            assertCurrent: () =>
              waitForAbortable(descriptor.assertCurrent(operationSignal), operationSignal),
            operate: async (containerId, transport, checkpoint) => {
              const stopMonitor = new AbortController();
              const policyTermination = new AbortController();
              const monitorSignal = AbortSignal.any([operationSignal, stopMonitor.signal]);
              const monitoredOperationSignal = AbortSignal.any([
                operationSignal,
                policyTermination.signal,
              ]);
              const monitorPromise =
                this.options.monitorHost === undefined
                  ? Promise.resolve()
                  : Promise.resolve()
                      .then(() => this.options.monitorHost?.(descriptor, monitorSignal))
                      .then(() => {
                        if (!monitorSignal.aborted) {
                          throw new Error("Prime host runtime monitor ended before the operation");
                        }
                      })
                      .catch((error: unknown) => {
                        if (!monitorSignal.aborted) {
                          policyTerminationError = error;
                          policyTermination.abort(error);
                        }
                      });
              try {
                const operation = this.options.operate({
                  request: primeRequest,
                  descriptor,
                  containerId,
                  transport,
                  checkpoint,
                  signal: monitoredOperationSignal,
                  createCleanupSignal: createExecutionCleanupSignal,
                });
                try {
                  evidence = await waitForAbortable(operation, monitoredOperationSignal);
                } catch (error) {
                  if (!monitoredOperationSignal.aborted) {
                    throw error;
                  }
                  const cancellation = abortError(monitoredOperationSignal);
                  try {
                    await waitForAbortable(operation, createExecutionCleanupSignal());
                  } catch (settlementError) {
                    if (cleanupSignal?.aborted === true) {
                      throw new AggregateError(
                        [cancellation, settlementError],
                        "Prime OCI operation and cleanup both failed",
                      );
                    }
                    if (
                      settlementError instanceof AggregateError ||
                      (monitoredOperationSignal.reason instanceof Error &&
                        settlementError !== monitoredOperationSignal.reason)
                    ) {
                      throw settlementError;
                    }
                  }
                  throw cancellation;
                }
              } finally {
                stopMonitor.abort(new Error("Prime host runtime monitor stopped"));
                await waitForAbortable(monitorPromise, monitorSignal).catch(() => undefined);
              }
            },
            operationSignal,
            createCleanupSignal: createExecutionCleanupSignal,
          });
        } catch (error) {
          if (error instanceof PrimeOciUnsafeStateError) {
            await evidence?.abortResult(error).catch(() => undefined);
            throw error;
          }
          lifecycleError = error;
        }
        if (lifecycleError !== undefined && evidence !== undefined) {
          await evidence.abortResult(lifecycleError);
        }
        if (lifecycleError !== undefined) {
          if (policyTerminationError !== undefined) {
            finishResult = (endedAtMs) =>
              failureResult(
                primeRequest,
                "crashed",
                boundedReason(policyTerminationError),
                startedAtMs,
                endedAtMs,
              );
          } else if (deadline.expired) {
            finishResult = (endedAtMs) =>
              failureResult(
                primeRequest,
                "timed_out",
                `Prime execution exceeded ${primeRequest.evaluation.controls.budget.maxExecutionMs}ms`,
                startedAtMs,
                endedAtMs,
              );
          } else if (signal?.aborted === true) {
            finishResult = (endedAtMs) =>
              failureResult(
                primeRequest,
                "cancelled",
                boundedReason(signal.reason ?? lifecycleError),
                startedAtMs,
                endedAtMs,
              );
          } else {
            throw lifecycleError;
          }
        } else {
          if (evidence === undefined) {
            throw new Error("Prime OCI execution did not produce harness evidence");
          }
          if (evidence.settlement.timedOut && evidence.settlement.aborted) {
            throw new Error("Prime OCI settlement cannot be both timed out and aborted");
          }
          if (
            !Number.isInteger(evidence.settlement.kernelRequests) ||
            evidence.settlement.kernelRequests < 0 ||
            evidence.settlement.kernelRequests > 1
          ) {
            throw new Error("Prime OCI settlement has an invalid kernel request count");
          }
          if (
            (evidence.harness.outcome === "timed_out") !== evidence.settlement.timedOut ||
            (evidence.harness.outcome === "cancelled") !== evidence.settlement.aborted
          ) {
            throw new Error("Prime child outcome contradicts trusted OCI settlement evidence");
          }
          await evidence.publishResult(
            (this.options.cleanupSignalFactory ?? createCleanupSignal)(
              primeRequest.identity.runtime.policy.cleanupGraceMs,
            ),
          );
          const completedEvidence = evidence;
          finishResult = (endedAtMs) =>
            Object.freeze({
              harness: Object.freeze({
                ...completedEvidence.harness,
                runtime: runtimeEvidence(primeRequest, completedEvidence.settlement),
              }),
              metrics: completedEvidence.finishMetrics({ startedAtMs, endedAtMs }),
            });
        }
      } catch (error) {
        retainGlobalSlot = error instanceof PrimeOciUnsafeStateError;
        throw error;
      } finally {
        if (!retainGlobalSlot) {
          await this.options.globalAdmission.release(
            globalLease,
            (this.options.cleanupSignalFactory ?? createCleanupSignal)(
              primeRequest.identity.runtime.policy.cleanupGraceMs,
            ),
          );
        }
      }
      if (finishResult === undefined) {
        throw new Error("Prime OCI execution did not produce a final result");
      }
      return finishResult(clock());
    } finally {
      deadline.dispose();
    }
  }

  async recoverAttempt(
    request: {
      readonly identity: ExternalHarnessIdentity;
      readonly attempt: EvaluationTrialAttempt;
      readonly workspaceRoot: string;
      readonly updateOciLease: (lease: EvaluationOciLease) => Promise<void>;
    },
    signal?: AbortSignal,
  ): Promise<EvaluationTrialAttempt> {
    this.#assertPlatform();
    if (request.identity.adapter !== "prime-agent-native-v1") {
      throw new Error("Prime OCI recovery received a different adapter identity");
    }
    const attempt = parseEvaluationTrialAttempt(request.attempt);
    if (attempt.adapter !== "prime-agent-native-v1") {
      throw new Error("Prime OCI recovery requires one durable Prime attempt");
    }
    const descriptorPromise = this.options.registry.resolveAdmitted(request.identity);
    const descriptor =
      signal === undefined
        ? await descriptorPromise
        : await waitForAbortable(descriptorPromise, signal);
    await descriptor.assertCurrent(signal);
    let recovered = attempt;
    if (attempt.ociLease !== undefined) {
      const engine = await this.options.createEngine(descriptor, signal);
      const lease = await new PrimeOciContainerLifecycle(engine).recover({
        lease: attempt.ociLease,
        update: request.updateOciLease,
        ...(signal === undefined ? {} : { cleanupSignal: signal }),
      });
      recovered = parseEvaluationTrialAttempt({ ...attempt, ociLease: lease });
    }
    await this.options.globalAdmission.recover(
      { identity: request.identity, attempt: recovered },
      descriptor,
      signal,
    );
    if (this.options.recoverWorkspace === undefined) {
      throw new Error("Prime workspace recovery is not available");
    }
    await this.options.recoverWorkspace(request.workspaceRoot, signal);
    return recovered;
  }

  #primeRequest(
    request: ExternalHarnessRuntimeRequest,
  ): ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity } {
    this.#assertPlatform();
    if (request.identity.adapter !== "prime-agent-native-v1") {
      throw new Error("Prime OCI runtime received a different adapter identity");
    }
    return request as ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity };
  }

  #assertPlatform(): void {
    if (this.#platform !== "linux") {
      throw new Error(`Prime OCI runtime is supported only on Linux, not ${this.#platform}`);
    }
  }
}

function runtimeEvidence(
  request: ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity },
  settlement: PrimeOciOperationEvidence["settlement"],
) {
  return Object.freeze({
    adapter: "prime-agent-native-v1" as const,
    containment: "docker-oci-v1" as const,
    engineStatus: "verified" as const,
    imageId: request.identity.image.id,
    policyDigest: request.identity.runtime.policy.digest,
    exitCode: settlement.exitCode,
    timedOut: settlement.timedOut,
    aborted: settlement.aborted,
    recoveryOutcome: "not_attempted" as const,
    removal: "confirmed" as const,
  });
}

function failureResult(
  request: ExternalHarnessRuntimeRequest & { readonly identity: PrimeIdentity },
  outcome: "timed_out" | "cancelled" | "crashed",
  reason: string,
  startedAtMs: number,
  endedAtMs: number,
): HarnessEvaluationResult {
  const metrics = unavailableEvaluationMetrics();
  return Object.freeze({
    harness: Object.freeze({
      outcome,
      runId: null,
      reason,
      runtime: runtimeEvidence(request, {
        exitCode: null,
        timedOut: outcome === "timed_out",
        aborted: outcome === "cancelled",
        kernelRequests: 0,
      }),
    }),
    metrics: Object.freeze({
      ...metrics,
      wallTimeMs: durationMs(startedAtMs, endedAtMs),
      interventions: 1,
      recoveryAttempts: 0,
      recoveryOutcome: "not_attempted" as const,
    }),
  });
}

function createDeadline(maxMs: number): PrimeOciExecutionDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`Prime execution exceeded ${maxMs}ms`));
  }, maxMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    dispose: () => clearTimeout(timer),
  };
}

function createCleanupSignal(maxMs: number): AbortSignal {
  return AbortSignal.timeout(maxMs);
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Prime operation aborted");
}

function durationMs(startedAtMs: number, endedAtMs: number): number {
  const duration = Math.ceil(endedAtMs - startedAtMs);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : 0;
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable Prime cancellation reason";
  }
}
