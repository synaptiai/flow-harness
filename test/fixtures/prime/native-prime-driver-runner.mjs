import { createInterface } from "node:readline";

import { runNativePrimeDriverProtocol } from "../../../dist/infrastructure/prime/native-prime-agent-evaluation-driver.js";

const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

await runNativePrimeDriverProtocol({
  lines: input[Symbol.asyncIterator](),
  writeLine: async (line) => {
    await writeLine(line);
  },
  createSession: async ({ infer }) => {
    let completed = false;
    return {
      prompt: async () => {
        const response = await infer('{"version":1,"context":{"messages":[]}}');
        if (response !== '{"message":"done"}') {
          throw new Error("fake inference response changed");
        }
        completed = true;
      },
      abort: async () => undefined,
      dispose: async () => undefined,
      subscribe: () => () => undefined,
      getSessionStats: () => ({
        sessionId: "compiled-prime-session",
        assistantMessages: 2,
        toolCalls: 1,
      }),
      lastAssistantMessage: () => (completed ? { stopReason: "stop" } : undefined),
    };
  },
});

input.close();

async function writeLine(line) {
  await new Promise((resolveWrite, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error === null || error === undefined) {
        resolveWrite();
      } else {
        reject(error);
      }
    });
  });
}
