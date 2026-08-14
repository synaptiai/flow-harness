export interface NoIoPrimeResourceLoader {
  getExtensions(): {
    readonly extensions: readonly never[];
    readonly errors: readonly never[];
    readonly runtime: unknown;
  };
  getSkills(): { readonly skills: readonly never[]; readonly diagnostics: readonly never[] };
  getPrompts(): { readonly prompts: readonly never[]; readonly diagnostics: readonly never[] };
  getThemes(): { readonly themes: readonly never[]; readonly diagnostics: readonly never[] };
  getAgentsFiles(): { readonly agentsFiles: readonly never[] };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): readonly never[];
  extendResources(paths: unknown): never;
  reload(): Promise<void>;
}

export function createNoIoPrimeResourceLoader(
  runtime: unknown,
  options: { readonly systemPrompt?: string } = {},
): NoIoPrimeResourceLoader {
  return Object.freeze({
    getExtensions: () => Object.freeze({ extensions: [], errors: [], runtime }),
    getSkills: () => Object.freeze({ skills: [], diagnostics: [] }),
    getPrompts: () => Object.freeze({ prompts: [], diagnostics: [] }),
    getThemes: () => Object.freeze({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => Object.freeze({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: (_paths: unknown): never => {
      throw new Error("native Prime resource loader does not accept resource paths");
    },
    reload: async () => undefined,
  });
}
