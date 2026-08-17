import { describe, expect, it, vi } from "vitest";

import { generateAgentSkillPackageCandidate } from "../../../src/application/generate-agent-skill-package-candidate.js";
import type { AgentExecutor, NodeExecutionOutcome } from "../../../src/application/ports.js";
import {
  AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
} from "../../../src/domain/adaptation/agent-skill-package-candidate-generation.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  agentSkillPackageCandidateGenerationFixture,
  agentSkillPackageGenerationResponse,
  sha256,
} from "../../fixtures/agent-skill-package-candidate-generation.js";

describe("generate Agent Skill package candidate", () => {
  it("runs one exact zero-tool model turn and returns the validated package", async () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    const executor = fakeExecutor({
      status: "succeeded",
      evidence: agentEvidence(agentSkillPackageGenerationResponse),
    });
    const signal = new AbortController().signal;

    const completed = await generateAgentSkillPackageCandidate(
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
        id: "agent-skill-package-candidate-generation",
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
        workflowId: "adaptive-workflow",
        attempt: 1,
        cwd: "/project",
        projectRoot: "/project",
        protectedPaths: ["/project/.flow"],
        agentSystemPrompt: AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_SYSTEM_PROMPT,
        agentExactModelSettings: true,
        agentMaxOutputBytes: MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_BYTES,
        agentMaxOutputTokens: 8_192,
        signal,
      },
    );
    expect(completed.package).toMatchObject({ name: "review-helper" });
    expect(completed.generation).toMatchObject({
      provider: "test",
      model: "deterministic",
      usage: { outputTokens: 30 },
    });
  });

  it.each([
    {
      label: "wrong provider",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, { provider: "other" }),
      message: /provenance/,
    },
    {
      label: "wrong model",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, { model: "other" }),
      message: /provenance/,
    },
    {
      label: "changed text hash",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        textHash: "f".repeat(64),
      }),
      message: /text hash/,
    },
    {
      label: "truncated text",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, { textTruncated: true }),
      message: /truncated/,
    },
    {
      label: "policy activity",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        policyDecisions: [{} as never],
      }),
      message: /policy or effect activity/,
    },
    {
      label: "effect activity",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        effectReceipts: [{} as never],
      }),
      message: /policy or effect activity/,
    },
    {
      label: "capability activity",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, { capabilities: {} as never }),
      message: /capability activity/,
    },
    {
      label: "extra turn",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        activity: { turns: 2, toolCalls: 0, toolErrors: 0 },
      }),
      message: /one model turn/,
    },
    {
      label: "tool call",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        activity: { turns: 1, toolCalls: 1, toolErrors: 0 },
      }),
      message: /tool activity/,
    },
    {
      label: "tool error",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        activity: { turns: 1, toolCalls: 0, toolErrors: 1 },
      }),
      message: /tool activity/,
    },
    {
      label: "missing usage",
      evidence: agentEvidenceWithoutUsage(agentSkillPackageGenerationResponse),
      message: /usage/,
    },
    {
      label: "excess output usage",
      evidence: agentEvidence(agentSkillPackageGenerationResponse, {
        usage: {
          inputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 8_193,
          costUsdMicros: 0,
        },
      }),
      message: /token limit/,
    },
  ])("rejects $label evidence", async ({ evidence, message }) => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    await expect(
      generateAgentSkillPackageCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        fakeExecutor({ status: "succeeded", evidence }),
      ),
    ).rejects.toThrowError(message);
  });

  it("preserves exact cancellation and does not invoke the executor after pre-cancellation", async () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PRE_EXECUTION_CANCELLATION");
    controller.abort(reason);
    const executor = fakeExecutor({
      status: "succeeded",
      evidence: agentEvidence(agentSkillPackageGenerationResponse),
    });

    await expect(
      generateAgentSkillPackageCandidate(
        {
          prepared,
          cwd: "/project",
          protectedPaths: [],
          signal: controller.signal,
        },
        executor,
      ),
    ).rejects.toBe(reason);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("gives cancellation precedence over a private executor rejection", async () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    const controller = new AbortController();
    const reason = new Error("PRIVATE_EXECUTION_CANCELLATION");
    const executor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        controller.abort(reason);
        throw new Error("PRIVATE_PROVIDER_REJECTION");
      }),
    };

    await expect(
      generateAgentSkillPackageCandidate(
        {
          prepared,
          cwd: "/project",
          protectedPaths: [],
          signal: controller.signal,
        },
        executor,
      ),
    ).rejects.toBe(reason);
  });

  it("closes failed and non-Error executor rejections without a private cause", async () => {
    const { prepared } = agentSkillPackageCandidateGenerationFixture();
    for (const executor of [
      fakeExecutor({
        status: "failed",
        error: {
          code: "pi_agent_failed",
          message: "PRIVATE_PROVIDER_FAILURE",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      }),
      {
        execute: vi.fn<AgentExecutor["execute"]>(async () => {
          throw "PRIVATE_NON_ERROR_REJECTION";
        }),
      },
    ]) {
      let caught: unknown;
      try {
        await generateAgentSkillPackageCandidate(
          { prepared, cwd: "/project", protectedPaths: [] },
          executor,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(
        expect.objectContaining({
          code: "execution_failed",
          message: "execution_failed: Agent Skill package candidate generation failed",
        }),
      );
      expect(caught).not.toHaveProperty("cause");
      expect((caught as Error).message).not.toContain("PRIVATE");
    }
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

function agentEvidenceWithoutUsage(text: string): AgentEvidence {
  const { usage: _usage, ...evidence } = agentEvidence(text);
  return evidence;
}
