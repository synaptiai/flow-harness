import { type ChildProcess, execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { NodeExecutionOutcome } from "../../src/application/ports.js";
import { CommandNodeExecutor } from "../../src/infrastructure/process/command-node-executor.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const execFile = promisify(execFileCallback);
const linuxTarget = process.platform === "linux" && process.arch === "x64";
const macosDiagnostic =
  process.platform === "darwin" && process.env.FLOW_VERIFIER_ISOLATION_DIAGNOSTIC === "1";
const suiteLabel = macosDiagnostic
  ? "macOS diagnostic only: native verification observer isolation prerequisites"
  : "Linux x64 verification observer isolation prerequisites (qualification pending)";
const CHILD_LIFETIME_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;

// These are prerequisites for a future protected observer, not qualification of a
// behavioral classifier. Unsupported sandbox preparation must fail, not count as isolation.
// macOS reproductions are opt-in diagnostics, never evidence of Linux or adapter qualification.
describe.skipIf(!linuxTarget && !macosDiagnostic)(suiteLabel, () => {
  it.each([
    { name: "ordinary", detached: false },
    { name: "new-session", detached: true },
  ])(
    "settles normal exit only after the $name descendant stops",
    async ({ detached }) => {
      await withFixture(async (fixture) => {
        const helper = join(fixture.workspace, "descendant.mjs");
        const heartbeat = join(fixture.workspace, "heartbeat.jsonl");
        const stop = join(fixture.workspace, "stop");
        const releaseParent = join(fixture.workspace, "release-parent");
        await writeFile(helper, descendantSource(heartbeat, stop));
        fixture.descendantCommand = `${process.execPath} ${helper} ${fixture.token}`;

        const script = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, [${JSON.stringify(helper)}, ${JSON.stringify(fixture.token)}], {
          detached: ${detached}, stdio: "ignore"
        });
        const deadline = Date.now() + 4000;
        child.once("error", () => process.exit(71));
        const check = setInterval(() => {
          let lines = [];
          try { lines = fs.readFileSync(${JSON.stringify(heartbeat)}, "utf8").trim().split("\\n"); } catch {}
          if (lines.length >= 2 && fs.existsSync(${JSON.stringify(releaseParent)})) {
            clearInterval(check);
            child.unref();
            process.stdout.write(JSON.stringify({ ready: true, token: ${JSON.stringify(fixture.token)} }));
          } else if (Date.now() >= deadline) {
            process.exit(72);
          }
        }, 10);
      `;

        let settled = false;
        const execution = executeCandidate(fixture, script);
        void execution.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        let outcome: NodeExecutionOutcome;
        try {
          const readinessDeadline = Date.now() + 5_000;
          while (true) {
            const observed = await readFile(heartbeat, "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "";
                throw error;
              },
            );
            if (observed.trim().split("\n").filter(Boolean).length >= 2) break;
            if (settled) {
              successfulEvidence(await execution);
              throw new Error("Candidate settled before descendant readiness");
            }
            if (Date.now() >= readinessDeadline)
              throw new Error("Descendant readiness was not observed");
            await delay(10);
          }
          // Positive control for the host identity check, not a candidate-reported namespace PID.
          fixture.descendantHostPids = await ownedDescendantPids(fixture.descendantCommand);
          expect(fixture.descendantHostPids).toHaveLength(1);
          await writeFile(releaseParent, "release");
          outcome = await execution;
        } finally {
          await writeFile(releaseParent, "release");
          await execution.catch(() => undefined);
        }
        const evidence = successfulEvidence(outcome);
        expect(JSON.parse(evidence.stdout)).toEqual({ ready: true, token: fixture.token });
        const before = await readFile(heartbeat, "utf8");
        expect(before.trim().split("\n").length).toBeGreaterThanOrEqual(2);
        expect(
          Date.now() - JSON.parse(before.trim().split("\n")[0] as string).startedAt,
        ).toBeLessThan(CHILD_LIFETIME_MS - 1_000);

        // A fresh host observation after settlement detects work crossing the stage boundary.
        await delay(250);
        const after = await readFile(heartbeat, "utf8");
        const survivors = await ownedDescendantPids(
          fixture.descendantCommand,
          fixture.descendantHostPids,
        );
        expect({ heartbeatContinued: after !== before, survivors }).toEqual({
          heartbeatContinued: false,
          survivors: [],
        });
      });
    },
    30_000,
  );

  it("denies private verifier files and does not inherit an open verifier descriptor", async () => {
    await withFixture(async (fixture) => {
      const canary = join(fixture.verifier, "canary.txt");
      const alias = join(fixture.workspace, "verifier-alias");
      const attemptedWrite = join(fixture.verifier, "candidate-write.txt");
      const value = `synthetic-verifier-canary-${fixture.token}`;
      await writeFile(canary, value, { mode: 0o600 });
      await symlink(canary, alias);
      const descriptor = await open(canary, "r");

      try {
        const identity = await descriptor.stat();
        const control = Buffer.alloc(Buffer.byteLength(value));
        await descriptor.read(control, 0, control.byteLength, 0);
        expect(control.toString("utf8")).toBe(value);
        const script = `
          const fs = require("node:fs");
          const result = { directRead: false, aliasRead: false, privateWrite: false, inheritedDescriptor: false, workspaceWrite: false };
          try { fs.readFileSync(${JSON.stringify(canary)}); result.directRead = true; } catch {}
          try { fs.readFileSync(${JSON.stringify(alias)}); result.aliasRead = true; } catch {}
          try { fs.writeFileSync(${JSON.stringify(attemptedWrite)}, "tampered"); result.privateWrite = true; } catch {}
          const expected = { dev: ${identity.dev}, ino: ${identity.ino} };
          const matches = stat => stat.dev === expected.dev && stat.ino === expected.ino;
          for (const fd of new Set([${descriptor.fd}, ...Array.from({ length: 64 }, (_, index) => index)])) {
            try { if (matches(fs.fstatSync(fd))) result.inheritedDescriptor = true; } catch {}
          }
          for (const path of ["/dev/fd/${descriptor.fd}", "/proc/self/fd/${descriptor.fd}"]) {
            let fd;
            try {
              fd = fs.openSync(path, "r");
              if (matches(fs.fstatSync(fd))) result.inheritedDescriptor = true;
            } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
          }
          fs.writeFileSync("ordinary.txt", "allowed"); result.workspaceWrite = true;
          process.stdout.write(JSON.stringify(result));
        `;

        const evidence = successfulEvidence(await executeCandidate(fixture, script));
        expect(JSON.parse(evidence.stdout)).toEqual({
          directRead: false,
          aliasRead: false,
          // Linux can write its private ephemeral mask, not the protected host directory.
          // The unchanged host canary and absent host write below establish that distinction.
          privateWrite: process.platform === "linux",
          inheritedDescriptor: false,
          workspaceWrite: true,
        });
        await expect(readFile(canary, "utf8")).resolves.toBe(value);
        await expect(readFile(attemptedWrite)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(fixture.workspace, "ordinary.txt"), "utf8")).resolves.toBe(
          "allowed",
        );
      } finally {
        await descriptor.close();
      }
    });
  }, 30_000);

  it.skipIf(!linuxTarget)(
    "cannot reach a host verifier process through the candidate proc view",
    async () => {
      await withFixture(async (fixture) => {
        const canary = join(fixture.verifier, "process-canary.txt");
        const ready = join(fixture.verifier, "process-ready.txt");
        await writeFile(canary, `synthetic-${fixture.token}`, { mode: 0o600 });
        const host = spawn(
          process.execPath,
          [
            "-e",
            `
        const fs = require("node:fs");
        const fd = fs.openSync(${JSON.stringify(canary)}, "r");
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ fd }));
        setInterval(() => {}, 1000);
        setTimeout(() => process.exit(0), 20000);
      `,
            fixture.token,
          ],
          {
            cwd: fixture.verifier,
            env: { PATH: "/usr/bin:/bin", FLOW_VERIFIER_CANARY: fixture.token },
            stdio: "ignore",
          },
        );
        const hostClosed = new Promise<void>((resolve, reject) => {
          host.once("error", reject);
          host.once("close", () => resolve());
        });
        void hostClosed.catch(() => undefined);

        try {
          if (host.pid === undefined) throw new Error("Host verifier fixture did not start");
          const readinessDeadline = Date.now() + 5_000;
          while (
            !(await readFile(ready, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            }))
          ) {
            if (
              host.exitCode !== null ||
              host.signalCode !== null ||
              Date.now() >= readinessDeadline
            ) {
              throw new Error("Host verifier fixture did not become ready");
            }
            await delay(10);
          }
          const procRoot = `/proc/${host.pid}`;
          const hostDescriptor: unknown = JSON.parse(await readFile(ready, "utf8")).fd;
          if (
            typeof hostDescriptor !== "number" ||
            !Number.isSafeInteger(hostDescriptor) ||
            hostDescriptor < 0
          ) {
            throw new Error("Host verifier descriptor identity is invalid");
          }
          const canaryIdentity = await stat(canary);
          const descriptorIdentity = await stat(`${procRoot}/fd/${hostDescriptor}`);
          expect({ dev: descriptorIdentity.dev, ino: descriptorIdentity.ino }).toEqual({
            dev: canaryIdentity.dev,
            ino: canaryIdentity.ino,
          });
          expect(await readFile(`${procRoot}/cmdline`, "utf8")).toContain(fixture.token);
          expect(await readFile(`${procRoot}/environ`, "utf8")).toContain(
            `FLOW_VERIFIER_CANARY=${fixture.token}`,
          );
          const script = `
          const fs = require("node:fs");
          const result = { hostProcessVisible: false, hostEnvironmentReadable: false, hostDescriptorReachable: false };
          const root = ${JSON.stringify(procRoot)};
          // Each channel is checked independently. Match owned canary identities so a
          // namespace-local process with the same numeric PID is not called the host verifier.
          try {
            const command = fs.readFileSync(root + "/cmdline", "utf8");
            result.hostProcessVisible = command.split("\\0").filter(Boolean).at(-1) === ${JSON.stringify(fixture.token)};
          } catch {}
          try {
            const environment = fs.readFileSync(root + "/environ", "utf8");
            result.hostEnvironmentReadable = environment.split("\\0").includes(${JSON.stringify(`FLOW_VERIFIER_CANARY=${fixture.token}`)});
          } catch {}
          try {
            const identity = fs.statSync(root + "/fd/${hostDescriptor}");
            result.hostDescriptorReachable = identity.dev === ${canaryIdentity.dev} && identity.ino === ${canaryIdentity.ino};
          } catch {}
          process.stdout.write(JSON.stringify(result));
        `;
          const evidence = successfulEvidence(await executeCandidate(fixture, script));
          expect(JSON.parse(evidence.stdout)).toEqual({
            hostProcessVisible: false,
            hostEnvironmentReadable: false,
            hostDescriptorReachable: false,
          });
          expect(host.exitCode).toBeNull();
          expect(host.signalCode).toBeNull();
          await expect(readFile(canary, "utf8")).resolves.toBe(`synthetic-${fixture.token}`);
        } finally {
          fixture.hostCleanupUnconfirmed = true;
          await stopOwnedHost(host, hostClosed);
          fixture.hostCleanupUnconfirmed = false;
        }
      });
    },
    30_000,
  );

  it("retains a forged passed observation as data without changing a failed command outcome", async () => {
    await withFixture(async (fixture) => {
      const forged = JSON.stringify({
        version: 1,
        kind: "verification-observation",
        outcome: "passed",
        assertionId: fixture.token,
      });
      const outcome = await executeCandidate(
        fixture,
        `process.stdout.write(${JSON.stringify(forged)}); process.exitCode = 7;`,
      );
      // No behavioral observer exists yet. This only proves that command settlement
      // does not promote candidate JSON into process success or trusted classification.
      expect(outcome).toMatchObject({
        status: "failed",
        error: { code: "command_failed" },
        evidence: {
          kind: "command",
          exitCode: 7,
          stdout: forged,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          signal: null,
          timedOut: false,
          aborted: false,
        },
      });
    });
  }, 30_000);
});

interface Fixture {
  readonly token: string;
  readonly root: string;
  readonly workspace: string;
  readonly verifier: string;
  descendantCommand?: string;
  descendantHostPids?: number[];
  hostCleanupUnconfirmed?: boolean;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-verifier-isolation-")));
  const fixture: Fixture = {
    root,
    token: randomUUID(),
    workspace: join(root, "workspace"),
    verifier: join(root, "verifier"),
  };
  await mkdir(fixture.workspace, { mode: 0o700 });
  await mkdir(fixture.verifier, { mode: 0o700 });

  const failures: unknown[] = [];
  try {
    await run(fixture);
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanupFixture(fixture);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Probe and owned cleanup failed");
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  if (fixture.hostCleanupUnconfirmed) {
    throw new Error(`Host verifier cleanup is unconfirmed; retained fixture ${fixture.root}`);
  }
  // Never signal candidate-reported PIDs: Linux namespace PIDs are not host identities.
  // This owned helper honors a stop file and also exits at its fixed hard lifetime.
  await writeFile(join(fixture.workspace, "stop"), "stop");
  if (fixture.descendantCommand !== undefined) {
    const deadline = Date.now() + CHILD_LIFETIME_MS + 2_000;
    while (
      (await ownedDescendantPids(fixture.descendantCommand, fixture.descendantHostPids)).length > 0
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Owned descendant cleanup is unconfirmed; retained fixture ${fixture.root}`,
        );
      }
      await delay(25);
    }
  }
  await rm(fixture.root, { recursive: true, force: true });
}

async function executeCandidate(fixture: Fixture, script: string): Promise<NodeExecutionOutcome> {
  const executor = new CommandNodeExecutor({
    sandbox: createProductionCommandSandbox("native", fixture.workspace),
    preparationSettlementMs: 5_000,
  });
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), COMMAND_TIMEOUT_MS + 1_000);
  try {
    return await executor.execute(
      {
        id: "candidate",
        type: "command",
        dependsOn: [],
        command: {
          executable: process.execPath,
          args: ["-e", script],
          timeoutMs: COMMAND_TIMEOUT_MS,
        },
      },
      {
        runId: `isolation-${fixture.token}`,
        workflowId: "verification-observer-isolation",
        attempt: 1,
        cwd: fixture.workspace,
        projectRoot: fixture.workspace,
        protectedPaths: [fixture.verifier],
        signal: cancellation.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function successfulEvidence(outcome: NodeExecutionOutcome) {
  expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
  if (outcome.evidence?.kind !== "command") throw new Error("Missing real command evidence");
  expect(outcome.evidence.sandbox).toMatchObject({
    backend: "anthropic-sandbox-runtime",
    backendVersion: "0.0.70",
    profile: "workspace-write-network-deny-v1",
  });
  expect(outcome.evidence).toMatchObject({
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stderr: "",
  });
  return outcome.evidence;
}

async function ownedDescendantPids(
  command: string,
  observedHostPids: readonly number[] = [],
): Promise<number[]> {
  const result = await execFile("/bin/ps", ["-axo", "pid=,command="], {
    timeout: 2_000,
    maxBuffer: 2 * 1_024 * 1_024,
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
  });
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const pid = Number(match[1]);
    // A Linux zombie may lose its argv. Retain the positively observed host PID,
    // rather than treating a changed/empty command as proof of descendant absence.
    return match[2] === command || observedHostPids.includes(pid) ? [pid] : [];
  });
}

async function stopOwnedHost(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const boundedWait = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error("Owned host verifier cleanup is unconfirmed")),
      3_000,
    );
  });
  try {
    await Promise.race([closed, boundedWait]);
  } finally {
    clearTimeout(escalation);
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

function descendantSource(heartbeat: string, stop: string): string {
  return `
    import { appendFileSync, existsSync } from "node:fs";
    const token = process.argv[2];
    const startedAt = Date.now();
    let sequence = 0;
    const pulse = () => {
      if (existsSync(${JSON.stringify(stop)}) || Date.now() - startedAt >= ${CHILD_LIFETIME_MS}) process.exit(0);
      appendFileSync(${JSON.stringify(heartbeat)}, JSON.stringify({ token, startedAt, sequence: sequence++ }) + "\\n");
    };
    setTimeout(() => process.exit(0), ${CHILD_LIFETIME_MS});
    pulse();
    setInterval(pulse, 25);
  `;
}
