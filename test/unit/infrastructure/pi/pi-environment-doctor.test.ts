import { describe, expect, it, vi } from "vitest";
import type { CompiledWorkflow } from "../../../../src/domain/workflow/types.js";
import {
  collectWorkflowEnvironmentRequirements,
  collectWorkflowModelRequirements,
  inspectPiProviderConfiguration,
} from "../../../../src/infrastructure/pi/pi-environment-doctor.js";

describe("Pi environment doctor", () => {
  it("collects and deduplicates agent, verifier, packaged-verifier, and child requirements", () => {
    const requirements = collectWorkflowModelRequirements(workflowWithModels());

    expect(requirements).toEqual([
      { provider: "anthropic", model: "claude-sonnet" },
      { provider: "openai", model: "gpt-5.4" },
      { provider: "openai", model: "gpt-5.6" },
    ]);
  });

  it("detects Linux-only agent commands recursively", () => {
    const workflow = workflowWithModels();
    const child = workflow.nodes.find((node) => node.type === "child");
    if (child?.type !== "child") {
      throw new Error("expected child workflow");
    }
    const childAgent = child.child.workflow.nodes[0];
    if (childAgent?.type !== "agent") {
      throw new Error("expected child agent");
    }
    const environment = collectWorkflowEnvironmentRequirements({
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.type === "child"
          ? {
              ...node,
              child: {
                ...node.child,
                workflow: {
                  ...node.child.workflow,
                  nodes: [{ ...childAgent, agent: { ...childAgent.agent, tools: ["exec"] } }],
                },
              },
            }
          : node,
      ),
    });

    expect(environment.requiresLinuxAgentCommands).toBe(true);
    expect(environment.modelRequirements).toEqual(collectWorkflowModelRequirements(workflow));
  });

  it("restores the local runtime with networking disabled and accepts configured exact models", async () => {
    const signal = new AbortController().signal;
    const runtime = {
      getModel: vi.fn((provider: string, model: string) =>
        provider === "anthropic" && model === "claude-sonnet" ? { provider, id: model } : undefined,
      ),
      hasConfiguredAuth: vi.fn((provider: string) => provider === "anthropic"),
    };
    const createRuntime = vi.fn(async () => runtime);

    await inspectPiProviderConfiguration(
      [{ provider: "anthropic", model: "claude-sonnet" }],
      signal,
      { createRuntime },
    );

    expect(createRuntime).toHaveBeenCalledWith({ allowModelNetwork: false, signal });
    expect(runtime.getModel).toHaveBeenCalledWith("anthropic", "claude-sonnet");
    expect(runtime.hasConfiguredAuth).toHaveBeenCalledWith("anthropic");
  });

  it.each([
    {
      label: "missing model",
      getModel: () => undefined,
      hasConfiguredAuth: (): boolean => true,
    },
    {
      label: "missing credentials",
      getModel: () => ({ provider: "anthropic", id: "claude-sonnet" }),
      hasConfiguredAuth: (): boolean => false,
    },
  ])("rejects a $label without exposing model or credential data", async (fixture) => {
    const privateProvider = "PRIVATE_PROVIDER";
    const privateModel = "PRIVATE_MODEL";

    await expect(
      inspectPiProviderConfiguration(
        [{ provider: privateProvider, model: privateModel }],
        new AbortController().signal,
        {
          createRuntime: async () => ({
            getModel: fixture.getModel,
            hasConfiguredAuth: fixture.hasConfiguredAuth,
          }),
        },
      ),
    ).rejects.toThrow("selected provider configuration is unavailable");

    await expect(
      inspectPiProviderConfiguration(
        [{ provider: privateProvider, model: privateModel }],
        new AbortController().signal,
        {
          createRuntime: async () => ({
            getModel: fixture.getModel,
            hasConfiguredAuth: fixture.hasConfiguredAuth,
          }),
        },
      ),
    ).rejects.not.toThrow(/PRIVATE/);
  });

  it("preserves exact cancellation after local runtime restoration", async () => {
    const cancellation = new Error("PRIVATE_CANCELLATION");
    const controller = new AbortController();

    await expect(
      inspectPiProviderConfiguration(
        [{ provider: "anthropic", model: "claude-sonnet" }],
        controller.signal,
        {
          createRuntime: async () => {
            controller.abort(cancellation);
            return {
              getModel: () => ({ provider: "anthropic", id: "claude-sonnet" }),
              hasConfiguredAuth: () => true,
            };
          },
        },
      ),
    ).rejects.toBe(cancellation);
  });
});

function workflowWithModels(): CompiledWorkflow {
  const child: CompiledWorkflow = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "child",
    nodes: [
      {
        id: "child-agent",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt: "work",
          model: { provider: "openai", id: "gpt-5.6", thinking: "low" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 10_000,
        },
      },
    ],
  };
  return {
    apiVersion: "flow.synapti.ai/v1alpha1",
    id: "parent",
    nodes: [
      {
        id: "agent",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt: "work",
          model: { provider: "anthropic", id: "claude-sonnet", thinking: "low" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 10_000,
        },
      },
      {
        id: "verifier",
        type: "verifier",
        dependsOn: ["agent"],
        verifier: {
          kind: "model",
          prompt: "verify",
          evidence: [],
          model: { provider: "openai", id: "gpt-5.4", thinking: "off" },
          timeoutMs: 10_000,
        },
      },
      {
        id: "packaged-verifier",
        type: "verifier",
        dependsOn: ["verifier"],
        verifier: {
          kind: "packaged-model",
          package: { name: "review", version: "1.0.0" },
          evidence: [],
          model: { provider: "anthropic", id: "claude-sonnet", thinking: "off" },
          timeoutMs: 10_000,
        },
      },
      {
        id: "child",
        type: "child",
        dependsOn: ["packaged-verifier"],
        child: {
          workflow: child,
          workflowDigest: "a".repeat(64),
          resultNodeId: "child-agent",
          resultSchema: { type: "string", maxLength: 64 },
          resultSchemaDigest: "b".repeat(64),
        },
      },
    ],
  };
}
