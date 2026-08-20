import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { createEffectiveHarnessState } from "../../../src/domain/adaptation/effective-harness-state.js";
import { MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES } from "../../../src/domain/adaptation/supplemental-memory.js";
import {
  completeSupplementalMemoryCandidateGeneration,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  prepareSupplementalMemoryCandidateGeneration,
  SupplementalMemoryCandidateGenerationError,
} from "../../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import type { TuningEvidencePacket } from "../../../src/domain/evaluation/tuning-evidence.js";
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

    const exactValue = "x".repeat(MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES);
    expect(
      completeSupplementalMemoryCandidateGeneration(
        prepared,
        JSON.stringify({ value: exactValue }),
        usage(),
      ).change,
    ).toMatchObject({ kind: "add", value: exactValue });
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

  it("accepts exact request, evidence, and execution limits and rejects one over", () => {
    const baseline = baselineState();
    const baseEvidence = expandedEvidence(baseline.workflow.workflowDigest, 64);
    const baseInput = { ...generationInput(baseline, "add"), evidence: baseEvidence };
    const base = prepareSupplementalMemoryCandidateGeneration(baseInput);
    const remaining =
      MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES -
      Buffer.byteLength(base.renderedInput, "utf8");
    expect(remaining).toBeGreaterThanOrEqual(0);

    const exactEvidence = expandedEvidence(baseline.workflow.workflowDigest, 64);
    addEvidenceReasonBytes(exactEvidence, remaining);
    const exact = prepareSupplementalMemoryCandidateGeneration({
      ...baseInput,
      evidence: exactEvidence,
    });
    expect(Buffer.byteLength(exact.renderedInput, "utf8")).toBe(
      MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_INPUT_BYTES,
    );

    const overflowEvidence = expandedEvidence(baseline.workflow.workflowDigest, 64);
    addEvidenceReasonBytes(overflowEvidence, remaining + 1);
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({ ...baseInput, evidence: overflowEvidence }),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryCandidateGenerationError>>({
        code: "limit_exceeded",
      }),
    );

    const evidenceBoundary = Array.from(
      { length: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE },
      (_, index) => evidenceItem(baseline.workflow.workflowDigest, index),
    );
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...generationInput(baseline, "add"),
        evidence: evidenceBoundary,
        limits: {
          timeoutMs: 86_400_000,
          maxOutputTokens: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
        },
      }),
    ).not.toThrow();
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...generationInput(baseline, "add"),
        evidence: [
          ...evidenceBoundary,
          evidenceItem(
            baseline.workflow.workflowDigest,
            MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE,
          ),
        ],
      }),
    ).toThrowError(/evidence set/);
  });

  it("rejects each invalid operator input before model execution", () => {
    const baseline = baselineState();
    const valid = generationInput(baseline, "add");
    const firstEvidence = valid.evidence[0];
    if (firstEvidence === undefined) throw new Error("generation evidence fixture is missing");
    const otherEvidence = evidenceItem(baseline.workflow.workflowDigest, 1);
    const cases = [
      { ...valid, candidate: { ...valid.candidate, id: "Invalid" } },
      { ...valid, candidate: { ...valid.candidate, version: "01.0.0" } },
      { ...valid, target: { ...valid.target, workflowId: "other-workflow" } },
      { ...valid, target: { ...valid.target, entryId: "invalid_entry" } },
      { ...valid, target: { ...valid.target, childPath: Array(9).fill("child") } },
      { ...valid, evidence: [] },
      {
        ...valid,
        evidence: [firstEvidence, { ...otherEvidence, provenance: firstEvidence.provenance }],
      },
      { ...valid, evidence: [firstEvidence, { ...firstEvidence, provenance: "other.json" }] },
      { ...valid, evidence: [{ ...firstEvidence, provenance: "../private.json" }] },
      { ...valid, evidence: [{ ...firstEvidence, sourceSha256: "f".repeat(63) }] },
      { ...valid, model: { ...valid.model, provider: "Invalid" } },
      { ...valid, model: { ...valid.model, id: "" } },
      { ...valid, model: { ...valid.model, id: "x".repeat(257) } },
      { ...valid, model: { ...valid.model, id: " padded" } },
      { ...valid, limits: { ...valid.limits, timeoutMs: 0 } },
      { ...valid, limits: { ...valid.limits, timeoutMs: 86_400_001 } },
      { ...valid, limits: { ...valid.limits, maxOutputTokens: 0 } },
      {
        ...valid,
        limits: {
          ...valid.limits,
          maxOutputTokens: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS + 1,
        },
      },
    ];

    for (const input of cases) {
      expect(() => prepareSupplementalMemoryCandidateGeneration(input)).toThrowError(
        SupplementalMemoryCandidateGenerationError,
      );
    }

    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...valid,
        target: { ...valid.target, agentNodeId: "missing-agent" },
      }),
    ).toThrowError(/agent node/);
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...valid,
        target: { ...valid.target, childPath: ["missing-child"] },
      }),
    ).toThrowError(/embedded child workflow/);
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...valid,
        target: { ...valid.target, operation: "replace" },
      }),
    ).toThrowError(/operation/);
    expect(() =>
      prepareSupplementalMemoryCandidateGeneration({
        ...valid,
        evidence: [evidenceItem("f".repeat(64), 2)],
      }),
    ).toThrowError(/effective workflow/);
  });

  it("binds every usage counter and the exact output-token limit", () => {
    const prepared = prepareSupplementalMemoryCandidateGeneration(
      generationInput(baselineState(), "add"),
    );
    const rawResponse = JSON.stringify({ value: "Accepted." });
    expect(
      completeSupplementalMemoryCandidateGeneration(prepared, rawResponse, {
        ...usage(),
        outputTokens: prepared.input.limits.maxOutputTokens,
      }),
    ).toMatchObject({
      generation: { usage: { outputTokens: prepared.input.limits.maxOutputTokens } },
    });

    for (const invalidUsage of [
      { ...usage(), inputTokens: -1 },
      { ...usage(), cacheReadTokens: -1 },
      { ...usage(), cacheWriteTokens: -1 },
      { ...usage(), outputTokens: -1 },
      { ...usage(), costUsdMicros: -1 },
      { ...usage(), inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...usage(), outputTokens: prepared.input.limits.maxOutputTokens + 1 },
    ]) {
      expect(() =>
        completeSupplementalMemoryCandidateGeneration(prepared, rawResponse, invalidUsage),
      ).toThrowError(
        expect.objectContaining<Partial<SupplementalMemoryCandidateGenerationError>>({
          code: "invalid_output",
        }),
      );
    }
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

function evidenceItem(workflowDigest: string, index: number) {
  const packet = promptCandidateTuningEvidence(workflowDigest, `boundary-evaluation-${index}`);
  return {
    provenance: `evidence-${index}.json`,
    sourceSha256: sha256(JSON.stringify(packet)),
    packet,
  };
}

function expandedEvidence(workflowDigest: string, taskCount: number) {
  return Array.from(
    { length: MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_EVIDENCE },
    (_, index) => {
      const packet = structuredClone(
        promptCandidateTuningEvidence(workflowDigest, `expanded-evaluation-${index}`),
      ) as DeepMutable<TuningEvidencePacket>;
      const baseTask = requiredItem(packet.tasks, 0, "expanded evidence task");
      packet.tasks = Array.from({ length: taskCount }, (__, taskIndex) => ({
        id: `tune-${taskIndex}`,
        trials: structuredClone(baseTask.trials),
      }));
      packet.evaluation.completedTrials = taskCount * 2;
      packet.evaluation.scheduledTrials = taskCount * 2;
      recomputeEvidenceDigest(packet);
      return {
        provenance: `expanded-${index}.json`,
        sourceSha256: sha256(JSON.stringify(packet)),
        packet,
      };
    },
  );
}

function addEvidenceReasonBytes(
  evidence: ReturnType<typeof expandedEvidence>,
  addedBytes: number,
): void {
  let remaining = addedBytes;
  for (const item of evidence) {
    for (const task of item.packet.tasks) {
      for (const trial of task.trials) {
        if (remaining === 0) break;
        const increment = Math.min(remaining, 510);
        trial.harness.reason = "x".repeat(increment + 2);
        remaining -= increment;
      }
    }
    recomputeEvidenceDigest(item.packet);
    item.sourceSha256 = sha256(JSON.stringify(item.packet));
  }
  if (remaining !== 0) {
    throw new Error("input-boundary fixture has insufficient bounded reason capacity");
  }
}

function recomputeEvidenceDigest(packet: DeepMutable<TuningEvidencePacket>): void {
  const { evidenceDigest: _evidenceDigest, ...content } = packet;
  packet.evidenceDigest = sha256(canonicalize(content));
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("input-boundary fixture contains a non-canonical value");
}

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

function requiredItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) throw new Error(`${label} fixture is missing`);
  return item;
}
