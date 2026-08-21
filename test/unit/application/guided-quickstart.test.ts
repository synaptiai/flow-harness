import { describe, expect, it, vi } from "vitest";

import {
  GuidedQuickstartError,
  type GuidedQuickstartPorts,
  runGuidedQuickstart,
} from "../../../src/application/guided-quickstart.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";

describe("guided quick start", () => {
  it("publishes and runs the credential-free workflow in the fixed phase order", async () => {
    const phases: string[] = [];
    const ports = createPorts(phases);

    const result = await runGuidedQuickstart(
      {
        directory: "/workspace/project",
        mode: { kind: "foundation" },
        runId: "quickstart-foundation",
      },
      ports,
    );

    expect(phases).toEqual(["prepare:foundation", "publish", "execute"]);
    expect(ports.validateProvider).not.toHaveBeenCalled();
    expect(result).toEqual({
      version: 1,
      mode: "foundation",
      project: { publication: "created" },
      run: {
        id: "quickstart-foundation",
        status: "succeeded",
        evidence: ".flow/runs/quickstart-foundation/events.jsonl",
      },
      commands: {
        inspect: ["flow", "inspect", "quickstart-foundation"],
        browser: ["flow", "web", "quickstart-foundation", "--actor", "operator:quickstart"],
      },
    });
  });

  it("validates the exact selected provider and model before execution", async () => {
    const phases: string[] = [];
    const ports = createPorts(phases);

    await runGuidedQuickstart(
      {
        directory: "/workspace/project",
        mode: { kind: "provider", provider: "anthropic", model: "claude-sonnet-4-6" },
        runId: "quickstart-provider",
      },
      ports,
    );

    expect(phases).toEqual([
      "prepare:provider",
      "publish",
      "provider:anthropic/claude-sonnet-4-6",
      "execute",
    ]);
    expect(ports.executeWorkflow).toHaveBeenCalledOnce();
  });

  it("publishes and validates the explicit coding mode before execution", async () => {
    const phases: string[] = [];
    const ports = createPorts(phases);

    const result = await runGuidedQuickstart(
      {
        directory: "/workspace/project",
        mode: { kind: "coding", provider: "openai", model: "gpt-5.6-luna" },
        runId: "quickstart-coding",
      },
      ports,
    );

    expect(phases).toEqual([
      "prepare:coding",
      "publish",
      "provider:openai/gpt-5.6-luna",
      "execute",
    ]);
    expect(result).toEqual({
      version: 1,
      mode: "coding",
      project: { publication: "created", fixture: "FLOW_QUICKSTART.md" },
      run: {
        id: "quickstart-coding",
        status: "succeeded",
        evidence: ".flow/runs/quickstart-coding/events.jsonl",
      },
      commands: {
        inspect: ["flow", "inspect", "quickstart-coding"],
        browser: ["flow", "web", "quickstart-coding", "--actor", "operator:quickstart"],
      },
    });
  });

  it.each([
    { outcome: "already_exists" as const, code: "project_exists" },
    { outcome: "commit_uncertain" as const, code: "publication_uncertain" },
    { outcome: "settlement_uncertain" as const, code: "publication_uncertain" },
  ])("maps $outcome publication without entering execution", async ({ outcome, code }) => {
    const phases: string[] = [];
    const ports = createPorts(phases);
    vi.mocked(ports.publishProject).mockResolvedValue({ outcome });

    const failure = await runGuidedQuickstart(
      {
        directory: "/workspace/PRIVATE_PROJECT",
        mode: { kind: "foundation" },
        runId: "quickstart-foundation",
      },
      ports,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GuidedQuickstartError);
    expect(failure).toMatchObject({ code });
    expect((failure as Error).message).not.toContain("PRIVATE");
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it("preserves exact cancellation before project publication", async () => {
    const phases: string[] = [];
    const ports = createPorts(phases);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PREPUBLICATION_CANCELLATION");
    vi.mocked(ports.prepareWorkflow).mockImplementation(async () => {
      controller.abort(reason);
      throw new Error("PRIVATE_PREPARATION_FAILURE");
    });

    await expect(
      runGuidedQuickstart(
        {
          directory: "/workspace/project",
          mode: { kind: "foundation" },
          runId: "quickstart-foundation",
          signal: controller.signal,
        },
        ports,
      ),
    ).rejects.toBe(reason);
    expect(ports.publishProject).not.toHaveBeenCalled();
  });

  it("reports fixed cancellation after settled project publication and starts no later phase", async () => {
    const phases: string[] = [];
    const ports = createPorts(phases);
    const controller = new AbortController();
    vi.mocked(ports.publishProject).mockImplementation(async () => {
      phases.push("publish");
      controller.abort(new Error("PRIVATE_POSTPUBLICATION_CANCELLATION"));
      return { outcome: "published" as const, projectRoot: "/workspace/project" };
    });

    await expect(
      runGuidedQuickstart(
        {
          directory: "/workspace/project",
          mode: { kind: "provider", provider: "anthropic", model: "claude-sonnet-4-6" },
          runId: "quickstart-provider",
          signal: controller.signal,
        },
        ports,
      ),
    ).rejects.toMatchObject({
      code: "cancelled_after_publication",
      message:
        "Quick start stopped after project publication; inspect the project before retrying.",
    });
    expect(phases).toEqual(["prepare:provider", "publish"]);
    expect(ports.validateProvider).not.toHaveBeenCalled();
    expect(ports.executeWorkflow).not.toHaveBeenCalled();
  });

  it("offers inspection and browser presentation for an accepted failed run", async () => {
    const ports = createPorts([]);
    vi.mocked(ports.executeWorkflow).mockResolvedValue({ status: "failed" });

    const result = await runGuidedQuickstart(
      {
        directory: "/workspace/project",
        mode: { kind: "foundation" },
        runId: "failed-run",
      },
      ports,
    );

    expect(result.run).toMatchObject({ id: "failed-run", status: "failed" });
    expect(result.commands).toEqual({
      inspect: ["flow", "inspect", "failed-run"],
      browser: ["flow", "web", "failed-run", "--actor", "operator:quickstart"],
    });
  });

  it.each([
    { runId: "../PRIVATE", mode: { kind: "foundation" } as const },
    {
      runId: "quickstart-provider",
      mode: { kind: "provider", provider: "INVALID", model: "model" } as const,
    },
    {
      runId: "quickstart-provider",
      mode: { kind: "provider", provider: "provider", model: "" } as const,
    },
    {
      runId: "quickstart-coding",
      mode: { kind: "coding", provider: "google", model: "gemini-3.1-pro-preview" } as const,
    },
  ])("rejects invalid bounded input before calling a port", async (input) => {
    const ports = createPorts([]);

    await expect(
      runGuidedQuickstart({ directory: "/workspace/project", ...input }, ports),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(ports.prepareWorkflow).not.toHaveBeenCalled();
    expect(ports.publishProject).not.toHaveBeenCalled();
  });
});

function createPorts(phases: string[]): GuidedQuickstartPorts {
  const workflow = compileWorkflowText(
    `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: quickstart-test }
nodes:
  - id: verify
    type: command
    command: { executable: node, args: [--version] }
`,
    "quickstart-test.workflow.yaml",
  );
  return {
    prepareWorkflow: vi.fn(async (mode) => {
      phases.push(`prepare:${mode.kind}`);
      return workflow;
    }),
    publishProject: vi.fn(async () => {
      phases.push("publish");
      return { outcome: "published" as const, projectRoot: "/workspace/project" };
    }),
    validateProvider: vi.fn(async ({ provider, model }) => {
      phases.push(`provider:${provider}/${model}`);
    }),
    executeWorkflow: vi.fn(async () => {
      phases.push("execute");
      return { status: "succeeded" as const };
    }),
  };
}
