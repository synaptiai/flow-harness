import { describe, expect, it } from "vitest";

import { projectPublicRunOutput } from "../../../src/cli/public-output.js";

describe("public run output", () => {
  it("removes encoded package content from nested state and event values", () => {
    const privateContent = Buffer.from("PRIVATE_AGENT_SKILL_RESOURCE\n").toString("base64");
    const durable = {
      type: "run_started",
      capabilitySnapshot: {
        digest: "a".repeat(64),
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            files: [
              {
                path: "references/checklist.md",
                bytes: 29,
                sha256: "b".repeat(64),
                contentBase64: privateContent,
              },
            ],
          },
        ],
      },
    };

    const projected = projectPublicRunOutput(durable);

    expect(projected).toEqual({
      type: "run_started",
      capabilitySnapshot: {
        digest: "a".repeat(64),
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            files: [
              {
                path: "references/checklist.md",
                bytes: 29,
                sha256: "b".repeat(64),
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("contentBase64");
    expect(JSON.stringify(projected)).not.toContain(privateContent);
    expect(durable.capabilitySnapshot.packages[0]?.files[0]?.contentBase64).toBe(privateContent);
  });

  it("preserves legacy prompt bytes and same-named public metadata", () => {
    const promptContent = Buffer.from("legacy prompt workflow\n").toString("base64");
    const value = {
      capabilitySnapshot: {
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            metadata: {
              contentBase64: "public-metadata-label",
              nested: {
                kind: "agent-skill",
                files: [{ contentBase64: "public-nested-metadata" }],
              },
            },
            files: [
              {
                path: "SKILL.md",
                contentBase64: Buffer.from("private skill bytes\n").toString("base64"),
              },
            ],
          },
        ],
        activations: [
          {
            kind: "prompt-activation",
            source: { bytes: 23, sha256: "c".repeat(64), contentBase64: promptContent },
          },
        ],
      },
    };

    expect(projectPublicRunOutput(value)).toEqual({
      capabilitySnapshot: {
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            metadata: {
              contentBase64: "public-metadata-label",
              nested: {
                kind: "agent-skill",
                files: [{ contentBase64: "public-nested-metadata" }],
              },
            },
            files: [{ path: "SKILL.md" }],
          },
        ],
        activations: [
          {
            kind: "prompt-activation",
            source: { bytes: 23, sha256: "c".repeat(64), contentBase64: promptContent },
          },
        ],
      },
    });
  });
});
