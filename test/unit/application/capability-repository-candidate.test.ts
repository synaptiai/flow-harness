import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CapabilityRepositoryCandidateError,
  createCapabilityRepositoryCandidate,
  encodeCapabilityRepositoryCandidateIdentity,
  parseCapabilityRepositoryCandidateIdentityRecord,
  toPublicCapabilityRepositoryCandidate,
} from "../../../src/application/capability-repository-candidate.js";
import {
  type CreatedCapabilityBundleSource,
  createCapabilityBundleSource,
} from "../../../src/domain/capability/capability-bundles.js";
import {
  encodeCapabilityRepositoryIndex,
  parseCapabilityRepositoryIndex,
} from "../../../src/domain/capability/capability-repository.js";
import { encodeSignedCapabilityBundleEnvelope } from "../../../src/domain/capability/signed-capability-bundle-envelope.js";

const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
});
const targetPath = "flow/packages/review-suite/1.0.0.flowpkg.json";
const targetSource =
  "https://packages.example.test/targets/7f/7fd4c3.review-suite-1.0.0.flowpkg.json";

describe("capability repository candidate", () => {
  it("cross-binds repository, target, package, and publisher evidence", () => {
    const fixture = candidateFixture();

    const candidate = createCapabilityRepositoryCandidate(fixture.input);

    expect(candidate.identity).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityRepositoryCandidate",
      candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      repository: {
        stateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        metadata: fixture.input.repositoryMetadata,
      },
      index: {
        path: "flow/capability-index.json",
        bytes: fixture.input.index.bytes,
        digest: fixture.input.index.digest,
      },
      target: {
        path: targetPath,
        source: targetSource,
        length: fixture.envelope.byteLength,
        hashes: { sha256: sha256Hex(fixture.envelope) },
      },
      envelope: {
        bytes: fixture.envelope.byteLength,
        digest: digest(fixture.envelope),
        capabilityBundleBytes: fixture.bundle.content.byteLength,
        sigstoreBundleBytes: fixture.sigstoreBundle.byteLength,
      },
      bundle: {
        name: "review-suite",
        version: "1.0.0",
        bytes: fixture.bundle.content.byteLength,
        digest: fixture.bundle.bundle.digest,
      },
      publisher: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: digest(fixture.sigstoreBundle),
      },
    });
    expect(candidate.envelopeBytes()).toEqual(fixture.envelope);
    expect(candidate.capabilityBundleBytes()).toEqual(fixture.bundle.content);
    expect(candidate.sigstoreBundleBytes()).toEqual(fixture.sigstoreBundle);
    const mutableRead = candidate.capabilityBundleBytes();
    mutableRead.fill(0);
    expect(candidate.capabilityBundleBytes()).toEqual(fixture.bundle.content);
    expect(Object.isFrozen(candidate.identity)).toBe(true);
  });

  it("projects value-free review evidence without source URLs or package bytes", () => {
    const fixture = candidateFixture();
    const candidate = createCapabilityRepositoryCandidate(fixture.input);

    const publicCandidate = toPublicCapabilityRepositoryCandidate(candidate);
    const output = JSON.stringify(publicCandidate);

    expect(publicCandidate.target).toEqual({
      path: targetPath,
      length: fixture.envelope.byteLength,
      hashes: { sha256: sha256Hex(fixture.envelope) },
    });
    expect(output).not.toContain("packages.example.test");
    expect(output).not.toContain(fixture.bundle.content.toString("base64"));
    expect(output).not.toContain(fixture.sigstoreBundle.toString("base64"));
    expect(output).not.toContain("contentBase64");
  });

  it("round-trips one canonical bounded candidate identity record", () => {
    const candidate = createCapabilityRepositoryCandidate(candidateFixture().input);

    const encoded = encodeCapabilityRepositoryCandidateIdentity(candidate.identity);
    const reopened = parseCapabilityRepositoryCandidateIdentityRecord(encoded);

    expect(reopened).toEqual(candidate.identity);
    expect(Object.isFrozen(reopened)).toBe(true);
    expect(() =>
      parseCapabilityRepositoryCandidateIdentityRecord(Buffer.from(`${encoded}\n`)),
    ).toThrowError(new CapabilityRepositoryCandidateError("validate candidate identity"));
  });

  it("rejects a self-digest mutation in a candidate identity record", () => {
    const candidate = createCapabilityRepositoryCandidate(candidateFixture().input);
    const mutated = { ...candidate.identity, candidateDigest: `sha256:${"0".repeat(64)}` };

    expect(() =>
      parseCapabilityRepositoryCandidateIdentityRecord(Buffer.from(JSON.stringify(mutated))),
    ).toThrowError(new CapabilityRepositoryCandidateError("validate candidate identity"));
  });

  it.each([
    ["index name", (input: CandidateInputFixture) => (input.entry.name = "PRIVATE_OTHER")],
    ["index version", (input: CandidateInputFixture) => (input.entry.version = "2.0.0")],
    [
      "index target path",
      (input: CandidateInputFixture) => (input.entry.targetPath = `${targetPath}.x`),
    ],
    ["target path", (input: CandidateInputFixture) => (input.target.path = `${targetPath}.x`)],
    [
      "target source",
      (input: CandidateInputFixture) => (input.target.source = "https://PRIVATE.example.test/"),
    ],
    ["target length", (input: CandidateInputFixture) => (input.target.length += 1)],
    [
      "target digest",
      (input: CandidateInputFixture) => (input.target.hashes.sha256 = "0".repeat(64)),
    ],
    [
      "extra target hash",
      (input: CandidateInputFixture) => (input.target.hashes.sha512 = "0".repeat(128)),
    ],
    [
      "custom name",
      (input: CandidateInputFixture) => (input.target.custom.flow.name = "PRIVATE_OTHER"),
    ],
    [
      "custom version",
      (input: CandidateInputFixture) => (input.target.custom.flow.version = "2.0.0"),
    ],
    [
      "custom issuer",
      (input: CandidateInputFixture) =>
        (input.target.custom.flow.publisher.certificateIssuer = "https://private.example.test/"),
    ],
    [
      "custom identity",
      (input: CandidateInputFixture) =>
        (input.target.custom.flow.publisher.certificateIdentity = "PRIVATE_IDENTITY"),
    ],
    [
      "verified issuer",
      (input: CandidateInputFixture) =>
        (input.authority.certificateIssuer = "https://private.example.test/"),
    ],
    [
      "verified identity",
      (input: CandidateInputFixture) => (input.authority.certificateIdentity = "PRIVATE_IDENTITY"),
    ],
    [
      "signature bundle digest",
      (input: CandidateInputFixture) =>
        (input.authority.signatureBundleDigest = digest(Buffer.from("other"))),
    ],
    [
      "repository metadata order",
      (input: CandidateInputFixture) => input.repositoryMetadata.reverse(),
    ],
  ])("rejects a contradictory %s with one closed stage", (_label, mutate) => {
    const fixture = candidateFixture();
    mutate(fixture.input);

    let caught: unknown;
    try {
      createCapabilityRepositoryCandidate(fixture.input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryCandidateError("validate candidate evidence"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });
});

interface CandidateInputFixture {
  repositoryMetadata: {
    name: string;
    length: number;
    digest: `sha256:${string}`;
  }[];
  index: ReturnType<typeof parseCapabilityRepositoryIndex>;
  entry: { name: string; version: string; targetPath: string };
  target: {
    path: string;
    source: string;
    length: number;
    hashes: Record<string, string>;
    custom: {
      flow: {
        apiVersion: string;
        kind: string;
        name: string;
        version: string;
        publisher: { certificateIssuer: string; certificateIdentity: string };
      };
    };
    content: Buffer;
  };
  authority: {
    kind: "sigstore-keyless-v0.3";
    certificateIssuer: string;
    certificateIdentity: string;
    signatureBundleDigest: string;
  };
}

function candidateFixture(): {
  input: CandidateInputFixture;
  bundle: CreatedCapabilityBundleSource;
  sigstoreBundle: Buffer;
  envelope: Buffer;
} {
  const bundle = capabilityBundleFixture();
  const sigstoreBundle = Buffer.from("PRIVATE_SIGSTORE_BUNDLE");
  const envelope = encodeSignedCapabilityBundleEnvelope({
    capabilityBundle: bundle.content,
    sigstoreBundle,
  });
  const index = parseCapabilityRepositoryIndex(
    encodeCapabilityRepositoryIndex({
      packages: [{ name: bundle.bundle.name, version: bundle.bundle.version, targetPath }],
    }),
  );
  return {
    bundle,
    sigstoreBundle,
    envelope,
    input: {
      repositoryMetadata: [
        { name: "1.snapshot.json", length: 100, digest: digest(Buffer.from("snapshot")) },
        { name: "1.targets.json", length: 200, digest: digest(Buffer.from("targets")) },
        { name: "root.json", length: 300, digest: digest(Buffer.from("root")) },
        { name: "timestamp.json", length: 400, digest: digest(Buffer.from("timestamp")) },
      ],
      index,
      entry: { ...requireOnlyIndexEntry(index) },
      target: {
        path: targetPath,
        source: targetSource,
        length: envelope.byteLength,
        hashes: { sha256: sha256Hex(envelope) },
        custom: {
          flow: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            kind: "CapabilityPackageTarget",
            name: bundle.bundle.name,
            version: bundle.bundle.version,
            publisher: { ...policy },
          },
        },
        content: envelope,
      },
      authority: {
        kind: "sigstore-keyless-v0.3",
        ...policy,
        signatureBundleDigest: digest(sigstoreBundle),
      },
    },
  };
}

function capabilityBundleFixture(): CreatedCapabilityBundleSource {
  return createCapabilityBundleSource({
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
}

function requireOnlyIndexEntry(index: ReturnType<typeof parseCapabilityRepositoryIndex>): {
  readonly name: string;
  readonly version: string;
  readonly targetPath: string;
} {
  const [entry] = index.packages;
  if (entry === undefined || index.packages.length !== 1) {
    throw new Error("candidate fixture requires one index entry");
  }
  return entry;
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(content)}`;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
