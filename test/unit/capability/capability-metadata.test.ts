import { describe, expect, it } from "vitest";

import {
  CapabilityMetadataError,
  MAX_CAPABILITY_METADATA_BYTES,
  MAX_CAPABILITY_METADATA_TARGETS,
  parseCapabilityMetadata,
} from "../../../src/domain/capability/capability-metadata.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const EXPIRES_AT = "2026-08-15T00:00:00.000Z";

describe("capability metadata", () => {
  it("parses and freezes one canonical active HTTPS target before expiry", () => {
    const parsed = parseCapabilityMetadata(metadataBytes(), NOW);

    expect(parsed).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityMetadata",
      name: "project-capabilities",
      version: 1,
      expiresAt: EXPIRES_AT,
      bytes: expect.any(Number),
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
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
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.targets)).toBe(true);
    expect(Object.isFrozen(parsed.targets[0])).toBe(true);
  });

  it("binds an exact publisher policy to a canonical HTTPS target", () => {
    const fixture = metadataFixture();
    const target = fixture.spec.targets[0] as MetadataTargetFixture;
    target.publisher = publisherPolicy();

    expect(parseCapabilityMetadata(Buffer.from(JSON.stringify(fixture)), NOW)).toMatchObject({
      targets: [
        {
          source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
          publisher: publisherPolicy(),
        },
      ],
    });
  });

  it("rejects metadata at its exact expiry instant", () => {
    expect(() => parseCapabilityMetadata(metadataBytes(), new Date(EXPIRES_AT))).toThrowError(
      new CapabilityMetadataError("validate freshness"),
    );
  });

  it("rejects an invalid trusted clock at the fixed freshness stage", () => {
    expect(() => parseCapabilityMetadata(metadataBytes(), new Date(Number.NaN))).toThrowError(
      new CapabilityMetadataError("validate freshness"),
    );
  });

  it("rejects a non-canonical JSON encoding", () => {
    const source = Buffer.from(`${metadataBytes().toString("utf8")}\n`);

    expect(() => parseCapabilityMetadata(source, NOW)).toThrowError(
      new CapabilityMetadataError("validate metadata"),
    );
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["one byte over", Buffer.alloc(MAX_CAPABILITY_METADATA_BYTES + 1, 0x61)],
    ["fatal UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s input with a fixed parse stage", (_label, source) => {
    expectClosedFailure(source, "parse metadata");
  });

  it("accepts canonical metadata at the exact byte boundary", () => {
    const source = exactBoundaryMetadataBytes();

    expect(source.byteLength).toBe(MAX_CAPABILITY_METADATA_BYTES);
    expect(parseCapabilityMetadata(source, NOW)).toMatchObject({
      name: "project-capabilities",
      version: 1,
      bytes: MAX_CAPABILITY_METADATA_BYTES,
    });
  });

  it.each([
    [
      "unknown top-level field",
      (value: MetadataFixture) => Object.assign(value, { private: true }),
    ],
    [
      "non-canonical expiry",
      (value: MetadataFixture) => {
        value.metadata.expiresAt = "2026-08-15T00:00:00Z";
      },
    ],
    [
      "duplicate target identity",
      (value: MetadataFixture) => {
        value.spec.targets.push(structuredClone(value.spec.targets[0] as MetadataTargetFixture));
      },
    ],
    [
      "unsorted target identity",
      (value: MetadataFixture) => {
        value.spec.targets.unshift({
          ...(structuredClone(value.spec.targets[0]) as MetadataTargetFixture),
          name: "z-last",
        });
      },
    ],
    [
      "OCI target without a publisher policy",
      (value: MetadataFixture) => {
        (value.spec.targets[0] as MetadataTargetFixture).source =
          `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
      },
    ],
    [
      "HTTPS target with an empty query delimiter",
      (value: MetadataFixture) => {
        (value.spec.targets[0] as MetadataTargetFixture).source =
          "https://packages.example.test/review-suite-1.0.0.flowpkg?";
      },
    ],
    [
      "HTTPS target with an empty fragment delimiter",
      (value: MetadataFixture) => {
        (value.spec.targets[0] as MetadataTargetFixture).source =
          "https://packages.example.test/review-suite-1.0.0.flowpkg#";
      },
    ],
    [
      "OCI target publisher identity beyond the UTF-8 byte bound",
      (value: MetadataFixture) => {
        const target = value.spec.targets[0] as MetadataTargetFixture;
        target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
        target.publisher = {
          certificateIssuer: "https://token.actions.githubusercontent.com/",
          certificateIdentity: "😀".repeat(1_025),
        };
      },
    ],
    [
      "OCI target publisher identity containing an escaped lone surrogate",
      (value: MetadataFixture) => {
        const target = value.spec.targets[0] as MetadataTargetFixture;
        target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
        target.publisher = {
          certificateIssuer: "https://token.actions.githubusercontent.com/",
          certificateIdentity: "PRIVATE_\ud800_IDENTITY",
        };
      },
    ],
    [
      "OCI target publisher identity containing an escaped lone low surrogate",
      (value: MetadataFixture) => {
        const target = value.spec.targets[0] as MetadataTargetFixture;
        target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
        target.publisher = {
          certificateIssuer: "https://token.actions.githubusercontent.com/",
          certificateIdentity: "PRIVATE_\udc00_IDENTITY",
        };
      },
    ],
  ])("rejects %s with a fixed validation stage", (_label, mutate) => {
    const value = metadataFixture();
    mutate(value);

    expectClosedFailure(Buffer.from(JSON.stringify(value)), "validate metadata");
  });

  it("accepts one exact OCI target with its publisher policy", () => {
    const value = metadataFixture();
    const target = value.spec.targets[0] as MetadataTargetFixture;
    target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
    target.publisher = publisherPolicy();

    expect(parseCapabilityMetadata(Buffer.from(JSON.stringify(value)), NOW).targets[0]).toEqual({
      ...target,
      publisher: publisherPolicy(),
    });
  });

  it("accepts an empty target set as an explicit deny-all authority", () => {
    const value = metadataFixture();
    value.spec.targets = [];

    expect(parseCapabilityMetadata(Buffer.from(JSON.stringify(value)), NOW)).toMatchObject({
      name: "project-capabilities",
      version: 1,
      targets: [],
    });
  });

  it("accepts the exact target-count boundary and rejects one target beyond it", () => {
    const value = metadataFixture();
    value.spec.targets = Array.from({ length: MAX_CAPABILITY_METADATA_TARGETS }, (_, index) => {
      const name = `target-${index.toString().padStart(4, "0")}`;
      return {
        name,
        version: "1.0.0",
        digest: `sha256:${index.toString(16).padStart(64, "0")}`,
        bytes: 1,
        source: `https://packages.example.test/${name}.flowpkg`,
        status: "active" as const,
      };
    });

    expect(parseCapabilityMetadata(Buffer.from(JSON.stringify(value)), NOW).targets).toHaveLength(
      MAX_CAPABILITY_METADATA_TARGETS,
    );
    value.spec.targets.push({
      name: "target-overflow",
      version: "1.0.0",
      digest: `sha256:${"f".repeat(64)}`,
      bytes: 1,
      source: "https://packages.example.test/target-overflow.flowpkg",
      status: "active",
    });
    expectClosedFailure(Buffer.from(JSON.stringify(value)), "validate metadata");
  });

  it("accepts exact numeric, source, and publisher boundaries", () => {
    const value = metadataFixture();
    value.metadata.version = Number.MAX_SAFE_INTEGER;
    const httpsTarget = value.spec.targets[0] as MetadataTargetFixture;
    httpsTarget.bytes = 4 * 1024 * 1024;
    const sourcePrefix = "https://packages.example.test/";
    httpsTarget.source = `${sourcePrefix}${"s".repeat(4_096 - sourcePrefix.length)}`;
    const ociTarget: MetadataTargetFixture = {
      name: "z-publisher-boundary",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`,
      bytes: 1,
      source: `registry.example.test/flow/z-publisher-boundary@sha256:${"c".repeat(64)}`,
      status: "active",
      publisher: {
        certificateIssuer: `${"https://issuer.example.test/"}${"i".repeat(2_048 - "https://issuer.example.test/".length)}`,
        certificateIdentity: "p".repeat(4_096),
      },
    };
    value.spec.targets.push(ociTarget);

    expect(parseCapabilityMetadata(Buffer.from(JSON.stringify(value)), NOW)).toMatchObject({
      version: Number.MAX_SAFE_INTEGER,
      targets: [
        { bytes: 4 * 1024 * 1024, source: httpsTarget.source },
        { publisher: ociTarget.publisher },
      ],
    });
  });

  it.each([
    ["metadata version", (value: MetadataFixture) => (value.metadata.version = 2 ** 53)],
    [
      "target bytes",
      (value: MetadataFixture) =>
        ((value.spec.targets[0] as MetadataTargetFixture).bytes = 4 * 1024 * 1024 + 1),
    ],
    [
      "target source",
      (value: MetadataFixture) => {
        const prefix = "https://packages.example.test/";
        (value.spec.targets[0] as MetadataTargetFixture).source =
          `${prefix}${"s".repeat(4_097 - prefix.length)}`;
      },
    ],
    [
      "publisher issuer",
      (value: MetadataFixture) => {
        const target = value.spec.targets[0] as MetadataTargetFixture;
        target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
        const prefix = "https://issuer.example.test/";
        target.publisher = {
          certificateIssuer: `${prefix}${"i".repeat(2_049 - prefix.length)}`,
          certificateIdentity: "publisher",
        };
      },
    ],
    [
      "publisher identity",
      (value: MetadataFixture) => {
        const target = value.spec.targets[0] as MetadataTargetFixture;
        target.source = `registry.example.test/flow/review-suite@sha256:${"b".repeat(64)}`;
        target.publisher = {
          certificateIssuer: "https://issuer.example.test/",
          certificateIdentity: "p".repeat(4_097),
        };
      },
    ],
  ])("rejects one value beyond the %s boundary", (_label, mutate) => {
    const value = metadataFixture();
    mutate(value);
    expectClosedFailure(Buffer.from(JSON.stringify(value)), "validate metadata");
  });
});

function metadataBytes(): Buffer {
  return Buffer.from(JSON.stringify(metadataFixture()));
}

function exactBoundaryMetadataBytes(): Buffer {
  const value = metadataFixture();
  value.spec.targets = Array.from({ length: 128 }, (_, index) => {
    const name = `target-${index.toString().padStart(4, "0")}`;
    return {
      name,
      version: "1.0.0",
      digest: `sha256:${index.toString(16).padStart(64, "0")}`,
      bytes: 1,
      source: `https://packages.example.test/${name}.flowpkg`,
      status: "active" as const,
    };
  });
  let remaining = MAX_CAPABILITY_METADATA_BYTES - Buffer.byteLength(JSON.stringify(value));
  for (const target of value.spec.targets) {
    const available = 4_096 - target.source.length;
    const padding = Math.min(remaining, available);
    target.source += "x".repeat(padding);
    remaining -= padding;
  }
  if (remaining !== 0) {
    throw new Error("metadata fixture cannot reach the exact byte boundary");
  }
  return Buffer.from(JSON.stringify(value));
}

interface MetadataTargetFixture {
  name: string;
  version: string;
  digest: string;
  bytes: number;
  source: string;
  status: "active" | "revoked";
  publisher?: { certificateIssuer: string; certificateIdentity: string };
}

interface MetadataFixture {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: number; expiresAt: string };
  spec: { targets: MetadataTargetFixture[] };
  private?: boolean;
}

function metadataFixture(): MetadataFixture {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityMetadata",
    metadata: {
      name: "project-capabilities",
      version: 1,
      expiresAt: EXPIRES_AT,
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
  };
}

function publisherPolicy() {
  return {
    certificateIssuer: "https://token.actions.githubusercontent.com/",
    certificateIdentity:
      "https://github.com/synaptiai/flow-harness/.github/workflows/release.yml@refs/tags/v1.0.0",
  } as const;
}

function expectClosedFailure(
  source: Buffer,
  stage: ConstructorParameters<typeof CapabilityMetadataError>[0],
): void {
  let caught: unknown;
  try {
    parseCapabilityMetadata(source, NOW);
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new CapabilityMetadataError(stage));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
