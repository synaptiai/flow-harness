import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, chown, cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePrimeOciImageIdentity } from "../../src/domain/evaluation/external-harness.js";
import { LocalPrimeHostAdmissionProbe } from "../../src/infrastructure/oci/local-prime-host-admission-probe.js";
import {
  type PrimeHostAdmissionObservation,
  validatePrimeHostAdmission,
} from "../../src/infrastructure/oci/prime-host-admission.js";
import { primeExternalHarnessIdentity } from "../fixtures/evaluation/prime-external-harness-identity.js";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const workerPath = join(repositoryRoot, "test/fixtures/prime/global-admission-worker.mjs");
const linux = process.platform === "linux" && process.arch === "x64";
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

describe.skipIf(!linux)("Prime OCI daemon-global admission", () => {
  it("excludes independent processes and a second Docker-authorized user", async () => {
    const secondUser = process.env.FLOW_PRIME_TEST_SECOND_USER;
    if (secondUser === undefined || !/^[a-z_][a-z0-9_-]{0,31}$/.test(secondUser)) {
      throw new Error("Prime admission gate requires FLOW_PRIME_TEST_SECOND_USER");
    }
    const image = readVerifiedImage();
    const root = await mkdtemp(join(tmpdir(), "flow-prime-admission-runtime-"));
    temporaryDirectories.push(root);
    const socket = await lstat("/var/run/docker.sock");
    await chown(root, process.getuid?.() ?? socket.uid, socket.gid);
    await chmod(root, 0o2770);
    const leasePath = join(root, "global-slot.json");
    const readyPath = join(root, "holder.ready");
    const releasePath = join(root, "holder.release");
    const configPath = join(root, "config.json");
    const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
    const environment = dockerEnvironment(root);
    const peerWorkerPath = await stageAdmissionWorker(root);
    const [daemonId, apiVersion] = await Promise.all([
      executeFile(docker, ["info", "--format", "{{.ID}}"], {
        encoding: "utf8",
        env: environment,
      }).then((value) => value.stdout.trim()),
      executeFile(docker, ["version", "--format", "{{.Server.APIVersion}}"], {
        encoding: "utf8",
        env: environment,
      }).then((value) => value.stdout.trim()),
    ]);
    const identity = { ...primeExternalHarnessIdentity(), image };
    await writeFile(
      configPath,
      `${JSON.stringify({ identity, daemonId, apiVersion, leasePath })}\n`,
      { mode: 0o640 },
    );
    await chown(configPath, process.getuid?.() ?? socket.uid, socket.gid);

    const holder = startWorker([configPath, "hold", readyPath, releasePath]);
    childProcesses.push(holder);
    await waitForFile(readyPath);

    const sameUser = await runWorker([configPath, "attempt"]);
    expect(sameUser.code).not.toBe(0);
    expect(sameUser.stderr).toMatch(/global slot|durable owner|unresolved/i);

    const crossUser = await run(
      "/usr/bin/sudo",
      ["-n", "-u", secondUser, "--", process.execPath, peerWorkerPath, configPath, "attempt"],
      environment,
    );
    expect(crossUser.code).not.toBe(0);
    expect(crossUser.stderr).toMatch(/global slot|durable owner|unresolved/i);

    await writeFile(releasePath, "release\n", { mode: 0o660 });
    const holderExit = await waitForExit(holder);
    expect(holderExit).toEqual({ code: 0, signal: null });
  }, 120_000);

  it.each(["crash-intent", "crash-create", "crash-owned"] as const)(
    "recovers the durable global slot after %s",
    async (mode) => {
      const fixture = await createAdmissionFixture();
      const crashed = await runWorker([fixture.configPath, mode]);
      expect(crashed).toMatchObject({ code: null, signal: "SIGKILL" });

      const recovered = await runWorker([fixture.configPath, "recover"]);
      expect(recovered).toMatchObject({ code: 0, signal: null });
      await expect(lstat(fixture.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const inspection = await run(
        fixture.docker,
        ["inspect", "flow-prime-global-v1"],
        fixture.environment,
      );
      expect(inspection.code).not.toBe(0);
    },
    120_000,
  );
});

describe("Prime host headroom intersection", () => {
  it("accepts each exact threshold and rejects each one-under value", () => {
    const policy = primeExternalHarnessIdentity().runtime.policy;
    const base = headroomObservation();
    expect(() => validatePrimeHostAdmission(base, policy)).not.toThrow();

    const cases: readonly [string, (value: ReturnType<typeof headroomObservation>) => void][] = [
      ["host memory", (value) => (value.hostMemoryAvailableBytes -= 1)],
      ["ancestor memory", decrementAncestorMemory],
      ["host PID", (value) => (value.hostPidLimit -= 1)],
      ["ancestor PID", decrementAncestorPid],
      ["online CPU", (value) => (value.onlineCpuCount -= 1)],
      ["CPU set", (value) => (value.cpusetCpuCount -= 1)],
      ["ancestor CPU", decrementAncestorCpu],
      ["latency", (value) => (value.probeLatenciesMs[15] = policy.maxDaemonProbeLatencyMs + 1)],
    ];
    for (const [name, mutate] of cases) {
      const changed = structuredClone(base);
      mutate(changed);
      expect(() => validatePrimeHostAdmission(changed, policy), name).toThrow(
        /Prime (?:host|image)|latency/i,
      );
    }
  });

  it("terminates after three consecutive slow runtime probes", async () => {
    const policy = primeExternalHarnessIdentity().runtime.policy;
    const measure = vi.fn(async () => policy.maxDaemonProbeLatencyMs + 1);
    const probe = new LocalPrimeHostAdmissionProbe({
      measureDaemonLatency: measure,
      waitForRuntimeProbe: async () => undefined,
    });

    await expect(probe.monitorRuntime({ cgroupPath: "/sys/fs/cgroup" }, policy)).rejects.toThrow(
      /three times/i,
    );
    expect(measure).toHaveBeenCalledTimes(3);
  });
});

async function stageAdmissionWorker(root: string): Promise<string> {
  const stagedWorkerPath = join(root, "test/fixtures/prime/global-admission-worker.mjs");
  await mkdir(dirname(stagedWorkerPath), { recursive: true });
  await Promise.all([
    cp(workerPath, stagedWorkerPath),
    cp(join(repositoryRoot, "dist"), join(root, "dist"), { recursive: true }),
    writeFile(join(root, "package.json"), '{"type":"module"}\n', { mode: 0o640 }),
  ]);
  return stagedWorkerPath;
}

function headroomObservation(): PrimeHostAdmissionObservation {
  const policy = primeExternalHarnessIdentity().runtime.policy;
  return {
    hostMemoryAvailableBytes: policy.minMemoryHeadroomBytes,
    memoryAncestors: [{ maxBytes: policy.minMemoryHeadroomBytes, currentBytes: 0 }],
    hostPidLimit: policy.minPidHeadroom,
    hostPidCurrent: 0,
    pidAncestors: [{ max: policy.minPidHeadroom, current: 0 }],
    onlineCpuCount: policy.minCpuCapacity,
    cpusetCpuCount: policy.minCpuCapacity,
    cpuAncestors: [{ quotaMicros: policy.minCpuCapacity * 100_000, periodMicros: 100_000 }],
    controllers: ["cpu", "io", "memory", "pids"] as ("cpu" | "io" | "memory" | "pids")[],
    probeLatenciesMs: Array.from(
      { length: policy.preflightDaemonProbeCount },
      () => policy.maxDaemonProbeLatencyMs,
    ),
  };
}

function decrementAncestorMemory(value: PrimeHostAdmissionObservation): void {
  const ancestor = value.memoryAncestors[0];
  if (ancestor === undefined || ancestor.maxBytes === null) {
    throw new Error("Prime memory ancestor fixture is invalid");
  }
  ancestor.maxBytes -= 1;
}

function decrementAncestorPid(value: PrimeHostAdmissionObservation): void {
  const ancestor = value.pidAncestors[0];
  if (ancestor === undefined || ancestor.max === null) {
    throw new Error("Prime PID ancestor fixture is invalid");
  }
  ancestor.max -= 1;
}

function decrementAncestorCpu(value: PrimeHostAdmissionObservation): void {
  const ancestor = value.cpuAncestors[0];
  if (ancestor === undefined || ancestor.quotaMicros === null) {
    throw new Error("Prime CPU ancestor fixture is invalid");
  }
  ancestor.quotaMicros -= 1;
}

function readVerifiedImage() {
  const path = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (path === undefined) {
    throw new Error("Prime admission gate requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    readonly image?: unknown;
  };
  if (value.image === undefined) {
    throw new Error("Prime admission gate received an invalid image result");
  }
  return parsePrimeOciImageIdentity(value.image);
}

function dockerEnvironment(root: string) {
  return {
    HOME: root,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: root,
  };
}

async function createAdmissionFixture() {
  const image = readVerifiedImage();
  const root = await mkdtemp(join(tmpdir(), "flow-prime-admission-recovery-"));
  temporaryDirectories.push(root);
  const socket = await lstat("/var/run/docker.sock");
  const leasePath = join(root, "global-slot.json");
  const configPath = join(root, "config.json");
  const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const environment = dockerEnvironment(root);
  const [daemonId, apiVersion] = await Promise.all([
    executeFile(docker, ["info", "--format", "{{.ID}}"], {
      encoding: "utf8",
      env: environment,
    }).then((value) => value.stdout.trim()),
    executeFile(docker, ["version", "--format", "{{.Server.APIVersion}}"], {
      encoding: "utf8",
      env: environment,
    }).then((value) => value.stdout.trim()),
  ]);
  const identity = { ...primeExternalHarnessIdentity(), image };
  await writeFile(
    configPath,
    `${JSON.stringify({ identity, daemonId, apiVersion, leasePath })}\n`,
    { mode: 0o640 },
  );
  await chown(configPath, process.getuid?.() ?? socket.uid, socket.gid);
  return { apiVersion, configPath, docker, environment, leasePath, root };
}

function startWorker(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [workerPath, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function runWorker(args: readonly string[]) {
  return await run(process.execPath, [workerPath, ...args], process.env);
}

async function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }>((resolveRun, rejectRun) => {
    const errors: Buffer[] = [];
    const child = spawn(command, [...args], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) =>
      resolveRun({ code, signal, stderr: Buffer.concat(errors).toString("utf8") }),
    );
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Prime admission holder did not publish readiness");
}

async function waitForExit(child: ChildProcess) {
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}
