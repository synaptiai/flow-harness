import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";
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
import { snapshotSelectedToolPackages } from "../../../src/infrastructure/fs/local-tool-package-catalog.js";
import { snapshotSelectedVerifierPackages } from "../../../src/infrastructure/fs/local-verifier-package-catalog.js";
import { discoverProjectCapabilityCatalogs } from "../../../src/infrastructure/fs/project-capability-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("installed project capability catalog", () => {
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

    const agentSnapshot = await snapshotSelectedAgentSkills(catalogs.agentSkills, ["review"]);
    const verifierSnapshot = await snapshotSelectedVerifierPackages(catalogs.verifiers, [
      { name: "evidence-review", version: "1.2.0" },
    ]);
    const toolSnapshot = await snapshotSelectedToolPackages(catalogs.tools, [
      { name: "git-status", version: "1.0.0" },
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

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
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
