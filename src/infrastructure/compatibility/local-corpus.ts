import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import {
  type CompatibilityArtifactSource,
  CompatibilityCorpusError,
  type CompatibilityCorpusManifest,
  MAX_COMPATIBILITY_ARTIFACT_BYTES,
  parseCompatibilityCorpusManifest,
} from "../../domain/compatibility/check.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const MAX_COMPATIBILITY_MANIFEST_BYTES = 256 * 1024;

export type LocalCompatibilityCorpusErrorCode =
  | "artifact_identity_mismatch"
  | "corpus_malformed"
  | "corpus_missing"
  | "resource_limit"
  | "unsupported_corpus";

export class LocalCompatibilityCorpusError extends Error {
  override readonly name = "LocalCompatibilityCorpusError";

  constructor(
    readonly code: LocalCompatibilityCorpusErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LoadedCompatibilityCorpus {
  readonly corpusSha256: string;
  readonly manifest: CompatibilityCorpusManifest;
  readonly sources: ReadonlyMap<string, CompatibilityArtifactSource>;
}

export async function loadLocalCompatibilityCorpus(
  rootDirectory: string,
): Promise<LoadedCompatibilityCorpus> {
  const rootBefore = await observeCorpusDirectory(rootDirectory);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readBoundedNoFollow(
      join(rootDirectory, "manifest.json"),
      MAX_COMPATIBILITY_MANIFEST_BYTES,
    );
  } catch (error) {
    throw manifestReadError(error);
  }

  let manifest: CompatibilityCorpusManifest;
  try {
    const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes), {
      maxDepth: 16,
      maxNodes: 16_384,
      valueLabel: "compatibility corpus",
    });
    manifest = parseCompatibilityCorpusManifest(value);
  } catch (error) {
    if (error instanceof CompatibilityCorpusError && error.code === "unsupported_corpus") {
      throw new LocalCompatibilityCorpusError(error.code, error.message);
    }
    throw new LocalCompatibilityCorpusError(
      "corpus_malformed",
      "compatibility corpus is malformed",
    );
  }

  const sources = new Map<string, CompatibilityArtifactSource>();
  for (const artifact of manifest.artifacts) {
    try {
      sources.set(
        artifact.path,
        await readBoundedNoFollow(
          join(rootDirectory, ...artifact.path.split("/")),
          MAX_COMPATIBILITY_ARTIFACT_BYTES,
        ),
      );
    } catch (error) {
      sources.set(artifact.path, { category: artifactReadCategory(error) });
    }
  }

  const rootAfter = await observeCorpusDirectory(rootDirectory);
  if (!sameObservation(rootBefore, rootAfter)) {
    throw new LocalCompatibilityCorpusError(
      "artifact_identity_mismatch",
      "compatibility corpus changed during read",
    );
  }
  return {
    corpusSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifest,
    sources,
  };
}

async function observeCorpusDirectory(path: string): Promise<BigIntStats> {
  try {
    const observation = await lstat(path, { bigint: true });
    if (!observation.isDirectory() || observation.isSymbolicLink()) {
      throw new LocalCompatibilityCorpusError(
        "corpus_malformed",
        "compatibility corpus is malformed",
      );
    }
    return observation;
  } catch (error) {
    if (error instanceof LocalCompatibilityCorpusError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new LocalCompatibilityCorpusError("corpus_missing", "compatibility corpus is missing");
    }
    throw new LocalCompatibilityCorpusError(
      "corpus_malformed",
      "compatibility corpus is malformed",
    );
  }
}

type CorpusReadErrorCode = "changed" | "malformed" | "missing" | "resource_limit";

class CorpusReadError extends Error {
  constructor(readonly code: CorpusReadErrorCode) {
    super(code);
  }
}

async function readBoundedNoFollow(path: string, maximumBytes: number): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new CorpusReadError("missing");
    throw new CorpusReadError("malformed");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n) throw new CorpusReadError("malformed");
    if (before.size > BigInt(maximumBytes)) throw new CorpusReadError("resource_limit");

    const allocation = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < allocation.byteLength) {
      const { bytesRead } = await handle.read(
        allocation,
        offset,
        allocation.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new CorpusReadError("resource_limit");

    const after = await handle.stat({ bigint: true });
    if (offset !== Number(before.size) || !sameObservation(before, after)) {
      throw new CorpusReadError("changed");
    }
    return allocation.subarray(0, offset);
  } catch (error) {
    if (error instanceof CorpusReadError) throw error;
    throw new CorpusReadError("malformed");
  } finally {
    await handle.close();
  }
}

function manifestReadError(error: unknown): LocalCompatibilityCorpusError {
  if (error instanceof CorpusReadError) {
    if (error.code === "missing") {
      return new LocalCompatibilityCorpusError("corpus_missing", "compatibility corpus is missing");
    }
    if (error.code === "resource_limit") {
      return new LocalCompatibilityCorpusError(
        "resource_limit",
        "compatibility corpus exceeds its resource limit",
      );
    }
    if (error.code === "changed") {
      return new LocalCompatibilityCorpusError(
        "artifact_identity_mismatch",
        "compatibility corpus changed during read",
      );
    }
  }
  return new LocalCompatibilityCorpusError("corpus_malformed", "compatibility corpus is malformed");
}

function artifactReadCategory(
  error: unknown,
): "artifact_identity_mismatch" | "artifact_malformed" | "resource_limit" | "source_missing" {
  if (!(error instanceof CorpusReadError)) return "artifact_malformed";
  if (error.code === "missing") return "source_missing";
  if (error.code === "resource_limit") return "resource_limit";
  if (error.code === "changed") return "artifact_identity_mismatch";
  return "artifact_malformed";
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
