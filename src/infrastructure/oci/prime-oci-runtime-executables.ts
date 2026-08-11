import { constants } from "node:fs";
import { access, type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename } from "node:path";

const CONTAINERD_PID_PATHS = [
  "/run/docker/containerd/containerd.pid",
  "/var/run/docker/containerd/containerd.pid",
] as const;
const DOCKER_DAEMON_PID_PATHS = ["/run/docker.pid", "/var/run/docker.pid"] as const;
const DOCKER_DAEMON_CONFIGURATION_PATH = "/etc/docker/daemon.json";
const MAX_DOCKER_CONFIGURATION_BYTES = 1_048_576;
const MAX_PID_FILE_BYTES = 32;
const MAX_PROCESS_ARGUMENT_BYTES = 65_536;
const MAX_PROCESS_ARGUMENT_COUNT = 128;
const MAX_PROCESS_STAT_BYTES = 4_096;

export interface DockerManagedContainerdResolverOptions {
  readonly pidPaths?: readonly string[];
  readonly readPidRecord?: (path: string) => Promise<number>;
  readonly readDockerDaemonPid?: () => Promise<number>;
  readonly readDockerDaemonConfiguration?: () => Promise<Record<string, unknown> | null>;
  readonly readParentPid?: (pid: number) => Promise<number>;
  readonly resolveProcessExecutable?: (pid: number) => Promise<string>;
  readonly readProcessArguments?: (pid: number) => Promise<readonly string[]>;
}

export async function resolveDockerManagedContainerdExecutable(
  options: DockerManagedContainerdResolverOptions = {},
): Promise<string> {
  return (await resolveDockerManagedRuntimeExecutables(options)).containerd;
}

export async function resolveDockerManagedRuntimeExecutables(
  options: DockerManagedContainerdResolverOptions = {},
): Promise<{ readonly containerd: string; readonly dockerd: string }> {
  const readPidRecord = options.readPidRecord ?? readContainerdPid;
  const readDockerDaemonPid =
    options.readDockerDaemonPid ?? (() => readFirstPidRecord(DOCKER_DAEMON_PID_PATHS));
  const readDockerDaemonConfiguration =
    options.readDockerDaemonConfiguration ?? readDefaultDockerDaemonConfiguration;
  const readParentPid = options.readParentPid ?? readProcessParentPid;
  const resolveProcessExecutable = options.resolveProcessExecutable ?? resolveExecutableForProcess;
  const readProcessArguments = options.readProcessArguments ?? readProcessArgumentsFromProc;
  let lastError: unknown;
  for (const pidPath of options.pidPaths ?? CONTAINERD_PID_PATHS) {
    try {
      const pid = await readPidRecord(pidPath);
      const parentPid = await readParentPid(pid);
      const [executable, parentExecutable, parentArguments, dockerDaemonPid, daemonConfiguration] =
        await Promise.all([
          resolveProcessExecutable(pid),
          resolveProcessExecutable(parentPid),
          readProcessArguments(parentPid),
          readDockerDaemonPid(),
          readDockerDaemonConfiguration(),
        ]);
      if (parentPid !== dockerDaemonPid) {
        throw new Error(
          "Docker-managed containerd parent differs from the canonical Docker daemon",
        );
      }
      if (basename(parentExecutable) !== "dockerd") {
        throw new Error("Docker-managed containerd parent is not dockerd");
      }
      assertFixedDockerDaemonArguments(parentArguments);
      assertFixedDockerDaemonConfiguration(daemonConfiguration);
      return Object.freeze({ containerd: executable, dockerd: parentExecutable });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Docker-managed containerd executable cannot be resolved", {
    cause: lastError,
  });
}

async function readFirstPidRecord(paths: readonly string[]): Promise<number> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return await readContainerdPid(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Docker daemon PID record cannot be resolved", { cause: lastError });
}

async function resolveExecutableForProcess(pid: number): Promise<string> {
  const executable = await realpath(`/proc/${pid}/exe`);
  await access(executable, constants.X_OK);
  if (!(await lstat(executable)).isFile()) {
    throw new Error("Prime OCI runtime executable is not one regular file");
  }
  return executable;
}

async function readContainerdPid(path: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PID_FILE_BYTES) {
      throw new Error("Docker containerd PID record is not one bounded regular file");
    }
    const source = await handle.readFile("utf8");
    if (!/^[1-9]\d*\n?$/.test(source)) {
      throw new Error("Docker containerd PID record is invalid");
    }
    const pid = Number.parseInt(source, 10);
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("Docker containerd PID is outside the supported range");
    }
    return pid;
  } finally {
    await handle.close();
  }
}

async function readProcessParentPid(pid: number): Promise<number> {
  const source = await readBoundedProcessFile(`/proc/${pid}/stat`, MAX_PROCESS_STAT_BYTES);
  const commandEnd = source.lastIndexOf(")");
  const match = commandEnd < 0 ? null : /^ [A-Za-z] ([1-9]\d*) /.exec(source.slice(commandEnd + 1));
  const parentPid = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    throw new Error("Docker-managed containerd parent process is invalid");
  }
  return parentPid;
}

async function readProcessArgumentsFromProc(pid: number): Promise<readonly string[]> {
  const source = await readBoundedProcessFile(`/proc/${pid}/cmdline`, MAX_PROCESS_ARGUMENT_BYTES);
  if (!source.endsWith("\0")) {
    throw new Error("Docker daemon command line is not terminated");
  }
  const arguments_ = source.slice(0, -1).split("\0");
  if (
    arguments_.length < 1 ||
    arguments_.length > MAX_PROCESS_ARGUMENT_COUNT ||
    arguments_.some((argument) => argument.length > 4_095)
  ) {
    throw new Error("Docker daemon command line exceeds its bound");
  }
  return Object.freeze(arguments_);
}

async function readBoundedProcessFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    const result = await handle.read(bytes, 0, bytes.byteLength, null);
    if (result.bytesRead < 1 || result.bytesRead > maxBytes) {
      throw new Error("Prime OCI process observation exceeds its byte limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}

function assertFixedDockerDaemonArguments(arguments_: readonly string[]): void {
  const forbiddenOptions = [
    "--config-file",
    "--containerd",
    "--containerd-namespace",
    "--containerd-plugins-namespace",
    "--exec-root",
    "--pidfile",
  ];
  const hostValues: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      throw new Error("Docker daemon command line is incomplete");
    }
    if (
      forbiddenOptions.some((option) => argument === option || argument.startsWith(`${option}=`))
    ) {
      throw new Error("Docker daemon changes one fixed authority option");
    }
    if (argument === "--host" || argument === "-H") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("Docker daemon host option is incomplete");
      }
      hostValues.push(value);
      index += 1;
    } else if (argument.startsWith("--host=")) {
      hostValues.push(argument.slice("--host=".length));
    } else if (argument.startsWith("-H=")) {
      hostValues.push(argument.slice("-H=".length));
    } else if (argument.startsWith("-H") && argument.length > 2) {
      hostValues.push(argument.slice(2));
    }
  }
  if (
    hostValues.length !== 1 ||
    hostValues.some((value) => value !== "unix:///var/run/docker.sock")
  ) {
    throw new Error("Docker daemon does not use the fixed API endpoint");
  }
}

async function readDefaultDockerDaemonConfiguration(): Promise<Record<string, unknown> | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      DOCKER_DAEMON_CONFIGURATION_PATH,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_DOCKER_CONFIGURATION_BYTES) {
      throw new Error("Docker daemon configuration is not one bounded regular file");
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Docker daemon configuration is not one JSON object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

function assertFixedDockerDaemonConfiguration(
  configuration: Readonly<Record<string, unknown>> | null,
): void {
  if (configuration === null) {
    return;
  }
  const forbiddenKeys = new Set([
    "containerd",
    "containerd-namespace",
    "containerd-plugins-namespace",
    "exec-root",
    "hosts",
    "pidfile",
  ]);
  if (Object.keys(configuration).some((key) => forbiddenKeys.has(key))) {
    throw new Error("Docker daemon configuration changes one fixed authority option");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
