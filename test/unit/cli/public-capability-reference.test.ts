import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPublicCapabilityReferenceCli } from "../../../src/cli/public-capability-reference.js";
import { PUBLIC_CAPABILITY_REFERENCE_PATHS } from "../../../src/infrastructure/fs/public-capability-reference-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("public capability reference CLI", () => {
  it("writes and then verifies the production reference", async () => {
    const root = await temporaryRoot();
    const output: string[] = [];

    expect(await runPublicCapabilityReferenceCli(["--write"], options(root, output))).toBe(0);
    expect(await runPublicCapabilityReferenceCli(["--check"], options(root, output))).toBe(0);
    expect(
      JSON.parse(await readFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json), "utf8")),
    ).toMatchObject({ version: "flow.public-capabilities/v1" });
    expect(output).toEqual([
      "Generated the public capability reference.\n",
      "The public capability reference is current.\n",
    ]);
  });

  it("returns a failure with regeneration guidance for stale output", async () => {
    const root = await temporaryRoot();
    const errors: string[] = [];
    await runPublicCapabilityReferenceCli(["--write"], options(root));
    await writeFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json), "{}\n", "utf8");

    expect(await runPublicCapabilityReferenceCli(["--check"], options(root, [], errors))).toBe(1);
    expect(errors.join("")).toMatch(
      /public capability reference is stale.*docs:capabilities:generate/u,
    );
  });

  it("returns usage status for an unsupported mode", async () => {
    const errors: string[] = [];

    expect(
      await runPublicCapabilityReferenceCli(
        ["--unknown"],
        options(await temporaryRoot(), [], errors),
      ),
    ).toBe(2);
    expect(errors).toEqual(["Usage: public-capability-reference (--check | --write)\n"]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-public-reference-cli-"));
  temporaryDirectories.push(root);
  return root;
}

function options(root: string, output: string[] = [], errors: string[] = []) {
  return {
    cwd: root,
    stdout: (value: string) => output.push(value),
    stderr: (value: string) => errors.push(value),
  };
}
