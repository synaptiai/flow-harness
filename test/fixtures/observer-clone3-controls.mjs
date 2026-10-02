import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { setImmediate, setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

// Fixed synthetic inputs only. No repository or credential data is read.
if (!isMainThread) {
  assert.deepEqual(workerData, { measurement: "clone3-fixed-control-v1" });
  parentPort.postMessage(42);
  parentPort.close();
} else {
  const control = process.argv[2];
  try {
    switch (control) {
      case "timers": {
        const values = [];
        await setTimeout(10);
        values.push("timer");
        await setImmediate();
        values.push("immediate");
        assert.deepEqual(values, ["timer", "immediate"]);
        break;
      }
      case "filesystem": {
        const file = "synthetic-input.txt";
        await writeFile(file, "fixed synthetic input\n", { flag: "wx", mode: 0o600 });
        assert.equal(await readFile(file, "utf8"), "fixed synthetic input\n");
        assert.equal((await stat(file)).size, 22);
        await unlink(file);
        break;
      }
      case "worker": {
        await new Promise((resolve, reject) => {
          const messages = [];
          const worker = new Worker(new URL(import.meta.url), {
            workerData: { measurement: "clone3-fixed-control-v1" },
          });
          worker.on("message", (message) => messages.push(message));
          worker.on("error", reject);
          worker.on("exit", (code) => {
            try {
              assert.equal(code, 0);
              assert.deepEqual(messages, [42]);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
        break;
      }
      case "subprocess": {
        const output = await promisify(execFile)(
          process.execPath,
          ["-e", 'process.stdout.write("child-ok")'],
          { timeout: 3000, maxBuffer: 1024 },
        );
        assert.equal(output.stdout, "child-ok");
        assert.equal(output.stderr, "");
        break;
      }
      default:
        throw new Error("Unknown fixed control");
    }
    process.stdout.write(`${JSON.stringify({ control, result: "ok" })}\n`);
  } catch {
    process.stderr.write("Fixed clone3 control failed\n");
    process.exitCode = 1;
  }
}
