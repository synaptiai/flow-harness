#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MINIMUM_NODE_VERSION = Object.freeze([26, 7, 0] as const);
const NODE_REQUIREMENT_MESSAGE = "Flow requires Node.js 26.7.0 or newer.";
const PLATFORM_REQUIREMENT_MESSAGE = "Flow supports Linux and macOS.";

interface FlowCliModule {
  readonly runDirectCli: (args: readonly string[]) => Promise<void>;
}

interface FlowLauncherOptions {
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly loadCli?: () => Promise<FlowCliModule>;
  readonly stderr?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export async function runFlowLauncher(
  args: readonly string[],
  options: FlowLauncherOptions = {},
): Promise<void> {
  const stderr = options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  const setExitCode = options.setExitCode ?? ((code) => (process.exitCode = code));
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    stderr(PLATFORM_REQUIREMENT_MESSAGE);
    setExitCode(1);
    return;
  }

  const nodeVersion = parseNodeVersion(options.nodeVersion ?? process.versions.node);
  if (nodeVersion === undefined || compareVersion(nodeVersion, MINIMUM_NODE_VERSION) < 0) {
    stderr(NODE_REQUIREMENT_MESSAGE);
    setExitCode(1);
    return;
  }

  const loadCli = options.loadCli ?? (async () => await import("./main.js"));
  const cli = await loadCli();
  await cli.runDirectCli(args);
}

function parseNodeVersion(source: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(source);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const majorDifference = left[0] - right[0];
  if (majorDifference !== 0) {
    return majorDifference;
  }
  const minorDifference = left[1] - right[1];
  if (minorDifference !== 0) {
    return minorDifference;
  }
  return left[2] - right[2];
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
