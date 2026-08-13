import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseToolPackageManifest } from "../../src/domain/capability/tool-packages.js";
import { parseVerifierPackageManifest } from "../../src/domain/capability/verifier-packages.js";
import { parseWorkflowPackageManifest } from "../../src/domain/capability/workflow-packages.js";
import { compileWorkflowText } from "../../src/domain/workflow/compiler.js";

const rootUrl = new URL("../../", import.meta.url);

describe("public repository contracts", () => {
  it("documents an honest source-based pre-alpha first run", async () => {
    const readme = await readText("README.md");

    expect(readme).toMatch(/pre-alpha/i);
    expect(readme).toMatch(/not published to npm/i);
    expect(readme).toContain("git clone https://github.com/synaptiai/flow-harness.git");
    expect(readme).toContain("npm ci --ignore-scripts");
    expect(readme).toContain("bubblewrap");
    expect(readme).toContain("node dist/cli/main.js run");
    expect(readme).toContain("[Contributing](CONTRIBUTING.md)");
    expect(readme).toContain("[Support](SUPPORT.md)");
    expect(readme).toContain("[Security](SECURITY.md)");
  });

  it("documents the operator-only container command profile and its residual boundary", async () => {
    const [readme, configuration, architecture, security, testing, roadmap] = await Promise.all([
      readText("README.md"),
      readText("docs/configuration.md"),
      readText("docs/architecture.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("docs/roadmap.md"),
    ]);

    expect(readme).toContain("sandbox:\n  profile: container");
    expect(readme).toContain("flow-container-v1");
    expect(readme).toContain(".flow/container-command-intents");
    expect(readme).toMatch(/protected paths.*masked inside the workspace/is);
    expect(readme).toMatch(/sensitive workspace.*masked/is);
    expect(readme).toMatch(/Git metadata.*read-only/is);
    expect(readme).toMatch(/complete submitted Docker configuration.*policy digest/is);
    expect(readme).toMatch(/bounded workspace content snapshot.*immediately before launch/is);
    expect(readme).toMatch(/workspace.*contain.*configured project root.*reject/is);
    expect(readme).toMatch(/container profile.*shared Linux kernel/is);
    expect(readme).toMatch(/command-only seccomp.*socket creation.*cannot bind/is);

    expect(configuration).toContain("sandbox:\n  profile: container");
    expect(configuration).toMatch(/project configuration cannot select.*sandbox profile/is);
    expect(configuration).toMatch(/native.*built-in default/is);

    expect(architecture).toContain("flow-container-v1");
    expect(architecture).toMatch(/one Docker\s+container per command/is);
    expect(architecture).toMatch(/durable intent.*before.*Docker create/is);
    expect(architecture).toContain("Project `.flow` is always protected");
    expect(architecture).toMatch(/protected child.*inspected masked path/is);
    expect(architecture).toMatch(/bounded.*sensitive.*discovery/is);
    expect(architecture).toMatch(/Git metadata.*read-only path/is);
    expect(architecture).toMatch(/configuration digest.*public sandbox evidence/is);
    expect(architecture).toMatch(/workspace snapshot digest.*re-observes.*before launch/is);
    expect(architecture).toMatch(/workspace.*contains the project root.*reject/is);
    expect(architecture).toMatch(/command-only seccomp.*socket-specific syscalls/is);

    expect(security).toMatch(/container command profile.*shared Linux kernel/is);
    expect(security).toMatch(/exact full container ID.*confirmed absence/is);
    expect(security).toMatch(/nested protected paths.*masked/is);
    expect(security).toMatch(/sensitive workspace.*masked/is);
    expect(security).toMatch(/Git metadata.*read-only/is);
    expect(security).toMatch(/not.*atomic.*host filesystem snapshot/is);
    expect(security).toMatch(/workspace content snapshot.*masked.*content/is);
    expect(security).toMatch(/command-only seccomp.*local.*binding/is);

    expect(testing).toContain("container-command-sandbox.runtime.test.ts");
    expect(testing).toContain("container-command-recovery.runtime.test.ts");
    expect(testing).toMatch(/sensitive.*Git.*configuration digest/is);
    expect(testing).toMatch(/local TCP.*Unix.*binding/is);

    expect(roadmap).toMatch(/container command profile.*implemented/is);
    expect(roadmap).toMatch(/real Linux.*runtime gate.*pending/is);
  });

  it("documents and configures the Ubuntu 24.04 sandbox prerequisite", async () => {
    const [readme, workflow] = await Promise.all([
      readText("README.md"),
      readText(".github/workflows/ci.yml"),
    ]);
    const appArmorSetting = "kernel.apparmor_restrict_unprivileged_userns=0";

    expect(readme).toContain(appArmorSetting);
    expect(workflow).toContain(`sudo sysctl -w ${appArmorSetting}`);
  });

  it("scopes CI to one validation path per pull request while retaining main and manual runs", async () => {
    const workflow = parse(await readText(".github/workflows/ci.yml")) as WorkflowDefinition;

    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(Object.keys(workflow.jobs).sort()).toEqual(["dependency-audit", "quality"]);
  });

  it("audits the repository and Prime runtime dependency locks", async () => {
    const [workflow, containerDecision] = await Promise.all([
      readText(".github/workflows/ci.yml"),
      readText(".decisions/issue-78.md"),
    ]);

    expect(workflow).toContain("npm audit --omit=dev --audit-level=low");
    expect(workflow).toContain("node scripts/audit-prime-dependencies.mjs");
    expect(containerDecision).toContain("npm audit --omit=dev --audit-level=low");
    expect(containerDecision).toContain(
      "npx vitest run --config vitest.runtime.config.ts test/runtime/",
    );
    expect(containerDecision).not.toContain("npx vitest run test/runtime/");
  });

  it("maps each container-profile acceptance criterion exactly once", async () => {
    const decision = await readText(".decisions/issue-78.md");
    const map = decision.split("## Acceptance verification map\n", 2)[1]?.split("\n## ", 1)[0];
    expect(map).toBeDefined();

    const criteria = map
      ?.split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Criterion "))
      .filter((line) => !line.startsWith("| ---"))
      .map((line) => line.split("|")[1]?.trim());

    expect(criteria).not.toContain(undefined);
    expect(new Set(criteria).size).toBe(criteria?.length);
  });

  it("routes support, conduct, and vulnerability reports to distinct channels", async () => {
    const [support, conduct, security] = await Promise.all([
      readText("SUPPORT.md"),
      readText("CODE_OF_CONDUCT.md"),
      readText("SECURITY.md"),
    ]);

    expect(support).toContain("support@synapti.ai");
    expect(support).toContain("/security/advisories/new");
    expect(conduct).toContain("support@synapti.ai");
    expect(security).toContain("/security/advisories/new");
  });

  it.each([
    ["bug", ".github/ISSUE_TEMPLATE/bug.yml", ["reproduction", "expected", "security"]],
    ["capability", ".github/ISSUE_TEMPLATE/capability.yml", ["outcome", "evidence", "security"]],
  ])("provides a structured %s issue form", async (_kind, path, requiredIds) => {
    const form = parse(await readText(path)) as IssueForm;

    expect(form.name).toEqual(expect.any(String));
    expect(form.description).toEqual(expect.any(String));
    expect(form.body.map((field) => field.id)).toEqual(expect.arrayContaining(requiredIds));
    for (const id of requiredIds) {
      expect(form.body.find((field) => field.id === id)?.validations?.required).toBe(true);
    }
  });

  it("disables unstructured issues and redirects private security reports", async () => {
    const config = parse(await readText(".github/ISSUE_TEMPLATE/config.yml")) as IssueConfig;

    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://github.com/synaptiai/flow-harness/security/advisories/new",
        }),
      ]),
    );
  });

  it("asks pull requests for issue linkage, evidence, boundary impact, and failure modes", async () => {
    const template = await readText(".github/pull_request_template.md");

    for (const heading of [
      "## Linked issue",
      "## Outcome",
      "## Architecture and security boundaries",
      "## Failure modes",
      "## Verification",
      "## Documentation",
    ]) {
      expect(template).toContain(heading);
    }
  });

  it("documents the durable hash-anchored edit boundary and a valid declaration example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      sourcing,
      roadmap,
      security,
      testing,
      exampleSource,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/implement-and-verify.workflow.yaml"),
    ]);

    expect(readme).toMatch(/hash-anchored/i);
    expect(readme).toContain("`read`, `ls`, and `edit`");
    expect(readme).toMatch(/write-ahead durable evidence/i);
    expect(architecture).toContain("`node_effect_prepared`");
    expect(workflowSpec).toContain("expectedSha256");
    expect(workflowSpec).toMatch(/stale_version/);
    expect(workflowSpec).toContain("flow.effects/v1");
    expect(recovery).toContain("`node_effect_reconciled`");
    expect(recovery).toMatch(/same target queue.*cross-process lock/is);
    expect(sourcing).toMatch(/Pi's built-in edit/i);
    expect(roadmap).toMatch(
      /workspace edits persist typed prepare\/settle evidence.*Implemented/is,
    );
    expect(roadmap).toMatch(/Supported open edits are reconciled.*Implemented/is);
    expect(security).toMatch(/replay rejects terminalization while an effect remains\s+unresolved/);
    expect(security).toMatch(/opens without following symlinks.*8 MiB/is);
    expect(testing).toMatch(/edit crashes before rename.*settlement rejection/is);

    const example = parse(exampleSource) as {
      readonly nodes: ReadonlyArray<{
        readonly type: string;
        readonly agent?: { readonly tools?: readonly string[] };
      }>;
    };
    expect(example.nodes.find((node) => node.type === "agent")?.agent?.tools).toEqual([
      "read",
      "ls",
      "edit",
    ]);
  });

  it("documents durable run budgets with a valid credential-free example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      roadmap,
      testing,
      exampleSource,
      childExampleSource,
      optimizationExampleSource,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/roadmap.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/budgeted-foundation.workflow.yaml"),
      readText("examples/isolated-child.workflow.yaml"),
      readText("examples/bounded-optimization.workflow.yaml"),
    ]);

    expect(readme).toContain("resource_exhausted");
    expect(readme).toContain("maxArtifactBytes");
    expect(readme).toMatch(/artifactBytes.*UTF-8.*stdout \+ stderr/is);
    expect(readme).toMatch(/does not yet.*artifact store/is);
    expect(readme).toMatch(/reported-cost.*hard billing cap/is);
    expect(architecture).toMatch(/durable resource accounting/i);
    expect(architecture).toMatch(/recursively re-reduces every settled child\s+ledger/i);
    expect(workflowSpec).toContain("maxCostUsd");
    expect(workflowSpec).toContain("maxArtifactBytes");
    expect(workflowSpec).toMatch(/terminal primary executor payloads.*command.*agent.*verifier/is);
    expect(workflowSpec).toMatch(/micro-USD/i);
    expect(recovery).toContain("run_budget_exhausted");
    expect(recovery).toMatch(/parent child outcome.*all five resource totals/is);
    expect(roadmap).toMatch(
      /model tokens.*reported cost.*active execution time.*retained executor-output artifacts.*Implemented/is,
    );
    expect(testing).toMatch(/Focused artifact-budget tests.*multibyte UTF-8 accounting/is);
    expect(testing).toMatch(/do not claim an artifact store.*physical disk quota/is);
    expect(childExampleSource.match(/maxArtifactBytes:/g)).toHaveLength(2);
    expect(optimizationExampleSource.match(/maxArtifactBytes:/g)).toHaveLength(2);

    const example = parse(exampleSource) as {
      readonly budget?: {
        readonly maxNodeStarts?: number;
        readonly maxExecutionMs?: number;
        readonly maxArtifactBytes?: number;
      };
      readonly nodes: readonly unknown[];
    };
    expect(example.budget).toEqual({
      maxNodeStarts: 2,
      maxExecutionMs: 130000,
      maxArtifactBytes: 1048576,
    });
    expect(example.nodes).toHaveLength(2);
  });

  it("documents bounded deterministic concurrency with a valid credential-free example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      sourcing,
      roadmap,
      testing,
      exampleSource,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/roadmap.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/concurrent-fork.workflow.yaml"),
    ]);

    expect(readme).toMatch(/concurrency:\s*\{\s*maxNodes:\s*2\s*\}/);
    expect(readme).toMatch(/declaration order.*quiesc/is);
    expect(architecture).toMatch(/quiescent waves/i);
    expect(workflowSpec).toMatch(/maxNodes.*1 through 32/is);
    expect(recovery).toMatch(/every open attempt.*declaration order/is);
    expect(sourcing).toMatch(/Pi.*concurren.*tool/is);
    expect(roadmap).toMatch(/Concurrent static DAG fork\/join.*Implemented/is);
    expect(testing).toMatch(/reverse completion.*declaration order/is);

    const example = parse(exampleSource) as {
      readonly concurrency?: { readonly maxNodes?: number };
      readonly nodes: readonly unknown[];
    };
    expect(example.concurrency).toEqual({ maxNodes: 2 });
    expect(example.nodes).toHaveLength(4);
  });

  it("documents replay-safe bounded loops with a valid credential-free example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      sourcing,
      roadmap,
      security,
      testing,
      source,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/bounded-loop.workflow.yaml"),
    ]);

    expect(readme).toMatch(/Replay-safe bounded loops.*Implemented/is);
    expect(readme).toContain("loop_limit_reached");
    expect(architecture).toContain("`node_loop_checked`");
    expect(workflowSpec).toMatch(/maxIterations.*1 through 32/is);
    expect(workflowSpec).toMatch(/at most 256 total nodes/is);
    expect(recovery).toMatch(/loop checks and completions.*safe committed/is);
    expect(sourcing).toMatch(/bounded loop checks/i);
    expect(roadmap).toMatch(/Bounded loops.*implemented/is);
    expect(security).toMatch(/finite compiler constructs.*at most 32 iterations/is);
    expect(testing).toContain("examples/bounded-loop.workflow.yaml");

    const example = parse(source) as {
      readonly nodes: ReadonlyArray<{
        readonly type: string;
        readonly loop?: {
          readonly maxIterations?: number;
          readonly until?: {
            readonly source?: { readonly nodeId?: string };
            readonly equals?: string;
          };
          readonly body?: { readonly nodes?: readonly unknown[] };
        };
      }>;
    };
    expect(example.nodes[0]).toMatchObject({
      type: "loop",
      loop: {
        maxIterations: 3,
        until: { source: { nodeId: "advance" }, equals: "pass" },
        body: { nodes: [expect.objectContaining({ id: "advance", type: "command" })] },
      },
    });
  });

  it("documents replay-safe typed results with a valid credential-free example", async () => {
    const [readme, architecture, workflowSpec, recovery, roadmap, security, testing, source] =
      await Promise.all([
        readText("README.md"),
        readText("docs/architecture.md"),
        readText("docs/workflow-spec.md"),
        readText("docs/recovery.md"),
        readText("docs/roadmap.md"),
        readText("SECURITY.md"),
        readText("docs/testing-and-evaluation.md"),
        readText("examples/typed-result.workflow.yaml"),
      ]);

    expect(readme).toMatch(/Typed result.*Implemented/is);
    expect(readme).toContain("examples/typed-result.workflow.yaml");
    expect(architecture).toContain("`node_result_published`");
    expect(workflowSpec).toMatch(/RFC 8785.*canonical JSON/is);
    expect(workflowSpec).toMatch(/result\.value/is);
    expect(recovery).toMatch(/typed result publications.*safe committed/is);
    expect(roadmap).toMatch(/typed results.*Implemented/is);
    expect(security).toMatch(/duplicate JSON object keys.*fail/is);
    expect(testing).toContain("examples/typed-result.workflow.yaml");

    const example = parse(source) as {
      readonly nodes: ReadonlyArray<{
        readonly id?: string;
        readonly type?: string;
        readonly result?: {
          readonly source?: { readonly nodeId?: string; readonly field?: string };
          readonly schema?: { readonly type?: string; readonly required?: readonly string[] };
        };
      }>;
    };
    expect(example.nodes[1]).toMatchObject({
      id: "publish",
      type: "result",
      result: {
        source: { nodeId: "produce", field: "command.stdout" },
        schema: { type: "object", required: ["accepted", "score"] },
      },
    });
    expect(() => compileWorkflowText(source, "examples/typed-result.workflow.yaml")).not.toThrow();
  });

  it("documents isolated child runs with a valid credential-free example", async () => {
    const [readme, architecture, workflowSpec, recovery, security, roadmap, testing, source] =
      await Promise.all([
        readText("README.md"),
        readText("docs/architecture.md"),
        readText("docs/workflow-spec.md"),
        readText("docs/recovery.md"),
        readText("SECURITY.md"),
        readText("docs/roadmap.md"),
        readText("docs/testing-and-evaluation.md"),
        readText("examples/isolated-child.workflow.yaml"),
      ]);

    expect(readme).toMatch(/Isolated child workflow runs.*Implemented/is);
    expect(readme).toContain("examples/isolated-child.workflow.yaml");
    expect(architecture).toContain("### Isolated child run trees");
    expect(workflowSpec).toContain("## Isolated child workflow node");
    expect(workflowSpec).toMatch(/not an atomic\s+filesystem snapshot or security boundary/is);
    expect(recovery).toContain("child_recovery_ineligible");
    expect(security).toMatch(/Child workflows run from owner-only.*reflink-or-copy/is);
    expect(security).toMatch(/different workspace or policy waits/is);
    expect(roadmap).toMatch(/Child runs use isolated workspaces.*Implemented/is);
    expect(testing).toContain("examples/isolated-child.workflow.yaml");

    const workflow = compileWorkflowText(source, "examples/isolated-child.workflow.yaml");
    expect(workflow.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "delegate",
          type: "child",
          child: expect.objectContaining({ resultNodeId: "publish" }),
        }),
        expect.objectContaining({ id: "publish-parent", type: "result" }),
      ]),
    );
  });

  it("documents detached supervision without overstating its trust boundary", async () => {
    const [readme, architecture, workflowSpec, recovery, sourcing, roadmap, security] =
      await Promise.all([
        readText("README.md"),
        readText("docs/architecture.md"),
        readText("docs/workflow-spec.md"),
        readText("docs/recovery.md"),
        readText("docs/capability-sourcing.md"),
        readText("docs/roadmap.md"),
        readText("SECURITY.md"),
      ]);

    expect(readme).toContain("run <workflow.yaml> --detach");
    expect(readme).toContain("supervisor status");
    expect(readme).toMatch(/accepted.*durable.*worker/is);
    expect(architecture).toMatch(/authenticated worker.*adoption/is);
    expect(workflowSpec).toMatch(/execution mode.*not.*workflow semantics/is);
    expect(workflowSpec).not.toMatch(/No handoff from a live process, detached supervisor/);
    expect(recovery).toMatch(/supervisor restart/i);
    expect(sourcing).toMatch(/Supervisor and one worker per root run tree.*Implemented/is);
    expect(roadmap).toMatch(/supervisor owns detached workers.*Implemented/is);
    expect(security).toMatch(/same operating-system user.*not.*sandbox/is);
  });

  it("documents strict project configuration and bounded admission", async () => {
    const [readme, configuration, architecture, recovery, roadmap, security] = await Promise.all([
      readText("README.md"),
      readText("docs/configuration.md"),
      readText("docs/architecture.md"),
      readText("docs/recovery.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
    ]);

    expect(readme).toMatch(/one worker.*32 additional jobs.*durable FIFO queue/is);
    expect(readme).toMatch(/accepted.*queued.*queue_full/is);
    expect(configuration).toMatch(/project.*narrow.*operator ceiling/is);
    expect(configuration).toMatch(/invalid\s+versions or kinds.*source and field diagnostics/is);
    expect(architecture).toMatch(/active plus queued admission.*effective policy/is);
    expect(recovery).toMatch(/queued cancellation.*no.*worker descriptor/is);
    expect(roadmap).toMatch(/durable bounded FIFO admission/is);
    expect(security).toMatch(/capacity ceiling.*does not contain a worker/is);
  });

  it("documents portable Agent Skills with a valid progressive-disclosure example", async () => {
    const [readme, architecture, workflowSpec, sourcing, roadmap, testing, workflowSource, skill] =
      await Promise.all([
        readText("README.md"),
        readText("docs/architecture.md"),
        readText("docs/workflow-spec.md"),
        readText("docs/capability-sourcing.md"),
        readText("docs/roadmap.md"),
        readText("docs/testing-and-evaluation.md"),
        readText("examples/portable-agent-skill.workflow.yaml"),
        readText("examples/agent-skills/review/SKILL.md"),
      ]);

    expect(readme).toMatch(/Portable Agent Skills packages.*Implemented/is);
    expect(readme).toContain("skills validate");
    expect(readme).toContain("examples/portable-agent-skill.workflow.yaml");
    expect(architecture).toMatch(/immutable capability snapshot.*run_started/is);
    expect(workflowSpec).toContain("## Portable Agent Skills");
    expect(workflowSpec).toMatch(/allowed-tools.*request.*not.*author/i);
    expect(sourcing).toMatch(/Portable skills.*Implemented/is);
    expect(sourcing).toMatch(/Pi.*ambient skill discovery.*disabled/is);
    expect(roadmap).toMatch(/Agent Skills packages.*Implemented/is);
    expect(testing).toContain("examples/portable-agent-skill.workflow.yaml");
    expect(skill).toMatch(/name:\s+review/);

    const workflow = compileWorkflowText(
      workflowSource,
      "examples/portable-agent-skill.workflow.yaml",
    );
    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      agent: { tools: ["read"], skills: ["review"] },
    });
  });

  it("documents versioned verifier packages with a valid credential-free example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      sourcing,
      recovery,
      roadmap,
      testing,
      source,
      manifest,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/recovery.md"),
      readText("docs/roadmap.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/versioned-verifier-package.workflow.yaml"),
      readText("examples/verifier-packages/release-tests/VERIFIER.yaml"),
    ]);

    expect(readme).toMatch(/Versioned verifier packages.*Implemented/is);
    expect(readme).toContain("verifiers validate");
    expect(readme).toContain("examples/versioned-verifier-package.workflow.yaml");
    expect(architecture).toMatch(/verifier package.*immutable capability snapshot/is);
    expect(workflowSpec).toContain("## Versioned verifier packages");
    expect(sourcing).toMatch(/Verifier packages.*Implemented/is);
    expect(recovery).toMatch(/durable verifier package snapshot/i);
    expect(roadmap).toMatch(/evaluator.*versioned manifests.*Implemented/is);
    expect(testing).toContain("examples/versioned-verifier-package.workflow.yaml");

    const workflow = compileWorkflowText(
      source,
      "examples/versioned-verifier-package.workflow.yaml",
    );
    expect(workflow.nodes[0]).toMatchObject({
      type: "verifier",
      verifier: {
        kind: "packaged-command",
        package: { name: "release-tests", version: "1.0.0" },
      },
    });
    expect(
      parseVerifierPackageManifest(
        Buffer.from(manifest),
        "examples/verifier-packages/release-tests/VERIFIER.yaml",
      ),
    ).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "VerifierPackage",
      metadata: { name: "release-tests", version: "1.0.0" },
      spec: { kind: "command", command: { executable: "node", args: ["--version"] } },
    });
  });

  it("documents versioned command tools with a valid credential-free example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      sourcing,
      recovery,
      roadmap,
      security,
      testing,
      source,
      manifest,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/recovery.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/versioned-command-tool.workflow.yaml"),
      readText("examples/tool-packages/git-status/TOOL.yaml"),
    ]);

    expect(readme).toMatch(/Versioned command tool packages.*Implemented/is);
    expect(readme).toContain("tools inspect git-status --version 1.0.0");
    expect(readme).toContain("examples/versioned-command-tool.workflow.yaml");
    expect(architecture).toMatch(/command tool package.*immutable capability snapshot/is);
    expect(workflowSpec).toContain("## Versioned command tool packages");
    expect(sourcing).toMatch(/Command tool packages.*Implemented/is);
    expect(recovery).toMatch(/durable command tool package snapshot/i);
    expect(roadmap).toMatch(/Tool.*versioned manifests.*Implemented/is);
    expect(security).toMatch(/ToolPackage.*existing agent-command boundary/is);
    expect(testing).toContain("examples/versioned-command-tool.workflow.yaml");

    const workflow = compileWorkflowText(source, "examples/versioned-command-tool.workflow.yaml");
    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      agent: {
        tools: ["read"],
        toolPackages: [{ name: "git-status", version: "1.0.0" }],
      },
    });
    expect(
      parseToolPackageManifest(
        Buffer.from(manifest),
        "examples/tool-packages/git-status/TOOL.yaml",
      ),
    ).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "ToolPackage",
      metadata: { name: "git-status", version: "1.0.0" },
      spec: {
        tool: { name: "project_git_status", inputs: [] },
        driver: {
          kind: "command",
          version: "v1",
          profile: "git-status-v1",
          executable: "/usr/bin/git",
          args: [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "status",
            "--short",
            "--untracked-files=normal",
            "--ignore-submodules=all",
          ],
        },
        permissions: ["process.execute"],
      },
    });
  });

  it("documents digest-pinned remote capability bundles with a valid source example", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      sourcing,
      roadmap,
      security,
      testing,
      contributing,
      bundleSource,
      verifierManifest,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("CONTRIBUTING.md"),
      readText("examples/capability-bundle-source/BUNDLE.json"),
      readText("examples/capability-bundle-source/verifiers/release-tests/VERIFIER.yaml"),
    ]);

    expect(readme).toMatch(/Distribute digest-pinned capability bundles/i);
    expect(readme).toContain("packages install");
    expect(readme).toMatch(/digest identifies bytes.*does not authenticate a publisher/is);
    expect(architecture).toMatch(/digest-pinned remote acquisition.*transport.*installation/is);
    expect(workflowSpec).toContain("## Installed capability bundles");
    expect(workflowSpec).toMatch(/Child execution, resume, and\s+replay never use.*source URL/is);
    expect(recovery).toMatch(
      /never reads `\.flow\/packages\.lock\.json`.*contacts the recorded source URL/is,
    );
    expect(sourcing).toContain(
      "https://github.com/opencontainers/image-spec/blob/main/descriptor.md",
    );
    expect(sourcing).toContain("https://theupdateframework.github.io/specification/");
    expect(roadmap).toMatch(/Deterministic inert bundles.*implemented/is);
    expect(security).toMatch(
      /Remote capability bundles contain only.*Agent Skill.*verifier.*command tool.*workflow source ABIs/is,
    );
    expect(testing).toContain("packages pack examples/capability-bundle-source");
    expect(contributing).toMatch(/capability-bundle format.*adversarial regression/is);

    expect(JSON.parse(bundleSource)).toEqual({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "CapabilityBundleSource",
      metadata: {
        name: "review-suite",
        version: "1.0.0",
        description: "Credential-free release verification capabilities.",
        license: "Apache-2.0",
        compatibility: "Flow v1alpha1 capability ABIs",
      },
    });
    expect(
      parseVerifierPackageManifest(
        Buffer.from(verifierManifest),
        "examples/capability-bundle-source/verifiers/release-tests/VERIFIER.yaml",
      ),
    ).toMatchObject({
      metadata: { name: "release-tests", version: "1.0.0" },
      spec: { kind: "command", command: { executable: "node", args: ["--version"] } },
    });
  });

  it("documents versioned workflow packages with valid root and child examples", async () => {
    const [
      readme,
      architecture,
      workflowSpec,
      recovery,
      sourcing,
      roadmap,
      security,
      testing,
      manifestSource,
      parentSource,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/workflow-packages/release-check/WORKFLOW.yaml"),
      readText("examples/versioned-workflow-package.workflow.yaml"),
    ]);

    expect(readme).toMatch(/Use a versioned workflow package/i);
    expect(readme).toContain("workflow:release-check@1.0.0");
    expect(architecture).toMatch(/closed\s+immutable snapshot.*standard workflow compiler/is);
    expect(workflowSpec).toContain("## Versioned workflow packages");
    expect(recovery).toMatch(/workflow package.*durable snapshot.*live catalog/is);
    expect(sourcing).toMatch(/workflow packages.*inert.*source/is);
    expect(roadmap).toMatch(/Workflow.*contributions.*Implemented/is);
    expect(security).toMatch(/WorkflowPackage.*cannot.*hooks.*policy/is);
    expect(testing).toContain("examples/versioned-workflow-package.workflow.yaml");

    const manifest = parseWorkflowPackageManifest(
      Buffer.from(manifestSource),
      "examples/workflow-packages/release-check/WORKFLOW.yaml",
    );
    expect(manifest.metadata).toMatchObject({ name: "release-check", version: "1.0.0" });
    const compiled = compileWorkflowText(
      parentSource,
      "examples/versioned-workflow-package.workflow.yaml",
      {
        packageResolver: {
          resolve(reference) {
            expect(reference).toEqual({ name: "release-check", version: "1.0.0" });
            return {
              ...reference,
              digest: "a".repeat(64),
              source: manifest.spec.workflow,
            };
          },
        },
      },
    );
    expect(compiled.nodes[0]).toMatchObject({
      type: "child",
      child: {
        workflow: {
          sourcePackage: { name: "release-check", version: "1.0.0" },
        },
      },
    });
  });

  it("documents live agent command approval with a valid provider-neutral example", async () => {
    const [readme, architecture, workflowSpec, recovery, roadmap, security, testing, source] =
      await Promise.all([
        readText("README.md"),
        readText("docs/architecture.md"),
        readText("docs/workflow-spec.md"),
        readText("docs/recovery.md"),
        readText("docs/roadmap.md"),
        readText("SECURITY.md"),
        readText("docs/testing-and-evaluation.md"),
        readText("examples/agent-command-approval.workflow.yaml"),
      ]);

    expect(readme).toContain("examples/agent-command-approval.workflow.yaml");
    expect(architecture).toMatch(/run owner.*decision.*command preparation/is);
    expect(workflowSpec).toContain("### Live agent `exec` approval");
    expect(workflowSpec).toMatch(/denial.*bounded tool error.*does not.*fail.*node/is);
    expect(recovery).toMatch(/owner process\s+dies.*refuses recovery/is);
    expect(roadmap).toMatch(/per-call human approval.*Implemented/is);
    expect(security).toMatch(/actor label.*not authenticated/is);
    expect(testing).toContain("examples/agent-command-approval.workflow.yaml");

    const workflow = compileWorkflowText(source, "examples/agent-command-approval.workflow.yaml");
    expect(workflow.nodes[0]).toMatchObject({
      type: "agent",
      agent: {
        tools: ["read", "ls", "edit", "exec"],
        toolApproval: { exec: { mode: "required", grantTtlMs: 300000 } },
      },
    });
  });

  it("documents reproducible harness evaluation with an admission-ready example", async () => {
    const [
      readme,
      architecture,
      evaluation,
      workflowSpec,
      roadmap,
      security,
      testing,
      plan,
      task,
      result,
      baseline,
      candidate,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/evaluation.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
      readText("examples/evaluation/harness-comparison.evaluation.yaml"),
      readText("examples/evaluation/fixture/TASK.md"),
      readText("examples/evaluation/fixture/RESULT.md"),
      readText("examples/evaluation/baseline.workflow.yaml"),
      readText("examples/evaluation/candidate.workflow.yaml"),
    ]);

    expect(readme).toContain("flow eval validate");
    expect(readme).toContain("docs/evaluation.md");
    expect(architecture).toMatch(/ordinary run\s+ledger.*separate evaluation ledger/is);
    expect(evaluation).toContain("paired-alternating-v1");
    expect(evaluation).toMatch(/missing.*never.*success|missing.*denominator/is);
    expect(evaluation).toContain("thinking");
    expect(workflowSpec).toContain("## Evaluation plans");
    expect(roadmap).toMatch(/reproducible harness evaluation.*Implemented/is);
    expect(security).toMatch(/evaluation fixture.*untrusted/is);
    expect(testing).toContain("examples/evaluation/harness-comparison.evaluation.yaml");
    expect(plan).toContain("kind: EvaluationPlan");

    const parsedPlan = parse(plan) as {
      readonly suite: {
        readonly tasks: ReadonlyArray<{
          readonly verifier: {
            readonly assertions: ReadonlyArray<{
              readonly kind: string;
              readonly path: string;
              readonly value?: string;
            }>;
          };
        }>;
      };
    };
    expect(task).toMatch(/edit the existing `RESULT\.md`/i);
    expect(result).toMatch(/replace this placeholder/i);
    expect(parsedPlan.suite.tasks[0]?.verifier.assertions).toContainEqual({
      kind: "sha256",
      path: "RESULT.md",
      value: createHash("sha256")
        .update(
          "Deterministic verification checks the requested artifact instead of trusting a model's completion claim.\n",
        )
        .digest("hex"),
    });
    for (const [name, source] of [
      ["baseline", baseline],
      ["candidate", candidate],
    ] as const) {
      const workflow = compileWorkflowText(source, `${name}.workflow.yaml`);
      expect(workflow.nodes.find((node) => node.type === "agent")).toMatchObject({
        type: "agent",
        agent: { tools: expect.arrayContaining(["read", "edit"]) },
      });
    }
  });

  it("documents model generation and reviewed activation without model authority", async () => {
    const [
      readme,
      architecture,
      sourcing,
      evaluation,
      workflowSpec,
      recovery,
      roadmap,
      security,
      testing,
    ] = await Promise.all([
      readText("README.md"),
      readText("docs/architecture.md"),
      readText("docs/capability-sourcing.md"),
      readText("docs/evaluation.md"),
      readText("docs/workflow-spec.md"),
      readText("docs/recovery.md"),
      readText("docs/roadmap.md"),
      readText("SECURITY.md"),
      readText("docs/testing-and-evaluation.md"),
    ]);

    expect(readme).toMatch(/(?:flow|main\.js) candidate validate/);
    expect(readme).toMatch(/(?:flow|main\.js) candidate generate/);
    expect(readme).toMatch(/(?:flow|main\.js) eval tuning-evidence/);
    expect(readme).toMatch(/(?:flow|main\.js) candidate activate/);
    expect(readme).toMatch(/(?:flow|main\.js) activation rollback/);
    expect(architecture).toMatch(/activation store contains immutable.*saved snapshot/is);
    expect(sourcing).toMatch(/Prime Agent.*supplemental.*Flow.*activate/is);
    expect(evaluation).toMatch(/activation gate.*complete.*superior/is);
    expect(workflowSpec).toContain("kind: PromptCandidate");
    expect(workflowSpec).toContain("activation:<workflow-id>");
    expect(recovery).toContain("run_started");
    expect(recovery).toMatch(/live index changes.*saved\s+snapshot/is);
    expect(roadmap).toMatch(/Activation is versioned.*Implemented/is);
    expect(roadmap).toMatch(/zero-tool model generation.*Implemented/is);
    expect(security).toMatch(/operator command.*complete superior evaluation/is);
    expect(security).toMatch(/candidate cannot authorize.*activation/is);
    expect(testing).toContain("test/integration/cli/prompt-candidate.test.ts");
    expect(testing).toContain("prompt-candidate-generation.test.ts");
    expect(testing).toMatch(/Activation tests cover.*rollback/is);
    expect(readme).toMatch(/model-authorized evaluation and activation remain unavailable/is);
    expect(architecture).toMatch(/model-authorized evaluation and activation remain unavailable/is);
  });
});

async function readText(path: string): Promise<string> {
  return await readFile(new URL(path, rootUrl), "utf8");
}

interface IssueForm {
  readonly name?: string;
  readonly description?: string;
  readonly body: Array<{
    readonly id?: string;
    readonly validations?: { readonly required?: boolean };
  }>;
}

interface IssueConfig {
  readonly blank_issues_enabled?: boolean;
  readonly contact_links?: ReadonlyArray<{ readonly url?: string }>;
}

interface WorkflowDefinition {
  readonly on: {
    readonly pull_request?: unknown;
    readonly push?: { readonly branches?: readonly string[] };
    readonly workflow_dispatch?: unknown;
  };
  readonly jobs: Readonly<Record<string, unknown>>;
}
