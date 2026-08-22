import { describe, expect, it } from "vitest";

import {
  definePublicCapabilityCatalog,
  type PublicCapabilityCatalogInput,
} from "../../../../src/domain/capability/public-capability-reference.js";

describe("public capability catalog", () => {
  it("normalizes stable public arrays by identifier", () => {
    const catalog = definePublicCapabilityCatalog(
      fixture({
        limits: [limit("z-limit", 2), limit("a-limit", 1)],
        tools: [tool({ limitIds: [] })],
      }),
    );

    expect(catalog.limits.map((item) => item.id)).toEqual(["a-limit", "z-limit"]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.limits)).toBe(true);
  });

  it("rejects duplicate public identifiers", () => {
    expect(() =>
      definePublicCapabilityCatalog(
        fixture({
          limits: [limit("same-limit", 1), limit("same-limit", 2)],
        }),
      ),
    ).toThrow(/duplicate public limit identifier.*same-limit/u);
  });

  it("rejects a tool that references an undeclared public limit", () => {
    expect(() =>
      definePublicCapabilityCatalog(
        fixture({
          tools: [tool({ limitIds: ["missing-limit"] })],
        }),
      ),
    ).toThrow(/undeclared public limit.*missing-limit/u);
  });

  it("rejects non-finite values hidden inside a JSON Schema", () => {
    expect(() =>
      definePublicCapabilityCatalog(
        fixture({
          tools: [
            tool({
              inputSchema: {
                type: "object",
                properties: { count: { type: "number", maximum: Number.POSITIVE_INFINITY } },
              },
            }),
          ],
        }),
      ),
    ).toThrow(/finite JSON number/u);
  });
});

function fixture(
  overrides: Partial<PublicCapabilityCatalogInput> = {},
): PublicCapabilityCatalogInput {
  return {
    version: "flow.public-capabilities/v1",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    tools: [tool()],
    limits: [limit("read-output-bytes", 65_536)],
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
    ...overrides,
  };
}

function tool(
  overrides: Partial<PublicCapabilityCatalogInput["tools"][number]> = {},
): PublicCapabilityCatalogInput["tools"][number] {
  return {
    selector: "read",
    name: "flow_read",
    label: "read",
    description: "Read one admitted workspace file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    executionMode: "default",
    authority: ["read"],
    policyActions: ["filesystem.read"],
    availability: [],
    limitIds: ["read-output-bytes"],
    ...overrides,
  };
}

function limit(id: string, value: number): PublicCapabilityCatalogInput["limits"][number] {
  return {
    id,
    value,
    unit: "bytes",
    scope: "Maximum bytes returned by one read call.",
  };
}
