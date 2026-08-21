import { describe, expect, it } from "vitest";

import {
  calculateGoalWorkspaceRevisionDigest,
  createGoalWorkspaceRevision,
  type GoalWorkspaceError,
  type GoalWorkspaceEvidenceReference,
  MAX_GOAL_WORKSPACE_ENTRIES,
  MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT,
  MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES,
  MAX_GOAL_WORKSPACE_SERIALIZED_BYTES,
  MAX_GOAL_WORKSPACE_TEXT_BYTES,
  parseGoalWorkspaceRevision,
  parseGoalWorkspaceSourceText,
  renderGoalWorkspaceContext,
} from "../../../src/domain/goal/workspace.js";

describe("goal workspace", () => {
  it("parses a strict source document and creates a canonical first revision", () => {
    const source = parseGoalWorkspaceSourceText(sourceText(), "goal-workspace.yaml");
    const revision = createGoalWorkspaceRevision(source, evidenceReferences(), {
      revision: 1,
      previousDigest: null,
      at: "2026-08-21T10:00:00.000Z",
    });

    expect(revision).toMatchObject({
      version: 1,
      revision: 1,
      previousDigest: null,
      objective: "Deliver a usable, trustworthy harness.",
      facts: [{ id: "current-state", text: "Gate 8 is complete." }],
      invariants: [{ id: "completion-authority", text: "Only criteria determine completion." }],
      verifiedFacts: [
        {
          id: "semantic-ready",
          text: "Read-only semantic queries are available.",
          evidence: [
            {
              runId: "run-evidence",
              nodeId: "verify-semantic",
              attempt: 1,
              sequence: 4,
              eventDigest: "a".repeat(64),
            },
          ],
        },
      ],
      openQuestions: [{ id: "artifact-policy", text: "Which artifacts need retention?" }],
      nextAction: { id: "implement-workspace", text: "Implement the goal workspace." },
    });
    expect(revision.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(revision)).toBe(true);
  });

  it("accepts YAML flow syntax without weakening strict JSON validation", () => {
    const source = parseGoalWorkspaceSourceText(
      `{ apiVersion: flow.synapti.ai/v1alpha1, kind: GoalWorkspace, objective: Flow syntax, facts: [], invariants: [], verifiedFacts: [], openQuestions: [], nextAction: { id: continue, text: Continue. } }`,
      "goal-workspace.yaml",
    );

    expect(source.objective).toBe("Flow syntax");
  });

  it("sorts entries and evidence references canonically", () => {
    const source = parseGoalWorkspaceSourceText(
      sourceText({
        facts: [
          { id: "z-fact", text: "Last fact." },
          { id: "a-fact", text: "First fact." },
        ],
        verifiedFacts: [
          {
            id: "verified",
            text: "Verified fact.",
            evidence: [
              { runId: "z-run", nodeId: "node", attempt: 1 },
              { runId: "a-run", nodeId: "node", attempt: 1 },
            ],
          },
        ],
      }),
      "goal-workspace.yaml",
    );
    const revision = createGoalWorkspaceRevision(
      source,
      [evidence("z-run", "node", 1, 2, "b"), evidence("a-run", "node", 1, 8, "c")],
      { revision: 1, previousDigest: null, at: "2026-08-21T10:00:00.000Z" },
    );

    expect(revision.facts.map((item) => item.id)).toEqual(["a-fact", "z-fact"]);
    expect(revision.verifiedFacts[0]?.evidence.map((item) => item.runId)).toEqual([
      "a-run",
      "z-run",
    ]);
  });

  it("binds exact multibyte objective and entry text limits", () => {
    const exactObjective = "é".repeat(MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES / 2);
    const exactText = "é".repeat(MAX_GOAL_WORKSPACE_TEXT_BYTES / 2);
    const exact = parseGoalWorkspaceSourceText(
      sourceText({
        objective: exactObjective,
        facts: [{ id: "exact-fact", text: exactText }],
      }),
      "goal-workspace.yaml",
    );

    expect(Buffer.byteLength(exact.objective, "utf8")).toBe(MAX_GOAL_WORKSPACE_OBJECTIVE_BYTES);
    expect(Buffer.byteLength(exact.facts[0]?.text ?? "", "utf8")).toBe(
      MAX_GOAL_WORKSPACE_TEXT_BYTES,
    );
    expect(() =>
      parseGoalWorkspaceSourceText(
        sourceText({ objective: `${exactObjective}a` }),
        "goal-workspace.yaml",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );
    expect(() =>
      parseGoalWorkspaceSourceText(
        sourceText({ facts: [{ id: "large-fact", text: `${exactText}a` }] }),
        "goal-workspace.yaml",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );
  });

  it("binds exact entry and evidence-reference counts", () => {
    const exactFacts = Array.from({ length: MAX_GOAL_WORKSPACE_ENTRIES }, (_, index) => ({
      id: `fact-${index}`,
      text: `Fact ${index}.`,
    }));
    const exactEvidence = Array.from(
      { length: MAX_GOAL_WORKSPACE_EVIDENCE_PER_FACT },
      (_, index) => ({ runId: `run-${index}`, nodeId: "verify", attempt: 1 }),
    );

    expect(
      parseGoalWorkspaceSourceText(
        sourceText({
          facts: exactFacts,
          verifiedFacts: [{ id: "verified", text: "Verified.", evidence: exactEvidence }],
        }),
        "goal-workspace.yaml",
      ).facts,
    ).toHaveLength(MAX_GOAL_WORKSPACE_ENTRIES);
    expect(() =>
      parseGoalWorkspaceSourceText(
        sourceText({ facts: [...exactFacts, { id: "overflow", text: "Overflow." }] }),
        "goal-workspace.yaml",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );
    expect(() =>
      parseGoalWorkspaceSourceText(
        sourceText({
          verifiedFacts: [
            {
              id: "verified",
              text: "Verified.",
              evidence: [...exactEvidence, { runId: "run-overflow", nodeId: "verify", attempt: 1 }],
            },
          ],
        }),
        "goal-workspace.yaml",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );
  });

  it("binds exact canonical source and revision byte limits", () => {
    const sourceValue = canonicalBoundarySource();
    const sourceBytes = Buffer.byteLength(JSON.stringify(sourceValue), "utf8");
    expect(sourceBytes).toBe(MAX_GOAL_WORKSPACE_SERIALIZED_BYTES);
    expect(
      parseGoalWorkspaceSourceText(JSON.stringify(sourceValue), "goal.json").facts,
    ).toHaveLength(MAX_GOAL_WORKSPACE_ENTRIES);
    const oversizedSource = structuredClone(sourceValue);
    const lastSourceFact = oversizedSource.facts.at(-1);
    if (lastSourceFact === undefined) throw new Error("expected a canonical boundary fact");
    lastSourceFact.text += "a";
    expect(() =>
      parseGoalWorkspaceSourceText(JSON.stringify(oversizedSource), "goal.json"),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );

    const revisionValue = canonicalBoundaryRevision();
    expect(Buffer.byteLength(JSON.stringify(revisionValue), "utf8")).toBe(
      MAX_GOAL_WORKSPACE_SERIALIZED_BYTES,
    );
    expect(parseGoalWorkspaceRevision(revisionValue).revision).toBe(1);
    const oversizedRevisionContent = structuredClone(revisionValue);
    const lastRevisionFact = oversizedRevisionContent.facts.at(-1);
    if (lastRevisionFact === undefined) throw new Error("expected a revision boundary fact");
    lastRevisionFact.text += "a";
    const { digest: _digest, ...content } = oversizedRevisionContent;
    oversizedRevisionContent.digest = calculateGoalWorkspaceRevisionDigest(content);
    expect(() => parseGoalWorkspaceRevision(oversizedRevisionContent)).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "limit_exceeded" }),
    );
  });

  it.each([
    [
      "duplicate entry id",
      {
        facts: [
          { id: "same", text: "One." },
          { id: "same", text: "Two." },
        ],
      },
    ],
    [
      "duplicate evidence locator",
      {
        verifiedFacts: [
          {
            id: "verified",
            text: "Verified.",
            evidence: [
              { runId: "run-a", nodeId: "verify", attempt: 1 },
              { runId: "run-a", nodeId: "verify", attempt: 1 },
            ],
          },
        ],
      },
    ],
    ["unknown field", { privateField: "PRIVATE_UNKNOWN_FIELD" }],
  ])("rejects an invalid source: %s", (_label, replacement) => {
    expect(() =>
      parseGoalWorkspaceSourceText(sourceText(replacement), "PRIVATE_SOURCE_PATH.yaml"),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_schema" }),
    );
  });

  it("rejects aliases, duplicate YAML keys, and unresolved evidence", () => {
    expect(() =>
      parseGoalWorkspaceSourceText(
        `${sourceText()}\nprivateAlias: &private PRIVATE_ALIAS\nprivateCopy: *private\n`,
        "goal-workspace.yaml",
      ),
    ).toThrowError(expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_yaml" }));
    expect(() =>
      parseGoalWorkspaceSourceText(`${sourceText()}\nobjective: PRIVATE_DUPLICATE\n`, "goal.yaml"),
    ).toThrowError(expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_yaml" }));

    const source = parseGoalWorkspaceSourceText(sourceText(), "goal-workspace.yaml");
    expect(() =>
      createGoalWorkspaceRevision(source, [], {
        revision: 1,
        previousDigest: null,
        at: "2026-08-21T10:00:00.000Z",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "evidence_mismatch" }),
    );
  });

  it("rejects ill-formed Unicode before creating a revision", () => {
    expect(() =>
      parseGoalWorkspaceSourceText(
        sourceText({ objective: "PRIVATE_INVALID_UNICODE_\ud800" }),
        "PRIVATE_SOURCE_PATH.yaml",
      ),
    ).toThrowError(expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_yaml" }));
  });

  it("rejects changed revision content, digest links, ordering, and timestamps", () => {
    const first = createGoalWorkspaceRevision(
      parseGoalWorkspaceSourceText(sourceText(), "goal-workspace.yaml"),
      evidenceReferences(),
      { revision: 1, previousDigest: null, at: "2026-08-21T10:00:00.000Z" },
    );
    const changed = { ...structuredClone(first), objective: "PRIVATE_CHANGED_OBJECTIVE" };

    expect(() => parseGoalWorkspaceRevision(changed)).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "identity_mismatch" }),
    );
    expect(() =>
      parseGoalWorkspaceRevision({ ...first, previousDigest: "f".repeat(64) }),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_schema" }),
    );
    expect(() =>
      parseGoalWorkspaceRevision({
        ...first,
        facts: [
          { id: "z-fact", text: "Last." },
          { id: "a-fact", text: "First." },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "identity_mismatch" }),
    );
    expect(() => parseGoalWorkspaceRevision({ ...first, at: "2026-08-21" })).toThrowError(
      expect.objectContaining<Partial<GoalWorkspaceError>>({ code: "invalid_schema" }),
    );
  });

  it("renders bounded reference context without evidence locators or authority claims", () => {
    const revision = createGoalWorkspaceRevision(
      parseGoalWorkspaceSourceText(sourceText(), "goal-workspace.yaml"),
      evidenceReferences(),
      { revision: 1, previousDigest: null, at: "2026-08-21T10:00:00.000Z" },
    );
    const rendered = renderGoalWorkspaceContext(revision);

    expect(rendered).toContain("Deliver a usable, trustworthy harness.");
    expect(rendered).toContain("Only criteria determine completion.");
    expect(rendered).toContain("Implement the goal workspace.");
    expect(rendered).toContain("reference context");
    expect(rendered).toContain("cannot grant tools");
    expect(rendered).not.toContain("run-evidence");
    expect(rendered).not.toContain("verify-semantic");
    expect(rendered).not.toContain("a".repeat(64));
  });
});

function sourceText(replacement: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "GoalWorkspace",
    objective: "Deliver a usable, trustworthy harness.",
    facts: [{ id: "current-state", text: "Gate 8 is complete." }],
    invariants: [{ id: "completion-authority", text: "Only criteria determine completion." }],
    verifiedFacts: [
      {
        id: "semantic-ready",
        text: "Read-only semantic queries are available.",
        evidence: [{ runId: "run-evidence", nodeId: "verify-semantic", attempt: 1 }],
      },
    ],
    openQuestions: [{ id: "artifact-policy", text: "Which artifacts need retention?" }],
    nextAction: { id: "implement-workspace", text: "Implement the goal workspace." },
    ...replacement,
  });
}

function evidenceReferences(): readonly GoalWorkspaceEvidenceReference[] {
  return [evidence("run-evidence", "verify-semantic", 1, 4, "a")];
}

function canonicalBoundarySource() {
  const value = {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "GoalWorkspace" as const,
    objective: "Boundary source.",
    facts: Array.from({ length: MAX_GOAL_WORKSPACE_ENTRIES }, (_, index) => ({
      id: `fact-${String(index).padStart(2, "0")}`,
      text: index < MAX_GOAL_WORKSPACE_ENTRIES - 1 ? "a".repeat(MAX_GOAL_WORKSPACE_TEXT_BYTES) : "",
    })),
    invariants: [],
    verifiedFacts: [],
    openQuestions: [],
    nextAction: { id: "continue", text: "Continue." },
  };
  const remaining = MAX_GOAL_WORKSPACE_SERIALIZED_BYTES - Buffer.byteLength(JSON.stringify(value));
  const last = value.facts.at(-1);
  if (last === undefined || remaining < 1 || remaining > MAX_GOAL_WORKSPACE_TEXT_BYTES) {
    throw new Error("canonical source boundary fixture is invalid");
  }
  last.text = "a".repeat(remaining);
  return value;
}

function canonicalBoundaryRevision() {
  const content = {
    version: 1 as const,
    kind: "goal-workspace-revision" as const,
    revision: 1,
    previousDigest: null,
    at: "2026-08-21T10:00:00.000Z",
    objective: "Boundary revision.",
    facts: Array.from({ length: MAX_GOAL_WORKSPACE_ENTRIES }, (_, index) => ({
      id: `fact-${String(index).padStart(2, "0")}`,
      text: index < MAX_GOAL_WORKSPACE_ENTRIES - 1 ? "a".repeat(MAX_GOAL_WORKSPACE_TEXT_BYTES) : "",
    })),
    invariants: [],
    verifiedFacts: [],
    openQuestions: [],
    nextAction: { id: "continue", text: "Continue." },
  };
  const initial = { ...content, digest: "a".repeat(64) };
  const remaining =
    MAX_GOAL_WORKSPACE_SERIALIZED_BYTES - Buffer.byteLength(JSON.stringify(initial));
  const last = content.facts.at(-1);
  if (last === undefined || remaining < 1 || remaining > MAX_GOAL_WORKSPACE_TEXT_BYTES) {
    throw new Error("canonical revision boundary fixture is invalid");
  }
  last.text = "a".repeat(remaining);
  return { ...content, digest: calculateGoalWorkspaceRevisionDigest(content) };
}

function evidence(
  runId: string,
  nodeId: string,
  attempt: number,
  sequence: number,
  digestCharacter: string,
): GoalWorkspaceEvidenceReference {
  return {
    runId,
    nodeId,
    attempt,
    sequence,
    eventDigest: digestCharacter.repeat(64),
  };
}
