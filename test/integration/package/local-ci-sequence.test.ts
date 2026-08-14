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

    const { FLOW_PRIME_PREPARED_ATTESTATION: _prepared, ...cleanEnvironment } = process.env;
    const result = await run(process.execPath, ["scripts/ci-local.mjs"], {
      ...cleanEnvironment,
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
            readonly imageResultPath: string | null;
          },
      );
    const preparationIndex = commands.findIndex(
      ({ command, args }) =>
        command === "node" && args.slice(-3).join(" ") === "runtime prepare prime-agent",
    );
    const coverageIndex = commands.findIndex(
      ({ command, args }) => command === "npm" && args.join(" ") === "run test:coverage",
    );
    const runtimeIndex = commands.findIndex(
      ({ command, args }) => command === "npm" && args.join(" ") === "run test:runtime",
    );
    const primeAuditIndex = commands.findIndex(
      ({ command, args }) =>
        command === "node" && args.join(" ") === "scripts/audit-prime-dependencies.mjs",
    );

    expect(preparationIndex).toBeGreaterThan(-1);
    expect(coverageIndex).toBeGreaterThan(preparationIndex);
    expect(runtimeIndex).toBeGreaterThan(preparationIndex);
    expect(primeAuditIndex).toBeGreaterThan(preparationIndex);
    expect(commands[coverageIndex]?.imageId).toBe(`sha256:${"a".repeat(64)}`);
    expect(commands[runtimeIndex]?.imageId).toBe(`sha256:${"a".repeat(64)}`);
    expect(commands[coverageIndex]?.imageResultPath).toMatch(/image-result\.json$/);
    expect(commands[runtimeIndex]?.imageResultPath).toBe(commands[coverageIndex]?.imageResultPath);
  });

  it("ignores an ambient prepared attestation and strips it from verified gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-local-ci-prepared-"));
    temporaryDirectories.push(root);
    const binaryRoot = join(root, "bin");
    const logPath = join(root, "commands.jsonl");
    const attestationPath = join(root, "attestation.json");
    const ambientResultPath = join(root, "ambient-prime-evidence.json");
    await mkdir(binaryRoot);
    await writeFile(attestationPath, JSON.stringify({ image: { id: `sha256:${"b".repeat(64)}` } }));
    await writeExecutable(join(binaryRoot, "npm"), fakeCommandSource("npm", logPath, false));
    await writeExecutable(join(binaryRoot, "node"), fakeCommandSource("node", logPath, true));

    const result = await run(process.execPath, ["scripts/ci-local.mjs"], {
      ...process.env,
      PATH: `${binaryRoot}${delimiter}${process.env.PATH ?? ""}`,
      FLOW_PRIME_PREPARED_ATTESTATION: attestationPath,
      FLOW_PRIME_TEST_IMAGE_ID: `sha256:${"b".repeat(64)}`,
      FLOW_PRIME_TEST_IMAGE_RESULT: ambientResultPath,
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
            readonly imageResultPath: string | null;
            readonly preparedAttestation: string | null;
          },
      );
    expect(
      commands.some(
        ({ command, args }) =>
          command === "node" && args.slice(-3).join(" ") === "runtime prepare prime-agent",
      ),
    ).toBe(true);
    const firstVerifiedIndex = commands.findIndex(({ imageId }) => imageId !== null);
    expect(firstVerifiedIndex).toBeGreaterThan(0);
    expect(
      commands
        .slice(0, firstVerifiedIndex)
        .every(
          ({ imageId, imageResultPath, preparedAttestation }) =>
            imageId === null && imageResultPath === null && preparedAttestation === null,
        ),
    ).toBe(true);
    const verified = commands.filter(({ imageId }) => imageId !== null);
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every(({ imageId }) => imageId === `sha256:${"a".repeat(64)}`)).toBe(true);
    const generatedResultPath = verified[0]?.imageResultPath;
    expect(generatedResultPath).not.toBeNull();
    expect(generatedResultPath).not.toBe(ambientResultPath);
    expect(generatedResultPath).toMatch(/flow-prime-ci-[^/]+\/image-result\.json$/);
    expect(verified.every(({ imageResultPath }) => imageResultPath === generatedResultPath)).toBe(
      true,
    );
    expect(verified.every(({ preparedAttestation }) => preparedAttestation === null)).toBe(true);
  });
});

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function fakeCommandSource(command: string, logPath: string, handlesImageOutput: boolean): string {
  return `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  command: ${JSON.stringify(command)},
  args,
  imageId: process.env.FLOW_PRIME_TEST_IMAGE_ID ?? null,
  imageResultPath: process.env.FLOW_PRIME_TEST_IMAGE_RESULT ?? null,
  preparedAttestation: process.env.FLOW_PRIME_PREPARED_ATTESTATION ?? null,
}) + "\\n");
if (${JSON.stringify(handlesImageOutput)} && args.slice(-3).join(" ") === "runtime prepare prime-agent") {
  const runtimeRoot = join(process.cwd(), ".flow", "runtime", "prime-agent");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "oci-attestation.json"), JSON.stringify({ image: { id: "sha256:${"a".repeat(64)}" } }));
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
