import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("OpenRouter provider catalog", () => {
  it("resolves GLM 5.3 Flash without model-catalog network access", async () => {
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
    });

    expect(runtime.getModel("openrouter", "z-ai/glm-5.3-flash")).toMatchObject({
      provider: "openrouter",
      id: "z-ai/glm-5.3-flash",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
    });
  });
});
