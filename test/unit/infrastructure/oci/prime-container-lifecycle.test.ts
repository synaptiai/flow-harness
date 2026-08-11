import { describe, expect, it, vi } from "vitest";

import type { EvaluationOciLease } from "../../../../src/domain/evaluation/attempt.js";
import {
  PrimeOciContainerLifecycle,
  type PrimeOciEngine,
  type PrimeOciIntentLease,
  PrimeOciUnsafeStateError,
} from "../../../../src/infrastructure/oci/prime-container-lifecycle.js";

describe("Prime OCI container lifecycle", () => {
  it("makes every authority transition durable before the next operation", async () => {
    const events: string[] = [];
    const updates: EvaluationOciLease[] = [];
    const engine = fakeEngine(events);
    const lifecycle = new PrimeOciContainerLifecycle(engine);

    await lifecycle.run({
      intent: intentLease(),
      update: async (lease) => {
        events.push(`update:${lease.state}`);
        updates.push(lease);
      },
      assertCurrent: async () => {
        events.push("assert-current");
      },
      operate: async (_containerId, attachment, checkpoint) => {
        expect(attachment).toBe(attachedTransport);
        events.push("operate");
        await checkpoint("terminal");
        await checkpoint("exported");
      },
    });

    expect(events).toEqual([
      "update:intent",
      "create",
      "update:created",
      "assert-current",
      "attach",
      "start",
      "update:started",
      "operate",
      "update:terminal",
      "update:exported",
      "stop",
      "update:stopped",
      "remove",
      "confirm-removed",
      "update:removed",
    ]);
    expect(updates.at(-1)?.state).toBe("removed");
  });

  it("does not start when the created lease is not durable", async () => {
    const events: string[] = [];
    const engine = fakeEngine(events);
    const lifecycle = new PrimeOciContainerLifecycle(engine);

    await expect(
      lifecycle.run({
        intent: intentLease(),
        update: async (lease) => {
          events.push(`update:${lease.state}`);
          if (lease.state === "created") {
            throw new Error("durable write failed");
          }
        },
        assertCurrent: vi.fn(),
        operate: vi.fn(),
      }),
    ).rejects.toThrow(/durable write failed/i);

    expect(events).not.toContain("start");
    expect(events).toContain("remove");
    expect(events).toContain("confirm-removed");
  });

  it("recovers an intent when create commits but its response is lost", async () => {
    const events: string[] = [];
    const engine = fakeEngine(events, { createResponseLost: true });
    const lifecycle = new PrimeOciContainerLifecycle(engine);

    await expect(
      lifecycle.run({
        intent: intentLease(),
        update: async (lease) => {
          events.push(`update:${lease.state}`);
        },
        assertCurrent: vi.fn(),
        operate: vi.fn(),
      }),
    ).rejects.toThrow(/create response lost/i);

    expect(events).toContain("recover-intent");
    expect(events).not.toContain("start");
    expect(events.slice(-3)).toEqual(["remove", "confirm-removed", "update:removed"]);
  });

  it("keeps the durable lease when removal is not proved", async () => {
    const events: string[] = [];
    const engine = fakeEngine(events, { removalConfirmed: false });
    const lifecycle = new PrimeOciContainerLifecycle(engine);

    await expect(
      lifecycle.run({
        intent: intentLease(),
        update: async (lease) => {
          events.push(`update:${lease.state}`);
        },
        assertCurrent: vi.fn(),
        operate: async (_containerId, _attachment, checkpoint) => {
          await checkpoint("terminal");
          await checkpoint("exported");
        },
      }),
    ).rejects.toBeInstanceOf(PrimeOciUnsafeStateError);

    expect(events).toContain("update:stopped");
    expect(events).not.toContain("update:removed");
  });

  it("rejects an exported checkpoint before the terminal checkpoint", async () => {
    const engine = fakeEngine([]);
    const lifecycle = new PrimeOciContainerLifecycle(engine);

    await expect(
      lifecycle.run({
        intent: intentLease(),
        update: vi.fn(async () => undefined),
        assertCurrent: vi.fn(),
        operate: async (_containerId, _attachment, checkpoint) => {
          await checkpoint("exported");
        },
      }),
    ).rejects.toThrow(/checkpoint|terminal/i);
  });

  it("creates and removes the exact named object after an initial recovery miss", async () => {
    const events: string[] = [];
    const lifecycle = new PrimeOciContainerLifecycle(
      fakeEngine(events, { recoveredIntentMissing: true }),
    );

    const recovered = await lifecycle.recover({
      lease: intentLease(),
      update: async (lease) => {
        events.push(`update:${lease.state}`);
      },
    });

    expect(recovered.state).toBe("removed");
    expect(events).toEqual([
      "recover-intent",
      "create",
      "update:created",
      "stop",
      "update:stopped",
      "remove",
      "confirm-removed",
      "update:removed",
    ]);
  });

  it("reconciles a delayed named object after the retry gets a conflict", async () => {
    const events: string[] = [];
    const base = fakeEngine(events);
    const created = {
      containerId: "f".repeat(64),
      inspectedPolicyDigest: "c".repeat(64),
    };
    base.recoverIntent = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(created);
    base.create = vi.fn(async () => {
      events.push("create");
      throw new Error("name conflict");
    });

    await expect(
      new PrimeOciContainerLifecycle(base).recover({
        lease: intentLease(),
        update: async (lease) => {
          events.push(`update:${lease.state}`);
        },
      }),
    ).resolves.toMatchObject({ state: "removed" });

    expect(base.recoverIntent).toHaveBeenCalledTimes(2);
    expect(events).toContain("update:created");
    expect(events).toContain("update:removed");
  });

  it("settles and removes a durable started container during recovery", async () => {
    const events: string[] = [];
    const lifecycle = new PrimeOciContainerLifecycle(fakeEngine(events));
    const intent = intentLease();
    const started: EvaluationOciLease = {
      ...intent,
      state: "started",
      containerId: "f".repeat(64),
      inspectedPolicyDigest: intent.policyDigest,
    };

    const recovered = await lifecycle.recover({
      lease: started,
      update: async (lease) => {
        events.push(`update:${lease.state}`);
      },
    });

    expect(recovered.state).toBe("removed");
    expect(events).toEqual([
      "stop",
      "update:stopped",
      "remove",
      "confirm-removed",
      "update:removed",
    ]);
  });
});

function fakeEngine(
  events: string[],
  options: {
    readonly createResponseLost?: boolean;
    readonly recoveredIntentMissing?: boolean;
    readonly removalConfirmed?: boolean;
  } = {},
): PrimeOciEngine {
  const created = {
    containerId: "f".repeat(64),
    inspectedPolicyDigest: "c".repeat(64),
  };
  return {
    create: async () => {
      events.push("create");
      if (options.createResponseLost === true) {
        throw new Error("create response lost");
      }
      return created;
    },
    recoverIntent: async () => {
      events.push("recover-intent");
      return options.recoveredIntentMissing === true ? null : created;
    },
    attach: async () => {
      events.push("attach");
      return attachedTransport;
    },
    start: async () => {
      events.push("start");
    },
    stop: async () => {
      events.push("stop");
    },
    remove: async () => {
      events.push("remove");
    },
    confirmRemoved: async () => {
      events.push("confirm-removed");
      return options.removalConfirmed ?? true;
    },
  };
}

const attachedTransport = {
  output: (async function* () {})(),
  write: async () => undefined,
  closeInput: async () => undefined,
  release: async () => undefined,
};

function intentLease(): PrimeOciIntentLease {
  const ownerNonce = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}` as const;
  const policyDigest = "c".repeat(64);
  return {
    version: 1,
    adapter: "prime-agent-native-v1",
    state: "intent",
    ownerNonce,
    containerName: `flow-prime-${"d".repeat(32)}`,
    labels: {
      evaluationId: "evaluation-run",
      trialId: `trial-${"e".repeat(48)}`,
      ownerNonce,
      imageId,
      policyDigest,
    },
    imageId,
    policyDigest,
    fixtureDigest: "f".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock",
      device: 1,
      inode: 2,
      uid: 0,
      gid: 999,
      mode: 0o660,
    },
  };
}
