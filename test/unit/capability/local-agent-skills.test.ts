import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  calculateAgentSkillPackageDigest,
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_AGENT_SKILL_METADATA_ENTRIES,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  AgentSkillCatalogError,
  discoverProjectAgentSkills,
  snapshotSelectedAgentSkills,
} from "../../../src/infrastructure/fs/local-agent-skill-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local Agent Skills catalog", () => {
  it("discovers nested standards-shaped packages and snapshots exact sorted bytes", async () => {
    const project = await temporaryProject("flow-skills-valid-");
    await writeSkill(project, "review", {
      source: `---
name: review
description: Review code when correctness and security need independent scrutiny.
license: Apache-2.0
compatibility: Requires a text file reader.
metadata:
  author: synapti
  version: "1.2.3"
allowed-tools: Read Grep
---
# Review

Read references/checklist.md only when a detailed checklist is needed.
`,
      resources: {
        "references/checklist.md": "# Checklist\n\n- Verify evidence.\n",
        "assets/binary.dat": Buffer.from([0, 255, 1, 2]),
      },
    });
    await writeSkill(project, "groups/testing", {
      source: `---
name: testing
description: Design focused tests when a behavior needs executable evidence.
---
# Testing
`,
    });

    const catalog = await discoverProjectAgentSkills(project);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["review", "testing"]);
    expect(catalog.skills[0]).toMatchObject({
      name: "review",
      license: "Apache-2.0",
      compatibility: "Requires a text file reader.",
      metadata: { author: "synapti", version: "1.2.3" },
      requestedTools: ["Grep", "Read"],
      trust: "project-explicit",
      provenance: ".flow/skills/review",
    });

    const snapshot = await snapshotSelectedAgentSkills(catalog, ["testing", "review"]);

    expect(snapshot.packages.map((skill) => skill.name)).toEqual(["review", "testing"]);
    expect(snapshot.packages[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/binary.dat",
      "references/checklist.md",
    ]);
    expect(snapshot.packages[0]?.files[1]).toMatchObject({
      path: "assets/binary.dat",
      bytes: 4,
      contentBase64: "AP8BAg==",
    });
    expect(validateCapabilitySnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.packages)).toBe(true);
  });

  it("rejects a digest-valid snapshot whose metadata is not in canonical lexical order", async () => {
    const project = await temporaryProject("flow-skills-canonical-");
    await writeSkill(project, "review", {
      source: `---
name: review
description: Review code.
metadata:
  author: synapti
  version: "1"
---
Review.
`,
    });
    const catalog = await discoverProjectAgentSkills(project);
    const original = await snapshotSelectedAgentSkills(catalog, ["review"]);
    const originalSkill = original.packages[0];
    if (originalSkill === undefined) {
      throw new Error("skill fixture was not created");
    }
    const reordered = { ...originalSkill, metadata: { version: "1", author: "synapti" } };
    const skill = { ...reordered, digest: calculateAgentSkillPackageDigest(reordered) };
    const packages = [skill];
    const forged = {
      ...original,
      packages,
      digest: calculateCapabilitySnapshotDigest(packages),
    };

    expect(() => validateCapabilitySnapshot(forged)).toThrow(/metadata keys.*sorted/i);
  });

  it("enforces manifest bounds on snapshots received outside the local scanner", () => {
    const input = {
      kind: "agent-skill" as const,
      name: "review",
      description: "Review code.",
      metadata: Object.fromEntries(
        Array.from({ length: MAX_AGENT_SKILL_METADATA_ENTRIES + 1 }, (_, index) => [
          `key-${String(index).padStart(2, "0")}`,
          "value",
        ]),
      ),
      requestedTools: [],
      trust: "project-explicit" as const,
      provenance: ".flow/skills/review",
      files: [{ path: "SKILL.md", content: Buffer.from("# Review\n") }],
    };

    expect(() => createCapabilitySnapshot([input])).toThrow(/at most 64 entries/i);
    expect(() =>
      createCapabilitySnapshot([
        {
          ...input,
          metadata: {},
          requestedTools: ["Read\u0000Hidden"],
        },
      ]),
    ).toThrow(/control characters/i);
  });

  it("rejects duplicate names even when packages are stored at different depths", async () => {
    const project = await temporaryProject("flow-skills-duplicate-");
    await writeSkill(project, "one/shared", {
      source: skillSource("shared", "First package."),
    });
    await writeSkill(project, "two/shared", {
      source: skillSource("shared", "Second package."),
    });

    await expect(discoverProjectAgentSkills(project)).rejects.toMatchObject({
      name: "AgentSkillCatalogError",
      code: "duplicate_skill",
    });
  });

  it.each([
    {
      label: "directory name mismatch",
      path: "actual-name",
      source: skillSource("different-name", "Mismatched package."),
    },
    {
      label: "unknown frontmatter field",
      path: "unknown-field",
      source: `---\nname: unknown-field\ndescription: Invalid package.\ncommands: [bash]\n---\nBody\n`,
    },
    {
      label: "non-string metadata",
      path: "bad-metadata",
      source: `---\nname: bad-metadata\ndescription: Invalid package.\nmetadata:\n  count: 2\n---\nBody\n`,
    },
  ])("rejects strict manifest violation: $label", async ({ path, source }) => {
    const project = await temporaryProject("flow-skills-invalid-");
    await writeSkill(project, path, { source });

    await expect(discoverProjectAgentSkills(project)).rejects.toMatchObject({
      code: "invalid_skill",
    });
  });

  it("rejects symlinked package entries instead of reading outside content", async () => {
    const project = await temporaryProject("flow-skills-symlink-");
    const outside = join(project, "outside.txt");
    await writeFile(outside, "outside-secret\n", "utf8");
    await writeSkill(project, "unsafe", {
      source: skillSource("unsafe", "Unsafe package."),
    });
    await symlink(outside, join(project, ".flow", "skills", "unsafe", "reference.md"));

    const catalog = await discoverProjectAgentSkills(project);
    await expect(snapshotSelectedAgentSkills(catalog, ["unsafe"])).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects a resource directory replaced by an in-root symlink after discovery", async () => {
    const project = await temporaryProject("flow-skills-directory-race-");
    await writeSkill(project, "review", {
      source: skillSource("review", "Review package."),
      resources: { "references/checklist.md": "original\n" },
    });
    const alternate = join(project, ".flow", "skills", "alternate-resources");
    await mkdir(alternate, { recursive: true });
    await writeFile(join(alternate, "checklist.md"), "substituted\n", "utf8");
    const catalog = await discoverProjectAgentSkills(project);
    const references = join(project, ".flow", "skills", "review", "references");
    await rm(references, { recursive: true });
    await symlink(alternate, references);

    await expect(snapshotSelectedAgentSkills(catalog, ["review"])).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects oversized files and unknown selections before producing a partial snapshot", async () => {
    const project = await temporaryProject("flow-skills-bounds-");
    await writeSkill(project, "large", {
      source: skillSource("large", "Oversized package."),
      resources: { "references/large.txt": "x".repeat(MAX_AGENT_SKILL_FILE_BYTES + 1) },
    });
    const catalog = await discoverProjectAgentSkills(project);

    await expect(snapshotSelectedAgentSkills(catalog, ["large"])).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    await expect(snapshotSelectedAgentSkills(catalog, ["missing"])).rejects.toMatchObject({
      code: "missing_skill",
    });
  });

  it("returns an empty immutable catalog when the capability root does not exist", async () => {
    const project = await temporaryProject("flow-skills-empty-");

    await expect(discoverProjectAgentSkills(project)).resolves.toMatchObject({ skills: [] });
  });

  it("exposes bounded typed errors", () => {
    const error = new AgentSkillCatalogError("invalid_skill", "x".repeat(20_000));

    expect(error.message.length).toBeLessThanOrEqual(16_384);
  });
});

async function temporaryProject(prefix: string): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow", "skills"), { recursive: true });
  return project;
}

async function writeSkill(
  project: string,
  relativeDirectory: string,
  input: {
    readonly source: string;
    readonly resources?: Readonly<Record<string, string | Buffer>>;
  },
): Promise<void> {
  const directory = join(project, ".flow", "skills", relativeDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), input.source, "utf8");
  for (const [path, content] of Object.entries(input.resources ?? {})) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

function skillSource(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
}
