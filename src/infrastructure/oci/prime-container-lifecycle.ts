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
  readonly createCleanupSignal?: () => AbortSignal | undefined;
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
    const createCleanupSignal = memoizeSignal(input.createCleanupSignal);

    await input.update(current);
    try {
      await input.assertCurrent();
      try {
        created = await this.engine.create(input.intent, input.operationSignal);
      } catch (error) {
        operationError = error;
        created = await this.#recoverLostCreate(input, createCleanupSignal);
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
        const attachment = await this.engine.attach(created.containerId, input.operationSignal);
        await input.assertCurrent();
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
        : await this.#cleanup(
            { update: input.update, createCleanupSignal },
            current,
            created.containerId,
          ).then(
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
      const created = await this.#settleIntent(
        input.lease as PrimeOciIntentLease,
        input.cleanupSignal,
      );
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
          ...(input.cleanupSignal === undefined
            ? {}
            : { createCleanupSignal: () => input.cleanupSignal as AbortSignal }),
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
        ...(input.cleanupSignal === undefined
          ? {}
          : { createCleanupSignal: () => input.cleanupSignal as AbortSignal }),
      },
      input.lease,
      input.lease.containerId,
    );
  }

  async #recoverLostCreate(
    input: PrimeOciContainerLifecycleInput,
    createCleanupSignal: () => AbortSignal | undefined,
  ): Promise<PrimeOciCreatedIdentity> {
    try {
      return await this.#settleIntent(input.intent, createCleanupSignal());
    } catch (error) {
      throw new PrimeOciUnsafeStateError("Prime OCI create outcome cannot be recovered", {
        cause: error,
      });
    }
  }

  async #settleIntent(
    intent: PrimeOciIntentLease,
    signal: AbortSignal | undefined,
  ): Promise<PrimeOciCreatedIdentity> {
    const recovered = await this.engine.recoverIntent(intent, signal);
    if (recovered !== null) {
      return recovered;
    }
    let createError: unknown;
    try {
      return await this.engine.create(intent, signal);
    } catch (error) {
      createError = error;
    }
    const reconciled = await this.engine.recoverIntent(intent, signal);
    if (reconciled !== null) {
      return reconciled;
    }
    throw new PrimeOciUnsafeStateError("Prime OCI named create did not settle", {
      cause: createError,
    });
  }

  async #cleanup(
    input: Pick<PrimeOciContainerLifecycleInput, "update" | "createCleanupSignal">,
    currentInput: EvaluationOciLease,
    containerId: string,
  ): Promise<EvaluationOciLease> {
    let current = currentInput;
    const cleanupSignal = input.createCleanupSignal?.();
    let stopError: unknown;
    try {
      await this.engine.stop(containerId, cleanupSignal);
      current = await updateLease(input, { ...current, state: "stopped" });
    } catch (error) {
      stopError = error;
    }

    let removeError: unknown;
    try {
      await this.engine.remove(containerId, cleanupSignal);
    } catch (error) {
      removeError = error;
    }

    let removed = false;
    try {
      removed = await this.engine.confirmRemoved(containerId, cleanupSignal);
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

function memoizeSignal(
  factory: PrimeOciContainerLifecycleInput["createCleanupSignal"],
): () => AbortSignal | undefined {
  let signal: AbortSignal | undefined;
  return () => {
    signal ??= factory?.();
    return signal;
  };
}
