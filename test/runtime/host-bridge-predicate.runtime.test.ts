import { execFile as callbackExecFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { type BridgeCheck, bridgeSettled } from "./helpers/host-bridge-probe.js";
import type { CheckRecord } from "./helpers/native-observer-host-probe.js";
import {
  calibrateZombie,
  type ZombieObservations,
} from "./helpers/native-observer-zombie-control.js";

const guardian = process.env.FLOW_TEST_HOST_BRIDGE_GUARDIAN;
const enabled = process.platform === "linux" && process.arch === "x64" && guardian !== undefined;
const execFile = promisify(callbackExecFile);
const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

describe.skipIf(!enabled)("bridge settlement predicate against real kernel observations", () => {
  let root: string;
  let parentExecutable: string;
  let probeExecutable: string;
  beforeAll(async () => {
    // Retain the owned binaries and directory, including on uncertain cleanup.
    root = await mkdtemp(join(await realpath(tmpdir()), "flow-bridge-predicate-"));
    parentExecutable = join(root, "zombie-parent");
    probeExecutable = join(root, "host-process");
    const signal = AbortSignal.timeout(12_000);
    for (const [source, executable] of [
      ["native-observer-zombie-parent.c", parentExecutable],
      ["native-observer-host-process.c", probeExecutable],
    ] as const) {
      signal.throwIfAborted();
      const compiled = await execFile(
        "/usr/bin/cc",
        [
          "-static",
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pedantic",
          fileURLToPath(new URL(`../fixtures/${source}`, import.meta.url)),
          "-o",
          executable,
        ],
        { cwd: root, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8192, signal },
      );
      expect(compiled.stdout).toBe("");
      expect(compiled.stderr).toBe("");
    }
  }, 15_000);

  it("rejects unreaped zombies in either role even when a termination-only predicate accepts", async (context) => {
    if (guardian === undefined || !guardian.startsWith("/"))
      throw new Error("Explicit guardian path required for bridge qualification controls");
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Host UID unavailable");
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
    try {
      const collect = async (): Promise<ZombieObservations> => {
        let observed: ZombieObservations | undefined;
        await calibrateZombie({
          parentExecutable,
          probeExecutable,
          uid,
          env,
          cwd: root,
          signal,
          onObserved: (value) => {
            if (observed !== undefined) throw new Error("Duplicate zombie calibration callback");
            observed = value;
          },
        });
        if (observed === undefined) throw new Error("Missing joined zombie observations");
        return observed;
      };
      const leader = await collect();
      const connection = await collect();
      signal.throwIfAborted();

      // Each field below comes unchanged from the real oracle. These are replayed
      // snapshots from two independent live -> zombie -> reaped calibrations,
      // not a claim that these host children formed an actual bridge topology.
      expect(bridgeSettled(pair(leader.live, connection.live))).toBe(false);
      expect(bridgeSettled(pair(leader.live, connection.reaped))).toBe(false);
      expect(bridgeSettled(pair(leader.reaped, connection.live))).toBe(false);
      for (const record of [
        pair(leader.zombie, connection.reaped),
        pair(leader.reaped, connection.zombie),
        pair(leader.zombie, connection.zombie),
      ]) {
        const terminationOnly = [record.leader, record.connection].every(
          (value) => value.pidfdTerminated,
        );
        expect(
          terminationOnly,
          "The deliberately weak predicate accepts actual unreaped data",
        ).toBe(true);
        expect(bridgeSettled(record), "The actual bridge predicate must reject unreaped data").toBe(
          false,
        );
      }
      expect(bridgeSettled(pair(leader.reaped, connection.reaped))).toBe(true);
      signal.throwIfAborted();
    } catch (error) {
      throw new AggregateError([error], `Bridge predicate calibration failed; retained ${root}`);
    }
  }, 20_000);
});

function pair(leader: CheckRecord, connection: CheckRecord): BridgeCheck {
  const observation = (record: CheckRecord): BridgeCheck["leader"] => ({
    pidfdTerminated: record.pidfdTerminated,
    originalIdentityAbsent: record.originalIdentityAbsent,
    procState: record.procState,
  });
  return {
    event: "bridge-check",
    leader: observation(leader),
    connection: observation(connection),
  };
}
