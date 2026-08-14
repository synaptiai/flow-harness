import { type ChildProcess, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutionContext } from "../../src/application/ports.js";
import type { CompiledCommandNode } from "../../src/domain/workflow/types.js";
import { DockerUnixApiClient } from "../../src/infrastructure/oci/docker-unix-api-client.js";
import { CommandNodeExecutor } from "../../src/infrastructure/process/command-node-executor.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const linux = process.platform === "linux" && process.arch === "x64";
const repositoryRoot = resolve(import.meta.dirname, "../..");
const workerPath = join(
  repositoryRoot,
  "test",
  "fixtures",
  "container-command",
  "container-command-crash-worker.mjs",
);
const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linux)("container command crash recovery", () => {
  it("claims a dead owner and removes its exact full-ID container before the next command", async () => {
    const projectRoot = await createPreparedProject();
    const readyPath = join(projectRoot, "worker.ready");
    const worker = spawn(process.execPath, [workerPath, projectRoot, readyPath], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childProcesses.push(worker);
    await waitForFile(readyPath, worker);
    const recordPath = await onlyIntentRecord(projectRoot);
    const intent = JSON.parse(await readFile(recordPath, "utf8")) as {
      readonly containerId?: string;
    };
    expect(intent.containerId).toMatch(/^[a-f0-9]{64}$/);
    const containerId = intent.containerId as string;
    worker.kill("SIGKILL");
    await waitForExit(worker);

    const outcome = await execute(projectRoot);

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: { stdout: "recovered", sandbox: { profile: "flow-container-v1" } },
    });
    const attestation = JSON.parse(
      await readFile(
        join(projectRoot, ".flow", "runtime", "prime-agent", "oci-attestation.json"),
        "utf8",
      ),
    ) as { readonly local: { readonly apiVersion: string } };
    const api = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: attestation.local.apiVersion,
    });
    await expect(api.inspectContainer(containerId)).resolves.toBeNull();
    await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
  }, 90_000);
});

async function execute(projectRoot: string) {
  const executor = new CommandNodeExecutor({
    sandbox: createProductionCommandSandbox("container", projectRoot),
  });
  return executor.execute(commandNode(), context(projectRoot));
}

function commandNode(): CompiledCommandNode {
  return {
    id: "container-recovery",
    type: "command",
    dependsOn: [],
    command: {
      executable: "/usr/local/bin/node",
      args: ["-e", 'process.stdout.write("recovered")'],
      timeoutMs: 30_000,
    },
  };
}

function context(projectRoot: string): NodeExecutionContext {
  return {
    runId: "container-command-recovery",
    workflowId: "container-command-recovery",
    attempt: 1,
    cwd: projectRoot,
    projectRoot,
    protectedPaths: [join(projectRoot, ".flow")],
  };
}

async function createPreparedProject(): Promise<string> {
  const source = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (source === undefined) {
    throw new Error("container recovery gate requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const projectRoot = await mkdtemp(join(tmpdir(), "flow-container-command-recovery-"));
  temporaryDirectories.push(projectRoot);
  const runtimeDirectory = join(projectRoot, ".flow", "runtime", "prime-agent");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(
    join(projectRoot, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
    "utf8",
  );
  await copyFile(source, join(runtimeDirectory, "oci-attestation.json"));
  return projectRoot;
}

async function waitForFile(path: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `container crash worker exited before readiness: ${child.signalCode ?? String(child.exitCode)}`,
      );
    }
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("container crash worker readiness timed out");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolveExit());
  });
}

async function onlyIntentRecord(projectRoot: string): Promise<string> {
  const directory = join(projectRoot, ".flow", "container-command-intents");
  const records = await readIntentRecords(projectRoot);
  expect(records).toHaveLength(1);
  return join(directory, records[0] as string);
}

async function readIntentRecords(projectRoot: string): Promise<readonly string[]> {
  const directory = join(projectRoot, ".flow", "container-command-intents");
  return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
}
