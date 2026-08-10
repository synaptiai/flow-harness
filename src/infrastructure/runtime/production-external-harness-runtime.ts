import { randomBytes } from "node:crypto";

import type { ExternalHarnessRuntime } from "../../application/external-harness-adapter.js";
import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import { AttachedPrimeOciOperator } from "../oci/attached-prime-oci-operator.js";
import { DockerUnixApiClient } from "../oci/docker-unix-api-client.js";
import { DurablePrimeWorkspacePublisher } from "../oci/durable-prime-workspace-publisher.js";
import { LocalDockerPrimeGlobalSlotEngine } from "../oci/local-docker-prime-global-slot.js";
import { LocalDockerPrimeOciEngine } from "../oci/local-docker-prime-oci-engine.js";
import { LocalPrimeGlobalSlotStore } from "../oci/local-prime-global-slot-store.js";
import { LocalPrimeHostAdmissionProbe } from "../oci/local-prime-host-admission-probe.js";
import {
  LocalPrimeOciHarnessRuntime,
  type PrimeOciGlobalAdmission,
} from "../oci/local-prime-oci-harness-runtime.js";
import {
  createLocalPrimeOciFixtureSource,
  StagedPrimeOciResultSink,
} from "../oci/local-prime-workspace-transfer.js";
import {
  PrimeGlobalAdmissionController,
  PrimeGlobalAdmissionUnsafeStateError,
  type PrimeGlobalSlotLease,
} from "../oci/prime-global-admission.js";
import { createPrimeOciIntent } from "../oci/prime-oci-intent.js";
import { validatePrimeOciReadiness } from "../oci/prime-oci-readiness.js";
import type { NativePrimeHarnessDescriptor } from "../prime/native-prime-harness-registry.js";
import { NativePrimeHostInferenceBroker } from "../prime/native-prime-host-inference-broker.js";
import { BuiltInExternalHarnessInferenceBroker } from "../process/built-in-external-harness-inference-broker.js";
import { BuiltInExternalHarnessRuntime } from "../process/built-in-external-harness-runtime.js";
import {
  type ExternalHarnessDescriptorRegistry,
  LocalExternalHarnessRuntime,
} from "../process/local-external-harness-runtime.js";
import { createProductionCommandSandbox } from "./production-node-executor.js";

export interface ProductionExternalHarnessRegistry extends ExternalHarnessDescriptorRegistry {
  resolvePrimeAdmitted?(identity: ExternalHarnessIdentity): Promise<NativePrimeHarnessDescriptor>;
}

export interface ProductionExternalHarnessRuntimeOptions {
  readonly processRuntime?: ExternalHarnessRuntime;
  readonly createPrimeRuntime?: () => ExternalHarnessRuntime;
}

export function createProductionExternalHarnessRuntime(
  registry: ProductionExternalHarnessRegistry,
  options: ProductionExternalHarnessRuntimeOptions = {},
): ExternalHarnessRuntime {
  const processRuntime =
    options.processRuntime ??
    new LocalExternalHarnessRuntime({
      registry,
      sandbox: createProductionCommandSandbox(),
      inferenceBroker: new BuiltInExternalHarnessInferenceBroker(),
    });
  return new BuiltInExternalHarnessRuntime({
    processRuntime,
    createPrime: options.createPrimeRuntime ?? (() => createProductionPrimeOciRuntime(registry)),
  });
}

export function createProductionPrimeOciRuntime(
  registry: ProductionExternalHarnessRegistry,
): ExternalHarnessRuntime {
  const resolvePrimeAdmitted = registry.resolvePrimeAdmitted?.bind(registry);
  if (resolvePrimeAdmitted === undefined) {
    throw new Error("production external harness registry has no Prime OCI descriptor route");
  }

  return new LocalPrimeOciHarnessRuntime({
    registry: { resolveAdmitted: resolvePrimeAdmitted },
    globalAdmission: createProductionGlobalAdmission(),
    monitorHost: (descriptor, signal) =>
      new LocalPrimeHostAdmissionProbe().monitorRuntime(
        {
          cgroupPath: descriptor.localRuntime.cgroupPath,
          imageProbe: descriptor.localRuntime.imageProbe,
          imageDevice: descriptor.localRuntime.imageDevice,
        },
        descriptor.identity.runtime.policy,
        signal,
      ),
    createEngine: async (descriptor) => {
      const local = descriptor.localRuntime;
      return new LocalDockerPrimeOciEngine({
        api: new DockerUnixApiClient({
          socketPath: local.socketPath,
          apiVersion: local.apiVersion,
        }),
        identity: descriptor.identity,
        seccompProfile: local.seccompProfile,
        imageDevice: local.imageDevice,
      });
    },
    createIntent: async (request, descriptor) =>
      createPrimeOciIntent(request, {
        socketPath: descriptor.localRuntime.socketPath,
        ...descriptor.localRuntime.socket,
      }),
    operate: async (input) => {
      const workspaceRoot = input.request.evaluation.workspace.cwd;
      const publisher = new DurablePrimeWorkspacePublisher();
      const recovered = await publisher.recover(workspaceRoot);
      if (recovered !== "none") {
        throw new Error("Prime workspace required replacement recovery before trial execution");
      }
      const fixture = await createLocalPrimeOciFixtureSource({
        root: workspaceRoot,
        instructionPath: input.request.evaluation.instruction.path,
        expectedSnapshotDigest: input.request.evaluation.workspace.snapshotDigest,
      });
      const resultSink = new StagedPrimeOciResultSink({
        targetRoot: workspaceRoot,
        publish: (publication) => publisher.publish(publication),
      });
      return new AttachedPrimeOciOperator({
        fixture,
        resultSink,
        inferenceBroker: new NativePrimeHostInferenceBroker(),
        validateReadiness: (payload, operation) => {
          validatePrimeOciReadiness(payload, {
            identity: operation.descriptor.identity,
            identityDigest: operation.descriptor.identityDigest,
            containerId: operation.containerId,
            trialId: operation.request.evaluation.trial.trialId,
          });
        },
      }).operate(input);
    },
  });
}

function createProductionGlobalAdmission(): PrimeOciGlobalAdmission {
  const controllers = new Map<string, PrimeGlobalAdmissionController>();
  const hostProbe = new LocalPrimeHostAdmissionProbe();
  const admission: PrimeOciGlobalAdmission = {
    acquire: async (_request, descriptor, signal) => {
      await hostProbe.observe(
        {
          cgroupPath: descriptor.localRuntime.cgroupPath,
          imageProbe: descriptor.localRuntime.imageProbe,
          imageDevice: descriptor.localRuntime.imageDevice,
        },
        descriptor.identity.runtime.policy,
        signal,
      );
      const controller = createGlobalAdmissionController(descriptor);
      const lease = await controller.acquire(signal);
      if (controllers.has(lease.ownerNonce)) {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot owner nonce collided in the active process",
        );
      }
      controllers.set(lease.ownerNonce, controller);
      return lease;
    },
    release: async (lease: PrimeGlobalSlotLease, signal?: AbortSignal) => {
      const controller = controllers.get(lease.ownerNonce);
      if (controller === undefined) {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot release has no active local controller",
        );
      }
      await controller.release(lease, signal);
      controllers.delete(lease.ownerNonce);
    },
    recover: async (_request, descriptor, signal) => {
      await createGlobalAdmissionController(descriptor).recover(signal);
    },
  };
  return Object.freeze(admission);
}

function createGlobalAdmissionController(
  descriptor: NativePrimeHarnessDescriptor,
): PrimeGlobalAdmissionController {
  const local = descriptor.localRuntime;
  const api = new DockerUnixApiClient({
    socketPath: local.socketPath,
    apiVersion: local.apiVersion,
  });
  return new PrimeGlobalAdmissionController({
    store: new LocalPrimeGlobalSlotStore({ leasePath: local.globalLeasePath }),
    engine: new LocalDockerPrimeGlobalSlotEngine({
      api,
      identity: descriptor.identity,
      daemonId: local.daemonId,
    }),
    daemonId: local.daemonId,
    policyDigest: descriptor.identity.runtime.policy.digest,
    ownerNonce: () => randomBytes(32).toString("hex"),
  });
}
