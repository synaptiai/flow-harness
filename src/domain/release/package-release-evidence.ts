import { z } from "zod";
import { verifierPackageVersionSchema } from "../capability/verifier-packages.js";
import { parseStrictJson } from "../strict-json.js";

export const PACKAGE_RELEASE_EVIDENCE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const FLOW_PACKAGE_NAME = "@synaptiai/flow-harness" as const;
export const FLOW_PACKAGE_REPOSITORY = "https://github.com/synaptiai/flow-harness" as const;
export const MAX_PACKAGE_RELEASE_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_PACKAGE_RELEASE_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_RELEASE_UNPACKED_BYTES = 64 * 1024 * 1024;
export const MAX_PACKAGE_RELEASE_FILES = 4_096;
export const MAX_PACKAGE_RELEASE_PATH_BYTES = 1_024;

const ROOT_PACKAGE_FILES = new Set([
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "npm-shrinkwrap.json",
  "package.json",
]);
const PACKAGE_FILE_PATHS = new Set([...ROOT_PACKAGE_FILES, "scripts/prepare-proof-runtime.mjs"]);
const PACKAGE_DIRECTORY_PREFIXES = [
  "dist/",
  "docs/",
  "examples/",
  "prime-container/",
  "proof-container/",
] as const;
const REQUIRED_PACKAGE_FILES = [
  ...ROOT_PACKAGE_FILES,
  "dist/cli/launcher.js",
  "examples/verify-foundation.workflow.yaml",
] as const;

const packageVersionSchema = verifierPackageVersionSchema.refine(
  (value) => !value.includes("+"),
  "npm package versions must not contain build metadata",
);
const fileSchema = z
  .object({
    path: z.string().min(1).max(MAX_PACKAGE_RELEASE_PATH_BYTES),
    bytes: z.number().int().nonnegative().max(MAX_PACKAGE_RELEASE_UNPACKED_BYTES),
    mode: z.literal(0o644),
  })
  .strict();
const evidenceSchema = z
  .object({
    apiVersion: z.literal(PACKAGE_RELEASE_EVIDENCE_API_VERSION),
    kind: z.literal("PackageReleaseEvidence"),
    packageName: z.literal(FLOW_PACKAGE_NAME),
    packageVersion: packageVersionSchema,
    sourceRepository: z.literal(FLOW_PACKAGE_REPOSITORY),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    archive: z
      .object({
        fileName: z.string().min(1).max(256),
        bytes: z.number().int().positive().max(MAX_PACKAGE_RELEASE_ARCHIVE_BYTES),
        unpackedBytes: z.number().int().positive().max(MAX_PACKAGE_RELEASE_UNPACKED_BYTES),
        entryCount: z.number().int().positive().max(MAX_PACKAGE_RELEASE_FILES),
        sha512: z.string().regex(/^[a-f0-9]{128}$/),
      })
      .strict(),
    files: z.array(fileSchema).min(1).max(MAX_PACKAGE_RELEASE_FILES),
  })
  .strict();

export type PackageReleaseEvidenceStage = "parse evidence" | "validate evidence";

export class PackageReleaseEvidenceError extends Error {
  override readonly name = "PackageReleaseEvidenceError";
  readonly code = "package_release_failed" as const;

  constructor(readonly stage: PackageReleaseEvidenceStage) {
    super(`Package release failed during ${stage}`);
  }
}

export interface PackageReleaseEvidenceFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: 0o644;
}

export interface PackageReleaseEvidenceInput {
  readonly apiVersion: typeof PACKAGE_RELEASE_EVIDENCE_API_VERSION;
  readonly kind: "PackageReleaseEvidence";
  readonly packageName: typeof FLOW_PACKAGE_NAME;
  readonly packageVersion: string;
  readonly sourceRepository: typeof FLOW_PACKAGE_REPOSITORY;
  readonly sourceRevision: string;
  readonly archive: {
    readonly fileName: string;
    readonly bytes: number;
    readonly unpackedBytes: number;
    readonly entryCount: number;
    readonly sha512: string;
  };
  readonly files: readonly PackageReleaseEvidenceFile[];
}

export type PackageReleaseEvidence = PackageReleaseEvidenceInput;

export function encodePackageReleaseEvidence(input: PackageReleaseEvidenceInput): Buffer {
  try {
    const evidence = validateEvidence(evidenceSchema.parse(input));
    const encoded = canonicalEvidenceBytes(evidence);
    if (encoded.byteLength > MAX_PACKAGE_RELEASE_EVIDENCE_BYTES) {
      throw new Error("release evidence exceeds its byte limit");
    }
    return encoded;
  } catch (error) {
    if (error instanceof PackageReleaseEvidenceError) {
      throw error;
    }
    throw new PackageReleaseEvidenceError("validate evidence");
  }
}

export function parsePackageReleaseEvidence(source: Uint8Array): PackageReleaseEvidence {
  const content = Buffer.from(source);
  if (content.byteLength < 1 || content.byteLength > MAX_PACKAGE_RELEASE_EVIDENCE_BYTES) {
    throw new PackageReleaseEvidenceError("parse evidence");
  }

  let input: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    input = parseStrictJson(text, {
      maxDepth: 8,
      maxNodes: 32_768,
      valueLabel: "package release evidence",
    });
  } catch {
    throw new PackageReleaseEvidenceError("parse evidence");
  }

  try {
    const evidence = validateEvidence(evidenceSchema.parse(input));
    if (!content.equals(canonicalEvidenceBytes(evidence))) {
      throw new Error("release evidence must use its canonical encoding");
    }
    return deepFreeze(toEvidence(evidence));
  } catch (error) {
    if (error instanceof PackageReleaseEvidenceError) {
      throw error;
    }
    throw new PackageReleaseEvidenceError("validate evidence");
  }
}

function validateEvidence(
  evidence: z.infer<typeof evidenceSchema>,
): z.infer<typeof evidenceSchema> {
  const expectedFileName = `synaptiai-flow-harness-${evidence.packageVersion}.tgz`;
  if (evidence.archive.fileName !== expectedFileName) {
    throw new Error("archive name does not match the package version");
  }
  if (evidence.archive.entryCount !== evidence.files.length) {
    throw new Error("archive entry count does not match the file manifest");
  }

  let unpackedBytes = 0;
  let previousPath: string | undefined;
  const paths = new Set<string>();
  for (const file of evidence.files) {
    if (!isAdmittedPackagePath(file.path)) {
      throw new Error("package file path is outside the release boundary");
    }
    if (previousPath !== undefined && comparePath(previousPath, file.path) >= 0) {
      throw new Error("package file paths are not unique and ordered");
    }
    previousPath = file.path;
    paths.add(file.path);
    unpackedBytes += file.bytes;
  }
  if (unpackedBytes !== evidence.archive.unpackedBytes) {
    throw new Error("unpacked byte total does not match the file manifest");
  }
  for (const requiredPath of REQUIRED_PACKAGE_FILES) {
    if (!paths.has(requiredPath)) {
      throw new Error("package file manifest is incomplete");
    }
  }
  return evidence;
}

function canonicalEvidenceBytes(evidence: z.infer<typeof evidenceSchema>): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: evidence.apiVersion,
      kind: evidence.kind,
      packageName: evidence.packageName,
      packageVersion: evidence.packageVersion,
      sourceRepository: evidence.sourceRepository,
      sourceRevision: evidence.sourceRevision,
      archive: {
        fileName: evidence.archive.fileName,
        bytes: evidence.archive.bytes,
        unpackedBytes: evidence.archive.unpackedBytes,
        entryCount: evidence.archive.entryCount,
        sha512: evidence.archive.sha512,
      },
      files: evidence.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        mode: file.mode,
      })),
    }),
  );
}

function toEvidence(evidence: z.infer<typeof evidenceSchema>): PackageReleaseEvidence {
  return {
    apiVersion: evidence.apiVersion,
    kind: evidence.kind,
    packageName: evidence.packageName,
    packageVersion: evidence.packageVersion,
    sourceRepository: evidence.sourceRepository,
    sourceRevision: evidence.sourceRevision,
    archive: {
      fileName: evidence.archive.fileName,
      bytes: evidence.archive.bytes,
      unpackedBytes: evidence.archive.unpackedBytes,
      entryCount: evidence.archive.entryCount,
      sha512: evidence.archive.sha512,
    },
    files: evidence.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      mode: file.mode,
    })),
  };
}

function isAdmittedPackagePath(path: string): boolean {
  if (
    Buffer.byteLength(path, "utf8") > MAX_PACKAGE_RELEASE_PATH_BYTES ||
    path.normalize("NFC") !== path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/")
  ) {
    return false;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        [...segment].some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && (point <= 31 || point === 127);
        }),
    )
  ) {
    return false;
  }
  return (
    PACKAGE_FILE_PATHS.has(path) ||
    PACKAGE_DIRECTORY_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
