import { execFile as callbackExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { executeLinuxObserverCommand } from "../../src/infrastructure/verification/linux-observer-command.js";
import { runOwnedTest } from "../fixtures/owned-test-scope.js";

const execFile = promisify(callbackExecFile);
const source = fileURLToPath(
  new URL("../fixtures/observer-secondary-group-probe.c", import.meta.url),
);
const denied = "synthetic-denied";
const accessible = "synthetic-accessible";

// Paired evidence gathering under unchanged SRT. This does not select a production
// fixture identity, qualify idmapped mounts, or establish an application-result channel.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "Existing supplementary-group fixture experiment",
  () => {
    it("reproduces primary-group DAC bypass while retaining secondary-group EACCES", async (context) => {
      const retention = new AbortController();
      await runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          const uid = process.getuid?.();
          const gid = process.getgid?.();
          if (
            uid === undefined ||
            gid === undefined ||
            uid === 0 ||
            process.geteuid?.() !== uid ||
            process.getegid?.() !== gid
          )
            throw new Error("Experiment requires an ordinary non-root Linux identity");
          // Exclude the nested root and overflow display numbers so the numeric-ID
          // attack probes cannot accidentally name an ordinary mapped identity.
          const secondary = process
            .getgroups?.()
            .find((value) => value !== gid && value !== 0 && value !== 65534);
          if (secondary === undefined)
            throw new Error(
              "Experiment requires an already-held secondary group distinct from primary, zero, and overflow",
            );
          const root = await scope.temporaryDirectory("flow-secondary-group-");
          const workspace = join(root, "workspace");
          const privateRoot = join(root, "private");
          const inputs = join(privateRoot, "inputs");
          const tools = join(privateRoot, "tools");
          for (const path of [
            workspace,
            privateRoot,
            inputs,
            tools,
            join(workspace, "bind-target"),
          ])
            await mkdir(path, { mode: 0o700 });
          const expectation = join(privateRoot, "expectation.txt");
          await writeFile(expectation, "synthetic-private-expectation", { mode: 0o600 });
          for (const [arm, group] of [
            ["primary", gid],
            ["secondary", secondary],
          ] as const) {
            const directory = join(inputs, arm);
            await mkdir(directory, { mode: 0o700 });
            await mkdir(join(directory, "blocked"), { mode: 0o700 });
            for (const [relative, bytes] of [
              ["denied.txt", denied],
              ["accessible.txt", accessible],
              ["blocked/child.txt", denied],
            ] as const) {
              const path = join(directory, relative);
              await writeFile(path, bytes, { mode: 0o600 });
              await chown(path, uid, group);
            }
            await chown(directory, uid, group);
            await chown(join(directory, "blocked"), uid, group);
            await chmod(join(directory, "denied.txt"), 0);
            await chmod(join(directory, "blocked"), 0);
          }
          const executable = join(tools, "group-probe");
          // Only compile trusted test source; no candidate repository script runs here.
          // A missing compiler is an unsupported-host failure, never a skip or denial.
          try {
            const compiled = await execFile(
              "/usr/bin/gcc",
              ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
              { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384, signal: scope.signal },
            );
            expect(compiled.stderr).toBe("");
          } catch (error) {
            retention.abort(
              new Error("Compiler failure; descendants not independently confirmed settled"),
            );
            throw error;
          }
          const baseline = await inventory(privateRoot);
          for (const [arm, group] of [
            ["primary", gid],
            ["secondary", secondary],
          ] as const) {
            for (const suffix of [
              "",
              "/denied.txt",
              "/accessible.txt",
              "/blocked",
              "/blocked/child.txt",
            ])
              expect(baseline[`inputs/${arm}${suffix}`]).toMatchObject({ uid, gid: group });
          }
          let settled = false;
          let integrity = false;
          let observed: Probe | undefined;
          try {
            for (const arm of ["primary", "secondary"]) {
              await expect(boundedRead(join(inputs, arm, "denied.txt"))).rejects.toMatchObject({
                code: "EACCES",
              });
              await expect(
                boundedRead(join(inputs, arm, "blocked/child.txt")),
              ).rejects.toMatchObject({ code: "EACCES" });
            }
            const result = await executeLinuxObserverCommand({
              command: {
                executable,
                args: [inputs, join(workspace, "bind-target"), String(secondary), expectation],
                timeoutMs: 10_000,
              },
              cwd: workspace,
              protectedPaths: [privateRoot],
              runtimeSupportPaths: [inputs, tools],
              maxOutputBytes: 16_384,
              preparationSettlementMs: 5_000,
              identity: {
                runId: "secondary-group-experiment",
                workflowId: "paired-fixtures",
                nodeId: "probe",
                attempt: 1,
              },
              signal: scope.signal,
            });
            settled = result.kind === "completed";
            if (!settled)
              retention.abort(new Error("Sandbox settlement unsupported; retain experiment"));
            expect(result.kind, JSON.stringify(result)).toBe("completed");
            if (result.outcome?.evidence?.kind !== "command")
              throw new Error("Missing native evidence");
            const evidence = result.outcome.evidence;
            expect(evidence.exitCode, evidence.stderr).toBe(0);
            expect(evidence.stderr).toBe("");
            const output = JSON.parse(evidence.stdout) as Probe;
            expect(output.outerUidMap).toEqual([[uid, uid, 1]]);
            expect(output.nestedUidMap).toEqual([[0, uid, 1]]);
            expect(output.outerGidMap).toEqual([[gid, gid, 1]]);
            expect(output.nestedGidMap).toEqual([[0, gid, 1]]);
            expect(output.namespaceChanged).toBe(true);
            expect(output.mountNamespaceChanged).toBe(true);
            expect(BigInt(`0x${output.capEff}`) & 2n).toBe(2n);
            const message = JSON.stringify(output);
            // Preserve the known-bad primary identity as a required positive bypass control.
            expect(output.primary.before, message).toEqual([0, 0, osConstants.errno.ENOENT, 0]);
            expect(output.secondary.before, message).toEqual([
              osConstants.errno.EACCES,
              osConstants.errno.EACCES,
              osConstants.errno.ENOENT,
              0,
            ]);
            for (const arm of [output.primary, output.secondary]) {
              expect(arm.after, message).toEqual(arm.before);
              expect(arm.chmod, message).toBe(osConstants.errno.EROFS);
              expect(arm.chgrp, message).toBe(osConstants.errno.EROFS);
            }
            expect([osConstants.errno.EACCES, osConstants.errno.ENOENT], message).toContain(
              output.privateRead,
            );
            expect(output.setgroups, message).toBe(osConstants.errno.EPERM);
            expect(output.setresgid, message).toBe(osConstants.errno.EINVAL);
            expect(output.fsgidBefore, message).toBe(0);
            expect(output.fsgidAfter, message).toBe(0);
            expect(output.mapCurrent, message).toBe(0);
            expect(output.mapSecondary, message).toBe(osConstants.errno.EPERM);
            expect(output.mapOverflow, message).toBe(osConstants.errno.EPERM);
            expect(output.setnsUser, message).toBe(osConstants.errno.EPERM);
            expect(output.setnsMount, message).toBe(osConstants.errno.EPERM);
            expect(output.bind, message).toBe(0);
            expect(output.remount, message).toBe(osConstants.errno.EPERM);
            expect(output.secondary.fileGid, message).toBe(65534);
            expect(output.primary.fileGid, message).toBe(0);
            expect(output.secondary.outerFileGid, message).toBe(65534);
            expect(output.primary.outerFileGid, message).toBe(gid);
            expect(output.aliasPrimary, message).toEqual(output.primary.before);
            expect(output.aliasSecondary, message).toEqual(output.secondary.before);
            observed = output;
          } finally {
            if (!settled) retention.abort(new Error("Sandbox execution not confirmed settled"));
            if (settled) {
              try {
                expect(await inventory(privateRoot, baseline)).toEqual(baseline);
                expect(await boundedRead(expectation)).toBe("synthetic-private-expectation");
                integrity = true;
              } finally {
                if (!integrity) retention.abort(new Error("Fixture identity unconfirmed"));
              }
            }
            if (settled && integrity) {
              for (const arm of ["primary", "secondary"]) {
                await chmod(join(inputs, arm, "blocked"), 0o700);
                await chmod(join(inputs, arm, "denied.txt"), 0o600);
              }
            }
          }
          if (observed === undefined) throw new Error("Missing paired observation");
          const summary = JSON.stringify({
            experiment: "held-secondary-group",
            primaryGid: gid,
            secondaryGid: secondary,
            outerUidMap: observed.outerUidMap,
            outerGidMap: observed.outerGidMap,
            nestedUidMap: observed.nestedUidMap,
            nestedGidMap: observed.nestedGidMap,
            primary: observed.primary,
            secondary: observed.secondary,
            aliasPrimary: observed.aliasPrimary,
            aliasSecondary: observed.aliasSecondary,
            attempts: {
              setgroups: observed.setgroups,
              setresgid: observed.setresgid,
              fsgidBefore: observed.fsgidBefore,
              fsgidAfter: observed.fsgidAfter,
              mapCurrent: observed.mapCurrent,
              mapSecondary: observed.mapSecondary,
              mapOverflow: observed.mapOverflow,
              setnsUser: observed.setnsUser,
              setnsMount: observed.setnsMount,
              bind: observed.bind,
              remount: observed.remount,
            },
            fixtureIdentityUnchanged: true,
            idmappedMountQualified: false,
            observerQualified: false,
          });
          if (Buffer.byteLength(summary) > 8192)
            throw new Error("Experiment summary exceeded bound");
          process.stdout.write(`${summary}\n`);
        },
      );
    }, 30_000);
  },
);

interface Arm {
  before: number[];
  after: number[];
  chmod: number;
  chgrp: number;
  fileGid: number;
  outerFileGid: number;
}
interface Probe {
  outerUidMap: number[][];
  nestedUidMap: number[][];
  outerGidMap: number[][];
  nestedGidMap: number[][];
  namespaceChanged: boolean;
  mountNamespaceChanged: boolean;
  capEff: string;
  primary: Arm;
  secondary: Arm;
  aliasPrimary: number[];
  aliasSecondary: number[];
  privateRead: number;
  setgroups: number;
  setresgid: number;
  fsgidBefore: number;
  fsgidAfter: number;
  mapCurrent: number;
  mapSecondary: number;
  mapOverflow: number;
  setnsUser: number;
  setnsMount: number;
  bind: number;
  remount: number;
}
type Entry = {
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  mode: number;
  type: "directory" | "file";
  sha256?: string;
  children?: string[];
};

async function boundedRead(path: string): Promise<string> {
  return (await boundedBytes(path, 4096)).toString("utf8");
}

async function boundedBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Synthetic fixture exceeded bound");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function inventory(
  root: string,
  baseline?: Record<string, Entry>,
): Promise<Record<string, Entry>> {
  const result: Record<string, Entry> = {};
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 4 || Object.keys(result).length >= 32)
      throw new Error("Fixture inventory exceeded bound");
    const path = relative === "." ? root : join(root, relative);
    const info = await lstat(path, { bigint: true });
    if ((!info.isDirectory() && !info.isFile()) || (await realpath(path)) !== path)
      throw new Error("Unexpected fixture type");
    const entry: Entry = {
      dev: String(info.dev),
      ino: String(info.ino),
      uid: Number(info.uid),
      gid: Number(info.gid),
      mode: Number(info.mode),
      type: info.isDirectory() ? "directory" : "file",
    };
    if (baseline !== undefined) {
      const expected = baseline[relative];
      if (expected === undefined) throw new Error("Unexpected fixture entry");
      expect(entry).toEqual({
        dev: expected.dev,
        ino: expected.ino,
        uid: expected.uid,
        gid: expected.gid,
        mode: expected.mode,
        type: expected.type,
      });
    }
    result[relative] = entry;
    const originalMode = entry.mode & 0o777;
    // Observe original ownership/mode/identity BEFORE restoring access for bounded inspection.
    if (originalMode === 0) await chmod(path, info.isDirectory() ? 0o700 : 0o600);
    try {
      if (info.isDirectory()) {
        entry.children = (await readdir(path)).sort();
        for (const child of entry.children)
          await visit(relative === "." ? child : `${relative}/${child}`, depth + 1);
      } else
        entry.sha256 = createHash("sha256")
          .update(await boundedBytes(path, 4_194_304))
          .digest("hex");
    } finally {
      if (originalMode === 0) await chmod(path, originalMode);
    }
  };
  await visit(".", 0);
  return result;
}
