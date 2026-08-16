import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
import { parseCapabilityMetadata } from "../../../src/domain/capability/capability-metadata.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FLOW_CONFIG_API_VERSION,
} from "../../../src/domain/config/resolver.js";
import {
  AgentSkillCatalogError,
  snapshotSelectedAgentSkills,
} from "../../../src/infrastructure/fs/local-agent-skill-catalog.js";
import { LocalCapabilityPackageStore } from "../../../src/infrastructure/fs/local-capability-package-store.js";
import {
  PolicyPackageCatalogError,
  snapshotSelectedPolicyPackages,
} from "../../../src/infrastructure/fs/local-policy-package-catalog.js";
import { snapshotSelectedPresentationPackage } from "../../../src/infrastructure/fs/local-presentation-package-catalog.js";
import { snapshotSelectedToolPackages } from "../../../src/infrastructure/fs/local-tool-package-catalog.js";
import { snapshotSelectedVerifierPackages } from "../../../src/infrastructure/fs/local-verifier-package-catalog.js";
import {
  snapshotSelectedWorkflowPackages,
  WorkflowPackageCatalogError,
} from "../../../src/infrastructure/fs/local-workflow-package-catalog.js";
import { discoverProjectCapabilityCatalogs } from "../../../src/infrastructure/fs/project-capability-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("installed project capability catalog", () => {
  it.each(["lock", "bundle"] as const)(
    "stops installed-bundle verification when the %s read is cancelled",
    async (boundary) => {
      const project = await projectDirectory();
      const created = createCapabilityBundleSource({
        name: "cancelled-suite",
        version: "1.0.0",
        description: "Cancellation fixture.",
        packages: [{ kind: "policy-package", manifest: Buffer.from(policyManifest()) }],
      });
      const digest = created.bundle.digest.slice("sha256:".length);
      await new LocalCapabilityPackageStore(project).install({
        source: "https://packages.example.test/cancelled-suite-1.0.0.flowpkg",
        expectedSha256: digest,
        content: created.content,
      });
      const controller = new AbortController();
      const reason = new Error("cancel installed policy discovery");

      const lockPath = join(project, ".flow", "packages.lock.json");
      const blobPath = join(project, ".flow", "packages", "sha256", `${digest}.flowpkg`);
      const cancelRead = async () => {
        controller.abort(reason);
        await rm(boundary === "lock" ? lockPath : blobPath);
      };

      await expect(
        discoverProjectCapabilityCatalogs(project, {
          signal: controller.signal,
          capabilityPackageStoreHooks: {
            ...(boundary === "lock"
              ? { beforeVerifyLockRead: cancelRead }
              : { beforeVerifyBundleRead: cancelRead }),
          },
        }),
      ).rejects.toBe(reason);
    },
  );

  it("keeps an admitted metadata snapshot while a revoked refresh blocks new admission", async () => {
    const project = await projectDirectory();
    const created = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities.",
      packages: [{ kind: "verifier-package", manifest: Buffer.from(verifierManifest()) }],
    });
    const source = "https://packages.example.test/review-suite-1.0.0.flowpkg";
    const store = new LocalCapabilityPackageStore(project);
    await store.install({
      source,
      expectedSha256: created.bundle.digest.slice("sha256:".length),
      content: created.content,
    });
    await store.refreshMetadata({
      metadata: metadataFor(created.bundle, source, 1, "active"),
      authority: metadataAuthority(),
    });
    const admitted = await discoverProjectCapabilityCatalogs(project);

    await store.refreshMetadata({
      metadata: metadataFor(created.bundle, source, 2, "revoked"),
      authority: metadataAuthority(),
    });

    await expect(
      snapshotSelectedVerifierPackages(admitted.verifiers, [
        { name: "evidence-review", version: "1.2.0" },
      ]),
    ).resolves.toMatchObject({
      packages: [{ name: "evidence-review", version: "1.2.0" }],
    });
    await expect(discoverProjectCapabilityCatalogs(project)).rejects.toMatchObject({
      code: "metadata_target",
    });
  });

  it("composes every installed package ABI with portable bundle provenance", async () => {
    const project = await projectDirectory();
    const skill = Buffer.from(`---
name: review
description: Review the project when explicitly selected.
allowed-tools: read
---
Review the evidence.
`);
    const created = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities.",
      packages: [
        {
          kind: "agent-skill",
          files: [
            { path: "SKILL.md", content: skill },
            { path: "references/guide.md", content: Buffer.from("Use evidence.\n") },
          ],
        },
        {
          kind: "tool-package",
          manifest: Buffer.from(toolManifest("git-status", "status_report")),
        },
        { kind: "verifier-package", manifest: Buffer.from(verifierManifest()) },
        { kind: "workflow-package", manifest: Buffer.from(workflowManifest()) },
        { kind: "policy-package", manifest: Buffer.from(policyManifest()) },
        { kind: "presentation-package", manifest: Buffer.from(presentationManifest()) },
      ],
    });
    const sha256 = created.bundle.digest.slice("sha256:".length);
    await new LocalCapabilityPackageStore(project).install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: sha256,
      content: created.content,
    });

    const catalogs = await discoverProjectCapabilityCatalogs(project);

    expect(catalogs.agentSkills.skills).toMatchObject([
      {
        name: "review",
        trust: "project-explicit",
        provenance: `.flow/packages/sha256/${sha256}/agent-skill/review`,
      },
    ]);
    expect(catalogs.verifiers.packages).toMatchObject([
      {
        name: "evidence-review",
        version: "1.2.0",
        provenance: `.flow/packages/sha256/${sha256}/verifier-package/evidence-review`,
      },
    ]);
    expect(catalogs.tools.packages).toMatchObject([
      {
        name: "git-status",
        version: "1.0.0",
        toolName: "status_report",
        provenance: `.flow/packages/sha256/${sha256}/tool-package/git-status`,
      },
    ]);
    expect(catalogs.workflows.packages).toMatchObject([
      {
        name: "release-check",
        version: "1.0.0",
        provenance: `.flow/packages/sha256/${sha256}/workflow-package/release-check`,
      },
    ]);
    expect(catalogs.policies.packages).toMatchObject([
      {
        name: "restricted-review",
        version: "1.0.0",
        provenance: `.flow/packages/sha256/${sha256}/policy-package/restricted-review`,
      },
    ]);
    expect(catalogs.presentations.packages).toEqual([]);

    const presentationCatalogs = await discoverProjectCapabilityCatalogs(project, {
      includeNonPolicies: false,
      includePolicies: false,
      includePresentations: true,
    });
    expect(presentationCatalogs.presentations.packages).toMatchObject([
      {
        name: "operations",
        version: "1.0.0",
        provenance: `.flow/packages/sha256/${sha256}/presentation-package/operations`,
      },
    ]);
    await expect(
      snapshotSelectedPresentationPackage(presentationCatalogs.presentations, {
        name: "operations",
        version: "1.0.0",
      }),
    ).resolves.toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/presentation-package/operations`,
    });

    const agentSnapshot = await snapshotSelectedAgentSkills(catalogs.agentSkills, ["review"]);
    const verifierSnapshot = await snapshotSelectedVerifierPackages(catalogs.verifiers, [
      { name: "evidence-review", version: "1.2.0" },
    ]);
    const toolSnapshot = await snapshotSelectedToolPackages(catalogs.tools, [
      { name: "git-status", version: "1.0.0" },
    ]);
    const workflowSnapshot = await snapshotSelectedWorkflowPackages(catalogs.workflows, [
      { name: "release-check", version: "1.0.0" },
    ]);
    const policySnapshot = await snapshotSelectedPolicyPackages(catalogs.policies, [
      { name: "restricted-review", version: "1.0.0" },
    ]);
    expect(agentSnapshot.packages[0]).toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/agent-skill/review`,
      files: [{ path: "SKILL.md" }, { path: "references/guide.md" }],
    });
    expect(verifierSnapshot.packages[0]).toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/verifier-package/evidence-review`,
    });
    expect(toolSnapshot.packages[0]).toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/tool-package/git-status`,
    });
    expect(workflowSnapshot.packages[0]).toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/workflow-package/release-check`,
    });
    expect(policySnapshot.packages[0]).toMatchObject({
      provenance: `.flow/packages/sha256/${sha256}/policy-package/restricted-review`,
    });

    const output = captureIo();
    expect(
      await main(["skills", "list"], output.io, {
        cwd: project,
        loadConfig: async () => effectiveConfig(project),
      }),
    ).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "null")).toMatchObject({
      skills: [
        {
          name: "review",
          provenance: `.flow/packages/sha256/${sha256}/agent-skill/review`,
        },
      ],
    });
    expect(output.stdout.join("\n")).not.toContain("Review the evidence");

    const workflowList = captureIo();
    const workflowInspect = captureIo();
    const cliDependencies = {
      cwd: project,
      loadConfig: async () => effectiveConfig(project),
    };
    expect(await main(["workflows", "list"], workflowList.io, cliDependencies)).toBe(0);
    expect(
      await main(
        ["workflows", "inspect", "release-check", "--version", "1.0.0"],
        workflowInspect.io,
        cliDependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(workflowList.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "release-check",
          version: "1.0.0",
          provenance: `.flow/packages/sha256/${sha256}/workflow-package/release-check`,
        },
      ],
    });
    expect(JSON.parse(workflowInspect.stdout[0] ?? "null")).toMatchObject({
      name: "release-check",
      version: "1.0.0",
      manifest: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      workflow: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(workflowInspect.stdout.join("\n")).not.toMatch(/contentBase64|kind: Workflow/i);
  });

  it("rejects a local and installed Agent Skill name collision", async () => {
    const project = await projectDirectory();
    const skill = Buffer.from(`---
name: review
description: Installed review.
---
Review.
`);
    const created = createCapabilityBundleSource({
      name: "review-suite",
      version: "1.0.0",
      description: "Review capabilities.",
      packages: [{ kind: "agent-skill", files: [{ path: "SKILL.md", content: skill }] }],
    });
    await new LocalCapabilityPackageStore(project).install({
      source: "https://packages.example.test/review-suite-1.0.0.flowpkg",
      expectedSha256: created.bundle.digest.slice("sha256:".length),
      content: created.content,
    });
    const localDirectory = join(project, ".flow", "skills", "review");
    await mkdir(localDirectory, { recursive: true });
    await writeFile(
      join(localDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Local review.\n---\nReview.\n",
    );

    await expect(discoverProjectCapabilityCatalogs(project)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentSkillCatalogError && error.code === "duplicate_skill",
    );
  });

  it("rejects a local and installed workflow package name collision", async () => {
    const project = await projectDirectory();
    const created = createCapabilityBundleSource({
      name: "workflow-suite",
      version: "1.0.0",
      description: "Workflow capabilities.",
      packages: [{ kind: "workflow-package", manifest: Buffer.from(workflowManifest()) }],
    });
    await new LocalCapabilityPackageStore(project).install({
      source: "https://packages.example.test/workflow-suite-1.0.0.flowpkg",
      expectedSha256: created.bundle.digest.slice("sha256:".length),
      content: created.content,
    });
    const localDirectory = join(project, ".flow", "workflows", "release-check");
    await mkdir(localDirectory, { recursive: true });
    await writeFile(join(localDirectory, "WORKFLOW.yaml"), workflowManifest());

    await expect(discoverProjectCapabilityCatalogs(project)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof WorkflowPackageCatalogError && error.code === "duplicate_package",
    );
  });

  it("rejects a local and installed policy package name collision", async () => {
    const project = await projectDirectory();
    const created = createCapabilityBundleSource({
      name: "policy-suite",
      version: "1.0.0",
      description: "Policy capabilities.",
      packages: [{ kind: "policy-package", manifest: Buffer.from(policyManifest()) }],
    });
    await new LocalCapabilityPackageStore(project).install({
      source: "https://packages.example.test/policy-suite-1.0.0.flowpkg",
      expectedSha256: created.bundle.digest.slice("sha256:".length),
      content: created.content,
    });
    const localDirectory = join(project, ".flow", "policies", "restricted-review");
    await mkdir(localDirectory, { recursive: true });
    await writeFile(join(localDirectory, "POLICY.yaml"), policyManifest());

    await expect(discoverProjectCapabilityCatalogs(project)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PolicyPackageCatalogError && error.code === "duplicate_package",
    );
  });

  it("rejects different tool packages that expose the same provider-facing name", async () => {
    const project = await projectDirectory();
    const created = createCapabilityBundleSource({
      name: "tool-suite",
      version: "1.0.0",
      description: "Tool capabilities.",
      packages: [
        { kind: "tool-package", manifest: Buffer.from(toolManifest("git-status", "report")) },
        { kind: "tool-package", manifest: Buffer.from(toolManifest("project-status", "report")) },
      ],
    });
    await new LocalCapabilityPackageStore(project).install({
      source: "https://packages.example.test/tool-suite-1.0.0.flowpkg",
      expectedSha256: created.bundle.digest.slice("sha256:".length),
      content: created.content,
    });

    await expect(discoverProjectCapabilityCatalogs(project)).rejects.toMatchObject({
      code: "duplicate_package",
      message: expect.stringMatching(/provider-facing.*report/i),
    });
  });
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-installed-catalog-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".flow"));
  return directory;
}

function verifierManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.2.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Reject unsupported claims.
`;
}

function metadataFor(
  bundle: ReturnType<typeof createCapabilityBundleSource>["bundle"],
  source: string,
  version: number,
  status: "active" | "revoked",
) {
  return parseCapabilityMetadata(
    Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "CapabilityMetadata",
        metadata: {
          name: "flow-capabilities",
          version,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        spec: {
          targets: [
            {
              name: bundle.name,
              version: bundle.version,
              digest: bundle.digest,
              bytes: bundle.bytes,
              source,
              status,
            },
          ],
        },
      }),
    ),
    new Date("2026-08-14T00:00:00.000Z"),
  );
}

function metadataAuthority() {
  return Object.freeze({
    kind: "sigstore-keyless-v0.3" as const,
    certificateIssuer: "https://token.actions.githubusercontent.com/",
    certificateIdentity:
      "https://github.com/synaptiai/flow-harness/.github/workflows/metadata.yml@refs/heads/main",
    signatureBundleDigest: `sha256:${"f".repeat(64)}`,
  });
}

function toolManifest(name: string, toolName: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: ${name}
  version: 1.0.0
  description: Show a bounded status report.
spec:
  tool:
    name: ${toolName}
    description: Return a bounded project status.
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
  version: 1.0.0
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
  version: 1.0.0
  description: Restrict review workflows.
spec:
  tools:
    allowed: [read]
`;
}

function presentationManifest(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata: { name: operations, version: 1.0.0, description: Operator layout }
spec:
  messages:
    - version: v0.9
      createSurface: { surfaceId: flow-run, catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1 }
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - { id: root, component: FlowLayout, density: compact, children: [group-1] }
          - { id: group-1, component: FlowGroup, variant: stack, children: [run-summary, graph-progress, node-table, resource-facts, pending-approvals, outcome-notice] }
          - { id: run-summary, component: FlowRunSummary }
          - { id: graph-progress, component: FlowGraphProgress }
          - { id: node-table, component: FlowNodeTable }
          - { id: resource-facts, component: FlowResourceFacts }
          - { id: pending-approvals, component: FlowPendingApprovals }
          - { id: outcome-notice, component: FlowOutcomeNotice }
`;
}

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    sandbox: { profile: "native" },
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}
