import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../../src/domain/capability/agent-skills.js";
import { createLanguageServerSnapshot } from "../../../../src/domain/capability/language-server.js";
import { createSemanticQueryReceipt } from "../../../../src/domain/semantic/semantic-code.js";
import {
  PiAgentExecutor,
  type PiAgentRunner,
} from "../../../../src/infrastructure/pi/pi-agent-executor.js";
import type { SemanticToolSession } from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

describe("Pi semantic execution", () => {
  it("creates and forwards one attempt-scoped session from frozen server identity", async () => {
    const snapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(snapshot.languageServer?.digest);
    const session: SemanticToolSession = {
      evidence: () => [receipt],
      async query() {
        return { operation: "diagnostics", diagnostics: [] };
      },
    };
    let factoryCalls = 0;
    const runner: PiAgentRunner = {
      async run(request) {
        expect(request.semanticSession).toBe(session);
        return { text: "complete", stopReason: "stop" };
      },
    };
    const executor = new PiAgentExecutor(
      runner,
      () => 100,
      5_000,
      65_536,
      ({ context, languageServer }) => {
        factoryCalls += 1;
        expect(context.runId).toBe("run-semantic");
        expect(languageServer).toStrictEqual(snapshot.languageServer);
        return session;
      },
    );

    const outcome = await executor.execute(semanticNode(), {
      runId: "run-semantic",
      workflowId: "semantic-workflow",
      attempt: 1,
      cwd: "/workspace",
      protectedPaths: [],
      capabilitySnapshot: snapshot,
    });

    expect(outcome.status).toBe("succeeded");
    expect(factoryCalls).toBe(1);
    expect(outcome.evidence).toMatchObject({
      kind: "agent",
      semanticReceipts: [receipt],
    });
  });

  it("rejects noncanonical semantic evidence without publishing private values", async () => {
    const privateValue = "PRIVATE_FORGED_SEMANTIC_EVIDENCE";
    const snapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(snapshot.languageServer?.digest);
    const executor = new PiAgentExecutor(
      {
        async run() {
          return { text: "complete", stopReason: "stop" };
        },
      },
      () => 100,
      5_000,
      65_536,
      () => ({
        evidence: () => [
          {
            ...receipt,
            result: {
              operation: "hover",
              hover: {
                path: "src/example.ts",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 1 },
                },
                format: "plaintext",
                value: privateValue,
              },
            },
          } as typeof receipt,
        ],
        async query() {
          return { operation: "diagnostics", diagnostics: [] };
        },
      }),
    );

    const outcome = await executor.execute(semanticNode(), {
      runId: "run-semantic",
      workflowId: "semantic-workflow",
      attempt: 1,
      cwd: "/workspace",
      protectedPaths: [],
      capabilitySnapshot: snapshot,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_semantic_evidence_invalid",
        message: "semantic query evidence is invalid",
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(privateValue);
  });

  it("rejects digest-valid evidence from a different language server", async () => {
    const snapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(snapshot.languageServer?.digest);
    const substituted = redigestReceipt({
      ...receipt,
      languageServerDigest: "f".repeat(64),
    });
    const executor = new PiAgentExecutor(
      {
        async run() {
          return { text: "complete", stopReason: "stop" };
        },
      },
      () => 100,
      5_000,
      65_536,
      () => ({
        evidence: () => [substituted],
        async query() {
          return { operation: "diagnostics", diagnostics: [] };
        },
      }),
    );

    const outcome = await executor.execute(semanticNode(), {
      runId: "run-semantic",
      workflowId: "semantic-workflow",
      attempt: 1,
      cwd: "/workspace",
      protectedPaths: [],
      capabilitySnapshot: snapshot,
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error: {
        code: "pi_semantic_evidence_invalid",
        message: "semantic query evidence is invalid",
      },
    });
  });

  it.each([
    {
      label: "missing snapshot",
      capabilitySnapshot: undefined,
      factory: () => semanticSession(),
      code: "pi_semantic_snapshot_unavailable",
    },
    {
      label: "missing service factory",
      capabilitySnapshot: semanticCapabilitySnapshot(),
      factory: undefined,
      code: "pi_semantic_service_unavailable",
    },
  ])(
    "fails before provider execution for $label",
    async ({ capabilitySnapshot, factory, code }) => {
      let providerCalls = 0;
      const guarded: PiAgentRunner = {
        async run() {
          providerCalls += 1;
          return { text: "should not run", stopReason: "stop" };
        },
      };
      const selected = new PiAgentExecutor(guarded, () => 100, 5_000, 65_536, factory);

      const outcome = await selected.execute(semanticNode(), {
        runId: "run-semantic",
        workflowId: "semantic-workflow",
        attempt: 1,
        cwd: "/workspace",
        protectedPaths: [],
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      });

      expect(outcome).toMatchObject({ status: "failed", error: { code } });
      expect(providerCalls).toBe(0);
    },
  );
});

function semanticSession(): SemanticToolSession {
  return {
    evidence: () => [],
    async query() {
      return { operation: "diagnostics", diagnostics: [] };
    },
  };
}

function semanticNode() {
  return {
    id: "analyze",
    type: "agent" as const,
    dependsOn: [],
    agent: {
      prompt: "Analyze semantics.",
      model: { provider: "anthropic", id: "model", thinking: "medium" as const },
      tools: ["semantic" as const],
      skills: [],
      toolPackages: [],
      timeoutMs: 30_000,
    },
  };
}

function semanticCapabilitySnapshot() {
  const executable = "/opt/flow/bin/typescript-language-server";
  const executableSha256 = "a".repeat(64);
  const languageServer = createLanguageServerSnapshot({
    provenance: ".flow/language-servers/typescript.json",
    manifest: Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "LanguageServer",
        metadata: { name: "typescript" },
        spec: {
          protocol: "lsp-3.18",
          executable,
          executableSha256,
          args: ["--stdio"],
          languages: [{ id: "typescript", suffixes: [".ts"] }],
          containmentProfile: "default",
          requestTimeoutMs: 5_000,
        },
      }),
    ),
    executable: {
      path: executable,
      sha256: executableSha256,
      bytes: 123,
      device: "1",
      inode: "2",
    },
  });
  return validateCapabilitySnapshot({
    version: 1,
    packages: [],
    languageServer,
    digest: calculateCapabilitySnapshotDigest([], [], undefined, languageServer),
  });
}

function semanticReceipt(languageServerDigest = "c".repeat(64)) {
  return createSemanticQueryReceipt({
    sequence: 1,
    request: {
      operation: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    },
    projectDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    languageServerDigest,
    sandbox: {
      backend: "sandbox-runtime",
      backendVersion: "1.2.3",
      profile: "workspace-readonly-network-deny-v1",
      policyDigest: "d".repeat(64),
    },
    result: { operation: "hover", hover: null },
  });
}

function redigestReceipt(receipt: ReturnType<typeof semanticReceipt>) {
  const { digest: _digest, ...withoutDigest } = receipt;
  return {
    ...withoutDigest,
    digest: createHash("sha256").update(JSON.stringify(withoutDigest)).digest("hex"),
  };
}
