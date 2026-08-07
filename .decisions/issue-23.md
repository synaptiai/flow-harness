# Decision Journal: Issue #23 — Project configuration and bounded admission

**Issue**: #23 | **Branch**: `codex/issue-23-bounded-admission` | **Started**: 2026-08-07
**Depends on**: issue #22 / branch `codex/issue-22-detached-supervisor`

---

## Context

Issue #22 adds a same-host supervisor, exact submission journals, immutable job snapshots,
authenticated detached workers, cancellation, event replay, and restart adoption. Every valid
detached submission still reserves a run and launches a worker immediately. That makes the control
plane durable but not bounded: concurrent clients can create an arbitrary number of worker process
groups, provider sessions, and command sandboxes.

Flow also has no project initialization or inspectable effective configuration. Operational choices
are repeated as CLI flags, invocations from subdirectories do not share a declared project root,
and a supervisor generation is not bound to the policy under which it accepted work.

The upstream implementations separate useful concerns:

- Pi and OMP layer global and project settings. OMP deep-merges objects and lets later layers replace
  scalars and arrays. That is appropriate for preferences, but unsafe for Flow capacity because an
  untrusted project must not widen an operator ceiling.
- OMP's task semaphore is process- and session-scoped. It is deliberately held around active work
  and removes cancelled waiters, but queued state and concurrency counts disappear with the process.
- OMP uses synchronous SQLite for settings and metrics; Pi 0.84 provides a Node `node:sqlite`
  session backend with transactions, writer fencing, WAL, and `synchronous=FULL`.
- Prime Agent uses fsynced append-only command journals and atomic compaction, but its daemon
  explicitly has no fixed session, worker, client, or workload cap. Its prompt-admission records
  coordinate delivery ownership, not durable worker-capacity admission.
- Pi's JSONL session backend appends mutations before applying them in memory and atomically repairs
  a torn final record. Flow's run ledger already follows the same durable-fact-first pattern.

## Specification

_Captured from issue #23 and architecture analysis on 2026-08-07._

### Non-goals

- Multi-host scheduling, distributed consensus, remote control, cluster autoscaling, or a shared
  network database.
- Priority, weighted-fair, preemptive, deadline, or provider-price scheduling.
- Hot capacity changes while a supervisor has active or queued work.
- Graph-node parallelism, child-run isolation, scheduled triggers, or optimization loops.
- CPU, memory, disk, network-byte, provider-billing, or artifact-byte enforcement.
- Storing provider credentials or other secrets in project configuration or configuration output.
- Treating project configuration as authority to broaden built-in or operator safety policy.
- Replacing the per-run JSONL event ledger with supervisor admission metadata.
- Importing Pi or OMP configuration types, persistence schemas, or semaphore state into Flow domain
  contracts.

### Configuration contract

- The project file is `<project-root>/.flow/config.yaml`. Its presence defines the Flow project root.
  Discovery starts at the invocation directory and walks parents to the filesystem root. The
  selected root and source path are visible in inspection output.
- The operator file is `${XDG_CONFIG_HOME}/flow/config.yaml`, falling back to
  `${HOME}/.config/flow/config.yaml` when `XDG_CONFIG_HOME` is absent. Tests inject these locations;
  production does not invent hidden environment-specific precedence.
- Both files are strict, versioned YAML documents. The operator and project documents have distinct
  kinds so a file cannot silently move between authority scopes.
- Initial capacity fields are `supervisor.maxActiveWorkers` and `supervisor.maxQueuedJobs`.
  `maxActiveWorkers` is a positive safe integer no greater than 64. `maxQueuedJobs` is a nonnegative
  safe integer no greater than 1024; zero means reject overflow instead of queueing it.
- Built-in defaults are one active worker and 32 queued jobs. An operator may select any value
  within the hard schema bounds. A project may omit a field or select a value no greater than the
  effective operator value. A project attempt to widen a ceiling is an error, not a silently capped
  preference.
- Effective values use a monotonic safety merge, not generic last-wins deep merge:

  `effective(field) = project(field) ?? operator(field) ?? builtIn(field)`

  subject to `project(field) <= operator(field) ?? builtIn(field)`.
- The effective policy digest is SHA-256 over canonical JSON containing only the versioned effective
  control values. Provenance paths are reported separately and do not make equivalent policy values
  hash differently.
- Configuration inspection reports built-in, operator, and project contributions, the effective
  values, selected project root, and policy digest. The initial schema contains no secret fields;
  future secret-bearing fields must expose only redacted provenance.
- `flow init` creates the parent `.flow` directory and a minimal project document without capacity
  overrides. That makes initialization safe under every valid operator ceiling. Existing regular
  files, symbolic links, directories, and malformed targets are not replaced unless a caller uses
  the explicit replacement option; replacement remains confined to the selected path.

### Admission state and invariants

The supervisor owns an append-only, versioned admission ledger under
`<runs-dir>/.supervisor/admission.jsonl`. Immutable workflow snapshots remain in the existing job
files. Command records, active-run claims, worker descriptors, and per-run events retain their
existing roles.

For a reduced admission state `S` and configured limits `A` and `Q`:

- `active(S) = |{j : state(j) ∈ {dispatching, accepted, uncertain}}|`
- `queued(S) = |{j : state(j) = queued}|`
- `0 <= active(S) <= A`
- `0 <= queued(S) <= Q`
- every committed queued job has one unique positive queue sequence;
- dispatch selects the minimum queue sequence among queued jobs;
- a terminal, rejected, or queued-cancelled job never transitions back to dispatching;
- a queued-cancelled job has no active claim, authenticated worker, or run ledger;
- every accepted worker has a prior durable capacity reservation;
- an exact command-id retry returns the same queued, accepted, rejected, cancelled, or uncertain
  outcome and never allocates a second queue position.

Admission ledger events contain the complete state transition identity and queue sequence. An event
is appended and fsynced before its transition is applied in memory or acknowledged. A torn final
record is truncated on recovery; malformed committed prefixes fail closed. Compaction writes a
complete snapshot to an owner-only sibling file, fsyncs it, atomically renames it, and fsyncs the
directory.

The supervisor serializes every admission mutation through one operation tail. Its deterministic
socket, generation startup lock, and live-PID refusal establish a single same-host writer. The
ledger is not a distributed database and does not claim safety against the same OS user modifying
private files.

### Admission state machine

```text
new ──submit──> queued ──reserve slot──> dispatching ──authenticate──> accepted
 │                 │                         │                            │
 │                 └──cancel──────────────> cancelled                    ├──settle──> terminal
 │                                                                      ├──cancel──> cancelling
 └──queue full / run conflict──> rejected                               └──lost boundary──> uncertain
```

- A submission is compiled and its exact command identity is recorded before admission. Dispatch
  and queue decisions write the immutable job snapshot before the admission event; deterministic
  queue-full rejection retains no executable snapshot.
- A crash before an admitted event can therefore leave an inert snapshot, but never a queued job
  whose required source was not durable.
- If capacity is available, the same admission operation records `dispatching`; otherwise it records
  `queued` or a deterministic `rejected` outcome when the queue is full.
- `dispatching` consumes capacity before process launch. A worker cannot execute the scheduler until
  authenticated adoption. If a supervisor exits during launch, the replacement first reconciles the
  known worker identity and descriptor. It never allocates another slot.
- A dispatching job with no descriptor is relaunched during reconciliation with its fixed worker id
  and token. Only one process can publish the matching descriptor, and every worker remains gated
  from scheduler execution until adoption. Failure after the authenticated execution boundary
  becomes `uncertain`, not requeued.
- Worker completion releases the existing active-run claim. A bounded supervisor reconciliation
  loop validates the run ledger, records `terminal`, and dispatches the next FIFO job. A best-effort
  worker notification may reduce latency but is not authoritative.
- Queue cancellation and dispatch run on the same serialized operation tail. If cancellation wins,
  it records `cancelled` and no worker is launched. If dispatch wins, cancellation follows the
  authenticated active-worker path; it never rewrites history as a queued cancellation.

### Policy binding

- A supervisor descriptor records the effective policy digest and bounded limits used by its
  generation. Status returns the same digest and limits.
- A client resolves configuration before auto-start or submit. If a live supervisor advertises a
  different digest, the command fails before mutation with an actionable policy-mismatch error.
- A replacement generation may adopt work only with the same policy digest. A stopped, idle
  supervisor can be explicitly shut down and its policy binding retired; the next start may then
  bind a new policy.
- Shutdown refuses while active or queued work exists. This prevents changing a queue's capacity or
  order by restarting under a different file.
- Equivalent effective values produce the same digest even if their source files differ. Editing an
  unused comment or moving an equivalent operator file does not require restart.

### Failure modes

- **Unknown, malformed, or unsupported configuration** — Fail with source path and field path before
  supervisor startup, command journaling, job creation, or run mutation.
- **Project widening attempt** — Fail with the project field, requested value, and operator/built-in
  ceiling. Do not silently clamp it because inspection must explain the exact accepted policy.
- **Configuration changes after supervisor start** — A policy digest mismatch fails before mutation.
  Existing work continues under the bound policy until an explicit idle shutdown.
- **Concurrent submissions with free capacity** — The serialized durable transition reserves at
  most `A` dispatching/active slots. Later submissions queue or reject.
- **Concurrent submissions at the queue boundary** — Exactly `Q` committed queued states exist.
  Every overflow command gets its own durable deterministic rejection.
- **Crash after job file but before admission event** — The job is an inert orphan. An exact retry
  verifies its digest and records the missing admission transition; a different input conflicts.
- **Crash after queued event but before response** — The exact retry reduces the ledger and returns
  the same queue position. It does not append a duplicate event.
- **Crash after dispatch reservation but before worker descriptor** — The reservation remains active.
  Restart reconciles or safely re-establishes the pre-execution adoption gate with the same identity;
  it does not admit another queued job into that slot first.
- **Crash after worker authentication but before accepted response** — Restart authenticates the
  existing worker, records/replays accepted, and never spawns a replacement.
- **Worker exits before a terminal ledger event** — The job becomes uncertain and continues to
  consume capacity until explicitly reconciled; no queued job is launched past the ceiling.
- **Worker completes while supervisor is down** — The run ledger and released claim are authoritative.
  Restart records terminal state and fills the freed slot in FIFO order.
- **Queued cancellation races dispatch** — One serialized transition wins. Cancellation either
  proves no worker start or follows active-worker cancellation; there is no state that claims both.
- **Torn admission tail** — Only the final invalid fragment may be removed. Invalid earlier records,
  sequence gaps, duplicate queue positions, invalid transitions, or policy changes fail closed.
- **Slow or hostile status client** — Status remains a bounded summary; it does not include workflow
  source, command reasons, tokens, credentials, or an unbounded queue dump.
- **Queue remains full indefinitely** — New work is deterministically rejected without retaining a
  workflow snapshot or creating a worker. The compact admission fact and exact command journal are
  retained for idempotency; automatic admission-ledger snapshots bound replay history, while command
  journals remain an auditable per-request history. FIFO prevents starvation among admitted queued
  jobs; it does not promise a completion deadline.
- **Project root reached through a subdirectory** — Discovery returns the same nearest ancestor
  config and canonical root. A nested Flow project intentionally creates a separate scope.
- **Unsafe init target** — Existing symlinks and non-regular targets fail. Replacement uses an
  owner-controlled temporary file and atomic rename within `.flow`.

## User and system flows

### Initialize and inspect

1. `flow init` resolves the requested directory, checks for an existing `.flow/config.yaml`, and
   writes a minimal versioned project document atomically.
2. `flow config show` walks from the invocation directory to the nearest project file, reads the
   operator file, validates both strict schemas, applies the monotonic merge, and computes the
   canonical digest.
3. Output identifies every contributing scope and selected root without loading the run store,
   supervisor, executor, or provider.

### Submit within capacity

1. The client resolves effective configuration and connects only to a matching supervisor policy.
2. The supervisor compiles and journals the exact request, persists the immutable job, and serially
   reduces the admission ledger.
3. If `active < A`, it appends a dispatch reservation before worker launch.
4. The existing worker identity/adoption gate completes; the ledger and command journal become
   accepted and the client receives the worker identity.

### Queue and later dispatch

1. If active capacity is full and `queued < Q`, the supervisor appends a unique FIFO queue position
   and returns an explicit `queued` result.
2. Status reports bounded active/queued summaries and the bound policy digest.
3. When a claim is released, reconciliation commits the previous job's terminal classification.
4. The smallest queued sequence transitions to dispatching before its worker is launched.

### Cancel queued work

1. The client supplies a stable cancellation command id, run id, actor, and optional reason.
2. Under the admission operation tail, the supervisor verifies that the job is still queued and
   appends an attributable queued-cancellation transition.
3. The command result replays idempotently. No active claim, descriptor, worker, run store, model,
   or command node is created for that job.

## Coupling analysis

- Configuration parsing, provenance, monotonic merge, and policy digest are Flow-native domain and
  application concerns. They import no Pi, OMP, Prime, provider, or supervisor process types.
- The CLI is the project-discovery and composition boundary. `config show` remains read-only and can
  run without supervisor state or provider setup.
- Admission belongs to the supervisor application layer. It can select which independent run worker
  may start, but cannot select graph nodes or append run events.
- The admission ledger adapter reuses the same owner-only, fsync, atomic-replace, torn-tail, and
  strict-replay principles as the run store. Its event schema is separate because supervisor queue
  state is not graph authority.
- Existing job files keep large workflow snapshots out of the admission ledger. A ledger record
  binds their digest and identity.
- Existing command records remain the public idempotency boundary. On retry, they reconcile from the
  admission ledger or authenticated worker exactly as issue #22 reconciles lost acknowledgements.
- Worker completion is observed from existing claims and run ledgers. A notification is an
  optimization, not a second source of truth.

## Options considered

### Configuration policy

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| CLI flags only | No config parser; explicit per command | Clients disagree, restart policy is ambiguous, poor project UX | Rejected |
| Generic defaults → operator → project deep merge | Familiar Pi/OMP behavior | A project can widen a scalar safety ceiling; provenance is insufficient | Rejected for safety fields |
| Operator-only configuration | Strong local authority | Teams cannot commit narrower reproducible limits or define a project root | Rejected |
| Strict layered documents with monotonic safety merge | Inspectable, reproducible, operator ceiling cannot be widened, future field-specific merge laws | More schema/provenance code; unsafe widening must be diagnosed | **Chosen** |

### Admission behavior

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Reject whenever active capacity is full | Small state surface; bounded | Poor unattended UX; clients must implement retries; no durable ordering | Rejected |
| Durable bounded FIFO | Deterministic, starvation-free among admitted work, observable, restart-safe | Requires queue state, dispatch reconciliation, queued cancellation | **Chosen** |
| Priority or weighted-fair scheduler | Expressive for heterogeneous workloads | No measured policy need; starvation and configuration complexity; premature API | Deferred |

### Durable admission storage

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Extend independent JSON snapshot files | Reuses current adapter; minimal new code | No atomic global order/counter; more cross-file crash ambiguity | Rejected |
| Flow append-only admission ledger | One fsynced event is one state transition; natural FIFO sequence; auditable; aligns Prime command journal and Pi/Flow JSONL; no runtime dependency | Requires strict reducer, tail repair, compaction, and a single-writer invariant | **Chosen for the same-host supervisor** |
| Flow SQLite state store using `node:sqlite` | Transactions, constraints, indexed queries, defensive multiwriter serialization; Pi proves packaging compatibility | Experimental warning on Node 22.19, synchronous event-loop work, new migrations/permissions/backup surface, disproportionate for one local writer | Keep behind the future store port; reconsider for broader control planes |
| Imported Pi SQLite session backend | Proven leases/migrations and same Node floor | Session schema and semantics do not model Flow admission; couples native control authority to an inner runtime package | Rejected |

## Decision

Implement strict Flow-native operator and project configuration with field-specific monotonic safety
merging. Add `flow init` and `flow config show`. Bind every supervisor generation to the canonical
effective capacity digest.

Implement durable bounded FIFO admission as a Flow-owned append-only supervisor ledger. Preserve
immutable job files, exact command journals, active claims, authenticated worker descriptors, and
the per-run JSONL ledger. Serialize admission transitions, reserve capacity before launch, reconcile
worker completion from authoritative stores, and let queued cancellation win only before dispatch.

The initial defaults are deliberately conservative: one active worker and 32 queued jobs. OMP's
default of 32 applies to session-local subagents and is not evidence that 32 independent Flow run
workers—each able to create providers, sandboxes, and later child graphs—are safe by default.

## Consequences

- Unconfigured projects remain usable, but detached work becomes safely bounded and overflow can
  wait rather than starting an unbounded process fleet.
- A project can make its own workload narrower and reproducible without gaining authority over the
  operator ceiling.
- The control plane acquires a second append-only ledger, but the separation is explicit: run events
  prove graph state; admission events prove capacity allocation and queue order.
- Same-host single-writer coordination remains the scope. A future multi-host control plane can
  implement the admission-store port with a transactional database without changing the domain
  state machine.
- A dispatching or uncertain job may conservatively reduce available capacity. This is preferable to
  exceeding the configured ceiling or replaying an external effect.
- Hot policy reload is intentionally absent. Effective-value changes require an explicit idle
  supervisor restart, making the policy boundary visible and testable.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Safe project initialization | Filesystem/error | `npx vitest run test/integration/config/project-config.test.ts -t "initializes|replaces|unsafe"` | Minimal config is atomic; existing/symlink/non-file targets are preserved unless safe replacement is explicit | Repository scaffolding beyond Flow config |
| Inspectable effective config | Contract | `npx vitest run test/unit/config/resolver.test.ts test/integration/config/project-config.test.ts test/cli/main.test.ts` | Values, sources, root, production XDG path, and stable digest are exact and secret-free | TUI settings editor |
| Defaults/operator/project monotonic merge | Domain/property | `npx vitest run test/unit/config/resolver.test.ts` | Defaults apply; operator changes values; project only narrows; digest canonicalization is order-independent | Generic deep merge for future fields |
| Invalid config fails before mutation | Error/holdout | `npx vitest run test/unit/config/resolver.test.ts -t "invalid configuration|widening" && npx vitest run test/integration/config/project-config.test.ts test/integration/cli/main.test.ts -t "YAML and schema|invalid project configuration"` | Version, kind, unknown field, every hard bound, widening, and YAML diagnostics include path; no supervisor or run-store state appears | Automatic config repair |
| Subdirectory root discovery | Filesystem | `npx vitest run test/integration/config/project-config.test.ts -t "subdirectory"` | Nearest canonical project root is stable and visible | Monorepo workspace aggregation |
| Active limit under concurrency/restart | Concurrency/runtime | `npx vitest run test/integration/supervisor/service.test.ts -t "oversubscribes|FIFO|restarts"` and `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "capacity"` | Maximum dispatching/authenticated workers never exceeds the bound under barriers and restart | Multi-host consensus |
| Explicit queued versus accepted outcome | Protocol/API | `npx vitest run test/unit/supervisor/protocol.test.ts test/integration/supervisor/service.test.ts -t "queued"` | Queue result has stable position; accepted result has authenticated worker; schemas cannot conflate them | Completion ETA |
| Deterministic starvation-free restart order | State/model/runtime | `npx vitest run test/unit/supervisor/admission-reducer.test.ts` and `npx vitest run test/integration/supervisor/service.test.ts -t "FIFO|restart"` | Every reachable state preserves unique FIFO dispatch; restart preserves sequence | Priority fairness |
| Bounded queue and durable rejection | Boundary/idempotency | `npx vitest run test/integration/supervisor/service.test.ts -t "bounds active|oversubscribes|queue-full rejection"` | Exactly Q waiters; overflow and interrupted-journal retries return the same rejection and retain no job snapshot | Client-side retry policy |
| Queued cancellation starts no worker | Race/runtime | `npx vitest run test/integration/supervisor/service.test.ts -t "queued work|cancellation retryable"` and `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "capacity"` | Cancellation/dispatch race has one winner; a queued winner leaves no claim, worker, or run ledger | Reversal after dispatch |
| Bounded status and policy digest | API/security | `npx vitest run test/integration/supervisor/service.test.ts` | Active/queued summaries and digest are bounded; explicit negative assertions exclude source/token/reason fields; status performs identity checks without provider execution | Full historical queue export |
| Policy mismatch requires safe restart | Lifecycle | `npx vitest run test/integration/supervisor/daemon.test.ts` and `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "requires explicit idle shutdown"` | Changed effective values fail before submit; shutdown refuses non-idle state; successful shutdown retires before acknowledgment; explicit idle restart rebinds | Hot reload |
| Existing behavior compatibility | Regression | `npx vitest run test/integration/cli/main.test.ts` and `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts` | Foreground paths, ledgers, approvals, accepted work, cancellation, and event replay remain correct | Stable pre-1.0 syntax forever |
| Public documentation accuracy | Documentation | `npx vitest run test/scaffold/community-files.test.ts -t "project configuration and bounded admission"` | README and architecture/config/recovery/security/roadmap describe limits, precedence, outcomes, recovery, and trust boundaries | Future capabilities |
| Complete package remains releasable | Regression/package | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Local CI, runtime, package contents, clean install, and audit pass | Live provider availability |

## Implementation tasks

1. [x] Define strict operator/project config schemas, built-in hard/default limits, canonical digest,
   monotonic merge, source provenance, and path-specific diagnostics.
2. [x] Implement nearest-project-root discovery and XDG operator path resolution behind testable
   filesystem/environment boundaries.
3. [x] Implement atomic `flow init` with explicit safe replacement behavior.
4. [x] Implement `flow config show` with values, sources, selected root, and digest.
5. [x] Define admission events, parser, reducer, invariants, terminal transitions, and exhaustive
   model/property tests.
6. [x] Implement the owner-only append/fsync/replay/torn-tail/compaction admission ledger adapter.
7. [x] Extend protocol results and errors to distinguish durable queued, accepted, rejected,
   cancelled, uncertain, and policy-mismatch outcomes.
8. [x] Integrate serialized admission into submission without changing foreground execution or run
   ledger authority.
9. [x] Add deterministic capacity release, FIFO dispatch, and restart reconciliation.
10. [x] Extend cancellation so queued work is attributable, idempotent, and worker-free.
11. [x] Bind supervisor descriptors and client requests to the effective policy digest and enforce
    explicit idle restart for changes.
12. [x] Extend bounded status with active/queued summaries and effective limits.
13. [x] Add concurrent, crash-point, restart, queue-bound, cancellation-race, compiled-process, and
    clean-package tests without provider credentials.
14. [x] Update README, architecture, configuration, recovery, security, testing, workflow, and
    roadmap documentation as behavior lands.
15. [x] Run local CI, coverage, package/consumer, audit, model-state exploration, and adversarial
    review; record every finding and disposition here.

## Final verification evidence

- `npm run check`: passed on the final tree; 41 default test files / 471 tests, clean build, and 2
  compiled-process files / 14 runtime tests.
- `npm run test:coverage`: passed the configured 75% statement, 65% branch, 70% function, and 75%
  line thresholds. Process-race coverage is timing-sensitive; the final recorded run reported 82.28%
  statements, 72.79% branches, 90.86% functions, and 82.62% lines.
- Package metadata inspection: 177 files, 219,405 bytes compressed, and 1,168,739 bytes unpacked.
- `npm run pack:check`: rebuilt and packed the final tree, installed the tarball in a clean temporary
  consumer with lifecycle scripts disabled, ran the installed `flow --help`, created
  `.flow/config.yaml`, and inspected the canonical default 1/32 policy and project root.
- `npm audit --omit=dev --audit-level=low`: zero production vulnerabilities.
- Admission model exploration: the exhaustive small-state reducer test visited more than 100
  reachable states while checking active/queue bounds and unique FIFO tickets.
- Adversarial review: every finding below is fixed and represented by a focused test or an existing
  full-gate assertion; no unresolved P1/P2/P3 finding remains for this issue.

## Adversarial review findings and dispositions

| Finding | Priority | Disposition |
| --- | --- | --- |
| Queue-full submission retained a large inert workflow snapshot | P1 | Fixed: rejection now stores only command/admission facts; regression asserts no job record |
| Status and reconciliation enumerated lifetime worker descriptors | P1 | Fixed: both read only identities reachable from live claims/admission; regression store fails if historical enumeration occurs |
| Reconciliation stopped after one queued launch became uncertain | P1 | Fixed: the failed job consumes one conservative uncertain slot and unrelated actions continue |
| Admission ledger had only manual compaction | P1 | Fixed: automatic threshold/byte-triggered replay-equivalent snapshot with focused recovery test |
| Breaking policy-aware wire schema remained protocol v1 | P1 | Fixed: wire/descriptor protocol is v2; durable job, command, worker, run, and admission records remain v1 |
| Compacted roots allowed duplicate run or worker identities | P1 | Fixed: reducer rejects unreachable snapshot topology and new-event identity collisions |
| Cancellation during dispatch/claim creation reported `not_found` | P1 | Fixed: returns retryable `worker_unavailable`; deterministic barrier test retries the same command successfully |
| Idle shutdown could race a later admission or in-flight store close | P1 | Fixed: serialized shutdown fence plus drained close/retire; response delivery no longer controls server transition |
| Production ignored `XDG_CONFIG_HOME` despite injectable tests | P1 | Fixed: explicit injectable environment wiring with absolute-path semantics and integration coverage |
| Dead-supervisor policy mismatch was hidden behind detached child exit | P2 | Fixed: lock-holding parent preflights the durable admission policy before spawn |
| Active health checks multiplied timeout latency sequentially | P2 | Fixed: at most 64 live identities are checked concurrently; historical state remains excluded |
| Policy mismatch blocked the read-only status needed to inspect the old generation | P2 | Fixed: status reports the live digest/limits without weakening stateful request checks; compiled lifecycle test covers shutdown and rebound |
| Protocol, records, and reducer duplicated hard capacity literals | P2 | Fixed: all schemas import the Flow domain cap constants |
| Accepted frame could outgrow its job record through Flow metadata | P2 | Fixed: the private record limit reserves a fixed metadata envelope above the wire ceiling |
| Unknown server/storage faults were mislabeled as invalid client protocol | P2 | Fixed: protocol parsing remains `protocol_invalid`; internal/storage failures normalize to `internal` |
| Exact submission retry could recreate admission while queued cancellation committed | P1 | Fixed: serialized admission re-reads the durable command and fails closed for cancelling, missing, or uncertain queue state; deterministic barrier test prevents resurrection |
| A timed-out daemon launch could outlive the startup lock and race a replacement generation | P1 | Fixed: timeout terminates the detached process group, escalates when required, reaps it before releasing the lock, and reports the parent-known PID |
| One unreachable dispatching worker stopped adoption of unrelated healthy workers | P2 | Fixed: transport failure marks only that job and command uncertain while identity mismatches remain fatal; reconciliation continues |
| `queue_cancelling` work was omitted from the idle/shutdown predicate | P2 | Fixed: idleness requires an empty admission job map, so cancellation must finish before shutdown or policy retirement |
| A queue-full decision could be lost between admission and command-journal commit | P1 | Fixed: two-phase digest-bound rejection tombstones survive replay/compaction and exact retry; shutdown and retirement wait for commit completion |
| Direct and dangling project/operator config symlinks were followed or treated as absent | P2 | Fixed: discovery uses path-identity checks and reads use `O_NOFOLLOW`; direct and dangling cases fail closed |
| Initial `flow init` exposed the public config path before its bytes were complete | P2 | Fixed: a synced private inode is published through an atomic no-replace hard link and directory-synced before cleanup; concurrent initializers produce one complete winner |
| Invalid-config acceptance selectors skipped claimed version, kind, bound, CLI, and documentation cases | P2 | Fixed: field-specific table tests, pre-mutation CLI holdout, public-doc assertions, and exact runnable selectors cover every claim |
| `pack:check` inspected a dry-run file list but claimed a clean consumer install | P3 | Fixed: one local/CI script rebuilds, packs, clean-installs, and executes the installed CLI plus init/config smoke path |
| Exclusive job, claim, command, and startup records were visible before serialization completed | P1 | Fixed: the shared exclusive writer now uses synced pending inodes and atomic no-replace publication; compiled startup contention and store regressions prove one complete winner |
| The daemon-timeout regression depended on the child writing a PID file before its own deadline | P2 | Fixed: a typed timeout error carries the PID known immediately by the spawning parent and is emitted after process-group termination/reaping |
| Timed-out detached-child cleanup used only unreferenced handles and could let the client exit before escalation/reaping | P1 | Fixed: cleanup temporarily references the child until termination completes, then restores detached ownership; compiled timeout regression proves the client remains alive through reaping |
| Concurrent exact queued-cancellation callers could turn one durable cancellation into `not_found` for the retry | P2 | Fixed: a caller that loses the admission race re-reads the digest-bound command journal and returns the same completed queued result; a barrier test proves both callers converge without launching work |
| Initial admission creation exposed the final ledger name before the initialization record was synced | P2 | Fixed: initialization now writes and syncs a private inode, publishes it with a no-replace hard link, and directory-syncs before cleanup; protocol and 16-opener tests prove complete publication |
| Shutdown acknowledged success before the old admission policy was retired | P2 | Fixed: retirement completes in request dispatch before the success frame is built; the daemon test checks the binding is absent immediately after the response |
| A reconciliation callback queued before shutdown could run after policy retirement and access a closed admission store | P1 | Fixed: the monotonic shutdown fence also prevents new timer reconciliation, while refused non-idle shutdown leaves reconciliation enabled; the full suite exposed and verifies the ordering |
| A startup-lock contender could observe `EEXIST` and then fail when the owner released before the incumbent read | P2 | Fixed: only the typed `EEXIST`→`not_found` contention epoch retries exclusive reservation; four compiled six-client stress runs converge on one generation |
| The parent, not the detached daemon, transferred startup-lock ownership, leaving a parent-death double-writer window | P1 | Fixed: source and new-owner tokens are passed to the child, which transfers ownership before admission replay, descriptor publication, or listening; a lifecycle-order regression enforces the boundary |
| Concurrent stale-lock releasers wrapped losing rename races as unexpected I/O failures | P2 | Fixed: rename-time absence is typed `not_found` and treated as converged stale cleanup; 32 concurrent releasers produce one success and only typed absence outcomes |
| Child-side ownership transfer preserved the parent token, so a stale parent observation could still delete the daemon lock | P1 | Fixed: transfer atomically rotates both PID and capability token; stale parent-token release fails identity validation, and the focused regression proves daemon ownership remains published |
| FIFO, status, policy, and compatibility verification selectors silently skipped model/runtime or security evidence | P2 | Fixed: model and runtime configs run separately, broad claims execute complete focused files, status has explicit sensitive-field exclusions, and every documented selector passes with nonzero tests |
| Final test, coverage, and package counts described an earlier commit as the final tree | P2 | Fixed: evidence was regenerated after the last code change and records 41/471 default tests, 2/14 runtime tests, enforced coverage thresholds with the latest observation, and current 177-file package sizes |
| Rotated ownership could still be deleted because release validated the mutable path before renaming it | P1 | Fixed: release atomically renames the exact inode to a recoverable marker before identity validation; reservations and transfers settle markers, and deterministic ordering plus 64-round race tests prove a stale release cannot erase daemon ownership |
| Timing-sensitive process branches made a single exact coverage percentage an unstable final-tree claim | P2 | Fixed: the journal records the configured enforced thresholds and labels the latest observed report rather than claiming one immutable percentage |
| A crash after publishing a fresh reservation but before its marker check could leave a conflicting public lock and release marker forever | P2 | Fixed: exact restored identity reacquires idempotently; marker settlement retires only a conflicting dead-PID unpublished reservation through the atomic release path, then restores the authoritative marker; two deterministic recovery tests cover both states |

## Research references

- Pi settings: <https://pi.dev/docs/latest/settings>
- Pi JSONL session storage:
  <https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/harness/session/jsonl/storage.ts>
- Pi Node SQLite backend:
  <https://github.com/badlogic/pi-mono/tree/main/packages/session-backends/sqlite-node>
- OMP settings precedence: <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>
- OMP task concurrency: <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md>
- OMP semaphore implementation:
  <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/parallel.ts>
- Prime daemon architecture:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- Prime command recovery journal:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/modes/daemon/command-recovery-journal.ts>
- XDG Base Directory Specification: <https://specifications.freedesktop.org/basedir-spec/latest/>
- Node SQLite: <https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html>
