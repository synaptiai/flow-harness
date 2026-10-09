import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  type PinnedGitHubIssueHostExecutable,
  pinGitHubIssueHostExecutable,
} from "../../../../src/infrastructure/git/fixed-host-executables.js";
import {
  MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES,
  MAX_STRICT_HOST_PROCESS_TIMEOUT_MS,
  StrictHostProcess,
} from "../../../../src/infrastructure/git/strict-host-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("StrictHostProcess", () => {
  it("runs one fixed executable with literal arguments and an exact environment", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(
      root,
      "literal-arguments",
      `process.stdout.write(JSON.stringify({
        args: process.argv.slice(2),
        allowed: process.env.FLOW_ALLOWED,
        inherited: process.env.FLOW_AMBIENT_SECRET ?? null,
      }));`,
    );
    process.env.FLOW_AMBIENT_SECRET = "must-not-cross-the-boundary";
    const processRunner = await strictProcess(executable, { FLOW_ALLOWED: "yes" });

    try {
      const result = await processRunner.run({
        arguments: ["$HOME", "$(touch should-not-run)", "; echo no"],
        cwd: root,
      });

      expect(result).toMatchObject({
        termination: "exit",
        exitCode: 0,
        signal: null,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
        args: ["$HOME", "$(touch should-not-run)", "; echo no"],
        allowed: "yes",
        inherited: null,
      });
    } finally {
      delete process.env.FLOW_AMBIENT_SECRET;
    }
  });

  it("preserves bounded stdout and stderr evidence for a nonzero exit", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(
      root,
      "nonzero",
      'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 23;',
    );

    const result = await (await strictProcess(executable)).run({ arguments: [], cwd: root });

    expect(result).toMatchObject({
      termination: "exit",
      exitCode: 23,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(result.stdout.toString("utf8")).toBe("out");
    expect(result.stderr.toString("utf8")).toBe("err");
  });

  it.runIf(process.platform !== "win32")(
    "classifies an unrequested terminating signal",
    async () => {
      const root = await temporaryDirectory("flow-strict-host-process-");
      const executable = await writeNodeExecutable(
        root,
        "signal",
        'process.stdout.write("before-signal"); process.kill(process.pid, "SIGTERM");',
      );

      const result = await (await strictProcess(executable)).run({ arguments: [], cwd: root });

      expect(result).toMatchObject({
        termination: "signal",
        exitCode: null,
        signal: "SIGTERM",
      });
      expect(result.stdout.toString("utf8")).toBe("before-signal");
    },
  );

  it("classifies timeout and terminates the process", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(root, "timeout", "setInterval(() => {}, 1000);");
    const processRunner = await strictProcess(executable, {}, 20);

    const result = await processRunner.run({ arguments: [], cwd: root });

    expect(result).toMatchObject({ termination: "timeout", exitCode: null });
  });

  it("classifies an in-flight abort without exposing the abort reason", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(root, "abort", "setInterval(() => {}, 1000);");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("secret abort reason")), 20).unref();

    const result = await (await strictProcess(executable)).run({
      arguments: [],
      cwd: root,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ termination: "abort", exitCode: null });
    expect(JSON.stringify(result)).not.toContain("secret abort reason");
  });

  it("does not launch when the signal is already aborted", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const marker = join(root, "launched");
    const executable = await writeNodeExecutable(
      root,
      "pre-abort",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
    );
    const controller = new AbortController();
    controller.abort(new Error("secret abort reason"));

    const result = await (await strictProcess(executable)).run({
      arguments: [],
      cwd: root,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ termination: "abort", durationMs: 0 });
    await expect(import("node:fs/promises").then(({ stat }) => stat(marker))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("does not launch when the caller aborts during executable revalidation", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const marker = join(root, "launched-during-admission");
    const executable = await writeNodeExecutable(
      root,
      "abort-during-admission",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`,
    );
    const processRunner = await strictProcess(executable);
    const controller = new AbortController();

    const pending = processRunner.run({ arguments: [], cwd: root, signal: controller.signal });
    controller.abort(new Error("secret abort reason"));
    const result = await pending;

    expect(result).toMatchObject({ termination: "abort", exitCode: null });
    await expect(import("node:fs/promises").then(({ stat }) => stat(marker))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it.each([
    ["stdout", "process.stdout.write('x'.repeat(4096));"],
    ["stderr", "process.stderr.write('x'.repeat(4096));"],
  ] as const)("bounds %s and classifies overflow", async (stream, body) => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(root, `${stream}-overflow`, body);
    const processRunner = new StrictHostProcess({
      executable: await pinExecutable(executable),
      environment: {},
      timeoutMs: 5_000,
      maxStdoutBytes: stream === "stdout" ? 1_024 : 4_096,
      maxStderrBytes: stream === "stderr" ? 1_024 : 4_096,
    });

    const result = await processRunner.run({ arguments: [], cwd: root });

    expect(result.termination).toBe("output_limit");
    expect(result[stream]).toHaveLength(1_024);
    expect(result[`${stream}Truncated`]).toBe(true);
  });

  it("classifies a missing fixed executable as a launch failure", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(root, "removed-after-pinning", "");
    const processRunner = await strictProcess(executable);
    await unlink(executable);

    const result = await processRunner.run({ arguments: [], cwd: root });

    expect(result).toMatchObject({
      termination: "launch_error",
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  });

  it("accepts output that exactly equals each configured limit", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(
      root,
      "exact-output-limits",
      'process.stdout.write("o".repeat(1024)); process.stderr.write("e".repeat(1024));',
    );
    const processRunner = new StrictHostProcess({
      executable: await pinExecutable(executable),
      environment: {},
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    const result = await processRunner.run({ arguments: [], cwd: root });

    expect(result).toMatchObject({
      termination: "exit",
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(result.stdout).toHaveLength(1_024);
    expect(result.stderr).toHaveLength(1_024);
  });

  it("rejects invalid executable, argument, environment, timeout, and output bounds", async () => {
    const root = await temporaryDirectory("flow-strict-host-process-");
    const executable = await writeNodeExecutable(root, "validation", "");
    const pinned = await pinExecutable(executable);
    expect(
      () =>
        new StrictHostProcess({
          executable: { ...pinned, path: "git" },
          environment: {},
          timeoutMs: 1,
          maxStdoutBytes: 1,
          maxStderrBytes: 1,
        }),
    ).toThrow("absolute");
    expect(
      () =>
        new StrictHostProcess({
          executable: pinned,
          environment: { "INVALID-NAME": "value" },
          timeoutMs: 1,
          maxStdoutBytes: 1,
          maxStderrBytes: 1,
        }),
    ).toThrow("environment");
    expect(
      () =>
        new StrictHostProcess({
          executable: pinned,
          environment: {},
          timeoutMs: MAX_STRICT_HOST_PROCESS_TIMEOUT_MS + 1,
          maxStdoutBytes: 1,
          maxStderrBytes: 1,
        }),
    ).toThrow("timeout");
    expect(
      () =>
        new StrictHostProcess({
          executable: pinned,
          environment: {},
          timeoutMs: 1,
          maxStdoutBytes: MAX_STRICT_HOST_PROCESS_OUTPUT_BYTES + 1,
          maxStderrBytes: 1,
        }),
    ).toThrow("output");
    const processRunner = new StrictHostProcess({
      executable: pinned,
      environment: {},
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    expect(() => processRunner.run({ arguments: ["bad\0argument"], cwd: tmpdir() })).toThrow(
      "argument",
    );
    expect(() => processRunner.run({ arguments: [], cwd: "relative" })).toThrow(
      "working directory",
    );
  });
});

async function strictProcess(
  executable: string,
  environment: Readonly<Record<string, string>> = {},
  timeoutMs = 5_000,
): Promise<StrictHostProcess> {
  return new StrictHostProcess({
    executable: await pinExecutable(executable),
    environment,
    timeoutMs,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
  });
}

async function pinExecutable(executable: string): Promise<PinnedGitHubIssueHostExecutable> {
  const projectRoot = await temporaryDirectory("flow-strict-host-project-");
  return await pinGitHubIssueHostExecutable(executable, projectRoot);
}

async function writeNodeExecutable(root: string, name: string, body: string): Promise<string> {
  const executable = join(root, name);
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
