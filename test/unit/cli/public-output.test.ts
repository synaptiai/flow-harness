import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectPublicRunOutput } from "../../../src/cli/public-output.js";
import { createLeanProofRequest } from "../../../src/domain/proof/lean-proof-verification.js";

describe("public run output", () => {
  it("replaces private proof content with bounded identities", () => {
    const specification = "PRIVATE_SPECIFICATION: n + 0 = n";
    const statement = "theorem Flow.Proof.add_zero (PRIVATE_STATEMENT : Prop) : PRIVATE_STATEMENT";
    const proof = "by\n  exact PRIVATE_PROOF";
    const specificationDigest = sha256(specification);
    const statementDigest = sha256(statement);
    const request = createLeanProofRequest({
      specification,
      statement,
      proof,
      targetDeclaration: "Flow.Proof.add_zero",
      runtime: {
        version: 1,
        platform: "linux",
        architecture: "x64",
        imageDigest: `sha256:${"a".repeat(64)}`,
        buildAttestationDigest: "b".repeat(64),
        dependencyManifestDigest: "c".repeat(64),
        leanVersion: "4.33.1",
        mathlibRevision: "d".repeat(40),
        safeVerifyRevision: "e".repeat(40),
        nanodaRevision: "1".repeat(40),
        profileDigest: "2".repeat(64),
      },
      faithfulness: {
        version: 1,
        authority: "human",
        approverIdentityHash: "3".repeat(64),
        approvedAt: "2026-08-24T10:00:00.000Z",
        specificationDigest,
        statementDigest,
      },
    });
    const execution = {
      version: 1,
      requestDigest: request.requestDigest,
      runtimeIdentity: request.runtime,
      compiler: {
        status: "accepted",
        targetDeclaration: request.targetDeclaration,
        statementDigest,
        environmentDigest: "4".repeat(64),
        durationMs: 1,
      },
      safeVerify: {
        status: "accepted",
        targetDeclaration: request.targetDeclaration,
        statementDigest,
        environmentDigest: "4".repeat(64),
        observedAxioms: ["propext"],
        reasonCode: "accepted",
        durationMs: 1,
      },
      nanoda: {
        status: "accepted",
        environmentDigest: "4".repeat(64),
        reasonCode: "accepted",
        durationMs: 1,
      },
      cleanup: "confirmed",
    } as const;

    const projected = projectPublicRunOutput({
      type: "node_succeeded",
      evidence: {
        kind: "verifier",
        driver: "lean-proof",
        result: "completed",
        verdict: "accepted",
        reason: "accepted",
        reasonHash: sha256("accepted"),
        durationMs: 3,
        sources: [],
        request,
        execution,
      },
    });
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject({
      evidence: {
        kind: "verifier",
        driver: "lean-proof",
        request: {
          requestDigest: request.requestDigest,
          specification: { digest: request.specificationDigest, bytes: 32 },
          statement: {
            digest: request.statementDigest,
            bytes: Buffer.byteLength(statement, "utf8"),
          },
          proof: { digest: request.proofDigest, bytes: Buffer.byteLength(proof, "utf8") },
          targetDeclaration: {
            digest: sha256(request.targetDeclaration),
            bytes: 19,
          },
        },
        execution: { cleanup: "confirmed" },
      },
    });
    expect(serialized).not.toContain("PRIVATE_SPECIFICATION");
    expect(serialized).not.toContain("PRIVATE_STATEMENT");
    expect(serialized).not.toContain("PRIVATE_PROOF");
  });
  it("removes encoded package content from nested state and event values", () => {
    const privateContent = Buffer.from("PRIVATE_AGENT_SKILL_RESOURCE\n").toString("base64");
    const durable = {
      type: "run_started",
      capabilitySnapshot: {
        digest: "a".repeat(64),
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            files: [
              {
                path: "references/checklist.md",
                bytes: 29,
                sha256: "b".repeat(64),
                contentBase64: privateContent,
              },
            ],
          },
        ],
      },
    };

    const projected = projectPublicRunOutput(durable);

    expect(projected).toEqual({
      type: "run_started",
      workProfile: "standard",
      capabilitySnapshot: {
        digest: "a".repeat(64),
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            files: [
              {
                path: "references/checklist.md",
                bytes: 29,
                sha256: "b".repeat(64),
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("contentBase64");
    expect(JSON.stringify(projected)).not.toContain(privateContent);
    expect(durable.capabilitySnapshot.packages[0]?.files[0]?.contentBase64).toBe(privateContent);
  });

  it("projects the effective profile for legacy and current event pages", () => {
    expect(
      projectPublicRunOutput({
        type: "events",
        events: [
          { type: "run_started", runId: "legacy-run" },
          { type: "run_started", runId: "current-run", workProfile: "long" },
        ],
      }),
    ).toEqual({
      type: "events",
      events: [
        { type: "run_started", runId: "legacy-run", workProfile: "standard" },
        { type: "run_started", runId: "current-run", workProfile: "long" },
      ],
    });
  });

  it("preserves legacy prompt bytes and same-named public metadata", () => {
    const promptContent = Buffer.from("legacy prompt workflow\n").toString("base64");
    const value = {
      capabilitySnapshot: {
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            metadata: {
              contentBase64: "public-metadata-label",
              nested: {
                kind: "agent-skill",
                files: [{ contentBase64: "public-nested-metadata" }],
              },
            },
            files: [
              {
                path: "SKILL.md",
                contentBase64: Buffer.from("private skill bytes\n").toString("base64"),
              },
            ],
          },
        ],
        activations: [
          {
            kind: "prompt-activation",
            source: { bytes: 23, sha256: "c".repeat(64), contentBase64: promptContent },
          },
        ],
      },
    };

    expect(projectPublicRunOutput(value)).toEqual({
      capabilitySnapshot: {
        packages: [
          {
            kind: "agent-skill",
            name: "review",
            metadata: {
              contentBase64: "public-metadata-label",
              nested: {
                kind: "agent-skill",
                files: [{ contentBase64: "public-nested-metadata" }],
              },
            },
            files: [{ path: "SKILL.md" }],
          },
        ],
        activations: [
          {
            kind: "prompt-activation",
            source: { bytes: 23, sha256: "c".repeat(64), contentBase64: promptContent },
          },
        ],
      },
    });
  });

  it("removes supplemental memory and relationship details from public output", () => {
    const privateText = "PRIVATE_SUPPLEMENTAL_MEMORY\n";
    const privateContent = Buffer.from(privateText).toString("base64");
    const value = {
      capabilitySnapshot: {
        effectiveHarness: {
          version: 1,
          kind: "effective-harness-runtime",
          supplementalMemory: [
            {
              id: "operator-guidance",
              target: {
                workflowId: "review-workflow",
                childPath: [],
                agentNodeId: "reviewer",
              },
              bytes: Buffer.byteLength(privateText),
              sha256: "d".repeat(64),
              contentBase64: privateContent,
              metadata: { contentBase64: "public-metadata-label" },
            },
          ],
          supplementalMemoryRelationships: {
            version: 1,
            kind: "supplemental-memory-relationship-state",
            relationships: [
              {
                id: "private-support",
                predicate: "supports",
                evidence: [
                  {
                    runId: "PRIVATE_RELATIONSHIP_RUN",
                    nodeId: "reviewer",
                    attempt: 1,
                    sequence: 2,
                    eventDigest: "e".repeat(64),
                  },
                ],
              },
            ],
            assessment: {
              relationshipCount: 1,
              evidenceReferenceCount: 1,
              unresolvedContradictionCount: 0,
              relationshipSetDigest: "e".repeat(64),
              digest: "f".repeat(64),
            },
          },
        },
      },
    };

    const projected = projectPublicRunOutput(value);

    expect(projected).toEqual({
      capabilitySnapshot: {
        effectiveHarness: {
          version: 1,
          kind: "effective-harness-runtime",
          supplementalMemory: [
            {
              id: "operator-guidance",
              target: {
                workflowId: "review-workflow",
                childPath: [],
                agentNodeId: "reviewer",
              },
              bytes: Buffer.byteLength(privateText),
              sha256: "d".repeat(64),
              metadata: { contentBase64: "public-metadata-label" },
            },
          ],
          supplementalMemoryRelationships: {
            relationshipCount: 1,
            evidenceReferenceCount: 1,
            unresolvedContradictionCount: 0,
            relationshipSetDigest: "e".repeat(64),
            assessmentDigest: "f".repeat(64),
          },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain(privateContent);
    expect(JSON.stringify(projected)).not.toContain(privateText);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_RELATIONSHIP_RUN");
    expect(JSON.stringify(projected)).not.toContain("private-support");
    expect(value.capabilitySnapshot.effectiveHarness.supplementalMemory[0]?.contentBase64).toBe(
      privateContent,
    );
  });

  it("projects a language server without private executable or manifest data", () => {
    const privateManifest = Buffer.from("PRIVATE_LANGUAGE_SERVER_MANIFEST\n").toString("base64");
    const value = {
      capabilitySnapshot: {
        languageServer: {
          version: 1,
          kind: "language-server",
          name: "typescript",
          protocol: "lsp-3.18",
          executable: {
            path: "/PRIVATE/bin/typescript-language-server",
            sha256: "a".repeat(64),
            bytes: 1_024,
            device: "16777234",
            inode: "9071",
          },
          args: ["--stdio", "--PRIVATE_CONFIG"],
          languages: [{ id: "typescript", suffixes: [".ts"] }],
          initializationOptions: { private: "PRIVATE_INITIALIZATION" },
          containmentProfile: "default",
          requestTimeoutMs: 5_000,
          manifest: {
            provenance: ".flow/language-servers/typescript.json",
            sha256: "b".repeat(64),
            bytes: 512,
            contentBase64: privateManifest,
          },
          digest: "c".repeat(64),
        },
      },
    };

    const projected = projectPublicRunOutput(value);

    expect(projected).toEqual({
      capabilitySnapshot: {
        languageServer: {
          version: 1,
          kind: "language-server",
          name: "typescript",
          protocol: "lsp-3.18",
          executable: { sha256: "a".repeat(64), bytes: 1_024 },
          languages: [{ id: "typescript", suffixes: [".ts"] }],
          containmentProfile: "default",
          requestTimeoutMs: 5_000,
          manifest: {
            provenance: ".flow/language-servers/typescript.json",
            sha256: "b".repeat(64),
            bytes: 512,
          },
          digest: "c".repeat(64),
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    expect(value.capabilitySnapshot.languageServer.manifest.contentBase64).toBe(privateManifest);
  });

  it("projects an ACP agent without private launch, credential, or manifest data", () => {
    const privateManifest = Buffer.from("PRIVATE_ACP_AGENT_MANIFEST\n").toString("base64");
    const value = {
      capabilitySnapshot: {
        acpAgent: {
          version: 1,
          kind: "acp-agent",
          name: "review-agent",
          protocol: "acp-v1",
          compatibilityProfile: "prompt-only-v1",
          launch: {
            kind: "node-package",
            nodeExecutable: {
              path: "/PRIVATE/bin/node",
              sha256: "a".repeat(64),
              bytes: 1_024,
              device: "1",
              inode: "2",
            },
            nodeVersion: "v27.0.0",
            package: {
              root: "/PRIVATE/node_modules/review-agent",
              resolutionRoot: "/PRIVATE/node_modules",
              name: "review-agent",
              version: "1.2.3",
              sha256: "b".repeat(64),
              bytes: 2_048,
              files: 7,
              device: "3",
              inode: "4",
              entrypoint: {
                path: "dist/PRIVATE-entrypoint.js",
                sha256: "c".repeat(64),
                bytes: 512,
                device: "5",
                inode: "6",
              },
            },
            args: ["--PRIVATE_CONFIG"],
          },
          modelMappings: [
            { provider: "example", model: "public-model", agentModel: "public-agent-model" },
          ],
          providerAuthorities: [
            {
              provider: "example",
              domain: "PRIVATE.example.com",
              credentialEnv: "PRIVATE_API_KEY",
            },
          ],
          containmentProfile: "acp-prompt-only-v1",
          usage: { modelTokens: "complete", costUsd: "unavailable" },
          configuration: { private: "PRIVATE_CONFIGURATION" },
          manifest: {
            provenance: "PRIVATE/acp-agent.json",
            sha256: "d".repeat(64),
            bytes: 768,
            contentBase64: privateManifest,
          },
          digest: "e".repeat(64),
        },
      },
    };

    const projected = projectPublicRunOutput(value);

    expect(projected).toEqual({
      capabilitySnapshot: {
        acpAgent: {
          version: 1,
          kind: "acp-agent",
          name: "review-agent",
          protocol: "acp-v1",
          compatibilityProfile: "prompt-only-v1",
          launch: {
            kind: "node-package",
            nodeExecutable: { sha256: "a".repeat(64), bytes: 1_024 },
            nodeVersion: "v27.0.0",
            package: {
              name: "review-agent",
              version: "1.2.3",
              sha256: "b".repeat(64),
              bytes: 2_048,
              files: 7,
              entrypoint: { sha256: "c".repeat(64), bytes: 512 },
            },
          },
          modelMappings: [
            { provider: "example", model: "public-model", agentModel: "public-agent-model" },
          ],
          containmentProfile: "acp-prompt-only-v1",
          usage: { modelTokens: "complete", costUsd: "unavailable" },
          manifest: { sha256: "d".repeat(64), bytes: 768 },
          digest: "e".repeat(64),
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(value.capabilitySnapshot.acpAgent.manifest.contentBase64).toBe(privateManifest);
  });

  it("projects semantic receipts as safe summaries without changing same-named result data", () => {
    const privatePath = "PRIVATE/source/example.ts";
    const privateMessage = "PRIVATE semantic diagnostic";
    const receipt = {
      version: 1,
      sequence: 1,
      request: { operation: "diagnostics", path: privatePath },
      requestDigest: "a".repeat(64),
      projectDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      languageServerDigest: "d".repeat(64),
      sandbox: {
        backend: "sandbox-runtime",
        backendVersion: "1.2.3",
        profile: "workspace-readonly-network-deny-v1",
        policyDigest: "e".repeat(64),
      },
      result: {
        operation: "diagnostics",
        diagnostics: [
          {
            path: privatePath,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            severity: "error",
            message: privateMessage,
          },
        ],
      },
      resultDigest: "f".repeat(64),
      digest: "0".repeat(64),
    };
    const value = {
      type: "node_succeeded",
      evidence: {
        kind: "agent",
        provider: "test",
        model: "deterministic",
        semanticReceipts: [receipt],
      },
      result: {
        semanticReceipts: [{ request: privatePath, result: privateMessage }],
      },
    };

    const projected = projectPublicRunOutput(value);

    expect(projected).toEqual({
      type: "node_succeeded",
      evidence: {
        kind: "agent",
        provider: "test",
        model: "deterministic",
        semanticReceipts: [
          {
            version: 1,
            sequence: 1,
            operation: "diagnostics",
            itemCount: 1,
            requestDigest: "a".repeat(64),
            projectDigest: "b".repeat(64),
            sourceDigest: "c".repeat(64),
            languageServerDigest: "d".repeat(64),
            sandbox: receipt.sandbox,
            resultDigest: "f".repeat(64),
            digest: "0".repeat(64),
          },
        ],
      },
      result: {
        semanticReceipts: [{ request: privatePath, result: privateMessage }],
      },
    });
    expect(JSON.stringify((projected as { evidence: unknown }).evidence)).not.toContain("PRIVATE");
    expect(value.evidence.semanticReceipts[0]).toBe(receipt);
  });

  it("projects goal workspace review fields without copying unknown private data", () => {
    const goalWorkspace = {
      version: 1,
      kind: "goal-workspace-revision",
      revision: 2,
      previousDigest: "a".repeat(64),
      at: "2026-08-21T20:00:00.000Z",
      objective: "Ship a durable goal workspace.",
      facts: [{ id: "state", text: "The ledger is append-only." }],
      invariants: [{ id: "authority", text: "Policy remains authoritative." }],
      verifiedFacts: [
        {
          id: "proof",
          text: "The focused test passed.",
          evidence: [
            {
              runId: "run-1",
              nodeId: "verify",
              attempt: 1,
              sequence: 7,
              eventDigest: "b".repeat(64),
            },
          ],
        },
      ],
      openQuestions: [{ id: "risk", text: "Which risk remains?" }],
      nextAction: { id: "review", text: "Review the implementation." },
      digest: "c".repeat(64),
      privateEvidenceBytes: "PRIVATE_RAW_EVIDENCE",
    };

    const projected = projectPublicRunOutput({
      capabilitySnapshot: {
        version: 1,
        packages: [],
        goalWorkspace,
        digest: "d".repeat(64),
      },
    });

    expect(projected).toEqual({
      capabilitySnapshot: {
        version: 1,
        packages: [],
        goalWorkspace: {
          version: 1,
          kind: "goal-workspace-revision",
          revision: 2,
          previousDigest: "a".repeat(64),
          at: "2026-08-21T20:00:00.000Z",
          objective: "Ship a durable goal workspace.",
          facts: [{ id: "state", text: "The ledger is append-only." }],
          invariants: [{ id: "authority", text: "Policy remains authoritative." }],
          verifiedFacts: goalWorkspace.verifiedFacts,
          openQuestions: [{ id: "risk", text: "Which risk remains?" }],
          nextAction: { id: "review", text: "Review the implementation." },
          digest: "c".repeat(64),
        },
        digest: "d".repeat(64),
      },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_RAW_EVIDENCE");
    expect(goalWorkspace.privateEvidenceBytes).toBe("PRIVATE_RAW_EVIDENCE");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
