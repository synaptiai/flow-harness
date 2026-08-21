import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { createLanguageServerSnapshot } from "../../../src/domain/capability/language-server.js";
import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { createSemanticQueryReceipt } from "../../../src/domain/semantic/semantic-code.js";

describe("semantic receipt replay", () => {
  it("retains canonical semantic receipts in terminal agent evidence", () => {
    const capabilitySnapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(1, capabilitySnapshot.languageServer?.digest);

    const state = reduceRunEvents(events([receipt], capabilitySnapshot));

    expect(state.nodes.analyze?.evidence).toMatchObject({
      kind: "agent",
      semanticReceipts: [receipt],
    });
  });

  it("rejects forged content and noncontiguous semantic receipt sequences", () => {
    const capabilitySnapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(1, capabilitySnapshot.languageServer?.digest);
    const forged = {
      ...receipt,
      result: {
        operation: "hover" as const,
        hover: {
          path: "src/example.ts",
          range: range(0, 0, 0, 1),
          format: "plaintext" as const,
          value: "PRIVATE_FORGED_RESULT",
        },
      },
    };

    expect(() => reduceRunEvents(events([forged], capabilitySnapshot))).toThrow(
      /semantic receipt is invalid/i,
    );
    expect(() =>
      reduceRunEvents(
        events(
          [
            semanticReceipt(1, capabilitySnapshot.languageServer?.digest),
            semanticReceipt(3, capabilitySnapshot.languageServer?.digest),
          ],
          capabilitySnapshot,
        ),
      ),
    ).toThrow(/semantic receipt sequence must be contiguous/i);
  });

  it("rejects semantic receipts without the exact durable language server", () => {
    const capabilitySnapshot = semanticCapabilitySnapshot();
    const receipt = semanticReceipt(1, capabilitySnapshot.languageServer?.digest);
    const substituted = redigestReceipt({
      ...receipt,
      languageServerDigest: "f".repeat(64),
    });

    expect(() => reduceRunEvents(events([receipt]))).toThrow(
      /semantic receipt requires a durable language-server snapshot/i,
    );
    expect(() => reduceRunEvents(events([substituted], capabilitySnapshot))).toThrow(
      /semantic receipt language server does not match the durable run snapshot/i,
    );
  });
});

function events(
  semanticReceipts: readonly unknown[],
  capabilitySnapshot?: CapabilitySnapshot,
): RunEvent[] {
  return [
    {
      ...base(1),
      type: "run_started",
      nodeIds: ["analyze"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "e".repeat(64),
      ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
    },
    { ...base(2), type: "node_started", nodeId: "analyze", attempt: 1 },
    {
      ...base(3),
      type: "node_succeeded",
      nodeId: "analyze",
      attempt: 1,
      evidence: {
        kind: "agent",
        provider: "test",
        model: "deterministic",
        text: "done",
        textHash: sha256("done"),
        textTruncated: false,
        durationMs: 1,
        policyDecisions: [],
        effectReceipts: [],
        semanticReceipts,
      },
    },
  ] as RunEvent[];
}

function semanticReceipt(sequence: number, languageServerDigest = "c".repeat(64)) {
  return createSemanticQueryReceipt({
    sequence,
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

function semanticCapabilitySnapshot(): CapabilitySnapshot {
  const manifest = Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "typescript" },
      spec: {
        protocol: "lsp-3.18",
        executable: "/opt/flow/bin/typescript-language-server",
        executableSha256: "c".repeat(64),
        args: ["--stdio"],
        languages: [{ id: "typescript", suffixes: [".ts"] }],
        containmentProfile: "default",
        requestTimeoutMs: 5_000,
      },
    }),
  );
  const languageServer = createLanguageServerSnapshot({
    provenance: ".flow/language-servers/typescript.json",
    manifest,
    executable: {
      path: "/opt/flow/bin/typescript-language-server",
      sha256: "c".repeat(64),
      bytes: 128,
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

function redigestReceipt(receipt: ReturnType<typeof semanticReceipt>) {
  const { digest: _digest, ...withoutDigest } = receipt;
  return { ...withoutDigest, digest: sha256(JSON.stringify(withoutDigest)) };
}

function base(sequence: number) {
  return {
    version: 1 as const,
    sequence,
    at: `2026-08-21T15:00:0${sequence}.000Z`,
    runId: "semantic-run",
    workflowId: "semantic-workflow",
  };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
