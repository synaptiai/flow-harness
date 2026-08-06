import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

import type { SrtRuntimeConfig, SrtSandboxManager } from "./srt-command-sandbox.js";

export const ANTHROPIC_SANDBOX_RUNTIME_VERSION = "0.0.70" as const;

export function resolveAnthropicSandboxRuntimeSeccompPath(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): string | undefined {
  if (platform !== "linux" || (architecture !== "x64" && architecture !== "arm64")) {
    return undefined;
  }
  const runtimeEntryPath = fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"));
  return resolve(
    dirname(runtimeEntryPath),
    "..",
    "vendor",
    "seccomp",
    architecture,
    "apply-seccomp",
  );
}

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
