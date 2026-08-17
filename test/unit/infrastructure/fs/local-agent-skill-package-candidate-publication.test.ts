import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createAgentSkillPackageCandidateSource } from "../../../../src/domain/adaptation/agent-skill-package-candidate.js";
import { completeAgentSkillPackageCandidateGeneration } from "../../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import {
  type LocalAgentSkillPackageCandidatePublisherError,
  publishLocalAgentSkillPackageCandidate,
} from "../../../../src/infrastructure/fs/local-agent-skill-package-candidate-publisher.js";
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

describe("local Agent Skill package candidate publication", () => {
  it("publishes one complete review directory with inert file modes", async () => {
    const fixture = await publicationFixture();
    let revalidations = 0;

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        revalidate: () => {
          revalidations += 1;
        },
      }),
    ).resolves.toEqual({ outputPath: fixture.outputPath, status: "settled" });

    expect(revalidations).toBe(2);
    expect(JSON.parse(await readFile(join(fixture.outputPath, "CANDIDATE.json"), "utf8"))).toEqual(
      fixture.source,
    );
    expect(
      await readFile(join(fixture.outputPath, "skill/review-helper/SKILL.md"), "utf8"),
    ).toContain("# Review helper");
    expect(
      await readFile(
        join(fixture.outputPath, "skill/review-helper/references/checklist.md"),
        "utf8",
      ),
    ).toContain("Check correctness");
    expect(await readdir(fixture.outputPath)).toEqual(["CANDIDATE.json", "skill"]);
    expect((await lstat(fixture.outputPath)).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(fixture.outputPath, "skill/review-helper/SKILL.md"))).mode & 0o777,
    ).toBe(0o600);

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package),
    ).rejects.toMatchObject({ code: "output_exists" });
  });

  it("leaves no final directory when cancellation reaches the commit point", async () => {
    const fixture = await publicationFixture();
    const controller = new AbortController();
    const reason = new Error("publication cancelled");

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        signal: controller.signal,
        beforePublish: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    await expect(access(fixture.outputPath, constants.F_OK)).rejects.toThrow();
  });

  it("retires its owned lock when cancellation follows lock creation", async () => {
    const fixture = await publicationFixture();
    const controller = new AbortController();
    const reason = new Error("publication lock cancelled");

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        signal: controller.signal,
        afterLockCreated: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    await expect(readdir(fixture.root)).resolves.not.toContain(
      ".generated-review-helper.generation.lock",
    );
    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package),
    ).resolves.toMatchObject({ status: "settled" });
  });

  it("reports uncertain settlement and preserves the complete tree after rename", async () => {
    const fixture = await publicationFixture();

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        afterPublish: () => {
          throw new Error("PRIVATE_POST_RENAME_FAILURE");
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalAgentSkillPackageCandidatePublisherError>>({
        code: "publication_uncertain",
        message: expect.not.stringContaining("PRIVATE_POST_RENAME_FAILURE"),
      }),
    );
    await expect(readFile(join(fixture.outputPath, "CANDIDATE.json"), "utf8")).resolves.toContain(
      "AgentSkillPackageCandidate",
    );
  });

  it("reopens the staged tree and rejects mutation before commit", async () => {
    const fixture = await publicationFixture();

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        beforePublish: async () => {
          const staging = (await readdir(fixture.root)).find(
            (entry) =>
              entry.startsWith(".generated-review-helper.generation.") && entry.endsWith(".tmp"),
          );
          expect(staging).toBeDefined();
          await unlink(
            join(fixture.root, staging ?? "missing", "skill/review-helper/references/checklist.md"),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(access(fixture.outputPath, constants.F_OK)).rejects.toThrow();
  });

  it("revalidates the staged tree after the final external source fence", async () => {
    const fixture = await publicationFixture();
    let revalidations = 0;

    await expect(
      publishLocalAgentSkillPackageCandidate(fixture.outputPath, fixture.source, fixture.package, {
        revalidate: async () => {
          revalidations += 1;
          if (revalidations !== 2) {
            return;
          }
          const staging = (await readdir(fixture.root)).find(
            (entry) =>
              entry.startsWith(".generated-review-helper.generation.") && entry.endsWith(".tmp"),
          );
          expect(staging).toBeDefined();
          await unlink(
            join(fixture.root, staging ?? "missing", "skill/review-helper/references/checklist.md"),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "io" });
    await expect(access(fixture.outputPath, constants.F_OK)).rejects.toThrow();
  });
});

async function publicationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-package-candidate-publish-")));
  temporaryDirectories.push(root);
  const generation = agentSkillPackageCandidateGenerationFixture();
  const completed = completeAgentSkillPackageCandidateGeneration(
    generation.prepared,
    agentSkillPackageGenerationResponse,
    {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 0,
    },
  );
  await writeFile(join(root, "baseline.workflow.yaml"), promptCandidateWorkflowText(), "utf8");
  await writeFile(
    join(root, "tuning-evidence.json"),
    JSON.stringify(generation.input.evidence[0]?.packet),
    "utf8",
  );
  await writeFile(join(root, "review-helper.blueprint.json"), generation.blueprintText, "utf8");
  return {
    root,
    outputPath: join(root, "generated-review-helper"),
    source: createAgentSkillPackageCandidateSource(generation.prepared, completed),
    package: completed.package,
  };
}
