import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { NativeOmpEvaluationSessionResult } from "../../../src/infrastructure/omp/native-omp-evaluation-driver.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const bunExecutable =
  process.env.FLOW_BUN_EXECUTABLE?.trim() || join(homedir(), ".bun", "bin", "bun");
const runnerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/omp/native-omp-session-runner.ts",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("native OMP evaluation driver", () => {
  it("runs a real OMP edit session through a credential-free host broker", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(join(workspace, "RESULT.md"), "PENDING\n", "utf8");
    const execution = await runOmp(workspace, "edit");

    expect(await readFile(join(workspace, "RESULT.md"), "utf8")).toBe("DONE\n");
    expect(execution.contexts).toHaveLength(2);
    expect(execution.contexts[0]).not.toContain('"runner"');
    expect(execution.contexts[0]).not.toContain('"modelRegistry"');
    expect(execution.contexts[1]).toContain('"responseId":"response-123"');
    expect(execution.contexts[1]).toContain('"textSignature":"signed-provider-text"');
    expect(execution.contexts[1]).toContain('"redacted":true');
    expect(execution.contexts[1]).toContain('"thinkingSignature":"opaque-provider-reasoning"');
    expect(execution.result).toMatchObject({
      harness: { outcome: "completed", runId: expect.any(String), reason: null },
      metrics: {
        costUsdMicros: 4_000,
        inputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 4,
        turns: 2,
        toolCalls: 1,
        toolErrors: 0,
        wallTimeMs: expect.any(Number),
        activeTimeMs: null,
        interventions: null,
        policyViolations: null,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
  }, 30_000);

  it("denies OMP read and edit paths outside the trial workspace", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const secretPath = join(root, "private.txt");
    const protectedPath = join(root, "protected.txt");
    await mkdir(workspace);
    await writeFile(secretPath, "PRIVATE_VALUE\n", "utf8");
    await writeFile(protectedPath, "UNCHANGED\n", "utf8");
    const execution = await runOmp(workspace, "escape", [secretPath, protectedPath]);

    expect(await readFile(protectedPath, "utf8")).toBe("UNCHANGED\n");
    expect(execution.contexts.at(1)).not.toContain("PRIVATE_VALUE");
    expect(execution.result).toMatchObject({
      harness: { outcome: "completed" },
      metrics: { toolCalls: 2, toolErrors: 2 },
    });
  }, 30_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-native-omp-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runOmp(
  workspace: string,
  scenario: "edit" | "escape",
  paths: readonly string[] = [],
): Promise<{
  readonly result: NativeOmpEvaluationSessionResult;
  readonly contexts: readonly string[];
}> {
  const { stdout } = await execFileAsync(
    bunExecutable,
    [runnerPath, workspace, scenario, ...paths],
    { encoding: "utf8", maxBuffer: 4 * 1_048_576, timeout: 30_000 },
  );
  return JSON.parse(stdout) as {
    readonly result: NativeOmpEvaluationSessionResult;
    readonly contexts: readonly string[];
  };
}
