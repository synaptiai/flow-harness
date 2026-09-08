import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const baseline = process.env.FLOW_TEST_HOST_BRIDGE_BASELINE === "1";
const guardian = process.env.FLOW_TEST_HOST_BRIDGE_GUARDIAN;
const profile = process.env.FLOW_TEST_HOST_BRIDGE_PROFILE;
if (
  profile !== undefined &&
  (profile !== "host-bridge-ipv4-loopback-v1" ||
    guardian === undefined ||
    process.env.FLOW_TEST_HOST_BRIDGE_RELAY === undefined ||
    baseline)
)
  throw new Error(
    "Restricted forwarding requires the exact profile, guardian, and relay selection",
  );
const enabled =
  process.platform === "linux" && process.arch === "x64" && (baseline || guardian !== undefined);

describe.skipIf(!enabled)("host bridge owner release contract", () => {
  it.for(
    (["stop", "disconnect", "malformed"] as const).flatMap((release) =>
      (profile === undefined ? ["normal"] : ["normal", "maximum"]).map((pathLength) => ({
        release,
        pathLength,
      })),
    ),
  )(
    "handles $release after actual bridge forwarding with $pathLength path length",
    async ({ release, pathLength }, context) => {
      const executable = baseline ? "/usr/bin/socat" : requiredGuardian();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
      const root = await mkdtemp(join(await realpath(tmpdir()), "flow-bridge-owner-"));
      const prefix = `${root}/`;
      const path =
        pathLength === "normal"
          ? join(root, "bridge.sock")
          : `${prefix}${"s".repeat(107 - Buffer.byteLength(prefix))}`;
      if (pathLength === "maximum") expect(Buffer.byteLength(path)).toBe(107);
      // Retain this test's socket and directory as diagnostic evidence. Removal is
      // deliberately not evidence of process settlement, especially in the RED run.
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("close", () => sockets.delete(socket));
        socket.pipe(socket);
      });
      const failures: unknown[] = [];
      try {
        signal.throwIfAborted();
        server.listen(0, "127.0.0.1");
        await once(server, "listening", { signal });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No proxy port");
        const args = [
          `UNIX-LISTEN:${path},fork,reuseaddr`,
          `TCP:localhost:${address.port},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
        ];
        await exerciseBridge(executable, args, path, root, signal, release);
      } catch (error) {
        failures.push(error);
      } finally {
        for (const socket of sockets) socket.destroy();
        const serverClosed = new Promise<boolean>((resolve) =>
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
              failures.push(error);
            resolve(true);
          }),
        );
        if (!(await bounded(serverClosed, 1_000)))
          failures.push(new Error(`Proxy cleanup unconfirmed; retained ${root}`));
      }
      if (failures.length !== 0)
        throw new AggregateError(failures, "Bridge release contract failed");
      signal.throwIfAborted();
    },
  );
});

async function exerciseBridge(
  executable: string,
  args: string[],
  path: string,
  root: string,
  signal: AbortSignal,
  release: "stop" | "disconnect" | "malformed",
): Promise<void> {
  // Baseline mode exercises the existing SRT direct-spawn contract. It is an
  // explicit RED experiment, never an execution fallback for the guardian.
  const relay = baseline
    ? "/usr/bin/socat"
    : await realpath(process.env.FLOW_TEST_HOST_BRIDGE_RELAY ?? "/usr/bin/socat");
  signal.throwIfAborted();
  const child = spawn(executable, baseline ? args : [relay, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env:
      profile === undefined
        ? { PATH: "/usr/bin:/bin" }
        : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  });
  let output = "";
  let errors = "";
  let overflow = false;
  let spawnError: Error | undefined;
  let closed = false;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (bytes: Buffer) => {
    if (output.length + bytes.length > 256) overflow = true;
    else output += bytes.toString("utf8");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    if (errors.length + bytes.length > 4096) overflow = true;
    else errors += bytes.toString("utf8");
  });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  let client: Socket | undefined;
  const failures: unknown[] = [];
  try {
    client = await connectBridge(path, signal);
    const payload = Buffer.from("flow-host-bridge-real-forwarding\n");
    const chunks: Buffer[] = [];
    client.on("data", (bytes: Buffer) => chunks.push(bytes));
    const clientClosed = once(client, "close", { signal });
    client.write(payload);
    client.end();
    await clientClosed;
    expect(Buffer.concat(chunks)).toEqual(payload);
    client = undefined;
    child.stdin.end(
      release === "stop" ? "stop\n" : release === "malformed" ? "stopped\n" : undefined,
    );
    const completed = await bounded(close, 4_000);
    signal.throwIfAborted();
    expect(spawnError).toBeUndefined();
    expect(overflow).toBe(false);
    expect(errors).toBe("");
    expect(completed, "owner release must join the process, not merely request a signal").toEqual({
      code: release === "stop" ? 0 : 1,
      signal: null,
    });
    expect(output).toBe(
      `FLOW_HOST_BRIDGE_V1 OWNED\n${release === "stop" ? "FLOW_HOST_BRIDGE_V1 SETTLED\n" : ""}`,
    );
  } catch (error) {
    failures.push(error);
    failures.push(
      new Error(
        `Bridge state before emergency cleanup: ${JSON.stringify({
          closed,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          spawnErrorCode: (spawnError as NodeJS.ErrnoException | undefined)?.code ?? null,
          output,
          errors,
          overflow,
        })}`,
      ),
    );
  } finally {
    client?.destroy();
    // Signal only the ChildProcess created above. Never discover or signal an
    // unrelated PID, or treat this test's emergency cleanup as guardian proof.
    if (!closed) child.kill("SIGKILL");
    const joined = await bounded(
      close.then(() => true),
      1_000,
    );
    if (!joined) failures.push(new Error(`Bridge test cleanup unconfirmed; retained ${root}`));
  }
  if (failures.length !== 0) throw new AggregateError(failures, "Bridge release contract failed");
  signal.throwIfAborted();
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T | undefined> {
  const deadline = new AbortController();
  return Promise.race([
    operation,
    delay(milliseconds, undefined, { signal: deadline.signal }),
  ]).finally(() => deadline.abort());
}

function requiredGuardian(): string {
  if (guardian === undefined || !guardian.startsWith("/"))
    throw new Error("Expected explicit guardian path");
  return guardian;
}

async function connectBridge(path: string, signal: AbortSignal): Promise<Socket> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const socket = createConnection({ path });
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect", { signal });
      return socket;
    } catch (error) {
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "ENOENT" && code !== "ECONNREFUSED") || Date.now() >= deadline) throw error;
      await delay(10, undefined, { signal });
    }
  }
}
