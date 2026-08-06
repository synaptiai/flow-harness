import { describe, expect, it } from "vitest";

import type { CompiledAgentNode } from "../../src/domain/workflow/types.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe("PiAgentExecutor live", () => {
  it("executes a real provider-backed node through the embedded Pi session", async () => {
    if (provider === undefined || model === undefined) {
      throw new Error("FLOW_LIVE_PI_PROVIDER and FLOW_LIVE_PI_MODEL are required");
    }

    const node: CompiledAgentNode = {
      id: "live-agent",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Reply with exactly FLOW_LIVE_OK and do not call tools.",
        model: { provider, id: model, thinking: "off" },
        tools: [],
        timeoutMs: 120_000,
      },
    };

    const outcome = await new PiAgentExecutor().execute(node, {
      runId: "live-pi-run",
      workflowId: "live-pi-workflow",
      attempt: 1,
      cwd: process.cwd(),
    });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded" && outcome.evidence.kind === "agent") {
      expect(outcome.evidence.text).toContain("FLOW_LIVE_OK");
    }
  });
});
