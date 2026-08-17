import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AgentSkillPackageCandidateError,
  calculateAgentSkillPackageCandidateIdentityDigest,
  createAgentSkillPackageCandidateSource,
  parseAgentSkillPackageCandidateIdentity,
  parseAgentSkillPackageCandidateText,
  projectAgentSkillPackageCandidate,
} from "../../../src/domain/adaptation/agent-skill-package-candidate.js";
import { completeAgentSkillPackageCandidateGeneration } from "../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
} from "../../fixtures/agent-skill-package-candidate-generation.js";
import { promptCandidateGenerationFixture } from "../../fixtures/prompt-candidate-generation.js";

describe("Agent Skill package candidates", () => {
  it("projects exactly one root agent from no skill to the generated package", () => {
    const generation = agentSkillPackageCandidateGenerationFixture();
    const prompt = promptCandidateGenerationFixture();
    const completed = completeAgentSkillPackageCandidateGeneration(
      generation.prepared,
      agentSkillPackageGenerationResponse,
      {
        inputTokens: 120,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        outputTokens: 30,
        costUsdMicros: 45,
      },
    );
    const source = createAgentSkillPackageCandidateSource(generation.prepared, completed);
    const sourceText = `${JSON.stringify(source, null, 2)}\n`;

    expect(parseAgentSkillPackageCandidateText(sourceText)).toEqual(source);
    expect(source).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AgentSkillPackageCandidate",
      metadata: { id: "generated-review-helper", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-skill-package",
        workflowId: "adaptive-workflow",
        nodeId: "implement",
        skillName: "review-helper",
      },
      package: {
        path: "skill/review-helper",
        packageDigest: completed.package.digest,
      },
    });

    const projected = projectAgentSkillPackageCandidate({
      manifestProvenance: "CANDIDATE.json",
      source,
      sourceSha256: sha256(sourceText),
      baseline: {
        provenance: prompt.input.baseline.provenance,
        source: prompt.input.baseline.source,
        sourceSha256: prompt.input.baseline.sourceSha256,
        compiled: prompt.input.baseline.compiled,
      },
      evidence: prompt.input.evidence,
      package: completed.package,
    });

    const projectedSource = JSON.parse(projected.workflow.source) as {
      nodes: Array<{ id: string; agent?: { skills?: string[] } }>;
    };
    expect(projectedSource.nodes.find((node) => node.id === "implement")?.agent?.skills).toEqual([
      "review-helper",
    ]);
    expect(
      projectedSource.nodes.find((node) => node.id === "private-review")?.agent?.skills,
    ).toEqual([]);
    expect(projected.baselineCapabilitySnapshot).toBeUndefined();
    expect(projected.candidateCapabilitySnapshot.packages).toEqual([completed.package]);
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "agent-skill-package-candidate",
      id: "generated-review-helper",
      candidateVersion: "1.0.0",
      scope: source.scope,
      manifest: { provenance: "CANDIDATE.json", sourceSha256: sha256(sourceText) },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: prompt.input.baseline.sourceSha256,
          workflowDigest: prompt.input.baseline.workflowDigest,
        },
      },
      package: {
        name: "review-helper",
        provenance: "skill/review-helper",
        packageDigest: completed.package.digest,
        capabilityDigest: projected.candidateCapabilitySnapshot.digest,
      },
      selection: { nodeId: "implement", before: [], after: ["review-helper"] },
      projectedWorkflow: {
        sourceSha256: projected.workflow.sourceSha256,
        workflowDigest: projected.workflow.workflowDigest,
      },
    });
    expect(projected.identity.candidateDigest).toBe(
      calculateAgentSkillPackageCandidateIdentityDigest(withoutCandidateDigest(projected.identity)),
    );
    expect(parseAgentSkillPackageCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );

    const restored = structuredClone(projectedSource);
    const restoredTarget = restored.nodes.find((node) => node.id === "implement");
    if (restoredTarget?.agent !== undefined) {
      restoredTarget.agent.skills = [];
    }
    expect(restored).toEqual(prompt.input.baseline.source);
  });

  it("rejects a fully redigested generated package whose bytes contradict generation", () => {
    const fixture = projectionFixture();
    const replacement = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: fixture.completed.package.name,
        description: fixture.completed.package.description,
        license: fixture.completed.package.license,
        compatibility: fixture.completed.package.compatibility,
        metadata: fixture.completed.package.metadata,
        requestedTools: fixture.completed.package.requestedTools,
        trust: fixture.completed.package.trust,
        provenance: fixture.completed.package.provenance,
        files: fixture.completed.package.files.map((file) => ({
          path: file.path,
          content:
            file.path === "references/checklist.md"
              ? Buffer.from("# Substituted\n", "utf8")
              : Buffer.from(file.contentBase64, "base64"),
        })),
      },
    ]).packages[0];
    if (replacement === undefined) {
      throw new Error("replacement package is unavailable");
    }
    const source = {
      ...fixture.source,
      package: { ...fixture.source.package, packageDigest: replacement.digest },
    };

    expect(() =>
      projectAgentSkillPackageCandidate({
        ...fixture.input,
        source,
        package: replacement,
      }),
    ).toThrowError(
      new AgentSkillPackageCandidateError(
        "identity_mismatch",
        "generation response identity does not match the package",
      ),
    );
  });

  it("rejects a parsed baseline source that contradicts the compiled baseline identity", () => {
    const fixture = projectionFixture();
    const source = structuredClone(fixture.input.baseline.source);
    const privateReview = source.nodes.find((node) => node.id === "private-review");
    if (privateReview?.type !== "agent") {
      throw new Error("fixture private review agent is unavailable");
    }
    privateReview.agent.prompt = "PRIVATE_SUBSTITUTED_BASELINE_PROMPT";

    expect(() =>
      projectAgentSkillPackageCandidate({
        ...fixture.input,
        baseline: { ...fixture.input.baseline, source },
      }),
    ).toThrowError(
      new AgentSkillPackageCandidateError(
        "identity_mismatch",
        "candidate baseline workflow identity does not match",
      ),
    );
  });

  it.each([
    [
      "request digest",
      (source: ReturnType<typeof projectionFixture>["source"]) => ({
        ...source,
        generation: { ...source.generation, requestDigest: "f".repeat(64) },
      }),
    ],
    [
      "blueprint digest",
      (source: ReturnType<typeof projectionFixture>["source"]) => ({
        ...source,
        blueprint: { ...source.blueprint, blueprintDigest: "f".repeat(64) },
      }),
    ],
    [
      "package digest",
      (source: ReturnType<typeof projectionFixture>["source"]) => ({
        ...source,
        package: { ...source.package, packageDigest: "f".repeat(64) },
      }),
    ],
  ])("rejects a substituted %s", (_label, mutate) => {
    const fixture = projectionFixture();
    expect(() =>
      projectAgentSkillPackageCandidate({ ...fixture.input, source: mutate(fixture.source) }),
    ).toThrow(AgentSkillPackageCandidateError);
  });

  it("rejects extra manifest fields", () => {
    const fixture = projectionFixture();
    expect(() =>
      parseAgentSkillPackageCandidateText(
        JSON.stringify({ ...fixture.source, PRIVATE_UNKNOWN: "PRIVATE_VALUE" }),
      ),
    ).toThrow(AgentSkillPackageCandidateError);
  });

  it.each([
    [
      "selection node",
      (identity: MutableCandidateIdentity) => {
        identity.selection.nodeId = "other-node";
      },
    ],
    [
      "scope skill",
      (identity: MutableCandidateIdentity) => {
        identity.scope.skillName = "other-skill";
      },
    ],
    [
      "selected skill",
      (identity: MutableCandidateIdentity) => {
        identity.selection.after = ["other-skill"];
      },
    ],
    [
      "package provenance",
      (identity: MutableCandidateIdentity) => {
        identity.package.provenance = "skill/other-skill";
      },
    ],
    [
      "generation blueprint",
      (identity: MutableCandidateIdentity) => {
        identity.generation.blueprintDigest = "f".repeat(64);
      },
    ],
  ])("rejects a redigested %s mismatch", (_label, mutate) => {
    const fixture = projectionFixture();
    const projected = projectAgentSkillPackageCandidate(fixture.input);
    const identity = structuredClone(projected.identity) as unknown as MutableCandidateIdentity;
    mutate(identity);
    identity.candidateDigest = calculateAgentSkillPackageCandidateIdentityDigest(
      withoutCandidateDigest(identity) as unknown as Parameters<
        typeof calculateAgentSkillPackageCandidateIdentityDigest
      >[0],
    );
    expect(() => parseAgentSkillPackageCandidateIdentity(identity)).toThrow(
      AgentSkillPackageCandidateError,
    );
  });
});

type DeepMutable<Value> = Value extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
    : Value;

type MutableCandidateIdentity = DeepMutable<
  ReturnType<typeof projectAgentSkillPackageCandidate>["identity"]
>;

function projectionFixture() {
  const generation = agentSkillPackageCandidateGenerationFixture();
  const prompt = promptCandidateGenerationFixture();
  const completed = completeAgentSkillPackageCandidateGeneration(
    generation.prepared,
    agentSkillPackageGenerationResponse,
    {
      inputTokens: 120,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 30,
      costUsdMicros: 45,
    },
  );
  const source = createAgentSkillPackageCandidateSource(generation.prepared, completed);
  const sourceText = `${JSON.stringify(source, null, 2)}\n`;
  const input = {
    manifestProvenance: "CANDIDATE.json",
    source,
    sourceSha256: sha256(sourceText),
    baseline: {
      provenance: prompt.input.baseline.provenance,
      source: prompt.input.baseline.source,
      sourceSha256: prompt.input.baseline.sourceSha256,
      compiled: prompt.input.baseline.compiled,
    },
    evidence: prompt.input.evidence,
    package: completed.package,
  };
  return { generation, prompt, completed, source, sourceText, input };
}

function withoutCandidateDigest<Identity extends { readonly candidateDigest: string }>(
  identity: Identity,
): Omit<Identity, "candidateDigest"> {
  const { candidateDigest: _candidateDigest, ...content } = identity;
  return content;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
