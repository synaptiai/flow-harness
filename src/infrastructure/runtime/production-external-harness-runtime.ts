import type { ExternalHarnessRuntime } from "../../application/external-harness-adapter.js";
import { BuiltInExternalHarnessInferenceBroker } from "../process/built-in-external-harness-inference-broker.js";
import {
  type ExternalHarnessDescriptorRegistry,
  LocalExternalHarnessRuntime,
} from "../process/local-external-harness-runtime.js";
import { createProductionCommandSandbox } from "./production-node-executor.js";

export function createProductionExternalHarnessRuntime(
  registry: ExternalHarnessDescriptorRegistry,
): ExternalHarnessRuntime {
  return new LocalExternalHarnessRuntime({
    registry,
    sandbox: createProductionCommandSandbox(),
    inferenceBroker: new BuiltInExternalHarnessInferenceBroker(),
  });
}
