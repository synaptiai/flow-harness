import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  calculatePresentationPackageDigest,
  createPresentationPackageSnapshot,
  FLOW_A2UI_CATALOG_ID,
  MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES,
  parsePresentationPackageManifest,
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

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
