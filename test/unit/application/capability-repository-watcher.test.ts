import { describe, expect, it, vi } from "vitest";

import type { CapabilityPublisherVerification } from "../../../src/application/capability-package-store.js";
import type { PublicCapabilityRepositoryCandidate } from "../../../src/application/capability-repository-candidate.js";
import {
  CapabilityRepositoryWatcherError,
  reconcileCapabilityRepositoryWatcher,
  runCapabilityRepositoryWatcher,
} from "../../../src/application/capability-repository-watcher.js";

const PUBLISHER: CapabilityPublisherVerification = Object.freeze({
  kind: "sigstore-keyless-v0.3",
  certificateIssuer: "https://issuer.example.test/",
  certificateIdentity: "https://publisher.example.test/release",
  signatureBundleDigest: `sha256:${"9".repeat(64)}`,
});

describe("capability repository watcher reconciliation", () => {
  it("selects the highest patch candidate and replaces through the existing boundary", async () => {
    const replace = vi.fn().mockResolvedValue({
      status: "replaced",
      cleanup: "retained",
      bundle: { name: "review-suite", version: "1.0.3", digest: `sha256:${"3".repeat(64)}` },
      previous: { name: "review-suite", version: "1.0.0", digest: `sha256:${"0".repeat(64)}` },
      publisher: {
        certificateIssuer: PUBLISHER.certificateIssuer,
        certificateIdentity: PUBLISHER.certificateIdentity,
      },
    });

    const result = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:00:00.000Z",
          candidates: [
            candidate("1.1.0", "1"),
            candidate("1.0.2+one", "4"),
            candidate("1.0.3", "3"),
            candidate("1.0.2+two", "5"),
          ],
        }),
        replace,
      },
      watchInput(),
    );

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({
      candidateDigest: `sha256:${"3".repeat(64)}`,
      expectedCurrentVersion: "1.0.0",
      certificateIssuer: PUBLISHER.certificateIssuer,
      certificateIdentity: PUBLISHER.certificateIdentity,
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      outcome: "replaced",
      checkedAt: "2027-01-01T00:00:00.000Z",
      package: {
        name: "review-suite",
        previousVersion: "1.0.0",
        version: "1.0.3",
        digest: `sha256:${"3".repeat(64)}`,
      },
      cleanup: "retained",
    });
  });

  it("allows an explicit same-major minor update but never a major update", async () => {
    const replace = vi.fn().mockResolvedValue({
      status: "already_current",
      bundle: { name: "review-suite", version: "1.4.0", digest: `sha256:${"4".repeat(64)}` },
      publisher: {
        certificateIssuer: PUBLISHER.certificateIssuer,
        certificateIdentity: PUBLISHER.certificateIdentity,
      },
    });

    const result = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.2.0")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:00:00.000Z",
          candidates: [candidate("1.4.0", "4"), candidate("2.0.0", "5")],
        }),
        replace,
      },
      watchInput({ updatePolicy: "minor" }),
    );

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateDigest: `sha256:${"4".repeat(64)}`,
        expectedCurrentVersion: "1.2.0",
      }),
    );
    expect(result.outcome).toBe("already_current");
  });

  it("fails before a repository check when the installed baseline is absent", async () => {
    const check = vi.fn();
    const replace = vi.fn();

    await expect(
      reconcileCapabilityRepositoryWatcher(
        { readInstalled: vi.fn().mockResolvedValue(undefined), check, replace },
        watchInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryWatcherError("read installed package"));

    expect(check).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("fails before a repository check when the installed publisher no longer matches", async () => {
    const check = vi.fn();
    const replace = vi.fn();
    const changedPublisher = {
      ...installed("1.0.0"),
      publisher: {
        ...PUBLISHER,
        certificateIdentity: "https://publisher.example.test/PRIVATE_CHANGED",
      },
    };

    await expect(
      reconcileCapabilityRepositoryWatcher(
        { readInstalled: vi.fn().mockResolvedValue(changedPublisher), check, replace },
        watchInput(),
      ),
    ).rejects.toEqual(new CapabilityRepositoryWatcherError("read installed package"));

    expect(check).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("rejects malformed publisher policy before reading installed state", async () => {
    const readInstalled = vi.fn();
    const input = {
      ...watchInput(),
      certificateIssuer: "PRIVATE_NOT_A_CANONICAL_ISSUER",
    };

    await expect(
      reconcileCapabilityRepositoryWatcher(
        { readInstalled, check: vi.fn(), replace: vi.fn() },
        input,
      ),
    ).rejects.toEqual(new CapabilityRepositoryWatcherError("validate watcher policy"));

    expect(readInstalled).not.toHaveBeenCalled();
  });

  it("reports policy-blocked without mutation for only newer major candidates", async () => {
    const replace = vi.fn();

    const result = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.2.3")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:00:00.000Z",
          candidates: [candidate("2.0.0", "5")],
        }),
        replace,
      },
      watchInput(),
    );

    expect(result).toEqual({
      outcome: "policy_blocked",
      checkedAt: "2027-01-01T00:00:00.000Z",
      package: { name: "review-suite", version: "1.2.3" },
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not choose between distinct candidates with equal semantic precedence", async () => {
    const replace = vi.fn();

    const result = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:00:00.000Z",
          candidates: [candidate("1.0.1+one", "5"), candidate("1.0.1+two", "6")],
        }),
        replace,
      },
      watchInput(),
    );

    expect(result).toEqual({
      outcome: "policy_blocked",
      checkedAt: "2027-01-01T00:00:00.000Z",
      package: { name: "review-suite", version: "1.0.0" },
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores candidates from another package or publisher without exposing their values", async () => {
    const replace = vi.fn();
    const foreign = candidate("1.0.1", "6", {
      name: "PRIVATE_OTHER_PACKAGE",
      certificateIdentity: "PRIVATE_OTHER_PUBLISHER",
    });

    const result = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:00:00.000Z",
          candidates: [foreign],
        }),
        replace,
      },
      watchInput(),
    );

    expect(result).toEqual({
      outcome: "no_update",
      checkedAt: "2027-01-01T00:00:00.000Z",
      package: { name: "review-suite", version: "1.0.0" },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves cancellation before the repository check", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const check = vi.fn();

    await expect(
      reconcileCapabilityRepositoryWatcher(
        {
          readInstalled: async () => {
            controller.abort(reason);
            return installed("1.0.0");
          },
          check,
          replace: vi.fn(),
        },
        watchInput({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(check).not.toHaveBeenCalled();
  });

  it("preserves cancellation after the repository check and before replacement", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");
    const replace = vi.fn();

    await expect(
      reconcileCapabilityRepositoryWatcher(
        {
          readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
          check: async () => {
            controller.abort(reason);
            return {
              status: "staged" as const,
              checkedAt: "2027-01-01T00:01:00.000Z",
              candidates: [candidate("1.0.1", "7")],
            };
          },
          replace,
        },
        watchInput({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);

    expect(replace).not.toHaveBeenCalled();
  });
});

describe("capability repository watcher scheduling", () => {
  it("reports a failed check and waits a new full interval before reconciling", async () => {
    const controller = new AbortController();
    const stopReason = new Error("stop watcher");
    const statuses: unknown[] = [];
    const wait = vi.fn().mockResolvedValue(undefined);
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRIVATE_CHECK_FAILURE"))
      .mockResolvedValueOnce({
        status: "staged",
        checkedAt: "2027-01-01T00:02:00.000Z",
        candidates: [],
      });

    await expect(
      runCapabilityRepositoryWatcher(
        {
          readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
          check,
          replace: vi.fn(),
          now: sequenceClock([
            "2027-01-01T00:00:00.000Z",
            "2027-01-01T00:01:00.000Z",
            "2027-01-01T00:01:01.000Z",
            "2027-01-01T00:02:01.000Z",
            "2027-01-01T00:02:02.000Z",
          ]),
          wait,
          observe: async (status) => {
            statuses.push(status);
            if (status.kind === "scheduler" && status.outcome === "checked") {
              controller.abort(stopReason);
            }
          },
        },
        {
          ...watchInput({ signal: controller.signal }),
          intervalMs: 60_000,
        },
      ),
    ).rejects.toBe(stopReason);

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 60_000, controller.signal);
    expect(wait).toHaveBeenNthCalledWith(2, 60_000, controller.signal);
    expect(statuses).toEqual([
      {
        kind: "scheduler",
        outcome: "scheduler_started",
        attemptedAt: "2027-01-01T00:00:00.000Z",
        completedAt: null,
        missedIntervals: 0,
        consecutiveFailures: 0,
      },
      {
        kind: "scheduler",
        outcome: "check_failed",
        attemptedAt: "2027-01-01T00:01:00.000Z",
        completedAt: "2027-01-01T00:01:01.000Z",
        missedIntervals: 0,
        consecutiveFailures: 1,
      },
      {
        kind: "reconciliation",
        outcome: "no_update",
        checkedAt: "2027-01-01T00:02:00.000Z",
        package: { name: "review-suite", version: "1.0.0" },
      },
      {
        kind: "scheduler",
        outcome: "checked",
        attemptedAt: "2027-01-01T00:02:01.000Z",
        completedAt: "2027-01-01T00:02:02.000Z",
        missedIntervals: 0,
        consecutiveFailures: 0,
      },
    ]);
    expect(JSON.stringify(statuses)).not.toContain("PRIVATE");
  });

  it("stops instead of retrying a replacement failure", async () => {
    const privateFailure = new Error("PRIVATE_REPLACEMENT_FAILURE");
    const wait = vi.fn().mockResolvedValue(undefined);
    const statuses: unknown[] = [];

    await expect(
      runCapabilityRepositoryWatcher(
        {
          readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate("1.0.1", "7")],
          }),
          replace: vi.fn().mockRejectedValue(privateFailure),
          now: sequenceClock(["2027-01-01T00:00:00.000Z", "2027-01-01T00:01:00.000Z"]),
          wait,
          observe: async (status) => {
            statuses.push(status);
          },
        },
        { ...watchInput(), intervalMs: 60_000 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryWatcherError("replace candidate"));

    expect(wait).toHaveBeenCalledOnce();
    expect(statuses.map((status) => (status as { outcome: string }).outcome)).toEqual([
      "scheduler_started",
    ]);
    expect(JSON.stringify(statuses)).not.toContain("PRIVATE");
  });

  it("keeps replacement uncertainty primary when cancellation arrives at settlement", async () => {
    const controller = new AbortController();
    const cancellation = new Error("PRIVATE_LATE_CANCELLATION");
    const replacementFailure = new Error("PRIVATE_COMMIT_UNCERTAINTY");

    const failure = await reconcileCapabilityRepositoryWatcher(
      {
        readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
        check: vi.fn().mockResolvedValue({
          status: "staged",
          checkedAt: "2027-01-01T00:01:00.000Z",
          candidates: [candidate("1.0.1", "8")],
        }),
        replace: async () => {
          controller.abort(cancellation);
          throw replacementFailure;
        },
      },
      watchInput({ signal: controller.signal }),
    ).catch((error: unknown) => error);

    expect(failure).toEqual(new CapabilityRepositoryWatcherError("replace candidate"));
    expect((failure as Error).message).not.toContain("PRIVATE");
    expect(failure).not.toBe(cancellation);
  });

  it("preserves exact cancellation returned by the replacement boundary", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled");

    await expect(
      reconcileCapabilityRepositoryWatcher(
        {
          readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [candidate("1.0.1", "8")],
          }),
          replace: async () => {
            controller.abort(reason);
            throw reason;
          },
        },
        watchInput({ signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
  });

  it("stops with a fixed stage when reconciliation status cannot be reported", async () => {
    const privateFailure = new Error("PRIVATE_OBSERVER_FAILURE");

    await expect(
      runCapabilityRepositoryWatcher(
        {
          readInstalled: vi.fn().mockResolvedValue(installed("1.0.0")),
          check: vi.fn().mockResolvedValue({
            status: "staged",
            checkedAt: "2027-01-01T00:01:00.000Z",
            candidates: [],
          }),
          replace: vi.fn(),
          now: sequenceClock(["2027-01-01T00:00:00.000Z", "2027-01-01T00:01:00.000Z"]),
          wait: vi.fn().mockResolvedValue(undefined),
          observe: async (status) => {
            if (status.kind === "reconciliation") {
              throw privateFailure;
            }
          },
        },
        { ...watchInput(), intervalMs: 60_000 },
      ),
    ).rejects.toEqual(new CapabilityRepositoryWatcherError("report status"));
  });
});

function watchInput(
  overrides: Partial<{
    readonly signal: AbortSignal;
    readonly updatePolicy: "patch" | "minor";
  }> = {},
) {
  return {
    packageName: "review-suite",
    certificateIssuer: PUBLISHER.certificateIssuer,
    certificateIdentity: PUBLISHER.certificateIdentity,
    signal: overrides.signal ?? new AbortController().signal,
    ...(overrides.updatePolicy === undefined ? {} : { updatePolicy: overrides.updatePolicy }),
  } as const;
}

function installed(version: string) {
  return Object.freeze({
    name: "review-suite",
    version,
    digest: `sha256:${"0".repeat(64)}`,
    publisher: PUBLISHER,
  } as const);
}

function candidate(
  version: string,
  digestCharacter: string,
  overrides: { readonly name?: string; readonly certificateIdentity?: string } = {},
): PublicCapabilityRepositoryCandidate {
  const name = overrides.name ?? "review-suite";
  const candidateDigest = `sha256:${digestCharacter.repeat(64)}` as const;
  const value: PublicCapabilityRepositoryCandidate = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "CapabilityRepositoryCandidate",
    candidateDigest,
    repository: { stateDigest: `sha256:${"a".repeat(64)}`, metadata: [] },
    index: {
      path: "flow/capability-index.json",
      bytes: 1,
      digest: `sha256:${"b".repeat(64)}`,
    },
    target: {
      path: `flow/packages/${name}/${version}.flowpkg.json`,
      length: 1,
      hashes: { sha256: "c".repeat(64) },
    },
    envelope: {
      bytes: 1,
      digest: `sha256:${"d".repeat(64)}`,
      capabilityBundleBytes: 1,
      sigstoreBundleBytes: 1,
    },
    bundle: { name, version, bytes: 1, digest: candidateDigest },
    publisher: {
      kind: "sigstore-keyless-v0.3",
      certificateIssuer: PUBLISHER.certificateIssuer,
      certificateIdentity: overrides.certificateIdentity ?? PUBLISHER.certificateIdentity,
      signatureBundleDigest: `sha256:${"e".repeat(64)}`,
    },
  };
  return Object.freeze(value);
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
