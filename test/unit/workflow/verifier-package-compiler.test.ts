import { describe, expect, it } from "vitest";

import {
  compileWorkflowText,
  type WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

describe("verifier package workflow compilation", () => {
  it("compiles exact packaged command and provider-neutral packaged model selections", () => {
    const workflow = compileWorkflowText(validWorkflow());

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "release",
          type: "verifier",
          verifier: {
            kind: "packaged-command",
            package: { name: "release-tests", version: "1.0.0" },
          },
        }),
        expect.objectContaining({
          id: "review",
          type: "verifier",
          verifier: {
            kind: "packaged-model",
            package: { name: "evidence-review", version: "1.2.0" },
            evidence: [{ nodeId: "prepare", field: "command.stdout" }],
            model: { provider: "test", id: "deterministic", thinking: "medium" },
            maxOutputTokens: 8_192,
            timeoutMs: 120_000,
          },
        }),
      ]),
    );
  });

  it.each([
    [
      "inline command override",
      `kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
      command: { executable: node }`,
    ],
    [
      "model fields on a command package",
      `kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }`,
    ],
    [
      "missing model evidence",
      `kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      model: { provider: test, id: deterministic }`,
    ],
    [
      "version range",
      `kind: packaged-model
      package: { name: evidence-review, version: ^1.2.0 }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }`,
    ],
  ])("rejects %s at the strict schema boundary", (_label, verifier) => {
    expect(() => compileWorkflowText(workflowWithVerifier(verifier))).toThrow(
      /workflow compilation failed/i,
    );
  });

  it("applies ordinary model evidence dependency and field validation to packaged models", () => {
    const error = captureCompilationError(
      workflowWithVerifier(`kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      evidence: [{ nodeId: prepare, field: agent.text }]
      model: { provider: test, id: deterministic }`),
    );

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "verifier_source_field_mismatch" })]),
    );
  });

  it("remaps packaged model evidence inside bounded loops without changing package identity", () => {
    const workflow = compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-loop }
nodes:
  - id: review-loop
    type: loop
    loop:
      maxIterations: 2
      until:
        source: { nodeId: check, field: command.stdout }
        equals: pass
      body:
        nodes:
          - id: prepare
            type: command
            command: { executable: node }
          - id: review
            type: verifier
            dependsOn: [prepare]
            verifier:
              kind: packaged-model
              package: { name: evidence-review, version: 1.2.0 }
              evidence: [{ nodeId: prepare, field: command.stdout }]
              model: { provider: test, id: deterministic }
          - id: check
            type: command
            dependsOn: [review]
            command: { executable: node }
  - id: finish
    type: command
    dependsOn: [review-loop]
    command: { executable: node }
`);

    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review-loop--i2--node--review",
          verifier: expect.objectContaining({
            kind: "packaged-model",
            package: { name: "evidence-review", version: "1.2.0" },
            evidence: [{ nodeId: "review-loop--i2--node--prepare", field: "command.stdout" }],
          }),
        }),
      ]),
    );
  });

  it("binds the exact package version into the workflow digest", () => {
    const first = compileWorkflowText(validWorkflow());
    const second = compileWorkflowText(validWorkflow().replace("version: 1.2.0", "version: 1.2.1"));

    expect(calculateWorkflowDigest(first)).not.toBe(calculateWorkflowDigest(second));
  });
});

function validWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-verifiers }
nodes:
  - id: prepare
    type: command
    command: { executable: node }
  - id: release
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      kind: packaged-model
      package: { name: evidence-review, version: 1.2.0 }
      evidence: [{ nodeId: prepare, field: command.stdout }]
      model: { provider: test, id: deterministic }
      maxOutputTokens: 8192
      timeoutMs: 120000
`;
}

function workflowWithVerifier(verifier: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-invalid }
nodes:
  - id: prepare
    type: command
    command: { executable: node }
  - id: review
    type: verifier
    dependsOn: [prepare]
    verifier:
      ${verifier}
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
