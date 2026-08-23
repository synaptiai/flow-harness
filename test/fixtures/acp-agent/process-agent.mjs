#!/usr/bin/env node
import { Readable, Writable } from "node:stream";

import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const mode = process.argv[2] ?? "success";
let model = "fallback-model";
let thinking = "low";

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: model,
    options: [
      { value: "fallback-model", name: "Fallback" },
      { value: "gpt-5.6-codex", name: "Selected" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    type: "select",
    currentValue: thinking,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

agent({ name: "flow-process-fixture" })
  .onRequest(methods.agent.initialize, () => {
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
    }
    return { protocolVersion: PROTOCOL_VERSION };
  })
  .onRequest(methods.agent.session.new, () => ({
    sessionId: "PRIVATE_SESSION_ID",
    configOptions: configOptions(),
  }))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (params.configId === "model") model = String(params.value);
    if (params.configId === "thinking") thinking = String(params.value);
    return { configOptions: configOptions() };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (mode === "hang") {
      return await new Promise(() => undefined);
    }
    if (mode === "tool") {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "PRIVATE_TOOL_ID",
          title: "Private tool",
        },
      });
    } else {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ACP process completed" },
        },
      });
    }
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 21, inputTokens: 13, outputTokens: 8 },
    };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
