import { describe, expect, it, vi } from "vitest";

import { createNoIoPrimeResourceLoader } from "../../../../src/infrastructure/prime/no-io-resource-loader.js";

describe("no-I/O Prime resource loader", () => {
  it("returns only empty in-memory resources", async () => {
    const runtime = Object.freeze({ kind: "test-runtime" });
    const loader = createNoIoPrimeResourceLoader(runtime, {
      systemPrompt: "Use only the admitted IPython tool.",
    });

    expect(loader.getExtensions()).toEqual({ extensions: [], errors: [], runtime });
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBe("Use only the admitted IPython tool.");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    await expect(loader.reload()).resolves.toBeUndefined();
  });

  it("rejects attempts to add ambient resource paths", () => {
    const loader = createNoIoPrimeResourceLoader(Object.freeze({}));

    expect(() => loader.extendResources({ skills: ["/workspace/skill"] })).toThrow(
      /does not accept resource paths/i,
    );
  });

  it("does not inspect the process environment or filesystem", async () => {
    const readFile = vi.spyOn(process, "cwd");
    const loader = createNoIoPrimeResourceLoader(Object.freeze({}));

    loader.getExtensions();
    loader.getSkills();
    loader.getPrompts();
    loader.getThemes();
    loader.getAgentsFiles();
    loader.getSystemPrompt();
    loader.getAppendSystemPrompt();
    await loader.reload();

    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
  });
});
