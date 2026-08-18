import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  calculatePresentationPackageDigest,
  createPresentationPackageSnapshot,
  FLOW_A2UI_CATALOG_ID,
  FLOW_A2UI_CATALOG_V2_ID,
  MAX_PRESENTATION_PACKAGE_COMPONENTS,
  MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES,
  MAX_PRESENTATION_PACKAGE_NOTE_BODY_BYTES,
  MAX_PRESENTATION_PACKAGE_NOTE_TEXT_BYTES,
  MAX_PRESENTATION_PACKAGE_NOTE_TITLE_BYTES,
  parsePresentationPackageManifest,
  presentationPackageNotes,
  validatePresentationPackageSnapshot,
} from "../../../src/domain/capability/presentation-packages.js";

const encoder = new TextEncoder();

function manifest(
  components: readonly Readonly<Record<string, unknown>>[] = validComponents(),
): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: operations
  version: 1.0.0
  description: Closed operator layout
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: ${FLOW_A2UI_CATALOG_ID}
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
${components.map((component) => yamlComponent(component)).join("\n")}
`;
}

function validComponents(): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      id: "root",
      component: "FlowLayout",
      density: "compact",
      children: ["group-1", "group-2"],
    },
    {
      id: "group-1",
      component: "FlowGroup",
      variant: "stack",
      children: ["run-summary", "graph-progress", "node-table"],
    },
    {
      id: "group-2",
      component: "FlowGroup",
      variant: "separated",
      children: ["resource-facts", "pending-approvals", "outcome-notice"],
    },
    { id: "run-summary", component: "FlowRunSummary" },
    { id: "graph-progress", component: "FlowGraphProgress" },
    { id: "node-table", component: "FlowNodeTable" },
    { id: "resource-facts", component: "FlowResourceFacts" },
    { id: "pending-approvals", component: "FlowPendingApprovals" },
    { id: "outcome-notice", component: "FlowOutcomeNotice" },
  ];
}

function maximumComponents(): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      id: "root",
      component: "FlowLayout",
      density: "comfortable",
      children: ["group-1", "group-2", "group-3", "group-4", "group-5", "group-6"],
    },
    ...[
      "run-summary",
      "graph-progress",
      "node-table",
      "resource-facts",
      "pending-approvals",
      "outcome-notice",
    ].map((widget, index) => ({
      id: `group-${index + 1}`,
      component: "FlowGroup",
      variant: "stack",
      children: [widget],
    })),
    ...validComponents().filter(
      (component) => !["root", "group-1", "group-2"].includes(String(component.id)),
    ),
  ];
}

function contentManifest(
  notes: readonly { readonly title: string; readonly body: string }[] = [
    { title: "Operator context", body: "This text is package-provided information." },
  ],
): string {
  const noteLines = notes
    .map(
      (note) =>
        `              - title: ${JSON.stringify(note.title)}\n                body: ${JSON.stringify(note.body)}`,
    )
    .join("\n");
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: operations
  version: 1.0.0
  description: Closed operator layout with attributed content
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: ${FLOW_A2UI_CATALOG_V2_ID}
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - id: root
            component: FlowLayout
            density: compact
            children: [group-1, group-2, package-notes]
          - id: group-1
            component: FlowGroup
            variant: stack
            children: [run-summary, graph-progress, node-table]
          - id: group-2
            component: FlowGroup
            variant: separated
            children: [resource-facts, pending-approvals, outcome-notice]
          - id: package-notes
            component: FlowPackageNotes
            notes:
${noteLines}
          - id: run-summary
            component: FlowRunSummary
          - id: graph-progress
            component: FlowGraphProgress
          - id: node-table
            component: FlowNodeTable
          - id: resource-facts
            component: FlowResourceFacts
          - id: pending-approvals
            component: FlowPendingApprovals
          - id: outcome-notice
            component: FlowOutcomeNotice
`;
}

describe("presentation package contract", () => {
  it("parses a static A2UI v0.9 Flow-catalog surface from the v0.9.1 release", () => {
    const parsed = parsePresentationPackageManifest(encoder.encode(manifest()));

    expect(parsed.spec.messages).toHaveLength(2);
    expect(parsed.spec.messages[0]).toEqual({
      version: "v0.9",
      createSurface: { surfaceId: "flow-run", catalogId: FLOW_A2UI_CATALOG_ID },
    });
    expect(parsed.spec.messages[1]).toMatchObject({
      version: "v0.9",
      updateComponents: { surfaceId: "flow-run" },
    });
  });

  it("validates the frozen messages through the official A2UI envelope and Flow catalog seam", () => {
    const common = readJson(
      new URL("../../fixtures/a2ui-v0.9/common-types-profile.schema.json", import.meta.url),
    );
    const server = readJson(
      new URL("../../fixtures/a2ui-v0.9/server-to-client-profile.schema.json", import.meta.url),
    );
    const catalog = readJson(
      new URL("../../../docs/specs/flow-a2ui-run-presentation-v1.catalog.json", import.meta.url),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(common);
    ajv.addSchema(
      { ...catalog, $id: "https://a2ui.org/specification/v0_9/catalog.json" },
      "https://a2ui.org/specification/v0_9/catalog.json",
    );
    const validate = ajv.compile(server);
    const messages = parsePresentationPackageManifest(encoder.encode(manifest())).spec.messages;

    for (const message of messages) {
      expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("accepts bounded static notes through the additive A2UI catalog", () => {
    const parsed = parsePresentationPackageManifest(
      encoder.encode(
        contentManifest([
          { title: "Operator context", body: "This text is package-provided information." },
          { title: "Review scope", body: "Flow still owns run status and actions." },
        ]),
      ),
    );
    const snapshot = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: encoder.encode(contentManifest()) },
    });

    expect(parsed.spec.messages[0]).toEqual({
      version: "v0.9",
      createSurface: { surfaceId: "flow-run", catalogId: FLOW_A2UI_CATALOG_V2_ID },
    });
    expect(presentationPackageNotes(snapshot)).toEqual([
      { title: "Operator context", body: "This text is package-provided information." },
    ]);
    expect(Object.isFrozen(presentationPackageNotes(snapshot))).toBe(true);
  });

  it("validates content-bearing messages through the official A2UI envelope and v2 catalog", () => {
    const common = readJson(
      new URL("../../fixtures/a2ui-v0.9/common-types-profile.schema.json", import.meta.url),
    );
    const server = readJson(
      new URL("../../fixtures/a2ui-v0.9/server-to-client-profile.schema.json", import.meta.url),
    );
    const catalog = readJson(
      new URL("../../../docs/specs/flow-a2ui-run-presentation-v2.catalog.json", import.meta.url),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(common);
    ajv.addSchema(
      { ...catalog, $id: "https://a2ui.org/specification/v0_9/catalog.json" },
      "https://a2ui.org/specification/v0_9/catalog.json",
    );
    const validate = ajv.compile(server);

    for (const message of parsePresentationPackageManifest(encoder.encode(contentManifest())).spec
      .messages) {
      expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("preserves the exact legacy catalog identity and digest", () => {
    const snapshot = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: encoder.encode(manifest()) },
    });

    expect(FLOW_A2UI_CATALOG_ID).toBe("https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1");
    expect(snapshot.digest).toBe(
      "a10fc92c0a5a8c984725ac75db1bcd7f44a9738a3ba382581bcfa4b87c060ee3",
    );
    expect(presentationPackageNotes(snapshot)).toEqual([]);
  });

  it("binds exact note text into the content-bearing package identity", () => {
    const first = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: {
        content: encoder.encode(contentManifest([{ title: "Context", body: "Review alpha." }])),
      },
    });
    const second = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: {
        content: encoder.encode(contentManifest([{ title: "Context", body: "Review bravo." }])),
      },
    });

    expect(first.manifest.bytes).toBe(second.manifest.bytes);
    expect(first.manifest.sha256).not.toBe(second.manifest.sha256);
    expect(first.digest).not.toBe(second.digest);
    expect(presentationPackageNotes(first)).toEqual([{ title: "Context", body: "Review alpha." }]);
    expect(presentationPackageNotes(second)).toEqual([{ title: "Context", body: "Review bravo." }]);
  });

  it("enforces exact UTF-8 and aggregate note limits", () => {
    const exactTitle = "é".repeat(MAX_PRESENTATION_PACKAGE_NOTE_TITLE_BYTES / 2);
    const exactBody = "é".repeat(MAX_PRESENTATION_PACKAGE_NOTE_BODY_BYTES / 2);
    const exactAggregate = Array.from({ length: 4 }, (_, index) => ({
      title: String(index),
      body: "x".repeat(MAX_PRESENTATION_PACKAGE_NOTE_TEXT_BYTES / 4 - 1),
    }));

    expect(
      parsePresentationPackageManifest(
        encoder.encode(contentManifest([{ title: exactTitle, body: exactBody }])),
      ).metadata.name,
    ).toBe("operations");
    expect(
      parsePresentationPackageManifest(encoder.encode(contentManifest(exactAggregate))).metadata
        .name,
    ).toBe("operations");

    for (const notes of [
      [{ title: `${exactTitle}a`, body: "body" }],
      [{ title: "title", body: `${exactBody}a` }],
      Array.from({ length: 4 }, (_, index) => ({
        title: String(index),
        body: "x".repeat(MAX_PRESENTATION_PACKAGE_NOTE_TEXT_BYTES / 4),
      })),
      Array.from({ length: 5 }, (_, index) => ({ title: String(index), body: "body" })),
    ]) {
      expect(() =>
        parsePresentationPackageManifest(encoder.encode(contentManifest(notes))),
      ).toThrow("presentation package manifest is invalid");
    }
  });

  it.each([
    ["an unsafe title", () => contentManifest([{ title: "PRIVATE\nTITLE", body: "body" }])],
    ["an unsafe body", () => contentManifest([{ title: "title", body: "PRIVATE\u202eBODY" }])],
    ["a blank title", () => contentManifest([{ title: "   ", body: "body" }])],
    ["a blank body", () => contentManifest([{ title: "title", body: "   " }])],
    ["an empty note list", () => contentManifest([])],
    ["a content catalog without its note leaf", () => contentManifestWithoutNotes()],
    [
      "a binding in note text",
      () =>
        contentManifest().replace(
          'body: "This text is package-provided information."',
          "body:\n                  path: /PRIVATE/note",
        ),
    ],
    [
      "a package link",
      () =>
        contentManifest().replace(
          'body: "This text is package-provided information."',
          'body: "This text is package-provided information."\n                link: https://PRIVATE.example',
        ),
    ],
    [
      "a remote package resource",
      () =>
        contentManifest().replace(
          'body: "This text is package-provided information."',
          'body: "This text is package-provided information."\n                resource: https://PRIVATE.example/note.json',
        ),
    ],
    [
      "a package function",
      () =>
        contentManifest().replace(
          'body: "This text is package-provided information."',
          'body: "This text is package-provided information."\n                functionCall: PRIVATE_FUNCTION',
        ),
    ],
    [
      "an executable package field",
      () =>
        contentManifest().replace(
          'body: "This text is package-provided information."',
          'body: "This text is package-provided information."\n                script: PRIVATE_EXECUTABLE',
        ),
    ],
    [
      "a package action",
      () =>
        contentManifest().replace(
          "component: FlowPackageNotes",
          "component: FlowPackageNotes\n            action: PRIVATE_ACTION",
        ),
    ],
    [
      "a misplaced content leaf",
      () =>
        contentManifest().replace(
          "children: [group-1, group-2, package-notes]",
          "children: [package-notes, group-1, group-2]",
        ),
    ],
    [
      "legacy catalog content",
      () => contentManifest().replace(FLOW_A2UI_CATALOG_V2_ID, FLOW_A2UI_CATALOG_ID),
    ],
  ])("rejects %s without exposing private values", (_label, source) => {
    expect(() => parsePresentationPackageManifest(encoder.encode(source()))).toThrow(
      "presentation package manifest is invalid",
    );
    try {
      parsePresentationPackageManifest(encoder.encode(source()));
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  });

  it("accepts the exact manifest byte limit and rejects one byte more", () => {
    const source = manifest();
    const padding = MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES - Buffer.byteLength(source) - 2;
    const exact = `${source}#${"x".repeat(padding)}\n`;

    expect(Buffer.byteLength(exact)).toBe(MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES);
    expect(parsePresentationPackageManifest(encoder.encode(exact)).metadata.name).toBe(
      "operations",
    );
    expect(() => parsePresentationPackageManifest(encoder.encode(`${exact}#`))).toThrow(
      "presentation package manifest is invalid",
    );
  });

  it("accepts the exact closed graph maximum", () => {
    const parsed = parsePresentationPackageManifest(encoder.encode(manifest(maximumComponents())));

    expect(parsed.spec.messages[1].updateComponents.components).toHaveLength(13);
  });

  it("accepts the exact content-bearing graph maximum", () => {
    const parsed = parsePresentationPackageManifest(encoder.encode(maximumContentManifest()));

    expect(MAX_PRESENTATION_PACKAGE_COMPONENTS).toBe(14);
    expect(parsed.spec.messages[1].updateComponents.components).toHaveLength(
      MAX_PRESENTATION_PACKAGE_COMPONENTS,
    );
  });

  it.each([
    [
      "a seventh layout group",
      [
        ...maximumComponents(),
        { id: "group-7", component: "FlowGroup", variant: "stack", children: ["run-summary"] },
      ],
    ],
    [
      "nested groups beyond the closed depth",
      validComponents().map((component) =>
        component.id === "group-1" ? { ...component, children: ["group-2"] } : component,
      ),
    ],
  ])("rejects %s", (_label, components) => {
    expect(() => parsePresentationPackageManifest(encoder.encode(manifest(components)))).toThrow(
      "presentation package manifest is invalid",
    );
  });

  it.each([
    ["invalid UTF-8", Uint8Array.from([0xff])],
    ["invalid YAML", encoder.encode("[PRIVATE_INVALID_YAML")],
  ])("rejects %s without exposing source values", (_label, source) => {
    expect(() => parsePresentationPackageManifest(source)).toThrow(
      "presentation package manifest is invalid",
    );
    try {
      parsePresentationPackageManifest(source);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  });

  it("creates a self-authenticating frozen snapshot whose digest binds layout order", () => {
    const source = encoder.encode(manifest());
    const snapshot = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: source },
    });

    expect(validatePresentationPackageSnapshot(snapshot)).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.digest).toBe(calculatePresentationPackageDigest(snapshot));

    const reordered = validComponents().map((component) =>
      component.id === "group-1"
        ? { ...component, children: ["node-table", "graph-progress", "run-summary"] }
        : component,
    );
    const other = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: encoder.encode(manifest(reordered)) },
    });
    expect(other.digest).not.toBe(snapshot.digest);
  });

  it("keeps semantic identity across an equivalent YAML re-encoding", () => {
    const original = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: encoder.encode(manifest()) },
    });
    const reformatted = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: {
        content: encoder.encode(
          manifest().replace(
            "description: Closed operator layout",
            "description: 'Closed operator layout'",
          ),
        ),
      },
    });

    expect(reformatted.manifest.sha256).not.toBe(original.manifest.sha256);
    expect(reformatted.digest).toBe(original.digest);
  });

  it.each([
    ["missing widget", validComponents().filter((item) => item.id !== "outcome-notice")],
    [
      "duplicate widget reference",
      validComponents().map((item) =>
        item.id === "group-2"
          ? {
              ...item,
              children: ["resource-facts", "pending-approvals", "outcome-notice", "run-summary"],
            }
          : item,
      ),
    ],
    [
      "unreachable component",
      [
        ...validComponents(),
        { id: "group-3", component: "FlowGroup", variant: "stack", children: ["run-summary"] },
      ],
    ],
    [
      "duplicate component id",
      [...validComponents(), { id: "outcome-notice", component: "FlowOutcomeNotice" }],
    ],
    [
      "root self-reference",
      validComponents().map((item) =>
        item.id === "root" ? { ...item, children: ["root", "group-1", "group-2"] } : item,
      ),
    ],
    [
      "unknown component",
      validComponents().map((item) =>
        item.id === "run-summary" ? { ...item, component: "PRIVATEUnknown" } : item,
      ),
    ],
    [
      "dynamic children",
      validComponents().map((item) =>
        item.id === "group-1" ? { ...item, children: { path: "/private/widgets" } } : item,
      ),
    ],
    [
      "arbitrary text",
      validComponents().map((item) =>
        item.id === "run-summary" ? { ...item, text: "PRIVATE PACKAGE TEXT" } : item,
      ),
    ],
    [
      "package action",
      validComponents().map((item) =>
        item.id === "run-summary" ? { ...item, action: { event: { name: "PRIVATE" } } } : item,
      ),
    ],
    [
      "package data",
      validComponents().map((item) =>
        item.id === "run-summary" ? { ...item, data: { value: "PRIVATE" } } : item,
      ),
    ],
    [
      "package function",
      validComponents().map((item) =>
        item.id === "run-summary" ? { ...item, functionCall: { call: "PRIVATE_FUNCTION" } } : item,
      ),
    ],
  ])("rejects %s without exposing private values", (_label, components) => {
    expect(() => parsePresentationPackageManifest(encoder.encode(manifest(components)))).toThrow(
      "presentation package manifest is invalid",
    );
    try {
      parsePresentationPackageManifest(encoder.encode(manifest(components)));
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  });

  it("rejects protocol, catalog, theme, and client-data-model authority", () => {
    for (const changed of [
      manifest().replace("version: v0.9", "version: v1.0"),
      manifest().replace("kind: PresentationPackage", "kind: PresentationPackage\nPRIVATE: true"),
      manifest().replace(FLOW_A2UI_CATALOG_ID, "https://private.example/catalog"),
      manifest().replace(
        "catalogId:",
        "theme:\n          primaryColor: '#000000'\n        catalogId:",
      ),
      manifest().replace("catalogId:", "inlineCatalogs: []\n        catalogId:"),
      manifest().replace("catalogId:", "sendDataModel: true\n        catalogId:"),
    ]) {
      expect(() => parsePresentationPackageManifest(encoder.encode(changed))).toThrow(
        "presentation package manifest is invalid",
      );
    }
  });

  it("rejects tampered snapshot bytes and structural identity", () => {
    const snapshot = createPresentationPackageSnapshot({
      kind: "presentation-package",
      trust: "project-explicit",
      provenance: "presentations/operations",
      manifest: { content: encoder.encode(manifest()) },
    });
    expect(() =>
      validatePresentationPackageSnapshot({ ...snapshot, digest: "0".repeat(64) }),
    ).toThrow("presentation package snapshot is invalid");
    expect(() =>
      validatePresentationPackageSnapshot({
        ...snapshot,
        manifest: { ...snapshot.manifest, bytes: snapshot.manifest.bytes + 1 },
      }),
    ).toThrow("presentation package snapshot is invalid");
  });
});

function yamlComponent(component: Readonly<Record<string, unknown>>): string {
  const lines = [
    `          - id: ${String(component.id)}`,
    `            component: ${String(component.component)}`,
  ];
  for (const [key, value] of Object.entries(component)) {
    if (key === "id" || key === "component") {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`            ${key}: [${value.join(", ")}]`);
    } else if (typeof value === "object" && value !== null) {
      const [innerKey, innerValue] = Object.entries(value)[0] ?? [];
      lines.push(`            ${key}:`);
      lines.push(`              ${String(innerKey)}: ${String(innerValue)}`);
    } else {
      lines.push(`            ${key}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

function contentManifestWithoutNotes(): string {
  const source = contentManifest().replace(
    "children: [group-1, group-2, package-notes]",
    "children: [group-1, group-2]",
  );
  const start = source.indexOf("          - id: package-notes\n");
  const end = source.indexOf("          - id: run-summary\n");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("test fixture is invalid");
  }
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function maximumContentManifest(): string {
  return manifest(maximumComponents())
    .replace(FLOW_A2UI_CATALOG_ID, FLOW_A2UI_CATALOG_V2_ID)
    .replace(
      "children: [group-1, group-2, group-3, group-4, group-5, group-6]",
      "children: [group-1, group-2, group-3, group-4, group-5, group-6, package-notes]",
    )
    .replace(
      "          - id: run-summary\n",
      `          - id: package-notes
            component: FlowPackageNotes
            notes:
              - title: Operator context
                body: This text is package-provided information.
          - id: run-summary
`,
    );
}

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
