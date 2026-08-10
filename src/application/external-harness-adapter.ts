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

export type ExternalHarnessEvaluationProfile = {
  [Adapter in ExternalHarnessIdentity["adapter"]]: {
    readonly id: string;
    readonly adapter: Adapter;
    readonly harness: Extract<ExternalHarnessIdentity, { readonly adapter: Adapter }>;
  };
}[ExternalHarnessIdentity["adapter"]];

export type NativePiEvaluationProfile = Extract<
  ExternalHarnessEvaluationProfile,
  { readonly adapter: "pi-native-v1" }
>;

export interface ExternalHarnessEvaluationAdapterOptions {
  readonly isolation: ExternalHarnessRuntimeIsolation;
  readonly signal?: AbortSignal;
  readonly clockMs?: () => number;
}

export type NativePiEvaluationAdapterOptions = ExternalHarnessEvaluationAdapterOptions;

export class ExternalHarnessEvaluationAdapter implements HarnessEvaluationAdapter {
  readonly kind: ExternalHarnessIdentity["adapter"];
  readonly #identity: ExternalHarnessIdentity;
  readonly #profileId: string;

  constructor(
    profile: ExternalHarnessEvaluationProfile,
    private readonly runtime: ExternalHarnessRuntime,
    private readonly options: ExternalHarnessEvaluationAdapterOptions,
  ) {
    const identity = parseExternalHarnessIdentity(profile.harness);
    if (identity.adapter !== profile.adapter) {
      throw new Error("external harness profile contradicts its admitted identity");
    }
    this.kind = identity.adapter;
    this.#identity = identity;
    this.#profileId = profile.id;
  }

  async run(request: HarnessEvaluationRequest): Promise<HarnessEvaluationResult> {
    const clock = this.options.clockMs ?? Date.now;
    const started = clock();
    if (request.trial.profileId !== this.#profileId) {
      return crashedResult(
        `adapter profile "${this.#profileId}" cannot run trial profile "${request.trial.profileId}"`,
        elapsed(started, clock()),
      );
    }
    try {
      return await this.runtime.execute(
        Object.freeze({
          identity: this.#identity,
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

export class NativePiEvaluationAdapter extends ExternalHarnessEvaluationAdapter {
  constructor(
    profile: NativePiEvaluationProfile,
    runtime: ExternalHarnessRuntime,
    options: NativePiEvaluationAdapterOptions,
  ) {
    super(profile, runtime, options);
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
