import { spawn } from "node:child_process";
import { z } from "zod";

const state = z
  .string()
  .length(1)
  .refine((value) => "RSDZTtXxKWPIN".includes(value));
const pid = z.number().int().min(1).max(2_147_483_647);
const identity = z
  .object({
    pid,
    uid: z.number().int().min(0).max(4_294_967_295),
    startTime: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/)
      .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
    session: pid,
    state: state.refine((value) => !"ZXx".includes(value)),
    pidfdTerminated: z.literal(false),
    parent: pid,
    group: pid,
  })
  .strict();
const observation = z
  .object({
    pidfdTerminated: z.boolean(),
    originalIdentityAbsent: z.boolean(),
    procState: state.nullable(),
  })
  .strict()
  .refine((value) => value.originalIdentityAbsent === (value.procState === null));
const readySchema = z
  .object({
    event: z.literal("bridge-ready"),
    leader: identity,
    connection: identity,
  })
  .strict();
const checkSchema = z
  .object({
    event: z.literal("bridge-check"),
    leader: observation,
    connection: observation,
  })
  .strict();
export type BridgeReady = z.infer<typeof readySchema>;
export type BridgeCheck = z.infer<typeof checkSchema>;

export function bridgeSettled(record: BridgeCheck): boolean {
  return [record.leader, record.connection].every(
    (value) => value.pidfdTerminated && value.originalIdentityAbsent && value.procState === null,
  );
}

export interface BridgeProbe {
  ready(): Promise<BridgeReady>;
  check(): Promise<BridgeCheck>;
  close(): Promise<void>;
}

interface Options {
  executable: string;
  guardianPid: number;
  uid: number;
  relay: string;
  args: readonly [string, string];
  signal: AbortSignal;
}

/** Test-only observer. It can signal only its own probe, never a discovered PID. */
export function createBridgeProbe(options: Options): BridgeProbe {
  options.signal.throwIfAborted();
  if (
    !pid.safeParse(options.guardianPid).success ||
    !options.executable.startsWith("/") ||
    !options.relay.startsWith("/") ||
    !Number.isSafeInteger(options.uid) ||
    options.uid < 0 ||
    options.uid > 4_294_967_295
  )
    throw new Error("Invalid bridge probe ownership inputs");
  const child = spawn(
    options.executable,
    ["bridge", String(options.guardianPid), String(options.uid), options.relay, ...options.args],
    {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let failure: Error | undefined;
  let pending:
    | {
        kind: "ready" | "check";
        resolve(value: BridgeReady | BridgeCheck): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let ready = false;
  let closing = false;
  let inputFinished = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let output = Buffer.alloc(0);
  let outputBytes = 0;
  let closeTask: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const stopOwnedProbe = (): void => {
    if (exit === undefined && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  };
  const fail = (error: Error): void => {
    failure ??= error;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    stopOwnedProbe();
  };
  const abort = (): void => fail(new Error("Bridge probe observation aborted"));
  child.once("close", (code, signal) => {
    exit = { code, signal };
    options.signal.removeEventListener("abort", abort);
    resolveClosed();
    if (!closing || pending !== undefined || output.length !== 0 || code !== 0 || signal !== null)
      fail(new Error(`Bridge probe closed unexpectedly: ${JSON.stringify(exit)}`));
  });
  child.on("error", () => fail(new Error("Bridge probe launch failed")));
  child.stdin.on("error", () => fail(new Error("Bridge probe control failed")));
  child.stdin.once("finish", () => {
    inputFinished = true;
  });
  child.stdout.on("error", () => fail(new Error("Bridge probe output failed")));
  child.stderr.on("error", () => fail(new Error("Bridge probe diagnostics failed")));
  child.stderr.on("data", () => fail(new Error("Bridge probe emitted unexpected diagnostics")));
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 8192) {
      fail(new Error("Bridge probe output exceeded its bound"));
      return;
    }
    if (failure !== undefined) return;
    if (pending === undefined || closing) {
      fail(new Error("Unsolicited bridge probe output"));
      return;
    }
    output = Buffer.concat([output, chunk]);
    const newline = output.indexOf(10);
    if (newline < 0) return;
    if (newline !== output.length - 1) {
      fail(new Error("Extra bridge probe output"));
      return;
    }
    try {
      const bytes = output.subarray(0, newline);
      const text = bytes.toString("utf8");
      const parsed: unknown = JSON.parse(text);
      if (!Buffer.from(text).equals(bytes) || JSON.stringify(parsed) !== text)
        throw new Error("Noncanonical bridge probe output");
      const record =
        pending.kind === "ready" ? readySchema.parse(parsed) : checkSchema.parse(parsed);
      if (record.event === "bridge-ready") {
        const { leader, connection } = record;
        if (
          leader.uid !== options.uid ||
          connection.uid !== options.uid ||
          leader.parent !== options.guardianPid ||
          leader.pid === options.guardianPid ||
          leader.group !== leader.pid ||
          leader.session !== leader.pid ||
          connection.pid === leader.pid ||
          connection.pid === options.guardianPid ||
          connection.parent !== leader.pid ||
          connection.group !== leader.pid ||
          connection.session !== leader.pid
        )
          throw new Error("Mismatched bridge ancestry");
        ready = true;
      }
      const completion = pending;
      pending = undefined;
      output = Buffer.alloc(0);
      clearTimeout(completion.timer);
      completion.resolve(record);
    } catch {
      fail(new Error("Malformed or mismatched bridge probe record"));
    }
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();

  const request = (kind: "ready" | "check"): Promise<BridgeReady | BridgeCheck> => {
    if (failure !== undefined) return Promise.reject(failure);
    if (
      closing ||
      exit !== undefined ||
      pending !== undefined ||
      (kind === "ready" ? ready : !ready)
    )
      return Promise.reject(new Error("Invalid bridge probe request order"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error("Bridge probe response exceeded one second")),
        1000,
      );
      pending = { kind, resolve, reject, timer };
      child.stdin.write(`${kind}\n`);
    });
  };
  const join = async (inputCompletion = Promise.resolve()): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([closed, inputCompletion]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Bridge probe cleanup unconfirmed")), 1000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return Object.freeze({
    ready: async () => (await request("ready")) as BridgeReady,
    check: async () => (await request("check")) as BridgeCheck,
    close: () => {
      closeTask ??= (async () => {
        closing = true;
        if (pending !== undefined) fail(new Error("Bridge probe closed during observation"));
        let inputCompletion = Promise.resolve();
        if (failure === undefined) {
          inputCompletion = new Promise<void>((resolve) => {
            child.stdin.once("finish", resolve);
            // The permanent error listener retains failure; this only joins delivery.
            child.stdin.once("error", () => resolve());
          });
          child.stdin.end("quit\n");
        } else stopOwnedProbe();
        try {
          await join(inputCompletion);
        } catch (error) {
          const failures = [failure, error].filter(Boolean);
          stopOwnedProbe();
          try {
            await join();
          } catch (joinError) {
            failures.push(joinError);
          }
          throw new AggregateError(failures, "Bridge probe cleanup failed");
        }
        if (failure !== undefined)
          throw new AggregateError(
            [failure, new Error(`Bridge probe closure: ${JSON.stringify(exit)}`)],
            "Bridge probe failed before normal closure",
          );
        if (!inputFinished || exit?.code !== 0 || exit.signal !== null || output.length !== 0)
          throw new Error("Bridge probe did not close normally");
      })();
      return closeTask;
    },
  });
}
