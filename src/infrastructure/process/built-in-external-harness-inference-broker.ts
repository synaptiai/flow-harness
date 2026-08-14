import { NativeOmpHostInferenceBroker } from "../omp/native-omp-host-inference-broker.js";
import { NativePiHostInferenceBroker } from "../pi/native-pi-host-inference-broker.js";
import { NativePrimeHostInferenceBroker } from "../prime/native-prime-host-inference-broker.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "./local-external-harness-runtime.js";

export interface BuiltInExternalHarnessInferenceBrokerOptions {
  readonly pi?: ExternalHarnessInferenceBroker;
  readonly omp?: ExternalHarnessInferenceBroker;
  readonly prime?: ExternalHarnessInferenceBroker;
}

export class BuiltInExternalHarnessInferenceBroker implements ExternalHarnessInferenceBroker {
  readonly #omp: ExternalHarnessInferenceBroker;
  readonly #pi: ExternalHarnessInferenceBroker;
  readonly #prime: ExternalHarnessInferenceBroker;

  constructor(options: BuiltInExternalHarnessInferenceBrokerOptions = {}) {
    this.#pi = options.pi ?? new NativePiHostInferenceBroker();
    this.#omp = options.omp ?? new NativeOmpHostInferenceBroker();
    this.#prime = options.prime ?? new NativePrimeHostInferenceBroker();
  }

  infer(request: ExternalHarnessInferenceRequest, signal?: AbortSignal): Promise<string> {
    if (request.identity.adapter === "pi-native-v1") {
      return this.#pi.infer(request, signal);
    }
    if (request.identity.adapter === "omp-native-v1") {
      return this.#omp.infer(request, signal);
    }
    return this.#prime.infer(request, signal);
  }

  async close(evaluation: ExternalHarnessInferenceRequest["evaluation"]): Promise<void> {
    await Promise.all([
      this.#pi.close?.(evaluation),
      this.#omp.close?.(evaluation),
      this.#prime.close?.(evaluation),
    ]);
  }
}
