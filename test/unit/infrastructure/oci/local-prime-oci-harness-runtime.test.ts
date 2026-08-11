import { describe, expect, it, vi } from "vitest";
import type { HarnessEvaluationResult } from "../../../../src/application/evaluation-adapter.js";
import type { ExternalHarnessRuntimeRequest } from "../../../../src/application/external-harness-adapter.js";
import type {
  EvaluationOciLease,
  EvaluationTrialAttempt,
} from "../../../../src/domain/evaluation/attempt.js";
import { unavailableEvaluationMetrics } from "../../../../src/domain/evaluation/records.js";
import {
  LocalPrimeOciHarnessRuntime,
  type PrimeOciOperationEvidence,
} from "../../../../src/infrastructure/oci/local-prime-oci-harness-runtime.js";
import type { PrimeOciEngine } from "../../../../src/infrastructure/oci/prime-container-lifecycle.js";
import type { NativePrimeHarnessDescriptor } from "../../../../src/infrastructure/prime/native-prime-harness-registry.js";
import {
  type PrimeExternalHarnessIdentity,
  primeExternalHarnessIdentity,
} from "../../../fixtures/evaluation/prime-external-harness-identity.js";

type PrimeRuntimeRequest = ExternalHarnessRuntimeRequest & {
  readonly identity: PrimeExternalHarnessIdentity;
};

describe("local Prime OCI harness runtime", () => {
  it("runs one Prime trial and returns only after durable removal", async () => {
    const updates: EvaluationOciLease[] = [];
    const descriptor = primeDescriptor();
    const evidence = completedEvidence();
    vi.mocked(evidence.publishResult).mockImplementation(async () => {
      expect(updates.at(-1)?.state).toBe("removed");
    });
    const operate = vi.fn(async (input) => {
      await input.checkpoint("terminal");
      await input.checkpoint("exported");
      return evidence;
    });
    const globalAdmission = fakeGlobalAdmission();
    const clockMs = vi
      .fn()
      .mockReturnValueOnce(10.2)
      .mockImplementationOnce(() => {
        expect(globalAdmission.release).toHaveBeenCalledOnce();
        return 25.8;
      });
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission,
      createEngine: vi.fn(async () => fakeEngine()),
      createIntent: vi.fn(async (request) => intentLease(request.evaluation.trial.trialId)),
      operate,
      platform: "linux",
      clockMs,
    });
    const request = runtimeRequest(async (lease) => {
      updates.push(lease);
    });

    await expect(runtime.execute(request)).resolves.toEqual({
      harness: {
        outcome: "completed",
        runId: "prime-session",
        reason: null,
        runtime: {
          adapter: "prime-agent-native-v1",
          containment: "docker-oci-v1",
          engineStatus: "verified",
          imageId: request.identity.image.id,
          policyDigest: request.identity.runtime.policy.digest,
          exitCode: 0,
          timedOut: false,
          aborted: false,
          recoveryOutcome: "not_attempted",
          removal: "confirmed",
        },
      },
      metrics: { ...unavailableEvaluationMetrics(), wallTimeMs: 16 },
    });
    expect(evidence.finishMetrics).toHaveBeenCalledWith({ startedAtMs: 10.2, endedAtMs: 25.8 });
    expect(evidence.publishResult).toHaveBeenCalledOnce();
    expect(updates.map((lease) => lease.state)).toEqual([
      "intent",
      "created",
      "started",
      "terminal",
      "exported",
      "stopped",
      "removed",
    ]);
    expect(descriptor.assertCurrent).toHaveBeenCalledTimes(1);
    expect(globalAdmission.acquire).toHaveBeenCalledOnce();
    expect(globalAdmission.release).toHaveBeenCalledOnce();
    expect(operate).toHaveBeenCalledTimes(1);
  });

  it("rejects missing durability and non-Linux execution before create", async () => {
    const createEngine = vi.fn(async () => fakeEngine());
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => primeDescriptor()) },
      globalAdmission: fakeGlobalAdmission(),
      createEngine,
      createIntent: vi.fn(),
      operate: vi.fn(),
      platform: "darwin",
    });
    const request = runtimeRequest(async () => undefined);
    const { durability: _durability, ...evaluationWithoutDurability } = request.evaluation;

    await expect(runtime.execute(request)).rejects.toThrow(/linux/i);
    await expect(
      new LocalPrimeOciHarnessRuntime({
        registry: { resolveAdmitted: vi.fn(async () => primeDescriptor()) },
        globalAdmission: fakeGlobalAdmission(),
        createEngine,
        createIntent: vi.fn(),
        operate: vi.fn(),
        platform: "linux",
      }).execute({
        ...request,
        evaluation: evaluationWithoutDurability,
      }),
    ).rejects.toThrow(/durable/i);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("recovers an intent that has no Docker object", async () => {
    const descriptor = primeDescriptor();
    const engine = fakeEngine({ recoveredIntent: null });
    const globalAdmission = fakeGlobalAdmission();
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission,
      createEngine: vi.fn(async () => engine),
      createIntent: vi.fn(),
      operate: vi.fn(),
      recoverWorkspace: vi.fn(async () => undefined),
      platform: "linux",
    });
    const request = runtimeRequest(async () => undefined);
    const attempt = {
      version: 1 as const,
      planDigest: request.evaluation.planDigest,
      position: 1,
      trialId: request.evaluation.trial.trialId,
      taskId: "task",
      profileId: "candidate",
      adapter: "prime-agent-native-v1" as const,
      startedAt: "2026-08-10T10:00:00.000Z",
      workspace: { backend: "reflink-copy-v1" as const, snapshotDigest: "d".repeat(64) },
      ociLease: intentLease(request.evaluation.trial.trialId),
    };
    const updates: EvaluationOciLease[] = [];

    const recovered = await runtime.recoverAttempt({
      identity: request.identity,
      attempt,
      workspaceRoot: request.evaluation.workspace.cwd,
      updateOciLease: async (lease) => {
        updates.push(lease);
      },
    });

    expect(recovered.ociLease?.state).toBe("absent");
    expect(globalAdmission.recover).toHaveBeenCalledOnce();
    expect(updates.map((lease) => lease.state)).toEqual(["absent"]);
  });

  it("recovers global admission before an OCI intent exists", async () => {
    const descriptor = primeDescriptor();
    const globalAdmission = fakeGlobalAdmission();
    const recoverWorkspace = vi.fn(async () => undefined);
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission,
      createEngine: vi.fn(async () => fakeEngine()),
      createIntent: vi.fn(),
      operate: vi.fn(),
      recoverWorkspace,
      platform: "linux",
    });
    const request = runtimeRequest(async () => undefined);
    const attempt: EvaluationTrialAttempt = {
      version: 1,
      planDigest: request.evaluation.planDigest,
      position: request.evaluation.trial.position,
      trialId: request.evaluation.trial.trialId,
      taskId: request.evaluation.trial.taskId,
      profileId: request.evaluation.trial.profileId,
      adapter: "prime-agent-native-v1",
      startedAt: "2026-08-10T10:00:00.000Z",
      workspace: { backend: "reflink-copy-v1", snapshotDigest: "d".repeat(64) },
    };
    const updateOciLease = vi.fn();

    await expect(
      runtime.recoverAttempt({
        identity: request.identity,
        attempt,
        workspaceRoot: request.evaluation.workspace.cwd,
        updateOciLease,
      }),
    ).resolves.toEqual(attempt);
    expect(globalAdmission.recover).toHaveBeenCalledOnce();
    expect(recoverWorkspace).toHaveBeenCalledWith(request.evaluation.workspace.cwd, undefined);
    expect(updateOciLease).not.toHaveBeenCalled();
  });

  it("returns a typed timeout only after durable container removal", async () => {
    const descriptor = primeDescriptor();
    const deadlineController = new AbortController();
    const cleanupController = new AbortController();
    const cleanupSignalFactory = vi.fn(() => cleanupController.signal);
    const clockValues = [10, 42];
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission: fakeGlobalAdmission(),
      createEngine: vi.fn(async () => fakeEngine()),
      createIntent: vi.fn(async (request) => intentLease(request.evaluation.trial.trialId)),
      operate: vi.fn(async () => {
        expect(cleanupSignalFactory).not.toHaveBeenCalled();
        const reason = new Error("Prime execution deadline expired");
        deadlineController.abort(reason);
        throw reason;
      }),
      platform: "linux",
      clockMs: () => clockValues.shift() ?? 42,
      deadlineFactory: () => ({
        signal: deadlineController.signal,
        get expired() {
          return deadlineController.signal.aborted;
        },
        dispose: vi.fn(),
      }),
      cleanupSignalFactory,
    });
    const request = runtimeRequest(async () => undefined);

    await expect(runtime.execute(request)).resolves.toEqual({
      harness: {
        outcome: "timed_out",
        runId: null,
        reason: "Prime execution exceeded 30000ms",
        runtime: {
          adapter: "prime-agent-native-v1",
          containment: "docker-oci-v1",
          engineStatus: "verified",
          imageId: request.identity.image.id,
          policyDigest: request.identity.runtime.policy.digest,
          exitCode: null,
          timedOut: true,
          aborted: false,
          recoveryOutcome: "not_attempted",
          removal: "confirmed",
        },
      },
      metrics: {
        ...unavailableEvaluationMetrics(),
        wallTimeMs: 32,
        interventions: 1,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    expect(cleanupSignalFactory).toHaveBeenCalledWith(30_000);
  });

  it("terminates a running container after the host monitor rejects its policy", async () => {
    const descriptor = primeDescriptor();
    const globalAdmission = fakeGlobalAdmission();
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission,
      createEngine: vi.fn(async () => fakeEngine()),
      createIntent: vi.fn(async (request) => intentLease(request.evaluation.trial.trialId)),
      monitorHost: vi.fn(async () => {
        throw new Error("Prime runtime image latency exceeded the admitted policy three times");
      }),
      operate: vi.fn(
        async (input) =>
          new Promise<never>((_resolve, reject) => {
            const abort = () => reject(input.signal?.reason);
            input.signal?.addEventListener("abort", abort, { once: true });
          }),
      ),
      platform: "linux",
      clockMs: () => 10,
    });
    const request = runtimeRequest(async () => undefined);

    const result = await runtime.execute(request);

    expect(result.harness).toMatchObject({
      outcome: "crashed",
      reason: "Prime runtime image latency exceeded the admitted policy three times",
      runtime: {
        adapter: "prime-agent-native-v1",
        removal: "confirmed",
        timedOut: false,
        aborted: false,
      },
    });
    expect(result.metrics).toMatchObject({ interventions: 1, policyViolations: null });
    expect(globalAdmission.release).toHaveBeenCalledOnce();
  });

  it("rejects a child outcome that contradicts trusted OCI settlement", async () => {
    const descriptor = primeDescriptor();
    const runtime = new LocalPrimeOciHarnessRuntime({
      registry: { resolveAdmitted: vi.fn(async () => descriptor) },
      globalAdmission: fakeGlobalAdmission(),
      createEngine: vi.fn(async () => fakeEngine()),
      createIntent: vi.fn(async (request) => intentLease(request.evaluation.trial.trialId)),
      operate: vi.fn(async (input): Promise<PrimeOciOperationEvidence> => {
        await input.checkpoint("terminal");
        await input.checkpoint("exported");
        return {
          harness: { outcome: "completed", runId: "prime-session", reason: null },
          settlement: {
            exitCode: null,
            timedOut: true,
            aborted: false,
            kernelRequests: 1,
          },
          publishResult: vi.fn(async () => undefined),
          abortResult: vi.fn(async () => undefined),
          finishMetrics: () => unavailableEvaluationMetrics(),
        };
      }),
      platform: "linux",
    });

    await expect(runtime.execute(runtimeRequest(async () => undefined))).rejects.toThrow(
      /outcome.*settlement|settlement.*outcome/i,
    );
  });
});

function runtimeRequest(
  updateOciLease: (lease: EvaluationOciLease) => Promise<void>,
): PrimeRuntimeRequest {
  return {
    identity: primeExternalHarnessIdentity(),
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId: `trial-${"b".repeat(48)}`,
        position: 1,
        taskId: "task",
        profileId: "candidate",
        seed: 11,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-trial-${"b".repeat(48)}`,
        cwd: "/workspace",
        backend: "reflink-copy-v1",
        snapshotDigest: "c".repeat(64),
      },
      instruction: { path: "TASK.md", sha256: "d".repeat(64) },
      controls: {
        model: { provider: "test", id: "model", thinking: "off" },
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
      durability: { updateOciLease },
    },
    isolation: { projectRoot: "/project", protectedPaths: ["/project/.flow"] },
  };
}

function primeDescriptor(): NativePrimeHarnessDescriptor & {
  readonly assertCurrent: ReturnType<typeof vi.fn>;
} {
  const identity = primeExternalHarnessIdentity();
  return {
    identity,
    identityDigest: "e".repeat(64),
    localRuntime: {
      daemonId: "daemon-test-id",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 2, uid: 0, gid: 999, mode: 0o660 },
      apiVersion: "1.51",
      cgroupPath: "/sys/fs/cgroup/flow-prime",
      corePattern: "core",
      globalLeasePath: "/var/lib/flow-prime/global-slot.json",
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      leaseTarget: "flow-prime-global-v1",
      seccompProfile: { defaultAction: "SCMP_ACT_ERRNO", syscalls: [] },
    },
    assertCurrent: vi.fn(async () => undefined),
  };
}

function fakeEngine(
  options: { readonly recoveredIntent?: PrimeOciEngine extends never ? never : null } = {},
): PrimeOciEngine {
  const attached = {
    output: (async function* () {})(),
    write: vi.fn(async () => undefined),
    closeInput: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  return {
    create: vi.fn(async () => ({
      containerId: "f".repeat(64),
      inspectedPolicyDigest: "9".repeat(64),
    })),
    recoverIntent: vi.fn(async () => options.recoveredIntent ?? null),
    attach: vi.fn(async () => attached),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    confirmRemoved: vi.fn(async () => true),
  };
}

function intentLease(trialId: string) {
  const ownerNonce = "1".repeat(64);
  const imageId = `sha256:${"2".repeat(64)}` as const;
  const policyDigest = "9".repeat(64);
  return {
    version: 1 as const,
    adapter: "prime-agent-native-v1" as const,
    state: "intent" as const,
    ownerNonce,
    containerName: `flow-prime-${"3".repeat(32)}` as const,
    labels: {
      evaluationId: "evaluation-run",
      trialId,
      ownerNonce,
      imageId,
      policyDigest,
    },
    imageId,
    policyDigest,
    fixtureDigest: "4".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock" as const,
      device: 1,
      inode: 2,
      uid: 0,
      gid: 999,
      mode: 0o660,
    },
  };
}

function completedEvidence(): PrimeOciOperationEvidence & {
  readonly publishResult: ReturnType<typeof vi.fn>;
  readonly abortResult: ReturnType<typeof vi.fn>;
} {
  return {
    harness: { outcome: "completed", runId: "prime-session", reason: null },
    settlement: { exitCode: 0, timedOut: false, aborted: false, kernelRequests: 1 },
    publishResult: vi.fn(async () => undefined),
    abortResult: vi.fn(async () => undefined),
    finishMetrics: vi.fn((): HarnessEvaluationResult["metrics"] => ({
      ...unavailableEvaluationMetrics(),
      wallTimeMs: 16,
    })),
  };
}

function fakeGlobalAdmission() {
  const lease = {
    version: 1 as const,
    state: "owned" as const,
    lockName: "flow-prime-global-v1" as const,
    ownerNonce: "1".repeat(64),
    policyDigest: "9".repeat(64),
    daemonId: "daemon-test-id",
    objectId: "2".repeat(64),
  };
  return {
    acquire: vi.fn(async () => lease),
    release: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
  };
}
