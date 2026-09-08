import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ownedTestCase } from "../fixtures/owned-test-scope.js";

const execFile = promisify(execFileCallback);
const relay = process.env.FLOW_TEST_RESTRICTED_RELAY;
const enabled = process.platform === "linux" && process.arch === "x64" && relay !== undefined;
const profileEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
});

function hostArguments(socket: string, port = "1"): [string, string] {
  return [
    `UNIX-LISTEN:${socket},fork,reuseaddr`,
    `TCP:localhost:${port},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
  ];
}

async function expectProfileRejection(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  reason: "invalid_arguments" | "invalid_environment",
) {
  if (relay === undefined) throw new Error("Explicit relay artifact required");
  // No connection is made to any listener. The reviewed baseline forks only on
  // a connection, so these inputs can own only their directly spawned process.
  // execFile joins that child on its SIGKILL timeout; uncertainty still rejects.
  const result = await execFile(relay, args, {
    cwd,
    env,
    timeout: 3_000,
    killSignal: "SIGKILL",
    maxBuffer: 32_768,
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), normalExitFailure);
  expect(result).toEqual({
    code: 64,
    stdout: "",
    stderr: `FLOW_RELAY_PROFILE_V1 ${reason}\n`,
  });
}

const argumentCases: ReadonlyArray<{
  name: string;
  arguments: (socket: string) => readonly string[];
}> = [
  { name: "no addresses", arguments: () => [] },
  { name: "one address", arguments: (socket) => [hostArguments(socket)[0]] },
  { name: "extra address", arguments: (socket) => [...hostArguments(socket), "unused"] },
  { name: "empty listener address", arguments: (socket) => ["", hostArguments(socket)[1]] },
  {
    name: "lowercase listener keyword",
    arguments: (socket) => [
      hostArguments(socket)[0].replace("UNIX-LISTEN", "unix-listen"),
      hostArguments(socket)[1],
    ],
  },
  {
    name: "relative socket path",
    arguments: () => hostArguments("relay.sock"),
  },
  {
    name: "missing fork option",
    arguments: (socket) => [`UNIX-LISTEN:${socket},reuseaddr`, hostArguments(socket)[1]],
  },
  {
    name: "reordered listener options",
    arguments: (socket) => [`UNIX-LISTEN:${socket},reuseaddr,fork`, hostArguments(socket)[1]],
  },
  {
    name: "extra listener option",
    arguments: (socket) => [`${hostArguments(socket)[0]},reuseaddr`, hostArguments(socket)[1]],
  },
  {
    name: "IPv4-specific TCP keyword",
    arguments: (socket) => [
      hostArguments(socket)[0],
      hostArguments(socket)[1].replace("TCP:", "TCP4:"),
    ],
  },
  {
    name: "numeric host instead of literal localhost",
    arguments: (socket) => [
      hostArguments(socket)[0],
      hostArguments(socket)[1].replace("localhost", "127.0.0.1"),
    ],
  },
  {
    name: "changed keepidle value",
    arguments: (socket) => [
      hostArguments(socket)[0],
      hostArguments(socket)[1].replace("keepidle=10", "keepidle=11"),
    ],
  },
  {
    name: "missing keepcnt option",
    arguments: (socket) => [
      hostArguments(socket)[0],
      hostArguments(socket)[1].replace(",keepcnt=3", ""),
    ],
  },
  {
    name: "extra TCP option",
    arguments: (socket) => [hostArguments(socket)[0], `${hostArguments(socket)[1]},keepalive`],
  },
];

function normalExitFailure(error: unknown) {
  // Spawn errors, timeouts, signals, and output overflow are not admission.
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "number" ||
    !("signal" in error) ||
    error.signal !== null ||
    !("killed" in error) ||
    error.killed !== false ||
    !("stdout" in error) ||
    !("stderr" in error)
  )
    throw error;
  return { code: error.code, stdout: error.stdout, stderr: error.stderr };
}

it("retains an actual normal nonzero exit without treating every error as uncertain", async () => {
  const result = await execFile(
    process.execPath,
    [
      "-e",
      "process.stderr.write('FLOW_RELAY_PROFILE_V1 invalid_arguments\\n'); process.exitCode = 64;",
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 32_768,
    },
  ).then(() => {
    throw new Error("Expected normal status 64");
  }, normalExitFailure);
  expect(result).toEqual({
    code: 64,
    stdout: "",
    stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
  });
});

it("rejects an actual parent-requested termination despite a matching numeric exit", async (context) => {
  const operation = execFile(
    process.execPath,
    [
      "-e",
      [
        "process.on('SIGTERM', () => process.exit(64));",
        "process.stderr.write('FLOW_RELAY_PROFILE_V1 invalid_arguments\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    { env: { PATH: "/usr/bin:/bin" }, timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 32_768 },
  );
  // This fixed control has one direct child and creates no descendants. Join it
  // even if readiness, signal delivery, or the assertion fails.
  const outcome = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const child = operation.child;
  try {
    if (child.stderr === null) throw new Error("Missing control error stream");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(2_000)]);
    const [ready] = await once(child.stderr, "data", { signal });
    expect(ready.toString()).toBe("FLOW_RELAY_PROFILE_V1 invalid_arguments\n");
    expect(child.kill("SIGTERM")).toBe(true);
    const result = await outcome;
    if (!("error" in result)) throw new Error("Expected the real control to exit with status 64");
    expect(result.error).toMatchObject({
      code: 64,
      signal: null,
      killed: true,
      stdout: "",
      stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
    });
    expect(() => normalExitFailure(result.error)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await outcome;
  }
});

describe.skipIf(!enabled)("restricted host-relay argument admission", () => {
  it("rejects the general version option before entering upstream socat", async () => {
    if (relay === undefined) throw new Error("Explicit relay artifact required");
    const result = await execFile(relay, ["-V"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
      timeout: 3_000,
      killSignal: "SIGKILL",
      maxBuffer: 32_768,
    }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), normalExitFailure);
    expect(result).toEqual({
      code: 64,
      stdout: "",
      stderr: "FLOW_RELAY_PROFILE_V1 invalid_arguments\n",
    });
  });

  it.for(argumentCases)(
    "rejects $name",
    ownedTestCase(async (testCase, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-args-");
      await expectProfileRejection(
        testCase.arguments(join(root, "relay.sock")),
        root,
        profileEnvironment,
        "invalid_arguments",
      );
    }),
  );

  it.for([
    { name: "comma", value: "," },
    { name: "colon", value: ":" },
    { name: "dual-address separator", value: "!!" },
    { name: "backslash escape", value: "\\" },
    { name: "double quote", value: '"' },
    { name: "single quote", value: "'" },
    { name: "opening parenthesis", value: "(" },
    { name: "closing parenthesis", value: ")" },
    { name: "brackets", value: "[]" },
    { name: "braces", value: "{}" },
    { name: "space", value: " " },
    { name: "tab", value: "\t" },
    { name: "newline", value: "\n" },
    { name: "non-ASCII character", value: "é" },
  ])(
    "rejects a socket filename containing $name",
    ownedTestCase(async ({ value }, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-path-");
      // Only the final filename is altered. Even upstream interpretation of a
      // delimiter or escape stays inside the owned root (also the child's cwd).
      const socket = join(root, `relay${value}.sock`);
      await expectProfileRejection(
        hostArguments(socket),
        root,
        profileEnvironment,
        "invalid_arguments",
      );
    }),
  );

  it.for(["", "0", "01", "+1", "-1", " 1", "1 ", "65536", "999999", "http", "1.0", "0x50"])(
    "rejects noncanonical or out-of-range port %j",
    ownedTestCase(async (port, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-port-");
      await expectProfileRejection(
        hostArguments(join(root, "relay.sock"), port),
        root,
        profileEnvironment,
        "invalid_arguments",
      );
    }),
  );

  it.for([108, 109])(
    "rejects a socket pathname of exactly %i bytes",
    ownedTestCase(async (bytes, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-limit-");
      const prefix = `${root}/`;
      const padding = bytes - Buffer.byteLength(prefix);
      expect(padding).toBeGreaterThan(0);
      const socket = `${prefix}${"s".repeat(padding)}`;
      expect(Buffer.byteLength(socket)).toBe(bytes);
      expect(dirname(socket)).toBe(root);
      await expectProfileRejection(
        hostArguments(socket),
        root,
        profileEnvironment,
        "invalid_arguments",
      );
    }),
  );
});

describe.skipIf(!enabled)("restricted host-relay environment admission", () => {
  it.for(["PATH", "LANG", "LC_ALL", "TZ"] as const)(
    "rejects missing %s with otherwise valid host arguments",
    ownedTestCase(async (key, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-env-");
      const env: NodeJS.ProcessEnv = { ...profileEnvironment };
      delete env[key];
      await expectProfileRejection(
        hostArguments(join(root, "relay.sock")),
        root,
        env,
        "invalid_environment",
      );
    }),
  );

  it.for([
    { key: "PATH", value: "/bin" },
    { key: "LANG", value: "POSIX" },
    { key: "LC_ALL", value: "POSIX" },
    { key: "TZ", value: "GMT0" },
  ])(
    "rejects changed $key with otherwise valid host arguments",
    ownedTestCase(async ({ key, value }, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-env-");
      await expectProfileRejection(
        hostArguments(join(root, "relay.sock")),
        root,
        { ...profileEnvironment, [key]: value },
        "invalid_environment",
      );
    }),
  );

  it.for([
    { name: "empty environment", env: {} },
    {
      name: "one additional inert key",
      env: { ...profileEnvironment, FLOW_TEST_INERT_PROFILE_INPUT: "1" },
    },
  ])(
    "rejects $name with otherwise valid host arguments",
    ownedTestCase(async ({ env }, scope) => {
      const root = await scope.temporaryDirectory("flow-relay-env-");
      await expectProfileRejection(
        hostArguments(join(root, "relay.sock")),
        root,
        env,
        "invalid_environment",
      );
    }),
  );
});
