import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NodeExecutionContext, NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("goal workspace CLI", () => {
  it("initializes, reviews, updates, validates, and runs from one durable revision", async () => {
    const project = await projectFixture();
    const initialPath = join(project, "goal-initial.yaml");
    const updatePath = join(project, "goal-update.yaml");
    const workflowPath = join(project, "goal.workflow.yaml");
    await writeFile(initialPath, goalSource("Ship a usable harness.", "Implement the workspace."));
    await writeFile(updatePath, goalSource("Ship a usable harness.", "Review the workspace."));
    await writeFile(workflowPath, workflowSource());

    const initializedOutput = capture();
    expect(
      await main(["goal", "init", initialPath], initializedOutput.io, { cwd: project }),
      initializedOutput.stderr.join("\n"),
    ).toBe(0);
    const initialized = JSON.parse(initializedOutput.stdout.join("\n"));
    expect(initialized).toMatchObject({
      revision: 1,
      previousDigest: null,
      objective: "Ship a usable harness.",
      nextAction: { id: "continue", text: "Implement the workspace." },
    });

    const shownOutput = capture();
    expect(await main(["goal", "show"], shownOutput.io, { cwd: project })).toBe(0);
    expect(JSON.parse(shownOutput.stdout.join("\n"))).toEqual(initialized);

    const updatedOutput = capture();
    expect(
      await main(
        [
          "goal",
          "update",
          updatePath,
          "--expected-revision",
          "1",
          "--expected-digest",
          initialized.digest,
        ],
        updatedOutput.io,
        { cwd: project },
      ),
      updatedOutput.stderr.join("\n"),
    ).toBe(0);
    const updated = JSON.parse(updatedOutput.stdout.join("\n"));
    expect(updated).toMatchObject({
      revision: 2,
      previousDigest: initialized.digest,
      nextAction: { id: "continue", text: "Review the workspace." },
    });

    const staleOutput = capture();
    expect(
      await main(
        [
          "goal",
          "update",
          updatePath,
          "--expected-revision",
          "1",
          "--expected-digest",
          initialized.digest,
        ],
        staleOutput.io,
        { cwd: project },
      ),
    ).toBe(1);
    expect(staleOutput.stderr.join("\n")).toBe("goal workspace revision changed");

    const historyOutput = capture();
    expect(
      await main(["goal", "history", "--after", "0", "--limit", "10"], historyOutput.io, {
        cwd: project,
      }),
    ).toBe(0);
    expect(
      JSON.parse(historyOutput.stdout.join("\n")).map(
        (item: { revision: number }) => item.revision,
      ),
    ).toEqual([1, 2]);

    const validationOutput = capture();
    expect(
      await main(["validate", workflowPath, "--goal-workspace"], validationOutput.io, {
        cwd: project,
      }),
      validationOutput.stderr.join("\n"),
    ).toBe(0);
    expect(validationOutput.stdout.join("\n")).toContain("goal workspaces: 1");

    await unlink(initialPath);
    await unlink(updatePath);
    let observedContext: NodeExecutionContext | undefined;
    const runOutput = capture();
    expect(
      await main(
        ["run", workflowPath, "--goal-workspace", "--run-id", "goal-workspace-run"],
        runOutput.io,
        {
          cwd: project,
          executor: agentExecutor((context) => {
            observedContext = context;
          }),
        },
      ),
      runOutput.stderr.join("\n"),
    ).toBe(0);
    expect(observedContext?.agentGoalWorkspace).toContain("Ship a usable harness.");
    expect(observedContext?.agentGoalWorkspace).toContain("Review the workspace.");
    expect(JSON.parse(runOutput.stdout.join("\n"))).toMatchObject({
      status: "succeeded",
      capabilitySnapshot: {
        goalWorkspace: { revision: 2, digest: updated.digest },
      },
    });
  });
});

function agentExecutor(observe: (context: NodeExecutionContext) => void): NodeExecutor {
  return {
    async execute(_node, context) {
      observe(context);
      const text = JSON.stringify("done");
      return {
        status: "succeeded",
        evidence: {
          kind: "agent",
          provider: "test",
          model: "deterministic",
          text,
          textHash: createHash("sha256").update(text).digest("hex"),
          textTruncated: false,
          durationMs: 1,
          policyDecisions: [],
          effectReceipts: [],
        },
      };
    },
  };
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

async function projectFixture(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "flow-goal-cli-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, ".flow"));
  await writeFile(
    join(project, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
  );
  return project;
}

function goalSource(objective: string, nextAction: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: GoalWorkspace
objective: ${JSON.stringify(objective)}
facts:
  - { id: durable-state, text: The workspace is revisioned. }
invariants:
  - { id: policy-authority, text: Flow policy remains authoritative. }
verifiedFacts: []
openQuestions:
  - { id: next-risk, text: Which risk remains? }
nextAction: { id: continue, text: ${JSON.stringify(nextAction)} }
`;
}

function workflowSource(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: goal-workspace-workflow }
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Continue the approved goal.
      model: { provider: test, id: deterministic }
      tools: [read]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
}
