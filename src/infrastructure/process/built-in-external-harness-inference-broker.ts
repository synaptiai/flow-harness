import { NativeOmpHostInferenceBroker } from "../omp/native-omp-host-inference-broker.js";
import { NativePiHostInferenceBroker } from "../pi/native-pi-host-inference-broker.js";
import type {
  ExternalHarnessInferenceBroker,
  ExternalHarnessInferenceRequest,
} from "./local-external-harness-runtime.js";

export interface BuiltInExternalHarnessInferenceBrokerOptions {
  readonly pi?: ExternalHarnessInferenceBroker;
  readonly omp?: ExternalHarnessInferenceBroker;
}

export class BuiltInExternalHarnessInferenceBroker implements ExternalHarnessInferenceBroker {
  readonly #omp: ExternalHarnessInferenceBroker;
  readonly #pi: ExternalHarnessInferenceBroker;

  constructor(options: BuiltInExternalHarnessInferenceBrokerOptions = {}) {
    this.#pi = options.pi ?? new NativePiHostInferenceBroker();
    this.#omp = options.omp ?? new NativeOmpHostInferenceBroker();
  }

  infer(request: ExternalHarnessInferenceRequest, signal?: AbortSignal): Promise<string> {
    return request.identity.adapter === "pi-native-v1"
      ? this.#pi.infer(request, signal)
      : this.#omp.infer(request, signal);
  }

  async close(evaluation: ExternalHarnessInferenceRequest["evaluation"]): Promise<void> {
    await Promise.all([this.#pi.close?.(evaluation), this.#omp.close?.(evaluation)]);
  }
}
