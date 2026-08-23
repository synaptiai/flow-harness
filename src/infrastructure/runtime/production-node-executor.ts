import type { CommandSandbox } from "../../application/command-sandbox.js";
import { NodeExecutorRouter } from "../../application/node-executor-router.js";
import type { NodeExecutor } from "../../application/ports.js";
import type { FlowSandboxProfile } from "../../domain/config/resolver.js";
import type {
  PublicAvailabilityRequirement,
  PublicExecutionSeamInput,
} from "../../domain/capability/public-capability-reference.js";
import { createLocalSemanticToolSessionFactory } from "../lsp/local-semantic-code-service.js";
import { PiAgentExecutor } from "../pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../process/command-node-executor.js";
import {
  ANTHROPIC_SANDBOX_RUNTIME_VERSION,
  anthropicSandboxRuntimeManager,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../sandbox/anthropic-sandbox-runtime-manager.js";
import { SrtCommandSandbox } from "../sandbox/srt-command-sandbox.js";
import { createProductionContainerCommandSandbox } from "./production-container-command-sandbox.js";

export const PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR = Object.freeze({
  availability: Object.freeze([
    "production-sandbox",
  ] as const satisfies readonly PublicAvailabilityRequirement[]),
  create(sandbox: CommandSandbox): CommandNodeExecutor {
    return new CommandNodeExecutor({ sandbox });
  },
});

export const PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR = Object.freeze({
  reference: Object.freeze({
    id: "model-provider",
    title: "Model provider",
    summary: "Provider and model identifiers resolve through the embedded Pi adapter at runtime.",
    openness: "open",
    implementation: "pi",
  } as const satisfies PublicExecutionSeamInput),
  create(sandbox: CommandSandbox): PiAgentExecutor {
    return new PiAgentExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      createLocalSemanticToolSessionFactory(sandbox),
    );
  },
});

export function createProductionCommandSandbox(
  profile: FlowSandboxProfile = "native",
  projectRoot = process.cwd(),
): CommandSandbox {
  if (profile === "container") {
    return createProductionContainerCommandSandbox(projectRoot);
  }
  const seccompApplyPath = resolveAnthropicSandboxRuntimeSeccompPath();
  return new SrtCommandSandbox(anthropicSandboxRuntimeManager, {
    backendVersion: ANTHROPIC_SANDBOX_RUNTIME_VERSION,
    ...(seccompApplyPath === undefined ? {} : { seccompApplyPath }),
  });
}

export function createProductionNodeExecutor(
  profile: FlowSandboxProfile = "native",
  projectRoot = process.cwd(),
): NodeExecutor {
  const sandbox = createProductionCommandSandbox(profile, projectRoot);
  return new NodeExecutorRouter(
    PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR.create(sandbox),
    PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.create(sandbox),
  );
}
