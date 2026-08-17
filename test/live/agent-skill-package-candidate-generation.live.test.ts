import { describe, expect, it } from "vitest";

import { generateAgentSkillPackageCandidate } from "../../src/application/generate-agent-skill-package-candidate.js";
import { prepareAgentSkillPackageCandidateGeneration } from "../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";
import { agentSkillPackageCandidateGenerationFixture } from "../fixtures/agent-skill-package-candidate-generation.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)(
  "Agent Skill package candidate generation live",
  () => {
    it("generates one valid bounded package through a real provider-backed Pi session", async ({
      skip,
    }) => {
      if (provider === undefined || model === undefined) {
        throw new Error("live provider settings are unavailable after test admission");
      }
      if (!(await hasConfiguredLivePiModel(provider, model))) {
        skip(`live provider "${provider}" has no configured authentication`);
        return;
      }
      const { input } = agentSkillPackageCandidateGenerationFixture();
      const prepared = prepareAgentSkillPackageCandidateGeneration({
        ...input,
        model: { provider, id: model, thinking: "off" },
      });

      const candidate = await generateAgentSkillPackageCandidate(
        {
          prepared,
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          protectedPaths: [],
        },
        new PiAgentExecutor(),
      );

      expect(candidate).toMatchObject({
        package: {
          name: "review-helper",
          files: [
            expect.objectContaining({ path: "SKILL.md" }),
            expect.objectContaining({ path: "references/checklist.md" }),
          ],
        },
        generation: { provider, model, thinking: "off" },
      });
      expect(candidate.package.files).toHaveLength(2);
    });
  },
);
