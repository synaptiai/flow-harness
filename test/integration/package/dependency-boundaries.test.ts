import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const applicationRoot = join(repositoryRoot, "src", "application");
const domainRoot = join(repositoryRoot, "src", "domain");
const sourceRoot = join(repositoryRoot, "src");

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

  it("keeps the Pi terminal renderer outside domain and application modules", async () => {
    const violations: string[] = [];
    for (const root of [domainRoot, applicationRoot]) {
      for (const path of await typescriptFiles(root)) {
        const source = await readFile(path, "utf8");
        if (/\b(?:from\s*|import\s*(?:\(\s*)?)["']@earendil-works\/pi-tui["']/u.test(source)) {
          violations.push(relative(repositoryRoot, path));
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("pins the official ACP SDK to infrastructure under its reviewed license", async () => {
    const packageManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    const packageLock = JSON.parse(
      await readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
    ) as {
      readonly packages?: Readonly<
        Record<string, { readonly version?: string; readonly license?: string }>
      >;
    };
    expect(packageManifest.dependencies?.["@agentclientprotocol/sdk"]).toBe("1.3.0");
    expect(packageLock.packages?.["node_modules/@agentclientprotocol/sdk"]).toEqual(
      expect.objectContaining({ version: "1.3.0", license: "Apache-2.0" }),
    );

    const violations: string[] = [];
    for (const root of [domainRoot, applicationRoot]) {
      for (const path of await typescriptFiles(root)) {
        const source = await readFile(path, "utf8");
        if (source.includes('"@agentclientprotocol/sdk"')) {
          violations.push(relative(repositoryRoot, path));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains tuf-js and its compatibility imports in two repository infrastructure adapters", async () => {
    const imports: { readonly path: string; readonly sources: readonly string[] }[] = [];
    for (const path of await typescriptFiles(sourceRoot)) {
      const source = await readFile(path, "utf8");
      const tufSources = Array.from(
        source.matchAll(/\bfrom\s*["'](?<source>tuf-js(?:\/[^"']*)?)["']/gu),
        (match) => match.groups?.source,
      ).filter((value): value is string => value !== undefined);
      if (tufSources.length > 0) {
        imports.push({ path: relative(repositoryRoot, path), sources: tufSources });
      }
    }

    expect(imports).toEqual([
      {
        path: "src/infrastructure/tuf/capability-repository-generation-authenticator.ts",
        sources: ["tuf-js", "tuf-js", "tuf-js/dist/error.js"],
      },
      {
        path: "src/infrastructure/tuf/staged-tuf-repository.ts",
        sources: ["tuf-js", "tuf-js", "tuf-js/dist/error.js"],
      },
    ]);
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
