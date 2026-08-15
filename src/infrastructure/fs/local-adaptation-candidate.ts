import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { MAX_AGENT_SKILL_CANDIDATE_BYTES } from "../../domain/adaptation/agent-skill-candidate.js";
import { MAX_PROMPT_CANDIDATE_BYTES } from "../../domain/adaptation/prompt-candidate.js";
import {
  type AdmittedLocalAgentSkillCandidate,
  admitLocalAgentSkillCandidate,
} from "./local-agent-skill-candidate.js";
import {
  type AdmittedLocalPromptCandidate,
  admitLocalPromptCandidate,
} from "./local-prompt-candidate.js";

const MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES = Math.max(
  MAX_AGENT_SKILL_CANDIDATE_BYTES,
  MAX_PROMPT_CANDIDATE_BYTES,
);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type AdmittedLocalAdaptationCandidate =
  | {
      readonly kind: "prompt-candidate";
      readonly candidate: AdmittedLocalPromptCandidate;
    }
  | {
      readonly kind: "agent-skill-candidate";
      readonly candidate: AdmittedLocalAgentSkillCandidate;
    };

export interface LocalAdaptationCandidateOptions {
  readonly signal?: AbortSignal;
  /** @internal Deterministic discriminator race and cancellation seam. */
  readonly afterDiscriminatorStat?: () => void | Promise<void>;
  /** @internal Deterministic nested-admission cancellation seam. */
  readonly afterAgentSkillPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic nested prompt-candidate cancellation seam. */
  readonly afterPromptPathValidation?: (provenance: string) => void | Promise<void>;
}

export async function admitLocalAdaptationCandidate(
  candidatePath: string,
  options: LocalAdaptationCandidateOptions = {},
): Promise<AdmittedLocalAdaptationCandidate> {
  const absolutePath = resolve(candidatePath);
  options.signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error("candidate discriminator source cannot be opened without links", {
      cause: error,
    });
  }
  let source: string;
  let sourceIdentity: BigIntStats;
  let sourceSha256: string;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES)) {
      throw new Error("candidate discriminator source is not an admitted regular file");
    }
    await options.afterDiscriminatorStat?.();
    options.signal?.throwIfAborted();
    const content = await readBoundedDiscriminator(handle, options.signal);
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(content.byteLength) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("candidate discriminator source changed while it was read");
    }
    try {
      source = fatalUtf8Decoder.decode(content);
    } catch {
      throw new Error("candidate discriminator source is not UTF-8");
    }
    sourceIdentity = before;
    sourceSha256 = createHash("sha256").update(content).digest("hex");
  } finally {
    await handle.close();
  }
  options.signal?.throwIfAborted();
  const kind = parseCandidateKind(source);
  if (kind === "AgentSkillCandidate") {
    const candidate = await admitLocalAgentSkillCandidate(absolutePath, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.afterAgentSkillPathValidation === undefined
        ? {}
        : { afterPathValidation: options.afterAgentSkillPathValidation }),
      expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
    });
    return Object.freeze({ kind: "agent-skill-candidate", candidate });
  }
  const candidate = await admitLocalPromptCandidate(absolutePath, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.afterPromptPathValidation === undefined
      ? {}
      : { afterPathValidation: options.afterPromptPathValidation }),
    expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
  });
  options.signal?.throwIfAborted();
  return Object.freeze({ kind: "prompt-candidate", candidate });
}

async function readBoundedDiscriminator(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    signal?.throwIfAborted();
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  if (totalBytes > MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES) {
    throw new Error("candidate discriminator source exceeds its byte limit");
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseCandidateKind(source: string): "PromptCandidate" | "AgentSkillCandidate" {
  const document = parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error("candidate discriminator source is invalid");
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "PromptCandidate" || value.kind === "AgentSkillCandidate")
  ) {
    return value.kind;
  }
  throw new Error("candidate discriminator kind is unsupported");
}
