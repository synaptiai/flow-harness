import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import { isSafeDisplayText } from "../presentation/safe-display-text.js";
import { verifierPackageNameSchema, verifierPackageVersionSchema } from "./verifier-packages.js";

export const PRESENTATION_PACKAGE_API_VERSION = "flow.synapti.ai/v1alpha1" as const;
export const PRESENTATION_PACKAGE_A2UI_VERSION = "v0.9" as const;
export const FLOW_A2UI_CATALOG_ID =
  "https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1" as const;
export const FLOW_A2UI_CATALOG_V2_ID =
  "https://flow.synapti.ai/a2ui/catalogs/run-presentation/v2" as const;
export const FLOW_A2UI_SURFACE_ID = "flow-run" as const;
export const MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES = 64 * 1024;
export const MAX_PRESENTATION_PACKAGE_COMPONENTS = 13;
export const MAX_PRESENTATION_PACKAGE_GROUPS = 6;
export const MAX_PRESENTATION_PACKAGE_NOTES = 4;
export const MAX_PRESENTATION_PACKAGE_NOTE_TITLE_BYTES = 128;
export const MAX_PRESENTATION_PACKAGE_NOTE_BODY_BYTES = 1024;
export const MAX_PRESENTATION_PACKAGE_NOTE_TEXT_BYTES = 4096;

export const FLOW_PRESENTATION_WIDGETS = Object.freeze([
  "run-summary",
  "graph-progress",
  "node-table",
  "resource-facts",
  "pending-approvals",
  "outcome-notice",
] as const);

export type FlowPresentationWidget = (typeof FLOW_PRESENTATION_WIDGETS)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const portablePathSchema = z.string().min(1).max(1024).refine(isPortableRelativePath);
const groupIdSchema = z.string().regex(/^group-[1-6]$/);
const widgetIdSchema = z.enum(FLOW_PRESENTATION_WIDGETS);
const packageNotesIdSchema = z.literal("package-notes");
const legacyChildIdSchema = z.union([groupIdSchema, widgetIdSchema]);
const contentChildIdSchema = z.union([groupIdSchema, widgetIdSchema, packageNotesIdSchema]);

const legacyLayoutComponentSchema = z
  .object({
    id: z.literal("root"),
    component: z.literal("FlowLayout"),
    density: z.enum(["compact", "comfortable"]),
    children: z.array(legacyChildIdSchema).min(1).max(FLOW_PRESENTATION_WIDGETS.length),
  })
  .strict();
const contentLayoutComponentSchema = z
  .object({
    id: z.literal("root"),
    component: z.literal("FlowLayout"),
    density: z.enum(["compact", "comfortable"]),
    children: z
      .array(contentChildIdSchema)
      .min(2)
      .max(FLOW_PRESENTATION_WIDGETS.length + 1),
  })
  .strict();
const groupComponentSchema = z
  .object({
    id: groupIdSchema,
    component: z.literal("FlowGroup"),
    variant: z.enum(["stack", "separated"]),
    children: z.array(widgetIdSchema).min(1).max(FLOW_PRESENTATION_WIDGETS.length),
  })
  .strict();

const leafComponentSchema = z.discriminatedUnion("id", [
  z.object({ id: z.literal("run-summary"), component: z.literal("FlowRunSummary") }).strict(),
  z.object({ id: z.literal("graph-progress"), component: z.literal("FlowGraphProgress") }).strict(),
  z.object({ id: z.literal("node-table"), component: z.literal("FlowNodeTable") }).strict(),
  z.object({ id: z.literal("resource-facts"), component: z.literal("FlowResourceFacts") }).strict(),
  z
    .object({
      id: z.literal("pending-approvals"),
      component: z.literal("FlowPendingApprovals"),
    })
    .strict(),
  z.object({ id: z.literal("outcome-notice"), component: z.literal("FlowOutcomeNotice") }).strict(),
]);

const noteTitleSchema = boundedSafeDisplayTextSchema(MAX_PRESENTATION_PACKAGE_NOTE_TITLE_BYTES);
const noteBodySchema = boundedSafeDisplayTextSchema(MAX_PRESENTATION_PACKAGE_NOTE_BODY_BYTES);
const packageNoteSchema = z.object({ title: noteTitleSchema, body: noteBodySchema }).strict();
const packageNotesComponentSchema = z
  .object({
    id: packageNotesIdSchema,
    component: z.literal("FlowPackageNotes"),
    notes: z.array(packageNoteSchema).min(1).max(MAX_PRESENTATION_PACKAGE_NOTES),
  })
  .strict()
  .superRefine((component, context) => {
    const bytes = component.notes.reduce(
      (total, note) =>
        total + Buffer.byteLength(note.title, "utf8") + Buffer.byteLength(note.body, "utf8"),
      0,
    );
    if (bytes > MAX_PRESENTATION_PACKAGE_NOTE_TEXT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "package note text exceeds its aggregate limit",
      });
    }
  });

const legacyComponentSchema = z.union([
  legacyLayoutComponentSchema,
  groupComponentSchema,
  leafComponentSchema,
]);
const contentComponentSchema = z.union([
  contentLayoutComponentSchema,
  groupComponentSchema,
  leafComponentSchema,
  packageNotesComponentSchema,
]);

function createSurfaceMessageSchema(catalogId: string) {
  return z
    .object({
      version: z.literal(PRESENTATION_PACKAGE_A2UI_VERSION),
      createSurface: z
        .object({
          surfaceId: z.literal(FLOW_A2UI_SURFACE_ID),
          catalogId: z.literal(catalogId),
        })
        .strict(),
    })
    .strict();
}

const legacyCreateSurfaceMessageSchema = createSurfaceMessageSchema(FLOW_A2UI_CATALOG_ID);
const contentCreateSurfaceMessageSchema = createSurfaceMessageSchema(FLOW_A2UI_CATALOG_V2_ID);
const legacyUpdateComponentsMessageSchema = z
  .object({
    version: z.literal(PRESENTATION_PACKAGE_A2UI_VERSION),
    updateComponents: z
      .object({
        surfaceId: z.literal(FLOW_A2UI_SURFACE_ID),
        components: z
          .array(legacyComponentSchema)
          .min(FLOW_PRESENTATION_WIDGETS.length + 1)
          .max(MAX_PRESENTATION_PACKAGE_COMPONENTS),
      })
      .strict(),
  })
  .strict();
const contentUpdateComponentsMessageSchema = z
  .object({
    version: z.literal(PRESENTATION_PACKAGE_A2UI_VERSION),
    updateComponents: z
      .object({
        surfaceId: z.literal(FLOW_A2UI_SURFACE_ID),
        components: z
          .array(contentComponentSchema)
          .min(FLOW_PRESENTATION_WIDGETS.length + 2)
          .max(MAX_PRESENTATION_PACKAGE_COMPONENTS + 1),
      })
      .strict(),
  })
  .strict();

const legacyPresentationDefinitionSchema = z
  .object({
    messages: z.tuple([legacyCreateSurfaceMessageSchema, legacyUpdateComponentsMessageSchema]),
  })
  .strict()
  .superRefine((definition, context) => {
    validatePresentationGraph(definition.messages[1].updateComponents.components, context, false);
  });
const contentPresentationDefinitionSchema = z
  .object({
    messages: z.tuple([contentCreateSurfaceMessageSchema, contentUpdateComponentsMessageSchema]),
  })
  .strict()
  .superRefine((definition, context) => {
    validatePresentationGraph(definition.messages[1].updateComponents.components, context, true);
  });
const presentationDefinitionSchema = z.union([
  legacyPresentationDefinitionSchema,
  contentPresentationDefinitionSchema,
]);

function boundedSafeDisplayTextSchema(maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes)
    .refine(isSafeDisplayText);
}

function validatePresentationGraph(
  components: readonly Readonly<{
    readonly id: string;
    readonly component: string;
    readonly children?: readonly string[];
  }>[],
  context: z.RefinementCtx,
  requiresPackageNotes: boolean,
): void {
  const byId = new Map<string, (typeof components)[number]>();
  for (const [index, component] of components.entries()) {
    if (byId.has(component.id)) {
      context.addIssue({
        code: "custom",
        path: ["messages", 1, "updateComponents", "components", index, "id"],
        message: "component ids must be unique",
      });
    }
    byId.set(component.id, component);
  }
  const root = byId.get("root");
  if (root?.component !== "FlowLayout" || root.children === undefined) {
    context.addIssue({ code: "custom", message: "the Flow layout root is required" });
    return;
  }
  if (requiresPackageNotes && root.children.at(-1) !== "package-notes") {
    context.addIssue({
      code: "custom",
      message: "package notes must be the final direct child of the Flow layout root",
    });
  }
  const visited = new Set<string>(["root"]);
  const widgets: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) {
      context.addIssue({ code: "custom", message: "component references must be unique" });
      return;
    }
    const component = byId.get(id);
    if (component === undefined) {
      context.addIssue({ code: "custom", message: "component references must resolve" });
      return;
    }
    visited.add(id);
    if (component.component === "FlowGroup" && component.children !== undefined) {
      for (const child of component.children) {
        visit(child);
      }
    } else if (component.component !== "FlowLayout" && component.component !== "FlowPackageNotes") {
      widgets.push(component.id);
    }
  };
  for (const child of root.children) {
    visit(child);
  }
  if (visited.size !== byId.size) {
    context.addIssue({ code: "custom", message: "every component must be reachable from root" });
  }
  if (
    widgets.length !== FLOW_PRESENTATION_WIDGETS.length ||
    FLOW_PRESENTATION_WIDGETS.some((widget) => !widgets.includes(widget))
  ) {
    context.addIssue({ code: "custom", message: "every Flow widget must appear exactly once" });
  }
}

export const presentationPackageManifestSchema = z
  .object({
    apiVersion: z.literal(PRESENTATION_PACKAGE_API_VERSION),
    kind: z.literal("PresentationPackage"),
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        description: z.string().trim().min(1).max(1024),
        license: z.string().trim().min(1).max(1024).optional(),
        compatibility: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    spec: presentationDefinitionSchema,
  })
  .strict();

const manifestSnapshotSchema = z
  .object({
    bytes: z.number().int().positive().max(MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES),
    sha256: sha256Schema,
    contentBase64: z.string().max(Math.ceil((MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES * 4) / 3) + 4),
  })
  .strict();

export const presentationPackageSnapshotSchema = z
  .object({
    kind: z.literal("presentation-package"),
    apiVersion: z.literal(PRESENTATION_PACKAGE_API_VERSION),
    name: verifierPackageNameSchema,
    version: verifierPackageVersionSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(1024).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    trust: z.literal("project-explicit"),
    provenance: portablePathSchema,
    definition: presentationDefinitionSchema,
    manifest: manifestSnapshotSchema,
    digest: sha256Schema,
  })
  .strict();

export type PresentationPackageDefinition = z.infer<typeof presentationDefinitionSchema>;
export type PresentationPackageManifest = z.infer<typeof presentationPackageManifestSchema>;
export type PresentationPackageSnapshot = z.infer<typeof presentationPackageSnapshotSchema>;
export type PresentationPackageComponent = z.infer<typeof contentComponentSchema>;
export type PresentationPackageNote = z.infer<typeof packageNoteSchema>;

export interface PresentationPackageSnapshotInput {
  readonly kind: "presentation-package";
  readonly trust: "project-explicit";
  readonly provenance: string;
  readonly manifest: { readonly content: Uint8Array };
}

export interface PresentationPackageReference {
  readonly name: string;
  readonly version: string;
}

export function parsePresentationPackageReference(value: string): PresentationPackageReference {
  const match = /^([^@]+)@([^@]+)$/.exec(value);
  const name = match?.[1];
  const version = match?.[2];
  if (
    name === undefined ||
    version === undefined ||
    !verifierPackageNameSchema.safeParse(name).success ||
    !verifierPackageVersionSchema.safeParse(version).success
  ) {
    throw new Error("presentation selection must use <name>@<exact-semantic-version>");
  }
  return Object.freeze({ name, version });
}

export function parsePresentationPackageManifest(
  source: Uint8Array,
  _label = "presentation package manifest",
): PresentationPackageManifest {
  if (source.byteLength === 0 || source.byteLength > MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES) {
    throw new Error("presentation package manifest is invalid");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error("invalid YAML");
    }
    const input = document.toJS({ maxAliasCount: 0 }) as unknown;
    const parsed = presentationPackageManifestSchema.safeParse(input);
    if (!parsed.success) {
      throw parsed.error;
    }
    return deepFreeze(parsed.data);
  } catch {
    throw new Error("presentation package manifest is invalid");
  }
}

export function createPresentationPackageSnapshot(
  input: PresentationPackageSnapshotInput,
): PresentationPackageSnapshot {
  const content = Buffer.from(input.manifest.content);
  const manifest = parsePresentationPackageManifest(content);
  const candidate = {
    kind: input.kind,
    apiVersion: manifest.apiVersion,
    name: manifest.metadata.name,
    version: manifest.metadata.version,
    description: manifest.metadata.description,
    ...(manifest.metadata.license === undefined ? {} : { license: manifest.metadata.license }),
    ...(manifest.metadata.compatibility === undefined
      ? {}
      : { compatibility: manifest.metadata.compatibility }),
    trust: input.trust,
    provenance: input.provenance,
    definition: manifest.spec,
    manifest: {
      bytes: content.byteLength,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    },
  };
  return validatePresentationPackageSnapshot({
    ...candidate,
    digest: calculatePresentationPackageDigest(candidate),
  });
}

export function validatePresentationPackageSnapshot(input: unknown): PresentationPackageSnapshot {
  try {
    const parsed = presentationPackageSnapshotSchema.parse(input);
    if (parsed.provenance.split("/").at(-1) !== parsed.name) {
      throw new Error("invalid provenance");
    }
    const content = decodeCanonicalBase64(parsed.manifest.contentBase64);
    if (
      content.byteLength !== parsed.manifest.bytes ||
      sha256(content) !== parsed.manifest.sha256
    ) {
      throw new Error("invalid manifest identity");
    }
    const manifest = parsePresentationPackageManifest(content);
    const expected = {
      apiVersion: parsed.apiVersion,
      kind: "PresentationPackage" as const,
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
      throw new Error("invalid reconstructed manifest");
    }
    if (calculatePresentationPackageDigest(parsed) !== parsed.digest) {
      throw new Error("invalid package digest");
    }
    return deepFreeze(parsed);
  } catch {
    throw new Error("presentation package snapshot is invalid");
  }
}

export function calculatePresentationPackageDigest(
  value: Omit<PresentationPackageSnapshot, "digest"> | PresentationPackageSnapshot,
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
    }),
  );
}

const NO_PRESENTATION_PACKAGE_NOTES: readonly PresentationPackageNote[] = Object.freeze([]);

export function presentationPackageNotes(
  snapshot: PresentationPackageSnapshot,
): readonly PresentationPackageNote[] {
  const components =
    validatePresentationPackageSnapshot(snapshot).definition.messages[1].updateComponents
      .components;
  const component = components.find((item) => item.id === "package-notes");
  if (component === undefined) {
    return NO_PRESENTATION_PACKAGE_NOTES;
  }
  if (component.component !== "FlowPackageNotes") {
    throw new Error("presentation package snapshot is invalid");
  }
  return component.notes;
}

export function orderedPresentationWidgets(
  snapshot: PresentationPackageSnapshot,
): readonly Readonly<{
  readonly widget: FlowPresentationWidget;
  readonly group: string | null;
  readonly variant: "stack" | "separated";
}>[] {
  const validated = validatePresentationPackageSnapshot(snapshot);
  const components = validated.definition.messages[1].updateComponents.components;
  const byId = new Map(components.map((component) => [component.id, component]));
  const root = byId.get("root");
  if (root?.component !== "FlowLayout") {
    throw new Error("presentation package snapshot is invalid");
  }
  const ordered: Array<{
    readonly widget: FlowPresentationWidget;
    readonly group: string | null;
    readonly variant: "stack" | "separated";
  }> = [];
  for (const child of root.children) {
    const component = byId.get(child);
    if (component?.component === "FlowGroup") {
      for (const widget of component.children) {
        ordered.push({ widget, group: component.id, variant: component.variant });
      }
    } else if (component?.component !== "FlowPackageNotes") {
      if (component === undefined || !widgetIdSchema.safeParse(child).success) {
        throw new Error("presentation package snapshot is invalid");
      }
      ordered.push({ widget: child as FlowPresentationWidget, group: null, variant: "stack" });
    }
  }
  return Object.freeze(ordered.map((item) => Object.freeze(item)));
}

export function presentationPackageDensity(
  snapshot: PresentationPackageSnapshot,
): "compact" | "comfortable" {
  const components =
    validatePresentationPackageSnapshot(snapshot).definition.messages[1].updateComponents
      .components;
  const root = components.find((component) => component.id === "root");
  if (root?.component !== "FlowLayout") {
    throw new Error("presentation package snapshot is invalid");
  }
  return root.density;
}

function decodeCanonicalBase64(value: string): Buffer {
  const content = Buffer.from(value, "base64");
  if (
    content.byteLength === 0 ||
    content.byteLength > MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES ||
    content.toString("base64") !== value
  ) {
    throw new Error("invalid canonical base64");
  }
  return content;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPortableRelativePath(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value.split("/").every(
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
