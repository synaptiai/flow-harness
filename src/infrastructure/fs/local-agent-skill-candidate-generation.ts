import { join } from "node:path";

import {
  isAgentSkillCandidateGenerationResourcePath,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS,
} from "../../domain/adaptation/agent-skill-candidate-generation.js";
import type { AgentSkillPackageSnapshot } from "../../domain/capability/agent-skills.js";
import {
  AgentSkillCatalogError,
  snapshotProjectAgentSkillPath,
} from "./local-agent-skill-catalog.js";
import {
  type AdmittedLocalPromptCandidateGenerationSources,
  admitLocalPromptCandidateGenerationSources,
  LocalPromptCandidateError,
} from "./local-prompt-candidate.js";

export type LocalAgentSkillCandidateGenerationSourceErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "limit_exceeded"
  | "source_changed";

export class LocalAgentSkillCandidateGenerationSourceError extends Error {
  override readonly name = "LocalAgentSkillCandidateGenerationSourceError";

  constructor(
    readonly code: LocalAgentSkillCandidateGenerationSourceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface AdmitLocalAgentSkillCandidateGenerationSourcesInput {
  readonly outputPath: string;
  readonly baselinePath: string;
  readonly evidencePaths: readonly string[];
  readonly skillName: string;
  readonly resourcePaths: readonly string[];
  readonly signal?: AbortSignal;
  /** @internal Deterministic source race and cancellation seam. */
  readonly afterPathValidation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic package-entry race and cancellation seam. */
  readonly afterSkillEntryObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic package-revalidation cancellation seam. */
  readonly afterSkillRevalidationObservation?: (provenance: string) => void | Promise<void>;
  /** @internal Deterministic package-directory cancellation seam. */
  readonly afterSkillDirectoryBoundary?: (
    provenance: string,
    phase: "entries" | "stat",
  ) => void | Promise<void>;
  /** @internal Deterministic package-file cancellation seam. */
  readonly afterSkillFileBoundary?: (
    provenance: string,
    phase: "open" | "stat" | "close",
  ) => void | Promise<void>;
}

export interface AdmittedLocalAgentSkillCandidateGenerationSources
  extends Pick<
    AdmittedLocalPromptCandidateGenerationSources,
    "outputPath" | "root" | "baseline" | "evidence"
  > {
  readonly skill: AgentSkillPackageSnapshot;
  readonly resourcePaths: readonly string[];
  readonly revalidate: () => Promise<void>;
}

export async function admitLocalAgentSkillCandidateGenerationSources(
  input: AdmitLocalAgentSkillCandidateGenerationSourcesInput,
): Promise<AdmittedLocalAgentSkillCandidateGenerationSources> {
  input.signal?.throwIfAborted();
  if (
    input.resourcePaths.length === 0 ||
    input.resourcePaths.length > MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS ||
    new Set(input.resourcePaths).size !== input.resourcePaths.length
  ) {
    throw new LocalAgentSkillCandidateGenerationSourceError(
      "limit_exceeded",
      `Agent Skill candidate generation requires between 1 and ${MAX_AGENT_SKILL_CANDIDATE_GENERATION_TARGETS} unique resource paths`,
    );
  }
  let common: AdmittedLocalPromptCandidateGenerationSources;
  try {
    common = await admitLocalPromptCandidateGenerationSources(
      input.outputPath,
      input.baselinePath,
      input.evidencePaths,
      {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.afterPathValidation === undefined
          ? {}
          : { afterPathValidation: input.afterPathValidation }),
      },
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof LocalPromptCandidateError && error.code === "source_changed") {
      throw new LocalAgentSkillCandidateGenerationSourceError(
        "source_changed",
        "candidate generation workflow or evidence changed during admission",
      );
    }
    throw new LocalAgentSkillCandidateGenerationSourceError(
      error instanceof LocalPromptCandidateError && error.code === "limit_exceeded"
        ? "limit_exceeded"
        : "invalid_source",
      "candidate generation workflow or evidence cannot be admitted",
    );
  }
  input.signal?.throwIfAborted();
  let skillSnapshot: Awaited<ReturnType<typeof snapshotProjectAgentSkillPath>>;
  try {
    skillSnapshot = await snapshotProjectAgentSkillPath({
      projectRoot: common.root,
      provenance: join(".flow", "skills", input.skillName),
      expectedName: input.skillName,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.afterSkillEntryObservation === undefined
        ? {}
        : { afterEntryObservation: input.afterSkillEntryObservation }),
      ...(input.afterSkillRevalidationObservation === undefined
        ? {}
        : { afterRevalidationObservation: input.afterSkillRevalidationObservation }),
      ...(input.afterSkillDirectoryBoundary === undefined
        ? {}
        : { afterDirectoryBoundary: input.afterSkillDirectoryBoundary }),
      ...(input.afterSkillFileBoundary === undefined
        ? {}
        : { afterFileBoundary: input.afterSkillFileBoundary }),
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new LocalAgentSkillCandidateGenerationSourceError(
      error instanceof AgentSkillCatalogError && error.code === "source_changed"
        ? "source_changed"
        : error instanceof AgentSkillCatalogError && error.code === "limit_exceeded"
          ? "limit_exceeded"
          : "invalid_source",
      "selected Agent Skill package cannot be admitted",
    );
  }
  input.signal?.throwIfAborted();
  const skill = skillSnapshot.snapshot.packages[0];
  if (skill === undefined) {
    throw new LocalAgentSkillCandidateGenerationSourceError(
      "invalid_source",
      "selected Agent Skill package is unavailable",
    );
  }
  const files = new Map(skill.files.map((file) => [file.path, file]));
  for (const path of input.resourcePaths) {
    const file = files.get(path);
    if (
      file === undefined ||
      !isAgentSkillCandidateGenerationResourcePath(path) ||
      !isUtf8(file.contentBase64)
    ) {
      throw new LocalAgentSkillCandidateGenerationSourceError(
        "invalid_source",
        "selected Agent Skill resource is not an existing UTF-8 generation target",
      );
    }
  }
  const revalidate = async (): Promise<void> => {
    input.signal?.throwIfAborted();
    try {
      await common.revalidate();
      input.signal?.throwIfAborted();
      await skillSnapshot.revalidateForPublication();
      input.signal?.throwIfAborted();
    } catch {
      input.signal?.throwIfAborted();
      throw new LocalAgentSkillCandidateGenerationSourceError(
        "source_changed",
        "candidate generation sources changed after admission",
      );
    }
  };
  await revalidate();
  return deepFreeze({
    outputPath: common.outputPath,
    root: common.root,
    baseline: common.baseline,
    evidence: common.evidence,
    skill,
    resourcePaths: [...input.resourcePaths],
    revalidate,
  });
}

function isUtf8(contentBase64: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(contentBase64, "base64"));
    return true;
  } catch {
    return false;
  }
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
