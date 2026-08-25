import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const documentationRoot = join(repositoryRoot, "docs");

describe("public documentation structure", () => {
  it("keeps the root README as a bounded public landing page", async () => {
    const source = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const lines = source.split("\n");

    expect(Buffer.byteLength(source, "utf8")).toBeLessThanOrEqual(24_000);
    expect(lines.length).toBeLessThanOrEqual(320);
    expect(source).toMatch(/^# Flow$/mu);
    expect(source).toMatch(/^## Why Flow$/mu);
    expect(source).toMatch(/^## Quick start$/mu);
    expect(source).toMatch(/^## Documentation$/mu);
    expect(source).toMatch(/^## Security$/mu);
    expect(source).toMatch(/^## Community$/mu);
    expect(source).toContain("docs/README.md");
    expect(source).toContain("docs/getting-started.md");
    expect(source).toContain("docs/project-status.md");
    expect(source).toContain("flow quickstart .");
    expect(source).not.toContain("flow_example=");
    expect(source).not.toMatch(
      /^### (?:Apply|Approve|Bound|Compare|Distribute|Follow|Observe|Recover|Run in|Select|Use)/mu,
    );
  });

  it("routes every public document through the documentation hub", async () => {
    const hub = await readFile(join(documentationRoot, "README.md"), "utf8");
    const linkedDocuments = new Set(
      Array.from(hub.matchAll(/\[[^\]]+\]\((?<target>[^)#?]+\.md)(?:#[^)]+)?\)/gu), (match) =>
        normalizePath(match.groups?.target ?? ""),
      ).filter((path) => !path.startsWith("../")),
    );
    const publicDocuments = (await markdownFiles(documentationRoot))
      .map((path) => normalizePath(relative(documentationRoot, path)))
      .filter((path) => path !== "README.md")
      .sort();

    expect(Array.from(linkedDocuments).sort()).toEqual(publicDocuments);
  });

  it("provides the required reader-oriented entry points", async () => {
    const gettingStarted = await readFile(join(documentationRoot, "getting-started.md"), "utf8");
    expect(gettingStarted).toMatch(/^# Getting started$/mu);
    expect(gettingStarted).toContain(
      "flow quickstart [directory] [--coding] [--provider <provider> --model <model>] [--run-id <id>]",
    );
    expect(gettingStarted).toContain("flow web quickstart-foundation --actor operator:quickstart");
    expect(gettingStarted).toContain("publication_uncertain");
    await expect(readFile(join(documentationRoot, "project-status.md"), "utf8")).resolves.toMatch(
      /^# Project status$/mu,
    );
    await expect(
      readFile(join(documentationRoot, "guides", "run-and-control.md"), "utf8"),
    ).resolves.toMatch(/^# Run and control workflows$/mu);
    await expect(
      readFile(join(documentationRoot, "guides", "diagnose-environment.md"), "utf8"),
    ).resolves.toMatch(/^# Diagnose the Flow environment$/mu);
    await expect(
      readFile(join(documentationRoot, "guides", "capability-packages.md"), "utf8"),
    ).resolves.toMatch(/^# Use capability packages$/mu);
    await expect(
      readFile(join(documentationRoot, "reference", "tools-and-capabilities.md"), "utf8"),
    ).resolves.toMatch(/^# Tools and capabilities$/mu);
    await expect(
      readFile(join(documentationRoot, "guides", "coding-quickstart.md"), "utf8"),
    ).resolves.toMatch(/^# Complete the coding quick start$/mu);
    await expect(
      readFile(join(documentationRoot, "operations", "prime-runtime.md"), "utf8"),
    ).resolves.toMatch(/^# Prime runtime operations$/mu);

    const compatibility = await readFile(join(documentationRoot, "compatibility.md"), "utf8");
    expect(compatibility).toMatch(/^# Compatibility policy$/mu);
    expect(compatibility).toContain("flow compatibility check");
    expect(compatibility).toContain("Compiled JavaScript modules");

    const libraryAssessment = await readFile(
      join(documentationRoot, "library-api-assessment.md"),
      "utf8",
    );
    expect(libraryAssessment).toMatch(/^# Library API assessment$/mu);
    expect(libraryAssessment).toContain("2,938");
    expect(libraryAssessment).toContain("Agent Client Protocol");
    expect(libraryAssessment).toContain("No supported library API");
  });

  it("uses the published executable in operator documentation", async () => {
    const documentationFiles = await markdownFiles(documentationRoot);
    const sourceEntrypointDocuments: string[] = [];

    for (const path of documentationFiles) {
      const source = await readFile(path, "utf8");
      if (/node dist\/cli\/(?:launcher|main)\.js/u.test(source)) {
        sourceEntrypointDocuments.push(normalizePath(relative(documentationRoot, path)));
      }
    }

    expect(sourceEntrypointDocuments.sort()).toEqual(["testing-and-evaluation.md"]);

    const [
      packageMetadataText,
      readme,
      installGuide,
      gettingStarted,
      testing,
      contributing,
      support,
    ] = await Promise.all([
      readFile(join(repositoryRoot, "package.json"), "utf8"),
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(documentationRoot, "guides", "install-preview.md"), "utf8"),
      readFile(join(documentationRoot, "getting-started.md"), "utf8"),
      readFile(join(documentationRoot, "testing-and-evaluation.md"), "utf8"),
      readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8"),
      readFile(join(repositoryRoot, "SUPPORT.md"), "utf8"),
    ]);
    const packageMetadata = JSON.parse(packageMetadataText) as {
      readonly name?: unknown;
      readonly bin?: unknown;
    };

    expect(packageMetadata.name).toBe("@synapti/flow-harness");
    expect(packageMetadata.bin).toEqual({ flow: "dist/cli/launcher.js" });
    expect(readme).toContain("npm install --global --ignore-scripts @synapti/flow-harness@preview");
    expect(readme).toContain("flow --help");
    expect(installGuide).toContain(
      "npm exec --yes --package=@synapti/flow-harness@preview -- flow --help",
    );
    expect(gettingStarted).toContain("flow <command> [arguments]");
    expect(testing).toContain("This contributor-only smoke test deliberately calls");
    expect(contributing).toContain("node dist/cli/launcher.js --help");
    expect(contributing).toContain("test an uninstalled change");
    expect(support).toContain("published as `@synapti/flow-harness` on npm");
    expect(support).not.toContain("There is no supported npm release");
  });

  it("persists the public documentation policy for contributors and automated agents", async () => {
    const [agentInstructions, contributing, stylePolicy] = await Promise.all([
      readFile(join(repositoryRoot, "AGENTS.md"), "utf8"),
      readFile(join(repositoryRoot, "CONTRIBUTING.md"), "utf8"),
      readFile(join(documentationRoot, "documentation-style.md"), "utf8"),
    ]);

    expect(agentInstructions).toContain("docs/documentation-style.md");
    expect(agentInstructions).toContain("https://developers.google.com/style");
    expect(agentInstructions).toContain("npm run docs:style");
    expect(agentInstructions).toContain("npm run docs:capabilities:generate");
    expect(agentInstructions).toContain("npm run docs:capabilities:check");
    expect(contributing).toContain("docs/documentation-style.md");
    expect(contributing).toContain("npm run docs:capabilities:generate");
    expect(stylePolicy).toContain("https://developers.google.com/style");
    expect(stylePolicy).toContain("npm run docs:style");
    expect(stylePolicy).toContain("npm run docs:capabilities:check");
  });
});

async function markdownFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      paths.push(path);
    }
  }
  return paths;
}

function normalizePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}
