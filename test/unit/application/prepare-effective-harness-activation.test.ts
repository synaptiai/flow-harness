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

    const legacy = structuredClone(stored) as MutableStoredEvaluation;
    delete requiredBinding(legacy, 0).workflowId;
    delete requiredBinding(legacy, 1).workflowId;
    expect(prepareEffectiveHarnessActivation({ artifact, stored: legacy }).artifact).toEqual(
      artifact,
    );
  });

  it("requires the exact paired routes for a model-routing activation", () => {
    const artifact = modelRoutingEffectiveHarnessCandidateArtifactFixture();
    const stored = superiorEffectiveHarnessEvaluation(artifact);

    expect(prepareEffectiveHarnessActivation({ artifact, stored }).artifact).toEqual(artifact);
    const mutations: readonly ((value: MutableStoredEvaluation) => void)[] = [
      (value) => {
        requiredBinding(value, 0).workflowId = "private-workflow";
      },
      (value) => {
        requiredBinding(value, 1).workflowId = "private-workflow";
      },
      (value) => {
        requiredRoutes(value)[0].profileId = "private-profile";
      },
      (value) => {
        requiredRoutes(value)[1].profileId = "private-profile";
      },
      (value) => {
        requiredRoutes(value)[0].nodeId = "private-node";
      },
      (value) => {
        requiredRoutes(value)[1].nodeId = "private-node";
      },
      ...([0, 1] as const).flatMap((routeIndex) =>
        (["provider", "id", "thinking"] as const).map(
          (field) => (value: MutableStoredEvaluation) => {
            const route = requiredRoutes(value)[routeIndex].route;
            if (field === "thinking") {
              route.thinking = "xhigh";
            } else {
              route[field] = `private-${field}`;
            }
          },
        ),
      ),
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(stored) as MutableStoredEvaluation;
      mutate(changed);
      const error = (() => {
        try {
          prepareEffectiveHarnessActivation({ artifact, stored: changed });
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: "identity_mismatch" });
      expect((error as Error).message).toBe(
        "identity_mismatch: effective harness evaluation does not match its candidate artifact",
      );
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toContain("private-");
    }
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

type MutableStoredEvaluation = DeepMutable<ReturnType<typeof superiorEffectiveHarnessEvaluation>>;

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly []
    ? []
    : Value extends readonly [infer First, infer Second]
      ? [DeepMutable<First>, DeepMutable<Second>]
      : Value extends readonly (infer Item)[]
        ? DeepMutable<Item>[]
        : Value extends object
          ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
          : Value;

function requiredRoutes(value: MutableStoredEvaluation) {
  const routes = value.header.controls.modelRoutes;
  if (routes === undefined) throw new Error("routing evaluation has no routes");
  return routes;
}

function requiredBinding(value: MutableStoredEvaluation, index: 0 | 1) {
  const profile = value.header.profiles[index];
  if (profile?.adapter !== "flow-workflow-v1" || profile.effectiveHarness === undefined) {
    throw new Error("routing evaluation has no effective harness binding");
  }
  return profile.effectiveHarness;
}
