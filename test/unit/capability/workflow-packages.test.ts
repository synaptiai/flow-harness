import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES,
  calculateWorkflowPackageDigest,
  createWorkflowPackageSnapshot,
  parseWorkflowPackageManifest,
  validateWorkflowPackageSnapshot,
} from "../../../src/domain/capability/workflow-packages.js";

const WORKFLOW_SOURCE = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: release-check
budget:
  maxNodeStarts: 1
  maxModelTokens: 0
  maxCostUsdMicros: 0
  maxExecutionMs: 1000
  maxArtifactBytes: 1024
nodes:
  - id: done
    type: command
    command:
      executable: /usr/bin/true
      args: []
`.trim();

describe("workflow packages", () => {
  it("parses a strict inert workflow package manifest", () => {
    const manifest = parseWorkflowPackageManifest(
      createManifestSource(),
      "workflow package fixture",
    );

    expect(manifest).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "WorkflowPackage",
      metadata: {
        name: "release-check",
        version: "1.2.3",
        description: "Run a bounded release check.",
        license: "Apache-2.0",
        compatibility: "flow.synapti.ai/v1alpha1",
      },
      spec: { workflow: WORKFLOW_SOURCE },
    });
  });

  it.each([
    {
      name: "unknown fields",
      source: createManifestSource()
        .toString("utf8")
        .replace("spec:\n", "spec:\n  install: npm install arbitrary-code\n"),
      expected: /unrecognized key|install/i,
    },
    {
      name: "version ranges",
      source: createManifestSource().toString("utf8").replace("version: 1.2.3", "version: ^1.2.3"),
      expected: /exact semantic version/i,
    },
    {
      name: "YAML aliases",
      source: `apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata: &metadata
  name: release-check
  version: 1.2.3
  description: Run a bounded release check.
spec:
  workflow: *metadata
`,
      expected: /aliases are not supported/i,
    },
    {
      name: "blank workflow source",
      source: createManifestSource()
        .toString("utf8")
        .replace(/workflow: \|-[\s\S]*$/, 'workflow: "   "\n'),
      expected: /non-whitespace|workflow/i,
    },
  ])("rejects $name", ({ source, expected }) => {
    expect(() => parseWorkflowPackageManifest(Buffer.from(source))).toThrow(expected);
  });

  it("rejects invalid UTF-8 and oversized manifests before parsing", () => {
    expect(() => parseWorkflowPackageManifest(Uint8Array.from([0xc3, 0x28]))).toThrow(
      /valid UTF-8/i,
    );
    expect(() =>
      parseWorkflowPackageManifest(Buffer.alloc(MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES + 1, "a")),
    ).toThrow(/must not exceed/i);
  });

  it("creates and validates an immutable byte-exact snapshot", () => {
    const source = createManifestSource();
    const snapshot = createWorkflowPackageSnapshot({
      kind: "workflow-package",
      trust: "project-explicit",
      provenance: ".flow/workflows/release-check",
      manifest: { content: source },
    });

    expect(snapshot).toEqual({
      kind: "workflow-package",
      apiVersion: "flow.synapti.ai/v1alpha1",
      name: "release-check",
      version: "1.2.3",
      description: "Run a bounded release check.",
      license: "Apache-2.0",
      compatibility: "flow.synapti.ai/v1alpha1",
      trust: "project-explicit",
      provenance: ".flow/workflows/release-check",
      manifest: {
        bytes: source.byteLength,
        sha256: hash(source),
        contentBase64: source.toString("base64"),
      },
      workflow: {
        bytes: Buffer.byteLength(WORKFLOW_SOURCE),
        sha256: hash(Buffer.from(WORKFLOW_SOURCE)),
      },
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validateWorkflowPackageSnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
    expect(Object.isFrozen(snapshot.workflow)).toBe(true);
  });

  it("participates in the shared capability snapshot with canonical identity ordering", () => {
    const workflowInput = {
      kind: "workflow-package" as const,
      trust: "project-explicit" as const,
      provenance: ".flow/workflows/release-check",
      manifest: { content: createManifestSource() },
    };

    const snapshot = createCapabilitySnapshot([], [], [], [workflowInput]);

    expect(snapshot.packages).toEqual([
      expect.objectContaining({
        kind: "workflow-package",
        name: "release-check",
        version: "1.2.3",
      }),
    ]);
    expect(validateCapabilitySnapshot(structuredClone(snapshot))).toEqual(snapshot);
    expect(Object.isFrozen(snapshot.packages)).toBe(true);
  });

  it("rejects a digest-valid snapshot whose manifest workflow disagrees with its workflow binding", () => {
    const snapshot = createWorkflowPackageSnapshot({
      kind: "workflow-package",
      trust: "project-explicit",
      provenance: ".flow/workflows/release-check",
      manifest: { content: createManifestSource() },
    });
    const changedSource = createManifestSource(
      WORKFLOW_SOURCE.replace("/usr/bin/true", "/bin/false"),
    );
    const changed = {
      ...snapshot,
      manifest: {
        bytes: changedSource.byteLength,
        sha256: hash(changedSource),
        contentBase64: changedSource.toString("base64"),
      },
    };
    const forged = { ...changed, digest: calculateWorkflowPackageDigest(changed) };

    expect(() => validateWorkflowPackageSnapshot(forged)).toThrow(
      /workflow.*(?:byte count|digest)|disagrees/i,
    );
  });

  it("rejects non-canonical manifest bytes, forged package digests, and misleading provenance", () => {
    const snapshot = createWorkflowPackageSnapshot({
      kind: "workflow-package",
      trust: "project-explicit",
      provenance: ".flow/workflows/release-check",
      manifest: { content: createManifestSource() },
    });
    const nonCanonicalBase64 = {
      ...snapshot,
      manifest: { ...snapshot.manifest, contentBase64: `${snapshot.manifest.contentBase64}=` },
    };

    expect(() => validateWorkflowPackageSnapshot(nonCanonicalBase64)).toThrow(/base64/i);
    expect(() => validateWorkflowPackageSnapshot({ ...snapshot, digest: "0".repeat(64) })).toThrow(
      /package digest/i,
    );
    expect(() =>
      validateWorkflowPackageSnapshot({
        ...snapshot,
        provenance: ".flow/workflows/different-name",
        digest: calculateWorkflowPackageDigest({
          ...snapshot,
          provenance: ".flow/workflows/different-name",
        }),
      }),
    ).toThrow(/provenance.*package name/i);
  });
});

function createManifestSource(workflow = WORKFLOW_SOURCE): Buffer {
  const indentedWorkflow = workflow
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.2.3
  description: Run a bounded release check.
  license: Apache-2.0
  compatibility: flow.synapti.ai/v1alpha1
spec:
  workflow: |-
${indentedWorkflow}
`);
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
