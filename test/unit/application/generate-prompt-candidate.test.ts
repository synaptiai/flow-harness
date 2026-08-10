import { describe, expect, it, vi } from "vitest";

import {
  generatePromptCandidate,
  type PromptCandidateGenerationExecutionError,
} from "../../../src/application/generate-prompt-candidate.js";
import type { AgentExecutor, NodeExecutionOutcome } from "../../../src/application/ports.js";
import {
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "../../../src/domain/adaptation/prompt-candidate-generation.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  promptCandidateGenerationFixture,
  sha256,
} from "../../fixtures/prompt-candidate-generation.js";

describe("generate prompt candidate", () => {
  it("runs one zero-tool turn and returns a validated candidate", async () => {
    const { prepared } = promptCandidateGenerationFixture();
    const raw = JSON.stringify({
      changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
    });
    const executor = fakeExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const signal = new AbortController().signal;

    const candidate = await generatePromptCandidate(
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
        id: "prompt-candidate-generation",
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
        agentSystemPrompt: PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
        agentExactModelSettings: true,
        agentMaxOutputBytes: MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
        agentMaxOutputTokens: prepared.input.limits.maxOutputTokens,
        signal,
      },
    );
    expect(candidate.generation).toMatchObject({
      provider: "test",
      model: "deterministic",
      responseDigest: sha256(raw),
    });
  });

  it.each([
    {
      name: "executor failure",
      outcome: {
        status: "failed",
        error: {
          code: "pi_agent_failed",
          message: "provider failed",
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      } satisfies NodeExecutionOutcome,
      message: /provider failed/,
    },
    {
      name: "truncated text",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { textTruncated: true }),
      } satisfies NodeExecutionOutcome,
      message: /truncated/,
    },
    {
      name: "wrong provider",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", { provider: "other" }),
      } satisfies NodeExecutionOutcome,
      message: /provenance/,
    },
    {
      name: "tool activity",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          activity: { turns: 1, toolCalls: 1, toolErrors: 0 },
        }),
      } satisfies NodeExecutionOutcome,
      message: /tool activity/,
    },
    {
      name: "extra turns",
      outcome: {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          activity: { turns: 2, toolCalls: 0, toolErrors: 0 },
        }),
      } satisfies NodeExecutionOutcome,
      message: /one model turn/,
    },
    {
      name: "missing usage",
      outcome: {
        status: "succeeded",
        evidence: agentEvidenceWithoutUsage("{}"),
      } satisfies NodeExecutionOutcome,
      message: /usage/,
    },
  ])("rejects $name evidence", async ({ outcome, message }) => {
    const { prepared } = promptCandidateGenerationFixture();

    await expect(
      generatePromptCandidate(
        { prepared, cwd: "/project", protectedPaths: ["/project/.flow"] },
        fakeExecutor(outcome),
      ),
    ).rejects.toThrowError(message);
  });

  it("uses a bounded execution error", async () => {
    const { prepared } = promptCandidateGenerationFixture();
    const reason = "x".repeat(10_000);

    await expect(
      generatePromptCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        fakeExecutor({
          status: "failed",
          error: {
            code: "pi_agent_failed",
            message: reason,
            retryable: false,
            sideEffectStatus: "none",
          },
          evidence: null,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PromptCandidateGenerationExecutionError>>({
        name: "PromptCandidateGenerationExecutionError",
        code: "execution_failed",
      }),
    );
  });

  it("returns no candidate when cancellation wins after model execution", async () => {
    const { prepared } = promptCandidateGenerationFixture();
    const controller = new AbortController();
    const reason = new Error("candidate generation was cancelled after execution");
    const raw = JSON.stringify({
      changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
    });
    const executor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        controller.abort(reason);
        return { status: "succeeded", evidence: agentEvidence(raw) };
      }),
    };

    await expect(
      generatePromptCandidate(
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
});

function fakeExecutor(outcome: NodeExecutionOutcome): AgentExecutor & {
  execute: ReturnType<typeof vi.fn<AgentExecutor["execute"]>>;
} {
  return { execute: vi.fn<AgentExecutor["execute"]>(async () => outcome) };
}

function agentEvidence(text: string, overrides: Partial<AgentEvidence> = {}): AgentEvidence {
  const base: AgentEvidence = {
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
  };
  return { ...base, ...overrides };
}

function agentEvidenceWithoutUsage(text: string): AgentEvidence {
  const { usage: _usage, ...evidence } = agentEvidence(text);
  return evidence;
}
