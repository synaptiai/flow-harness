import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const verificationRoot = await mkdtemp(join(tmpdir(), "flow-package-check-"));

try {
  await run("npm", ["run", "build"], repositoryRoot);
  const packed = await run("npm", ["pack", "--pack-destination", verificationRoot], repositoryRoot);
  const tarballName = packed.stdout.trim().split("\n").at(-1);
  assert(tarballName, "npm pack did not report a tarball name");

  const tarballPath = join(verificationRoot, tarballName);
  const consumerRoot = join(verificationRoot, "consumer");
  const projectRoot = join(verificationRoot, "project");
  await mkdir(projectRoot);
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerRoot,
      tarballPath,
    ],
    verificationRoot,
  );

  const flowBinary = join(consumerRoot, "node_modules", ".bin", "flow");
  const help = await run(flowBinary, ["--help"], projectRoot);
  assert.match(help.stdout, /flow validate/, "the installed Flow binary did not print CLI help");

  await run(flowBinary, ["init", projectRoot], projectRoot);
  const shown = await run(flowBinary, ["config", "show"], projectRoot);
  const effective = JSON.parse(shown.stdout);
  assert.deepEqual(effective.supervisor, { maxActiveWorkers: 1, maxQueuedJobs: 32 });
  assert.equal(effective.projectRoot, await realpath(projectRoot));

  const installedPackageRoot = join(consumerRoot, "node_modules", "@synaptiai", "flow-harness");
  const primeExample = join(
    installedPackageRoot,
    "examples",
    "evaluation",
    "native-prime-agent-comparison.evaluation.yaml",
  );
  await access(primeExample);
  const primeValidation = await runExpectFailure(
    flowBinary,
    ["eval", "validate", primeExample],
    projectRoot,
  );
  assert.match(
    `${primeValidation.stdout}\n${primeValidation.stderr}`,
    /Prime|oci-attestation|ENOENT/i,
    "the installed CLI did not reach the Prime runtime preparation boundary",
  );

  process.stdout.write(
    `Verified clean installation and CLI execution from ${tarballName} (${effective.policyDigest}).\n`,
  );
} finally {
  await rm(verificationRoot, { recursive: true, force: true });
}

async function run(command, args, cwd) {
  return await execute(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(verificationRoot, "npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runExpectFailure(command, args, cwd) {
  try {
    await run(command, args, cwd);
  } catch (error) {
    assert.equal(typeof error, "object");
    assert(error !== null);
    return {
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
  assert.fail(`${command} ${args.join(" ")} unexpectedly succeeded`);
}
