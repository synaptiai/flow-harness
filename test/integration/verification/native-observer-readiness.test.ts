import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ownedTest, ownedTestCase } from "../../fixtures/owned-test-scope.js";
import { waitForReady } from "../../runtime/helpers/native-observer-readiness.js";

it(
  "accepts the exact default ready notice from a real file",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "ready\n", { flag: "wx" });
    await expect(waitForReady(path, scope.signal)).resolves.toBeUndefined();
  }),
);

it(
  "accepts only the explicitly selected zero-session notice",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "ready-session-zero\n", { flag: "wx" });
    await expect(waitForReady(path, scope.signal, "ready-session-zero\n")).resolves.toBeUndefined();
    await expect(waitForReady(path, scope.signal)).rejects.toThrow("Unexpected readiness notice");
  }),
);

it.for(["r", "ready", "ready\nextra", "\0"])(
  "rejects nonempty wrong or partial notice %j without waiting for the deadline",
  ownedTestCase(async (notice, scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, notice, { flag: "wx" });
    const start = performance.now();
    await expect(waitForReady(path, scope.signal)).rejects.toThrow("Unexpected readiness notice");
    expect(performance.now() - start).toBeLessThan(1000);
  }),
);

it(
  "keeps retrying a real empty file until the original absolute deadline",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "", { flag: "wx" });
    const start = performance.now();
    await expect(waitForReady(path, scope.signal)).rejects.toThrow("bounded readiness");
    expect(performance.now() - start).toBeGreaterThanOrEqual(1000);
  }),
);

it(
  "keeps retrying ENOENT until the same absolute deadline",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    const start = performance.now();
    await expect(waitForReady(path, scope.signal)).rejects.toThrow("bounded readiness");
    expect(performance.now() - start).toBeGreaterThanOrEqual(1000);
  }),
);

it.for(["ready\n", "ready-session-zero\n", "term-received\n"] as const)(
  "accepts the empty-to-complete publication transition for %j",
  ownedTestCase(async (notice, scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "", { flag: "wx" });
    const waiting = waitForReady(path, scope.signal, notice);
    // Observe the original promise immediately; always join the actual write as
    // well as the waiter, even if the old strict-empty behavior rejects early.
    // This transition does not assume which I/O completes first. The persistent
    // empty-file case independently proves that an observed empty read retries.
    const settled = Promise.allSettled([waiting, writeFile(path, notice)]);
    expect(await settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }),
);

it(
  "accepts an ENOENT-to-complete publication transition",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    const settled = await Promise.allSettled([
      waitForReady(path, scope.signal),
      writeFile(path, "ready\n", { flag: "wx" }),
    ]);
    expect(settled).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  }),
);

it(
  "propagates a real filesystem error other than ENOENT",
  ownedTest(async (scope) => {
    const directory = await scope.temporaryDirectory("flow-native-ready-");
    await expect(waitForReady(directory, scope.signal)).rejects.toMatchObject({ code: "EISDIR" });
  }),
);

it(
  "rejects cancellation before any read",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "ready\n", { flag: "wx" });
    const controller = new AbortController();
    const reason = new Error("Readiness cancelled");
    controller.abort(reason);
    await expect(waitForReady(path, controller.signal)).rejects.toBe(reason);
  }),
);

it(
  "rejects cancellation during a real read before accepting its correct notice",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "ready\n", { flag: "wx" });
    const controller = new AbortController();
    const reason = new Error("Readiness cancelled during read");
    const waiting = waitForReady(path, controller.signal);
    // No async callback can return the read before this synchronous abort.
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  }),
);

it(
  "rejects a correct real read delivered after the absolute deadline",
  ownedTest(async (scope) => {
    const path = join(await scope.temporaryDirectory("flow-native-ready-"), "notice");
    await writeFile(path, "ready\n", { flag: "wx" });
    const waiting = waitForReady(path, scope.signal);
    // Real elapsed time and real I/O, not fake timers or a substituted read.
    // Block only this test worker so the pending read continuation is late.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1050);
    await expect(waiting).rejects.toThrow("bounded readiness");
  }),
);
