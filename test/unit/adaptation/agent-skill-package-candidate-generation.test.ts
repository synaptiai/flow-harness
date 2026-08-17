import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type AgentSkillPackageCandidateGenerationError,
  completeAgentSkillPackageCandidateGeneration,
  MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_FILES,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
  parseAgentSkillPackageBlueprintText,
  prepareAgentSkillPackageCandidateGeneration,
} from "../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { parseAgentSkillManifest } from "../../../src/domain/capability/agent-skill-manifest.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
} from "../../fixtures/agent-skill-package-candidate-generation.js";
import { promptCandidateGenerationFixture } from "../../fixtures/prompt-candidate-generation.js";

describe("Agent Skill package candidate generation", () => {
  it("keeps package authority in the blueprint and completes every declared text file", () => {
    const fixture = promptCandidateGenerationFixture();
    const blueprintText = JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AgentSkillPackageBlueprint",
      scope: { workflowId: "adaptive-workflow", nodeId: "implement" },
      skill: {
        name: "review-helper",
        description: "Review an implementation against the task.",
        license: "MIT",
        compatibility: "Flow 1.x",
        metadata: { owner: "synapti", tier: "review" },
        requestedTools: ["Read"],
        trust: "project-explicit",
      },
      files: [
        {
          path: "SKILL.md",
          purpose: "Define the review procedure.",
          guidance: "Write concise instructions grounded in the tuning evidence.",
        },
        {
          path: "references/checklist.md",
          purpose: "Provide the detailed checklist.",
          guidance: "Cover the recurring evidence-backed failure modes.",
        },
        {
          path: "assets/severity.csv",
          purpose: "Map severity names to review action.",
          guidance: "Return a small UTF-8 CSV table.",
        },
      ],
    });
    const blueprint = parseAgentSkillPackageBlueprintText(blueprintText, "package blueprint");
    const prepared = prepareAgentSkillPackageCandidateGeneration({
      candidate: { id: "generated-review-helper", version: "1.0.0" },
      baseline: fixture.input.baseline,
      targetNodeId: "implement",
      blueprint: {
        provenance: "review-helper.blueprint.json",
        sourceSha256: sha256(blueprintText),
        document: blueprint,
      },
      evidence: fixture.input.evidence,
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
    });

    const renderedRequest = JSON.parse(prepared.renderedInput) as Record<string, unknown>;
    expect(renderedRequest).toMatchObject({
      kind: "flow.agent-skill-package-candidate-generation-request/v1",
      baseline: { workflowId: "adaptive-workflow" },
      targetNodeId: "implement",
      blueprint: { skill: { name: "review-helper" } },
    });
    expect(prepared.renderedInput).not.toContain("review-helper.blueprint.json");
    expect(prepared.renderedInput).not.toContain("generated-review-helper");

    const completed = completeAgentSkillPackageCandidateGeneration(
      prepared,
      JSON.stringify({
        files: [
          {
            path: "assets/severity.csv",
            content: "severity,action\nhigh,block\nlow,comment\n",
          },
          {
            path: "SKILL.md",
            content: "# Review helper\n\nRead the checklist and report evidence-backed findings.\n",
          },
          {
            path: "references/checklist.md",
            content: "# Checklist\n\n- Check correctness.\n- Check privacy.\n",
          },
        ],
      }),
      {
        inputTokens: 120,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        outputTokens: 90,
        costUsdMicros: 45,
      },
    );

    expect(completed.package).toMatchObject({
      kind: "agent-skill",
      name: "review-helper",
      description: "Review an implementation against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti", tier: "review" },
      requestedTools: ["Read"],
      trust: "project-explicit",
      provenance: "skill/review-helper",
    });
    expect(completed.package.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/severity.csv",
      "references/checklist.md",
    ]);
    const manifestFile = completed.package.files[0];
    expect(manifestFile).toBeDefined();
    const manifest = parseAgentSkillManifest(
      Buffer.from(manifestFile?.contentBase64 ?? "", "base64"),
      "generated package",
    );
    expect(manifest).toEqual({
      name: "review-helper",
      description: "Review an implementation against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti", tier: "review" },
      requestedTools: ["Read"],
    });
    expect(Buffer.from(manifestFile?.contentBase64 ?? "", "base64").toString("utf8")).toContain(
      "# Review helper",
    );
    expect(completed.generation).toMatchObject({
      kind: "model",
      provider: "test",
      model: "deterministic",
      limits: { candidates: 1, turns: 1, maxOutputTokens: 8_192 },
      targets: [
        { path: "SKILL.md" },
        { path: "assets/severity.csv" },
        { path: "references/checklist.md" },
      ],
    });
  });

  it.each([
    {
      label: "missing SKILL.md",
      mutate: (blueprint: MutableBlueprint) => {
        blueprint.files = blueprint.files.filter((file) => file.path !== "SKILL.md");
      },
    },
    {
      label: "duplicate path",
      mutate: (blueprint: MutableBlueprint) => {
        blueprint.files.push(structuredClone(requiredItem(blueprint.files, 0)));
      },
    },
    {
      label: "script path",
      mutate: (blueprint: MutableBlueprint) => {
        requiredItem(blueprint.files, 1).path = "scripts/check.sh";
      },
    },
    {
      label: "undeclared top-level path",
      mutate: (blueprint: MutableBlueprint) => {
        requiredItem(blueprint.files, 1).path = "NOTES.md";
      },
    },
    {
      label: "binary asset extension",
      mutate: (blueprint: MutableBlueprint) => {
        requiredItem(blueprint.files, 1).path = "assets/private.bin";
      },
    },
    {
      label: "path traversal",
      mutate: (blueprint: MutableBlueprint) => {
        requiredItem(blueprint.files, 1).path = "references/../PRIVATE.md";
      },
    },
    {
      label: "duplicate requested tool",
      mutate: (blueprint: MutableBlueprint) => {
        blueprint.skill.requestedTools = ["Read", "Read"];
      },
    },
    {
      label: "control-bearing guidance",
      mutate: (blueprint: MutableBlueprint) => {
        requiredItem(blueprint.files, 0).guidance = "PRIVATE_GUIDANCE\0";
      },
    },
  ])("rejects a blueprint with $label", ({ mutate }) => {
    const blueprint = validBlueprintSource();
    mutate(blueprint);
    let caught: unknown;
    try {
      parseAgentSkillPackageBlueprintText(JSON.stringify(blueprint), "PRIVATE_BLUEPRINT_PATH");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(
      expect.objectContaining<Partial<AgentSkillPackageCandidateGenerationError>>({
        name: "AgentSkillPackageCandidateGenerationError",
        code: "invalid_blueprint",
        message: "invalid_blueprint: package blueprint is invalid",
      }),
    );
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });

  it("accepts exactly sixteen declared files and rejects the seventeenth", () => {
    const exact = validBlueprintSource();
    exact.files = [
      requiredItem(exact.files, 0),
      ...Array.from(
        { length: MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_FILES - 1 },
        (_, index) => ({
          path: `references/item-${index}.md`,
          purpose: `Reference ${index}`,
          guidance: `Write reference ${index}.`,
        }),
      ),
    ];
    expect(
      parseAgentSkillPackageBlueprintText(JSON.stringify(exact), "package blueprint").files,
    ).toHaveLength(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_FILES);

    exact.files.push({
      path: "references/overflow.md",
      purpose: "Overflow",
      guidance: "This file must be rejected.",
    });
    expect(() =>
      parseAgentSkillPackageBlueprintText(JSON.stringify(exact), "package blueprint"),
    ).toThrowError(/invalid_blueprint/);
  });

  it("enforces the exact serialized blueprint byte boundary", () => {
    const source = JSON.stringify(validBlueprintSource());
    const exact = `${source}${" ".repeat(MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES - source.length)}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES);
    expect(parseAgentSkillPackageBlueprintText(exact, "package blueprint")).toMatchObject({
      kind: "AgentSkillPackageBlueprint",
    });
    expect(() =>
      parseAgentSkillPackageBlueprintText(`${exact} `, "package blueprint"),
    ).toThrowError(/limit_exceeded/);
  });

  it.each([
    {
      label: "missing file",
      response: JSON.stringify({
        files: [{ path: "SKILL.md", content: "# Review\n" }],
      }),
    },
    {
      label: "unknown file",
      response: JSON.stringify({
        files: [
          { path: "SKILL.md", content: "# Review\n" },
          { path: "references/checklist.md", content: "Checklist\n" },
          { path: "references/private.md", content: "PRIVATE_UNKNOWN\n" },
        ],
      }),
    },
    {
      label: "duplicate file",
      response: JSON.stringify({
        files: [
          { path: "SKILL.md", content: "# Review\n" },
          { path: "references/checklist.md", content: "Checklist\n" },
          { path: "references/checklist.md", content: "PRIVATE_DUPLICATE\n" },
        ],
      }),
    },
    {
      label: "control-bearing content",
      response: JSON.stringify({
        files: [
          { path: "SKILL.md", content: "# Review\n" },
          { path: "references/checklist.md", content: "PRIVATE_CONTENT\0" },
        ],
      }),
    },
  ])("rejects a response with $label without disclosing content", ({ response }) => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    let caught: unknown;
    try {
      completeAgentSkillPackageCandidateGeneration(prepared, response, generationUsage());
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(
      expect.objectContaining({
        code: "invalid_output",
      }),
    );
    expect(caught).not.toHaveProperty("cause");
    expect((caught as Error).message).not.toContain("PRIVATE");
  });

  it("enforces the exact response byte boundary across the complete package", () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    const exact = responseWithBytes(MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(
      MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
    );
    expect(
      completeAgentSkillPackageCandidateGeneration(prepared, exact, generationUsage()).package,
    ).toMatchObject({ name: "review-helper" });
    expect(() =>
      completeAgentSkillPackageCandidateGeneration(prepared, `${exact} `, generationUsage()),
    ).toThrowError(/limit_exceeded/);
  });

  it("keeps the canonical ordinary response stable", () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    expect(
      completeAgentSkillPackageCandidateGeneration(
        prepared,
        agentSkillPackageGenerationResponse,
        generationUsage(),
      ).package.files.map((file) => file.path),
    ).toEqual(["SKILL.md", "references/checklist.md"]);
  });
});

type MutableBlueprint = ReturnType<typeof validBlueprintSource>;

function validBlueprintSource() {
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "AgentSkillPackageBlueprint",
    scope: { workflowId: "adaptive-workflow", nodeId: "implement" },
    skill: {
      name: "review-helper",
      description: "Review an implementation against the task.",
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: { owner: "synapti", tier: "review" },
      requestedTools: ["Read"],
      trust: "project-explicit",
    },
    files: [
      {
        path: "SKILL.md",
        purpose: "Define the review procedure.",
        guidance: "Write concise instructions.",
      },
      {
        path: "references/checklist.md",
        purpose: "Provide the detailed checklist.",
        guidance: "Cover recurring evidence-backed failures.",
      },
    ],
  };
}

function generationUsage() {
  return {
    inputTokens: 120,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 90,
    costUsdMicros: 45,
  };
}

function responseWithBytes(bytes: number): string {
  const base = JSON.stringify({
    files: [
      { path: "SKILL.md", content: "" },
      { path: "references/checklist.md", content: "Checklist\n" },
    ],
  });
  const contentBytes = bytes - Buffer.byteLength(base, "utf8");
  if (contentBytes <= 0) {
    throw new Error("response boundary fixture is too small");
  }
  return JSON.stringify({
    files: [
      { path: "SKILL.md", content: "x".repeat(contentBytes) },
      { path: "references/checklist.md", content: "Checklist\n" },
    ],
  });
}

function requiredItem<Item>(items: readonly Item[], index: number): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error("package generation fixture is incomplete");
  }
  return item;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
