import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandSandbox } from "../../../../src/application/command-sandbox.js";
import type { ExternalHarnessRuntimeRequest } from "../../../../src/application/external-harness-adapter.js";
import type { HarnessEvaluationRequest } from "../../../../src/application/evaluation-adapter.js";
import type { ExternalHarnessIdentity } from "../../../../src/domain/evaluation/external-harness.js";
import { externalHarnessIdentityDigest } from "../../../../src/domain/evaluation/external-harness.js";
import type { NativePiHarnessDescriptor } from "../../../../src/infrastructure/pi/native-pi-harness-registry.js";
import {
  LocalExternalHarnessRuntime,
  MAX_EXTERNAL_HARNESS_STDERR_BYTES,
  type ExternalHarnessDescriptorRegistry,
  type ExternalHarnessInferenceBroker,
} from "../../../../src/infrastructure/process/local-external-harness-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local external harness runtime", () => {
  it("rejects an external harness on macOS before admission", async () => {
    const fixture = await runtimeFixture("success");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "darwin",
    });

    await expect(runtime.execute(fixture.request)).rejects.toThrow(/not supported.*darwin/i);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("rejects process-group preparation before it starts the driver", async () => {
    const fixture = await runtimeFixture("success");
    fixture.prepare.mockResolvedValueOnce({
      processContainment: "process-group",
      launch: {
        executable: process.execPath,
        args: [fixture.driverPath],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: {
        backend: "anthropic-sandbox-runtime",
        backendVersion: "0.0.70",
        profile: "workspace-write-network-deny-v1",
        policyDigest: fixture.request.identity.runtime.policyDigest,
      },
      release: fixture.release,
    });
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
    });

    await expect(runtime.execute(fixture.request)).rejects.toThrow(/PID namespace/i);
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("checks the admitted artifacts after sandbox preparation and before process start", async () => {
    const fixture = await runtimeFixture("success");
    fixture.assertCurrent.mockRejectedValueOnce(
      new Error("external harness identity changed after evaluation plan admission"),
    );
    const infer = vi.fn<ExternalHarnessInferenceBroker["infer"]>();
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer },
      platform: "linux",
    });

    await expect(runtime.execute(fixture.request)).rejects.toThrow(/identity.*changed/i);
    expect(fixture.assertCurrent).toHaveBeenCalledTimes(1);
    expect(infer).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("does not start the driver when the artifact check crosses the execution deadline", async () => {
    const fixture = await runtimeFixture("success");
    fixture.assertCurrent.mockImplementationOnce(async () => new Promise<void>(() => undefined));
    const beforeHelloWrite = vi.fn();
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: async () => '{"message":"ok"}' },
      platform: "linux",
      beforeHelloWrite,
    });
    const request = {
      ...fixture.request,
      evaluation: {
        ...fixture.request.evaluation,
        controls: {
          ...fixture.request.evaluation.controls,
          budget: { ...fixture.request.evaluation.controls.budget, maxExecutionMs: 10 },
        },
      },
    };

    const result = await runtime.execute(request);

    expect(result).toMatchObject({ harness: { outcome: "timed_out" } });
    expect(result.harness).not.toHaveProperty("runtime");
    expect(beforeHelloWrite).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("does not start the driver when cancellation arrives during the artifact check", async () => {
    const fixture = await runtimeFixture("success");
    const controller = new AbortController();
    fixture.assertCurrent.mockImplementationOnce(async () => {
      controller.abort(new Error("operator cancelled evaluation"));
    });
    const beforeHelloWrite = vi.fn();
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: async () => '{"message":"ok"}' },
      platform: "linux",
      beforeHelloWrite,
    });

    await expect(runtime.execute(fixture.request, controller.signal)).resolves.toMatchObject({
      harness: { outcome: "cancelled", reason: "operator cancelled evaluation" },
    });
    expect(beforeHelloWrite).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("exchanges one inference request and records parent-observed process evidence", async () => {
    const fixture = await runtimeFixture("success");
    const infer = vi.fn<ExternalHarnessInferenceBroker["infer"]>(async (request) => {
      expect(request.body).toBe('{"context":[]}');
      return '{"message":"ok"}';
    });
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer },
      platform: "linux",
    });

    const result = await runtime.execute(fixture.request);

    expect(infer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      harness: {
        outcome: "completed",
        runId: "pi-session",
        runtime: {
          adapter: "pi-native-v1",
          containment: "linux-pid-namespace",
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          treeTermination: "confirmed",
        },
      },
    });
    expect(fixture.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: process.execPath,
        args: [fixture.driverPath],
        cwd: fixture.workspace,
        projectRoot: fixture.root,
        protectedPaths: [fixture.root, join(fixture.workspace, "TASK.md")],
        runtimeSupportPaths: [fixture.root],
      }),
    );
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("terminates a driver that sends a forged frame", async () => {
    const fixture = await runtimeFixture("forged");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: {
        outcome: "malformed_output",
        reason: expect.stringMatching(/authentication|forged|MAC/i),
        runtime: { treeTermination: "confirmed" },
      },
    });
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("records missing output when a clean driver exit has no terminal frame", async () => {
    const fixture = await runtimeFixture("missing-terminal");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: {
        outcome: "missing_output",
        runtime: { exitCode: 0, treeTermination: "confirmed" },
      },
    });
  });

  it("stops the process before it reports an initial control-write failure", async () => {
    const fixture = await runtimeFixture("idle");
    let childPid: number | undefined;
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
      beforeHelloWrite: (child) => {
        childPid = child.pid;
        child.stdin?.destroy();
      },
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: {
        outcome: "crashed",
        reason: expect.stringMatching(/control input is closed/),
        runtime: { treeTermination: "confirmed" },
      },
    });

    expect(childPid).toBeTypeOf("number");
    expect(isProcessAlive(childPid)).toBe(false);
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("stops a descendant after the driver exits normally", async () => {
    const fixture = await runtimeFixture("descendant");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
    });
    let descendantPid: number | undefined;

    try {
      await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
        harness: {
          outcome: "completed",
          runtime: { treeTermination: "confirmed" },
        },
      });
      descendantPid = Number(await readFile(join(fixture.workspace, "descendant.pid"), "utf8"));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (isProcessAlive(descendantPid)) {
        process.kill(descendantPid as number, "SIGKILL");
      }
    }
  });

  it("records cancellation after it stops the process tree", async () => {
    const fixture = await runtimeFixture("idle");
    const controller = new AbortController();
    let childPid: number | undefined;
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
      beforeHelloWrite: (child) => {
        childPid = child.pid;
        setTimeout(() => controller.abort("test cancellation"), 25);
      },
    });

    await expect(runtime.execute(fixture.request, controller.signal)).resolves.toMatchObject({
      harness: {
        outcome: "cancelled",
        reason: "test cancellation",
        runtime: { aborted: true, treeTermination: "confirmed" },
      },
    });
    expect(isProcessAlive(childPid)).toBe(false);
    expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("ends a blocked inference call at the execution deadline", async () => {
    const fixture = await runtimeFixture("success");
    let childPid: number | undefined;
    const deadlineController = new AbortController();
    const deadlineReason = new Error("external harness exceeded 30000ms");
    const deadline = {
      signal: deadlineController.signal,
      reason: deadlineReason,
      get expired() {
        return deadlineController.signal.aborted;
      },
      remainingMs: () => (deadlineController.signal.aborted ? 0 : 30_000),
      dispose: vi.fn(),
    };
    const infer = vi.fn<ExternalHarnessInferenceBroker["infer"]>(async () => {
      deadlineController.abort(deadlineReason);
      return new Promise<string>(() => undefined);
    });
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
      deadlineFactory: () => deadline,
      beforeHelloWrite: (child) => {
        childPid = child.pid;
      },
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: {
        outcome: "timed_out",
        runtime: { timedOut: true, treeTermination: "confirmed" },
      },
    });
    expect(infer).toHaveBeenCalledTimes(1);
    expect(isProcessAlive(childPid)).toBe(false);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(deadline.dispose).toHaveBeenCalledTimes(1);
  });

  it("accepts the exact standard-error transport limit", async () => {
    const fixture = await runtimeFixture("stderr-exact");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: { outcome: "completed" },
    });
  });

  it("terminates one byte over the standard-error transport limit", async () => {
    const fixture = await runtimeFixture("stderr-over");
    const runtime = new LocalExternalHarnessRuntime({
      registry: fixture.registry,
      sandbox: fixture.sandbox,
      inferenceBroker: { infer: vi.fn() },
      platform: "linux",
      terminationGraceMs: 10,
      terminationConfirmationMs: 1_000,
    });

    await expect(runtime.execute(fixture.request)).resolves.toMatchObject({
      harness: {
        outcome: "malformed_output",
        reason: expect.stringMatching(/standard error|diagnostic|byte limit/i),
        runtime: { treeTermination: "confirmed" },
      },
    });
  });
});

async function runtimeFixture(
  mode:
    | "success"
    | "forged"
    | "missing-terminal"
    | "idle"
    | "descendant"
    | "stderr-exact"
    | "stderr-over",
) {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  const driverPath = join(root, "fake-driver.mjs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(join(workspace, "TASK.md"), "Create RESULT.md.\n", "utf8");
  await writeFile(driverPath, fakeDriverSource(mode), "utf8");
  const identity = externalIdentity();
  const assertCurrent = vi.fn<() => Promise<void>>(async () => undefined);
  const descriptor = {
    identity,
    identityDigest: externalHarnessIdentityDigest(identity),
    launch: {
      executable: process.execPath,
      args: [driverPath],
      runtimeSupportPaths: [root],
    },
    assertCurrent,
  } as NativePiHarnessDescriptor & { readonly assertCurrent: () => Promise<void> };
  const registry: ExternalHarnessDescriptorRegistry = {
    resolveAdmitted: async () => descriptor,
  };
  const release = vi.fn(async () => undefined);
  const prepare = vi.fn<CommandSandbox["prepare"]>(async (request) => ({
    processContainment: "linux-pid-namespace",
    launch: {
      executable: request.executable,
      args: request.args,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
    evidence: {
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      profile: "workspace-write-network-deny-v1",
      policyDigest: identity.runtime.policyDigest,
    },
    release,
  }));
  const evaluation = evaluationRequest(workspace);
  const request: ExternalHarnessRuntimeRequest = {
    identity,
    evaluation,
    isolation: { projectRoot: root, protectedPaths: [root] },
  };
  return {
    root,
    workspace,
    driverPath,
    registry,
    sandbox: { prepare },
    prepare,
    release,
    assertCurrent,
    request,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-external-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function evaluationRequest(workspace: string): HarnessEvaluationRequest {
  return {
    planDigest: "a".repeat(64),
    trial: {
      trialId: `trial-${"b".repeat(48)}`,
      position: 1,
      taskId: "task",
      profileId: "candidate",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-trial-${"b".repeat(48)}`,
      cwd: workspace,
      backend: "reflink-copy-v1",
      snapshotDigest: "c".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: sha256("Create RESULT.md.\n") },
    controls: {
      model: { provider: "test-provider", id: "test-model", thinking: "off" },
      budget: {
        maxNodeStarts: 8,
        maxModelTokens: 4_096,
        maxCostUsdMicros: 100_000,
        maxExecutionMs: 30_000,
        maxArtifactBytes: 1_048_576,
      },
      network: "deny",
      retry: { providerRetries: 0, harnessRetries: 0 },
    },
  };
}

function externalIdentity(): ExternalHarnessIdentity {
  return {
    version: 1,
    adapter: "pi-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "2".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-pi-evaluation-v1",
      artifactSha256: "3".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      node: { version: "22.19.0", executableSha256: "3".repeat(64) },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      integrity: `sha512-${"A".repeat(86)}==`,
      packageContentSha256: "4".repeat(64),
      config: "pi-evaluation-v1",
      configDigest: "4".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1",
      version: 1,
      package: "@earendil-works/pi-ai",
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "5".repeat(64),
    },
  };
}

function fakeDriverSource(
  mode:
    | "success"
    | "forged"
    | "missing-terminal"
    | "idle"
    | "descendant"
    | "stderr-exact"
    | "stderr-over",
): string {
  return `
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const hello = JSON.parse((await lines.next()).value);
const secretHex = hello.payload.secretHex;
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function send(sequence, type, payload, forged = false) {
  const unsigned = { version: 1, sequence, sessionId: hello.sessionId, type, payload };
  const mac = forged ? "0".repeat(64) : createHmac("sha256", Buffer.from(secretHex, "hex")).update(canonical(unsigned)).digest("hex");
  process.stdout.write(JSON.stringify({ ...unsigned, mac }) + "\\n");
}
send(1, "ready", { trialId: hello.payload.trialId, identityDigest: hello.payload.identityDigest }, ${mode === "forged"});
if (${JSON.stringify(mode)} === "missing-terminal" || ${JSON.stringify(mode)} === "forged") process.exit(0);
if (${JSON.stringify(mode)} === "idle") await new Promise(() => {});
if (${JSON.stringify(mode)} === "stderr-exact" || ${JSON.stringify(mode)} === "stderr-over") {
  const bytes = ${MAX_EXTERNAL_HARNESS_STDERR_BYTES} + (${JSON.stringify(mode)} === "stderr-over" ? 1 : 0);
  await new Promise((resolve, reject) => process.stderr.write("x".repeat(bytes), (error) => error ? reject(error) : resolve()));
  if (${JSON.stringify(mode)} === "stderr-over") await new Promise(() => {});
  send(2, "terminal", { harness: { outcome: "completed", runId: "pi-session", reason: null }, metrics: { costUsdMicros: null, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, turns: null, toolCalls: null, toolErrors: null, wallTimeMs: null, activeTimeMs: null, interventions: null, policyViolations: null, recoveryAttempts: null, recoveryOutcome: null } });
  process.exit(0);
}
if (${JSON.stringify(mode)} === "descendant") {
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync("descendant.pid", String(descendant.pid));
  send(2, "terminal", { harness: { outcome: "completed", runId: "pi-session", reason: null }, metrics: { costUsdMicros: null, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, turns: null, toolCalls: null, toolErrors: null, wallTimeMs: null, activeTimeMs: null, interventions: null, policyViolations: null, recoveryAttempts: null, recoveryOutcome: null } });
  process.exit(0);
}
const body = '{"context":[]}';
send(2, "inference_request", { requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71", body, bodySha256: createHash("sha256").update(body).digest("hex") });
await lines.next();
send(3, "terminal", { harness: { outcome: "completed", runId: "pi-session", reason: null }, metrics: { costUsdMicros: null, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, turns: null, toolCalls: null, toolErrors: null, wallTimeMs: null, activeTimeMs: null, interventions: null, policyViolations: null, recoveryAttempts: null, recoveryOutcome: null } });
`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
