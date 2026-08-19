import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateModelRoutingCandidateDigest,
  MAX_MODEL_ROUTING_CANDIDATE_BYTES,
  type ModelRoutingCandidateError,
  parseModelRoutingCandidateIdentity,
  parseModelRoutingCandidateText,
  projectModelRoutingCandidate,
} from "../../../src/domain/adaptation/model-routing-candidate.js";
import {
  compileWorkflowText,
  parseWorkflowSourceText,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

const baselineText = JSON.stringify({
  apiVersion: "flow.synapti.ai/v1alpha1",
  kind: "Workflow",
  metadata: { id: "routing-workflow" },
  budget: {
    maxNodeStarts: 2,
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
        model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
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

describe("model-routing candidates", () => {
  it("projects one exact root-agent route and binds the complete candidate identity", () => {
    const sourceText = candidateText();
    const source = parseModelRoutingCandidateText(sourceText, "route.candidate.yaml");
    const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");

    const projected = projectModelRoutingCandidate({
      manifestProvenance: "route.candidate.yaml",
      sourceSha256: sha256(sourceText),
      source,
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceText: baselineText,
        sourceSha256: sha256(baselineText),
        source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
        compiled,
      },
    });

    expect(parseModelRoutingCandidateIdentity(structuredClone(projected.identity))).toEqual(
      projected.identity,
    );
    expect(projected.identity).toMatchObject({
      version: 1,
      kind: "model-routing-candidate",
      id: "sonnet-to-gpt",
      candidateVersion: "1.0.0",
      scope: {
        kind: "workflow-model-route",
        workflowId: "routing-workflow",
        nodeId: "implement",
      },
      baseline: {
        workflow: {
          provenance: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: calculateWorkflowDigest(compiled),
        },
      },
      route: {
        before: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
        after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
      },
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(projected.workflow.compiled.nodes.find((node) => node.id === "implement")).toMatchObject(
      {
        type: "agent",
        agent: {
          prompt: "Implement the task.",
          model: { provider: "openai", id: "gpt-5.4", thinking: "high" },
          tools: ["read", "edit"],
        },
      },
    );
    expect(Object.isFrozen(projected)).toBe(true);
  });

  it("binds each route field and rejects no-op or non-agent targets", () => {
    for (const mutate of [
      (candidate: CandidateSource) => {
        candidate.route.before.provider = "openai";
      },
      (candidate: CandidateSource) => {
        candidate.route.before.id = "gpt-5.4";
      },
      (candidate: CandidateSource) => {
        candidate.route.before.thinking = "high";
      },
    ]) {
      const input = projectionInput();
      mutate(input.source as CandidateSource);
      refreshSourceDigest(input);
      expect(() => projectModelRoutingCandidate(input)).toThrowError(
        expect.objectContaining<Partial<ModelRoutingCandidateError>>({
          code: "identity_mismatch",
        }),
      );
    }

    const noOp = JSON.parse(candidateText()) as CandidateSource;
    noOp.route.after = structuredClone(noOp.route.before);
    expect(() => parseModelRoutingCandidateText(JSON.stringify(noOp))).toThrowError(
      expect.objectContaining<Partial<ModelRoutingCandidateError>>({ code: "invalid_schema" }),
    );

    const nonAgent = projectionInput();
    (nonAgent.source as CandidateSource).scope.nodeId = "publish";
    refreshSourceDigest(nonAgent);
    expect(() => projectModelRoutingCandidate(nonAgent)).toThrowError(
      expect.objectContaining<Partial<ModelRoutingCandidateError>>({ code: "invalid_target" }),
    );
  });

  it("enforces the exact source-byte boundary and exact durable digest", () => {
    const source = candidateText();
    const exact =
      source + " ".repeat(MAX_MODEL_ROUTING_CANDIDATE_BYTES - Buffer.byteLength(source));
    expect(Buffer.byteLength(exact)).toBe(MAX_MODEL_ROUTING_CANDIDATE_BYTES);
    expect(parseModelRoutingCandidateText(exact).kind).toBe("ModelRoutingCandidate");
    expect(() => parseModelRoutingCandidateText(`${exact} `)).toThrowError(
      expect.objectContaining<Partial<ModelRoutingCandidateError>>({ code: "limit_exceeded" }),
    );

    const identity = structuredClone(
      projectModelRoutingCandidate(projectionInput()).identity,
    ) as DeepMutable<ReturnType<typeof projectModelRoutingCandidate>["identity"]>;
    identity.route.after.id = "PRIVATE_SUBSTITUTED_MODEL";
    const error = catchError(() => parseModelRoutingCandidateIdentity(identity));
    expect(error).toMatchObject({ code: "identity_mismatch" });
    expect(error?.cause).toBeUndefined();

    const redigested = structuredClone(identity);
    const { candidateDigest: _candidateDigest, ...withoutDigest } = redigested;
    redigested.candidateDigest = calculateModelRoutingCandidateDigest(withoutDigest);
    expect(parseModelRoutingCandidateIdentity(redigested).route.after.id).toBe(
      "PRIVATE_SUBSTITUTED_MODEL",
    );
  });

  it("enforces exact route-field and portable-path boundaries", () => {
    const exactProvider = "p".repeat(96);
    const exactModel = "m".repeat(256);
    const exactPath = "b".repeat(1_024);
    for (const mutate of [
      (candidate: CandidateSource) => {
        candidate.route.after.provider = exactProvider;
      },
      (candidate: CandidateSource) => {
        candidate.route.after.id = exactModel;
      },
      (candidate: CandidateSource) => {
        candidate.baseline.workflow.path = exactPath;
      },
    ]) {
      const candidate = JSON.parse(candidateText()) as CandidateSource;
      mutate(candidate);
      expect(() => parseModelRoutingCandidateText(JSON.stringify(candidate))).not.toThrow();
    }

    for (const mutate of [
      (candidate: CandidateSource) => {
        candidate.route.after.provider = `${exactProvider}p`;
      },
      (candidate: CandidateSource) => {
        candidate.route.after.id = `${exactModel}m`;
      },
      (candidate: CandidateSource) => {
        candidate.route.after.id = " private-model";
      },
      (candidate: CandidateSource) => {
        candidate.baseline.workflow.path = `${exactPath}b`;
      },
      ...[
        "/private/workflow.yaml",
        "../workflow.yaml",
        "./workflow.yaml",
        "a//workflow.yaml",
        "a\\workflow.yaml",
      ].map((path) => (candidate: CandidateSource) => {
        candidate.baseline.workflow.path = path;
      }),
    ]) {
      const candidate = JSON.parse(candidateText()) as CandidateSource;
      mutate(candidate);
      expect(() => parseModelRoutingCandidateText(JSON.stringify(candidate))).toThrowError(
        expect.objectContaining<Partial<ModelRoutingCandidateError>>({ code: "invalid_schema" }),
      );
    }
  });
});

function projectionInput() {
  const sourceText = candidateText();
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  return {
    manifestProvenance: "route.candidate.yaml",
    sourceSha256: sha256(sourceText),
    source: structuredClone(parseModelRoutingCandidateText(sourceText)),
    baseline: {
      provenance: "baseline.workflow.yaml",
      sourceText: baselineText,
      sourceSha256: sha256(baselineText),
      source: parseWorkflowSourceText(baselineText, "baseline.workflow.yaml"),
      compiled,
    },
  };
}

function refreshSourceDigest(input: ReturnType<typeof projectionInput>): void {
  input.sourceSha256 = sha256(JSON.stringify(input.source));
}

function candidateText(): string {
  const compiled = compileWorkflowText(baselineText, "baseline.workflow.yaml");
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "ModelRoutingCandidate",
    metadata: { id: "sonnet-to-gpt", version: "1.0.0" },
    scope: {
      kind: "workflow-model-route",
      workflowId: "routing-workflow",
      nodeId: "implement",
    },
    baseline: {
      workflow: {
        path: "baseline.workflow.yaml",
        sourceSha256: sha256(baselineText),
        workflowDigest: calculateWorkflowDigest(compiled),
      },
    },
    route: {
      before: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: "medium" },
      after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function catchError(operation: () => unknown): Error | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : undefined;
  }
}

type CandidateSource = ReturnType<typeof parseModelRoutingCandidateText> & {
  scope: { nodeId: string };
  baseline: { workflow: { path: string } };
  route: {
    before: { provider: string; id: string; thinking: string };
    after: { provider: string; id: string; thinking: string };
  };
};

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;
