import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurablePrimeWorkspacePublisher } from "../../src/infrastructure/oci/durable-prime-workspace-publisher.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const crashFixture = join(repositoryRoot, "test/fixtures/prime/workspace-publisher-crash.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Prime durable result replacement", () => {
  it.each([
    ["journal-prepared", "rolled_back", "OLD.md", "OLD\n"],
    ["target-renamed", "rolled_back", "OLD.md", "OLD\n"],
    ["target-retired", "rolled_back", "OLD.md", "OLD\n"],
    ["staging-renamed", "rolled_back", "OLD.md", "OLD\n"],
    ["target-switched", "committed", "RESULT.md", "DONE\n"],
    ["retired-removed", "committed", "RESULT.md", "DONE\n"],
  ] as const)(
    "recovers a process crash after %s",
    async (checkpoint, expectedOutcome, expectedFile, expectedContent) => {
      const parent = await mkdtemp(join(tmpdir(), `flow-prime-replacement-${checkpoint}-`));
      temporaryDirectories.push(parent);
      const targetRoot = join(parent, "workspace");
      const stagingRoot = join(parent, ".workspace.prime-stage");
      await Promise.all([mkdir(targetRoot), mkdir(stagingRoot)]);
      await Promise.all([
        writeFile(join(targetRoot, "OLD.md"), "OLD\n"),
        writeFile(join(stagingRoot, "RESULT.md"), "DONE\n"),
      ]);

      const exit = await runCrashFixture(checkpoint, targetRoot, stagingRoot);
      expect(exit).toEqual({ code: null, signal: "SIGKILL" });

      await expect(new DurablePrimeWorkspacePublisher().recover(targetRoot)).resolves.toBe(
        expectedOutcome,
      );
      await expect(readFile(join(targetRoot, expectedFile), "utf8")).resolves.toBe(expectedContent);
    },
  );
});

async function runCrashFixture(checkpoint: string, targetRoot: string, stagingRoot: string) {
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [crashFixture, checkpoint, targetRoot, stagingRoot], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun({ code, signal }));
  });
}
