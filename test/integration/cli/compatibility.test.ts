import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../../../src/cli/main.js";
import { LocalCompatibilityCorpusError } from "../../../src/infrastructure/compatibility/local-corpus.js";

describe("flow compatibility check", () => {
  it("checks the packaged historical corpus without changing the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "flow-compatibility-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      ["compatibility", "check"],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { cwd: project },
    );

    expect(exitCode, stderr.join("\n")).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      version: "flow.compatibility-report/v1",
      flow: { package: "@synapti/flow-harness", version: "0.1.0-alpha.3" },
      corpus: {
        version: "flow.compatibility-corpus/v1",
        id: "alpha-compatibility-v1",
        sha256: await packagedManifestSha256(),
      },
      overall: "compatible",
      artifacts: [
        {
          id: "alpha1-verify-installation-workflow",
          state: "compatible",
          category: "compatible",
        },
        {
          id: "alpha1-terminal-run",
          state: "compatible",
          category: "compatible",
        },
      ],
    });
    await expect(readdir(project)).resolves.toEqual([]);
  });

  it("rejects extra arguments before reading the corpus", async () => {
    const loadCompatibilityCorpus = vi.fn();
    const stderr: string[] = [];

    const exitCode = await main(
      ["compatibility", "check", "./other-corpus"],
      { stdout: () => undefined, stderr: (text) => stderr.push(text) },
      { loadCompatibilityCorpus },
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toContain("Usage: flow compatibility check");
    expect(loadCompatibilityCorpus).not.toHaveBeenCalled();
  });

  it("emits a stable diagnostic when the packaged corpus is unavailable", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      ["compatibility", "check"],
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      {
        loadCompatibilityCorpus: async () => {
          throw new LocalCompatibilityCorpusError(
            "corpus_missing",
            "compatibility corpus is missing",
          );
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["corpus_missing: compatibility corpus is missing"]);
  });
});

async function packagedManifestSha256(): Promise<string> {
  const source = await readFile(new URL("../../../compatibility/manifest.json", import.meta.url));
  return createHash("sha256").update(source).digest("hex");
}
