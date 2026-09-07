import { posix } from "node:path";

import { quote as quoteSrtArgv } from "@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js";

import type { SandboxLaunch } from "../../application/command-sandbox.js";
import { normalizeAgentCommandRequest } from "../../domain/agent-command.js";
import { MAX_AGENT_COMMAND_EXECUTABLE_BYTES } from "../../domain/command-envelope.js";
import { encodePosixCommand } from "../sandbox/posix-argv.js";
import { parseSrtLinuxLaunchDescriptor } from "../sandbox/srt-command-sandbox.js";

export interface NativeObserverLaunchInput {
  readonly launch: SandboxLaunch;
  readonly originalCommand: Readonly<{ executable: string; args: readonly string[] }>;
  readonly trustedBwrapPath: string;
  readonly trustedHelperPath: string;
  readonly correlation: string;
  readonly proxyBridge?: Readonly<{
    httpSocketPath: string;
    socksSocketPath: string;
    originalRelayExecutable: string;
    trustedRelayExecutable: string;
  }>;
}

/** Pure, observer-only transformation of an already admitted SRT launch.
 * This does not authenticate the supplied backend or artifact paths, open the
 * admitted ELF, transfer descriptors, execute a process, or establish custody.
 * The caller must reserve FD 3 for the protected result and FD 4 for the admitted
 * ELF through inherited descriptors. Bubblewrap 0.9.0 needs no preservation
 * option; real Linux inheritance and protected-channel qualification remain
 * open. The original command envelope bounds application arguments, not SRT's
 * independently admitted mount inventory or its shell-quoting expansion.
 * Current SRT production launches require independently admitted proxy metadata.
 * The caller must bind original PATH resolution to the admitted trusted system
 * relay and establish protected immutable helper custody, socket identities, and
 * mount semantics. This function only checks
 * the pinned template and path syntax; it does not prove those identities.
 * The replacement shell suppresses startup files and closes private descriptors
 * in relay children. Application arguments remain separate positional arguments
 * rather than expanding into the shell script, preserving the original envelope.
 * Its final exec does not run the retained EXIT trap: relay
 * readiness, descriptor custody and namespace teardown remain qualification
 * gates. No production execution or lifecycle composition is enabled here.
 */
export function rewriteNativeObserverLaunch(
  input: NativeObserverLaunchInput,
): SandboxLaunch | null {
  try {
    const { launch, trustedBwrapPath, trustedHelperPath, correlation } = input;
    const proxyBridge = input.proxyBridge === undefined ? undefined : { ...input.proxyBridge };
    if (
      typeof correlation !== "string" ||
      !/^[a-f0-9]{64}$/.test(correlation) ||
      !canonicalExecutable(trustedBwrapPath) ||
      !canonicalExecutable(trustedHelperPath)
    )
      return null;
    const command = normalizeAgentCommandRequest({
      executable: input.originalCommand.executable,
      args: input.originalCommand.args,
    });
    if (!canonicalExecutable(command.executable) || !command.args.every(lossless)) return null;
    const argv = [launch.executable, ...launch.args];
    if (!argv.every(lossless)) return null;
    const environment = { ...launch.env };
    if (
      Object.entries(environment).some(
        ([name, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          !lossless(value) ||
          unsupportedEnvironment(name, proxyBridge !== undefined),
      )
    )
      return null;
    const descriptor = parseSrtLinuxLaunchDescriptor(argv, trustedBwrapPath);
    if (
      descriptor === null ||
      !descriptor.options.some((option) => option.name === "--unshare-net") ||
      descriptor.options.some(
        (option) =>
          (option.name === "--setenv" || option.name === "--unsetenv") &&
          unsupportedEnvironment(option.operands[0] as string, proxyBridge !== undefined),
      )
    )
      return null;
    let expected = [
      trustedHelperPath,
      "/bin/bash",
      "-c",
      encodePosixCommand(command.executable, command.args),
    ];
    const observerArgs = [
      "--flow-observer-v1",
      correlation,
      "--",
      command.executable,
      ...command.args,
    ];
    let workload = [trustedHelperPath, ...observerArgs];
    if (proxyBridge !== undefined) {
      const { httpSocketPath, socksSocketPath, originalRelayExecutable, trustedRelayExecutable } =
        proxyBridge;
      if (
        !canonicalSocketPath(httpSocketPath) ||
        !canonicalSocketPath(socksSocketPath) ||
        !canonicalExecutable(trustedRelayExecutable) ||
        (originalRelayExecutable !== "socat" && !canonicalExecutable(originalRelayExecutable)) ||
        ![httpSocketPath, socksSocketPath].every((path) =>
          descriptor.options.some(
            (option) =>
              option.name === "--bind" &&
              option.operands[0] === path &&
              option.operands[1] === path,
          ),
        )
      )
        return null;
      const addresses = [
        ["TCP-LISTEN:3128,fork,reuseaddr", `UNIX-CONNECT:${httpSocketPath}`],
        ["TCP-LISTEN:1080,fork,reuseaddr", `UNIX-CONNECT:${socksSocketPath}`],
      ];
      const trap = 'trap "kill %1 %2 2>/dev/null; exit" EXIT';
      const originalScript = [
        ...addresses.map(
          (args) =>
            `${quoteSrtArgv([originalRelayExecutable])} ${args.join(" ")} >/dev/null 2>&1 &`,
        ),
        trap,
        `${quoteSrtArgv([trustedHelperPath])} ${quoteSrtArgv(["/bin/bash", "-c", encodePosixCommand(command.executable, command.args)])}`,
      ].join("\n");
      expected = ["/bin/bash", "-c", originalScript];
      const observerScript = [
        ...addresses.map(
          (args) =>
            `${encodePosixCommand(trustedRelayExecutable, args)} 3>&- 4>&- >/dev/null 2>&1 &`,
        ),
        trap,
        'exec "$@"',
      ].join("\n");
      workload = [
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-c",
        observerScript,
        "flow-observer-bootstrap",
        trustedHelperPath,
        ...observerArgs,
      ];
    }
    if (
      descriptor.innerArgv.length !== expected.length ||
      descriptor.innerArgv.some((value, index) => value !== expected[index])
    )
      return null;
    return Object.freeze({
      executable: trustedBwrapPath,
      args: Object.freeze([
        ...descriptor.options.flatMap((option) => [option.name, ...option.operands]),
        "--",
        ...workload,
      ]),
      env: Object.freeze(environment),
    });
  } catch {
    return null;
  }
}

function lossless(value: string): boolean {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

function canonicalExecutable(value: string): boolean {
  return (
    lossless(value) &&
    !value.endsWith("/") &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    Buffer.byteLength(value, "utf8") <= MAX_AGENT_COMMAND_EXECUTABLE_BYTES
  );
}

function canonicalSocketPath(value: string): boolean {
  return canonicalExecutable(value) && /^\/[A-Za-z0-9_./-]+$/.test(value);
}

function unsupportedEnvironment(name: string, proxyAllowed: boolean): boolean {
  return (
    /^(?:SRT_|ARGV0$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|BASH_FUNC_|LD_|DYLD_)/i.test(name) ||
    (!proxyAllowed && /(?:^|_)PROXY(?:_|$)/i.test(name))
  );
}
