import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const COMMAND_TIMEOUT_MS = 180_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_SNAPSHOT_ENTRIES = 1_024;
const MAX_PROJECT_SNAPSHOT_BYTES = 4 * 1024 * 1024;

try {
  await verifyPackage();
} catch (error) {
  const message =
    error instanceof Error && /^Package release failed during [a-z ]+$/.test(error.message)
      ? error.message
      : "Package release failed during verify installed package";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function verifyPackage() {
  const releaseMode = parseMode(process.argv.slice(2));
  const verificationRoot = await mkdtemp(join(tmpdir(), "flow-package-check-"));
  let operationFailed = false;
  let operationError;
  try {
    if (!releaseMode) {
      await withPackageReleaseStage("build package source", async () => {
        await run("npm", ["run", "build"], repositoryRoot, verificationRoot);
      });
    }
    const { releaseArtifact, releaseVerifier, strictJson } = await withPackageReleaseStage(
      "load package verification modules",
      async () => {
        const [releaseArtifact, releaseVerifier, strictJson] = await Promise.all([
          import("../dist/infrastructure/release/package-release-artifact.js"),
          import("../dist/infrastructure/release/package-release-verifier.js"),
          import("../dist/domain/strict-json.js"),
        ]);
        return { releaseArtifact, releaseVerifier, strictJson };
      },
    );
    const expectedRevision = await withPackageReleaseStage(
      "resolve package source revision",
      async () => await sourceRevision(verificationRoot),
    );
    const artifact = await withPackageReleaseStage("create package artifact", async () =>
      releaseMode
        ? await readPreparedArtifact()
        : await buildEphemeralArtifact(
            verificationRoot,
            expectedRevision,
            releaseArtifact.preparePackageReleaseEvidence,
            strictJson.parseStrictJson,
          ),
    );
    const evidence = await withPackageReleaseStage("verify package artifact", async () =>
      releaseVerifier.verifyPackageReleaseArtifact({
        archive: artifact.archive,
        evidenceBytes: artifact.evidenceBytes,
        expectedSourceRevision: expectedRevision,
      }),
    );

    const consumerRoot = join(verificationRoot, "consumer");
    const projectRoot = join(verificationRoot, "project");
    await withPackageReleaseStage("install package artifact", async () => {
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
          artifact.archivePath,
        ],
        verificationRoot,
        verificationRoot,
      );
    });

    const installedPackageRoot = join(consumerRoot, "node_modules", "@synaptiai", "flow-harness");
    const flowBinary = join(consumerRoot, "node_modules", ".bin", "flow");
    await withPackageReleaseStage("verify installed package", async () => {
      await releaseVerifier.verifyInstalledPackageRelease(installedPackageRoot, evidence);
      const help = await run(flowBinary, ["--help"], projectRoot, verificationRoot);
      assert.match(
        help.stdout,
        /flow validate/,
        "the installed Flow binary did not print CLI help",
      );
    });

    const effective = await withPackageReleaseStage("run installed quick start", async () => {
      const existingFile = join(projectRoot, "README.md");
      await writeFile(existingFile, "existing consumer file\n", "utf8");
      const quickstart = JSON.parse(
        (
          await run(
            flowBinary,
            ["quickstart", projectRoot, "--run-id", "packed-quickstart"],
            projectRoot,
            verificationRoot,
          )
        ).stdout,
      );
      assert.deepEqual(quickstart, {
        version: 1,
        mode: "foundation",
        project: { publication: "created" },
        run: {
          id: "packed-quickstart",
          status: "succeeded",
          evidence: ".flow/runs/packed-quickstart/events.jsonl",
        },
        commands: {
          inspect: ["flow", "inspect", "packed-quickstart"],
          browser: ["flow", "web", "packed-quickstart", "--actor", "operator:quickstart"],
        },
      });
      assert.equal(await readFile(existingFile, "utf8"), "existing consumer file\n");
      const shown = await run(flowBinary, ["config", "show"], projectRoot, verificationRoot);
      const effective = JSON.parse(shown.stdout);
      assert.deepEqual(effective.supervisor, { maxActiveWorkers: 1, maxQueuedJobs: 32 });
      assert.equal(effective.projectRoot, await realpath(projectRoot));
      return effective;
    });
    const quickstartProjectBeforeDoctor = await withPackageReleaseStage(
      "inspect quick-start project",
      async () => {
        const snapshot = await snapshotProjectFiles(projectRoot);
        const paths = new Map(snapshot.map((entry) => [entry.path, entry]));
        for (const expected of [
          ".",
          ".flow",
          ".flow/config.yaml",
          ".flow/runs/packed-quickstart/events.jsonl",
          "README.md",
        ]) {
          assert.equal(paths.has(expected), true, "the quick-start project snapshot is incomplete");
        }
        const projectConfiguration = paths.get(".flow/config.yaml");
        assert.equal(projectConfiguration?.contentBase64 !== undefined, true);
        assert.equal(
          Buffer.from(projectConfiguration.contentBase64, "base64").toString("utf8"),
          "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
        );
        const existingFile = paths.get("README.md");
        assert.equal(existingFile?.contentBase64 !== undefined, true);
        assert.equal(
          Buffer.from(existingFile.contentBase64, "base64").toString("utf8"),
          "existing consumer file\n",
        );
        assert.equal(
          snapshot.every(
            (entry) =>
              Number.isSafeInteger(entry.mode) &&
              Number.isSafeInteger(entry.uid) &&
              Number.isSafeInteger(entry.gid) &&
              Number.isSafeInteger(entry.dev) &&
              Number.isSafeInteger(entry.ino) &&
              Number.isSafeInteger(entry.nlink) &&
              Number.isSafeInteger(entry.size) &&
              Number.isFinite(entry.mtimeMs) &&
              Number.isFinite(entry.ctimeMs),
          ),
          true,
          "the quick-start project snapshot omits filesystem identity",
        );
        return snapshot;
      },
    );
    const doctorReport = await readInstalledDoctorReport(flowBinary, projectRoot, verificationRoot);
    await withPackageReleaseStage("verify installed diagnostic", async () => {
      assert.equal(doctorReport.version, 1);
      assert.equal(doctorReport.target, "project");
      assert.equal(doctorReport.ok, true);
      assert.deepEqual(
        doctorReport.checks.map((check) => [check.category, check.status]),
        [
          ["runtime.host", "pass"],
          ["project.configuration", "pass"],
          ["project.discovery", "pass"],
          ["project.filesystem", "pass"],
          ["sandbox.native", "pass"],
        ],
      );
    });
    await withPackageReleaseStage(
      "compare quick-start project",
      async () =>
        await assert.deepEqual(
          await snapshotProjectFiles(projectRoot),
          quickstartProjectBeforeDoctor,
          "flow doctor changed the quick-start project",
        ),
    );

    const quickstartRuns = join(projectRoot, ".flow", "runs");
    await withPackageReleaseStage("verify quick-start browser", async () => {
      await verifyBrowserPresentation(
        flowBinary,
        quickstartRuns,
        "packed-quickstart",
        "verify-installation",
        projectRoot,
        verificationRoot,
      );
    });

    const primeExample = join(
      installedPackageRoot,
      "examples",
      "evaluation",
      "native-prime-agent-comparison.evaluation.yaml",
    );
    await withPackageReleaseStage("verify installed prime boundary", async () => {
      await access(primeExample);
      const primeValidation = await runExpectFailure(
        flowBinary,
        ["eval", "validate", primeExample],
        projectRoot,
        verificationRoot,
      );
      assert.match(
        `${primeValidation.stdout}\n${primeValidation.stderr}`,
        /Prime|oci-attestation|ENOENT/i,
        "the installed CLI did not reach the Prime runtime preparation boundary",
      );
    });

    process.stdout.write(
      `Verified clean installation and CLI execution from ${evidence.archive.fileName} (${effective.policyDigest}).\n`,
    );
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await rm(verificationRoot, { recursive: true, force: true });
  } catch {
    if (!operationFailed) {
      throw new Error("Package release failed during cleanup package verification");
    }
  }
  if (operationFailed) {
    throw operationError;
  }
}

function parseMode(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--release") return true;
  throw new Error("invalid package verification arguments");
}

async function withPackageReleaseStage(stage, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`Package release failed during ${stage}`);
  }
}

async function sourceRevision(verificationRoot) {
  if (process.env.GITHUB_SHA !== undefined) return process.env.GITHUB_SHA;
  const result = await run("git", ["rev-parse", "HEAD"], repositoryRoot, verificationRoot);
  return result.stdout.trim();
}

async function readPreparedArtifact() {
  const releaseRoot = join(repositoryRoot, "release", "package");
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const archiveEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
  if (
    entries.length !== 2 ||
    archiveEntries.length !== 1 ||
    !entries.some((entry) => entry.isFile() && entry.name === "package-release-evidence.json")
  ) {
    throw new Error("prepared release directory is not exact");
  }
  const archivePath = join(releaseRoot, archiveEntries[0].name);
  return {
    archive: await readBoundedNoFollow(archivePath, MAX_ARCHIVE_BYTES),
    archivePath,
    evidenceBytes: await readBoundedNoFollow(
      join(releaseRoot, "package-release-evidence.json"),
      MAX_EVIDENCE_BYTES,
    ),
  };
}

async function buildEphemeralArtifact(
  verificationRoot,
  revision,
  preparePackageReleaseEvidence,
  parseStrictJson,
) {
  const packRoot = join(verificationRoot, "packed");
  await mkdir(packRoot);
  const packed = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    repositoryRoot,
    verificationRoot,
  );
  const packOutput = parseStrictJson(packed.stdout, {
    maxDepth: 8,
    maxNodes: 32_768,
    valueLabel: "npm pack output",
  });
  const entries = await readdir(packRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || !entries[0].name.endsWith(".tgz")) {
    throw new Error("npm pack did not produce one regular archive");
  }
  const archivePath = join(packRoot, entries[0].name);
  const archive = await readBoundedNoFollow(archivePath, MAX_ARCHIVE_BYTES);
  return {
    archive,
    archivePath,
    evidenceBytes: preparePackageReleaseEvidence({
      archive,
      packOutput,
      sourceRevision: revision,
    }),
  };
}

async function readBoundedNoFollow(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("package verification file is outside its bound");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      content.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("package verification file changed while it was read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function snapshotProjectFiles(root) {
  const snapshot = [];
  let bytes = 0;
  const visit = async (path, relativePath) => {
    if (snapshot.length >= MAX_PROJECT_SNAPSHOT_ENTRIES) {
      throw new Error("package verification project snapshot exceeds its entry limit");
    }
    const metadata = await lstat(path);
    const common = {
      path: relativePath,
      mode: metadata.mode & 0o7777,
      uid: metadata.uid,
      gid: metadata.gid,
      dev: metadata.dev,
      ino: metadata.ino,
      nlink: metadata.nlink,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    };
    if (metadata.isDirectory()) {
      snapshot.push({ ...common, type: "directory" });
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        await visit(join(path, entry.name), join(relativePath, entry.name));
      }
      return;
    }
    if (!metadata.isFile()) {
      throw new Error("package verification project snapshot found an unsupported entry");
    }
    const content = await readFile(path);
    bytes += content.byteLength;
    if (bytes > MAX_PROJECT_SNAPSHOT_BYTES) {
      throw new Error("package verification project snapshot exceeds its byte limit");
    }
    snapshot.push({ ...common, type: "file", contentBase64: content.toString("base64") });
  };
  await visit(root, ".");
  return snapshot;
}

async function run(command, args, cwd, verificationRoot) {
  return await execute(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(verificationRoot, "npm-cache") },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

async function runExpectFailure(command, args, cwd, verificationRoot) {
  try {
    await run(command, args, cwd, verificationRoot);
  } catch (error) {
    assert.equal(typeof error, "object");
    assert(error !== null);
    return {
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
    };
  }
  assert.fail("package verification command unexpectedly succeeded");
}

async function readInstalledDoctorReport(flowBinary, projectRoot, verificationRoot) {
  let source;
  try {
    source = (await run(flowBinary, ["doctor"], projectRoot, verificationRoot)).stdout;
  } catch (error) {
    if (typeof error !== "object" || error === null || typeof error.stdout !== "string") {
      throw new Error("Package release failed during run installed diagnostic");
    }
    source = error.stdout;
  }

  let report;
  try {
    report = JSON.parse(source);
  } catch {
    throw new Error("Package release failed during parse installed diagnostic");
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new Error("Package release failed during parse installed diagnostic");
  }
  if (report.ok !== true) {
    const failedCategory = Array.isArray(report.checks)
      ? report.checks.find(
          (check) =>
            typeof check === "object" &&
            check !== null &&
            !Array.isArray(check) &&
            check.status === "fail" &&
            typeof check.category === "string",
        )?.category
      : undefined;
    throw new Error(installedDoctorFailureStage(failedCategory));
  }
  return report;
}

function installedDoctorFailureStage(category) {
  switch (category) {
    case "runtime.host":
      return "Package release failed during installed host diagnostic";
    case "project.configuration":
      return "Package release failed during installed configuration diagnostic";
    case "project.discovery":
      return "Package release failed during installed discovery diagnostic";
    case "project.filesystem":
      return "Package release failed during installed filesystem diagnostic";
    case "sandbox.native":
      return "Package release failed during installed native sandbox diagnostic";
    default:
      return "Package release failed during installed environment diagnostic";
  }
}

async function verifyBrowserPresentation(
  flowBinary,
  runsDirectory,
  runId,
  workflowId,
  cwd,
  verificationRoot,
) {
  const child = spawn(
    flowBinary,
    ["web", runId, "--actor", "package:test", "--runs-dir", runsDirectory],
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
    assert.equal(document.run.runId, runId);
    assert.equal(document.run.workflowId, workflowId);
    assert.equal(document.run.status, "succeeded");
    const result = await withDeadline(
      completed,
      30_000,
      "installed browser presentation did not settle",
    );
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.equal(stdout.trim(), sessionUrl.href);
  } finally {
    child.kill("SIGTERM");
    await run(
      flowBinary,
      ["supervisor", "shutdown", "--runs-dir", runsDirectory],
      cwd,
      verificationRoot,
    ).catch(() => undefined);
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

async function withDeadline(operation, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => rejectTimeout(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
