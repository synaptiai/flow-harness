import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { PrimeOciAttachedTransport } from "../../../src/infrastructure/oci/attached-prime-oci-operator.js";
import { resolvePrimeImageDevice } from "../../../src/infrastructure/oci/production-prime-oci-preparation.js";
import { primeExternalHarnessIdentity } from "../evaluation/prime-external-harness-identity.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const executeFile = promisify(execFile);

export interface VerifiedPrimeContainerTransport extends PrimeOciAttachedTransport {
  readonly containerId: string;
  readonly containerName: string;
  forceRemove(): Promise<void>;
}

export interface VerifiedPrimeContainerOptions {
  readonly dockerExecutable?: string;
  readonly imageDevicePath?: string;
  readonly seccompPath?: string;
  readonly temporaryRoot?: string;
}

export async function startVerifiedPrimeContainer(
  imageId: string,
  options: VerifiedPrimeContainerOptions = {},
): Promise<VerifiedPrimeContainerTransport> {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error("verified Prime container requires one full image ID");
  }
  const docker =
    options.dockerExecutable ?? process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const seccompPath =
    options.seccompPath ?? join(repositoryRoot, "prime-container", "seccomp.json");
  const operationRoot = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), "flow-prime-runtime-container-"),
  );
  const cidPath = join(operationRoot, "container.id");
  const containerName = `flow-prime-runtime-${randomUUID().replaceAll("-", "")}`;
  const environment = {
    HOME: operationRoot,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: operationRoot,
  };
  let imageDevicePath: string;
  try {
    imageDevicePath =
      options.imageDevicePath ?? (await resolveDockerImageDevicePath(docker, environment));
    if (!/^\/dev\/[a-zA-Z0-9._/-]+$/.test(imageDevicePath)) {
      throw new Error("verified Prime container received an invalid image device path");
    }
  } catch (error) {
    await rm(operationRoot, { recursive: true, force: true });
    throw error;
  }
  const policy = primeExternalHarnessIdentity().runtime.policy;
  const child = spawn(
    docker,
    [
      "run",
      "--rm",
      "--interactive",
      "--pull=never",
      "--platform=linux/amd64",
      `--name=${containerName}`,
      `--cidfile=${cidPath}`,
      "--user=0:10003",
      "--network=none",
      "--ipc=none",
      "--read-only",
      "--log-driver=none",
      "--no-healthcheck",
      "--pids-limit=64",
      "--memory=2147483648",
      "--memory-swap=2147483648",
      "--cpu-period=100000",
      "--cpu-quota=200000",
      `--device-read-bps=${imageDevicePath}:${String(policy.imageReadBytesPerSecond)}`,
      `--device-read-iops=${imageDevicePath}:${String(policy.imageReadOperationsPerSecond)}`,
      "--cap-drop=ALL",
      "--cap-add=CHOWN",
      "--cap-add=DAC_READ_SEARCH",
      "--cap-add=FOWNER",
      "--cap-add=KILL",
      "--cap-add=SETGID",
      "--cap-add=SETUID",
      "--security-opt=no-new-privileges",
      `--security-opt=seccomp=${seccompPath}`,
      "--ulimit=nofile=256:256",
      "--ulimit=nproc=64:64",
      "--ulimit=fsize=268435456:268435456",
      "--ulimit=core=0:0",
      "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=536870912,nr_inodes=8192,mode=0710",
      "--tmpfs=/run/flow-node:rw,nosuid,nodev,noexec,size=16777216,nr_inodes=256,mode=0700",
      "--tmpfs=/run/flow-supervisor:rw,nosuid,nodev,noexec,size=16777216,nr_inodes=256,mode=0700",
      imageId,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: environment },
  );
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  let containerId: string;
  try {
    containerId = await waitForContainerId(cidPath, child, errors);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited.catch(() => undefined);
    await rm(operationRoot, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    const code = await exited;
    await rm(operationRoot, { recursive: true, force: true });
    if (code !== 0) {
      throw new Error(
        `verified Prime container exited with ${String(code)}: ${Buffer.concat(errors).toString("utf8")}`,
      );
    }
  };
  return {
    containerId,
    containerName,
    output: child.stdout,
    write: async (bytes, signal) => {
      throwIfAborted(signal);
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(Buffer.from(bytes), (error) => {
          if (error === null || error === undefined) {
            resolveWrite();
          } else {
            rejectWrite(error);
          }
        });
      });
    },
    closeInput: async () => {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    },
    release,
    forceRemove: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const cleanup = spawn(docker, ["rm", "--force", containerName], {
          stdio: "ignore",
          env: environment,
        });
        await new Promise<void>((resolveCleanup) => {
          cleanup.once("error", () => resolveCleanup());
          cleanup.once("exit", () => resolveCleanup());
        });
      }
      await exited.catch(() => undefined);
      await rm(operationRoot, { recursive: true, force: true });
      released = true;
    },
  };
}

async function resolveDockerImageDevicePath(
  dockerExecutable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await executeFile(dockerExecutable, ["info", "--format={{.DockerRootDir}}"], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 4_096,
    timeout: 10_000,
  });
  const dockerRoot = stdout.trim();
  if (!dockerRoot.startsWith("/") || Buffer.byteLength(dockerRoot, "utf8") > 4_095) {
    throw new Error("Docker returned an invalid storage root");
  }
  return (await resolvePrimeImageDevice(dockerRoot)).path;
}

async function waitForContainerId(
  path: string,
  child: { readonly exitCode: number | null; readonly signalCode: NodeJS.Signals | null },
  errors: readonly Buffer[],
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error("Docker CID file contains an invalid full container ID");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `verified Prime container exited before CID publication: ${Buffer.concat(errors).toString("utf8")}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Docker did not publish the Prime container ID within 10000ms");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Prime test aborted");
  }
}
