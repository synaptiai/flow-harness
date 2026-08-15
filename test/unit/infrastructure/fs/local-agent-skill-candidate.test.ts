import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import {
  admitLocalAgentSkillCandidate,
  LocalAgentSkillCandidateError,
} from "../../../../src/infrastructure/fs/local-agent-skill-candidate.js";
import { promptCandidateTuningEvidence } from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local Agent Skill candidate admission", () => {
  it("stably admits the exact workflow, skill, evidence, and projected snapshots", async () => {
    const fixture = await candidateProject();

    const admitted = await admitLocalAgentSkillCandidate(fixture.candidatePath);

    expect(admitted.identity).toMatchObject({
      kind: "agent-skill-candidate",
      id: "better-review",
      manifest: {
        provenance: "candidate.yaml",
        sourceSha256: sha256(fixture.candidateText),
      },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(fixture.workflowText),
        },
        skill: {
          name: "review",
          provenance: ".flow/skills/review",
          packageDigest: admitted.baseline.skill.digest,
        },
      },
      evidence: [
        {
          provenance: "tuning.json",
          sourceSha256: sha256(fixture.evidenceText),
        },
      ],
    });
    expect(admitted.baseline.workflow.sourcePath).toBe(
      join(fixture.project, "baseline.workflow.yaml"),
    );
    expect(admitted.baseline.skill.files).toHaveLength(2);
    expect(admitted.candidateCapabilitySnapshot.digest).not.toBe(
      admitted.baselineCapabilitySnapshot.digest,
    );
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it.each(["candidate", "workflow", "evidence", "skill-directory", "skill-resource"] as const)(
    "rejects a symbolic-link %s source without reading the target",
    async (kind) => {
      const fixture = await candidateProject();
      const target =
        kind === "candidate"
          ? fixture.candidatePath
          : kind === "workflow"
            ? join(fixture.project, "baseline.workflow.yaml")
            : kind === "evidence"
              ? join(fixture.project, "tuning.json")
              : kind === "skill-directory"
                ? join(fixture.project, ".flow", "skills", "review")
                : join(fixture.project, ".flow", "skills", "review", "reference.md");
      const saved = `${target}.saved`;
      await rename(target, saved);
      await symlink(saved, target);

      await expect(admitLocalAgentSkillCandidate(fixture.candidatePath)).rejects.toBeInstanceOf(
        LocalAgentSkillCandidateError,
      );
    },
  );

  it("rejects declared skill provenance or digest substitution", async () => {
    const wrongPath = await candidateProject();
    const pathSource = JSON.parse(wrongPath.candidateText);
    pathSource.baseline.skill.path = ".flow/skills/other";
    await writeFile(wrongPath.candidatePath, JSON.stringify(pathSource));
    await expect(admitLocalAgentSkillCandidate(wrongPath.candidatePath)).rejects.toBeInstanceOf(
      LocalAgentSkillCandidateError,
    );

    const wrongDigest = await candidateProject();
    const digestSource = JSON.parse(wrongDigest.candidateText);
    digestSource.baseline.skill.packageDigest = "f".repeat(64);
    await writeFile(wrongDigest.candidatePath, JSON.stringify(digestSource));
    await expect(admitLocalAgentSkillCandidate(wrongDigest.candidatePath)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
  });

  it("does not grant unrelated local skill packages authority over the declared baseline", async () => {
    const fixture = await candidateProject();
    const unrelated = join(fixture.project, ".flow", "skills", "unrelated");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "SKILL.md"), "kind: Invalid\n");

    await expect(admitLocalAgentSkillCandidate(fixture.candidatePath)).resolves.toMatchObject({
      baseline: { skill: { name: "review" } },
    });
  });

  it.each(["baseline.workflow.yaml", ".flow/skills/review"])(
    "preserves exact cancellation before admitting %s",
    async (boundary) => {
      const fixture = await candidateProject();
      const controller = new AbortController();
      const reason = new Error("operator cancelled skill candidate admission");

      await expect(
        admitLocalAgentSkillCandidate(fixture.candidatePath, {
          signal: controller.signal,
          afterPathValidation: (provenance) => {
            if (provenance === boundary) {
              controller.abort(reason);
            }
          },
        }),
      ).rejects.toBe(reason);
    },
  );

  it("rejects replacement of the canonical candidate root before later reads", async () => {
    const fixture = await candidateProject();
    const savedRoot = `${fixture.project}-saved`;
    temporaryDirectories.push(savedRoot);
    let swapped = false;

    await expect(
      admitLocalAgentSkillCandidate(fixture.candidatePath, {
        afterPathValidation: async (provenance) => {
          if (provenance !== "candidate.yaml" || swapped) {
            return;
          }
          swapped = true;
          await rename(fixture.project, savedRoot);
          await symlink(savedRoot, fixture.project, "dir");
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
});

async function candidateProject() {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-skill-candidate-")));
  temporaryDirectories.push(project);
  const skillRoot = join(project, ".flow", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  const skillText = baselineSkillText();
  await writeFile(join(skillRoot, "SKILL.md"), skillText);
  await writeFile(join(skillRoot, "reference.md"), "Check evidence.\n");

  const workflowText = workflowSource();
  const workflowDigest = calculateWorkflowDigest(compileWorkflowText(workflowText));
  const evidence = promptCandidateTuningEvidence(workflowDigest);
  const evidenceText = JSON.stringify(evidence);
  await writeFile(join(project, "baseline.workflow.yaml"), workflowText);
  await writeFile(join(project, "tuning.json"), evidenceText);

  const { discoverProjectAgentSkills, snapshotSelectedAgentSkills } = await import(
    "../../../../src/infrastructure/fs/local-agent-skill-catalog.js"
  );
  const skillSnapshot = await snapshotSelectedAgentSkills(
    await discoverProjectAgentSkills(project),
    ["review"],
  );
  const skill = skillSnapshot.packages[0];
  if (skill === undefined) {
    throw new Error("Agent Skill candidate fixture has no baseline skill");
  }
  const candidate = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "AgentSkillCandidate",
    metadata: { id: "better-review", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-skill",
      workflowId: "adaptive-skill-workflow",
      skillName: "review",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(workflowText),
        workflowDigest,
      },
      skill: { path: ".flow/skills/review", packageDigest: skill.digest },
    },
    evidence: [
      {
        path: "tuning.json",
        sourceSha256: sha256(evidenceText),
        evidenceDigest: evidence.evidenceDigest,
        planDigest: evidence.evaluation.planDigest,
      },
    ],
    changes: {
      resources: [
        {
          path: "SKILL.md",
          expectedSha256: sha256(skillText),
          value: candidateSkillText(),
        },
      ],
    },
  };
  const candidateText = JSON.stringify(candidate);
  const candidatePath = join(project, "candidate.yaml");
  await writeFile(candidatePath, candidateText);
  return { project, candidatePath, candidateText, workflowText, evidenceText };
}

function workflowSource(): string {
  return JSON.stringify({
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
}

function baselineSkillText(): string {
  return `---
name: review
description: Review the result against the task.
metadata:
  owner: synapti
allowed-tools: Read
---
# Review

Check correctness.
`;
}

function candidateSkillText(): string {
  return baselineSkillText().replace(
    "Check correctness.",
    "Check correctness, security, and evidence.",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
