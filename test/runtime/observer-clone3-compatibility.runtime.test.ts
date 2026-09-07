import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { countClone3 } from "../fixtures/observer-clone3-trace.js";
import { runOwnedTest } from "../fixtures/owned-test-scope.js";

const linuxX64 = process.platform === "linux" && process.arch === "x64";
const fixture = fileURLToPath(new URL("../fixtures/observer-clone3-controls.mjs", import.meta.url));
const traceByteLimit = 2 * 1024 * 1024;
const controls = ["timers", "filesystem", "worker", "subprocess"] as const;
const modes = ["untraced", "traced", "injected"] as const;

// Fixed synthetic controls only: passing this measurement never exempts arbitrary
// candidate clone3 calls, qualifies a security tracer, or establishes a benchmark.
// strace --inject skips the selected syscall and supplies the requested error:
// https://man7.org/linux/man-pages/man1/strace.1.html (Tampering).
describe.skipIf(!linuxX64)("Native clone3 compatibility measurements", () => {
  it.for(controls)(
    "measures %s under baseline, tracing, and forced ENOSYS",
    { timeout: 45_000 },
    async (control, context) => {
      const retention = new AbortController();
      return runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          expect(process.getuid?.(), "Measurements require an unprivileged user").not.toBe(0);
          expect(process.version, "This measurement is frozen to Node 26.7.0").toBe("v26.7.0");
          const directory = await scope.temporaryDirectory("flow-clone3-measurement-");
          const tools = {
            strace: await discover("strace", scope.signal),
            uname: await discover("uname", scope.signal),
            getconf: await discover("getconf", scope.signal),
          };
          const run = async (label: string, command: string, args: string[], traced = false) => {
            const result = await execute(
              command,
              args,
              directory,
              scope.signal,
              traced ? traceByteLimit : 8192,
              traced ? 7000 : 2000,
            );
            if (!result.settled)
              retention.abort(new Error("Measurement process settlement unconfirmed"));
            // No argv, trace contents, inherited environment, or private paths enter diagnostics.
            const diagnostic = JSON.stringify({
              label,
              code: result.code,
              signal: result.signal,
              failure: result.failure,
              settled: result.settled,
              stdoutBytes: result.stdout.length,
              stderrBytes: result.stderr.length,
            });
            expect(result.settled, diagnostic).toBe(true);
            expect(result.failure, diagnostic).toBeNull();
            expect(result.signal, diagnostic).toBeNull();
            expect(result.code, diagnostic).toBe(0);
            return result;
          };
          const node = await run("Node version", process.execPath, ["--version"]);
          const kernel = await run("kernel version", tools.uname, ["-sr"]);
          const libc = await run("libc version", tools.getconf, ["GNU_LIBC_VERSION"]);
          const strace = await run("strace version", tools.strace, ["--version"]);
          for (const result of [node, kernel, libc, strace]) expect(result.stderr.length).toBe(0);
          const metadata = {
            node: node.stdout.toString("utf8").trim(),
            kernel: kernel.stdout.toString("utf8").trim(),
            libc: libc.stdout.toString("utf8").trim(),
            strace: strace.stdout.toString("utf8").split("\n")[0] ?? "",
          };
          expect(metadata.node).toBe("v26.7.0");
          expect(metadata.kernel).toMatch(/^Linux [a-zA-Z0-9._+-]+$/);
          expect(metadata.libc).toMatch(/^glibc [0-9.]+$/);
          expect(metadata.strace).toMatch(/^strace -- version [a-zA-Z0-9.+_-]+$/);
          const measurements = [];
          for (const mode of modes) {
            scope.signal.throwIfAborted();
            const args = [fixture, control];
            const traced = mode !== "untraced";
            const result = await run(
              mode,
              traced ? tools.strace : process.execPath,
              traced
                ? [
                    "-f",
                    "-qq",
                    "-s",
                    "32",
                    ...(mode === "injected" ? ["--inject=clone3:error=ENOSYS"] : []),
                    "--",
                    process.execPath,
                    ...args,
                  ]
                : args,
              traced,
            );
            // The fixture has no stderr writer on success. Traces include startup,
            // runtime threads and descendants, not just the named workload operation.
            expect(result.stdout.toString("utf8")).toBe(
              `${JSON.stringify({ control, result: "ok" })}\n`,
            );
            if (!traced) expect(result.stderr.length).toBe(0);
            const counts = traced ? countClone3(result.stderr.toString("utf8")) : null;
            if (counts !== null) {
              expect(counts.completed).toBe(counts.calls);
              expect(counts.injected).toBe(mode === "injected" ? counts.calls : 0);
              if (mode === "injected") expect(counts.enosys).toBe(counts.calls);
              expect(
                result.stderr.length,
                "An empty trace does not prove tracing support",
              ).toBeGreaterThan(0);
              await writeFile(join(directory, `${mode}.trace`), result.stderr, {
                flag: "wx",
                mode: 0o600,
              });
            }
            measurements.push({
              mode,
              elapsedMs: Number(result.elapsedMs.toFixed(3)),
              traceBytes: traced ? result.stderr.length : 0,
              traceSha256: traced ? createHash("sha256").update(result.stderr).digest("hex") : null,
              clone3: counts,
              injectionCoverage:
                mode !== "injected"
                  ? "not-requested"
                  : counts?.injected === 0
                    ? "unexercised"
                    : "fixed-control-passed-with-injection",
            });
          }
          // Intentionally limited public evidence, emitted only after every control passes.
          process.stdout.write(
            `${JSON.stringify({ measurement: "clone3-fixed-control-v1", control, metadata, singleSampleNotBenchmark: true, arbitraryCandidateCompatibilityQualified: false, measurements })}\n`,
          );
        },
      );
    },
  );
});

async function discover(name: string, signal: AbortSignal): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    signal.throwIfAborted();
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new Error(`Cannot inspect required ${name} tool`);
    }
  }
  throw new Error(`Native measurement requires installed ${name}; no provisioning is performed`);
}

interface Observation {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  elapsedMs: number;
  failure: string | null;
  settled: boolean;
}

// Settlement applies only to these fixed tools/fixtures, which never detach a
// new session. This is not a general descendant-containment implementation.
function execute(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  stderrLimit: number,
  timeoutMs: number,
): Promise<Observation> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
        stdout,
        stderr,
        elapsedMs: performance.now() - started,
        failure,
        settled,
      });
    };
    const stop = (reason: string) => {
      if (finished) return;
      failure ??= reason;
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            failure = "process-group termination failed";
        }
      killDeadline ??= setTimeout(() => complete(null, null, false), 1000);
    };
    const abort = () => stop("cancelled");
    const deadline = setTimeout(() => stop("deadline exceeded"), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) return;
      const remaining = 8192 - stdout.length;
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) stop("stdout byte limit exceeded");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (finished) return;
      const remaining = stderrLimit - stderr.length;
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) stop("trace byte limit exceeded");
    });
    child.on("error", () => {
      failure = "process spawn or stream failure";
    });
    child.on("close", (code, terminationSignal) => {
      if (finished) return;
      let settled = child.pid === undefined;
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          settled = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      if (!settled) stop("process group remains after close");
      complete(code, terminationSignal, settled);
    });
  });
}
