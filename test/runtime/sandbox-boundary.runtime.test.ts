import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(projectRoot, "dist", "cli", "main.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("compiled command sandbox boundary", () => {
  it("allows workspace work while protecting home siblings, run state, and credentials", async () => {
    const root = await createFixtureRoot();
    const workspace = join(root, "workspace");
    const runsDirectory = join(workspace, "relocated-runs");
    const siblingSecret = join(root, "sibling-secret.txt");
    const workspaceOutput = join(workspace, "ordinary-output.txt");
    const gitWrite = join(workspace, ".git", "tampered.txt");
    const flowWrite = join(workspace, ".flow", "tampered.txt");
    await Promise.all([
      mkdir(join(workspace, ".git"), { recursive: true }),
      mkdir(join(workspace, ".flow"), { recursive: true }),
    ]);
    await writeFile(siblingSecret, "host-secret", "utf8");

    const script = `
      const fs = require("node:fs");
      const result = { workspaceWrite: false, siblingRead: false, runStoreWrite: false, gitWrite: false, flowWrite: false, leaked: process.env.FLOW_RUNTIME_SECRET ?? null };
      try { fs.writeFileSync(${JSON.stringify(workspaceOutput)}, "allowed"); result.workspaceWrite = true; } catch {}
      try { fs.readFileSync(${JSON.stringify(siblingSecret)}, "utf8"); result.siblingRead = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(join(runsDirectory, "tampered.txt"))}, "tampered"); result.runStoreWrite = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(gitWrite)}, "tampered"); result.gitWrite = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(flowWrite)}, "tampered"); result.flowWrite = true; } catch {}
      process.stdout.write(JSON.stringify(result));
    `;
    const execution = await runCommandWorkflow(workspace, runsDirectory, script, {
      FLOW_RUNTIME_SECRET: "must-not-reach-command",
    });

    expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const state = JSON.parse(execution.stdout);
    const commandOutput = JSON.parse(state.nodes.execute.evidence.stdout);
    expect(commandOutput).toEqual({
      workspaceWrite: true,
      siblingRead: false,
      runStoreWrite: false,
      gitWrite: false,
      flowWrite: false,
      leaked: null,
    });
    await expect(readFile(workspaceOutput, "utf8")).resolves.toBe("allowed");
    await expect(readFile(gitWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(flowWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.nodes.execute.evidence.sandbox).toMatchObject({
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      profile: "workspace-write-network-deny-v1",
      policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("denies a loopback service that is reachable from the host", async () => {
    const root = await createFixtureRoot();
    const workspace = join(root, "workspace");
    const runsDirectory = join(workspace, "runs");
    await mkdir(workspace, { recursive: true });
    const server = createServer((_request, response) => response.end("reachable"));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not expose a TCP port");
      }
      const url = `http://127.0.0.1:${address.port}`;
      await expect(fetch(url).then((response) => response.text())).resolves.toBe("reachable");
      const script = `
        const http = require("node:http");
        const request = http.get(${JSON.stringify(url)}, response => {
          response.resume();
          response.on("end", () => { process.stdout.write("reachable"); });
        });
        request.setTimeout(1000, () => request.destroy(new Error("timeout")));
        request.on("error", () => process.stdout.write("blocked"));
      `;

      const execution = await runCommandWorkflow(workspace, runsDirectory, script);

      expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
      const state = JSON.parse(execution.stdout);
      expect(state.nodes.execute.evidence.stdout).toBe("blocked");
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
    }
  });
});

async function createFixtureRoot(): Promise<string> {
  const directory = await mkdtemp(join(projectRoot, ".flow-sandbox-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCommandWorkflow(
  workspace: string,
  runsDirectory: string,
  script: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  const workflowPath = join(workspace, "sandbox.workflow.yaml");
  await writeFile(
    workflowPath,
    `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: sandbox-boundary }
nodes:
  - id: execute
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args:
        - -e
        - ${JSON.stringify(script)}
      timeoutMs: 10000
`,
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [
      cliPath,
      "run",
      workflowPath,
      "--run-id",
      `sandbox-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "--runs-dir",
      runsDirectory,
      "--cwd",
      workspace,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, ...additionalEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return await new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
