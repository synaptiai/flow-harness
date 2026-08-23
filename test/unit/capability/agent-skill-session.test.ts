import { describe, expect, it } from "vitest";

import {
  type AgentSkillSessionError,
  createAgentSkillSession,
} from "../../../src/domain/capability/agent-skill-session.js";
import {
  createCapabilitySnapshot,
  MAX_CAPABILITY_READ_RECEIPTS,
} from "../../../src/domain/capability/agent-skills.js";

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

  it("rejects a new resource before it exceeds the attempt receipt limit", () => {
    const files = Array.from({ length: MAX_CAPABILITY_READ_RECEIPTS }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `references/resource-${index}.txt`,
      content: Buffer.from(`resource-${index}\n`),
    }));
    const session = createAgentSkillSession(
      createCapabilitySnapshot([
        {
          kind: "agent-skill",
          name: "first",
          description: "First bounded resource set.",
          metadata: {},
          requestedTools: [],
          trust: "project-explicit",
          provenance: ".flow/skills/first",
          files: files.slice(0, 64),
        },
        {
          kind: "agent-skill",
          name: "second",
          description: "Second bounded resource set.",
          metadata: {},
          requestedTools: [],
          trust: "project-explicit",
          provenance: ".flow/skills/second",
          files: [{ path: "SKILL.md", content: Buffer.from("# Second\n") }, ...files.slice(64)],
        },
      ]),
      ["first", "second"],
    );
    const uris = [
      ...files.slice(0, 64).map((file) => `skill://first/${file.path}`),
      "skill://second/SKILL.md",
      ...files.slice(64, -1).map((file) => `skill://second/${file.path}`),
    ];
    expect(uris).toHaveLength(MAX_CAPABILITY_READ_RECEIPTS);
    for (const uri of uris) {
      session.readText(uri);
    }

    expect(() =>
      session.readText(`skill://second/${files.at(-1)?.path ?? "missing"}`),
    ).toThrowError(
      expect.objectContaining<Partial<AgentSkillSessionError>>({ code: "read_limit" }),
    );
    expect(session.evidence().reads).toHaveLength(MAX_CAPABILITY_READ_RECEIPTS);
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
