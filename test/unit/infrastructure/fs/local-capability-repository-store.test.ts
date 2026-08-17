import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createCapabilityRepositoryCandidate,
  toPublicCapabilityRepositoryCandidate,
} from "../../../../src/application/capability-repository-candidate.js";
import {
  type CapabilityRepositoryGenerationAuthenticator,
  type CapabilityRepositoryStoredFile,
  type CapabilityRepositoryStoredIndex,
  CapabilityRepositoryStoreError,
} from "../../../../src/application/capability-repository-store.js";
import { createCapabilityBundleSource } from "../../../../src/domain/capability/capability-bundles.js";
import {
  encodeCapabilityRepositoryIndex,
  parseCapabilityRepositoryIndex,
} from "../../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../../src/domain/capability/signed-capability-bundle-envelope.js";
import {
  LocalCapabilityRepositoryStore,
  type LocalCapabilityRepositoryStoreHooks,
} from "../../../../src/infrastructure/fs/local-capability-repository-store.js";

const initializedAt = "2026-08-17T00:00:00.000Z";
const checkedAt = "2026-08-17T01:00:00.000Z";
const repositoryBaseUrl = "https://packages.example.test/repository/";
const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
});

describe("local capability repository store", () => {
  it("initializes from one trusted root and authenticates the reopened generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const trustedRoot = storedFile("root.json", Buffer.from("TRUSTED_ROOT"));
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);

    const initialized = await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot,
    });
    const reopened = await new LocalCapabilityRepositoryStore(projectRoot, authenticator).status();

    expect(initialized).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityRepositoryState",
      status: "initialized",
      initializedAt,
      metadata: [{ name: "root.json", length: trustedRoot.length, digest: trustedRoot.digest }],
      candidates: [],
    });
    expect(reopened).toEqual(initialized);
    expect(authenticator.authenticate).toHaveBeenCalledTimes(2);
    expect(authenticator.authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        repositoryBaseUrl,
        initializedAt,
        trustedRoot: expect.objectContaining({ name: "root.json" }),
        metadata: [expect.objectContaining({ name: "root.json" })],
        candidates: [],
      }),
    );
  });

  it("atomically publishes and reopens one authenticated checked generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();

    const publication = await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });
    const reopenedStore = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    const reopened = await reopenedStore.status();
    const candidate = await reopenedStore.readCandidate(fixture.candidate.identity.candidateDigest);

    expect(publication).toEqual({
      status: "staged",
      checkedAt,
      candidates: [toPublicCapabilityRepositoryCandidate(fixture.candidate)],
    });
    expect(reopened).toMatchObject({
      status: "checked",
      initializedAt,
      checkedAt,
      candidates: [toPublicCapabilityRepositoryCandidate(fixture.candidate)],
    });
    expect(candidate.identity).toEqual(fixture.candidate.identity);
    expect(candidate.envelopeBytes()).toEqual(fixture.candidate.envelopeBytes());
    const mutable = candidate.envelopeBytes();
    mutable.fill(0);
    expect(candidate.envelopeBytes()).toEqual(fixture.candidate.envelopeBytes());
    const trustedState = await reopenedStore.readTrustedState();
    expect(trustedState.repositoryBaseUrl).toBe(repositoryBaseUrl);
    expect(trustedState.metadata.map(({ name }) => name)).toEqual(
      fixture.metadata.map(({ name }) => name),
    );
    const mutableMetadata = trustedState.metadata[0]?.bytes();
    mutableMetadata?.fill(0);
    expect(trustedState.metadata[0]?.bytes()).toEqual(fixture.metadata[0]?.bytes());
    expect(
      await readdir(join(projectRoot, ".flow", "capability.repository", "generations")),
    ).toHaveLength(2);
  });

  it("atomically publishes and reopens a checked generation with no candidates", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const metadata = Object.freeze([
      storedFile("1.snapshot.json", Buffer.from("SNAPSHOT")),
      storedFile("1.targets.json", Buffer.from("TARGETS")),
      storedFile("root.json", Buffer.from("ROTATED_TRUSTED_ROOT")),
      storedFile("timestamp.json", Buffer.from("TIMESTAMP")),
    ]);
    const index = storedIndex(encodeCapabilityRepositoryIndex({ packages: [] }));

    const publication = await store.publish({
      checkedAt,
      metadata,
      index,
      candidates: [],
      signal: new AbortController().signal,
    });
    const reopened = await new LocalCapabilityRepositoryStore(projectRoot, authenticator).status();

    expect(publication).toEqual({ status: "staged", checkedAt, candidates: [] });
    expect(reopened).toMatchObject({
      status: "checked",
      checkedAt,
      metadata: metadata.map(({ name, length, digest }) => ({ name, length, digest })),
      candidates: [],
    });
    expect(authenticator.authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        checkedAt,
        index: expect.objectContaining({ path: "flow/capability-index.json" }),
        candidates: [],
      }),
    );
  });

  it("rejects a redigested repository-state substitution without candidates", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const metadata = Object.freeze([
      storedFile("1.snapshot.json", Buffer.from("SNAPSHOT")),
      storedFile("1.targets.json", Buffer.from("TARGETS")),
      storedFile("root.json", Buffer.from("ROTATED_TRUSTED_ROOT")),
      storedFile("timestamp.json", Buffer.from("TIMESTAMP")),
    ]);
    await store.publish({
      checkedAt,
      metadata,
      index: storedIndex(encodeCapabilityRepositoryIndex({ packages: [] })),
      candidates: [],
      signal: new AbortController().signal,
    });
    const state = await store.status();
    if (state === undefined) {
      throw new Error("fixture requires current repository state");
    }
    const repositoryDirectory = join(projectRoot, ".flow", "capability.repository");
    const generationsDirectory = join(repositoryDirectory, "generations");
    const generationDirectory = join(
      generationsDirectory,
      state.generationDigest.slice("sha256:".length),
    );
    const generationRecordPath = join(generationDirectory, "generation.json");
    const generation = JSON.parse(await readFile(generationRecordPath, "utf8")) as Record<
      string,
      unknown
    >;
    generation.repositoryStateDigest = `sha256:${"0".repeat(64)}`;
    const { generationDigest: _oldDigest, ...content } = generation;
    generation.generationDigest = digest(Buffer.from(JSON.stringify(content)));
    await writeFile(generationRecordPath, JSON.stringify(generation));
    const replacementDirectory = join(
      generationsDirectory,
      String(generation.generationDigest).slice("sha256:".length),
    );
    await rename(generationDirectory, replacementDirectory);
    const currentPath = join(repositoryDirectory, "current.json");
    const current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
    current.generationDigest = generation.generationDigest;
    await writeFile(currentPath, JSON.stringify(current));

    await expect(
      new LocalCapabilityRepositoryStore(projectRoot, authenticator).status(),
    ).rejects.toEqual(new CapabilityRepositoryStoreError("read repository generation"));
  });

  it("advances the check high-water without creating a duplicate generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });
    const laterCheckedAt = "2026-08-17T02:00:00.000Z";

    const repeated = await store.publish({
      checkedAt: laterCheckedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });

    expect(repeated).toEqual({
      status: "already_current",
      checkedAt: laterCheckedAt,
      candidates: [toPublicCapabilityRepositoryCandidate(fixture.candidate)],
    });
    await expect(store.status()).resolves.toMatchObject({ checkedAt: laterCheckedAt });
    expect(
      await readdir(join(projectRoot, ".flow", "capability.repository", "generations")),
    ).toHaveLength(2);
  });

  it("rejects clock rollback without changing the current generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });
    const before = await store.status();

    await expect(
      store.publish({
        checkedAt: "2026-08-16T23:59:59.999Z",
        metadata: fixture.metadata,
        index: fixture.index,
        candidates: [fixture.candidate],
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new CapabilityRepositoryStoreError("validate repository store input"));
    await expect(store.status()).resolves.toEqual(before);
  });

  it("rejects candidate reopening when the clock rolls behind the durable check instant", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:59:59.999Z"));
    try {
      await expect(
        new LocalCapabilityRepositoryStore(projectRoot, authenticator).readCandidate(
          fixture.candidate.identity.candidateDigest,
        ),
      ).rejects.toEqual(new CapabilityRepositoryStoreError("inspect repository store"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes only the inert candidate by publishing a new authenticated generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });

    const removed = await store.removeCandidate(fixture.candidate.identity.candidateDigest);

    expect(removed).toMatchObject({ status: "checked", checkedAt, candidates: [] });
    await expect(store.listCandidates()).resolves.toEqual([]);
    await expect(store.readCandidate(fixture.candidate.identity.candidateDigest)).rejects.toEqual(
      new CapabilityRepositoryStoreError("read repository candidate"),
    );
  });

  it("fails closed without removing a stale lock or pending generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const repositoryDirectory = join(projectRoot, ".flow", "capability.repository");
    const pending = join(repositoryDirectory, ".generation.pending");
    await mkdir(pending);

    await expect(store.status()).rejects.toEqual(
      new CapabilityRepositoryStoreError("inspect repository store"),
    );
    await expect(readdir(pending)).resolves.toEqual([]);
  });

  it("accepts exactly four candidates and rejects a fifth before publication", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const four = checkedGenerationFixture(4);
    await expect(
      store.publish({
        checkedAt,
        metadata: four.metadata,
        index: four.index,
        candidates: four.candidates,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "staged", candidates: { length: 4 } });
    const before = await store.status();
    const five = checkedGenerationFixture(5);

    await expect(
      store.publish({
        checkedAt: "2026-08-17T02:00:00.000Z",
        metadata: five.metadata,
        index: five.index,
        candidates: five.candidates,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new CapabilityRepositoryStoreError("enforce repository store capacity"));
    await expect(store.status()).resolves.toEqual(before);
  });

  it("preserves a pre-existing lock for explicit operator remediation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const lockPath = join(projectRoot, ".flow", "capability.repository", "repository.lock");
    const lockCanary = Buffer.from("PRIVATE_STALE_LOCK");
    await writeFile(lockPath, lockCanary);

    let caught: unknown;
    try {
      await store.status();
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryStoreError("acquire repository store lock"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    await expect(readFile(lockPath)).resolves.toEqual(lockCanary);
  });

  it("bounds concurrent publications to one visible verified generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    await new LocalCapabilityRepositoryStore(projectRoot, authenticator).initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const first = new LocalCapabilityRepositoryStore(projectRoot, authenticator, {
      beforeCurrentRenamed: async () => {
        enteredFirst();
        await firstPaused;
      },
    });
    const second = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    const input = {
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    };

    const firstPublication = first.publish(input);
    await firstEntered;
    await expect(second.publish(input)).rejects.toEqual(
      new CapabilityRepositoryStoreError("acquire repository store lock"),
    );
    releaseFirst();
    await expect(firstPublication).resolves.toMatchObject({ status: "staged" });

    const reopened = await second.status();
    expect(reopened).toMatchObject({
      status: "checked",
      candidates: [{ candidateDigest: fixture.candidate.identity.candidateDigest }],
    });
    expect(
      await readdir(join(projectRoot, ".flow", "capability.repository", "generations")),
    ).toHaveLength(2);
  });

  it("rejects a symlinked metadata directory even when external bytes are identical", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const fixture = checkedGenerationFixture();
    await store.publish({
      checkedAt,
      metadata: fixture.metadata,
      index: fixture.index,
      candidates: [fixture.candidate],
      signal: new AbortController().signal,
    });
    const state = await store.status();
    if (state === undefined) {
      throw new Error("fixture requires current repository state");
    }
    const generation = join(
      projectRoot,
      ".flow",
      "capability.repository",
      "generations",
      state.generationDigest.slice("sha256:".length),
    );
    const metadataDirectory = join(generation, "metadata");
    const originalMetadata = join(generation, "metadata.original");
    const external = await mkdtemp(join(tmpdir(), "flow-external-repository-metadata-"));
    for (const name of await readdir(metadataDirectory)) {
      await writeFile(join(external, name), await readFile(join(metadataDirectory, name)));
    }
    const canaryPath = join(external, "PRIVATE_CANARY");
    await writeFile(canaryPath, "PRIVATE_EXTERNAL_CANARY");
    await rename(metadataDirectory, originalMetadata);
    await symlink(external, metadataDirectory);

    await expect(store.status()).rejects.toEqual(
      new CapabilityRepositoryStoreError("read repository generation"),
    );
    await expect(readFile(canaryPath, "utf8")).resolves.toBe("PRIVATE_EXTERNAL_CANARY");
  });

  it("rejects an unexpected generation entry", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator);
    const state = await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const generation = join(
      projectRoot,
      ".flow",
      "capability.repository",
      "generations",
      state.generationDigest.slice("sha256:".length),
    );
    await writeFile(join(generation, "PRIVATE.extra"), "PRIVATE_EXTRA_BYTES");

    await expect(store.status()).rejects.toEqual(
      new CapabilityRepositoryStoreError("read repository generation"),
    );
  });

  it("keeps the old generation authoritative when cancellation arrives before current rename", async () => {
    const projectRoot = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled repository publication");
    let armed = false;
    const hooks: LocalCapabilityRepositoryStoreHooks = {
      beforeCurrentRenamed: () => {
        if (armed) {
          controller.abort(reason);
        }
      },
    };
    const authenticator = acceptingAuthenticator();
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator, hooks);
    const initialized = await store.initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    armed = true;
    const fixture = checkedGenerationFixture();

    await expect(
      store.publish({
        checkedAt,
        metadata: fixture.metadata,
        index: fixture.index,
        candidates: [fixture.candidate],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(
      new LocalCapabilityRepositoryStore(projectRoot, authenticator).status(),
    ).resolves.toEqual(initialized);
  });

  it("reports settlement uncertainty after current rename and preserves the new generation", async () => {
    const projectRoot = await projectDirectory();
    const authenticator = acceptingAuthenticator();
    const fixture = checkedGenerationFixture();
    await new LocalCapabilityRepositoryStore(projectRoot, authenticator).initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const store = new LocalCapabilityRepositoryStore(projectRoot, authenticator, {
      afterCurrentRenamed: () => {
        throw new Error("PRIVATE_DIRECTORY_SYNC_FAILURE");
      },
    });

    let caught: unknown;
    try {
      await store.publish({
        checkedAt,
        metadata: fixture.metadata,
        index: fixture.index,
        candidates: [fixture.candidate],
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryStoreError("settle repository store commit"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    await expect(
      new LocalCapabilityRepositoryStore(projectRoot, authenticator).listCandidates(),
    ).resolves.toEqual([toPublicCapabilityRepositoryCandidate(fixture.candidate)]);
  });

  it("fails closed when reopened bytes are not authenticated", async () => {
    const projectRoot = await projectDirectory();
    const accepting = acceptingAuthenticator();
    await new LocalCapabilityRepositoryStore(projectRoot, accepting).initialize({
      repositoryBaseUrl,
      initializedAt,
      trustedRoot: storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    });
    const privateFailure = new Error("PRIVATE_AUTHENTICATOR_DETAIL");
    const rejecting: CapabilityRepositoryGenerationAuthenticator = {
      authenticate: vi.fn(async () => {
        throw privateFailure;
      }),
    };

    let caught: unknown;
    try {
      await new LocalCapabilityRepositoryStore(projectRoot, rejecting).status();
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryStoreError("read repository generation"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    expect(rejecting.authenticate).toHaveBeenCalledOnce();
  });
});

function acceptingAuthenticator(): CapabilityRepositoryGenerationAuthenticator & {
  readonly authenticate: ReturnType<typeof vi.fn>;
} {
  return {
    authenticate: vi.fn(async () => undefined),
  };
}

function checkedGenerationFixture(packageCount = 1) {
  const packages = Array.from({ length: packageCount }, (_, position) => {
    const name = packageCount === 1 ? "review-suite" : `review-suite-${position + 1}`;
    const version = "1.0.0";
    const capabilityBundle = createCapabilityBundleSource({
      name,
      version,
      description: "Review capabilities for one Flow project.",
      packages: [
        {
          kind: "verifier-package",
          manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review-${position + 1}
  version: 1.0.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
        },
      ],
    });
    const targetPath = `flow/packages/${name}/${version}.flowpkg.json`;
    const sigstoreBundle = Buffer.from(`PRIVATE_SIGSTORE_BUNDLE_${position + 1}`);
    const envelope = encodeSignedCapabilityBundleEnvelope({
      capabilityBundle: capabilityBundle.content,
      sigstoreBundle,
    });
    return { name, version, targetPath, capabilityBundle, sigstoreBundle, envelope };
  });
  const indexBytes = encodeCapabilityRepositoryIndex({
    packages: packages.map(({ name, version, targetPath }) => ({ name, version, targetPath })),
  });
  const parsedIndex = parseCapabilityRepositoryIndex(indexBytes);
  const metadata = Object.freeze([
    storedFile("1.snapshot.json", Buffer.from("SNAPSHOT")),
    storedFile("1.targets.json", Buffer.from("TARGETS")),
    storedFile("root.json", Buffer.from("TRUSTED_ROOT")),
    storedFile("timestamp.json", Buffer.from("TIMESTAMP")),
  ]);
  const candidates = packages.map((item, position) => {
    const entry = parsedIndex.packages[position];
    if (entry === undefined) {
      throw new Error("fixture requires one index entry per package");
    }
    return createCapabilityRepositoryCandidate({
      repositoryMetadata: metadata.map(({ name, length, digest }) => ({ name, length, digest })),
      index: parsedIndex,
      entry,
      target: {
        path: item.targetPath,
        source: `https://packages.example.test/repository/targets/${position + 1}/package.flowpkg.json`,
        length: item.envelope.byteLength,
        hashes: { sha256: sha256Hex(item.envelope) },
        custom: {
          flow: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            kind: "CapabilityPackageTarget",
            name: item.name,
            version: item.version,
            publisher: policy,
          },
        },
        content: item.envelope,
      },
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: digest(item.sigstoreBundle),
      },
    });
  });
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error("fixture requires at least one candidate");
  }
  return {
    metadata,
    index: storedIndex(indexBytes),
    candidate,
    candidates: Object.freeze(candidates),
  };
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
    path: "flow/capability-index.json",
    length: copy.byteLength,
    hashes: Object.freeze({ sha256: sha256Hex(copy) }),
    bytes: () => Buffer.from(copy),
  });
}

async function projectDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "flow-capability-repository-store-"));
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
