import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/main.js";
import { main } from "../../src/cli/main.js";

const configuredPlan = process.env.FLOW_LIVE_ACP_QUALIFICATION_PLAN;

describe.skipIf(configuredPlan === undefined)("ACP production-agent qualification live", () => {
  it("qualifies two exactly admitted production agents through the public CLI", async () => {
    if (configuredPlan === undefined) {
      throw new Error("live ACP qualification plan is unavailable after test admission");
    }
    const planPath = await realpath(resolve(configuredPlan));
    const projectRoot = dirname(planPath);
    const evaluationsDirectory = await mkdtemp(join(tmpdir(), "flow-live-acp-qualification-"));
    const evaluationId = "live-acp-qualification";
    try {
      const validation = captureIo();
      expect(
        await main(["eval", "validate", planPath], validation.io, { cwd: projectRoot }),
        validation.stderr.join("\n"),
      ).toBe(0);
      expect(JSON.parse(validation.stdout.join("\n"))).toMatchObject({
        valid: true,
        purpose: "acp-interoperability-v1",
      });

      const execution = captureIo();
      expect(
        await main(
          [
            "eval",
            "run",
            planPath,
            "--evaluation-id",
            evaluationId,
            "--evaluations-dir",
            evaluationsDirectory,
          ],
          execution.io,
          { cwd: projectRoot },
        ),
        execution.stderr.join("\n"),
      ).toBe(0);
      const evidence = JSON.parse(execution.stdout.join("\n"));
      expect(evidence.report.qualification).toMatchObject({
        purpose: "acp-interoperability-v1",
        verdict: "qualified",
      });
      const profileReports = Object.values(
        evidence.report.qualification.profiles as Record<
          string,
          { readonly executor: { readonly agentDigest: string } }
        >,
      );
      expect(profileReports).toHaveLength(2);
      expect(new Set(profileReports.map((profile) => profile.executor.agentDigest)).size).toBe(2);
      expect(evidence.report.qualification.limitations).toEqual([]);
    } finally {
      await rm(evaluationsDirectory, { recursive: true, force: true });
    }
  }, 600_000);
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
