import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutionContext } from "../../src/application/ports.js";
import type { CompiledCommandNode } from "../../src/domain/workflow/types.js";
import { DockerUnixApiClient } from "../../src/infrastructure/oci/docker-unix-api-client.js";
import { CommandNodeExecutor } from "../../src/infrastructure/process/command-node-executor.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const linux = process.platform === "linux" && process.arch === "x64";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linux)("container command sandbox runtime", () => {
  it("allows workspace mutation while denying protected state, credentials, peers, and network", async () => {
    const projectRoot = await createPreparedProject();
    const hostSocketDirectory = await mkdtemp(join(tmpdir(), "flow-command-host-socket-"));
    temporaryDirectories.push(hostSocketDirectory);
    const hostSocketPath = join(hostSocketDirectory, "private.sock");
    const peerSecret = join(projectRoot, "..", `peer-${process.pid}.txt`);
    temporaryDirectories.push(peerSecret);
    await writeFile(peerSecret, "PRIVATE_PEER", "utf8");
    const protectedSecret = join(projectRoot, ".flow", "private.txt");
    await writeFile(protectedSecret, "PRIVATE_FLOW", "utf8");
    await Promise.all([mkdir(join(projectRoot, ".git")), mkdir(join(projectRoot, "credentials"))]);
    await Promise.all([
      writeFile(join(projectRoot, ".env"), "PRIVATE_ENV_FILE", "utf8"),
      writeFile(join(projectRoot, "credentials", "provider.pem"), "PRIVATE_KEY_FILE", "utf8"),
      writeFile(join(projectRoot, ".git", "config"), "HOST_GIT_CONFIG", "utf8"),
    ]);
    const server = createServer();
    const unixServer = createServer();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    await new Promise<void>((resolveListen, reject) => {
      unixServer.once("error", reject);
      unixServer.listen(hostSocketPath, resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("container command runtime server did not expose a TCP port");
    }

    try {
      const script = `
        const fs = require("node:fs");
        const net = require("node:net");
        const result = { workspaceWrite: false, protectedRead: false, envFileLeaked: false, keyFileLeaked: false, gitRead: false, gitWrite: false, peerRead: false, credential: process.env.FLOW_CONTAINER_PRIVATE ?? null, hostLoopback: false, internet: false, unixSocket: false, tcpBind: false, unixBind: false };
        fs.writeFileSync("/workspace/result.txt", "container-ok\\n");
        result.workspaceWrite = true;
        try { fs.readFileSync("/workspace/.flow/private.txt", "utf8"); result.protectedRead = true; } catch {}
        try { result.envFileLeaked = fs.readFileSync("/workspace/.env", "utf8").includes("PRIVATE_ENV_FILE"); } catch {}
        try { result.keyFileLeaked = fs.readFileSync("/workspace/credentials/provider.pem", "utf8").includes("PRIVATE_KEY_FILE"); } catch {}
        try { fs.readFileSync("/workspace/.git/config", "utf8"); result.gitRead = true; } catch {}
        try { fs.writeFileSync("/workspace/.git/config", "tampered"); result.gitWrite = true; } catch {}
        try { fs.readFileSync(${JSON.stringify(peerSecret)}, "utf8"); result.peerRead = true; } catch {}
        let pending = 5;
        const settled = () => { if (--pending === 0) process.stdout.write(JSON.stringify(result)); };
        const settleOnce = () => {
          let complete = false;
          return () => {
            if (!complete) {
              complete = true;
              settled();
            }
          };
        };
        const hostLoopback = net.connect({ host: "127.0.0.1", port: ${address.port} });
        hostLoopback.setTimeout(1000);
        hostLoopback.on("connect", () => { result.hostLoopback = true; hostLoopback.destroy(); });
        hostLoopback.on("timeout", () => hostLoopback.destroy());
        hostLoopback.on("error", () => {});
        hostLoopback.on("close", settled);
        const internet = net.connect({ host: "1.1.1.1", port: 443 });
        internet.setTimeout(1000);
        internet.on("connect", () => { result.internet = true; internet.destroy(); });
        internet.on("timeout", () => internet.destroy());
        internet.on("error", () => {});
        internet.on("close", settled);
        const unixSocket = net.connect({ path: ${JSON.stringify(hostSocketPath)} });
        unixSocket.setTimeout(1000);
        unixSocket.on("connect", () => { result.unixSocket = true; unixSocket.destroy(); });
        unixSocket.on("timeout", () => unixSocket.destroy());
        unixSocket.on("error", () => {});
        unixSocket.on("close", settled);
        const tcpListener = net.createServer();
        const tcpSettled = settleOnce();
        tcpListener.on("listening", () => { result.tcpBind = true; tcpListener.close(tcpSettled); });
        tcpListener.on("error", tcpSettled);
        try { tcpListener.listen(0, "127.0.0.1"); } catch { tcpSettled(); }
        const unixListener = net.createServer();
        const unixSettled = settleOnce();
        unixListener.on("listening", () => { result.unixBind = true; unixListener.close(unixSettled); });
        unixListener.on("error", unixSettled);
        try { unixListener.listen("/workspace/private-listener.sock"); } catch { unixSettled(); }
      `;
      const outcome = await execute(projectRoot, script, 20_000);

      expect(outcome).toMatchObject({
        status: "succeeded",
        evidence: {
          kind: "command",
          exitCode: 0,
          timedOut: false,
          sandbox: {
            backend: "docker-engine",
            profile: "flow-container-v1",
            policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      if (outcome.evidence?.kind !== "command") {
        throw new Error("container command runtime returned no command evidence");
      }
      expect(JSON.parse(outcome.evidence.stdout)).toEqual({
        workspaceWrite: true,
        protectedRead: false,
        envFileLeaked: false,
        keyFileLeaked: false,
        gitRead: true,
        gitWrite: false,
        peerRead: false,
        credential: null,
        hostLoopback: false,
        internet: false,
        unixSocket: false,
        tcpBind: false,
        unixBind: false,
      });
      await expect(readFile(join(projectRoot, "result.txt"), "utf8")).resolves.toBe(
        "container-ok\n",
      );
      await expect(readFile(join(projectRoot, ".git", "config"), "utf8")).resolves.toBe(
        "HOST_GIT_CONFIG",
      );
      await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      await new Promise<void>((resolveClose, reject) => {
        unixServer.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
    }
  }, 60_000);

  it("enforces fixed cgroup resource controls", async () => {
    const projectRoot = await createPreparedProject();
    const script = `
      const fs = require("node:fs");
      const read = name => fs.readFileSync("/sys/fs/cgroup/" + name, "utf8").trim();
      process.stdout.write(JSON.stringify({ memory: read("memory.max"), swap: read("memory.swap.max"), pids: read("pids.max"), cpu: read("cpu.max") }));
    `;

    const outcome = await execute(projectRoot, script, 20_000);

    expect(outcome.status).toBe("succeeded");
    if (outcome.evidence?.kind !== "command") {
      throw new Error("container resource runtime returned no command evidence");
    }
    expect(JSON.parse(outcome.evidence.stdout)).toEqual({
      memory: "1073741824",
      swap: "0",
      pids: "64",
      cpu: "100000 100000",
    });
    await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
  }, 60_000);

  it("terminates descendants and removes the container after timeout", async () => {
    const projectRoot = await createPreparedProject();
    const descendantScript = `
      const fs = require("node:fs");
      fs.writeFileSync("/workspace/descendant-ready.txt", "ready");
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync("/workspace/post-cleanup-arm.txt")) {
        Atomics.wait(pause, 0, 0, 25);
      }
      fs.writeFileSync("/workspace/post-cleanup-write.txt", "survived");
    `;
    const script = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;

    const outcome = await execute(projectRoot, script, 5_000);

    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "command_timeout" },
      evidence: { timedOut: true, terminationStatus: "confirmed" },
    });
    await expect(readFile(join(projectRoot, "descendant-ready.txt"), "utf8")).resolves.toBe(
      "ready",
    );
    await writeFile(join(projectRoot, "post-cleanup-arm.txt"), "armed", "utf8");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    await expect(
      readFile(join(projectRoot, "post-cleanup-write.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
  }, 60_000);

  it("removes the container after operator cancellation", async () => {
    const projectRoot = await createPreparedProject();
    const readyPath = join(projectRoot, "cancellation-ready.txt");
    const controller = new AbortController();
    const executor = new CommandNodeExecutor({
      sandbox: createProductionCommandSandbox("container", projectRoot),
    });
    const operation = executor.execute(
      commandNode(
        'require("node:fs").writeFileSync("/workspace/cancellation-ready.txt", "ready"); setInterval(() => {}, 1000);',
        20_000,
      ),
      {
        ...context(projectRoot),
        signal: controller.signal,
      },
    );
    let settledBeforeReady = false;
    void operation.then(
      () => {
        settledBeforeReady = true;
      },
      () => {
        settledBeforeReady = true;
      },
    );
    await waitForRuntimeFile(readyPath, () => settledBeforeReady);
    controller.abort(new Error("operator cancelled container command"));

    await expect(operation).resolves.toMatchObject({
      status: "failed",
      error: { code: "command_aborted", sideEffectStatus: "uncertain" },
      evidence: { aborted: true, terminationStatus: "confirmed" },
    });
    await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
  }, 60_000);

  it("rejects disappearance of the exact container immediately before launch", async () => {
    const projectRoot = await createPreparedProject();
    const sandbox = createProductionCommandSandbox("container", projectRoot);
    const prepared = await sandbox.prepare({
      executable: "/usr/local/bin/node",
      args: ["-e", 'process.stdout.write("MUST_NOT_RUN")'],
      cwd: projectRoot,
      projectRoot,
      protectedPaths: [join(projectRoot, ".flow")],
    });
    const containerId = prepared.launch.args.at(-1);
    if (containerId === undefined || !/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error("container drift gate did not receive a full container ID");
    }
    const apiVersion = await readPreparedApiVersion(projectRoot);
    const api = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion,
    });
    await api.removeContainer(containerId);

    try {
      await expect(prepared.beforeLaunch?.()).rejects.toThrow(
        "Container command sandbox inspection failed during validate command container before launch",
      );
    } finally {
      await prepared.release();
    }
    await expect(readIntentRecords(projectRoot)).resolves.toEqual([]);
  }, 60_000);
});

async function execute(projectRoot: string, script: string, timeoutMs: number) {
  const executor = new CommandNodeExecutor({
    sandbox: createProductionCommandSandbox("container", projectRoot),
  });
  return executor.execute(commandNode(script, timeoutMs), context(projectRoot));
}

function commandNode(script: string, timeoutMs: number): CompiledCommandNode {
  return {
    id: "container-runtime",
    type: "command",
    dependsOn: [],
    command: {
      executable: "/usr/local/bin/node",
      args: ["-e", script],
      timeoutMs,
    },
  };
}

function context(projectRoot: string): NodeExecutionContext {
  return {
    runId: "container-command-runtime",
    workflowId: "container-command-runtime",
    attempt: 1,
    cwd: projectRoot,
    projectRoot,
    protectedPaths: [join(projectRoot, ".flow")],
  };
}

async function createPreparedProject(): Promise<string> {
  const source = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (source === undefined) {
    throw new Error("container command runtime gate requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const projectRoot = await mkdtemp(join(tmpdir(), "flow-container-command-runtime-"));
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

async function readIntentRecords(projectRoot: string): Promise<readonly string[]> {
  const directory = join(projectRoot, ".flow", "container-command-intents");
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readPreparedApiVersion(projectRoot: string): Promise<string> {
  const attestation = JSON.parse(
    await readFile(
      join(projectRoot, ".flow", "runtime", "prime-agent", "oci-attestation.json"),
      "utf8",
    ),
  ) as { readonly local?: { readonly apiVersion?: unknown } };
  const apiVersion = attestation.local?.apiVersion;
  if (typeof apiVersion !== "string" || !/^\d+\.\d+$/.test(apiVersion)) {
    throw new Error("container drift gate attestation has no Docker API version");
  }
  return apiVersion;
}

async function waitForRuntimeFile(path: string, operationSettled: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (operationSettled()) {
      throw new Error("container command settled before its launch marker was written");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("container command did not write its launch marker before the test deadline");
}
