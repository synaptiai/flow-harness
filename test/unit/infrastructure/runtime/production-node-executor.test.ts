import { describe, expect, it, vi } from "vitest";
import { NodeExecutorRouter } from "../../../../src/application/node-executor-router.js";
import type { AgentExecutor } from "../../../../src/application/ports.js";
import { AcpAgentExecutor } from "../../../../src/infrastructure/acp/acp-agent-executor.js";
import { LocalContainerCommandSandbox } from "../../../../src/infrastructure/oci/local-container-command-sandbox.js";
import { LocalLeanProofDriver } from "../../../../src/infrastructure/oci/local-lean-proof-driver.js";
import { PiAgentExecutor } from "../../../../src/infrastructure/pi/pi-agent-executor.js";
import {
  createProductionAcpAgentSandbox,
  createProductionCommandSandbox,
  createProductionNodeExecutor,
  ProductionAgentExecutor,
} from "../../../../src/infrastructure/runtime/production-node-executor.js";
import { SrtCommandSandbox } from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";
import { acpAgentCapabilitySnapshot } from "../../../fixtures/acp-agent.js";

describe("production node executor composition", () => {
  it("keeps the native sandbox as the unchanged default", () => {
    expect(createProductionCommandSandbox()).toBeInstanceOf(SrtCommandSandbox);
    expect(createProductionCommandSandbox("native")).toBeInstanceOf(SrtCommandSandbox);
    const executor = createProductionNodeExecutor();
    expect(executor).toBeInstanceOf(NodeExecutorRouter);
    expect((executor as NodeExecutorRouter).agentExecutor).toBeInstanceOf(ProductionAgentExecutor);
    expect((executor as NodeExecutorRouter).leanProofDriver).toBeInstanceOf(LocalLeanProofDriver);
    const agentExecutor = (executor as NodeExecutorRouter).agentExecutor as ProductionAgentExecutor;
    expect(agentExecutor.piExecutor).toBeInstanceOf(PiAgentExecutor);
    expect(agentExecutor.acpExecutor).toBeInstanceOf(AcpAgentExecutor);
    expect((agentExecutor.piExecutor as PiAgentExecutor).semanticSessionFactory).toBeTypeOf(
      "function",
    );
    expect(createProductionNodeExecutor("native")).toBeDefined();
  });

  it("selects the container adapter without initializing its runtime", () => {
    const commandSandbox = createProductionCommandSandbox("container");
    expect(commandSandbox).toBeInstanceOf(LocalContainerCommandSandbox);
    expect(createProductionAcpAgentSandbox(commandSandbox)).toBeInstanceOf(SrtCommandSandbox);
    expect(createProductionNodeExecutor("container")).toBeDefined();
  });

  it("shares the native SRT coordinator and routes only admitted ACP snapshots", async () => {
    const nativeSandbox = createProductionCommandSandbox("native");
    expect(createProductionAcpAgentSandbox(nativeSandbox)).toBe(nativeSandbox);
    const piOutcome = failed("pi");
    const piExecute = vi.fn(async () => piOutcome);
    const acpExecute = vi.fn(async () => failed("acp"));
    const executor = new ProductionAgentExecutor(
      { execute: piExecute } satisfies AgentExecutor,
      { execute: acpExecute } satisfies AgentExecutor,
    );
    const node = agentNode();
    const baseContext = {
      runId: "run-1",
      workflowId: "workflow-1",
      attempt: 1,
      cwd: "/workspace",
      projectRoot: "/workspace",
      protectedPaths: [],
    };

    const unchangedPiOutcome = await executor.execute(node, baseContext);
    await executor.execute(node, {
      ...baseContext,
      capabilitySnapshot: acpAgentCapabilitySnapshot(),
    });

    expect(unchangedPiOutcome).toBe(piOutcome);
    expect(piExecute).toHaveBeenCalledTimes(1);
    expect(acpExecute).toHaveBeenCalledTimes(1);
  });

  it("fails an opted-in rolling-context ACP node before either executor runs", async () => {
    const piExecute = vi.fn(async () => failed("pi"));
    const acpExecute = vi.fn(async () => failed("acp"));
    const executor = new ProductionAgentExecutor(
      { execute: piExecute } satisfies AgentExecutor,
      { execute: acpExecute } satisfies AgentExecutor,
    );

    const outcome = await executor.execute(agentNode(), {
      runId: "run-1",
      workflowId: "workflow-1",
      attempt: 1,
      cwd: "/workspace",
      projectRoot: "/workspace",
      protectedPaths: [],
      capabilitySnapshot: acpAgentCapabilitySnapshot(),
      contextCompaction: {
        mode: "rolling",
        pressureThresholdPercent: 85,
        protectedConstraints: [],
      },
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "rolling_context_unsupported_acp",
        retryable: false,
        sideEffectStatus: "none",
      },
      evidence: null,
    });
    expect(piExecute).not.toHaveBeenCalled();
    expect(acpExecute).not.toHaveBeenCalled();
  });
});

function agentNode() {
  return {
    id: "agent-1",
    type: "agent" as const,
    dependsOn: [],
    agent: {
      prompt: "Complete the task.",
      model: { provider: "openai", id: "gpt-5.6-codex", thinking: "high" as const },
      tools: [],
      skills: [],
      toolPackages: [],
      timeoutMs: 1_000,
    },
  };
}

function failed(code: string) {
  return {
    status: "failed" as const,
    error: { code, message: code, retryable: false, sideEffectStatus: "none" as const },
    evidence: null,
  };
}
