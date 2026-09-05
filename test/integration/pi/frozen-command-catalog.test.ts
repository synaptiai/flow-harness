import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import { createFrozenVerificationAgentCommandAuthority } from "../../../src/application/frozen-issue-command.js";
import { normalizeAgentCommandAuthority } from "../../../src/domain/agent-command.js";
import { PolicyBroker } from "../../../src/domain/policy/broker.js";
import { AgentCommandRecorder } from "../../../src/infrastructure/pi/agent-command-recorder.js";
import { AgentEffectRecorder } from "../../../src/infrastructure/pi/agent-effect-recorder.js";
import { EmbeddedPiAgentRunner } from "../../../src/infrastructure/pi/pi-agent-executor.js";

it("delivers frozen invocation metadata and timeout correction through the real Pi session", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "flow-command-catalog-")));
  try {
    const invocation = { executable: "python3", args: ["-m", "pytest"], timeoutMs: 300_000 };
    const faux = createFauxCore({
      provider: "flow-catalog-test",
      models: [{ id: "catalog-model", reasoning: false }],
    });
    const model = faux.getModel();
    if (model === undefined) throw new Error("provider fixture missing");
    let description: string | undefined;
    let refusal: unknown;
    faux.setResponses([
      (context) => {
        description = context.tools?.find((tool) => tool.name === "flow_exec")?.description;
        return fauxAssistantMessage(
          fauxToolCall(
            "flow_exec",
            { executable: "python3", args: ["-m", "pytest"] },
            { id: "wrong-timeout" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        refusal = context.messages.at(-1);
        return fauxAssistantMessage("Stopped without running an unapproved command.");
      },
    ]);
    const attribution = {
      runId: "catalog-run",
      workflowId: "catalog-workflow",
      nodeId: "implement",
      attempt: 1,
    };
    const policy = new PolicyBroker(attribution, ["process.execute"]);
    const commandRecorder = new AgentCommandRecorder(
      {
        executeAgentCommand: async () => {
          throw new Error("refused command reached executor");
        },
      },
      {
        prepare: async () => {
          throw new Error("refused command reached journal");
        },
      },
      { ...attribution, cwd, protectedPaths: [] },
    );
    const effectRecorder = new AgentEffectRecorder(attribution, {
      prepare: async () => {
        throw new Error("read-only tool selection reached effect journal");
      },
    });
    const runtime = {
      getModel: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => undefined,
      isUsingOAuth: () => false,
      streamSimple: faux.streamSimple,
    };
    const runner = new EmbeddedPiAgentRunner(async () => runtime as never, createAgentSession);
    const result = await runner.run({
      cwd,
      prompt: "Inspect the available verification command.",
      provider: model.provider,
      model: model.id,
      thinking: "off",
      tools: ["exec"],
      maxOutputBytes: 65_536,
      policyBroker: policy,
      protectedPaths: [],
      commandRecorder,
      effectRecorder,
      agentCommandAuthority: createFrozenVerificationAgentCommandAuthority([invocation]),
    });
    expect(result.stopReason).toBe("stop");
    expect(description).toContain(JSON.stringify(invocation));
    expect(description).not.toContain('"version"');
    expect(refusal).toMatchObject({
      role: "toolResult",
      toolCallId: "wrong-timeout",
      isError: true,
      content: [{ type: "text", text: expect.stringContaining(JSON.stringify(invocation)) }],
    });
    expect(policy.snapshot()).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("preserves the legacy provider-visible tool and system-prompt identity", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "flow-command-catalog-")));
  try {
    const catalog = createFrozenVerificationAgentCommandAuthority([
      { executable: "python3", args: ["-m", "pytest"], timeoutMs: 300_000 },
    ]);
    const legacy = normalizeAgentCommandAuthority(catalog.requestDigests);
    const faux = createFauxCore({
      provider: "flow-catalog-test",
      models: [{ id: "catalog-model", reasoning: false }],
    });
    const model = faux.getModel();
    if (model === undefined) throw new Error("provider fixture missing");
    const surfaces: unknown[] = [];
    const attribution = {
      runId: "catalog-run",
      workflowId: "catalog-workflow",
      nodeId: "implement",
      attempt: 1,
    };
    const runtime = {
      getModel: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => undefined,
      isUsingOAuth: () => false,
      streamSimple: faux.streamSimple,
    };
    const runner = new EmbeddedPiAgentRunner(async () => runtime as never, createAgentSession);
    for (const authority of [undefined, legacy, catalog]) {
      faux.setResponses([
        (context) => {
          surfaces.push({
            tools: context.tools?.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
            systemPrompt: context.systemPrompt,
          });
          return fauxAssistantMessage("Inspected command guidance.");
        },
      ]);
      const commandRecorder = new AgentCommandRecorder(
        {
          executeAgentCommand: async () => {
            throw new Error("metadata test must not execute");
          },
        },
        {
          prepare: async () => {
            throw new Error("metadata test must not prepare");
          },
        },
        { ...attribution, cwd, protectedPaths: [] },
      );
      const effectRecorder = new AgentEffectRecorder(attribution, {
        prepare: async () => {
          throw new Error("metadata test must not mutate");
        },
      });
      await runner.run({
        cwd,
        prompt: "Inspect the available tools.",
        provider: model.provider,
        model: model.id,
        thinking: "off",
        tools: ["exec"],
        maxOutputBytes: 65_536,
        policyBroker: new PolicyBroker(attribution, ["process.execute"]),
        protectedPaths: [],
        commandRecorder,
        effectRecorder,
        ...(authority === undefined ? {} : { agentCommandAuthority: authority }),
      });
    }
    expect(surfaces).toHaveLength(3);
    expect(surfaces[1]).toEqual(surfaces[0]);
    expect(surfaces[2]).not.toEqual(surfaces[0]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
