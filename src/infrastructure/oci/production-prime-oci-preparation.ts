import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  access,
  chmod,
  chown,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { loadEffectiveFlowConfig } from "../fs/flow-config-store.js";
import { LocalPrimeImageBuilder, runLocalDockerCommand } from "./local-prime-image-builder.js";
import {
  assertPrimeOciSocketPolicy,
  LocalPrimeOciAttestationStore,
  type PrimeOciLocalRuntimeAttestation,
  publishLocalPrimeOciAttestation,
} from "./local-prime-oci-attestation.js";
import { LocalPrimeOciRuntimeInspector } from "./local-prime-oci-runtime-inspector.js";
import {
  PrimeOciPreparationError,
  type PrimeOciPreparationResult,
  preparePrimeOciRuntime,
} from "./prime-oci-preparation.js";
import { resolveDockerManagedRuntimeExecutables } from "./prime-oci-runtime-executables.js";

const DOCKER_SOCKET = "/var/run/docker.sock" as const;
const MAX_EXECUTABLE_BYTES = 268_435_456;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const PREPARATION_CLEANUP_MS = 30_000;
const MAX_ATTESTATION_BYTES = 1_048_576;
const dockerVersionSchema = z
  .object({
    Server: z.object({ ApiVersion: z.string().regex(/^\d+\.\d+$/) }).passthrough(),
  })
  .passthrough();
const dockerInfoSchema = z
  .object({
    ID: z.string().min(1).max(256),
    DockerRootDir: z.string().min(1).max(4_095),
    OSType: z.literal("linux"),
    Architecture: z.enum(["amd64", "x86_64"]),
    DefaultRuntime: z.literal("runc"),
    Runtimes: z.record(
      z.string().min(1).max(128),
      z
        .object({
          path: z.string().min(1).max(4_095),
          runtimeArgs: z.array(z.string().max(1_024)).max(0).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export async function prepareProductionPrimeOciRuntime(input: {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
}): Promise<PrimeOciPreparationResult> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new PrimeOciPreparationError(
      "inspection_failed",
      "Prime OCI runtime preparation requires Linux on x64",
    );
  }
  throwIfAborted(input.signal);
  const configuration = await loadEffectiveFlowConfig({ cwd: input.cwd });
  if (configuration.projectRoot === null) {
    throw new PrimeOciPreparationError(
      "inspection_failed",
      "Prime OCI runtime preparation requires a configured Flow project",
    );
  }
  const projectRoot = await realpath(configuration.projectRoot);
  const packageRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  const dockerExecutable = await resolveDockerExecutable();
  const dockerBuildxExecutable = await resolveDockerBuildxExecutable();
  const dockerExecutableSha256 = await hashStableRegularFile(
    dockerExecutable,
    MAX_EXECUTABLE_BYTES,
    "Docker executable",
  );
  const environmentRoot = await realpath(
    await mkdtemp(join(tmpdir(), "flow-prime-preparation-environment-")),
  );
  try {
    const run = (args: readonly string[]) =>
      runLocalDockerCommand(dockerExecutable, args, environmentRoot, input.signal);
    const runtimeInfo = parseJson(
      dockerInfoSchema,
      await run(["info", "--format", "{{json .}}"]),
      "Docker information",
    );
    const configuredRuncPath = runtimeInfo.Runtimes.runc?.path;
    if (configuredRuncPath === undefined || !configuredRuncPath.startsWith("/")) {
      throw new Error("Prime OCI runc runtime must use one absolute executable path");
    }
    const runcExecutable = await resolveConfiguredExecutable(configuredRuncPath, "runc");
    const runtimeExecutables = await resolveDockerManagedRuntimeExecutables();
    const containerdExecutable = runtimeExecutables.containerd;
    const dockerdExecutable = runtimeExecutables.dockerd;
    const dockerdExecutableSha256 = await hashStableRegularFile(
      dockerdExecutable,
      MAX_EXECUTABLE_BYTES,
      "dockerd executable",
    );
    const containerdExecutableSha256 = await hashStableRegularFile(
      containerdExecutable,
      MAX_EXECUTABLE_BYTES,
      "containerd executable",
    );
    const runcExecutableSha256 = await hashStableRegularFile(
      runcExecutable,
      MAX_EXECUTABLE_BYTES,
      "runc executable",
    );
    const descriptorPath = join(
      projectRoot,
      ".flow",
      "runtime",
      "prime-agent",
      "oci-attestation.json",
    );
    const preparationRoot = join(dirname(descriptorPath), "preparation");
    await mkdir(preparationRoot, { recursive: true, mode: 0o700 });
    await chmod(preparationRoot, 0o700);
    const retainedImageId = await readExistingImageId(descriptorPath);
    const builder = new LocalPrimeImageBuilder({
      packageRoot,
      dockerExecutable,
      dockerBuildxExecutable,
      temporaryRoot: await realpath(preparationRoot),
      ...(retainedImageId === undefined ? {} : { retainedImageId }),
      run: (args, options) =>
        runLocalDockerCommand(dockerExecutable, args, options.environmentRoot, options.signal),
      cleanupRun: (args, options) =>
        runLocalDockerCommand(
          dockerExecutable,
          args,
          options.environmentRoot,
          AbortSignal.timeout(PREPARATION_CLEANUP_MS),
          PREPARATION_CLEANUP_MS,
        ),
    });
    const inspector = new LocalPrimeOciRuntimeInspector({
      run,
      local: () =>
        observeLocalRuntime({
          packageRoot,
          projectRoot,
          dockerExecutable,
          dockerExecutableSha256,
          dockerdExecutable,
          dockerdExecutableSha256,
          containerdExecutable,
          containerdExecutableSha256,
          runcExecutable,
          runcExecutableSha256,
          run,
          signal: input.signal,
        }),
      dockerExecutableSha256,
      dockerdExecutableSha256,
      containerdExecutableSha256,
      runcExecutableSha256,
    });
    let result: PrimeOciPreparationResult;
    try {
      result = await preparePrimeOciRuntime(
        { descriptorPath, ...(input.signal === undefined ? {} : { signal: input.signal }) },
        {
          build: (buildNumber) => builder.build(buildNumber, input.signal),
          inspectRuntime: () => inspector.inspect(),
          publish: publishLocalPrimeOciAttestation,
        },
      );
    } catch (error) {
      const visibleImageId = await readExistingImageId(descriptorPath).catch(() => undefined);
      await builder.retireCreatedImagesExcept(visibleImageId);
      throw error;
    }
    await builder.retireCreatedImagesExcept(result.imageId);
    await new LocalPrimeOciAttestationStore({ descriptorPath }).read();
    return result;
  } finally {
    await rm(environmentRoot, { recursive: true, force: true });
  }
}

async function readExistingImageId(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_ATTESTATION_BYTES) {
      throw new Error("Prime OCI existing attestation is not one bounded regular file");
    }
    const parsed = z
      .object({ image: z.object({ id: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(await handle.readFile("utf8")));
    return parsed.image.id;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function observeLocalRuntime(input: {
  readonly packageRoot: string;
  readonly projectRoot: string;
  readonly dockerExecutable: string;
  readonly dockerExecutableSha256: string;
  readonly dockerdExecutable: string;
  readonly dockerdExecutableSha256: string;
  readonly containerdExecutable: string;
  readonly containerdExecutableSha256: string;
  readonly runcExecutable: string;
  readonly runcExecutableSha256: string;
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly signal: AbortSignal | undefined;
}): Promise<PrimeOciLocalRuntimeAttestation> {
  throwIfAborted(input.signal);
  const [versionSource, infoSource, socketMetadata, corePattern, cgroupSource, seccompSource] =
    await Promise.all([
      input.run(["version", "--format", "{{json .}}"]),
      input.run(["info", "--format", "{{json .}}"]),
      lstat(DOCKER_SOCKET, { bigint: true }),
      readBoundedText("/proc/sys/kernel/core_pattern", 4_096, "host core pattern"),
      readBoundedText("/proc/self/cgroup", 65_536, "host cgroup membership"),
      readBoundedText(
        join(input.packageRoot, "prime-container", "seccomp.json"),
        1_048_576,
        "Prime seccomp profile",
      ),
    ]);
  if (!socketMetadata.isSocket()) {
    throw new Error("Prime OCI Docker endpoint is not a Unix socket");
  }
  const version = parseJson(dockerVersionSchema, versionSource, "Docker version");
  const info = parseJson(dockerInfoSchema, infoSource, "Docker information");
  const cgroupPath = await resolveCurrentCgroup(cgroupSource);
  const socket = Object.freeze({
    device: safeNumber(socketMetadata.dev, "Docker socket device"),
    inode: safeNumber(socketMetadata.ino, "Docker socket inode"),
    uid: safeNumber(socketMetadata.uid, "Docker socket user"),
    gid: safeNumber(socketMetadata.gid, "Docker socket group"),
    mode: Number(socketMetadata.mode & 0o777n),
  });
  assertPrimeOciSocketPolicy(socket);
  const globalLeasePath = await prepareGlobalLeaseDirectory(info.ID, socket.gid);
  const imageDevice = await resolvePrimeImageDevice(info.DockerRootDir);
  let seccompProfile: Readonly<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(seccompSource) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    seccompProfile = parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error("Prime seccomp profile is not one JSON object", { cause: error });
  }
  return Object.freeze({
    daemonId: info.ID,
    socketPath: DOCKER_SOCKET,
    socket,
    apiVersion: version.Server.ApiVersion,
    cgroupPath,
    corePattern: corePattern.trim(),
    globalLeasePath,
    imageDevice,
    executables: {
      docker: { path: input.dockerExecutable, sha256: input.dockerExecutableSha256 },
      dockerd: { path: input.dockerdExecutable, sha256: input.dockerdExecutableSha256 },
      containerd: {
        path: input.containerdExecutable,
        sha256: input.containerdExecutableSha256,
      },
      runc: { path: input.runcExecutable, sha256: input.runcExecutableSha256 },
    },
    leaseTarget: "flow-prime-global-v1",
    seccompProfile,
  });
}

async function resolveDockerExecutable(): Promise<string> {
  return resolveFixedExecutable(["/usr/bin/docker", "/usr/local/bin/docker"], "Docker");
}

async function resolveDockerBuildxExecutable(): Promise<string> {
  return resolveFixedExecutable(
    [
      "/usr/libexec/docker/cli-plugins/docker-buildx",
      "/usr/lib/docker/cli-plugins/docker-buildx",
      "/usr/local/lib/docker/cli-plugins/docker-buildx",
    ],
    "Docker Buildx",
  );
}

async function resolveFixedExecutable(
  candidates: readonly string[],
  label: string,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      await access(canonical, constants.X_OK);
      if ((await lstat(canonical)).isFile()) {
        return canonical;
      }
    } catch {}
  }
  throw new Error(`${label} executable is not available at a fixed system path`);
}

async function resolveConfiguredExecutable(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new Error(`${label} executable path is not canonical`);
  }
  await access(canonical, constants.X_OK);
  if (!(await lstat(canonical)).isFile()) {
    throw new Error(`${label} executable is not one regular file`);
  }
  return canonical;
}

async function prepareGlobalLeaseDirectory(daemonId: string, socketGid: number): Promise<string> {
  const getgroups = process.getgroups;
  const getgid = process.getgid;
  const getuid = process.getuid;
  if (getgroups === undefined || getgid === undefined || getuid === undefined) {
    throw new Error("Prime OCI operator identity is unavailable on this host");
  }
  if (!getgroups().includes(socketGid) && getgid() !== socketGid) {
    throw new Error("Prime OCI operator is not a member of the Docker socket group");
  }
  const directory = `/var/tmp/flow-prime-${sha256(daemonId).slice(0, 32)}`;
  await mkdir(directory, { recursive: true, mode: 0o2770 });
  const metadata = await lstat(directory, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Prime OCI global lease root is not one direct directory");
  }
  const repairs = globalLeaseDirectoryRepairs(
    {
      gid: safeNumber(metadata.gid, "Prime global lease group"),
      mode: Number(metadata.mode & 0o7777n),
    },
    socketGid,
  );
  if (repairs.group) {
    await chown(directory, getuid(), socketGid);
  }
  if (repairs.mode) {
    await chmod(directory, 0o2770);
  }
  if ((await realpath(directory)) !== directory) {
    throw new Error("Prime OCI global lease root is not canonical");
  }
  const settled = await lstat(directory, { bigint: true });
  if (
    safeNumber(settled.gid, "Prime global lease group") !== socketGid ||
    Number(settled.mode & 0o7777n) !== 0o2770
  ) {
    throw new Error("Prime OCI global lease root has the wrong group or mode");
  }
  return join(directory, "global-slot.json");
}

export function globalLeaseDirectoryRepairs(
  input: { readonly gid: number; readonly mode: number },
  expectedGid: number,
): { readonly group: boolean; readonly mode: boolean } {
  return Object.freeze({
    group: input.gid !== expectedGid,
    mode: input.mode !== 0o2770,
  });
}

async function resolveCurrentCgroup(source: string): Promise<string> {
  const matches = source
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("0::"));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("Prime OCI host does not expose one cgroup version two membership");
  }
  const member = matches[0].slice(3);
  if (!member.startsWith("/") || member.includes("..")) {
    throw new Error("Prime OCI cgroup membership is invalid");
  }
  const path = resolve("/sys/fs/cgroup", `.${member}`);
  if ((await realpath(path)) !== path) {
    throw new Error("Prime OCI cgroup membership path is not canonical");
  }
  return path;
}

export async function resolvePrimeImageDevice(dockerRoot: string) {
  const canonicalRoot = await realpath(dockerRoot);
  const metadata = await lstat(canonicalRoot, { bigint: true });
  const { major, minor } = decodeLinuxDevice(metadata.dev);
  const devicePath = await realpath(`/dev/block/${major}:${minor}`);
  if (!(await lstat(devicePath)).isBlockDevice()) {
    throw new Error("Prime OCI image backing path is not one block device");
  }
  return Object.freeze({ path: devicePath, major, minor });
}

function decodeLinuxDevice(device: bigint): { readonly major: number; readonly minor: number } {
  const major = Number(((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n));
  const minor = Number((device & 0xffn) | ((device >> 12n) & 0xffffff00n));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error("Prime OCI image device identity exceeds the integer range");
  }
  return Object.freeze({ major, minor });
}

async function hashStableRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw new Error(`${label} is not one bounded regular file`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameFile(before, after, label);
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

async function readBoundedText(path: string, maxBytes: number, label: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function parseJson<Schema extends z.ZodType>(schema: Schema, source: string, label: string) {
  if (Buffer.byteLength(source, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  const parsed = schema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error(`${label} violates the closed schema`, { cause: parsed.error });
  }
  return parsed.data;
}

function assertSameFile(before: BigIntStats, after: BigIntStats, label: string): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.ctimeNs !== after.ctimeNs ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`${label} changed while read`);
  }
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} exceeds the supported integer range`);
  }
  return number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Prime OCI preparation was cancelled");
  }
}
