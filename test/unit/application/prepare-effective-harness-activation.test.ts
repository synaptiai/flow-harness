import { describe, expect, it } from "vitest";

import { prepareEffectiveHarnessActivation } from "../../../src/application/prepare-effective-harness-activation.js";
import {
  effectiveHarnessCandidateArtifactFixture,
  modelRoutingEffectiveHarnessCandidateArtifactFixture,
  superiorEffectiveHarnessEvaluation,
} from "../../fixtures/effective-harness-evaluation.js";

describe("effective harness activation preparation", () => {
  it("binds one superior complete evaluation to the exact artifact and state pair", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const stored = superiorEffectiveHarnessEvaluation(artifact);

    const prepared = prepareEffectiveHarnessActivation({ artifact, stored });

    expect(prepared).toEqual({
      artifact,
      evaluation: {
        id: stored.header.evaluationId,
        planDigest: stored.header.planDigest,
        terminalRecordDigest: stored.records.at(-1)?.recordDigest,
        reportDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("requires the exact paired routes for a model-routing activation", () => {
    const artifact = modelRoutingEffectiveHarnessCandidateArtifactFixture();
    const stored = superiorEffectiveHarnessEvaluation(artifact);

    expect(prepareEffectiveHarnessActivation({ artifact, stored }).artifact).toEqual(artifact);

    const changed = structuredClone(stored);
    const changedRoutes = changed.header.controls.modelRoutes;
    if (changedRoutes === undefined) throw new Error("routing evaluation has no routes");
    changedRoutes[1].route = {
      ...changedRoutes[1].route,
      id: "private-substitute-model",
    };
    expect(() => prepareEffectiveHarnessActivation({ artifact, stored: changed })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
    const missing = structuredClone(stored);
    delete missing.header.controls.modelRoutes;
    expect(() => prepareEffectiveHarnessActivation({ artifact, stored: missing })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );

    const ordinaryArtifact = effectiveHarnessCandidateArtifactFixture();
    const ordinaryStored = structuredClone(superiorEffectiveHarnessEvaluation(ordinaryArtifact));
    ordinaryStored.header.controls.modelRoutes = stored.header.controls.modelRoutes;
    expect(() =>
      prepareEffectiveHarnessActivation({
        artifact: ordinaryArtifact,
        stored: ordinaryStored,
      }),
    ).toThrowError(expect.objectContaining({ code: "identity_mismatch" }));
  });

  it.each([
    "artifactDigest",
    "baselineStateDigest",
    "candidateStateDigest",
    "baselineHeadDigest",
    "candidateDigest",
  ] as const)("rejects an independent %s substitution", (field) => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const stored = structuredClone(superiorEffectiveHarnessEvaluation(artifact));
    const baseline = stored.header.profiles[0];
    const candidate = stored.header.profiles[1];
    if (baseline?.adapter !== "flow-workflow-v1" || candidate?.adapter !== "flow-workflow-v1") {
      throw new Error("effective harness evaluation fixture is incomplete");
    }
    const replacement = "9".repeat(64);
    if (field === "artifactDigest") {
      if (baseline.effectiveHarness !== undefined)
        baseline.effectiveHarness.artifactDigest = replacement;
    } else if (field === "baselineStateDigest") {
      if (baseline.effectiveHarness !== undefined)
        baseline.effectiveHarness.stateDigest = replacement;
    } else if (field === "candidateStateDigest") {
      if (candidate.effectiveHarness !== undefined)
        candidate.effectiveHarness.stateDigest = replacement;
    } else if (field === "baselineHeadDigest") {
      if (candidate.effectiveHarness !== undefined)
        candidate.effectiveHarness.baselineHeadDigest = replacement;
    } else if (candidate.effectiveHarness !== undefined) {
      candidate.effectiveHarness.candidateDigest = replacement;
    }

    expect(() => prepareEffectiveHarnessActivation({ artifact, stored })).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it("rejects incomplete and non-superior evaluations", () => {
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const incomplete = superiorEffectiveHarnessEvaluation(artifact);

    expect(() =>
      prepareEffectiveHarnessActivation({
        artifact,
        stored: { ...incomplete, records: incomplete.records.slice(0, -1) },
      }),
    ).toThrowError(expect.objectContaining({ code: "evaluation_incomplete" }));
    expect(() =>
      prepareEffectiveHarnessActivation({
        artifact,
        stored: superiorEffectiveHarnessEvaluation(artifact, false),
      }),
    ).toThrowError(expect.objectContaining({ code: "evaluation_not_superior" }));
  });
});
