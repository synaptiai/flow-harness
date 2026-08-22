import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";
import { LocalArtifactStore } from "../../../src/infrastructure/fs/local-artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("flow artifacts", () => {
  it("inspects, releases, plans, and applies pruning without disclosing bytes or paths", async () => {
    const root = await temporaryProject();
    const privateBytes = "PRIVATE_ARTIFACT_BYTES";
    const privateBase64 = Buffer.from(privateBytes).toString("base64");
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from(privateBytes),
      mediaType: "application/octet-stream",
      producer: producer(),
    });
    const overrides = {
      cwd: root,
      loadConfig: async () => resolveFlowConfig({ projectRoot: root }),
    };

    const inspection = capture();
    expect(
      await main(["artifacts", "inspect", reference.reference], inspection.io, overrides),
    ).toBe(0);
    expect(JSON.parse(inspection.stdout.join("\n"))).toMatchObject({
      reference,
      retention: "retained",
      availability: "available",
    });
    expect(inspection.stdout.join("\n")).not.toContain(privateBytes);
    expect(inspection.stdout.join("\n")).not.toContain(privateBase64);
    expect(inspection.stdout.join("\n")).not.toContain(join(root, ".flow", "artifacts"));

    const listed = capture();
    expect(await main(["artifacts", "list"], listed.io, overrides)).toBe(0);
    expect(JSON.parse(listed.stdout.join("\n"))).toEqual([{ reference, retention: "retained" }]);
    expect(listed.stdout.join("\n")).not.toContain(privateBytes);
    expect(listed.stdout.join("\n")).not.toContain(privateBase64);
    expect(listed.stdout.join("\n")).not.toContain(join(root, ".flow", "artifacts"));

    const released = capture();
    expect(await main(["artifacts", "release", reference.reference], released.io, overrides)).toBe(
      0,
    );
    expect(JSON.parse(released.stdout.join("\n"))).toMatchObject({ retention: "released" });

    const dryRun = capture();
    expect(await main(["artifacts", "prune"], dryRun.io, overrides)).toBe(0);
    const plan = JSON.parse(dryRun.stdout.join("\n")) as {
      readonly planDigest: string;
      readonly items: readonly unknown[];
    };
    expect(plan.items).toEqual([reference.descriptor]);

    const applied = capture();
    expect(
      await main(
        ["artifacts", "prune", "--apply", "--expected-plan-digest", plan.planDigest],
        applied.io,
        overrides,
      ),
    ).toBe(0);
    expect(JSON.parse(applied.stdout.join("\n"))).toEqual({
      planDigest: plan.planDigest,
      pruned: [reference.descriptor],
    });

    const pruned = capture();
    expect(await main(["artifacts", "inspect", reference.reference], pruned.io, overrides)).toBe(0);
    expect(JSON.parse(pruned.stdout.join("\n"))).toMatchObject({ availability: "pruned" });
  });

  it("requires an exact dry-run digest before mutation", async () => {
    const root = await temporaryProject();
    const overrides = {
      cwd: root,
      loadConfig: async () => resolveFlowConfig({ projectRoot: root }),
    };
    const missingDigest = capture();

    expect(await main(["artifacts", "prune", "--apply"], missingDigest.io, overrides)).toBe(2);
    expect(missingDigest.stderr.join("\n")).toContain(
      "artifacts prune requires --apply and --expected-plan-digest together",
    );
  });

  it("injects the project artifact store into foreground execution", async () => {
    const root = await temporaryProject();
    const workflowPath = join(root, "artifact-wiring.workflow.yaml");
    await writeFile(
      workflowPath,
      `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: artifact-wiring }
nodes:
  - id: execute
    type: command
    command: { executable: node, args: [--version] }
`,
    );
    const artifactStore = new LocalArtifactStore(root);
    let observed = false;
    const executor: NodeExecutor = {
      async execute(node, context) {
        observed = context.artifactStore === artifactStore;
        if (node.type !== "command") throw new Error("unexpected node type");
        const stdout = "v1";
        const emptyHash = sha256("");
        return {
          status: "succeeded",
          evidence: {
            kind: "command",
            executable: node.command.executable,
            args: node.command.args,
            exitCode: 0,
            signal: null,
            stdout,
            stderr: "",
            stdoutHash: sha256(stdout),
            stderrHash: emptyHash,
            stdoutRetainedHash: sha256(stdout),
            stderrRetainedHash: emptyHash,
            stdoutRetainedBytes: Buffer.byteLength(stdout),
            stderrRetainedBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
            aborted: false,
            durationMs: 1,
            sandbox: {
              backend: "test-sandbox",
              backendVersion: "1",
              profile: "workspace-write-network-deny-v1",
              policyDigest: "a".repeat(64),
            },
          },
        };
      },
    };
    const output = capture();

    expect(
      await main(["run", workflowPath], output.io, {
        cwd: root,
        loadConfig: async () => resolveFlowConfig({ projectRoot: root }),
        createArtifactStore: () => artifactStore,
        createNodeExecutor: () => executor,
      }),
    ).toBe(0);
    expect(observed).toBe(true);
  });

  it("keeps non-project foreground execution preview-only", async () => {
    const root = await temporaryProject();
    const workflowPath = join(root, "artifact-preview-only.workflow.yaml");
    await writeFile(
      workflowPath,
      `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: artifact-preview-only }
nodes:
  - id: execute
    type: command
    command: { executable: node, args: [--version] }
`,
    );
    let observedStore: unknown = "not-executed";
    const executor: NodeExecutor = {
      async execute(node, context) {
        observedStore = context.artifactStore;
        if (node.type !== "command") throw new Error("unexpected node type");
        return successfulCommandOutcome(node.command.executable, node.command.args);
      },
    };

    expect(
      await main(["run", workflowPath], capture().io, {
        cwd: root,
        loadConfig: async () => resolveFlowConfig({}),
        createArtifactStore: () => {
          throw new Error("PRIVATE_UNPROTECTED_ARTIFACT_STORE");
        },
        createNodeExecutor: () => executor,
      }),
    ).toBe(0);
    expect(observedStore).toBeUndefined();
  });

  it.each([
    { name: "project", withProject: true },
    { name: "non-project", withProject: false },
  ])("uses the correct artifact boundary for a $name durable resume", async ({ withProject }) => {
    const root = await temporaryProject();
    const workflowPath = join(root, "artifact-resume.workflow.yaml");
    const runsDirectory = join(root, "runs");
    await writeFile(
      workflowPath,
      `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: artifact-resume }
nodes:
  - id: execute
    type: command
    approval: { mode: required, grantTtlMs: 60000 }
    command: { executable: node, args: [--version] }
`,
    );
    const artifactStore = new LocalArtifactStore(root);
    let observedStore: unknown;
    const executor: NodeExecutor = {
      async execute(node, context) {
        observedStore = context.artifactStore;
        if (node.type !== "command") throw new Error("unexpected node type");
        return successfulCommandOutcome(node.command.executable, node.command.args);
      },
    };
    const overrides = {
      cwd: root,
      loadConfig: async () => resolveFlowConfig(withProject ? { projectRoot: root } : {}),
      createArtifactStore: () => {
        if (!withProject) throw new Error("PRIVATE_UNPROTECTED_RESUME_ARTIFACT_STORE");
        return artifactStore;
      },
      createNodeExecutor: () => executor,
    };
    const started = capture();
    expect(
      await main(
        ["run", workflowPath, "--run-id", "artifact-resume", "--runs-dir", runsDirectory],
        started.io,
        overrides,
      ),
    ).toBe(3);
    expect(observedStore).toBeUndefined();
    const waiting = JSON.parse(started.stdout.join("\n")) as {
      readonly nodes: { readonly execute: { readonly approval: { readonly requestId: string } } };
    };

    expect(
      await main(
        [
          "approve",
          "artifact-resume",
          waiting.nodes.execute.approval.requestId,
          "--actor",
          "operator:test",
          "--runs-dir",
          runsDirectory,
        ],
        capture().io,
        overrides,
      ),
    ).toBe(0);
    expect(
      await main(
        ["resume", workflowPath, "--run-id", "artifact-resume", "--runs-dir", runsDirectory],
        capture().io,
        overrides,
      ),
    ).toBe(0);
    expect(observedStore).toBe(withProject ? artifactStore : undefined);
  });
});

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-artifacts-cli-"));
  temporaryDirectories.push(root);
  return root;
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  };
}

function producer() {
  return {
    kind: "agent-command" as const,
    runId: "run-cli",
    workflowId: "workflow-cli",
    nodeId: "agent",
    attempt: 1,
    commandId: "command-1",
    commandSequence: 1,
    stream: "stdout" as const,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function successfulCommandOutcome(executable: string, args: readonly string[]) {
  const stdout = "v1";
  const emptyHash = sha256("");
  return {
    status: "succeeded" as const,
    evidence: {
      kind: "command" as const,
      executable,
      args,
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutHash: sha256(stdout),
      stderrHash: emptyHash,
      stdoutRetainedHash: sha256(stdout),
      stderrRetainedHash: emptyHash,
      stdoutRetainedBytes: Buffer.byteLength(stdout),
      stderrRetainedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      sandbox: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-write-network-deny-v1" as const,
        policyDigest: "a".repeat(64),
      },
    },
  };
}
