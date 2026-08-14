import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";

const TAR_BLOCK_BYTES = 512;
const READ_CHUNK_BYTES = 65_536;
const MAX_ARCHIVE_BYTES = 8_589_934_592;
const MAX_OUTER_ENTRIES = 2_048;
const MAX_LAYER_ENTRIES = 262_144;
const MAX_LAYERS = 512;
const MAX_PACKAGE_METADATA_BYTES = 2_147_483_648;
const MAX_PACKAGE_METADATA_ENTRIES = 131_072;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_PACKAGE_IDENTITIES = 8_192;
const MAX_PATH_BYTES = 4_095;
const MAX_PRIVATE_KEY_CANDIDATE_BYTES = 1_048_576;
const MAX_PRIVATE_KEY_MARKER_LINE_BYTES = 128;
const SECRET_SCAN_OVERLAP_BYTES = 128;
const AWS_DOCUMENTATION_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const awsAccessKeyPattern = /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g;
const privateKeyBeginPattern =
  /^-----BEGIN ((?:(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) )?PRIVATE KEY)-----$/;
const privateKeyMetadataNamePattern = /^[A-Za-z][A-Za-z0-9-]*:/;
const privateKeyPayloadPattern = /^[A-Za-z0-9+/]+={0,2}$/;
const syntheticSecretPattern = new RegExp(
  `${["FLOW", "PRIME", "FORBIDDEN", "SECRET"].join("_")}_[A-Za-z0-9_-]*`,
);
const forbiddenSecretPatterns: readonly Readonly<{
  pattern: RegExp;
  stage: PrimeImageArchiveSecretStage;
}>[] = Object.freeze([
  { pattern: /ghp_[A-Za-z0-9]{36}/, stage: "scan image archive GitHub tokens" },
  { pattern: /npm_[A-Za-z0-9]{36}/, stage: "scan image archive npm tokens" },
  {
    pattern: syntheticSecretPattern,
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
  | "scan native Prime image AWS access keys"
  | "scan Node image AWS access keys"
  | "scan Python image AWS access keys"
  | "scan system image AWS access keys"
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

export interface PrimeImagePackageMetadataLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export class PrimeImagePackageMetadataBudget {
  #bytes = 0;
  #entries = 0;
  readonly #limits: PrimeImagePackageMetadataLimits;

  constructor(
    limits: PrimeImagePackageMetadataLimits = {
      maxBytes: MAX_PACKAGE_METADATA_BYTES,
      maxEntries: MAX_PACKAGE_METADATA_ENTRIES,
    },
  ) {
    const maxBytes = limits.maxBytes;
    const maxEntries = limits.maxEntries;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1
    ) {
      throw new Error("Prime image package metadata limits are invalid");
    }
    this.#limits = Object.freeze({
      maxBytes: Math.min(maxBytes, MAX_PACKAGE_METADATA_BYTES),
      maxEntries: Math.min(maxEntries, MAX_PACKAGE_METADATA_ENTRIES),
    });
  }

  get bytes(): number {
    return this.#bytes;
  }

  get entries(): number {
    return this.#entries;
  }

  replace(priorBytes: number | undefined, nextBytes: number): void {
    if (
      (priorBytes !== undefined && (!Number.isSafeInteger(priorBytes) || priorBytes < 0)) ||
      !Number.isSafeInteger(nextBytes) ||
      nextBytes < 0 ||
      (priorBytes !== undefined && (this.#entries === 0 || priorBytes > this.#bytes))
    ) {
      throw new Error("Prime image package metadata budget transition is invalid");
    }
    const entries = this.#entries + (priorBytes === undefined ? 1 : 0);
    const bytes = this.#bytes - (priorBytes ?? 0) + nextBytes;
    if (
      !Number.isSafeInteger(entries) ||
      entries < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      throw new Error("Prime image package metadata budget transition is invalid");
    }
    if (entries > this.#limits.maxEntries || bytes > this.#limits.maxBytes) {
      throw new PrimeImageArchiveInspectionError(
        "inventory image archive packages",
        new Error("Prime image package metadata exceeds its aggregate limit"),
      );
    }
    this.#entries = entries;
    this.#bytes = bytes;
  }
}

export interface PrimeImageArchiveInspectionHooks {
  readonly beforeStabilityObservation?: () => Promise<void>;
  readonly closeArchive?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
  readonly observeWhiteoutMetadataPath?: () => void;
  readonly packageMetadataLimits?: PrimeImagePackageMetadataLimits;
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

interface PrivateKeyScanState {
  candidateBytes: number;
  discardingLine: boolean;
  label: string | undefined;
  payloadCharacters: number;
  payloadStarted: boolean;
  pendingLine: string;
}

type PackageMetadataRecord =
  | {
      readonly bytes: number;
      readonly kind: "node" | "python";
      readonly state: "absent";
    }
  | {
      readonly bytes: number;
      readonly kind: "node" | "python";
      readonly state: "invalid";
    }
  | {
      readonly bytes: number;
      readonly identity: PrimeImagePackageIdentity;
      readonly kind: "node" | "python";
      readonly state: "identified";
    };

interface WhiteoutTrieNode {
  readonly children: Map<string, WhiteoutTrieNode>;
  terminal: boolean;
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

    const metadata = new Map<string, PackageMetadataRecord>();
    const layerSha256 = await inspectArchiveStage("scan image archive layers", async () => {
      const layerDigests: string[] = [];
      for (const layerPath of manifest.Layers) {
        const layer = requireRegularEntry(byPath, layerPath, MAX_ARCHIVE_BYTES);
        layerDigests.push(await hashRange(handle, layer.dataOffset, layer.size));
        await inspectLayer(handle, layer, metadata, hooks);
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
  metadata: Map<string, PackageMetadataRecord>,
  hooks: PrimeImageArchiveInspectionHooks,
): Promise<void> {
  const entries = await readTarEntries(handle, layer.dataOffset, layer.size, MAX_LAYER_ENTRIES);
  const lowerMetadata = new Map(metadata);
  applyWhiteouts(entries, lowerMetadata, hooks);
  const currentMetadata = new Map<string, PackageMetadataRecord>();
  for (const entry of entries) {
    const regular = entry.type === "0" || entry.type === "\0";
    if (regular) {
      const secretStage = await findForbiddenSecretStage(
        handle,
        entry.dataOffset,
        entry.size,
        entry.path,
      );
      if (secretStage !== undefined) {
        throw new PrimeImageArchiveInspectionError(
          secretStage,
          new Error("Prime image layer contains a prohibited secret pattern"),
        );
      }
    }
    const kind = packageMetadataKind(entry.path);
    if (kind === undefined) {
      continue;
    }
    currentMetadata.set(
      entry.path,
      !regular || entry.size > MAX_METADATA_BYTES
        ? { bytes: entry.size, kind, state: "invalid" }
        : parsePackageMetadata(kind, await readEntryBytes(handle, entry, MAX_METADATA_BYTES)),
    );
  }
  const currentBudgets = {
    node: new PrimeImagePackageMetadataBudget(hooks.packageMetadataLimits),
    python: new PrimeImagePackageMetadataBudget(hooks.packageMetadataLimits),
  };
  for (const record of currentMetadata.values()) {
    currentBudgets[record.kind].replace(undefined, record.bytes);
  }
  metadata.clear();
  for (const [path, bytes] of lowerMetadata) {
    metadata.set(path, bytes);
  }
  for (const [path, bytes] of currentMetadata) {
    metadata.set(path, bytes);
  }
  const finalBudgets = {
    node: new PrimeImagePackageMetadataBudget(hooks.packageMetadataLimits),
    python: new PrimeImagePackageMetadataBudget(hooks.packageMetadataLimits),
  };
  for (const record of metadata.values()) {
    finalBudgets[record.kind].replace(undefined, record.bytes);
  }
}

function applyWhiteouts(
  entries: readonly TarEntry[],
  metadata: Map<string, PackageMetadataRecord>,
  hooks: PrimeImageArchiveInspectionHooks,
): void {
  const root: WhiteoutTrieNode = { children: new Map(), terminal: false };
  let hasWhiteout = false;
  for (const entry of entries) {
    const target = whiteoutTarget(entry);
    if (target === undefined) {
      continue;
    }
    addWhiteoutTarget(root, target);
    hasWhiteout = true;
  }
  if (!hasWhiteout) {
    return;
  }
  for (const path of metadata.keys()) {
    hooks.observeWhiteoutMetadataPath?.();
    if (whiteoutMatches(root, path)) {
      metadata.delete(path);
    }
  }
}

function whiteoutTarget(entry: TarEntry): string | undefined {
  const name = posix.basename(entry.path);
  if (!name.startsWith(".wh.")) {
    return undefined;
  }
  if ((entry.type !== "0" && entry.type !== "\0") || entry.size !== 0) {
    throw new Error("Prime image layer has an invalid whiteout");
  }
  const directory = posix.dirname(entry.path);
  if (name === ".wh..wh..opq") {
    return directory === "." ? "" : directory;
  }
  const targetName = name.slice(".wh.".length);
  if (targetName === "" || targetName === "." || targetName === "..") {
    throw new Error("Prime image layer has an invalid whiteout");
  }
  return posix.join(directory, targetName);
}

function addWhiteoutTarget(root: WhiteoutTrieNode, path: string): void {
  let node = root;
  for (const component of path === "" ? [] : path.split("/")) {
    let child = node.children.get(component);
    if (child === undefined) {
      child = { children: new Map(), terminal: false };
      node.children.set(component, child);
    }
    node = child;
  }
  node.terminal = true;
}

function whiteoutMatches(root: WhiteoutTrieNode, path: string): boolean {
  let node = root;
  if (node.terminal) {
    return true;
  }
  for (const component of path.split("/")) {
    const child = node.children.get(component);
    if (child === undefined) {
      return false;
    }
    node = child;
    if (node.terminal) {
      return true;
    }
  }
  return false;
}

function packageMetadataKind(path: string): "node" | "python" | undefined {
  if (path.startsWith("opt/flow/node/node_modules/") && path.endsWith("/package.json")) {
    return "node";
  }
  if (
    path.startsWith("opt/flow/python/") &&
    posix.dirname(path).endsWith(".dist-info") &&
    posix.basename(path) === "METADATA"
  ) {
    return "python";
  }
  return undefined;
}

function packageInventory(
  metadata: ReadonlyMap<string, PackageMetadataRecord>,
  kind: "node" | "python",
): readonly PrimeImagePackageIdentity[] {
  const packages = new Map<string, PrimeImagePackageIdentity>();
  for (const record of metadata.values()) {
    if (record.kind !== kind || record.state === "absent") {
      continue;
    }
    if (record.state === "invalid") {
      throw new Error("Prime image package metadata is invalid");
    }
    packages.set(
      `${record.identity.name}\0${record.identity.version}`,
      Object.freeze(record.identity),
    );
  }
  const values = [...packages.values()].sort((left, right) =>
    `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`, "en"),
  );
  if (values.length > MAX_PACKAGE_IDENTITIES) {
    throw new Error("Prime image package inventory exceeds its count limit");
  }
  return Object.freeze(values);
}

function parsePackageMetadata(kind: "node" | "python", bytes: Buffer): PackageMetadataRecord {
  try {
    const identity = kind === "node" ? parseNodePackage(bytes) : parsePythonPackage(bytes);
    return identity === undefined
      ? { bytes: bytes.byteLength, kind, state: "absent" }
      : { bytes: bytes.byteLength, identity, kind, state: "identified" };
  } catch {
    return { bytes: bytes.byteLength, kind, state: "invalid" };
  }
}

function parseNodePackage(bytes: Buffer): PrimeImagePackageIdentity | undefined {
  const value = parseJsonObject(bytes, "Prime image Node package metadata");
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    return undefined;
  }
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
  let physicalEntries = 0;
  let rootMarkerSeen = false;
  while (offset + TAR_BLOCK_BYTES <= end) {
    const header = await readRange(handle, offset, TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    physicalEntries += 1;
    if (physicalEntries > maxEntries) {
      throw new Error("Prime image tar exceeds its entry limit");
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
      const sourcePath = pendingPath ?? headerPath;
      pendingPath = undefined;
      if (isTarRootDirectory(sourcePath, type)) {
        if (size !== 0 || rootMarkerSeen) {
          throw new Error(
            rootMarkerSeen
              ? "Prime image tar repeats its root marker"
              : "Prime image tar root marker contains data",
          );
        }
        rootMarkerSeen = true;
        offset = nextOffset;
        continue;
      }
      const path = normalizeTarPath(sourcePath, type);
      entries.push(Object.freeze({ dataOffset, path, size, type }));
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

function isTarRootDirectory(path: string, type: string): boolean {
  return type === "5" && (path === "." || path === "./");
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
  path: string,
): Promise<PrimeImageArchiveSecretStage | undefined> {
  let offset = 0;
  let overlap = "";
  const privateKeyState: PrivateKeyScanState = {
    candidateBytes: 0,
    discardingLine: false,
    label: undefined,
    payloadCharacters: 0,
    payloadStarted: false,
    pendingLine: "",
  };
  while (offset < bytes) {
    const length = Math.min(READ_CHUNK_BYTES, bytes - offset);
    const chunk = (await readRange(handle, position + offset, length)).toString("latin1");
    const privateKeyChunk =
      offset === 0 && chunk.startsWith("\xef\xbb\xbf") ? chunk.slice(3) : chunk;
    if (scanPrivateKeyChunk(privateKeyState, privateKeyChunk, false)) {
      return "scan image archive private keys";
    }
    const source = `${overlap}${chunk}`;
    for (const secret of forbiddenSecretPatterns) {
      if (secret.pattern.test(source)) {
        return secret.stage;
      }
    }
    const finalChunk = offset + length === bytes;
    for (const match of source.matchAll(awsAccessKeyPattern)) {
      const matchEnd = (match.index ?? 0) + match[0].length;
      if (matchEnd < overlap.length || (!finalChunk && matchEnd === source.length)) {
        continue;
      }
      if (match[0] !== AWS_DOCUMENTATION_ACCESS_KEY_ID) {
        return awsAccessKeyStage(path);
      }
    }
    overlap = source.slice(-SECRET_SCAN_OVERLAP_BYTES);
    offset += length;
  }
  if (scanPrivateKeyChunk(privateKeyState, "", true)) {
    return "scan image archive private keys";
  }
  return undefined;
}

function awsAccessKeyStage(path: string): PrimeImageArchiveSecretStage {
  if (path.startsWith("opt/flow/bin/") || path.startsWith("opt/flow/lib/")) {
    return "scan native Prime image AWS access keys";
  }
  if (path.startsWith("opt/flow/node/")) {
    return "scan Node image AWS access keys";
  }
  if (path.startsWith("opt/flow/python/")) {
    return "scan Python image AWS access keys";
  }
  return "scan system image AWS access keys";
}

function scanPrivateKeyChunk(state: PrivateKeyScanState, chunk: string, final: boolean): boolean {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf("\n", offset);
    const end = newline === -1 ? chunk.length : newline;
    if (!state.discardingLine) {
      state.pendingLine += chunk.slice(offset, end);
      if (
        state.label !== undefined &&
        state.candidateBytes + state.pendingLine.length > MAX_PRIVATE_KEY_CANDIDATE_BYTES
      ) {
        return true;
      }
      if (
        state.label === undefined &&
        state.pendingLine.length > MAX_PRIVATE_KEY_MARKER_LINE_BYTES
      ) {
        state.pendingLine = "";
        state.discardingLine = true;
      }
    }
    if (newline === -1) {
      break;
    }
    if (state.discardingLine) {
      state.discardingLine = false;
    } else {
      const line = state.pendingLine;
      state.pendingLine = "";
      if (scanPrivateKeyLine(state, line, 1)) {
        return true;
      }
    }
    offset = newline + 1;
  }
  if (
    final &&
    !state.discardingLine &&
    state.pendingLine !== "" &&
    scanPrivateKeyLine(state, state.pendingLine, 0)
  ) {
    return true;
  }
  if (final) {
    state.pendingLine = "";
    state.discardingLine = false;
  }
  return false;
}

function scanPrivateKeyLine(
  state: PrivateKeyScanState,
  line: string,
  terminatorBytes: number,
): boolean {
  const candidate = line.replace(/\r$/, "").trim();
  if (state.label !== undefined) {
    state.candidateBytes += line.length + terminatorBytes;
    if (state.candidateBytes > MAX_PRIVATE_KEY_CANDIDATE_BYTES) {
      return true;
    }
    if (candidate === `-----END ${state.label}-----`) {
      const matched = state.payloadCharacters >= 64;
      resetPrivateKeyCandidate(state);
      return matched;
    }
    if (candidate === "") {
      return false;
    }
    if (!state.payloadStarted && isPrivateKeyMetadata(candidate)) {
      return false;
    }
    const normalizedPayload = candidate.replace(/[\t\v\f\r ]/g, "");
    if (normalizedPayload !== "" && privateKeyPayloadPattern.test(normalizedPayload)) {
      state.payloadCharacters += normalizedPayload.length;
      state.payloadStarted = true;
      return false;
    }
    resetPrivateKeyCandidate(state);
  }
  const begin = privateKeyBeginPattern.exec(candidate);
  if (begin?.[1] !== undefined) {
    state.label = begin[1];
    state.candidateBytes = line.length + terminatorBytes;
    state.payloadCharacters = 0;
    state.payloadStarted = false;
  }
  return false;
}

function isPrivateKeyMetadata(candidate: string): boolean {
  const prefix = privateKeyMetadataNamePattern.exec(candidate)?.[0];
  if (prefix === undefined) {
    return false;
  }
  return Array.from(candidate.slice(prefix.length)).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 9 || (codePoint !== undefined && codePoint >= 32 && codePoint <= 126);
  });
}

function resetPrivateKeyCandidate(state: PrivateKeyScanState): void {
  state.candidateBytes = 0;
  state.label = undefined;
  state.payloadCharacters = 0;
  state.payloadStarted = false;
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
