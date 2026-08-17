import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CapabilityRepositoryCandidate } from "../../../src/application/capability-repository-candidate.js";
import { toPublicCapabilityRepositoryCandidate } from "../../../src/application/capability-repository-candidate.js";
import {
  CapabilityRepositoryCheckError,
  type CapabilityRepositoryCheckPublisher,
  type CapabilityRepositoryCheckSession,
  createCapabilityRepositoryChecker,
} from "../../../src/application/check-capability-repository.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import { encodeCapabilityRepositoryIndex } from "../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../src/domain/capability/signed-capability-bundle-envelope.js";

const checkedAt = new Date("2026-08-17T00:00:00.000Z");
const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
});

describe("capability repository checker", () => {
  it("verifies the complete TUF selection before one inert publication", async () => {
    const events: string[] = [];
    const fixture = repositoryFixture({ events });
    const publish = vi.fn(
      async (input: Parameters<CapabilityRepositoryCheckPublisher["publish"]>[0]) => {
        events.push("publish");
        return {
          status: "staged" as const,
          checkedAt: input.checkedAt,
          candidates: input.candidates.map((candidate: CapabilityRepositoryCandidate) =>
            toPublicCapabilityRepositoryCandidate(candidate),
          ),
        };
      },
    );
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now: () => new Date(checkedAt),
    });

    const result = await checker.check({});

    expect(events).toEqual([
      "refresh",
      "index",
      "package",
      "complete",
      "verify",
      "publish",
      "release",
    ]);
    expect(result).toMatchObject({
      status: "staged",
      checkedAt: checkedAt.toISOString(),
      candidates: [
        {
          bundle: { name: "review-suite", version: "1.0.0" },
          candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      ],
    });
    expect(fixture.refresh).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fixture.readTarget).toHaveBeenNthCalledWith(
      1,
      "flow/capability-index.json",
      expect.any(AbortSignal),
    );
    expect(fixture.readTarget).toHaveBeenNthCalledWith(
      2,
      fixture.targetPath,
      expect.any(AbortSignal),
    );
    expect(fixture.verify).toHaveBeenCalledWith(
      fixture.capabilityBundle,
      fixture.sigstoreBundle,
      policy,
    );
    const published = publish.mock.calls[0]?.[0];
    expect(published?.checkedAt).toBe(checkedAt.toISOString());
    expect(
      published?.metadata.map(({ name, length, digest }) => ({ name, length, digest })),
    ).toEqual(fixture.metadata.map(({ name, length, digest }) => ({ name, length, digest })));
    expect(published?.metadata.map((file) => file.bytes())).toEqual(
      fixture.metadata.map((file) => file.bytes()),
    );
    expect(published?.index).toEqual({
      path: "flow/capability-index.json",
      length: fixture.indexBytes.byteLength,
      hashes: { sha256: sha256Hex(fixture.indexBytes) },
      bytes: expect.any(Function),
    });
    expect(published?.index.bytes()).toEqual(fixture.indexBytes);
    const publishedIndex = published?.index.bytes();
    publishedIndex?.fill(0);
    expect(published?.index.bytes()).toEqual(fixture.indexBytes);
    expect(published?.signal).toBeInstanceOf(AbortSignal);
    expect(published?.candidates).toHaveLength(1);
    expect(published?.candidates[0]?.identity.candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("publishes nothing when one selected target contradicts the index", async () => {
    const fixture = repositoryFixture({ customName: "PRIVATE_OTHER" });
    const publish = vi.fn();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now: () => new Date(checkedAt),
    });

    let caught: unknown;
    try {
      await checker.check({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryCheckError("verify package targets"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a contradictory index target descriptor before package reads", async () => {
    const fixture = repositoryFixture({ indexLengthDelta: 1 });
    const publish = vi.fn();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({})).rejects.toEqual(
      new CapabilityRepositoryCheckError("read repository index"),
    );
    expect(fixture.readTarget).toHaveBeenCalledOnce();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects an index above candidate capacity before package downloads", async () => {
    const fixture = repositoryFixture({ packageCount: 5 });
    const publish = vi.fn();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({})).rejects.toEqual(
      new CapabilityRepositoryCheckError("read repository index"),
    );
    expect(fixture.readTarget).toHaveBeenCalledOnce();
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves exact cancellation between publisher verifications", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled repository check");
    const fixture = repositoryFixture({
      packageCount: 2,
      afterVerify: () => controller.abort(reason),
    });
    const publish = vi.fn();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({ signal: controller.signal })).rejects.toBe(reason);
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it("preserves publisher-owned settlement failure over late cancellation", async () => {
    const controller = new AbortController();
    const settlement = new Error("fixed repository settlement failure");
    const fixture = repositoryFixture();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({
        publish: vi.fn(async () => {
          controller.abort(new Error("late cancellation"));
          throw settlement;
        }),
      }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({ signal: controller.signal })).rejects.toBe(settlement);
  });

  it("closes a private clock failure before repository refresh", async () => {
    const fixture = repositoryFixture();
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({}),
      now: () => {
        throw new Error("PRIVATE_CLOCK_FAILURE");
      },
    });

    let caught: unknown;
    try {
      await checker.check({});
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryCheckError("complete repository check"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it("rejects a backward clock after verification before repository publication", async () => {
    const fixture = repositoryFixture();
    const publish = vi.fn();
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date(checkedAt))
      .mockReturnValueOnce(new Date(checkedAt.getTime() - 1));
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({ publish }),
      now,
    });

    await expect(checker.check({})).rejects.toEqual(
      new CapabilityRepositoryCheckError("complete repository check"),
    );
    expect(now).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("reports a release failure after an otherwise successful check", async () => {
    const fixture = repositoryFixture({
      release: async () => {
        throw new Error("PRIVATE_RELEASE_FAILURE");
      },
    });
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({
        publish: vi.fn(async (input) => ({
          status: "staged" as const,
          checkedAt: input.checkedAt,
          candidates: input.candidates.map(toPublicCapabilityRepositoryCandidate),
        })),
      }),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({})).rejects.toEqual(
      new CapabilityRepositoryCheckError("complete repository check"),
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves a primary verification error when release also fails", async () => {
    const fixture = repositoryFixture({
      customName: "PRIVATE_OTHER",
      release: async () => {
        throw new Error("PRIVATE_RELEASE_FAILURE");
      },
    });
    const checker = createCapabilityRepositoryChecker({
      refresher: { refresh: fixture.refresh },
      verifier: { verify: fixture.verify },
      publisher: publisher({}),
      now: () => new Date(checkedAt),
    });

    await expect(checker.check({})).rejects.toEqual(
      new CapabilityRepositoryCheckError("verify package targets"),
    );
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});

function publisher(
  overrides: Partial<CapabilityRepositoryCheckPublisher>,
): CapabilityRepositoryCheckPublisher {
  return { publish: vi.fn(), ...overrides } as CapabilityRepositoryCheckPublisher;
}

function repositoryFixture(
  options: {
    readonly events?: string[];
    readonly customName?: string;
    readonly indexLengthDelta?: number;
    readonly packageCount?: number;
    readonly afterVerify?: () => void;
    readonly release?: () => Promise<void>;
  } = {},
) {
  const packageCount = options.packageCount ?? 1;
  const packages = Array.from({ length: packageCount }, (_, index) => {
    const version = `${index + 1}.0.0`;
    const name = packageCount === 1 ? "review-suite" : `review-suite-${index + 1}`;
    const targetPath = `flow/packages/${name}/${version}.flowpkg.json`;
    const capabilityBundle = capabilityBundleBytes(name, version);
    const sigstoreBundle = Buffer.from(`PRIVATE_SIGSTORE_${index}`);
    const envelope = encodeSignedCapabilityBundleEnvelope({ capabilityBundle, sigstoreBundle });
    return { name, version, targetPath, capabilityBundle, sigstoreBundle, envelope };
  });
  const indexBytes = encodeCapabilityRepositoryIndex({
    packages: packages.map(({ name, version, targetPath }) => ({ name, version, targetPath })),
  });
  const metadata = Object.freeze([
    metadataFile("1.snapshot.json", "snapshot"),
    metadataFile("1.targets.json", "targets"),
    metadataFile("root.json", "root"),
    metadataFile("timestamp.json", "timestamp"),
  ]);
  const readTarget = vi.fn(async (path: string) => {
    if (path === "flow/capability-index.json") {
      options.events?.push("index");
      return targetEvidence(path, indexBytes, {}, options.indexLengthDelta ?? 0);
    }
    const selected = packages.find((item) => item.targetPath === path);
    if (selected === undefined) {
      throw new Error("unexpected target path");
    }
    options.events?.push("package");
    return targetEvidence(selected.targetPath, selected.envelope, {
      flow: {
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityPackageTarget",
        name: options.customName ?? selected.name,
        version: selected.version,
        publisher: { ...policy },
      },
    });
  });
  const session: CapabilityRepositoryCheckSession = {
    readTarget,
    complete: vi.fn(async () => {
      options.events?.push("complete");
      return { metadata };
    }),
    release: vi.fn(async () => {
      options.events?.push("release");
      await options.release?.();
    }),
  };
  const refresh = vi.fn(async () => {
    options.events?.push("refresh");
    return session;
  });
  const verify = vi.fn((artifact: Uint8Array, sigstore: Uint8Array) => {
    options.events?.push("verify");
    const selected = packages.find(
      (item) =>
        Buffer.from(artifact).equals(item.capabilityBundle) &&
        Buffer.from(sigstore).equals(item.sigstoreBundle),
    );
    if (selected === undefined) {
      throw new Error("verification received inconsistent bytes");
    }
    options.afterVerify?.();
    return policy;
  });
  const first = requireFirst(packages);
  return {
    refresh,
    readTarget,
    verify,
    release: session.release,
    metadata,
    targetPath: first.targetPath,
    capabilityBundle: first.capabilityBundle,
    sigstoreBundle: first.sigstoreBundle,
    indexBytes,
  };
}

function targetEvidence(
  path: string,
  content: Buffer,
  custom: Record<string, unknown>,
  lengthDelta = 0,
) {
  return Object.freeze({
    path,
    source: `https://packages.example.test/targets/${sha256Hex(content)}.${path.replaceAll("/", ".")}`,
    length: content.byteLength + lengthDelta,
    hashes: Object.freeze({ sha256: sha256Hex(content) }),
    custom: Object.freeze(custom),
    bytes: () => Buffer.from(content),
  });
}

function metadataFile(name: string, content: string) {
  const source = Buffer.from(content);
  return Object.freeze({
    name,
    length: source.byteLength,
    digest: digest(source),
    bytes: () => Buffer.from(source),
  });
}

function capabilityBundleBytes(name: string, version: string): Buffer {
  return createCapabilityBundleSource({
    name,
    version,
    description: "Review one package.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: ${name}
  version: ${version}
  description: Review evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
      },
    ],
  }).content;
}

function requireFirst<T>(values: readonly T[]): T {
  const [value] = values;
  if (value === undefined) {
    throw new Error("fixture requires one package");
  }
  return value;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
