import { execFile as callbackExecFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";

import type { PreparedCommand, SandboxLaunch } from "../../src/application/command-sandbox.js";
import {
  anthropicSandboxRuntimeManager,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../../src/infrastructure/sandbox/anthropic-sandbox-runtime-manager.js";
import {
  FLOW_SANDBOX_POLICY_DIGEST,
  SrtCommandSandbox,
} from "../../src/infrastructure/sandbox/srt-command-sandbox.js";
import { rewriteNativeObserverLaunch } from "../../src/infrastructure/verification/native-observer-launch.js";
import { parseNativeObserverResult } from "../../src/infrastructure/verification/native-observer-result.js";

const execFile = promisify(callbackExecFile);
const source = fileURLToPath(
  new URL("../fixtures/native-observer-transport-app.c", import.meta.url),
);
const marker = "flow-observer-fixed-application-exit-7\n";
const upstreamSha256 = "5c92b0f369a626f5d7cb27d7912cfa882dc26a3690f17cc0016480c5b8b01df7";

// Application record + ordinary output + private-channel EOF only. This is not
// policy-clean, protected-writer, relay/bridge-disposal or repair qualification.
// Default selection is the exact installed upstream helper: after the genuine
// original-launch positive control, its absent observer frame MUST fail here.
// FLOW_TEST_NATIVE_OBSERVER_HELPER is an explicit future artifact input; invalid
// inputs fail, never silently fall back. Non-Linux collection is not a RED run.
// Every owned root is deliberately retained, even on a future record pass:
// manager release and bwrap monitor close do not prove all bridges/relays reaped.
describe.skipIf(process.platform !== "linux")("Native observer application transport", () => {
  it("reports the fixed ELF's normal exit 7 on the private channel", async (context) => {
    expect(process.arch, "Only the Linux x64 profile is supported").toBe("x64");
    context.signal.throwIfAborted();
    const root = await mkdtemp(join(await realpath(tmpdir()), "flow-observer-transport-"));
    // No deletion is scheduled, including after a Vitest timeout or late settlement.
    console.info(`Native observer diagnostic evidence retained: ${root}`);
    const handles: FileHandle[] = [];
    const artifacts: { path: string; before: Awaited<ReturnType<typeof identity>> }[] = [];
    const failures: unknown[] = [];
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private");
    try {
      await Promise.all([mkdir(home), mkdir(workspace), mkdir(privateRoot)]);
      const environment = {
        PATH: "/usr/bin:/bin",
        HOME: home,
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: root,
      };
      const application = join(privateRoot, "fixed-application");
      context.signal.throwIfAborted();
      const compiled = await bounded(
        execFile(
          "/usr/bin/cc",
          [
            "-static",
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-pedantic",
            source,
            "-o",
            application,
          ],
          {
            cwd: root,
            env: environment,
            encoding: "utf8",
            timeout: 5000,
            killSignal: "SIGKILL",
            maxBuffer: 8192,
            signal: context.signal,
          },
        ),
        6000,
        "Static compiler did not settle",
      );
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toBe("");
      await chmod(application, 0o555);
      const appIdentity = await identity(application);
      artifacts.push({ path: application, before: appIdentity });
      const app = await open(application, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(app);
      expect(await app.stat({ bigint: true })).toMatchObject({
        dev: appIdentity.dev,
        ino: appIdentity.ino,
      });
      // This trusted fixed ELF has no external inputs or effects beyond its
      // descriptor inventory and marker. Run it before manager initialization
      // to distinguish ambient host inheritance from sandbox-created handles.
      const hostControl = await capture(
        { executable: application, args: [], env: environment },
        workspace,
        home,
        context.signal,
      );
      expect(hostControl.stderr.toString("utf8"), "Direct-host diagnostics").toBe("");
      expect(hostControl.code).toBe(7);
      expect(hostControl.signal).toBeNull();
      expect(hostControl.stdout.toString("utf8")).toBe(marker);
      console.info("Native observer direct-host positive control: exact marker, exit 7");
      const selected = process.env.FLOW_TEST_NATIVE_OBSERVER_HELPER;
      const helperInput = selected ?? resolveAnthropicSandboxRuntimeSeccompPath();
      if (helperInput === undefined || !isAbsolute(helperInput))
        throw new Error("Missing absolute observer helper input");
      const helper = await realpath(helperInput);
      if (helper !== helperInput)
        throw new Error("Observer helper input must be canonical and not a symlink");
      const helperIdentity = await identity(helper);
      artifacts.push({ path: helper, before: helperIdentity });
      expect(
        JSON.parse(
          await readFile(
            new URL(import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json")),
            "utf8",
          ),
        ).version,
      ).toBe("0.0.70");
      if (selected === undefined) expect(helperIdentity.sha256).toBe(upstreamSha256);
      const sandbox = new SrtCommandSandbox(anthropicSandboxRuntimeManager, {
        backendVersion: "0.0.70",
        environment,
        seccompApplyPath: helper,
      });
      const command = { executable: application, args: [] as string[] };
      const request = {
        ...command,
        cwd: workspace,
        protectedPaths: [privateRoot],
        runtimeSupportPaths: [application, helper],
      };
      // The original path MUST really execute this same ELF. A sandbox/setup
      // failure is not evidence that the missing observer protocol was detected.
      await prepared(sandbox, request, context.signal, async (original) => {
        const result = await capture(original.launch, workspace, home, context.signal);
        expect(result.stderr.toString("utf8"), "Original-launch diagnostics").toBe("");
        expect(result.code).toBe(7);
        expect(result.signal).toBeNull();
        expect(result.stdout.toString("utf8")).toBe(marker);
      });
      console.info("Native observer original-launch positive control: exact marker, exit 7");
      await prepared(sandbox, request, context.signal, async (original) => {
        const httpSocketPath = SandboxManager.getLinuxHttpSocketPath();
        const socksSocketPath = SandboxManager.getLinuxSocksSocketPath();
        if (httpSocketPath === undefined || socksSocketPath === undefined)
          throw new Error("Missing real manager proxy sockets");
        for (const path of new Set([httpSocketPath, socksSocketPath])) {
          expect(await realpath(path)).toBe(path);
          expect((await lstat(path)).isSocket()).toBe(true);
        }
        const correlation = randomBytes(32).toString("hex");
        const launch = rewriteNativeObserverLaunch({
          launch: original.launch,
          originalCommand: command,
          trustedBwrapPath: await realpath("/usr/bin/bwrap"),
          trustedHelperPath: helper,
          correlation,
          proxyBridge: {
            httpSocketPath,
            socksSocketPath,
            originalRelayExecutable: "socat",
            trustedRelayExecutable: await realpath("/usr/bin/socat"),
          },
        });
        if (launch === null)
          throw new Error("Real manager launch is unsupported by observer rewrite");
        const result = await capture(launch, workspace, home, context.signal, app.fd);
        expect(result.privateEof).toBe(true);
        if (selected === undefined) {
          // The pinned helper treats the unsupported observer flag as its
          // executable. Require this exact failure, not any namespace/setup error.
          expect(result.code).toBe(1);
          expect(result.signal).toBeNull();
          expect(result.stdout.length).toBe(0);
          expect(result.stderr.toString("utf8")).toBe(
            "apply-seccomp: execvp: No such file or directory\n",
          );
          console.info(
            "Native observer upstream unsupported-exec control: exact ENOENT diagnostic; private-frame feature assertion follows",
          );
        }
        // Assert the missing feature only after the real baseline above succeeded.
        expect(
          parseNativeObserverResult(result.privateBytes, correlation),
          "Expected one complete private normal-exit frame from the selected helper",
        ).toEqual({ kind: "normal_exit", exitCode: 7, clone3FallbackUsed: false });
        expect(result.code).toBe(0); // Transport success, not application exit status.
        expect(result.signal).toBeNull();
        expect(result.stdout.toString("utf8")).toBe(marker);
        expect(result.stderr.length).toBe(0);
      });
    } catch (error) {
      failures.push(error);
    } finally {
      // Retain and compare evidence even when the expected baseline frame check
      // fails. These comparisons do not establish immutability during execution.
      for (const artifact of artifacts) {
        try {
          expect(await identity(artifact.path)).toEqual(artifact.before);
        } catch (error) {
          failures.push(error);
        }
      }
      const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
      for (const close of closed) if (close.status === "rejected") failures.push(close.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Native observer diagnostic failed; evidence retained");
  }, 45_000);
});

async function identity(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.size > 16n * 1024n * 1024n || (stat.mode & 0o022n) !== 0n)
    throw new Error("Expected a bounded non-group/world-writable regular artifact");
  const bytes = await readFile(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function prepared(
  sandbox: SrtCommandSandbox,
  request: Parameters<SrtCommandSandbox["prepare"]>[0],
  signal: AbortSignal,
  body: (command: PreparedCommand) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Preparation deadline")), 5000);
  const preparation = sandbox.prepare({
    ...request,
    signal: AbortSignal.any([signal, controller.signal]),
  });
  let command: PreparedCommand;
  try {
    command = await bounded(preparation, 5500, "Sandbox preparation did not settle");
  } catch (error) {
    // A late acquired session is still observed and gets a release attempt.
    controller.abort();
    void preparation.then((late) => late.release()).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const failures: unknown[] = [];
  try {
    signal.throwIfAborted();
    controller.signal.throwIfAborted();
    expect(command.processContainment).toBe("linux-pid-namespace");
    expect(command.evidence).toMatchObject({
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
    });
    if (command.beforeLaunch !== undefined || command.run !== undefined)
      throw new Error("Unexpected managed launch interface");
    await body(command);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await bounded(command.release(), 5500, "Sandbox release did not settle");
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Observation or release failed");
}

function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function capture(
  launch: SandboxLaunch,
  cwd: string,
  home: string,
  signal: AbortSignal,
  applicationFd?: number,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  privateBytes: Buffer;
  privateEof: boolean;
}> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Node's "pipe" can be a socketpair. FD 3 is a logical private channel, not
    // a promised S_IFIFO. No descriptor writer authenticity is claimed here.
    const child = spawn(launch.executable, [...launch.args], {
      cwd,
      env: { ...launch.env, HOME: home },
      detached: true,
      stdio:
        applicationFd === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", "pipe", applicationFd],
    });
    const chunks: Buffer[][] = [[], [], []];
    const sizes = [0, 0, 0];
    let privateEof = applicationFd === undefined;
    let failure: Error | undefined;
    let joined = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finishFailure = (error: Error) => {
      if (failure !== undefined || joined) return;
      failure = error;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Root remains retained, including uncertain group settlement. */
        }
      }
      grace = setTimeout(() => {
        joined = true;
        cleanup();
        // Stop local readers after the bounded failed join. This is not EOF or
        // descendant settlement, and cannot produce a successful observation.
        for (const stream of streams) stream?.destroy();
        reject(error);
      }, 1000);
    };
    const abort = () => finishFailure(new Error("Native observer process cancelled"));
    const deadline = setTimeout(
      () => finishFailure(new Error("Native observer process deadline")),
      4000,
    );
    const cleanup = () => {
      clearTimeout(deadline);
      if (grace !== undefined) clearTimeout(grace);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const streams = [child.stdout, child.stderr, child.stdio[3]];
    streams.forEach((value, index) => {
      if (value === null || value === undefined) return;
      const stream = value as Readable;
      stream.on("data", (value: Buffer) => {
        const size = (sizes[index] ?? 0) + value.length;
        sizes[index] = size;
        if (size > (index === 2 ? 64 : 8192)) {
          finishFailure(new Error("Native observer output exceeded bound"));
          return;
        }
        chunks[index]?.push(Buffer.from(value));
      });
      stream.on("error", () => finishFailure(new Error("Native observer channel error")));
      if (index === 2)
        stream.once("end", () => {
          privateEof = true;
        });
    });
    child.once("error", () => finishFailure(new Error("Native observer spawn failed")));
    child.once("close", (code, terminated) => {
      if (joined) return;
      joined = true;
      cleanup();
      if (failure !== undefined) reject(failure);
      else
        resolve({
          code,
          signal: terminated,
          stdout: Buffer.concat(chunks[0] ?? []),
          stderr: Buffer.concat(chunks[1] ?? []),
          privateBytes: Buffer.concat(chunks[2] ?? []),
          privateEof,
        });
    });
  });
}
