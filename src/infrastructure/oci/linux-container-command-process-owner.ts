import { readFile } from "node:fs/promises";

import {
  type ContainerCommandIntent,
  type ContainerCommandProcessOwner,
  parseContainerCommandProcessOwner,
} from "./container-command-intent.js";

const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,31}$/;

export async function readLinuxContainerCommandProcessOwner(): Promise<
  ContainerCommandIntent["owner"]
> {
  const [bootId, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/proc/self/stat", "utf8"),
  ]);
  return parseLinuxContainerCommandProcessOwner(bootId, stat, process.pid);
}

export interface LinuxContainerCommandProcessObservation {
  readonly readBootId: () => Promise<string>;
  readonly readStat: (pid: number) => Promise<string>;
}

export async function isLinuxContainerCommandProcessOwnerAlive(
  ownerInput: ContainerCommandProcessOwner,
  observation: LinuxContainerCommandProcessObservation = {
    readBootId: () => readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readStat: (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
  },
): Promise<boolean> {
  const owner = parseContainerCommandProcessOwner(ownerInput);
  const bootIdSource = await observation.readBootId();
  const bootId = singleLine(bootIdSource);
  if (!BOOT_ID_PATTERN.test(bootId)) {
    throw new Error("Linux container command boot identity is invalid");
  }
  if (bootId !== owner.bootId) {
    return false;
  }
  let stat: string;
  try {
    stat = await observation.readStat(owner.pid);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const current = parseLinuxContainerCommandProcessOwner(bootIdSource, stat, owner.pid);
  return current.startTicks === owner.startTicks;
}

export function parseLinuxContainerCommandProcessOwner(
  bootIdSource: string,
  statSource: string,
  expectedPid: number,
): ContainerCommandIntent["owner"] {
  const bootId = singleLine(bootIdSource);
  const stat = singleLine(statSource);
  const firstSpace = stat.indexOf(" ");
  const commandEnd = stat.lastIndexOf(")");
  const pid = Number(stat.slice(0, firstSpace));
  const fields = commandEnd < 0 ? [] : stat.slice(commandEnd + 2).split(" ");
  const startTicks = fields[19];
  if (
    !BOOT_ID_PATTERN.test(bootId) ||
    !Number.isSafeInteger(expectedPid) ||
    expectedPid <= 0 ||
    pid !== expectedPid ||
    firstSpace <= 0 ||
    stat[firstSpace + 1] !== "(" ||
    commandEnd <= firstSpace + 1 ||
    fields.length < 20 ||
    startTicks === undefined ||
    !START_TICKS_PATTERN.test(startTicks)
  ) {
    throw new Error("Linux container command process identity is invalid");
  }
  return Object.freeze({ bootId, pid, startTicks });
}

function singleLine(source: string): string {
  return source.endsWith("\n") ? source.slice(0, -1) : source;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
