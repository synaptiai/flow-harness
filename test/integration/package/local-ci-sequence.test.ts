import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local CI sequence", () => {
  it("builds the Prime image before tests and passes its identity to each test gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-local-ci-"));
    temporaryDirectories.push(root);
    const binaryRoot = join(root, "bin");
    const logPath = join(root, "commands.jsonl");
    await mkdir(binaryRoot);
    await writeExecutable(join(binaryRoot, "npm"), fakeCommandSource("npm", logPath, false));
    await writeExecutable(join(binaryRoot, "node"), fakeCommandSource("node", logPath, true));

    const result = await run(process.execPath, ["scripts/ci-local.mjs"], {
      ...process.env,
      PATH: `${binaryRoot}${delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result).toEqual({ code: 0, stderr: "" });
    const commands = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly command: string;
            readonly args: readonly string[];
            readonly imageId: string | null;
          },
      );
    const imageBuildIndex = commands.findIndex(
      ({ command, args }) => command === "node" && args[0] === "scripts/verify-prime-image.mjs",
    );
    const coverageIndex = commands.findIndex(
      ({ command, args }) => command === "npm" && args.join(" ") === "run test:coverage",
    );
    const runtimeIndex = commands.findIndex(
      ({ command, args }) => command === "npm" && args.join(" ") === "run test:runtime",
    );

    expect(imageBuildIndex).toBeGreaterThan(-1);
    expect(coverageIndex).toBeGreaterThan(imageBuildIndex);
    expect(runtimeIndex).toBeGreaterThan(imageBuildIndex);
    expect(commands[coverageIndex]?.imageId).toBe(`sha256:${"a".repeat(64)}`);
    expect(commands[runtimeIndex]?.imageId).toBe(`sha256:${"a".repeat(64)}`);
  });
});

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function fakeCommandSource(command: string, logPath: string, handlesImageOutput: boolean): string {
  return `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  command: ${JSON.stringify(command)},
  args,
  imageId: process.env.FLOW_PRIME_TEST_IMAGE_ID ?? null,
}) + "\\n");
if (${JSON.stringify(handlesImageOutput)} && args[0] === "scripts/verify-prime-image.mjs") {
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || args[outputIndex + 1] === undefined) process.exit(2);
  writeFileSync(args[outputIndex + 1], JSON.stringify({ image: { id: "sha256:${"a".repeat(64)}" } }));
}
`;
}

async function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      resolveRun({ code, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}
