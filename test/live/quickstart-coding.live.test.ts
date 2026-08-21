import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/main.js";
import { main } from "../../src/cli/main.js";
import {
  QUICKSTART_CODING_EXPECTED_SOURCE,
  QUICKSTART_CODING_FIXTURE_PATH,
} from "../../src/infrastructure/fs/flow-config-store.js";
import { hasConfiguredLivePiModel } from "../fixtures/live-pi.js";

const provider = process.env.FLOW_LIVE_PI_PROVIDER;
const model = process.env.FLOW_LIVE_PI_MODEL;

describe.skipIf(provider === undefined || model === undefined)("coding quick start live", () => {
  it("completes the bounded coding workflow through a real provider", async ({ skip }) => {
    if (provider === undefined || model === undefined) {
      throw new Error("live coding provider settings are unavailable after test admission");
    }
    if (provider !== "anthropic" && provider !== "openai") {
      throw new Error("live coding quick start requires the anthropic or openai provider");
    }
    if (!(await hasConfiguredLivePiModel(provider, model))) {
      skip(`live provider "${provider}" has no configured authentication`);
      return;
    }

    const project = await mkdtemp(join(tmpdir(), "flow-live-coding-quickstart-"));
    try {
      const quickstart = captureIo();
      const exitCode = await main(
        [
          "quickstart",
          project,
          "--coding",
          "--provider",
          provider,
          "--model",
          model,
          "--run-id",
          "live-coding-quickstart",
        ],
        quickstart.io,
        { cwd: project },
      );

      expect(exitCode, quickstart.stderr.join("\n")).toBe(0);
      await expect(readFile(join(project, QUICKSTART_CODING_FIXTURE_PATH), "utf8")).resolves.toBe(
        QUICKSTART_CODING_EXPECTED_SOURCE,
      );

      const inspect = captureIo();
      expect(await main(["inspect", "live-coding-quickstart"], inspect.io, { cwd: project })).toBe(
        0,
      );
      expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
        status: "succeeded",
        goal: {
          status: "accepted",
          criteria: { "fixture-is-exact": { status: "accepted" } },
        },
        nodes: {
          implement: {
            evidence: {
              kind: "agent",
              provider,
              model,
              effectReceipts: [
                expect.objectContaining({ kind: "filesystem.edit", outcome: "committed" }),
              ],
            },
          },
          verify: {
            evidence: { kind: "verifier", driver: "command", verdict: "accepted" },
          },
        },
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);
});

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}
