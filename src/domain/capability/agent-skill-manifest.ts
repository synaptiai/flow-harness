import { parseDocument } from "yaml";
import { z } from "zod";

import {
  agentSkillNameSchema,
  MAX_AGENT_SKILL_METADATA_BYTES,
  MAX_AGENT_SKILL_METADATA_ENTRIES,
  MAX_AGENT_SKILL_REQUESTED_TOOLS,
} from "./agent-skills.js";

export const MAX_AGENT_SKILL_FRONTMATTER_BYTES = 64 * 1024;

const skillFrontmatterSchema = z
  .object({
    name: agentSkillNameSchema,
    description: z.string().min(1).max(1024),
    license: z.string().min(1).max(1024).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z
      .record(z.string().min(1).max(256), z.string().max(4096))
      .default({})
      .refine((value) => Object.keys(value).length <= MAX_AGENT_SKILL_METADATA_ENTRIES)
      .refine(
        (value) =>
          Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_AGENT_SKILL_METADATA_BYTES,
      ),
    "allowed-tools": z.string().max(8192).optional(),
  })
  .strict();

export type AgentSkillManifestErrorCode = "invalid_skill" | "limit_exceeded";

export class AgentSkillManifestError extends Error {
  override readonly name = "AgentSkillManifestError";

  constructor(
    readonly code: AgentSkillManifestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AgentSkillManifest {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
}

export function parseAgentSkillManifest(source: Uint8Array, label: string): AgentSkillManifest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new AgentSkillManifestError("invalid_skill", `${label}: SKILL.md must be valid UTF-8`, {
      cause: error,
    });
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match?.[1] === undefined) {
    throw new AgentSkillManifestError(
      "invalid_skill",
      `${label}: SKILL.md must start with bounded YAML frontmatter`,
    );
  }
  if (Buffer.byteLength(match[1], "utf8") > MAX_AGENT_SKILL_FRONTMATTER_BYTES) {
    throw new AgentSkillManifestError(
      "limit_exceeded",
      `${label}: frontmatter exceeds ${MAX_AGENT_SKILL_FRONTMATTER_BYTES} bytes`,
    );
  }
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new AgentSkillManifestError(
      "invalid_skill",
      `${label}: ${document.errors[0]?.message ?? "invalid YAML frontmatter"}`,
    );
  }
  let input: unknown;
  try {
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new AgentSkillManifestError("invalid_skill", `${label}: YAML aliases are not supported`, {
      cause: error,
    });
  }
  const parsed = skillFrontmatterSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AgentSkillManifestError(
      "invalid_skill",
      `${label}: ${issue?.path.map(String).join(".") || "<frontmatter>"}: ${issue?.message ?? "invalid frontmatter"}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze({
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data.license === undefined ? {} : { license: parsed.data.license }),
    ...(parsed.data.compatibility === undefined
      ? {}
      : { compatibility: parsed.data.compatibility }),
    metadata: parsed.data.metadata,
    requestedTools: parseRequestedTools(parsed.data["allowed-tools"], label),
  });
}

function parseRequestedTools(value: string | undefined, label: string): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return Object.freeze([]);
  }
  const tools = value.trim().split(/\s+/).sort(compareStrings);
  if (
    tools.length > MAX_AGENT_SKILL_REQUESTED_TOOLS ||
    new Set(tools).size !== tools.length ||
    tools.some(
      (tool) =>
        tool.length > 128 ||
        Array.from(tool).some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && (point <= 31 || point === 127);
        }),
    )
  ) {
    throw new AgentSkillManifestError(
      "invalid_skill",
      `${label}: allowed-tools must contain at most 64 unique bounded tool names`,
    );
  }
  return Object.freeze(tools);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
