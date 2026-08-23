import { createHash } from "node:crypto";

import { z } from "zod";
import { parseStrictJson, StrictJsonError } from "../strict-json.js";
import type { PublicCapabilityFamilyInput } from "./public-capability-reference.js";
import { parseAgentSkillManifest } from "./agent-skill-manifest.js";
import {
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_AGENT_SKILL_FILES,
  MAX_AGENT_SKILL_PACKAGE_BYTES,
} from "./agent-skills.js";
import {
  MAX_POLICY_PACKAGE_MANIFEST_BYTES,
  parsePolicyPackageManifest,
} from "./policy-packages.js";
import {
  MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES,
  parsePresentationPackageManifest,
} from "./presentation-packages.js";
import { MAX_TOOL_PACKAGE_MANIFEST_BYTES, parseToolPackageManifest } from "./tool-packages.js";
import {
  MAX_VERIFIER_PACKAGE_MANIFEST_BYTES,
  parseVerifierPackageManifest,
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "./verifier-packages.js";
import {
  MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES,
  parseWorkflowPackageManifest,
} from "./workflow-packages.js";

export const CAPABILITY_BUNDLE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const MAX_CAPABILITY_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_CAPABILITY_BUNDLE_DECODED_BYTES = 2 * 1024 * 1024;
export const MAX_CAPABILITY_BUNDLE_PACKAGES = 32;

export const CAPABILITY_PACKAGE_FAMILY_REFERENCES = Object.freeze([
  capabilityFamilyReference({
    kind: "agent-skill",
    title: "Agent Skills",
    summary: "Inert instructions and resources selected by exact package identity.",
    extension: "dynamic",
  }),
  capabilityFamilyReference({
    kind: "policy-package",
    title: "Policy packages",
    summary: "Inert policy narrowing that cannot grant authority beyond operator policy.",
    extension: "dynamic",
  }),
  capabilityFamilyReference({
    kind: "presentation-package",
    title: "Presentation packages",
    summary: "Inert A2UI-profile presentation metadata for supported Flow hosts.",
    extension: "dynamic",
  }),
  capabilityFamilyReference({
    kind: "tool-package",
    title: "Command tool packages",
    summary: "Declarative scalar inputs rendered through closed argv-only command profiles.",
    extension: "dynamic",
  }),
  capabilityFamilyReference({
    kind: "verifier-package",
    title: "Verifier packages",
    summary: "Inert command or model verification definitions admitted by exact identity.",
    extension: "dynamic",
  }),
  capabilityFamilyReference({
    kind: "workflow-package",
    title: "Workflow packages",
    summary: "Inert workflow sources compiled through the ordinary Flow workflow contract.",
    extension: "dynamic",
  }),
] as const satisfies readonly PublicCapabilityFamilyInput[]);

export type CapabilityPackageFamilyKind =
  (typeof CAPABILITY_PACKAGE_FAMILY_REFERENCES)[number]["kind"];

function capabilityFamilyReference<const TReference extends PublicCapabilityFamilyInput>(
  reference: TReference,
): TReference {
  return Object.freeze(reference);
}

const verifierEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("verifier-package")),
    manifestBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_VERIFIER_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();
const toolEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("tool-package")),
    manifestBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_TOOL_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();
const workflowEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("workflow-package")),
    manifestBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();
const policyEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("policy-package")),
    manifestBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_POLICY_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();
const presentationEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("presentation-package")),
    manifestBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();
const agentSkillEntrySchema = z
  .object({
    kind: z.literal(capabilityPackageFamilyKind("agent-skill")),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            contentBase64: z.string().max(Math.ceil((MAX_AGENT_SKILL_FILE_BYTES * 4) / 3) + 4),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AGENT_SKILL_FILES),
  })
  .strict();
const bundleEntrySchema = z.discriminatedUnion("kind", [
  agentSkillEntrySchema,
  verifierEntrySchema,
  toolEntrySchema,
  workflowEntrySchema,
  policyEntrySchema,
  presentationEntrySchema,
]);
const bundleMetadataSchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    description: canonicalMetadataTextSchema(1024),
    license: canonicalMetadataTextSchema(1024).optional(),
    compatibility: canonicalMetadataTextSchema(500).optional(),
  })
  .strict();

const bundleSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_BUNDLE_API_VERSION),
    kind: z.literal("CapabilityBundle"),
    metadata: bundleMetadataSchema,
    spec: z
      .object({
        packages: z.array(bundleEntrySchema).min(1).max(MAX_CAPABILITY_BUNDLE_PACKAGES),
      })
      .strict(),
  })
  .strict();

export interface CapabilityBundleVerifierPackage {
  readonly kind: "verifier-package";
  readonly name: string;
  readonly version: string;
  readonly manifestBase64: string;
}

export interface CapabilityBundleToolPackage {
  readonly kind: "tool-package";
  readonly name: string;
  readonly version: string;
  readonly toolName: string;
  readonly manifestBase64: string;
}

export interface CapabilityBundleWorkflowPackage {
  readonly kind: "workflow-package";
  readonly name: string;
  readonly version: string;
  readonly manifestBase64: string;
}

export interface CapabilityBundlePolicyPackage {
  readonly kind: "policy-package";
  readonly name: string;
  readonly version: string;
  readonly manifestBase64: string;
}

export interface CapabilityBundlePresentationPackage {
  readonly kind: "presentation-package";
  readonly name: string;
  readonly version: string;
  readonly manifestBase64: string;
}

export interface CapabilityBundleAgentSkillPackage {
  readonly kind: "agent-skill";
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly contentBase64: string;
  }[];
}

export type CapabilityBundlePackage =
  | CapabilityBundleAgentSkillPackage
  | CapabilityBundleVerifierPackage
  | CapabilityBundleToolPackage
  | CapabilityBundleWorkflowPackage
  | CapabilityBundlePolicyPackage
  | CapabilityBundlePresentationPackage;

export interface CapabilityBundle {
  readonly apiVersion: typeof CAPABILITY_BUNDLE_API_VERSION;
  readonly kind: "CapabilityBundle";
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly bytes: number;
  readonly digest: string;
  readonly packages: readonly CapabilityBundlePackage[];
}

export type CapabilityBundleSourcePackage =
  | {
      readonly kind: "agent-skill";
      readonly files: readonly {
        readonly path: string;
        readonly content: Uint8Array;
      }[];
    }
  | { readonly kind: "verifier-package"; readonly manifest: Uint8Array }
  | { readonly kind: "tool-package"; readonly manifest: Uint8Array }
  | { readonly kind: "workflow-package"; readonly manifest: Uint8Array }
  | { readonly kind: "policy-package"; readonly manifest: Uint8Array }
  | { readonly kind: "presentation-package"; readonly manifest: Uint8Array };

export interface CapabilityBundleSourceInput {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly packages: readonly CapabilityBundleSourcePackage[];
}

export interface CreatedCapabilityBundleSource {
  readonly content: Buffer;
  readonly bundle: CapabilityBundle;
}

type EncodedCapabilityBundleEntry = z.infer<typeof bundleEntrySchema>;

export function createCapabilityBundleSource(
  input: CapabilityBundleSourceInput,
): CreatedCapabilityBundleSource {
  const metadata = bundleMetadataSchema.parse({
    name: input.name,
    version: input.version,
    description: input.description,
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
  });
  const entries = input.packages.map(encodeSourcePackage);
  const packages = entries.map((entry) => ({ entry, parsed: parseBundlePackageEntry(entry) }));
  packages.sort((left, right) =>
    compareStrings(packageIdentityKey(left.parsed), packageIdentityKey(right.parsed)),
  );
  assertCanonicalPackageOrder(packages.map((item) => item.parsed));
  const content = Buffer.from(
    JSON.stringify({
      apiVersion: CAPABILITY_BUNDLE_API_VERSION,
      kind: "CapabilityBundle",
      metadata: {
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        ...(metadata.license === undefined ? {} : { license: metadata.license }),
        ...(metadata.compatibility === undefined ? {} : { compatibility: metadata.compatibility }),
      },
      spec: { packages: packages.map((item) => item.entry) },
    }),
  );
  return Object.freeze({ content, bundle: parseCapabilityBundle(content) });
}

export function parseCapabilityBundle(source: Uint8Array): CapabilityBundle {
  const content = Buffer.from(source);
  assertCapabilityBundleByteLength(content);
  return parseVerifiedCapabilityBundle(content, createHash("sha256").update(content).digest("hex"));
}

export function parseDigestPinnedCapabilityBundle(
  source: Uint8Array,
  expectedSha256: string,
): CapabilityBundle {
  assertCapabilityBundleSha256(expectedSha256);
  const content = Buffer.from(source);
  assertCapabilityBundleByteLength(content);
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `capability bundle digest mismatch: expected sha256:${expectedSha256}, received sha256:${actualSha256}`,
    );
  }
  return parseVerifiedCapabilityBundle(content, actualSha256);
}

export function assertCapabilityBundleSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("expected capability bundle SHA-256 must be 64 lowercase hexadecimal digits");
  }
}

function assertCapabilityBundleByteLength(content: Buffer): void {
  if (content.byteLength === 0 || content.byteLength > MAX_CAPABILITY_BUNDLE_BYTES) {
    throw new Error(
      `capability bundle must contain between 1 and ${MAX_CAPABILITY_BUNDLE_BYTES} bytes`,
    );
  }
}

function parseVerifiedCapabilityBundle(content: Buffer, sha256: string): CapabilityBundle {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error("capability bundle must be valid UTF-8", { cause: error });
  }
  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 16,
      maxNodes: 4_096,
      valueLabel: "capability bundle",
    });
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new Error(`capability bundle JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
  const parsed = bundleSchema.parse(input);
  const packages = parsed.spec.packages.map(parseBundlePackageEntry);
  const decodedBytes = parsed.spec.packages.reduce(
    (total, entry) =>
      total +
      (entry.kind === "agent-skill"
        ? entry.files.reduce(
            (packageTotal, file) => packageTotal + canonicalBase64ByteLength(file.contentBase64),
            0,
          )
        : canonicalBase64ByteLength(entry.manifestBase64)),
    0,
  );
  if (decodedBytes > MAX_CAPABILITY_BUNDLE_DECODED_BYTES) {
    throw new Error(
      `capability bundle decoded package content exceeds ${MAX_CAPABILITY_BUNDLE_DECODED_BYTES} bytes`,
    );
  }
  assertCanonicalPackageOrder(packages);
  return Object.freeze({
    apiVersion: parsed.apiVersion,
    kind: parsed.kind,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    description: parsed.metadata.description,
    ...(parsed.metadata.license === undefined ? {} : { license: parsed.metadata.license }),
    ...(parsed.metadata.compatibility === undefined
      ? {}
      : { compatibility: parsed.metadata.compatibility }),
    bytes: content.byteLength,
    digest: `sha256:${sha256}`,
    packages: Object.freeze(packages),
  });
}

function encodeSourcePackage(input: CapabilityBundleSourcePackage): EncodedCapabilityBundleEntry {
  if (input.kind === "agent-skill") {
    return {
      kind: input.kind,
      files: [...input.files]
        .sort((left, right) => compareStrings(left.path, right.path))
        .map((file) => ({
          path: file.path,
          contentBase64: Buffer.from(file.content).toString("base64"),
        })),
    };
  }
  return {
    kind: input.kind,
    manifestBase64: Buffer.from(input.manifest).toString("base64"),
  };
}

function parseBundlePackageEntry(entry: EncodedCapabilityBundleEntry): CapabilityBundlePackage {
  if (entry.kind === "agent-skill") {
    return parseBundledAgentSkill(entry.files);
  }
  if (entry.kind === "verifier-package") {
    const manifest = decodeCanonicalBase64(
      entry.manifestBase64,
      MAX_VERIFIER_PACKAGE_MANIFEST_BYTES,
      "bundled verifier package manifest",
    );
    const definition = parseVerifierPackageManifest(manifest, "bundled verifier package manifest");
    return Object.freeze({
      kind: entry.kind,
      name: definition.metadata.name,
      version: definition.metadata.version,
      manifestBase64: entry.manifestBase64,
    });
  }
  if (entry.kind === "workflow-package") {
    const manifest = decodeCanonicalBase64(
      entry.manifestBase64,
      MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES,
      "bundled workflow package manifest",
    );
    const definition = parseWorkflowPackageManifest(manifest, "bundled workflow package manifest");
    return Object.freeze({
      kind: entry.kind,
      name: definition.metadata.name,
      version: definition.metadata.version,
      manifestBase64: entry.manifestBase64,
    });
  }
  if (entry.kind === "policy-package") {
    const manifest = decodeCanonicalBase64(
      entry.manifestBase64,
      MAX_POLICY_PACKAGE_MANIFEST_BYTES,
      "bundled policy package manifest",
    );
    const definition = parsePolicyPackageManifest(manifest, "bundled policy package manifest");
    return Object.freeze({
      kind: entry.kind,
      name: definition.metadata.name,
      version: definition.metadata.version,
      manifestBase64: entry.manifestBase64,
    });
  }
  if (entry.kind === "presentation-package") {
    const manifest = decodeCanonicalBase64(
      entry.manifestBase64,
      MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES,
      "bundled presentation package manifest",
    );
    const definition = parsePresentationPackageManifest(manifest);
    return Object.freeze({
      kind: entry.kind,
      name: definition.metadata.name,
      version: definition.metadata.version,
      manifestBase64: entry.manifestBase64,
    });
  }
  const manifest = decodeCanonicalBase64(
    entry.manifestBase64,
    MAX_TOOL_PACKAGE_MANIFEST_BYTES,
    "bundled tool package manifest",
  );
  const definition = parseToolPackageManifest(manifest, "bundled tool package manifest");
  return Object.freeze({
    kind: entry.kind,
    name: definition.metadata.name,
    version: definition.metadata.version,
    toolName: definition.spec.tool.name,
    manifestBase64: entry.manifestBase64,
  });
}

function parseBundledAgentSkill(
  files: readonly { readonly path: string; readonly contentBase64: string }[],
): CapabilityBundleAgentSkillPackage {
  let packageBytes = 0;
  let previousPath: string | undefined;
  let manifest: Buffer | undefined;
  for (const file of files) {
    if (!isPortableRelativePath(file.path)) {
      throw new Error(`bundled Agent Skill path "${file.path}" is not portable`);
    }
    if (previousPath !== undefined && previousPath >= file.path) {
      throw new Error(
        previousPath === file.path
          ? `bundled Agent Skill has duplicate path "${file.path}"`
          : "bundled Agent Skill files must use canonical path order",
      );
    }
    previousPath = file.path;
    const content = decodeCanonicalBase64(
      file.contentBase64,
      MAX_AGENT_SKILL_FILE_BYTES,
      `bundled Agent Skill file "${file.path}"`,
      true,
    );
    packageBytes += content.byteLength;
    if (packageBytes > MAX_AGENT_SKILL_PACKAGE_BYTES) {
      throw new Error(`bundled Agent Skill exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} decoded bytes`);
    }
    if (file.path === "SKILL.md") {
      manifest = content;
    }
  }
  if (manifest === undefined) {
    throw new Error("bundled Agent Skill is missing SKILL.md");
  }
  const parsed = parseAgentSkillManifest(manifest, "bundled Agent Skill");
  return Object.freeze({
    kind: "agent-skill",
    name: parsed.name,
    description: parsed.description,
    ...(parsed.license === undefined ? {} : { license: parsed.license }),
    ...(parsed.compatibility === undefined ? {} : { compatibility: parsed.compatibility }),
    metadata: parsed.metadata,
    requestedTools: parsed.requestedTools,
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
  });
}

function decodeCanonicalBase64(
  value: string,
  maximumBytes: number,
  label: string,
  allowEmpty = false,
): Buffer {
  const content = Buffer.from(value, "base64");
  if (
    (!allowEmpty && content.byteLength === 0) ||
    content.byteLength > maximumBytes ||
    content.toString("base64") !== value
  ) {
    throw new Error(`${label} must use bounded canonical base64`);
  }
  return content;
}

function canonicalBase64ByteLength(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function capabilityPackageFamilyKind<TKind extends CapabilityPackageFamilyKind>(
  kind: TKind,
): TKind {
  if (!CAPABILITY_PACKAGE_FAMILY_REFERENCES.some((item) => item.kind === kind)) {
    throw new Error(`unsupported capability package family "${kind}"`);
  }
  return kind;
}

function assertCanonicalPackageOrder(packages: readonly CapabilityBundlePackage[]): void {
  let previous: string | undefined;
  for (const item of packages) {
    const key = packageIdentityKey(item);
    if (previous === key) {
      throw new Error(
        `duplicate contained package identity "${item.kind}:${item.name}${"version" in item ? `@${item.version}` : ""}"`,
      );
    }
    if (previous !== undefined && previous > key) {
      throw new Error("contained packages must use canonical identity order");
    }
    previous = key;
  }
}

function packageIdentityKey(item: CapabilityBundlePackage): string {
  return `${item.kind}\0${item.name}\0${"version" in item ? item.version : ""}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalMetadataTextSchema(maximumLength: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace");
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
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
