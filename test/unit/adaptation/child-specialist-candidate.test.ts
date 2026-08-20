import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_CHILD_SPECIALIST_CANDIDATE_BYTES,
  MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES,
  parseChildSpecialistCandidateIdentity,
  parseChildSpecialistCandidateText,
  projectChildSpecialistCandidate,
} from "../../../src/domain/adaptation/child-specialist-candidate.js";
import {
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

const baselineInstructions = "Review the implementation against the task.";
const candidateInstructions = "Review the implementation and identify unsupported claims.";

const childWorkflowText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "review-specialist" },
  budget: {
    maxNodeStarts: 3,
    maxModelTokens: 10_000,
    maxCostUsd: 1,
    maxExecutionMs: 300_000,
    maxArtifactBytes: 1_048_576,
  },
  nodes: [
    {
      id: "review",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: baselineInstructions,
        model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        tools: ["read"],
        skills: ["review-checklist"],
        toolPackages: [],
        timeoutMs: 300_000,
      },
    },
    {
      id: "security-reference",
      type: "agent",
      dependsOn: ["review"],
      agent: {
        prompt: "Retain the admitted security review capability.",
        model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        tools: ["read"],
        skills: ["security-checklist"],
        toolPackages: [],
        timeoutMs: 300_000,
      },
    },
    {
      id: "publish",
      type: "result",
      dependsOn: ["review", "security-reference"],
      result: {
        source: { nodeId: "review", field: "agent.text" },
        schema: { type: "string", maxLength: 1_024 },
      },
    },
  ],
});

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "specialist-harness" },
  budget: {
    maxNodeStarts: 4,
    maxModelTokens: 20_000,
    maxCostUsd: 2,
    maxExecutionMs: 600_000,
    maxArtifactBytes: 2_097_152,
  },
  nodes: [
    {
      id: "delegate-review",
      type: "child",
      dependsOn: [],
      child: { resultNodeId: "publish", workflow: childWorkflowText },
    },
  ],
});

describe("child-specialist candidates", () => {
  it("projects one instructions change into one embedded child agent", () => {
    const packages = skillPackages();
    const sourceText = candidateText(packages);
    const source = parseChildSpecialistCandidateText(sourceText, "specialist.candidate.yaml");
    const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");

    const projected = projectChildSpecialistCandidate({
      manifestProvenance: "specialist.candidate.yaml",
      sourceSha256: sha256(sourceText),
      source,
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceText: baselineText,
        sourceSha256: sha256(baselineText),
        source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
        compiled,
        packages,
      },
    });

    expect(parseChildSpecialistCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "child-specialist-candidate",
      id: "review-instructions",
      candidateVersion: "1.0.0",
      scope: {
        kind: "workflow-child-specialist",
        workflowId: "specialist-harness",
        childNodeId: "delegate-review",
        agentNodeId: "review",
      },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: calculateWorkflowDigest(compiled),
        },
        child: {
          sourceSha256: sha256(childWorkflowText),
          workflowDigest: childWorkflowDigest(compiled),
        },
        packageClosureDigest: calculateCapabilitySnapshotDigest(packages),
      },
      change: {
        kind: "instructions",
        before: {
          bytes: Buffer.byteLength(baselineInstructions),
          sha256: sha256(baselineInstructions),
        },
        after: {
          bytes: Buffer.byteLength(candidateInstructions),
          sha256: sha256(candidateInstructions),
        },
      },
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const child = projected.workflow.compiled.nodes.find((node) => node.id === "delegate-review");
    expect(child).toMatchObject({
      type: "child",
      child: {
        resultNodeId: "publish",
        workflow: {
          nodes: [
            {
              id: "review",
              type: "agent",
              agent: {
                prompt: candidateInstructions,
                model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
                tools: ["read"],
                skills: ["review-checklist"],
              },
            },
            { id: "security-reference", type: "agent" },
            { id: "publish", type: "result" },
          ],
        },
      },
    });
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("projects one exact selection of already-admitted Agent Skills", () => {
    const packages = skillPackages();
    const sourceText = skillCandidateText(packages);
    const source = parseChildSpecialistCandidateText(sourceText, "specialist.candidate.yaml");
    const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");

    const projected = projectChildSpecialistCandidate({
      manifestProvenance: "specialist.candidate.yaml",
      sourceSha256: sha256(sourceText),
      source,
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceText: baselineText,
        sourceSha256: sha256(baselineText),
        source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
        compiled,
        packages,
      },
    });

    expect(parseChildSpecialistCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
    expect(projected.identity.change).toEqual({
      kind: "skills",
      before: ["review-checklist"],
      after: ["review-checklist", "security-checklist"],
    });
    const child = projected.workflow.compiled.nodes.find((node) => node.id === "delegate-review");
    expect(child).toMatchObject({
      type: "child",
      child: {
        workflow: {
          nodes: [
            {
              id: "review",
              type: "agent",
              agent: {
                prompt: baselineInstructions,
                model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
                tools: ["read"],
                skills: ["review-checklist", "security-checklist"],
              },
            },
            { id: "security-reference", type: "agent" },
            { id: "publish", type: "result" },
          ],
        },
      },
    });
  });

  it("rejects an instructions proposal that does not change the selected child agent", () => {
    const packages = skillPackages();
    const document = JSON.parse(candidateText(packages)) as Record<string, unknown>;
    document.change = {
      kind: "instructions",
      beforeSha256: sha256(baselineInstructions),
      value: baselineInstructions,
    };
    const sourceText = JSON.stringify(document);
    const source = parseChildSpecialistCandidateText(sourceText, "specialist.candidate.yaml");
    const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");

    expect(() =>
      projectChildSpecialistCandidate({
        manifestProvenance: "specialist.candidate.yaml",
        sourceSha256: sha256(sourceText),
        source,
        baseline: {
          provenance: "baseline.workflow.yaml",
          sourceText: baselineText,
          sourceSha256: sha256(baselineText),
          source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
          compiled,
          packages,
        },
      }),
    ).toThrowError(/invalid_projection: child-specialist candidate must change its declared axis/);
  });

  it("rejects blank replacement instructions", () => {
    const packages = skillPackages();
    const document = JSON.parse(candidateText(packages)) as CandidateDocument;
    document.change.value = " \n\t ";

    expect(() =>
      parseChildSpecialistCandidateText(JSON.stringify(document), "specialist.candidate.yaml"),
    ).toThrowError(/invalid_schema:/);
  });

  it("rejects duplicate and no-op Agent Skill selections", () => {
    const packages = skillPackages();
    const duplicate = JSON.parse(skillCandidateText(packages)) as CandidateDocument;
    duplicate.change.after = ["review-checklist", "security-checklist", "security-checklist"];
    expect(() => parseChildSpecialistCandidateText(JSON.stringify(duplicate))).toThrowError(
      /invalid_schema:/,
    );

    const noOp = JSON.parse(skillCandidateText(packages)) as CandidateDocument;
    noOp.change.after = ["review-checklist"];
    expect(() => parseChildSpecialistCandidateText(JSON.stringify(noOp))).toThrowError(
      /invalid_schema:/,
    );
  });

  it.each([
    [
      "parent source",
      (document: CandidateDocument) => (document.baseline.workflow.sourceSha256 = "0".repeat(64)),
    ],
    [
      "parent digest",
      (document: CandidateDocument) => (document.baseline.workflow.workflowDigest = "0".repeat(64)),
    ],
    [
      "child source",
      (document: CandidateDocument) => (document.baseline.child.sourceSha256 = "0".repeat(64)),
    ],
    [
      "child digest",
      (document: CandidateDocument) => (document.baseline.child.workflowDigest = "0".repeat(64)),
    ],
    [
      "package closure",
      (document: CandidateDocument) => (document.baseline.packageClosureDigest = "0".repeat(64)),
    ],
    [
      "workflow target",
      (document: CandidateDocument) => (document.scope.workflowId = "other-harness"),
    ],
    [
      "instructions baseline",
      (document: CandidateDocument) => (document.change.beforeSha256 = "0".repeat(64)),
    ],
  ])("rejects a stale %s identity", (_label, mutate) => {
    const packages = skillPackages();
    const document = JSON.parse(candidateText(packages)) as CandidateDocument;
    mutate(document);
    const sourceText = JSON.stringify(document);

    expect(() => projectSource(sourceText, packages)).toThrowError(/identity_mismatch:/);
  });

  it.each([
    ["child", (document: CandidateDocument) => (document.scope.childNodeId = "missing-child")],
    ["agent", (document: CandidateDocument) => (document.scope.agentNodeId = "missing-agent")],
  ])("rejects a missing %s target", (_label, mutate) => {
    const packages = skillPackages();
    const document = JSON.parse(candidateText(packages)) as CandidateDocument;
    mutate(document);
    const sourceText = JSON.stringify(document);

    expect(() => projectSource(sourceText, packages)).toThrowError(/invalid_target:/);
  });

  it("rejects an Agent Skill outside the admitted package closure", () => {
    const packages = skillPackages();
    const document = JSON.parse(skillCandidateText(packages)) as CandidateDocument;
    document.change.after = ["review-checklist", "unadmitted-checklist"];
    const sourceText = JSON.stringify(document);

    expect(() => projectSource(sourceText, packages)).toThrowError(
      /invalid_target: child-specialist candidate selects an Agent Skill outside the admitted package closure/,
    );
  });

  it("rejects a document that attempts to declare both change axes", () => {
    const packages = skillPackages();
    const document = JSON.parse(skillCandidateText(packages)) as CandidateDocument;
    Object.assign(document.change, {
      beforeSha256: sha256(baselineInstructions),
      value: candidateInstructions,
    });

    expect(() =>
      parseChildSpecialistCandidateText(JSON.stringify(document), "specialist.candidate.yaml"),
    ).toThrowError(/invalid_schema:/);
  });

  it("keeps baseline and replacement instruction contents out of the public identity", () => {
    const packages = skillPackages();
    const projected = projectSource(candidateText(packages), packages);
    const publicIdentity = JSON.stringify(projected.identity);

    expect(publicIdentity).not.toContain(baselineInstructions);
    expect(publicIdentity).not.toContain(candidateInstructions);
    expect(publicIdentity).not.toContain("prompt");
  });

  it("accepts the exact candidate byte limit and rejects one additional byte", () => {
    const packages = skillPackages();
    const sourceText = candidateText(packages);
    const padding = " ".repeat(
      MAX_CHILD_SPECIALIST_CANDIDATE_BYTES - Buffer.byteLength(sourceText),
    );
    const exact = `${sourceText}${padding}`;

    expect(Buffer.byteLength(exact)).toBe(MAX_CHILD_SPECIALIST_CANDIDATE_BYTES);
    expect(parseChildSpecialistCandidateText(exact)).toMatchObject({
      kind: "ChildSpecialistCandidate",
    });
    expect(() => parseChildSpecialistCandidateText(`${exact} `)).toThrowError(/limit_exceeded:/);
  });

  it("measures the exact instructions limit in UTF-8 bytes", () => {
    const packages = skillPackages();
    const document = JSON.parse(candidateText(packages)) as CandidateDocument;
    document.change.value = "é".repeat(MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES / 2);
    const exact = JSON.stringify(document);

    expect(Buffer.byteLength(document.change.value)).toBe(MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES);
    expect(projectSource(exact, packages).identity.change).toMatchObject({
      kind: "instructions",
      after: { bytes: MAX_CHILD_SPECIALIST_INSTRUCTIONS_BYTES },
    });
    document.change.value += "a";
    expect(() => parseChildSpecialistCandidateText(JSON.stringify(document))).toThrowError(
      /invalid_schema:/,
    );
  });

  it("accepts exactly 32 selected Agent Skills and rejects 33", () => {
    const packages = skillPackages(32);
    const admittedNames = packages
      .filter((capability) => capability.kind === "agent-skill")
      .map((capability) => capability.name);
    const exactBaseline = baselineForSkillClosure(admittedNames);
    const compiled = compileWorkflowText(exactBaseline.parent, "baseline.workflow.yaml");
    const compiledChild = compiled.nodes.find((node) => node.id === "delegate-review");
    if (compiledChild?.type !== "child") throw new Error("exact-limit fixture has no child");
    const document = JSON.parse(skillCandidateText(packages)) as CandidateDocument;
    document.baseline.workflow.sourceSha256 = sha256(exactBaseline.parent);
    document.baseline.workflow.workflowDigest = calculateWorkflowDigest(compiled);
    document.baseline.child.sourceSha256 = sha256(exactBaseline.child);
    document.baseline.child.workflowDigest = compiledChild.child.workflowDigest;
    document.change.after = admittedNames;

    expect(admittedNames).toHaveLength(32);
    expect(
      projectSourceAgainstBaseline(JSON.stringify(document), packages, exactBaseline.parent)
        .identity.change,
    ).toEqual({ kind: "skills", before: ["review-checklist"], after: admittedNames });
    document.change.after = [...admittedNames, "overflow-skill"];
    expect(() => parseChildSpecialistCandidateText(JSON.stringify(document))).toThrowError(
      /invalid_schema:/,
    );
  });
});

interface CandidateDocument {
  scope: { workflowId: string; childNodeId: string; agentNodeId: string };
  baseline: {
    workflow: { sourceSha256: string; workflowDigest: string };
    child: { sourceSha256: string; workflowDigest: string };
    packageClosureDigest: string;
  };
  change: {
    beforeSha256: string;
    value: string;
    after?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function projectSource(sourceText: string, packages: ReturnType<typeof skillPackages>) {
  return projectSourceAgainstBaseline(sourceText, packages, baselineText);
}

function projectSourceAgainstBaseline(
  sourceText: string,
  packages: ReturnType<typeof skillPackages>,
  admittedBaselineText: string,
) {
  const compiled = compileWorkflowText(admittedBaselineText, "baseline.workflow.yaml");
  return projectChildSpecialistCandidate({
    manifestProvenance: "specialist.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: parseChildSpecialistCandidateText(sourceText, "specialist.candidate.yaml"),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: admittedBaselineText,
      sourceSha256: sha256(admittedBaselineText),
      source: parseWorkflowSourceText(admittedBaselineText, "baseline.workflow.yaml"),
      compiled,
      packages,
    },
  });
}

function baselineForSkillClosure(skills: readonly string[]): {
  readonly parent: string;
  readonly child: string;
} {
  const parent = JSON.parse(baselineText) as {
    nodes: { id: string; child?: { workflow?: string } }[];
  };
  const selected = parent.nodes.find((node) => node.id === "delegate-review");
  const child = JSON.parse(selected?.child?.workflow ?? "null") as {
    nodes: { id: string; agent?: { skills?: string[] } }[];
  };
  const reference = child.nodes.find((node) => node.id === "security-reference");
  if (reference?.agent === undefined) throw new Error("exact-limit fixture has no reference agent");
  reference.agent.skills = skills.filter((skill) => skill !== "review-checklist");
  const childText = JSON.stringify(child);
  if (selected?.child === undefined) throw new Error("exact-limit fixture has no embedded child");
  selected.child.workflow = childText;
  return { parent: JSON.stringify(parent), child: childText };
}

function candidateText(packages: ReturnType<typeof skillPackages>): string {
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ChildSpecialistCandidate",
    metadata: { id: "review-instructions", version: "1.0.0" },
    scope: {
      kind: "workflow-child-specialist",
      workflowId: "specialist-harness",
      childNodeId: "delegate-review",
      agentNodeId: "review",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
      child: {
        sourceSha256: sha256(childWorkflowText),
        workflowDigest: childWorkflowDigest(compiled),
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest(packages),
    },
    change: {
      kind: "instructions",
      beforeSha256: sha256(baselineInstructions),
      value: candidateInstructions,
    },
  });
}

function skillCandidateText(packages: ReturnType<typeof skillPackages>): string {
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ChildSpecialistCandidate",
    metadata: { id: "review-skills", version: "1.0.0" },
    scope: {
      kind: "workflow-child-specialist",
      workflowId: "specialist-harness",
      childNodeId: "delegate-review",
      agentNodeId: "review",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
      child: {
        sourceSha256: sha256(childWorkflowText),
        workflowDigest: childWorkflowDigest(compiled),
      },
      packageClosureDigest: calculateCapabilitySnapshotDigest(packages),
    },
    change: {
      kind: "skills",
      before: ["review-checklist"],
      after: ["review-checklist", "security-checklist"],
    },
  });
}

function childWorkflowDigest(compiled: ReturnType<typeof compileWorkflowText>): string {
  const child = compiled.nodes.find((node) => node.id === "delegate-review");
  if (child?.type !== "child") throw new Error("missing child fixture");
  return child.child.workflowDigest;
}

function skillPackages(count = 2) {
  const names = [
    "review-checklist",
    "security-checklist",
    ...Array.from(
      { length: Math.max(0, count - 2) },
      (_, index) => `specialist-skill-${String(index + 1).padStart(2, "0")}`,
    ),
  ].slice(0, count);
  return createCapabilitySnapshot(
    names.map((name) => ({
      kind: "agent-skill" as const,
      name,
      description: `Review a result with ${name}.`,
      license: "MIT",
      compatibility: "Flow 1.x",
      metadata: {},
      requestedTools: [],
      trust: "project-explicit" as const,
      provenance: `.flow/skills/${name}`,
      files: [{ path: "SKILL.md", content: Buffer.from(`# ${name}\n`) }],
    })),
  ).packages;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
