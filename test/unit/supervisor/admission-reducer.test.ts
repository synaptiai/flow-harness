import { describe, expect, it } from "vitest";

import {
  classifyNewAdmission,
  createAdmissionInitializedEvent,
  createAdmissionSnapshotEvent,
  createDispatchReservedEvent,
  createJobEnqueuedEvent,
  createJobRejectedEvent,
  createJobReleasedEvent,
  createQueueCancellationCompletedEvent,
  createQueueCancellationRecordedEvent,
  createWorkerAcceptedEvent,
  reduceAdmissionEvents,
  type AdmissionEvent,
  type AdmissionJobIdentity,
  type AdmissionState,
} from "../../../src/supervisor/admission.js";

describe("supervisor admission reducer", () => {
  it("initializes an empty policy-bound state", () => {
    const state = initialState(2, 3);

    expect(state).toMatchObject({
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers: 2, maxQueuedJobs: 3 },
      lastSequence: 1,
      lastQueueSequence: 0,
      activeCount: 0,
      queuedCount: 0,
      jobs: {},
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.jobs)).toBe(true);
  });

  it("classifies new work as dispatch, queue, or deterministic rejection", () => {
    let state = initialState(1, 1);
    expect(classifyNewAdmission(state)).toBe("dispatch");

    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    expect(classifyNewAdmission(state)).toBe("queue");

    state = apply(state, createJobEnqueuedEvent(state, job(2), at(3)));
    expect(classifyNewAdmission(state)).toBe("reject");
  });

  it("preserves FIFO order across replay and refuses to skip an older job", () => {
    let state = initialState(1, 3);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    state = apply(state, createWorkerAcceptedEvent(state, job(1).jobId, at(3)));
    state = apply(state, createJobEnqueuedEvent(state, job(2), at(4)));
    state = apply(state, createJobEnqueuedEvent(state, job(3), at(5)));
    state = apply(state, createJobReleasedEvent(state, job(1).jobId, "succeeded", at(6)));

    expect(() => createDispatchReservedEvent(state, job(3), at(7))).toThrow(/oldest|FIFO/i);

    const next = createDispatchReservedEvent(state, job(2), at(7));
    state = apply(state, next);
    expect(state.jobs[job(2).jobId]).toMatchObject({
      status: "dispatching",
      queueSequence: 1,
    });
    expect(state.jobs[job(3).jobId]).toMatchObject({
      status: "queued",
      queueSequence: 2,
    });

    const replayed = reduceAdmissionEvents([
      createAdmissionInitializedEvent({
        policyDigest: "a".repeat(64),
        limits: { maxActiveWorkers: 1, maxQueuedJobs: 3 },
        at: at(1),
      }),
      ...state.events,
    ]);
    expect(replayed).toEqual(state);
  });

  it("replays an exact compacted snapshot and continues its monotonic sequences", () => {
    let state = initialState(1, 3);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    state = apply(state, createJobEnqueuedEvent(state, job(2), at(3)));
    state = apply(state, createJobEnqueuedEvent(state, job(3), at(4)));
    state = apply(state, createJobReleasedEvent(state, job(1).jobId, "succeeded", at(5)));
    state = apply(state, createDispatchReservedEvent(state, job(2), at(6)));

    const snapshot = createAdmissionSnapshotEvent(state, at(7));
    const compacted = reduceAdmissionEvents([snapshot]);

    expect(compacted).toEqual({ ...state, events: [] });
    const next = createJobEnqueuedEvent(compacted, job(4), at(8));
    expect(next).toMatchObject({ sequence: 7, queueSequence: 3 });
    expect(reduceAdmissionEvents([snapshot, next])).toMatchObject({
      lastSequence: 7,
      lastQueueSequence: 3,
      queuedCount: 2,
    });
  });

  it("rejects compacted snapshots with duplicate run or worker identities", () => {
    let state = initialState(1, 2);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    state = apply(state, createJobEnqueuedEvent(state, job(2), at(3)));
    const snapshot = createAdmissionSnapshotEvent(state, at(4));
    const [first, second] = snapshot.jobs;
    if (first === undefined || second === undefined) {
      throw new Error("test requires two admission jobs");
    }

    expect(() =>
      reduceAdmissionEvents([{ ...snapshot, jobs: [first, { ...second, runId: first.runId }] }]),
    ).toThrow(/run.*unique/i);
    expect(() =>
      reduceAdmissionEvents([
        { ...snapshot, jobs: [first, { ...second, workerId: first.workerId }] },
      ]),
    ).toThrow(/worker.*unique/i);
  });

  it("makes queued cancellation a two-step durable transition that cannot dispatch", () => {
    let state = initialState(1, 2);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    state = apply(state, createJobEnqueuedEvent(state, job(2), at(3)));
    state = apply(
      state,
      createQueueCancellationRecordedEvent(state, job(2).jobId, {
        commandId: commandId(90),
        actor: "operator",
        reason: "no longer needed",
        at: at(4),
      }),
    );

    expect(state).toMatchObject({ queuedCount: 0, activeCount: 1 });
    expect(state.jobs[job(2).jobId]?.status).toBe("queue_cancelling");
    expect(() => createDispatchReservedEvent(state, job(2), at(5))).toThrow(/queued/i);

    state = apply(
      state,
      createQueueCancellationCompletedEvent(state, job(2).jobId, commandId(90), at(5)),
    );
    expect(state.jobs[job(2).jobId]).toBeUndefined();
  });

  it("rejects sequence gaps, policy changes, and capacity overflow during replay", () => {
    const initialized = createAdmissionInitializedEvent({
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers: 1, maxQueuedJobs: 1 },
      at: at(1),
    });
    const state = reduceAdmissionEvents([initialized]);
    const first = createDispatchReservedEvent(state, job(1), at(2));

    expect(() => reduceAdmissionEvents([{ ...initialized, sequence: 2 }])).toThrow(/sequence/i);
    expect(() =>
      reduceAdmissionEvents([initialized, { ...first, policyDigest: "b".repeat(64) }]),
    ).toThrow(/policy/i);
    expect(() =>
      reduceAdmissionEvents([
        initialized,
        first,
        { ...createDispatchReservedEvent(state, job(2), at(3)), sequence: 3 },
      ]),
    ).toThrow(/capacity/i);
  });

  it("durably rejects queue overflow without retaining job state", () => {
    let state = initialState(1, 0);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));

    const rejected = createJobRejectedEvent(state, job(2), "queue_full", at(3));
    state = apply(state, rejected);

    expect(state).toMatchObject({ lastSequence: 3, activeCount: 1, queuedCount: 0 });
    expect(state.jobs[job(2).jobId]).toBeUndefined();
    expect(() => createJobRejectedEvent(initialState(1, 0), job(2), "queue_full", at(2))).toThrow(
      /not full/i,
    );
  });

  it("refuses a second nonterminal job for the same run", () => {
    let state = initialState(1, 2);
    state = apply(state, createDispatchReservedEvent(state, job(1), at(2)));
    const duplicateRun = { ...job(2), runId: job(1).runId };

    expect(() => createJobEnqueuedEvent(state, duplicateRun, at(3))).toThrow(/run.*already/i);
  });

  it("never exceeds active or queued limits across the reachable small-state model", () => {
    const visited = new Set<string>();
    const stack: Array<{ state: AdmissionState; nextJob: number; depth: number }> = [
      { state: initialState(2, 2), nextJob: 1, depth: 0 },
    ];

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const key = JSON.stringify({
        jobs: current.state.jobs,
        nextJob: current.nextJob,
        depth: current.depth,
      });
      if (visited.has(key)) continue;
      visited.add(key);

      expect(current.state.activeCount).toBeLessThanOrEqual(current.state.limits.maxActiveWorkers);
      expect(current.state.queuedCount).toBeLessThanOrEqual(current.state.limits.maxQueuedJobs);
      expect(new Set(queuedSequences(current.state)).size).toBe(
        queuedSequences(current.state).length,
      );
      if (current.depth >= 7) continue;

      for (const next of validSuccessors(current.state, current.nextJob)) {
        stack.push({
          state: next.state,
          nextJob: next.nextJob,
          depth: current.depth + 1,
        });
      }
    }

    expect(visited.size).toBeGreaterThan(100);
  });
});

function initialState(maxActiveWorkers: number, maxQueuedJobs: number): AdmissionState {
  return reduceAdmissionEvents([
    createAdmissionInitializedEvent({
      policyDigest: "a".repeat(64),
      limits: { maxActiveWorkers, maxQueuedJobs },
      at: at(1),
    }),
  ]);
}

function apply(state: AdmissionState, event: AdmissionEvent): AdmissionState {
  return reduceAdmissionEvents([
    createAdmissionInitializedEvent({
      policyDigest: state.policyDigest,
      limits: state.limits,
      at: at(1),
    }),
    ...state.events,
    event,
  ]);
}

function validSuccessors(
  state: AdmissionState,
  nextJob: number,
): Array<{ state: AdmissionState; nextJob: number }> {
  const successors: Array<{ state: AdmissionState; nextJob: number }> = [];
  const classification = classifyNewAdmission(state);
  if (nextJob <= 5 && classification !== "reject") {
    const identity = job(nextJob);
    const event =
      classification === "dispatch"
        ? createDispatchReservedEvent(state, identity, at(state.lastSequence + 1))
        : createJobEnqueuedEvent(state, identity, at(state.lastSequence + 1));
    successors.push({ state: apply(state, event), nextJob: nextJob + 1 });
  }

  for (const entry of Object.values(state.jobs)) {
    if (entry.status === "dispatching") {
      successors.push({
        state: apply(
          state,
          createWorkerAcceptedEvent(state, entry.jobId, at(state.lastSequence + 1)),
        ),
        nextJob,
      });
    }
    if (entry.status === "accepted") {
      successors.push({
        state: apply(
          state,
          createJobReleasedEvent(state, entry.jobId, "succeeded", at(state.lastSequence + 1)),
        ),
        nextJob,
      });
    }
    if (entry.status === "queued") {
      successors.push({
        state: apply(
          state,
          createQueueCancellationRecordedEvent(state, entry.jobId, {
            commandId: commandId(100 + entry.queueSequence),
            actor: "model-checker",
            at: at(state.lastSequence + 1),
          }),
        ),
        nextJob,
      });
    }
    if (entry.status === "queue_cancelling") {
      successors.push({
        state: apply(
          state,
          createQueueCancellationCompletedEvent(
            state,
            entry.jobId,
            entry.cancellation.commandId,
            at(state.lastSequence + 1),
          ),
        ),
        nextJob,
      });
    }
  }

  if (state.activeCount < state.limits.maxActiveWorkers) {
    const queued = Object.values(state.jobs)
      .filter((entry) => entry.status === "queued")
      .sort((left, right) => left.queueSequence - right.queueSequence)[0];
    if (queued !== undefined) {
      successors.push({
        state: apply(state, createDispatchReservedEvent(state, queued, at(state.lastSequence + 1))),
        nextJob,
      });
    }
  }
  return successors;
}

function queuedSequences(state: AdmissionState): number[] {
  return Object.values(state.jobs)
    .filter((entry) => entry.status === "queued")
    .map((entry) => entry.queueSequence);
}

function job(index: number): AdmissionJobIdentity {
  return {
    jobId: commandId(index),
    workerId: commandId(index + 20),
    runId: `run-${index}`,
    jobDigest: index.toString(16).padStart(64, "0"),
  };
}

function commandId(index: number): `${string}-${string}-${string}-${string}-${string}` {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function at(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 7, 0, 0, sequence)).toISOString();
}
