import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AcpAgentSandbox } from "../../application/acp-agent-sandbox.js";
import type { CommandSandbox } from "../../application/command-sandbox.js";
import { NodeExecutorRouter } from "../../application/node-executor-router.js";
import type {
  AgentExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
  NodeExecutor,
} from "../../application/ports.js";
import type {
  PublicAvailabilityRequirement,
  PublicExecutionSeamInput,
} from "../../domain/capability/public-capability-reference.js";
import type { FlowSandboxProfile } from "../../domain/config/resolver.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import type { CompiledAgentNode } from "../../domain/workflow/types.js";
import { AcpAgentExecutor } from "../acp/acp-agent-executor.js";
import { createLocalSemanticToolSessionFactory } from "../lsp/local-semantic-code-service.js";
import { DockerUnixApiClient } from "../oci/docker-unix-api-client.js";
import { LocalLeanProofDriver } from "../oci/local-lean-proof-driver.js";
import { LocalLeanProofLeaseStore } from "../oci/local-lean-proof-lease-store.js";
import { LocalLeanProofRuntimeAdmission } from "../oci/local-lean-proof-runtime-admission.js";
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

export const PRODUCTION_LEAN_PROOF_VERIFIER_DESCRIPTOR = Object.freeze({
  reference: Object.freeze({
    id: "lean-proof-verifier",
    title: "Lean proof verifier",
    summary:
      "One exact human-approved statement runs through the admitted Linux x64 compiler, SafeVerify, Nanoda, and durable cleanup boundary.",
    openness: "open",
    implementation: "lean-proof-oci-v1",
  } as const satisfies PublicExecutionSeamInput),
});

export class ProductionAgentExecutor implements AgentExecutor {
  constructor(
    readonly piExecutor: AgentExecutor,
    readonly acpExecutor: AgentExecutor,
  ) {}

  execute(node: CompiledAgentNode, context: NodeExecutionContext): Promise<NodeExecutionOutcome> {
    if (
      context.capabilitySnapshot?.acpAgent !== undefined &&
      context.contextCompaction?.mode === "rolling"
    ) {
      return Promise.resolve({
        status: "failed",
        error: {
          code: "rolling_context_unsupported_acp",
          message:
            "rolling context requires an executor that exposes exact provider serialization and token admission",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      });
    }
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
    createProductionLeanProofDriver(projectRoot),
  );
}

export function createProductionLeanProofDriver(projectRoot = process.cwd()): LocalLeanProofDriver {
  const api = new DockerUnixApiClient({
    socketPath: "/var/run/docker.sock",
    apiVersion: "1.51",
  });
  const runtimeRoot = join(projectRoot, ".flow", "proof-runtime");
  const admission = new LocalLeanProofRuntimeAdmission({
    descriptorPath: join(runtimeRoot, "attestation.json"),
    inspectImage: (reference) => api.inspectImage(reference),
  });
  const seccompPath = fileURLToPath(
    new URL("../../../prime-container/seccomp.json", import.meta.url),
  );
  const seccompProfile = parseStrictJson(readFileSync(seccompPath, "utf8"), {
    maxDepth: 32,
    maxNodes: 32_768,
    valueLabel: "Lean proof seccomp profile",
  });
  if (
    typeof seccompProfile !== "object" ||
    seccompProfile === null ||
    Array.isArray(seccompProfile)
  ) {
    throw new Error("Lean proof seccomp profile must be one JSON object");
  }
  return new LocalLeanProofDriver({
    api,
    leaseStore: new LocalLeanProofLeaseStore({ directory: join(runtimeRoot, "leases") }),
    seccompProfile,
    admitRuntime: (runtime) => admission.admit(runtime),
  });
}

function isAcpAgentSandbox(sandbox: CommandSandbox): sandbox is CommandSandbox & AcpAgentSandbox {
  return (
    "prepareAcpAgent" in sandbox &&
    typeof (sandbox as Partial<AcpAgentSandbox>).prepareAcpAgent === "function"
  );
}
