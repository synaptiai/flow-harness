import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { decideCommandApproval } from "../../../src/application/command-approval.js";
import type { NodeExecutor } from "../../../src/application/ports.js";
import { resumeWorkflow, runWorkflow } from "../../../src/application/run-workflow.js";
import { reduceRunEvents } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { JsonlRunStore } from "../../../src/infrastructure/fs/jsonl-run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("concurrent command approval decisions", () => {
  it("commits exactly one competing decision and never starts the command", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-approval-race-"));
    temporaryDirectories.push(root);
    await runWorkflow(workflow(), {
      runId: "approval-race",
      cwd: root,
      protectedPaths: [root],
      store: new JsonlRunStore(root),
      executor: successfulExecutor(),
      now: () => new Date("2026-08-07T15:00:00.000Z"),
    });

    const decisions = await Promise.allSettled([
      decideCommandApproval({
        runId: "approval-race",
        requestId: "approval-2",
        decision: "approve",
        actor: "operator:first",
        store: new JsonlRunStore(root),
      }),
      decideCommandApproval({
        runId: "approval-race",
        requestId: "approval-2",
        decision: "deny",
        actor: "operator:second",
        store: new JsonlRunStore(root),
      }),
    ]);

    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1);

    const events = await new JsonlRunStore(root).read("approval-race");
    const decisionTypes = events.filter(
      (event) =>
        event.type === "command_approval_granted" || event.type === "command_approval_denied",
    );
    expect(decisionTypes).toHaveLength(1);
    expect(events.some((event) => event.type === "node_started")).toBe(false);
    expect(["running", "failed"]).toContain(reduceRunEvents(events).status);
  });

  it("consumes one grant and starts one command under competing resumes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-approval-resume-race-"));
    temporaryDirectories.push(root);
    const compiled = workflow();
    await runWorkflow(compiled, {
      runId: "approval-resume-race",
      cwd: root,
      protectedPaths: [root],
      store: new JsonlRunStore(root),
      executor: successfulExecutor(),
    });
    await decideCommandApproval({
      runId: "approval-resume-race",
      requestId: "approval-2",
      decision: "approve",
      actor: "operator:test",
      store: new JsonlRunStore(root),
    });
    const executorCalls: string[] = [];
    const delayedExecutor: NodeExecutor = {
      async execute(node) {
        executorCalls.push(node.id);
        await delay(50);
        return commandSuccess();
      },
    };

    const resumes = await Promise.allSettled([
      resumeWorkflow(compiled, {
        runId: "approval-resume-race",
        cwd: root,
        protectedPaths: [root],
        store: new JsonlRunStore(root),
        executor: delayedExecutor,
      }),
      resumeWorkflow(compiled, {
        runId: "approval-resume-race",
        cwd: root,
        protectedPaths: [root],
        store: new JsonlRunStore(root),
        executor: delayedExecutor,
      }),
    ]);

    expect(resumes.filter((resume) => resume.status === "fulfilled")).toHaveLength(1);
    expect(resumes.filter((resume) => resume.status === "rejected")).toHaveLength(1);
    expect(executorCalls).toEqual(["verify"]);
    const events = await new JsonlRunStore(root).read("approval-resume-race");
    expect(events.filter((event) => event.type === "node_started")).toHaveLength(1);
    expect(reduceRunEvents(events).status).toBe("succeeded");
  });
});

function workflow() {
  return compileWorkflowText(`
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: approval-race }
nodes:
  - id: verify
    type: command
    approval: { mode: required }
    command: { executable: node, args: [--version] }
`);
}

function successfulExecutor(): NodeExecutor {
  return {
    async execute() {
      return commandSuccess();
    },
  };
}

function commandSuccess() {
  const output = "v22.19.0\n";
  return {
    status: "succeeded" as const,
    evidence: {
      kind: "command" as const,
      executable: "node",
      args: ["--version"],
      exitCode: 0,
      signal: null,
      stdout: output,
      stderr: "",
      stdoutHash: createHash("sha256").update(output).digest("hex"),
      stderrHash: createHash("sha256").update("").digest("hex"),
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: 1,
    },
  };
}
