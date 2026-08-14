import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const runsDirectory = await mkdtemp(resolve(tmpdir(), "flow-compiled-smoke-"));
const cli = resolve(repositoryRoot, "dist/cli/main.js");

try {
  await run(["--help"]);
  await run(["validate", "examples/verify-foundation.workflow.yaml"]);
  await run([
    "run",
    "examples/verify-foundation.workflow.yaml",
    "--run-id",
    "ci-smoke",
    "--runs-dir",
    runsDirectory,
  ]);
  const inspected = await run(["inspect", "ci-smoke", "--runs-dir", runsDirectory]);
  assert.match(inspected, /ci-smoke/);
} finally {
  await rm(runsDirectory, { recursive: true, force: true });
}

async function run(args) {
  const result = await execute(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}
