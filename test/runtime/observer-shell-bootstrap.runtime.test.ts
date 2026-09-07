import { execFile as callbackExecFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, type FileHandle, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { describe, expect, it } from "vitest";

import { encodePosixCommand } from "../../src/infrastructure/sandbox/posix-argv.js";
import { rewriteNativeObserverLaunch } from "../../src/infrastructure/verification/native-observer-launch.js";
import { type OwnedTestScope, runOwnedTest } from "../fixtures/owned-test-scope.js";

const execFile = promisify(callbackExecFile);
const source = fileURLToPath(
  new URL("../fixtures/observer-bootstrap-fd-control.c", import.meta.url),
);
type Inventory = {
  role: string;
  fd3: boolean;
  fd4: boolean;
  other: number;
  dev3: string;
  ino3: string;
  dev4: string;
  ino4: string;
  reaped: number;
  argumentCount: number;
  argumentBytes: number;
};

// Only shell startup and descriptor mechanics: fixed C controls replace both
// socat and the unfinished observer. No bwrap, application or network executes.
// The control helper explicitly reaps its two control children; this does NOT
// establish that the future production helper owns or settles proxy relays.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "Observer shell bootstrap controls",
  () => {
    it("keeps private descriptors out of relays and suppresses synthetic startup files", async (context) => {
      const retention = new AbortController();
      await runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          const root = await scope.temporaryDirectory("flow-bootstrap-control-");
          const home = join(root, "home");
          await mkdir(home);
          const startup = 'printf startup > "$HOME/startup-marker"\n';
          for (const name of [
            ".bashrc",
            ".bash_profile",
            ".bash_login",
            ".profile",
            "explicit-startup",
          ])
            await writeFile(join(home, name), startup, { flag: "wx", mode: 0o600 });
          const environment = {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
            HOME: home,
            TMPDIR: root,
          };
          const executable = join(root, "fd-control");
          try {
            scope.signal.throwIfAborted();
            const compiled = await execFile(
              "/usr/bin/cc",
              [
                "-std=c11",
                "-O2",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-pedantic",
                source,
                "-o",
                executable,
              ],
              {
                cwd: root,
                env: environment,
                encoding: "utf8",
                timeout: 5000,
                killSignal: "SIGKILL",
                maxBuffer: 8192,
                signal: scope.signal,
              },
            );
            expect(compiled.stdout).toBe("");
            expect(compiled.stderr).toBe("");
          } catch (error) {
            retention.abort(new Error("Compiler settlement uncertain"));
            throw error;
          }
          const args = await bootstrap(executable, root, scope, retention);
          expect(args.slice(0, 3)).toEqual(["--noprofile", "--norc", "-c"]);
          const script = args[3];
          if (script === undefined) throw new Error("Missing generated script");
          const good = await observe("good", args, environment, root, scope, retention);
          expect(good.relays.map(({ fd3, fd4, other }) => ({ fd3, fd4, other }))).toEqual([
            { fd3: false, fd4: false, other: 0 },
            { fd3: false, fd4: false, other: 0 },
          ]);
          await expect(access(join(home, "startup-marker"))).rejects.toMatchObject({
            code: "ENOENT",
          });

          // Real negative control: deleting only the generated redirections leaks
          // the actual mapped descriptors; the exact same early-entry probe sees it.
          const leaky = script.replaceAll(" 3>&- 4>&-", "");
          expect(leaky).not.toBe(script);
          const bad = await observe(
            "leaky",
            [...args.slice(0, 3), leaky, ...args.slice(4)],
            environment,
            root,
            scope,
            retention,
          );
          expect(bad.relays.map(({ fd3, fd4 }) => ({ fd3, fd4 }))).toEqual([
            { fd3: true, fd4: true },
            { fd3: true, fd4: true },
          ]);
          for (const relay of bad.relays)
            expect(relay).toMatchObject({
              dev3: bad.helper.dev3,
              ino3: bad.helper.ino3,
              dev4: bad.helper.dev4,
              ino4: bad.helper.ino4,
            });

          expect(script.match(/ 3>&- 4>&-/g)).toHaveLength(2);
          const duplicate = script.replaceAll(" 3>&- 4>&-", " 19>&3 3>&- 4>&-");
          const high = await observe(
            "high-fd",
            [...args.slice(0, 3), duplicate, ...args.slice(4)],
            environment,
            root,
            scope,
            retention,
          );
          expect(high.relays.map(({ fd3, fd4, other }) => ({ fd3, fd4, other }))).toEqual([
            { fd3: false, fd4: false, other: 1 },
            { fd3: false, fd4: false, other: 1 },
          ]);

          const maximumRoot = join(root, "maximum-metadata");
          await mkdir(maximumRoot);
          const maximumArgs = await bootstrap(
            executable,
            maximumRoot,
            scope,
            retention,
            Array.from({ length: 64 }, () => "'".repeat(512)),
          );
          const maximum = await observe(
            "maximum",
            maximumArgs,
            environment,
            root,
            scope,
            retention,
          );
          expect(maximum.helper).toMatchObject({ argumentCount: 64, argumentBytes: 32768 });
          expect(maximum.relays.map(({ fd3, fd4, other }) => ({ fd3, fd4, other }))).toEqual([
            { fd3: false, fd4: false, other: 0 },
            { fd3: false, fd4: false, other: 0 },
          ]);

          // Positive startup-file detection, not a production admission bypass:
          // BASH_ENV is deliberately injected only into this fixed control run.
          await observe(
            "startup",
            args,
            { ...environment, BASH_ENV: join(home, "explicit-startup") },
            root,
            scope,
            retention,
          );
          expect(await readFile(join(home, "startup-marker"), "utf8")).toBe("startup");
        },
      );
    });
  },
);

async function bootstrap(
  executable: string,
  root: string,
  scope: OwnedTestScope,
  retention: AbortController,
  originalArgs: string[] = ["2"],
): Promise<readonly string[]> {
  // The actual generator needs only existing paths for its proxy bind inputs.
  // They are synthetic regular files: no networking or bwrap execution occurs.
  const http = join(root, "http.sock");
  const socks = join(root, "socks.sock");
  await writeFile(http, "synthetic", { flag: "wx" });
  await writeFile(socks, "synthetic", { flag: "wx" });
  const originalCommand = {
    executable: "/observer-test/application-not-executed",
    args: originalArgs,
  };
  scope.signal.throwIfAborted();
  let generated = false;
  let result: readonly string[] | undefined;
  const failures: unknown[] = [];
  try {
    const wrapped = await wrapCommandWithSandboxLinux({
      command: encodePosixCommand(originalCommand.executable, originalCommand.args),
      needsNetworkRestriction: true,
      allowAllUnixSockets: false,
      enableWeakerNestedSandbox: false,
      binShell: "/bin/bash",
      bwrapPath: "/usr/bin/bwrap",
      seccompConfig: { applyPath: executable },
      socatPath: executable,
      httpSocketPath: http,
      socksSocketPath: socks,
      abortSignal: scope.signal,
    });
    generated = true;
    const rewritten = rewriteNativeObserverLaunch({
      launch: { executable: "/bin/bash", args: ["-c", wrapped], env: { PATH: "/usr/bin:/bin" } },
      originalCommand,
      trustedBwrapPath: "/usr/bin/bwrap",
      trustedHelperPath: executable,
      correlation: "ab".repeat(32),
      proxyBridge: {
        httpSocketPath: http,
        socksSocketPath: socks,
        originalRelayExecutable: executable,
        trustedRelayExecutable: executable,
      },
    });
    expect(rewritten).not.toBeNull();
    const delimiter = rewritten?.args.indexOf("--") ?? -1;
    expect(delimiter).toBeGreaterThan(0);
    expect(rewritten?.args[delimiter + 1]).toBe("/bin/bash");
    result = rewritten?.args.slice(delimiter + 2);
  } catch (error) {
    retention.abort(new Error("Bootstrap generation or validation failed"));
    failures.push(error);
  } finally {
    if (generated) {
      try {
        cleanupBwrapMountPoints();
      } catch (error) {
        retention.abort(new Error("Bootstrap generator cleanup uncertain"));
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Bootstrap generation failed");
  if (result === undefined) throw new Error("Missing bootstrap arguments");
  return result;
}

async function observe(
  name: string,
  args: readonly string[],
  env: Record<string, string>,
  root: string,
  scope: OwnedTestScope,
  retention: AbortController,
) {
  const cwd = join(root, name);
  await mkdir(cwd);
  const handles: FileHandle[] = [];
  const failures: unknown[] = [];
  let observation: { helper: Inventory; relays: Inventory[] } | undefined;
  try {
    for (const number of [3, 4])
      handles.push(
        await open(
          join(cwd, `mapped-${number}`),
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        ),
      );
    const identities = await Promise.all(handles.map((handle) => handle.stat({ bigint: true })));
    scope.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/bash", [...args], {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", handles[0]?.fd ?? "ignore", handles[1]?.fd ?? "ignore"],
      });
      let failed = false;
      let finished = false;
      let bytes = 0;
      let joinTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(joinTimer);
        scope.signal.removeEventListener("abort", fail);
        if (error === undefined) resolve();
        else reject(error);
      };
      const fail = () => {
        if (finished || failed) return;
        failed = true;
        retention.abort(new Error("Bootstrap control settlement uncertain"));
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Retention remains sticky. */
          }
        }
        joinTimer = setTimeout(
          () => finish(new Error("Bootstrap control close unconfirmed")),
          1000,
        );
      };
      const timer = setTimeout(fail, 5000);
      scope.signal.addEventListener("abort", fail, { once: true });
      if (scope.signal.aborted) fail();
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 0) fail();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 0) fail();
      });
      child.on("error", fail);
      child.stdin?.on("error", fail);
      // Keep an empty pipe open for shell startup detection without racing a
      // no-payload write against the child's early close of standard input.
      child.on("close", (code, signal) => {
        if (failed || code !== 0 || signal !== null) {
          fail();
          finish(new Error("Bootstrap control failed"));
        } else finish();
      });
    });
    const report = async (role: string) => {
      const contents = await readFile(join(cwd, `${role}.json`), "utf8");
      expect(Buffer.byteLength(contents)).toBeLessThan(1024);
      return JSON.parse(contents) as Inventory;
    };
    const helper = await report("helper");
    expect(helper).toMatchObject({
      role: "helper",
      fd3: true,
      fd4: true,
      other: 0,
      reaped: 2,
      dev3: String(identities[0]?.dev),
      ino3: String(identities[0]?.ino),
      dev4: String(identities[1]?.dev),
      ino4: String(identities[1]?.ino),
    });
    const relays = [await report("relay3128"), await report("relay1080")];
    expect(relays.map(({ role, reaped }) => ({ role, reaped }))).toEqual([
      { role: "relay3128", reaped: 0 },
      { role: "relay1080", reaped: 0 },
    ]);
    observation = { helper, relays };
  } catch (error) {
    failures.push(error);
  } finally {
    const closes = await Promise.allSettled(handles.map((handle) => handle.close()));
    const closeFailures = closes
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (closeFailures.length > 0) {
      retention.abort(new Error("Mapped descriptor closure uncertain"));
      failures.push(...closeFailures);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Bootstrap control failed");
  if (observation === undefined) throw new Error("Missing control observation");
  return observation;
}
