import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!linux)("real native Prime Agent evaluation", () => {
  it("keeps one persistent IPython kernel across two tool calls", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Use IPython twice. Keep state. Write the final value to RESULT.md.\n",
      responses: [
        primeAssistantToolCall("call-prime-1", "counter = 40\ncounter", 1),
        primeAssistantToolCall(
          "call-prime-2",
          [
            "counter += 2",
            "from pathlib import Path",
            'Path("RESULT.md").write_text(str(counter), encoding="utf-8")',
            "counter",
          ].join("\n"),
          2,
        ),
        primeAssistantText("The task is complete.", 3),
      ],
    });
    try {
      expect(await readFile(`${session.workspace}/RESULT.md`, "utf8")).toBe("42");
      expect(session.hostRequests).toHaveLength(3);
      expect(session.hostRequests[1]).toContain("40");
      expect(session.hostRequests[2]).toContain("42");
      expect(session.checkpoints).toEqual(["terminal", "exported"]);
      expect(session.evidence.harness).toEqual({
        outcome: "completed",
        runId: expect.any(String),
        reason: null,
      });
      expect(session.evidence.settlement).toEqual({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        kernelRequests: 1,
      });
      expect(session.evidence.finishMetrics({ startedAtMs: 1, endedAtMs: 2 })).toMatchObject({
        turns: 3,
        toolCalls: 2,
        toolErrors: 0,
        wallTimeMs: 1,
      });
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
