import { describe, expect, it } from "vitest";

import {
  type WorkflowCompilationError,
  compileWorkflowText,
} from "../../../src/domain/workflow/compiler.js";

describe("bounded loop compilation", () => {
  it("expands a structured loop into deterministic iteration-qualified nodes", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: bounded-loop }
nodes:
  - id: repair
    type: loop
    loop:
      maxIterations: 2
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [scripts/probe.mjs] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`);

    expect(workflow.nodes.map((node) => node.id)).toEqual([
      "repair--i1--node--probe",
      "repair--i1--check",
      "repair--i2--node--probe",
      "repair--i2--check",
      "repair",
      "verify",
    ]);
    expect(workflow.nodes[0]).toMatchObject({
      id: "repair--i1--node--probe",
      type: "command",
      dependsOn: [],
      loopInstance: { loopId: "repair", iteration: 1, templateNodeId: "probe" },
    });
    expect(workflow.nodes[1]).toEqual({
      id: "repair--i1--check",
      type: "loop-check",
      dependsOn: ["repair--i1--node--probe"],
      loopCheck: {
        loopId: "repair",
        iteration: 1,
        source: { nodeId: "repair--i1--node--probe", field: "command.stdout" },
        equals: "pass",
      },
    });
    expect(workflow.nodes[2]).toMatchObject({
      id: "repair--i2--node--probe",
      dependsOn: ["repair--i1--check"],
      loopGuard: {
        loopId: "repair",
        iteration: 2,
        checkNodeId: "repair--i1--check",
      },
      loopInstance: { loopId: "repair", iteration: 2, templateNodeId: "probe" },
    });
    expect(workflow.nodes[4]).toEqual({
      id: "repair",
      type: "loop",
      dependsOn: ["repair--i1--check", "repair--i2--check"],
      loop: {
        maxIterations: 2,
        checkNodeIds: ["repair--i1--check", "repair--i2--check"],
      },
    });
    expect(workflow.nodes[5]?.dependsOn).toEqual(["repair"]);
    expect(workflow.nodes.every(Object.isFrozen)).toBe(true);
  });

  it("rejects an expanded loop control graph larger than the durable ledger contract", () => {
    const exactValue = "x".repeat(65_536);
    const source = `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: oversized-loop }
nodes:
  - id: repeat
    type: loop
    loop:
      maxIterations: 8
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: ${JSON.stringify(exactValue)}
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repeat]
    command: { executable: node, args: [verify] }
`;

    expect(() => compileWorkflowText(source)).toThrowError(
      expect.objectContaining<Partial<WorkflowCompilationError>>({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "control_graph_too_large", path: "nodes" }),
        ]),
      }),
    );
  });

  it.each([
    ["zero", "0"],
    ["fractional", "1.5"],
    ["above the hard maximum", "33"],
  ])("rejects a %s iteration bound at the schema boundary", (_name, maxIterations) => {
    expectDiagnostic(loopSource({ maxIterations }), "invalid_schema", "nodes.0.loop.maxIterations");
  });

  it("rejects nested loops at the body schema boundary", () => {
    expectDiagnostic(
      loopSource({
        body: `
          - id: nested
            type: loop
            loop:
              maxIterations: 1
              until:
                source: { nodeId: probe, field: command.stdout }
                equals: pass
              body:
                nodes:
                  - id: probe
                    type: command
                    command: { executable: node, args: [probe] }`,
      }),
      "invalid_schema",
      "nodes.0.loop.body.nodes.0.type",
    );
  });

  it.each([
    [
      "cross-scope dependency",
      `
          - id: probe
            type: command
            dependsOn: [outside]
            command: { executable: node, args: [probe] }`,
      "unknown_dependency",
    ],
    [
      "multiple body entries",
      `
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
          - id: sibling
            type: command
            command: { executable: node, args: [sibling] }`,
      "loop_body_entry_count",
    ],
    [
      "body cycle",
      `
          - id: probe
            type: command
            dependsOn: [again]
            command: { executable: node, args: [probe] }
          - id: again
            type: command
            dependsOn: [probe]
            command: { executable: node, args: [again] }`,
      "cycle",
    ],
  ])("rejects a loop body with a %s", (_name, body, diagnostic) => {
    expectDiagnostic(loopSource({ body }), diagnostic, "nodes.0.loop.body.nodes");
  });

  it.each([
    ["unknown local source", "missing", "command.stdout", "loop_source_unknown"],
    ["incompatible evidence field", "probe", "agent.text", "loop_source_field_mismatch"],
  ])("rejects an %s", (_name, sourceNodeId, sourceField, diagnostic) => {
    expectDiagnostic(
      loopSource({ sourceNodeId, sourceField }),
      diagnostic,
      "nodes.0.loop.until.source",
    );
  });

  it("rejects a stop source that only runs inside one conditional branch", () => {
    expectDiagnostic(
      loopSource({
        sourceNodeId: "probe",
        body: `
          - id: classify
            type: command
            command: { executable: node, args: [classify] }
          - id: route
            type: condition
            dependsOn: [classify]
            condition:
              source: { nodeId: classify, field: command.stdout }
              cases: [{ id: change, equals: change }]
              default: clean
          - id: probe
            type: command
            dependsOn: [route]
            when: { conditionId: route, case: change }
            command: { executable: node, args: [probe] }
          - id: clean
            type: command
            dependsOn: [route]
            when: { conditionId: route, case: clean }
            command: { executable: node, args: [clean] }
          - id: converge
            type: join
            join:
              conditionId: route
              branches:
                - { case: change, nodeId: probe }
                - { case: clean, nodeId: clean }`,
      }),
      "loop_source_not_unconditional",
      "nodes.0.loop.until.source.nodeId",
    );
  });

  it("rejects expansion beyond the finite compiled-node limit", () => {
    const body = Array.from({ length: 8 }, (_, index) => {
      const id = `step-${index + 1}`;
      const dependency = index === 0 ? "" : `\n            dependsOn: [step-${index}]`;
      return `
          - id: ${id}
            type: command${dependency}
            command: { executable: node, args: [${id}] }`;
    }).join("");

    expectDiagnostic(
      loopSource({ maxIterations: "32", sourceNodeId: "step-8", body }),
      "loop_expansion_too_large",
      "nodes",
    );
  });

  it("rejects generated durable identifiers longer than 128 characters", () => {
    const loopId = "l".repeat(96);
    const bodyId = "b".repeat(21);
    expectDiagnostic(
      loopSource({ loopId, sourceNodeId: bodyId, bodyId }),
      "loop_instance_id_too_long",
      "nodes.0.id",
    );
  });

  it("reports generated identity collisions when duplicate loop declarations expand", () => {
    expectDiagnostic(
      `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: duplicate-loop }
nodes:
  - id: repair
    type: loop
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
  - id: repair
    type: loop
    dependsOn: [repair]
    loop:
      maxIterations: 1
      until:
        source: { nodeId: probe, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: probe
            type: command
            command: { executable: node, args: [probe] }
  - id: verify
    type: command
    dependsOn: [repair]
    command: { executable: npm, args: [test] }
`,
      "loop_instance_id_collision",
      "nodes.1.id",
    );
  });

  it("remaps nested control references and preserves per-instance safety metadata", () => {
    const workflow = compileWorkflowText(
      loopSource({
        maxIterations: "2",
        sourceNodeId: "probe",
        body: `
          - id: classify
            type: command
            approval: { mode: required, grantTtlMs: 120000 }
            command: { executable: node, args: [classify] }
          - id: route
            type: condition
            dependsOn: [classify]
            condition:
              source: { nodeId: classify, field: command.stdout }
              cases: [{ id: change, equals: change }]
              default: clean
          - id: change
            type: agent
            dependsOn: [route]
            when: { conditionId: route, case: change }
            agent:
              prompt: Repair it.
              model: { provider: test, id: deterministic }
              recovery: { mode: fresh, maxAttempts: 3 }
          - id: clean
            type: command
            dependsOn: [route]
            when: { conditionId: route, case: clean }
            command: { executable: node, args: [clean] }
          - id: converge
            type: join
            join:
              conditionId: route
              branches:
                - { case: change, nodeId: change }
                - { case: clean, nodeId: clean }
          - id: probe
            type: command
            dependsOn: [converge]
            command: { executable: node, args: [probe] }`,
      }),
    );

    expect(workflow.nodes.find((node) => node.id === "repair--i2--node--classify")).toMatchObject({
      dependsOn: ["repair--i1--check"],
      approval: { mode: "required", grantTtlMs: 120000 },
    });
    expect(workflow.nodes.find((node) => node.id === "repair--i2--node--route")).toMatchObject({
      condition: { source: { nodeId: "repair--i2--node--classify" } },
    });
    expect(workflow.nodes.find((node) => node.id === "repair--i2--node--change")).toMatchObject({
      when: { conditionId: "repair--i2--node--route", case: "change" },
      agent: { recovery: { mode: "fresh", maxAttempts: 3 } },
    });
    expect(workflow.nodes.find((node) => node.id === "repair--i2--node--converge")).toMatchObject({
      dependsOn: ["repair--i2--node--change", "repair--i2--node--clean"],
      join: {
        conditionId: "repair--i2--node--route",
        branches: [
          { case: "change", nodeId: "repair--i2--node--change" },
          { case: "clean", nodeId: "repair--i2--node--clean" },
        ],
      },
    });
  });

  it("preserves the compiled shape of workflows without loops", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: legacy-shape }
nodes:
  - id: verify
    type: command
    command: { executable: npm, args: [test] }
`);

    expect(workflow.nodes).toEqual([
      {
        id: "verify",
        type: "command",
        dependsOn: [],
        command: { executable: "npm", args: ["test"], timeoutMs: 60000 },
      },
    ]);
  });
});

function expectDiagnostic(source: string, code: string, pathPrefix: string): void {
  expect(() => compileWorkflowText(source)).toThrowError(
    expect.objectContaining<Partial<WorkflowCompilationError>>({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code, path: expect.stringMatching(`^${pathPrefix}`) }),
      ]),
    }),
  );
}

function loopSource(
  options: {
    readonly loopId?: string;
    readonly maxIterations?: string;
    readonly sourceNodeId?: string;
    readonly sourceField?: string;
    readonly bodyId?: string;
    readonly body?: string;
  } = {},
): string {
  const loopId = options.loopId ?? "repair";
  const bodyId = options.bodyId ?? "probe";
  const sourceNodeId = options.sourceNodeId ?? bodyId;
  const body =
    options.body ??
    `
          - id: ${bodyId}
            type: command
            command: { executable: node, args: [probe] }`;
  return `
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: bounded-loop-contract }
nodes:
  - id: ${loopId}
    type: loop
    loop:
      maxIterations: ${options.maxIterations ?? "2"}
      until:
        source: { nodeId: ${sourceNodeId}, field: ${options.sourceField ?? "command.stdout"} }
        equals: pass
      body:
        nodes:${body}
  - id: verify
    type: command
    dependsOn: [${loopId}]
    command: { executable: npm, args: [test] }
`;
}
