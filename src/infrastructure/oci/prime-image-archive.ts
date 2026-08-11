import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";

const TAR_BLOCK_BYTES = 512;
const READ_CHUNK_BYTES = 65_536;
const MAX_ARCHIVE_BYTES = 8_589_934_592;
const MAX_OUTER_ENTRIES = 2_048;
const MAX_LAYER_ENTRIES = 262_144;
const MAX_LAYERS = 512;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_PATH_BYTES = 4_095;
const SECRET_SCAN_OVERLAP_BYTES = 128;
const AWS_DOCUMENTATION_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const awsAccessKeyPattern = /AKIA[0-9A-Z]{16}/g;
const forbiddenSecretPatterns: readonly Readonly<{
  pattern: RegExp;
  stage: PrimeImageArchiveSecretStage;
}>[] = Object.freeze([
  {
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/,
    stage: "scan image archive private keys",
  },
  { pattern: /ghp_[A-Za-z0-9]{36}/, stage: "scan image archive GitHub tokens" },
  { pattern: /npm_[A-Za-z0-9]{36}/, stage: "scan image archive npm tokens" },
  {
    pattern: /FLOW_PRIME_FORBIDDEN_SECRET_[A-Za-z0-9_-]*/,
    stage: "scan image archive synthetic secrets",
  },
]);

export interface PrimeImagePackageIdentity {
  readonly name: string;
  readonly version: string;
}

export interface PrimeImageExternalSbom {
  readonly node: readonly PrimeImagePackageIdentity[];
  readonly python: readonly PrimeImagePackageIdentity[];
}

export interface PrimeImageArchiveInspection {
  readonly archiveSha256: string;
  readonly layerSha256: readonly string[];
  readonly sbom: PrimeImageExternalSbom;
  readonly sbomSha256: string;
}

export type PrimeImageArchiveSecretStage =
  | "scan image archive private keys"
  | "scan image archive AWS access keys"
  | "scan image archive GitHub tokens"
  | "scan image archive npm tokens"
  | "scan image archive synthetic secrets";

export type PrimeImageArchiveInspectionStage =
  | "open image archive"
  | "read image archive manifest"
  | "verify image archive configuration"
  | "scan image archive layers"
  | PrimeImageArchiveSecretStage
  | "inventory image archive packages"
  | "verify image archive stability";

export class PrimeImageArchiveInspectionError extends Error {
  override readonly name = "PrimeImageArchiveInspectionError";

  constructor(
    readonly stage: PrimeImageArchiveInspectionStage,
    cause: unknown,
  ) {
    super(`Prime image archive inspection failed during ${stage}`, { cause });
  }
}

export interface PrimeImageArchiveInspectionHooks {
  readonly beforeStabilityObservation?: () => Promise<void>;
  readonly closeArchive?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
}

interface TarEntry {
  readonly dataOffset: number;
  readonly path: string;
  readonly size: number;
  readonly type: string;
}

interface DockerSaveManifest {
  readonly Config: string;
  readonly Layers: readonly string[];
}

export async function inspectPrimeImageArchive(
  input: {
    readonly archivePath: string;
    readonly imageId: string;
  },
  hooks: PrimeImageArchiveInspectionHooks = {},
): Promise<PrimeImageArchiveInspection> {
  const requestedPath = resolve(input.archivePath);
  const handle = await inspectArchiveStage("open image archive", async () => {
    if (
      (await realpath(requestedPath)) !== requestedPath ||
      !imageDigestPattern.test(input.imageId)
    ) {
      throw new Error("Prime image archive input is not canonical");
    }
    return open(requestedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  });
  let inspection: PrimeImageArchiveInspection | undefined;
  let inspectionFailed = false;
  let primaryError: unknown;
  try {
    const before = await inspectArchiveStage("open image archive", async () => {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.size > BigInt(MAX_ARCHIVE_BYTES)) {
        throw new Error("Prime image archive is not one bounded regular file");
      }
      return metadata;
    });
    const archiveBytes = Number(before.size);
    const { byPath, manifest } = await inspectArchiveStage(
      "read image archive manifest",
      async () => {
        const outerEntries = await readTarEntries(handle, 0, archiveBytes, MAX_OUTER_ENTRIES);
        const entriesByPath = new Map(outerEntries.map((entry) => [entry.path, entry]));
        const manifestEntry = requireRegularEntry(
          entriesByPath,
          "manifest.json",
          MAX_MANIFEST_BYTES,
        );
        return {
          byPath: entriesByPath,
          manifest: parseDockerSaveManifest(
            await readEntryBytes(handle, manifestEntry, MAX_MANIFEST_BYTES),
          ),
        };
      },
    );
    await inspectArchiveStage("verify image archive configuration", async () => {
      const configurationEntry = requireRegularEntry(byPath, manifest.Config, MAX_MANIFEST_BYTES);
      const configuration = await readEntryBytes(handle, configurationEntry, MAX_MANIFEST_BYTES);
      if (`sha256:${sha256(configuration)}` !== input.imageId) {
        throw new Error("Prime image configuration digest does not match the image ID");
      }
    });

    const metadata = new Map<string, Buffer>();
    const layerSha256 = await inspectArchiveStage("scan image archive layers", async () => {
      const layerDigests: string[] = [];
      for (const layerPath of manifest.Layers) {
        const layer = requireRegularEntry(byPath, layerPath, MAX_ARCHIVE_BYTES);
        layerDigests.push(await hashRange(handle, layer.dataOffset, layer.size));
        await inspectLayer(handle, layer, metadata);
      }
      return Object.freeze(layerDigests);
    });
    const { sbom, sbomSha256 } = await inspectArchiveStage(
      "inventory image archive packages",
      async () => {
        const inventory = Object.freeze({
          node: packageInventory(metadata, "node"),
          python: packageInventory(metadata, "python"),
        });
        return { sbom: inventory, sbomSha256: sha256(canonicalize(inventory)) };
      },
    );
    inspection = await inspectArchiveStage("verify image archive stability", async () => {
      await hooks.beforeStabilityObservation?.();
      const archiveSha256 = await hashRange(handle, 0, archiveBytes);
      const after = await handle.stat({ bigint: true });
      if (!sameFileIdentity(before, after)) {
        throw new Error("Prime image archive changed while inspected");
      }
      return Object.freeze({ archiveSha256, layerSha256, sbom, sbomSha256 });
    });
  } catch (error) {
    inspectionFailed = true;
    primaryError = error;
  }

  try {
    await (hooks.closeArchive ?? closeArchive)(handle);
  } catch (closeError) {
    const stage =
      primaryError instanceof PrimeImageArchiveInspectionError
        ? primaryError.stage
        : "verify image archive stability";
    throw new PrimeImageArchiveInspectionError(
      stage,
      inspectionFailed
        ? new AggregateError(
            [primaryError, closeError],
            "Prime image archive inspection and close both failed",
          )
        : closeError,
    );
  }
  if (inspectionFailed) {
    throw primaryError;
  }
  if (inspection === undefined) {
    throw new PrimeImageArchiveInspectionError(
      "verify image archive stability",
      new Error("Prime image archive inspection produced no evidence"),
    );
  }
  return inspection;
}

async function closeArchive(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  await handle.close();
}

async function inspectArchiveStage<T>(
  stage: PrimeImageArchiveInspectionStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrimeImageArchiveInspectionError) {
      throw error;
    }
    throw new PrimeImageArchiveInspectionError(stage, error);
  }
}

async function inspectLayer(
  handle: Awaited<ReturnType<typeof open>>,
  layer: TarEntry,
  metadata: Map<string, Buffer>,
): Promise<void> {
  const entries = await readTarEntries(handle, layer.dataOffset, layer.size, MAX_LAYER_ENTRIES);
  for (const entry of entries) {
    applyWhiteout(entry.path, metadata);
    if (entry.type !== "0" && entry.type !== "\0") {
      continue;
    }
    const secretStage = await findForbiddenSecretStage(handle, entry.dataOffset, entry.size);
    if (secretStage !== undefined) {
      throw new PrimeImageArchiveInspectionError(
        secretStage,
        new Error("Prime image layer contains a prohibited secret pattern"),
      );
    }
    if (!isPackageMetadata(entry.path)) {
      continue;
    }
    metadata.set(entry.path, await readEntryBytes(handle, entry, MAX_METADATA_BYTES));
  }
}

function applyWhiteout(path: string, metadata: Map<string, Buffer>): void {
  const name = basename(path);
  if (name === ".wh..wh..opq") {
    deleteMetadataPrefix(metadata, `${dirname(path)}/`);
    return;
  }
  if (!name.startsWith(".wh.")) {
    return;
  }
  const target = posix.join(dirname(path), name.slice(".wh.".length));
  metadata.delete(target);
  deleteMetadataPrefix(metadata, `${target}/`);
}

function deleteMetadataPrefix(metadata: Map<string, Buffer>, prefix: string): void {
  for (const path of metadata.keys()) {
    if (path.startsWith(prefix)) {
      metadata.delete(path);
    }
  }
}

function isPackageMetadata(path: string): boolean {
  return (
    (path.startsWith("opt/flow/node/node_modules/") && path.endsWith("/package.json")) ||
    (path.startsWith("opt/flow/python/") &&
      path.includes(".dist-info/") &&
      path.endsWith("/METADATA"))
  );
}

function packageInventory(
  metadata: ReadonlyMap<string, Buffer>,
  kind: "node" | "python",
): readonly PrimeImagePackageIdentity[] {
  const packages = new Map<string, PrimeImagePackageIdentity>();
  for (const [path, bytes] of metadata) {
    const item =
      kind === "node" && path.endsWith("/package.json")
        ? parseNodePackage(bytes)
        : kind === "python" && path.endsWith("/METADATA")
          ? parsePythonPackage(bytes)
          : undefined;
    if (item !== undefined) {
      packages.set(`${item.name}\0${item.version}`, Object.freeze(item));
    }
  }
  return Object.freeze(
    [...packages.values()].sort((left, right) =>
      `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`, "en"),
    ),
  );
}

function parseNodePackage(bytes: Buffer): PrimeImagePackageIdentity {
  const value = parseJsonObject(bytes, "Prime image Node package metadata");
  return packageIdentity(value.name, value.version);
}

function parsePythonPackage(bytes: Buffer): PrimeImagePackageIdentity {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const name = /^Name:\s*([^\r\n]+)$/im.exec(source)?.[1]?.trim();
  const version = /^Version:\s*([^\r\n]+)$/im.exec(source)?.[1]?.trim();
  return packageIdentity(name, version);
}

function packageIdentity(name: unknown, version: unknown): PrimeImagePackageIdentity {
  if (
    typeof name !== "string" ||
    typeof version !== "string" ||
    !isBoundedIdentity(name) ||
    !isBoundedIdentity(version)
  ) {
    throw new Error("Prime image package metadata has an invalid identity");
  }
  return { name, version };
}

function isBoundedIdentity(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

function parseDockerSaveManifest(bytes: Buffer): DockerSaveManifest {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Prime image archive manifest violates its closed schema");
  }
  const record = parsed[0];
  if (record === null || Array.isArray(record) || typeof record !== "object") {
    throw new Error("Prime image archive manifest violates its closed schema");
  }
  const config = (record as Record<string, unknown>).Config;
  const layers = (record as Record<string, unknown>).Layers;
  if (
    typeof config !== "string" ||
    !Array.isArray(layers) ||
    layers.length < 1 ||
    layers.length > MAX_LAYERS ||
    layers.some((layer) => typeof layer !== "string")
  ) {
    throw new Error("Prime image archive manifest violates its closed schema");
  }
  validateTarPath(config);
  for (const layer of layers as string[]) {
    validateTarPath(layer);
  }
  return Object.freeze({ Config: config, Layers: Object.freeze(layers as string[]) });
}

async function readTarEntries(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
  maxEntries: number,
): Promise<readonly TarEntry[]> {
  const entries: TarEntry[] = [];
  const end = start + length;
  let offset = start;
  let pendingPath: string | undefined;
  while (offset + TAR_BLOCK_BYTES <= end) {
    const header = await readRange(handle, offset, TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    assertTarChecksum(header);
    const size = parseTarNumber(header.subarray(124, 136));
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const paddedBytes = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = dataOffset + paddedBytes;
    if (size > MAX_ARCHIVE_BYTES || nextOffset > end) {
      throw new Error("Prime image tar entry exceeds its archive boundary");
    }
    const type = String.fromCharCode(header[156] ?? 0);
    const headerPath = tarHeaderPath(header);
    if (type === "x" || type === "g") {
      const pax = await readRange(handle, dataOffset, size);
      pendingPath = parsePaxPath(pax) ?? pendingPath;
    } else if (type === "L") {
      pendingPath = trimTarString(await readRange(handle, dataOffset, size));
    } else {
      const path = normalizeTarPath(pendingPath ?? headerPath, type);
      pendingPath = undefined;
      entries.push(Object.freeze({ dataOffset, path, size, type }));
      if (entries.length > maxEntries) {
        throw new Error("Prime image tar exceeds its entry limit");
      }
    }
    offset = nextOffset;
  }
  return Object.freeze(entries);
}

function tarHeaderPath(header: Buffer): string {
  const name = trimTarString(header.subarray(0, 100));
  const prefix = trimTarString(header.subarray(345, 500));
  return prefix === "" ? name : `${prefix}/${name}`;
}

function trimTarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    end === -1 ? bytes : bytes.subarray(0, end),
  );
}

function parsePaxPath(bytes: Buffer): string | undefined {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  let path: string | undefined;
  while (offset < source.length) {
    const separator = source.indexOf(" ", offset);
    if (separator < 1) {
      throw new Error("Prime image PAX header is invalid");
    }
    const recordLength = Number(source.slice(offset, separator));
    if (
      !Number.isSafeInteger(recordLength) ||
      recordLength < 4 ||
      offset + recordLength > source.length
    ) {
      throw new Error("Prime image PAX header is invalid");
    }
    const record = source.slice(separator + 1, offset + recordLength - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") {
      path = record.slice(equals + 1);
    }
    offset += recordLength;
  }
  return path;
}

function normalizeTarPath(path: string, type: string): string {
  const withoutDot = path.startsWith("./") ? path.slice(2) : path;
  const normalized =
    type === "5" && withoutDot.endsWith("/") ? withoutDot.slice(0, -1) : withoutDot;
  validateTarPath(normalized);
  return normalized;
}

function validateTarPath(path: string): void {
  const parts = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    parts.some(
      (part) =>
        part === "" || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255,
    )
  ) {
    throw new Error("Prime image tar path violates its Linux bounds");
  }
}

function assertTarChecksum(header: Buffer): void {
  const expected = parseTarNumber(header.subarray(148, 156));
  const actual = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );
  if (actual !== expected) {
    throw new Error("Prime image tar header checksum is invalid");
  }
}

function parseTarNumber(bytes: Uint8Array): number {
  if ((bytes[0] ?? 0) >= 0x80) {
    throw new Error("Prime image tar uses an unsupported binary number");
  }
  const source = Buffer.from(bytes).toString("ascii").replaceAll("\0", "").trim();
  if (source === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(source)) {
    throw new Error("Prime image tar contains an invalid number");
  }
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Prime image tar number is outside its bound");
  }
  return value;
}

function requireRegularEntry(
  entries: ReadonlyMap<string, TarEntry>,
  path: string,
  maxBytes: number,
): TarEntry {
  const entry = entries.get(path);
  if (entry === undefined || (entry.type !== "0" && entry.type !== "\0") || entry.size > maxBytes) {
    throw new Error("Prime image archive omits one bounded regular entry");
  }
  return entry;
}

async function readEntryBytes(
  handle: Awaited<ReturnType<typeof open>>,
  entry: TarEntry,
  maxBytes: number,
): Promise<Buffer> {
  if (entry.size > maxBytes) {
    throw new Error("Prime image archive entry exceeds its byte limit");
  }
  return readRange(handle, entry.dataOffset, entry.size);
}

async function readRange(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  bytes: number,
): Promise<Buffer> {
  const target = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(target, offset, bytes - offset, position + offset);
    if (read.bytesRead === 0) {
      throw new Error("Prime image archive ended before its declared boundary");
    }
    offset += read.bytesRead;
  }
  return target;
}

async function hashRange(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  bytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < bytes) {
    const length = Math.min(READ_CHUNK_BYTES, bytes - offset);
    hash.update(await readRange(handle, position + offset, length));
    offset += length;
  }
  return hash.digest("hex");
}

async function findForbiddenSecretStage(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  bytes: number,
): Promise<PrimeImageArchiveSecretStage | undefined> {
  let offset = 0;
  let overlap = "";
  while (offset < bytes) {
    const length = Math.min(READ_CHUNK_BYTES, bytes - offset);
    const source = `${overlap}${(await readRange(handle, position + offset, length)).toString("latin1")}`;
    for (const secret of forbiddenSecretPatterns) {
      if (secret.pattern.test(source)) {
        return secret.stage;
      }
    }
    for (const match of source.matchAll(awsAccessKeyPattern)) {
      if (match[0] !== AWS_DOCUMENTATION_ACCESS_KEY_ID) {
        return "scan image archive AWS access keys";
      }
    }
    overlap = source.slice(-SECRET_SCAN_OVERLAP_BYTES);
    offset += length;
  }
  return undefined;
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
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

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Prime image external SBOM contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
