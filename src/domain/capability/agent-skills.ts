import { createHash } from "node:crypto";

import { z } from "zod";

export const MAX_AGENT_SKILL_PACKAGES = 32;
export const MAX_AGENT_SKILL_FILES = 128;
export const MAX_AGENT_SKILL_FILE_BYTES = 128 * 1024;
export const MAX_AGENT_SKILL_PACKAGE_BYTES = 256 * 1024;
export const MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES = 512 * 1024;
export const MAX_CAPABILITY_READ_RECEIPTS = 128;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const agentSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");

export interface AgentSkillSnapshotFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentBase64: string;
}

export interface AgentSkillPackageSnapshot {
  readonly kind: "agent-skill";
  readonly name: string;
  readonly description: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly files: readonly AgentSkillSnapshotFile[];
  readonly digest: string;
}

export interface CapabilitySnapshot {
  readonly version: 1;
  readonly packages: readonly AgentSkillPackageSnapshot[];
  readonly digest: string;
}

export interface AgentSkillPackageSnapshotInput
  extends Omit<AgentSkillPackageSnapshot, "digest" | "files" | "metadata" | "requestedTools"> {
  readonly metadata: Readonly<Record<string, string>>;
  readonly requestedTools: readonly string[];
  readonly files: readonly {
    readonly path: string;
    readonly content: Uint8Array;
  }[];
}

export interface AgentSkillSelectionEvidence {
  readonly name: string;
  readonly digest: string;
}

export interface AgentSkillReadReceipt {
  readonly uri: string;
  readonly packageDigest: string;
  readonly fileDigest: string;
  readonly bytes: number;
}

export interface AgentCapabilityEvidence {
  readonly selected: readonly AgentSkillSelectionEvidence[];
  readonly reads: readonly AgentSkillReadReceipt[];
}

const snapshotFileSchema = z
  .object({
    path: portablePathSchema,
    bytes: z.number().int().nonnegative().max(MAX_AGENT_SKILL_FILE_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_AGENT_SKILL_FILE_BYTES * 4) / 3) + 4),
  })
  .strict();

const packageSnapshotSchema = z
  .object({
    kind: z.literal("agent-skill"),
    name: agentSkillNameSchema,
    description: z.string().min(1).max(1024),
    license: z.string().min(1).max(1024).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string().min(1).max(256), z.string().max(4096)),
    requestedTools: z
      .array(z.string().min(1).max(128))
      .max(64)
      .refine((items) => new Set(items).size === items.length, "requested tools must be unique"),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    files: z.array(snapshotFileSchema).min(1).max(MAX_AGENT_SKILL_FILES),
    digest: sha256Schema,
  })
  .strict();

const capabilitySnapshotSchema = z
  .object({
    version: z.literal(1),
    packages: z.array(packageSnapshotSchema).min(1).max(MAX_AGENT_SKILL_PACKAGES),
    digest: sha256Schema,
  })
  .strict();

export const persistedCapabilitySnapshotSchema: z.ZodType<CapabilitySnapshot> = z
  .unknown()
  .transform((input, context) => {
    try {
      return validateCapabilitySnapshot(input);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
        input,
      });
      return z.NEVER;
    }
  });

const selectionEvidenceSchema = z
  .object({ name: agentSkillNameSchema, digest: sha256Schema })
  .strict();

const readReceiptSchema = z
  .object({
    uri: z.string().min(1).max(2048),
    packageDigest: sha256Schema,
    fileDigest: sha256Schema,
    bytes: z.number().int().nonnegative().max(MAX_AGENT_SKILL_FILE_BYTES),
  })
  .strict();

export const agentCapabilityEvidenceSchema: z.ZodType<AgentCapabilityEvidence> = z
  .object({
    selected: z
      .array(selectionEvidenceSchema)
      .min(1)
      .max(MAX_AGENT_SKILL_PACKAGES)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
    reads: z.array(readReceiptSchema).max(MAX_CAPABILITY_READ_RECEIPTS),
  })
  .strict();

export function isAgentSkillName(value: string): boolean {
  return agentSkillNameSchema.safeParse(value).success;
}

export function createCapabilitySnapshot(
  inputs: readonly AgentSkillPackageSnapshotInput[],
): CapabilitySnapshot {
  if (inputs.length === 0) {
    throw new RangeError("a capability snapshot requires at least one selected package");
  }
  const packages = inputs
    .map((input): AgentSkillPackageSnapshot => {
      const files = input.files
        .map((file): AgentSkillSnapshotFile => {
          const content = Buffer.from(file.content);
          return {
            path: file.path,
            bytes: content.byteLength,
            sha256: sha256(content),
            contentBase64: content.toString("base64"),
          };
        })
        .sort(comparePath);
      const metadata = Object.fromEntries(
        Object.entries(input.metadata).sort(([left], [right]) => compareStrings(left, right)),
      );
      const requestedTools = [...input.requestedTools].sort(compareStrings);
      const candidate: Omit<AgentSkillPackageSnapshot, "digest"> = {
        kind: input.kind,
        name: input.name,
        description: input.description,
        ...(input.license === undefined ? {} : { license: input.license }),
        ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
        metadata,
        requestedTools,
        trust: input.trust,
        provenance: input.provenance,
        files,
      };
      return {
        ...candidate,
        digest: calculateAgentSkillPackageDigest(candidate),
      };
    })
    .sort((left, right) => compareStrings(left.name, right.name));
  const candidate = {
    version: 1 as const,
    packages,
    digest: calculateCapabilitySnapshotDigest(packages),
  };
  return validateCapabilitySnapshot(candidate);
}

export function validateCapabilitySnapshot(input: unknown): CapabilitySnapshot {
  const parsed = capabilitySnapshotSchema.parse(input);
  assertSortedUnique(
    parsed.packages.map((item) => item.name),
    "capability package names",
  );
  for (const skill of parsed.packages) {
    assertSortedUnique(Object.keys(skill.metadata), `skill "${skill.name}" metadata keys`);
    assertSortedUnique(
      skill.files.map((file) => file.path),
      `skill "${skill.name}" file paths`,
    );
    assertSortedUnique([...skill.requestedTools], `skill "${skill.name}" requested tools`);
    if (skill.provenance.split("/").at(-1) !== skill.name) {
      throw new Error(`skill "${skill.name}" provenance must end with its package name`);
    }
    let packageBytes = 0;
    for (const file of skill.files) {
      const content = decodeCanonicalBase64(file.contentBase64, file.path);
      if (content.byteLength !== file.bytes) {
        throw new Error(`skill "${skill.name}" file "${file.path}" byte count does not match`);
      }
      if (sha256(content) !== file.sha256) {
        throw new Error(`skill "${skill.name}" file "${file.path}" digest does not match`);
      }
      packageBytes += content.byteLength;
    }
    if (!skill.files.some((file) => file.path === "SKILL.md")) {
      throw new Error(`skill "${skill.name}" snapshot is missing SKILL.md`);
    }
    if (packageBytes > MAX_AGENT_SKILL_PACKAGE_BYTES) {
      throw new Error(
        `skill "${skill.name}" exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} snapshot bytes`,
      );
    }
    if (calculateAgentSkillPackageDigest(skill) !== skill.digest) {
      throw new Error(`skill "${skill.name}" package digest does not match`);
    }
  }
  if (calculateCapabilitySnapshotDigest(parsed.packages) !== parsed.digest) {
    throw new Error("capability snapshot digest does not match");
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES
  ) {
    throw new Error(
      `serialized capability snapshot exceeds ${MAX_CAPABILITY_SNAPSHOT_SERIALIZED_BYTES} UTF-8 bytes`,
    );
  }
  return deepFreeze(parsed);
}

export function calculateAgentSkillPackageDigest(
  skill: Omit<AgentSkillPackageSnapshot, "digest"> | AgentSkillPackageSnapshot,
): string {
  const canonical = {
    kind: skill.kind,
    name: skill.name,
    description: skill.description,
    license: skill.license ?? null,
    compatibility: skill.compatibility ?? null,
    metadata: skill.metadata,
    requestedTools: skill.requestedTools,
    trust: skill.trust,
    provenance: skill.provenance,
    files: skill.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  return sha256(JSON.stringify(canonical));
}

export function calculateCapabilitySnapshotDigest(
  packages: readonly AgentSkillPackageSnapshot[],
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      packages: packages.map((skill) => ({ name: skill.name, digest: skill.digest })),
    }),
  );
}

export function selectedAgentSkills(
  snapshot: CapabilitySnapshot,
  names: readonly string[],
): readonly AgentSkillPackageSnapshot[] {
  const byName = new Map(snapshot.packages.map((skill) => [skill.name, skill]));
  return Object.freeze(
    names.map((name) => {
      const skill = byName.get(name);
      if (skill === undefined) {
        throw new Error(`capability snapshot does not contain selected skill "${name}"`);
      }
      return skill;
    }),
  );
}

export function createAgentCapabilityEvidence(
  snapshot: CapabilitySnapshot,
  names: readonly string[],
  reads: readonly AgentSkillReadReceipt[] = [],
): AgentCapabilityEvidence {
  const selectedPackages = selectedAgentSkills(snapshot, names);
  const selected = selectedPackages.map((skill) => ({ name: skill.name, digest: skill.digest }));
  if (new Set(names).size !== names.length) {
    throw new Error("selected Agent Skill names must be unique");
  }
  if (reads.length > MAX_CAPABILITY_READ_RECEIPTS) {
    throw new Error(`Agent Skill reads exceed ${MAX_CAPABILITY_READ_RECEIPTS} receipts`);
  }
  const allowedReceipts = new Map<string, AgentSkillReadReceipt>();
  for (const skill of selectedPackages) {
    for (const file of skill.files) {
      const uri = skillResourceUri(skill.name, file.path);
      allowedReceipts.set(uri, {
        uri,
        packageDigest: skill.digest,
        fileDigest: file.sha256,
        bytes: file.bytes,
      });
    }
  }
  const observedUris = new Set<string>();
  for (const read of reads) {
    const allowed = allowedReceipts.get(read.uri);
    if (allowed === undefined || JSON.stringify(allowed) !== JSON.stringify(read)) {
      throw new Error(`Agent Skill read receipt "${read.uri}" is not bound to selected content`);
    }
    if (observedUris.has(read.uri)) {
      throw new Error(`Agent Skill read receipt "${read.uri}" is duplicated`);
    }
    observedUris.add(read.uri);
  }
  return deepFreeze(agentCapabilityEvidenceSchema.parse({ selected, reads: [...reads] }));
}

export function skillResourceUri(skillName: string, path: string): string {
  if (!isAgentSkillName(skillName) || !isPortableRelativePath(path)) {
    throw new Error("cannot create a skill URI from an invalid name or path");
  }
  return `skill://${skillName}/${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function decodeCanonicalBase64(value: string, path: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error(`skill file "${path}" content is not canonical base64`);
  }
  return content;
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !Array.from(segment).some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && (point <= 31 || point === 127);
      }),
  );
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    const previous = values[index - 1];
    if (
      current === undefined ||
      (previous !== undefined && compareStrings(previous, current) >= 0)
    ) {
      throw new Error(`${label} must be strictly sorted and unique`);
    }
  }
}

function comparePath(left: { readonly path: string }, right: { readonly path: string }): number {
  return compareStrings(left.path, right.path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
