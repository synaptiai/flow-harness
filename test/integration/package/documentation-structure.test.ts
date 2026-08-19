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
    await expect(readFile(join(documentationRoot, "getting-started.md"), "utf8")).resolves.toMatch(
      /^# Getting started$/mu,
    );
    await expect(readFile(join(documentationRoot, "project-status.md"), "utf8")).resolves.toMatch(
      /^# Project status$/mu,
    );
    await expect(
      readFile(join(documentationRoot, "guides", "run-and-control.md"), "utf8"),
    ).resolves.toMatch(/^# Run and control workflows$/mu);
    await expect(
      readFile(join(documentationRoot, "guides", "capability-packages.md"), "utf8"),
    ).resolves.toMatch(/^# Use capability packages$/mu);
    await expect(
      readFile(join(documentationRoot, "operations", "prime-runtime.md"), "utf8"),
    ).resolves.toMatch(/^# Prime runtime operations$/mu);
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
