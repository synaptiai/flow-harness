import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { NodeExecutorRouter } from "../../../src/application/node-executor-router.js";
import type {
  AgentExecutor,
  CommandExecutor,
  NodeExecutionOutcome,
  RunEventStore,
} from "../../../src/application/ports.js";
import { runWorkflow } from "../../../src/application/run-workflow.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import type { VerifierPackageSnapshotInput } from "../../../src/domain/capability/verifier-packages.js";
import {
  type CommandEvidence,
  type RunEvent,
  reduceRunEvents,
} from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("verifier package run history", () => {
  it.each([
    {
      label: "missing package-use evidence",
      mutate(events: RunEvent[]) {
        const succeeded = requireSucceeded(events);
        if (succeeded.evidence.kind !== "verifier") {
          throw new Error("verifier evidence fixture is missing");
        }
        const { package: _package, ...evidence } = succeeded.evidence;
        events[events.indexOf(succeeded)] = { ...succeeded, evidence };
      },
    },
    {
      label: "forged package digest",
      mutate(events: RunEvent[]) {
        const succeeded = requireSucceeded(events);
        if (succeeded.evidence.kind !== "verifier" || succeeded.evidence.package === undefined) {
          throw new Error("verifier package evidence fixture is missing");
        }
        events[events.indexOf(succeeded)] = {
          ...succeeded,
          evidence: {
            ...succeeded.evidence,
            package: { ...succeeded.evidence.package, digest: "0".repeat(64) },
          },
        };
      },
    },
    {
      label: "missing run-start requirement",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        const { verifierPackageRequirements: _requirements, ...without } = started;
        events[0] = without;
      },
    },
    {
      label: "requirement version drift",
      mutate(events: RunEvent[]) {
        const started = requireStarted(events);
        if (started.verifierPackageRequirements === undefined) {
          throw new Error("verifier package requirement fixture is missing");
        }
        events[0] = {
          ...started,
          verifierPackageRequirements: started.verifierPackageRequirements.map((requirement) => ({
            ...requirement,
            version: "1.0.1",
          })),
        };
      },
    },
  ])("rejects $label", async ({ mutate }) => {
    const events = await packagedEvents();
    mutate(events);

    expect(() => reduceRunEvents(events)).toThrow(/package|control graph|snapshot/i);
  });

  it("retains historical inline verifier ledgers and rejects invented package identity on them", async () => {
    const command = fakeCommandExecutor(async (node) => commandSuccess(node.id));
    const store = new MemoryStore();
    await runWorkflow(inlineWorkflow(), {
      cwd: process.cwd(),
      protectedPaths: [],
      runId: "inline-verifier-history",
      store,
      executor: new NodeExecutorRouter(command, fakeAgentExecutor()),
    });
    expect(reduceRunEvents(store.events).status).toBe("succeeded");
    const succeeded = requireSucceeded(store.events);
    if (succeeded.evidence.kind !== "verifier") {
      throw new Error("inline verifier evidence fixture is missing");
    }
    const forged = structuredClone(store.events);
    const succeededIndex = forged.findIndex((event) => event.type === "node_succeeded");
    if (succeededIndex < 0) {
      throw new Error("forged inline verifier event is missing");
    }
    forged[succeededIndex] = {
      ...succeeded,
      evidence: {
        ...succeeded.evidence,
        package: { name: "invented", version: "1.0.0", digest: "0".repeat(64) },
      },
    };

    expect(() => reduceRunEvents(forged)).toThrow(/inline verifier.*package identity/i);
  });
});

async function packagedEvents(): Promise<RunEvent[]> {
  const snapshot = createCapabilitySnapshot([], [packageInput()]);
  const store = new MemoryStore();
  await runWorkflow(packagedWorkflow(), {
    cwd: process.cwd(),
    protectedPaths: [],
    runId: "packaged-verifier-history",
    store,
    executor: new NodeExecutorRouter(
      fakeCommandExecutor(async (node) => commandSuccess(node.id)),
      fakeAgentExecutor(),
    ),
    capabilitySnapshot: snapshot,
  });
  return structuredClone(store.events);
}

class MemoryStore implements RunEventStore {
  readonly events: RunEvent[] = [];

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }
}

function requireStarted(events: RunEvent[]) {
  const event = events[0];
  if (event?.type !== "run_started") {
    throw new Error("run_started fixture is missing");
  }
  return event;
}

function requireSucceeded(events: RunEvent[]) {
  const event = events.find((item) => item.type === "node_succeeded");
  if (event?.type !== "node_succeeded") {
    throw new Error("node_succeeded fixture is missing");
  }
  return event;
}

function fakeCommandExecutor(implementation: CommandExecutor["execute"]): CommandExecutor {
  return { execute: vi.fn(implementation) };
}

function fakeAgentExecutor(): AgentExecutor {
  return {
    execute: vi.fn(async () => {
      throw new Error("unexpected agent invocation");
    }),
  };
}

function commandSuccess(id: string): NodeExecutionOutcome {
  return { status: "succeeded", evidence: commandEvidence(id) };
}

function commandEvidence(id: string): CommandEvidence {
  const stdout = "v22.0.0";
  return {
    kind: "command",
    executable: "node",
    args: id === "release" ? ["--version"] : [],
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

function packageInput(): VerifierPackageSnapshotInput {
  const definition = {
    kind: "command" as const,
    command: { executable: "node", args: ["--version"], timeoutMs: 30_000 },
  };
  return {
    kind: "verifier-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name: "release-tests",
    version: "1.0.0",
    description: "Run release tests.",
    trust: "project-explicit",
    provenance: ".flow/verifiers/release-tests",
    definition,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata: { name: release-tests, version: 1.0.0, description: Run release tests. }
spec:
  kind: command
  command: { executable: node, args: [--version], timeoutMs: 30000 }
`),
    },
  };
}

function packagedWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: package-history }
nodes:
  - id: release
    type: verifier
    verifier:
      kind: packaged-command
      package: { name: release-tests, version: 1.0.0 }
`);
}

function inlineWorkflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: inline-history }
nodes:
  - id: release
    type: verifier
    verifier:
      kind: command
      command: { executable: node, args: [--version], timeoutMs: 30000 }
`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
