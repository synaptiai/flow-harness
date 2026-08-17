import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  type EffectiveHarnessCandidateArtifact,
  MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
  parseEffectiveHarnessCandidateArtifact,
} from "../../domain/adaptation/effective-harness-candidate.js";
import { parseStrictJson } from "../../domain/strict-json.js";

export interface AdmittedLocalEffectiveHarnessCandidate {
  readonly provenance: string;
  readonly sourceSha256: string;
  readonly artifact: EffectiveHarnessCandidateArtifact;
}

export interface LocalEffectiveHarnessCandidateOptions {
  readonly signal?: AbortSignal | undefined;
  /** @internal Exact source identity captured by a stable discriminator read. */
  readonly expectedSource?: { readonly identity: BigIntStats; readonly sha256: string } | undefined;
  /** @internal Deterministic cancellation and source-race seam. */
  readonly afterRead?: () => void | Promise<void>;
}

export type LocalEffectiveHarnessCandidateErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalEffectiveHarnessCandidateError extends Error {
  override readonly name = "LocalEffectiveHarnessCandidateError";

  constructor(
    readonly code: LocalEffectiveHarnessCandidateErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function admitLocalEffectiveHarnessCandidate(
  candidatePath: string,
  options: LocalEffectiveHarnessCandidateOptions = {},
): Promise<AdmittedLocalEffectiveHarnessCandidate> {
  options.signal?.throwIfAborted();
  const absolutePath = resolve(candidatePath);
  let lexical: BigIntStats;
  try {
    lexical = await lstat(absolutePath, { bigint: true });
  } catch {
    options.signal?.throwIfAborted();
    throw new LocalEffectiveHarnessCandidateError(
      "invalid_path",
      "effective harness candidate source is unavailable",
    );
  }
  options.signal?.throwIfAborted();
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new LocalEffectiveHarnessCandidateError(
      "invalid_path",
      "effective harness candidate source must be a regular file without links",
    );
  }
  if (
    options.expectedSource !== undefined &&
    !sameIdentity(options.expectedSource.identity, lexical)
  ) {
    throw new LocalEffectiveHarnessCandidateError(
      "source_changed",
      "effective harness candidate source changed before it was reopened",
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    options.signal?.throwIfAborted();
    throw new LocalEffectiveHarnessCandidateError(
      "invalid_path",
      "effective harness candidate source cannot be opened without links",
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    if (!before.isFile()) {
      throw new LocalEffectiveHarnessCandidateError(
        "invalid_path",
        "effective harness candidate source is not a regular file",
      );
    }
    if (before.size > BigInt(MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES)) {
      throw new LocalEffectiveHarnessCandidateError(
        "limit_exceeded",
        "effective harness candidate source exceeds its byte limit",
      );
    }
    const content = await readBounded(handle, options.signal);
    const after = await handle.stat({ bigint: true });
    options.signal?.throwIfAborted();
    if (BigInt(content.byteLength) !== before.size || !sameIdentity(before, after)) {
      throw new LocalEffectiveHarnessCandidateError(
        "source_changed",
        "effective harness candidate source changed while it was read",
      );
    }
    const sourceSha256 = createHash("sha256").update(content).digest("hex");
    if (options.expectedSource !== undefined && options.expectedSource.sha256 !== sourceSha256) {
      throw new LocalEffectiveHarnessCandidateError(
        "source_changed",
        "effective harness candidate source changed while it was reopened",
      );
    }
    await options.afterRead?.();
    options.signal?.throwIfAborted();
    let raw: unknown;
    try {
      raw = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(content), {
        maxDepth: 32,
        maxNodes: 500_000,
        valueLabel: "effective harness candidate",
      });
    } catch {
      throw new LocalEffectiveHarnessCandidateError(
        "invalid_source",
        "effective harness candidate source is invalid",
      );
    }
    let artifact: EffectiveHarnessCandidateArtifact;
    try {
      artifact = parseEffectiveHarnessCandidateArtifact(raw);
    } catch {
      throw new LocalEffectiveHarnessCandidateError(
        "invalid_source",
        "effective harness candidate source is invalid",
      );
    }
    return Object.freeze({
      provenance: basename(absolutePath),
      sourceSha256,
      artifact,
    });
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES) {
    throw new LocalEffectiveHarnessCandidateError(
      "limit_exceeded",
      "effective harness candidate source exceeds its byte limit",
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
