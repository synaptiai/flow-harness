# Decision Journal: Issue #25 — Durable workspace-effect evidence

**Issue**: #25 | **Branch**: `codex/issue-25-durable-effect-journal` | **Started**: 2026-08-07

---

## Context

Flow already makes agent writes narrower than a general shell mutation: the `flow_edit` tool is
policy-brokered, hash anchored, limited to one existing regular UTF-8 file, serialized in-process,
protected by a same-host cross-process lock, written through a synced temporary file, atomically
renamed, and followed by a directory sync. Completed agent attempts retain bounded edit receipts in
terminal evidence.

That evidence is currently published too late. The receipt is created only after the editor returns,
and it is persisted only inside `node_succeeded` or `node_failed`. If the worker stops after the
rename but before terminal evidence, replay sees only `node_started`. Flow correctly refuses resume
as `uncertain_operation`, but it has discarded the exact before/after hashes needed by a future
reconciler.

This issue establishes the durable mutation-boundary protocol. It does not decide whether an open
attempt may be retried. That later decision also depends on node-level session continuity, fresh
approval, attempt numbering, retry budgets, and provider usage that may be unknown after a crash.

The design is constrained by existing authority boundaries:

- `runWorkflow` owns run-event sequence allocation, timestamps, reducer application, and store
  appends.
- The run reducer is the only interpreter of persisted graph state.
- `JsonlRunStore.append` validates sequence and event size and fsyncs before acknowledgement.
- A node executor returns one terminal outcome; Pi and filesystem adapters must not construct graph
  transitions or write directly to the run store.
- The public Pi `AgentSession.subscribe()` listener is synchronous and does not await listener
  promises, so Pi session events cannot form a durability barrier for tool mutation.
- The existing edit lock is a coordination mechanism for cooperating same-user Flow processes, not
  a security boundary against the same user or a privileged process.

## Specification

_Captured by specification-capture on 2026-08-07. Source: user-confirmed architecture selection,
Issue #25, and the existing recovery/workflow contracts._

### Non-goals

- This issue does not automatically resume, retry, or mark successful an interrupted node.
- This issue does not reconcile arbitrary commands, provider requests, network calls, third-party
  APIs, or filesystem mutations outside the typed hash-anchored edit adapter.
- This issue does not restore or continue an interrupted Pi model session.
- This issue does not reuse a consumed command approval or infer unobserved provider usage as zero.
- This issue does not add attempt numbers greater than one, retry budgets, backoff, conditions,
  graph concurrency, or loops.
- This issue does not provide distributed coordination, multi-host locks, or protection from a
  hostile process running as the same operating-system user.
- This issue does not replace terminal `node_succeeded` or `node_failed` events, existing evidence,
  policy decisions, or run resource accounting.
- This issue does not treat a matching file hash as proof that a model turn or whole node completed.

### Failure modes

- **Timeouts and cancellation before preparation** — No effect event exists and rename is never
  entered. Existing tool/node cancellation behavior applies.
- **Preparation append rejects** — The editor does not rename. The temporary file is cleaned where
  cleanup remains trustworthy. The attempt journal becomes unusable for further mutation or a
  terminal outcome when append acknowledgement itself is uncertain.
- **Cancellation after preparation and before rename** — The editor settles `not_applied` while the
  target lock is still held. If settlement cannot be acknowledged, the prepared effect remains
  unresolved and recovery stays uncertain.
- **Crash after preparation and before rename** — The ledger retains exact before/after identities;
  the target remains unmodified by this process. This issue still blocks resume rather than
  classifying or retrying the node.
- **Crash after rename and before directory sync** — The prepared record survives, while durability
  and target outcome remain unknown.
- **Crash after directory sync and before settlement** — The prepared record survives. A later issue
  may compare authoritative target state, but this issue does not infer a result from absence of a
  settlement.
- **Settlement append rejects after rename** — The edit adapter reports an uncertain effect; the
  prepared record is never erased or replaced with a guessed result. The application journal is
  poisoned so a later terminal append cannot skip the unresolved boundary.
- **Lock release fails after committed settlement** — The durable effect remains committed. The tool
  may fail because future coordination is impaired, but it does not rewrite the committed
  settlement as an unknown target mutation.
- **Partial failures across multiple effects** — Each effect has an independent identity and
  settlement. Terminal evidence is accepted only when every prepared effect is settled and all
  committed/unknown settlements match receipts exactly.
- **Invalid input** — Unknown fields, malformed digests, non-canonical or oversized targets, invalid
  modes, mismatched attribution, skipped effect sequences, settlement without preparation,
  duplicate settlement, or more than 32 preparations are rejected by schema/replay before state is
  advanced.
- **Missing context** — An agent attempt declaring the durable effect protocol but lacking an
  application-owned journal cannot start a writable Pi session. There is no fallback to
  terminal-only receipts.
- **Dependency outage** — Run-store or filesystem I/O failure fails closed at the boundary where it
  occurs. Provider or Pi availability does not weaken journal requirements.
- **Resource exhaustion** — The 32-effect cap and 2 MiB serialized-event ceiling are enforced before
  mutation. No unbounded queue, target, proof, or error payload is persisted.
- **Concurrent callers** — The application serializes effect publication and event-sequence
  allocation. Per-target editor locks order filesystem mutation; the fixed lock order is target lock
  then run-journal append. The scheduler never waits on a target lock while holding an append open.
- **Legacy replay** — Attempts whose `node_started` lacks the durable protocol marker keep the old
  terminal-receipt contract. Effect boundary events are forbidden for such attempts. New-protocol
  attempts cannot silently fall back to legacy receipts.

### Interface contracts

- New writable agent attempts declare `effectProtocol: "flow.effects/v1"` on `node_started`.
  Historical events omit the optional field and replay unchanged.
- `node_effect_prepared` is legal only for the one running node and exact attempt that declared the
  protocol. It carries a globally stable event-derived effect id, a contiguous attempt-local effect
  sequence, and a strict `filesystem.edit` descriptor with canonical target, operation digest,
  before/after SHA-256 values, and preserved POSIX permission mode.
- `node_effect_settled` references one open prepared effect and records exactly one of:
  `committed/directory_synced`, `not_applied/commit_not_entered`, or
  `unknown/post_commit_failure`. Outcome and reason must be a valid pair.
- `NodeRunState` exposes immutable effect state reconstructed from the ledger. This state is audit
  data; it does not change node status or resource totals.
- The application provides a narrow attempt-scoped journal through `NodeExecutionContext`. The
  journal can prepare one typed effect and settle only the handle it returned. It cannot append raw
  events or choose run identity, node identity, sequence, timestamp, or scheduler transitions.
- Preparation returns only after the event append and fsync are acknowledged. Rename is forbidden
  before that promise resolves.
- The editor publishes preparation after the temporary file is synced and the target is revalidated,
  immediately before rename, while the existing target lock remains held.
- The editor publishes settlement after known non-entry or after rename plus directory sync, before
  releasing the target lock.
- For protocol-v1 attempts, terminal agent receipts are a compatibility projection of settled
  `committed` and `unknown` effects. Their attribution, order, target, digest, hashes, and mapped
  outcome must match exactly. `not_applied` effects remain audit events and do not become receipts.
- Terminal events are illegal while any prepared effect is unsettled. A committed effect never
  authorizes `node_succeeded`; the original executor must still return valid terminal evidence.
- Command executors receive no effect journal and retain the existing `uncertain_operation` recovery
  behavior.

## User, operator, and system flows

### User: a normal workspace edit

1. The model requests `flow_edit` after reading a full-file SHA-256 version.
2. Flow policy authorizes the exact semantic operation and canonical target.
3. The editor validates the request, acquires the target lock, reads and revalidates the target,
   writes and fsyncs a temporary file, and derives the exact before/after identities.
4. The application durably records the prepared effect and returns its stable identity.
5. The editor renames, syncs the directory, and durably settles the effect as committed.
6. The tool returns the new hash. The eventual terminal evidence contains the exact projected
   receipt, which replay cross-checks against the effect events.

### User: an edit rejected before mutation

1. Validation, policy, stale-version, replacement, size, target, or lock checks fail before
   preparation; no effect event is created.
2. If cancellation or another known failure occurs after preparation but before rename, Flow settles
   the prepared effect as not applied.
3. The tool reports the error. No committed/uncertain receipt is added for a not-applied effect.

### Operator: inspect an interrupted attempt

1. The worker stops after `node_started` and one or more effect boundary events.
2. `flow inspect` replays and exposes the immutable prepared/settled effect state.
3. `flow resume` still returns `uncertain_operation` and appends nothing in this issue.
4. The operator can distinguish “no durable effect identity”, “prepared but unresolved”, and
   “settled sub-effect” without treating any of them as node completion.

### System: concurrent effect publication

1. Independent tool calls may reach the attempt journal concurrently in future executors.
2. The application serializes event construction, sequence allocation, append, and reducer update.
3. Each preparation receives the next global event id and next attempt-local effect sequence.
4. Per-target locks independently prevent two cooperating writers from overtaking each other.

## Options considered

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Narrow application-owned attempt journal in `NodeExecutionContext` | Preserves sequence/store authority, can be awaited inside the real edit lock, provider-neutral typed contract, smallest coherent change | Adds a mid-attempt callback contract and requires serialized publication plus exact terminal cross-checking | **Selected by the user** |
| Give the Pi recorder or editor direct access to `RunEventStore` | Superficially fewer callback types | Splits graph/event authority, lets infrastructure invent sequences and transitions, couples Pi/filesystem code to persistence, still needs run context | Rejected |
| Change every executor to an acknowledged async event stream | Clean for remote/out-of-process executors and general progress events | Large router/scheduler redesign, cancellation/drain/deadlock complexity, unnecessary for current in-process typed edit | Defer until a remote executor requires it |
| Observe Pi tool-start/session events | Reuses upstream telemetry | Public session listeners are not awaited; session records cannot prove external effect or form a pre-rename fsync barrier | Rejected as authority; retain for telemetry only |

## Decision

Use a narrow, application-owned, attempt-scoped effect journal passed through
`NodeExecutionContext`. Add a protocol marker to new writable agent attempts, strict prepared and
settled run events, immutable replay state, and an acknowledged editor lifecycle inside the existing
target lock. Derive effect identity from the durable prepare event sequence and retain the existing
attempt-local receipt sequence as `effectSequence`.

All run-event construction and sequence allocation remain in the application. Infrastructure can
submit only a typed filesystem-edit descriptor and can settle only the handle returned for that
descriptor. The journal serializes concurrent publications and becomes permanently failed after an
unacknowledged append so later code cannot write around a durability gap.

Retain terminal receipts for public compatibility. For protocol-v1 attempts they become a verified
projection, not a second independent source of truth. Preserve legacy replay when the protocol marker
is absent.

Do not add reconciliation or retry in this issue. The next recovery issue can use prepared effect
descriptors to compare the target under the same lock, but it must still terminalize the interrupted
attempt conservatively and must not infer model completion.

## Dependency and lock analysis

```text
CLI / supervisor worker
        |
        v
application/run-workflow  -- owns sequence, timestamp, append, reducer
        |                         ^
        | NodeExecutionContext   | typed prepare/settle callbacks
        v                         |
Pi agent executor -> effect recorder -> workspace tool -> hash editor
                                                   |
                                                   v
                                      target lock -> temp fsync -> rename -> dir fsync
```

- Domain types import no application, Pi, filesystem, supervisor, or CLI modules.
- Application ports import domain effect descriptors but no infrastructure types.
- Pi and filesystem adapters depend inward on the application callback contract.
- The run store remains an application dependency; it is never injected into the recorder/editor.
- Fixed ordering is target lock → application journal append. No path acquires a target lock while a
  journal append is held open by the scheduler, so the design introduces no reverse edge.
- The application journal queue serializes only small event publications. It does not serialize the
  provider session or filesystem work preceding preparation.

## Event and state model

```text
node_started(effectProtocol = flow.effects/v1)
  |
  +-- node_effect_prepared(effect-<event-sequence>, effectSequence = 1..32)
  |       |
  |       +-- node_effect_settled(committed, directory_synced)
  |       +-- node_effect_settled(not_applied, commit_not_entered)
  |       `-- node_effect_settled(unknown, post_commit_failure)
  |
  +-- ...additional independently identified effects...
  |
  +-- node_succeeded(evidence receipts exactly project settled committed/unknown effects)
  `-- node_failed(evidence receipts exactly project settled committed/unknown effects)
```

Invariant summary:

1. Preparation requires the exact running protocol-v1 attempt.
2. `effectId` equals the deterministic id for the prepare event sequence.
3. `effectSequence` equals the number of previously prepared effects plus one and is at most 32.
4. Settlement requires the exact still-open prepared effect.
5. Terminal outcome requires zero open prepared effects.
6. Terminal receipts equal the ordered projection of committed/unknown settlements.
7. Not-applied effects never appear as terminal receipts.
8. Effect events do not alter run status, node status, goals, approvals, or resources.
9. Legacy attempts forbid effect events and keep legacy receipt validation.
10. A terminal node or run rejects every later effect event.
11. Every prepared effect, including not-applied effects, matches a distinct allowed write decision.
12. The journal is a lower bound on failure classification: unknown requires uncertainty, committed
    forbids none, and executor-originated uncertainty may conservatively remain uncertain.

## Crash-window matrix

| Last acknowledged boundary | Target observation | Durable claim in this issue | Retry implication |
| --- | --- | --- | --- |
| Before preparation | Any | No effect identity | None; open model attempt is still uncertain |
| Prepared, before rename | Exact before state | Prepared and unresolved after process death | No retry in this issue |
| Prepared, after rename, before directory sync | Before/after/missing/diverged | Prepared and unresolved | No retry; durability unknown |
| Prepared, after directory sync, before settlement | Exact after state | Prepared and unresolved | No node-success inference |
| Settled not applied | Exact before state at settlement time | Authoritative non-entry claim | Still no node retry policy |
| Settled committed | Rename and directory sync acknowledged | Authoritative edit-commit claim | Does not prove node success |
| Settled unknown | Post-commit failure | Explicit uncertainty | Never retry from this result |

Future reconciliation may classify an unresolved prepared edit as not applied only from exact before
hash and mode under the same target lock, committed only from exact after hash and mode, and unknown
for missing, divergent, wrong-mode, symlink, corrupt, or live-lock states. Those classifications are
recorded here to constrain the next issue, not implemented by this one.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Durable identity, strict schema, exact attribution | Contract/data | `npx vitest run test/unit/run/effect-journal-reducer.test.ts` | Legal prepare replays; malformed target, digest, mode, id, attribution, authorization, or protocol fails | Filesystem durability |
| One settlement and exact terminal projection | Behavioral/contract | `npx vitest run test/unit/run/effect-journal-reducer.test.ts` | Committed/unknown map exactly to receipts; not-applied does not; unresolved cannot terminalize | Whole-node success after crash |
| Duplicate/reordered/mismatched/over-limit records | Error handling | `npx vitest run test/unit/run/effect-journal-reducer.test.ts` | Malformed records fail schema validation; contextually illegal permutations throw `RunReplayError` at the offending event | Hostile ledger repair |
| Serialized publication and append-before-mutation authority | Behavioral | `npx vitest run test/unit/application/run-workflow-effect-journal.test.ts` | Concurrent prepares get contiguous ids; append failure poisons journal; executor cannot emit raw events | Distributed sequencing |
| Preparation prevents rename on append failure | Integration/error | `npx vitest run test/unit/infrastructure/fs/hash-anchored-edit.test.ts` | Real target remains unchanged; hook order proves prepare acknowledgement precedes rename | Reboot durability |
| Known non-entry, commit, and post-commit uncertainty | Integration/behavioral | `npx vitest run test/unit/infrastructure/fs/hash-anchored-edit.test.ts` | Hook outcomes match deterministic cancellation, sync, and injected post-commit failures | Arbitrary filesystem operations |
| Pi tool receipt agrees with durable settlement | Integration | `npx vitest run test/unit/infrastructure/pi/agent-effect-recorder.test.ts test/unit/infrastructure/pi/workspace-read-tools.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts` | Recorder, tool, and executor lifecycles return exact receipt projection and refuse missing journals | Live provider behavior |
| Real JSONL reopening and filesystem commit | Integration/data | `npx vitest run test/integration/fs/durable-effect-journal.test.ts` | A normal committed edit reopens with its prepared/settled records, target bytes, and event ordering intact | Process interruption, kernel crash, or power-loss simulation |
| Legacy compatibility and open-attempt refusal | Compatibility | `npx vitest run test/unit/run/reducer.test.ts test/unit/application/run-workflow.test.ts test/integration/cli/main.test.ts` | Old ledgers replay; open attempts append/execute nothing; public inspect exposes effect state | Automatic reconciliation |
| Event bounds and 32-effect cap | Boundary/data | `npx vitest run test/unit/run/effect-journal-reducer.test.ts test/unit/infrastructure/pi/agent-effect-recorder.test.ts test/integration/fs/jsonl-run-store.test.ts` | Worst-case valid evidence appends; oversized records and the 33rd effect reject before mutation | Unlimited audit retention |
| Compiled process crash evidence | Runtime | `npm run build && npx vitest run --config vitest.runtime.config.ts test/runtime/durable-effect-crash.runtime.test.ts` | Real children exit at five deterministic boundaries and leave the expected target plus fsynced event prefix | Host reboot, provider billing, remote effects |
| Public documentation remains truthful | Contract/docs | `npx vitest run test/scaffold/community-files.test.ts` | README/security/architecture/recovery/workflow/testing/roadmap statements agree | Future retry availability |
| Full release compatibility | Release | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | All static, behavioral, build, runtime, coverage, package, and advisory gates pass | Live paid-provider availability |

## Planned RED → GREEN → REFACTOR sequence

1. **Reducer RED** — Add focused tests for the protocol marker, prepared/settled events, immutable
   effect state, invalid permutations, terminal projection, limits, and legacy replay. Confirm they
   fail because the event union does not yet accept effect events.
2. **Reducer GREEN/REFACTOR** — Add strict types/schemas/replay invariants and factor exact projection
   validation without changing resource or terminal semantics.
3. **Application RED** — Prove a writable agent attempt receives only a narrow journal, preparation
   is durably recorded before acknowledgement, concurrent calls serialize, and append failure
   poisons later publication.
4. **Application GREEN/REFACTOR** — Introduce the attempt-scoped journal and one shared serialized
   record queue while retaining application ownership of every event field.
5. **Editor RED** — Prove lifecycle ordering around temp fsync, target recheck, rename, directory
   sync, cancellation, cleanup, and post-commit failure with real temporary files.
6. **Editor GREEN/REFACTOR** — Add acknowledged lifecycle hooks inside the existing lock without
   exposing journal/domain types to the filesystem adapter.
7. **Pi RED/GREEN/REFACTOR** — Convert effect reservations to the asynchronous prepare/settle
   lifecycle, make terminal receipts the exact settlement projection, and fail before writable
   session start when the journal is absent.
8. **Integration/runtime** — Exercise real JSONL reopening, real files, deterministic child-process
   termination windows, legacy CLI refusal, and installed compiled behavior.
9. **Documentation and evidence** — Update every public contract, run the full verification map,
   perform independent adversarial review, and record limitations honestly.

## Research cross-checks

- Pi SDK/session documentation: session persistence restores conversation/model state but does not
  prove external side effects. <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- OMP session format records a durable tool-execution start before tool implementation, which is a
  useful interruption marker but not proof of external effect outcome.
  <https://github.com/can1357/oh-my-pi/blob/main/docs/session.md>
- Prime Agent journals mutating commands before dispatch and never automatically replays uncertain
  commands; workers separately journal operation transitions.
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- Temporal documents that an activity can complete externally while completion recording is lost,
  so retry safety needs operation-level idempotency rather than workflow optimism.
  <https://docs.temporal.io/activity-definition>
- AWS documents caller-provided idempotency identity and semantic-equivalence validation rather than
  deriving safety from payload similarity alone.
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>

## Consequences

- Run ledgers become larger by two bounded events per attempted edit, up to 64 new events per agent
  attempt. The existing 2 MiB per-event limit still has more than 99% headroom for the worst-case
  prepared descriptor; total ledger retention remains a separate policy concern.
- Filesystem edits gain one fsynced run-ledger append before rename and one after the mutation
  boundary. Safety is intentionally prioritized over edit latency.
- Terminal receipts remain readable to existing clients, while protocol-v1 replay rejects any
  disagreement between receipts and mid-attempt events.
- The application execution context gains a provider-neutral mid-attempt capability, but executor
  implementations still cannot publish arbitrary progress or graph events.
- Future reconciliation can be adapter-specific and evidence-based without changing the prepared
  descriptor shape. Future remote executors may justify replacing callbacks with an acknowledged
  event stream, but this issue does not pay that complexity prematurely.
