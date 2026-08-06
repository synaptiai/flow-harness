import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import type { SrtRuntimeConfig, SrtSandboxManager } from "./srt-command-sandbox.js";

export const ANTHROPIC_SANDBOX_RUNTIME_VERSION = "0.0.70" as const;

export const anthropicSandboxRuntimeManager: SrtSandboxManager = {
  checkDependencies: () => SandboxManager.checkDependencies(),
  initialize: async (config: SrtRuntimeConfig) => {
    await SandboxManager.initialize(SandboxRuntimeConfigSchema.parse(config));
  },
  wrapWithSandboxArgv: (command, binShell, customConfig, signal, cwd) =>
    SandboxManager.wrapWithSandboxArgv(command, binShell, customConfig, signal, cwd),
  cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
  reset: () => SandboxManager.reset(),
};
