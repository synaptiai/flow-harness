import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  refreshStagedTufRepository,
  StagedTufRepositoryError,
  validateStagedTufTrustedRoot,
} from "../../../../src/infrastructure/tuf/staged-tuf-repository.js";

const EXPIRY = "2030-01-01T00:00:00.000Z";
const METADATA_BASE = "https://updates.example.test/metadata/";
const TARGET_BASE = "https://updates.example.test/targets/";
const INDEX_PATH = "flow/capability-index.json";
const PACKAGE_PATH = "flow/packages/review-suite/1.0.0.flowpkg.json";

describe("staged TUF repository", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map(async (path) => await rm(path, { recursive: true, force: true })),
    );
  });

  it("refreshes real signed metadata and downloads consistent-snapshot targets", async () => {
    const fixture = createRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const requested: string[] = [];
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url, maximumBytes, signal) => {
        signal.throwIfAborted();
        requested.push(url);
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : {
              statusCode: 200,
              bytes:
                content.byteLength <= maximumBytes
                  ? Buffer.from(content)
                  : Buffer.alloc(maximumBytes + 1),
            };
      },
    });

    const index = await session.readTarget(INDEX_PATH);
    const capabilityPackage = await session.readTarget(PACKAGE_PATH);
    const completed = await session.complete();

    expect(index).toMatchObject({
      path: INDEX_PATH,
      source: `${TARGET_BASE}flow/${sha256(fixture.index)}.capability-index.json`,
      length: fixture.index.byteLength,
      hashes: { sha256: sha256(fixture.index) },
    });
    expect(index.bytes()).toEqual(fixture.index);
    expect(capabilityPackage).toMatchObject({
      path: PACKAGE_PATH,
      source: `${TARGET_BASE}flow/packages/review-suite/${sha256(fixture.capabilityPackage)}.1.0.0.flowpkg.json`,
      length: fixture.capabilityPackage.byteLength,
      custom: targetCustom(),
    });
    expect(capabilityPackage.bytes()).toEqual(fixture.capabilityPackage);
    expect(completed.metadata.map((entry) => entry.name)).toEqual([
      "root.json",
      "snapshot.json",
      "targets.json",
      "timestamp.json",
    ]);
    expect(completed.metadata.every((entry) => entry.bytes().byteLength > 0)).toBe(true);
    expect(requested).toContain(`${METADATA_BASE}2.root.json`);
    expect(requested).toContain(`${METADATA_BASE}timestamp.json`);
    expect(requested).toContain(`${METADATA_BASE}1.snapshot.json`);
    expect(requested).toContain(`${METADATA_BASE}1.targets.json`);
  });

  it("validates and reopens one explicit self-signed root without network access", async () => {
    const fixture = createRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    const root = await validateStagedTufTrustedRoot({
      stagingDirectory,
      trustedRoot: fixture.root,
    });

    expect(root).toMatchObject({
      name: "root.json",
      length: fixture.root.byteLength,
      digest: `sha256:${sha256(fixture.root)}`,
    });
    expect(root.bytes()).toEqual(fixture.root);
  });

  it("rejects a correctly signed explicit root that is already expired", async () => {
    const fixture = createRepositoryFixture({ expiry: "2020-01-01T00:00:00.000Z" });
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      validateStagedTufTrustedRoot({
        stagingDirectory,
        trustedRoot: fixture.root,
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("validate trusted root"));
  });

  it("rejects a correctly signed root that disables consistent snapshots", async () => {
    const fixture = createRepositoryFixture({ consistentSnapshot: false });
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      validateStagedTufTrustedRoot({
        stagingDirectory,
        trustedRoot: fixture.root,
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("validate trusted root"));
  });

  it("retains every sequential root rotation for offline replay", async () => {
    const fixture = createRotatedRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url) => {
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : { statusCode: 200, bytes: Buffer.from(content) };
      },
    });

    const completed = await session.complete();
    const rotatedRoot = completed.metadata.find(({ name }) => name === "2.root.json");
    const finalRoot = completed.metadata.find(({ name }) => name === "3.root.json");
    const activeRoot = completed.metadata.find(({ name }) => name === "root.json");

    expect(rotatedRoot?.bytes()).toEqual(fixture.rotatedRoot);
    expect(finalRoot?.bytes()).toEqual(fixture.finalRoot);
    expect(activeRoot?.bytes()).toEqual(fixture.finalRoot);
  });

  it("rejects a valid root rotation that disables consistent snapshots", async () => {
    const fixture = createRotatedRepositoryFixture({ finalConsistentSnapshot: false });
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const remote = new Map(fixture.remote);
    remote.set(`${METADATA_BASE}snapshot.json`, fixture.snapshot);
    remote.set(`${METADATA_BASE}targets.json`, fixture.targets);

    await expect(
      refreshStagedTufRepository({
        stagingDirectory,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata: { "root.json": fixture.root },
        read: fixtureReader(remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it.each([
    "insufficient old threshold",
    "insufficient new threshold",
    "skipped version",
    "rolled-back version",
    "expired rotation",
    "missing transition",
  ] as const)("rejects a root transition with %s", async (failure) => {
    const fixture = createRootTransitionFailureFixture(failure);
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      refreshStagedTufRepository({
        stagingDirectory,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata: { "root.json": fixture.root },
        read: fixtureReader(fixture.remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it.each(["timestamp", "snapshot", "targets"] as const)(
    "rejects correctly signed expired %s metadata",
    async (roleName) => {
      const fixture = createRepositoryFixture({
        expiries: { [roleName]: "2020-01-01T00:00:00.000Z" },
      });
      const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

      await expect(
        refreshStagedTufRepository({
          stagingDirectory,
          metadataBaseUrl: METADATA_BASE,
          targetBaseUrl: TARGET_BASE,
          trustedMetadata: { "root.json": fixture.root },
          read: fixtureReader(fixture.remote),
        }),
      ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
    },
  );

  it("rejects a frozen timestamp after its signed expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    const key = createSigningKey();
    const fixture = createRepositoryFixture({
      key,
      expiry: "2035-01-01T00:00:00.000Z",
      expiries: { timestamp: "2027-01-02T00:00:00.000Z" },
    });
    const firstStaging = await makeTemporaryRoot(temporaryRoots);
    const first = await refreshStagedTufRepository({
      stagingDirectory: firstStaging,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: fixtureReader(fixture.remote),
    });
    const completed = await first.complete();
    const trustedMetadata = Object.fromEntries(
      completed.metadata.map((metadata) => [metadata.name, metadata.bytes()]),
    );

    vi.setSystemTime(new Date("2027-01-03T00:00:00.000Z"));
    const secondStaging = await makeTemporaryRoot(temporaryRoots);
    await expect(
      refreshStagedTufRepository({
        stagingDirectory: secondStaging,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata,
        read: fixtureReader(fixture.remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it("rejects a signed metadata rollback against the durable high-water versions", async () => {
    const key = createSigningKey();
    const current = createRepositoryFixture({
      key,
      versions: { timestamp: 2, snapshot: 2, targets: 2 },
    });
    const rolledBack = createRepositoryFixture({ key });
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      refreshStagedTufRepository({
        stagingDirectory,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata: {
          "root.json": current.root,
          "timestamp.json": current.timestamp,
          "snapshot.json": current.snapshot,
          "targets.json": current.targets,
        },
        read: fixtureReader(rolledBack.remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it("rejects a signed snapshot substituted behind a different timestamp descriptor", async () => {
    const key = createSigningKey();
    const expected = createRepositoryFixture({ key, index: Buffer.from("EXPECTED_INDEX") });
    const substituted = createRepositoryFixture({
      key,
      index: Buffer.from("SUBSTITUTED_INDEX"),
    });
    const remote = new Map(expected.remote);
    remote.set(`${METADATA_BASE}1.snapshot.json`, substituted.snapshot);
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      refreshStagedTufRepository({
        stagingDirectory,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata: { "root.json": expected.root },
        read: fixtureReader(remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it("enforces a delegated role signature threshold", async () => {
    const fixture = createDelegationFixture("insufficient threshold");
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: fixtureReader(fixture.remote),
    });

    await expect(session.readTarget(fixture.targetPath)).rejects.toEqual(
      new StagedTufRepositoryError("resolve target"),
    );
  });

  it("honors a terminating delegated role before a later matching role", async () => {
    const fixture = createDelegationFixture("terminating");
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const requested: string[] = [];
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url) => {
        requested.push(url);
        return fixtureReader(fixture.remote)(url);
      },
    });

    await expect(session.readTarget(fixture.targetPath)).rejects.toEqual(
      new StagedTufRepositoryError("resolve target"),
    );
    expect(requested).toContain(`${METADATA_BASE}1.terminating-role.json`);
    expect(requested).not.toContain(`${METADATA_BASE}1.later-role.json`);
  });

  it("rejects duplicate delegated role names before resolving target authority", async () => {
    const fixture = createDelegationFixture("duplicate names");
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);

    await expect(
      refreshStagedTufRepository({
        stagingDirectory,
        metadataBaseUrl: METADATA_BASE,
        targetBaseUrl: TARGET_BASE,
        trustedMetadata: { "root.json": fixture.root },
        read: fixtureReader(fixture.remote),
      }),
    ).rejects.toEqual(new StagedTufRepositoryError("refresh metadata"));
  });

  it.each([
    ["a delegation cycle", "cycle"],
    ["excessive delegation depth", "depth"],
    ["excessive matching roles", "roles"],
  ] as const)("bounds %s", async (_label, scenario) => {
    const fixture = createDelegationFixture(scenario);
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const requested: string[] = [];
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url) => {
        requested.push(url);
        return fixtureReader(fixture.remote)(url);
      },
    });

    await expect(session.readTarget(fixture.targetPath)).rejects.toEqual(
      new StagedTufRepositoryError("resolve target"),
    );
    expect(requested.length).toBeLessThanOrEqual(36);
  });

  it.each([
    [
      "bad self signature",
      (root: Buffer) => {
        const parsed = JSON.parse(root.toString("utf8")) as {
          signatures: { sig: string }[];
        };
        const first = parsed.signatures[0];
        if (first === undefined) {
          throw new Error("fixture requires a root signature");
        }
        first.sig = "00".repeat(64);
        return Buffer.from(JSON.stringify(parsed));
      },
    ],
    [
      "duplicate top-level key",
      (root: Buffer) => Buffer.from(`{"signed":{},${root.toString("utf8").slice(1)}`),
    ],
    ["fatal UTF-8", () => Buffer.from([0xc3, 0x28])],
  ])("rejects an explicit root with %s using one fixed stage", async (_label, mutate) => {
    const fixture = createRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    let caught: unknown;
    try {
      await validateStagedTufTrustedRoot({
        stagingDirectory,
        trustedRoot: mutate(fixture.root),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new StagedTufRepositoryError("validate trusted root"));
    expect(caught).not.toHaveProperty("cause");
  });

  it("returns one fixed value-free stage when a verified target is absent", async () => {
    const fixture = createRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url) => {
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : { statusCode: 200, bytes: Buffer.from(content) };
      },
    });

    let caught: unknown;
    try {
      await session.readTarget("flow/packages/PRIVATE_MISSING/1.0.0.flowpkg.json");
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new StagedTufRepositoryError("resolve target"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });

  it("rejects a staged target replaced by a symbolic link before Flow reopens it", async () => {
    const fixture = createRepositoryFixture();
    const stagingDirectory = await makeTemporaryRoot(temporaryRoots);
    const external = join(stagingDirectory, "PRIVATE_EXTERNAL_TARGET");
    await writeFile(external, fixture.capabilityPackage);
    const session = await refreshStagedTufRepository({
      stagingDirectory,
      metadataBaseUrl: METADATA_BASE,
      targetBaseUrl: TARGET_BASE,
      trustedMetadata: { "root.json": fixture.root },
      read: async (url) => {
        const content = fixture.remote.get(url);
        return content === undefined
          ? { statusCode: 404, bytes: Buffer.alloc(0) }
          : { statusCode: 200, bytes: Buffer.from(content) };
      },
      hooks: {
        afterTargetDownloaded: async (path: string) => {
          await unlink(path);
          await symlink(external, path);
        },
      },
    });

    await expect(session.readTarget(PACKAGE_PATH)).rejects.toEqual(
      new StagedTufRepositoryError("download target"),
    );
    await expect(
      writeFile(external, fixture.capabilityPackage, { flag: "wx" }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});

interface RepositoryFixture {
  readonly root: Buffer;
  readonly targets: Buffer;
  readonly snapshot: Buffer;
  readonly timestamp: Buffer;
  readonly index: Buffer;
  readonly capabilityPackage: Buffer;
  readonly remote: ReadonlyMap<string, Buffer>;
}

interface RepositoryFixtureOptions {
  readonly key?: ReturnType<typeof createSigningKey>;
  readonly expiry?: string;
  readonly expiries?: Partial<Record<"timestamp" | "snapshot" | "targets", string>>;
  readonly versions?: Partial<Record<"timestamp" | "snapshot" | "targets", number>>;
  readonly index?: Buffer;
  readonly consistentSnapshot?: boolean;
}

function createRepositoryFixture(input: RepositoryFixtureOptions = {}): RepositoryFixture {
  const key = input.key ?? createSigningKey();
  const expiry = input.expiry ?? EXPIRY;
  const index = input.index ?? Buffer.from("PRIVATE_INDEX_BYTES");
  const capabilityPackage = Buffer.from("PRIVATE_SIGNED_PACKAGE_ENVELOPE");
  const targetsVersion = input.versions?.targets ?? 1;
  const snapshotVersion = input.versions?.snapshot ?? 1;
  const timestampVersion = input.versions?.timestamp ?? 1;
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: targetsVersion,
      expires: input.expiries?.targets ?? expiry,
      keys: { [key.id]: key.publicMetadata },
      roles: {
        root: role(key.id),
        timestamp: role(key.id),
        snapshot: role(key.id),
        targets: role(key.id),
      },
      consistent_snapshot: input.consistentSnapshot ?? true,
    },
    key,
  );
  const targets = signedMetadata(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires: expiry,
      targets: {
        [INDEX_PATH]: targetDescriptor(index, {
          flow: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            kind: "CapabilityRepositoryIndexTarget",
          },
        }),
        [PACKAGE_PATH]: targetDescriptor(capabilityPackage, targetCustom()),
      },
    },
    key,
  );
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: snapshotVersion,
      expires: input.expiries?.snapshot ?? expiry,
      meta: { "targets.json": metadataDescriptor(targetsVersion, targets) },
    },
    key,
  );
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: timestampVersion,
      expires: input.expiries?.timestamp ?? expiry,
      meta: { "snapshot.json": metadataDescriptor(snapshotVersion, snapshot) },
    },
    key,
  );
  const remote = new Map<string, Buffer>([
    [`${METADATA_BASE}timestamp.json`, timestamp],
    [`${METADATA_BASE}${snapshotVersion}.snapshot.json`, snapshot],
    [`${METADATA_BASE}${targetsVersion}.targets.json`, targets],
    [consistentTargetUrl(INDEX_PATH, index), index],
    [consistentTargetUrl(PACKAGE_PATH, capabilityPackage), capabilityPackage],
  ]);
  return { root, targets, snapshot, timestamp, index, capabilityPackage, remote };
}

function createRotatedRepositoryFixture(
  input: { readonly finalConsistentSnapshot?: boolean } = {},
): RepositoryFixture & {
  readonly rotatedRoot: Buffer;
  readonly finalRoot: Buffer;
} {
  const oldKey = createSigningKey();
  const middleKey = createSigningKey();
  const finalKey = createSigningKey();
  const index = Buffer.from("PRIVATE_ROTATED_INDEX_BYTES");
  const capabilityPackage = Buffer.from("PRIVATE_ROTATED_PACKAGE_ENVELOPE");
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      keys: { [oldKey.id]: oldKey.publicMetadata },
      roles: {
        root: role(oldKey.id),
        timestamp: role(oldKey.id),
        snapshot: role(oldKey.id),
        targets: role(oldKey.id),
      },
      consistent_snapshot: true,
    },
    oldKey,
  );
  const rotatedRoot = signedMetadataWithKeys(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 2,
      expires: EXPIRY,
      keys: { [middleKey.id]: middleKey.publicMetadata },
      roles: {
        root: role(middleKey.id),
        timestamp: role(middleKey.id),
        snapshot: role(middleKey.id),
        targets: role(middleKey.id),
      },
      consistent_snapshot: true,
    },
    [oldKey, middleKey],
  );
  const finalRoot = signedMetadataWithKeys(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 3,
      expires: EXPIRY,
      keys: { [finalKey.id]: finalKey.publicMetadata },
      roles: {
        root: role(finalKey.id),
        timestamp: role(finalKey.id),
        snapshot: role(finalKey.id),
        targets: role(finalKey.id),
      },
      consistent_snapshot: input.finalConsistentSnapshot ?? true,
    },
    [middleKey, finalKey],
  );
  const targets = signedMetadata(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      targets: {
        [INDEX_PATH]: targetDescriptor(index, {}),
        [PACKAGE_PATH]: targetDescriptor(capabilityPackage, targetCustom()),
      },
    },
    finalKey,
  );
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      meta: { "targets.json": metadataDescriptor(1, targets) },
    },
    finalKey,
  );
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      meta: { "snapshot.json": metadataDescriptor(1, snapshot) },
    },
    finalKey,
  );
  return {
    root,
    rotatedRoot,
    finalRoot,
    targets,
    snapshot,
    timestamp,
    index,
    capabilityPackage,
    remote: new Map([
      [`${METADATA_BASE}2.root.json`, rotatedRoot],
      [`${METADATA_BASE}3.root.json`, finalRoot],
      [`${METADATA_BASE}timestamp.json`, timestamp],
      [`${METADATA_BASE}1.snapshot.json`, snapshot],
      [`${METADATA_BASE}1.targets.json`, targets],
      [consistentTargetUrl(INDEX_PATH, index), index],
      [consistentTargetUrl(PACKAGE_PATH, capabilityPackage), capabilityPackage],
    ]),
  };
}

type RootTransitionFailure =
  | "insufficient old threshold"
  | "insufficient new threshold"
  | "skipped version"
  | "rolled-back version"
  | "expired rotation"
  | "missing transition";

function createRootTransitionFailureFixture(
  failure: RootTransitionFailure,
): Pick<RepositoryFixture, "root" | "remote"> {
  const oldKeys = [createSigningKey(), createSigningKey()] as const;
  const newKeys = [createSigningKey(), createSigningKey()] as const;
  const root = signedMetadataWithKeys(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      keys: Object.fromEntries(oldKeys.map((key) => [key.id, key.publicMetadata])),
      roles: {
        root: { keyids: oldKeys.map((key) => key.id), threshold: 2 },
        timestamp: role(oldKeys[0].id),
        snapshot: role(oldKeys[0].id),
        targets: role(oldKeys[0].id),
      },
      consistent_snapshot: true,
    },
    oldKeys,
  );
  const version = failure === "skipped version" ? 3 : failure === "rolled-back version" ? 1 : 2;
  const expires = failure === "expired rotation" ? "2020-01-01T00:00:00.000Z" : EXPIRY;
  const signers =
    failure === "insufficient old threshold"
      ? [oldKeys[0], ...newKeys]
      : failure === "insufficient new threshold"
        ? [...oldKeys, newKeys[0]]
        : [...oldKeys, ...newKeys];
  const rotatedRoot = signedMetadataWithKeys(
    {
      _type: "root",
      spec_version: "1.0.31",
      version,
      expires,
      keys: Object.fromEntries(newKeys.map((key) => [key.id, key.publicMetadata])),
      roles: {
        root: { keyids: newKeys.map((key) => key.id), threshold: 2 },
        timestamp: role(newKeys[0].id),
        snapshot: role(newKeys[0].id),
        targets: role(newKeys[0].id),
      },
      consistent_snapshot: true,
    },
    signers,
  );
  const metadata = createRepositoryFixture({ key: newKeys[0] });
  const remote = new Map(metadata.remote);
  if (failure !== "missing transition") {
    remote.set(`${METADATA_BASE}2.root.json`, rotatedRoot);
  }
  return { root, remote };
}

type DelegationScenario =
  | "insufficient threshold"
  | "terminating"
  | "duplicate names"
  | "cycle"
  | "depth"
  | "roles";

interface DelegationFixture {
  readonly root: Buffer;
  readonly targetPath: string;
  readonly remote: ReadonlyMap<string, Buffer>;
}

interface DelegationRoleDefinition {
  readonly name: string;
  readonly keyids: readonly string[];
  readonly threshold: number;
  readonly terminating: boolean;
  readonly paths: readonly string[];
}

interface DelegationDocumentDefinition {
  readonly name: string;
  readonly targets: Readonly<Record<string, Record<string, unknown>>>;
  readonly roles: readonly DelegationRoleDefinition[];
  readonly signers: readonly ReturnType<typeof createSigningKey>[];
}

function createDelegationFixture(scenario: DelegationScenario): DelegationFixture {
  const rootKey = createSigningKey();
  const delegationKeys = [createSigningKey(), createSigningKey()] as const;
  const targetPath = "delegated/artifact";
  const targetBytes = Buffer.from("PRIVATE_DELEGATED_ARTIFACT");
  let topRoles: DelegationRoleDefinition[];
  let documents: DelegationDocumentDefinition[];

  if (scenario === "insufficient threshold") {
    topRoles = [
      delegatedRole(
        "threshold-role",
        delegationKeys.map(({ id }) => id),
        {
          threshold: 2,
        },
      ),
    ];
    documents = [
      delegatedDocument("threshold-role", delegationKeys.slice(0, 1), {
        [targetPath]: targetDescriptor(targetBytes, {}),
      }),
    ];
  } else if (scenario === "terminating") {
    topRoles = [
      delegatedRole("terminating-role", [delegationKeys[0].id], { terminating: true }),
      delegatedRole("later-role", [delegationKeys[0].id]),
    ];
    documents = [
      delegatedDocument("terminating-role", [delegationKeys[0]], {}),
      delegatedDocument("later-role", [delegationKeys[0]], {
        [targetPath]: targetDescriptor(targetBytes, {}),
      }),
    ];
  } else if (scenario === "duplicate names") {
    topRoles = [
      delegatedRole("duplicate-role", [delegationKeys[0].id]),
      delegatedRole("duplicate-role", [delegationKeys[1].id]),
    ];
    documents = [
      delegatedDocument("duplicate-role", [delegationKeys[1]], {
        [targetPath]: targetDescriptor(targetBytes, {}),
      }),
    ];
  } else if (scenario === "cycle") {
    topRoles = [delegatedRole("cycle-a", [delegationKeys[0].id])];
    documents = [
      delegatedDocument("cycle-a", [delegationKeys[0]], {}, [
        delegatedRole("cycle-b", [delegationKeys[0].id]),
      ]),
      delegatedDocument("cycle-b", [delegationKeys[0]], {}, [
        delegatedRole("cycle-a", [delegationKeys[0].id]),
      ]),
    ];
  } else if (scenario === "depth") {
    const names = Array.from({ length: 33 }, (_, index) => `depth-${index + 1}`);
    topRoles = [delegatedRole(names[0] as string, [delegationKeys[0].id])];
    documents = names.map((name, index) =>
      delegatedDocument(
        name,
        [delegationKeys[0]],
        index === names.length - 1 ? { [targetPath]: targetDescriptor(targetBytes, {}) } : {},
        index === names.length - 1
          ? []
          : [delegatedRole(names[index + 1] as string, [delegationKeys[0].id])],
      ),
    );
  } else {
    const names = Array.from({ length: 33 }, (_, index) => `wide-${index + 1}`);
    topRoles = names.map((name) => delegatedRole(name, [delegationKeys[0].id]));
    documents = names.map((name, index) =>
      delegatedDocument(
        name,
        [delegationKeys[0]],
        index === names.length - 1 ? { [targetPath]: targetDescriptor(targetBytes, {}) } : {},
      ),
    );
  }

  const delegationKeyMetadata = Object.fromEntries(
    delegationKeys.map((key) => [key.id, key.publicMetadata]),
  );
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      keys: { [rootKey.id]: rootKey.publicMetadata },
      roles: {
        root: role(rootKey.id),
        timestamp: role(rootKey.id),
        snapshot: role(rootKey.id),
        targets: role(rootKey.id),
      },
      consistent_snapshot: true,
    },
    rootKey,
  );
  const targetsBody = {
    _type: "targets",
    spec_version: "1.0.31",
    version: 1,
    expires: EXPIRY,
    targets: {},
    delegations: {
      keys: delegationKeyMetadata,
      roles: topRoles,
    },
  };
  const targets =
    scenario === "duplicate names"
      ? signedMetadataWithCanonicalBody(
          targetsBody,
          {
            ...targetsBody,
            delegations: { ...targetsBody.delegations, roles: topRoles.slice(-1) },
          },
          rootKey,
        )
      : signedMetadata(targetsBody, rootKey);
  const delegatedMetadata = new Map(
    documents.map((document) => {
      const signed = signedMetadataWithKeys(
        {
          _type: "targets",
          spec_version: "1.0.31",
          version: 1,
          expires: EXPIRY,
          targets: document.targets,
          ...(document.roles.length === 0
            ? {}
            : {
                delegations: {
                  keys: delegationKeyMetadata,
                  roles: document.roles,
                },
              }),
        },
        document.signers,
      );
      return [document.name, signed] as const;
    }),
  );
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      meta: {
        "targets.json": metadataDescriptor(1, targets),
        ...Object.fromEntries(
          [...delegatedMetadata].map(([name, metadata]) => [
            `${name}.json`,
            metadataDescriptor(1, metadata),
          ]),
        ),
      },
    },
    rootKey,
  );
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires: EXPIRY,
      meta: { "snapshot.json": metadataDescriptor(1, snapshot) },
    },
    rootKey,
  );
  return {
    root,
    targetPath,
    remote: new Map([
      [`${METADATA_BASE}timestamp.json`, timestamp],
      [`${METADATA_BASE}1.snapshot.json`, snapshot],
      [`${METADATA_BASE}1.targets.json`, targets],
      ...[...delegatedMetadata].map(
        ([name, metadata]) => [`${METADATA_BASE}1.${name}.json`, metadata] as const,
      ),
      [consistentTargetUrl(targetPath, targetBytes), targetBytes],
    ]),
  };
}

function delegatedRole(
  name: string,
  keyids: readonly string[],
  input: { readonly threshold?: number; readonly terminating?: boolean } = {},
): DelegationRoleDefinition {
  return {
    name,
    keyids,
    threshold: input.threshold ?? 1,
    terminating: input.terminating ?? false,
    paths: ["delegated/*"],
  };
}

function delegatedDocument(
  name: string,
  signers: readonly ReturnType<typeof createSigningKey>[],
  targets: Readonly<Record<string, Record<string, unknown>>>,
  roles: readonly DelegationRoleDefinition[] = [],
): DelegationDocumentDefinition {
  return { name, targets, roles, signers };
}

function targetCustom(): Record<string, unknown> {
  return {
    flow: {
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityPackageTarget",
      name: "review-suite",
      version: "1.0.0",
      publisher: {
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity:
          "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
      },
    },
  };
}

function targetDescriptor(
  content: Buffer,
  custom: Record<string, unknown>,
): Record<string, unknown> {
  return {
    length: content.byteLength,
    hashes: { sha256: sha256(content) },
    custom,
  };
}

function metadataDescriptor(version: number, content: Buffer): Record<string, unknown> {
  return {
    version,
    length: content.byteLength,
    hashes: { sha256: sha256(content) },
  };
}

function consistentTargetUrl(path: string, content: Buffer): string {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `${TARGET_BASE}${directory}${sha256(content)}.${name}`;
}

function role(keyID: string): Record<string, unknown> {
  return { keyids: [keyID], threshold: 1 };
}

function createSigningKey(): {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicMetadata: Record<string, unknown>;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const publicMetadata = {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: { public: publicDer.subarray(publicDer.byteLength - 32).toString("hex") },
  };
  return {
    id: sha256(Buffer.from(canonicalJson(publicMetadata))),
    privateKey,
    publicMetadata,
  };
}

function signedMetadata(
  signed: Record<string, unknown>,
  key: ReturnType<typeof createSigningKey>,
): Buffer {
  const signature = sign(null, Buffer.from(canonicalJson(signed)), key.privateKey).toString("hex");
  return Buffer.from(JSON.stringify({ signatures: [{ keyid: key.id, sig: signature }], signed }));
}

function signedMetadataWithCanonicalBody(
  transmitted: Record<string, unknown>,
  canonical: Record<string, unknown>,
  key: ReturnType<typeof createSigningKey>,
): Buffer {
  const signature = sign(null, Buffer.from(canonicalJson(canonical)), key.privateKey).toString(
    "hex",
  );
  return Buffer.from(
    JSON.stringify({ signatures: [{ keyid: key.id, sig: signature }], signed: transmitted }),
  );
}

function signedMetadataWithKeys(
  signed: Record<string, unknown>,
  keys: readonly ReturnType<typeof createSigningKey>[],
): Buffer {
  const payload = Buffer.from(canonicalJson(signed));
  return Buffer.from(
    JSON.stringify({
      signatures: keys.map((key) => ({
        keyid: key.id,
        sig: sign(null, payload, key.privateKey).toString("hex"),
      })),
      signed,
    }),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function makeTemporaryRoot(paths: string[]): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "flow-staged-tuf-"));
  paths.push(path);
  return path;
}

function fixtureReader(
  remote: ReadonlyMap<string, Buffer>,
): (url: string) => Promise<{ readonly statusCode: number; readonly bytes: Buffer }> {
  return async (url) => {
    const content = remote.get(url);
    return content === undefined
      ? { statusCode: 404, bytes: Buffer.alloc(0) }
      : { statusCode: 200, bytes: Buffer.from(content) };
  };
}
