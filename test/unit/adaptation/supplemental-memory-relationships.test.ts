import { describe, expect, it } from "vitest";

import {
  createSupplementalMemoryRelationshipState,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL,
  MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES,
  parseSupplementalMemoryRelationshipState,
  renderSupplementalMemoryRelationshipBlock,
  type SupplementalMemoryRelationshipError,
  type SupplementalMemoryRelationshipInput,
} from "../../../src/domain/adaptation/supplemental-memory-relationships.js";
import {
  createSupplementalMemoryEntries,
  type SupplementalMemoryEntry,
} from "../../../src/domain/adaptation/supplemental-memory.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("supplemental-memory relationship state", () => {
  it("creates a canonical evidence-bound state with only closed predicates", () => {
    const { entries, target } = fixtureEntries();
    const state = createSupplementalMemoryRelationshipState(
      [
        relationship(
          "why-conflict",
          "contradicts",
          "second",
          entries[1]?.sha256 ?? "",
          "first",
          entries[0]?.sha256 ?? "",
        ),
        relationship(
          "why-support",
          "supports",
          "first",
          entries[0]?.sha256 ?? "",
          "second",
          entries[1]?.sha256 ?? "",
        ),
      ],
      entries,
    );

    expect(state.relationships.map((item) => item.id)).toEqual(["why-conflict", "why-support"]);
    expect(state.assessment).toMatchObject({
      relationshipCount: 2,
      evidenceReferenceCount: 2,
      unresolvedContradictionCount: 1,
    });
    expect(state.assessment.relationshipSetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(state.assessment.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      createSupplementalMemoryRelationshipState(
        [
          {
            ...relationship(
              "unknown",
              "supports",
              "first",
              entries[0]?.sha256 ?? "",
              "second",
              entries[1]?.sha256 ?? "",
            ),
            predicate: "similar_to",
          } as unknown as SupplementalMemoryRelationshipInput,
        ],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "invalid_schema",
      }),
    );

    const rendered = renderSupplementalMemoryRelationshipBlock(state, target);
    expect(rendered).toContain('predicate="contradicts"');
    expect(rendered).toContain('status="unresolved"');
    expect(rendered).toContain('predicate="supports"');
    expect(rendered).not.toContain("proof-run");
    expect(rendered).not.toContain("PRIVATE");
    expect(Buffer.byteLength(rendered ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_PROMPT_BYTES,
    );
    expect(renderSupplementalMemoryRelationshipBlock(state, entries[2]?.target ?? target)).toBe(
      undefined,
    );
  });

  it("rejects self-links, duplicate claims, stale endpoints, and cross-target endpoints", () => {
    const { entries } = fixtureEntries();
    const first = entries[0];
    const second = entries[1];
    const other = entries[2];
    if (first === undefined || second === undefined || other === undefined)
      throw new Error("fixture");

    const cases: readonly [
      SupplementalMemoryRelationshipInput,
      SupplementalMemoryRelationshipError["code"],
    ][] = [
      [
        relationship("self", "supports", first.id, first.sha256, first.id, first.sha256),
        "invalid_relationship",
      ],
      [
        relationship("stale", "supports", first.id, "f".repeat(64), second.id, second.sha256),
        "stale_endpoint",
      ],
      [
        relationship("other-agent", "supports", first.id, first.sha256, other.id, other.sha256),
        "stale_endpoint",
      ],
    ];
    for (const [input, code] of cases) {
      expect(() => createSupplementalMemoryRelationshipState([input], entries)).toThrowError(
        expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({ code }),
      );
    }

    const duplicate = relationship(
      "first-claim",
      "supports",
      first.id,
      first.sha256,
      second.id,
      second.sha256,
    );
    expect(() =>
      createSupplementalMemoryRelationshipState(
        [duplicate, { ...duplicate, id: "second-claim" }],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "invalid_relationship",
      }),
    );
  });

  it("rejects cycles across the closed lineage predicates without deriving new edges", () => {
    const { entries } = fixtureEntries();
    const [first, second] = entries;
    if (first === undefined || second === undefined) throw new Error("fixture");

    expect(() =>
      createSupplementalMemoryRelationshipState(
        [
          relationship(
            "first-lineage",
            "refines",
            first.id,
            first.sha256,
            second.id,
            second.sha256,
          ),
          relationship(
            "second-lineage",
            "derived_from",
            second.id,
            second.sha256,
            first.id,
            first.sha256,
          ),
        ],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "invalid_relationship",
      }),
    );

    const state = createSupplementalMemoryRelationshipState(
      [relationship("one-way", "refines", first.id, first.sha256, second.id, second.sha256)],
      entries,
    );
    expect(state.relationships).toHaveLength(1);
  });

  it("accepts supersession only from an active replacement to its exact prior version", () => {
    const { entries, target } = fixtureEntries();
    const current = entries[0];
    if (current === undefined) throw new Error("fixture");
    const prior = "e".repeat(64);

    expect(
      createSupplementalMemoryRelationshipState(
        [
          {
            ...relationship(
              "revision",
              "supersedes",
              current.id,
              current.sha256,
              current.id,
              prior,
            ),
            target,
          },
        ],
        entries,
      ).relationships[0],
    ).toMatchObject({
      predicate: "supersedes",
      from: { entryId: current.id, entrySha256: current.sha256 },
      to: { entryId: current.id, entrySha256: prior },
    });

    expect(() =>
      createSupplementalMemoryRelationshipState(
        [relationship("wrong-id", "supersedes", current.id, current.sha256, "second", prior)],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "invalid_relationship",
      }),
    );
    expect(() =>
      createSupplementalMemoryRelationshipState(
        [
          relationship(
            "wrong-direction",
            "supersedes",
            current.id,
            prior,
            current.id,
            current.sha256,
          ),
        ],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "stale_endpoint",
      }),
    );
  });

  it("enforces exact per-relationship evidence and active-entry degree bounds", () => {
    const workflow = workflowWithAgents(["implement"]);
    const target = { workflowId: workflow.id, childPath: [] as string[], agentNodeId: "implement" };
    const entries = createSupplementalMemoryEntries(
      Array.from({ length: 6 }, (_, index) => ({
        id: `fact-${index}`,
        target,
        content: `Fact ${index}.`,
      })),
      workflow,
    );
    const center = entries[0];
    if (center === undefined) throw new Error("fixture");
    const exactDegree = entries
      .slice(1, 1 + MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE)
      .map((other, index) => ({
        ...relationship(
          `degree-${index}`,
          "supports",
          center.id,
          center.sha256,
          other.id,
          other.sha256,
        ),
        evidence: Array.from(
          { length: MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE },
          (_, evidenceIndex) => evidence(evidenceIndex + 1),
        ),
      }));
    expect(
      createSupplementalMemoryRelationshipState(exactDegree, entries).relationships,
    ).toHaveLength(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_DEGREE);

    const overflowDegree = relationship(
      "degree-overflow",
      "contradicts",
      center.id,
      center.sha256,
      entries[5]?.id ?? "",
      entries[5]?.sha256 ?? "",
    );
    expect(() =>
      createSupplementalMemoryRelationshipState([...exactDegree, overflowDegree], entries),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "limit_exceeded",
      }),
    );
    const firstDegree = exactDegree[0];
    if (firstDegree === undefined) throw new Error("fixture");
    expect(() =>
      createSupplementalMemoryRelationshipState(
        [
          {
            ...firstDegree,
            evidence: Array.from(
              { length: MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE + 1 },
              (_, index) => evidence(index + 1),
            ),
          },
        ],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "limit_exceeded",
      }),
    );
  });

  it("accepts exact state-wide relationship and evidence bounds and rejects plus one", () => {
    const workflow = workflowWithAgents(Array.from({ length: 8 }, (_, index) => `agent-${index}`));
    const entryInputs = Array.from({ length: 8 }, (_, index) => {
      const target = {
        workflowId: workflow.id,
        childPath: [] as string[],
        agentNodeId: `agent-${index}`,
      };
      return [
        { id: "first", target, content: `First ${index}.` },
        { id: "second", target, content: `Second ${index}.` },
      ];
    }).flat();
    const entries = createSupplementalMemoryEntries(entryInputs, workflow);
    const relationships: SupplementalMemoryRelationshipInput[] = [];
    for (let index = 0; index < 8; index += 1) {
      const targetEntries = entries.filter((item) => item.target.agentNodeId === `agent-${index}`);
      const [first, second] = targetEntries;
      if (first === undefined || second === undefined) throw new Error("fixture");
      for (const [suffix, predicate, from, to] of [
        ["support-forward", "supports", first, second],
        ["support-back", "supports", second, first],
        ["conflict-forward", "contradicts", first, second],
        ["conflict-back", "contradicts", second, first],
      ] as const) {
        relationships.push({
          ...relationship(
            `agent-${index}-${suffix}`,
            predicate,
            from.id,
            from.sha256,
            to.id,
            to.sha256,
          ),
          target: from.target,
          evidence: Array.from({ length: 4 }, (_, evidenceIndex) =>
            evidence(evidenceIndex + 1, `run-${index}-${suffix}`, `agent-${index}`),
          ),
        });
      }
    }

    const state = createSupplementalMemoryRelationshipState(relationships, entries);
    expect(state.relationships).toHaveLength(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS);
    expect(state.assessment.evidenceReferenceCount).toBe(
      MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIP_EVIDENCE_TOTAL,
    );
    expect(() =>
      createSupplementalMemoryRelationshipState(
        [
          ...relationships,
          relationship(
            "overflow",
            "supports",
            "first",
            entries[0]?.sha256 ?? "",
            "second",
            entries[1]?.sha256 ?? "",
          ),
        ],
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "limit_exceeded",
      }),
    );
  });

  it("rejects relationship metadata whose target prompt exceeds the byte budget", () => {
    const workflow = workflowWithAgents(["implement"]);
    const target = {
      workflowId: workflow.id,
      childPath: [] as string[],
      agentNodeId: "implement",
    };
    const entries = createSupplementalMemoryEntries(
      Array.from({ length: 16 }, (_, index) => ({
        id: `fact-${index.toString().padStart(2, "0")}-${"e".repeat(80)}`,
        target,
        content: `Fact ${index}.`,
      })),
      workflow,
    );
    const relationships = Array.from({ length: 16 }, (_, index) =>
      [1, 2].map((distance, offset) => {
        const from = entries[index];
        const to = entries[(index + distance) % entries.length];
        if (from === undefined || to === undefined) throw new Error("fixture");
        return {
          ...relationship(
            `edge-${(index * 2 + offset).toString().padStart(2, "0")}-${"r".repeat(80)}`,
            "supports",
            from.id,
            from.sha256,
            to.id,
            to.sha256,
          ),
          target,
        };
      }),
    ).flat();

    expect(relationships).toHaveLength(MAX_SUPPLEMENTAL_MEMORY_RELATIONSHIPS);
    expect(() => createSupplementalMemoryRelationshipState(relationships, entries)).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "limit_exceeded",
      }),
    );
  });

  it("rejects reordered or identity-tampered durable relationship state", () => {
    const { entries } = fixtureEntries();
    const state = createSupplementalMemoryRelationshipState(
      [
        relationship(
          "a-claim",
          "supports",
          entries[0]?.id ?? "",
          entries[0]?.sha256 ?? "",
          entries[1]?.id ?? "",
          entries[1]?.sha256 ?? "",
        ),
        relationship(
          "b-claim",
          "contradicts",
          entries[1]?.id ?? "",
          entries[1]?.sha256 ?? "",
          entries[0]?.id ?? "",
          entries[0]?.sha256 ?? "",
        ),
      ],
      entries,
    );

    expect(() =>
      parseSupplementalMemoryRelationshipState(
        { ...state, relationships: [...state.relationships].reverse() },
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "identity_mismatch",
      }),
    );
    expect(() =>
      parseSupplementalMemoryRelationshipState(
        { ...state, assessment: { ...state.assessment, digest: "f".repeat(64) } },
        entries,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryRelationshipError>>({
        code: "identity_mismatch",
      }),
    );
  });
});

function fixtureEntries(): {
  entries: readonly SupplementalMemoryEntry[];
  target: SupplementalMemoryEntry["target"];
} {
  const workflow = workflowWithAgents(["implement", "other-agent"]);
  const target = { workflowId: workflow.id, childPath: [] as string[], agentNodeId: "implement" };
  return {
    target,
    entries: createSupplementalMemoryEntries(
      [
        { id: "first", target, content: "PRIVATE_FIRST_CONTENT" },
        { id: "second", target, content: "PRIVATE_SECOND_CONTENT" },
        {
          id: "other",
          target: { ...target, agentNodeId: "other-agent" },
          content: "PRIVATE_OTHER_CONTENT",
        },
      ],
      workflow,
    ),
  };
}

function relationship(
  id: string,
  predicate: SupplementalMemoryRelationshipInput["predicate"],
  fromId: string,
  fromSha256: string,
  toId: string,
  toSha256: string,
): SupplementalMemoryRelationshipInput {
  return {
    id,
    target: {
      workflowId: "memory-relationship-workflow",
      childPath: [],
      agentNodeId: "implement",
    },
    predicate,
    from: { entryId: fromId, entrySha256: fromSha256 },
    to: { entryId: toId, entrySha256: toSha256 },
    evidence: [evidence(1)],
  };
}

function evidence(attempt: number, runId = "proof-run", nodeId = "implement") {
  return {
    runId,
    nodeId,
    attempt,
    sequence: attempt,
    eventDigest: attempt.toString(16).padStart(64, "0"),
  };
}

function workflowWithAgents(agentNodeIds: readonly string[]) {
  return compileWorkflowText(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "Workflow",
      metadata: { id: "memory-relationship-workflow" },
      budget: {
        maxNodeStarts: agentNodeIds.length + 1,
        maxModelTokens: 100_000,
        maxCostUsd: 10,
        maxExecutionMs: 10_000,
        maxArtifactBytes: 1_024,
      },
      nodes: [
        ...agentNodeIds.map((id, index) => ({
          id,
          type: "agent",
          ...(index === 0 ? {} : { dependsOn: [agentNodeIds[index - 1]] }),
          agent: {
            prompt: `Run ${id}.`,
            model: { provider: "test", id: "deterministic", thinking: "medium" },
            tools: [],
            skills: [],
            toolPackages: [],
            timeoutMs: 10_000,
          },
        })),
        {
          id: "publish",
          type: "result",
          dependsOn: [agentNodeIds.at(-1)],
          result: {
            source: { nodeId: agentNodeIds.at(-1), field: "agent.text" },
            schema: { type: "string", maxLength: 1_024 },
          },
        },
      ],
    }),
    "memory-relationships.workflow.json",
  );
}
