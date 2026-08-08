import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { calculateVerifierPackageDigest } from "../../../src/domain/capability/verifier-packages.js";

describe("verifier packages", () => {
  it("creates an immutable capability snapshot containing an exact versioned model package", () => {
    const createSnapshot = createCapabilitySnapshot as unknown as (
      skills: readonly unknown[],
      verifiers: readonly unknown[],
    ) => ReturnType<typeof createCapabilitySnapshot>;
    const source = Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Review evidence.
spec:
  kind: model
  prompt: Reject claims that are not supported by the declared evidence.
`);

    const snapshot = createSnapshot(
      [],
      [
        {
          kind: "verifier-package",
          apiVersion: "flow.synapti.ai/v1alpha1",
          name: "evidence-review",
          version: "1.2.0",
          description: "Review evidence.",
          metadata: {},
          trust: "project-explicit",
          provenance: ".flow/verifiers/evidence-review",
          definition: {
            kind: "model",
            prompt: "Reject claims that are not supported by the declared evidence.",
          },
          manifest: { content: source },
        },
      ],
    );

    expect(snapshot.packages).toEqual([
      expect.objectContaining({
        kind: "verifier-package",
        name: "evidence-review",
        version: "1.2.0",
        manifest: {
          bytes: source.byteLength,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          contentBase64: source.toString("base64"),
        },
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(validateCapabilitySnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot.packages[0])).toBe(true);
  });

  it("rejects a digest-valid snapshot whose exact manifest disagrees with its parsed definition", () => {
    const createSnapshot = createCapabilitySnapshot as unknown as (
      skills: readonly unknown[],
      verifiers: readonly unknown[],
    ) => ReturnType<typeof createCapabilitySnapshot>;
    const original = createSnapshot(
      [],
      [
        {
          kind: "verifier-package",
          apiVersion: "flow.synapti.ai/v1alpha1",
          name: "review",
          version: "1.0.0",
          description: "Review evidence.",
          trust: "project-explicit",
          provenance: ".flow/verifiers/review",
          definition: { kind: "model", prompt: "Original rubric." },
          manifest: {
            content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: review, version: 1.0.0, description: Review evidence. }
spec: { kind: model, prompt: Original rubric. }
`),
          },
        },
      ],
    );
    const originalPackage = original.packages[0];
    if (originalPackage?.kind !== "verifier-package") {
      throw new Error("verifier package fixture was not created");
    }
    const changedSource = Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: review, version: 1.0.0, description: Review evidence. }
spec: { kind: model, prompt: Changed rubric. }
`);
    const manifest = {
      bytes: changedSource.byteLength,
      sha256: hash(changedSource),
      contentBase64: changedSource.toString("base64"),
    };
    const changed = { ...originalPackage, manifest };
    const forgedPackage = { ...changed, digest: calculateVerifierPackageDigest(changed) };
    const packages = [forgedPackage];
    const forged = {
      ...original,
      packages,
      digest: calculateCapabilitySnapshotDigest(packages),
    };

    expect(() => validateCapabilitySnapshot(forged)).toThrow(/manifest.*definition|disagrees/i);
  });
});

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
