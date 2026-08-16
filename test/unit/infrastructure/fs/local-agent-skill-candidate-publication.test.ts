import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parseAgentSkillCandidateText } from "../../../../src/domain/adaptation/agent-skill-candidate.js";
import {
  completeAgentSkillCandidateGeneration,
  prepareAgentSkillCandidateGeneration,
} from "../../../../src/domain/adaptation/agent-skill-candidate-generation.js";
import {
  assertLocalPromptCandidateOutputAvailable,
  publishLocalPromptCandidate,
} from "../../../../src/infrastructure/fs/local-prompt-candidate-publisher.js";
import { agentSkillCandidateGenerationFixture } from "../../../fixtures/agent-skill-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local Agent Skill candidate publication", () => {
  it("publishes a strict generated Agent Skill candidate without replacement", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-skill-publication-")));
    temporaryDirectories.push(root);
    const output = join(root, "candidate.yaml");
    const sourceText = generatedSourceText();

    await assertLocalPromptCandidateOutputAvailable(output);
    await publishLocalPromptCandidate(output, sourceText);

    expect(parseAgentSkillCandidateText(await readFile(output, "utf8"))).toBeDefined();
    await expect(publishLocalPromptCandidate(output, sourceText)).rejects.toMatchObject({
      code: "output_exists",
    });
    await expect(access(output)).resolves.toBeUndefined();
  });
});

function generatedSourceText(): string {
  const prepared = prepareAgentSkillCandidateGeneration(
    agentSkillCandidateGenerationFixture().input,
  );
  const source = completeAgentSkillCandidateGeneration(
    prepared,
    JSON.stringify({
      changes: [{ path: "references/checklist.md", value: "Check correctness and security.\n" }],
    }),
    {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 0,
    },
  );
  return `${JSON.stringify(source, null, 2)}\n`;
}
