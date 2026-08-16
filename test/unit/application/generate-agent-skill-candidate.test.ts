import { describe, expect, it, vi } from "vitest";

import {
  type AgentSkillCandidateGenerationExecutionError,
  generateAgentSkillCandidate,
} from "../../../src/application/generate-agent-skill-candidate.js";
import type { AgentExecutor, NodeExecutionOutcome } from "../../../src/application/ports.js";
import {
  AGENT_SKILL_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
  prepareAgentSkillCandidateGeneration,
} from "../../../src/domain/adaptation/agent-skill-candidate-generation.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  agentSkillCandidateGenerationFixture,
  sha256,
} from "../../fixtures/agent-skill-candidate-generation.js";

describe("generate Agent Skill candidate", () => {
  it("runs one exact zero-tool turn and returns a validated candidate", async () => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    const raw = JSON.stringify({
      changes: [{ path: "references/checklist.md", value: "Check more carefully." }],
    });
    const executor = fakeExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const signal = new AbortController().signal;

    const candidate = await generateAgentSkillCandidate(
      {
        prepared,
        cwd: "/project",
        projectRoot: "/project",
        protectedPaths: ["/project/.flow"],
        signal,
      },
      executor,
    );

    expect(executor.execute).toHaveBeenCalledWith(
      {
        id: "agent-skill-candidate-generation",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt: prepared.renderedInput,
          model: prepared.input.model,
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: prepared.input.limits.timeoutMs,
        },
      },
      {
        runId: `candidate-generation-${prepared.requestDigest}`,
        workflowId: "adaptive-skill-workflow",
        attempt: 1,
        cwd: "/project",
        projectRoot: "/project",
        protectedPaths: ["/project/.flow"],
        agentSystemPrompt: AGENT_SKILL_CANDIDATE_GENERATION_SYSTEM_PROMPT,
        agentExactModelSettings: true,
        agentMaxOutputBytes: MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_BYTES,
        agentMaxOutputTokens: prepared.input.limits.maxOutputTokens,
        signal,
      },
    );
    expect(candidate.generation).toMatchObject({ provider: "test", model: "deterministic" });
  });

  it.each([
    {
      label: "wrong provider",
      outcome: { status: "succeeded", evidence: agentEvidence("{}", { provider: "other" }) },
      message: /provenance/,
    },
    {
      label: "wrong model",
      outcome: { status: "succeeded", evidence: agentEvidence("{}", { model: "other" }) },
      message: /provenance/,
    },
    {
      label: "changed text hash",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { textHash: "f".repeat(64) }),
      },
      message: /text hash/,
    },
    {
      label: "truncated text",
      outcome: { status: "succeeded", evidence: agentEvidence("{}", { textTruncated: true }) },
      message: /truncated/,
    },
    {
      label: "policy activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { policyDecisions: [{} as never] }),
      },
      message: /policy or effect activity/,
    },
    {
      label: "effect activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { effectReceipts: [{} as never] }),
      },
      message: /policy or effect activity/,
    },
    {
      label: "capability activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { capabilities: {} as never }),
      },
      message: /capability activity/,
    },
    {
      label: "missing activity",
      outcome: { status: "succeeded", evidence: agentEvidenceWithoutActivity("{}") },
      message: /one model turn/,
    },
    {
      label: "tool activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { activity: { turns: 1, toolCalls: 1, toolErrors: 0 } }),
      },
      message: /tool activity/,
    },
    {
      label: "tool error activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { activity: { turns: 1, toolCalls: 0, toolErrors: 1 } }),
      },
      message: /tool activity/,
    },
    {
      label: "extra turn",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { activity: { turns: 2, toolCalls: 0, toolErrors: 0 } }),
      },
      message: /one model turn/,
    },
    {
      label: "missing usage",
      outcome: { status: "succeeded", evidence: agentEvidenceWithoutUsage("{}") },
      message: /usage/,
    },
    {
      label: "excess output-token usage",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          usage: {
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 8_193,
            costUsdMicros: 0,
          },
        }),
      },
      message: /token limit/,
    },
    {
      label: "invalid usage counter",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          usage: {
            inputTokens: -1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1,
            costUsdMicros: 0,
          },
        }),
      },
      message: /usage is invalid/,
    },
    {
      label: "non-agent evidence",
      outcome: { status: "succeeded", evidence: { kind: "command" } as never },
      message: /non-agent evidence/,
    },
  ])("rejects $label evidence", async ({ outcome, message }) => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    await expect(
      generateAgentSkillCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        fakeExecutor(outcome as NodeExecutionOutcome),
      ),
    ).rejects.toThrowError(message);
  });

  it("preserves cancellation after execution and bounds provider failures", async () => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CANCEL_REASON");
    const raw = JSON.stringify({
      changes: [{ path: "references/checklist.md", value: "Check more carefully." }],
    });
    const executor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        controller.abort(reason);
        return { status: "succeeded", evidence: agentEvidence(raw) };
      }),
    };
    await expect(
      generateAgentSkillCandidate(
        { prepared, cwd: "/project", protectedPaths: [], signal: controller.signal },
        executor,
      ),
    ).rejects.toBe(reason);

    const privateProviderError = "PRIVATE_PROVIDER_FAILURE";
    let providerFailure: unknown;
    try {
      await generateAgentSkillCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        fakeExecutor({
          status: "failed",
          error: {
            code: "pi_agent_failed",
            message: privateProviderError,
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: null,
        }),
      );
    } catch (error) {
      providerFailure = error;
    }
    expect(providerFailure).toEqual(
      expect.objectContaining<Partial<AgentSkillCandidateGenerationExecutionError>>({
        name: "AgentSkillCandidateGenerationExecutionError",
        code: "execution_failed",
        message: "execution_failed: Agent Skill candidate generation failed",
      }),
    );
    expect(providerFailure).not.toHaveProperty("cause");
    expect((providerFailure as Error).message).not.toContain(privateProviderError);
  });

  it("does not cross a cancelled executor boundary and closes rejected executor values", async () => {
    const prepared = prepareAgentSkillCandidateGeneration(
      agentSkillCandidateGenerationFixture().input,
    );
    const preCancelled = new AbortController();
    const preCancelledReason = new Error("PRIVATE_PRE_EXECUTION_CANCELLATION");
    preCancelled.abort(preCancelledReason);
    const executor = fakeExecutor({ status: "succeeded", evidence: agentEvidence("{}") });

    await expect(
      generateAgentSkillCandidate(
        {
          prepared,
          cwd: "/project",
          protectedPaths: [],
          signal: preCancelled.signal,
        },
        executor,
      ),
    ).rejects.toBe(preCancelledReason);
    expect(executor.execute).not.toHaveBeenCalled();

    const duringExecution = new AbortController();
    const duringExecutionReason = new Error("PRIVATE_EXECUTION_CANCELLATION");
    const rejectingExecutor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        duringExecution.abort(duringExecutionReason);
        throw new Error("PRIVATE_PROVIDER_REJECTION");
      }),
    };
    await expect(
      generateAgentSkillCandidate(
        {
          prepared,
          cwd: "/project",
          protectedPaths: [],
          signal: duringExecution.signal,
        },
        rejectingExecutor,
      ),
    ).rejects.toBe(duringExecutionReason);

    let rejectedValue: unknown;
    try {
      await generateAgentSkillCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        {
          execute: vi.fn<AgentExecutor["execute"]>(async () => {
            throw "PRIVATE_NON_ERROR_REJECTION";
          }),
        },
      );
    } catch (error) {
      rejectedValue = error;
    }
    expect(rejectedValue).toEqual(
      expect.objectContaining({
        code: "execution_failed",
        message: "execution_failed: Agent Skill candidate generation failed",
      }),
    );
    expect(rejectedValue).not.toHaveProperty("cause");
    expect((rejectedValue as Error).message).not.toContain("PRIVATE_NON_ERROR_REJECTION");
  });
});

function fakeExecutor(outcome: NodeExecutionOutcome): AgentExecutor & {
  execute: ReturnType<typeof vi.fn<AgentExecutor["execute"]>>;
} {
  return { execute: vi.fn<AgentExecutor["execute"]>(async () => outcome) };
}

function agentEvidence(text: string, overrides: Partial<AgentEvidence> = {}): AgentEvidence {
  return {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 5,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      costUsdMicros: 45,
    },
    activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
    policyDecisions: [],
    effectReceipts: [],
    ...overrides,
  };
}

function agentEvidenceWithoutActivity(text: string): AgentEvidence {
  const { activity: _activity, ...evidence } = agentEvidence(text);
  return evidence;
}

function agentEvidenceWithoutUsage(text: string): AgentEvidence {
  const { usage: _usage, ...evidence } = agentEvidence(text);
  return evidence;
}
