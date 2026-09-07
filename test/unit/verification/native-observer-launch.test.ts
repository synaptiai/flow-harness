import { describe, expect, it } from "vitest";

import type { SandboxLaunch } from "../../../src/application/command-sandbox.js";
import { encodePosixCommand } from "../../../src/infrastructure/sandbox/posix-argv.js";
import { rewriteNativeObserverLaunch } from "../../../src/infrastructure/verification/native-observer-launch.js";

const helper = "/opt/flow/apply-seccomp";
const bwrap = "/usr/bin/bwrap";
const correlation = "ab".repeat(32);
const originalCommand = { executable: "/usr/bin/node", args: ["script.js", "a'b", "", "$HOME"] };
const options = [
  "--new-session",
  "--die-with-parent",
  "--unshare-net",
  "--ro-bind",
  "/",
  "/",
  "--bind",
  "/tmp/work space",
  "/tmp/work space",
  "--setenv",
  "TMPDIR",
  "/tmp/private",
  "--unsetenv",
  "TOKEN",
  "--unshare-pid",
  "--unshare-user",
  "--cap-drop",
  "ALL",
  "--proc",
  "/proc",
];
function quote(values: readonly string[]) {
  return values
    .map((value) =>
      /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/.test(value)
        ? value
        : `'${value.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
}
function input(command = originalCommand, selectedOptions = options, inner?: readonly string[]) {
  const launch: SandboxLaunch = {
    executable: "/bin/bash",
    args: [
      "-c",
      quote([
        bwrap,
        ...selectedOptions,
        "--",
        "/bin/bash",
        "-c",
        quote(
          inner ?? [
            helper,
            "/bin/bash",
            "-c",
            encodePosixCommand(command.executable, command.args),
          ],
        ),
      ]),
    ],
    env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp/private" },
  };
  return {
    launch,
    originalCommand: { ...command, args: [...command.args] },
    trustedBwrapPath: bwrap,
    trustedHelperPath: helper,
    correlation,
  };
}

describe("Native observer launch rewrite", () => {
  it("does not coerce a non-string correlation into an invocation binding", () => {
    const request = input();
    expect(
      rewriteNativeObserverLaunch({
        ...request,
        correlation: { toString: () => correlation } as unknown as string,
      }),
    ).toBeNull();
  });

  it("rejects non-array command arguments instead of expanding an iterable", () => {
    const request = input({ executable: "/usr/bin/node", args: ["a", "b"] });
    expect(
      rewriteNativeObserverLaunch({
        ...request,
        originalCommand: { executable: "/usr/bin/node", args: "ab" as unknown as string[] },
      }),
    ).toBeNull();
  });

  it("preserves every admitted option and environment entry while replacing only the workload", () => {
    const request = input();
    const result = rewriteNativeObserverLaunch(request);
    expect(result).toEqual({
      executable: bwrap,
      args: [
        ...options,
        "--",
        helper,
        "--flow-observer-v1",
        correlation,
        "--",
        originalCommand.executable,
        ...originalCommand.args,
      ],
      env: request.launch.env,
    });
  });

  it.each([
    [
      "shell executable",
      (value: ReturnType<typeof input>) => ({
        ...value,
        launch: { ...value.launch, executable: "/bin/sh" },
      }),
    ],
    [
      "extra shell argument",
      (value: ReturnType<typeof input>) => ({
        ...value,
        launch: { ...value.launch, args: [...value.launch.args, "extra"] },
      }),
    ],
    [
      "extra shell clause",
      (value: ReturnType<typeof input>) => ({
        ...value,
        launch: { ...value.launch, args: ["-c", `${value.launch.args[1]}; true`] },
      }),
    ],
    [
      "NUL",
      (value: ReturnType<typeof input>) => ({
        ...value,
        launch: { ...value.launch, args: ["-c", `${value.launch.args[1]}\0`] },
      }),
    ],
    [
      "non-lossless UTF-8",
      (value: ReturnType<typeof input>) => ({
        ...value,
        launch: { ...value.launch, args: ["-c", `${value.launch.args[1]}\ud800`] },
      }),
    ],
    [
      "wrong bwrap",
      (value: ReturnType<typeof input>) => ({ ...value, trustedBwrapPath: "/other/bwrap" }),
    ],
    [
      "wrong helper",
      (value: ReturnType<typeof input>) => ({ ...value, trustedHelperPath: "/other/helper" }),
    ],
    [
      "uppercase correlation",
      (value: ReturnType<typeof input>) => ({ ...value, correlation: correlation.toUpperCase() }),
    ],
    [
      "short correlation",
      (value: ReturnType<typeof input>) => ({ ...value, correlation: correlation.slice(2) }),
    ],
    [
      "mismatched command",
      (value: ReturnType<typeof input>) => ({
        ...value,
        originalCommand: { ...value.originalCommand, args: ["different.js"] },
      }),
    ],
  ])("rejects %s without rewriting", (_name, change) => {
    expect(rewriteNativeObserverLaunch(change(input()))).toBeNull();
  });

  it.for([
    options.filter((value) => value !== "--new-session"),
    options.filter((value) => value !== "--die-with-parent"),
    options.filter((value) => value !== "--unshare-net"),
    options.filter((value) => value !== "--unshare-user"),
    options.filter((value) => value !== "--unshare-pid"),
    options.map((value) => (value === "ALL" ? "SYS_ADMIN" : value)),
    [...options, "--tmpfs", "/after-lifecycle"],
    [...options.slice(0, 2), "--preserve-fds", "1", ...options.slice(2)],
    [...options.slice(0, 2), "--unknown-option", ...options.slice(2)],
    [...options.slice(0, 2), "--args", "3", ...options.slice(2)],
  ])("rejects altered containment or descriptor-taking options %#", (selectedOptions) => {
    expect(rewriteNativeObserverLaunch(input(originalCommand, selectedOptions))).toBeNull();
  });

  it.each([
    [helper, "/bin/sh", "-c", encodePosixCommand(originalCommand.executable, originalCommand.args)],
    [helper, "/bin/bash", "-c", "true"],
    [
      helper,
      "/bin/bash",
      "-c",
      encodePosixCommand(originalCommand.executable, originalCommand.args),
      "extra",
    ],
    ["env", "ARGV0=apply-seccomp", helper, "/bin/bash", "-c", "true"],
    ["socat", "proxy", helper, "/bin/bash", "-c", "true"],
  ])("rejects a non-exact nested helper command %#", (...inner) => {
    expect(rewriteNativeObserverLaunch(input(originalCommand, options, inner))).toBeNull();
  });

  it.each([
    "SRT_OBSERVE_SOCK",
    "SRT_ENCODED_CMD",
    "HTTP_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
    "ARGV0",
  ])("rejects monitor or proxy environment %s", (name) => {
    const request = input();
    expect(
      rewriteNativeObserverLaunch({
        ...request,
        launch: { ...request.launch, env: { [name]: "value" } },
      }),
    ).toBeNull();
    expect(
      rewriteNativeObserverLaunch(
        input(originalCommand, [
          ...options.slice(0, 2),
          "--setenv",
          name,
          "value",
          ...options.slice(2),
        ]),
      ),
    ).toBeNull();
  });

  it.each(["relative", "/a/../node", "/node\0", "/node\ud800", `/${"x".repeat(1024)}`])(
    "rejects noncanonical executable paths %#",
    (executable) => {
      const request = executable.includes("\0") ? input() : input({ executable, args: [] });
      expect(
        rewriteNativeObserverLaunch({ ...request, originalCommand: { executable, args: [] } }),
      ).toBeNull();
    },
  );

  it.each(["\0", "\ud800"])("rejects non-lossless environment bytes %#", (value) => {
    const request = input();
    expect(
      rewriteNativeObserverLaunch({
        ...request,
        launch: { ...request.launch, env: { LANG: value } },
      }),
    ).toBeNull();
  });

  it.each([
    Array.from({ length: 65 }, () => "a"),
    ["x".repeat(8193)],
    Array.from({ length: 5 }, () => "x".repeat(8192)),
    ["\ud800"],
  ])("rejects argument-envelope violations %#", (...args) => {
    expect(rewriteNativeObserverLaunch(input({ executable: "/usr/bin/node", args }))).toBeNull();
  });

  it("retains the maximum original envelope without counting wrapper expansion against it", () => {
    const args = Array.from({ length: 64 }, () => "'".repeat(512));
    const request = input({ executable: "/usr/bin/node", args });
    const result = rewriteNativeObserverLaunch(request);
    expect(result?.args.slice(-65)).toEqual(["/usr/bin/node", ...args]);
  });

  it("detaches and freezes all returned containers", () => {
    const request = input();
    const result = rewriteNativeObserverLaunch(request);
    expect(result).not.toBeNull();
    const snapshot = structuredClone(result);
    request.originalCommand.args.push("changed");
    (request.launch.args as string[]).push("changed");
    (request.launch.env as Record<string, string>).PATH = "/changed";
    expect(result).toEqual(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.args)).toBe(true);
    expect(Object.isFrozen(result?.env)).toBe(true);
  });
});
