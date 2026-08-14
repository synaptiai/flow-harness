import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalPrimeGlobalSlotStore } from "../../../../src/infrastructure/oci/local-prime-global-slot-store.js";
import type { PrimeGlobalSlotLease } from "../../../../src/infrastructure/oci/prime-global-admission.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local Prime global slot store", () => {
  it("durably changes intent to owned and removes the exact lease", async () => {
    const fixture = await storeFixture();
    const intent = intentLease();
    const owned: PrimeGlobalSlotLease = {
      ...intent,
      state: "owned",
      objectId: "d".repeat(64),
    };

    await fixture.store.writeIntent(intent);
    expect((await stat(fixture.leasePath)).mode & 0o777).toBe(0o660);
    await expect(fixture.store.read()).resolves.toEqual(intent);
    await fixture.store.writeOwned(owned);
    await expect(fixture.store.read()).resolves.toEqual(owned);
    await fixture.store.remove(owned);
    await expect(fixture.store.read()).resolves.toBeNull();
  });

  it("rejects a second intent and a mismatched removal", async () => {
    const fixture = await storeFixture();
    const intent = intentLease();
    await fixture.store.writeIntent(intent);

    await expect(fixture.store.writeIntent(intentLease("c"))).rejects.toThrow(/exists|owner/i);
    await expect(fixture.store.remove({ ...intent, ownerNonce: "e".repeat(64) })).rejects.toThrow(
      /changed|match/i,
    );
    await expect(fixture.store.read()).resolves.toEqual(intent);
  });

  it("rejects malformed final state and removes an unpublished intent temporary", async () => {
    const fixture = await storeFixture();
    await writeFile(fixture.leasePath, '{"partial":');
    await expect(fixture.store.read()).rejects.toThrow(/strict JSON|schema/i);

    await rm(fixture.leasePath);
    const intent = intentLease();
    await writeFile(
      `${fixture.leasePath}.intent.${intent.ownerNonce}.tmp`,
      `${JSON.stringify(intent)}\n`,
    );
    await expect(fixture.store.read()).resolves.toBeNull();
    await expect(fixture.store.writeIntent(intent)).resolves.toBeUndefined();
  });
});

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-global-slot-"));
  temporaryDirectories.push(root);
  const leasePath = join(root, "global-slot.json");
  return { leasePath, store: new LocalPrimeGlobalSlotStore({ leasePath }) };
}

function intentLease(nonce = "a"): PrimeGlobalSlotLease {
  return {
    version: 1,
    state: "intent",
    lockName: "flow-prime-global-v1",
    ownerNonce: nonce.repeat(64),
    policyDigest: "b".repeat(64),
    daemonId: "daemon-test-id",
  };
}
