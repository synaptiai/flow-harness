import type { ExternalHarnessRuntime } from "../../application/external-harness-adapter.js";
import type { NativePiHarnessRegistry } from "../pi/native-pi-harness-registry.js";
import { NativePiHostInferenceBroker } from "../pi/native-pi-host-inference-broker.js";
import { LocalExternalHarnessRuntime } from "../process/local-external-harness-runtime.js";
import { createProductionCommandSandbox } from "./production-node-executor.js";

export function createProductionExternalHarnessRuntime(
  registry: NativePiHarnessRegistry,
): ExternalHarnessRuntime {
  return new LocalExternalHarnessRuntime({
    registry,
    sandbox: createProductionCommandSandbox(),
    inferenceBroker: new NativePiHostInferenceBroker(),
  });
}
