import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isDirectEntry, main } from "../../src/cli/main.js";

describe("flow CLI", () => {
  it("prints help without requiring provider configuration", async () => {
    const output: string[] = [];

    const exitCode = await main(["--help"], {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("Provider-neutral harness");
    expect(output.join("\n")).toContain("flow validate");
    expect(output.join("\n")).toContain("flow run");
    expect(output.join("\n")).toContain("flow inspect");
  });

  it("rejects unknown commands with a usage error", async () => {
    const output: string[] = [];

    const exitCode = await main(["unknown"], {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain('Unknown command "unknown"');
  });

  it("recognizes an npm-style symlink as the executable entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-cli-entry-"));
    const target = join(directory, "main.js");
    const linkedBinary = join(directory, "flow");
    try {
      await writeFile(target, "", "utf8");
      await symlink(target, linkedBinary);

      expect(isDirectEntry(linkedBinary, pathToFileURL(target).href)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
