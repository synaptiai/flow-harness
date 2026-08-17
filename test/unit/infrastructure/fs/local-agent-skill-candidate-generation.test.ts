import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareAgentSkillCandidateGeneration } from "../../../../src/domain/adaptation/agent-skill-candidate-generation.js";
import {
  admitLocalAgentSkillCandidateGenerationSources,
  LocalAgentSkillCandidateGenerationSourceError,
} from "../../../../src/infrastructure/fs/local-agent-skill-candidate-generation.js";
import {
  agentSkillCandidateGenerationFixture,
  agentSkillGenerationWorkflowText,
} from "../../../fixtures/agent-skill-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local Agent Skill candidate generation sources", () => {
  it("admits only the exact workflow, evidence, selected package, and resource allowlist", async () => {
    const fixture = await localFixture();

    const admitted = await admitLocalAgentSkillCandidateGenerationSources({
      outputPath: fixture.outputPath,
      baselinePath: fixture.baselinePath,
      evidencePaths: [fixture.evidencePath],
      skillName: "review",
      resourcePaths: ["references/checklist.md"],
    });
    const prepared = prepareAgentSkillCandidateGeneration({
      candidate: { id: "generated-review", version: "1.0.0" },
      baseline: admitted.baseline,
      skill: admitted.skill,
      evidence: admitted.evidence,
      allowedResourcePaths: admitted.resourcePaths,
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
    });

    expect(admitted.root).toBe(fixture.root);
    expect(admitted.skill).toMatchObject({ name: "review", provenance: ".flow/skills/review" });
    expect(admitted.resourcePaths).toEqual(["references/checklist.md"]);
    expect(prepared.renderedInput).not.toContain("PRIVATE_UNRELATED_RESOURCE_CONTENT");
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("does not consult an unrelated malformed live skill", async () => {
    const fixture = await localFixture();
    const unrelated = join(fixture.root, ".flow", "skills", "unrelated");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "SKILL.md"), "PRIVATE_INVALID_SKILL", "utf8");

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
      }),
    ).resolves.toMatchObject({ skill: { name: "review" } });
  });

  it.each([
    "missing.md",
    "SKILL.md",
    "scripts/check.sh",
    "assets/binary.dat",
    "references/checklist.md",
  ])(
    "rejects an unavailable, authority-bearing, executable, binary, or repeated selected resource: %s",
    async (path) => {
      const fixture = await localFixture();
      if (path === "references/checklist.md") {
        await expect(
          admitLocalAgentSkillCandidateGenerationSources({
            outputPath: fixture.outputPath,
            baselinePath: fixture.baselinePath,
            evidencePaths: [fixture.evidencePath],
            skillName: "review",
            resourcePaths: [path, path],
          }),
        ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
        return;
      }
      await expect(
        admitLocalAgentSkillCandidateGenerationSources({
          outputPath: fixture.outputPath,
          baselinePath: fixture.baselinePath,
          evidencePaths: [fixture.evidencePath],
          skillName: "review",
          resourcePaths: [path],
        }),
      ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
    },
  );

  it("rejects a linked selected package resource", async () => {
    const fixture = await localFixture();
    const resource = join(fixture.root, ".flow", "skills", "review", "references", "checklist.md");
    await rm(resource);
    await symlink(join(fixture.root, "outside.md"), resource);
    await writeFile(join(fixture.root, "outside.md"), "PRIVATE_LINK_TARGET", "utf8");

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
      }),
    ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
  });

  it("rejects linked tuning evidence without consulting its target", async () => {
    const fixture = await localFixture();
    const outsideEvidence = join(fixture.root, "outside-tuning.json");
    await writeFile(outsideEvidence, await readFile(fixture.evidencePath));
    await rm(fixture.evidencePath);
    await symlink(outsideEvidence, fixture.evidencePath);

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
      }),
    ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
  });

  it.each(["baseline", "output"])(
    "rejects a caller-supplied linked %s parent before source validation",
    async (kind) => {
      const fixture = await localFixture();
      const alias = join(fixture.root, `${kind}-alias`);
      await symlink(fixture.root, alias);
      let sourceValidated = false;

      await expect(
        admitLocalAgentSkillCandidateGenerationSources({
          outputPath:
            kind === "output"
              ? join(alias, "generated.agent-skill-candidate.yaml")
              : fixture.outputPath,
          baselinePath:
            kind === "baseline" ? join(alias, "baseline.workflow.yaml") : fixture.baselinePath,
          evidencePaths: [fixture.evidencePath],
          skillName: "review",
          resourcePaths: ["references/checklist.md"],
          afterPathValidation: () => {
            sourceValidated = true;
          },
        }),
      ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
      expect(sourceValidated).toBe(false);
    },
  );

  it("rejects a symbolic link in an ancestor of the generation root", async () => {
    const fixture = await localFixture();
    const actual = join(fixture.root, "actual", "project");
    await mkdir(actual, { recursive: true });
    await rename(fixture.baselinePath, join(actual, "baseline.workflow.yaml"));
    await rename(fixture.evidencePath, join(actual, "tuning.json"));
    await rename(join(fixture.root, ".flow"), join(actual, ".flow"));
    const alias = join(fixture.root, "alias");
    await symlink(join(fixture.root, "actual"), alias);
    let sourceValidated = false;

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: join(alias, "project", "generated.agent-skill-candidate.yaml"),
        baselinePath: join(alias, "project", "baseline.workflow.yaml"),
        evidencePaths: [join(alias, "project", "tuning.json")],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
        afterPathValidation: () => {
          sourceValidated = true;
        },
      }),
    ).rejects.toBeInstanceOf(LocalAgentSkillCandidateGenerationSourceError);
    expect(sourceValidated).toBe(false);
  });

  it("rejects source drift through the combined revalidation closure", async () => {
    const fixture = await localFixture();
    const admitted = await admitLocalAgentSkillCandidateGenerationSources({
      outputPath: fixture.outputPath,
      baselinePath: fixture.baselinePath,
      evidencePaths: [fixture.evidencePath],
      skillName: "review",
      resourcePaths: ["references/checklist.md"],
    });
    await writeFile(fixture.evidencePath, `${await readFile(fixture.evidencePath, "utf8")} `);

    await expect(admitted.revalidate()).rejects.toBeInstanceOf(
      LocalAgentSkillCandidateGenerationSourceError,
    );
  });

  it("preserves exact cancellation during selected package capture", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_EXACT_CANCELLATION");

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
        signal: controller.signal,
        afterSkillEntryObservation: (provenance) => {
          if (provenance.endsWith("references/checklist.md")) {
            controller.abort(reason);
          }
        },
      }),
    ).rejects.toBe(reason);
  });

  it("stops common source admission at the exact cancellation boundary", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_COMMON_SOURCE_CANCELLATION");
    const validated: string[] = [];

    await expect(
      admitLocalAgentSkillCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        skillName: "review",
        resourcePaths: ["references/checklist.md"],
        signal: controller.signal,
        afterPathValidation: (provenance) => {
          validated.push(provenance);
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(validated).toEqual(["baseline.workflow.yaml"]);
  });
});

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-agent-skill-generation-")));
  temporaryDirectories.push(root);
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "tuning.json");
  const outputPath = join(root, "generated.agent-skill-candidate.yaml");
  const { input, skill } = agentSkillCandidateGenerationFixture();
  await writeFile(baselinePath, agentSkillGenerationWorkflowText, "utf8");
  await writeFile(evidencePath, `${JSON.stringify(input.evidence[0]?.packet)}\n`, "utf8");
  for (const file of skill.files) {
    const destination = join(root, skill.provenance, file.path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, Buffer.from(file.contentBase64, "base64"));
  }
  return { root, baselinePath, evidencePath, outputPath };
}
