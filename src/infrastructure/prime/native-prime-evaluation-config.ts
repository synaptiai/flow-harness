function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const NATIVE_PRIME_EVALUATION_CONFIG = deepFreeze({
  version: 1,
  id: "prime-agent-rlm-evaluation-v1",
  tools: ["ipython"],
  session: "memory",
  settings: {
    compaction: { enabled: false, agentCallable: false },
    autoRefine: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    enableSkillCommands: false,
    enableBuiltinSkills: false,
    mcpServers: {},
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  },
  sessionOptions: {
    noTools: "all",
    tools: [],
    initialActiveToolNames: ["ipython"],
    allowedToolNames: ["ipython"],
    includeGoals: false,
    includeCompactSkill: false,
    rlmDepth: 0,
    rlmMaxDepth: 0,
    prewarmIpythonKernel: false,
    serializedRefine: false,
  },
  resourceLoader: "no-io",
  extensions: "deny",
  skills: "deny",
  schedules: "deny",
  mcp: "deny",
  rules: "deny",
  promptTemplates: "deny",
  agentStorage: "memory",
  autonomousMode: "off",
  forkserver: "off",
  maxModelTurns: 64,
});
