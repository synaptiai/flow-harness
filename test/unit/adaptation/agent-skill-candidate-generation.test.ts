import { describe, expect, it } from "vitest";
import { parseAgentSkillCandidateText } from "../../../src/domain/adaptation/agent-skill-candidate.js";
import {
  type AgentSkillCandidateGenerationUsage,
  completeAgentSkillCandidateGeneration,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS,
  prepareAgentSkillCandidateGeneration,
} from "../../../src/domain/adaptation/agent-skill-candidate-generation.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import {
  parseTuningEvidencePacket,
  type TuningEvidencePacket,
} from "../../../src/domain/evaluation/tuning-evidence.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import {
  agentSkillCandidateGenerationFixture,
  executableScriptCanary,
  selectedResourceText,
  sha256,
  unrelatedResourceCanary,
} from "../../fixtures/agent-skill-candidate-generation.js";
import { promptCandidateTuningEvidence } from "../../fixtures/prompt-candidate-generation.js";

const usage: AgentSkillCandidateGenerationUsage = {
  inputTokens: 120,
  cacheReadTokens: 20,
  cacheWriteTokens: 0,
  outputTokens: 30,
  costUsdMicros: 45,
};

describe("Agent Skill candidate generation", () => {
  it("renders only the selected resource, exact package identity, and tuning evidence", () => {
    const { input } = agentSkillCandidateGenerationFixture();
    const prepared = prepareAgentSkillCandidateGeneration(input);
    const request = JSON.parse(prepared.renderedInput) as Record<string, unknown>;

    expect(request).toMatchObject({
      version: 1,
      kind: "flow.agent-skill-candidate-generation-request/v1",
      baseline: {
        workflowId: "adaptive-skill-workflow",
        sourceSha256: input.baseline.sourceSha256,
        workflowDigest: input.baseline.workflowDigest,
      },
      skill: {
        name: "review",
        packageDigest: input.skill.digest,
        description: input.skill.description,
        license: "MIT",
        compatibility: "Flow 1.x",
        metadata: { owner: "synapti" },
        requestedTools: ["Read"],
        trust: "project-explicit",
      },
      targets: [
        {
          path: "references/checklist.md",
          value: selectedResourceText,
          expectedSha256: sha256(selectedResourceText),
        },
      ],
      evidence: [{ sourceSha256: input.evidence[0]?.sourceSha256 }],
    });
    expect(prepared.requestDigest).toBe(sha256(prepared.renderedInput));
    expect(prepared.renderedInput).not.toContain(unrelatedResourceCanary);
    expect(prepared.renderedInput).not.toContain("references/private.md");
    expect(prepared.renderedInput).not.toContain("baseline.workflow.yaml");
    expect(prepared.renderedInput).not.toContain("tuning.json");
    expect(prepared.renderedInput).not.toContain(input.skill.provenance);
    expect(prepared.renderedInput).not.toContain("Review TASK.md.");
    expect(prepared.renderedInput).not.toContain("Use references/checklist.md.");
    expect(prepared.renderedInput).not.toContain(executableScriptCanary);
  });

  it("creates an ordinary candidate with exact generation provenance", () => {
    const { input } = agentSkillCandidateGenerationFixture();
    const prepared = prepareAgentSkillCandidateGeneration(input);
    const changes = [
      {
        path: "references/checklist.md",
        value: "# Review checklist\n\nCheck correctness, security, and evidence.\n",
      },
    ];
    const candidate = completeAgentSkillCandidateGeneration(
      prepared,
      JSON.stringify({ changes }),
      usage,
    );

    expect(parseAgentSkillCandidateText(JSON.stringify(candidate))).toEqual(candidate);
    expect(candidate).toMatchObject({
      kind: "AgentSkillCandidate",
      metadata: { id: "generated-review", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-skill",
        workflowId: "adaptive-skill-workflow",
        skillName: "review",
      },
      baseline: {
        workflow: {
          path: "baseline.workflow.yaml",
          sourceSha256: input.baseline.sourceSha256,
          workflowDigest: input.baseline.workflowDigest,
        },
        skill: { path: input.skill.provenance, packageDigest: input.skill.digest },
      },
      changes: {
        resources: [
          {
            path: "references/checklist.md",
            expectedSha256: sha256(selectedResourceText),
            value: changes[0]?.value,
          },
        ],
      },
      generation: {
        version: 1,
        kind: "model",
        provider: "test",
        model: "deterministic",
        thinking: "medium",
        requestDigest: prepared.requestDigest,
        targets: [
          { path: "references/checklist.md", expectedSha256: sha256(selectedResourceText) },
        ],
        usage,
      },
    });
  });

  it("rejects unselected, duplicate, unchanged, malformed, missing, and oversized output", () => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    const complete = (value: unknown) =>
      completeAgentSkillCandidateGeneration(prepared, JSON.stringify(value), usage);

    const privateTarget = "PRIVATE_UNSELECTED_RESOURCE.md";
    let privateTargetError: unknown;
    try {
      complete({ changes: [{ path: privateTarget, value: "changed" }] });
    } catch (error) {
      privateTargetError = error;
    }
    expect(privateTargetError).toEqual(
      expect.objectContaining({
        code: "invalid_target",
        message: "invalid_target: model response contains an unselected resource target",
      }),
    );
    expect(privateTargetError).not.toHaveProperty("cause");
    expect((privateTargetError as Error).message).not.toContain(privateTarget);
    expect(() =>
      complete({
        changes: [
          { path: "references/checklist.md", value: "changed once" },
          { path: "references/checklist.md", value: "changed twice" },
        ],
      }),
    ).toThrowError(/invalid model response/);
    expect(() =>
      complete({ changes: [{ path: "references/checklist.md", value: selectedResourceText }] }),
    ).toThrowError(/unchanged resource target/);
    expect(() =>
      complete({ changes: [{ path: "references/checklist.md", value: "\ud800" }] }),
    ).toThrowError(/invalid model response/);
    expect(() => complete({ changes: [] })).toThrowError(/invalid model response/);
    expect(() =>
      complete({ changes: [{ path: "references/checklist.md", value: "x" }], extra: 1 }),
    ).toThrowError(/invalid model response/);
    expect(() =>
      completeAgentSkillCandidateGeneration(
        prepared,
        "x".repeat(MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES + 1),
        usage,
      ),
    ).toThrowError(/response exceeds/);
  });

  it("accepts a valid response at the exact UTF-8 byte limit", () => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    const prefix = '{"changes":[{"path":"references/checklist.md","value":"';
    const suffix = '"}]}';
    const rawResponse = `${prefix}${"x".repeat(
      MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES -
        Buffer.byteLength(prefix, "utf8") -
        Buffer.byteLength(suffix, "utf8"),
    )}${suffix}`;

    expect(Buffer.byteLength(rawResponse, "utf8")).toBe(
      MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
    );
    expect(completeAgentSkillCandidateGeneration(prepared, rawResponse, usage)).toMatchObject({
      changes: {
        resources: [{ path: "references/checklist.md" }],
      },
    });
  });

  it("accepts the exact target and evidence cardinality limits", () => {
    const { input, skill } = agentSkillCandidateGenerationFixture();
    const allResourcePaths = Array.from(
      { length: MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS + 1 },
      (_, index) => `references/generated-${index}.md`,
    );
    const resourcePaths = allResourcePaths.slice(0, MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS);
    const snapshot = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: skill.name,
        description: skill.description,
        ...(skill.license === undefined ? {} : { license: skill.license }),
        ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
        metadata: skill.metadata,
        requestedTools: skill.requestedTools,
        trust: skill.trust,
        provenance: skill.provenance,
        files: [
          ...skill.files.map((file) => ({
            path: file.path,
            content: Buffer.from(file.contentBase64, "base64"),
          })),
          ...allResourcePaths.map((path, index) => ({
            path,
            content: Buffer.from(`resource ${index}\n`),
          })),
        ],
      },
    ]);
    const boundedSkill = snapshot.packages[0];
    if (boundedSkill?.kind !== "agent-skill") {
      throw new Error("cardinality fixture has no Agent Skill package");
    }
    const evidence = Array.from(
      { length: MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE },
      (_, index) => {
        const packet = promptCandidateTuningEvidence(
          input.baseline.workflowDigest,
          `source-evaluation-${index}`,
        );
        return {
          provenance: `tuning-${index}.json`,
          sourceSha256: sha256(JSON.stringify(packet)),
          packet,
        };
      },
    );

    expect(
      prepareAgentSkillCandidateGeneration({
        ...input,
        skill: boundedSkill,
        evidence,
        allowedResourcePaths: resourcePaths,
      }).targets,
    ).toHaveLength(MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        skill: boundedSkill,
        evidence,
        allowedResourcePaths: allResourcePaths,
      }),
    ).toThrowError(/between 1 and 16 unique targets/);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        skill: boundedSkill,
        evidence: [
          ...evidence,
          {
            provenance: "tuning-overflow.json",
            sourceSha256: sha256("overflow"),
            packet: promptCandidateTuningEvidence(
              input.baseline.workflowDigest,
              "source-evaluation-overflow",
            ),
          },
        ],
        allowedResourcePaths: resourcePaths,
      }),
    ).toThrowError(/between 1 and 16 unique evidence files/);
  });

  it("accepts the exact canonical input byte limit and rejects one byte above", () => {
    const { input } = agentSkillCandidateGenerationFixture();
    let selectedTaskCount: number | undefined;
    let addedBytes: number | undefined;
    for (const taskCount of [64, 48, 32]) {
      const evidence = expandedEvidence(input.baseline.workflowDigest, taskCount);
      try {
        const base = prepareAgentSkillCandidateGeneration({ ...input, evidence });
        const remaining =
          MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES -
          Buffer.byteLength(base.renderedInput, "utf8");
        if (remaining >= 0 && remaining <= evidence.length * taskCount * 2 * 510) {
          selectedTaskCount = taskCount;
          addedBytes = remaining;
          break;
        }
      } catch {
        // Try the next smaller valid tuning-evidence shape.
      }
    }
    if (selectedTaskCount === undefined || addedBytes === undefined) {
      throw new Error("input-boundary fixture cannot span the generation request limit");
    }

    const exactEvidence = expandedEvidence(input.baseline.workflowDigest, selectedTaskCount);
    addEvidenceReasonBytes(exactEvidence, addedBytes);
    const overflowEvidence = expandedEvidence(input.baseline.workflowDigest, selectedTaskCount);
    addEvidenceReasonBytes(overflowEvidence, addedBytes + 1);
    const exact = prepareAgentSkillCandidateGeneration({ ...input, evidence: exactEvidence });

    expect(Buffer.byteLength(exact.renderedInput, "utf8")).toBe(
      MAX_AGENT_SKILL_CANDIDATE_GENERATION_INPUT_BYTES,
    );
    expect(() =>
      prepareAgentSkillCandidateGeneration({ ...input, evidence: overflowEvidence }),
    ).toThrowError(/generation input exceeds/);
  });

  it("rejects duplicate or invalid targets and invalid package/workflow identity before execution", () => {
    const { input } = agentSkillCandidateGenerationFixture();

    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        allowedResourcePaths: ["references/checklist.md", "references/checklist.md"],
      }),
    ).toThrowError(/unique targets/);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        allowedResourcePaths: ["missing.md"],
      }),
    ).toThrowError(/selected resource is not an admitted UTF-8 generation target/);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        allowedResourcePaths: ["scripts/check.sh"],
      }),
    ).toThrowError(/selected resource is not an admitted UTF-8 generation target/);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        baseline: { ...input.baseline, workflowDigest: "f".repeat(64) },
      }),
    ).toThrowError(/workflow digest/);
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        skill: { ...input.skill, digest: "f".repeat(64) },
      }),
    ).toThrowError(/package identity/);

    const workflowWithAnotherSkill = {
      ...input.baseline.compiled,
      nodes: input.baseline.compiled.nodes.map((node) =>
        node.type === "agent"
          ? { ...node, agent: { ...node.agent, skills: [...node.agent.skills, "other"] } }
          : node,
      ),
    };
    expect(() =>
      prepareAgentSkillCandidateGeneration({
        ...input,
        baseline: {
          ...input.baseline,
          compiled: workflowWithAnotherSkill,
          workflowDigest: calculateWorkflowDigest(workflowWithAnotherSkill),
        },
      }),
    ).toThrowError(/exactly its scoped Agent Skill/);
  });
});

function expandedEvidence(workflowDigest: string, taskCount: number) {
  return Array.from({ length: MAX_AGENT_SKILL_CANDIDATE_GENERATION_EVIDENCE }, (_, index) => {
    const packet = structuredClone(
      promptCandidateTuningEvidence(workflowDigest, `expanded-evaluation-${index}`),
    ) as DeepMutable<TuningEvidencePacket>;
    const baseTask = requiredItem(packet.tasks, 0, "expanded evidence task");
    packet.tasks = Array.from({ length: taskCount }, (__, taskIndex) => ({
      id: `tune-${taskIndex}`,
      trials: structuredClone(baseTask.trials),
    }));
    packet.evaluation.completedTrials = taskCount * 2;
    packet.evaluation.scheduledTrials = taskCount * 2;
    recomputeEvidenceDigest(packet);
    return {
      provenance: `expanded-${index}.json`,
      sourceSha256: sha256(JSON.stringify(packet)),
      packet,
    };
  });
}

function addEvidenceReasonBytes(
  evidence: ReturnType<typeof expandedEvidence>,
  addedBytes: number,
): void {
  let remaining = addedBytes;
  for (const item of evidence) {
    for (const task of item.packet.tasks) {
      for (const trial of task.trials) {
        if (remaining === 0) {
          break;
        }
        const increment = Math.min(remaining, 510);
        trial.harness.reason = "x".repeat(increment + 2);
        remaining -= increment;
      }
    }
    recomputeEvidenceDigest(item.packet);
    item.sourceSha256 = sha256(JSON.stringify(item.packet));
  }
  if (remaining !== 0) {
    throw new Error("input-boundary fixture has insufficient bounded reason capacity");
  }
}

function recomputeEvidenceDigest(packet: DeepMutable<TuningEvidencePacket>): void {
  const { evidenceDigest: _evidenceDigest, ...content } = packet;
  packet.evidenceDigest = sha256(canonicalize(content));
  parseTuningEvidencePacket(packet);
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("input-boundary fixture contains a non-canonical value");
}

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

function requiredItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`${label} fixture is missing`);
  }
  return item;
}
