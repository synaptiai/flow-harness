import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
    const workspaceCollection = join(root, ".workspace.flow-workspaces");
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
      const result = { workspaceWrite: false, workspaceCollectionWrite: false, siblingRead: false, runStoreWrite: false, gitWrite: false, flowWrite: false, leaked: process.env.FLOW_RUNTIME_SECRET ?? null };
      try { fs.writeFileSync(${JSON.stringify(workspaceOutput)}, "allowed"); result.workspaceWrite = true; } catch {}
      try { fs.mkdirSync(${JSON.stringify(workspaceCollection)}); result.workspaceCollectionWrite = true; } catch {}
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
    const linuxEphemeralMask = process.platform === "linux";
    expect(commandOutput).toEqual({
      workspaceWrite: true,
      workspaceCollectionWrite: linuxEphemeralMask,
      siblingRead: false,
      runStoreWrite: linuxEphemeralMask,
      gitWrite: false,
      flowWrite: linuxEphemeralMask,
      leaked: null,
    });
    await expect(readFile(workspaceOutput, "utf8")).resolves.toBe("allowed");
    await expect(lstat(workspaceCollection)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(runsDirectory, "tampered.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("denies reads of ancestor project Flow state from a nested workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-sandbox-project-state-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const flowDirectory = join(root, ".flow");
    const protectedFile = join(flowDirectory, "activations", "private.txt");
    const runsDirectory = join(flowDirectory, "runs");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(flowDirectory, "activations"), { recursive: true }),
    ]);
    await writeFile(
      join(flowDirectory, "config.yaml"),
      "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
      "utf8",
    );
    await writeFile(protectedFile, "PRIVATE_ACTIVATION", "utf8");
    const script = `
      const fs = require("node:fs");
      try {
        fs.readFileSync(${JSON.stringify(protectedFile)}, "utf8");
        process.stdout.write("readable");
      } catch {
        process.stdout.write("blocked");
      }
    `;

    const execution = await runCommandWorkflow(workspace, runsDirectory, script, {}, workspace);

    expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const state = JSON.parse(execution.stdout);
    expect(state.nodes.execute.evidence.stdout).toBe("blocked");
  });

  it("denies a private workspace collection inside a broad execution root", async () => {
    const root = await createFixtureRoot();
    const runsDirectory = join(root, "runs");
    const privateCollection = join(root, ".other-project.flow-workspaces");
    const legacyCollection = join(root, ".flow-workspaces");
    const privateFile = join(privateCollection, "private.txt");
    const legacyFile = join(legacyCollection, "private.txt");
    const attemptedWrite = join(privateCollection, "tampered.txt");
    const legacyAttemptedWrite = join(legacyCollection, "tampered.txt");
    await Promise.all([
      mkdir(privateCollection, { recursive: true }),
      mkdir(legacyCollection, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(privateFile, "PRIVATE_WORKSPACE", "utf8"),
      writeFile(legacyFile, "PRIVATE_WORKSPACE", "utf8"),
    ]);
    const script = `
      const fs = require("node:fs");
      const result = { read: false, write: false, legacyRead: false, legacyWrite: false };
      try { fs.readFileSync(${JSON.stringify(privateFile)}, "utf8"); result.read = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(attemptedWrite)}, "tampered"); result.write = true; } catch {}
      try { fs.readFileSync(${JSON.stringify(legacyFile)}, "utf8"); result.legacyRead = true; } catch {}
      try { fs.writeFileSync(${JSON.stringify(legacyAttemptedWrite)}, "tampered"); result.legacyWrite = true; } catch {}
      process.stdout.write(JSON.stringify(result));
    `;

    const execution = await runCommandWorkflow(root, runsDirectory, script);

    expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const state = JSON.parse(execution.stdout);
    const linuxEphemeralMask = process.platform === "linux";
    expect(JSON.parse(state.nodes.execute.evidence.stdout)).toEqual({
      read: false,
      write: linuxEphemeralMask,
      legacyRead: false,
      legacyWrite: linuxEphemeralMask,
    });
    await expect(readFile(attemptedWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(legacyAttemptedWrite, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies project Flow-state and sibling-ledger reads from a child workspace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-sandbox-child-state-")));
    temporaryDirectories.push(root);
    const flowDirectory = join(root, ".flow");
    const activationFile = join(flowDirectory, "activations", "private.txt");
    const siblingLedger = join(flowDirectory, "runs", "sibling.jsonl");
    const collection = join(dirname(root), `.${basename(root)}.flow-workspaces`);
    temporaryDirectories.push(collection);
    const owner = createHash("sha256")
      .update(join(flowDirectory, "runs"))
      .digest("hex")
      .slice(0, 24);
    const siblingWorkspaceFile = join(
      collection,
      owner,
      "existing-sibling",
      "workspace",
      "secret.txt",
    );
    await Promise.all([
      mkdir(join(flowDirectory, "activations"), { recursive: true }),
      mkdir(join(flowDirectory, "runs"), { recursive: true }),
      mkdir(dirname(siblingWorkspaceFile), { recursive: true }),
    ]);
    await writeFile(
      join(flowDirectory, "config.yaml"),
      "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
      "utf8",
    );
    await writeFile(activationFile, "PRIVATE_ACTIVATION", "utf8");
    await writeFile(siblingLedger, '{"private":"run"}\n', "utf8");
    await writeFile(siblingWorkspaceFile, "PRIVATE_SIBLING_WORKSPACE", "utf8");
    const script = `
      const fs = require("node:fs");
      const result = { "activation-read": false, "sibling-read": false, "workspace-read": false };
      try { fs.readFileSync(${JSON.stringify(activationFile)}, "utf8"); result["activation-read"] = true; } catch {}
      try { fs.readFileSync(${JSON.stringify(siblingLedger)}, "utf8"); result["sibling-read"] = true; } catch {}
      try { fs.readFileSync(${JSON.stringify(siblingWorkspaceFile)}, "utf8"); result["workspace-read"] = true; } catch {}
      process.stdout.write(JSON.stringify(result));
    `;

    const execution = await runWorkflowSource(
      root,
      join(flowDirectory, "runs"),
      childCommandWorkflow(script),
      root,
    );

    expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const state = JSON.parse(execution.stdout);
    const childOutput = JSON.parse(state.nodes.delegate.evidence.result.canonicalValue);
    expect(childOutput).toEqual({
      "activation-read": false,
      "sibling-read": false,
      "workspace-read": false,
    });
  });

  it("denies a child read from a sibling in an outer private collection", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-sandbox-nested-state-")));
    temporaryDirectories.push(root);
    const outerCollection = join(dirname(root), `.${basename(root)}.flow-workspaces`);
    temporaryDirectories.push(outerCollection);
    const innerProject = join(outerCollection, "owner", "current", "workspace", "inner-project");
    const flowDirectory = join(innerProject, ".flow");
    const outerSiblingSecret = join(outerCollection, "owner", "sibling", "workspace", "secret.txt");
    await Promise.all([
      mkdir(join(flowDirectory, "runs"), { recursive: true }),
      mkdir(dirname(outerSiblingSecret), { recursive: true }),
    ]);
    await writeFile(
      join(flowDirectory, "config.yaml"),
      "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
      "utf8",
    );
    await writeFile(outerSiblingSecret, "PRIVATE_OUTER_SIBLING", "utf8");
    const script = `
      const fs = require("node:fs");
      const result = { "activation-read": false, "sibling-read": false, "workspace-read": false };
      try { fs.readFileSync(${JSON.stringify(outerSiblingSecret)}, "utf8"); result["workspace-read"] = true; } catch {}
      process.stdout.write(JSON.stringify(result));
    `;

    const execution = await runWorkflowSource(
      innerProject,
      join(flowDirectory, "runs"),
      childCommandWorkflow(script),
      innerProject,
    );

    expect(execution.code, `${execution.stderr}\n${execution.stdout}`).toBe(0);
    const state = JSON.parse(execution.stdout);
    expect(JSON.parse(state.nodes.delegate.evidence.result.canonicalValue)).toEqual({
      "activation-read": false,
      "sibling-read": false,
      "workspace-read": false,
    });
  });
});

async function createFixtureRoot(): Promise<string> {
  const directory = await mkdtemp(join(homedir(), ".flow-sandbox-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCommandWorkflow(
  workspace: string,
  runsDirectory: string,
  script: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
  invocationDirectory = projectRoot,
): Promise<ProcessResult> {
  return await runWorkflowSource(
    workspace,
    runsDirectory,
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
    invocationDirectory,
    additionalEnvironment,
  );
}

async function runWorkflowSource(
  workspace: string,
  runsDirectory: string,
  source: string,
  invocationDirectory: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  const workflowPath = join(workspace, "sandbox.workflow.yaml");
  await writeFile(workflowPath, source, "utf8");

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
      cwd: invocationDirectory,
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

function childCommandWorkflow(script: string): string {
  const child = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: sandbox-child }
budget:
  maxNodeStarts: 4
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 20000
  maxArtifactBytes: 100000
nodes:
  - id: execute
    type: command
    command:
      executable: ${JSON.stringify(process.execPath)}
      args:
        - -e
        - ${JSON.stringify(script)}
      timeoutMs: 10000
  - id: publish
    type: result
    dependsOn: [execute]
    result:
      source: { nodeId: execute, field: command.stdout }
      schema:
        type: object
        properties:
          activation-read: { type: boolean }
          sibling-read: { type: boolean }
          workspace-read: { type: boolean }
        required: [activation-read, sibling-read, workspace-read]
`.trim();
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: sandbox-child-parent }
budget:
  maxNodeStarts: 8
  maxModelTokens: 100
  maxCostUsd: 0.01
  maxExecutionMs: 30000
  maxArtifactBytes: 200000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |
${child
  .split("\n")
  .map((line) => `        ${line}`)
  .join("\n")}
`;
}

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
