import type { CommandSandbox } from "../../application/command-sandbox.js";
import type { AcpAgentSandbox } from "../../application/acp-agent-sandbox.js";
import { NodeExecutorRouter } from "../../application/node-executor-router.js";
import type {
  AgentExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "../../application/ports.js";
import type { FlowSandboxProfile } from "../../domain/config/resolver.js";
import type {
  PublicAvailabilityRequirement,
  PublicExecutionSeamInput,
} from "../../domain/capability/public-capability-reference.js";
import { createLocalSemanticToolSessionFactory } from "../lsp/local-semantic-code-service.js";
import { AcpAgentExecutor } from "../acp/acp-agent-executor.js";
import { PiAgentExecutor } from "../pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../process/command-node-executor.js";
import {
  ANTHROPIC_SANDBOX_RUNTIME_VERSION,
  anthropicSandboxRuntimeManager,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../sandbox/anthropic-sandbox-runtime-manager.js";
import { SrtCommandSandbox } from "../sandbox/srt-command-sandbox.js";
import { createProductionContainerCommandSandbox } from "./production-container-command-sandbox.js";
import type { CompiledAgentNode } from "../../domain/workflow/types.js";

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
    summary:
      "Provider and model identifiers resolve through embedded Pi or an exactly admitted prompt-only ACP agent at runtime.",
    openness: "open",
    implementation: "pi-acp",
  } as const satisfies PublicExecutionSeamInput),
  create(sandbox: CommandSandbox, acpSandbox: AcpAgentSandbox): ProductionAgentExecutor {
    const piExecutor = new PiAgentExecutor(
      undefined,
      undefined,
      undefined,
      undefined,
      createLocalSemanticToolSessionFactory(sandbox),
    );
    return new ProductionAgentExecutor(piExecutor, new AcpAgentExecutor({ sandbox: acpSandbox }));
  },
});

export class ProductionAgentExecutor implements AgentExecutor {
  constructor(
    readonly piExecutor: AgentExecutor,
    readonly acpExecutor: AgentExecutor,
  ) {}

  execute(node: CompiledAgentNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    return context.capabilitySnapshot?.acpAgent === undefined
      ? this.piExecutor.execute(node, context)
      : this.acpExecutor.execute(node, context);
  }
}

export function createProductionCommandSandbox(
  profile: FlowSandboxProfile = "native",
  projectRoot = process.cwd(),
): CommandSandbox {
  if (profile === "container") {
    return createProductionContainerCommandSandbox(projectRoot);
  }
  return createNativeSrtSandbox();
}

export function createProductionAcpAgentSandbox(commandSandbox: CommandSandbox): AcpAgentSandbox {
  return isAcpAgentSandbox(commandSandbox) ? commandSandbox : createNativeSrtSandbox();
}

function createNativeSrtSandbox(): SrtCommandSandbox {
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
  const acpSandbox = createProductionAcpAgentSandbox(sandbox);
  return new NodeExecutorRouter(
    PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR.create(sandbox),
    PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.create(sandbox, acpSandbox),
  );
}

function isAcpAgentSandbox(sandbox: CommandSandbox): sandbox is CommandSandbox & AcpAgentSandbox {
  return (
    "prepareAcpAgent" in sandbox &&
    typeof (sandbox as Partial<AcpAgentSandbox>).prepareAcpAgent === "function"
  );
}
