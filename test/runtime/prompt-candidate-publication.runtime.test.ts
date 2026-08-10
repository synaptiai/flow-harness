import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { completePromptCandidateGeneration } from "../../src/domain/adaptation/prompt-candidate-generation.js";
import { promptCandidateGenerationFixture } from "../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

it("recovers a candidate publisher that exits after the hard-link commit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-candidate-crash-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".flow"));
  await writeFile(
    join(root, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
    "utf8",
  );
  const outputPath = join(root, "generated.prompt-candidate.yaml");
  const sourceText = generatedCandidateText();
  const publisherUrl = new URL(
    "../../dist/infrastructure/fs/local-prompt-candidate-publisher.js",
    import.meta.url,
  ).href;
  const script = `
    const { publishLocalPromptCandidate } = await import(${JSON.stringify(publisherUrl)});
    await publishLocalPromptCandidate(
      ${JSON.stringify(outputPath)},
      ${JSON.stringify(sourceText)},
      { afterPublishLink: () => process.exit(91) },
    );
  `;

  const exitCode = await runChild(script);

  expect(exitCode).toBe(91);
  await expect(readFile(outputPath, "utf8")).resolves.toBe(sourceText);
  expect(await publicationDebris(root)).toEqual({ locks: 1, temporaries: 1 });
  const recoveryCrashScript = `
    const { assertLocalPromptCandidateOutputAvailable } = await import(${JSON.stringify(publisherUrl)});
    await assertLocalPromptCandidateOutputAvailable(
      ${JSON.stringify(outputPath)},
      {
        duringCompletedPublicationRecovery: (phase) => {
          if (phase === "after-dead-lock-validation") process.exit(92);
        },
      },
    );
  `;
  expect(await runChild(recoveryCrashScript)).toBe(92);
  expect(await publicationDebris(root)).toEqual({ locks: 1, temporaries: 1 });

  const cliPath = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const rerun = await runProcess(
    cliPath,
    [
      "candidate",
      "generate",
      "missing-baseline.workflow.yaml",
      "missing-evidence.json",
      "--output",
      outputPath,
    ],
    root,
  );
  expect(rerun.code).toBe(1);
  expect(rerun.stderr).toMatch(/output_exists/);
  await expect(readFile(outputPath, "utf8")).resolves.toBe(sourceText);
  expect(await publicationDebris(root)).toEqual({ locks: 0, temporaries: 0 });
  await expect(access(outputPath)).resolves.toBeUndefined();
});

function generatedCandidateText(): string {
  const { prepared } = promptCandidateGenerationFixture();
  const source = completePromptCandidateGeneration(
    prepared,
    JSON.stringify({
      changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
    }),
    {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 0,
    },
  );
  return `${JSON.stringify(source)}\n`;
}

async function publicationDebris(root: string): Promise<{
  readonly locks: number;
  readonly temporaries: number;
}> {
  const names = await readdir(root);
  return {
    locks: names.filter((name) => /^\..+\.generation\.lock$/.test(name)).length,
    temporaries: names.filter((name) => /^\..+\.generation\.[0-9a-f-]+\.tmp$/.test(name)).length,
  };
}

async function runChild(script: string): Promise<number | null> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "ignore",
  });
  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function runProcess(
  scriptPath: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stderr };
}
