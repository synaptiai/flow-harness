import { describe, expect, it, vi } from "vitest";
import {
  CapabilityRepositoryFirstActivationError,
  type CapabilityRepositoryFirstActivationStateContent,
  runCapabilityRepositoryFirstActivation,
} from "../../../src/application/capability-repository-first-activation.js";
import { createCapabilityBundleSource } from "../../../src/domain/capability/capability-bundles.js";

const PUBLISHER = Object.freeze({
  kind: "sigstore-keyless-v0.3" as const,
  certificateIssuer: "https://issuer.example.test/",
  certificateIdentity: "https://publisher.example.test/release",
  signatureBundleDigest: `sha256:${"9".repeat(64)}`,
});

describe("capability repository first activation", () => {
  it("rejects invalid authorization before any boundary", async () => {
    const dependencies = {
      state: { read: vi.fn(), publish: vi.fn() },
      readInstalled: vi.fn(),
      check: vi.fn(),
      reopen: vi.fn(),
      install: vi.fn(),
      now: vi.fn(),
      wait: vi.fn(),
      observe: vi.fn(),
    };

    await expect(
      runCapabilityRepositoryFirstActivation(dependencies, {
        packageName: "PRIVATE INVALID NAME",
        version: "1.0.0",
        certificateIssuer: "https://issuer.example.test/",
        certificateIdentity: "https://publisher.example.test/release",
        intervalMs: 60_000,
        maxChecks: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("validate activation policy"));

    expect(dependencies.state.read).not.toHaveBeenCalled();
    expect(dependencies.state.publish).not.toHaveBeenCalled();
    expect(dependencies.readInstalled).not.toHaveBeenCalled();
    expect(dependencies.check).not.toHaveBeenCalled();
    expect(dependencies.reopen).not.toHaveBeenCalled();
    expect(dependencies.install).not.toHaveBeenCalled();
    expect(dependencies.now).not.toHaveBeenCalled();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.observe).not.toHaveBeenCalled();
  });

  it("waits once, prepares the exact receipt, installs, and settles", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const trace: string[] = [];
    let stateVersion = 0;
    const publish = vi.fn(
      async (input: { readonly state: CapabilityRepositoryFirstActivationStateContent }) => {
        trace.push(`state:${String(input.state.status)}`);
        stateVersion += 1;
        return Object.freeze({
          ...input.state,
          recordDigest: `sha256:${String(stateVersion).padStart(64, "0")}`,
        });
      },
    );

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state: {
          read: vi.fn(async () => {
            trace.push("state:read");
            return undefined;
          }),
          publish,
        },
        readInstalled: vi.fn(async () => {
          trace.push("installed:read");
          return [];
        }),
        wait: vi.fn(async () => {
          trace.push("wait");
        }),
        now: sequenceClock([
          "2027-01-01T00:00:00.000Z",
          "2027-01-01T00:01:00.000Z",
          "2027-01-01T00:01:01.000Z",
          "2027-01-01T00:01:02.000Z",
        ]),
        check: vi.fn(async () => {
          trace.push("check");
          return {
            status: "staged" as const,
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          };
        }),
        reopen: vi.fn(async () => {
          trace.push("reopen");
          return {
            identity: candidate,
            capabilityBundle: bundle.content,
          };
        }),
        install: vi.fn(async () => {
          trace.push("install");
          return {
            outcome: "settled" as const,
            result: { status: "installed" as const, bundle: bundle.bundle },
          };
        }),
        observe: vi.fn(async (status: { readonly outcome: string }) => {
          trace.push(`observe:${status.outcome}`);
        }),
      },
      activationInput(),
    );

    expect(result).toEqual({
      outcome: "activated",
      attempts: 1,
      package: {
        name: "review-suite",
        version: "1.0.0",
        digest: bundle.bundle.digest,
      },
    });
    expect(trace).toEqual([
      "installed:read",
      "state:read",
      "state:waiting",
      "observe:activation_started",
      "wait",
      "state:waiting",
      "check",
      "reopen",
      "state:prepared",
      "installed:read",
      "install",
      "state:settled",
      "observe:activated",
    ]);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it("consumes finite attempts for missing exact candidates and terminates", async () => {
    const state = inMemoryState();
    const wait = vi.fn().mockResolvedValue(undefined);
    const check = vi.fn().mockResolvedValue({
      status: "staged",
      checkedAt: "2027-01-01T00:01:00.000Z",
      candidates: [
        {
          ...repositoryCandidate(capabilityBundle().bundle),
          bundle: {
            ...repositoryCandidate(capabilityBundle().bundle).bundle,
            version: "1.0.1",
          },
        },
      ],
    });
    const statuses: unknown[] = [];
    const reopen = vi.fn();
    const install = vi.fn();

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state,
        readInstalled: vi.fn().mockResolvedValue([]),
        wait,
        now: sequenceClock([
          "2027-01-01T00:00:00.000Z",
          "2027-01-01T00:01:00.000Z",
          "2027-01-01T00:01:01.000Z",
          "2027-01-01T00:02:01.000Z",
          "2027-01-01T00:02:02.000Z",
        ]),
        check,
        reopen,
        install,
        observe: async (status) => {
          statuses.push(status);
        },
      },
      activationInput(),
    );

    expect(result).toEqual({ outcome: "attempts_exhausted", attempts: 2 });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
    expect(reopen).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(statuses).toEqual([
      { outcome: "activation_started", attempts: 0, maximumAttempts: 2 },
      { outcome: "candidate_unavailable", attempts: 1, maximumAttempts: 2 },
      { outcome: "candidate_unavailable", attempts: 2, maximumAttempts: 2 },
      { outcome: "attempts_exhausted", attempts: 2 },
    ]);
  });

  it("rejects an installed package before waiting or checking the repository", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState();
    const wait = vi.fn();
    const check = vi.fn();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([
            {
              entry: {
                name: bundle.bundle.name,
                version: bundle.bundle.version,
                source: "https://packages.example.test/targets/10/review-suite.flowpkg.json",
                digest: bundle.bundle.digest,
                bytes: bundle.bundle.bytes,
                publisher: PUBLISHER,
              },
              bundle: bundle.bundle,
            },
          ]),
          wait,
          now: vi.fn(),
          check,
          reopen: vi.fn(),
          install: vi.fn(),
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("read installed package"));

    expect(state.publish).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("returns idempotent success for an exact settled installation without later work", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState(activationState("settled", bundle.bundle));
    const check = vi.fn();
    const install = vi.fn();
    const observe = vi.fn();

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state,
        readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
        wait: vi.fn(),
        now: vi.fn(),
        check,
        reopen: vi.fn(),
        install,
        observe,
      },
      activationInput(),
    );

    expect(result).toEqual({
      outcome: "already_activated",
      attempts: 1,
      package: {
        name: bundle.bundle.name,
        version: bundle.bundle.version,
        digest: bundle.bundle.digest,
      },
    });
    expect(state.publish).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(result);
  });

  it("never reinstalls a settled activation after its package is removed", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState(activationState("settled", bundle.bundle));
    const wait = vi.fn();
    const check = vi.fn();
    const install = vi.fn();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait,
          now: vi.fn(),
          check,
          reopen: vi.fn(),
          install,
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("read installed package"));

    expect(state.publish).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("settles a prepared exact installation without checking or installing twice", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const wait = vi.fn();
    const check = vi.fn();
    const install = vi.fn();

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state,
        readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
        wait,
        now: sequenceClock(["2027-01-01T00:02:00.000Z"]),
        check,
        reopen: vi.fn(),
        install,
        settlePackageMutation: vi.fn().mockResolvedValue(undefined),
        observe: vi.fn(),
      },
      activationInput(),
    );

    expect(result).toEqual({
      outcome: "already_activated",
      attempts: 1,
      package: {
        name: bundle.bundle.name,
        version: bundle.bundle.version,
        digest: bundle.bundle.digest,
      },
    });
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ status: "settled" }) }),
    );
    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("reopens an exact settled transition after state publication becomes uncertain", async () => {
    const bundle = capabilityBundle();
    const durable = inMemoryState(activationState("prepared", bundle.bundle));
    const publish = vi.fn(async (input: Parameters<typeof durable.publish>[0]) => {
      await durable.publish(input);
      throw new Error("PRIVATE_STATE_SETTLEMENT");
    });
    const observe = vi.fn();

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state: { read: durable.read, publish },
        readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
        wait: vi.fn(),
        now: sequenceClock(["2027-01-01T00:02:00.000Z"]),
        check: vi.fn(),
        reopen: vi.fn(),
        install: vi.fn(),
        settlePackageMutation: vi.fn().mockResolvedValue(undefined),
        observe,
      },
      activationInput(),
    );

    expect(result).toEqual({
      outcome: "already_activated",
      attempts: 1,
      package: {
        name: bundle.bundle.name,
        version: bundle.bundle.version,
        digest: bundle.bundle.digest,
      },
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(durable.read).toHaveBeenCalledTimes(2);
    await expect(
      durable.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "settled" });
    expect(observe).toHaveBeenCalledWith(result);
  });

  it("rejects a successful state response that contradicts the requested transition", async () => {
    const wait = vi.fn();
    const check = vi.fn();
    const read = vi.fn().mockResolvedValue(undefined);

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state: {
            read,
            publish: vi.fn(async ({ state }) => ({
              ...state,
              intervalMs: state.intervalMs + 1,
              recordDigest: `sha256:${"6".repeat(64)}` as const,
            })),
          },
          readInstalled: vi.fn().mockResolvedValue([]),
          wait,
          now: sequenceClock(["2027-01-01T00:00:00.000Z"]),
          check,
          reopen: vi.fn(),
          install: vi.fn(),
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("publish activation state"));

    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("resumes a prepared missing installation without another wait or check", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const wait = vi.fn();
    const check = vi.fn();
    const install = vi.fn().mockResolvedValue({
      outcome: "settled",
      result: { status: "installed", bundle: bundle.bundle },
    });
    const readInstalled = vi.fn().mockResolvedValue([]);

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state,
        readInstalled,
        wait,
        now: sequenceClock(["2027-01-01T00:02:00.000Z"]),
        check,
        reopen: vi
          .fn()
          .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
        install,
        observe: vi.fn(),
      },
      activationInput(),
    );

    expect(result).toEqual({
      outcome: "activated",
      attempts: 1,
      package: {
        name: bundle.bundle.name,
        version: bundle.bundle.version,
        digest: bundle.bundle.digest,
      },
    });
    expect(wait).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(readInstalled).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledOnce();
  });

  it("consumes finite attempts for private repository failures", async () => {
    const state = inMemoryState();
    const check = vi.fn().mockRejectedValue(new Error("PRIVATE_REPOSITORY_FAILURE"));
    const statuses: unknown[] = [];
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await runCapabilityRepositoryFirstActivation(
      {
        state,
        readInstalled: vi.fn().mockResolvedValue([]),
        wait,
        now: sequenceClock([
          "2027-01-01T00:00:00.000Z",
          "2027-01-01T00:01:00.000Z",
          "2027-01-01T00:01:01.000Z",
          "2027-01-01T00:02:01.000Z",
          "2027-01-01T00:02:02.000Z",
        ]),
        check,
        reopen: vi.fn(),
        install: vi.fn(),
        observe: async (status) => {
          statuses.push(status);
        },
      },
      activationInput(),
    );

    expect(result).toEqual({ outcome: "attempts_exhausted", attempts: 2 });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([
      { outcome: "activation_started", attempts: 0, maximumAttempts: 2 },
      { outcome: "check_failed", attempts: 1, maximumAttempts: 2 },
      { outcome: "check_failed", attempts: 2, maximumAttempts: 2 },
      { outcome: "attempts_exhausted", attempts: 2 },
    ]);
    expect(JSON.stringify(statuses)).not.toContain("PRIVATE");
  });

  it("rejects a reopened policy package before preparation or installation", async () => {
    const bundle = policyCapabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const install = vi.fn();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("verify candidate package"));

    expect(install).not.toHaveBeenCalled();
    expect(state.publish).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous exact candidates without reopening either one", async () => {
    const bundle = capabilityBundle();
    const first = repositoryCandidate(bundle.bundle);
    const second = {
      ...repositoryCandidate(bundle.bundle),
      candidateDigest: `sha256:${"7".repeat(64)}` as const,
    };
    const reopen = vi.fn();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state: inMemoryState(),
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [first, second],
          }),
          reopen,
          install: vi.fn(),
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("select candidate"));

    expect(reopen).not.toHaveBeenCalled();
  });

  it("stops on clock rollback before consuming an attempt or checking", async () => {
    const state = inMemoryState();
    const check = vi.fn();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock(["2027-01-01T00:00:00.000Z", "2026-12-31T23:59:59.000Z"]),
          check,
          reopen: vi.fn(),
          install: vi.fn(),
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("observe clock"));

    expect(state.publish).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
  });

  it("does not reconcile an ordinary precommit install rejection", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const readInstalled = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactInstalled(bundle.bundle)]);

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install: vi.fn().mockRejectedValue(new Error("PRIVATE_PRECOMMIT_REJECTION")),
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("install candidate"));

    expect(readInstalled).toHaveBeenCalledTimes(2);
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("reconciles only an explicitly commit-uncertain install outcome", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const readInstalled = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactInstalled(bundle.bundle)]);
    const settlePackageMutation = vi.fn().mockResolvedValue(undefined);
    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install: vi.fn().mockResolvedValue({ outcome: "commit_uncertain" }),
          settlePackageMutation,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).resolves.toMatchObject({ outcome: "activated" });

    expect(readInstalled).toHaveBeenCalledTimes(3);
    expect(settlePackageMutation).toHaveBeenCalledOnce();
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "settled" });
  });

  it("durably advances the prepared trusted-clock high-water before a precommit rejection", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const install = vi.fn(async (input: unknown) => {
      const advance = (
        input as {
          readonly advanceTrustedClockHighWater?: (observedAt: string) => Promise<void>;
        }
      ).advanceTrustedClockHighWater;
      if (advance === undefined) {
        throw new Error("trusted-clock advancement is missing");
      }
      await advance("2027-01-01T00:02:00.000Z");
      throw new Error("PRIVATE_PRECOMMIT_REJECTION");
    });

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn(),
          now: vi.fn(),
          check: vi.fn(),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install,
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("install candidate"));

    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({
      status: "prepared",
      lastObservedAt: "2027-01-01T00:02:00.000Z",
    });
  });

  it("reports mutation-lock settlement uncertainty after settling an exact recovered package", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const readInstalled = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactInstalled(bundle.bundle)]);
    const settlePackageMutation = vi.fn().mockResolvedValue(undefined);

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install: vi.fn().mockResolvedValue({ outcome: "settlement_uncertain" }),
          settlePackageMutation,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("settle activation"));

    expect(readInstalled).toHaveBeenCalledTimes(3);
    expect(settlePackageMutation).toHaveBeenCalledOnce();
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "settled" });
  });

  it.each([
    { label: "missing", reconciliation: [] },
    { label: "failed", reconciliation: new Error("PRIVATE_INSTALLED_READ_FAILURE") },
  ])(
    "preserves unresolved commit uncertainty over late cancellation when installed state is $label",
    async ({ reconciliation }) => {
      const bundle = capabilityBundle();
      const candidate = repositoryCandidate(bundle.bundle);
      const state = inMemoryState();
      const controller = new AbortController();
      const readInstalled = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      if (reconciliation instanceof Error) {
        readInstalled.mockRejectedValueOnce(reconciliation);
      } else {
        readInstalled.mockResolvedValueOnce(reconciliation);
      }

      await expect(
        runCapabilityRepositoryFirstActivation(
          {
            state,
            readInstalled,
            wait: vi.fn().mockResolvedValue(undefined),
            now: sequenceClock([
              "2027-01-01T00:00:00.000Z",
              "2027-01-01T00:01:00.000Z",
              "2027-01-01T00:01:01.000Z",
            ]),
            check: vi.fn().mockResolvedValue({
              status: "staged",
              checkedAt: "2027-01-01T00:01:00.000Z",
              candidates: [candidate],
            }),
            reopen: vi
              .fn()
              .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
            install: vi.fn(async () => {
              controller.abort(new Error("operator cancelled"));
              return { outcome: "commit_uncertain" as const };
            }),
            observe: vi.fn(),
          },
          { ...activationInput(), maxChecks: 1, signal: controller.signal },
        ),
      ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("settle activation"));

      await expect(
        state.read(activationInput(), new AbortController().signal),
      ).resolves.toMatchObject({ status: "prepared" });
    },
  );

  it("re-enters package mutation settlement before accepting a prepared exact installation", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const install = vi.fn();
    const settlePackageMutation = vi
      .fn()
      .mockRejectedValue(new Error("PRIVATE_STALE_MUTATION_LOCK"));

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
          wait: vi.fn(),
          now: vi.fn(),
          check: vi.fn(),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install,
          settlePackageMutation,
          observe: vi.fn(),
        },
        activationInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("settle activation"));

    expect(settlePackageMutation).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("preserves prepared restart settlement uncertainty over late cancellation", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const settlePackageMutation = vi.fn(async (signal: AbortSignal) => {
      controller.abort(reason);
      expect(signal).not.toBe(controller.signal);
      throw new Error("PRIVATE_STALE_MUTATION_LOCK");
    });

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
          wait: vi.fn(),
          now: vi.fn(),
          check: vi.fn(),
          reopen: vi.fn(),
          install: vi.fn(),
          settlePackageMutation,
          observe: vi.fn(),
        },
        { ...activationInput(), signal: controller.signal },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("settle activation"));

    expect(settlePackageMutation).toHaveBeenCalledOnce();
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("settles a prepared exact restart before restoring late cancellation", async () => {
    const bundle = capabilityBundle();
    const state = inMemoryState(activationState("prepared", bundle.bundle));
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const install = vi.fn();
    const check = vi.fn();
    const settlePackageMutation = vi.fn(async (signal: AbortSignal) => {
      controller.abort(reason);
      expect(signal).not.toBe(controller.signal);
    });

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([exactInstalled(bundle.bundle)]),
          wait: vi.fn(),
          now: vi.fn(),
          check,
          reopen: vi.fn(),
          install,
          settlePackageMutation,
          observe: vi.fn(),
        },
        { ...activationInput(), signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "settled" });
    expect(state.publish.mock.calls.at(-1)?.[0]?.signal).not.toBe(controller.signal);
    expect(install).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("preserves settlement uncertainty over late cancellation when mutation settlement fails", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const readInstalled = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([exactInstalled(bundle.bundle)]);
    const settlePackageMutation = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(controller.signal);
      throw new Error("PRIVATE_STALE_MUTATION_LOCK");
    });

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install: vi.fn(async () => {
            controller.abort(reason);
            return { outcome: "settlement_uncertain" as const };
          }),
          settlePackageMutation,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1, signal: controller.signal },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("settle activation"));

    expect(settlePackageMutation).toHaveBeenCalledOnce();
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("settles a successful late-cancelled install before preserving the exact reason", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const state = inMemoryState();

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
            "2027-01-01T00:01:02.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install: vi.fn(async () => {
            controller.abort(reason);
            return {
              outcome: "settled" as const,
              result: { status: "installed" as const, bundle: bundle.bundle },
            };
          }),
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1, signal: controller.signal },
      ),
    ).rejects.toBe(reason);

    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "settled" });
    const finalPublish = state.publish.mock.calls.at(-1)?.[0];
    expect(finalPublish?.signal).not.toBe(controller.signal);
  });

  it("settles from the prepared clock high-water after package commit and never reinstalls", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    let installed = false;
    const install = vi.fn(async () => {
      installed = true;
      return {
        outcome: "settled" as const,
        result: { status: "installed" as const, bundle: bundle.bundle },
      };
    });
    const readInstalled = vi.fn(async () => (installed ? [exactInstalled(bundle.bundle)] : []));

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen: vi
            .fn()
            .mockResolvedValue({ identity: candidate, capabilityBundle: bundle.content }),
          install,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).resolves.toMatchObject({ outcome: "activated" });
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({
      status: "settled",
      settledAt: "2027-01-01T00:01:01.000Z",
    });

    installed = false;
    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled,
          wait: vi.fn(),
          now: vi.fn(() => new Date("2026-12-31T23:59:59.000Z")),
          check: vi.fn(),
          reopen: vi.fn(),
          install,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("read installed package"));
    expect(install).toHaveBeenCalledOnce();
  });

  it("requires exact repository currentness again at the package mutation boundary", async () => {
    const bundle = capabilityBundle();
    const candidate = repositoryCandidate(bundle.bundle);
    const state = inMemoryState();
    const reopen = vi
      .fn()
      .mockResolvedValueOnce({ identity: candidate, capabilityBundle: bundle.content })
      .mockResolvedValueOnce({
        identity: { ...candidate, candidateDigest: `sha256:${"a".repeat(64)}` },
        capabilityBundle: bundle.content,
      });
    let packageMutationStarted = false;
    const install = vi.fn(async (input: unknown) => {
      const assertCurrent = (
        input as {
          readonly assertCurrent?: (signal: AbortSignal) => Promise<void>;
          readonly signal?: AbortSignal;
        }
      ).assertCurrent;
      if (assertCurrent === undefined) {
        throw new Error("repository currentness fence is missing");
      }
      await assertCurrent(
        (input as { readonly signal?: AbortSignal }).signal ?? new AbortController().signal,
      );
      packageMutationStarted = true;
      return {
        outcome: "settled" as const,
        result: { status: "installed" as const, bundle: bundle.bundle },
      };
    });

    await expect(
      runCapabilityRepositoryFirstActivation(
        {
          state,
          readInstalled: vi.fn().mockResolvedValue([]),
          wait: vi.fn().mockResolvedValue(undefined),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
          ]),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate],
          }),
          reopen,
          install,
          observe: vi.fn(),
        },
        { ...activationInput(), maxChecks: 1 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryFirstActivationError("install candidate"));

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(packageMutationStarted).toBe(false);
    await expect(
      state.read(activationInput(), new AbortController().signal),
    ).resolves.toMatchObject({ status: "prepared" });
  });
});

function activationInput() {
  return {
    packageName: "review-suite",
    version: "1.0.0",
    certificateIssuer: PUBLISHER.certificateIssuer,
    certificateIdentity: PUBLISHER.certificateIdentity,
    intervalMs: 60_000,
    maxChecks: 2,
    signal: new AbortController().signal,
  } as const;
}

function capabilityBundle() {
  return createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review capabilities.",
    packages: [
      {
        kind: "verifier-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: evidence-review
  version: 1.0.0
  description: Review declared evidence.
spec:
  kind: model
  prompt: Review evidence.
`),
      },
    ],
  });
}

function policyCapabilityBundle() {
  return createCapabilityBundleSource({
    name: "review-suite",
    version: "1.0.0",
    description: "Review policy.",
    packages: [
      {
        kind: "policy-package",
        manifest: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: restricted-review
  version: 1.0.0
  description: Restrict review workflows.
spec:
  tools:
    allowed: [read]
`),
      },
    ],
  });
}

function repositoryCandidate(bundle: { readonly bytes: number; readonly digest: string }) {
  return Object.freeze({
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "CapabilityRepositoryCandidate" as const,
    candidateDigest: `sha256:${"1".repeat(64)}` as const,
    repository: {
      stateDigest: `sha256:${"2".repeat(64)}` as const,
      metadata: [],
    },
    index: {
      path: "flow/capability-index.json" as const,
      bytes: 1,
      digest: `sha256:${"3".repeat(64)}` as const,
    },
    target: {
      path: "flow/packages/review-suite/1.0.0.flowpkg.json",
      source: "https://packages.example.test/targets/10/review-suite.flowpkg.json",
      length: 1,
      hashes: { sha256: "4".repeat(64) },
    },
    envelope: {
      bytes: 1,
      digest: `sha256:${"5".repeat(64)}` as const,
      capabilityBundleBytes: 1,
      sigstoreBundleBytes: 1,
    },
    bundle: {
      name: "review-suite",
      version: "1.0.0",
      bytes: bundle.bytes,
      digest: bundle.digest as `sha256:${string}`,
    },
    publisher: PUBLISHER,
  });
}

function sequenceClock(values: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("clock fixture exhausted");
    }
    return new Date(value);
  };
}

function inMemoryState(initial?: CapabilityRepositoryFirstActivationStateContent) {
  let current:
    | (CapabilityRepositoryFirstActivationStateContent & {
        readonly recordDigest: `sha256:${string}`;
      })
    | undefined =
    initial === undefined
      ? undefined
      : Object.freeze({ ...initial, recordDigest: `sha256:${"8".repeat(64)}` });
  let version = initial === undefined ? 0 : 8;
  return {
    read: vi.fn(async (_authorization: unknown, _signal: AbortSignal) => current),
    publish: vi.fn(
      async (input: {
        readonly expectedRecordDigest: `sha256:${string}` | null;
        readonly state: CapabilityRepositoryFirstActivationStateContent;
        readonly signal: AbortSignal;
      }) => {
        version += 1;
        current = Object.freeze({
          ...input.state,
          recordDigest: `sha256:${String(version).padStart(64, "0")}`,
        });
        return current;
      },
    ),
  };
}

function activationState(
  status: "prepared" | "settled",
  bundle: ReturnType<typeof capabilityBundle>["bundle"],
): CapabilityRepositoryFirstActivationStateContent {
  const prepared = {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "CapabilityRepositoryFirstActivation" as const,
    status: "prepared" as const,
    authorization: {
      packageName: bundle.name,
      version: bundle.version,
      certificateIssuer: PUBLISHER.certificateIssuer,
      certificateIdentity: PUBLISHER.certificateIdentity,
    },
    intervalMs: 60_000,
    maxChecks: 2,
    attempts: 1,
    createdAt: "2027-01-01T00:00:00.000Z",
    lastObservedAt: "2027-01-01T00:01:01.000Z",
    receipt: {
      candidateDigest: `sha256:${"1".repeat(64)}` as const,
      checkedAt: "2027-01-01T00:01:00.000Z",
      source: "https://packages.example.test/targets/10/review-suite.flowpkg.json",
      bundle: {
        name: bundle.name,
        version: bundle.version,
        bytes: bundle.bytes,
        digest: bundle.digest,
      },
      publisher: PUBLISHER,
    },
  };
  return status === "prepared"
    ? Object.freeze(prepared)
    : Object.freeze({
        ...prepared,
        status: "settled" as const,
        settledAt: "2027-01-01T00:01:02.000Z",
      });
}

function exactInstalled(bundle: ReturnType<typeof capabilityBundle>["bundle"]) {
  return Object.freeze({
    entry: Object.freeze({
      name: bundle.name,
      version: bundle.version,
      source: "https://packages.example.test/targets/10/review-suite.flowpkg.json",
      digest: bundle.digest,
      bytes: bundle.bytes,
      publisher: PUBLISHER,
    }),
    bundle,
  });
}
