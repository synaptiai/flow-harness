import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

export const TOOL_PACKAGE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const TOOL_PACKAGE_DRIVER_VERSION = "v1" as const;
export const MAX_TOOL_PACKAGE_MANIFEST_BYTES = 64 * 1024;
export const MAX_TOOL_PACKAGE_INPUTS = 32;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPortableRelativePath, "must be a normalized portable relative path");
export const toolPackageNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const toolPackageVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isExactSemanticVersion, "must be an exact semantic version");
export const packagedToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine(
    (value) => !value.startsWith("flow_") && !["read", "ls", "edit", "exec"].includes(value),
    "must not use a reserved Flow tool name",
  );

const inputNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine((value) => !value.startsWith("flow_"), "must not use a reserved Flow input name");
const inputBaseShape = {
  name: inputNameSchema,
  description: z.string().trim().min(1).max(1024),
};
const toolInputSchema = z.discriminatedUnion("type", [
  z.object({ ...inputBaseShape, type: z.literal("string") }).strict(),
  z.object({ ...inputBaseShape, type: z.literal("integer") }).strict(),
  z.object({ ...inputBaseShape, type: z.literal("boolean") }).strict(),
  z
    .object({
      ...inputBaseShape,
      type: z.literal("enum"),
      values: z
        .array(
          z
            .string()
            .min(1)
            .max(256)
            .refine(
              (value) => !containsControlCharacter(value),
              "must not contain control characters",
            ),
        )
        .min(1)
        .max(32)
        .refine((items) => new Set(items).size === items.length, "enum values must be unique"),
    })
    .strict(),
]);

const inputPlaceholder = /^\{input:([A-Za-z][A-Za-z0-9_]*)\}$/;
const commandDriverSchema = z
  .object({
    kind: z.literal("command"),
    version: z.literal(TOOL_PACKAGE_DRIVER_VERSION),
    executable: z.string().trim().min(1).max(4096),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0) <= 65_536,
        "command arguments must not exceed 65536 UTF-8 bytes in total",
      ),
    timeoutMs: z.number().int().positive().max(86_400_000),
  })
  .strict()
  .refine(
    (command) =>
      !command.executable.includes("\0") && command.args.every((arg) => !arg.includes("\0")),
    "command values must not contain NUL bytes",
  );

export const toolPackageDefinitionSchema = z
  .object({
    tool: z
      .object({
        name: packagedToolNameSchema,
        description: z.string().trim().min(1).max(1024),
        inputs: z
          .array(toolInputSchema)
          .max(MAX_TOOL_PACKAGE_INPUTS)
          .refine(
            (items) => new Set(items.map((item) => item.name)).size === items.length,
            "tool input names must be unique",
          ),
      })
      .strict(),
    driver: commandDriverSchema,
    permissions: z.tuple([z.literal("process.execute")]),
  })
  .strict()
  .superRefine((definition, context) => {
    const inputNames = new Set(definition.tool.inputs.map((input) => input.name));
    const usedInputs = new Set<string>();
    definition.driver.args.forEach((argument, index) => {
      const match = inputPlaceholder.exec(argument);
      if (match !== null) {
        const name = match[1];
        if (name !== undefined && inputNames.has(name)) {
          usedInputs.add(name);
        } else {
          context.addIssue({
            code: "custom",
            path: ["driver", "args", index],
            message: `references undeclared input "${name ?? ""}"`,
          });
        }
        return;
      }
      if (argument.includes("{input:")) {
        context.addIssue({
          code: "custom",
          path: ["driver", "args", index],
          message: "input placeholders must occupy one complete argument",
        });
      }
    });
    for (const input of definition.tool.inputs) {
      if (!usedInputs.has(input.name)) {
        context.addIssue({
          code: "custom",
          path: ["tool", "inputs"],
          message: `input "${input.name}" must be used by the command arguments`,
        });
      }
    }
  });

export const toolPackageManifestSchema = z
  .object({
    apiVersion: z.literal(TOOL_PACKAGE_API_VERSION),
    kind: z.literal("ToolPackage"),
    metadata: z
      .object({
        name: toolPackageNameSchema,
        version: toolPackageVersionSchema,
        description: z.string().trim().min(1).max(1024),
        license: z.string().trim().min(1).max(1024).optional(),
        compatibility: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    spec: toolPackageDefinitionSchema,
  })
  .strict();

const manifestSnapshotSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_TOOL_PACKAGE_MANIFEST_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_TOOL_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

export const toolPackageSnapshotSchema = z
  .object({
    kind: z.literal("tool-package"),
    apiVersion: z.literal(TOOL_PACKAGE_API_VERSION),
    name: toolPackageNameSchema,
    version: toolPackageVersionSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(1024).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    definition: toolPackageDefinitionSchema,
    manifest: manifestSnapshotSchema,
    digest: sha256Schema,
  })
  .strict();

export type ToolPackageDefinition = z.infer<typeof toolPackageDefinitionSchema>;
export type ToolPackageManifest = z.infer<typeof toolPackageManifestSchema>;
export type ToolPackageSnapshot = z.infer<typeof toolPackageSnapshotSchema>;

export interface ToolPackageSnapshotInput {
  readonly kind: "tool-package";
  readonly apiVersion: typeof TOOL_PACKAGE_API_VERSION;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license?: string | undefined;
  readonly compatibility?: string | undefined;
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly definition: ToolPackageDefinition;
  readonly manifest: { readonly content: Uint8Array };
}

export function createToolPackageSnapshot(input: ToolPackageSnapshotInput): ToolPackageSnapshot {
  const content = Buffer.from(input.manifest.content);
  const candidate = {
    kind: input.kind,
    apiVersion: input.apiVersion,
    name: input.name,
    version: input.version,
    description: input.description,
    ...(input.license === undefined ? {} : { license: input.license }),
    ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
    trust: input.trust,
    provenance: input.provenance,
    definition: input.definition,
    manifest: {
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    },
  };
  return validateToolPackageSnapshot({
    ...candidate,
    digest: calculateToolPackageDigest(candidate),
  });
}

export function validateToolPackageSnapshot(input: unknown): ToolPackageSnapshot {
  const parsed = toolPackageSnapshotSchema.parse(input);
  if (parsed.provenance.split("/").at(-1) !== parsed.name) {
    throw new Error(`tool package "${parsed.name}" provenance must end with its package name`);
  }
  const content = decodeCanonicalBase64(parsed.manifest.contentBase64);
  if (content.byteLength !== parsed.manifest.bytes) {
    throw new Error(`tool package "${parsed.name}" manifest byte count does not match`);
  }
  if (sha256(content) !== parsed.manifest.sha256) {
    throw new Error(`tool package "${parsed.name}" manifest digest does not match`);
  }
  const manifest = parseToolPackageManifest(content, `tool package "${parsed.name}"`);
  const expected = {
    apiVersion: parsed.apiVersion,
    kind: "ToolPackage" as const,
    metadata: {
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      ...(parsed.license === undefined ? {} : { license: parsed.license }),
      ...(parsed.compatibility === undefined ? {} : { compatibility: parsed.compatibility }),
    },
    spec: parsed.definition,
  };
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error(`tool package "${parsed.name}" manifest disagrees with its definition`);
  }
  if (calculateToolPackageDigest(parsed) !== parsed.digest) {
    throw new Error(`tool package "${parsed.name}" package digest does not match`);
  }
  return deepFreeze(parsed);
}

export function parseToolPackageManifest(
  source: Uint8Array,
  label = "tool package manifest",
): ToolPackageManifest {
  if (source.byteLength === 0 || source.byteLength > MAX_TOOL_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`${label} must be 1-${MAX_TOOL_PACKAGE_MANIFEST_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8`, { cause: error });
  }
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${label}: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  let input: unknown;
  try {
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new Error(`${label}: YAML aliases are not supported`, { cause: error });
  }
  const parsed = toolPackageManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label}: ${issue?.path.map(String).join(".") || "<manifest>"}: ${issue?.message ?? "invalid manifest"}`,
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}

export function calculateToolPackageDigest(
  value: Omit<ToolPackageSnapshot, "digest"> | ToolPackageSnapshot,
): string {
  return sha256(
    JSON.stringify({
      kind: value.kind,
      apiVersion: value.apiVersion,
      name: value.name,
      version: value.version,
      description: value.description,
      license: value.license ?? null,
      compatibility: value.compatibility ?? null,
      trust: value.trust,
      provenance: value.provenance,
      definition: value.definition,
      manifest: {
        bytes: value.manifest.bytes,
        sha256: value.manifest.sha256,
      },
    }),
  );
}

export function toolPackageIdentityKey(value: {
  readonly name: string;
  readonly version: string;
}): string {
  return `tool-package\0${value.name}\0${value.version}`;
}

function isExactSemanticVersion(value: string): boolean {
  const buildParts = value.split("+");
  if (buildParts.length > 2) {
    return false;
  }
  const coreAndPrerelease = buildParts[0];
  const build = buildParts[1];
  if (coreAndPrerelease === undefined || (build !== undefined && !validIdentifiers(build, false))) {
    return false;
  }
  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? coreAndPrerelease
      : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);
  const coreIdentifiers = core.split(".");
  if (coreIdentifiers.length !== 3 || !coreIdentifiers.every(validNumericIdentifier)) {
    return false;
  }
  return prerelease === undefined || validIdentifiers(prerelease, true);
}

function validIdentifiers(value: string, rejectNumericLeadingZeros: boolean): boolean {
  const identifiers = value.split(".");
  return identifiers.every(
    (identifier) =>
      identifier.length > 0 &&
      /^[0-9A-Za-z-]+$/.test(identifier) &&
      (!rejectNumericLeadingZeros ||
        !/^\d+$/.test(identifier) ||
        validNumericIdentifier(identifier)),
  );
}

function validNumericIdentifier(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new Error("tool package manifest content is not canonical base64");
  }
  return content;
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !containsControlCharacter(segment),
    );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
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
