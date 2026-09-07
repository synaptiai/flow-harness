import { spawn } from "node:child_process";

export interface ReadyRecord {
  readonly event: "ready";
  readonly pid: number;
  readonly uid: number;
  readonly startTime: string;
  readonly session: number;
  readonly state: string;
  readonly pidfdTerminated: false;
}

export interface CheckRecord {
  readonly event: "check";
  readonly pidfdTerminated: boolean;
  readonly originalIdentityAbsent: boolean;
  readonly procState: string | null;
}

export interface HostProbe {
  ready(): Promise<ReadyRecord>;
  check(): Promise<CheckRecord>;
  close(): Promise<void>;
}

interface Options {
  readonly executable: string;
  readonly mode: "discover" | "known";
  readonly uid: number;
  readonly marker: string;
  readonly ownedPid?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Pending {
  readonly kind: "ready" | "check";
  readonly resolve: (record: ReadyRecord | CheckRecord) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const states = new Set("RSDZTtXxKWPIN".split(""));
const responseMs = 1_000;

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function processState(value: unknown): value is string {
  return typeof value === "string" && states.has(value);
}

function parseRecord(bytes: Buffer, kind: "ready" | "check"): ReadyRecord | CheckRecord {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error("Host probe returned invalid UTF-8");
  const record: unknown = JSON.parse(text);
  // The fixed C writer emits canonical compact JSON. Round-trip equality also
  // rejects duplicate keys, alternate numeric spellings, and hidden whitespace.
  if (JSON.stringify(record) !== text) throw new Error("Host probe returned noncanonical JSON");
  if (
    kind === "ready" &&
    objectWithKeys(record, [
      "event",
      "pid",
      "uid",
      "startTime",
      "session",
      "state",
      "pidfdTerminated",
    ]) &&
    record.event === "ready" &&
    integer(record.pid, 1, 2_147_483_647) &&
    integer(record.uid, 0, 4_294_967_295) &&
    typeof record.startTime === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(record.startTime) &&
    BigInt(record.startTime) <= 18_446_744_073_709_551_615n &&
    integer(record.session, 0, 2_147_483_647) &&
    processState(record.state) &&
    record.state !== "Z" &&
    record.state !== "X" &&
    record.state !== "x" &&
    record.pidfdTerminated === false
  ) {
    return Object.freeze(record) as unknown as ReadyRecord;
  }
  if (
    kind === "check" &&
    objectWithKeys(record, ["event", "pidfdTerminated", "originalIdentityAbsent", "procState"]) &&
    record.event === "check" &&
    typeof record.pidfdTerminated === "boolean" &&
    typeof record.originalIdentityAbsent === "boolean" &&
    (record.originalIdentityAbsent ? record.procState === null : processState(record.procState))
  ) {
    return Object.freeze(record) as unknown as CheckRecord;
  }
  throw new Error(`Host probe returned an invalid ${kind} record`);
}

/** Host-only fixture. The only process this wrapper can signal is its own probe.
 * Call close in finally: a failed protocol or cleanup is never successful close.
 * The C tool owns discovered-process pidfds; no discovered PID is signalled here.
 */
export async function startHostProbe(options: Options): Promise<HostProbe> {
  if (options.signal.aborted) throw new Error("Host probe was aborted before launch");
  if (
    (options.mode !== "discover" && options.mode !== "known") ||
    !options.executable.startsWith("/") ||
    !options.cwd.startsWith("/") ||
    !integer(options.uid, 0, 4_294_967_295) ||
    !/^[0-9a-f]{64}$/.test(options.marker) ||
    (options.mode === "known"
      ? !integer(options.ownedPid, 1, 2_147_483_647)
      : options.ownedPid !== undefined)
  ) {
    throw new Error("Invalid host probe invocation");
  }
  const args =
    options.mode === "known"
      ? ["known", String(options.ownedPid), String(options.uid), options.marker]
      : ["discover", String(options.uid), options.marker];
  const child = spawn(options.executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let resolveExit: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>((resolve) => {
    resolveExit = resolve;
  });
  let observedExit: Exit | undefined;
  let failure: Error | undefined;
  let pending: Pending | undefined;
  let output = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let ready = false;
  let closing = false;
  let cleanup: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;

  const join = async (inputFinished: Promise<void> = Promise.resolve()): Promise<Exit> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([exited, inputFinished]).then(([exit]) => exit),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Host probe cleanup exceeded one second")),
            responseMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const stopOwnedProbe = (): Promise<void> => {
    if (cleanup !== undefined) return cleanup;
    cleanup = (async () => {
      if (observedExit === undefined && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await join();
    })();
    // Always retain the rejected promise for close(), while avoiding an unhandled
    // rejection when an asynchronous stream failure initiates cleanup first.
    void cleanup.catch(() => {});
    return cleanup;
  };

  const fail = (error: Error): void => {
    failure ??= error;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    void stopOwnedProbe();
  };

  const abort = (): void => fail(new Error("Host probe was aborted"));
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  child.once("close", (code, signal) => {
    observedExit = { code, signal };
    resolveExit(observedExit);
    options.signal.removeEventListener("abort", abort);
    if (!closing || pending !== undefined || output.length !== 0 || code !== 0 || signal !== null)
      fail(new Error("Host probe exited early or unsuccessfully"));
  });
  child.once("error", () => fail(new Error("Host probe process failed")));
  child.stdin.on("error", () => fail(new Error("Host probe input failed")));
  child.stdout.on("error", () => fail(new Error("Host probe output failed")));
  child.stderr.on("error", () => fail(new Error("Host probe diagnostic stream failed")));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256) fail(new Error("Host probe stderr exceeded its bound"));
    else if (stderrBytes !== 0) fail(new Error("Host probe wrote unexpected stderr"));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 8192) {
      fail(new Error("Host probe stdout exceeded its bound"));
      return;
    }
    if (failure !== undefined) return;
    if (pending === undefined || closing) {
      fail(new Error("Host probe wrote unsolicited output"));
      return;
    }
    output = Buffer.concat([output, chunk]);
    const newline = output.indexOf(10);
    if (newline < 0) return;
    if (newline !== output.length - 1) {
      fail(new Error("Host probe returned extra output"));
      return;
    }
    try {
      const record = parseRecord(output.subarray(0, newline), pending.kind);
      if (
        record.event === "ready" &&
        (record.uid !== options.uid ||
          (options.mode === "known" && record.pid !== options.ownedPid))
      ) {
        throw new Error("Host probe returned a mismatched process identity");
      }
      output = Buffer.alloc(0);
      const completion = pending;
      pending = undefined;
      clearTimeout(completion.timer);
      if (record.event === "ready") ready = true;
      completion.resolve(record);
    } catch {
      fail(new Error("Host probe returned a malformed or mismatched record"));
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Host probe launch exceeded one second")),
        responseMs,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Host probe launch failed"));
      });
    });
    if (failure !== undefined) throw failure;
  } catch (error) {
    fail(error instanceof Error ? error : new Error("Host probe launch failed"));
    await stopOwnedProbe();
    throw failure;
  }

  const request = (kind: "ready" | "check"): Promise<ReadyRecord | CheckRecord> => {
    if (failure !== undefined) return Promise.reject(failure);
    if (
      closing ||
      observedExit !== undefined ||
      pending !== undefined ||
      (kind === "ready" ? ready : !ready)
    )
      return Promise.reject(new Error("Invalid host probe command order"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error("Host probe response exceeded one second")),
        responseMs,
      );
      pending = { kind, resolve, reject, timer };
      child.stdin.write(`${kind}\n`, (error) => {
        if (error !== null && error !== undefined)
          fail(new Error("Host probe command write failed"));
      });
    });
  };

  return Object.freeze({
    ready: async () => (await request("ready")) as ReadyRecord,
    check: async () => (await request("check")) as CheckRecord,
    close: () => {
      closeTask ??= (async () => {
        if (failure !== undefined) {
          await stopOwnedProbe();
          throw failure;
        }
        if (pending !== undefined) {
          fail(new Error("Host probe closed during a pending command"));
          await stopOwnedProbe();
          throw failure;
        }
        closing = true;
        const inputFinished = new Promise<void>((resolve, reject) => {
          child.stdin.once("finish", resolve);
          child.stdin.once("error", reject);
          child.stdin.end("quit\n");
        });
        try {
          const exit = await join(inputFinished);
          if (
            failure !== undefined ||
            exit.code !== 0 ||
            exit.signal !== null ||
            stderrBytes !== 0 ||
            output.length !== 0
          )
            throw failure ?? new Error("Host probe close failed");
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Host probe close failed"));
          await stopOwnedProbe();
          throw failure;
        }
      })();
      return closeTask;
    },
  });
}
