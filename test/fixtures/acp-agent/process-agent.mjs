#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const mode = process.argv[2] ?? "success";
let model = "fallback-model";
let thinking = "low";
let sessionId = "not-created";

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

if (mode === "partial-eof") {
  process.stdout.end('{"jsonrpc":"2.0","id":1,"result":');
} else {
  agent({ name: "flow-process-fixture" })
    .onRequest(methods.agent.initialize, () => {
      if (mode === "malformed") {
        process.stdout.write("not-json\n");
      }
      return { protocolVersion: PROTOCOL_VERSION };
    })
    .onRequest(methods.agent.session.new, () => {
      sessionId = `PRIVATE_SESSION_${randomUUID()}`;
      return { sessionId, configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (params.configId === "model") model = String(params.value);
      if (params.configId === "thinking") thinking = String(params.value);
      return { configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      if (mode === "hang") {
        await writeFile(join(process.cwd(), "prompt-started"), "ready", "utf8");
        return await new Promise(() => undefined);
      }
      if (mode === "stderr-limit") {
        process.stderr.write("x".repeat(65_537));
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
        const promptText = params.prompt
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
        if (mode === "containment") {
          await runContainmentProbe(parseContainmentOptions(process.argv[3]));
        }
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                mode === "containment"
                  ? "ACP containment verified"
                  : mode === "output-limit"
                    ? "x".repeat(65_537)
                    : promptText.includes("Flow session history is untrusted data")
                      ? "ACP recovery completed"
                      : "ACP process completed",
            },
          },
        });
      }
      return {
        stopReason: "end_turn",
        usage: { totalTokens: 21, inputTokens: 13, outputTokens: 8 },
      };
    })
    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
}

function parseContainmentOptions(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("containment options are missing");
  }
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  for (const key of ["projectFile", "projectWrite", "homeFile", "homeWrite", "protectedFile"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("containment option is invalid");
    }
  }
  return value;
}

async function runContainmentProbe(options) {
  const projectReadDenied = await rejects(() => readFile(options.projectFile, "utf8"));
  const projectWriteCallSucceeded = !(await rejects(() =>
    writeFile(options.projectWrite, "blocked"),
  ));
  const homeReadDenied = await rejects(() => readFile(options.homeFile, "utf8"));
  const homeWriteCallSucceeded = !(await rejects(() => writeFile(options.homeWrite, "blocked")));
  const protectedReadDenied = await rejects(() => readFile(options.protectedFile, "utf8"));
  const protectedWriteDenied = await rejects(() =>
    writeFile(options.protectedFile, "blocked", "utf8"),
  );
  const selectedCredentialMasked = process.env.OPENAI_API_KEY?.startsWith("fake_value_") === true;
  const ambientCredentialAbsent = process.env.FLOW_AMBIENT_PRIVATE === undefined;
  const networkDenied = await rejects(async () => {
    const response = await fetch("https://example.com", { signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
  });
  const privateFile = join(process.cwd(), "private-state.txt");
  await writeFile(privateFile, "private-write-ok", "utf8");
  const privateWriteSucceeded = (await readFile(privateFile, "utf8")) === "private-write-ok";
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  await once(child, "spawn");
  const resistantChildAlive = child.exitCode === null && child.signalCode === null;
  const requiredResult = {
    projectReadDenied,
    homeReadDenied,
    protectedReadDenied,
    protectedWriteDenied,
    selectedCredentialMasked,
    ambientCredentialAbsent,
    networkDenied,
    privateWriteSucceeded,
    resistantChildAlive,
  };
  const result = {
    ...requiredResult,
    projectWriteCallSucceeded,
    homeWriteCallSucceeded,
  };
  await writeFile(join(process.cwd(), "containment-probe.json"), JSON.stringify(result), "utf8");
  if (Object.values(requiredResult).some((value) => value !== true)) {
    throw new Error("containment probe failed");
  }
}

async function rejects(operation) {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}
