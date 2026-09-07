import { execFile as callbackExecFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";

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
const faultSource = fileURLToPath(
  new URL("../fixtures/native-observer-fault-launcher.c", import.meta.url),
);
const marker = "flow-observer-fixed-application-exit-7\n";
const resultMarker = "flow-observer-fixed-application-result\n";
const canaryDiagnostic =
  "unexpected-fd=19 inventory-fd=3 flags=0 fd-errno=0 kind=regular stat-errno=0\n";
const upstreamSha256 = "5c92b0f369a626f5d7cb27d7912cfa882dc26a3690f17cc0016480c5b8b01df7";
type FaultMode =
  | "passthrough"
  | "deny-exec"
  | "deny-exec-write"
  | "deny-exec-write-kill"
  | "close-app-fd";
type OwnedApplication = { path: string; handle: FileHandle };
type Fixture = {
  home: string;
  workspace: string;
  privateRoot: string;
  environment: Record<string, string>;
  app: OwnedApplication;
  malformed: OwnedApplication;
  nonExecutable: OwnedApplication;
  helper: string;
  explicitHelper: boolean;
  faultLauncher: string;
  sandbox: SrtCommandSandbox;
  calibration?: Promise<void>;
  faultCalibration?: Promise<void>;
};

// Result/EOF qualification only, not policy-clean, private-writer, full relay
// disposal or repair eligibility. Default upstream still fails the original
// missing-frame regression. The additional matrix requires an explicit artifact.
// Non-Linux collection is not native evidence. Every owned root is retained,
// even on success: manager reset/monitor close do not prove bridge settlement.
// Shared compilation does not share prepared leases; every launch prepares anew.
describe
  .skipIf(process.platform !== "linux")
  .sequential("Native observer application transport", () => {
    const handles: FileHandle[] = [];
    const artifacts: { path: string; before: Awaited<ReturnType<typeof identity>> }[] = [];
    const active = new Set<Promise<void>>();
    let initialization: Promise<void> | undefined;
    let fixture: Fixture | undefined;
    let closing = false;
    let unavailable = false;
    const setup = new AbortController();

    beforeAll(() => {
      const timer = setTimeout(
        () => setup.abort(new Error("Native fixture setup deadline")),
        20_000,
      );
      initialization = createFixture(setup.signal, handles, artifacts)
        .then((value) => {
          fixture = value;
        })
        .finally(() => clearTimeout(timer));
      return initialization;
    }, 30_000);

    afterAll(async () => {
      closing = true;
      setup.abort();
      // Join original callbacks, not Vitest's timeout wrappers. An uncertain join
      // leaves even the owned handles open; no delayed close or root deletion runs.
      await bounded(
        Promise.allSettled([initialization, ...active]),
        1000,
        "Native fixture users did not settle; handles and root retained",
      );
      const failures: unknown[] = [];
      try {
        await checkArtifacts();
      } catch (error) {
        failures.push(error);
      }
      const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
      for (const close of closed) if (close.status === "rejected") failures.push(close.reason);
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          "Native fixture final comparison or close failed; root retained",
        );
    });

    async function checkArtifacts() {
      for (const artifact of artifacts)
        expect(await identity(artifact.path)).toEqual(artifact.before);
    }

    function runCase(context: TestContext, body: (value: Fixture) => Promise<void>) {
      // A timed-out callback may still own the global manager. A rejected bounded
      // preparation/release/capture can also leave work alive after its callback
      // settles. Never admit another case after either condition.
      if (closing || unavailable || active.size !== 0) {
        unavailable = true;
        return Promise.reject(new Error("Native fixture unavailable after prior uncertainty"));
      }
      const operation = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try {
          context.signal.throwIfAborted();
          if (closing || fixture === undefined) throw new Error("Native fixture is unavailable");
          await body(fixture);
        } catch (error) {
          unavailable = true;
          failures.push(error);
        }
        // Preserve comparisons on failed assertions as well as successful records.
        try {
          await checkArtifacts();
        } catch (error) {
          unavailable = true;
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "Native observation or artifact comparison failed");
      });
      active.add(operation);
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      return operation;
    }

    it(
      "reports the fixed ELF's normal exit 7 on the private channel",
      (context) =>
        runCase(context, async (value) => {
          await calibrate(value, context.signal);
          const result = await observe(value, context.signal);
          if (!value.explicitHelper) {
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
          expect(
            result.record,
            "Expected one complete private normal-exit frame from the selected helper",
          ).toEqual({ kind: "normal_exit", exitCode: 7, clone3FallbackUsed: false });
          expectTransport(result, marker, "");
        }),
      45_000,
    );

    it.for(Array.from({ length: 256 }, (_, value) => value))(
      "preserves separately registered normal application exit %i",
      { timeout: 45_000 },
      (exitCode, context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          const result = await observe(value, context.signal, {
            args: ["--exit", String(exitCode)],
          });
          expect(result.record).toEqual({
            kind: "normal_exit",
            exitCode,
            clone3FallbackUsed: false,
          });
          expectTransport(result, resultMarker, "");
        }),
    );

    it(
      "distinguishes real SIGTERM 15 from the separately tested normal exit 143",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          const result = await observe(value, context.signal, { args: ["--signal-term"] });
          expect(result.record).toEqual({
            kind: "signalled",
            signal: 15,
            clone3FallbackUsed: false,
          });
          expectTransport(result, resultMarker, "");
          // This record does not independently prove exec for arbitrary signalled
          // workers; the fixed control marker is calibration, not a production witness.
        }),
      45_000,
    );

    it(
      "calibrates the real fault launcher immediately before the helper",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          await calibrateFaults(value, context.signal);
        }),
      45_000,
    );

    it(
      "rejects the trusted fault launcher outside the admitted bwrap",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          const result = await capture(
            {
              executable: value.faultLauncher,
              args: [
                "passthrough",
                value.helper,
                "--flow-observer-v1",
                randomBytes(32).toString("hex"),
                "--",
                value.app.path,
              ],
              env: value.environment,
            },
            value.workspace,
            value.home,
            context.signal,
            value.app.handle.fd,
            value.app.handle.fd,
          );
          expect(result.code).toBe(121);
          expect(result.signal).toBeNull();
          expect(result.stdout.length).toBe(0);
          expect(result.stderr.length).toBe(0);
          expect(result.privateBytes.length).toBe(0);
          expect(result.privateEof).toBe(true);
        }),
      45_000,
    );

    it(
      "rejects an actually closed FD 4 without an application result",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          await calibrateFaults(value, context.signal);
          const result = await observe(value, context.signal, { fault: "close-app-fd" });
          expect(result.record).toEqual({
            kind: "setup_failed",
            errno: 9,
            stage: "descriptor_handoff",
            clone3FallbackUsed: false,
          });
          expectTransport(result, "", faultMarker("close-app-fd"));
        }),
      45_000,
    );

    it(
      "rejects a malformed ELF without executing an application",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          const result = await observe(value, context.signal, { application: value.malformed });
          expect(result.record).toEqual({
            kind: "setup_failed",
            errno: 8,
            stage: "descriptor_handoff",
            clone3FallbackUsed: false,
          });
          expectTransport(result, "", "");
        }),
      45_000,
    );

    it(
      "reports real execution denial for a valid non-executable ELF",
      (context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          const result = await observe(value, context.signal, { application: value.nonExecutable });
          expect(result.record).toEqual({
            kind: "exec_failed",
            errno: 13,
            clone3FallbackUsed: false,
          });
          expectTransport(result, "", "");
        }),
      45_000,
    );

    const faults = [
      { mode: "deny-exec", expected: { kind: "exec_failed", errno: 1, clone3FallbackUsed: false } },
      {
        mode: "deny-exec-write",
        expected: { kind: "signalled", signal: 9, clone3FallbackUsed: false },
      },
      {
        mode: "deny-exec-write-kill",
        expected: { kind: "signalled", signal: 4, clone3FallbackUsed: false },
      },
    ] as const;
    it.for(faults)(
      "keeps real $mode failure out of normal application results",
      { timeout: 45_000 },
      ({ mode, expected }, context) =>
        runCase(context, async (value) => {
          await requireArtifact(value, context.signal);
          await calibrateFaults(value, context.signal);
          const result = await observe(value, context.signal, { fault: mode });
          expect(result.record).toEqual(expected);
          expectTransport(result, "", faultMarker(mode));
        }),
    );
  });

async function createFixture(
  signal: AbortSignal,
  handles: FileHandle[],
  artifacts: { path: string; before: Awaited<ReturnType<typeof identity>> }[],
): Promise<Fixture> {
  expect(process.arch, "Only the Linux x64 profile is supported").toBe("x64");
  signal.throwIfAborted();
  const root = await mkdtemp(join(await realpath(tmpdir()), "flow-observer-transport-"));
  console.info(`Native observer diagnostic evidence retained: ${root}`);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const privateRoot = join(root, "private");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(privateRoot)]);
  const environment = { PATH: "/usr/bin:/bin", HOME: home, LANG: "C", LC_ALL: "C", TMPDIR: root };
  const application = join(privateRoot, "fixed-application");
  const faultLauncher = join(privateRoot, "fault-launcher");
  for (const [input, output] of [
    [source, application],
    [faultSource, faultLauncher],
  ] as const) {
    signal.throwIfAborted();
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
          input,
          "-o",
          output,
        ],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout: 5000,
          killSignal: "SIGKILL",
          maxBuffer: 8192,
          signal,
        },
      ),
      6000,
      "Static compiler did not settle",
    );
    expect(compiled.stdout).toBe("");
    expect(compiled.stderr).toBe("");
    await chmod(output, 0o555);
  }
  const malformed = join(privateRoot, "malformed-elf");
  const nonExecutable = join(privateRoot, "non-executable-elf");
  const malformedHeader = Buffer.from((await readFile(application)).subarray(0, 64));
  expect(malformedHeader.length).toBe(64);
  expect(malformedHeader.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  malformedHeader[0] = 0; // Full-sized header rejection, not a short-read failure.
  await writeFile(malformed, malformedHeader, { flag: "wx", mode: 0o444 });
  await copyFile(application, nonExecutable, constants.COPYFILE_EXCL);
  await chmod(nonExecutable, 0o444);
  const selected = process.env.FLOW_TEST_NATIVE_OBSERVER_HELPER;
  const helperInput = selected ?? resolveAnthropicSandboxRuntimeSeccompPath();
  if (helperInput === undefined || !isAbsolute(helperInput))
    throw new Error("Missing absolute observer helper input");
  const helper = await realpath(helperInput);
  if (helper !== helperInput)
    throw new Error("Observer helper input must be canonical and not a symlink");
  for (const path of [application, malformed, nonExecutable, helper, faultLauncher])
    artifacts.push({ path, before: await identity(path) });
  expect(
    JSON.parse(
      await readFile(
        new URL(import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json")),
        "utf8",
      ),
    ).version,
  ).toBe("0.0.70");
  if (selected === undefined) expect((await identity(helper)).sha256).toBe(upstreamSha256);
  async function opened(path: string): Promise<OwnedApplication> {
    signal.throwIfAborted();
    const before = await identity(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    handles.push(handle);
    expect(await handle.stat({ bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    return { path, handle };
  }
  const app = await opened(application);
  const malformedApp = await opened(malformed);
  const nonExecutableApp = await opened(nonExecutable);
  signal.throwIfAborted();
  return {
    home,
    workspace,
    privateRoot,
    environment,
    app,
    malformed: malformedApp,
    nonExecutable: nonExecutableApp,
    helper,
    explicitHelper: selected !== undefined,
    faultLauncher,
    sandbox: new SrtCommandSandbox(anthropicSandboxRuntimeManager, {
      backendVersion: "0.0.70",
      environment,
      seccompApplyPath: helper,
    }),
  };
}

function requestFor(value: Fixture, application: OwnedApplication, args: readonly string[] = []) {
  return {
    executable: application.path,
    args,
    cwd: value.workspace,
    protectedPaths: [value.privateRoot],
    runtimeSupportPaths: [application.path, value.helper, value.faultLauncher],
  };
}

function calibrate(value: Fixture, signal: AbortSignal): Promise<void> {
  value.calibration ??= (async () => {
    const host = { executable: value.app.path, args: [], env: value.environment };
    const positive = await capture(host, value.workspace, value.home, signal);
    expect(positive.stderr.toString("utf8"), "Direct-host diagnostics").toBe("");
    expect(positive.code).toBe(7);
    expect(positive.signal).toBeNull();
    expect(positive.stdout.toString("utf8")).toBe(marker);
    console.info("Native observer direct-host positive control: exact marker, exit 7");
    // FD 19 is an explicit test canary, not a production FD-number ceiling.
    const negative = await capture(
      host,
      value.workspace,
      value.home,
      signal,
      undefined,
      value.app.handle.fd,
    );
    expectCanary(negative);
    console.info("Native observer direct-host negative control: explicit FD 19 detected, exit 96");
    await prepared(value.sandbox, requestFor(value, value.app), signal, async (original) => {
      const result = await capture(original.launch, value.workspace, value.home, signal);
      expect(result.stderr.toString("utf8"), "Original-launch diagnostics").toBe("");
      expect(result.code).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stdout.toString("utf8")).toBe(marker);
    });
    console.info("Native observer original-launch positive control: exact marker, exit 7");
    await prepared(value.sandbox, requestFor(value, value.app), signal, async (original) => {
      expectCanary(
        await capture(
          original.launch,
          value.workspace,
          value.home,
          signal,
          undefined,
          value.app.handle.fd,
        ),
      );
    });
    console.info(
      "Native observer original-launch negative control: explicit FD 19 detected, exit 96",
    );
  })();
  return value.calibration;
}

function expectCanary(result: Awaited<ReturnType<typeof capture>>) {
  expect(result.code).toBe(96);
  expect(result.signal).toBeNull();
  expect(result.stdout.length).toBe(0);
  expect(result.stderr.toString("utf8")).toBe(canaryDiagnostic);
}

async function requireArtifact(value: Fixture, signal: AbortSignal) {
  await calibrate(value, signal);
  expect(
    value.explicitHelper,
    "The extended native matrix requires FLOW_TEST_NATIVE_OBSERVER_HELPER",
  ).toBe(true);
}

function faultMarker(mode: FaultMode) {
  return `flow-observer-fault:${mode}:canary=live-regular-matches-app\n`;
}

function calibrateFaults(value: Fixture, signal: AbortSignal): Promise<void> {
  value.faultCalibration ??= (async () => {
    const result = await observe(value, signal, { fault: "passthrough" });
    expect(result.record).toEqual({ kind: "normal_exit", exitCode: 7, clone3FallbackUsed: false });
    expectTransport(result, marker, faultMarker("passthrough"));
  })();
  return value.faultCalibration;
}

async function observe(
  value: Fixture,
  signal: AbortSignal,
  options: { application?: OwnedApplication; args?: readonly string[]; fault?: FaultMode } = {},
) {
  const application = options.application ?? value.app;
  const request = requestFor(value, application, options.args);
  let observation:
    | (Awaited<ReturnType<typeof capture>> & {
        record: ReturnType<typeof parseNativeObserverResult>;
      })
    | undefined;
  await prepared(value.sandbox, request, signal, async (original) => {
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
      originalCommand: { executable: request.executable, args: request.args },
      trustedBwrapPath: await realpath("/usr/bin/bwrap"),
      trustedHelperPath: value.helper,
      correlation,
      proxyBridge: {
        httpSocketPath,
        socksSocketPath,
        originalRelayExecutable: "socat",
        trustedRelayExecutable: await realpath("/usr/bin/socat"),
      },
    });
    if (launch === null) throw new Error("Real manager launch is unsupported by observer rewrite");
    let actual = launch;
    if (options.fault !== undefined) {
      const tail = [
        "flow-observer-bootstrap",
        value.helper,
        "--flow-observer-v1",
        correlation,
        "--",
        application.path,
        ...request.args,
      ];
      const index = launch.args.length - tail.length;
      if (index < 0 || !tail.every((part, i) => launch.args[index + i] === part))
        throw new Error("Missing exact observer helper positional tail");
      const args = [
        ...launch.args.slice(0, index + 1),
        value.faultLauncher,
        options.fault,
        ...launch.args.slice(index + 1),
      ];
      // Only the positional helper command is prefixed. No bwrap option,
      // shell script, proxy process or original application argument is changed.
      expect(args.slice(0, index + 1)).toEqual(launch.args.slice(0, index + 1));
      expect(args.slice(index + 3)).toEqual(launch.args.slice(index + 1));
      actual = { ...launch, args };
    }
    const result = await capture(
      actual,
      value.workspace,
      value.home,
      signal,
      application.handle.fd,
      application.handle.fd,
    );
    expect(result.privateEof).toBe(true);
    observation = {
      ...result,
      record: parseNativeObserverResult(result.privateBytes, correlation),
    };
  });
  if (observation === undefined) throw new Error("Native observation missing");
  return observation;
}

function expectTransport(
  result: Awaited<ReturnType<typeof observe>>,
  stdout: string,
  stderr: string,
) {
  expect(result.code).toBe(0); // Private transport, not application exit.
  expect(result.signal).toBeNull();
  expect(result.privateEof).toBe(true);
  expect(result.stdout.toString("utf8")).toBe(stdout);
  expect(result.stderr.toString("utf8")).toBe(stderr);
}

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
  canaryFd?: number,
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
    const stdio: ("ignore" | "pipe" | number)[] =
      applicationFd === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", "pipe", applicationFd];
    if (canaryFd !== undefined) {
      // These ignored slots are not an ambient-FD sanitizer. The explicit
      // mapping at 19 is the canary; the application still inventories all FDs.
      while (stdio.length < 19) stdio.push("ignore");
      stdio[19] = canaryFd;
    }
    const child = spawn(launch.executable, [...launch.args], {
      cwd,
      env: { ...launch.env, HOME: home },
      detached: true,
      stdio,
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
