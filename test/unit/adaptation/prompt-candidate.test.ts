import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { completePromptCandidateGeneration } from "../../../src/domain/adaptation/prompt-candidate-generation.js";
import {
  MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES,
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES,
  calculatePromptCandidateGenerationRequestDigest,
  calculatePromptCandidateGenerationResponseDigest,
  renderPromptCandidateGenerationRequest,
} from "../../../src/domain/adaptation/prompt-candidate-generation-contract.js";
import {
  MAX_PROMPT_CANDIDATE_CHANGES,
  MAX_PROMPT_CANDIDATE_EVIDENCE,
  MAX_PROMPT_CANDIDATE_PROJECTED_WORKFLOW_BYTES,
  PromptCandidateError,
  parsePromptCandidateIdentity,
  parsePromptCandidateText,
  projectPromptCandidate,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import { createEvaluationSchedule } from "../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../src/domain/evaluation/records.js";
import { createTuningEvidencePacket } from "../../../src/domain/evaluation/tuning-evidence.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { workflowSourceSchema } from "../../../src/domain/workflow/schema.js";
import { promptCandidateGenerationFixture } from "../../fixtures/prompt-candidate-generation.js";

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "adaptive-workflow" },
  budget: {
    maxNodeStarts: 8,
    maxModelTokens: 10_000,
    maxCostUsd: 1,
    maxExecutionMs: 300_000,
    maxArtifactBytes: 1_048_576,
  },
  nodes: [
    {
      id: "implement",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Implement the task.",
        model: { provider: "test", id: "deterministic", thinking: "medium" },
        tools: ["read", "edit"],
        skills: [],
        toolPackages: [],
        timeoutMs: 300_000,
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

describe("prompt candidates", () => {
  it("uses the activation source limit for projected workflows", () => {
    expect(MAX_PROMPT_CANDIDATE_PROJECTED_WORKFLOW_BYTES).toBe(8 * 1024 * 1024);
    expect(
      Buffer.byteLength(projectPromptCandidate(projectionContext()).workflow.source, "utf8"),
    ).toBeLessThan(MAX_PROMPT_CANDIDATE_PROJECTED_WORKFLOW_BYTES);

    const exact = structuredClone(projectionContext()) as MutableProjectionContext;
    const nodes = exact.baseline.source.nodes as unknown as Array<Record<string, unknown>>;
    let predecessor = "implement";
    for (let index = 0; index < 31; index += 1) {
      nodes.push(paddingAgentNode(index, predecessor, "x".repeat(262_144)));
      predecessor = `padding-${index}`;
    }
    nodes.push(paddingAgentNode(31, predecessor, "x"));
    const publish = nodes.find((node) => node.id === "publish");
    if (publish === undefined) {
      throw new Error("projected workflow boundary fixture has no publish node");
    }
    publish.dependsOn = ["implement", "padding-31"];
    const baseBytes = Buffer.byteLength(projectPromptCandidate(exact).workflow.source, "utf8");
    const remaining = MAX_PROMPT_CANDIDATE_PROJECTED_WORKFLOW_BYTES - baseBytes;
    const finalNode = nodes.at(-1) as { agent?: { prompt?: string } } | undefined;
    if (finalNode?.agent?.prompt === undefined) {
      throw new Error("projected workflow boundary fixture has no final prompt");
    }
    finalNode.agent.prompt += "x".repeat(remaining);
    expect(Buffer.byteLength(projectPromptCandidate(exact).workflow.source, "utf8")).toBe(
      MAX_PROMPT_CANDIDATE_PROJECTED_WORKFLOW_BYTES,
    );

    const oversized = structuredClone(exact) as MutableProjectionContext;
    const oversizedNodes = oversized.baseline.source.nodes as unknown as Array<{
      agent?: { prompt?: string };
    }>;
    const oversizedPrompt = oversizedNodes.at(-1)?.agent;
    if (oversizedPrompt?.prompt === undefined) {
      throw new Error("projected workflow boundary fixture has no oversized prompt");
    }
    oversizedPrompt.prompt += "x";
    expect(() => projectPromptCandidate(oversized)).toThrowError(
      expect.objectContaining({ code: "limit_exceeded" }),
    );
  }, 20_000);

  it("parses a strict versioned prompt-only source", () => {
    const source = parsePromptCandidateText(candidateText(), "candidate.yaml");

    expect(source).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "better-instructions", version: "1.0.0" },
      scope: { kind: "workflow", workflowId: "adaptive-workflow" },
      changes: {
        prompts: [
          {
            nodeId: "implement",
            expectedSha256: sha256("Implement the task."),
            value: "Read TASK.md, implement it, and verify the result.",
          },
        ],
      },
    });
  });

  it("preserves exact prompt whitespace while rejecting blank replacements", () => {
    const candidate = JSON.parse(candidateText());
    candidate.changes.prompts[0].value = "  Read TASK.md exactly.  \n";

    expect(parsePromptCandidateText(JSON.stringify(candidate)).changes.prompts[0]?.value).toBe(
      "  Read TASK.md exactly.  \n",
    );

    candidate.changes.prompts[0].value = " \n\t ";
    expect(() => parsePromptCandidateText(JSON.stringify(candidate))).toThrowError(
      /invalid_schema/,
    );
  });

  it("rejects generation provenance that contradicts the version-one contract", () => {
    const generated = generatedCandidate();
    expect(parsePromptCandidateText(JSON.stringify(generated))).toEqual(generated);

    const wrongSystemPrompt = structuredClone(generated);
    requiredGeneration(wrongSystemPrompt).systemPromptSha256 = "f".repeat(64);
    expect(() => parsePromptCandidateText(JSON.stringify(wrongSystemPrompt))).toThrowError(
      /invalid_schema/,
    );

    const wrongInputLimit = structuredClone(generated);
    requiredGeneration(wrongInputLimit).limits.maxInputBytes += 1;
    expect(() => parsePromptCandidateText(JSON.stringify(wrongInputLimit))).toThrowError(
      /invalid_schema/,
    );

    const wrongOutputLimit = structuredClone(generated);
    requiredGeneration(wrongOutputLimit).limits.maxOutputBytes += 1;
    expect(() => parsePromptCandidateText(JSON.stringify(wrongOutputLimit))).toThrowError(
      /invalid_schema/,
    );

    const wrongTokenLimit = structuredClone(generated);
    requiredGeneration(wrongTokenLimit).limits.maxOutputTokens = 8_193;
    expect(() => parsePromptCandidateText(JSON.stringify(wrongTokenLimit))).toThrowError(
      /invalid_schema/,
    );

    const impossibleUsage = structuredClone(generated);
    requiredGeneration(impossibleUsage).limits.maxOutputTokens = 1;
    requiredGeneration(impossibleUsage).usage.outputTokens = 2;
    expect(() => parsePromptCandidateText(JSON.stringify(impossibleUsage))).toThrowError(
      /invalid_schema/,
    );

    const wrongTarget = structuredClone(generatedProjectionContext()) as DeepMutable<
      ReturnType<typeof generatedProjectionContext>
    >;
    const wrongTargetGeneration = wrongTarget.source.generation;
    if (wrongTargetGeneration === undefined) {
      throw new Error("generated projection fixture has no generation provenance");
    }
    wrongTargetGeneration.targets[0] = {
      nodeId: "private-review",
      expectedSha256: sha256("Review the private result."),
    };
    refreshCandidateSourceHash(wrongTarget);
    expect(() => projectPromptCandidate(wrongTarget)).toThrowError(/generation target/i);

    const wrongRequest = structuredClone(generatedProjectionContext()) as DeepMutable<
      ReturnType<typeof generatedProjectionContext>
    >;
    const wrongRequestGeneration = wrongRequest.source.generation;
    if (wrongRequestGeneration === undefined) {
      throw new Error("generated projection fixture has no generation provenance");
    }
    wrongRequestGeneration.requestDigest = "f".repeat(64);
    refreshCandidateSourceHash(wrongRequest);
    expect(() => projectPromptCandidate(wrongRequest)).toThrowError(/generation request digest/i);

    const wrongResponse = structuredClone(generatedProjectionContext()) as DeepMutable<
      ReturnType<typeof generatedProjectionContext>
    >;
    const wrongResponseGeneration = wrongResponse.source.generation;
    if (wrongResponseGeneration === undefined) {
      throw new Error("generated projection fixture has no generation provenance");
    }
    wrongResponseGeneration.responseDigest = "f".repeat(64);
    refreshCandidateSourceHash(wrongResponse);
    expect(() => projectPromptCandidate(wrongResponse)).toThrowError(/generation response digest/i);
  });

  it("rejects padded model provenance in source and durable identity", () => {
    const paddedSource = structuredClone(generatedCandidate());
    const sourceGeneration = requiredGeneration(paddedSource);
    sourceGeneration.model = ` ${sourceGeneration.model} `;
    expect(() => parsePromptCandidateText(JSON.stringify(paddedSource))).toThrowError(
      /invalid_schema/,
    );

    const identity = structuredClone(projectPromptCandidate(generatedProjectionContext()).identity);
    if (identity.generation === undefined) {
      throw new Error("generated identity fixture has no generation provenance");
    }
    identity.generation.model = ` ${identity.generation.model} `;
    expect(() => parsePromptCandidateIdentity(identity)).toThrowError(/identity_mismatch/);
  });

  it("rejects replay provenance above the request and response byte limits", () => {
    const oversizedResponse = structuredClone(generatedProjectionContext()) as DeepMutable<
      ReturnType<typeof generatedProjectionContext>
    >;
    const responseChange = requiredFirst(
      oversizedResponse.source.changes.prompts,
      "generated response change",
    );
    const responseGeneration = oversizedResponse.source.generation;
    if (responseGeneration === undefined) {
      throw new Error("generated response fixture has no generation provenance");
    }
    const emptyResponseBytes = Buffer.byteLength(
      JSON.stringify({ changes: [{ nodeId: responseChange.nodeId, value: "" }] }),
      "utf8",
    );
    responseChange.value = "x".repeat(
      MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES - emptyResponseBytes + 1,
    );
    const responseChanges = [{ nodeId: responseChange.nodeId, value: responseChange.value }];
    expect(Buffer.byteLength(JSON.stringify({ changes: responseChanges }), "utf8")).toBe(
      MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_BYTES + 1,
    );
    responseGeneration.responseDigest =
      calculatePromptCandidateGenerationResponseDigest(responseChanges);
    refreshCandidateSourceHash(oversizedResponse);
    expect(() => projectPromptCandidate(oversizedResponse)).toThrowError(
      /generation response.*byte limit/i,
    );

    const oversizedRequest = oversizedGenerationRequestContext();
    expect(oversizedRequest.requestBytes).toBe(MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES + 1);
    expect(() => projectPromptCandidate(oversizedRequest.context)).toThrowError(
      /generation request.*byte limit/i,
    );
  });

  it("enforces evidence, change, prompt, and diagnostic bounds", () => {
    const candidate = JSON.parse(candidateText());
    candidate.evidence = Array.from({ length: MAX_PROMPT_CANDIDATE_EVIDENCE + 1 }, (_, index) => ({
      path: `evidence-${index}.json`,
      sourceSha256: index.toString(16).padStart(64, "0"),
      evidenceDigest: (index + 32).toString(16).padStart(64, "0"),
      planDigest: "a".repeat(64),
    }));
    expect(() => parsePromptCandidateText(JSON.stringify(candidate))).toThrowError(
      /invalid_schema/,
    );

    const tooManyChanges = JSON.parse(candidateText());
    tooManyChanges.changes.prompts = Array.from(
      { length: MAX_PROMPT_CANDIDATE_CHANGES + 1 },
      (_, index) => ({
        nodeId: `agent-${index}`,
        expectedSha256: "a".repeat(64),
        value: "Improve the task.",
      }),
    );
    expect(() => parsePromptCandidateText(JSON.stringify(tooManyChanges))).toThrowError(
      /invalid_schema/,
    );

    const oversizedPrompt = JSON.parse(candidateText());
    oversizedPrompt.changes.prompts[0].value = "x".repeat(262_145);
    expect(() => parsePromptCandidateText(JSON.stringify(oversizedPrompt))).toThrowError(
      /invalid_schema/,
    );

    const hostileDiagnostic = JSON.parse(candidateText());
    hostileDiagnostic["x".repeat(900_000)] = true;
    try {
      parsePromptCandidateText(JSON.stringify(hostileDiagnostic));
      throw new Error("hostile candidate unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptCandidateError);
      expect((error as Error).message.length).toBeLessThanOrEqual(8_500);
    }
  });

  it("rejects unknown authority-bearing change surfaces, duplicate targets, and excess source", () => {
    const source = JSON.parse(candidateText()) as Record<string, unknown>;
    expect(() =>
      parsePromptCandidateText(
        JSON.stringify({ ...source, changes: { tools: [{ nodeId: "implement" }] } }),
      ),
    ).toThrowError(/invalid_schema/);

    const changes = source.changes as { prompts: unknown[] };
    expect(() =>
      parsePromptCandidateText(
        JSON.stringify({
          ...source,
          changes: { prompts: [...changes.prompts, changes.prompts[0]] },
        }),
      ),
    ).toThrowError(/unique/);

    expect(() => parsePromptCandidateText(" ".repeat(1_048_577))).toThrowError(/limit_exceeded/);
  });

  it("projects only the declared prompt and records exact provenance", () => {
    const context = projectionContext();
    const projected = projectPromptCandidate(context);
    const repeated = projectPromptCandidate(context);

    expect(projected.identity).toEqual(repeated.identity);
    expect(projected.identity).toMatchObject({
      version: 1,
      id: "better-instructions",
      candidateVersion: "1.0.0",
      manifest: {
        provenance: "candidate.yaml",
        sourceSha256: context.sourceSha256,
      },
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: context.source.baseline.workflowDigest,
      },
      evidence: [
        {
          provenance: "tuning.json",
          sourceSha256: context.evidence[0]?.sourceSha256,
          evidenceDigest: context.evidence[0]?.packet.evidenceDigest,
          planDigest: context.evidence[0]?.packet.evaluation.planDigest,
        },
      ],
      changes: [
        {
          nodeId: "implement",
          beforeSha256: sha256("Implement the task."),
          afterSha256: sha256("Read TASK.md, implement it, and verify the result."),
        },
      ],
    });
    expect(projected.identity.candidateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(projected.identity.projectedWorkflow).toEqual({
      sourceSha256: sha256(projected.workflow.source),
      workflowDigest: calculateWorkflowDigest(projected.workflow.compiled),
    });

    const parsedProjection = JSON.parse(projected.workflow.source);
    expect(parsedProjection.nodes[0].agent.prompt).toBe(
      "Read TASK.md, implement it, and verify the result.",
    );
    expect({ ...parsedProjection.nodes[0].agent, prompt: "Implement the task." }).toEqual(
      JSON.parse(baselineText).nodes[0].agent,
    );
    expect(parsedProjection.nodes.slice(1)).toEqual(JSON.parse(baselineText).nodes.slice(1));
    expect(JSON.parse(baselineText).nodes[0].agent.prompt).toBe("Implement the task.");
  });

  it.each([
    [
      "baseline source",
      (context: MutableProjectionContext) => {
        context.baseline.sourceSha256 = "f".repeat(64);
      },
    ],
    [
      "baseline workflow",
      (context: MutableProjectionContext) => {
        context.source.baseline.workflowDigest = "f".repeat(64);
      },
    ],
    [
      "evidence source",
      (context: MutableProjectionContext) => {
        requiredFirst(context.evidence, "admitted evidence").sourceSha256 = "f".repeat(64);
      },
    ],
    [
      "evidence digest",
      (context: MutableProjectionContext) => {
        requiredFirst(context.source.evidence, "declared evidence").evidenceDigest = "f".repeat(64);
      },
    ],
    [
      "evidence plan",
      (context: MutableProjectionContext) => {
        requiredFirst(context.source.evidence, "declared evidence").planDigest = "f".repeat(64);
      },
    ],
    [
      "prompt",
      (context: MutableProjectionContext) => {
        requiredFirst(context.source.changes.prompts, "prompt change").expectedSha256 = "f".repeat(
          64,
        );
      },
    ],
  ])("rejects stale or substituted %s identity", (_label, mutate) => {
    const context = structuredClone(projectionContext()) as MutableProjectionContext;
    mutate(context);
    expect(() => projectPromptCandidate(context)).toThrowError(PromptCandidateError);
  });

  it("rejects evidence unrelated to the baseline and non-agent or missing targets", () => {
    const unrelated = structuredClone(projectionContext()) as MutableProjectionContext;
    const unrelatedPacket = tuningEvidence("f".repeat(64));
    unrelated.evidence[0] = {
      provenance: "tuning.json",
      sourceSha256: sha256(JSON.stringify(unrelatedPacket)),
      packet: unrelatedPacket,
    };
    unrelated.source.evidence[0] = {
      path: "tuning.json",
      sourceSha256: unrelated.evidence[0].sourceSha256,
      evidenceDigest: unrelatedPacket.evidenceDigest,
      planDigest: unrelatedPacket.evaluation.planDigest,
    };
    expect(() => projectPromptCandidate(unrelated)).toThrowError(/does not cover the baseline/);

    const nonAgent = structuredClone(projectionContext()) as MutableProjectionContext;
    requiredFirst(nonAgent.source.changes.prompts, "prompt change").nodeId = "publish";
    expect(() => projectPromptCandidate(nonAgent)).toThrowError(/root agent node/);

    const missing = structuredClone(projectionContext()) as MutableProjectionContext;
    requiredFirst(missing.source.changes.prompts, "prompt change").nodeId = "missing";
    expect(() => projectPromptCandidate(missing)).toThrowError(/root agent node/);
  });
});

function candidateText(): string {
  const compiled = compileWorkflowText(baselineText);
  const evidence = tuningEvidence(calculateWorkflowDigest(compiled));
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "PromptCandidate",
    metadata: { id: "better-instructions", version: "1.0.0" },
    scope: { kind: "workflow", workflowId: "adaptive-workflow" },
    baseline: {
      workflow: "baseline.workflow.yaml",
      sourceSha256: sha256(baselineText),
      workflowDigest: calculateWorkflowDigest(compiled),
    },
    evidence: [
      {
        path: "tuning.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        evidenceDigest: evidence.evidenceDigest,
        planDigest: evidence.evaluation.planDigest,
      },
    ],
    changes: {
      prompts: [
        {
          nodeId: "implement",
          expectedSha256: sha256("Implement the task."),
          value: "Read TASK.md, implement it, and verify the result.",
        },
      ],
    },
  });
}

function generatedCandidate() {
  const { prepared } = promptCandidateGenerationFixture();
  return completePromptCandidateGeneration(
    prepared,
    JSON.stringify({
      changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
    }),
    {
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 1,
    },
  );
}

function generatedProjectionContext() {
  const fixture = promptCandidateGenerationFixture();
  const source = generatedCandidate();
  const text = JSON.stringify(source);
  return {
    manifestProvenance: "generated-candidate.yaml",
    source,
    sourceSha256: sha256(text),
    baseline: {
      provenance: fixture.input.baseline.provenance,
      source: fixture.input.baseline.source,
      sourceSha256: fixture.input.baseline.sourceSha256,
      compiled: fixture.input.baseline.compiled,
    },
    evidence: fixture.input.evidence.map((item) => ({
      provenance: item.provenance,
      sourceSha256: item.sourceSha256,
      packet: item.packet,
    })),
  };
}

function oversizedGenerationRequestContext() {
  const prompts = ["x".repeat(262_144), "x".repeat(262_144), "x".repeat(262_144), "x"];
  const build = (values: readonly string[]) => {
    const agentIds = values.map((_value, index) => `implement-${index}`);
    const baselineSource = {
      apiVersion: "flow.synapti.ai/v1alpha1" as const,
      kind: "Workflow" as const,
      metadata: { id: "adaptive-workflow" },
      nodes: [
        ...values.map((prompt, index) => ({
          id: agentIds[index],
          type: "agent" as const,
          ...(index === 0 ? {} : { dependsOn: [agentIds[index - 1] as string] }),
          agent: {
            prompt,
            model: { provider: "test", id: "deterministic", thinking: "medium" as const },
            tools: ["read" as const],
            skills: [],
            toolPackages: [],
            timeoutMs: 300_000,
          },
        })),
        {
          id: "publish",
          type: "result" as const,
          dependsOn: [agentIds.at(-1) as string],
          result: {
            source: { nodeId: agentIds.at(-1) as string, field: "agent.text" as const },
            schema: { type: "string" as const, maxLength: 1_024 },
          },
        },
      ],
    };
    const baselineText = JSON.stringify(baselineSource);
    const compiled = compileWorkflowText(baselineText);
    const workflowDigest = calculateWorkflowDigest(compiled);
    const evidence = tuningEvidence(workflowDigest);
    const targets = values.map((prompt, index) => ({
      nodeId: agentIds[index] as string,
      prompt,
      promptSha256: sha256(prompt),
    }));
    const request = {
      baseline: {
        workflowId: compiled.id,
        sourceSha256: sha256(baselineText),
        workflowDigest,
      },
      targets,
      evidence: [{ sourceSha256: sha256(JSON.stringify(evidence)), packet: evidence }],
      model: { provider: "test", id: "deterministic", thinking: "medium" as const },
      limits: { timeoutMs: 300_000, maxOutputTokens: 8_192 },
    };
    return { agentIds, baselineSource, baselineText, compiled, evidence, request };
  };

  const initial = build(prompts);
  const initialBytes = Buffer.byteLength(renderPromptCandidateGenerationRequest(initial.request));
  prompts[3] = "x".repeat(1 + MAX_PROMPT_CANDIDATE_GENERATION_INPUT_BYTES + 1 - initialBytes);
  const fixture = build(prompts);
  const requestBytes = Buffer.byteLength(renderPromptCandidateGenerationRequest(fixture.request));
  const source = structuredClone(generatedCandidate()) as DeepMutable<
    ReturnType<typeof generatedCandidate>
  >;
  const generation = requiredGeneration(source);
  const firstTarget = requiredFirst(fixture.request.targets, "oversized request target");
  const replacement = { nodeId: firstTarget.nodeId, value: "Use the accepted task result." };
  source.baseline.sourceSha256 = fixture.request.baseline.sourceSha256;
  source.baseline.workflowDigest = fixture.request.baseline.workflowDigest;
  source.evidence = [
    {
      path: "tuning-evidence.json",
      sourceSha256: fixture.request.evidence[0]?.sourceSha256 as string,
      evidenceDigest: fixture.evidence.evidenceDigest,
      planDigest: fixture.evidence.evaluation.planDigest,
    },
  ];
  source.changes.prompts = [
    {
      nodeId: replacement.nodeId,
      expectedSha256: firstTarget.promptSha256,
      value: replacement.value,
    },
  ];
  generation.targets = fixture.request.targets.map((target) => ({
    nodeId: target.nodeId,
    expectedSha256: target.promptSha256,
  }));
  generation.requestDigest = calculatePromptCandidateGenerationRequestDigest(fixture.request);
  generation.responseDigest = calculatePromptCandidateGenerationResponseDigest([replacement]);
  const context = {
    manifestProvenance: "generated-candidate.yaml",
    source,
    sourceSha256: sha256(JSON.stringify(source)),
    baseline: {
      provenance: "baseline.workflow.yaml",
      source: workflowSourceSchema.parse(fixture.baselineSource),
      sourceSha256: fixture.request.baseline.sourceSha256,
      compiled: fixture.compiled,
    },
    evidence: [
      {
        provenance: "tuning-evidence.json",
        sourceSha256: fixture.request.evidence[0]?.sourceSha256 as string,
        packet: fixture.evidence,
      },
    ],
  };
  return { context, requestBytes };
}

function refreshCandidateSourceHash(
  context: DeepMutable<ReturnType<typeof generatedProjectionContext>>,
): void {
  context.sourceSha256 = sha256(JSON.stringify(context.source));
}

function requiredGeneration(candidate: ReturnType<typeof generatedCandidate>) {
  if (candidate.generation === undefined) {
    throw new Error("generated candidate fixture has no generation provenance");
  }
  return candidate.generation;
}

function projectionContext() {
  const text = candidateText();
  const source = parsePromptCandidateText(text);
  const compiled = compileWorkflowText(baselineText);
  const evidence = tuningEvidence(calculateWorkflowDigest(compiled));
  return {
    manifestProvenance: "candidate.yaml",
    source,
    sourceSha256: sha256(text),
    baseline: {
      provenance: "baseline.workflow.yaml",
      source: workflowSourceSchema.parse(JSON.parse(baselineText)),
      sourceSha256: sha256(baselineText),
      compiled,
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: sha256(JSON.stringify(evidence)),
        packet: evidence,
      },
    ],
  };
}

function tuningEvidence(workflowDigest: string) {
  const planDigest = "a".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["tuning-task"],
    ["baseline", "other"],
    [1],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "9".repeat(64),
      },
      harness: { outcome: "completed", runId: "run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1,
        activeTimeMs: 1,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return createTuningEvidencePacket({
    evaluationId: "source-evaluation",
    planDigest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [{ id: "tuning-task", partition: "tuning" }],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest },
      { id: "other", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
    ],
    schedule,
    records,
  });
}

function paddingAgentNode(
  index: number,
  predecessor: string,
  prompt: string,
): Record<string, unknown> {
  return {
    id: `padding-${index}`,
    type: "agent",
    dependsOn: [predecessor],
    agent: {
      prompt,
      model: { provider: "test", id: "deterministic", thinking: "medium" },
      tools: [],
      skills: [],
      toolPackages: [],
      timeoutMs: 300_000,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableProjectionContext = DeepMutable<ReturnType<typeof projectionContext>>;

function requiredFirst<Item>(items: readonly Item[], label: string): Item {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`${label} fixture is missing`);
  }
  return item;
}
