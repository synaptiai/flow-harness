import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentSkillCandidateError,
  type AgentSkillCandidateIdentity,
  type AgentSkillCandidateProjectionInput,
  type AgentSkillCandidateSource,
  MAX_AGENT_SKILL_CANDIDATE_BYTES,
  calculateAgentSkillCandidateIdentityDigest,
  parseAgentSkillCandidateIdentity,
  parseAgentSkillCandidateText,
  projectAgentSkillCandidate,
} from "../../../src/domain/adaptation/agent-skill-candidate.js";
import {
  type AgentSkillPackageSnapshot,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { promptCandidateTuningEvidence } from "../../fixtures/prompt-candidate-generation.js";

const baselineSkillText = `---
name: review
description: Review the result against the task.
license: MIT
compatibility: Flow 1.x
metadata:
  owner: synapti
allowed-tools: Read
---
# Review

Check correctness.
`;

const projectedSkillText = baselineSkillText.replace(
  "Check correctness.",
  "Check correctness, security, and evidence.",
);

const baselineWorkflowText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "adaptive-skill-workflow" },
  budget: {
    maxNodeStarts: 2,
    maxModelTokens: 10_000,
    maxCostUsd: 1,
    maxExecutionMs: 300_000,
    maxArtifactBytes: 1_048_576,
  },
  nodes: [
    {
      id: "review",
      type: "agent",
      agent: {
        prompt: "Review TASK.md.",
        model: { provider: "test", id: "deterministic", thinking: "medium" },
        tools: ["read"],
        skills: ["review"],
        toolPackages: [],
        timeoutMs: 300_000,
      },
    },
    {
      id: "publish",
      type: "result",
      dependsOn: ["review"],
      result: {
        source: { nodeId: "review", field: "agent.text" },
        schema: { type: "string", maxLength: 1_024 },
      },
    },
  ],
});

describe("Agent Skill candidates", () => {
  it("parses a strict workflow-scoped resource replacement", () => {
    const source = parseAgentSkillCandidateText(JSON.stringify(candidateSource()));

    expect(source).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AgentSkillCandidate",
      metadata: { id: "better-review", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-skill",
        workflowId: "adaptive-skill-workflow",
        skillName: "review",
      },
      changes: {
        resources: [
          {
            path: "SKILL.md",
            expectedSha256: sha256(baselineSkillText),
            value: projectedSkillText,
          },
        ],
      },
    });
  });

  it("projects only declared bytes and records exact package and capability identities", () => {
    const context = projectionContext();
    const projected = projectAgentSkillCandidate(context);

    expect(projected.workflow).toEqual({
      sourceSha256: sha256(baselineWorkflowText),
      workflowDigest: calculateWorkflowDigest(context.baseline.workflow.compiled),
      compiled: context.baseline.workflow.compiled,
    });
    expect(projected.baselineCapabilitySnapshot.packages).toEqual([context.baseline.skill]);
    expect(projected.candidateCapabilitySnapshot.packages[0]).toMatchObject({
      kind: "agent-skill",
      name: "review",
      description: context.baseline.skill.description,
      metadata: context.baseline.skill.metadata,
      requestedTools: context.baseline.skill.requestedTools,
      trust: context.baseline.skill.trust,
      provenance: context.baseline.skill.provenance,
      files: [
        {
          path: "SKILL.md",
          sha256: sha256(projectedSkillText),
          contentBase64: Buffer.from(projectedSkillText).toString("base64"),
        },
        context.baseline.skill.files[1],
      ],
    });
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "agent-skill-candidate",
      id: "better-review",
      candidateVersion: "1.0.0",
      scope: {
        kind: "workflow-agent-skill",
        workflowId: "adaptive-skill-workflow",
        skillName: "review",
      },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineWorkflowText),
          workflowDigest: calculateWorkflowDigest(context.baseline.workflow.compiled),
        },
        skill: {
          name: "review",
          provenance: ".flow/skills/review",
          packageDigest: context.baseline.skill.digest,
          capabilityDigest: projected.baselineCapabilitySnapshot.digest,
        },
      },
      changes: [
        {
          path: "SKILL.md",
          beforeSha256: sha256(baselineSkillText),
          afterSha256: sha256(projectedSkillText),
        },
      ],
      projectedSkill: {
        packageDigest: projected.candidateCapabilitySnapshot.packages[0]?.digest,
        capabilityDigest: projected.candidateCapabilitySnapshot.digest,
      },
    });
    expect(projected.identity.candidateDigest).toBe(
      calculateAgentSkillCandidateIdentityDigest(withoutCandidateDigest(projected.identity)),
    );
    expect(parseAgentSkillCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
  });

  it.each([
    {
      label: "name",
      mutate: (value: string) => value.replace("name: review", "name: substitute"),
    },
    {
      label: "description",
      mutate: (value: string) =>
        value.replace(
          "description: Review the result against the task.",
          "description: Substituted authority.",
        ),
    },
    {
      label: "license",
      mutate: (value: string) => value.replace("license: MIT", "license: Apache-2.0"),
    },
    {
      label: "compatibility",
      mutate: (value: string) =>
        value.replace("compatibility: Flow 1.x", "compatibility: Another harness"),
    },
    {
      label: "metadata",
      mutate: (value: string) => value.replace("owner: synapti", "owner: substitute"),
    },
    {
      label: "requested tools",
      mutate: (value: string) => value.replace("allowed-tools: Read", "allowed-tools: Read Bash"),
    },
  ])("rejects a SKILL.md replacement that changes $label authority", ({ mutate }) => {
    const context = projectionContext();
    firstResource(context).value = mutate(projectedSkillText);
    refreshCandidateSourceHash(context);

    expect(() => projectAgentSkillCandidate(context)).toThrowError(
      expect.objectContaining({ code: "invalid_projection" }),
    );
  });

  it("rejects missing, binary, stale, and added resource targets", () => {
    const missing = projectionContext();
    firstResource(missing).path = "missing.md";
    refreshCandidateSourceHash(missing);
    expect(() => projectAgentSkillCandidate(missing)).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );

    const stale = projectionContext();
    firstResource(stale).expectedSha256 = "f".repeat(64);
    refreshCandidateSourceHash(stale);
    expect(() => projectAgentSkillCandidate(stale)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );

    const binary = projectionContext();
    const binaryFile = requiredItem(binary.baseline.skill.files, 1, "binary skill file");
    firstResource(binary).path = "assets/binary.dat";
    firstResource(binary).expectedSha256 = binaryFile.sha256;
    refreshCandidateSourceHash(binary);
    expect(() => projectAgentSkillCandidate(binary)).toThrowError(
      expect.objectContaining({ code: "invalid_target" }),
    );

    const added = candidateSource();
    requiredItem(added.changes.resources, 0, "candidate resource").path = "new-resource.md";
    expect(() =>
      projectAgentSkillCandidate({ ...projectionContext(), source: added }),
    ).toThrowError(expect.objectContaining({ code: "invalid_target" }));
  });

  it("rejects workflow, package, evidence, and durable identity substitutions", () => {
    const wrongWorkflow = projectionContext();
    wrongWorkflow.source.scope.workflowId = "other-workflow";
    refreshCandidateSourceHash(wrongWorkflow);
    expect(() => projectAgentSkillCandidate(wrongWorkflow)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );

    const wrongPackage = projectionContext();
    wrongPackage.source.baseline.skill.packageDigest = "f".repeat(64);
    refreshCandidateSourceHash(wrongPackage);
    expect(() => projectAgentSkillCandidate(wrongPackage)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );

    const wrongEvidence = projectionContext();
    requiredItem(wrongEvidence.source.evidence, 0, "candidate evidence").evidenceDigest =
      "f".repeat(64);
    refreshCandidateSourceHash(wrongEvidence);
    expect(() => projectAgentSkillCandidate(wrongEvidence)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );

    const identity = structuredClone(
      projectAgentSkillCandidate(projectionContext()).identity,
    ) as DeepMutable<AgentSkillCandidateIdentity>;
    identity.projectedSkill.packageDigest = "f".repeat(64);
    expect(() => parseAgentSkillCandidateIdentity(identity)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it("keeps parser diagnostics bounded and private", () => {
    const source = candidateSource() as Record<string, unknown>;
    source[`PRIVATE_${"x".repeat(900_000)}`] = true;

    try {
      parseAgentSkillCandidateText(JSON.stringify(source));
      throw new Error("hostile Agent Skill candidate unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSkillCandidateError);
      expect((error as Error).message.length).toBeLessThanOrEqual(8_500);
      expect((error as Error).message).not.toContain("PRIVATE_");
    }
  });

  it("accepts the exact candidate byte bound and rejects one byte above it", () => {
    const source = JSON.stringify(candidateSource());
    const exact = `${source}${" ".repeat(MAX_AGENT_SKILL_CANDIDATE_BYTES - Buffer.byteLength(source))}`;

    expect(parseAgentSkillCandidateText(exact)).toEqual(candidateSource());
    expect(() => parseAgentSkillCandidateText(`${exact} `)).toThrowError(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  });

  it("rejects duplicate evidence and resource targets", () => {
    const duplicateEvidence = candidateSource();
    duplicateEvidence.evidence.push(
      structuredClone(requiredItem(duplicateEvidence.evidence, 0, "candidate evidence")),
    );
    expect(() => parseAgentSkillCandidateText(JSON.stringify(duplicateEvidence))).toThrowError(
      expect.objectContaining({ code: "invalid_schema" }),
    );

    const duplicateResources = candidateSource();
    duplicateResources.changes.resources.push(
      structuredClone(requiredItem(duplicateResources.changes.resources, 0, "candidate resource")),
    );
    expect(() => parseAgentSkillCandidateText(JSON.stringify(duplicateResources))).toThrowError(
      expect.objectContaining({ code: "invalid_schema" }),
    );
  });
});

function projectionContext(): MutableProjectionContext {
  const compiled = compileWorkflowText(baselineWorkflowText, "baseline.workflow.yaml");
  const skill = baselineSkill();
  const evidence = promptCandidateTuningEvidence(calculateWorkflowDigest(compiled));
  const source = candidateSource(skill, calculateWorkflowDigest(compiled), evidence.evidenceDigest);
  return {
    manifestProvenance: "candidate.yaml",
    source,
    sourceSha256: sha256(JSON.stringify(source)),
    baseline: {
      workflow: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineWorkflowText),
        compiled,
      },
      skill,
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        packet: evidence,
      },
    ],
  };
}

function baselineSkill(): AgentSkillPackageSnapshot {
  const snapshot = createCapabilitySnapshot([
    {
      kind: "agent-skill",
      name: "review",
      description: "Review the result against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti" },
      requestedTools: ["Read"],
      trust: "project-explicit",
      provenance: ".flow/skills/review",
      files: [
        { path: "SKILL.md", content: Buffer.from(baselineSkillText) },
        { path: "assets/binary.dat", content: Buffer.from([0, 255, 1, 2]) },
      ],
    },
  ]);
  const skill = snapshot.packages[0];
  if (skill?.kind !== "agent-skill") {
    throw new Error("Agent Skill candidate fixture has no skill package");
  }
  return skill;
}

function candidateSource(
  skill = baselineSkill(),
  workflowDigest = calculateWorkflowDigest(
    compileWorkflowText(baselineWorkflowText, "baseline.workflow.yaml"),
  ),
  evidenceDigest = promptCandidateTuningEvidence(workflowDigest).evidenceDigest,
) {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "AgentSkillCandidate" as const,
    metadata: { id: "better-review", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-skill" as const,
      workflowId: "adaptive-skill-workflow",
      skillName: "review",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineWorkflowText),
        workflowDigest,
      },
      skill: {
        path: ".flow/skills/review",
        packageDigest: skill.digest,
      },
    },
    evidence: [
      {
        path: "tuning.json",
        sourceSha256: sha256(JSON.stringify(promptCandidateTuningEvidence(workflowDigest))),
        evidenceDigest,
        planDigest: "a".repeat(64),
      },
    ],
    changes: {
      resources: [
        {
          path: "SKILL.md",
          expectedSha256: sha256(baselineSkillText),
          value: projectedSkillText,
        },
      ],
    },
  };
}

type MutableProjectionContext = Omit<
  AgentSkillCandidateProjectionInput,
  "source" | "sourceSha256"
> & {
  source: DeepMutable<AgentSkillCandidateSource>;
  sourceSha256: string;
};

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

function refreshCandidateSourceHash(context: MutableProjectionContext): void {
  context.sourceSha256 = sha256(JSON.stringify(context.source));
}

function firstResource(
  context: MutableProjectionContext,
): MutableProjectionContext["source"]["changes"]["resources"][number] {
  return requiredItem(context.source.changes.resources, 0, "candidate resource");
}

function requiredItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`${label} fixture is missing`);
  }
  return item;
}

function withoutCandidateDigest<T extends { candidateDigest: string }>(
  identity: T,
): Omit<T, "candidateDigest"> {
  const { candidateDigest: _candidateDigest, ...content } = identity;
  return content;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
