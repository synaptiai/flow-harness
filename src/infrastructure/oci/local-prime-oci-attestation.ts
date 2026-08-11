import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { access, lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  type PrimeExternalHarnessIdentity,
  parsePrimeOciImageIdentity,
  parsePrimeOciRuntimeIdentity,
} from "../../domain/evaluation/external-harness.js";
import { parseStrictJson, type StrictJsonValue } from "../../domain/strict-json.js";
import { assertPrimeOciRuntimeCurrent } from "./local-prime-oci-currentness.js";

const MAX_ATTESTATION_BYTES = 1_048_576;
const MAX_EXECUTABLE_BYTES = 268_435_456;
const READ_CHUNK_BYTES = 65_536;
const MAX_ATTESTATION_TEMPORARIES = 4;
const MAX_ATTESTATION_TEMPORARY_BYTES = MAX_ATTESTATION_BYTES * MAX_ATTESTATION_TEMPORARIES;
const attestationTemporaryToken =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_095)
  .refine((value) => value.startsWith("/"), "must be an absolute path")
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "must be a normalized path",
  );
const socketIdentitySchema = z
  .object({
    device: safeInteger,
    inode: safeInteger,
    uid: safeInteger,
    gid: safeInteger,
    mode: z.number().int().min(0).max(0o777),
  })
  .strict();
const executableIdentitySchema = z
  .object({
    path: absolutePathSchema,
    sha256: sha256Schema,
  })
  .strict();
const builderIdentitySchema = z
  .object({
    clientPath: absolutePathSchema,
    clientSha256: sha256Schema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    imageReference: z.string().regex(/^moby\/buildkit:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/),
  })
  .strict();
const descriptorSchema = z
  .object({
    version: z.literal(1),
    runtime: z.unknown(),
    image: z.unknown(),
    builder: builderIdentitySchema,
    artifacts: z
      .object({
        driverSha256: sha256Schema,
        flowDistSha256: sha256Schema,
        kernelProxySha256: sha256Schema,
        noIoResourceLoaderSha256: sha256Schema,
        pythonLauncherSha256: sha256Schema,
        supervisorSha256: sha256Schema,
      })
      .strict(),
    harnessPackageContentSha256: sha256Schema,
    harnessDependencyClosureSha256: sha256Schema,
    daemonId: z.string().min(1).max(256),
    local: z
      .object({
        socketPath: z.literal("/var/run/docker.sock"),
        socket: socketIdentitySchema,
        apiVersion: z.string().regex(/^\d+\.\d+$/),
        cgroupPath: absolutePathSchema,
        corePattern: z.string().min(1).max(4_096),
        globalLeasePath: absolutePathSchema,
        imageDevice: z
          .object({
            path: absolutePathSchema,
            major: safeInteger,
            minor: safeInteger,
          })
          .strict(),
        executables: z
          .object({
            docker: executableIdentitySchema,
            dockerd: executableIdentitySchema,
            containerd: executableIdentitySchema,
            runc: executableIdentitySchema,
          })
          .strict(),
        leaseTarget: z.literal("flow-prime-global-v1"),
        seccompProfile: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export type PrimeOciSocketIdentity = z.infer<typeof socketIdentitySchema>;

export interface PrimeOciLocalRuntimeAttestation {
  readonly daemonId: string;
  readonly socketPath: "/var/run/docker.sock";
  readonly socket: PrimeOciSocketIdentity;
  readonly apiVersion: string;
  readonly cgroupPath: string;
  readonly corePattern: string;
  readonly globalLeasePath: string;
  readonly imageDevice: {
    readonly path: string;
    readonly major: number;
    readonly minor: number;
  };
  readonly executables: {
    readonly docker: z.infer<typeof executableIdentitySchema>;
    readonly dockerd: z.infer<typeof executableIdentitySchema>;
    readonly containerd: z.infer<typeof executableIdentitySchema>;
    readonly runc: z.infer<typeof executableIdentitySchema>;
  };
  readonly leaseTarget: "flow-prime-global-v1";
  readonly seccompProfile: Readonly<Record<string, unknown>>;
}

export interface LocalPrimeOciAttestation {
  readonly runtime: PrimeExternalHarnessIdentity["runtime"];
  readonly image: PrimeExternalHarnessIdentity["image"];
  readonly builder: z.infer<typeof builderIdentitySchema>;
  readonly artifacts: z.infer<typeof descriptorSchema>["artifacts"];
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(signal?: AbortSignal): Promise<void>;
}

export type PrimeOciAttestationDescriptor = z.infer<typeof descriptorSchema>;

export interface PrimeOciAttestationPublicationOptions {
  readonly syncDirectory?: (path: string) => Promise<void>;
}

export class PrimeOciAttestationPublicationUncertainError extends Error {
  constructor(cause: unknown) {
    super("Prime OCI local attestation publication is uncertain", { cause });
    this.name = "PrimeOciAttestationPublicationUncertainError";
  }
}

export interface LocalPrimeOciAttestationStoreOptions {
  readonly descriptorPath: string;
  readonly observeSocket?: (path: "/var/run/docker.sock") => Promise<PrimeOciSocketIdentity>;
  readonly observeExecutable?: (path: string) => Promise<string>;
  readonly assertRuntimeCurrent?: typeof assertPrimeOciRuntimeCurrent;
}

interface AttestationSnapshot {
  readonly digest: string;
  readonly descriptor: z.infer<typeof descriptorSchema>;
}

export class LocalPrimeOciAttestationStore {
  readonly #descriptorPath: string;
  readonly #assertRuntimeCurrent: typeof assertPrimeOciRuntimeCurrent;
  readonly #observeExecutable: (path: string) => Promise<string>;
  readonly #observeSocket: (path: "/var/run/docker.sock") => Promise<PrimeOciSocketIdentity>;

  constructor(options: LocalPrimeOciAttestationStoreOptions) {
    this.#descriptorPath = options.descriptorPath;
    this.#assertRuntimeCurrent = options.assertRuntimeCurrent ?? assertPrimeOciRuntimeCurrent;
    this.#observeExecutable = options.observeExecutable ?? observePrimeOciExecutable;
    this.#observeSocket = options.observeSocket ?? observeDockerSocket;
  }

  async read(): Promise<LocalPrimeOciAttestation> {
    const snapshot = await readSnapshot(this.#descriptorPath);
    const runtime = parsePrimeOciRuntimeIdentity(snapshot.descriptor.runtime);
    const image = parsePrimeOciImageIdentity(snapshot.descriptor.image);
    if (snapshot.descriptor.local.apiVersion !== runtime.engine.apiVersion) {
      throw new Error("Prime OCI Docker API version contradicts the public runtime identity");
    }
    assertExecutableClaims(snapshot.descriptor.local.executables, runtime);
    const seccompDigest = sha256(
      canonicalize(snapshot.descriptor.local.seccompProfile as StrictJsonValue),
    );
    if (seccompDigest !== runtime.policy.seccompSha256) {
      throw new Error("Prime OCI seccomp profile contradicts the public runtime identity");
    }
    if (snapshot.descriptor.local.corePattern.trimStart().startsWith("|")) {
      throw new Error("Prime OCI host core pattern uses a piped handler");
    }
    const observedSocket = socketIdentitySchema.parse(
      await this.#observeSocket(snapshot.descriptor.local.socketPath),
    );
    assertPrimeOciSocketPolicy(snapshot.descriptor.local.socket);
    assertPrimeOciSocketPolicy(observedSocket);
    if (!sameSocketIdentity(observedSocket, snapshot.descriptor.local.socket)) {
      throw new Error("Prime OCI Docker socket identity changed before admission");
    }
    await this.#assertExecutablesCurrent(snapshot.descriptor.local.executables);

    const localRuntime = deepFreeze({
      daemonId: snapshot.descriptor.daemonId,
      ...snapshot.descriptor.local,
      socket: observedSocket,
    });
    await this.#assertRuntimeCurrent({ runtime, image, local: localRuntime });
    return deepFreeze({
      runtime,
      image,
      builder: snapshot.descriptor.builder,
      artifacts: snapshot.descriptor.artifacts,
      harnessPackageContentSha256: snapshot.descriptor.harnessPackageContentSha256,
      harnessDependencyClosureSha256: snapshot.descriptor.harnessDependencyClosureSha256,
      localRuntime,
      assertCurrent: async (signal?: AbortSignal) => {
        const current = await readSnapshot(this.#descriptorPath);
        if (current.digest !== snapshot.digest) {
          throw new Error("Prime OCI local attestation changed after admission");
        }
        const currentSocket = socketIdentitySchema.parse(
          await this.#observeSocket(snapshot.descriptor.local.socketPath),
        );
        if (!sameSocketIdentity(currentSocket, snapshot.descriptor.local.socket)) {
          throw new Error("Prime OCI Docker socket changed after admission");
        }
        await this.#assertExecutablesCurrent(snapshot.descriptor.local.executables);
        await this.#assertRuntimeCurrent({
          runtime,
          image,
          local: localRuntime,
          ...(signal === undefined ? {} : { signal }),
        });
      },
    });
  }

  async #assertExecutablesCurrent(
    executables: z.infer<typeof descriptorSchema>["local"]["executables"],
  ): Promise<void> {
    for (const executable of Object.values(executables)) {
      if ((await this.#observeExecutable(executable.path)) !== executable.sha256) {
        throw new Error("Prime OCI executable changed after admission");
      }
    }
  }
}

export function assertPrimeOciSocketPolicy(socket: PrimeOciSocketIdentity): void {
  if (socket.uid !== 0 || socket.mode !== 0o660) {
    throw new Error("Prime OCI Docker socket does not meet the root-owned 0660 policy");
  }
}

function assertExecutableClaims(
  executables: z.infer<typeof descriptorSchema>["local"]["executables"],
  runtime: PrimeExternalHarnessIdentity["runtime"],
): void {
  if (
    executables.docker.sha256 !== runtime.client.executableSha256 ||
    executables.dockerd.sha256 !== runtime.engine.dockerdSha256 ||
    executables.containerd.sha256 !== runtime.engine.containerdSha256 ||
    executables.runc.sha256 !== runtime.engine.runcSha256
  ) {
    throw new Error("Prime OCI executable identity contradicts the public runtime identity");
  }
}

export async function observePrimeOciExecutable(path: string): Promise<string> {
  if ((await realpath(path)) !== path) {
    throw new Error("Prime OCI executable path is not canonical");
  }
  await access(path, constants.X_OK);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
      throw new Error("Prime OCI executable is not one bounded regular file");
    }
    const bytes = await readBounded(handle, MAX_EXECUTABLE_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error("Prime OCI executable changed while read");
    }
    return sha256(bytes);
  } finally {
    await handle.close();
  }
}

export async function publishLocalPrimeOciAttestation(
  path: string,
  input: unknown,
  signal?: AbortSignal,
  options: PrimeOciAttestationPublicationOptions = {},
): Promise<void> {
  throwIfAborted(signal);
  const parsed = descriptorSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Prime OCI local attestation violates the closed schema", {
      cause: parsed.error,
    });
  }
  const content = Buffer.from(
    `${canonicalize(parsed.data as unknown as StrictJsonValue)}\n`,
    "utf8",
  );
  if (content.byteLength > MAX_ATTESTATION_BYTES) {
    throw new Error(`Prime OCI local attestation exceeds ${MAX_ATTESTATION_BYTES} bytes`);
  }

  const target = resolve(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  throwIfAborted(signal);
  if ((await realpath(directory)) !== directory) {
    throw new Error("Prime OCI local attestation directory is not canonical");
  }
  const sync = options.syncDirectory ?? syncDirectory;
  await recoverAttestationTemporaries(target, sync);
  await recoverAttestationReplacement(target, sync);
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  const backup = attestationBackupPath(target);
  const expectedDigest = sha256(content);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    if ((await optionalReadSnapshotDirect(target)) !== undefined) {
      await rename(target, backup);
      await sync(directory);
    }
    await rename(temporary, target);
    await sync(directory);
    if ((await readSnapshotDirect(target)).digest !== expectedDigest) {
      throw new Error("Prime OCI local attestation changed after publication");
    }
    if ((await optionalReadSnapshotDirect(backup)) !== undefined) {
      await unlink(backup);
      await sync(directory);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    try {
      await recoverAttestationReplacement(target, sync);
      await sync(directory);
      if ((await optionalReadSnapshotDirect(target))?.digest === expectedDigest) {
        return;
      }
    } catch (recoveryError) {
      throw new PrimeOciAttestationPublicationUncertainError(
        new AggregateError([error, recoveryError], "Prime OCI attestation replacement failed"),
      );
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Prime OCI attestation publication was cancelled");
}

async function readSnapshot(path: string): Promise<AttestationSnapshot> {
  const target = resolve(path);
  await recoverAttestationReplacement(target, syncDirectory);
  return readSnapshotDirect(path);
}

async function readSnapshotDirect(path: string): Promise<AttestationSnapshot> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_ATTESTATION_BYTES)) {
      throw new Error("Prime OCI local attestation is not a bounded regular file");
    }
    const bytes = await readBounded(handle, MAX_ATTESTATION_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error("Prime OCI local attestation changed while read");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error("Prime OCI local attestation is not valid UTF-8", { cause: error });
    }
    let input: StrictJsonValue;
    try {
      input = parseStrictJson(text, {
        maxDepth: 16,
        maxNodes: 8_192,
        valueLabel: "Prime OCI local attestation",
      });
    } catch (error) {
      throw new Error("Prime OCI local attestation is not strict JSON", { cause: error });
    }
    const parsed = descriptorSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("Prime OCI local attestation violates the closed schema", {
        cause: parsed.error,
      });
    }
    return Object.freeze({
      digest: sha256(bytes),
      descriptor: parsed.data,
    });
  } finally {
    await handle.close();
  }
}

async function optionalReadSnapshotDirect(path: string): Promise<AttestationSnapshot | undefined> {
  try {
    return await readSnapshotDirect(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function recoverAttestationReplacement(
  target: string,
  sync: (path: string) => Promise<void>,
): Promise<void> {
  const backup = attestationBackupPath(target);
  if ((await optionalReadSnapshotDirect(backup)) === undefined) {
    return;
  }
  const directory = dirname(target);
  if ((await optionalReadSnapshotDirect(target)) === undefined) {
    await rename(backup, target);
    await sync(directory);
    return;
  }
  await sync(directory);
  await unlink(backup);
  await sync(directory);
}

async function recoverAttestationTemporaries(
  target: string,
  sync: (path: string) => Promise<void>,
): Promise<void> {
  const directoryPath = dirname(target);
  const prefix = `.${basename(target)}.`;
  const names: string[] = [];
  const directory = await opendir(directoryPath);
  for await (const entry of directory) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) {
      continue;
    }
    const token = entry.name.slice(prefix.length, -".tmp".length);
    if (attestationTemporaryToken.test(token)) {
      names.push(entry.name);
    }
  }
  names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (names.length > MAX_ATTESTATION_TEMPORARIES) {
    throw new Error("Prime OCI local attestation has too many recovery temporaries");
  }

  let totalBytes = 0;
  const validated: string[] = [];
  for (const name of names) {
    const path = join(directoryPath, name);
    const before = await lstat(path, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : before.uid;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (before.mode & 0o777n) !== 0o600n ||
      before.uid !== currentUid ||
      before.nlink < 1n ||
      before.nlink > 2n ||
      before.size < 1n ||
      before.size > BigInt(MAX_ATTESTATION_BYTES)
    ) {
      throw new Error("Prime OCI local attestation temporary is unsafe");
    }
    totalBytes += Number(before.size);
    if (totalBytes > MAX_ATTESTATION_TEMPORARY_BYTES) {
      throw new Error("Prime OCI local attestation temporaries exceed the recovery byte limit");
    }
    await readSnapshotDirect(path);
    const after = await lstat(path, { bigint: true });
    if (!sameFileIdentity(before, after)) {
      throw new Error("Prime OCI local attestation temporary changed during recovery");
    }
    validated.push(path);
  }
  for (const path of validated) {
    await unlink(path);
  }
  if (validated.length > 0) {
    await sync(directoryPath);
  }
}

function attestationBackupPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.prior-v1`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maxBytes) {
    const length = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - position);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position > maxBytes) {
    throw new Error(`Prime OCI local attestation exceeds ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks, position);
}

async function observeDockerSocket(path: "/var/run/docker.sock"): Promise<PrimeOciSocketIdentity> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isSocket()) {
    throw new Error("Prime OCI Docker endpoint is not a Unix socket");
  }
  return socketIdentitySchema.parse({
    device: safeNumber(metadata.dev, "Docker socket device"),
    inode: safeNumber(metadata.ino, "Docker socket inode"),
    uid: safeNumber(metadata.uid, "Docker socket user"),
    gid: safeNumber(metadata.gid, "Docker socket group"),
    mode: Number(metadata.mode & 0o777n),
  });
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sameSocketIdentity(left: PrimeOciSocketIdentity, right: PrimeOciSocketIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

function safeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the supported integer range`);
  }
  return number;
}

function canonicalize(value: StrictJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as StrictJsonValue)}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
