import { describe, expect, it } from "vitest";

import { calculatePromptCandidateGenerationResponseDigest } from "../../../src/domain/adaptation/prompt-candidate-generation-contract.js";
import {
  completePromptCandidateGeneration,
  MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE,
  MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_TARGETS,
  preparePromptCandidateGeneration,
  PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT,
  type PromptCandidateGenerationInput,
  PromptCandidateGenerationError,
} from "../../../src/domain/adaptation/prompt-candidate-generation.js";
import { parsePromptCandidateText } from "../../../src/domain/adaptation/prompt-candidate.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import {
  promptCandidateGenerationFixture,
  promptCandidateTuningEvidence,
  sha256,
} from "../../fixtures/prompt-candidate-generation.js";

describe("prompt candidate generation", () => {
  it("renders only permitted baseline prompts and tuning-only evidence", () => {
    const { baselineText, baseline, evidence, prepared } = promptCandidateGenerationFixture();

    expect(JSON.parse(prepared.renderedInput)).toMatchObject({
      version: 1,
      kind: "flow.prompt-candidate-generation-request/v1",
      baseline: {
        workflowId: "adaptive-workflow",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(baseline),
      },
      targets: [
        {
          nodeId: "implement",
          prompt: "Implement the task.",
          promptSha256: sha256("Implement the task."),
        },
      ],
      evidence: [
        {
          sourceSha256: sha256(JSON.stringify(evidence)),
          packet: { tasks: [{ id: "tune-task" }] },
        },
      ],
    });
    expect(prepared.requestDigest).toBe(sha256(prepared.renderedInput));
    expect(prepared.renderedInput).not.toContain("private-holdout-task");
    expect(prepared.renderedInput).not.toContain("SECRET.md");
    expect(prepared.renderedInput).not.toContain("Review the private result.");
    expect(prepared.renderedInput).not.toContain("tuning-evidence.json");
  });

  it("creates a normal candidate with exact generation provenance", () => {
    const { prepared } = promptCandidateGenerationFixture();
    const changes = [{ nodeId: "implement", value: "Read TASK.md and verify the result." }];
    const rawResponse = JSON.stringify({ changes }, undefined, 2);

    const candidate = completePromptCandidateGeneration(prepared, rawResponse, {
      inputTokens: 120,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 30,
      costUsdMicros: 45,
    });

    expect(parsePromptCandidateText(JSON.stringify(candidate))).toEqual(candidate);
    expect(candidate).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "generated-instructions", version: "1.0.0" },
      scope: { kind: "workflow", workflowId: "adaptive-workflow" },
      changes: {
        prompts: [
          {
            nodeId: "implement",
            expectedSha256: sha256("Implement the task."),
            value: "Read TASK.md and verify the result.",
          },
        ],
      },
      generation: {
        version: 1,
        kind: "model",
        provider: "test",
        model: "deterministic",
        thinking: "medium",
        systemPromptSha256: sha256(PROMPT_CANDIDATE_GENERATION_SYSTEM_PROMPT),
        requestDigest: prepared.requestDigest,
        responseDigest: calculatePromptCandidateGenerationResponseDigest(changes),
        targets: [{ nodeId: "implement", expectedSha256: sha256("Implement the task.") }],
        usage: {
          inputTokens: 120,
          cacheReadTokens: 20,
          cacheWriteTokens: 0,
          outputTokens: 30,
          costUsdMicros: 45,
        },
      },
    });
  });

  it("rejects unpermitted, duplicate, no-op, malformed, and oversized responses", () => {
    const { prepared } = promptCandidateGenerationFixture();
    const complete = (raw: string) =>
      completePromptCandidateGeneration(prepared, raw, {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsdMicros: 0,
      });

    expect(() =>
      complete(JSON.stringify({ changes: [{ nodeId: "private-review", value: "Changed." }] })),
    ).toThrowError(/not permitted/);
    expect(() =>
      complete(
        JSON.stringify({
          changes: [
            { nodeId: "implement", value: "Changed once." },
            { nodeId: "implement", value: "Changed twice." },
          ],
        }),
      ),
    ).toThrowError(/unique/);
    expect(() =>
      complete(
        JSON.stringify({ changes: [{ nodeId: "implement", value: "Implement the task." }] }),
      ),
    ).toThrowError(/must change/);
    expect(() => complete('{"changes":[],"extra":true}')).toThrowError(/invalid model response/);
    expect(() =>
      complete("x".repeat(MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES + 1)),
    ).toThrowError(
      new PromptCandidateGenerationError(
        "limit_exceeded",
        `generation response exceeds ${MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES} UTF-8 bytes`,
      ),
    );
  });

  it("accepts exact output limits and rejects one over each limit", () => {
    const { prepared } = promptCandidateGenerationFixture();
    const prefix = '{"changes":[{"nodeId":"implement","value":"';
    const suffix = '"}]}';
    const exactResponse = `${prefix}${"x".repeat(
      MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES - prefix.length - suffix.length,
    )}${suffix}`;

    expect(Buffer.byteLength(exactResponse, "utf8")).toBe(
      MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
    );
    expect(
      completePromptCandidateGeneration(prepared, exactResponse, {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 8_192,
        costUsdMicros: 0,
      }).changes.prompts[0]?.value,
    ).toHaveLength(MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES - prefix.length - suffix.length);
    expect(() =>
      completePromptCandidateGeneration(prepared, `${exactResponse} `, {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 8_192,
        costUsdMicros: 0,
      }),
    ).toThrowError(/exceeds 65536/);
    expect(() =>
      completePromptCandidateGeneration(prepared, exactResponse, {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 8_193,
        costUsdMicros: 0,
      }),
    ).toThrowError(/used 8193 tokens, above the 8192 token limit/);
  });

  it("rejects invalid identities, paths, targets, and limits before generation", () => {
    const { input } = promptCandidateGenerationFixture();
    const firstEvidence = input.evidence[0];
    if (firstEvidence === undefined) {
      throw new Error("generation fixture must contain tuning evidence");
    }
    const prepare = (overrides: Partial<typeof input>) =>
      preparePromptCandidateGeneration({ ...input, ...overrides });

    expect(() => prepare({ candidate: { id: "Invalid", version: "1.0.0" } })).toThrowError(
      /candidate id/,
    );
    expect(() => prepare({ candidate: { id: "valid", version: "next" } })).toThrowError(
      /candidate version/,
    );
    expect(() =>
      prepare({ model: { provider: "bad provider", id: "deterministic", thinking: "medium" } }),
    ).toThrowError(/provider/);
    expect(() =>
      prepare({
        evidence: [{ ...firstEvidence, provenance: "../tuning-evidence.json" }],
      }),
    ).toThrowError(/path/);
    expect(() =>
      prepare({
        evidence: [
          firstEvidence,
          { ...firstEvidence, provenance: "same-source-under-another-name.json" },
        ],
      }),
    ).toThrowError(/source identities.*unique/i);
    expect(() =>
      prepare({
        evidence: [
          firstEvidence,
          {
            ...firstEvidence,
            provenance: "same-packet-under-another-name.json",
            sourceSha256: "f".repeat(64),
          },
        ],
      }),
    ).toThrowError(/evidence digests.*unique/i);
    expect(() => prepare({ allowedNodeIds: ["missing"] })).toThrowError(/root agent node/);
    expect(() => prepare({ allowedNodeIds: ["implement", "implement"] })).toThrowError(/unique/);
    expect(() =>
      prepare({
        baseline: { ...input.baseline, workflowDigest: "f".repeat(64) },
      }),
    ).toThrowError(/compiled workflow digest/);
    expect(() =>
      prepare({
        baseline: {
          ...input.baseline,
          source: {
            ...input.baseline.source,
            nodes: input.baseline.source.nodes.map((node) =>
              node.id === "implement" && node.type === "agent"
                ? {
                    ...node,
                    agent: { ...node.agent, prompt: "A source prompt that was not compiled." },
                  }
                : node,
            ),
          },
        },
      }),
    ).toThrowError(/source prompt.*compiled workflow/i);
    expect(() => prepare({ limits: { ...input.limits, maxOutputTokens: 8_193 } })).toThrowError(
      /output-token limit/,
    );
  });

  it("accepts exact input, target, evidence, and timeout limits and rejects one over", () => {
    const basePrompts = ["x".repeat(262_144), "x".repeat(262_144), "x".repeat(262_144), "x"];
    const basePrepared = preparePromptCandidateGeneration(generationInput(basePrompts));
    const remaining =
      MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES -
      Buffer.byteLength(basePrepared.renderedInput, "utf8");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(262_144);

    const exactPrompts = [...basePrompts];
    exactPrompts[3] = `x${"x".repeat(remaining)}`;
    const exactInput = generationInput(exactPrompts);
    expect(
      Buffer.byteLength(preparePromptCandidateGeneration(exactInput).renderedInput, "utf8"),
    ).toBe(MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES);

    const oversizedPrompts = [...exactPrompts];
    oversizedPrompts[3] = `${oversizedPrompts[3]}x`;
    expect(() => preparePromptCandidateGeneration(generationInput(oversizedPrompts))).toThrowError(
      /generation input exceeds 1048576/,
    );

    expect(() =>
      preparePromptCandidateGeneration(
        generationInput(Array.from({ length: MAX_PROMPT_CANDIDATE_GENERATION_TARGETS }, () => "x")),
      ),
    ).not.toThrow();
    expect(() =>
      preparePromptCandidateGeneration(
        generationInput(
          Array.from({ length: MAX_PROMPT_CANDIDATE_GENERATION_TARGETS + 1 }, () => "x"),
        ),
      ),
    ).toThrowError(/between 1 and 16 unique targets/);

    const evidenceBoundary = generationInput(["x"], MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE);
    expect(() => preparePromptCandidateGeneration(evidenceBoundary)).not.toThrow();
    expect(() =>
      preparePromptCandidateGeneration(
        generationInput(["x"], MAX_PROMPT_CANDIDATE_GENERATION_EVIDENCE + 1),
      ),
    ).toThrowError(/between 1 and 16 unique evidence files/);

    expect(() =>
      preparePromptCandidateGeneration({
        ...generationInput(["x"]),
        limits: { timeoutMs: 1, maxOutputTokens: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      preparePromptCandidateGeneration({
        ...generationInput(["x"]),
        limits: { timeoutMs: 86_400_000, maxOutputTokens: 8_192 },
      }),
    ).not.toThrow();
    for (const timeoutMs of [0, 86_400_001]) {
      expect(() =>
        preparePromptCandidateGeneration({
          ...generationInput(["x"]),
          limits: { timeoutMs, maxOutputTokens: 1 },
        }),
      ).toThrowError(/generation timeout/);
    }
  });
});

function generationInput(
  prompts: readonly string[],
  evidenceCount = 1,
): PromptCandidateGenerationInput {
  const baselineText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "boundary-workflow" },
    nodes: [
      ...prompts.map((prompt, index) => ({
        id: `agent-${index}`,
        type: "agent",
        ...(index === 0 ? {} : { dependsOn: [`agent-${index - 1}`] }),
        agent: {
          prompt,
          model: { provider: "test", id: "deterministic", thinking: "off" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 300_000,
        },
      })),
      {
        id: "result",
        type: "result",
        dependsOn: [`agent-${prompts.length - 1}`],
        result: {
          source: { nodeId: `agent-${prompts.length - 1}`, field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
  const compiled = compileWorkflowText(baselineText, "boundary.workflow.json");
  const workflowDigest = calculateWorkflowDigest(compiled);
  const evidence = Array.from({ length: evidenceCount }, (_, index) => {
    const packet = promptCandidateTuningEvidence(workflowDigest, `boundary-evaluation-${index}`);
    return {
      provenance: `evidence-${index}.json`,
      sourceSha256: sha256(JSON.stringify(packet)),
      packet,
    };
  });
  return {
    candidate: { id: "boundary-candidate", version: "1.0.0" },
    baseline: {
      provenance: "boundary.workflow.json",
      sourceSha256: sha256(baselineText),
      workflowDigest,
      source: parseWorkflowSourceText(baselineText, "boundary.workflow.json"),
      compiled,
    },
    evidence,
    allowedNodeIds: prompts.map((_, index) => `agent-${index}`),
    model: { provider: "test", id: "deterministic", thinking: "off" },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  };
}
