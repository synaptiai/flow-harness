import { describe, expect, it } from "vitest";

import {
  createArtifactReference,
  MAX_ARTIFACT_BYTES,
  MAX_COMMAND_ARTIFACT_BYTES,
  validateArtifactReference,
} from "../../../src/domain/artifact/reference.js";

describe("artifact references", () => {
  it("keeps in-memory command capture within the generic artifact object bound", () => {
    expect(MAX_COMMAND_ARTIFACT_BYTES).toBe(1024 * 1024);
    expect(MAX_COMMAND_ARTIFACT_BYTES).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
  });

  it("binds one exact descriptor and producer into an opaque reference", () => {
    const reference = createArtifactReference({
      descriptor: {
        digest: `sha256:${"a".repeat(64)}`,
        size: 65_536,
        mediaType: "application/octet-stream",
      },
      producer: producer(),
    });

    expect(reference).toEqual({
      version: 1,
      reference: `artifact:${reference.referenceDigest}`,
      referenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      descriptor: {
        digest: `sha256:${"a".repeat(64)}`,
        size: 65_536,
        mediaType: "application/octet-stream",
      },
      producer: producer(),
      retentionClass: "run",
    });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.isFrozen(reference.descriptor)).toBe(true);
    expect(Object.isFrozen(reference.producer)).toBe(true);
  });

  it("keeps references independent when producers share exact bytes", () => {
    const descriptor = {
      digest: `sha256:${"b".repeat(64)}`,
      size: 40_000,
      mediaType: "application/octet-stream",
    } as const;
    const left = createArtifactReference({ descriptor, producer: producer() });
    const right = createArtifactReference({
      descriptor,
      producer: { ...producer(), runId: "run-right" },
    });

    expect(left.descriptor).toEqual(right.descriptor);
    expect(left.reference).not.toBe(right.reference);
    expect(left.referenceDigest).not.toBe(right.referenceDigest);
  });

  it("accepts exact zero and maximum artifact byte bounds", () => {
    for (const size of [0, MAX_ARTIFACT_BYTES]) {
      expect(
        createArtifactReference({
          descriptor: {
            digest: `sha256:${"c".repeat(64)}`,
            size,
            mediaType: "application/octet-stream",
          },
          producer: producer(),
        }).descriptor.size,
      ).toBe(size);
    }
  });

  it("accepts exact producer and media type bounds and rejects plus one", () => {
    const exactIdentity = "r".repeat(256);
    const exactMediaType = `${"a".repeat(63)}/${"b".repeat(63)}`;
    expect(
      createArtifactReference({
        descriptor: {
          digest: `sha256:${"c".repeat(64)}`,
          size: 1,
          mediaType: exactMediaType,
        },
        producer: { ...producer(), runId: exactIdentity },
      }),
    ).toMatchObject({
      descriptor: { mediaType: exactMediaType },
      producer: { runId: exactIdentity },
    });

    expect(() =>
      createArtifactReference({
        descriptor: {
          digest: `sha256:${"c".repeat(64)}`,
          size: 1,
          mediaType: `${"a".repeat(64)}/${"b".repeat(63)}`,
        },
        producer: producer(),
      }),
    ).toThrow();
    expect(() =>
      createArtifactReference({
        descriptor: {
          digest: `sha256:${"c".repeat(64)}`,
          size: 1,
          mediaType: exactMediaType,
        },
        producer: { ...producer(), runId: `${exactIdentity}r` },
      }),
    ).toThrow();
  });

  it.each([
    ["oversized bytes", { descriptor: { size: MAX_ARTIFACT_BYTES + 1 } }],
    ["invalid digest", { descriptor: { digest: `sha512:${"d".repeat(64)}` } }],
    ["invalid media type", { descriptor: { mediaType: "text/plain; private=canary" } }],
    ["invalid attempt", { producer: { attempt: 0 } }],
    ["invalid stream", { producer: { stream: "private" } }],
    ["unsafe producer text", { producer: { runId: "private\nrun" } }],
  ])("rejects %s", (_name, mutation) => {
    const input = {
      descriptor: {
        digest: `sha256:${"d".repeat(64)}`,
        size: 32_769,
        mediaType: "application/octet-stream",
        ...("descriptor" in mutation ? mutation.descriptor : {}),
      },
      producer: { ...producer(), ...("producer" in mutation ? mutation.producer : {}) },
    };

    expect(() => createArtifactReference(input as never)).toThrow();
  });

  it("rejects changed and extended persisted references", () => {
    const original = createArtifactReference({
      descriptor: {
        digest: `sha256:${"e".repeat(64)}`,
        size: 50_000,
        mediaType: "application/octet-stream",
      },
      producer: producer(),
    });

    expect(() =>
      validateArtifactReference({
        ...structuredClone(original),
        descriptor: { ...original.descriptor, size: original.descriptor.size + 1 },
      }),
    ).toThrow("artifact reference digest does not match its exact content");
    expect(() =>
      validateArtifactReference({ ...structuredClone(original), private: "canary" }),
    ).toThrow();
    expect(() =>
      validateArtifactReference({
        ...structuredClone(original),
        reference: `artifact:${"f".repeat(64)}`,
      }),
    ).toThrow("artifact reference does not match its digest");
  });
});

function producer() {
  return {
    kind: "agent-command" as const,
    runId: "run-left",
    workflowId: "workflow",
    nodeId: "agent",
    attempt: 1,
    commandId: "command-7",
    commandSequence: 2,
    stream: "stdout" as const,
  };
}
