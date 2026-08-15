import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const applicationRoot = join(repositoryRoot, "src", "application");

describe("source dependency boundaries", () => {
  it.each([
    ['import { adapter } from "../infrastructure/adapter.js";', true],
    ['import type { Adapter } from "../infrastructure/adapter.js";', true],
    ['export { adapter } from "../infrastructure/adapter.js";', true],
    ['import "../infrastructure/adapter.js";', true],
    ['await import("../infrastructure/adapter.js");', true],
    ['import { adapter } from "../../infrastructure/adapter.js";', true],
    ['await import("../../../infrastructure/adapter.js");', true],
    ['import { contract } from "./ports.js";', false],
    ['const description = "../infrastructure/adapter.js";', false],
  ])("classifies application import source %j", (source, expected) => {
    expect(importsInfrastructure(source)).toBe(expected);
  });

  it("keeps application modules independent from infrastructure implementations", async () => {
    const violations: string[] = [];
    for (const path of await typescriptFiles(applicationRoot)) {
      const source = await readFile(path, "utf8");
      if (importsInfrastructure(source)) {
        violations.push(relative(repositoryRoot, path));
      }
    }

    expect(violations).toEqual([]);
  });
});

function importsInfrastructure(source: string): boolean {
  return (
    /\bfrom\s*["'](?:\.\.\/)+infrastructure\//u.test(source) ||
    /\bimport\s*(?:\(\s*)?["'](?:\.\.\/)+infrastructure\//u.test(source)
  );
}

async function typescriptFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await typescriptFiles(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      paths.push(path);
    }
  }
  return paths.sort();
}
