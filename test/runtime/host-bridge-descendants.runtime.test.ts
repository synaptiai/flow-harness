import {
  execFile as callbackExecFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BridgeCheck,
  BridgeDiscoveryRejection,
  type BridgeProbe,
  bridgeSettled as settled,
  createBridgeProbe,
} from "./helpers/host-bridge-probe.js";

const guardian = process.env.FLOW_TEST_HOST_BRIDGE_GUARDIAN;
const enabled = process.platform === "linux" && process.arch === "x64" && guardian !== undefined;
const execFile = promisify(callbackExecFile);
const ownedRecord = "FLOW_HOST_BRIDGE_V1 OWNED\n";
const completeRecords = `${ownedRecord}FLOW_HOST_BRIDGE_V1 SETTLED\n`;

describe.skipIf(!enabled)("host bridge active-descendant settlement", () => {
  let probeExecutable: string;
  beforeAll(async () => {
    const signal = AbortSignal.timeout(10_000);
    const root = await mkdtemp(join(await realpath(tmpdir()), "flow-bridge-probe-"));
    probeExecutable = join(root, "host-process");
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
        fileURLToPath(new URL("../fixtures/native-observer-host-process.c", import.meta.url)),
        "-o",
        probeExecutable,
      ],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
        signal,
      },
    );
    expect(compiled.stdout).toBe("");
    expect(compiled.stderr).toBe("");
  });

  it.for(["settlement", "argument-mismatch", "ambiguous"] as const)(
    "checks real bridge %s before test socket cleanup",
    async (mode, context) => {
      if (guardian === undefined || !guardian.startsWith("/"))
        throw new Error("Explicit guardian path required");
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("Host UID unavailable");
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
      const root = await mkdtemp(join(await realpath(tmpdir()), "flow-bridge-live-"));
      const path = join(root, "bridge.sock");
      const relay = await realpath("/usr/bin/socat");
      const connections = new Set<Socket>();
      const server = createServer((socket) => {
        connections.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => connections.delete(socket));
        socket.pipe(socket);
      });
      let child: ChildProcessWithoutNullStreams | undefined;
      let ownerClose: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      let ownerClosed = false;
      let client: Socket | undefined;
      let secondClient: Socket | undefined;
      let probe: BridgeProbe | undefined;
      let output = "";
      let stderr = "";
      let overflow = false;
      let processError: Error | undefined;
      let releaseIssued = false;
      let receiptSeen = false;
      const ownedReceipt = deferred<void>();
      const receiptCheck = deferred<BridgeCheck>();
      // Retain rejection for the assertion without an unhandled rejection when a
      // malformed/early receipt arrives before the test reaches that assertion.
      void receiptCheck.promise.catch(() => undefined);
      const failures: unknown[] = [];
      const recordFailure = (error: unknown): void => {
        if (!failures.includes(error)) failures.push(error);
      };
      server.on("error", recordFailure);
      try {
        signal.throwIfAborted();
        server.listen(0, "127.0.0.1");
        await once(server, "listening", { signal });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No echo server port");
        const args: [string, string] = [
          `UNIX-LISTEN:${path},fork,reuseaddr`,
          `TCP:localhost:${address.port},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
        ];
        signal.throwIfAborted();
        child = spawn(guardian, [relay, ...args], {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", (error) => {
          processError = error;
        });
        child.stdin.on("error", (error) => {
          processError ??= error;
        });
        child.stdout.on("error", (error) => {
          processError ??= error;
        });
        child.stderr.on("error", (error) => {
          processError ??= error;
        });
        child.stderr.on("data", (bytes: Buffer) => {
          if (stderr.length + bytes.length > 4096) overflow = true;
          else stderr += bytes.toString("utf8");
        });
        child.stdout.on("data", (bytes: Buffer) => {
          if (output.length + bytes.length > 256) {
            overflow = true;
            return;
          }
          output += bytes.toString("utf8");
          if (output === ownedRecord) ownedReceipt.resolve();
          if (mode !== "settlement" || output !== completeRecords || receiptSeen) return;
          receiptSeen = true;
          if (!releaseIssued || probe === undefined) {
            receiptCheck.reject(
              new Error("Owner emitted a terminal receipt before observed release"),
            );
            return;
          }
          // Start observation on the line, not on owner close. This is not an
          // atomic receipt-time sample, and never closes either test socket.
          probe.check().then(receiptCheck.resolve, receiptCheck.reject);
        });
        ownerClose = new Promise((resolve) => {
          child?.once("close", (code, signal) => {
            ownerClosed = true;
            resolve({ code, signal });
          });
        });
        if (child.pid === undefined) throw new Error("Guardian has no owned PID");
        client = await connect(path, signal);
        const payload = Buffer.from("flow-bridge-held-connection\n");
        let echoOverflow = false;
        const forward = async (socket: Socket): Promise<void> => {
          let echo = Buffer.alloc(0);
          const forwarded = deferred<void>();
          socket.on("data", (bytes: Buffer) => {
            if (echo.length + bytes.length > payload.length) {
              echoOverflow = true;
              forwarded.reject(new Error("Echo exceeded the fixed payload"));
            } else {
              echo = Buffer.concat([echo, bytes]);
              if (echo.length === payload.length) forwarded.resolve();
            }
          });
          socket.write(payload);
          await requiredWithin(
            forwarded.promise,
            1000,
            "Actual bridge forwarding did not complete",
          );
          expect(echo).toEqual(payload);
        };
        await forward(client);
        expect(client.destroyed).toBe(false);
        expect(connections.size).toBe(1);
        await requiredWithin(ownedReceipt.promise, 1000, "Owner receipt did not arrive");
        expect(output).toBe(ownedRecord);
        expect(ownerClosed).toBe(false);
        if (mode === "ambiguous") {
          secondClient = await connect(path, signal);
          await forward(secondClient);
          expect(secondClient.destroyed).toBe(false);
          expect(connections.size).toBe(2);
        }
        probe = createBridgeProbe({
          executable: probeExecutable,
          guardianPid: child.pid,
          uid,
          relay,
          args:
            mode === "argument-mismatch"
              ? [args[0], args[1].replace("keepidle=10", "keepidle=11")]
              : args,
          signal,
        });
        if (mode !== "settlement") {
          // A generic error, timeout, or forced process closure must not pass.
          const rejected = probe.ready();
          await expect(rejected).rejects.toBeInstanceOf(BridgeDiscoveryRejection);
          await expect(rejected).rejects.toMatchObject({
            name: "BridgeDiscoveryRejection",
            code: "bridge-discovery",
            errno: mode === "argument-mismatch" ? 71 : 17,
          });
          await probe.close();
          probe = undefined;
          expect(ownerClosed).toBe(false);
          expect(client.destroyed).toBe(false);
          expect(connections.size).toBe(mode === "ambiguous" ? 2 : 1);
        } else {
          await probe.ready();
          const alive = await probe.check();
          for (const process of [alive.leader, alive.connection]) {
            expect(process.pidfdTerminated).toBe(false);
            expect(process.originalIdentityAbsent).toBe(false);
          }
          expect(settled(alive), "The acceptance predicate must reject actual live processes").toBe(
            false,
          );
          expect(client.destroyed).toBe(false);
          expect(connections.size).toBe(1);
          signal.throwIfAborted();
          releaseIssued = true;
          child.stdin.end("stop\n");
          const observed = await requiredWithin(
            receiptCheck.promise,
            4000,
            "No receipt-time process observation",
          );
          signal.throwIfAborted();
          expect(settled(observed)).toBe(true);
          expect(await requiredWithin(ownerClose, 1000, "Owner closure unconfirmed")).toEqual({
            code: 0,
            signal: null,
          });
          expect(output).toBe(completeRecords);
        }
        expect(stderr).toBe("");
        expect(overflow).toBe(false);
        expect(echoOverflow).toBe(false);
        expect(processError).toBeUndefined();
      } catch (error) {
        recordFailure(error);
        recordFailure(
          new Error(
            `Pre-cleanup bridge state: ${JSON.stringify({ ownerClosed, output, stderr, overflow })}`,
          ),
        );
      } finally {
        if (probe !== undefined) {
          try {
            await probe.close();
          } catch (error) {
            recordFailure(error);
          }
        }
        if (child !== undefined && ownerClose !== undefined) {
          try {
            if (!ownerClosed && !child.stdin.writableEnded) child.stdin.end("stop\n");
            let result = await within(ownerClose, 4000);
            if (result === undefined) {
              child.kill("SIGTERM");
              result = await within(ownerClose, 4000);
            }
            if (result === undefined) {
              child.kill("SIGKILL");
              recordFailure(new Error("Guardian custody lost during emergency cleanup"));
              await requiredWithin(ownerClose, 1000, "Emergency owner join unconfirmed");
            } else if (result.code !== 0 || result.signal !== null || output !== completeRecords)
              recordFailure(new Error("Guardian cleanup did not confirm explicit release"));
          } catch (error) {
            recordFailure(error);
          }
        }
        client?.destroy();
        secondClient?.destroy();
        for (const socket of connections) socket.destroy();
        try {
          await requiredWithin(
            new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
                  reject(error);
                else resolve();
              });
            }),
            1000,
            "Echo server cleanup unconfirmed",
          );
        } catch (error) {
          recordFailure(error);
        }
      }
      if (failures.length !== 0)
        throw new AggregateError(failures, `Active bridge test failed; retained ${root}`);
      signal.throwIfAborted();
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  const timeout = new AbortController();
  return Promise.race([
    promise,
    delay(milliseconds, undefined, { signal: timeout.signal }),
  ]).finally(() => timeout.abort());
}

async function requiredWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  // Wrap undefined results so a successfully resolved void promise is not a timeout.
  const result = await within(
    promise.then((value) => ({ value })),
    milliseconds,
  );
  if (result === undefined) throw new Error(message);
  return result.value;
}

async function connect(path: string, signal: AbortSignal): Promise<Socket> {
  const deadline = performance.now() + 3000;
  for (;;) {
    signal.throwIfAborted();
    const socket = createConnection({ path });
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect", { signal });
      return socket;
    } catch (error) {
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ECONNREFUSED") || performance.now() >= deadline)
        throw error;
      await delay(10, undefined, { signal });
    }
  }
}
