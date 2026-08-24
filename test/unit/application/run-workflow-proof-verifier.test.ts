import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { decideApproval } from "../../../src/application/command-approval.js";
import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  LeanProofDriver,
  RecoverableRunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import {
  createLeanProofRequest,
  type LeanProofRequest,
} from "../../../src/domain/proof/lean-proof-verification.js";
import {
  reduceRunEvents,
  type CommandEvidence,
  type RunEvent,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("runWorkflow Lean proof verifier", () => {
  it("resumes with the exact durable human approval and proof sources", async () => {
    const store = new MemoryStore();
    const command = commandExecutor();
    const driver = proofDriver();
    const executor = new NodeExecutorRouter(command, agentExecutor(), driver);

    const waiting = await runWorkflow(workflow(), {
      runId: "run-proof",
      store,
      executor,
      cwd: "/private/workspace",
      protectedPaths: [],
      now: clock("2026-08-24T10:00:00.000Z"),
    });
    expect(waiting.status).toBe("waiting_for_approval");
    const request = store.events.find((event) => event.type === "workflow_approval_requested");
    expect(request).toMatchObject({
      type: "workflow_approval_requested",
      nodeId: "approve-statement",
      request: {
        evidence: [
          { sourceNodeId: "specification", sourceHash: sha256(specification) },
          { sourceNodeId: "statement", sourceHash: sha256(statement) },
        ],
      },
    });
    if (request?.type !== "workflow_approval_requested") {
      throw new Error("approval request is unavailable");
    }
    await decideApproval({
      runId: "run-proof",
      requestId: request.requestId,
      decision: "approve",
      actor: "operator:daniel",
      store,
      now: () => new Date("2026-08-24T10:01:00.000Z"),
    });

    const state = await resumeWorkflow(workflow(), {
      runId: "run-proof",
      store,
      executor,
      cwd: "/private/workspace",
      protectedPaths: [],
      now: clock("2026-08-24T10:02:00.000Z"),
    });

    expect(driver.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        specification,
        statement,
        proof,
        faithfulness: {
          version: 1,
          authority: "human",
          approverIdentityHash: sha256("operator:daniel"),
          approvedAt: "2026-08-24T10:01:00.000Z",
          specificationDigest: sha256(specification),
          statementDigest: sha256(statement),
        },
        proofModel: {
          selectionRule: "exact-model-v1",
          fallback: "deny",
          provider: "test",
          model: "proof-model",
          thinking: "high",
        },
      }),
      expect.objectContaining({ nodeId: "verify-proof" }),
    );
    expect(state).toMatchObject({
      status: "succeeded",
      nodes: {
        "verify-proof": {
          status: "succeeded",
          evidence: { driver: "lean-proof", verdict: "accepted" },
        },
      },
    });
  });

  it("rejects replay when proof-model thinking provenance changes", async () => {
    const store = new MemoryStore();
    const executor = new NodeExecutorRouter(commandExecutor(), agentExecutor(), proofDriver());

    await runWorkflow(workflow(), {
      runId: "run-proof-provenance",
      store,
      executor,
      cwd: "/private/workspace",
      protectedPaths: [],
      now: clock("2026-08-24T11:00:00.000Z"),
    });
    const approval = store.events.find((event) => event.type === "workflow_approval_requested");
    if (approval?.type !== "workflow_approval_requested") {
      throw new Error("approval request is unavailable");
    }
    await decideApproval({
      runId: "run-proof-provenance",
      requestId: approval.requestId,
      decision: "approve",
      actor: "operator:daniel",
      store,
      now: () => new Date("2026-08-24T11:01:00.000Z"),
    });
    await resumeWorkflow(workflow(), {
      runId: "run-proof-provenance",
      store,
      executor,
      cwd: "/private/workspace",
      protectedPaths: [],
      now: clock("2026-08-24T11:02:00.000Z"),
    });

    const events = structuredClone(store.events);
    const proofEventIndex = events.findIndex(
      (event) => event.type === "node_succeeded" && event.nodeId === "verify-proof",
    );
    const proofEvent = events[proofEventIndex];
    if (
      proofEvent?.type !== "node_succeeded" ||
      proofEvent.evidence.kind !== "verifier" ||
      proofEvent.evidence.driver !== "lean-proof" ||
      proofEvent.evidence.request === null ||
      proofEvent.evidence.request.proofModel === undefined ||
      proofEvent.evidence.execution === null
    ) {
      throw new Error("completed proof evidence is unavailable");
    }
    const request = proofEvent.evidence.request;
    const proofModel = request.proofModel;
    const execution = proofEvent.evidence.execution;
    if (proofModel === undefined) throw new Error("proof model provenance is unavailable");
    const tamperedRequest = createLeanProofRequest({
      specification: request.specification,
      statement: request.statement,
      proof: request.proof,
      targetDeclaration: request.targetDeclaration,
      runtime: request.runtime,
      faithfulness: request.faithfulness,
      proofModel: {
        selectionRule: proofModel.selectionRule,
        fallback: proofModel.fallback,
        provider: proofModel.provider,
        model: proofModel.model,
        thinking: "low",
      },
    });
    const tamperedEvents = events.map((event, index) =>
      index === proofEventIndex
        ? {
            ...proofEvent,
            evidence: {
              ...proofEvent.evidence,
              request: tamperedRequest,
              execution: {
                ...execution,
                requestDigest: tamperedRequest.requestDigest,
              },
            },
          }
        : event,
    );

    expect(() => reduceRunEvents(tamperedEvents)).toThrow(/model provenance is inconsistent/i);
  });
});

const specification = "For every natural number n, n plus zero is n.";
const statement = "theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n";
const proof = "by\n  omega\n";

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: proof-workflow }
nodes:
  - id: specification
    type: command
    command: { executable: read-specification }
  - id: statement
    type: command
    dependsOn: [specification]
    command: { executable: read-statement }
  - id: proof
    type: agent
    dependsOn: [statement]
    agent:
      prompt: Propose only the proof term.
      model: { provider: test, id: proof-model, thinking: high }
  - id: approve-statement
    type: approval
    dependsOn: [specification, statement]
    approval:
      prompt: Confirm that the formal statement represents the specification.
      evidence:
        - { nodeId: specification, field: command.stdout }
        - { nodeId: statement, field: command.stdout }
  - id: verify-proof
    type: verifier
    dependsOn: [specification, statement, proof, approve-statement]
    verifier:
      kind: lean-proof
      targetDeclaration: Flow.Proof.add_zero
      specification: { nodeId: specification, field: command.stdout }
      statement: { nodeId: statement, field: command.stdout }
      proof: { nodeId: proof, field: agent.text }
      faithfulnessApprovalNodeId: approve-statement
      runtime:
        version: 1
        platform: linux
        architecture: x64
        imageDigest: sha256:${"a".repeat(64)}
        buildAttestationDigest: ${"b".repeat(64)}
        dependencyManifestDigest: ${"c".repeat(64)}
        leanVersion: 4.33.1
        mathlibRevision: ${"d".repeat(40)}
        safeVerifyRevision: ${"e".repeat(40)}
        nanodaRevision: "${"1".repeat(40)}"
        profileDigest: "${"2".repeat(64)}"
`);
}

function commandExecutor(): CommandExecutor {
  return {
    execute: vi.fn(async (node) => {
      const value = node.id === "specification" ? specification : statement;
      return {
        status: "succeeded" as const,
        evidence: commandEvidence(node.command.executable, value),
      };
    }),
  };
}

function agentExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async (node) => ({
      status: "succeeded" as const,
      evidence: {
        kind: "agent" as const,
        provider: node.agent.model.provider,
        model: node.agent.model.id,
        text: proof,
        textHash: sha256(proof),
        textTruncated: false,
        durationMs: 1,
        policyDecisions: [],
        effectReceipts: [],
      },
    })),
  };
}

function proofDriver(): LeanProofDriver & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (request: LeanProofRequest) => ({
      version: 1 as const,
      requestDigest: request.requestDigest,
      runtimeIdentity: request.runtime,
      compiler: {
        status: "accepted" as const,
        targetDeclaration: request.targetDeclaration,
        statementDigest: request.statementDigest,
        environmentDigest: "4".repeat(64),
        durationMs: 120,
      },
      safeVerify: {
        status: "accepted" as const,
        targetDeclaration: request.targetDeclaration,
        statementDigest: request.statementDigest,
        environmentDigest: "4".repeat(64),
        observedAxioms: ["propext", "Quot.sound", "Classical.choice"],
        reasonCode: "accepted",
        durationMs: 40,
      },
      nanoda: {
        status: "accepted" as const,
        environmentDigest: "4".repeat(64),
        reasonCode: "accepted",
        durationMs: 25,
      },
      cleanup: "confirmed" as const,
    })),
  };
}

function commandEvidence(executable: string, stdout: string): CommandEvidence {
  return {
    kind: "command",
    executable,
    args: [],
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutHash: sha256(stdout),
    stderrHash: sha256(""),
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
  };
}

function clock(start: string): () => Date {
  let time = Date.parse(start);
  return () => {
    const value = new Date(time);
    time += 1_000;
    return value;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryStore implements RecoverableRunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(runId: string): Promise<readonly RunEvent[]> {
    return this.events
      .filter((event) => event.runId === runId)
      .map((event) => structuredClone(event));
  }

  async claim(runId: string): Promise<readonly RunEvent[]> {
    return await this.read(runId);
  }

  async release(_runId: string): Promise<void> {}
}
