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

function proxyInput(shared = false, originalRelayExecutable = "socat", command = originalCommand) {
  const proxyBridge = {
    httpSocketPath: "/tmp/claude-http-0123456789abcdef.sock",
    socksSocketPath: shared
      ? "/tmp/claude-http-0123456789abcdef.sock"
      : "/tmp/claude-socks-0123456789abcdef.sock",
    originalRelayExecutable,
    trustedRelayExecutable: "/usr/bin/socat",
  };
  const selectedOptions = [
    ...options.slice(0, 3),
    ...[...new Set([proxyBridge.httpSocketPath, proxyBridge.socksSocketPath])].flatMap((path) => [
      "--bind",
      path,
      path,
    ]),
    "--setenv",
    "HTTP_PROXY",
    "http://localhost:3128",
    ...options.slice(3),
  ];
  const script = [
    `${quote([originalRelayExecutable])} TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:${proxyBridge.httpSocketPath} >/dev/null 2>&1 &`,
    `${quote([originalRelayExecutable])} TCP-LISTEN:1080,fork,reuseaddr UNIX-CONNECT:${proxyBridge.socksSocketPath} >/dev/null 2>&1 &`,
    'trap "kill %1 %2 2>/dev/null; exit" EXIT',
    `${quote([helper])} ${quote(["/bin/bash", "-c", encodePosixCommand(command.executable, command.args)])}`,
  ].join("\n");
  return {
    ...input(command, selectedOptions, ["/bin/bash", "-c", script]),
    proxyBridge,
    selectedOptions,
    script,
  };
}

describe("Native observer launch rewrite", () => {
  it("preserves the maximum proxy command envelope as separate arguments, not an expanded script", () => {
    const command = {
      executable: "/usr/bin/node",
      args: Array.from({ length: 64 }, () => "'".repeat(512)),
    };
    const result = rewriteNativeObserverLaunch(proxyInput(false, "socat", command));
    expect(result).not.toBeNull();
    const preserved = result?.args.slice(-65) ?? [];
    const expected = [command.executable, ...command.args];
    expect(preserved.length).toBe(expected.length);
    expect(preserved.every((value, index) => value === expected[index])).toBe(true);
    const delimiter = result?.args.indexOf("--") ?? -1;
    expect(result?.args[delimiter + 5]?.split("\n").at(-1)).toBe('exec "$@"');
    expect(result?.args[delimiter + 6]).toBe("flow-observer-bootstrap");
  });
  it.each([
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "BASH_FUNC_probe%%",
    "LD_PRELOAD",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "SRT_OBSERVE_SOCK",
    "ARGV0",
  ])("rejects bootstrap injection %s in every admitted environment surface", (name) => {
    for (const request of [input(), proxyInput()]) {
      expect(
        rewriteNativeObserverLaunch({
          ...request,
          launch: { ...request.launch, env: { ...request.launch.env, [name]: "injected" } },
        }),
      ).toBeNull();
    }
    const request = proxyInput();
    for (const operation of ["--setenv", "--unsetenv"]) {
      const selectedOptions = [
        ...request.selectedOptions.slice(0, 3),
        operation,
        name,
        ...(operation === "--setenv" ? ["injected"] : []),
        ...request.selectedOptions.slice(3),
      ];
      expect(
        rewriteNativeObserverLaunch({
          ...input(originalCommand, selectedOptions, ["/bin/bash", "-c", request.script]),
          proxyBridge: request.proxyBridge,
        }),
      ).toBeNull();
    }
  });

  it.each([
    (script: string) => `${script}\ntrue`,
    (script: string) => script.replace("TCP-LISTEN:3128", "TCP-LISTEN:3129"),
    (script: string) => script.replace("fork,reuseaddr", "reuseaddr"),
    (script: string) => script.replace("2>&1 &", "2>&1; true &"),
    (script: string) =>
      script.replace('trap "kill %1 %2 2>/dev/null; exit" EXIT', "trap true EXIT"),
    (script: string) => script.replace(helper, "/other/helper"),
    (script: string) => script.replace("/bin/bash", "/bin/sh"),
  ])("rejects altered proxy bootstrap byte structure %#", (change) => {
    const request = proxyInput();
    expect(
      rewriteNativeObserverLaunch({
        ...input(originalCommand, request.selectedOptions, [
          "/bin/bash",
          "-c",
          change(request.script),
        ]),
        proxyBridge: request.proxyBridge,
      }),
    ).toBeNull();
  });

  it.each([
    "/tmp/space sock",
    "/tmp/sock:bad",
    "/tmp/sock,bad",
    "/tmp/$(id)",
    "/tmp/é.sock",
    "/tmp/../sock",
    "/tmp//sock",
    "/tmp/sock/",
    "relative",
  ])("rejects unsafe socket grammar even when template and binds agree %#", (path) => {
    const request = proxyInput();
    const source = request.proxyBridge.httpSocketPath;
    expect(
      rewriteNativeObserverLaunch({
        ...input(
          originalCommand,
          request.selectedOptions.map((value) => (value === source ? path : value)),
          ["/bin/bash", "-c", request.script.replaceAll(source, path)],
        ),
        proxyBridge: { ...request.proxyBridge, httpSocketPath: path },
      }),
    ).toBeNull();
  });

  it.each(["./socat", "env socat", "/usr/../bin/socat", "/usr/bin/socat/"])(
    "rejects noncanonical original relay spelling %#",
    (relay) => {
      expect(rewriteNativeObserverLaunch(proxyInput(false, relay))).toBeNull();
    },
  );

  it("requires each socket's existing exact bind and does not infer it from an operand", () => {
    const request = proxyInput();
    const socketIndex = request.selectedOptions.indexOf(request.proxyBridge.socksSocketPath);
    const selectedOptions = [...request.selectedOptions];
    selectedOptions[socketIndex - 1] = "--ro-bind";
    expect(
      rewriteNativeObserverLaunch({
        ...input(originalCommand, selectedOptions, ["/bin/bash", "-c", request.script]),
        proxyBridge: request.proxyBridge,
      }),
    ).toBeNull();
  });

  it("requires proxy metadata to match the actual proxy form, never the direct helper form", () => {
    expect(
      rewriteNativeObserverLaunch({ ...input(), proxyBridge: proxyInput().proxyBridge }),
    ).toBeNull();
  });

  it("detaches proxy metadata from the constructed script", () => {
    const request = proxyInput();
    const result = rewriteNativeObserverLaunch(request);
    expect(result).not.toBeNull();
    const snapshot = structuredClone(result);
    request.proxyBridge.httpSocketPath = "/tmp/changed.sock";
    request.proxyBridge.trustedRelayExecutable = "/changed/socat";
    expect(result).toEqual(snapshot);
    expect(Object.isFrozen(result?.args)).toBe(true);
  });

  it.for([false, true])(
    "adapts the exact proxy template while preserving shared-socket=%s policy",
    (shared) => {
      const request = proxyInput(shared);
      const result = rewriteNativeObserverLaunch(request);
      expect(result).toEqual({
        executable: bwrap,
        args: [
          ...request.selectedOptions,
          "--",
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          [
            `${encodePosixCommand("/usr/bin/socat", ["TCP-LISTEN:3128,fork,reuseaddr", `UNIX-CONNECT:${request.proxyBridge.httpSocketPath}`])} 3>&- 4>&- >/dev/null 2>&1 &`,
            `${encodePosixCommand("/usr/bin/socat", ["TCP-LISTEN:1080,fork,reuseaddr", `UNIX-CONNECT:${request.proxyBridge.socksSocketPath}`])} 3>&- 4>&- >/dev/null 2>&1 &`,
            'trap "kill %1 %2 2>/dev/null; exit" EXIT',
            'exec "$@"',
          ].join("\n"),
          "flow-observer-bootstrap",
          helper,
          "--flow-observer-v1",
          correlation,
          "--",
          originalCommand.executable,
          ...originalCommand.args,
        ],
        env: request.launch.env,
      });
    },
  );
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
