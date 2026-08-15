import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { FLOW_SANDBOX_PROFILES } from "../config/sandbox-profiles.js";
import type { PolicyAction } from "../policy/types.js";
import { runBudgetLimitsSchema } from "../run/budget.js";
import { verifierPackageNameSchema, verifierPackageVersionSchema } from "./verifier-packages.js";

export const POLICY_PACKAGE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_POLICY_PACKAGE_MANIFEST_BYTES = 64 * 1024;
export const MAX_POLICY_PACKAGE_MODELS = 32;
export const MAX_POLICY_PACKAGE_TOOLS = 64;

const POLICY_ACTIONS = Object.freeze([
  "credential.read",
  "filesystem.delete",
  "filesystem.list",
  "filesystem.read",
  "filesystem.write",
  "network.request",
  "process.execute",
] as const satisfies readonly PolicyAction[]);

const boundedIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");
const modelIdentitySchema = z
  .object({ provider: boundedIdentitySchema, model: boundedIdentitySchema })
  .strict();
const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters");

const modelsSchema = z
  .object({
    allowed: sortedUniqueArray(
      modelIdentitySchema,
      MAX_POLICY_PACKAGE_MODELS,
      (value) => `${value.provider}\0${value.model}`,
      "model identities",
    ),
  })
  .strict();

const toolsSchema = z
  .object({
    allowed: sortedUniqueArray(
      toolNameSchema,
      MAX_POLICY_PACKAGE_TOOLS,
      (value) => value,
      "tool names",
    ).optional(),
    allowedPermissions: sortedUniqueArray(
      z.enum(POLICY_ACTIONS),
      POLICY_ACTIONS.length,
      (value) => value,
      "tool permissions",
    ).optional(),
  })
  .strict()
  .refine(
    (value) => value.allowed !== undefined || value.allowedPermissions !== undefined,
    "tools must declare at least one narrowing constraint",
  );

export const policyPackageDefinitionSchema = z
  .object({
    models: modelsSchema.optional(),
    tools: toolsSchema.optional(),
    commands: z
      .object({ requireApproval: z.literal(true) })
      .strict()
      .optional(),
    sandbox: z
      .object({
        allowedProfiles: sortedUniqueArray(
          z.enum(FLOW_SANDBOX_PROFILES),
          FLOW_SANDBOX_PROFILES.length,
          (value) => value,
          "sandbox profiles",
        ),
      })
      .strict()
      .optional(),
    budget: runBudgetLimitsSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    "policy package must declare at least one narrowing constraint",
  );

export const policyPackageManifestSchema = z
  .object({
    apiVersion: z.literal(POLICY_PACKAGE_API_VERSION),
    kind: z.literal("PolicyPackage"),
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        description: z.string().trim().min(1).max(1024),
        license: z.string().trim().min(1).max(1024).optional(),
        compatibility: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    spec: policyPackageDefinitionSchema,
  })
  .strict();

const manifestSnapshotSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_POLICY_PACKAGE_MANIFEST_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_POLICY_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

export const policyPackageSnapshotSchema = z
  .object({
    kind: z.literal("policy-package"),
    apiVersion: z.literal(POLICY_PACKAGE_API_VERSION),
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(1024).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    definition: policyPackageDefinitionSchema,
    manifest: manifestSnapshotSchema,
    digest: sha256Schema,
  })
  .strict();

export type PolicyPackageDefinition = z.infer<typeof policyPackageDefinitionSchema>;
export type PolicyPackageManifest = z.infer<typeof policyPackageManifestSchema>;
export type PolicyPackageSnapshot = z.infer<typeof policyPackageSnapshotSchema>;

export interface PolicyPackageSnapshotInput {
  readonly kind: "policy-package";
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly manifest: { readonly content: Uint8Array };
}

export function parsePolicyPackageManifest(
  source: Uint8Array,
  label = "policy package manifest",
): PolicyPackageManifest {
  if (source.byteLength === 0 || source.byteLength > MAX_POLICY_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`${label} must be 1-${MAX_POLICY_PACKAGE_MANIFEST_BYTES} bytes`);
  }
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
  const parsed = policyPackageManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label}: ${issue?.path.map(String).join(".") || "<manifest>"}: ${issue?.message ?? "invalid manifest"}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function createPolicyPackageSnapshot(
  input: PolicyPackageSnapshotInput,
): PolicyPackageSnapshot {
  const content = Buffer.from(input.manifest.content);
  const parsed = parsePolicyPackageManifest(content);
  const candidate = {
    kind: input.kind,
    apiVersion: parsed.apiVersion,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    description: parsed.metadata.description,
    ...(parsed.metadata.license === undefined ? {} : { license: parsed.metadata.license }),
    ...(parsed.metadata.compatibility === undefined
      ? {}
      : { compatibility: parsed.metadata.compatibility }),
    trust: input.trust,
    provenance: input.provenance,
    definition: parsed.spec,
    manifest: {
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    },
  };
  return validatePolicyPackageSnapshot({
    ...candidate,
    digest: calculatePolicyPackageDigest(candidate),
  });
}

export function validatePolicyPackageSnapshot(input: unknown): PolicyPackageSnapshot {
  const parsed = policyPackageSnapshotSchema.parse(input);
  if (parsed.provenance.split("/").at(-1) !== parsed.name) {
    throw new Error(`policy package "${parsed.name}" provenance must end with its package name`);
  }
  const content = decodeCanonicalBase64(parsed.manifest.contentBase64, parsed.name);
  if (content.byteLength !== parsed.manifest.bytes) {
    throw new Error(`policy package "${parsed.name}" manifest byte count does not match`);
  }
  if (sha256(content) !== parsed.manifest.sha256) {
    throw new Error(`policy package "${parsed.name}" manifest digest does not match`);
  }
  const manifest = parsePolicyPackageManifest(content, `policy package "${parsed.name}"`);
  const expected = {
    apiVersion: parsed.apiVersion,
    kind: "PolicyPackage" as const,
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
    throw new Error(`policy package "${parsed.name}" manifest disagrees with its definition`);
  }
  if (calculatePolicyPackageDigest(parsed) !== parsed.digest) {
    throw new Error(`policy package "${parsed.name}" package digest does not match`);
  }
  return deepFreeze(parsed);
}

export function calculatePolicyPackageDigest(
  value: Omit<PolicyPackageSnapshot, "digest"> | PolicyPackageSnapshot,
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

export function policyPackageIdentityKey(value: {
  readonly name: string;
  readonly version: string;
}): string {
  return `policy-package\0${value.name}\0${value.version}`;
}

function sortedUniqueArray<T>(
  schema: z.ZodType<T>,
  maximum: number,
  key: (value: T) => string,
  label: string,
) {
  return z
    .array(schema)
    .min(1)
    .max(maximum)
    .refine((values) => isStrictlySorted(values.map(key)), `${label} must be sorted and unique`);
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function decodeCanonicalBase64(value: string, name: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error(`policy package "${name}" manifest is not canonical base64`);
  }
  return content;
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
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
