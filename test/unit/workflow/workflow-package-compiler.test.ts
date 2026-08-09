import { describe, expect, it, vi } from "vitest";

import {
  compileWorkflowText,
  type ResolvedWorkflowPackage,
  WorkflowCompilationError,
} from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";

describe("workflow package compilation", () => {
  it("compiles a package-selected child through the ordinary child validation path", () => {
    const childSource = childWorkflow("packaged-child");
    const resolve = vi.fn(
      (): ResolvedWorkflowPackage => ({
        name: "release-check",
        version: "1.2.3",
        digest: "a".repeat(64),
        source: childSource,
      }),
    );

    const compiled = compileWorkflowText(packagedParent(), "parent.workflow.yaml", {
      packageResolver: { resolve },
    });
    const child = compiled.nodes[0];

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith({ name: "release-check", version: "1.2.3" });
    expect(child).toMatchObject({
      type: "child",
      child: {
        resultNodeId: "publish",
        workflow: {
          id: "packaged-child",
          sourcePackage: {
            name: "release-check",
            version: "1.2.3",
            digest: "a".repeat(64),
          },
        },
      },
    });
    const packagedWorkflow = child?.type === "child" ? child.child.workflow : undefined;
    const inlineWorkflow = compileWorkflowText(inlineParent(childSource)).nodes[0];
    expect(packagedWorkflow?.nodes).toEqual(
      inlineWorkflow?.type === "child" ? inlineWorkflow.child.workflow.nodes : undefined,
    );
    expect(Object.isFrozen(packagedWorkflow?.sourcePackage)).toBe(true);
  });

  it("does not change an inline child graph or digest when an unused resolver is supplied", () => {
    const source = inlineParent(childWorkflow("inline-child"));
    const baseline = compileWorkflowText(source);
    const resolve = vi.fn<() => ResolvedWorkflowPackage>();
    const withResolver = compileWorkflowText(source, "workflow", { packageResolver: { resolve } });

    expect(withResolver).toEqual(baseline);
    expect(calculateWorkflowDigest(withResolver)).toBe(calculateWorkflowDigest(baseline));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed when a selected package cannot be resolved exactly", () => {
    const missing = captureCompilationError(packagedParent());
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "workflow_package_unresolved", path: "child.package" }),
      ]),
    );

    const mismatched = captureCompilationError(packagedParent(), {
      resolve: () => ({
        name: "different",
        version: "1.2.3",
        digest: "a".repeat(64),
        source: childWorkflow("different"),
      }),
    });
    expect(mismatched.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "workflow_package_unresolved" })]),
    );
  });

  it("rejects an invalid packaged-root identity supplied through the compiler API", () => {
    for (const sourcePackage of [
      { name: "Release_Check", version: "1.0.0", digest: "a".repeat(64) },
      { name: "release-check", version: "latest", digest: "a".repeat(64) },
    ]) {
      expect(() =>
        compileWorkflowText(childWorkflow("packaged-root"), "workflow:invalid", {
          sourcePackage,
        }),
      ).toThrow(WorkflowCompilationError);
    }
  });

  it("bounds resolver failure detail in compilation diagnostics", () => {
    const error = captureCompilationError(packagedParent(), {
      resolve: () => {
        throw new Error("x".repeat(100_000));
      },
    });

    expect(error.diagnostics[0]?.message).toContain("[truncated]");
    expect(Buffer.byteLength(error.diagnostics[0]?.message ?? "", "utf8")).toBeLessThanOrEqual(
      4_096,
    );
  });

  it("rejects a transitive package cycle before exceeding the generic child-depth limit", () => {
    const packages = new Map<string, ResolvedWorkflowPackage>([
      [
        "first@1.0.0",
        {
          name: "first",
          version: "1.0.0",
          digest: "1".repeat(64),
          source: packagedChildWorkflow("first", "second"),
        },
      ],
      [
        "second@1.0.0",
        {
          name: "second",
          version: "1.0.0",
          digest: "2".repeat(64),
          source: packagedChildWorkflow("second", "first"),
        },
      ],
    ]);
    const source = packagedParent("first", "1.0.0");

    const error = captureCompilationError(source, {
      resolve: ({ name, version }) => {
        const resolved = packages.get(`${name}@${version}`);
        if (resolved === undefined) {
          throw new Error("missing fixture");
        }
        return resolved;
      },
    });

    expect(error.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "workflow_package_cycle" })]),
    );
  });
});

function captureCompilationError(
  source: string,
  packageResolver?: {
    readonly resolve: (reference: { name: string; version: string }) => ResolvedWorkflowPackage;
  },
): WorkflowCompilationError {
  try {
    compileWorkflowText(
      source,
      "workflow",
      packageResolver === undefined ? {} : { packageResolver },
    );
  } catch (error) {
    if (error instanceof WorkflowCompilationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected compilation to fail");
}

function packagedParent(name = "release-check", version = "1.2.3"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: packaged-parent }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      package: { name: ${name}, version: ${version} }
`;
}

function inlineParent(child: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: inline-parent }
budget:
  maxNodeStarts: 32
  maxModelTokens: 10000
  maxCostUsd: 2
  maxExecutionMs: 300000
nodes:
  - id: delegate
    type: child
    child:
      resultNodeId: publish
      workflow: |-
${indent(child, 8)}
`;
}

function childWorkflow(id: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 8
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
  maxArtifactBytes: 100000
nodes:
  - id: produce
    type: command
    command: { executable: /usr/bin/true }
  - id: publish
    type: result
    dependsOn: [produce]
    result:
      source: { nodeId: produce, field: command.stdout }
      schema: { type: boolean }
`;
}

function packagedChildWorkflow(id: string, packageName: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: ${id} }
budget:
  maxNodeStarts: 16
  maxModelTokens: 1000
  maxCostUsd: 0.25
  maxExecutionMs: 60000
  maxArtifactBytes: 100000
nodes:
  - id: nested
    type: child
    child:
      resultNodeId: publish
      package: { name: ${packageName}, version: 1.0.0 }
  - id: publish
    type: result
    dependsOn: [nested]
    result:
      source: { nodeId: nested, field: result.value }
      schema: { type: boolean }
`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .trim()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
