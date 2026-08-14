import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateContainerCommandConfigurationDigest,
  parseContainerCommandIntent,
} from "../../../../src/infrastructure/oci/container-command-intent.js";
import { LocalContainerCommandIntentStore } from "../../../../src/infrastructure/oci/local-container-command-intent-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalContainerCommandIntentStore", () => {
  it("publishes intent, replaces it with owned identity, and removes it durably", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-intent-store-"));
    roots.push(root);
    const directory = join(root, "leases");
    const store = new LocalContainerCommandIntentStore({ directory });
    const intent = durableIntent();

    await store.initialize();
    await store.writeIntent(intent);

    expect(await store.readAll()).toEqual([intent]);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, `${intent.ownerNonce}.json`))).mode & 0o777).toBe(0o600);

    const owned = parseContainerCommandIntent({
      ...intent,
      state: "owned",
      containerId: "c".repeat(64),
    });
    await store.writeOwned(owned);
    expect(await store.readAll()).toEqual([owned]);

    await store.remove(owned.ownerNonce);
    expect(await store.readAll()).toEqual([]);
  });

  it("does not replace an existing intent with a different owner record", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-intent-store-"));
    roots.push(root);
    const store = new LocalContainerCommandIntentStore({ directory: join(root, "leases") });
    const intent = durableIntent();
    await store.initialize();
    await store.writeIntent(intent);

    await expect(
      store.writeIntent(
        parseContainerCommandIntent({
          ...intent,
          containerName: `flow-command-${"e".repeat(32)}`,
        }),
      ),
    ).rejects.toThrow("container command intent already exists");
    expect(await store.readAll()).toEqual([intent]);
  });

  it("claims only orphaned intents and keeps an active recovery claim exclusive", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-intent-store-"));
    roots.push(root);
    const store = new LocalContainerCommandIntentStore({ directory: join(root, "leases") });
    const live = durableIntent({ ownerNonce: "a".repeat(64), pid: 1234 });
    const orphan = durableIntent({
      ownerNonce: "b".repeat(64),
      nameNonce: "c".repeat(32),
      pid: 5678,
    });
    const recoveryOwner = {
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: 9999,
      startTicks: "111111",
    };
    const alivePids = new Set([1234, 9999]);
    const isOwnerAlive = async (owner: { readonly pid: number }) => alivePids.has(owner.pid);
    await store.initialize();
    await store.writeIntent(live);
    await store.writeIntent(orphan);

    const claims = await store.claimOrphans(recoveryOwner, isOwnerAlive);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.intent).toEqual(orphan);
    expect(await store.claimOrphans(recoveryOwner, isOwnerAlive)).toEqual([]);

    await claims[0]?.release();
    const reclaimed = await store.claimOrphans(recoveryOwner, isOwnerAlive);
    expect(reclaimed).toHaveLength(1);
    await reclaimed[0]?.complete();
    expect(await store.readAll()).toEqual([live]);
  });
});

function durableIntent(
  options: {
    readonly ownerNonce?: string;
    readonly nameNonce?: string;
    readonly pid?: number;
  } = {},
) {
  const configuration = {
    Image: `sha256:${"d".repeat(64)}`,
    Entrypoint: ["node"],
    Cmd: ["-e", "console.log('PRIVATE_COMMAND')"],
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
  };
  return parseContainerCommandIntent({
    version: 1,
    state: "intent",
    ownerNonce: options.ownerNonce ?? "a".repeat(64),
    containerName: `flow-command-${options.nameNonce ?? "b".repeat(32)}`,
    owner: {
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: options.pid ?? 1234,
      startTicks: "987654",
    },
    runtime: {
      engineVersion: "28.3.3",
      apiVersion: "1.51",
      socketPath: "/var/run/docker.sock",
      imageId: `sha256:${"d".repeat(64)}`,
      runtimeName: "flow-prime-runc",
      policyDigest: "f".repeat(64),
    },
    privateDirectory: "/private/flow-container-command-a",
    configuration,
    configurationDigest: calculateContainerCommandConfigurationDigest(configuration),
  });
}
