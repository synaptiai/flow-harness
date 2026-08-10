import { describe, expect, it, vi } from "vitest";

import {
  PrimeGlobalAdmissionController,
  PrimeGlobalAdmissionUnsafeStateError,
  type PrimeGlobalSlotLease,
} from "../../../../src/infrastructure/oci/prime-global-admission.js";

describe("Prime global admission", () => {
  it("publishes intent before lock creation and removes the lock before the lease", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const engine = lockEngine(events);
    const admission = controller(store, engine);

    const lease = await admission.acquire();
    await admission.release(lease);

    expect(events).toEqual([
      "store:intent",
      "engine:create",
      "store:owned",
      "engine:inspect:object",
      "engine:remove",
      "engine:confirm",
      "store:remove",
    ]);
  });

  it("rejects a foreign fixed-name lock and never removes it", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const engine = lockEngine(events, {
      createError: new Error("name conflict"),
      inspection: {
        objectId: "f".repeat(64),
        ownerNonce: "e".repeat(64),
        policyDigest: "c".repeat(64),
        daemonId: "other-daemon",
      },
    });

    await expect(controller(store, engine).acquire()).rejects.toBeInstanceOf(
      PrimeGlobalAdmissionUnsafeStateError,
    );
    expect(engine.remove).not.toHaveBeenCalled();
  });

  it("recovers a lost create response from the exact fixed-name lock", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const ownerNonce = "a".repeat(64);
    const inspection = {
      objectId: "d".repeat(64),
      ownerNonce,
      policyDigest: "b".repeat(64),
      daemonId: "daemon-test-id",
    };
    const engine = lockEngine(events, {
      createError: new Error("lost response"),
      inspection,
    });
    const admitted = new PrimeGlobalAdmissionController({
      store,
      engine,
      daemonId: "daemon-test-id",
      policyDigest: "b".repeat(64),
      ownerNonce: () => ownerNonce,
    });

    const lease = await admitted.acquire();

    expect(lease).toMatchObject({ state: "owned", objectId: inspection.objectId });
    expect(events).toEqual(["store:intent", "engine:create", "engine:inspect:name", "store:owned"]);
  });

  it("keeps the slot closed when release inspection changes", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const engine = lockEngine(events);
    const admitted = controller(store, engine);
    const lease = await admitted.acquire();
    if (lease.objectId === undefined) {
      throw new Error("test expected an owned Prime global slot");
    }
    engine.inspect.mockResolvedValueOnce({
      objectId: lease.objectId,
      ownerNonce: "e".repeat(64),
      policyDigest: lease.policyDigest,
      daemonId: lease.daemonId,
    });

    await expect(admitted.release(lease)).rejects.toBeInstanceOf(
      PrimeGlobalAdmissionUnsafeStateError,
    );
    expect(engine.remove).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("recovers a durable intent after a lost create response", async () => {
    const events: string[] = [];
    const intent: PrimeGlobalSlotLease = {
      version: 1,
      state: "intent",
      lockName: "flow-prime-global-v1",
      ownerNonce: "a".repeat(64),
      policyDigest: "b".repeat(64),
      daemonId: "daemon-test-id",
    };
    const store = memoryStore(events, intent);
    const engine = lockEngine(events);

    await controller(store, engine).recover();

    expect(events).toEqual([
      "engine:inspect:name",
      "store:owned",
      "engine:inspect:object",
      "engine:remove",
      "engine:confirm",
      "store:remove",
    ]);
  });
});

function controller(store: ReturnType<typeof memoryStore>, engine: ReturnType<typeof lockEngine>) {
  return new PrimeGlobalAdmissionController({
    store,
    engine,
    daemonId: "daemon-test-id",
    policyDigest: "b".repeat(64),
    ownerNonce: () => "a".repeat(64),
  });
}

function memoryStore(events: string[], initial: PrimeGlobalSlotLease | null = null) {
  let current: PrimeGlobalSlotLease | null = initial;
  return {
    read: vi.fn(async () => current),
    writeIntent: vi.fn(async (lease: PrimeGlobalSlotLease) => {
      events.push("store:intent");
      if (current !== null) {
        throw new Error("slot lease already exists");
      }
      current = lease;
    }),
    writeOwned: vi.fn(async (lease: PrimeGlobalSlotLease) => {
      events.push("store:owned");
      current = lease;
    }),
    remove: vi.fn(async () => {
      events.push("store:remove");
      current = null;
    }),
  };
}

function lockEngine(
  events: string[],
  options: {
    readonly createError?: Error;
    readonly inspection?: {
      readonly objectId: string;
      readonly ownerNonce: string;
      readonly policyDigest: string;
      readonly daemonId: string;
    };
  } = {},
) {
  let inspection = options.inspection ?? {
    objectId: "d".repeat(64),
    ownerNonce: "a".repeat(64),
    policyDigest: "b".repeat(64),
    daemonId: "daemon-test-id",
  };
  return {
    create: vi.fn(async () => {
      events.push("engine:create");
      if (options.createError !== undefined) {
        throw options.createError;
      }
      return inspection;
    }),
    inspect: vi.fn(async (reference: string) => {
      events.push(
        reference === "flow-prime-global-v1" ? "engine:inspect:name" : "engine:inspect:object",
      );
      return inspection;
    }),
    remove: vi.fn(async () => {
      events.push("engine:remove");
      inspection = null as never;
    }),
    confirmRemoved: vi.fn(async () => {
      events.push("engine:confirm");
      return inspection === null;
    }),
  };
}
