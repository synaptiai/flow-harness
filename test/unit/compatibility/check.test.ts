import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { CompatibilityArtifactSource } from "../../../src/domain/compatibility/check.js";
import {
  type CompatibilityCorpusError,
  checkCompatibilityCorpus,
  parseCompatibilityCorpusManifest,
} from "../../../src/domain/compatibility/check.js";

const HISTORICAL_WORKFLOW = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: verify-installation
  description: Exercise the installed Flow command path without source files or credentials.
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata:
    id: installation-is-usable
  outcome: The installed Flow package runs a deterministic command workflow.
  criteria:
    - id: command-passes
      description: The installed command executes a credential-free Node.js check.
      verifier:
        nodeId: installation-smoke
nodes:
  - id: node-version
    type: command
    command:
      executable: node
      args:
        - --version
      timeoutMs: 10000
  - id: installation-smoke
    type: command
    dependsOn:
      - node-version
    command:
      executable: node
      args:
        - -e
        - process.stdout.write('flow-preview-ready')
      timeoutMs: 10000
`;

const HISTORICAL_LEDGER = [
  {
    version: 1,
    sequence: 1,
    at: "2026-08-25T15:53:30.645Z",
    runId: "alpha1-cross-release-host",
    workflowId: "cross-release-compatibility",
    type: "run_started",
    nodeIds: ["record-evidence"],
    workflowApiVersion: "flow.synapti.ai/v1alpha1",
    workflowDigest: "27e059ea243b14f54d9b28814a2aa55247b3e32f9ce4ac56177c54c4b9037388",
    goal: {
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "verify-cross-release",
      outcome: "The deterministic command completes successfully.",
      criteria: [
        {
          id: "command-completes",
          description: "The deterministic command exits successfully.",
          verifierNodeId: "record-evidence",
        },
      ],
    },
    executionCwd: "/private/tmp/flow-cross-release.4iuTe5",
  },
  {
    version: 1,
    sequence: 2,
    at: "2026-08-25T15:53:30.711Z",
    runId: "alpha1-cross-release-host",
    workflowId: "cross-release-compatibility",
    type: "node_started",
    nodeId: "record-evidence",
    attempt: 1,
  },
  {
    version: 1,
    sequence: 3,
    at: "2026-08-25T15:53:31.400Z",
    runId: "alpha1-cross-release-host",
    workflowId: "cross-release-compatibility",
    type: "node_succeeded",
    nodeId: "record-evidence",
    attempt: 1,
    evidence: {
      kind: "command",
      executable: "node",
      args: ["-e", "process.stdout.write('alpha1-evidence')"],
      exitCode: 0,
      signal: null,
      stdout: "alpha1-evidence",
      stderr: "",
      stdoutHash: "1e5adbb3ae66517f9de584bf665d7f96ab2c7f4adb6a7ed58adfb9d50ebf697c",
      stderrHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 681.725334,
      terminationStatus: "not-required",
      sandbox: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "0.0.70",
        profile: "workspace-write-network-deny-v1",
        policyDigest: "7b3b7499af5239d8ab51606fc8f4d1a8410c5ff9b8801fdcfa6f474a0e8ef5d8",
      },
    },
  },
  {
    version: 1,
    sequence: 4,
    at: "2026-08-25T15:53:31.409Z",
    runId: "alpha1-cross-release-host",
    workflowId: "cross-release-compatibility",
    type: "run_succeeded",
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n")
  .concat("\n");

describe("compatibility corpus check", () => {
  it("reports current compatibility with historical authored and terminal artifacts", () => {
    const input = corpusInput();
    const manifest = parseCompatibilityCorpusManifest(input.manifest);

    expect(
      checkCompatibilityCorpus({
        flowVersion: "0.1.0-alpha.4",
        corpusSha256: sha256(JSON.stringify(input.manifest)),
        manifest,
        sources: input.sources,
      }),
    ).toEqual({
      version: "flow.compatibility-report/v1",
      flow: { package: "@synapti/flow-harness", version: "0.1.0-alpha.4" },
      corpus: {
        version: "flow.compatibility-corpus/v1",
        id: "alpha-compatibility-v1",
        sha256: sha256(JSON.stringify(input.manifest)),
      },
      overall: "compatible",
      artifacts: [
        {
          id: "alpha1-verify-installation-workflow",
          kind: "authored_workflow",
          producer: { package: "@synaptiai/flow-harness", version: "0.1.0-alpha.1" },
          sourceSha256: sha256(HISTORICAL_WORKFLOW),
          state: "compatible",
          category: "compatible",
          observations: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            workflowId: "verify-installation",
            workflowDigest: "829448e4f68acdb620f7b67d0696fc6250b1c087407c7f83f95c2b7c2494676d",
            nodeCount: 2,
            criterionCount: 1,
          },
        },
        {
          id: "alpha1-terminal-run",
          kind: "terminal_run_ledger",
          producer: { package: "@synaptiai/flow-harness", version: "0.1.0-alpha.1" },
          sourceSha256: sha256(HISTORICAL_LEDGER),
          state: "compatible",
          category: "compatible",
          observations: {
            runId: "alpha1-cross-release-host",
            workflowId: "cross-release-compatibility",
            workflowDigest: "27e059ea243b14f54d9b28814a2aa55247b3e32f9ce4ac56177c54c4b9037388",
            terminalStatus: "succeeded",
            lastSequence: 4,
            evidenceNodeId: "record-evidence",
            stdoutHash: "1e5adbb3ae66517f9de584bf665d7f96ab2c7f4adb6a7ed58adfb9d50ebf697c",
            stderrHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        },
      ],
    });
  });

  it("keeps every declared artifact in a fail-closed report", () => {
    const input = corpusInput();
    const manifest = parseCompatibilityCorpusManifest(input.manifest);
    const sources = new Map(input.sources);
    sources.set("releases/0.1.0-alpha.1/terminal-run.events.jsonl", Buffer.from("changed\n"));

    const report = checkCompatibilityCorpus({
      flowVersion: "0.1.0-alpha.4",
      corpusSha256: sha256(JSON.stringify(input.manifest)),
      manifest,
      sources,
    });

    expect(report.overall).toBe("incompatible");
    expect(report.artifacts).toHaveLength(2);
    expect(report.artifacts[1]).toMatchObject({
      id: "alpha1-terminal-run",
      state: "incompatible",
      category: "artifact_identity_mismatch",
    });
    expect(report.artifacts[1]).not.toHaveProperty("observations");
  });

  it("preserves a bounded source-read failure as an artifact result", () => {
    const input = corpusInput();
    const manifest = parseCompatibilityCorpusManifest(input.manifest);
    const sources = new Map<string, CompatibilityArtifactSource>(input.sources);
    sources.set("releases/0.1.0-alpha.1/terminal-run.events.jsonl", {
      category: "resource_limit",
    });

    const report = checkCompatibilityCorpus({
      flowVersion: "0.1.0-alpha.4",
      corpusSha256: sha256(JSON.stringify(input.manifest)),
      manifest,
      sources,
    });

    expect(report.artifacts[1]).toMatchObject({
      id: "alpha1-terminal-run",
      state: "incompatible",
      category: "resource_limit",
    });
  });

  it("rejects an unsupported corpus version with a stable diagnostic", () => {
    const input = corpusInput();

    expect(() =>
      parseCompatibilityCorpusManifest({
        ...input.manifest,
        version: "flow.compatibility-corpus/v2",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<CompatibilityCorpusError>>({
        name: "CompatibilityCorpusError",
        code: "unsupported_corpus",
        message: "compatibility corpus version is unsupported",
      }),
    );
  });
});

function corpusInput() {
  const manifest = {
    version: "flow.compatibility-corpus/v1",
    id: "alpha-compatibility-v1",
    artifacts: [
      {
        id: "alpha1-verify-installation-workflow",
        kind: "authored_workflow",
        path: "releases/0.1.0-alpha.1/verify-installation.workflow.yaml",
        sha256: sha256(HISTORICAL_WORKFLOW),
        producer: {
          package: "@synaptiai/flow-harness",
          version: "0.1.0-alpha.1",
          archiveSha256: "3a8d76564dae33e2c43951c483a3cd69b146fa7788ce311949d5242cb0229568",
        },
        expected: {
          apiVersion: "flow.synapti.ai/v1alpha1",
          workflowId: "verify-installation",
          workflowDigest: "829448e4f68acdb620f7b67d0696fc6250b1c087407c7f83f95c2b7c2494676d",
          nodeCount: 2,
          criterionCount: 1,
        },
      },
      {
        id: "alpha1-terminal-run",
        kind: "terminal_run_ledger",
        path: "releases/0.1.0-alpha.1/terminal-run.events.jsonl",
        sha256: sha256(HISTORICAL_LEDGER),
        producer: {
          package: "@synaptiai/flow-harness",
          version: "0.1.0-alpha.1",
          archiveSha256: "3a8d76564dae33e2c43951c483a3cd69b146fa7788ce311949d5242cb0229568",
        },
        expected: {
          runId: "alpha1-cross-release-host",
          workflowId: "cross-release-compatibility",
          workflowDigest: "27e059ea243b14f54d9b28814a2aa55247b3e32f9ce4ac56177c54c4b9037388",
          terminalStatus: "succeeded",
          lastSequence: 4,
          evidenceNodeId: "record-evidence",
          stdoutHash: "1e5adbb3ae66517f9de584bf665d7f96ab2c7f4adb6a7ed58adfb9d50ebf697c",
          stderrHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      },
    ],
  } as const;
  return {
    manifest,
    sources: new Map<string, Uint8Array>([
      [manifest.artifacts[0].path, Buffer.from(HISTORICAL_WORKFLOW)],
      [manifest.artifacts[1].path, Buffer.from(HISTORICAL_LEDGER)],
    ]),
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
