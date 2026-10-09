import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeLinuxObserverCommand,
  type LinuxObserverCommandRequest,
} from "../../src/infrastructure/verification/linux-observer-command.js";

// The probe runs the nested-namespace attack from the fixture qualification, plus ordinary
// subprocess and thread controls, and reports what happened as JSON.
const probe = `
  const { spawnSync } = require("node:child_process");
  const { Worker } = require("node:worker_threads");
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 4000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const nested = run("/usr/bin/unshare", ["--user", "--map-root-user", "/bin/true"]);
  const child = run(process.execPath, ["-e", "process.stdout.write('child')"]);
  new Worker("require('node:worker_threads').parentPort.postMessage('thread')", { eval: true })
    .once("message", (thread) => process.stdout.write(JSON.stringify({ nested, child, thread })));
`;

interface ProbeResult {
  readonly nested: { readonly status: number | null; readonly stderr: string };
  readonly child: {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly thread: string;
}

// Actual Linux native execution only. CI builds and installs the helper with
// native/verification-observer/build-test-helper.sh; a missing helper fails the test.
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "observer namespace restriction on native Linux",
  () => {
    it("denies nested user namespaces only under the admitted helper", async () => {
      const helperPath = process.env.FLOW_OBSERVER_TEST_HELPER;
      const helperSha256 = process.env.FLOW_OBSERVER_TEST_HELPER_SHA256;
      if (helperPath === undefined || helperSha256 === undefined)
        throw new Error(
          "Observer namespace qualification requires FLOW_OBSERVER_TEST_HELPER and FLOW_OBSERVER_TEST_HELPER_SHA256",
        );
      await withRequest(async (request) => {
        const restricted = await executeLinuxObserverCommand({
          ...request,
          namespaceRestriction: { helperPath, helperSha256 },
        });
        expect(restricted.kind, JSON.stringify(restricted)).toBe("completed");
        if (restricted.kind !== "completed") throw new Error(JSON.stringify(restricted));
        expect(restricted.custody.namespaceRestriction).toEqual({
          helper: "observer-apply-seccomp",
          sha256: helperSha256,
        });
        const denied = probeResult(restricted.outcome.evidence);
        expect(denied.nested.status, JSON.stringify(denied)).toBe(1);
        expect(denied.nested.stderr).toMatch(/^unshare: .*Operation not permitted\s*$/s);
        expect(denied.child).toEqual({ status: 0, stdout: "child", stderr: "" });
        expect(denied.thread).toBe("thread");

        // Control: the same probe without the helper must still be able to nest, or the
        // denial above would not show that the helper caused it.
        const unrestricted = await executeLinuxObserverCommand(request);
        expect(unrestricted.kind, JSON.stringify(unrestricted)).toBe("completed");
        if (unrestricted.kind !== "completed") throw new Error(JSON.stringify(unrestricted));
        expect(unrestricted.custody.namespaceRestriction).toBeUndefined();
        const allowed = probeResult(unrestricted.outcome.evidence);
        expect(allowed.nested.status, JSON.stringify(allowed)).toBe(0);
        expect(allowed.child.status).toBe(0);
        expect(allowed.thread).toBe("thread");
      });
    }, 60_000);
  },
);

function probeResult(evidence: unknown): ProbeResult {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !("stdout" in evidence) ||
    typeof evidence.stdout !== "string"
  )
    throw new Error(`Missing command evidence: ${JSON.stringify(evidence)}`);
  return JSON.parse(evidence.stdout) as ProbeResult;
}

async function withRequest(
  run: (request: LinuxObserverCommandRequest) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-observer-namespace-")));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  try {
    await run({
      cwd,
      command: { executable: process.execPath, args: ["-e", probe], timeoutMs: 15_000 },
      protectedPaths: [],
      runtimeSupportPaths: [],
      maxOutputBytes: 4096,
      preparationSettlementMs: 10_000,
      identity: {
        runId: `observer-namespace-${randomUUID()}`,
        workflowId: "observer",
        nodeId: "namespace-probe",
        attempt: 1,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
