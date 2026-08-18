import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  const browserWorkflow = join(projectRoot, "packed-browser.workflow.yaml");
  const browserRuns = join(projectRoot, "browser-runs");
  await writeFile(
    browserWorkflow,
    `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packed-browser-workflow }
nodes:
  - id: execute
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args: [-e, ${JSON.stringify("process.stdout.write('packed-browser-ready');")}]
      timeoutMs: 10000
`,
    "utf8",
  );
  await run(
    flowBinary,
    [
      "run",
      browserWorkflow,
      "--run-id",
      "packed-browser-run",
      "--runs-dir",
      browserRuns,
      "--cwd",
      projectRoot,
    ],
    projectRoot,
  );
  await verifyBrowserPresentation(flowBinary, browserRuns, projectRoot);

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

async function verifyBrowserPresentation(flowBinary, runsDirectory, cwd) {
  const child = spawn(
    flowBinary,
    ["web", "packed-browser-run", "--actor", "package:test", "--runs-dir", runsDirectory],
    {
      cwd,
      env: { ...process.env, npm_config_cache: join(verificationRoot, "npm-cache") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once("error", rejectCompleted);
    child.once("close", (code, signal) => resolveCompleted({ code, signal }));
  });
  try {
    const firstLine = await waitForLine(child.stdout);
    const sessionUrl = new URL(firstLine);
    const capability = sessionUrl.hash.slice(1);
    assert.equal(sessionUrl.hostname, "127.0.0.1");
    assert.match(capability, /^[0-9a-f]{64}$/);
    const response = await fetch(`${sessionUrl.origin}/api/documents`, {
      headers: {
        authorization: `Bearer ${capability}`,
        origin: sessionUrl.origin,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const document = JSON.parse((await response.text()).trim());
    assert.equal(document.run.runId, "packed-browser-run");
    assert.equal(document.run.workflowId, "packed-browser-workflow");
    assert.equal(document.run.status, "succeeded");
    const result = await completed;
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.equal(stdout.trim(), sessionUrl.href);
  } finally {
    child.kill("SIGTERM");
    await run(flowBinary, ["supervisor", "shutdown", "--runs-dir", runsDirectory], cwd).catch(
      () => undefined,
    );
  }
}

async function waitForLine(stream) {
  return await new Promise((resolveLine, rejectLine) => {
    let pending = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error("installed browser presentation did not publish its URL"));
    }, 15_000);
    timeout.unref();
    const onData = (chunk) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolveLine(pending.slice(0, newline));
      }
    };
    const onClose = () => {
      cleanup();
      rejectLine(new Error("installed browser presentation closed before publishing its URL"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("close", onClose);
  });
}
