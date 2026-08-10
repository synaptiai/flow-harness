import { describe, expect, it } from "vitest";

import { generatePromptCandidate } from "../../src/application/generate-prompt-candidate.js";
import { preparePromptCandidateGeneration } from "../../src/domain/adaptation/prompt-candidate-generation.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";
import { promptCandidateGenerationFixture } from "../fixtures/prompt-candidate-generation.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)(
  "prompt candidate generation live",
  () => {
    it("generates one valid candidate through a real provider-backed Pi session", async ({
      skip,
    }) => {
      if (provider === undefined || model === undefined) {
        throw new Error("live provider settings are unavailable after test admission");
      }
      if (!(await hasConfiguredLivePiModel(provider, model))) {
        skip(`live provider "${provider}" has no configured authentication`);
        return;
      }
      const { input } = promptCandidateGenerationFixture();
      const prepared = preparePromptCandidateGeneration({
        ...input,
        model: { provider, id: model, thinking: "off" },
      });

      const candidate = await generatePromptCandidate(
        {
          prepared,
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          protectedPaths: [],
        },
        new PiAgentExecutor(),
      );

      expect(candidate).toMatchObject({
        kind: "PromptCandidate",
        metadata: { id: "generated-instructions", version: "1.0.0" },
        generation: { provider, model, thinking: "off" },
        changes: { prompts: [expect.objectContaining({ nodeId: "implement" })] },
      });
    });
  },
);
