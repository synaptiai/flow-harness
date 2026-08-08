import { describe, expect, it } from "vitest";

import {
  calculateToolPackageInputDigest,
  renderToolPackageCommand,
} from "../../../src/domain/capability/tool-package-renderer.js";
import {
  createToolPackageSnapshot,
  parseToolPackageManifest,
  type ToolPackageSnapshot,
} from "../../../src/domain/capability/tool-packages.js";

describe("tool package command renderer", () => {
  it("renders required scalar inputs into literal argv with canonical receipts", () => {
    const snapshot = packageSnapshot();
    const rendered = renderToolPackageCommand(snapshot, {
      verbose: false,
      limit: 12,
      format: "json",
      path: "src; echo not-a-shell | ignored",
    });

    expect(rendered.request).toEqual({
      version: 1,
      executable: "reporter",
      args: ["--fixed", "src; echo not-a-shell | ignored", "json", "12", "false"],
      timeoutMs: 10_000,
    });
    expect(rendered.input).toEqual({
      path: "src; echo not-a-shell | ignored",
      format: "json",
      limit: 12,
      verbose: false,
    });
    expect(rendered.inputDigest).toBe(calculateToolPackageInputDigest(snapshot, rendered.input));
    expect(Object.isFrozen(rendered.request.args)).toBe(true);
    expect(Object.isFrozen(rendered.input)).toBe(true);
  });

  it("is deterministic regardless of caller object key order", () => {
    const snapshot = packageSnapshot();
    const first = renderToolPackageCommand(snapshot, {
      path: "src",
      format: "text",
      limit: -4,
      verbose: true,
    });
    const second = renderToolPackageCommand(snapshot, {
      verbose: true,
      limit: -4,
      format: "text",
      path: "src",
    });

    expect(second).toEqual(first);
  });

  it.each([
    { label: "missing input", input: { path: "src", format: "json", limit: 1 } },
    {
      label: "unknown input",
      input: { path: "src", format: "json", limit: 1, verbose: true, extra: "no" },
    },
    {
      label: "wrong string type",
      input: { path: 1, format: "json", limit: 1, verbose: true },
    },
    {
      label: "unknown enum",
      input: { path: "src", format: "xml", limit: 1, verbose: true },
    },
    {
      label: "non-integer number",
      input: { path: "src", format: "json", limit: 1.5, verbose: true },
    },
    {
      label: "unsafe integer",
      input: {
        path: "src",
        format: "json",
        limit: Number.MAX_SAFE_INTEGER + 1,
        verbose: true,
      },
    },
    {
      label: "wrong boolean type",
      input: { path: "src", format: "json", limit: 1, verbose: "true" },
    },
    {
      label: "excessive string",
      input: { path: "x".repeat(4_097), format: "json", limit: 1, verbose: true },
    },
    { label: "non-object", input: ["src", "json", 1, true] },
  ])("rejects malformed model input: $label", ({ input }) => {
    expect(() => renderToolPackageCommand(packageSnapshot(), input)).toThrow();
  });

  it("applies the existing agent-command bounds after rendering", () => {
    const snapshot = packageSnapshot(
      manifest().replace("executable: reporter", `executable: ${"x".repeat(1_025)}`),
    );

    expect(() =>
      renderToolPackageCommand(snapshot, {
        path: "src",
        format: "json",
        limit: 1,
        verbose: true,
      }),
    ).toThrow(/executable.*1024/i);
  });
});

function packageSnapshot(source = manifest()): ToolPackageSnapshot {
  const parsed = parseToolPackageManifest(Buffer.from(source));
  return createToolPackageSnapshot({
    kind: "tool-package",
    apiVersion: parsed.apiVersion,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    description: parsed.metadata.description,
    trust: "project-explicit",
    provenance: `.flow/tools/${parsed.metadata.name}`,
    definition: parsed.spec,
    manifest: { content: Buffer.from(source) },
  });
}

function manifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-report
  version: 1.2.3
  description: Produce a bounded project report.
spec:
  tool:
    name: project_report
    description: Produce a project report from scalar inputs.
    inputs:
      - name: path
        description: Relative path to inspect.
        type: string
      - name: format
        description: Output representation.
        type: enum
        values: [json, text]
      - name: limit
        description: Maximum entries.
        type: integer
      - name: verbose
        description: Include verbose details.
        type: boolean
  driver:
    kind: command
    version: v1
    executable: reporter
    args:
      - --fixed
      - "{input:path}"
      - "{input:format}"
      - "{input:limit}"
      - "{input:verbose}"
    timeoutMs: 10000
  permissions: [process.execute]
`;
}
