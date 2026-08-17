import { describe, expect, it } from "vitest";

import { generateAgentSkillCandidate } from "../../src/application/generate-agent-skill-candidate.js";
import { prepareAgentSkillCandidateGeneration } from "../../src/domain/adaptation/agent-skill-candidate-generation.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";
import { agentSkillCandidateGenerationFixture } from "../fixtures/agent-skill-candidate-generation.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)(
  "Agent Skill candidate generation live",
  () => {
    it("generates one valid resource candidate through a real provider-backed Pi session", async ({
      skip,
    }) => {
      if (provider === undefined || model === undefined) {
        throw new Error("live provider settings are unavailable after test admission");
      }
      if (!(await hasConfiguredLivePiModel(provider, model))) {
        skip(`live provider "${provider}" has no configured authentication`);
        return;
      }
      const { input } = agentSkillCandidateGenerationFixture();
      const prepared = prepareAgentSkillCandidateGeneration({
        ...input,
        model: { provider, id: model, thinking: "off" },
      });

      const candidate = await generateAgentSkillCandidate(
        {
          prepared,
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          protectedPaths: [],
        },
        new PiAgentExecutor(),
      );

      expect(candidate).toMatchObject({
        kind: "AgentSkillCandidate",
        metadata: { id: "generated-review", version: "1.0.0" },
        generation: { provider, model, thinking: "off" },
        changes: {
          resources: [expect.objectContaining({ path: "references/checklist.md" })],
        },
      });
    });
  },
);
