import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES } from "../../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { admitLocalAgentSkillPackageCandidateGenerationSources } from "../../../../src/infrastructure/fs/local-agent-skill-package-candidate-generation.js";
import { agentSkillPackageCandidateGenerationFixture } from "../../../fixtures/agent-skill-package-candidate-generation.js";
import { promptCandidateGenerationFixture } from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local Agent Skill package candidate generation sources", () => {
  it("admits and revalidates one exact workflow, evidence set, and package blueprint", async () => {
    const fixture = await localFixture();

    const admitted = await admitLocalAgentSkillPackageCandidateGenerationSources({
      outputPath: fixture.outputPath,
      baselinePath: fixture.baselinePath,
      evidencePaths: [fixture.evidencePath],
      blueprintPath: fixture.blueprintPath,
    });

    expect(admitted).toMatchObject({
      outputPath: fixture.outputPath,
      root: fixture.root,
      baseline: {
        provenance: "baseline.workflow.yaml",
        workflowDigest: fixture.prompt.input.baseline.workflowDigest,
      },
      evidence: [{ provenance: "tuning-evidence.json" }],
      blueprint: {
        provenance: "review-helper.blueprint.json",
        sourceSha256: fixture.packageGeneration.input.blueprint.sourceSha256,
        document: {
          kind: "AgentSkillPackageBlueprint",
          skill: { name: "review-helper" },
        },
      },
    });
    await expect(admitted.revalidate()).resolves.toBeUndefined();
  });

  it("rejects an intermediate symbolic-link ancestor before reading the blueprint", async () => {
    const fixture = await localFixture();
    const actual = join(fixture.root, "actual");
    const alias = join(fixture.root, "alias");
    await mkdir(actual);
    await writeFile(join(actual, "blueprint.json"), fixture.packageGeneration.blueprintText);
    await symlink(actual, alias, "dir");
    let observed = false;

    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        blueprintPath: join(alias, "blueprint.json"),
        afterBlueprintFileBoundary: () => {
          observed = true;
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(observed).toBe(false);
  });

  it("rejects path replacement after blueprint observation", async () => {
    const fixture = await localFixture();
    let replaced = false;

    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        blueprintPath: fixture.blueprintPath,
        afterBlueprintEntryObservation: async (provenance) => {
          if (provenance === "review-helper.blueprint.json" && !replaced) {
            replaced = true;
            await rename(fixture.blueprintPath, `${fixture.blueprintPath}.saved`);
            await writeFile(fixture.blueprintPath, fixture.packageGeneration.blueprintText);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("rejects a same-size in-place mutation during the blueprint read", async () => {
    const fixture = await localFixture();
    const changed = fixture.packageGeneration.blueprintText.replace("Review an", "Change an");
    expect(Buffer.byteLength(changed)).toBe(
      Buffer.byteLength(fixture.packageGeneration.blueprintText),
    );
    let mutated = false;

    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        blueprintPath: fixture.blueprintPath,
        afterBlueprintFileBoundary: async (phase) => {
          if (phase === "read" && !mutated) {
            mutated = true;
            await writeFile(fixture.blueprintPath, changed);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("accepts the exact blueprint byte limit and rejects one additional byte", async () => {
    const exactFixture = await localFixture();
    const padding =
      MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES -
      Buffer.byteLength(exactFixture.packageGeneration.blueprintText);
    await writeFile(
      exactFixture.blueprintPath,
      `${exactFixture.packageGeneration.blueprintText}${" ".repeat(padding)}`,
    );
    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: exactFixture.outputPath,
        baselinePath: exactFixture.baselinePath,
        evidencePaths: [exactFixture.evidencePath],
        blueprintPath: exactFixture.blueprintPath,
      }),
    ).resolves.toMatchObject({ blueprint: { document: { skill: { name: "review-helper" } } } });

    const overflowFixture = await localFixture();
    await writeFile(
      overflowFixture.blueprintPath,
      `${overflowFixture.packageGeneration.blueprintText}${" ".repeat(
        MAX_AGENT_SKILL_PACKAGE_BLUEPRINT_BYTES -
          Buffer.byteLength(overflowFixture.packageGeneration.blueprintText) +
          1,
      )}`,
    );
    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: overflowFixture.outputPath,
        baselinePath: overflowFixture.baselinePath,
        evidencePaths: [overflowFixture.evidencePath],
        blueprintPath: overflowFixture.blueprintPath,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("preserves exact cancellation after a blueprint path boundary", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_BLUEPRINT_CANCELLATION");
    let fileBoundary = false;

    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        blueprintPath: fixture.blueprintPath,
        signal: controller.signal,
        afterBlueprintEntryObservation: (provenance) => {
          if (provenance === "review-helper.blueprint.json") {
            controller.abort(reason);
          }
        },
        afterBlueprintFileBoundary: () => {
          fileBoundary = true;
        },
      }),
    ).rejects.toBe(reason);
    expect(fileBoundary).toBe(false);
  });

  it("closes an opened blueprint handle before returning open-boundary cancellation", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_BLUEPRINT_OPEN_CANCELLATION");
    const phases: string[] = [];

    await expect(
      admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath: fixture.outputPath,
        baselinePath: fixture.baselinePath,
        evidencePaths: [fixture.evidencePath],
        blueprintPath: fixture.blueprintPath,
        signal: controller.signal,
        afterBlueprintFileBoundary: (phase) => {
          phases.push(phase);
          if (phase === "open") {
            controller.abort(reason);
          }
        },
      }),
    ).rejects.toBe(reason);
    expect(phases).toEqual(["open", "close"]);
  });

  it("detects blueprint drift through the returned revalidation fence", async () => {
    const fixture = await localFixture();
    const admitted = await admitLocalAgentSkillPackageCandidateGenerationSources({
      outputPath: fixture.outputPath,
      baselinePath: fixture.baselinePath,
      evidencePaths: [fixture.evidencePath],
      blueprintPath: fixture.blueprintPath,
    });
    await writeFile(
      fixture.blueprintPath,
      fixture.packageGeneration.blueprintText.replace("Review an", "Change an"),
    );

    await expect(admitted.revalidate()).rejects.toMatchObject({ code: "source_changed" });
  });
});

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-skill-package-generation-")));
  temporaryDirectories.push(root);
  const prompt = promptCandidateGenerationFixture();
  const packageGeneration = agentSkillPackageCandidateGenerationFixture();
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "tuning-evidence.json");
  const blueprintPath = join(root, "review-helper.blueprint.json");
  const outputPath = join(root, "candidate-output");
  await writeFile(baselinePath, prompt.baselineText);
  await writeFile(evidencePath, JSON.stringify(prompt.evidence));
  await writeFile(blueprintPath, packageGeneration.blueprintText);
  return {
    root,
    prompt,
    packageGeneration,
    baselinePath,
    evidencePath,
    blueprintPath,
    outputPath,
  };
}
