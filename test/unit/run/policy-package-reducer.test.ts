import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  NodeExecutor,
  RecoverableRunEventStore,
  RunEventStore,
} from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { PolicyPackageAdmissionError } from "../../../src/domain/policy/policy-package-admission.js";
import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("policy package run history", () => {
  it("persists and replays the exact immutable policy snapshot", async () => {
    const snapshot = policySnapshot();
    const store = new MemoryStore();
    await runWorkflow(workflow(8), {
      runId: "policy-history",
      cwd: process.cwd(),
      protectedPaths: [],
      capabilitySnapshot: snapshot,
      store,
      executor: successfulExecutor(),
    });

    const started = store.events[0];
    expect(started).toMatchObject({
      type: "run_started",
      capabilitySnapshot: {
        packages: [{ kind: "policy-package", name: "bounded-run", version: "1.0.0" }],
      },
    });
    expect(reduceRunEvents(structuredClone(store.events)).capabilitySnapshot).toEqual(snapshot);
  });

  it("recovers offline from durable policy evidence without a live catalog", async () => {
    const snapshot = policySnapshot();
    const source = workflow(8);
    const initial = new MemoryStore();
    await runWorkflow(source, {
      runId: "policy-recovery",
      cwd: process.cwd(),
      protectedPaths: [],
      capabilitySnapshot: snapshot,
      store: initial,
      executor: successfulExecutor(),
    });
    const started = initial.events[0];
    if (started?.type !== "run_started") {
      throw new Error("run_started fixture is missing");
    }
    const recovery = new MemoryStore([started]);

    const state = await resumeWorkflow(source, {
      runId: "policy-recovery",
      cwd: process.cwd(),
      protectedPaths: [],
      store: recovery,
      executor: successfulExecutor(),
    });

    expect(state.status).toBe("succeeded");
    expect(recovery.events.map((event) => event.type)).toContain("run_resumed");
    expect(recovery.events[0]).toEqual(started);
  });

  it("rejects a policy-incompatible resume before claiming durable ownership", async () => {
    const snapshot = policySnapshot();
    const store = new MemoryStore();
    const claim = vi.spyOn(store, "claim");

    await expect(
      resumeWorkflow(workflow(9), {
        runId: "policy-incompatible",
        cwd: process.cwd(),
        protectedPaths: [],
        capabilitySnapshot: snapshot,
        store,
        executor: successfulExecutor(),
      }),
    ).rejects.toBeInstanceOf(PolicyPackageAdmissionError);
    expect(claim).not.toHaveBeenCalled();
    expect(store.events).toEqual([]);
  });

  it("rejects a mutated durable policy snapshot even when its outer event remains shaped", async () => {
    const store = new MemoryStore();
    await runWorkflow(workflow(8), {
      runId: "policy-mutation",
      cwd: process.cwd(),
      protectedPaths: [],
      capabilitySnapshot: policySnapshot(),
      store,
      executor: successfulExecutor(),
    });
    const started = store.events[0];
    if (started?.type !== "run_started" || started.capabilitySnapshot === undefined) {
      throw new Error("run_started policy snapshot fixture is missing");
    }
    const events = structuredClone(store.events);
    events[0] = {
      ...started,
      capabilitySnapshot: {
        ...started.capabilitySnapshot,
        digest: "f".repeat(64),
      },
    };

    expect(() => reduceRunEvents(events)).toThrow(/capability snapshot digest/i);
  });
});

function workflow(maxNodeStarts: number) {
  return compileWorkflowText(`apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: policy-history }
budget: { maxNodeStarts: ${maxNodeStarts} }
nodes:
  - id: finish
    type: command
    command: { executable: /usr/bin/true }
`);
}

function policySnapshot() {
  return createCapabilitySnapshot(
    [],
    [],
    [],
    [],
    [
      {
        kind: "policy-package",
        trust: "project-explicit",
        provenance: ".flow/policies/bounded-run",
        manifest: {
          content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata: { name: bounded-run, version: 1.0.0, description: Bound run starts. }
spec:
  budget: { maxNodeStarts: 8 }
`),
        },
      },
    ],
  );
}

function successfulExecutor(): NodeExecutor {
  return {
    execute: vi.fn(async (node) => ({
      status: "succeeded" as const,
      evidence: {
        kind: "command" as const,
        executable: node.type === "command" ? node.command.executable : "/usr/bin/true",
        args: node.type === "command" ? node.command.args : [],
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutHash: sha256(""),
        stderrHash: sha256(""),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        durationMs: 1,
      },
    })),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryStore implements RunEventStore, RecoverableRunEventStore {
  readonly events: RunEvent[];

  constructor(events: readonly RunEvent[] = []) {
    this.events = [...structuredClone(events)];
  }

  async append(event: RunEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async read(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async claim(): Promise<readonly RunEvent[]> {
    return structuredClone(this.events);
  }

  async release(): Promise<void> {}
}
