import type { HarnessEvaluationResult } from "../../application/evaluation-adapter.js";
import type {
  ExternalHarnessRuntime,
  ExternalHarnessRuntimeRequest,
} from "../../application/external-harness-adapter.js";
import type {
  EvaluationOciLease,
  EvaluationTrialAttempt,
} from "../../domain/evaluation/attempt.js";
import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";

export interface BuiltInExternalHarnessRuntimeOptions {
  readonly processRuntime: ExternalHarnessRuntime;
  readonly createPrime: () => ExternalHarnessRuntime;
}

export class BuiltInExternalHarnessRuntime implements ExternalHarnessRuntime {
  readonly #createPrime: () => ExternalHarnessRuntime;
  readonly #processRuntime: ExternalHarnessRuntime;
  #prime: ExternalHarnessRuntime | undefined;

  constructor(options: BuiltInExternalHarnessRuntimeOptions) {
    this.#processRuntime = options.processRuntime;
    this.#createPrime = options.createPrime;
  }

  execute(
    request: ExternalHarnessRuntimeRequest,
    signal?: AbortSignal,
  ): Promise<HarnessEvaluationResult> {
    return request.identity.adapter === "prime-agent-native-v1"
      ? this.#primeRuntime().execute(request, signal)
      : this.#processRuntime.execute(request, signal);
  }

  recoverAttempt(
    request: {
      readonly identity: ExternalHarnessIdentity;
      readonly attempt: EvaluationTrialAttempt;
      readonly workspaceRoot: string;
      readonly updateOciLease: (lease: EvaluationOciLease) => Promise<void>;
    },
    signal?: AbortSignal,
  ): Promise<EvaluationTrialAttempt> {
    if (request.identity.adapter !== "prime-agent-native-v1") {
      return Promise.reject(new Error("only a Prime OCI attempt can use runtime recovery"));
    }
    const recover = this.#primeRuntime().recoverAttempt;
    if (recover === undefined) {
      return Promise.reject(new Error("Prime OCI attempt recovery is not available"));
    }
    return recover.call(this.#prime, request, signal);
  }

  #primeRuntime(): ExternalHarnessRuntime {
    this.#prime ??= this.#createPrime();
    return this.#prime;
  }
}
