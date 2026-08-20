import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createEffectiveHarnessState } from "../../../src/domain/adaptation/effective-harness-state.js";
import { MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES } from "../../../src/domain/adaptation/supplemental-memory.js";
import {
  completeSupplementalMemoryCandidateGeneration,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  prepareSupplementalMemoryCandidateGeneration,
  SupplementalMemoryCandidateGenerationError,
} from "../../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import { childSpecialistCandidateFixture } from "../../fixtures/child-specialist-candidate.js";
import { promptCandidateTuningEvidence } from "../../fixtures/prompt-candidate-generation.js";

describe("supplemental-memory candidate generation", () => {
  it("prepares one operator-selected add and accepts only the model-proposed value", () => {
    const input = generationInput(baselineState(), "add");
    const prepared = prepareSupplementalMemoryCandidateGeneration(input);
    const baseline = input.baseline;

    expect(JSON.parse(prepared.renderedInput)).toMatchObject({
      version: 1,
      kind: "flow.supplemental-memory-candidate-generation-request/v1",
      baseline: { stateDigest: baseline.stateDigest },
      target: {
        scope: {
          workflowId: baseline.workflowId,
          childPath: [],
          agentNodeId: "implement",
          entryId: "reviewed-fixture",
        },
        operation: "add",
        prior: null,
        agent: { prompt: "Implement the requested change." },
        memory: [],
      },
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      limits: { candidates: 1, turns: 1 },
    });

    const source = completeSupplementalMemoryCandidateGeneration(
      prepared,
      JSON.stringify({ value: "Use the reviewed fixture before changing generated output." }),
      usage(),
    );

    expect(source).toMatchObject({
      kind: "SupplementalMemoryCandidate",
      metadata: { id: "generated-memory", version: "1.0.0" },
      scope: {
        workflowId: baseline.workflowId,
        childPath: [],
        agentNodeId: "implement",
        entryId: "reviewed-fixture",
      },
      change: {
        kind: "add",
        value: "Use the reviewed fixture before changing generated output.",
      },
      generation: {
        kind: "model",
        operation: "add",
        priorSha256: null,
        requestDigest: prepared.requestDigest,
        limits: { candidates: 1, turns: 1 },
      },
    });
  });

  it("rejects model-supplied authority, malformed values, and values above the memory bound", () => {
    const prepared = prepareSupplementalMemoryCandidateGeneration(
      generationInput(baselineState(), "add"),
    );
    const privateCanary = "PRIVATE_MODEL_RESPONSE";
    const invalid = [
      JSON.stringify({ value: "Accepted.", operation: "remove" }),
      JSON.stringify({ value: "Accepted.", target: privateCanary }),
      JSON.stringify({ value: "   " }),
      JSON.stringify({ value: "\ud800" }),
      JSON.stringify({ value: "x".repeat(MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES + 1) }),
      `not-json-${privateCanary}`,
    ];

    for (const rawResponse of invalid) {
      const error = catchError(() =>
        completeSupplementalMemoryCandidateGeneration(prepared, rawResponse, usage()),
      );
      expect(error).toBeInstanceOf(SupplementalMemoryCandidateGenerationError);
      expect(error.message).not.toContain(privateCanary);
      expect(error.cause).toBeUndefined();
    }
  });

  it("accepts the exact response-byte bound and rejects bound plus one", () => {
    const prepared = prepareSupplementalMemoryCandidateGeneration(
      generationInput(baselineState(), "add"),
    );
    const response = JSON.stringify({ value: "Accepted." });
    const exact = `${response}${" ".repeat(
      MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES -
        Buffer.byteLength(response, "utf8"),
    )}`;

    expect(Buffer.byteLength(exact, "utf8")).toBe(
      MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
    );
    expect(
      completeSupplementalMemoryCandidateGeneration(prepared, exact, usage()).change,
    ).toMatchObject({ kind: "add", value: "Accepted." });
    expect(() =>
      completeSupplementalMemoryCandidateGeneration(prepared, `${exact} `, usage()),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryCandidateGenerationError>>({
        code: "limit_exceeded",
      }),
    );
  });

  it("binds replacement generation to the exact prior entry and rejects a no-op", () => {
    const prior = "Use the original reviewed fixture.";
    const prepared = prepareSupplementalMemoryCandidateGeneration(
      generationInput(stateWithMemory(prior), "replace"),
    );

    expect(JSON.parse(prepared.renderedInput).target.prior).toEqual({
      bytes: Buffer.byteLength(prior, "utf8"),
      sha256: sha256(prior),
      value: prior,
    });
    expect(() =>
      completeSupplementalMemoryCandidateGeneration(
        prepared,
        JSON.stringify({ value: prior }),
        usage(),
      ),
    ).toThrowError(/must change/);
    expect(
      completeSupplementalMemoryCandidateGeneration(
        prepared,
        JSON.stringify({ value: "Use the replacement reviewed fixture." }),
        usage(),
      ),
    ).toMatchObject({
      change: { kind: "replace", beforeSha256: sha256(prior) },
      generation: { operation: "replace", priorSha256: sha256(prior) },
    });
  });

  it("generates for one exact agent in an embedded child workflow", () => {
    const child = childSpecialistCandidateFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest: "a".repeat(64),
      workflowSource: child.baselineText,
      packages: child.packages,
    });
    const input = generationInput(baseline, "add");
    const prepared = prepareSupplementalMemoryCandidateGeneration({
      ...input,
      target: {
        ...input.target,
        workflowId: baseline.workflowId,
        childPath: ["delegate-review"],
        agentNodeId: "review",
      },
    });

    expect(JSON.parse(prepared.renderedInput).target).toMatchObject({
      scope: {
        workflowId: "specialist-harness",
        childPath: ["delegate-review"],
        agentNodeId: "review",
      },
      agent: { prompt: "Review the implementation against the declared task." },
    });
    expect(
      completeSupplementalMemoryCandidateGeneration(
        prepared,
        JSON.stringify({ value: "Use the reviewed child fixture." }),
        usage(),
      ),
    ).toMatchObject({
      scope: { childPath: ["delegate-review"], agentNodeId: "review" },
      change: { kind: "add", value: "Use the reviewed child fixture." },
    });
  });
});

function generationInput(baseline: ReturnType<typeof baselineState>, operation: "add" | "replace") {
  const evidence = promptCandidateTuningEvidence(baseline.workflow.workflowDigest);
  return {
    candidate: { id: "generated-memory", version: "1.0.0" },
    baseline,
    target: {
      workflowId: baseline.workflowId,
      childPath: [] as string[],
      agentNodeId: "implement",
      entryId: "reviewed-fixture",
      operation,
    },
    evidence: [
      {
        provenance: "tuning-evidence.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        packet: evidence,
      },
    ],
    model: { provider: "test", id: "deterministic", thinking: "medium" as const },
    limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
  };
}

function baselineState() {
  return createEffectiveHarnessState({
    scopeDigest: "a".repeat(64),
    workflowSource: workflowSource(),
    packages: [],
  });
}

function stateWithMemory(content: string) {
  return createEffectiveHarnessState({
    scopeDigest: "a".repeat(64),
    workflowSource: workflowSource(),
    packages: [],
    supplementalMemory: [
      {
        id: "reviewed-fixture",
        target: { workflowId: "memory-workflow", childPath: [], agentNodeId: "implement" },
        content,
      },
    ],
  });
}

function workflowSource(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "memory-workflow" },
    nodes: [
      {
        id: "implement",
        type: "agent",
        agent: {
          prompt: "Implement the requested change.",
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 10_000,
        },
      },
      {
        id: "publish",
        type: "result",
        dependsOn: ["implement"],
        result: {
          source: { nodeId: "implement", field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

function usage() {
  return {
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    costUsdMicros: 1,
  };
}

function catchError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected operation to fail");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
