import type { Stream } from "@agentclientprotocol/sdk";
import { agent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import type { AcpAgentRuntimeSnapshot } from "../../../../src/domain/capability/acp-agent.js";
import { runAcpAgentSession } from "../../../../src/infrastructure/acp/acp-agent-session.js";
import { acpAgentCapabilitySnapshot } from "../../../fixtures/acp-agent.js";

describe("ACP agent session", () => {
  it("applies exact ordered configuration and records provider-neutral output usage", async () => {
    const transport = linkedStreams();
    const observed: Array<{ readonly method: string; readonly params: unknown }> = [];
    let model = "fallback-model";
    let thinking = "low";
    const connection = agent({ name: "fixture-agent" })
      .onRequest(methods.agent.initialize, ({ params }) => {
        observed.push({ method: "initialize", params });
        return { protocolVersion: PROTOCOL_VERSION };
      })
      .onRequest(methods.agent.session.new, ({ params }) => {
        observed.push({ method: "session/new", params });
        return { sessionId: "session-private", configOptions: configOptions(model, thinking) };
      })
      .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        observed.push({ method: "session/set_config_option", params });
        if (params.configId === "model") model = String(params.value);
        if (params.configId === "thinking") thinking = String(params.value);
        return { configOptions: configOptions(model, thinking) };
      })
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        observed.push({ method: "session/prompt", params });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from ACP" },
          },
        });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 24,
            size: 128_000,
            cost: { amount: 0.012345, currency: "USD" },
          },
        });
        return {
          stopReason: "end_turn",
          usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 },
        };
      })
      .connect(transport.agent);

    const result = await runAcpAgentSession(transport.client, {
      snapshot: snapshot({ modelTokens: "complete", costUsd: "complete" }),
      provider: "openai",
      model: "gpt-5.6-codex",
      thinking: "high",
      cwd: "/private/attempt",
      prompt: "Flow authority capsule\n\nComplete the task.",
      maxOutputBytes: 65_536,
    });

    expect(result).toEqual({
      sessionId: "session-private",
      text: "hello from ACP",
      stopReason: "end_turn",
      usageObservation: {
        modelTokens: { status: "complete", totalTokens: 42 },
        costUsd: { status: "complete", costUsdMicros: 12_345 },
      },
      usageProvenance: {
        modelTokens: "prompt-response",
        costUsd: "session-usage-update",
      },
      updateCount: 2,
    });
    expect(observed).toEqual([
      {
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
          },
          clientInfo: { name: "flow-harness", version: "1" },
        },
      },
      {
        method: "session/new",
        params: { cwd: "/private/attempt", mcpServers: [] },
      },
      {
        method: "session/set_config_option",
        params: { sessionId: "session-private", configId: "model", value: "gpt-5.6-codex" },
      },
      {
        method: "session/set_config_option",
        params: { sessionId: "session-private", configId: "thinking", value: "high" },
      },
      {
        method: "session/prompt",
        params: {
          sessionId: "session-private",
          prompt: [{ type: "text", text: "Flow authority capsule\n\nComplete the task." }],
        },
      },
    ]);
    connection.close();
  });

  it("rejects an agent that does not retain an exact configuration assignment", async () => {
    const transport = linkedStreams();
    const connection = configurationAgent(transport.agent, {
      setConfig: (model, thinking) =>
        configOptions(model === "fallback-model" ? model : "drift", thinking),
    });

    await expect(runAcpAgentSession(transport.client, baseRequest())).rejects.toMatchObject({
      code: "configuration_drift",
    });
    connection.close();
  });

  it("classifies tool activity as denied authority and returns no tool payload", async () => {
    const transport = linkedStreams();
    const connection = configurationAgent(transport.agent, {
      prompt: async (params, client) => {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "PRIVATE_TOOL_ID",
            title: "PRIVATE_TOOL_TITLE",
          },
        });
        return { stopReason: "end_turn" };
      },
    });

    const error = await runAcpAgentSession(transport.client, baseRequest()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "authority_violation", authorityCategory: "tool" });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_TOOL_ID");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_TOOL_TITLE");
    connection.close();
  });

  it("returns explicit cancellation for a permission request and fails the session", async () => {
    const transport = linkedStreams();
    let permissionOutcome: unknown;
    const connection = configurationAgent(transport.agent, {
      prompt: async (params, client) => {
        permissionOutcome = await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-private" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        return { stopReason: "end_turn" };
      },
    });

    await expect(runAcpAgentSession(transport.client, baseRequest())).rejects.toMatchObject({
      code: "authority_violation",
      authorityCategory: "permission",
    });
    expect(permissionOutcome).toEqual({ outcome: { outcome: "cancelled" } });
    connection.close();
  });
});

function baseRequest() {
  return {
    snapshot: snapshot({ modelTokens: "unavailable", costUsd: "unavailable" }),
    provider: "openai",
    model: "gpt-5.6-codex",
    thinking: "high" as const,
    cwd: "/private/attempt",
    prompt: "Complete the task.",
    maxOutputBytes: 65_536,
  };
}

function configurationAgent(
  stream: Stream,
  options: {
    readonly setConfig?: (model: string, thinking: string) => ReturnType<typeof configOptions>;
    readonly prompt?: (
      params: { readonly sessionId: string },
      client: {
        notify(method: string, params: unknown): Promise<void>;
        request(method: string, params: unknown): Promise<unknown>;
      },
    ) => Promise<{ readonly stopReason: "end_turn" }>;
  } = {},
) {
  let model = "fallback-model";
  let thinking = "low";
  return agent({ name: "fixture-agent" })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: "session-private",
      configOptions: configOptions(model, thinking),
    }))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (params.configId === "model") model = String(params.value);
      if (params.configId === "thinking") thinking = String(params.value);
      return {
        configOptions: options.setConfig?.(model, thinking) ?? configOptions(model, thinking),
      };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) =>
      options.prompt === undefined
        ? { stopReason: "end_turn" }
        : await options.prompt(params, client),
    )
    .connect(stream);
}

function configOptions(model: string, thinking: string) {
  return [
    {
      id: "model",
      name: "Model",
      type: "select" as const,
      currentValue: model,
      options: [
        { value: "fallback-model", name: "Fallback" },
        { value: "gpt-5.6-codex", name: "GPT 5.6 Codex" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      type: "select" as const,
      currentValue: thinking,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function snapshot(usage: AcpAgentRuntimeSnapshot["usage"]): AcpAgentRuntimeSnapshot {
  const value = acpAgentCapabilitySnapshot("a", usage).acpAgent;
  if (value === undefined) throw new Error("missing ACP agent fixture");
  return value;
}

function linkedStreams(): { readonly client: Stream; readonly agent: Stream } {
  const clientToAgent = new TransformStream();
  const agentToClient = new TransformStream();
  return {
    client: { writable: clientToAgent.writable, readable: agentToClient.readable },
    agent: { writable: agentToClient.writable, readable: clientToAgent.readable },
  };
}
