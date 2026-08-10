import { HarnessUnsafeStateError } from "../../application/evaluation-adapter.js";
import type { EvaluationOciLease } from "../../domain/evaluation/attempt.js";
import type { PrimeOciAttachedTransport } from "./attached-prime-oci-operator.js";

export type PrimeOciIntentLease = EvaluationOciLease & {
  readonly state: "intent";
  readonly containerId?: never;
  readonly inspectedPolicyDigest?: never;
};

export interface PrimeOciCreatedIdentity {
  readonly containerId: string;
  readonly inspectedPolicyDigest: string;
}

export interface PrimeOciEngine {
  create(intent: PrimeOciIntentLease, signal?: AbortSignal): Promise<PrimeOciCreatedIdentity>;
  recoverIntent(
    intent: PrimeOciIntentLease,
    signal?: AbortSignal,
  ): Promise<PrimeOciCreatedIdentity | null>;
  attach(containerId: string, signal?: AbortSignal): Promise<PrimeOciAttachedTransport>;
  start(containerId: string, signal?: AbortSignal): Promise<void>;
  stop(containerId: string, signal?: AbortSignal): Promise<void>;
  remove(containerId: string, signal?: AbortSignal): Promise<void>;
  confirmRemoved(containerId: string, signal?: AbortSignal): Promise<boolean>;
}

export type PrimeOciLifecycleCheckpoint = "terminal" | "exported";

export interface PrimeOciContainerLifecycleInput {
  readonly intent: PrimeOciIntentLease;
  readonly update: (lease: EvaluationOciLease) => Promise<void>;
  readonly assertCurrent: () => Promise<void>;
  readonly operate: (
    containerId: string,
    attachment: PrimeOciAttachedTransport,
    checkpoint: (state: PrimeOciLifecycleCheckpoint) => Promise<void>,
  ) => Promise<void>;
  readonly operationSignal?: AbortSignal;
  readonly cleanupSignal?: AbortSignal;
}

export interface PrimeOciContainerRecoveryInput {
  readonly lease: EvaluationOciLease;
  readonly update: (lease: EvaluationOciLease) => Promise<void>;
  readonly cleanupSignal?: AbortSignal;
}

export class PrimeOciUnsafeStateError extends HarnessUnsafeStateError {
  override readonly name = "PrimeOciUnsafeStateError";
}

export class PrimeOciContainerLifecycle {
  constructor(private readonly engine: PrimeOciEngine) {}

  async run(input: PrimeOciContainerLifecycleInput): Promise<void> {
    let current: EvaluationOciLease = input.intent;
    let created: PrimeOciCreatedIdentity | undefined;
    let operationError: unknown;

    await input.update(current);
    try {
      try {
        created = await this.engine.create(input.intent, input.operationSignal);
      } catch (error) {
        operationError = error;
        created = await this.#recoverLostCreate(input);
      }
      if (created !== undefined) {
        current = await updateLease(input, {
          ...input.intent,
          state: "created",
          containerId: created.containerId,
          inspectedPolicyDigest: created.inspectedPolicyDigest,
        });
      }

      if (operationError === undefined && created !== undefined) {
        await input.assertCurrent();
        const attachment = await this.engine.attach(created.containerId, input.operationSignal);
        await this.engine.start(created.containerId, input.operationSignal);
        current = await updateLease(input, { ...current, state: "started" });
        await input.operate(created.containerId, attachment, async (checkpoint) => {
          if (checkpoint === "terminal") {
            if (current.state !== "started") {
              throw new Error("Prime OCI terminal checkpoint is invalid in the current state");
            }
            current = await updateLease(input, { ...current, state: "terminal" });
            return;
          }
          if (current.state !== "terminal") {
            throw new Error("Prime OCI exported checkpoint requires the terminal checkpoint");
          }
          current = await updateLease(input, { ...current, state: "exported" });
        });
        if (current.state !== "exported") {
          throw new Error("Prime OCI operation ended before the exported checkpoint");
        }
      }
    } catch (error) {
      operationError ??= error;
    }

    const cleanupError =
      created === undefined
        ? undefined
        : await this.#cleanup(input, current, created.containerId).then(
            () => undefined,
            (error: unknown) => error,
          );
    if (cleanupError !== undefined) {
      throw new PrimeOciUnsafeStateError("Prime OCI container cleanup is not proved", {
        cause: combineErrors(operationError, cleanupError),
      });
    }
    if (operationError !== undefined) {
      throw operationError;
    }
  }

  async recover(input: PrimeOciContainerRecoveryInput): Promise<EvaluationOciLease> {
    if (input.lease.state === "removed" || input.lease.state === "absent") {
      return input.lease;
    }
    if (input.lease.state === "intent") {
      const created = await this.engine.recoverIntent(
        input.lease as PrimeOciIntentLease,
        input.cleanupSignal,
      );
      if (created === null) {
        return updateRecoveryLease(input, { ...input.lease, state: "absent" });
      }
      const createdLease = {
        ...input.lease,
        state: "created" as const,
        containerId: created.containerId,
        inspectedPolicyDigest: created.inspectedPolicyDigest,
      };
      let current: EvaluationOciLease = createdLease;
      try {
        current = await updateRecoveryLease(input, createdLease);
      } catch {
        // Exact cleanup can still make the durable intent safe.
      }
      return this.#cleanup(
        {
          update: input.update,
          ...(input.cleanupSignal === undefined ? {} : { cleanupSignal: input.cleanupSignal }),
        },
        current,
        created.containerId,
      );
    }
    if (input.lease.containerId === undefined) {
      throw new PrimeOciUnsafeStateError("Prime OCI recovery has no durable container ID");
    }
    return this.#cleanup(
      {
        update: input.update,
        ...(input.cleanupSignal === undefined ? {} : { cleanupSignal: input.cleanupSignal }),
      },
      input.lease,
      input.lease.containerId,
    );
  }

  async #recoverLostCreate(
    input: PrimeOciContainerLifecycleInput,
  ): Promise<PrimeOciCreatedIdentity | undefined> {
    try {
      return (await this.engine.recoverIntent(input.intent, input.cleanupSignal)) ?? undefined;
    } catch (error) {
      throw new PrimeOciUnsafeStateError("Prime OCI create outcome cannot be recovered", {
        cause: error,
      });
    }
  }

  async #cleanup(
    input: Pick<PrimeOciContainerLifecycleInput, "update" | "cleanupSignal">,
    currentInput: EvaluationOciLease,
    containerId: string,
  ): Promise<EvaluationOciLease> {
    let current = currentInput;
    let stopError: unknown;
    try {
      await this.engine.stop(containerId, input.cleanupSignal);
      current = await updateLease(input, { ...current, state: "stopped" });
    } catch (error) {
      stopError = error;
    }

    let removeError: unknown;
    try {
      await this.engine.remove(containerId, input.cleanupSignal);
    } catch (error) {
      removeError = error;
    }

    let removed = false;
    try {
      removed = await this.engine.confirmRemoved(containerId, input.cleanupSignal);
    } catch (error) {
      removeError = combineErrors(removeError, error);
    }
    if (!removed) {
      throw new PrimeOciUnsafeStateError("Prime OCI container removal is not confirmed", {
        cause: combineErrors(stopError, removeError),
      });
    }
    return updateLease(input, { ...current, state: "removed" });
  }
}

async function updateLease(
  input: Pick<PrimeOciContainerLifecycleInput, "update">,
  lease: EvaluationOciLease,
): Promise<EvaluationOciLease> {
  await input.update(lease);
  return lease;
}

async function updateRecoveryLease(
  input: PrimeOciContainerRecoveryInput,
  lease: EvaluationOciLease,
): Promise<EvaluationOciLease> {
  await input.update(lease);
  return lease;
}

function combineErrors(primary: unknown, secondary: unknown): unknown {
  if (primary === undefined) {
    return secondary;
  }
  if (secondary === undefined) {
    return primary;
  }
  return new AggregateError([primary, secondary], "Prime OCI operation and cleanup both failed");
}
