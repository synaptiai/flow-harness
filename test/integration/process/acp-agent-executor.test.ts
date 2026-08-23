import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  AcpAgentSandbox,
  AcpAgentSandboxRequest,
} from "../../../src/application/acp-agent-sandbox.js";
import type { PreparedCommand } from "../../../src/application/command-sandbox.js";
import {
  calculateAcpAgentSessionBindingDigest,
  type SandboxEvidence,
} from "../../../src/domain/run/events.js";
import type { CompiledAgentNode } from "../../../src/domain/workflow/types.js";
import { AcpAgentExecutor } from "../../../src/infrastructure/acp/acp-agent-executor.js";
import { acpAgentCapabilitySnapshot } from "../../fixtures/acp-agent.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/acp-agent/process-agent.mjs",
);

describe("local ACP process executor", () => {
  it("runs one fresh prompt-only process and records non-secret bound evidence", async () => {
    const lifecycle: string[] = [];
    const sandbox = fixtureSandbox("success", lifecycle);
    const executor = new AcpAgentExecutor({
      sandbox,
      platform: "darwin",
      assertCurrent: async () => {
        lifecycle.push("revalidated");
      },
      terminationGraceMs: 25,
      terminationConfirmationMs: 500,
    });

    const outcome = await executor.execute(agentNode(), context());

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded" || outcome.evidence.kind !== "agent") return;
    const evidence = outcome.evidence;
    expect(evidence.text).toBe("ACP process completed");
    expect(evidence.usageObservation).toEqual({
      modelTokens: { status: "complete", totalTokens: 21 },
      costUsd: { status: "unavailable" },
    });
    expect(evidence.acp).toMatchObject({
      executor: "local-acp-process-v1",
      agentName: "opencode",
      processContainment: "process-group",
      terminationStatus: "confirmed",
      runtimeIdentity: "revalidated",
      credentialLease: "srt-host-scoped-sentinel",
      updateCount: 1,
    });
    expect(evidence.acp?.sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.acp?.sessionIdHash).not.toContain("PRIVATE_SESSION_ID");
    expect(evidence.acp?.sessionBindingDigest).toBe(
      calculateAcpAgentSessionBindingDigest({
        runId: "run-1",
        workflowId: "workflow-1",
        nodeId: "agent-1",
        attempt: 2,
        agentDigest: evidence.acp?.agentDigest ?? "",
        sessionIdHash: evidence.acp?.sessionIdHash ?? "",
      }),
    );
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_SESSION_ID");
    expect(lifecycle).toEqual(["prepare", "revalidated", "beforeLaunch", "release"]);
    const request = sandbox.requests[0];
    expect(request).toMatchObject({
      executable: "/opt/flow/acp/opencode-a",
      args: ["--stdio"],
      projectRoot: "/project",
      providerDomain: "api.openai.com",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      runtimeSupportPaths: ["/opt/flow/acp/opencode-a"],
    });
    expect(request?.cwd).not.toBe("/project/workspace");
    await expect(access(request?.cwd ?? "")).rejects.toThrow();
  });

  it("terminates a tool-authority violation and marks possible effects uncertain", async () => {
    const sandbox = fixtureSandbox("tool");
    const executor = new AcpAgentExecutor({
      sandbox,
      platform: "darwin",
      assertCurrent: async () => undefined,
      terminationGraceMs: 25,
      terminationConfirmationMs: 500,
    });

    const outcome = await executor.execute(agentNode(), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "acp_agent_authority_violation",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: {
        acp: {
          authorityViolation: "tool",
          terminationStatus: "confirmed",
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_TOOL_ID");
  });

  it("times out a stalled prompt, confirms termination, and never retries", async () => {
    const sandbox = fixtureSandbox("hang");
    const executor = new AcpAgentExecutor({
      sandbox,
      platform: "darwin",
      assertCurrent: async () => undefined,
      terminationGraceMs: 25,
      terminationConfirmationMs: 500,
    });

    const outcome = await executor.execute(agentNode(500), context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "acp_agent_timeout",
        retryable: false,
        sideEffectStatus: "uncertain",
      },
      evidence: { acp: { terminationStatus: "confirmed" } },
    });
  });

  it("rejects prompt-only contract drift before preparing the sandbox", async () => {
    const sandbox = fixtureSandbox("success");
    const executor = new AcpAgentExecutor({
      sandbox,
      assertCurrent: async () => undefined,
    });
    const node = agentNode();
    const drifted = {
      ...node,
      agent: { ...node.agent, tools: ["read" as const] },
    };

    const outcome = await executor.execute(drifted, context());

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "acp_agent_contract_invalid", sideEffectStatus: "none" },
      evidence: null,
    });
    expect(sandbox.requests).toHaveLength(0);
  });
});

function fixtureSandbox(mode: string, lifecycle: string[] = []) {
  const requests: AcpAgentSandboxRequest[] = [];
  const sandbox: AcpAgentSandbox & { readonly requests: AcpAgentSandboxRequest[] } = {
    requests,
    async prepareAcpAgent(request): Promise<PreparedCommand> {
      requests.push(request);
      lifecycle.push("prepare");
      return {
        processContainment: "process-group",
        launch: {
          executable: process.execPath,
          args: [fixturePath, mode],
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
        },
        evidence: sandboxEvidence(),
        beforeLaunch: async () => {
          lifecycle.push("beforeLaunch");
        },
        release: async () => {
          lifecycle.push("release");
        },
      };
    },
  };
  return sandbox;
}

function sandboxEvidence(): SandboxEvidence {
  return {
    backend: "anthropic-sandbox-runtime",
    backendVersion: "0.0.70",
    profile: "acp-prompt-only-v1",
    policyDigest: "c".repeat(64),
  };
}

function agentNode(timeoutMs = 5_000): CompiledAgentNode {
  return {
    id: "agent-1",
    type: "agent",
    dependsOn: [],
    agent: {
      prompt: "Complete the bounded task.",
      model: { provider: "openai", id: "gpt-5.6-codex", thinking: "high" },
      tools: [],
      skills: [],
      toolPackages: [],
      timeoutMs,
    },
  };
}

function context() {
  return {
    runId: "run-1",
    workflowId: "workflow-1",
    attempt: 2,
    cwd: "/project/workspace",
    projectRoot: "/project",
    protectedPaths: ["/private/flow-state"],
    capabilitySnapshot: acpAgentCapabilitySnapshot(),
    agentSystemPrompt: "Follow the bounded Flow task.",
    modelWorkProfile: {
      profile: "standard" as const,
      remaining: {
        nodeStarts: 4,
        modelTokens: 10_000,
        modelCostUsdMicros: 2_000_000,
        executionMs: 20_000,
        artifactBytes: 50_000,
      },
    },
  };
}
