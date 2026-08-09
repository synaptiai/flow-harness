import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { verifierPackageNameSchema, verifierPackageVersionSchema } from "./verifier-packages.js";

export const WORKFLOW_PACKAGE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES = 128 * 1024;
export const MAX_WORKFLOW_PACKAGE_WORKFLOW_BYTES = 128 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");
const workflowSourceSchema = z
  .string()
  .min(1)
  .max(MAX_WORKFLOW_PACKAGE_WORKFLOW_BYTES)
  .refine((source) => source.trim().length > 0, "must contain non-whitespace workflow source")
  .refine(
    (source) => Buffer.byteLength(source, "utf8") <= MAX_WORKFLOW_PACKAGE_WORKFLOW_BYTES,
    `must not exceed ${MAX_WORKFLOW_PACKAGE_WORKFLOW_BYTES} UTF-8 bytes`,
  );

export const workflowPackageNameSchema = verifierPackageNameSchema;
export const workflowPackageVersionSchema = verifierPackageVersionSchema;

export const workflowPackageManifestSchema = z
  .object({
    apiVersion: z.literal(WORKFLOW_PACKAGE_API_VERSION),
    kind: z.literal("WorkflowPackage"),
    metadata: z
      .object({
        name: workflowPackageNameSchema,
        version: workflowPackageVersionSchema,
        description: z.string().trim().min(1).max(1024),
        license: z.string().trim().min(1).max(1024).optional(),
        compatibility: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    spec: z
      .object({
        workflow: workflowSourceSchema,
      })
      .strict(),
  })
  .strict();

const manifestSnapshotSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

const workflowBindingSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_WORKFLOW_PACKAGE_WORKFLOW_BYTES),
    sha256: sha256Schema,
  })
  .strict();

export const workflowPackageSnapshotSchema = z
  .object({
    kind: z.literal("workflow-package"),
    apiVersion: z.literal(WORKFLOW_PACKAGE_API_VERSION),
    name: workflowPackageNameSchema,
    version: workflowPackageVersionSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(1024).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    manifest: manifestSnapshotSchema,
    workflow: workflowBindingSchema,
    digest: sha256Schema,
  })
  .strict();

export type WorkflowPackageManifest = z.infer<typeof workflowPackageManifestSchema>;
export type WorkflowPackageSnapshot = z.infer<typeof workflowPackageSnapshotSchema>;

export interface WorkflowPackageLocator {
  readonly name: string;
  readonly version: string;
}

export function parseWorkflowPackageLocator(value: string): WorkflowPackageLocator | null {
  if (!value.startsWith("workflow:")) {
    return null;
  }
  const match = /^workflow:([^@]+)@([^@]+)$/.exec(value);
  const name = match?.[1];
  const version = match?.[2];
  if (
    name === undefined ||
    version === undefined ||
    !workflowPackageNameSchema.safeParse(name).success ||
    !workflowPackageVersionSchema.safeParse(version).success
  ) {
    throw new Error('workflow locators must use "workflow:<name>@<exact-semantic-version>"');
  }
  return Object.freeze({ name, version });
}

export interface WorkflowPackageSnapshotInput {
  readonly kind: "workflow-package";
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly manifest: { readonly content: Uint8Array };
}

export function parseWorkflowPackageManifest(
  source: Uint8Array,
  label = "workflow package manifest",
): WorkflowPackageManifest {
  if (source.byteLength > MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES} UTF-8 bytes`);
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
  const parsed = workflowPackageManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label}: ${issue?.path.map(String).join(".") || "<manifest>"}: ${issue?.message ?? "invalid manifest"}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function workflowPackageSource(snapshot: WorkflowPackageSnapshot): string {
  const validated = validateWorkflowPackageSnapshot(snapshot);
  const content = Buffer.from(validated.manifest.contentBase64, "base64");
  return parseWorkflowPackageManifest(
    content,
    `workflow package "${validated.name}@${validated.version}"`,
  ).spec.workflow;
}

export function createWorkflowPackageSnapshot(
  input: WorkflowPackageSnapshotInput,
): WorkflowPackageSnapshot {
  const content = Buffer.from(input.manifest.content);
  const manifest = parseWorkflowPackageManifest(content);
  const workflow = Buffer.from(manifest.spec.workflow, "utf8");
  const candidate = {
    kind: input.kind,
    apiVersion: manifest.apiVersion,
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    description: manifest.metadata.description,
    ...(manifest.metadata.license === undefined ? {} : { license: manifest.metadata.license }),
    ...(manifest.metadata.compatibility === undefined
      ? {}
      : { compatibility: manifest.metadata.compatibility }),
    trust: input.trust,
    provenance: input.provenance,
    manifest: {
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    },
    workflow: {
      bytes: workflow.byteLength,
      sha256: sha256(workflow),
    },
  };
  return validateWorkflowPackageSnapshot({
    ...candidate,
    digest: calculateWorkflowPackageDigest(candidate),
  });
}

export function validateWorkflowPackageSnapshot(input: unknown): WorkflowPackageSnapshot {
  const parsed = workflowPackageSnapshotSchema.parse(input);
  if (parsed.provenance.split("/").at(-1) !== parsed.name) {
    throw new Error(`workflow package "${parsed.name}" provenance must end with its package name`);
  }
  const content = decodeCanonicalBase64(parsed.manifest.contentBase64);
  if (content.byteLength !== parsed.manifest.bytes) {
    throw new Error(`workflow package "${parsed.name}" manifest byte count does not match`);
  }
  if (sha256(content) !== parsed.manifest.sha256) {
    throw new Error(`workflow package "${parsed.name}" manifest digest does not match`);
  }
  const manifest = parseWorkflowPackageManifest(content, `workflow package "${parsed.name}"`);
  if (
    manifest.apiVersion !== parsed.apiVersion ||
    manifest.metadata.name !== parsed.name ||
    manifest.metadata.version !== parsed.version ||
    manifest.metadata.description !== parsed.description ||
    manifest.metadata.license !== parsed.license ||
    manifest.metadata.compatibility !== parsed.compatibility
  ) {
    throw new Error(`workflow package "${parsed.name}" manifest disagrees with its metadata`);
  }
  const workflow = Buffer.from(manifest.spec.workflow, "utf8");
  if (workflow.byteLength !== parsed.workflow.bytes) {
    throw new Error(`workflow package "${parsed.name}" workflow byte count does not match`);
  }
  if (sha256(workflow) !== parsed.workflow.sha256) {
    throw new Error(`workflow package "${parsed.name}" workflow digest does not match`);
  }
  if (calculateWorkflowPackageDigest(parsed) !== parsed.digest) {
    throw new Error(`workflow package "${parsed.name}" package digest does not match`);
  }
  return deepFreeze(parsed);
}

export function calculateWorkflowPackageDigest(
  value: Omit<WorkflowPackageSnapshot, "digest"> | WorkflowPackageSnapshot,
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
      manifest: {
        bytes: value.manifest.bytes,
        sha256: value.manifest.sha256,
      },
      workflow: value.workflow,
    }),
  );
}

export function workflowPackageIdentityKey(value: {
  readonly name: string;
  readonly version: string;
}): string {
  return `workflow-package\0${value.name}\0${value.version}`;
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error("workflow package manifest content is not canonical base64");
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
