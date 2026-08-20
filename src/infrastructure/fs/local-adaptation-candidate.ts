import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import { MAX_AGENT_SKILL_CANDIDATE_BYTES } from "../../domain/adaptation/agent-skill-candidate.js";
import type { ChildSpecialistCandidateSource } from "../../domain/adaptation/child-specialist-candidate.js";
import { MAX_CHILD_SPECIALIST_CANDIDATE_BYTES } from "../../domain/adaptation/child-specialist-candidate.js";
import { MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES } from "../../domain/adaptation/effective-harness-candidate.js";
import type { EffectiveHarnessState } from "../../domain/adaptation/effective-harness-state.js";
import { MAX_MODEL_ROUTING_CANDIDATE_BYTES } from "../../domain/adaptation/model-routing-candidate.js";
import { MAX_PROMPT_CANDIDATE_BYTES } from "../../domain/adaptation/prompt-candidate.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES,
  type SupplementalMemoryCandidateSource,
} from "../../domain/adaptation/supplemental-memory-candidate.js";
import type { CapabilityPackageSnapshot } from "../../domain/capability/agent-skills.js";
import {
  type AdmittedLocalAgentSkillCandidate,
  admitLocalAgentSkillCandidate,
} from "./local-agent-skill-candidate.js";
import {
  type AdmittedLocalAgentSkillPackageCandidate,
  admitLocalAgentSkillPackageCandidate,
} from "./local-agent-skill-package-candidate.js";
import {
  type AdmittedLocalChildSpecialistCandidate,
  admitLocalChildSpecialistCandidate,
} from "./local-child-specialist-candidate.js";
import {
  type AdmittedLocalEffectiveHarnessCandidate,
  admitLocalEffectiveHarnessCandidate,
} from "./local-effective-harness-candidate.js";
import {
  type AdmittedLocalModelRoutingCandidate,
  admitLocalModelRoutingCandidate,
} from "./local-model-routing-candidate.js";
import {
  type AdmittedLocalPromptCandidate,
  admitLocalPromptCandidate,
} from "./local-prompt-candidate.js";
import {
  type AdmittedLocalSupplementalMemoryCandidate,
  admitLocalSupplementalMemoryCandidate,
} from "./local-supplemental-memory-candidate.js";

const MAX_LOCAL_ADAPTATION_CANDIDATE_BYTES = Math.max(
  MAX_AGENT_SKILL_CANDIDATE_BYTES,
  MAX_CHILD_SPECIALIST_CANDIDATE_BYTES,
  MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
  MAX_MODEL_ROUTING_CANDIDATE_BYTES,
  MAX_PROMPT_CANDIDATE_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES,
);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type AdmittedLocalAdaptationCandidate =
  | {
      readonly kind: "child-specialist-candidate";
      readonly candidate: AdmittedLocalChildSpecialistCandidate;
    }
  | {
      readonly kind: "prompt-candidate";
      readonly candidate: AdmittedLocalPromptCandidate;
    }
  | {
      readonly kind: "agent-skill-candidate";
      readonly candidate: AdmittedLocalAgentSkillCandidate;
    }
  | {
      readonly kind: "agent-skill-package-candidate";
      readonly candidate: AdmittedLocalAgentSkillPackageCandidate;
    }
  | {
      readonly kind: "effective-harness-candidate";
      readonly candidate: AdmittedLocalEffectiveHarnessCandidate;
    }
  | {
      readonly kind: "model-routing-candidate";
      readonly candidate: AdmittedLocalModelRoutingCandidate;
    }
  | {
      readonly kind: "supplemental-memory-candidate";
      readonly candidate: AdmittedLocalSupplementalMemoryCandidate;
    };

export interface LocalAdaptationCandidateOptions {
  readonly signal?: AbortSignal;
  /** Exact already-admitted package closure required by child-specialist projection. */
  readonly capabilityPackages?: readonly CapabilityPackageSnapshot[];
  /** Resolve the immutable active package closure only after child-specialist discrimination. */
  readonly resolveChildSpecialistPackages?:
    | ((source: ChildSpecialistCandidateSource) => Promise<readonly CapabilityPackageSnapshot[]>)
    | undefined;
  /** Resolve one immutable complete baseline only after supplemental-memory discrimination. */
  readonly resolveSupplementalMemoryBaseline?:
    | ((source: SupplementalMemoryCandidateSource) => Promise<EffectiveHarnessState>)
    | undefined;
  /** @internal Deterministic discriminator race and cancellation seam. */
  readonly afterDiscriminatorStat?: () => void | Promise<void>;
  /** @internal Deterministic nested-admission cancellation seam. */
  readonly afterAgentSkillPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic nested prompt-candidate cancellation seam. */
  readonly afterPromptPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic stable-dispatch replacement seam. */
  readonly afterDiscriminatorRead?: () => void | Promise<void>;
}

export async function admitLocalAdaptationCandidate(
  candidatePath: string,
  options: LocalAdaptationCandidateOptions = {},
): Promise<AdmittedLocalAdaptationCandidate> {
  const absolutePath = resolve(candidatePath);
  options.signal?.throwIfAborted();
  let pathIdentity: BigIntStats;
  try {
    pathIdentity = await lstat(absolutePath, { bigint: true });
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("candidate discriminator source is unavailable");
  }
  options.signal?.throwIfAborted();
  if (pathIdentity.isSymbolicLink()) {
    throw new Error("candidate discriminator source cannot be a link");
  }
  if (pathIdentity.isDirectory()) {
    const candidate = await admitLocalAgentSkillPackageCandidate(absolutePath, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    options.signal?.throwIfAborted();
    return Object.freeze({ kind: "agent-skill-package-candidate", candidate });
  }
  if (!pathIdentity.isFile()) {
    throw new Error("candidate discriminator source is not an admitted regular file");
  }
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    options.signal?.throwIfAborted();
    throw new Error("candidate discriminator source cannot be opened without links");
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
  await options.afterDiscriminatorRead?.();
  options.signal?.throwIfAborted();
  const kind = parseCandidateKind(source);
  if (kind === "effective-harness-candidate") {
    const candidate = await admitLocalEffectiveHarnessCandidate(absolutePath, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
    });
    return Object.freeze({ kind, candidate });
  }
  if (kind === "ChildSpecialistCandidate") {
    if (
      options.capabilityPackages === undefined &&
      options.resolveChildSpecialistPackages === undefined
    ) {
      throw new Error("child-specialist candidate requires an admitted package closure");
    }
    const candidate = await admitLocalChildSpecialistCandidate(absolutePath, {
      ...(options.capabilityPackages === undefined ? {} : { packages: options.capabilityPackages }),
      ...(options.resolveChildSpecialistPackages === undefined
        ? {}
        : { resolvePackages: options.resolveChildSpecialistPackages }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
    });
    options.signal?.throwIfAborted();
    return Object.freeze({ kind: "child-specialist-candidate", candidate });
  }
  if (kind === "ModelRoutingCandidate") {
    const candidate = await admitLocalModelRoutingCandidate(absolutePath, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
    });
    options.signal?.throwIfAborted();
    return Object.freeze({ kind: "model-routing-candidate", candidate });
  }
  if (kind === "SupplementalMemoryCandidate") {
    if (options.resolveSupplementalMemoryBaseline === undefined) {
      throw new Error("supplemental-memory candidate requires an admitted effective baseline");
    }
    const candidate = await admitLocalSupplementalMemoryCandidate(absolutePath, {
      resolveBaseline: options.resolveSupplementalMemoryBaseline,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      expectedSource: { identity: sourceIdentity, sha256: sourceSha256 },
    });
    options.signal?.throwIfAborted();
    return Object.freeze({ kind: "supplemental-memory-candidate", candidate });
  }
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

function parseCandidateKind(
  source: string,
):
  | "PromptCandidate"
  | "AgentSkillCandidate"
  | "ChildSpecialistCandidate"
  | "ModelRoutingCandidate"
  | "SupplementalMemoryCandidate"
  | "effective-harness-candidate" {
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
    (value.kind === "PromptCandidate" ||
      value.kind === "AgentSkillCandidate" ||
      value.kind === "ChildSpecialistCandidate" ||
      value.kind === "ModelRoutingCandidate" ||
      value.kind === "SupplementalMemoryCandidate" ||
      value.kind === "effective-harness-candidate")
  ) {
    return value.kind;
  }
  throw new Error("candidate discriminator kind is unsupported");
}
