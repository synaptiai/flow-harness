import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type CheckRecord, type HostProbe, startHostProbe } from "./native-observer-host-probe.js";

export interface ZombieObservations {
  readonly live: CheckRecord;
  readonly zombie: CheckRecord;
  readonly reaped: CheckRecord;
}

interface Options {
  readonly parentExecutable: string;
  readonly probeExecutable: string;
  readonly uid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Receives frozen real observations only after parent and probe cleanup joined. */
  readonly onObserved?: (observations: ZombieObservations) => void;
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Pending {
  readonly expected: "ready" | "zombie" | "reaped";
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Zombie control exceeded one second")), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Real host-only calibration: live -> terminated but unreaped -> fully reaped.
 * Only the explicitly spawned parent is signalled by Node. Its fixed C code
 * owns/reaps its child and supplies PDEATHSIG cleanup; no discovered PID is used
 * as a signal target. Acknowledgements coordinate real kernel wait operations,
 * not invented process results. The independent probe discovers the child.
 */
export async function calibrateZombie(options: Options): Promise<void> {
  options.signal.throwIfAborted();
  if (
    !options.parentExecutable.startsWith("/") ||
    !options.probeExecutable.startsWith("/") ||
    !options.cwd.startsWith("/") ||
    !Number.isSafeInteger(options.uid) ||
    options.uid < 0 ||
    options.uid > 4_294_967_295
  )
    throw new Error("Invalid zombie control invocation");
  const marker = randomBytes(32).toString("hex");
  const child = spawn(options.parentExecutable, [marker], {
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
  let pending: Pending | undefined;
  let failure: Error | undefined;
  let closing = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let output = Buffer.alloc(0);
  let probe: HostProbe | undefined;
  let joined = false;
  let observations: ZombieObservations | undefined;
  const failures: unknown[] = [];

  const killOwnedParent = (): void => {
    if (observedExit === undefined && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  };
  const fail = (error: Error): void => {
    failure ??= error;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    try {
      killOwnedParent();
    } catch {
      /* Bounded join below must still succeed. */
    }
  };
  const waitFor = (expected: Pending["expected"], command?: "exit" | "reap"): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure);
    if (pending !== undefined || closing || observedExit !== undefined)
      return Promise.reject(new Error("Invalid zombie control command order"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error("Zombie control response exceeded one second")),
        1_000,
      );
      pending = { expected, resolve, reject, timer };
      if (command !== undefined)
        child.stdin.write(`${command}\n`, (error) => {
          if (error !== null && error !== undefined) fail(new Error("Zombie control input failed"));
        });
    });
  };
  const assertHealthy = (): void => {
    if (failure !== undefined) throw failure;
  };
  const abort = (): void => fail(new Error("Zombie control was aborted"));
  options.signal.addEventListener("abort", abort, { once: true });
  child.once("error", () => fail(new Error("Zombie control process failed")));
  child.once("close", (code, signal) => {
    observedExit = { code, signal };
    resolveExit(observedExit);
    if (!closing || pending !== undefined || output.length !== 0 || code !== 0 || signal !== null)
      fail(new Error("Zombie control exited early or unsuccessfully"));
  });
  child.stdin.on("error", () => fail(new Error("Zombie control input stream failed")));
  child.stdout.on("error", () => fail(new Error("Zombie control output stream failed")));
  child.stderr.on("error", () => fail(new Error("Zombie control diagnostic stream failed")));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256) fail(new Error("Zombie control stderr exceeded its bound"));
    else if (stderrBytes !== 0) fail(new Error("Zombie control wrote unexpected stderr"));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 256) {
      fail(new Error("Zombie control stdout exceeded its bound"));
      return;
    }
    if (failure !== undefined) return;
    if (pending === undefined || closing) {
      fail(new Error("Zombie control wrote unsolicited output"));
      return;
    }
    output = Buffer.concat([output, chunk]);
    const newline = output.indexOf(10);
    if (newline < 0) return;
    if (
      newline !== output.length - 1 ||
      !output.equals(Buffer.from(`${pending.expected}\n`, "ascii"))
    ) {
      fail(new Error("Zombie control returned a malformed acknowledgement"));
      return;
    }
    output = Buffer.alloc(0);
    const completed = pending;
    pending = undefined;
    clearTimeout(completed.timer);
    completed.resolve();
  });

  try {
    if (options.signal.aborted) abort();
    await waitFor("ready");
    probe = await startHostProbe({
      executable: options.probeExecutable,
      mode: "discover",
      uid: options.uid,
      marker,
      env: options.env,
      cwd: options.cwd,
      signal: options.signal,
    });
    await probe.ready();
    const live = await probe.check();
    assertHealthy();
    if (
      live.pidfdTerminated ||
      live.originalIdentityAbsent ||
      live.procState === null ||
      live.procState === "Z"
    )
      throw new Error("Zombie control did not establish a live unreaped child");

    await waitFor("zombie", "exit");
    const zombie = await probe.check();
    assertHealthy();
    if (!zombie.pidfdTerminated || zombie.originalIdentityAbsent || zombie.procState !== "Z")
      throw new Error("Host probe failed to distinguish termination from reaping");

    await waitFor("reaped", "reap");
    const reaped = await probe.check();
    assertHealthy();
    if (!reaped.pidfdTerminated || !reaped.originalIdentityAbsent || reaped.procState !== null)
      throw new Error("Host probe did not establish complete reaping");
    observations = Object.freeze({ live, zombie, reaped });

    closing = true;
    const inputFinished = new Promise<void>((resolve, reject) => {
      child.stdin.once("finish", resolve);
      child.stdin.once("error", reject);
      child.stdin.end("quit\n");
    });
    const [exit] = await bounded(Promise.all([exited, inputFinished]));
    joined = true;
    assertHealthy();
    if (exit.code !== 0 || exit.signal !== null || output.length !== 0 || stderrBytes !== 0)
      throw new Error("Zombie control did not close cleanly");
  } catch (error) {
    failures.push(error);
  } finally {
    options.signal.removeEventListener("abort", abort);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Zombie control is closing"));
      pending = undefined;
    }
    if (!joined) {
      try {
        killOwnedParent();
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(exited);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (probe !== undefined) await probe.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0)
    throw new AggregateError(failures, "Zombie calibration failed; retain owned fixtures");
  if (options.onObserved !== undefined) {
    options.signal.throwIfAborted();
    if (observations === undefined) throw new Error("Missing joined zombie observations");
    options.onObserved(observations);
  }
}
