import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { z } from "zod";
import { parseStrictJson, type StrictJsonObject, type StrictJsonValue } from "../strict-json.js";

export const ACP_AGENT_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const ACP_AGENT_PROTOCOL = "acp-v1" as const;
export const ACP_AGENT_COMPATIBILITY_PROFILE = "prompt-only-v1" as const;
export const ACP_AGENT_CONTAINMENT_PROFILE = "acp-prompt-only-v1" as const;
export const MAX_ACP_AGENT_MANIFEST_BYTES = 64 * 1024;
export const MAX_ACP_AGENT_EXECUTABLE_BYTES = 512 * 1024 * 1024;
export const MAX_ACP_AGENT_PACKAGE_BYTES = 512 * 1024 * 1024;
export const MAX_ACP_AGENT_PACKAGE_FILES = 20_000;
export const MAX_ACP_AGENT_ARGS = 32;
export const MAX_ACP_AGENT_ARG_BYTES = 4_096;
export const MAX_ACP_AGENT_ARGUMENT_BYTES = 32 * 1024;
export const MAX_ACP_AGENT_MODEL_MAPPINGS = 32;
export const MAX_ACP_AGENT_PROVIDER_AUTHORITIES = 8;
export const MAX_ACP_AGENT_SNAPSHOT_SERIALIZED_BYTES = 256 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identityNumberSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,31})$/);
const nameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const providerSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const modelSchema = z.string().min(1).max(256).refine(isBoundedPlainText);
const agentModelSchema = z.string().min(1).max(256).refine(isBoundedPlainText);
const providerDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
const credentialEnvironmentVariableSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/);
const nodeVersionSchema = z
  .string()
  .regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/);
const portablePathSchema = z.string().min(1).max(1_024).refine(isPortableRelativePath);
const executablePathSchema = z.string().min(1).max(4_096).refine(isCanonicalAbsolutePath);
const argumentSchema = z
  .string()
  .max(MAX_ACP_AGENT_ARG_BYTES)
  .refine((value) => !value.includes("\0") && !containsControlCharacter(value));
const argumentsSchema = z
  .array(argumentSchema)
  .max(MAX_ACP_AGENT_ARGS)
  .refine(
    (args) =>
      args.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0) <=
      MAX_ACP_AGENT_ARGUMENT_BYTES,
  );

const modelMappingSchema = z
  .object({
    provider: providerSchema,
    model: modelSchema,
    agentModel: agentModelSchema,
  })
  .strict();

const providerAuthoritySchema = z
  .object({
    provider: providerSchema,
    domain: providerDomainSchema,
    credentialEnv: credentialEnvironmentVariableSchema,
  })
  .strict();

const usageSupportSchema = z
  .object({
    modelTokens: z.enum(["complete", "unavailable"]),
    costUsd: z.enum(["complete", "unavailable"]),
  })
  .strict();

const binaryManifestLaunchSchema = z
  .object({
    kind: z.literal("binary"),
    executable: executablePathSchema,
    executableSha256: sha256Schema,
    args: argumentsSchema,
  })
  .strict();

const nodePackageManifestLaunchSchema = z
  .object({
    kind: z.literal("node-package"),
    nodeExecutable: executablePathSchema,
    nodeExecutableSha256: sha256Schema,
    nodeVersion: nodeVersionSchema,
    packageRoot: executablePathSchema,
    packageSha256: sha256Schema,
    packageEntrypoint: portablePathSchema,
    args: argumentsSchema,
  })
  .strict();

const manifestSchema = z
  .object({
    apiVersion: z.literal(ACP_AGENT_API_VERSION),
    kind: z.literal("AcpAgent"),
    metadata: z.object({ name: nameSchema }).strict(),
    spec: z
      .object({
        protocol: z.literal(ACP_AGENT_PROTOCOL),
        compatibilityProfile: z.literal(ACP_AGENT_COMPATIBILITY_PROFILE),
        launch: z.discriminatedUnion("kind", [
          binaryManifestLaunchSchema,
          nodePackageManifestLaunchSchema,
        ]),
        modelMappings: z
          .array(modelMappingSchema)
          .min(1)
          .max(MAX_ACP_AGENT_MODEL_MAPPINGS)
          .refine((items) => isSortedUnique(items.map(modelMappingKey))),
        providerAuthorities: z
          .array(providerAuthoritySchema)
          .min(1)
          .max(MAX_ACP_AGENT_PROVIDER_AUTHORITIES)
          .refine((items) => isSortedUnique(items.map((item) => item.provider))),
        containmentProfile: z.literal(ACP_AGENT_CONTAINMENT_PROFILE),
        usage: usageSupportSchema,
        configuration: z.unknown().refine(isStrictJsonObject).optional(),
      })
      .strict()
      .superRefine((spec, context) => {
        const mappingProviders = [...new Set(spec.modelMappings.map((item) => item.provider))];
        const authorityProviders = spec.providerAuthorities.map((item) => item.provider);
        if (JSON.stringify(mappingProviders) !== JSON.stringify(authorityProviders)) {
          context.addIssue({
            code: "custom",
            message: "model mappings and provider authorities must name the same providers",
          });
        }
      }),
  })
  .strict();

export type AcpAgentManifest = z.infer<typeof manifestSchema>;

const artifactIdentitySchema = z
  .object({
    path: executablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_ACP_AGENT_EXECUTABLE_BYTES),
    device: identityNumberSchema,
    inode: identityNumberSchema,
  })
  .strict();

const entrypointIdentitySchema = z
  .object({
    path: portablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_ACP_AGENT_PACKAGE_BYTES),
    device: identityNumberSchema,
    inode: identityNumberSchema,
  })
  .strict();

const packageClosureIdentitySchema = z
  .object({
    root: executablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_ACP_AGENT_PACKAGE_BYTES),
    files: z.number().int().positive().max(MAX_ACP_AGENT_PACKAGE_FILES),
    device: identityNumberSchema,
    inode: identityNumberSchema,
    entrypoint: entrypointIdentitySchema,
  })
  .strict();

const binaryLaunchIdentitySchema = z
  .object({
    kind: z.literal("binary"),
    executable: artifactIdentitySchema,
  })
  .strict();

const nodePackageLaunchIdentitySchema = z
  .object({
    kind: z.literal("node-package"),
    nodeExecutable: artifactIdentitySchema,
    nodeVersion: nodeVersionSchema,
    package: packageClosureIdentitySchema,
  })
  .strict();

const binarySnapshotLaunchSchema = z
  .object({
    kind: z.literal("binary"),
    executable: artifactIdentitySchema,
    args: argumentsSchema,
  })
  .strict();

const nodePackageSnapshotLaunchSchema = z
  .object({
    kind: z.literal("node-package"),
    nodeExecutable: artifactIdentitySchema,
    nodeVersion: nodeVersionSchema,
    package: packageClosureIdentitySchema,
    args: argumentsSchema,
  })
  .strict();

const storedManifestSchema = z
  .object({
    provenance: portablePathSchema,
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(MAX_ACP_AGENT_MANIFEST_BYTES),
    contentBase64: z.string().max(Math.ceil((MAX_ACP_AGENT_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

const snapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("acp-agent"),
    name: nameSchema,
    protocol: z.literal(ACP_AGENT_PROTOCOL),
    compatibilityProfile: z.literal(ACP_AGENT_COMPATIBILITY_PROFILE),
    launch: z.discriminatedUnion("kind", [
      binarySnapshotLaunchSchema,
      nodePackageSnapshotLaunchSchema,
    ]),
    modelMappings: z.array(modelMappingSchema).min(1).max(MAX_ACP_AGENT_MODEL_MAPPINGS),
    providerAuthorities: z
      .array(providerAuthoritySchema)
      .min(1)
      .max(MAX_ACP_AGENT_PROVIDER_AUTHORITIES),
    containmentProfile: z.literal(ACP_AGENT_CONTAINMENT_PROFILE),
    usage: usageSupportSchema,
    configuration: z.unknown().refine(isStrictJsonObject).optional(),
    manifest: storedManifestSchema,
    digest: sha256Schema,
  })
  .strict();

export interface AcpAgentArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
}

export interface AcpAgentPackageClosureIdentity {
  readonly root: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: number;
  readonly device: string;
  readonly inode: string;
  readonly entrypoint: Omit<AcpAgentArtifactIdentity, "path"> & { readonly path: string };
}

export type AcpAgentLaunchIdentity =
  | {
      readonly kind: "binary";
      readonly executable: AcpAgentArtifactIdentity;
    }
  | {
      readonly kind: "node-package";
      readonly nodeExecutable: AcpAgentArtifactIdentity;
      readonly nodeVersion: string;
      readonly package: AcpAgentPackageClosureIdentity;
    };

export type AcpAgentSnapshotLaunch =
  | (Extract<AcpAgentLaunchIdentity, { readonly kind: "binary" }> & {
      readonly args: readonly string[];
    })
  | (Extract<AcpAgentLaunchIdentity, { readonly kind: "node-package" }> & {
      readonly args: readonly string[];
    });

export interface AcpAgentModelMapping {
  readonly provider: string;
  readonly model: string;
  readonly agentModel: string;
}

export interface AcpAgentProviderAuthority {
  readonly provider: string;
  readonly domain: string;
  readonly credentialEnv: string;
}

export interface AcpAgentUsageSupport {
  readonly modelTokens: "complete" | "unavailable";
  readonly costUsd: "complete" | "unavailable";
}

export interface AcpAgentRuntimeSnapshot {
  readonly version: 1;
  readonly kind: "acp-agent";
  readonly name: string;
  readonly protocol: typeof ACP_AGENT_PROTOCOL;
  readonly compatibilityProfile: typeof ACP_AGENT_COMPATIBILITY_PROFILE;
  readonly launch: AcpAgentSnapshotLaunch;
  readonly modelMappings: readonly AcpAgentModelMapping[];
  readonly providerAuthorities: readonly AcpAgentProviderAuthority[];
  readonly containmentProfile: typeof ACP_AGENT_CONTAINMENT_PROFILE;
  readonly usage: AcpAgentUsageSupport;
  readonly configuration?: StrictJsonObject | undefined;
  readonly manifest: {
    readonly provenance: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly contentBase64: string;
  };
  readonly digest: string;
}

export interface AcpAgentRuntimeSnapshotInput {
  readonly provenance: string;
  readonly manifest: Uint8Array;
  readonly launch: AcpAgentLaunchIdentity;
}

export class AcpAgentContractError extends Error {
  override readonly name = "AcpAgentContractError";
  readonly code = "invalid_acp_agent" as const;

  constructor() {
    super("ACP agent runtime snapshot is invalid");
  }
}

export function createAcpAgentRuntimeSnapshot(
  input: AcpAgentRuntimeSnapshotInput,
): AcpAgentRuntimeSnapshot {
  try {
    requireManifestSize(input.manifest);
    const manifestBytes = Buffer.from(input.manifest);
    const manifest = parseManifest(manifestBytes);
    const launch = parseAdmissionLaunchIdentity(input.launch);
    assertLaunchMatchesManifest(launch, manifest.spec.launch);
    const candidate = snapshotFromManifest(input.provenance, manifestBytes, manifest, launch);
    return validateAcpAgentRuntimeSnapshot({
      ...candidate,
      digest: calculateAcpAgentRuntimeSnapshotDigest(candidate),
    });
  } catch (error) {
    if (error instanceof AcpAgentContractError) {
      throw error;
    }
    throw new AcpAgentContractError();
  }
}

export function parseAcpAgentManifest(input: Uint8Array): AcpAgentManifest {
  try {
    requireManifestSize(input);
    return parseManifest(input);
  } catch (error) {
    if (error instanceof AcpAgentContractError) {
      throw error;
    }
    throw new AcpAgentContractError();
  }
}

export function validateAcpAgentRuntimeSnapshot(input: unknown): AcpAgentRuntimeSnapshot {
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
    const launch = projectSnapshotLaunchIdentity(parsed.launch);
    assertLaunchMatchesManifest(launch, manifest.spec.launch);
    const reconstructed = snapshotFromManifest(
      parsed.manifest.provenance,
      content,
      manifest,
      launch,
    );
    if (
      JSON.stringify(reconstructed) !== JSON.stringify({ ...parsed, digest: undefined }) ||
      calculateAcpAgentRuntimeSnapshotDigest(reconstructed) !== parsed.digest ||
      Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_ACP_AGENT_SNAPSHOT_SERIALIZED_BYTES
    ) {
      throw new Error("snapshot identity");
    }
    return deepFreeze({ ...reconstructed, digest: parsed.digest });
  } catch (error) {
    if (error instanceof AcpAgentContractError) {
      throw error;
    }
    throw new AcpAgentContractError();
  }
}

export function calculateAcpAgentRuntimeSnapshotDigest(
  snapshot: Omit<AcpAgentRuntimeSnapshot, "digest"> | AcpAgentRuntimeSnapshot,
): string {
  return sha256(
    JSON.stringify({
      version: snapshot.version,
      kind: snapshot.kind,
      name: snapshot.name,
      protocol: snapshot.protocol,
      compatibilityProfile: snapshot.compatibilityProfile,
      launch: snapshot.launch,
      modelMappings: snapshot.modelMappings,
      providerAuthorities: snapshot.providerAuthorities,
      containmentProfile: snapshot.containmentProfile,
      usage: snapshot.usage,
      configuration: snapshot.configuration ?? null,
      manifest: {
        provenance: snapshot.manifest.provenance,
        sha256: snapshot.manifest.sha256,
        bytes: snapshot.manifest.bytes,
      },
    }),
  );
}

function parseManifest(content: Uint8Array): AcpAgentManifest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const parsed = parseStrictJson(text, {
    maxDepth: 12,
    maxNodes: 1_024,
    valueLabel: "ACP agent manifest",
  });
  const manifest = manifestSchema.parse(parsed);
  return normalizeJson(manifest) as AcpAgentManifest;
}

function parseAdmissionLaunchIdentity(input: unknown): AcpAgentLaunchIdentity {
  if (typeof input !== "object" || input === null || !("kind" in input)) {
    throw new Error("launch identity");
  }
  return input.kind === "binary"
    ? binaryLaunchIdentitySchema.parse(input)
    : nodePackageLaunchIdentitySchema.parse(input);
}

function projectSnapshotLaunchIdentity(input: unknown): AcpAgentLaunchIdentity {
  if (typeof input !== "object" || input === null || !("kind" in input)) {
    throw new Error("launch identity");
  }
  if (input.kind === "binary" && "executable" in input) {
    return binaryLaunchIdentitySchema.parse({
      kind: input.kind,
      executable: input.executable,
    });
  }
  if (
    input.kind === "node-package" &&
    "nodeExecutable" in input &&
    "nodeVersion" in input &&
    "package" in input
  ) {
    return nodePackageLaunchIdentitySchema.parse({
      kind: input.kind,
      nodeExecutable: input.nodeExecutable,
      nodeVersion: input.nodeVersion,
      package: input.package,
    });
  }
  throw new Error("launch identity");
}

function assertLaunchMatchesManifest(
  launch: AcpAgentLaunchIdentity,
  declared: AcpAgentManifest["spec"]["launch"],
): void {
  if (launch.kind !== declared.kind) {
    throw new Error("launch kind");
  }
  if (launch.kind === "binary" && declared.kind === "binary") {
    if (
      launch.executable.path !== declared.executable ||
      launch.executable.sha256 !== declared.executableSha256
    ) {
      throw new Error("binary identity");
    }
    return;
  }
  if (launch.kind === "node-package" && declared.kind === "node-package") {
    if (
      launch.nodeExecutable.path !== declared.nodeExecutable ||
      launch.nodeExecutable.sha256 !== declared.nodeExecutableSha256 ||
      launch.nodeVersion !== declared.nodeVersion ||
      launch.package.root !== declared.packageRoot ||
      launch.package.sha256 !== declared.packageSha256 ||
      launch.package.entrypoint.path !== declared.packageEntrypoint
    ) {
      throw new Error("Node package identity");
    }
    return;
  }
  throw new Error("launch identity");
}

function snapshotFromManifest(
  provenance: string,
  content: Uint8Array,
  manifest: AcpAgentManifest,
  launch: AcpAgentLaunchIdentity,
): Omit<AcpAgentRuntimeSnapshot, "digest"> {
  const manifestContent = Buffer.from(content);
  const args = manifest.spec.launch.args;
  return {
    version: 1,
    kind: "acp-agent",
    name: manifest.metadata.name,
    protocol: manifest.spec.protocol,
    compatibilityProfile: manifest.spec.compatibilityProfile,
    launch: { ...launch, args } as AcpAgentSnapshotLaunch,
    modelMappings: manifest.spec.modelMappings,
    providerAuthorities: manifest.spec.providerAuthorities,
    containmentProfile: manifest.spec.containmentProfile,
    usage: manifest.spec.usage,
    ...(manifest.spec.configuration === undefined
      ? {}
      : { configuration: manifest.spec.configuration as StrictJsonObject }),
    manifest: {
      provenance: portablePathSchema.parse(provenance),
      sha256: sha256(manifestContent),
      bytes: manifestContent.byteLength,
      contentBase64: manifestContent.toString("base64"),
    },
  };
}

function requireManifestSize(input: Uint8Array): void {
  if (input.byteLength === 0 || input.byteLength > MAX_ACP_AGENT_MANIFEST_BYTES) {
    throw new Error("manifest size");
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error("noncanonical base64");
  }
  return content;
}

function modelMappingKey(value: AcpAgentModelMapping): string {
  return `${value.provider}\0${value.model}`;
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

function isBoundedPlainText(value: string): boolean {
  return (
    value === value.normalize("NFC") && !value.includes("\0") && !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function isStrictJsonObject(value: unknown): value is StrictJsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isStrictJsonValue)
  );
}

function isStrictJsonValue(value: unknown): value is StrictJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || isBoundedPlainText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isStrictJsonValue);
  }
  return isStrictJsonObject(value);
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
