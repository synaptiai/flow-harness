import { NodeExecutorRouter } from "../../application/node-executor-router.js";
import type { NodeExecutor } from "../../application/ports.js";
import { PiAgentExecutor } from "../pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../process/command-node-executor.js";
import {
  ANTHROPIC_SANDBOX_RUNTIME_VERSION,
  anthropicSandboxRuntimeManager,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../sandbox/anthropic-sandbox-runtime-manager.js";
import { SrtCommandSandbox } from "../sandbox/srt-command-sandbox.js";

export function createProductionCommandSandbox(): SrtCommandSandbox {
  const seccompApplyPath = resolveAnthropicSandboxRuntimeSeccompPath();
  return new SrtCommandSandbox(anthropicSandboxRuntimeManager, {
    backendVersion: ANTHROPIC_SANDBOX_RUNTIME_VERSION,
    ...(seccompApplyPath === undefined ? {} : { seccompApplyPath }),
  });
}

export function createProductionNodeExecutor(): NodeExecutor {
  return new NodeExecutorRouter(
    new CommandNodeExecutor({
      sandbox: createProductionCommandSandbox(),
    }),
    new PiAgentExecutor(),
  );
}
