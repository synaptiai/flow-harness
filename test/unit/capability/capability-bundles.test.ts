import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCapabilityBundleSource,
  parseCapabilityBundle,
  parseDigestPinnedCapabilityBundle,
} from "../../../src/domain/capability/capability-bundles.js";

describe("capability bundles", () => {
  it("derives an exact verifier package identity from bounded bundle bytes", () => {
    const manifest = verifierManifest("Keep this rubric private.");
    const source = bundleSource([
      {
        kind: "verifier-package",
        manifestBase64: Buffer.from(manifest).toString("base64"),
      },
    ]);

    expect(parseCapabilityBundle(source)).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityBundle",
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities for a Flow project.",
      license: "Apache-2.0",
      compatibility: "Flow v1alpha1 capability ABIs",
      bytes: source.byteLength,
      digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
      packages: [
        {
          kind: "verifier-package",
          name: "evidence-review",
          version: "1.2.0",
          manifestBase64: Buffer.from(manifest).toString("base64"),
        },
      ],
    });
  });

  it("derives mixed command-tool and verifier identities in canonical order", () => {
    const tool = toolManifest();
    const verifier = verifierManifest("Review declared evidence.");
    const parsed = parseCapabilityBundle(
      bundleSource([
        { kind: "tool-package", manifestBase64: Buffer.from(tool).toString("base64") },
        {
          kind: "verifier-package",
          manifestBase64: Buffer.from(verifier).toString("base64"),
        },
      ]),
    );

    expect(parsed.packages).toEqual([
      {
        kind: "tool-package",
        name: "git-status",
        version: "1.0.0",
        toolName: "project_git_status",
        manifestBase64: Buffer.from(tool).toString("base64"),
      },
      {
        kind: "verifier-package",
        name: "evidence-review",
        version: "1.2.0",
        manifestBase64: Buffer.from(verifier).toString("base64"),
      },
    ]);
  });

  it("round-trips an inert workflow package through canonical bundle bytes", () => {
    const workflow = Buffer.from(workflowManifest());
    const created = createCapabilityBundleSource({
      name: "workflow-suite",
      version: "1.0.0",
      description: "Reusable Flow workflows.",
      packages: [{ kind: "workflow-package", manifest: workflow }],
    });

    expect(created.bundle.packages).toEqual([
      {
        kind: "workflow-package",
        name: "release-check",
        version: "1.2.3",
        manifestBase64: workflow.toString("base64"),
      },
    ]);
    expect(parseCapabilityBundle(created.content)).toEqual(created.bundle);
  });

  it("round-trips an inert policy package through canonical bundle bytes", () => {
    const policy = Buffer.from(policyManifest());
    const created = createCapabilityBundleSource({
      name: "policy-suite",
      version: "1.0.0",
      description: "Reusable Flow policy constraints.",
      packages: [{ kind: "policy-package", manifest: policy }],
    });

    expect(created.bundle.packages).toEqual([
      {
        kind: "policy-package",
        name: "restricted-review",
        version: "1.2.3",
        manifestBase64: policy.toString("base64"),
      },
    ]);
    expect(parseCapabilityBundle(created.content)).toEqual(created.bundle);
  });

  it("round-trips an inert A2UI-profile presentation package", () => {
    const presentation = Buffer.from(presentationManifest());
    const created = createCapabilityBundleSource({
      name: "presentation-suite",
      version: "1.0.0",
      description: "Reviewable terminal layouts.",
      packages: [{ kind: "presentation-package", manifest: presentation }],
    });

    expect(created.bundle.packages).toEqual([
      {
        kind: "presentation-package",
        name: "operations",
        version: "1.0.0",
        manifestBase64: presentation.toString("base64"),
      },
    ]);
    expect(parseCapabilityBundle(created.content)).toEqual(created.bundle);
  });

  it("derives Agent Skill metadata and requested tools from canonical package files", () => {
    const skill = `---
name: review
description: Review the project when explicitly selected.
license: Apache-2.0
compatibility: Flow Agent Skills v1
metadata:
  version: "1"
allowed-tools: read ls
---
Review the evidence before making a claim.
`;
    const guide = "Use deterministic evidence first.\n";
    const files = [
      { path: "SKILL.md", contentBase64: Buffer.from(skill).toString("base64") },
      { path: "references/guide.md", contentBase64: Buffer.from(guide).toString("base64") },
    ];

    const parsed = parseCapabilityBundle(bundleSource([{ kind: "agent-skill", files }]));

    expect(parsed.packages).toEqual([
      {
        kind: "agent-skill",
        name: "review",
        description: "Review the project when explicitly selected.",
        license: "Apache-2.0",
        compatibility: "Flow Agent Skills v1",
        metadata: { version: "1" },
        requestedTools: ["ls", "read"],
        files,
      },
    ]);
  });

  it("rejects duplicate contained package identities", () => {
    const manifestBase64 = Buffer.from(verifierManifest("Review evidence.")).toString("base64");

    expect(() =>
      parseCapabilityBundle(
        bundleSource([
          { kind: "verifier-package", manifestBase64 },
          { kind: "verifier-package", manifestBase64 },
        ]),
      ),
    ).toThrow(/duplicate.*verifier-package.*evidence-review.*1\.2\.0/i);
  });

  it("rejects duplicate JSON object keys before schema validation", () => {
    const source = bundleSource([
      {
        kind: "verifier-package",
        manifestBase64: Buffer.from(verifierManifest("Review evidence.")).toString("base64"),
      },
    ]);
    const ambiguous = Buffer.from(
      source
        .toString("utf8")
        .replace(
          '"kind":"CapabilityBundle"',
          '"kind":"CapabilityBundle","kind":"CapabilityBundle"',
        ),
    );

    expect(() => parseCapabilityBundle(ambiguous)).toThrow(/duplicate object key.*kind/i);
  });

  it("verifies the expected byte digest before parsing remote content", () => {
    const malformed = Buffer.from("not JSON");
    const actual = createHash("sha256").update(malformed).digest("hex");

    expect(() => parseDigestPinnedCapabilityBundle(malformed, "0".repeat(64))).toThrow(
      /digest mismatch/i,
    );
    expect(() => parseDigestPinnedCapabilityBundle(malformed, actual)).toThrow(/JSON/i);
  });

  it("serializes semantically identical source inputs to the same canonical bytes", () => {
    const skill = Buffer.from(`---
name: review
description: Review the project when explicitly selected.
license: Apache-2.0
---
Review the evidence.
`);
    const guide = Buffer.from("Use deterministic evidence first.\n");
    const verifier = Buffer.from(verifierManifest("Review evidence."));
    const forward = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities for a Flow project.",
      license: "Apache-2.0",
      packages: [
        {
          kind: "agent-skill",
          files: [
            { path: "SKILL.md", content: skill },
            { path: "references/guide.md", content: guide },
          ],
        },
        { kind: "verifier-package", manifest: verifier },
      ],
    });
    const reversed = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities for a Flow project.",
      license: "Apache-2.0",
      packages: [
        { kind: "verifier-package", manifest: verifier },
        {
          kind: "agent-skill",
          files: [
            { path: "references/guide.md", content: guide },
            { path: "SKILL.md", content: skill },
          ],
        },
      ],
    });

    expect(forward.content.equals(reversed.content)).toBe(true);
    expect(forward.bundle.digest).toBe(reversed.bundle.digest);
    expect(forward.bundle.packages.map((item) => item.kind)).toEqual([
      "agent-skill",
      "verifier-package",
    ]);
  });

  it("preserves empty Agent Skill reference files accepted by the local package ABI", () => {
    const skill = Buffer.from(`---
name: review
description: Review the project when explicitly selected.
---
Review the evidence.
`);

    const created = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities for a Flow project.",
      packages: [
        {
          kind: "agent-skill",
          files: [
            { path: "SKILL.md", content: skill },
            { path: "references/empty.md", content: Buffer.alloc(0) },
          ],
        },
      ],
    });

    expect(created.bundle.packages[0]).toMatchObject({
      kind: "agent-skill",
      files: [{ path: "SKILL.md" }, { path: "references/empty.md", contentBase64: "" }],
    });
  });

  it("rejects aggregate decoded package content above the bundle ceiling", () => {
    const filler = Buffer.alloc(120 * 1024, 0x61).toString("base64");
    const packages = Array.from({ length: 18 }, (_, index) => {
      const name = `review-${String(index + 1).padStart(2, "0")}`;
      const skill = `---\nname: ${name}\ndescription: Review package ${index + 1}.\n---\nReview.\n`;
      return {
        kind: "agent-skill",
        files: [
          { path: "SKILL.md", contentBase64: Buffer.from(skill).toString("base64") },
          { path: "references/payload.bin", contentBase64: filler },
        ],
      };
    });

    expect(Buffer.byteLength(JSON.stringify(packages), "utf8")).toBeLessThan(4 * 1024 * 1024);
    expect(() => parseCapabilityBundle(bundleSource(packages))).toThrow(/2097152/);
  });

  it("rejects bundle metadata that would require whitespace normalization", () => {
    const manifestBase64 = Buffer.from(verifierManifest("Review evidence.")).toString("base64");
    const source = bundleSource([{ kind: "verifier-package", manifestBase64 }]);
    const ambiguous = Buffer.from(
      source
        .toString("utf8")
        .replace(
          '"description":"Review capabilities for a Flow project."',
          '"description":" Review capabilities for a Flow project. "',
        ),
    );

    expect(() => parseCapabilityBundle(ambiguous)).toThrow(/surrounding whitespace/i);
  });

  it("rejects contained packages outside canonical identity order", () => {
    const verifier = Buffer.from(verifierManifest("Review evidence.")).toString("base64");
    const tool = Buffer.from(toolManifest()).toString("base64");

    expect(() =>
      parseCapabilityBundle(
        bundleSource([
          { kind: "verifier-package", manifestBase64: verifier },
          { kind: "tool-package", manifestBase64: tool },
        ]),
      ),
    ).toThrow(/canonical identity order/i);
  });

  it("rejects unsafe and duplicate Agent Skill paths", () => {
    const skillBase64 = Buffer.from(`---
name: review
description: Review the project when explicitly selected.
---
Review the evidence.
`).toString("base64");

    expect(() =>
      parseCapabilityBundle(
        bundleSource([
          {
            kind: "agent-skill",
            files: [
              { path: "../outside.md", contentBase64: "" },
              { path: "SKILL.md", contentBase64: skillBase64 },
            ],
          },
        ]),
      ),
    ).toThrow(/not portable/i);

    expect(() =>
      parseCapabilityBundle(
        bundleSource([
          {
            kind: "agent-skill",
            files: [
              { path: "SKILL.md", contentBase64: skillBase64 },
              { path: "SKILL.md", contentBase64: skillBase64 },
            ],
          },
        ]),
      ),
    ).toThrow(/duplicate path/i);
  });

  it("rejects non-canonical base64 before parsing a contained manifest", () => {
    const canonical = Buffer.from(verifierManifest("Review evidence. ")).toString("base64");
    expect(canonical.endsWith("=")).toBe(true);

    expect(() =>
      parseCapabilityBundle(
        bundleSource([{ kind: "verifier-package", manifestBase64: canonical.replace(/=+$/, "") }]),
      ),
    ).toThrow(/canonical base64/i);
  });

  it("rejects a non-lowercase expected digest before hashing content", () => {
    expect(() =>
      parseDigestPinnedCapabilityBundle(Buffer.from("not JSON"), "A".repeat(64)),
    ).toThrow(/64 lowercase hexadecimal/i);
  });
});

function bundleSource(packages: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityBundle",
      metadata: {
        name: "review-suite",
        version: "1.0.0",
        description: "Review capabilities for a Flow project.",
        license: "Apache-2.0",
        compatibility: "Flow v1alpha1 capability ABIs",
      },
      spec: { packages },
    }),
  );
}

function verifierManifest(prompt: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Review declared evidence.
  license: Apache-2.0
spec:
  kind: model
  prompt: ${prompt}
`;
}

function toolManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: git-status
  version: 1.0.0
  description: Show a bounded machine-readable workspace status.
  license: Apache-2.0
spec:
  tool:
    name: project_git_status
    description: Return the current project status.
    inputs: []
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args: [--no-optional-locks, -c, core.fsmonitor=false, -c, core.untrackedCache=false, status, --short, --untracked-files=normal, --ignore-submodules=all]
    timeoutMs: 10000
  permissions: [process.execute]
`;
}

function workflowManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.2.3
  description: Run a bounded reusable flow.
spec:
  workflow: |-
    apiVersion: flow.synapti.ai/v1alpha1
    kind: Workflow
    metadata: { id: release-check }
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
`;
}

function policyManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.2.3
  description: Restrict review execution.
spec:
  tools:
    allowed: [read]
  commands:
    requireApproval: true
`;
}

function presentationManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: operations
  version: 1.0.0
  description: Operator layout.
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - id: root
            component: FlowLayout
            density: compact
            children: [group-1]
          - id: group-1
            component: FlowGroup
            variant: stack
            children: [run-summary, graph-progress, node-table, resource-facts, pending-approvals, outcome-notice]
          - id: run-summary
            component: FlowRunSummary
          - id: graph-progress
            component: FlowGraphProgress
          - id: node-table
            component: FlowNodeTable
          - id: resource-facts
            component: FlowResourceFacts
          - id: pending-approvals
            component: FlowPendingApprovals
          - id: outcome-notice
            component: FlowOutcomeNotice
`;
}
