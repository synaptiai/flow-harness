import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitHubIssueHostAdmissionError } from "../../../../src/application/github-issue-ports.js";
import {
  type PinnedGitHubIssueHostExecutable,
  pinGitHubIssueHostExecutable,
} from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { runStrictReadProcess } from "../../../../src/infrastructure/git/strict-read-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub issue host admission errors", () => {
  it("exposes a stable content-free code and message", () => {
    const secret = "github_pat_secret";
    const error = new GitHubIssueHostAdmissionError("github_authentication_failed");

    expect(error).toMatchObject({
      name: "GitHubIssueHostAdmissionError",
      code: "github_authentication_failed",
      message: "GitHub issue host admission failed: github_authentication_failed",
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects an invalid executable without exposing its source", async () => {
    const secret = "github_pat_secret";
    const error = await captureError(() =>
      runStrictReadProcess({
        executable: `/tmp/git\0${secret}`,
        arguments: [],
        cwd: "/tmp",
        environment: {},
        timeoutMs: 100,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      }),
    );

    expect(error).toMatchObject({ code: "command_failed" });
    expect(String(error)).not.toContain(secret);
  });

  it("maps a nonexistent executable to executable_unavailable", async () => {
    await expect(
      runStrictReadProcess(request(join(tmpdir(), `flow-missing-${process.pid}`))),
    ).rejects.toMatchObject({ code: "executable_unavailable" });
  });

  it("rejects invalid UTF-8 output", async () => {
    const executable = await writeNodeExecutable(
      "invalid-utf8",
      "process.stdout.write(Buffer.from([0xff]));",
    );

    await expect(runStrictReadProcess(request(executable))).rejects.toMatchObject({
      code: "command_response_invalid",
    });
  });

  it("kills a command that exceeds the stdout bound", async () => {
    const executable = await writeNodeExecutable(
      "stdout-overflow",
      'process.stdout.write("x".repeat(2048)); setInterval(() => {}, 1000);',
    );

    await expect(
      runStrictReadProcess({ ...request(executable), maxStdoutBytes: 1_024 }),
    ).rejects.toMatchObject({ code: "command_output_limit_exceeded" });
  });

  it("kills a command after the fixed timeout", async () => {
    const executable = await writeNodeExecutable("timeout", "setInterval(() => {}, 1000);");

    await expect(
      runStrictReadProcess({ ...request(executable), timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "command_timed_out" });
  });

  it("kills an in-flight command when the caller aborts", async () => {
    const executable = await writeNodeExecutable("abort", "setInterval(() => {}, 1000);");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("github_pat_secret")), 10).unref();

    await expect(
      runStrictReadProcess({ ...request(executable), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "operation_aborted" });
  });

  it("does not spawn after aborting during executable revalidation", async () => {
    const executableRoot = await temporaryDirectory("flow-process-executable-");
    const projectRoot = await temporaryDirectory("flow-process-project-");
    const marker = join(executableRoot, "spawned");
    const executable = await writeNodeExecutable(
      "abort-before-spawn",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`,
      executableRoot,
    );
    const pinned = await pinGitHubIssueHostExecutable(executable, projectRoot);
    const controller = new AbortController();

    const result = runStrictReadProcess({ ...request(pinned), signal: controller.signal });
    controller.abort(new Error("github_pat_secret"));

    await expect(result).rejects.toMatchObject({ code: "operation_aborted" });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "does not leave the timed-out child running",
    async () => {
      const root = await temporaryDirectory("flow-process-child-");
      const parentPidFile = join(root, "parent-pid");
      const descendantPidFile = join(root, "descendant-pid");

      await expect(
        runStrictReadProcess({
          ...request("/bin/sh"),
          arguments: [
            "-c",
            `printf '%s' "$$" > ${JSON.stringify(parentPidFile)}; (while :; do :; done) & printf '%s' "$!" > ${JSON.stringify(descendantPidFile)}; wait`,
          ],
          timeoutMs: 250,
        }),
      ).rejects.toMatchObject({ code: "command_timed_out" });
      const parentPid = Number(await readFile(parentPidFile, "utf8"));
      const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
      expect(() => process.kill(parentPid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    },
    2_000,
  );
});

function request(executable: string | PinnedGitHubIssueHostExecutable) {
  return {
    executable,
    arguments: [] as const,
    cwd: tmpdir(),
    environment: {},
    timeoutMs: 5_000,
    maxStdoutBytes: 4_096,
    maxStderrBytes: 4_096,
  };
}

async function writeNodeExecutable(name: string, body: string, root?: string): Promise<string> {
  const directory = root ?? (await temporaryDirectory("flow-process-fixture-"));
  const executable = join(directory, name);
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, "utf8");
  await chmod(executable, 0o700);
  return executable;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
