import { describe, expect, it } from "vitest";

import {
  calculateToolPackageDigest,
  createToolPackageSnapshot,
  parseToolPackageManifest,
  type ToolPackageSnapshotInput,
  validateToolPackageSnapshot,
} from "../../../src/domain/capability/tool-packages.js";
import {
  MAX_AGENT_COMMAND_ARG_BYTES,
  MAX_AGENT_COMMAND_ARGS,
  MAX_AGENT_COMMAND_ARGS_BYTES,
} from "../../../src/domain/command-envelope.js";

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
        driver: {
          kind: "command",
          version: "v1",
          profile: "posix-printf-v1",
          executable: "/usr/bin/printf",
        },
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
      mutate: (source: string) => source.replace(', "{input:verbose}"', ""),
    },
    {
      label: "shell interpreter",
      mutate: (source: string) =>
        source
          .replace("executable: /usr/bin/printf", "executable: sh")
          .replace(
            '    args: ["%s\\\\n%s\\\\n%s\\\\n%s\\\\n", "{input:path}", "{input:format}", "{input:limit}", "{input:verbose}"]',
            '    args: [-c, "{input:path}", "{input:format}", "{input:limit}", "{input:verbose}"]',
          ),
    },
    {
      label: "workspace executable path",
      mutate: (source: string) =>
        source.replace("executable: /usr/bin/printf", "executable: ./printf"),
    },
  ])("rejects an unsafe or ambiguous manifest: $label", ({ mutate }) => {
    expect(() => parseToolPackageManifest(Buffer.from(mutate(manifest())))).toThrow();
  });

  it("rejects command definitions outside the live agent-command envelope", () => {
    expect(() =>
      parseToolPackageManifest(
        Buffer.from(manifest().replace("timeoutMs: 10000", "timeoutMs: 600001")),
      ),
    ).toThrow(/timeout/i);
    expect(() =>
      parseToolPackageManifest(
        Buffer.from(
          manifest().replace("executable: /usr/bin/printf", `executable: ${"x".repeat(1_025)}`),
        ),
      ),
    ).toThrow(/executable/i);
  });

  it("shares the live argument-count boundary", () => {
    const atLimit = [
      "%s".repeat(MAX_AGENT_COMMAND_ARGS - 1),
      ...Array.from({ length: MAX_AGENT_COMMAND_ARGS - 1 }, () => ""),
    ];
    const overLimit = [
      "%s".repeat(MAX_AGENT_COMMAND_ARGS),
      ...Array.from({ length: MAX_AGENT_COMMAND_ARGS }, () => ""),
    ];

    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest(atLimit)))).not.toThrow();
    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest(overLimit)))).toThrow(
      new RegExp(String(MAX_AGENT_COMMAND_ARGS)),
    );
  });

  it("shares the live per-argument UTF-8 byte boundary", () => {
    const atLimit = "é".repeat(MAX_AGENT_COMMAND_ARG_BYTES / 2);
    const overLimit = `${atLimit}a`;

    expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_AGENT_COMMAND_ARG_BYTES);
    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest([atLimit])))).not.toThrow();
    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest([overLimit])))).toThrow(
      new RegExp(`${MAX_AGENT_COMMAND_ARG_BYTES} UTF-8 bytes`),
    );
  });

  it("shares the live aggregate argument-byte boundary", () => {
    const format = `${"a".repeat(MAX_AGENT_COMMAND_ARG_BYTES - 16)}${"%s".repeat(8)}`;
    const atLimit = [
      format,
      ...Array.from({ length: 3 }, () => "a".repeat(8_192)),
      "",
      "",
      "",
      "",
      "",
    ];
    const overLimit = [...atLimit];
    overLimit[overLimit.length - 1] = "a";

    expect(atLimit.reduce((total, arg) => total + Buffer.byteLength(arg), 0)).toBe(
      MAX_AGENT_COMMAND_ARGS_BYTES,
    );
    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest(atLimit)))).not.toThrow();
    expect(() => parseToolPackageManifest(Buffer.from(envelopeManifest(overLimit)))).toThrow(
      new RegExp(`${MAX_AGENT_COMMAND_ARGS_BYTES} UTF-8 bytes in total`),
    );
  });

  it.each(["printf", "sh", "bash", "node", "python", "env", "/bin/printf", "./printf"])(
    "rejects unregistered executable identity %s",
    (executable) => {
      expect(() =>
        parseToolPackageManifest(
          Buffer.from(
            manifest().replace("executable: /usr/bin/printf", `executable: ${executable}`),
          ),
        ),
      ).toThrow(/profile.*requires executable/i);
    },
  );

  it.each([
    {
      label: "escape-interpreting conversion",
      value:
        'args: ["%b%s%s%s", "{input:path}", "{input:format}", "{input:limit}", "{input:verbose}"]',
    },
    {
      label: "model-controlled format",
      value:
        'args: ["{input:path}", "literal", "{input:format}", "{input:limit}", "{input:verbose}"]',
    },
  ])("rejects an unsafe printf argument role: $label", ({ value }) => {
    const source = manifest().replace(/^ {4}args: .*$/m, `    ${value}`);
    expect(() => parseToolPackageManifest(Buffer.from(source))).toThrow(/posix-printf-v1/i);
  });

  it("rejects a model-controlled printf format without trailing values", () => {
    const source = `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: unsafe-format, version: 1.0.0, description: Unsafe dynamic format. }
spec:
  tool:
    name: unsafe_format
    description: Attempt to render a dynamic printf format.
    inputs: [{ name: format, description: Dynamic format., type: string }]
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["{input:format}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;

    expect(() => parseToolPackageManifest(Buffer.from(source))).toThrow(/fixed non-option format/i);
  });

  it("accepts only the exact hardened Git-status vector", () => {
    const source = gitStatusManifest();

    expect(parseToolPackageManifest(Buffer.from(source)).spec.driver.profile).toBe("git-status-v1");
    expect(() =>
      parseToolPackageManifest(
        Buffer.from(source.replace("--short", "--short\\n      - --branch")),
      ),
    ).toThrow(/exact hardened status/i);
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
    ).toThrow(/profile|manifest disagrees/i);
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
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["%s\\n%s\\n%s\\n%s\\n", "{input:path}", "{input:format}", "{input:limit}", "{input:verbose}"]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function gitStatusManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: git-status, version: 1.0.0, description: Read hardened Git status. }
spec:
  tool: { name: project_git_status, description: Read hardened Git status., inputs: [] }
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args:
      - --no-optional-locks
      - -c
      - core.fsmonitor=false
      - -c
      - core.untrackedCache=false
      - status
      - --short
      - --untracked-files=normal
      - --ignore-submodules=all
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function envelopeManifest(args: readonly string[]): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata: { name: envelope-probe, version: 1.0.0, description: Probe command envelope bounds. }
spec:
  tool: { name: envelope_probe, description: Probe command envelope bounds., inputs: [] }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ${JSON.stringify(args)}
    timeoutMs: 10000
  permissions: [process.execute]
`;
}
