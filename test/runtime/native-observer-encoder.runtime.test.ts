import { execFile as callbackExecFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  type NativeObserverResultRecord,
  parseNativeObserverResult,
} from "../../src/infrastructure/verification/native-observer-result.js";
import type { OwnedTestScope } from "../fixtures/owned-test-scope.js";
import { runOwnedTest } from "../fixtures/owned-test-scope.js";

const execFile = promisify(callbackExecFile);
const source = fileURLToPath(
  new URL("../fixtures/native-observer-encoder-control.c", import.meta.url),
);
const include = fileURLToPath(new URL("../../native/verification-observer/", import.meta.url));
type Vector = {
  kind: number;
  detail: number;
  stage: number;
  flags: number;
  expected: NativeObserverResultRecord | null;
};

// Native compilation is opt-in through the runtime suite, never ordinary npm test.
// These portable byte-level controls do not qualify Linux security or writer custody.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "Native observer frame ABI",
  () => {
    it("encodes every exit and signal, failure boundaries, phases, and correlation bytes", async (context) => {
      const retention = new AbortController();
      await runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          const { executable, directory } = await compile(scope, retention);
          const vectors: Vector[] = [];
          for (const flags of [0, 1]) {
            const common = { clone3FallbackUsed: flags === 1 };
            for (let detail = 0; detail <= 255; detail++)
              vectors.push({
                kind: 1,
                detail,
                stage: 0,
                flags,
                expected: { ...common, kind: "normal_exit", exitCode: detail },
              });
            for (let detail = 1; detail <= 64; detail++)
              vectors.push({
                kind: 2,
                detail,
                stage: 0,
                flags,
                expected: { ...common, kind: "signalled", signal: detail },
              });
            for (const detail of [1, 4095]) {
              const stages = [
                "bootstrap",
                "namespace_setup",
                "filter_setup",
                "descriptor_handoff",
              ] as const;
              for (const [index, stage] of stages.entries())
                vectors.push({
                  kind: 3,
                  detail,
                  stage: index + 1,
                  flags,
                  expected: { ...common, kind: "setup_failed", errno: detail, stage },
                });
              vectors.push({
                kind: 4,
                detail,
                stage: 0,
                flags,
                expected: { ...common, kind: "exec_failed", errno: detail },
              });
              for (const stage of [4, 5])
                vectors.push({
                  kind: 6,
                  detail,
                  stage,
                  flags,
                  expected: {
                    ...common,
                    kind: "supervisor_failed",
                    errno: detail,
                    stage: stage === 4 ? "descriptor_handoff" : "settlement",
                  },
                });
            }
            vectors.push({
              kind: 5,
              detail: 0,
              stage: 0,
              flags,
              expected: { ...common, kind: "policy_interference" },
            });
          }
          expect(vectors).toHaveLength(670);
          await checkVectors(executable, directory, vectors, scope, retention);
        },
      );
    });

    it("rejects contradictory variants without changing destination bytes", async (context) => {
      const retention = new AbortController();
      await runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          const { executable, directory } = await compile(scope, retention);
          const vectors: Vector[] = [];
          const add = (kind: number, detail: number, stage: number, flags = 0) =>
            vectors.push({ kind, detail, stage, flags, expected: null });
          for (const kind of [0, 7, 0xffffffff]) add(kind, 0, 0);
          for (const kind of [1, 2, 3, 4, 5, 6]) {
            const detail = kind === 5 ? 0 : 1;
            const stage = kind === 3 ? 1 : kind === 6 ? 4 : 0;
            for (const flags of [2, 3, 0x80000000, 0xffffffff]) add(kind, detail, stage, flags);
            for (const badStage of [6, 0xffffffff]) add(kind, detail, badStage);
          }
          for (const detail of [256, 0xffffffff]) add(1, detail, 0);
          for (const detail of [0, 65, 0xffffffff]) add(2, detail, 0);
          for (const kind of [3, 4, 6])
            for (const detail of [0, 4096, 0xffffffff])
              add(kind, detail, kind === 3 ? 1 : kind === 6 ? 4 : 0);
          for (const kind of [1, 2, 4, 5])
            for (const stage of [1, 2, 3, 4, 5]) add(kind, kind === 5 ? 0 : 1, stage);
          for (const stage of [0, 5]) add(3, 1, stage);
          for (const stage of [0, 1, 2, 3]) add(6, 1, stage);
          for (const detail of [1, 255, 4095, 0xffffffff]) add(5, detail, 0);
          expect(vectors).toHaveLength(83);
          await checkVectors(executable, directory, vectors, scope, retention);
        },
      );
    });

    it("bounds memory writes and supports overlapping correlation storage", async (context) => {
      const retention = new AbortController();
      await runOwnedTest(
        {
          signal: AbortSignal.any([context.signal, retention.signal]),
          onTestFinished: context.onTestFinished,
        },
        async (scope) => {
          const { executable } = await compile(scope, retention);
          const result = await run(executable, ["memory"], scope, retention);
          expect(result.stdout.toString("ascii")).toBe("memory-ok\n");
        },
      );
    });
  },
);

async function compile(scope: OwnedTestScope, retention: AbortController) {
  const directory = await scope.temporaryDirectory("flow-native-encoder-");
  const executable = join(directory, "encoder-control");
  await run(
    "/usr/bin/cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pedantic",
      "-I",
      include,
      source,
      "-o",
      executable,
    ],
    scope,
    retention,
  );
  return { directory, executable };
}

async function run(
  executable: string,
  args: string[],
  scope: OwnedTestScope,
  retention: AbortController,
) {
  scope.signal.throwIfAborted();
  const directory = scope.directories[0];
  if (directory === undefined) throw new Error("Missing owned native control directory");
  let result: { stdout: Buffer; stderr: Buffer };
  try {
    result = await execFile(executable, args, {
      encoding: "buffer",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 131_072,
      signal: scope.signal,
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: directory,
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      },
    });
  } catch (error) {
    // Normal completion relies on the fixed compiler/control waiting for its own
    // work. Failure does not establish arbitrary descendant settlement.
    retention.abort(new Error("Native control execution or settlement failed"));
    throw error;
  }
  expect(result.stderr.toString("utf8")).toBe("");
  return result;
}

async function checkVectors(
  executable: string,
  directory: string,
  vectors: Vector[],
  scope: OwnedTestScope,
  retention: AbortController,
) {
  expect(vectors.length).toBeLessThanOrEqual(1024);
  const input = Buffer.alloc(vectors.length * 48);
  for (const [index, vector] of vectors.entries()) {
    const record = input.subarray(index * 48, (index + 1) * 48);
    [vector.kind, vector.detail, vector.stage, vector.flags].forEach((value, offset) => {
      record.writeUInt32LE(value, offset * 4);
    });
    for (let offset = 0; offset < 32; offset++)
      record[16 + offset] = index === 0 ? 0 : index === 1 ? 255 : (index + offset * 17) % 256;
  }
  const path = join(directory, "vectors.bin");
  await writeFile(path, input, { flag: "wx", mode: 0o600 });
  const result = await run(executable, ["encode", path], scope, retention);
  expect(result.stdout.byteLength).toBe(vectors.length * 65);
  for (const [index, vector] of vectors.entries()) {
    const response = result.stdout.subarray(index * 65, (index + 1) * 65);
    const frame = response.subarray(1);
    const correlation = input.subarray(index * 48 + 16, (index + 1) * 48);
    expect(response[0], JSON.stringify(vector)).toBe(vector.expected === null ? 1 : 0);
    if (vector.expected === null) expect(frame).toEqual(Buffer.alloc(64, 0xa5));
    else {
      const expected = Buffer.alloc(64);
      expected.write("FLOWOBS1", "ascii");
      correlation.copy(expected, 8);
      [vector.kind, vector.detail, vector.stage, vector.flags].forEach((value, offset) => {
        expected.writeUInt32LE(value, 40 + offset * 4);
      });
      expect(frame).toEqual(expected);
    }
    expect(parseNativeObserverResult(frame, correlation.toString("hex"))).toEqual(vector.expected);
  }
}
