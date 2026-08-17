import { describe, expect, it } from "vitest";

import {
  agentSkillPackageActivationWorkflow,
  createAgentSkillPackageActivationSnapshot,
  parseAgentSkillPackageActivationSnapshot,
} from "../../../src/domain/adaptation/agent-skill-package-activation.js";
import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  agentSkillPackageActivationFixture,
  agentSkillPackageEvaluationProof,
} from "../../fixtures/agent-skill-package-activation.js";

describe("Agent Skill package activation snapshots", () => {
  it("stores an exact generated package and a package-free rollback state", () => {
    const fixture = agentSkillPackageActivationFixture();
    const candidate = createAgentSkillPackageActivationSnapshot({
      selection: "candidate",
      candidate: fixture.projected.identity,
      evaluation: agentSkillPackageEvaluationProof(),
      workflowSource: fixture.projected.workflow.source,
      skill: fixture.completed.package,
    });
    const baseline = createAgentSkillPackageActivationSnapshot({
      selection: "baseline",
      candidate: fixture.projected.identity,
      evaluation: agentSkillPackageEvaluationProof(),
      workflowSource: fixture.prompt.baselineText,
    });

    expect(parseAgentSkillPackageActivationSnapshot(structuredClone(candidate))).toEqual(candidate);
    expect(parseAgentSkillPackageActivationSnapshot(structuredClone(baseline))).toEqual(baseline);
    expect(candidate).toMatchObject({
      kind: "agent-skill-package-activation",
      selection: "candidate",
      workflowId: "adaptive-workflow",
      skill: { name: "review-helper", digest: fixture.completed.package.digest },
    });
    expect(baseline).not.toHaveProperty("skill");
    expect(agentSkillPackageActivationWorkflow(candidate)).toBe(fixture.projected.workflow.source);
    expect(agentSkillPackageActivationWorkflow(baseline)).toBe(fixture.prompt.baselineText);

    const candidateCapability = validateCapabilitySnapshot({
      version: 1,
      packages: [fixture.completed.package],
      activations: [candidate],
      digest: calculateCapabilitySnapshotDigest([fixture.completed.package], [candidate]),
    });
    const baselineCapability = validateCapabilitySnapshot({
      version: 1,
      packages: [],
      activations: [baseline],
      digest: calculateCapabilitySnapshotDigest([], [baseline]),
    });
    expect(candidateCapability.packages).toHaveLength(1);
    expect(baselineCapability.packages).toHaveLength(0);
  });

  it("rejects a package on the baseline and a missing candidate package", () => {
    const fixture = agentSkillPackageActivationFixture();
    const candidate = createAgentSkillPackageActivationSnapshot({
      selection: "candidate",
      candidate: fixture.projected.identity,
      evaluation: agentSkillPackageEvaluationProof(),
      workflowSource: fixture.projected.workflow.source,
      skill: fixture.completed.package,
    });
    const baseline = createAgentSkillPackageActivationSnapshot({
      selection: "baseline",
      candidate: fixture.projected.identity,
      evaluation: agentSkillPackageEvaluationProof(),
      workflowSource: fixture.prompt.baselineText,
    });
    expect(() =>
      parseAgentSkillPackageActivationSnapshot({
        ...baseline,
        skill: fixture.completed.package,
      }),
    ).toThrow();
    expect(() =>
      parseAgentSkillPackageActivationSnapshot({ ...candidate, skill: undefined }),
    ).toThrow();
  });
});
