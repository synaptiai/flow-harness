import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];
const checker = resolve(import.meta.dirname, "../../../scripts/check-docs-ste.mjs");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("documentation STE gate", () => {
  it("accepts short direct prose", async () => {
    const file = await temporaryDocument(
      "# Prime profile\n\nFlow starts one container. Flow removes it after the trial.\n",
    );

    await expect(execute(process.execPath, [checker, "--file", file])).resolves.toMatchObject({
      stdout: expect.stringMatching(/PROSE_LINT=clean/),
    });
  });

  it.each([
    ["semicolon", "Flow starts one container; Flow removes it.\n"],
    ["marketing word", "The profile gives a seamless evaluation.\n"],
    [
      "long sentence",
      "Flow starts one container and checks the image identity before it sends the fixture because each trial must use the exact runtime that the plan records for replay.\n",
    ],
  ])("rejects a %s", async (_name, source) => {
    const file = await temporaryDocument(source);

    await expect(execute(process.execPath, [checker, "--file", file])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/PROSE_LINT=.*hard violation/i),
    });
  });
});

async function temporaryDocument(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-docs-ste-"));
  temporaryDirectories.push(root);
  const file = join(root, "document.md");
  await writeFile(file, source);
  return file;
}
