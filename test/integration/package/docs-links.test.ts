import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const checker = resolve(import.meta.dirname, "../../../scripts/check-doc-links.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("documentation link gate", () => {
  it("accepts relative files, local anchors, duplicate headings, and root links", async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "README.md"),
      [
        "# Project",
        "",
        "[Guide](docs/guide.md#install-flow)",
        "[Second section](docs/guide.md#install-flow-1)",
        "[Local](#project)",
        "[External](https://example.test/path#fragment)",
        "",
        "```md",
        "[Example only](missing.md)",
        "```",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "docs", "guide.md"),
      "# Guide\n\n## Install Flow\n\n## Install Flow\n",
    );

    await expect(
      execute(process.execPath, [checker, "--root", root, "--file", "README.md"]),
    ).resolves.toMatchObject({ stdout: "DOC_LINKS=clean\n" });
  });

  it.each([
    ["missing file", "[Missing](docs/missing.md)", "target does not exist"],
    ["missing anchor", "[Missing](docs/guide.md#absent)", "anchor does not exist"],
    ["path escape", "[Outside](../outside.md)", "target leaves repository"],
  ])("rejects a %s", async (_name, link, expected) => {
    const root = await temporaryRepository();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), `# Project\n\n${link}\n`);
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");

    await expect(
      execute(process.execPath, [checker, "--root", root, "--file", "README.md"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(expected),
    });
  });

  it("discovers links in public GitHub and example documentation", async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, "docs"));
    await mkdir(join(root, ".github"));
    await mkdir(join(root, "examples", "guide"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Project\n");
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(
      join(root, ".github", "pull_request_template.md"),
      "# Pull request\n\n[Missing guide](../docs/missing.md)\n",
    );
    await writeFile(join(root, "examples", "guide", "README.md"), "# Example guide\n");

    await expect(
      execute(process.execPath, [checker, "--root", root, "--all"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(".github/pull_request_template.md"),
    });
  });
});

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-doc-links-"));
  temporaryDirectories.push(root);
  return root;
}
