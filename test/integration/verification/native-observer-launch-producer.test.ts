import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { describe, expect, it } from "vitest";

import { encodePosixCommand } from "../../../src/infrastructure/sandbox/posix-argv.js";
import { parseSrtLinuxLaunchDescriptor } from "../../../src/infrastructure/sandbox/srt-command-sandbox.js";
import { rewriteNativeObserverLaunch } from "../../../src/infrastructure/verification/native-observer-launch.js";
import { runOwnedTest } from "../../fixtures/owned-test-scope.js";

const packageUrl = import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json");
const helper = fileURLToPath(new URL("./vendor/seccomp/x64/apply-seccomp", packageUrl));
const bwrap = "/usr/bin/bwrap";

// These controls invoke the real pinned Linux string generator, not the manager,
// bwrap, socat, or apply-seccomp. The private Unix listeners are real endpoints
// used only as generator inputs; no proxy traffic or Linux workload is executed.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Native observer producer compatibility",
  () => {
    it.for(["none", "separate", "shared", "absolute-relay"])(
      "checks actual generator output with proxy mode=%s",
      async (mode, context) => {
        const bridge = mode !== "none";
        const retention = new AbortController();
        await runOwnedTest(
          {
            signal: AbortSignal.any([context.signal, retention.signal]),
            onTestFinished: context.onTestFinished,
          },
          async (scope) => {
            const directory = await scope.temporaryDirectory("fop-");
            expect(JSON.parse(await readFile(new URL(packageUrl), "utf8")).version).toBe("0.0.70");
            expect((await lstat(helper)).isFile()).toBe(true);
            const servers: Server[] = [];
            const failures: unknown[] = [];
            let generated = false;
            try {
              const sockets = {
                httpSocketPath: join(directory, "http.sock"),
                socksSocketPath: join(directory, mode === "shared" ? "http.sock" : "socks.sock"),
              };
              if (bridge) {
                for (const path of new Set(Object.values(sockets))) {
                  scope.signal.throwIfAborted();
                  const server = createServer((socket) => socket.destroy());
                  servers.push(server);
                  const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(1000)]);
                  const listening = once(server, "listening", { signal });
                  server.listen({ path, signal: scope.signal });
                  await listening;
                  expect((await lstat(path)).isSocket()).toBe(true);
                }
              }
              const originalCommand = {
                executable: "/usr/bin/node",
                args: ["script.js", "a'b", "", "$HOME"],
              };
              scope.signal.throwIfAborted();
              const wrapped = await wrapCommandWithSandboxLinux({
                command: encodePosixCommand(originalCommand.executable, originalCommand.args),
                needsNetworkRestriction: true,
                allowAllUnixSockets: false,
                enableWeakerNestedSandbox: false,
                binShell: "/bin/bash",
                bwrapPath: bwrap,
                seccompConfig: { applyPath: helper },
                abortSignal: scope.signal,
                ...(bridge ? sockets : {}),
                ...(mode === "absolute-relay" ? { socatPath: "/usr/bin/socat" } : {}),
              });
              generated = true;
              const launch = {
                executable: "/bin/bash",
                args: ["-c", wrapped],
                env: { PATH: "/usr/bin:/bin" },
              };
              const result = rewriteNativeObserverLaunch({
                launch,
                originalCommand,
                trustedBwrapPath: bwrap,
                trustedHelperPath: helper,
                correlation: "ab".repeat(32),
              });
              if (bridge) {
                expect(wrapped).toContain("HTTP_PROXY");
                expect(wrapped).toContain("TCP-LISTEN:3128");
                expect(wrapped).toContain("trap");
                expect(result).toBeNull();
                const proxyBridge = {
                  ...sockets,
                  originalRelayExecutable: mode === "absolute-relay" ? "/usr/bin/socat" : "socat",
                  trustedRelayExecutable: "/usr/bin/socat",
                };
                const request = {
                  launch,
                  originalCommand,
                  trustedBwrapPath: bwrap,
                  trustedHelperPath: helper,
                  correlation: "ab".repeat(32),
                  proxyBridge,
                };
                const adapted = rewriteNativeObserverLaunch(request);
                const descriptor = parseSrtLinuxLaunchDescriptor(
                  [launch.executable, ...launch.args],
                  bwrap,
                );
                expect(descriptor).not.toBeNull();
                expect(adapted).toEqual({
                  executable: bwrap,
                  args: [
                    ...(descriptor?.options.flatMap((option) => [
                      option.name,
                      ...option.operands,
                    ]) ?? []),
                    "--",
                    "/bin/bash",
                    "--noprofile",
                    "--norc",
                    "-c",
                    [
                      `${encodePosixCommand("/usr/bin/socat", ["TCP-LISTEN:3128,fork,reuseaddr", `UNIX-CONNECT:${sockets.httpSocketPath}`])} 3>&- 4>&- >/dev/null 2>&1 &`,
                      `${encodePosixCommand("/usr/bin/socat", ["TCP-LISTEN:1080,fork,reuseaddr", `UNIX-CONNECT:${sockets.socksSocketPath}`])} 3>&- 4>&- >/dev/null 2>&1 &`,
                      'trap "kill %1 %2 2>/dev/null; exit" EXIT',
                      'exec "$@"',
                    ].join("\n"),
                    "flow-observer-bootstrap",
                    helper,
                    "--flow-observer-v1",
                    "ab".repeat(32),
                    "--",
                    originalCommand.executable,
                    ...originalCommand.args,
                  ],
                  env: launch.env,
                });
                expect(
                  rewriteNativeObserverLaunch({
                    ...request,
                    proxyBridge: { ...proxyBridge, httpSocketPath: join(directory, "wrong.sock") },
                  }),
                ).toBeNull();
                expect(
                  rewriteNativeObserverLaunch({
                    ...request,
                    proxyBridge: { ...proxyBridge, originalRelayExecutable: "/other/socat" },
                  }),
                ).toBeNull();
              } else {
                const descriptor = parseSrtLinuxLaunchDescriptor(
                  [launch.executable, ...launch.args],
                  bwrap,
                );
                expect(descriptor).not.toBeNull();
                expect(result).toEqual({
                  executable: bwrap,
                  args: [
                    ...(descriptor?.options.flatMap((option) => [
                      option.name,
                      ...option.operands,
                    ]) ?? []),
                    "--",
                    helper,
                    "--flow-observer-v1",
                    "ab".repeat(32),
                    "--",
                    originalCommand.executable,
                    ...originalCommand.args,
                  ],
                  env: launch.env,
                });
              }
            } catch (error) {
              retention.abort(new Error("Producer control resource settlement is uncertain"));
              failures.push(error);
            } finally {
              try {
                if (generated) cleanupBwrapMountPoints();
              } catch (error) {
                retention.abort(new Error("Producer mount bookkeeping cleanup is uncertain"));
                failures.push(error);
              }
              for (const server of servers) {
                try {
                  await closeServer(server);
                } catch (error) {
                  retention.abort(new Error("Producer listener settlement is uncertain"));
                  failures.push(error);
                }
              }
            }
            if (failures.length > 0) throw new AggregateError(failures, "Producer control failed");
          },
        );
      },
    );
  },
);

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Producer listener close timed out")), 1000);
    server.close((error) => {
      clearTimeout(deadline);
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
