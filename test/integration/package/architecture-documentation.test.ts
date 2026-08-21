import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const architecturePath = join(repositoryRoot, "docs", "architecture.md");

describe("architecture documentation", () => {
  it("maps every top-level runtime module and the Prime container", async () => {
    const runtimeModules = (await readdir(join(repositoryRoot, "src"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(runtimeModules).toEqual([
      "application",
      "cli",
      "domain",
      "infrastructure",
      "supervisor",
    ]);

    const architecture = await readFile(architecturePath, "utf8");
    for (const module of runtimeModules) {
      expect(architecture).toContain(`src/${module}/`);
    }
    expect(architecture).toContain("prime-container/");
  });

  it("contains a plain-language Mermaid overview of the complete runtime", async () => {
    const architecture = await readFile(architecturePath, "utf8");
    const overview = /## Architecture at a glance(?<body>[\s\S]*?)(?=\n## )/u.exec(architecture)
      ?.groups?.body;

    expect(overview).toBeDefined();
    expect(overview).toContain("```mermaid");
    expect(overview).toContain("People and automation");
    expect(overview).toContain("Ways to use Flow");
    expect(overview).toContain("Guided quick start");
    expect(overview).toContain("Environment diagnostics");
    expect(overview).toContain("Control plane");
    expect(overview).toContain("Execution plane");
    expect(overview).toContain("Durable project state");
    expect(overview).toContain("External systems");
  });

  it("avoids reserved Mermaid node identifiers", async () => {
    const architecture = await readFile(architecturePath, "utf8");
    const diagrams = [...architecture.matchAll(/```mermaid\n(?<source>[\s\S]*?)```/gu)].map(
      (match) => match.groups?.source ?? "",
    );

    expect(diagrams.length).toBeGreaterThan(0);
    for (const diagram of diagrams) {
      expect(diagram).not.toMatch(/^\s*(?:end|graph)\s*[[(]/gmu);
    }
  });

  it("requires architectural boundary changes to update the diagram", async () => {
    const [architecture, instructions, stylePolicy, contributing] = await Promise.all([
      readFile(architecturePath, "utf8"),
      readFile(join(repositoryRoot, "AGENTS.md"), "utf8"),
      readFile(join(repositoryRoot, "docs", "documentation-style.md"), "utf8"),
      readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8"),
    ]);

    expect(architecture).toContain("## Keep the architecture view current");
    expect(instructions).toContain("architecture diagram");
    expect(stylePolicy).toContain("architecture diagram");
    expect(contributing).toContain("architecture overview");
  });
});
