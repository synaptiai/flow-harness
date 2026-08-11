import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  type PrimeExternalHarnessIdentity,
  parsePrimeOciImageIdentity,
  parsePrimeOciRuntimeIdentity,
} from "../../domain/evaluation/external-harness.js";
import { parseStrictJson, type StrictJsonValue } from "../../domain/strict-json.js";

const MAX_ATTESTATION_BYTES = 1_048_576;
const READ_CHUNK_BYTES = 65_536;
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
const descriptorSchema = z
  .object({
    version: z.literal(1),
    runtime: z.unknown(),
    image: z.unknown(),
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
  readonly leaseTarget: "flow-prime-global-v1";
  readonly seccompProfile: Readonly<Record<string, unknown>>;
}

export interface LocalPrimeOciAttestation {
  readonly runtime: PrimeExternalHarnessIdentity["runtime"];
  readonly image: PrimeExternalHarnessIdentity["image"];
  readonly artifacts: z.infer<typeof descriptorSchema>["artifacts"];
  readonly harnessPackageContentSha256: string;
  readonly harnessDependencyClosureSha256: string;
  readonly localRuntime: PrimeOciLocalRuntimeAttestation;
  assertCurrent(): Promise<void>;
}

export type PrimeOciAttestationDescriptor = z.infer<typeof descriptorSchema>;

export interface LocalPrimeOciAttestationStoreOptions {
  readonly descriptorPath: string;
  readonly observeSocket?: (path: "/var/run/docker.sock") => Promise<PrimeOciSocketIdentity>;
}

interface AttestationSnapshot {
  readonly digest: string;
  readonly descriptor: z.infer<typeof descriptorSchema>;
}

export class LocalPrimeOciAttestationStore {
  readonly #descriptorPath: string;
  readonly #observeSocket: (path: "/var/run/docker.sock") => Promise<PrimeOciSocketIdentity>;

  constructor(options: LocalPrimeOciAttestationStoreOptions) {
    this.#descriptorPath = options.descriptorPath;
    this.#observeSocket = options.observeSocket ?? observeDockerSocket;
  }

  async read(): Promise<LocalPrimeOciAttestation> {
    const snapshot = await readSnapshot(this.#descriptorPath);
    const runtime = parsePrimeOciRuntimeIdentity(snapshot.descriptor.runtime);
    const image = parsePrimeOciImageIdentity(snapshot.descriptor.image);
    if (snapshot.descriptor.local.apiVersion !== runtime.engine.apiVersion) {
      throw new Error("Prime OCI Docker API version contradicts the public runtime identity");
    }
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
    if (!sameSocketIdentity(observedSocket, snapshot.descriptor.local.socket)) {
      throw new Error("Prime OCI Docker socket identity changed before admission");
    }

    const localRuntime = deepFreeze({
      daemonId: snapshot.descriptor.daemonId,
      ...snapshot.descriptor.local,
      socket: observedSocket,
    });
    return deepFreeze({
      runtime,
      image,
      artifacts: snapshot.descriptor.artifacts,
      harnessPackageContentSha256: snapshot.descriptor.harnessPackageContentSha256,
      harnessDependencyClosureSha256: snapshot.descriptor.harnessDependencyClosureSha256,
      localRuntime,
      assertCurrent: async () => {
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
      },
    });
  }
}

export async function publishLocalPrimeOciAttestation(
  path: string,
  input: unknown,
  signal?: AbortSignal,
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
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
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
    await rename(temporary, target);
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
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
