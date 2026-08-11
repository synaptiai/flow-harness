import { z } from "zod";
import { HarnessUnsafeStateError } from "../../application/evaluation-adapter.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const objectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const leaseSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["intent", "owned"]),
    lockName: z.literal("flow-prime-global-v1"),
    ownerNonce: sha256Schema,
    policyDigest: sha256Schema,
    daemonId: z.string().min(1).max(256),
    objectId: objectIdSchema.optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    if ((lease.state === "owned") !== (lease.objectId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Prime global slot state contradicts its object identity",
      });
    }
  });
const inspectionSchema = z
  .object({
    objectId: objectIdSchema,
    ownerNonce: sha256Schema,
    policyDigest: sha256Schema,
    daemonId: z.string().min(1).max(256),
  })
  .strict();

export type PrimeGlobalSlotLease = z.infer<typeof leaseSchema>;
export type PrimeGlobalSlotInspection = z.infer<typeof inspectionSchema>;

export interface PrimeGlobalSlotStore {
  read(): Promise<PrimeGlobalSlotLease | null>;
  writeIntent(lease: PrimeGlobalSlotLease): Promise<void>;
  writeOwned(lease: PrimeGlobalSlotLease): Promise<void>;
  remove(lease: PrimeGlobalSlotLease): Promise<void>;
}

export interface PrimeGlobalSlotEngine {
  create(lease: PrimeGlobalSlotLease, signal?: AbortSignal): Promise<PrimeGlobalSlotInspection>;
  inspect(
    reference: "flow-prime-global-v1" | string,
    signal?: AbortSignal,
  ): Promise<PrimeGlobalSlotInspection | null>;
  remove(objectId: string, signal?: AbortSignal): Promise<void>;
  confirmRemoved(objectId: string, signal?: AbortSignal): Promise<boolean>;
}

export interface PrimeGlobalAdmissionControllerOptions {
  readonly store: PrimeGlobalSlotStore;
  readonly engine: PrimeGlobalSlotEngine;
  readonly daemonId: string;
  readonly policyDigest: string;
  readonly ownerNonce: () => string;
}

export class PrimeGlobalAdmissionUnsafeStateError extends HarnessUnsafeStateError {
  override readonly name = "PrimeGlobalAdmissionUnsafeStateError";
}

export class PrimeGlobalAdmissionController {
  constructor(private readonly options: PrimeGlobalAdmissionControllerOptions) {}

  async acquire(signal?: AbortSignal): Promise<PrimeGlobalSlotLease> {
    throwIfAborted(signal);
    const existing = await this.options.store.read();
    if (existing !== null) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot has an unresolved durable owner",
      );
    }
    const intent = parsePrimeGlobalSlotLease({
      version: 1,
      state: "intent",
      lockName: "flow-prime-global-v1",
      ownerNonce: this.options.ownerNonce(),
      policyDigest: this.options.policyDigest,
      daemonId: this.options.daemonId,
    });
    await this.options.store.writeIntent(intent);

    let inspection: PrimeGlobalSlotInspection | null;
    try {
      inspection = inspectionSchema.parse(await this.options.engine.create(intent, signal));
    } catch (createError) {
      throwIfAborted(signal);
      try {
        inspection = await this.#settleIntent(intent, signal);
      } catch (inspectError) {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot create outcome cannot be reconciled",
          { cause: new AggregateError([createError, inspectError]) },
        );
      }
    }

    const parsedInspection = inspectionSchema.parse(inspection);
    if (!matchesIntent(parsedInspection, intent)) {
      await this.options.store.remove(intent).catch(() => undefined);
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot is owned by a foreign or unverifiable object",
      );
    }
    const owned = parsePrimeGlobalSlotLease({
      ...intent,
      state: "owned",
      objectId: parsedInspection.objectId,
    });
    try {
      await this.options.store.writeOwned(owned);
    } catch (error) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot object exists without a durable owned lease",
        { cause: error },
      );
    }
    return owned;
  }

  async release(leaseInput: PrimeGlobalSlotLease, signal?: AbortSignal): Promise<void> {
    const lease = parsePrimeGlobalSlotLease(leaseInput);
    if (lease.state !== "owned" || lease.objectId === undefined) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot release requires one owned object",
      );
    }
    throwIfAborted(signal);
    const inspection = await this.options.engine.inspect(lease.objectId, signal);
    if (
      inspection === null ||
      !matchesOwned(inspectionSchema.parse(inspection), lease, lease.objectId)
    ) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot object changed before release",
      );
    }
    await this.options.engine.remove(lease.objectId, signal);
    if (!(await this.options.engine.confirmRemoved(lease.objectId, signal))) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot object removal is not confirmed",
      );
    }
    await this.options.store.remove(lease);
  }

  async recover(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const lease = await this.options.store.read();
    if (lease === null) {
      const unowned = await this.options.engine.inspect("flow-prime-global-v1", signal);
      if (unowned !== null) {
        throw new PrimeGlobalAdmissionUnsafeStateError(
          "Prime global slot has a daemon object without a durable lease",
        );
      }
      return;
    }
    if (
      lease.daemonId !== this.options.daemonId ||
      lease.policyDigest !== this.options.policyDigest
    ) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot lease contradicts the admitted daemon or policy",
      );
    }
    if (lease.state === "owned") {
      const exact = await this.options.engine.inspect(lease.objectId as string, signal);
      if (exact === null) {
        const byName = await this.options.engine.inspect(lease.lockName, signal);
        if (byName !== null) {
          throw new PrimeGlobalAdmissionUnsafeStateError(
            "Prime global slot fixed name remains after exact object removal",
          );
        }
        await this.options.store.remove(lease);
        return;
      }
      await this.release(lease, signal);
      return;
    }

    const inspection = await this.#settleIntent(lease, signal);
    const parsedInspection = inspectionSchema.parse(inspection);
    if (!matchesIntent(parsedInspection, lease)) {
      throw new PrimeGlobalAdmissionUnsafeStateError(
        "Prime global slot intent resolves to a foreign or unverifiable object",
      );
    }
    const owned = parsePrimeGlobalSlotLease({
      ...lease,
      state: "owned",
      objectId: parsedInspection.objectId,
    });
    await this.options.store.writeOwned(owned);
    await this.release(owned, signal);
  }

  async #settleIntent(
    lease: PrimeGlobalSlotLease,
    signal: AbortSignal | undefined,
  ): Promise<PrimeGlobalSlotInspection> {
    const existing = await this.options.engine.inspect(lease.lockName, signal);
    if (existing !== null) {
      return inspectionSchema.parse(existing);
    }
    let createError: unknown;
    try {
      return inspectionSchema.parse(await this.options.engine.create(lease, signal));
    } catch (error) {
      createError = error;
    }
    const reconciled = await this.options.engine.inspect(lease.lockName, signal);
    if (reconciled !== null) {
      return inspectionSchema.parse(reconciled);
    }
    throw new PrimeGlobalAdmissionUnsafeStateError(
      "Prime global slot named create did not settle",
      {
        cause: createError,
      },
    );
  }
}

export function parsePrimeGlobalSlotLease(input: unknown): PrimeGlobalSlotLease {
  const parsed = leaseSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Prime global slot lease is invalid", { cause: parsed.error });
  }
  return Object.freeze(parsed.data);
}

function matchesIntent(
  inspection: PrimeGlobalSlotInspection,
  lease: PrimeGlobalSlotLease,
): boolean {
  return (
    inspection.ownerNonce === lease.ownerNonce &&
    inspection.policyDigest === lease.policyDigest &&
    inspection.daemonId === lease.daemonId
  );
}

function matchesOwned(
  inspection: PrimeGlobalSlotInspection,
  lease: PrimeGlobalSlotLease,
  objectId: string,
): boolean {
  return inspection.objectId === objectId && matchesIntent(inspection, lease);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime admission aborted");
  }
}
