import { describe, expect, it, vi } from "vitest";

import {
  PrimeGlobalAdmissionController,
  PrimeGlobalAdmissionUnsafeStateError,
  type PrimeGlobalSlotInspection,
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

  it("returns an owned slot when cancellation follows durable object creation", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const controllerSignal = new AbortController();
    const inspection = {
      objectId: "d".repeat(64),
      ownerNonce: "a".repeat(64),
      policyDigest: "b".repeat(64),
      daemonId: "daemon-test-id",
    };
    const engine = lockEngine(events, { createError: new Error("request aborted") });
    engine.create.mockImplementationOnce(async () => {
      events.push("engine:create");
      controllerSignal.abort(new Error("operator cancelled"));
      throw new Error("request aborted");
    });
    engine.inspect.mockImplementationOnce(async () => inspection);

    await expect(controller(store, engine).acquire(controllerSignal.signal)).resolves.toMatchObject(
      { state: "owned", objectId: inspection.objectId },
    );
    expect(store.writeOwned).toHaveBeenCalledOnce();
  });

  it("reconciles an intent that committed before its sync error", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    store.writeIntent.mockImplementationOnce(async (lease) => {
      events.push("store:intent");
      store.setCurrent(lease);
      throw new Error("directory sync failed after intent link");
    });
    const admitted = controller(store, lockEngine(events));

    await expect(admitted.acquire()).resolves.toMatchObject({ state: "owned" });
    expect(store.read).toHaveBeenCalled();
    expect(store.writeOwned).toHaveBeenCalledOnce();
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

  it("creates and removes the fixed-name slot after an initial recovery miss", async () => {
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
    engine.inspect.mockImplementationOnce(async () => {
      events.push("engine:inspect:name");
      return null;
    });

    await controller(store, engine).recover();

    expect(events).toEqual([
      "engine:inspect:name",
      "engine:create",
      "store:owned",
      "engine:inspect:object",
      "engine:remove",
      "engine:confirm",
      "store:remove",
    ]);
  });

  it("reconciles a delayed fixed-name slot after the retry gets a conflict", async () => {
    const events: string[] = [];
    const intent: PrimeGlobalSlotLease = {
      version: 1,
      state: "intent",
      lockName: "flow-prime-global-v1",
      ownerNonce: "a".repeat(64),
      policyDigest: "b".repeat(64),
      daemonId: "daemon-test-id",
    };
    const inspection = {
      objectId: "d".repeat(64),
      ownerNonce: intent.ownerNonce,
      policyDigest: intent.policyDigest,
      daemonId: intent.daemonId,
    };
    const store = memoryStore(events, intent);
    const engine = lockEngine(events, { createError: new Error("name conflict") });
    engine.inspect
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => inspection);

    await controller(store, engine).recover();

    expect(engine.inspect).toHaveBeenCalledTimes(3);
    expect(store.writeOwned).toHaveBeenCalledOnce();
    expect(store.remove).toHaveBeenCalledOnce();
  });

  it("retires an owned lease after daemon-side removal completed", async () => {
    const events: string[] = [];
    const owned: PrimeGlobalSlotLease = {
      version: 1,
      state: "owned",
      lockName: "flow-prime-global-v1",
      ownerNonce: "a".repeat(64),
      policyDigest: "b".repeat(64),
      daemonId: "daemon-test-id",
      objectId: "d".repeat(64),
    };
    const store = memoryStore(events, owned);
    const engine = lockEngine(events);
    engine.inspect.mockResolvedValue(null);

    await controller(store, engine).recover();

    expect(engine.inspect).toHaveBeenNthCalledWith(1, owned.objectId, undefined);
    expect(engine.inspect).toHaveBeenNthCalledWith(2, owned.lockName, undefined);
    expect(store.remove).toHaveBeenCalledWith(owned);
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
    confirmIntentDurable: vi.fn(async (lease: PrimeGlobalSlotLease) => {
      if (current?.ownerNonce !== lease.ownerNonce) {
        throw new Error("intent durability is not proved");
      }
    }),
    remove: vi.fn(async () => {
      events.push("store:remove");
      current = null;
    }),
    setCurrent: (lease: PrimeGlobalSlotLease | null) => {
      current = lease;
    },
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
  let inspection: PrimeGlobalSlotInspection | null = options.inspection ?? {
    objectId: "d".repeat(64),
    ownerNonce: "a".repeat(64),
    policyDigest: "b".repeat(64),
    daemonId: "daemon-test-id",
  };
  return {
    create: vi.fn(async (): Promise<PrimeGlobalSlotInspection> => {
      events.push("engine:create");
      if (options.createError !== undefined) {
        throw options.createError;
      }
      if (inspection === null) {
        throw new Error("test global slot object is absent");
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
      inspection = null;
    }),
    confirmRemoved: vi.fn(async () => {
      events.push("engine:confirm");
      return inspection === null;
    }),
  };
}
