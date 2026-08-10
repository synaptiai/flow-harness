import type { ExternalHarnessIdentity } from "../domain/evaluation/external-harness.js";
import { parseExternalHarnessIdentity } from "../domain/evaluation/external-harness.js";
import { unavailableEvaluationMetrics } from "../domain/evaluation/records.js";
import type {
  HarnessEvaluationAdapter,
  HarnessEvaluationRequest,
  HarnessEvaluationResult,
} from "./evaluation-adapter.js";

export interface ExternalHarnessRuntimeRequest {
  readonly identity: ExternalHarnessIdentity;
  readonly evaluation: HarnessEvaluationRequest;
  readonly isolation: ExternalHarnessRuntimeIsolation;
}

export interface ExternalHarnessRuntimeIsolation {
  readonly projectRoot: string;
  readonly protectedPaths: readonly string[];
}

export interface ExternalHarnessRuntime {
  execute(
    request: ExternalHarnessRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<HarnessEvaluationResult>;
}

export interface NativePiEvaluationProfile {
  readonly id: string;
  readonly adapter: "pi-native-v1";
  readonly harness: ExternalHarnessIdentity;
}

export interface NativePiEvaluationAdapterOptions {
  readonly isolation: ExternalHarnessRuntimeIsolation;
  readonly signal?: AbortSignal;
  readonly clockMs?: () => number;
}

export class NativePiEvaluationAdapter implements HarnessEvaluationAdapter {
  readonly kind = "pi-native-v1";
  readonly #profile: NativePiEvaluationProfile;

  constructor(
    profile: NativePiEvaluationProfile,
    private readonly runtime: ExternalHarnessRuntime,
    private readonly options: NativePiEvaluationAdapterOptions,
  ) {
    this.#profile = Object.freeze({
      ...profile,
      harness: parseExternalHarnessIdentity(profile.harness),
    });
  }

  async run(request: HarnessEvaluationRequest): Promise<HarnessEvaluationResult> {
    const clock = this.options.clockMs ?? Date.now;
    const started = clock();
    if (request.trial.profileId !== this.#profile.id) {
      return crashedResult(
        `adapter profile "${this.#profile.id}" cannot run trial profile "${request.trial.profileId}"`,
        elapsed(started, clock()),
      );
    }
    try {
      return await this.runtime.execute(
        Object.freeze({
          identity: this.#profile.harness,
          evaluation: request,
          isolation: Object.freeze({
            projectRoot: this.options.isolation.projectRoot,
            protectedPaths: Object.freeze([...this.options.isolation.protectedPaths]),
          }),
        }),
        this.options.signal,
      );
    } catch (error) {
      return crashedResult(boundedReason(error), elapsed(started, clock()));
    }
  }
}

function crashedResult(reason: string, wallTimeMs: number): HarnessEvaluationResult {
  return Object.freeze({
    harness: Object.freeze({ outcome: "crashed", runId: null, reason }),
    metrics: Object.freeze({ ...unavailableEvaluationMetrics(), wallTimeMs }),
  });
}

function boundedReason(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  } catch {
    return "unprintable external harness error";
  }
}

function elapsed(started: number, completed: number): number {
  const duration = Math.ceil(Math.max(0, completed - started));
  return Number.isSafeInteger(duration) ? duration : 0;
}
