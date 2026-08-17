import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type CapabilityRepositoryCandidate,
  createCapabilityRepositoryCandidate,
} from "../../../../src/application/capability-repository-candidate.js";
import type {
  AuthenticateCapabilityRepositoryGenerationInput,
  CapabilityRepositoryStoredFile,
  CapabilityRepositoryStoredIndex,
} from "../../../../src/application/capability-repository-store.js";
import { createCapabilityBundleSource } from "../../../../src/domain/capability/capability-bundles.js";
import {
  encodeCapabilityRepositoryIndex,
  parseCapabilityRepositoryIndex,
} from "../../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../../src/domain/capability/signed-capability-bundle-envelope.js";
import { LocalCapabilityRepositoryStore } from "../../../../src/infrastructure/fs/local-capability-repository-store.js";
import {
  CapabilityRepositoryGenerationAuthenticationError,
  createCapabilityRepositoryGenerationAuthenticator,
} from "../../../../src/infrastructure/tuf/capability-repository-generation-authenticator.js";

const expiry = "2030-01-01T00:00:00.000Z";
const repositoryBaseUrl = "https://updates.example.test/repository/";
const indexPath = "flow/capability-index.json";
const packagePath = "flow/packages/review-suite/1.0.0.flowpkg.json";
const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
});

describe("capability repository generation authenticator", () => {
  it("replays TUF and Sigstore authentication entirely from stored bytes", async () => {
    const fixture = repositoryGenerationFixture();
    const verify = vi.fn(() => policy);
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({
      verifier: { verify },
    });

    await expect(authenticator.authenticate(fixture.input)).resolves.toBeUndefined();

    expect(verify).toHaveBeenCalledWith(fixture.capabilityBundle, fixture.sigstoreBundle, policy);
  });

  it("authenticates an explicit trusted-root generation without repository I/O", async () => {
    const fixture = repositoryGenerationFixture();
    const verify = vi.fn();
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({
      verifier: { verify },
    });

    await expect(
      authenticator.authenticate({
        repositoryBaseUrl,
        initializedAt: fixture.input.initializedAt,
        trustedRoot: fixture.input.trustedRoot,
        metadata: [fixture.input.trustedRoot],
        candidates: [],
      }),
    ).resolves.toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });

  it("replays a delegated role whose persisted metadata name is URL encoded", async () => {
    const fixture = repositoryGenerationFixture({ delegatedRoleName: "team/reviewers" });
    const verify = vi.fn(() => policy);
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({
      verifier: { verify },
    });

    expect(fixture.input.metadata.map(({ name }) => name)).toContain("team%2Freviewers.json");
    await expect(authenticator.authenticate(fixture.input)).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("rejects self-consistent local metadata substitution with one value-free stage", async () => {
    const fixture = repositoryGenerationFixture();
    const substituted = Buffer.from("PRIVATE_REPLACED_TARGETS_METADATA");
    const metadata = fixture.input.metadata.map((file) =>
      file.name === "targets.json" ? storedFile(file.name, substituted) : file,
    );
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({
      verifier: { verify: vi.fn(() => policy) },
    });

    let caught: unknown;
    try {
      await authenticator.authenticate({ ...fixture.input, metadata });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      new CapabilityRepositoryGenerationAuthenticationError("authenticate repository metadata"),
    );
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });

  it("rejects a stored envelope that no longer matches its authenticated TUF target", async () => {
    const fixture = repositoryGenerationFixture();
    const candidate = fixture.input.candidates[0];
    if (candidate === undefined) {
      throw new Error("fixture requires one candidate");
    }
    const substituted = Object.freeze({
      identity: candidate.identity,
      envelopeBytes: () => Buffer.from("PRIVATE_SUBSTITUTED_ENVELOPE"),
    });
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({
      verifier: { verify: vi.fn(() => policy) },
    });

    await expect(
      authenticator.authenticate({ ...fixture.input, candidates: [substituted] }),
    ).rejects.toEqual(
      new CapabilityRepositoryGenerationAuthenticationError("authenticate repository targets"),
    );
  });

  it("reopens one durable checked generation through the real authenticator", async () => {
    const fixture = repositoryGenerationFixture();
    const projectRoot = await mkdtemp(join(tmpdir(), "flow-authenticated-repository-store-"));
    const verifier = { verify: vi.fn(() => policy) };
    const authenticator = createCapabilityRepositoryGenerationAuthenticator({ verifier });
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt: fixture.input.initializedAt,
      trustedRoot: fixture.input.trustedRoot,
    });
    if (fixture.input.index === undefined) {
      throw new Error("fixture requires an index");
    }
    await store.publish({
      checkedAt: fixture.input.checkedAt ?? "",
      metadata: fixture.input.metadata,
      index: fixture.input.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });

    await expect(
      new LocalCapabilityRepositoryStore(projectRoot, authenticator).status(),
    ).resolves.toMatchObject({
      status: "checked",
      candidates: [{ candidateDigest: fixture.candidate.identity.candidateDigest }],
    });
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });
});

function repositoryGenerationFixture(options: { readonly delegatedRoleName?: string } = {}): {
  readonly input: AuthenticateCapabilityRepositoryGenerationInput;
  readonly capabilityBundle: Buffer;
  readonly sigstoreBundle: Buffer;
  readonly candidate: CapabilityRepositoryCandidate;
} {
  const oldKey = createSigningKey();
  const newKey = createSigningKey();
  const capability = createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities for one Flow project.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.0.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
      },
    ],
  });
  const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_BUNDLE");
  const envelope = encodeSignedCapabilityBundleEnvelope({
    capabilityBundle: capability.content,
    sigstoreBundle,
  });
  const indexBytes = encodeCapabilityRepositoryIndex({
    packages: [{ name: "review-suite", version: "1.0.0", targetPath: packagePath }],
  });
  const root = signedMetadata(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: expiry,
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
      expires: expiry,
      keys: { [newKey.id]: newKey.publicMetadata },
      roles: {
        root: role(newKey.id),
        timestamp: role(newKey.id),
        snapshot: role(newKey.id),
        targets: role(newKey.id),
      },
      consistent_snapshot: true,
    },
    [oldKey, newKey],
  );
  const delegatedTargets =
    options.delegatedRoleName === undefined
      ? undefined
      : signedMetadata(
          {
            _type: "targets",
            spec_version: "1.0.31",
            version: 1,
            expires: expiry,
            targets: {
              [packagePath]: targetDescriptor(envelope, {
                flow: {
                  apiVersion: "flow.synapti.ai/v1alpha1",
                  kind: "CapabilityPackageTarget",
                  name: "review-suite",
                  version: "1.0.0",
                  publisher: policy,
                },
              }),
            },
          },
          newKey,
        );
  const targets = signedMetadata(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: 1,
      expires: expiry,
      targets: {
        [indexPath]: targetDescriptor(indexBytes, {}),
        ...(options.delegatedRoleName === undefined
          ? {
              [packagePath]: targetDescriptor(envelope, {
                flow: {
                  apiVersion: "flow.synapti.ai/v1alpha1",
                  kind: "CapabilityPackageTarget",
                  name: "review-suite",
                  version: "1.0.0",
                  publisher: policy,
                },
              }),
            }
          : {}),
      },
      ...(options.delegatedRoleName === undefined
        ? {}
        : {
            delegations: {
              keys: { [newKey.id]: newKey.publicMetadata },
              roles: [
                {
                  name: options.delegatedRoleName,
                  keyids: [newKey.id],
                  threshold: 1,
                  terminating: true,
                  paths: [packagePath],
                },
              ],
            },
          }),
    },
    newKey,
  );
  const snapshot = signedMetadata(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: 1,
      expires: expiry,
      meta: {
        "targets.json": metadataDescriptor(1, targets),
        ...(options.delegatedRoleName === undefined || delegatedTargets === undefined
          ? {}
          : {
              [`${options.delegatedRoleName}.json`]: metadataDescriptor(1, delegatedTargets),
            }),
      },
    },
    newKey,
  );
  const timestamp = signedMetadata(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: 1,
      expires: expiry,
      meta: { "snapshot.json": metadataDescriptor(1, snapshot) },
    },
    newKey,
  );
  const metadata = Object.freeze(
    [
      storedFile("2.root.json", rotatedRoot),
      storedFile("root.json", rotatedRoot),
      storedFile("snapshot.json", snapshot),
      storedFile("targets.json", targets),
      storedFile("timestamp.json", timestamp),
      ...(options.delegatedRoleName === undefined || delegatedTargets === undefined
        ? []
        : [storedFile(`${encodeURIComponent(options.delegatedRoleName)}.json`, delegatedTargets)]),
    ].sort((left, right) => left.name.localeCompare(right.name)),
  );
  const index = storedIndex(indexBytes);
  const parsedIndex = parseCapabilityRepositoryIndex(indexBytes);
  const entry = parsedIndex.packages[0];
  if (entry === undefined) {
    throw new Error("fixture requires one index entry");
  }
  const candidate = createCapabilityRepositoryCandidate({
    repositoryMetadata: metadata.map(({ name, length, digest }) => ({ name, length, digest })),
    index: parsedIndex,
    entry,
    target: {
      path: packagePath,
      source: consistentTargetUrl(packagePath, envelope),
      length: envelope.byteLength,
      hashes: { sha256: sha256Hex(envelope) },
      custom: {
        flow: {
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "CapabilityPackageTarget",
          name: "review-suite",
          version: "1.0.0",
          publisher: policy,
        },
      },
      content: envelope,
    },
    authority: {
      kind: "sigstore-keyless-v0.3",
      ...policy,
      signatureBundleDigest: digest(sigstoreBundle),
    },
  });
  return {
    capabilityBundle: capability.content,
    sigstoreBundle,
    candidate,
    input: {
      repositoryBaseUrl,
      initializedAt: "2026-08-17T00:00:00.000Z",
      checkedAt: "2026-08-17T01:00:00.000Z",
      trustedRoot: storedFile("root.json", root),
      metadata,
      index,
      candidates: [storedCandidate(candidate)],
    },
  };
}

function storedCandidate(candidate: CapabilityRepositoryCandidate) {
  return Object.freeze({
    identity: candidate.identity,
    envelopeBytes: () => candidate.envelopeBytes(),
  });
}

function storedFile(name: string, content: Buffer): CapabilityRepositoryStoredFile {
  const copy = Buffer.from(content);
  return Object.freeze({
    name,
    length: copy.byteLength,
    digest: digest(copy),
    bytes: () => Buffer.from(copy),
  });
}

function storedIndex(content: Buffer): CapabilityRepositoryStoredIndex {
  const copy = Buffer.from(content);
  return Object.freeze({
    path: indexPath,
    length: copy.byteLength,
    hashes: Object.freeze({ sha256: sha256Hex(copy) }),
    bytes: () => Buffer.from(copy),
  });
}

function targetDescriptor(
  content: Buffer,
  custom: Record<string, unknown>,
): Record<string, unknown> {
  return { length: content.byteLength, hashes: { sha256: sha256Hex(content) }, custom };
}

function metadataDescriptor(version: number, content: Buffer): Record<string, unknown> {
  return { version, length: content.byteLength, hashes: { sha256: sha256Hex(content) } };
}

function consistentTargetUrl(path: string, content: Buffer): string {
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `${repositoryBaseUrl}targets/${directory}${sha256Hex(content)}.${name}`;
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
    id: sha256Hex(Buffer.from(canonicalJson(publicMetadata))),
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

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
