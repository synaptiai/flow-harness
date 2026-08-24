import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";

const temporaryDirectories: string[] = [];
const digest = (value: string): string => value.repeat(64).slice(0, 64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Lean proof qualification CLI", () => {
  it("qualifies a closed input document and exports the content-free report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-proof-qualification-"));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, "qualification.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, `${JSON.stringify(qualificationInput())}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const captured = capture();

    expect(
      await main(["eval", "proof", "qualify", inputPath, "--output", outputPath], captured.io, {
        cwd: directory,
      }),
      captured.stderr.join("\n"),
    ).toBe(0);

    const report = JSON.parse(captured.stdout.join("\n"));
    expect(report).toMatchObject({
      kind: "lean-proof-qualification-report-v1",
      verdict: "qualified",
      coverage: { tasks: 1, proofAccepted: 1, ordinaryTestsPassed: 1 },
      taskResults: [
        expect.objectContaining({
          specificationDigest: digest("1"),
          statementDigest: digest("2"),
          ordinaryTestSuiteDigest: digest("9"),
        }),
      ],
    });
    expect(report.qualificationInputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
  });

  it("fails closed on malformed or oversized input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-proof-qualification-invalid-"));
    temporaryDirectories.push(directory);
    const malformedPath = join(directory, "malformed.json");
    const oversizedPath = join(directory, "oversized.json");
    await writeFile(malformedPath, '{"kind":', "utf8");
    await writeFile(oversizedPath, "x".repeat(1_048_577), "utf8");

    const malformed = capture();
    expect(await main(["eval", "proof", "qualify", malformedPath], malformed.io)).toBe(1);
    expect(malformed.stderr.join("\n")).toMatch(/valid JSON/i);

    const oversized = capture();
    expect(await main(["eval", "proof", "qualify", oversizedPath], oversized.io)).toBe(1);
    expect(oversized.stderr.join("\n")).toMatch(/1048576 UTF-8 bytes/i);
  });
});

function qualificationInput() {
  const runtime = {
    version: 1,
    platform: "linux",
    architecture: "x64",
    imageDigest: `sha256:${digest("a")}`,
    buildAttestationDigest: digest("b"),
    dependencyManifestDigest: digest("c"),
    leanVersion: "4.33.1",
    mathlibRevision: digest("d"),
    safeVerifyRevision: digest("e"),
    nanodaRevision: digest("f"),
    profileDigest: digest("0"),
  };
  return {
    version: 1,
    kind: "lean-proof-qualification-v1",
    qualificationId: "proof-profile-release",
    profile: { profileDigest: runtime.profileDigest, runtime },
    tasks: [
      {
        id: "addition-identity",
        requestDigest: digest("3"),
        specificationDigest: digest("1"),
        statementDigest: digest("2"),
      },
    ],
    trials: [
      {
        taskId: "addition-identity",
        requestDigest: digest("3"),
        runtime,
        proof: {
          verdict: "accepted",
          reasonCode: "proof_accepted",
          compiler: "accepted",
          safeVerify: "accepted",
          nanoda: "accepted",
        },
        faithfulness: {
          authority: "human",
          status: "approved",
          specificationDigest: digest("1"),
          statementDigest: digest("2"),
        },
        ordinaryTests: { status: "passed", suiteDigest: digest("9") },
        costUsdMicros: 0,
        latencyMs: 100,
        policyFailures: [],
        cleanup: "confirmed",
      },
    ],
  };
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}
