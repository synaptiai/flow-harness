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
import {
  LocalPrimeImageBuilder,
  PrimeImageBuildStageError,
  runLocalDockerCommand,
} from "./local-prime-image-builder.js";
import {
  assertPrimeOciSocketPolicy,
  LocalPrimeOciAttestationStore,
  type PrimeOciLocalRuntimeAttestation,
  type PrimeOciSocketIdentity,
  publishLocalPrimeOciAttestation,
} from "./local-prime-oci-attestation.js";
import { LocalPrimeOciRuntimeInspector } from "./local-prime-oci-runtime-inspector.js";
import {
  primeDockerRuntimeMapSchema,
  selectedPrimeDockerRuntime,
} from "./prime-docker-runtime-metadata.js";
import { resolvePrimeImageDevice } from "./prime-oci-image-device.js";
import { PRIME_OCI_RUNTIME_NAME } from "./prime-oci-policy.js";
import {
  type PrimeOciInspectionStage,
  type PrimeOciPreparationDependencies,
  PrimeOciPreparationError,
  type PrimeOciPreparationResult,
  preparePrimeOciRuntime,
  settlePrimeOciInspectionStages,
  withPrimeOciInspectionStage,
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
    DefaultRuntime: z.literal(PRIME_OCI_RUNTIME_NAME),
    Runtimes: primeDockerRuntimeMapSchema,
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
  throwIfAborted(input.signal);
  if (configuration.projectRoot === null) {
    throw new PrimeOciPreparationError(
      "inspection_failed",
      "Prime OCI runtime preparation requires a configured Flow project",
    );
  }
  const projectRoot = await realpath(configuration.projectRoot);
  throwIfAborted(input.signal);
  const packageRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  throwIfAborted(input.signal);
  const { dockerBuildxExecutable, dockerExecutable } = await inspectPrimeOciBootstrapExecutables(
    input.signal,
  );
  const createdEnvironmentRoot = await mkdtemp(
    join(tmpdir(), "flow-prime-preparation-environment-"),
  );
  return runPrimePreparationWithCleanup(
    async () => {
      const environmentRoot = await realpath(createdEnvironmentRoot);
      throwIfAborted(input.signal);
      const run = (args: readonly string[]) =>
        runLocalDockerCommand(dockerExecutable, args, environmentRoot, input.signal);
      const runtimeInfo = await withPrimeOciInspectionStage(
        "decode Docker information response",
        async () =>
          parseJson(
            dockerInfoSchema,
            await withPrimeOciInspectionStage(
              "query Docker information",
              () => run(["info", "--format", "{{json .}}"]),
              input.signal,
            ),
            "Docker information",
          ),
        input.signal,
      );
      const runtimeExecutables = await inspectPrimeOciManagedRuntimeExecutables(
        () => inspectRuntimeExecutables(dockerExecutable, runtimeInfo),
        input.signal,
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
            dockerExecutable,
            run,
            signal: input.signal,
          }),
        expectedExecutables: runtimeExecutables,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const result = await runPrimePreparationWithCleanup(
        () =>
          preparePrimeOciRuntime(
            { descriptorPath, ...(input.signal === undefined ? {} : { signal: input.signal }) },
            createProductionPrimeOciPreparationDependencies({
              builder,
              inspector,
              signal: input.signal,
              publish: publishLocalPrimeOciAttestation,
            }),
          ),
        async (prepared, primaryError) => {
          await reconcilePrimePreparationImages({
            ...(prepared === undefined ? {} : { preparedImageId: prepared.imageId }),
            primaryError,
            readVisibleImageId: () => readExistingImageId(descriptorPath),
            retireExcept: (retainedImageId) => builder.retireCreatedImagesExcept(retainedImageId),
          });
        },
      );
      await new LocalPrimeOciAttestationStore({ descriptorPath }).read();
      return result;
    },
    () => rm(createdEnvironmentRoot, { recursive: true, force: true }),
  );
}

export function createProductionPrimeOciPreparationDependencies(input: {
  readonly builder: Pick<LocalPrimeImageBuilder, "build">;
  readonly inspector: Pick<LocalPrimeOciRuntimeInspector, "inspect">;
  readonly signal: AbortSignal | undefined;
  readonly publish: PrimeOciPreparationDependencies["publish"];
}): PrimeOciPreparationDependencies {
  return Object.freeze({
    build: (buildNumber: 1 | 2) => input.builder.build(buildNumber, input.signal),
    preflightRuntime: () => input.inspector.inspect(),
    inspectRuntime: () => input.inspector.inspect(),
    publish: input.publish,
  });
}

export async function runPrimePreparationWithCleanup<T>(
  operation: () => Promise<T>,
  cleanup: (result: T | undefined, primaryError: unknown | undefined) => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let primaryError: unknown;
  let operationCompleted = false;
  try {
    result = await operation();
    operationCompleted = true;
  } catch (error) {
    primaryError = error;
  }

  try {
    await cleanup(operationCompleted ? result : undefined, primaryError);
  } catch (cleanupError) {
    throw new PrimeImageBuildStageError(
      "clean build resources",
      new AggregateError(
        operationCompleted ? [cleanupError] : [primaryError, cleanupError],
        "Prime OCI preparation cleanup failed",
      ),
    );
  }
  if (!operationCompleted) {
    throw primaryError;
  }
  return result as T;
}

export async function reconcilePrimePreparationImages(input: {
  readonly preparedImageId?: string;
  readonly primaryError: unknown | undefined;
  readonly readVisibleImageId: () => Promise<string | undefined>;
  readonly retireExcept: (retainedImageId: string | undefined) => Promise<void>;
}): Promise<void> {
  const retainedImageId =
    input.primaryError === undefined && input.preparedImageId !== undefined
      ? input.preparedImageId
      : await input.readVisibleImageId();
  await input.retireExcept(retainedImageId);
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

export interface PrimeOciLocalRuntimeObservationInput {
  readonly packageRoot: string;
  readonly dockerExecutable: string;
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly signal: AbortSignal | undefined;
}

export interface PrimeOciLocalRuntimeObservationOperations {
  readonly readDockerVersion: (run: PrimeOciLocalRuntimeObservationInput["run"]) => Promise<string>;
  readonly readDockerInformation: (
    run: PrimeOciLocalRuntimeObservationInput["run"],
  ) => Promise<string>;
  readonly inspectDockerSocket: () => Promise<PrimeOciSocketIdentity>;
  readonly inspectHostCorePolicy: () => Promise<string>;
  readonly inspectHostCgroup: () => Promise<string>;
  readonly prepareGlobalLeaseRoot: (daemonId: string, socketGid: number) => Promise<string>;
  readonly inspectImageBackingDevice: (
    dockerRoot: string,
  ) => Promise<PrimeOciLocalRuntimeAttestation["imageDevice"]>;
  readonly inspectRuntimeExecutables: (
    dockerExecutable: string,
    runtimeInfo: z.output<typeof dockerInfoSchema>,
  ) => Promise<PrimeOciLocalRuntimeAttestation["executables"]>;
  readonly inspectSeccompPolicy: (
    packageRoot: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

const productionLocalRuntimeObservationOperations: PrimeOciLocalRuntimeObservationOperations =
  Object.freeze({
    readDockerVersion: (run: PrimeOciLocalRuntimeObservationInput["run"]) =>
      run(["version", "--format", "{{json .}}"]),
    readDockerInformation: (run: PrimeOciLocalRuntimeObservationInput["run"]) =>
      run(["info", "--format", "{{json .}}"]),
    inspectDockerSocket: inspectDockerSocket,
    inspectHostCorePolicy: () =>
      readBoundedText("/proc/sys/kernel/core_pattern", 4_096, "host core pattern"),
    inspectHostCgroup: async () =>
      resolveCurrentCgroup(
        await readBoundedText("/proc/self/cgroup", 65_536, "host cgroup membership"),
      ),
    prepareGlobalLeaseRoot: prepareGlobalLeaseDirectory,
    inspectImageBackingDevice: resolvePrimeImageDevice,
    inspectRuntimeExecutables: inspectRuntimeExecutables,
    inspectSeccompPolicy: inspectSeccompPolicy,
  });

export async function observeLocalRuntime(
  input: PrimeOciLocalRuntimeObservationInput,
  operations: PrimeOciLocalRuntimeObservationOperations = productionLocalRuntimeObservationOperations,
): Promise<PrimeOciLocalRuntimeAttestation> {
  throwIfAborted(input.signal);
  const inspectStage = <T>(stage: PrimeOciInspectionStage, operation: () => Promise<T>) =>
    withPrimeOciInspectionStage(stage, operation, input.signal);
  const [version, info, socket, corePattern, cgroupPath, seccompProfile] =
    await settlePrimeOciInspectionStages(
      [
        inspectStage("decode Docker version response", async () =>
          parseJson(
            dockerVersionSchema,
            await inspectStage("query Docker version", () =>
              operations.readDockerVersion(input.run),
            ),
            "Docker version",
          ),
        ),
        inspectStage("decode Docker information response", async () =>
          parseJson(
            dockerInfoSchema,
            await inspectStage("query Docker information", () =>
              operations.readDockerInformation(input.run),
            ),
            "Docker information",
          ),
        ),
        inspectStage("inspect Docker socket", () => operations.inspectDockerSocket()),
        inspectStage("inspect host core policy", () => operations.inspectHostCorePolicy()),
        inspectStage("inspect host cgroup", () => operations.inspectHostCgroup()),
        inspectStage("inspect seccomp policy", () =>
          operations.inspectSeccompPolicy(input.packageRoot),
        ),
      ],
      input.signal,
    );
  const [globalLeasePath, imageDevice, executables] = await settlePrimeOciInspectionStages(
    [
      inspectStage("prepare global lease root", () =>
        operations.prepareGlobalLeaseRoot(info.ID, socket.gid),
      ),
      inspectStage("inspect image backing device", () =>
        operations.inspectImageBackingDevice(info.DockerRootDir),
      ),
      inspectPrimeOciRuntimeExecutables(
        () => operations.inspectRuntimeExecutables(input.dockerExecutable, info),
        input.signal,
      ),
    ],
    input.signal,
  );
  return Object.freeze({
    daemonId: info.ID,
    socketPath: DOCKER_SOCKET,
    socket,
    apiVersion: version.Server.ApiVersion,
    cgroupPath,
    corePattern: corePattern.trim(),
    globalLeasePath,
    imageDevice,
    executables,
    leaseTarget: "flow-prime-global-v1",
    seccompProfile,
  });
}

export async function inspectPrimeOciRuntimeExecutables<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withPrimeOciInspectionStage("inspect runtime executables", operation, signal);
}

export async function inspectPrimeOciBootstrapExecutables(
  signal?: AbortSignal,
  operation: () => Promise<{
    readonly dockerBuildxExecutable: string;
    readonly dockerExecutable: string;
  }> = async () => {
    const resolvedDocker = await resolveDockerExecutable();
    return Object.freeze({
      dockerExecutable: resolvedDocker,
      dockerBuildxExecutable: await resolveDockerBuildxExecutable(),
    });
  },
) {
  return inspectPrimeOciRuntimeExecutables(operation, signal);
}

export async function inspectPrimeOciManagedRuntimeExecutables<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return inspectPrimeOciRuntimeExecutables(operation, signal);
}

async function inspectDockerSocket(): Promise<PrimeOciSocketIdentity> {
  const socketMetadata = await lstat(DOCKER_SOCKET, { bigint: true });
  if (!socketMetadata.isSocket()) {
    throw new Error("Prime OCI Docker endpoint is not a Unix socket");
  }
  const observed = Object.freeze({
    device: safeNumber(socketMetadata.dev, "Docker socket device"),
    inode: safeNumber(socketMetadata.ino, "Docker socket inode"),
    uid: safeNumber(socketMetadata.uid, "Docker socket user"),
    gid: safeNumber(socketMetadata.gid, "Docker socket group"),
    mode: Number(socketMetadata.mode & 0o777n),
  });
  assertPrimeOciSocketPolicy(observed);
  return observed;
}

async function inspectSeccompPolicy(
  packageRoot: string,
): Promise<Readonly<Record<string, unknown>>> {
  const source = await readBoundedText(
    join(packageRoot, "prime-container", "seccomp.json"),
    1_048_576,
    "Prime seccomp profile",
  );
  try {
    const parsed = JSON.parse(source) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not an object");
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new Error("Prime seccomp profile is not one JSON object", { cause: error });
  }
}

async function inspectRuntimeExecutables(
  dockerExecutable: string,
  runtimeInfo: z.output<typeof dockerInfoSchema>,
): Promise<PrimeOciLocalRuntimeAttestation["executables"]> {
  if ((await realpath(dockerExecutable)) !== dockerExecutable) {
    throw new Error("Docker executable path is not canonical");
  }
  const configuredRuncPath = selectedPrimeDockerRuntime(runtimeInfo.Runtimes).path;
  const resolvedRunc = await resolveConfiguredExecutable(configuredRuncPath, "runc");
  const managed = await resolveDockerManagedRuntimeExecutables();
  const resolvedDockerdSha256 = await hashStableRegularFile(
    managed.dockerd,
    MAX_EXECUTABLE_BYTES,
    "dockerd executable",
  );
  const resolvedContainerdSha256 = await hashStableRegularFile(
    managed.containerd,
    MAX_EXECUTABLE_BYTES,
    "containerd executable",
  );
  if (
    managed.dockerdSha256 === undefined ||
    managed.dockerdSha256 !== resolvedDockerdSha256 ||
    managed.containerdSha256 === undefined ||
    managed.containerdSha256 !== resolvedContainerdSha256
  ) {
    throw new Error("Prime OCI protected runtime executable observation changed");
  }
  return Object.freeze({
    docker: {
      path: dockerExecutable,
      sha256: await hashStableRegularFile(
        dockerExecutable,
        MAX_EXECUTABLE_BYTES,
        "Docker executable",
      ),
    },
    dockerd: { path: managed.dockerd, sha256: resolvedDockerdSha256 },
    containerd: { path: managed.containerd, sha256: resolvedContainerdSha256 },
    runc: {
      path: resolvedRunc,
      sha256: await hashStableRegularFile(resolvedRunc, MAX_EXECUTABLE_BYTES, "runc executable"),
    },
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
