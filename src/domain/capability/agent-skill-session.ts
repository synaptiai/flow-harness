import {
  type AgentCapabilityEvidence,
  type AgentSkillReadReceipt,
  type CapabilitySnapshot,
  createAgentCapabilityEvidence,
  isAgentSkillName,
  MAX_CAPABILITY_READ_RECEIPTS,
  selectedAgentSkills,
  skillResourceUri,
} from "./agent-skills.js";

export type AgentSkillSessionErrorCode =
  | "binary_resource"
  | "missing_resource"
  | "read_limit"
  | "unselected_skill"
  | "unsafe_uri";

export class AgentSkillSessionError extends Error {
  override readonly name = "AgentSkillSessionError";

  constructor(
    readonly code: AgentSkillSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AgentSkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly digest: string;
  readonly uri: string;
}

export interface AgentSkillTextResource {
  readonly text: string;
  readonly receipt: AgentSkillReadReceipt;
}

export interface AgentSkillSession {
  readonly catalog: readonly AgentSkillCatalogEntry[];
  readText(uri: string): AgentSkillTextResource;
  evidence(): AgentCapabilityEvidence;
}

export function createAgentSkillSession(
  snapshot: CapabilitySnapshot,
  selectedNames: readonly string[],
): AgentSkillSession {
  const selected = selectedAgentSkills(snapshot, selectedNames);
  const byName = new Map(selected.map((skill) => [skill.name, skill]));
  const reads = new Map<string, AgentSkillReadReceipt>();
  const catalog = Object.freeze(
    selected.map((skill) =>
      Object.freeze({
        name: skill.name,
        description: skill.description,
        digest: skill.digest,
        uri: skillResourceUri(skill.name, "SKILL.md"),
      }),
    ),
  );
  return Object.freeze({
    catalog,
    readText(uri: string): AgentSkillTextResource {
      const resource = parseSkillUri(uri);
      const skill = byName.get(resource.name);
      if (skill === undefined) {
        throw new AgentSkillSessionError(
          "unselected_skill",
          `Agent Skill "${resource.name}" is not selected for this node`,
        );
      }
      const file = skill.files.find((candidate) => candidate.path === resource.path);
      if (file === undefined) {
        throw new AgentSkillSessionError(
          "missing_resource",
          `Agent Skill "${resource.name}" has no resource "${resource.path}"`,
        );
      }
      if (!reads.has(resource.canonicalUri) && reads.size >= MAX_CAPABILITY_READ_RECEIPTS) {
        throw new AgentSkillSessionError(
          "read_limit",
          `Agent Skill resource receipt limit of ${MAX_CAPABILITY_READ_RECEIPTS} was reached`,
        );
      }
      const content = Buffer.from(file.contentBase64, "base64");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch (error) {
        throw new AgentSkillSessionError(
          "binary_resource",
          `Agent Skill resource "${resource.canonicalUri}" is not UTF-8 text`,
          { cause: error },
        );
      }
      const receipt: AgentSkillReadReceipt = Object.freeze({
        uri: resource.canonicalUri,
        packageDigest: skill.digest,
        fileDigest: file.sha256,
        bytes: file.bytes,
      });
      reads.set(resource.canonicalUri, receipt);
      return Object.freeze({ text, receipt });
    },
    evidence(): AgentCapabilityEvidence {
      return createAgentCapabilityEvidence(snapshot, selectedNames, [...reads.values()]);
    },
  });
}

function parseSkillUri(uri: string): {
  readonly name: string;
  readonly path: string;
  readonly canonicalUri: string;
} {
  if (!uri.startsWith("skill://") || uri.includes("?") || uri.includes("#")) {
    throw unsafeUri(uri);
  }
  const remainder = uri.slice("skill://".length);
  const separator = remainder.indexOf("/");
  if (separator <= 0 || separator === remainder.length - 1) {
    throw unsafeUri(uri);
  }
  const name = remainder.slice(0, separator);
  const rawPath = remainder.slice(separator + 1);
  if (!isAgentSkillName(name) || name.includes("%") || rawPath.includes("\\")) {
    throw unsafeUri(uri);
  }
  const segments = rawPath.split("/").map((segment) => {
    if (segment.length === 0) {
      throw unsafeUri(uri);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw unsafeUri(uri);
    }
    if (
      decoded.length === 0 ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      Array.from(decoded).some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && (point <= 31 || point === 127);
      })
    ) {
      throw unsafeUri(uri);
    }
    return decoded;
  });
  const path = segments.join("/");
  return Object.freeze({ name, path, canonicalUri: skillResourceUri(name, path) });
}

function unsafeUri(uri: string): AgentSkillSessionError {
  return new AgentSkillSessionError("unsafe_uri", `unsafe Agent Skill resource URI "${uri}"`);
}
