import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCapabilityMetadataCandidate } from "../../../../src/application/capability-metadata-candidate.js";
import { CapabilityMetadataCandidateStoreError } from "../../../../src/application/capability-metadata-candidate-store.js";
import { parseCapabilityMetadata } from "../../../../src/domain/capability/capability-metadata.js";
import {
  type LocalCapabilityMetadataCandidateStoreHooks,
  LocalCapabilityMetadataCandidateStore as LocalCapabilityMetadataCandidateStoreImplementation,
} from "../../../../src/infrastructure/fs/local-capability-metadata-candidate-store.js";

const temporaryDirectories: string[] = [];
const now = new Date("2026-08-14T00:00:00.000Z");
const authenticatedAuthority = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});

class LocalCapabilityMetadataCandidateStore extends LocalCapabilityMetadataCandidateStoreImplementation {
  constructor(projectRoot: string, hooks: LocalCapabilityMetadataCandidateStoreHooks = {}) {
    super(
      projectRoot,
      {
        verify: (_metadata, _bundle, suppliedPolicy) => {
          if (
            suppliedPolicy.certificateIssuer !== authenticatedAuthority.certificateIssuer ||
            suppliedPolicy.certificateIdentity !== authenticatedAuthority.certificateIdentity
          ) {
            throw new Error("candidate signer policy does not authenticate the stored bundle");
          }
          return authenticatedAuthority;
        },
      },
      hooks,
    );
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("local capability metadata candidate store", () => {
  it("stages exact bytes idempotently and replaces only the latest observation", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const input = stageInput({ metadataVersion: 1, checkedAt: "2026-08-14T00:00:00.000Z" });

    await expect(store.stage(input)).resolves.toMatchObject({
      status: "staged",
      candidate: { candidateDigest: input.candidate.candidateDigest },
      observation: { checkedAt: "2026-08-14T00:00:00.000Z" },
    });
    await expect(
      store.stage({
        ...input,
        observation: { ...input.observation, checkedAt: "2026-08-14T01:00:00.000Z" },
      }),
    ).resolves.toMatchObject({ status: "already_staged" });

    await expect(store.list()).resolves.toMatchObject([
      { candidateDigest: input.candidate.candidateDigest, metadata: { version: 1 } },
    ]);
    const stored = await store.read(input.candidate.candidateDigest);
    expect(stored.candidate).toEqual(input.candidate);
    expect(stored.metadataBytes()).toEqual(input.metadata);
    expect(stored.sigstoreBundleBytes()).toEqual(input.sigstoreBundle);
    stored.metadataBytes().fill(0);
    expect(stored.metadataBytes()).toEqual(input.metadata);
    await expect(store.latestCheck()).resolves.toMatchObject({
      checkedAt: "2026-08-14T01:00:00.000Z",
      candidateDigest: input.candidate.candidateDigest,
    });
    await expect(stat(join(projectRoot, ".flow", "packages.metadata.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows independent versions and rejects a fifth distinct candidate", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    for (const version of [100, 2, 3, 4]) {
      await store.stage(stageInput({ metadataVersion: version }));
    }

    await expect(store.list()).resolves.toHaveLength(4);
    await expect(store.stage(stageInput({ metadataVersion: 5 }))).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("enforce candidate capacity"),
    );
    await expect(store.list()).resolves.toHaveLength(4);
  });

  it("stops directory discovery at capacity plus one entry", async () => {
    const projectRoot = await projectDirectory();
    let entriesRead = 0;
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      candidateDirectoryEntries: async function* () {
        for (let index = 0; index < 6; index += 1) {
          entriesRead += 1;
          if (index === 5) {
            throw new Error("PRIVATE_UNBOUNDED_DIRECTORY_SCAN");
          }
          yield {
            name: index.toString(16).padStart(64, "0"),
            isDirectory: () => true,
            isSymbolicLink: () => false,
          };
        }
      },
    });

    await expect(store.list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    expect(entriesRead).toBe(5);
  });

  it("removes only one exact candidate and leaves active metadata untouched", async () => {
    const projectRoot = await projectDirectory();
    const flowDirectory = join(projectRoot, ".flow");
    await mkdir(flowDirectory);
    const activePath = join(flowDirectory, "packages.metadata.json");
    await writeFile(activePath, "PRIVATE_ACTIVE_METADATA");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const first = stageInput({ metadataVersion: 1 });
    const second = stageInput({ metadataVersion: 2 });
    await store.stage(first);
    await store.stage(second);

    await store.remove(first.candidate.candidateDigest);

    await expect(store.list()).resolves.toMatchObject([
      { candidateDigest: second.candidate.candidateDigest },
    ]);
    await expect(readFile(activePath, "utf8")).resolves.toBe("PRIVATE_ACTIVE_METADATA");
    await expect(store.read(first.candidate.candidateDigest)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it.each(["metadata.json", "sigstore.bundle.json", "candidate.json"])(
    "rejects tampered %s when reopening the candidate",
    async (fileName) => {
      const projectRoot = await projectDirectory();
      const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
      const input = stageInput({ metadataVersion: 1 });
      await store.stage(input);
      await writeFile(
        candidateFile(projectRoot, input.candidate.candidateDigest, fileName),
        "PRIVATE_TAMPER",
      );

      await expect(store.read(input.candidate.candidateDigest)).rejects.toEqual(
        new CapabilityMetadataCandidateStoreError("read candidate"),
      );
    },
  );

  it("rejects a symlinked candidate file even when its target has the exact admitted bytes", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const input = stageInput({ metadataVersion: 1 });
    await store.stage(input);
    const metadataPath = candidateFile(
      projectRoot,
      input.candidate.candidateDigest,
      "metadata.json",
    );
    const externalPath = join(projectRoot, "PRIVATE_EXTERNAL_METADATA.json");
    await writeFile(externalPath, input.metadata);
    await unlink(metadataPath);
    await symlink(externalPath, metadataPath);

    await expect(store.read(input.candidate.candidateDigest)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it("rejects a symlink that replaces the complete content-addressed candidate directory", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const input = stageInput({ metadataVersion: 1 });
    await store.stage(input);
    const directory = candidateDirectory(projectRoot, input.candidate.candidateDigest);
    const externalDirectory = join(projectRoot, "PRIVATE_EXTERNAL_CANDIDATE");
    await rename(directory, externalDirectory);
    await symlink(externalDirectory, directory, "dir");

    await expect(store.read(input.candidate.candidateDigest)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it("accepts an exact one-mebibyte Sigstore bundle and rejects a physical byte beyond it", async () => {
    const projectRoot = await projectDirectory();
    const sigstoreBundle = Buffer.alloc(1024 * 1024, 0x61);
    const input = stageInputWithBundle({ metadataVersion: 1, sigstoreBundle });
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    await store.stage(input);

    await expect(store.read(input.candidate.candidateDigest)).resolves.toMatchObject({
      candidate: { sigstoreBundle: { bytes: 1024 * 1024 } },
    });
    await writeFile(
      candidateFile(projectRoot, input.candidate.candidateDigest, "sigstore.bundle.json"),
      Buffer.concat([sigstoreBundle, Buffer.from("+")]),
    );
    await expect(store.read(input.candidate.candidateDigest)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it("rejects a recomputed candidate record whose review fields contradict metadata bytes", async () => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const input = stageInput({ metadataVersion: 1 });
    await store.stage(input);
    const oldDirectory = candidateDirectory(projectRoot, input.candidate.candidateDigest);
    const recordPath = join(oldDirectory, "candidate.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      candidateDigest: string;
      metadata: { version: number };
      [key: string]: unknown;
    };
    record.metadata.version = 2;
    const { candidateDigest: _oldDigest, ...identity } = record;
    record.candidateDigest = digest(
      Buffer.from(
        JSON.stringify({
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "CapabilityMetadataCandidateIdentity",
          metadata: identity.metadata,
          sigstoreBundle: identity.sigstoreBundle,
          authority: identity.authority,
        }),
      ),
    );
    await writeFile(recordPath, JSON.stringify(record));
    await rename(oldDirectory, candidateDirectory(projectRoot, record.candidateDigest));

    await expect(store.list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it.each([
    ["issuer", { certificateIssuer: "https://issuer.example.test/PRIVATE_SUBSTITUTE" }],
    ["identity", { certificateIdentity: "https://publisher.example.test/PRIVATE_IDENTITY" }],
  ])("rejects a recomputed candidate record with substituted signer %s", async (_label, policy) => {
    const projectRoot = await projectDirectory();
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);
    const input = stageInput({ metadataVersion: 1 });
    await store.stage(input);
    const oldDirectory = candidateDirectory(projectRoot, input.candidate.candidateDigest);
    const recordPath = join(oldDirectory, "candidate.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      candidateDigest: string;
      authority: { certificateIssuer: string; certificateIdentity: string };
      [key: string]: unknown;
    };
    record.authority = { ...record.authority, ...policy };
    const { candidateDigest: _oldDigest, ...identity } = record;
    record.candidateDigest = digest(
      Buffer.from(
        JSON.stringify({
          apiVersion: "flow.synapti.ai/v1alpha1",
          kind: "CapabilityMetadataCandidateIdentity",
          metadata: identity.metadata,
          sigstoreBundle: identity.sigstoreBundle,
          authority: identity.authority,
        }),
      ),
    );
    await writeFile(recordPath, JSON.stringify(record));
    await rename(oldDirectory, candidateDirectory(projectRoot, record.candidateDigest));

    await expect(store.list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("read candidate"),
    );
  });

  it("preserves a candidate when cancellation arrives after reopen and before removal", async () => {
    const projectRoot = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled candidate removal");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      beforeCandidateRemove: () => controller.abort(reason),
    });
    const input = stageInput({ metadataVersion: 1 });
    await store.stage(input);

    await expect(store.remove(input.candidate.candidateDigest, controller.signal)).rejects.toBe(
      reason,
    );
    await expect(store.read(input.candidate.candidateDigest)).resolves.toMatchObject({
      candidate: { candidateDigest: input.candidate.candidateDigest },
    });
  });

  it("reports candidate rename settlement without rolling back the committed candidate", async () => {
    const projectRoot = await projectDirectory();
    const lockPath = join(projectRoot, ".flow", "packages.metadata.check.lock");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      afterCandidateRenamed: async () => {
        await unlink(lockPath);
        throw new Error("PRIVATE_CANDIDATE_DIRECTORY_SYNC_FAILURE");
      },
    });
    const input = stageInput({ metadataVersion: 1 });

    await expect(store.stage(input)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("settle candidate commit"),
    );
    await expect(
      new LocalCapabilityMetadataCandidateStore(projectRoot).read(input.candidate.candidateDigest),
    ).resolves.toMatchObject({
      candidate: { candidateDigest: input.candidate.candidateDigest },
    });
  });

  it("reports observation rename settlement while retaining both committed records", async () => {
    const projectRoot = await projectDirectory();
    const lockPath = join(projectRoot, ".flow", "packages.metadata.check.lock");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      afterLatestCheckRenamed: async () => {
        await unlink(lockPath);
        throw new Error("PRIVATE_OBSERVATION_DIRECTORY_SYNC_FAILURE");
      },
    });
    const input = stageInput({ metadataVersion: 1 });

    await expect(store.stage(input)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("settle candidate commit"),
    );
    const reopened = new LocalCapabilityMetadataCandidateStore(projectRoot);
    await expect(reopened.read(input.candidate.candidateDigest)).resolves.toMatchObject({
      candidate: { candidateDigest: input.candidate.candidateDigest },
    });
    await expect(reopened.latestCheck()).resolves.toMatchObject({
      candidateDigest: input.candidate.candidateDigest,
    });
  });

  it("reports settlement uncertainty when a successful stage cannot release its lock", async () => {
    const projectRoot = await projectDirectory();
    const lockPath = join(projectRoot, ".flow", "packages.metadata.check.lock");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      afterLatestCheckRenamed: async () => unlink(lockPath),
    });
    const input = stageInput({ metadataVersion: 1 });

    await expect(store.stage(input)).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("settle candidate commit"),
    );
    const reopened = new LocalCapabilityMetadataCandidateStore(projectRoot);
    await expect(reopened.read(input.candidate.candidateDigest)).resolves.toMatchObject({
      candidate: { candidateDigest: input.candidate.candidateDigest },
    });
    await expect(reopened.latestCheck()).resolves.toMatchObject({
      candidateDigest: input.candidate.candidateDigest,
    });
  });

  it("reports settlement uncertainty when cancellation follows the durable candidate commit", async () => {
    const projectRoot = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled after durable candidate commit");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      afterCandidateRenamed: () => controller.abort(reason),
    });
    const input = stageInput({ metadataVersion: 1 });

    await expect(store.stage({ ...input, signal: controller.signal })).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("settle candidate commit"),
    );
    const reopened = new LocalCapabilityMetadataCandidateStore(projectRoot);
    await expect(reopened.read(input.candidate.candidateDigest)).resolves.toMatchObject({
      candidate: { candidateDigest: input.candidate.candidateDigest },
    });
    await expect(reopened.latestCheck()).resolves.toBeNull();
  });

  it("publishes no candidate when cancellation arrives immediately before rename", async () => {
    const projectRoot = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled before candidate rename");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      beforeCandidateRenamed: () => controller.abort(reason),
    });
    const input = stageInput({ metadataVersion: 1 });

    await expect(store.stage({ ...input, signal: controller.signal })).rejects.toBe(reason);
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    await rm(join(projectRoot, ".flow", ".packages.metadata.candidate.pending"), {
      recursive: true,
    });
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).resolves.toEqual(
      [],
    );
  });

  it("preserves latest-check pending state when cancellation arrives before rename", async () => {
    const projectRoot = await projectDirectory();
    const input = stageInput({ metadataVersion: 1 });
    await new LocalCapabilityMetadataCandidateStore(projectRoot).stage(input);
    const controller = new AbortController();
    const reason = new Error("operator cancelled before latest-check rename");
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      beforeLatestCheckRenamed: () => controller.abort(reason),
    });
    const pendingPath = join(projectRoot, ".flow", ".packages.metadata.check.pending");

    await expect(store.stage({ ...input, signal: controller.signal })).rejects.toBe(reason);
    await expect(stat(pendingPath)).resolves.toBeDefined();
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    await unlink(pendingPath);
    await expect(
      new LocalCapabilityMetadataCandidateStore(projectRoot).list(),
    ).resolves.toHaveLength(1);
  });

  it("cleans an atomically linked lock when acquisition setup fails", async () => {
    const projectRoot = await projectDirectory();
    const failing = new LocalCapabilityMetadataCandidateStore(projectRoot, {
      afterCandidateLockLinked: () => {
        throw new Error("PRIVATE_LOCK_SETTLEMENT_FAILURE");
      },
    });

    await expect(failing.list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("acquire candidate store lock"),
    );
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).resolves.toEqual(
      [],
    );
  });

  it("fails closed until the operator explicitly removes a stale lock and pending state", async () => {
    const projectRoot = await projectDirectory();
    const flowDirectory = join(projectRoot, ".flow");
    await mkdir(join(flowDirectory, "packages.metadata.candidates", "sha256"), {
      recursive: true,
    });
    const lockPath = join(flowDirectory, "packages.metadata.check.lock");
    const owner = `${JSON.stringify({ version: 1, hostname: hostname(), pid: 2_147_483_647, token: "a".repeat(36) })}\n`;
    await writeFile(lockPath, owner);
    const pendingPath = join(flowDirectory, ".packages.metadata.candidate.pending");
    await mkdir(pendingPath);
    await writeFile(join(pendingPath, "metadata.json"), "PRIVATE_ORPHAN_BYTES");

    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("acquire candidate store lock"),
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(owner);
    await expect(stat(pendingPath)).resolves.toBeDefined();

    await unlink(lockPath);
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    await expect(readFile(join(pendingPath, "metadata.json"), "utf8")).resolves.toBe(
      "PRIVATE_ORPHAN_BYTES",
    );
    await rm(pendingPath, { recursive: true });
    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).resolves.toEqual(
      [],
    );
  });

  it("rejects unexpected pending content without traversing or removing it", async () => {
    const projectRoot = await projectDirectory();
    const pendingPath = join(projectRoot, ".flow", ".packages.metadata.candidate.pending");
    const nestedPath = join(pendingPath, "metadata.json");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "PRIVATE_NESTED"), "PRIVATE_NESTED_BYTES");

    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    await expect(stat(join(nestedPath, "PRIVATE_NESTED"))).resolves.toBeDefined();
  });

  it("does not follow a pending-directory symlink during reconciliation", async () => {
    const projectRoot = await projectDirectory();
    const externalDirectory = await projectDirectory();
    const externalCanary = join(externalDirectory, "metadata.json");
    await writeFile(externalCanary, "PRIVATE_EXTERNAL_CANARY");
    const pendingPath = join(projectRoot, ".flow", ".packages.metadata.candidate.pending");
    await mkdir(join(projectRoot, ".flow"), { recursive: true });
    await symlink(externalDirectory, pendingPath);

    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("inspect candidate store"),
    );
    await expect(readFile(externalCanary, "utf8")).resolves.toBe("PRIVATE_EXTERNAL_CANARY");
  });

  it("preserves pending content when cancellation is already active", async () => {
    const projectRoot = await projectDirectory();
    const pendingPath = join(projectRoot, ".flow", ".packages.metadata.candidate.pending");
    await mkdir(pendingPath, { recursive: true });
    await writeFile(join(pendingPath, "metadata.json"), "PRIVATE_PENDING_BYTES");
    const controller = new AbortController();
    const reason = new Error("operator cancelled pending reconciliation");
    controller.abort(reason);
    const store = new LocalCapabilityMetadataCandidateStore(projectRoot);

    await expect(store.list(controller.signal)).rejects.toBe(reason);
    await expect(readFile(join(pendingPath, "metadata.json"), "utf8")).resolves.toBe(
      "PRIVATE_PENDING_BYTES",
    );
  });

  it("does not remove a canonical lock whose owner may still be alive", async () => {
    const projectRoot = await projectDirectory();
    const flowDirectory = join(projectRoot, ".flow");
    const lockPath = join(flowDirectory, "packages.metadata.check.lock");
    await mkdir(join(flowDirectory, "packages.metadata.candidates", "sha256"), {
      recursive: true,
    });
    const owner = `${JSON.stringify({ version: 1, hostname: hostname(), pid: process.pid, token: "b".repeat(36) })}\n`;
    await writeFile(lockPath, owner);

    await expect(new LocalCapabilityMetadataCandidateStore(projectRoot).list()).rejects.toEqual(
      new CapabilityMetadataCandidateStoreError("acquire candidate store lock"),
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(owner);
  });

  it("preserves pre-existing cancellation before creating store state", async () => {
    const projectRoot = await projectDirectory();
    const controller = new AbortController();
    const reason = new Error("operator cancelled candidate publication");
    controller.abort(reason);

    await expect(
      new LocalCapabilityMetadataCandidateStore(projectRoot).stage({
        ...stageInput({ metadataVersion: 1 }),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    await expect(stat(join(projectRoot, ".flow"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface StageOptions {
  readonly metadataVersion: number;
  readonly checkedAt?: string;
}

function stageInput(options: StageOptions) {
  return stageInputWithBundle({
    ...options,
    sigstoreBundle: Buffer.from(`PRIVATE_SIGSTORE_PROOF_${options.metadataVersion}`),
  });
}

function stageInputWithBundle(options: StageOptions & { readonly sigstoreBundle: Buffer }) {
  const metadata = metadataBytes(options.metadataVersion);
  const sigstoreBundle = Buffer.from(options.sigstoreBundle);
  const authority = {
    kind: "sigstore-keyless-v0.3" as const,
    ...authenticatedAuthority,
    signatureBundleDigest: digest(sigstoreBundle),
  };
  const parsed = parseCapabilityMetadata(metadata, now);
  return {
    candidate: createCapabilityMetadataCandidate({
      metadata: parsed,
      metadataBytes: metadata,
      sigstoreBundle,
      authority,
    }),
    metadata,
    sigstoreBundle,
    observation: {
      apiVersion: "flow.synapti.ai/v1alpha1" as const,
      kind: "CapabilityMetadataCheckObservation" as const,
      checkedAt: options.checkedAt ?? "2026-08-14T00:00:00.000Z",
      channel: "https://metadata.example.test/flow/capability-metadata.json",
      envelopeBytes: 4096,
      envelopeDigest: `sha256:${"e".repeat(64)}`,
    },
  };
}

function metadataBytes(version: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: {
        name: "project-capabilities",
        version,
        expiresAt: "2026-08-15T00:00:00.000Z",
      },
      spec: {
        targets: [
          {
            name: "review-suite",
            version: "1.0.0",
            digest: `sha256:${"a".repeat(64)}`,
            bytes: 4096,
            source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
            status: "active",
          },
        ],
      },
    }),
  );
}

function candidateFile(projectRoot: string, candidateDigest: string, fileName: string): string {
  return join(candidateDirectory(projectRoot, candidateDigest), fileName);
}

function candidateDirectory(projectRoot: string, candidateDigest: string): string {
  return join(
    projectRoot,
    ".flow",
    "packages.metadata.candidates",
    "sha256",
    candidateDigest.slice("sha256:".length),
  );
}

function digest(source: Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-capability-metadata-candidates-"));
  temporaryDirectories.push(directory);
  return directory;
}
