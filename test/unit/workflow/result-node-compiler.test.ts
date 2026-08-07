import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";

describe("typed result node compilation", () => {
  it("compiles and freezes a normalized closed result schema", () => {
    const workflow = compileWorkflowText(validResultWorkflow());
    const result = workflow.nodes.find((node) => node.id === "publish");

    expect(result).toMatchObject({
      id: "publish",
      type: "result",
      dependsOn: ["produce"],
      result: {
        source: { nodeId: "produce", field: "command.stdout" },
        schema: {
          type: "object",
          properties: {
            accepted: { type: "boolean" },
            score: { type: "number", minimum: 0, maximum: 1 },
            tags: {
              type: "array",
              maxItems: 4,
              items: { type: "string", maxLength: 32 },
            },
          },
          required: ["accepted", "score"],
        },
        schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result?.type === "result" &&
        Object.isFrozen(result.result) &&
        Object.isFrozen(result.result.schema) &&
        result.result.schema.type === "object" &&
        Object.isFrozen(result.result.schema.properties),
    ).toBe(true);
  });

  it("uses a stable schema identity independent of source property order", () => {
    const first = resultNode(validObjectSchema());
    const second = resultNode(`type: object
required: [accepted, score]
properties:
  tags: { type: array, items: { type: string, maxLength: 32 }, maxItems: 4 }
  score: { maximum: 1, type: number, minimum: 0 }
  accepted: { type: boolean }`);

    expect(first.result.schema).toEqual(second.result.schema);
    expect(first.result.schemaDigest).toBe(second.result.schemaDigest);
  });

  it("allows a result as a terminal node and as a direct typed evidence source", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: composed-results }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: first
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
  - id: final
    type: result
    dependsOn: [first]
    result:
      source: { nodeId: first, field: result.value }
      schema: { type: boolean }
`);

    expect(workflow.nodes.at(-1)).toMatchObject({
      id: "final",
      type: "result",
      result: { source: { nodeId: "first", field: "result.value" } },
    });
  });

  it("remaps result declarations inside bounded loop bodies", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: loop-result }
nodes:
  - id: start
    type: command
    command: { executable: node }
  - id: converge
    type: loop
    dependsOn: [start]
    loop:
      maxIterations: 2
      until:
        source: { nodeId: publish, field: result.value }
        equals: "true"
      body:
        nodes:
          - id: produce
            type: command
            command: { executable: node }
          - id: publish
            type: result
            dependsOn: [produce]
            result:
              source: { nodeId: produce, field: command.stdout }
              schema: { type: boolean }
  - id: finish
    type: command
    dependsOn: [converge]
    command: { executable: node }
`);

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "converge--i1--node--publish",
          type: "result",
          result: expect.objectContaining({
            source: {
              nodeId: "converge--i1--node--produce",
              field: "command.stdout",
            },
          }),
        }),
        expect.objectContaining({
          id: "converge--i2--check",
          type: "loop-check",
          loopCheck: expect.objectContaining({
            source: {
              nodeId: "converge--i2--node--publish",
              field: "result.value",
            },
          }),
        }),
      ]),
    );
  });

  it.each([
    ["unknown source", "missing", "command.stdout", ["produce"], "result_source_unknown"],
    ["self source", "publish", "result.value", ["produce", "publish"], "result_source_self"],
    [
      "non-direct source",
      "produce",
      "command.stdout",
      ["middle"],
      "result_source_requires_dependency",
    ],
    ["incompatible field", "produce", "agent.text", ["produce"], "result_source_field_mismatch"],
  ])("rejects an %s", (_name, sourceNodeId, sourceField, dependsOn, diagnosticCode) => {
    const error = captureCompilationError(
      sourceValidationWorkflow(sourceNodeId, sourceField, dependsOn),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
    );
  });

  it.each([
    ["string without maxLength", "{ type: string }"],
    ["array without maxItems", "{ type: array, items: { type: boolean } }"],
    ["array without items", "{ type: array, maxItems: 2 }"],
    ["object without properties", "{ type: object, required: [] }"],
    [
      "unknown object property",
      "{ type: object, properties: { ok: { type: boolean } }, required: [], additionalProperties: true }",
    ],
    [
      "missing required property",
      "{ type: object, properties: { ok: { type: boolean } }, required: [missing] }",
    ],
    [
      "prototype-named required property",
      "{ type: object, properties: {}, required: [constructor] }",
    ],
    ["reversed number bounds", "{ type: number, minimum: 2, maximum: 1 }"],
    ["unsafe integer bound", `{ type: integer, maximum: ${Number.MAX_SAFE_INTEGER + 1} }`],
  ])("rejects %s", (_name, schema) => {
    expect(() => resultNode(schema)).toThrow(/workflow compilation failed/i);
  });

  it("rejects schemas beyond the depth and node-count limits", () => {
    let tooDeep = "{ type: boolean }";
    for (let index = 0; index < 9; index += 1) {
      tooDeep = `{ type: array, maxItems: 1, items: ${tooDeep} }`;
    }
    expect(() => resultNode(tooDeep)).toThrow(/schema depth/i);

    const properties = Array.from(
      { length: 128 },
      (_, index) => `p${index}: { type: boolean }`,
    ).join(", ");
    expect(() =>
      resultNode(`{ type: object, properties: { ${properties} }, required: [] }`),
    ).toThrow(/schema nodes/i);
  });

  it("rejects adversarial nesting with a structured compilation diagnostic", () => {
    let tooDeep = "{ type: boolean }";
    for (let index = 0; index < 1_000; index += 1) {
      tooDeep = `{ type: array, maxItems: 1, items: ${tooDeep} }`;
    }

    const error = captureCompilationError(resultWorkflowSource(tooDeep));
    expect(error).toBeInstanceOf(WorkflowCompilationError);
    expect(error.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^invalid_(?:schema|yaml)$/),
          message: expect.stringMatching(/depth|stack/i),
        }),
      ]),
    );
  });
});

function resultNode(schema: string) {
  const workflow = compileWorkflowText(resultWorkflowSource(schema));
  const result = workflow.nodes.find((node) => node.id === "publish");
  if (result?.type !== "result") {
    throw new Error("compiled result node is missing");
  }
  return result;
}

function resultWorkflowSource(schema: string): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-schema }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema:
${indent(schema, 8)}
`;
}

function validResultWorkflow(): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: typed-result }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema:
${indent(validObjectSchema(), 8)}
`;
}

function validObjectSchema(): string {
  return `type: object
properties:
  score: { type: number, minimum: 0, maximum: 1 }
  accepted: { type: boolean }
  tags: { type: array, maxItems: 4, items: { type: string, maxLength: 32 } }
required: [score, accepted]`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function sourceValidationWorkflow(
  sourceNodeId: string,
  sourceField: string,
  dependsOn: readonly string[],
): string {
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: result-source }
nodes:
  - id: produce
    type: command
    command: { executable: node }
  - id: middle
    type: command
    dependsOn: [produce]
    command: { executable: node }
  - id: publish
    type: result
    dependsOn: [${dependsOn.join(", ")}]
    result:
      source: { nodeId: ${sourceNodeId}, field: ${sourceField} }
      schema: { type: boolean }
`;
}

function captureCompilationError(source: string): WorkflowCompilationError {
  try {
    compileWorkflowText(source);
  } catch (error) {
    return error as WorkflowCompilationError;
  }
  throw new Error("expected workflow compilation to fail");
}
