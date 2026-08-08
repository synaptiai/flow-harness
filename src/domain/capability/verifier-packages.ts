import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

export const VERIFIER_PACKAGE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_VERIFIER_PACKAGE_MANIFEST_BYTES = 64 * 1024;
export const MAX_VERIFIER_PACKAGE_PROMPT_CHARACTERS = 16_384;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");
export const verifierPackageNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const verifierPackageVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isExactSemanticVersion, "must be an exact semantic version");

const commandDefinitionSchema = z
  .object({
    executable: z.string().trim().min(1).max(4096),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict()
  .refine(
    (command) =>
      !command.executable.includes("\0") && command.args.every((arg) => !arg.includes("\0")),
    "command values must not contain NUL bytes",
  );

export const verifierPackageDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: commandDefinitionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("model"),
      prompt: z.string().trim().min(1).max(MAX_VERIFIER_PACKAGE_PROMPT_CHARACTERS),
    })
    .strict(),
]);

export const verifierPackageManifestSchema = z
  .object({
    apiVersion: z.literal(VERIFIER_PACKAGE_API_VERSION),
    kind: z.literal("VerifierPackage"),
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        description: z.string().trim().min(1).max(1024),
        license: z.string().trim().min(1).max(1024).optional(),
        compatibility: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    spec: verifierPackageDefinitionSchema,
  })
  .strict();

const manifestSnapshotSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_VERIFIER_PACKAGE_MANIFEST_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_VERIFIER_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

export const verifierPackageSnapshotSchema = z
  .object({
    kind: z.literal("verifier-package"),
    apiVersion: z.literal(VERIFIER_PACKAGE_API_VERSION),
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(1024).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    definition: verifierPackageDefinitionSchema,
    manifest: manifestSnapshotSchema,
    digest: sha256Schema,
  })
  .strict();

export type VerifierPackageDefinition = z.infer<typeof verifierPackageDefinitionSchema>;
export type VerifierPackageManifest = z.infer<typeof verifierPackageManifestSchema>;
export type VerifierPackageSnapshot = z.infer<typeof verifierPackageSnapshotSchema>;

export interface VerifierPackageSnapshotInput {
  readonly kind: "verifier-package";
  readonly apiVersion: typeof VERIFIER_PACKAGE_API_VERSION;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly definition: VerifierPackageDefinition;
  readonly manifest: { readonly content: Uint8Array };
}

export interface VerifierPackageUseEvidence {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export const verifierPackageUseEvidenceSchema: z.ZodType<VerifierPackageUseEvidence> = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    digest: sha256Schema,
  })
  .strict();

export function createVerifierPackageSnapshot(
  input: VerifierPackageSnapshotInput,
): VerifierPackageSnapshot {
  const content = Buffer.from(input.manifest.content);
  const candidate = {
    kind: input.kind,
    apiVersion: input.apiVersion,
    name: input.name,
    version: input.version,
    description: input.description,
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
    trust: input.trust,
    provenance: input.provenance,
    definition: input.definition,
    manifest: {
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    },
  };
  return validateVerifierPackageSnapshot({
    ...candidate,
    digest: calculateVerifierPackageDigest(candidate),
  });
}

export function validateVerifierPackageSnapshot(input: unknown): VerifierPackageSnapshot {
  const parsed = verifierPackageSnapshotSchema.parse(input);
  if (parsed.provenance.split("/").at(-1) !== parsed.name) {
    throw new Error(`verifier package "${parsed.name}" provenance must end with its package name`);
  }
  const content = decodeCanonicalBase64(parsed.manifest.contentBase64);
  if (content.byteLength !== parsed.manifest.bytes) {
    throw new Error(`verifier package "${parsed.name}" manifest byte count does not match`);
  }
  if (sha256(content) !== parsed.manifest.sha256) {
    throw new Error(`verifier package "${parsed.name}" manifest digest does not match`);
  }
  const manifest = parseVerifierPackageManifest(content, `verifier package "${parsed.name}"`);
  const expected = {
    apiVersion: parsed.apiVersion,
    kind: "VerifierPackage" as const,
    metadata: {
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      ...(parsed.license === undefined ? {} : { license: parsed.license }),
      ...(parsed.compatibility === undefined ? {} : { compatibility: parsed.compatibility }),
    },
    spec: parsed.definition,
  };
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error(`verifier package "${parsed.name}" manifest disagrees with its definition`);
  }
  if (calculateVerifierPackageDigest(parsed) !== parsed.digest) {
    throw new Error(`verifier package "${parsed.name}" package digest does not match`);
  }
  return deepFreeze(parsed);
}

export function parseVerifierPackageManifest(
  source: Uint8Array,
  label = "verifier package manifest",
): VerifierPackageManifest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8`, { cause: error });
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${label}: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  let input: unknown;
  try {
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${label}: YAML aliases are not supported`, { cause: error });
  }
  const parsed = verifierPackageManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label}: ${issue?.path.map(String).join(".") || "<manifest>"}: ${issue?.message ?? "invalid manifest"}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function calculateVerifierPackageDigest(
  value: Omit<VerifierPackageSnapshot, "digest"> | VerifierPackageSnapshot,
): string {
  return sha256(
    JSON.stringify({
      kind: value.kind,
      apiVersion: value.apiVersion,
      name: value.name,
      version: value.version,
      description: value.description,
      license: value.license ?? null,
      compatibility: value.compatibility ?? null,
      trust: value.trust,
      provenance: value.provenance,
      definition: value.definition,
      manifest: {
        bytes: value.manifest.bytes,
        sha256: value.manifest.sha256,
      },
    }),
  );
}

export function verifierPackageIdentityKey(value: {
  readonly name: string;
  readonly version: string;
}): string {
  return `verifier-package\0${value.name}\0${value.version}`;
}

function isExactSemanticVersion(value: string): boolean {
  const buildParts = value.split("+");
  if (buildParts.length > 2) {
    return false;
  }
  const coreAndPrerelease = buildParts[0];
  const build = buildParts[1];
  if (coreAndPrerelease === undefined || (build !== undefined && !validIdentifiers(build, false))) {
    return false;
  }
  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? coreAndPrerelease
      : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split(".");
  if (coreIdentifiers.length !== 3 || !coreIdentifiers.every(validNumericIdentifier)) {
    return false;
  }
  return prerelease === undefined || validIdentifiers(prerelease, true);
}

function validIdentifiers(value: string, rejectNumericLeadingZeros: boolean): boolean {
  const identifiers = value.split(".");
  return identifiers.every(
    (identifier) =>
      identifier.length > 0 &&
      /^[0-9A-Za-z-]+$/.test(identifier) &&
      (!rejectNumericLeadingZeros ||
        !/^\d+$/.test(identifier) ||
        validNumericIdentifier(identifier)),
  );
}

function validNumericIdentifier(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error("verifier package manifest content is not canonical base64");
  }
  return content;
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !Array.from(segment).some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && (point <= 31 || point === 127);
      }),
  );
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
