import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type CapabilityMetadataCandidate,
  CapabilityMetadataCandidateError,
  createCapabilityMetadataCandidate,
  encodeCapabilityMetadataCandidate,
  MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES,
  parseCapabilityMetadataCandidate,
} from "../../../src/application/capability-metadata-candidate.js";
import { parseCapabilityMetadata } from "../../../src/domain/capability/capability-metadata.js";

const now = new Date("2026-08-14T00:00:00.000Z");
const policy = Object.freeze({
  certificateIssuer: "https://token.actions.githubusercontent.com/",
  certificateIdentity:
    "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/metadata-v1",
});

describe("capability metadata candidate", () => {
  it("creates and round-trips one canonical content-addressed identity", () => {
    const input = candidateInput();
    const candidate = createCapabilityMetadataCandidate(input);
    const encoded = encodeCapabilityMetadataCandidate(candidate);

    expect(candidate).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadataCandidate",
      candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      metadata: {
        name: "project-capabilities",
        version: 1,
        digest: input.metadata.digest,
        targets: [{ name: "review-suite", version: "1.0.0" }],
      },
      sigstoreBundle: {
        bytes: input.sigstoreBundle.byteLength,
        digest: input.authority.signatureBundleDigest,
      },
      authority: policy,
    });
    expect(parseCapabilityMetadataCandidate(encoded)).toEqual(candidate);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.metadata.targets)).toBe(true);
  });

  it("does not include observation time or channel in candidate identity", () => {
    const first = createCapabilityMetadataCandidate(candidateInput());
    const second = createCapabilityMetadataCandidate(candidateInput());

    expect(second.candidateDigest).toBe(first.candidateDigest);
  });

  it("accepts an exact one-mebibyte canonical record and rejects one additional byte", () => {
    const exact = candidateRecordAtBound(0);
    const encoded = encodeCapabilityMetadataCandidate(exact);

    expect(encoded).toHaveLength(MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES);
    expect(parseCapabilityMetadataCandidate(encoded)).toEqual(exact);
    expectClosedFailure(
      () => encodeCapabilityMetadataCandidate(candidateRecordAtBound(1)),
      "validate candidate record",
    );
  });

  it("changes the digest for every authoritative identity family", () => {
    const baseline = createCapabilityMetadataCandidate(candidateInput()).candidateDigest;
    const cases = [
      candidateInput({ metadataVersion: 2 }),
      candidateInput({ targetStatus: "revoked" }),
      candidateInput({ sigstoreBundle: Buffer.from("different proof bytes") }),
      candidateInput({ certificateIssuer: "https://issuer.example.test/" }),
      candidateInput({ certificateIdentity: "https://publisher.example.test/other" }),
    ];

    for (const input of cases) {
      expect(createCapabilityMetadataCandidate(input).candidateDigest).not.toBe(baseline);
    }
  });

  it.each([
    [
      "metadata byte mismatch",
      () => ({ ...candidateInput(), metadataBytes: Buffer.from("PRIVATE_METADATA_SUBSTITUTE") }),
    ],
    [
      "bundle digest mismatch",
      () => ({
        ...candidateInput(),
        authority: {
          ...candidateInput().authority,
          signatureBundleDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ],
  ])("rejects %s with a fixed input stage", (_label, createInput) => {
    expectClosedFailure(
      () => createCapabilityMetadataCandidate(createInput()),
      "validate candidate input",
    );
  });

  it("rejects review metadata that was not derived from the exact authenticated bytes", () => {
    const input = candidateInput();

    expectClosedFailure(
      () =>
        createCapabilityMetadataCandidate({
          ...input,
          metadata: { ...input.metadata, version: input.metadata.version + 1 },
        }),
      "validate candidate input",
    );
  });

  it.each([
    [
      "non-canonical record",
      (encoded: Buffer) => Buffer.from(`${encoded.toString("utf8")}\n`),
      "validate candidate record" as const,
    ],
    [
      "unknown field",
      (encoded: Buffer) =>
        Buffer.from(
          JSON.stringify({
            ...(JSON.parse(encoded.toString("utf8")) as object),
            privateCanary: "PRIVATE_UNKNOWN",
          }),
        ),
      "validate candidate record" as const,
    ],
    [
      "candidate digest substitution",
      (encoded: Buffer) => {
        const value = JSON.parse(encoded.toString("utf8")) as { candidateDigest: string };
        value.candidateDigest = `sha256:${"0".repeat(64)}`;
        return Buffer.from(JSON.stringify(value));
      },
      "validate candidate record" as const,
    ],
    [
      "duplicate JSON key",
      (encoded: Buffer) =>
        Buffer.from(
          encoded
            .toString("utf8")
            .replace(
              '"kind":"CapabilityMetadataCandidate",',
              '"kind":"CapabilityMetadataCandidate","kind":"PRIVATE_DUPLICATE",',
            ),
        ),
      "parse candidate record" as const,
    ],
  ])("rejects %s with a fixed private record stage", (_label, mutate, stage) => {
    const encoded = encodeCapabilityMetadataCandidate(
      createCapabilityMetadataCandidate(candidateInput()),
    );
    expectClosedFailure(() => parseCapabilityMetadataCandidate(mutate(encoded)), stage);
  });
});

type CandidateStage = ConstructorParameters<typeof CapabilityMetadataCandidateError>[0];

interface CandidateOptions {
  readonly metadataVersion?: number;
  readonly targetStatus?: "active" | "revoked";
  readonly sigstoreBundle?: Buffer;
  readonly certificateIssuer?: string;
  readonly certificateIdentity?: string;
}

function candidateInput(options: CandidateOptions = {}) {
  const metadataBytes = Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      metadata: {
        name: "project-capabilities",
        version: options.metadataVersion ?? 1,
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
            status: options.targetStatus ?? "active",
          },
        ],
      },
    }),
  );
  const sigstoreBundle = options.sigstoreBundle ?? Buffer.from("PRIVATE_SIGSTORE_PROOF");
  const certificateIssuer = options.certificateIssuer ?? policy.certificateIssuer;
  const certificateIdentity = options.certificateIdentity ?? policy.certificateIdentity;
  return {
    metadata: parseCapabilityMetadata(metadataBytes, now),
    metadataBytes,
    sigstoreBundle,
    authority: {
      kind: "sigstore-keyless-v0.3" as const,
      certificateIssuer,
      certificateIdentity,
      signatureBundleDigest: `sha256:${createHash("sha256").update(sigstoreBundle).digest("hex")}`,
    },
  };
}

function candidateRecordAtBound(extraBytes: 0 | 1): CapabilityMetadataCandidate {
  const targets = Array.from({ length: 1_024 }, (_, index) => ({
    name: `review-${index.toString().padStart(4, "0")}`,
    version: `1.0.${index}`,
    digest: `sha256:${"a".repeat(64)}`,
    bytes: 1,
    source: "https://p.example/",
    status: "active" as const,
  }));
  const identity = {
    metadata: {
      name: "project-capabilities",
      version: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      bytes: 1,
      digest: `sha256:${"b".repeat(64)}`,
      targets,
    },
    sigstoreBundle: { bytes: 1, digest: `sha256:${"c".repeat(64)}` },
    authority: { kind: "sigstore-keyless-v0.3" as const, ...policy },
  };
  const record = (candidateDigest: string) => ({
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "CapabilityMetadataCandidate" as const,
    candidateDigest,
    ...identity,
  });
  let remaining =
    MAX_CAPABILITY_METADATA_CANDIDATE_RECORD_BYTES +
    extraBytes -
    Buffer.byteLength(JSON.stringify(record(`sha256:${"0".repeat(64)}`)));
  for (const target of targets) {
    if (remaining === 0) {
      break;
    }
    const available = 4_096 - Buffer.byteLength(target.source);
    const added = Math.min(remaining, available);
    target.source += "a".repeat(added);
    remaining -= added;
  }
  if (remaining !== 0) {
    throw new Error("candidate boundary fixture could not reach the requested size");
  }
  const candidateDigest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadataCandidateIdentity",
        ...identity,
      }),
    )
    .digest("hex")}`;
  return record(candidateDigest);
}

function expectClosedFailure(operation: () => unknown, stage: CandidateStage): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new CapabilityMetadataCandidateError(stage));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
