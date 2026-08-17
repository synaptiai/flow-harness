import { describe, expect, it } from "vitest";

import {
  CapabilityRepositoryError,
  encodeCapabilityRepositoryIndex,
  MAX_CAPABILITY_REPOSITORY_INDEX_ENTRIES,
  parseCapabilityPackageTargetCustom,
  parseCapabilityRepositoryIndex,
} from "../../../src/domain/capability/capability-repository.js";

describe("capability repository domain", () => {
  it("round-trips one canonical sorted capability index", () => {
    const source = encodeCapabilityRepositoryIndex({
      packages: [
        {
          name: "review-suite",
          version: "1.0.0",
          targetPath: "flow/packages/review-suite/1.0.0.flowpkg.json",
        },
        {
          name: "review-suite",
          version: "2.0.0",
          targetPath: "flow/packages/review-suite/2.0.0.flowpkg.json",
        },
      ],
    });

    const parsed = parseCapabilityRepositoryIndex(source);

    expect(parsed).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityRepositoryIndex",
      bytes: source.byteLength,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      packages: [
        {
          name: "review-suite",
          version: "1.0.0",
          targetPath: "flow/packages/review-suite/1.0.0.flowpkg.json",
        },
        {
          name: "review-suite",
          version: "2.0.0",
          targetPath: "flow/packages/review-suite/2.0.0.flowpkg.json",
        },
      ],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.packages)).toBe(true);
  });

  it("accepts the exact index entry boundary and rejects one more entry", () => {
    const packages = Array.from({ length: MAX_CAPABILITY_REPOSITORY_INDEX_ENTRIES }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      return {
        name: `package-${suffix}`,
        version: "1.0.0",
        targetPath: `flow/packages/package-${suffix}/1.0.0.flowpkg.json`,
      };
    });

    expect(
      parseCapabilityRepositoryIndex(encodeCapabilityRepositoryIndex({ packages })).packages,
    ).toHaveLength(MAX_CAPABILITY_REPOSITORY_INDEX_ENTRIES);
    expect(() =>
      encodeCapabilityRepositoryIndex({
        packages: [
          ...packages,
          {
            name: "package-overflow",
            version: "1.0.0",
            targetPath: "flow/packages/package-overflow/1.0.0.flowpkg.json",
          },
        ],
      }),
    ).toThrowError(new CapabilityRepositoryError("validate index"));
  });

  it.each([
    ["unknown field", () => ({ ...indexFixture(), privateCanary: "PRIVATE_INDEX" })],
    ["non-canonical bytes", () => Buffer.from(`${JSON.stringify(indexFixture())}\n`)],
    [
      "duplicate package identity",
      () => ({
        ...indexFixture(),
        packages: [indexEntry(), { ...indexEntry(), targetPath: "flow/packages/other.json" }],
      }),
    ],
    [
      "duplicate target path",
      () => ({
        ...indexFixture(),
        packages: [indexEntry(), { ...indexEntry(), name: "z-other" }],
      }),
    ],
    [
      "unsorted entries",
      () => ({
        ...indexFixture(),
        packages: [{ ...indexEntry(), name: "z-last" }, indexEntry()],
      }),
    ],
    [
      "parent target segment",
      () => ({ ...indexFixture(), packages: [{ ...indexEntry(), targetPath: "../private" }] }),
    ],
    [
      "encoded target segment",
      () => ({
        ...indexFixture(),
        packages: [{ ...indexEntry(), targetPath: "flow/%2e%2e/private" }],
      }),
    ],
    [
      "backslash target separator",
      () => ({ ...indexFixture(), packages: [{ ...indexEntry(), targetPath: "flow\\private" }] }),
    ],
  ])("rejects %s with one fixed value-free index stage", (_label, fixture) => {
    const value = fixture();
    const source = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));

    expectClosedIndexFailure(source);
  });

  it("parses and freezes exact package target custom metadata", () => {
    const parsed = parseCapabilityPackageTargetCustom(targetCustomFixture());

    expect(parsed).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityPackageTarget",
      name: "review-suite",
      version: "1.0.0",
      publisher: {
        certificateIssuer: "https://token.actions.githubusercontent.com/",
        certificateIdentity:
          "https://github.com/synaptiai/flow-harness/.github/workflows/publish.yml@refs/tags/v1.0.0",
      },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.publisher)).toBe(true);
  });

  it.each([
    ["missing flow wrapper", () => targetCustomFixture().flow],
    ["unknown wrapper field", () => ({ ...targetCustomFixture(), privateCanary: true })],
    [
      "unknown flow field",
      () => ({
        flow: { ...targetCustomFixture().flow, privateCanary: "PRIVATE_TARGET" },
      }),
    ],
    [
      "non-canonical issuer",
      () => ({
        flow: {
          ...targetCustomFixture().flow,
          publisher: {
            ...targetCustomFixture().flow.publisher,
            certificateIssuer: "https://ISSUER.example.test/",
          },
        },
      }),
    ],
    [
      "private identity control byte",
      () => ({
        flow: {
          ...targetCustomFixture().flow,
          publisher: {
            ...targetCustomFixture().flow.publisher,
            certificateIdentity: "PRIVATE\nIDENTITY",
          },
        },
      }),
    ],
    [
      "private identity lone surrogate",
      () => ({
        flow: {
          ...targetCustomFixture().flow,
          publisher: {
            ...targetCustomFixture().flow.publisher,
            certificateIdentity: "PRIVATE_\ud800_IDENTITY",
          },
        },
      }),
    ],
  ])("rejects %s with one fixed value-free target stage", (_label, fixture) => {
    let caught: unknown;
    try {
      parseCapabilityPackageTargetCustom(fixture());
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new CapabilityRepositoryError("validate target custom metadata"));
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });
});

interface IndexEntryFixture {
  name: string;
  version: string;
  targetPath: string;
}

function indexEntry(): IndexEntryFixture {
  return {
    name: "review-suite",
    version: "1.0.0",
    targetPath: "flow/packages/review-suite/1.0.0.flowpkg.json",
  };
}

function indexFixture(): {
  apiVersion: string;
  kind: string;
  packages: IndexEntryFixture[];
} {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityRepositoryIndex",
    packages: [indexEntry()],
  };
}

function targetCustomFixture(): {
  flow: {
    apiVersion: string;
    kind: string;
    name: string;
    version: string;
    publisher: { certificateIssuer: string; certificateIdentity: string };
  };
} {
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

function expectClosedIndexFailure(source: Buffer): void {
  let caught: unknown;
  try {
    parseCapabilityRepositoryIndex(source);
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new CapabilityRepositoryError("validate index"));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
