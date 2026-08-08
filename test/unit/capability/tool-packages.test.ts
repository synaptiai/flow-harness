import { describe, expect, it } from "vitest";

import {
  calculateToolPackageDigest,
  createToolPackageSnapshot,
  parseToolPackageManifest,
  type ToolPackageSnapshotInput,
  validateToolPackageSnapshot,
} from "../../../src/domain/capability/tool-packages.js";

describe("tool package contract", () => {
  it("parses a strict inert command-tool manifest and freezes exact source identity", () => {
    const source = manifest("project-report", "1.2.3");
    const parsed = parseToolPackageManifest(Buffer.from(source));

    expect(parsed).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "ToolPackage",
      metadata: { name: "project-report", version: "1.2.3" },
      spec: {
        tool: {
          name: "project_report",
          inputs: [
            { name: "path", type: "string" },
            { name: "format", type: "enum", values: ["json", "text"] },
            { name: "limit", type: "integer" },
            { name: "verbose", type: "boolean" },
          ],
        },
        driver: { kind: "command", version: "v1", executable: "reporter" },
        permissions: ["process.execute"],
      },
    });
    expect(Object.isFrozen(parsed.spec.tool.inputs)).toBe(true);

    const snapshot = createToolPackageSnapshot(snapshotInput(source, parsed));

    expect(snapshot).toMatchObject({
      kind: "tool-package",
      name: "project-report",
      version: "1.2.3",
      trust: "project-explicit",
      provenance: ".flow/tools/project-report",
      manifest: {
        bytes: Buffer.byteLength(source),
        contentBase64: Buffer.from(source).toString("base64"),
      },
    });
    expect(snapshot.digest).toBe(calculateToolPackageDigest(snapshot));
    expect(Object.isFrozen(snapshot.definition.tool.inputs)).toBe(true);
  });

  it.each([
    {
      label: "unknown top-level field",
      mutate: (source: string) => `${source}hooks: [run]\n`,
    },
    {
      label: "mutable version range",
      mutate: (source: string) => source.replace("version: 1.2.3", "version: ^1.2.3"),
    },
    {
      label: "reserved tool name",
      mutate: (source: string) => source.replace("name: project_report", "name: flow_exec"),
    },
    {
      label: "unsupported permission",
      mutate: (source: string) =>
        source.replace("permissions: [process.execute]", "permissions: [network.fetch]"),
    },
    {
      label: "partial argument interpolation",
      mutate: (source: string) => source.replace('"{input:path}"', '"--path={input:path}"'),
    },
    {
      label: "unused input",
      mutate: (source: string) => source.replace('    - "{input:verbose}"\n', ""),
    },
  ])("rejects an unsafe or ambiguous manifest: $label", ({ mutate }) => {
    expect(() => parseToolPackageManifest(Buffer.from(mutate(manifest())))).toThrow();
  });

  it("rejects forged snapshot bytes, definitions, provenance, and package digests", () => {
    const source = manifest();
    const parsed = parseToolPackageManifest(Buffer.from(source));
    const snapshot = createToolPackageSnapshot(snapshotInput(source, parsed));

    expect(() =>
      validateToolPackageSnapshot({
        ...snapshot,
        manifest: { ...snapshot.manifest, contentBase64: Buffer.from("forged").toString("base64") },
      }),
    ).toThrow(/manifest (byte count|digest)/i);
    expect(() =>
      validateToolPackageSnapshot({
        ...snapshot,
        definition: {
          ...snapshot.definition,
          driver: { ...snapshot.definition.driver, executable: "other" },
        },
      }),
    ).toThrow(/manifest disagrees/i);
    expect(() =>
      validateToolPackageSnapshot({ ...snapshot, provenance: ".flow/tools/other" }),
    ).toThrow(/provenance/i);
    expect(() => validateToolPackageSnapshot({ ...snapshot, digest: "0".repeat(64) })).toThrow(
      /package digest/i,
    );
  });

  it("rejects duplicate inputs and malformed enum definitions", () => {
    const duplicate = manifest().replace(
      "      - name: format",
      "      - name: path\n        description: Duplicate path.\n        type: string\n      - name: format",
    );
    expect(() => parseToolPackageManifest(Buffer.from(duplicate))).toThrow(/unique/i);

    const duplicateEnum = manifest().replace("values: [json, text]", "values: [json, json]");
    expect(() => parseToolPackageManifest(Buffer.from(duplicateEnum))).toThrow(/unique/i);
  });
});

function snapshotInput(
  source: string,
  parsed: ReturnType<typeof parseToolPackageManifest>,
): ToolPackageSnapshotInput {
  return {
    kind: "tool-package",
    apiVersion: parsed.apiVersion,
    name: parsed.metadata.name,
    version: parsed.metadata.version,
    description: parsed.metadata.description,
    license: parsed.metadata.license,
    compatibility: parsed.metadata.compatibility,
    trust: "project-explicit",
    provenance: `.flow/tools/${parsed.metadata.name}`,
    definition: parsed.spec,
    manifest: { content: Buffer.from(source) },
  };
}

function manifest(name = "project-report", version = "1.2.3"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: ${name}
  version: ${version}
  description: Produce a bounded project report.
  license: Apache-2.0
  compatibility: Requires reporter on PATH.
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
      - "{input:path}"
      - "{input:format}"
      - "{input:limit}"
      - "{input:verbose}"
    timeoutMs: 10000
  permissions: [process.execute]
`;
}
