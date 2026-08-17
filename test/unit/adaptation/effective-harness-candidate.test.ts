import { describe, expect, it } from "vitest";

import { projectEffectiveHarnessCandidate } from "../../../src/application/prepare-effective-harness-candidate.js";
import {
  calculateEffectiveHarnessCandidateDigest,
  createEffectiveHarnessCandidateArtifact,
  EffectiveHarnessCandidateError,
  parseEffectiveHarnessCandidateArtifact,
} from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  calculateEffectiveHarnessStateDigest,
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { agentSkillPackageActivationFixture } from "../../fixtures/agent-skill-package-activation.js";

const scopeDigest = "a".repeat(64);

describe("effective harness candidate artifacts", () => {
  it("stores one exact baseline head, complete state pair, and reviewed candidate", () => {
    const fixture = agentSkillPackageActivationFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-package",
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const baselineHead = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 4,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    });

    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead,
      baselineState: baseline,
      candidateState: projected.state,
      candidate: fixture.projected.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      version: 1,
      kind: "effective-harness-candidate",
      scopeDigest,
      workflowId: baseline.workflowId,
      surface: "agent-skill-package",
      candidate: {
        kind: "agent-skill-package-candidate",
        candidateDigest: fixture.projected.identity.candidateDigest,
      },
      baselineHead,
      baselineState: { stateDigest: baseline.stateDigest },
      candidateState: { stateDigest: projected.state.stateDigest },
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it("rejects a redigested candidate state that contradicts the reviewed package", () => {
    const fixture = agentSkillPackageActivationFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-package",
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const artifact = structuredClone(
      createEffectiveHarnessCandidateArtifact({
        baselineHead: createEffectiveHarnessHeadIdentity({
          scopeDigest,
          workflowId: baseline.workflowId,
          generation: 1,
          activationDigest: "b".repeat(64),
          transitionDigest: "c".repeat(64),
          stateDigest: baseline.stateDigest,
        }),
        baselineState: baseline,
        candidateState: projected.state,
        candidate: fixture.projected.identity,
      }),
    );
    const original = fixture.completed.package;
    const replacement = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: original.name,
        description: original.description,
        ...(original.license === undefined ? {} : { license: original.license }),
        ...(original.compatibility === undefined ? {} : { compatibility: original.compatibility }),
        metadata: original.metadata,
        requestedTools: original.requestedTools,
        trust: original.trust,
        provenance: original.provenance,
        files: [{ path: "SKILL.md", content: Buffer.from("# Substituted\n") }],
      },
    ]).packages[0];
    if (replacement === undefined) {
      throw new Error("replacement fixture is missing");
    }
    const mutableState = artifact.candidateState as unknown as {
      packages: typeof artifact.candidateState.packages;
      stateDigest: string;
    };
    mutableState.packages = [replacement];
    mutableState.stateDigest = calculateEffectiveHarnessStateDigest(artifact.candidateState);
    (artifact as unknown as { artifactDigest: string }).artifactDigest =
      calculateEffectiveHarnessCandidateDigest(artifact);

    expect(() => parseEffectiveHarnessCandidateArtifact(artifact)).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessCandidateError>>({
        code: "surface_mismatch",
      }),
    );
  });

  it("rejects baseline-head and scope substitution without a private cause", () => {
    const fixture = agentSkillPackageActivationFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-package",
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 1,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: projected.state,
      candidate: fixture.projected.identity,
    });

    for (const mutate of [
      (value: MutableCandidateArtifact) => {
        (value.baselineHead as unknown as { stateDigest: string }).stateDigest = "d".repeat(64);
      },
      (value: MutableCandidateArtifact) => {
        (value as unknown as { scopeDigest: string }).scopeDigest = "e".repeat(64);
      },
    ]) {
      const changed = structuredClone(artifact);
      mutate(changed);
      (changed as unknown as { artifactDigest: string }).artifactDigest =
        calculateEffectiveHarnessCandidateDigest(changed);
      const error = (() => {
        try {
          parseEffectiveHarnessCandidateArtifact(changed);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(EffectiveHarnessCandidateError);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

type MutableCandidateArtifact = ReturnType<typeof createEffectiveHarnessCandidateArtifact>;
