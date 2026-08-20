import { createHash } from "node:crypto";

import { z } from "zod";

import {
  encodePackageReleaseEvidence,
  FLOW_PACKAGE_NAME,
  FLOW_PACKAGE_REPOSITORY,
  MAX_PACKAGE_RELEASE_ARCHIVE_BYTES,
  MAX_PACKAGE_RELEASE_FILES,
  MAX_PACKAGE_RELEASE_PATH_BYTES,
  MAX_PACKAGE_RELEASE_UNPACKED_BYTES,
} from "../../domain/release/package-release-evidence.js";

const packFileSchema = z
  .object({
    path: z.string().min(1).max(MAX_PACKAGE_RELEASE_PATH_BYTES),
    size: z.number().int().nonnegative().max(MAX_PACKAGE_RELEASE_UNPACKED_BYTES),
    mode: z.literal(0o644),
  })
  .strict();
const packReportSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.literal(FLOW_PACKAGE_NAME),
    version: z.string().min(1).max(128),
    size: z.number().int().positive().max(MAX_PACKAGE_RELEASE_ARCHIVE_BYTES),
    unpackedSize: z.number().int().positive().max(MAX_PACKAGE_RELEASE_UNPACKED_BYTES),
    shasum: z.string().regex(/^[a-f0-9]{40}$/),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    filename: z.string().min(1).max(256),
    files: z.array(packFileSchema).min(1).max(MAX_PACKAGE_RELEASE_FILES),
    entryCount: z.number().int().positive().max(MAX_PACKAGE_RELEASE_FILES),
    bundled: z.array(z.never()).max(0),
  })
  .strict();
const packOutputSchema = z.array(packReportSchema).length(1);

export class PackageReleaseArtifactError extends Error {
  override readonly name = "PackageReleaseArtifactError";
  readonly code = "package_release_failed" as const;

  constructor() {
    super("Package release failed during inspect packed artifact");
  }
}

export interface PreparePackageReleaseEvidenceInput {
  readonly archive: Uint8Array;
  readonly packOutput: unknown;
  readonly sourceRevision: string;
}

export function preparePackageReleaseEvidence(input: PreparePackageReleaseEvidenceInput): Buffer {
  try {
    const output = packOutputSchema.parse(input.packOutput);
    const report = output[0];
    if (report === undefined) {
      throw new Error("npm pack did not produce one report");
    }
    const archive = Buffer.from(input.archive);
    if (
      report.id !== `${report.name}@${report.version}` ||
      report.size !== archive.byteLength ||
      report.shasum !== createHash("sha1").update(archive).digest("hex") ||
      report.integrity !== `sha512-${createHash("sha512").update(archive).digest("base64")}`
    ) {
      throw new Error("npm pack report does not match the archive");
    }
    const files = [...report.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    return encodePackageReleaseEvidence({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PackageReleaseEvidence",
      packageName: FLOW_PACKAGE_NAME,
      packageVersion: report.version,
      sourceRepository: FLOW_PACKAGE_REPOSITORY,
      sourceRevision: input.sourceRevision,
      archive: {
        fileName: report.filename,
        bytes: report.size,
        unpackedBytes: report.unpackedSize,
        entryCount: report.entryCount,
        sha512: createHash("sha512").update(archive).digest("hex"),
      },
      files: files.map((file) => ({
        path: file.path,
        bytes: file.size,
        mode: file.mode,
      })),
    });
  } catch (error) {
    if (error instanceof PackageReleaseArtifactError) {
      throw error;
    }
    throw new PackageReleaseArtifactError();
  }
}
