import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createAgentSkillPackageCandidateSource } from "../../../../src/domain/adaptation/agent-skill-package-candidate.js";
import {
  completeAgentSkillPackageCandidateGeneration,
  parseAgentSkillPackageBlueprintText,
  prepareAgentSkillPackageCandidateGeneration,
} from "../../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { admitLocalAdaptationCandidate } from "../../../../src/infrastructure/fs/local-adaptation-candidate.js";
import {
  admitLocalAgentSkillPackageCandidate,
  LocalAgentSkillPackageCandidateError,
} from "../../../../src/infrastructure/fs/local-agent-skill-package-candidate.js";
import { publishLocalAgentSkillPackageCandidate } from "../../../../src/infrastructure/fs/local-agent-skill-package-candidate-publisher.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
} from "../../../fixtures/agent-skill-package-candidate-generation.js";
import { promptCandidateWorkflowText } from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local Agent Skill package candidates", () => {
  it("reopens and projects the complete review directory", async () => {
    const fixture = await localCandidateFixture();

    const admitted = await admitLocalAgentSkillPackageCandidate(fixture.outputPath);

    expect(admitted.sourcePath).toBe(join(fixture.outputPath, "CANDIDATE.json"));
    expect(admitted.identity).toMatchObject({
      kind: "agent-skill-package-candidate",
      package: { name: "review-helper", packageDigest: fixture.package.digest },
      selection: { nodeId: "implement", before: [], after: ["review-helper"] },
    });
    expect(admitted.candidateCapabilitySnapshot.packages).toEqual([fixture.package]);
    await expect(admitted.revalidate()).resolves.toBeUndefined();
    await expect(admitLocalAdaptationCandidate(fixture.outputPath)).resolves.toMatchObject({
      kind: "agent-skill-package-candidate",
      candidate: { identity: { candidateDigest: admitted.identity.candidateDigest } },
    });
  });

  it("rejects package mutation and a linked candidate directory", async () => {
    const changed = await localCandidateFixture();
    await writeFile(
      join(changed.outputPath, "skill/review-helper/references/checklist.md"),
      "PRIVATE_SUBSTITUTION\n",
      "utf8",
    );
    await expect(admitLocalAgentSkillPackageCandidate(changed.outputPath)).rejects.toBeInstanceOf(
      LocalAgentSkillPackageCandidateError,
    );

    const linked = await localCandidateFixture();
    const alias = join(linked.root, "candidate-alias");
    await symlink(linked.outputPath, alias);
    await expect(admitLocalAgentSkillPackageCandidate(alias)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("rejects a candidate selected through a nested symbolic-link ancestor", async () => {
    const fixture = await localCandidateFixture();
    const wrapper = await realpath(await mkdtemp(join(tmpdir(), "flow-package-candidate-link-")));
    temporaryDirectories.push(wrapper);
    const realParent = join(wrapper, "real");
    const movedRoot = join(realParent, "project");
    await mkdir(realParent);
    await rename(fixture.root, movedRoot);
    temporaryDirectories.splice(temporaryDirectories.indexOf(fixture.root), 1);
    await symlink(realParent, join(wrapper, "PRIVATE_ALIAS"));

    await expect(
      admitLocalAgentSkillPackageCandidate(
        join(wrapper, "PRIVATE_ALIAS", "project", "generated-review-helper"),
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("normalizes an unexpected observation failure without retaining private data", async () => {
    const fixture = await localCandidateFixture();
    const rejection = await admitLocalAgentSkillPackageCandidate(fixture.outputPath, {
      afterEntryObservation: () => {
        throw new Error("PRIVATE_OBSERVATION_FAILURE");
      },
    }).catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      code: "invalid_source",
      message: "invalid_source: candidate directory could not be admitted",
    });
    expect(rejection).not.toHaveProperty("cause");
    expect(JSON.stringify(rejection)).not.toContain("PRIVATE_OBSERVATION_FAILURE");
  });

  it("preserves cancellation when an observation fails at the same boundary", async () => {
    const fixture = await localCandidateFixture();
    const controller = new AbortController();
    const reason = new Error("candidate admission cancelled");

    await expect(
      admitLocalAgentSkillPackageCandidate(fixture.outputPath, {
        signal: controller.signal,
        afterEntryObservation: () => {
          controller.abort(reason);
          throw new Error("PRIVATE_OBSERVATION_FAILURE");
        },
      }),
    ).rejects.toBe(reason);
  });

  it("publishes and reopens the complete valid path closure declared by the blueprint", async () => {
    const deepPath = `references/${Array.from({ length: 65 }, (_, index) => `d${index}`).join("/")}/guide.md`;
    const fixture = await localCandidateFixture(deepPath);

    await expect(admitLocalAgentSkillPackageCandidate(fixture.outputPath)).resolves.toMatchObject({
      package: {
        files: expect.arrayContaining([expect.objectContaining({ path: deepPath })]),
      },
    });
  });
});

async function localCandidateFixture(deepPath?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-local-package-candidate-")));
  temporaryDirectories.push(root);
  const baseGeneration = agentSkillPackageCandidateGenerationFixture();
  const blueprintText =
    deepPath === undefined
      ? baseGeneration.blueprintText
      : JSON.stringify({
          ...baseGeneration.input.blueprint.document,
          files: baseGeneration.input.blueprint.document.files.map((file) =>
            file.path === "references/checklist.md" ? { ...file, path: deepPath } : file,
          ),
        });
  const blueprint = parseAgentSkillPackageBlueprintText(blueprintText, "package blueprint");
  const prepared = prepareAgentSkillPackageCandidateGeneration({
    ...baseGeneration.input,
    blueprint: {
      ...baseGeneration.input.blueprint,
      sourceSha256: sha256(blueprintText),
      document: blueprint,
    },
  });
  const response =
    deepPath === undefined
      ? agentSkillPackageGenerationResponse
      : JSON.stringify({
          files: [
            {
              path: "SKILL.md",
              content:
                "# Review helper\n\nRead the checklist and report evidence-backed findings.\n",
            },
            { path: deepPath, content: "# Deep guide\n" },
          ],
        });
  const completed = completeAgentSkillPackageCandidateGeneration(prepared, response, {
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    costUsdMicros: 0,
  });
  await writeFile(join(root, "baseline.workflow.yaml"), promptCandidateWorkflowText(), "utf8");
  await writeFile(
    join(root, "tuning-evidence.json"),
    JSON.stringify(baseGeneration.input.evidence[0]?.packet),
    "utf8",
  );
  await writeFile(join(root, "review-helper.blueprint.json"), blueprintText, "utf8");
  const outputPath = join(root, "generated-review-helper");
  const source = createAgentSkillPackageCandidateSource(prepared, completed);
  await publishLocalAgentSkillPackageCandidate(outputPath, source, completed.package);
  return { root, outputPath, source, package: completed.package };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
