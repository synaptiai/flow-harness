import { posix } from "node:path";

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
}

/** Pure, observer-only transformation of an already admitted SRT launch.
 * This does not authenticate the supplied backend or artifact paths, open the
 * admitted ELF, transfer descriptors, execute a process, or establish custody.
 * The caller must reserve FD 3 for the protected result and FD 4 for the admitted
 * ELF through inherited descriptors. Bubblewrap 0.9.0 needs no preservation
 * option; real Linux inheritance and protected-channel qualification remain
 * open. The original command envelope bounds application arguments, not SRT's
 * independently admitted mount inventory or its shell-quoting expansion.
 * The accepted no-proxy preparation profile is NOT produced by the current
 * production SRT manager: its initialized Linux bridge emits proxy environment
 * and a socat/trap workload even with an empty domain allowlist. Such launches
 * remain unsupported; this function must not strip that policy or be wired into
 * production until an explicit compatible preparation profile is qualified.
 */
export function rewriteNativeObserverLaunch(
  input: NativeObserverLaunchInput,
): SandboxLaunch | null {
  try {
    const { launch, trustedBwrapPath, trustedHelperPath, correlation } = input;
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
          unsupportedEnvironment(name),
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
          unsupportedEnvironment(option.operands[0] as string),
      )
    )
      return null;
    const expected = [
      trustedHelperPath,
      "/bin/bash",
      "-c",
      encodePosixCommand(command.executable, command.args),
    ];
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
        trustedHelperPath,
        "--flow-observer-v1",
        correlation,
        "--",
        command.executable,
        ...command.args,
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
    value !== "/" &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    Buffer.byteLength(value, "utf8") <= MAX_AGENT_COMMAND_EXECUTABLE_BYTES
  );
}

function unsupportedEnvironment(name: string): boolean {
  return /^(?:SRT_|ARGV0$)|(?:^|_)PROXY(?:_|$)/i.test(name);
}
