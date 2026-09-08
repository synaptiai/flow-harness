import { execFile as callbackExecFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const guardian = process.env.FLOW_TEST_HOST_BRIDGE_GUARDIAN;
const enabled = process.platform === "linux" && process.arch === "x64" && guardian !== undefined;
const weakBaseline = process.env.FLOW_TEST_STARTUP_REAPING_BASELINE === "1";
const execFile = promisify(callbackExecFile);
const owned = "FLOW_HOST_BRIDGE_V1 OWNED\n";
const reportSchema = z.strictObject({
  ownerCode: z.number().int().min(-1).max(255),
  ownerSignal: z.number().int().min(0).max(64),
  stdoutHex: z
    .string()
    .max(512)
    .regex(/^(?:[0-9a-f]{2})*$/),
  stderrHex: z
    .string()
    .max(512)
    .regex(/^(?:[0-9a-f]{2})*$/),
  remaining: z.enum(["none", "live", "unreaped"]),
});
type Report = z.infer<typeof reportSchema>;

function disposed(report: Report): boolean {
  // The initial sensitivity run deliberately ignores real unreaped children.
  // No observations are invented or changed, and this is never runtime policy.
  return weakBaseline ? report.remaining !== "live" : report.remaining === "none";
}

describe.skipIf(!enabled)("bridge startup with independent namespace custody", () => {
  let witness: string;
  let relay: string;
  beforeAll(async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "flow-startup-build-"));
    witness = join(root, "witness");
    relay = await realpath("/usr/bin/socat");
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
        fileURLToPath(new URL("../fixtures/host-bridge-startup-witness.c", import.meta.url)),
        "-o",
        witness,
      ],
      {
        cwd: root,
        env: { PATH: "/usr/bin:/bin" },
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 8192,
      },
    );
    expect(compiled.stdout).toBe("");
    expect(compiled.stderr).toBe("");
  });

  it.for(["live-residue", "zombie-residue"] as const)(
    "rejects actual adopted %s before namespace teardown",
    async (mode, context) => {
      const root = await temporaryRoot();
      const report = await observe(
        witness,
        mode,
        relay,
        root,
        join(root, "bridge.sock"),
        1,
        context.signal,
      );
      expect(report).toEqual({
        ownerCode: 1,
        ownerSignal: 0,
        stdoutHex: "",
        stderrHex: "",
        remaining: mode === "live-residue" ? "live" : "unreaped",
      });
      expect(disposed(report), "Only ECHILD can prove there are no remaining children").toBe(false);
    },
  );

  it.for(["executable-format", "listener-parent"] as const)(
    "rejects real %s failure without a control request or residual child",
    async (failure, context) => {
      const root = await temporaryRoot();
      let executable = relay;
      if (failure === "executable-format") {
        executable = join(root, "invalid-executable");
        // Executable permissions pass admission; real execve must reject these bytes.
        await writeFile(executable, "flow-test-invalid-executable-format\n", {
          flag: "wx",
          mode: 0o700,
        });
      }
      const path =
        failure === "listener-parent"
          ? join(root, "absent", "bridge.sock")
          : join(root, "bridge.sock");
      const report = await observe(witness, "observe", executable, root, path, 1, context.signal);
      expect(report).toEqual({
        ownerCode: 1,
        ownerSignal: 0,
        stdoutHex: Buffer.from(owned).toString("hex"),
        stderrHex: "",
        remaining: "none",
      });
      expect(disposed(report)).toBe(true);
    },
  );

  it("forwards a held connection and settles normally in the same namespace envelope", async (context) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(9000)]);
    const root = await temporaryRoot();
    const path = join(root, "bridge.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    let client: Socket | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening", { signal });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing echo port");
      const report = await observe(
        witness,
        "release",
        relay,
        root,
        path,
        address.port,
        signal,
        async () => {
          client = await connect(path, signal);
          const payload = Buffer.from("flow-startup-positive\n");
          const chunks: Buffer[] = [];
          let length = 0;
          const echoed = new Promise<void>((resolve, reject) => {
            client?.on("data", (chunk: Buffer) => {
              length += chunk.length;
              if (length > payload.length) {
                reject(new Error("Excess echo data"));
                return;
              }
              chunks.push(chunk);
              if (length === payload.length) resolve();
            });
          });
          client.write(payload);
          await bounded(echoed, 1000);
          expect(Buffer.concat(chunks)).toEqual(payload);
          expect(client.destroyed).toBe(false);
          expect(sockets.size).toBe(1);
        },
      );
      expect(report).toEqual({
        ownerCode: 0,
        ownerSignal: 0,
        stdoutHex: Buffer.from(`${owned}FLOW_HOST_BRIDGE_V1 SETTLED\n`).toString("hex"),
        stderrHex: "",
        remaining: "none",
      });
      expect(disposed(report)).toBe(true);
    } finally {
      client?.destroy();
      for (const socket of sockets) socket.destroy();
      await bounded(
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
              reject(error);
            else resolve();
          }),
        ),
        1000,
      );
    }
    signal.throwIfAborted();
  });
});

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), "flow-startup-"));
}

async function observe(
  witness: string,
  mode: "observe" | "release" | "live-residue" | "zombie-residue",
  relay: string,
  root: string,
  path: string,
  port: number,
  contextSignal: AbortSignal,
  beforeRelease?: () => Promise<void>,
): Promise<Report> {
  if (guardian === undefined || !guardian.startsWith("/"))
    throw new Error("Explicit guardian required");
  const signal = AbortSignal.any([contextSignal, AbortSignal.timeout(9000)]);
  signal.throwIfAborted();
  const child = spawn(
    "/usr/bin/bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--as-pid-1",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      root,
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "LANG",
      "C",
      "--",
      witness,
      mode,
      guardian,
      relay,
      `UNIX-LISTEN:${path},fork,reuseaddr`,
      `TCP:localhost:${port},keepalive,keepidle=10,keepintvl=5,keepcnt=3`,
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let diagnostic = "";
  let closed = false;
  const failures: unknown[] = [];
  const failed = (error: unknown): void => {
    // Bound retained failures as well as output when a broken child floods pipes.
    if (failures.length < 8) failures.push(error);
  };
  child.on("error", failed);
  child.stdin.on("error", failed);
  child.stdout.on("error", failed);
  child.stderr.on("error", failed);
  child.stdout.on("data", (bytes: Buffer) => {
    if (output.length + bytes.length > 2048) failed(new Error("Witness output overflow"));
    else output += bytes.toString("utf8");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    if (diagnostic.length + bytes.length > 4096) failed(new Error("Witness diagnostic overflow"));
    else diagnostic += bytes.toString("utf8");
  });
  const closure = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  const abort = (): void => {
    failed(new Error("Startup witness aborted; namespace cleanup unconfirmed"));
    if (!closed) child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  let report: Report | undefined;
  try {
    signal.throwIfAborted();
    if (beforeRelease !== undefined) {
      await beforeRelease();
      signal.throwIfAborted();
      child.stdin.end("stop\n");
    }
    expect(await bounded(closure, 8500)).toEqual({ code: 0, signal: null });
    signal.throwIfAborted();
    expect(diagnostic).toBe("");
    report = reportSchema.parse(JSON.parse(output));
    expect(output).toBe(`${JSON.stringify(report)}\n`);
  } catch (error) {
    failed(error);
  } finally {
    signal.removeEventListener("abort", abort);
    if (!closed) {
      failed(new Error("Forced startup wrapper closure; namespace cleanup unconfirmed"));
      child.kill("SIGKILL");
    }
    try {
      await bounded(closure, 1000);
    } catch (error) {
      failed(error);
    }
  }
  if (signal.aborted) failed(signal.reason);
  if (failures.length !== 0)
    throw new AggregateError(failures, `Startup witness failed; retained ${root}: ${diagnostic}`);
  if (report === undefined) throw new Error("Missing startup observation");
  return report;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Startup operation exceeded its bound")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function connect(path: string, signal: AbortSignal): Promise<Socket> {
  const deadline = performance.now() + 2000;
  for (;;) {
    signal.throwIfAborted();
    const socket = createConnection({ path });
    socket.on("error", () => undefined);
    try {
      await once(socket, "connect", { signal });
      return socket;
    } catch (error) {
      socket.destroy();
      if (performance.now() >= deadline) throw error;
      await delay(10, undefined, { signal });
    }
  }
}
