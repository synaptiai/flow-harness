import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const checker = resolve(import.meta.dirname, "../../../scripts/check-doc-style.mjs");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("documentation style gate", () => {
  it("accepts the complete public documentation set", async () => {
    await expect(
      execute(process.execPath, [checker, "--root", repositoryRoot, "--all"]),
    ).resolves.toMatchObject({ stdout: "DOC_STYLE=clean\n" });
  });

  it("discovers root documents and accepts product names, code, and physical paths", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "README.md"), "# Project\n");
    await writeFile(join(root, "AGENTS.md"), "# Repository instructions\n");
    await writeFile(
      join(root, "docs", "guide.md"),
      [
        "# Flow guide",
        "",
        "## Configure the Docker runtime",
        "",
        "Use `left & right` below `/workspace`.",
        "",
        "[Google Developer Documentation Style Guide](https://developers.google.com/style)",
        "",
      ].join("\n"),
    );

    await expect(
      execute(process.execPath, [checker, "--root", root, "--all"]),
    ).resolves.toMatchObject({ stdout: "DOC_STYLE=clean\n" });

    await writeFile(
      join(root, "AGENTS.md"),
      ["# Repository Instructions", "", "Keep this file in the root.", ""].join("\n"),
    );
    await expect(
      execute(process.execPath, [checker, "--root", root, "--all"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("AGENTS.md:1: heading must use sentence case"),
    });
  });

  it.each([
    ["multiple level-one headings", ["# Guide", "", "# Another guide"], "exactly one H1"],
    ["a skipped heading level", ["# Guide", "", "### Configure Flow"], "heading level"],
    ["title-case headings", ["# Guide", "", "## Configure Runtime Settings"], "sentence case"],
    ["weak link text", ["# Guide", "", "For details, see [here](guide.md)."], "link text"],
    ["empty image alternatives", ["# Guide", "", "![](diagram.svg)"], "alt text"],
    ["formulaic politeness", ["# Guide", "", "Please open the file."], "avoid this term"],
    [
      "directional cross-references",
      ["# Guide", "", "Use the policy described below."],
      "directional cross-reference",
    ],
    ["ampersands as conjunctions", ["# Guide", "", "Review safety & recovery."], "ampersand"],
  ])("rejects %s", async (_name, lines, expected) => {
    const file = await temporaryDocument([...lines, ""]);

    await expect(
      execute(process.execPath, [checker, "--root", repositoryRoot, "--file", file]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(expected),
    });
  });
});

async function temporaryDocument(lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-doc-style-"));
  temporaryDirectories.push(root);
  const file = join(root, "guide.md");
  await writeFile(file, lines.join("\n"));
  return file;
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-doc-style-root-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "docs"));
  return root;
}
