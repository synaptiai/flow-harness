import { createHash } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../strict-json.js";
import {
  type SigstoreCapabilityPublisherPolicy,
  validateSigstoreCapabilityPublisherPolicy,
} from "./sigstore-capability-verifier.js";
import { verifierPackageNameSchema, verifierPackageVersionSchema } from "./verifier-packages.js";

export const CAPABILITY_REPOSITORY_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const CAPABILITY_REPOSITORY_INDEX_KIND = "CapabilityRepositoryIndex" as const;
export const CAPABILITY_PACKAGE_TARGET_KIND = "CapabilityPackageTarget" as const;
export const MAX_CAPABILITY_REPOSITORY_INDEX_BYTES = 512 * 1024;
export const MAX_CAPABILITY_REPOSITORY_INDEX_ENTRIES = 64;
export const MAX_CAPABILITY_REPOSITORY_TARGET_PATH_BYTES = 1_024;

const targetPathSchema = z
  .string()
  .min(1)
  .max(MAX_CAPABILITY_REPOSITORY_TARGET_PATH_BYTES)
  .refine(isCanonicalPackageTargetPath);
const indexEntrySchema = z
  .object({
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    targetPath: targetPathSchema,
  })
  .strict();
const indexSchema = z
  .object({
    apiVersion: z.literal(CAPABILITY_REPOSITORY_API_VERSION),
    kind: z.literal(CAPABILITY_REPOSITORY_INDEX_KIND),
    packages: z.array(indexEntrySchema).max(MAX_CAPABILITY_REPOSITORY_INDEX_ENTRIES),
  })
  .strict();
const targetCustomSchema = z
  .object({
    flow: z
      .object({
        apiVersion: z.literal(CAPABILITY_REPOSITORY_API_VERSION),
        kind: z.literal(CAPABILITY_PACKAGE_TARGET_KIND),
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        publisher: z
          .object({
            certificateIssuer: z.string().min(1).max(2_048),
            certificateIdentity: z.string().min(1).max(4_096),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type CapabilityRepositoryStage =
  | "bound index"
  | "parse index"
  | "validate index"
  | "validate target custom metadata";

export class CapabilityRepositoryError extends Error {
  override readonly name = "CapabilityRepositoryError";
  readonly code = "capability_repository_failed" as const;

  constructor(readonly stage: CapabilityRepositoryStage) {
    super(`Capability repository failed during ${stage}`);
  }
}

export interface CapabilityRepositoryIndexEntry {
  readonly name: string;
  readonly version: string;
  readonly targetPath: string;
}

export interface CapabilityRepositoryIndex {
  readonly apiVersion: typeof CAPABILITY_REPOSITORY_API_VERSION;
  readonly kind: typeof CAPABILITY_REPOSITORY_INDEX_KIND;
  readonly bytes: number;
  readonly digest: `sha256:${string}`;
  readonly packages: readonly CapabilityRepositoryIndexEntry[];
}

export interface CapabilityPackageTargetCustom {
  readonly apiVersion: typeof CAPABILITY_REPOSITORY_API_VERSION;
  readonly kind: typeof CAPABILITY_PACKAGE_TARGET_KIND;
  readonly name: string;
  readonly version: string;
  readonly publisher: SigstoreCapabilityPublisherPolicy;
}

export function encodeCapabilityRepositoryIndex(input: {
  readonly packages: readonly CapabilityRepositoryIndexEntry[];
}): Buffer {
  try {
    const parsed = indexSchema.parse({
      apiVersion: CAPABILITY_REPOSITORY_API_VERSION,
      kind: CAPABILITY_REPOSITORY_INDEX_KIND,
      packages: input.packages.map((entry) => ({ ...entry })),
    });
    assertCanonicalIndexEntries(parsed.packages);
    const content = canonicalIndexBytes(parsed);
    if (content.byteLength > MAX_CAPABILITY_REPOSITORY_INDEX_BYTES) {
      throw new Error("index exceeds byte limit");
    }
    return content;
  } catch {
    throw new CapabilityRepositoryError("validate index");
  }
}

export function parseCapabilityRepositoryIndex(source: Uint8Array): CapabilityRepositoryIndex {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > MAX_CAPABILITY_REPOSITORY_INDEX_BYTES) {
    throw new CapabilityRepositoryError("bound index");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new CapabilityRepositoryError("parse index");
  }

  let input: unknown;
  try {
    input = parseStrictJson(text, {
      maxDepth: 5,
      maxNodes: 512,
      valueLabel: "capability repository index",
    });
  } catch {
    throw new CapabilityRepositoryError("parse index");
  }

  try {
    const parsed = indexSchema.parse(input);
    assertCanonicalIndexEntries(parsed.packages);
    if (!content.equals(canonicalIndexBytes(parsed))) {
      throw new Error("index is not canonical");
    }
    return deepFreeze({
      apiVersion: parsed.apiVersion,
      kind: parsed.kind,
      bytes: content.byteLength,
      digest: sha256(content),
      packages: parsed.packages.map((entry) => ({ ...entry })),
    });
  } catch {
    throw new CapabilityRepositoryError("validate index");
  }
}

export function parseCapabilityPackageTargetCustom(input: unknown): CapabilityPackageTargetCustom {
  try {
    const parsed = targetCustomSchema.parse(input).flow;
    const publisher = validateSigstoreCapabilityPublisherPolicy(parsed.publisher);
    return deepFreeze({
      apiVersion: parsed.apiVersion,
      kind: parsed.kind,
      name: parsed.name,
      version: parsed.version,
      publisher,
    });
  } catch {
    throw new CapabilityRepositoryError("validate target custom metadata");
  }
}

function canonicalIndexBytes(index: z.infer<typeof indexSchema>): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: index.apiVersion,
      kind: index.kind,
      packages: index.packages.map((entry) => ({
        name: entry.name,
        version: entry.version,
        targetPath: entry.targetPath,
      })),
    }),
  );
}

function assertCanonicalIndexEntries(entries: readonly z.infer<typeof indexEntrySchema>[]): void {
  const targetPaths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (current === undefined || targetPaths.has(current.targetPath)) {
      throw new Error("duplicate target path");
    }
    targetPaths.add(current.targetPath);
    if (index > 0) {
      const previous = entries[index - 1];
      if (previous === undefined || compareIndexEntries(previous, current) >= 0) {
        throw new Error("index entries must be sorted and unique");
      }
    }
  }
}

function compareIndexEntries(
  left: Pick<CapabilityRepositoryIndexEntry, "name" | "version">,
  right: Pick<CapabilityRepositoryIndexEntry, "name" | "version">,
): number {
  const leftKey = `${left.name}\0${left.version}`;
  const rightKey = `${right.name}\0${right.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isCanonicalPackageTargetPath(path: string): boolean {
  if (
    Buffer.byteLength(path, "utf8") > MAX_CAPABILITY_REPOSITORY_TARGET_PATH_BYTES ||
    path.includes("\\") ||
    path.includes("%") ||
    !path.startsWith("flow/packages/") ||
    !path.endsWith(".flowpkg.json")
  ) {
    return false;
  }
  const segments = path.split("/");
  return (
    segments.length >= 4 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(segment),
    )
  );
}

function sha256(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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
