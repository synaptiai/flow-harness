import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runOwnedTest } from "../fixtures/owned-test-scope.js";

const linuxX64 = process.platform === "linux" && process.arch === "x64";
const source = fileURLToPath(
  new URL("../fixtures/native-observer-notification-probe.c", import.meta.url),
);

// This is a kernel counterexample probe, not observer or application qualification.
// Unsupported native hosts fail; a Mac skip supplies no Linux evidence.
describe.skipIf(!linuxX64)("Native seccomp notification history", () => {
  it.for(["received", "cancelled"] as const)(
    "checks %s notification history against a real received positive control",
    { timeout: 30_000 },
    async (mode, context) => {
      const retention = new AbortController();
      return runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          expect(process.getuid?.(), "The probe must run without root privileges").not.toBe(0);
          const directory = await scope.temporaryDirectory("flow-notification-history-");
          const run = async (command: string, args: string[], timeoutMs: number) => {
            const outcome = await execute(command, args, directory, timeoutMs, scope.signal);
            if (!outcome.settled) retention.abort(new Error("Native probe settlement unconfirmed"));
            expect(outcome.settled, JSON.stringify(outcome)).toBe(true);
            expect(outcome.failure, JSON.stringify(outcome)).toBeNull();
            expect(outcome.signal, JSON.stringify(outcome)).toBeNull();
            expect(outcome.code, JSON.stringify(outcome)).toBe(0);
            return outcome;
          };
          const compiler = await discoverCompiler(scope.signal);
          const executable = join(directory, "notification-probe");
          await run(
            compiler,
            ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
            10_000,
          );
          const result = await run(executable, [mode], 10_000);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual({
            mode,
            filterApplied: true,
            waitKillableRecv: true,
            positiveReceived: true,
            secondQueued: true,
            secondReceived: mode === "received",
            caughtEintr: mode === "cancelled",
            normalExit: true,
            queueEmpty: true,
            listenerHangup: true,
          });
        },
      );
    },
  );
});

async function discoverCompiler(signal: AbortSignal): Promise<string> {
  for (const name of ["cc", "gcc", "clang"]) {
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, name);
      signal.throwIfAborted();
      try {
        await access(candidate, constants.X_OK);
        return await realpath(candidate);
      } catch (error) {
        if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    }
  }
  throw new Error(
    "Native notification history requires an installed C compiler; no provisioning is performed",
  );
}

interface ProcessObservation {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  failure: string | null;
  settled: boolean;
}

function execute(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessObservation> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let failure: string | null = null;
    let finished = false;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const complete = (
      code: number | null,
      terminationSignal: NodeJS.Signals | null,
      settled: boolean,
    ) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      signal.removeEventListener("abort", abort);
      resolve({
        code,
        signal: terminationSignal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        failure,
        settled,
      });
    };
    const stop = (reason: string) => {
      if (finished) return;
      failure ??= reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure += "; process-group kill failed";
        }
      }
      killDeadline ??= setTimeout(() => complete(null, null, false), 2000);
    };
    const abort = () => stop("cancelled");
    const deadline = setTimeout(() => stop("deadline exceeded"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      const remaining = 8192 - stdout.byteLength;
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) {
        stop("stdout exceeded bound");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (finished) return;
      const remaining = 8192 - stderr.byteLength;
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) {
        stop("stderr exceeded bound");
      }
    });
    child.on("error", (error) => {
      failure = error.message;
    });
    child.on("close", (code, terminationSignal) => {
      if (finished) return;
      let settled = child.pid === undefined;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          settled = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      if (!settled) stop("process group remains after close");
      complete(code, terminationSignal, settled);
    });
  });
}
