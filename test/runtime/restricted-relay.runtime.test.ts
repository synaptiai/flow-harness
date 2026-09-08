import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const relay = process.env.FLOW_TEST_RESTRICTED_RELAY;
const enabled = process.platform === "linux" && process.arch === "x64" && relay !== undefined;

function normalExitFailure(error: unknown) {
  // Spawn errors, timeouts, signals, and output overflow are not admission.
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "number" ||
    !("signal" in error) ||
    error.signal !== null ||
    !("killed" in error) ||
    error.killed !== false ||
    !("stdout" in error) ||
    !("stderr" in error)
  )
    throw error;
  return { code: error.code, stdout: error.stdout, stderr: error.stderr };
}

it("retains an actual normal nonzero exit without treating every error as uncertain", async () => {
  const result = await execFile(
    process.execPath,
    [
      "-e",
      "process.stderr.write('FLOW_RELAY_PROFILE_V1 invalid_arguments\\n'); process.exitCode = 64;",
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 32_768,
    },
  ).then(() => {
    throw new Error("Expected normal status 64");
  }, normalExitFailure);
  expect(result).toEqual({
    code: 64,
    stdout: "",
    stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
  });
});

it("rejects an actual parent-requested termination despite a matching numeric exit", async (context) => {
  const operation = execFile(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM', () => process.exit(64));",
        "process.stderr.write('FLOW_RELAY_PROFILE_V1 invalid_arguments\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    { env: { PATH: "/usr/bin:/bin" }, timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 32_768 },
  );
  // This fixed control has one direct child and creates no descendants. Join it
  // even if readiness, signal delivery, or the assertion fails.
  const outcome = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const child = operation.child;
  try {
    if (child.stderr === null) throw new Error("Missing control error stream");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(2_000)]);
    const [ready] = await once(child.stderr, "data", { signal });
    expect(ready.toString()).toBe("FLOW_RELAY_PROFILE_V1 invalid_arguments\n");
    expect(child.kill("SIGTERM")).toBe(true);
    const result = await outcome;
    if (!("error" in result)) throw new Error("Expected the real control to exit with status 64");
    expect(result.error).toMatchObject({
      code: 64,
      signal: null,
      killed: true,
      stdout: "",
      stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
    });
    expect(() => normalExitFailure(result.error)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await outcome;
  }
});

describe.skipIf(!enabled)("restricted host-relay argument admission", () => {
  it("rejects the general version option before entering upstream socat", async () => {
    if (relay === undefined) throw new Error("Explicit relay artifact required");
    const result = await execFile(relay, ["-V"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 32_768,
    }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), normalExitFailure);
    expect(result).toEqual({
      code: 64,
      stdout: "",
      stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
    });
  });
});
