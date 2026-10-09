import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { FLOW_SANDBOX_POLICY_DIGEST } from "../../src/infrastructure/sandbox/srt-command-sandbox.js";
import {
  executeLinuxObserverCommand,
  type LinuxObserverCommandObservation,
  type LinuxObserverCommandRequest,
} from "../../src/infrastructure/verification/linux-observer-command.js";

// Actual Linux native execution only. A Mac skip is not command-observer qualification.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "Linux observer command process observations",
  () => {
    it.each([0, 7])(
      "observes normal exit %i without relabeling command outcome",
      async (exitCode) => {
        await withRequest(async (request, remember) => {
          const result = remember(
            await executeLinuxObserverCommand({
              ...request,
              command: {
                ...request.command,
                args: [
                  "-e",
                  `process.stdout.write("data"); process.stderr.write("diagnostic"); process.exitCode = ${exitCode}`,
                ],
              },
            }),
          );
          expect(result.kind).toBe("completed");
          if (result.kind !== "completed") throw new Error(JSON.stringify(result));
          expect(result.custody).toEqual({
            processContainment: "linux-pid-namespace",
            exitStatusEncoding: "shell",
            backend: "anthropic-sandbox-runtime",
            backendVersion: "0.0.70",
            profile: "workspace-write-network-deny-v1",
            policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
            release: "succeeded",
          });
          expect(result.outcome.status).toBe(exitCode === 0 ? "succeeded" : "failed");
          if (result.outcome.status === "failed") {
            expect(result.outcome.error).toMatchObject({
              code: "command_failed",
              sideEffectStatus: "uncertain",
            });
          }
          expect(result.outcome.evidence).toMatchObject({
            kind: "command",
            exitCode,
            stdout: "data",
            stderr: "diagnostic",
            stdoutHash: createHash("sha256").update("data").digest("hex"),
            signal: null,
            timedOut: false,
            aborted: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            terminationStatus: "not-required",
          });
        });
      },
    );

    it.each([
      ["truncated output", 'process.stdout.write("x".repeat(8192))', 4096],
      ["non-UTF8 hash mismatch", "process.stdout.write(Buffer.from([255]))", 4096],
    ] as const)(
      "rejects %s as unsupported while retaining raw evidence",
      async (_label, script, maxOutputBytes) => {
        await withRequest(async (request, remember) => {
          const result = remember(
            await executeLinuxObserverCommand({
              ...request,
              maxOutputBytes,
              command: { ...request.command, args: ["-e", script] },
            }),
          );
          expect(result.kind).toBe("unsupported");
          expect(result.outcome?.evidence?.kind).toBe("command");
        });
      },
    );

    it("rejects timeout without treating it as a behavioral failure", async () => {
      await withRequest(async (request, remember) => {
        const result = remember(
          await executeLinuxObserverCommand({
            ...request,
            command: {
              ...request.command,
              args: ["-e", "setInterval(() => {}, 1000)"],
              timeoutMs: 1500,
            },
          }),
        );
        expect(result.kind).toBe("unsupported");
        expect(result.outcome).toMatchObject({
          status: "failed",
          error: { code: "command_timeout" },
        });
      });
    });

    it.each(["process.exit(143)", 'process.kill(process.pid, "SIGTERM")'])(
      "preserves ambiguous shell-encoded exit 143 for %s",
      async (script) => {
        await withRequest(async (request, remember) => {
          const result = remember(
            await executeLinuxObserverCommand({
              ...request,
              command: { ...request.command, args: ["-e", script] },
            }),
          );
          expect(result.kind).toBe("completed");
          if (result.kind !== "completed") throw new Error(JSON.stringify(result));
          expect(result.custody.exitStatusEncoding).toBe("shell");
          expect(result.outcome).toMatchObject({
            status: "failed",
            error: { code: "command_failed" },
            evidence: {
              kind: "command",
              exitCode: 143,
              signal: null,
              timedOut: false,
              aborted: false,
            },
          });
        });
      },
    );

    it("rejects cancellation after a real command has signaled readiness", async () => {
      await withRequest(async (request, remember) => {
        const marker = join(request.cwd, "started.txt");
        const cancellation = new AbortController();
        const pending = executeLinuxObserverCommand({
          ...request,
          signal: cancellation.signal,
          command: {
            ...request.command,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000);`,
            ],
          },
        });
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        let result: LinuxObserverCommandObservation;
        try {
          const deadline = Date.now() + 6000;
          while (
            (await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return "";
              throw error;
            })) !== "ready"
          ) {
            if (settled || Date.now() >= deadline)
              throw new Error("Command readiness was not observed");
            await delay(25);
          }
        } finally {
          cancellation.abort();
          result = remember(await pending);
        }
        expect(result).toMatchObject({
          kind: "unsupported",
          reason: "cancelled",
          outcome: {
            status: "failed",
            error: { code: "command_aborted" },
            evidence: { kind: "command", aborted: true },
          },
        });
      });
    });

    it("preserves a detached command vector and read-only/private path scopes", async () => {
      await withRequest(async (request, remember, root) => {
        const privateRoot = join(root, "private");
        await mkdir(privateRoot);
        const support = join(privateRoot, "support");
        await mkdir(support);
        const readable = join(support, "input.txt");
        const secret = join(privateRoot, "expectation.txt");
        await writeFile(readable, "synthetic input");
        await writeFile(secret, "synthetic private expectation");
        const args = [
          "-e",
          `const fs = require("node:fs"); const attempt = f => { try { f(); return true; } catch { return false; } }; process.stdout.write(JSON.stringify({ input: fs.readFileSync(${JSON.stringify(readable)}, "utf8"), privateRead: attempt(() => fs.readFileSync(${JSON.stringify(secret)})), rewrite: attempt(() => fs.writeFileSync(${JSON.stringify(readable)}, "tampered")) }));`,
        ];
        const runtimeSupportPaths = [support];
        const protectedPaths = [privateRoot];
        const pending = executeLinuxObserverCommand({
          ...request,
          command: { ...request.command, args },
          runtimeSupportPaths,
          protectedPaths,
        });
        args[1] = 'throw new Error("mutable request was not detached")';
        runtimeSupportPaths[0] = request.cwd;
        protectedPaths.length = 0;
        const result = remember(await pending);
        expect(result.kind).toBe("completed");
        if (result.outcome?.evidence?.kind !== "command")
          throw new Error("Missing command evidence");
        expect(JSON.parse(result.outcome.evidence.stdout)).toEqual({
          input: "synthetic input",
          privateRead: false,
          rewrite: false,
        });
        await expect(readFile(readable, "utf8")).resolves.toBe("synthetic input");
        await expect(readFile(secret, "utf8")).resolves.toBe("synthetic private expectation");
      });
    });
  },
);

async function withRequest(
  run: (
    request: LinuxObserverCommandRequest,
    remember: (result: LinuxObserverCommandObservation) => LinuxObserverCommandObservation,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-observer-command-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  let result: LinuxObserverCommandObservation | undefined;
  const failures: unknown[] = [];
  try {
    await run(
      {
        cwd,
        command: { executable: process.execPath, args: ["-e", ""], timeoutMs: 8000 },
        protectedPaths: [],
        runtimeSupportPaths: [],
        maxOutputBytes: 4096,
        preparationSettlementMs: 5000,
        identity: {
          runId: `observer-${randomUUID()}`,
          workflowId: "observer",
          nodeId: "probe",
          attempt: 1,
        },
      },
      (observed) => {
        result = observed;
        return observed;
      },
      root,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    if (
      result === undefined ||
      (result.kind === "unsupported" &&
        (result.reason === "sandbox_release_unconfirmed" ||
          result.reason === "execution_error" ||
          result.reason === "sandbox_unqualified" ||
          (result.outcome?.status === "failed" &&
            ["command_sandbox_cleanup_failed", "command_termination_failed"].includes(
              result.outcome.error.code,
            ))))
    ) {
      throw new Error(`Command cleanup unconfirmed; retained fixture ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Command probe and owned cleanup failed");
}
