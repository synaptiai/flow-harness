import { describe, expect, it } from "vitest";

import { renderPublicCapabilityReference } from "../../../src/application/public-capability-reference.js";
import { definePublicCapabilityCatalog } from "../../../src/domain/capability/public-capability-reference.js";

describe("public capability reference rendering", () => {
  it("renders byte-identical artifacts from unchanged catalog input", () => {
    const catalog = fixture();

    expect(renderPublicCapabilityReference(catalog)).toEqual(
      renderPublicCapabilityReference(catalog),
    );
  });

  it("renders canonical JSON with an explicit schema dialect and terminal newline", () => {
    const rendered = renderPublicCapabilityReference(fixture());

    expect(rendered.json.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered.json)).toMatchObject({
      version: "flow.public-capabilities/v1",
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    });
    expect(rendered.json).not.toMatch(/generatedAt|\/private\/|\/Users\//u);
  });

  it("renders a generated Markdown reference that routes to canonical guidance", () => {
    const rendered = renderPublicCapabilityReference(fixture());

    expect(rendered.markdown).toContain("<!-- Generated file. Do not edit directly. -->");
    expect(rendered.markdown).toMatch(/^# Tools and capabilities$/mu);
    expect(rendered.markdown).toMatch(/^## Built-in model tools$/mu);
    expect(rendered.markdown).toMatch(/^## Capability-package families$/mu);
    expect(rendered.markdown).toMatch(/^## Provider and evaluation seams$/mu);
    expect(rendered.markdown).toContain("../architecture.md");
    expect(rendered.markdown).toContain("../guides/capability-packages.md");
    expect(rendered.markdown.endsWith("\n")).toBe(true);
    expect(rendered.markdown.endsWith("\n\n")).toBe(false);
  });

  it("renders schema and public-limit defaults in both artifacts", () => {
    const rendered = renderPublicCapabilityReference(fixture());
    const parsed = JSON.parse(rendered.json) as {
      readonly tools: readonly { readonly inputSchema: unknown }[];
      readonly limits: readonly { readonly default?: number }[];
    };

    expect(parsed.tools[0]?.inputSchema).toMatchObject({
      properties: { path: { default: "." } },
    });
    expect(parsed.limits[0]?.default).toBe(32_768);
    expect(rendered.markdown).toContain('"default": "."');
    expect(rendered.markdown).toContain("| `read-output-bytes` | 65536 bytes | 32768 bytes |");
  });
});

function fixture() {
  return definePublicCapabilityCatalog({
    version: "flow.public-capabilities/v1",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    tools: [
      {
        selector: "read",
        name: "flow_read",
        label: "read",
        description: "Read one admitted workspace file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", default: "." } },
          required: ["path"],
        },
        executionMode: "default",
        authority: ["read"],
        policyActions: ["filesystem.read"],
        availability: [],
        limitIds: ["read-output-bytes"],
      },
    ],
    limits: [
      {
        id: "read-output-bytes",
        value: 65_536,
        default: 32_768,
        unit: "bytes",
        scope: "Maximum bytes returned by one read call.",
      },
    ],
    capabilityFamilies: [
      {
        kind: "agent-skill",
        title: "Agent Skills",
        summary: "Inert instruction and resource packages selected by exact identity.",
        extension: "dynamic",
      },
    ],
    executionSeams: [
      {
        id: "model-provider",
        title: "Model provider",
        summary: "Provider and model identifiers resolve through the configured runtime.",
        openness: "open",
        implementation: "pi",
      },
    ],
    evaluationAdapters: [
      {
        id: "flow-workflow-v1",
        title: "Flow workflow",
        summary: "Execute the admitted workflow through Flow.",
        isolation: "flow-runtime",
      },
    ],
  });
}
