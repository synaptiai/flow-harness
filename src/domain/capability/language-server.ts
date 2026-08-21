import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { z } from "zod";
import { parseStrictJson, type StrictJsonValue } from "../strict-json.js";

export const LANGUAGE_SERVER_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const LANGUAGE_SERVER_PROTOCOL = "lsp-3.18" as const;
export const MAX_LANGUAGE_SERVER_MANIFEST_BYTES = 64 * 1024;
export const MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES = 256 * 1024 * 1024;
export const MAX_LANGUAGE_SERVER_ARGS = 32;
export const MAX_LANGUAGE_SERVER_ARG_BYTES = 4_096;
export const MAX_LANGUAGE_SERVER_ARGUMENT_BYTES = 32 * 1024;
export const MAX_LANGUAGE_SERVER_LANGUAGES = 16;
export const MAX_LANGUAGE_SERVER_SUFFIXES = 32;
export const MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS = 30_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identityNumberSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,31})$/);
const nameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const languageIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[-+][a-z0-9]+)*$/);
const suffixSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^\.[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const portablePathSchema = z.string().min(1).max(1_024).refine(isPortableRelativePath);
const executablePathSchema = z.string().min(1).max(4_096).refine(isCanonicalAbsolutePath);
const argumentSchema = z
  .string()
  .max(MAX_LANGUAGE_SERVER_ARG_BYTES)
  .refine((value) => !value.includes("\0"));

const languageSchema = z
  .object({
    id: languageIdSchema,
    suffixes: z.array(suffixSchema).min(1).max(MAX_LANGUAGE_SERVER_SUFFIXES).refine(isSortedUnique),
  })
  .strict();

const manifestSchema = z
  .object({
    apiVersion: z.literal(LANGUAGE_SERVER_API_VERSION),
    kind: z.literal("LanguageServer"),
    metadata: z.object({ name: nameSchema }).strict(),
    spec: z
      .object({
        protocol: z.literal(LANGUAGE_SERVER_PROTOCOL),
        executable: executablePathSchema,
        executableSha256: sha256Schema,
        args: z
          .array(argumentSchema)
          .max(MAX_LANGUAGE_SERVER_ARGS)
          .refine(
            (args) =>
              args.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) <=
              MAX_LANGUAGE_SERVER_ARGUMENT_BYTES,
          ),
        languages: z
          .array(languageSchema)
          .min(1)
          .max(MAX_LANGUAGE_SERVER_LANGUAGES)
          .refine((items) => isSortedUnique(items.map((item) => item.id))),
        initializationOptions: z.unknown().refine(isStrictJsonValue).optional(),
        containmentProfile: z.literal("default"),
        requestTimeoutMs: z.number().int().min(100).max(MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS),
      })
      .strict(),
  })
  .strict();

export type LanguageServerManifest = z.infer<typeof manifestSchema>;

const executableIdentitySchema = z
  .object({
    path: executablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_LANGUAGE_SERVER_EXECUTABLE_BYTES),
    device: identityNumberSchema,
    inode: identityNumberSchema,
  })
  .strict();

const storedManifestSchema = z
  .object({
    provenance: portablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_LANGUAGE_SERVER_MANIFEST_BYTES),
    contentBase64: z.string().max(Math.ceil((MAX_LANGUAGE_SERVER_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

const snapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("language-server"),
    name: nameSchema,
    protocol: z.literal(LANGUAGE_SERVER_PROTOCOL),
    executable: executableIdentitySchema,
    args: z.array(argumentSchema).max(MAX_LANGUAGE_SERVER_ARGS),
    languages: z.array(languageSchema).min(1).max(MAX_LANGUAGE_SERVER_LANGUAGES),
    initializationOptions: z.unknown().refine(isStrictJsonValue).optional(),
    containmentProfile: z.literal("default"),
    requestTimeoutMs: z.number().int().min(100).max(MAX_LANGUAGE_SERVER_REQUEST_TIMEOUT_MS),
    manifest: storedManifestSchema,
    digest: sha256Schema,
  })
  .strict();

export interface LanguageServerExecutableIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
}

export interface LanguageServerLanguage {
  readonly id: string;
  readonly suffixes: readonly string[];
}

export interface LanguageServerSnapshot {
  readonly version: 1;
  readonly kind: "language-server";
  readonly name: string;
  readonly protocol: typeof LANGUAGE_SERVER_PROTOCOL;
  readonly executable: LanguageServerExecutableIdentity;
  readonly args: readonly string[];
  readonly languages: readonly LanguageServerLanguage[];
  readonly initializationOptions?: StrictJsonValue | undefined;
  readonly containmentProfile: "default";
  readonly requestTimeoutMs: number;
  readonly manifest: {
    readonly provenance: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly contentBase64: string;
  };
  readonly digest: string;
}

export interface LanguageServerSnapshotInput {
  readonly provenance: string;
  readonly manifest: Uint8Array;
  readonly executable: LanguageServerExecutableIdentity;
}

export class LanguageServerContractError extends Error {
  override readonly name = "LanguageServerContractError";
  readonly code = "invalid_language_server" as const;

  constructor() {
    super("language server snapshot is invalid");
  }
}

export function createLanguageServerSnapshot(
  input: LanguageServerSnapshotInput,
): LanguageServerSnapshot {
  try {
    if (
      input.manifest.byteLength === 0 ||
      input.manifest.byteLength > MAX_LANGUAGE_SERVER_MANIFEST_BYTES
    ) {
      throw new Error("manifest size");
    }
    const manifestBytes = Buffer.from(input.manifest);
    const manifest = parseManifest(manifestBytes);
    const executable = executableIdentitySchema.parse(input.executable);
    if (
      executable.path !== manifest.spec.executable ||
      executable.sha256 !== manifest.spec.executableSha256
    ) {
      throw new Error("executable identity");
    }
    const candidate = snapshotFromManifest(input.provenance, manifestBytes, manifest, executable);
    return validateLanguageServerSnapshot({
      ...candidate,
      digest: calculateLanguageServerSnapshotDigest(candidate),
    });
  } catch (error) {
    if (error instanceof LanguageServerContractError) {
      throw error;
    }
    throw new LanguageServerContractError();
  }
}

export function parseLanguageServerManifest(input: Uint8Array): LanguageServerManifest {
  try {
    if (input.byteLength === 0 || input.byteLength > MAX_LANGUAGE_SERVER_MANIFEST_BYTES) {
      throw new Error("manifest size");
    }
    return parseManifest(input);
  } catch (error) {
    if (error instanceof LanguageServerContractError) {
      throw error;
    }
    throw new LanguageServerContractError();
  }
}

export function validateLanguageServerSnapshot(input: unknown): LanguageServerSnapshot {
  try {
    const parsed = snapshotSchema.parse(input);
    const content = decodeCanonicalBase64(parsed.manifest.contentBase64);
    if (
      content.byteLength !== parsed.manifest.bytes ||
      sha256(content) !== parsed.manifest.sha256
    ) {
      throw new Error("manifest identity");
    }
    const manifest = parseManifest(content);
    const reconstructed = snapshotFromManifest(
      parsed.manifest.provenance,
      content,
      manifest,
      parsed.executable,
    );
    if (
      JSON.stringify(reconstructed) !== JSON.stringify({ ...parsed, digest: undefined }) ||
      calculateLanguageServerSnapshotDigest(reconstructed) !== parsed.digest
    ) {
      throw new Error("snapshot identity");
    }
    return deepFreeze({ ...reconstructed, digest: parsed.digest });
  } catch (error) {
    if (error instanceof LanguageServerContractError) {
      throw error;
    }
    throw new LanguageServerContractError();
  }
}

export function calculateLanguageServerSnapshotDigest(
  snapshot: Omit<LanguageServerSnapshot, "digest"> | LanguageServerSnapshot,
): string {
  return sha256(
    JSON.stringify({
      version: snapshot.version,
      kind: snapshot.kind,
      name: snapshot.name,
      protocol: snapshot.protocol,
      executable: snapshot.executable,
      args: snapshot.args,
      languages: snapshot.languages,
      initializationOptions: snapshot.initializationOptions ?? null,
      containmentProfile: snapshot.containmentProfile,
      requestTimeoutMs: snapshot.requestTimeoutMs,
      manifest: {
        provenance: snapshot.manifest.provenance,
        sha256: snapshot.manifest.sha256,
        bytes: snapshot.manifest.bytes,
      },
    }),
  );
}

function parseManifest(content: Uint8Array): z.infer<typeof manifestSchema> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed = parseStrictJson(text, {
    maxDepth: 12,
    maxNodes: 512,
    valueLabel: "language server manifest",
  });
  const manifest = manifestSchema.parse(parsed);
  return normalizeJson(manifest) as z.infer<typeof manifestSchema>;
}

function snapshotFromManifest(
  provenance: string,
  content: Uint8Array,
  manifest: z.infer<typeof manifestSchema>,
  executable: LanguageServerExecutableIdentity,
): Omit<LanguageServerSnapshot, "digest"> {
  const manifestContent = Buffer.from(content);
  return {
    version: 1,
    kind: "language-server",
    name: manifest.metadata.name,
    protocol: manifest.spec.protocol,
    executable,
    args: manifest.spec.args,
    languages: manifest.spec.languages,
    ...(manifest.spec.initializationOptions === undefined
      ? {}
      : { initializationOptions: manifest.spec.initializationOptions as StrictJsonValue }),
    containmentProfile: manifest.spec.containmentProfile,
    requestTimeoutMs: manifest.spec.requestTimeoutMs,
    manifest: {
      provenance: portablePathSchema.parse(provenance),
      sha256: sha256(manifestContent),
      bytes: manifestContent.byteLength,
      contentBase64: manifestContent.toString("base64"),
    },
  };
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error("noncanonical base64");
  }
  return content;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.includes("\0") &&
    !containsControlCharacter(value)
  );
}

function isPortableRelativePath(value: string): boolean {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !containsControlCharacter(segment),
    );
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function isStrictJsonValue(value: unknown): value is StrictJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isStrictJsonValue);
  }
  return (
    typeof value === "object" && value !== null && Object.values(value).every(isStrictJsonValue)
  );
}

function normalizeJson(value: unknown): StrictJsonValue {
  if (!isStrictJsonValue(value)) {
    throw new Error("value is not strict JSON");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
