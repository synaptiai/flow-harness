import { describe, expect, it, vi } from "vitest";

import {
  generateSupplementalMemoryCandidate,
  type SupplementalMemoryCandidateGenerationExecutionError,
} from "../../../src/application/generate-supplemental-memory-candidate.js";
import type { AgentExecutor, NodeExecutionOutcome } from "../../../src/application/ports.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
} from "../../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  sha256,
  supplementalMemoryCandidateGenerationFixture,
} from "../../fixtures/supplemental-memory-candidate-generation.js";

describe("generate supplemental-memory candidate", () => {
  it("runs one exact-model zero-tool turn and returns one validated value", async () => {
    const { prepared } = supplementalMemoryCandidateGenerationFixture();
    const raw = JSON.stringify({ value: "Use the reviewed fixture before changing output." });
    const executor = fakeExecutor({ status: "succeeded", evidence: agentEvidence(raw) });
    const signal = new AbortController().signal;

    const source = await generateSupplementalMemoryCandidate(
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
        id: "supplemental-memory-candidate-generation",
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
        workflowId: "memory-workflow",
        attempt: 1,
        cwd: "/project",
        projectRoot: "/project",
        protectedPaths: ["/project/.flow"],
        agentSystemPrompt: SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_SYSTEM_PROMPT,
        agentExactModelSettings: true,
        agentMaxOutputBytes: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
        agentMaxOutputTokens: prepared.input.limits.maxOutputTokens,
        signal,
      },
    );
    expect(source).toMatchObject({
      change: { kind: "add", value: "Use the reviewed fixture before changing output." },
      generation: { provider: "test", model: "deterministic" },
    });
  });

  it("rejects invalid or effect-bearing executor evidence without returning a candidate", async () => {
    const { prepared } = supplementalMemoryCandidateGenerationFixture();
    const privateCanary = "PRIVATE_EXECUTOR_VALUE";
    const cases: readonly NodeExecutionOutcome[] = [
      {
        status: "failed",
        error: {
          code: "pi_agent_failed",
          message: privateCanary,
          retryable: false,
          sideEffectStatus: "none",
        },
        evidence: null,
      },
      { status: "succeeded", evidence: agentEvidence("{}", { provider: "other" }) },
      { status: "succeeded", evidence: agentEvidence("{}", { model: "other" }) },
      { status: "succeeded", evidence: agentEvidence("{}", { textHash: "f".repeat(64) }) },
      { status: "succeeded", evidence: agentEvidence("{}", { textTruncated: true }) },
      { status: "succeeded", evidence: { kind: "command" } as never },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          activity: { turns: 2, toolCalls: 0, toolErrors: 0 },
        }),
      },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          activity: { turns: 1, toolCalls: 1, toolErrors: 0 },
        }),
      },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          activity: { turns: 1, toolCalls: 0, toolErrors: 1 },
        }),
      },
      {
        status: "succeeded",
        evidence: agentEvidenceWithoutActivity("{}"),
      },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", { policyDecisions: [{} as never] }),
      },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", {
          effectReceipts: [{} as never],
        }),
      },
      {
        status: "succeeded",
        evidence: agentEvidence("{}", { capabilities: {} as never }),
      },
      {
        status: "succeeded",
        evidence: agentEvidenceWithoutUsage("{}"),
      },
    ];

    for (const outcome of cases) {
      const error = await catchRejection(() =>
        generateSupplementalMemoryCandidate(
          { prepared, cwd: "/project", protectedPaths: [] },
          fakeExecutor(outcome),
        ),
      );
      expect(error).toEqual(
        expect.objectContaining<Partial<SupplementalMemoryCandidateGenerationExecutionError>>({
          name: "SupplementalMemoryCandidateGenerationExecutionError",
        }),
      );
      expect(error.message).not.toContain(privateCanary);
      expect(error.cause).toBeUndefined();
    }

    const throwingExecutor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        throw new Error(privateCanary);
      }),
    };
    const thrown = await catchRejection(() =>
      generateSupplementalMemoryCandidate(
        { prepared, cwd: "/project", protectedPaths: [] },
        throwingExecutor,
      ),
    );
    expect(thrown.message).not.toContain(privateCanary);
    expect(thrown.cause).toBeUndefined();
  });

  it("preserves exact cancellation before and after model execution", async () => {
    const { prepared } = supplementalMemoryCandidateGenerationFixture();
    const before = new AbortController();
    const beforeReason = new Error("cancel before generation");
    before.abort(beforeReason);
    const beforeExecutor = fakeExecutor({
      status: "succeeded",
      evidence: agentEvidence(JSON.stringify({ value: "Unused." })),
    });

    await expect(
      generateSupplementalMemoryCandidate(
        { prepared, cwd: "/project", protectedPaths: [], signal: before.signal },
        beforeExecutor,
      ),
    ).rejects.toBe(beforeReason);
    expect(beforeExecutor.execute).not.toHaveBeenCalled();

    const after = new AbortController();
    const afterReason = new Error("cancel after generation");
    const afterExecutor: AgentExecutor = {
      execute: vi.fn<AgentExecutor["execute"]>(async () => {
        after.abort(afterReason);
        return {
          status: "succeeded",
          evidence: agentEvidence(JSON.stringify({ value: "Unused." })),
        };
      }),
    };
    await expect(
      generateSupplementalMemoryCandidate(
        { prepared, cwd: "/project", protectedPaths: [], signal: after.signal },
        afterExecutor,
      ),
    ).rejects.toBe(afterReason);
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

function agentEvidenceWithoutActivity(text: string): AgentEvidence {
  const { activity: _activity, ...evidence } = agentEvidence(text);
  return evidence;
}

async function catchRejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected operation to reject");
}
