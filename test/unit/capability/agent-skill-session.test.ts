import { describe, expect, it } from "vitest";

import {
  type AgentSkillSessionError,
  createAgentSkillSession,
} from "../../../src/domain/capability/agent-skill-session.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";

describe("Agent Skill session", () => {
  it("discloses metadata first and loads exact selected text resources on demand", () => {
    const session = createAgentSkillSession(snapshot(), ["review"]);

    expect(session.catalog).toEqual([
      {
        name: "review",
        description: "Review code when explicitly selected.",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        uri: "skill://review/SKILL.md",
      },
    ]);
    expect(JSON.stringify(session.catalog)).not.toContain("Detailed private instructions");
    expect(JSON.stringify(session.catalog)).not.toContain("checklist-body");

    const activated = session.readText("skill://review/SKILL.md");
    const reference = session.readText("skill://review/references/checklist.md");

    expect(activated.text).toContain("Detailed private instructions");
    expect(reference.text).toBe("checklist-body\n");
    expect(session.evidence()).toEqual({
      selected: [{ name: "review", digest: session.catalog[0]?.digest }],
      reads: [activated.receipt, reference.receipt],
    });
  });

  it("deduplicates repeated activation evidence without changing returned content", () => {
    const session = createAgentSkillSession(snapshot(), ["review"]);

    const first = session.readText("skill://review/SKILL.md");
    const second = session.readText("skill://review/SKILL.md");

    expect(second.text).toBe(first.text);
    expect(session.evidence().reads).toHaveLength(1);
  });

  it.each([
    ["unselected package", "skill://testing/SKILL.md", "unselected_skill"],
    ["literal traversal", "skill://review/../testing/SKILL.md", "unsafe_uri"],
    ["encoded traversal", "skill://review/%2e%2e/testing/SKILL.md", "unsafe_uri"],
    ["encoded separator", "skill://review/references%2fchecklist.md", "unsafe_uri"],
    ["query", "skill://review/SKILL.md?raw=1", "unsafe_uri"],
    ["fragment", "skill://review/SKILL.md#section", "unsafe_uri"],
    ["missing resource", "skill://review/missing.md", "missing_resource"],
    ["binary resource", "skill://review/assets/binary.dat", "binary_resource"],
  ] as const)("rejects an unsafe or unavailable $label", (_label, uri, code) => {
    const session = createAgentSkillSession(snapshot(), ["review"]);

    expect(() => session.readText(uri)).toThrowError(
      expect.objectContaining<Partial<AgentSkillSessionError>>({ code }),
    );
    expect(session.evidence().reads).toEqual([]);
  });
});

function snapshot() {
  return createCapabilitySnapshot([
    {
      kind: "agent-skill",
      name: "review",
      description: "Review code when explicitly selected.",
      metadata: { version: "1" },
      requestedTools: ["Bash"],
      trust: "project-explicit",
      provenance: ".flow/skills/review",
      files: [
        {
          path: "SKILL.md",
          content: Buffer.from(`---
name: review
description: Review code when explicitly selected.
---
Detailed private instructions.
`),
        },
        { path: "references/checklist.md", content: Buffer.from("checklist-body\n") },
        { path: "assets/binary.dat", content: Buffer.from([0, 255]) },
      ],
    },
    {
      kind: "agent-skill",
      name: "testing",
      description: "Test code when explicitly selected.",
      metadata: {},
      requestedTools: [],
      trust: "project-explicit",
      provenance: ".flow/skills/testing",
      files: [{ path: "SKILL.md", content: Buffer.from("# Testing\n") }],
    },
  ]);
}
