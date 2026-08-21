#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createUnsupportedHostEnvironmentDoctorReport,
  type EnvironmentDoctorTarget,
} from "../application/environment-doctor.js";
import { isFlowHostSupported } from "../domain/host-requirements.js";

const NODE_REQUIREMENT_MESSAGE = "Flow requires Node.js 26.7.0 or newer.";
const PLATFORM_REQUIREMENT_MESSAGE = "Flow supports Linux and macOS.";

interface FlowCliModule {
  readonly runDirectCli: (args: readonly string[]) => Promise<void>;
}

interface FlowLauncherOptions {
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly loadCli?: () => Promise<FlowCliModule>;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export async function runFlowLauncher(
  args: readonly string[],
  options: FlowLauncherOptions = {},
): Promise<void> {
  const stderr = options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  const stdout = options.stdout ?? ((message) => process.stdout.write(`${message}\n`));
  const setExitCode = options.setExitCode ?? ((code) => (process.exitCode = code));
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const doctorTarget = parseDoctorTarget(args);
  if (platform !== "darwin" && platform !== "linux") {
    if (doctorTarget !== undefined) {
      stdout(
        JSON.stringify(
          createUnsupportedHostEnvironmentDoctorReport(doctorTarget, platform, nodeVersion),
          null,
          2,
        ),
      );
      setExitCode(1);
      return;
    }
    stderr(PLATFORM_REQUIREMENT_MESSAGE);
    setExitCode(1);
    return;
  }

  if (
    !isFlowHostSupported({
      platform,
      nodeVersion,
    })
  ) {
    if (doctorTarget !== undefined) {
      stdout(
        JSON.stringify(
          createUnsupportedHostEnvironmentDoctorReport(doctorTarget, platform, nodeVersion),
          null,
          2,
        ),
      );
      setExitCode(1);
      return;
    }
    stderr(NODE_REQUIREMENT_MESSAGE);
    setExitCode(1);
    return;
  }

  const loadCli = options.loadCli ?? (async () => await import("./main.js"));
  const cli = await loadCli();
  await cli.runDirectCli(args);
}

function parseDoctorTarget(args: readonly string[]): EnvironmentDoctorTarget | undefined {
  if (args[0] !== "doctor") {
    return undefined;
  }
  if (args.length === 1) {
    return "project";
  }
  if (args.length === 2 && args[1]?.startsWith("-") === false) {
    return "workflow";
  }
  if (
    (args.length === 3 && args[1] === "--profile" && args[2] === "prime-agent") ||
    (args.length === 2 && args[1] === "--profile=prime-agent")
  ) {
    return "prime-agent";
  }
  return undefined;
}

function isDirectEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1])) {
  await runFlowLauncher(process.argv.slice(2));
}
