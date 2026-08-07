# Decision Journal: Issue #30 — Proof-safe interrupted-agent retry

**Issue**: #30 | **Branch**: `codex/issue-30-proof-safe-retry` | **Started**: 2026-08-07

---

## Context

Gate 4 can now recover at committed node boundaries, retain write-ahead evidence for every
Flow-owned hash-anchored edit, and reconcile an unsettled edit against the current workspace. The
remaining open-attempt behavior is deliberately conservative: recovery records any supported
observations and then refuses the still-running node as `uncertain_operation`.

That refusal is stronger than necessary for two classes of agent attempt. A read-only agent can
have no workspace mutation through its allowed tools. A writable protocol-v1 agent can also be
shown not to have changed the workspace when every prepared edit either settled not-applied or was
reconciled against its exact before content and mode. A fresh attempt is effect-safe in those two
cases, although the interrupted provider usage and active execution time remain unknowable.

Three distinct retry layers must not be conflated:

1. A provider transport may retry the same HTTP request before a response stream exists.
2. Pi may retry a transient failed assistant turn inside one live node attempt.
3. Flow may start a new graph-node attempt after process recovery.

The exact installed Pi 0.84.0 runtime currently enables layer 2 by default with three retries and a
2-second exponential base delay, while provider retry defaults to zero. If Flow later allows `A`
node attempts without taking ownership of that default, the upper bound becomes `4A` assistant
requests rather than `A`. AWS guidance also warns that retries at multiple layers multiply load and
that side-effecting work is retryable only with an idempotency proof. Flow therefore needs one
explicit recovery-attempt contract and must disable inherited Pi retry defaults in this slice.

## Specification

_Captured by specification-capture on 2026-08-07. Source: Issue #30 plus the user-approved
constraints in Issues #12, #25, and #28._

### Non-goals

- This issue does not resume, reopen, fork, parse, repair, or treat a Pi/OMP session transcript as
  authoritative Flow state.
- This issue does not retry interrupted command nodes, settled node failures, approvals, arbitrary
  process execution, network calls, provider API mutations, or effects outside the typed
  `flow.effects/v1` edit protocol.
- This issue does not retry a writable attempt with any committed, applied, unknown, divergent,
  missing, unreadable, oversized, raced, unsettled, unsupported, or legacy-untracked effect.
- This issue does not infer provider tokens, reported cost, or active execution time for a process
  that stopped before terminal evidence became durable.
- This issue does not permit automatic retry under a declared model-token, reported-cost, or
  active-execution budget whose prior consumption is unknown.
- This issue does not add retry of ordinary terminal failures, provider-specific idempotency keys,
  backoff schedules across process restarts, delayed jobs, graph loops, or verifier reruns.
- This issue does not claim that a fresh attempt preserves the interrupted model's hidden state or
  unfinished reasoning. It starts the declared prompt in a new provider-neutral agent session.
- This issue does not add multi-host coordination, remote workers, VM isolation, or protection from
  a hostile process running as the same operating-system user.
- This issue does not change the meaning of a completed node, accepted goal, command approval, or
  reconciled edit.

### Failure modes

- **Timeouts and cancellation** — Cancellation before the durable interruption disposition appends
  nothing and starts no executor. Cancellation after a disposition but before a new start leaves a
  replayable pending node; the normal resume/cancel rules apply without duplicating the disposition.
  A fresh attempt receives the normal timeout bounded by any exact remaining node-start policy.
- **Partial failures** — The interruption disposition is appended before `run_resumed` and before
  the next `node_started`. If either later append or the process fails, replay retains one archived
  attempt and starts only its next number. If disposition append acknowledgement fails, the old
  attempt remains running and no retry starts.
- **Invalid input** — Unknown recovery fields, a meaningless attempt limit, unsupported mode,
  skipped/repeated attempt number, disposition for a non-running node, disposition outside the
  persisted policy, or a disposition that contradicts effect/resource state fails schema or replay
  at the offending event.
- **Missing context** — A historical run without a persisted recovery policy keeps the existing
  no-retry behavior. A writable historical attempt without the durable effect protocol is never
  treated like an empty read-only attempt. A missing executor or recovery adapter has no permissive
  fallback.
- **Dependency outage** — Pi/provider availability affects only a newly started attempt. It cannot
  weaken eligibility. Run-store or reconciliation failure happens before new execution and leaves
  the durable prefix authoritative.
- **Resource exhaustion** — `maxAttempts` bounds starts for one opted-in node and remains at most 16.
  The run-wide `maxNodeStarts` limit must have room for the next start before disposition. Declared
  model-token, reported-cost, or execution-time limits block automatic retry because the crashed
  attempt's consumption cannot be proven. No unknown consumption is coerced to zero.
- **Applied or uncertain effects** — Any effect other than known not-applied blocks retry, even if a
  later external change happens to restore the original bytes. A committed effect is never
  reclassified from current workspace observation.
- **Malformed or incompatible history** — Full workflow and event-history compatibility validation
  precedes reconciliation, disposition, `run_resumed`, and execution. A forged run-start policy or
  impossible interruption event is rejected either by intrinsic schema/replay validation or by the
  application check against the exact compiled workflow, before any recovery mutation.
- **Repeated recovery** — A committed disposition changes the node from running to pending and
  archives the old attempt. Later recovery cannot append the same disposition because no matching
  running attempt remains. A crash of the next attempt may produce one disposition for that new
  attempt if its own proof and limit permit it.
- **Upstream retry drift** — Production composition explicitly disables Pi assistant-turn retry and
  sets provider retry attempts to zero. An upstream default change therefore cannot silently add a
  second retry layer.

### Interface contracts

- An agent node may declare `recovery: { mode: fresh, maxAttempts: N }`, where `N` is an integer from
  2 through 16 and includes the initial attempt. Omission means no interrupted-attempt retry.
- `run_started` persists each opted-in node's exact recovery mode, maximum attempts, and required
  effect protocol. Replay does not consult a newly compiled workflow to decide event legality.
- `node_attempt_interrupted` references the exact running node and attempt and records
  `reason: process_interrupted`, `disposition: fresh_retry`, and
  `resourceAccounting: incomplete`. It is legal only when a persisted policy permits a next attempt,
  the run-wide node-start budget has remaining capacity, no unverifiable resource budget is
  declared, and every possible Flow-owned effect is known not applied.
- A policy persisted for a read-only agent requires no effect protocol and accepts only an empty
  effect list. A policy persisted for an edit-capable agent requires `flow.effects/v1` and accepts
  only effects whose executor settlement or recovery reconciliation is `not_applied`.
- Applying the interruption event archives immutable attempt identity, timestamps, protocol, and
  effect evidence; resets the current node projection to pending; retains the last attempt number;
  and changes no goal decision or resource total.
- `node_started` must use exactly the prior node attempt plus one. The scheduler derives this number
  from replayed state and never hard-codes attempt one.
- A fresh retry creates a new Pi in-memory session from the original compiled prompt and current
  workspace. Pi assistant-turn retry and provider retry are explicitly disabled in production.
- Recovery validates and reconciles first, appends an eligible interruption disposition second,
  appends `run_resumed` third, and enters the ordinary scheduler last.
- Default/no-policy, command, ineligible-effect, legacy, attempt-limit, resource-accounting, and
  node-start-capacity cases start no executor. Ineligible opt-in retries expose a stable typed
  recovery error; omitted policy preserves `uncertain_operation` compatibility.

## User, operator, and system flows

### User: opt-in read-only recovery

1. The workflow opts an agent with only read/list tools into fresh recovery with a finite attempt
   cap.
2. The worker stops after the first `node_started` but before a terminal event.
3. The user resumes the exact workflow from the exact execution directory.
4. Flow validates the ledger, proves the persisted policy required no effect protocol, and confirms
   the resource policies permit a new attempt.
5. Flow appends the interruption disposition, then `run_resumed`, then starts attempt two in a fresh
   model session.
6. Inspection retains attempt one's incomplete-accounting marker and attempt two's final evidence.

### User: opt-in writable recovery with no applied edit

1. The interrupted attempt contains one or more open protocol-v1 edit preparations.
2. Gate 4 reconciliation observes every open effect as exact-before/not-applied; any already-settled
   effect is also not-applied.
3. Flow archives the attempt and starts the next attempt. The new model sees the current workspace
   but no hidden session state from the interrupted process.

### Operator: unsafe or unbudgetable attempt

1. The operator resumes an attempt containing a committed/applied/unknown/legacy effect, or a run
   whose declared token/cost/time budget cannot tolerate unknown prior consumption.
2. Flow returns a typed bounded blocker after any safe reconciliation evidence is durable.
3. No interruption disposition, `run_resumed`, node start, provider call, or new effect occurs.
4. `inspect` exposes the effect evidence and original running attempt for manual diagnosis.

### System: crash between disposition and retry

1. Flow durably archives attempt one and resets the node to pending.
2. The process stops before `run_resumed` or `node_started` for attempt two.
3. A later resume sees no open attempt, appends a recovery marker, and starts exactly attempt two.
4. The attempt-one disposition is not repeated.

### System: repeated crash

Each fresh attempt consumes one node start and one per-node attempt. Another proof-safe interruption
may advance to the next number until either bound is exhausted. The system never multiplies that
bound with an implicit Pi retry loop.

## Existing patterns and dependency analysis

- The run reducer already treats `attempt` as durable identity and command-approval requests already
  require `current.attempt + 1`; only node scheduling and node transition legality assume one start.
- `run_started` already persists workflow identity, approval requirements, and budget limits. A
  bounded recovery-policy projection follows this established replay-authority pattern.
- The application already validates the exact compiled workflow before inspecting the workspace and
  serializes event construction/store append/reducer application. It remains the disposition event
  authority.
- Gate 4 reconciliation already distinguishes executor settlement from later observation. Retry
  eligibility consumes both without changing either.
- Pi is an infrastructure adapter. It may implement one live model loop, but it does not own Flow
  attempt count, graph state, durable policy, or recovery decisions.
- The supervisor already records a typed `RunRecoveryError` separately from authoritative run
  status. A retry-ineligible error fits that projection without pretending the run failed.

Dependency direction remains:

```text
workflow source -> compiler -> persisted run-start recovery policy
                                  |
                                  v
run reducer <--- application recovery decision <--- effect reconciler
    ^                       |
    |                       v
event store             ordinary scheduler -> executor port -> Pi adapter
```

The domain imports no Pi, filesystem, CLI, or supervisor module. The Pi adapter receives no right to
choose a Flow attempt or append a recovery event.

## Approaches considered

| Approach | Simplicity | Context continuity | Effect safety | Budget truth | Provider neutrality | Risk | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Persist and reopen the Pi session, then continue the interrupted turn | Low | Highest when the transcript is complete | Cannot currently bind a dangling Pi tool call/result to Flow's fsynced effect record; OMP drops unsafe dangling calls and Pi persistence is not a Flow durability barrier | Partial messages and provider usage can remain unknown | Couples recovery to Pi session format | High | Deferred until a typed session-checkpoint and tool-call bridge exist |
| Fresh-retry every reconciled agent attempt | High | None | Applied or unknown edits can be semantically duplicated even when hash anchors prevent an identical byte write | Unknown prior usage is hidden | High | High | Rejected |
| Require an operator to abandon/retry every open attempt | High | Operator-dependent | Strong | Operator can accept uncertainty explicitly | High | Low | Retained as the fallback for ineligible attempts, but insufficient for the roadmap capability |
| Opt-in fresh retry only from replay-proven no-effect state with one Flow-owned retry layer | Moderate | None; declared honestly | Strong for current read/list/edit surface | Honest by blocking declared unverifiable budgets and marking prior accounting incomplete | High | Moderate | **Selected** |

The decisive trade-off is context continuity versus proof. The installed Pi session can restore a
conversation, but it cannot form the fsynced authority for a Flow effect or prove a partially
delivered provider response. A fresh attempt deliberately sacrifices hidden context only where the
workspace proof makes repeating the declared prompt safe.

## Decision

Add an opt-in `fresh` recovery mode for agent nodes. Persist a compact policy projection at run
start. After Gate 4 reconciliation, append a strict interruption event only when replay proves that
the node was read-only or every tracked edit was not applied, the per-node attempt cap has room, the
global node-start cap has room, and no declared token/cost/execution limit depends on unknowable
consumption.

Archive interrupted attempts in the public replay state. Start the next attempt through the
ordinary scheduler with a new attempt number, original compiled prompt, current workspace, and new
in-memory Pi session. Explicitly disable both Pi assistant-turn retry and provider retry so Flow has
one recovery retry layer and future upstream defaults cannot change the bound.

Do not reinterpret an effect reconciliation as node completion. Do not automatically retry any
effect that may have applied. Do not claim resource-budget conformance when the prior attempt's
provider usage or active duration is unknown.

## State-machine and bound validation

```text
running attempt N
  |
  | reconcile all open effects
  v
proof-safe? -- no --> typed recovery refusal; remains running N
  |
 yes + policy/budget capacity
  v
node_attempt_interrupted(N)
  |
  +--> archive N (accounting incomplete)
  +--> current node pending, last attempt = N
  |
  v
run_resumed -> node_started(N+1) -> normal terminal outcome or another interruption
```

For `maxAttempts = A`, exactly `A - 1` interruption dispositions are possible and at most `A` node
starts can occur for that node. Because Pi retry is explicitly zero, the recovery layer does not
multiply the provider-turn bound by Pi's former factor of four. Normal multi-turn tool use remains
bounded by node timeout and is not misreported as recovery attempts.

Eligibility truth table for each possible effect state:

| Effect state | Fresh retry eligible? | Reason |
| --- | --- | --- |
| No effects, persisted read-only policy | Yes | No mutating tool was available |
| No effects, protocol-v1 edit policy | Yes | Every edit would have prepared before mutation |
| Executor-settled not-applied | Yes | Commit boundary was not entered |
| Recovery-observed not-applied | Yes | Exact before bytes and mode under the shared lock |
| Executor-settled committed or unknown | No | A mutation occurred or may have occurred |
| Recovery-observed applied or unknown | No | Current evidence proves or cannot exclude mutation |
| Prepared but neither settled nor reconciled | No | Effect outcome remains open |
| No protocol on a persisted edit-capable policy | No | Legacy/untracked effects cannot be excluded |

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Explicit opt-in, bounded schema, default no retry | Contract/config | `npx vitest run test/unit/workflow/compiler.test.ts` | Valid policy compiles immutably; absent, malformed, unknown, 1, and >16 values behave as specified | Session continuation or terminal-failure retries |
| Strict event legality, attempt archive, restart replay | Contract/data | `npx vitest run test/unit/run/attempt-recovery-reducer.test.ts` | Safe dispositions replay immutably; forged policy/effect/budget/attempt combinations fail at the event | Filesystem truth beyond durable evidence |
| Read-only and not-applied attempts retry as N+1 | Behavioral | `npx vitest run test/unit/application/run-workflow-retry.test.ts -t "read-only|not-applied"` | Event order is disposition, resumed, next start; executor receives next attempt and old evidence remains | Applied-effect retry or Pi context continuity |
| Unsafe/legacy/default cases remain blocked | Error/adversarial | `npx vitest run test/unit/application/run-workflow-retry.test.ts -t "applied edit|legacy writable|recovery was omitted"` | No executor or disposition; stable blocker and unchanged/observation-only ledger | Operator-forced recovery |
| Crash and cancellation boundaries are idempotent | Behavioral/data | `npx vitest run test/unit/application/run-workflow-retry.test.ts -t "crash between disposition|disposition persistence|cancellation"` | Durable disposition survives later failure and is never duplicated; failed disposition append and pre-disposition cancellation start nothing | Power-loss behavior beyond run-store fsync contract |
| Exact attempt and run-wide start bounds; unverifiable budgets block | Behavioral/error | `npx vitest run test/unit/run/attempt-recovery-reducer.test.ts -t "final configured attempt|unaccountable|node-start"` | No N+1 beyond either bound; token/cost/time limit yields typed refusal | Prepaid provider billing cap |
| Upstream retry defaults cannot multiply requests | Integration/contract | `npx vitest run test/unit/infrastructure/pi/pi-agent-executor.test.ts -t "retry ownership"` | Production session settings report assistant retry disabled and provider max retries zero | Provider implementation bugs outside the pinned adapter |
| CLI and detached production composition | Integration/runtime | `npx vitest run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts -t "fresh numbered attempt|proof-safe retry"` | Foreground and worker recovery start exactly next attempt and persist identical provenance | Remote/multi-host recovery |
| Public claims and release compatibility | Docs/release | `npx vitest run test/scaffold/community-files.test.ts && npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | README/recovery/architecture/workflow/testing/roadmap agree; all static/runtime/package/security gates pass | Gate 5 graph control flow |

## Planned RED → GREEN → REFACTOR sequence

1. **Workflow RED** — Add compiler tests for optional fresh recovery and strict attempt bounds; prove
   the current schema rejects the new contract.
2. **Domain RED** — Add reducer tests for run-start policy persistence, strict interruption legality,
   immutable archived attempts, exact N+1 starts, effect truth table, and resource-bound refusals.
3. **Domain GREEN/REFACTOR** — Add the compact event/state contracts and centralize eligibility
   validation in replay.
4. **Application RED** — Add recovery tests for read-only/not-applied success, all unsafe blockers,
   append-boundary idempotency, budget/attempt exhaustion, and cancellation.
5. **Application GREEN/REFACTOR** — Derive and append the disposition after reconciliation, then let
   the ordinary scheduler allocate the next attempt.
6. **Pi RED/GREEN** — Prove production uses explicit zero retry settings, then pin both upstream
   layers.
7. **Composition/docs RED/GREEN** — Add CLI/worker restart coverage and public-contract checks, then
   update every recovery and roadmap surface.
8. **VERIFY** — Run focused commands, the full release gate, runtime CLI samples, exhaustive diff
   review, and adversarial assumption review.

## Primary research and independent checks

- Exact installed Pi 0.84.0 sources and a runtime probe show `SettingsManager.inMemory()` defaults
  assistant-turn retry to enabled with `maxRetries: 3` and provider retry unspecified/zero.
- Pi's session documentation and exact installed `SessionManager` show that `inMemory` is
  non-persistent, while persistent session JSONL restores model context but is separate from Flow's
  run ledger and effect fsync barrier.
- OMP's current session documentation records `tool_execution_start` and synthesizes an aborted tail
  on resume, but explicitly states session appends and flushes have no fsync and dangling tool calls
  are removed from safe model context. This supports diagnostics, not automatic effect proof.
- Prime Agent's current daemon design journals mutating commands before dispatch, reports missing
  durable results as uncertain, and does not replay uncertain side effects after worker recovery.
- AWS Durable Execution documentation distinguishes at-least-once retry for idempotent operations
  from at-most-once/no-retry for external side effects. AWS Well-Architected guidance warns against
  retries at multiple layers because their attempt counts compound.
- Git history confirms Issues #12, #25, and #28 intentionally deferred retry until ownership,
  write-ahead evidence, and reconciliation existed. Issue #30 consumes those prerequisites rather
  than replacing them.

## Consequences and remaining uncertainty

- Proof-safe interrupted read-only and not-applied agent work can progress without operator
  intervention when the workflow explicitly permits it.
- Public run state grows by one bounded archived-attempt record per retry, at most 15 per node.
- Users lose Pi's implicit transient-turn retries in Flow. This is intentional deterministic
  ownership; a later Flow policy may reintroduce bounded live-turn retry with durable telemetry.
- A fresh attempt pays for a new prompt and lacks hidden provider/session context. The original
  workspace and Flow event evidence remain available, but they are not a transcript substitute.
- Runs with token, cost, or active-time budgets remain blocked after interruption. A future session
  checkpoint or pre-request reservation design is required before those bounds can remain provable.
- Session continuation for attempts with applied edits remains a separate high-risk capability. It
  needs durable session checkpoints, tool-call/effect correlation, provider compatibility, and
  explicit handling of dangling tool results before it can be considered.
