import { describe, expect, it } from "vitest";

import {
  definePublicCapabilityCatalog,
  type PublicCapabilityCatalogInput,
  PublicCapabilityCatalogValidationError,
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

  it("retains a safe location for public validation diagnostics", () => {
    try {
      definePublicCapabilityCatalog(
        fixture({ tools: [tool(), tool({ executionMode: "concurrent" as never })] }),
      );
      throw new Error("expected catalog validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicCapabilityCatalogValidationError);
      expect(error).toMatchObject({
        code: "invalid_public_capability_catalog",
        location: "tools[1]",
      });
    }
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

  it.each([
    ["execution mode", fixture({ tools: [tool({ executionMode: "concurrent" as never })] })],
    ["authority", fixture({ tools: [tool({ authority: ["root"] as never })] })],
    [
      "availability requirement",
      fixture({ tools: [tool({ availability: ["root-shell"] as never })] }),
    ],
    [
      "policy action",
      fixture({ tools: [tool({ policyActions: ["filesystem.delete"] as never })] }),
    ],
    [
      "limit unit",
      fixture({ limits: [{ ...limit("read-output-bytes", 1), unit: "seconds" as never }] }),
    ],
    [
      "capability extension",
      fixture({
        capabilityFamilies: [
          {
            kind: "agent-skill",
            title: "Agent Skills",
            summary: "Inert instruction packages.",
            extension: "static" as never,
          },
        ],
      }),
    ],
    [
      "execution seam openness",
      fixture({
        executionSeams: [
          {
            id: "model-provider",
            title: "Model provider",
            summary: "Resolve one provider at runtime.",
            openness: "closed" as never,
            implementation: "pi",
          },
        ],
      }),
    ],
    [
      "evaluation isolation",
      fixture({
        evaluationAdapters: [
          {
            id: "flow-workflow-v1",
            title: "Flow workflow",
            summary: "Execute one workflow.",
            isolation: "host-root" as never,
          },
        ],
      }),
    ],
  ])("rejects an unsupported %s at runtime", (_label, input) => {
    expect(() => definePublicCapabilityCatalog(input)).toThrow(/unsupported/u);
  });

  it("rejects a schema that is not valid Draft 2020-12", () => {
    expect(() =>
      definePublicCapabilityCatalog(
        fixture({ tools: [tool({ inputSchema: { type: "banana" } })] }),
      ),
    ).toThrow(/JSON Schema/u);
  });

  it("validates repeated schemas with the same identifier without retaining compiler state", () => {
    const input = fixture({
      tools: [
        tool({
          inputSchema: {
            $id: "https://flow.synapti.ai/schemas/test-public-tool",
            type: "object",
          },
        }),
      ],
    });

    expect(() => definePublicCapabilityCatalog(input)).not.toThrow();
    expect(() => definePublicCapabilityCatalog(input)).not.toThrow();
  });

  it("preserves an own __proto__ JSON Schema property", () => {
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as object;

    const catalog = definePublicCapabilityCatalog(fixture({ tools: [tool({ inputSchema })] }));
    const firstTool = catalog.tools[0];
    if (firstTool === undefined) {
      throw new Error("expected the public catalog fixture to contain one tool");
    }
    const properties = (firstTool.inputSchema as { properties?: object }).properties;

    expect(properties).toBeDefined();
    expect(Object.hasOwn(properties ?? {}, "__proto__")).toBe(true);
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
