import { describe, expect, it } from "vitest";

import type { CompiledAgentNode } from "../../src/domain/workflow/types.js";
import { PiAgentExecutor } from "../../src/infrastructure/pi/pi-agent-executor.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)("PiAgentExecutor live", () => {
  it("executes a real provider-backed node through the embedded Pi session", async ({ skip }) => {
    if (provider === undefined || model === undefined) {
      throw new Error("live provider settings are unavailable after test admission");
    }
    if (!(await hasConfiguredLivePiModel(provider, model))) {
      skip(`live provider "${provider}" has no configured authentication`);
      return;
    }

    const node: CompiledAgentNode = {
      id: "live-agent",
      type: "agent",
      dependsOn: [],
      agent: {
        prompt: "Reply with exactly FLOW_LIVE_OK and do not call tools.",
        model: { provider, id: model, thinking: "off" },
        tools: [],
        skills: [],
        toolPackages: [],
        timeoutMs: 120_000,
      },
    };

    const outcome = await new PiAgentExecutor().execute(node, {
      runId: "live-pi-run",
      workflowId: "live-pi-workflow",
      attempt: 1,
      cwd: process.cwd(),
      protectedPaths: [],
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      evidence: {
        kind: "agent",
        provider,
        model,
        text: expect.stringContaining("FLOW_LIVE_OK"),
      },
    });
    if (outcome.status !== "succeeded" || outcome.evidence.kind !== "agent") {
      throw new Error(`expected successful agent evidence, received ${JSON.stringify(outcome)}`);
    }
  });
});
