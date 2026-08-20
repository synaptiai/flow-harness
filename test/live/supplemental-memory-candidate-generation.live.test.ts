import { describe, expect, it } from "vitest";

import { generateSupplementalMemoryCandidate } from "../../src/application/generate-supplemental-memory-candidate.js";
import { prepareSupplementalMemoryCandidateGeneration } from "../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";
import { supplementalMemoryCandidateGenerationFixture } from "../fixtures/supplemental-memory-candidate-generation.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)(
  "supplemental-memory candidate generation live",
  () => {
    it("generates one valid memory candidate through a real provider-backed Pi session", async ({
      skip,
    }) => {
      if (provider === undefined || model === undefined) {
        throw new Error("live provider settings are unavailable after test admission");
      }
      if (!(await hasConfiguredLivePiModel(provider, model))) {
        skip(`live provider "${provider}" has no configured authentication`);
        return;
      }
      const { input } = supplementalMemoryCandidateGenerationFixture();
      const prepared = prepareSupplementalMemoryCandidateGeneration({
        ...input,
        model: { provider, id: model, thinking: "off" },
      });

      const candidate = await generateSupplementalMemoryCandidate(
        {
          prepared,
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          protectedPaths: [],
        },
        new PiAgentExecutor(),
      );

      expect(candidate).toMatchObject({
        kind: "SupplementalMemoryCandidate",
        metadata: { id: "generated-memory", version: "1.0.0" },
        scope: {
          workflowId: "memory-workflow",
          childPath: [],
          agentNodeId: "implement",
          entryId: "reviewed-fixture",
        },
        change: { kind: "add", value: expect.any(String) },
        generation: { provider, model, thinking: "off", operation: "add" },
      });
    });
  },
);
