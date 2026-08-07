# Decision Journal: Issue #34 — Execute bounded concurrent workflow forks

**Issue**: #34 | **Branch**: `codex/issue-34-bounded-concurrent-forks` | **Started**:
2026-08-07

---

## Init

### Context and invocation reason

Gate 5 requires concurrent fork/join execution. Issue #32 established replay-safe exact-output
conditions, guarded branches, omission, and explicit sequential joins, but the scheduler still
permits only one open executable attempt. This slice turns existing static DAG fan-out into bounded
real concurrency without moving graph authority into Pi, OMP, a provider, or an in-memory worker.

The user approved continuing the implementation roadmap with the same research, TDD,
documentation, and adversarial-review rigor. Issue #34 records the observable outcome; this journal
records the implementation contract and the alternatives that were considered.

### Current invariants

- A `node_started` event is durable before its executor may run.
- Event publication is serialized per run, including write-ahead effect preparation and settlement.
- The reducer currently rejects a second running node, a control transition during execution, and a
  terminal run while any node remains running.
- Recovery currently finds at most one open attempt, reconciles its open typed edits, optionally
  archives one proof-safe interrupted agent attempt, and otherwise fails closed.
- A first `node_failed` currently requires immediate run terminalization and assumes it is the only
  failed node.
- Command approvals are single outstanding waits. Control nodes are pure, resource-neutral, and
  never enter an executor.
- Model-token, reported-cost, and active-duration budgets are settlement ceilings. One sequential
  result may exceed a remaining token or cost allowance because authoritative usage is learned only
  after settlement.

## Research findings

- Argo DAGs run independent ready tasks in parallel. Its default fail-fast behavior stops scheduling
  new tasks after a failure and waits for already-running tasks to complete before failing the DAG.
- Argo exposes workflow/template `parallelism` limits and separate semaphore or mutex controls.
- AWS Step Functions `Parallel` waits for every branch, but a failed branch can mark the state failed
  while external Lambda or activity work may continue unless that work cooperates with cancellation.
  This is a warning against declaring terminal failure before Flow-owned executors quiesce.
- Temporal requires deterministic workflow commands and records external activity facts in event
  history. Cancellation delivery is cooperative; activities must heartbeat or otherwise expose a
  cancellation boundary.
- Pi's agent loop can execute sibling tool calls concurrently, while its reference subagent example
  uses a fixed worker pool and stores results by input index. Those are useful inner-loop mechanics,
  not durable graph or restart semantics.
- OMP's task tool uses a session-scoped semaphore, registers jobs before execution, keeps each child
  independently inspectable, and aggregates a batch only after all jobs settle. Its state is designed
  for interactive subagents rather than a replay-authoritative workflow ledger.
- Prime Agent separates a daemon supervisor from one worker-owned root session tree. Child runtimes,
  transcripts, and artifacts remain independently addressable, but its process boundary is lifecycle
  isolation rather than a security sandbox.

## Specification

### Non-goals

- This slice does not add dynamic maps, bounded loops, child runs, recursive subgraphs, or arbitrary
  dependency expressions.
- It does not isolate concurrent branches into worktrees, VMs, containers, or child-run workspaces.
  Existing policy, SRT command containment, and target-local edit locks remain the safety boundaries.
- It does not add provider/model-specific request pools or coordinate node concurrency across
  separate Flow runs. Supervisor worker admission remains a separate outer capacity layer.
- It does not cancel siblings merely because one sibling fails. Admitted work is allowed to reach
  its existing timeout/cleanup boundary; no later work is admitted.
- It does not make real-time effect-event interleaving deterministic. Write-ahead effect evidence
  must be published before an edit commit and therefore records the order in which effects actually
  reach durable boundaries.
- It does not introduce multiple simultaneous command approval requests. The existing single
  outstanding exact-operation approval contract remains.
- It does not promise a prepaid token, cost, or aggregate active-time cap. A concurrent admitted
  wave can settle up to `maxNodes` observations after a settlement ceiling is crossed.

### Failure modes

- **Timeouts** — Each admitted node retains its own Flow-bounded timeout and adapter cleanup grace.
  The wave does not terminalize until every admitted executor settles or reaches that boundary.
- **Partial start persistence** — Starts are appended in deterministic order before any executor in
  the wave is invoked. A process or store failure after only a prefix is committed leaves those
  attempts open. Recovery treats them conservatively exactly like the existing crash window between
  one start event and executor invocation; it never assumes unrecorded work was harmless.
- **Partial outcome persistence** — Executors all settle before terminal outcomes are appended in
  declaration order. A publication failure can leave a prefix of outcomes. Replay accepts committed
  facts and treats remaining open attempts under ordinary reconciliation rules.
- **One sibling fails** — No new node, approval request, condition, omission, or join is admitted.
  Other already-running nodes settle. The run then records resource exhaustion when a settlement
  ceiling has priority, cancellation when an operator signal has priority, or one deterministic
  primary failure.
- **Several siblings fail** — Every failure remains on its node. The primary run failure is the
  first failed node in workflow declaration order, which is also the deterministic outcome-commit
  order for the wave.
- **Cancellation** — The shared run signal reaches every admitted executor. Successful results
  observed after cancellation become conservative abort failures with their evidence retained.
  Terminal cancellation lists the exact failed nodes and requires no running node to remain.
- **Open effects after interruption** — Recovery reconciles every open typed effect in workflow
  declaration order before considering any fresh retry disposition.
- **Mixed recovery eligibility** — Each open agent attempt is independently validated. Safe
  dispositions may be committed, but any remaining command, legacy writable attempt, applied or
  unknown effect, or incomplete resource observation keeps recovery fail-closed.
- **Invalid input** — Missing, empty, unknown, fractional, non-positive, or over-cap concurrency
  declarations fail compilation before run creation.
- **Missing context** — Omitted concurrency means exactly one running node. Legacy run-start events
  without concurrency replay with that same default.
- **Dependency forgery** — A concurrent run persists its complete bounded graph projection. The
  reducer rejects a start whose dependencies have not succeeded, whose guard was not selected, or
  whose node is a control node.
- **Capacity forgery** — The reducer rejects a start when the persisted number of running nodes has
  reached the persisted per-run limit, independent of the application scheduler.
- **Approval boundary** — A later ready command that needs a new approval becomes a barrier. Any
  earlier admitted wave settles before Flow requests that approval.
- **Control boundary** — Pure condition, omission, and join events never overlap executor activity.
  Declaration-order control transitions act as deterministic wave boundaries.
- **Concurrent edits** — Each branch receives an attempt-scoped effect journal. Global event
  publication stays serialized and same-target edits retain the shared target lock and hash anchor.
- **Settlement overshoot** — Token, cost, and aggregate duration observations from the whole admitted
  wave are preserved rather than clipped. The configured node concurrency bounds the number of
  results that can be in flight at the crossing.

### Interface contracts

An author may opt into concurrent node execution with a strict top-level declaration:

```yaml
concurrency:
  maxNodes: 4
```

`maxNodes` is an integer from 1 through 32. Omission is semantically equivalent to one but remains
omitted in the compiled contract so existing workflow digests and serialized representations do not
change. The exact optional declaration is persisted in `run_started`; run state exposes the
effective maximum.

When the effective maximum is greater than one, `run_started` also persists the complete ordered
workflow graph projection even if the workflow has no condition or join. This lets replay enforce
dependency and executable/control-node admission without reopening mutable workflow YAML.

At a safe boundary, the application repeatedly selects the same declaration-order next transition
used by recovery validation:

1. A pure control transition is committed alone.
2. A missing or expired command approval is handled alone.
3. An executable transition is started, then the selector is evaluated again against the new
   running state until capacity is full or the next transition is a control/approval barrier.
4. Only after every selected start is durable are the executors invoked concurrently.
5. The scheduler waits for every promise to settle and for the serialized effect-publication queue
   to drain.
6. Node outcomes are committed in the original admission/declaration order.
7. Only after the wave is quiescent may Flow terminalize or select the next transition.

The reducer permits at most the effective maximum running nodes. A first node failure closes
admission but permits terminal outcomes for nodes that were already running. `run_failed` requires
zero running nodes and names the first failed node in declaration order. New cancellation events use
an ordered `cancelledNodeIds` projection when several admitted nodes settle as failed; legacy
single-node `cancelledNodeId` events remain valid.

The executor port stays node-scoped. Pi receives no graph, sibling, join, or concurrency authority.

## User, operator, and system flows

### User: execute a static fork and join

1. A root node succeeds.
2. Two or more independent successors become ready.
3. Flow persists their starts in declaration order up to `maxNodes` and invokes them concurrently.
4. All admitted outcomes are recorded in declaration order.
5. The existing explicit join or ordinary dependency node becomes eligible only after its declared
   predecessors reach the required states.

### Operator: cancel an active wave

1. The operator cancellation reaches the shared abort signal.
2. Every admitted executor reaches its normal abort/cleanup boundary.
3. Flow retains any settled evidence, commits all node outcomes, and lists the affected failed nodes.
4. Only then does the run become durably cancelled.

### System: recover several open attempts

1. The new owner replays the exact compiled workflow, concurrency contract, graph, and open nodes.
2. It reconciles open typed edits for every running attempt in declaration order.
3. It validates and archives every independently proof-safe fresh-retry attempt.
4. Any unresolved attempt blocks resume; no later executor starts.
5. If none remain, one `run_resumed` marker reopens ordinary deterministic scheduling.

## Coupling analysis

```text
workflow YAML -> compiler -> optional concurrency contract
                         -> persisted ordered graph projection
                                      |
                                      v
JSONL event ledger <-> pure run reducer <-> application wave scheduler
        ^                                          |
        |                                          v
serialized effect publication <----------- node-scoped executors
```

- Workflow schema/compiler owns author-facing limits and immutable values.
- Run domain owns concurrent-start legality, multi-open state, quiescent failure/cancellation, and
  replay validation. It imports no Pi, filesystem, supervisor, or provider types.
- The application owns deterministic admission, promise lifecycle, outcome ordering, and recovery
  orchestration.
- The existing event store remains an append/claim/read/release port; no in-memory semaphore becomes
  authoritative.
- Command and Pi adapters retain node-scoped cancellation, cleanup, evidence, and effect contracts.
- Supervisor capacity continues to bound runs/workers; per-run node capacity is an independent inner
  scheduler limit.

## Approaches considered

| Approach | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Completion-order streaming | Lowest downstream latency; reflects real finish time | Outcome ordering and primary failure vary with timing; harder replay and tests | Rejected for authoritative outcomes |
| Deterministic quiescent waves | Stable starts/outcomes, bounded fan-out, no background leak, matches Argo fail-fast quiescence | Waits for the slowest admitted sibling; effect events still interleave | **Selected** |
| One durable child run per branch | Strong lifecycle/workspace isolation and typed aggregation | Child-run contracts and workspace isolation are not implemented yet | Deferred to the child-run slice |
| OMP-style background job registry | Proven semaphore-bound fan-out and independent inspection | Process/session-scoped delivery is not a replay-authoritative graph ledger | Reuse mechanics, not authority |
| Unbounded `Promise.all` over every ready node | Very small implementation | No resource bound, weak cancellation/recovery, amplifies provider and host pressure | Rejected |

## Decision

Add optional strict `concurrency.maxNodes` with an effective default of one and a maximum of 32.
Persist the declaration and, for concurrent workflows, the full ordered graph projection. Admit
executable nodes by repeatedly applying the existing declaration-order transition selector until a
control/approval barrier or capacity boundary. Invoke the admitted nodes concurrently, quiesce the
entire wave, drain effect publication, and commit terminal node outcomes in admission order.

Generalize the reducer and recovery path from one open attempt to an ordered set. After the first
failure, allow only already-running siblings to settle, then choose the declaration-order first
failure unless cancellation or settlement exhaustion has terminal precedence. Preserve the current
single-approval and pure-control boundaries.

The production command adapter additionally coordinates SRT as one reference-counted same-policy
session. The pinned backend supports concurrent wraps and defers Linux mount-point cleanup while
its internal active-sandbox count is non-zero. Flow initializes once, supplies each wrap with a
distinct private temporary directory and complete per-exec filesystem configuration, rejects a
different concurrent workspace or policy, and resets only after the final release.

## Adversarial review findings and resolutions

1. **P1 — production command concurrency rejected by Flow's SRT adapter.** The scheduler overlapped
   test executors, but `SrtCommandSandbox` permitted only one active preparation. Replaced the
   adapter-local boolean with a serialized, reference-counted same-policy session and added a real
   CLI test whose two SRT-contained commands must observe each other's markers to succeed.
2. **P1 — partial outcome persistence could deadlock recovery after a sibling failure.** A durable
   first failure closed the reducer to the recovery events needed by a still-open proof-safe
   sibling. The reducer now permits only typed reconciliation and interruption dispositions in
   addition to already-running outcomes and terminalization; a crash-window regression proves the
   original failure terminalizes without rerunning its sibling.
3. **P2 — capacity test had a second rejection reason.** Its overflow node also had unsatisfied
   dependencies. Replaced it with a third independently ready sibling and mutation-tested the exact
   capacity comparison.
4. **P2 — scheduler overlap test could not prove deferral.** It had only two ready nodes at a limit
   of two. Added a three-way fork that proves the third remains uninvoked until the full first wave
   quiesces.
5. **P1 — final-start exhaustion could mask a concurrent failure.** When the last permitted starts
   admitted a wave whose first node failed while later nodes remained pending, the scheduler tried
   to emit `run_budget_exhausted`; the reducer correctly rejected that contradictory terminal event.
   Pending node-start exhaustion now applies only when no failure is already durable, and a
   three-way-fork regression proves the declaration-first failure terminalizes the run.

Targeted mutations were killed for capacity, outcome order, recovery order, and cancellation
projection. The production CLI smoke and automated mutually-waiting integration both proved two
real SRT-contained branch commands can overlap and still produce declaration-ordered outcomes.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict optional limit and legacy default | Contract | `npx vitest run test/unit/workflow/compiler.test.ts -t "concurrency"` | Valid 1–32 values compile; invalid/unknown values reject; omission preserves legacy compiled output | Provider-specific quotas |
| Reducer capacity and dependency proof | Contract/adversarial | `npx vitest run test/unit/run/concurrency-reducer.test.ts -t "start|capacity|dependency"` | Starts up to the persisted limit replay; overflow and forged prerequisites reject | Distributed scheduling |
| Actual bounded overlap | Behavioral | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts -t "overlap|limit"` | Controllable executors observe overlap and never exceed the configured maximum | CPU parallelism guarantees |
| Stable admission/outcome ordering | Determinism | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts -t "completion timing|declaration order"` | Reversed sibling completion timing produces the same start and outcome node ordering | Deterministic effect interleaving |
| Dependency and control barriers | Graph | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts -t "dependency|control|join|approval"` | Dependents, conditions, joins, and new approvals wait for quiescence and legal prerequisites | Dynamic maps or expressions |
| Failure quiescence | Failure | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts test/unit/run/concurrency-reducer.test.ts -t "failure|quiesce"` | No new admission follows failure; all admitted outcomes persist; primary failure is stable | Immediate sibling termination |
| Multi-node cancellation | Cancellation | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts test/unit/run/concurrency-reducer.test.ts -t "cancel"` | Every admitted executor settles, evidence remains, exact failed-node projection replays | Cancellation of non-cooperative external services |
| Multi-open recovery | Recovery | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts test/unit/application/run-workflow-reconciliation.test.ts test/unit/application/run-workflow-retry.test.ts -t "concurrent|multiple open"` | Effects reconcile and proof-safe attempts archive in declaration order; any unsafe attempt blocks | Retrying commands or unknown effects |
| Effects and budgets remain authoritative | Evidence/resources | `npx vitest run test/unit/application/run-workflow-concurrency.test.ts test/unit/application/run-workflow-budget.test.ts test/unit/application/run-workflow-effect-journal.test.ts -t "concurrent|wave|final node starts"` | Effect events serialize, same-target safety remains, complete wave usage is retained, final-start failure is not masked, and no later wave starts after exhaustion | Prepaid zero-overshoot billing |
| Public example and claims | Docs/runtime | `npx vitest run test/scaffold/community-files.test.ts test/integration/cli/main.test.ts -t "concurrent"` | README/spec/architecture/recovery/roadmap/testing and example agree with executable behavior | Remaining Gate 5 features |
| Complete package | Regression/release | `npm run check` | Formatting, lint, strict types, default tests, build, and compiled runtime tests pass | Live provider availability |
| Coverage/package/security | Release | `npm run test:coverage`; `npm run pack:check`; `npm audit --omit=dev --audit-level=low`; `actionlint .github/workflows/ci.yml` | Thresholds, clean install, production dependencies, and workflow syntax pass | Hosted-service availability |

## Planned RED → GREEN → REFACTOR sequence

1. **Compiler RED** — Add valid/invalid concurrency contract tests and prove the current strict schema
   rejects the field.
2. **Compiler GREEN/REFACTOR** — Add immutable optional source/compiled contracts, effective-limit
   helpers, and concurrent graph persistence without changing legacy compiled snapshots.
3. **Reducer RED** — Add capacity, dependency, several-running, several-failed, quiescent terminal,
   and plural cancellation replay tests.
4. **Reducer GREEN/REFACTOR** — Generalize the running-node and failed-node invariants while keeping
   terminal events impossible before quiescence.
5. **Scheduler RED** — Add controlled-promise overlap, cap, declaration-order outcome, dependency,
   approval/control barrier, failure, cancellation, budget, and effect-publication tests.
6. **Scheduler GREEN/REFACTOR** — Extract deterministic admission and node-attempt execution without
   leaking graph authority into executors.
7. **Recovery RED** — Add multiple-open reconciliation, mixed eligibility, repeated resume, and
   tampered-history tests.
8. **Recovery GREEN/REFACTOR** — Iterate ordered open attempts, reconcile all effects before retry
   dispositions, and require one final resume marker.
9. **Composition/docs RED/GREEN** — Add a credential-free example and public-contract tests, then
   update every capability and limitation surface.
10. **VERIFY** — Run focused tests after each layer, full local CI, coverage, runtime smoke, package
    installation, audit, mutation probes, and adversarial diff review.

## Primary references

- Argo DAG and fail-fast behavior: <https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/>
- Argo workflow parallelism and synchronization:
  <https://argo-workflows.readthedocs.io/en/latest/synchronization/>
- AWS Step Functions Parallel state:
  <https://docs.aws.amazon.com/step-functions/latest/dg/state-parallel.html>
- Temporal deterministic workflow constraints: <https://docs.temporal.io/workflow-definition>
- Temporal TypeScript cancellation:
  <https://docs.temporal.io/develop/typescript/workflows/cancellation>
- Pi agent-loop parallel tool execution:
  <https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts>
- Installed Pi 0.84.0 subagent concurrency example:
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`
- OMP task fan-out, semaphore, job, and cancellation behavior:
  <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md>
- Prime Agent architecture:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
- Prime Agent long-running worker and child lifecycle:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md>
- Pinned SRT manager API and concurrent Linux cleanup:
  `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js` and
  `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js`

## Implementation tasks

1. [x] Compile and persist the strict optional concurrency contract.
2. [x] Enforce concurrent admission and quiescent terminal invariants in replay.
3. [x] Execute deterministic bounded waves and preserve approval/control boundaries.
4. [x] Reconcile and dispose multiple interrupted attempts safely.
5. [x] Preserve evidence, effects, budgets, cancellation, and goal semantics under overlap.
6. [x] Add the public example and update all capability/limitation documentation.
7. [x] Run full runtime, package, coverage, audit, and adversarial verification.

## Verification evidence

- `npm test` outside the restricted host sandbox: **55 files, 724 tests passed**. The restricted
  run failed only where that outer sandbox forbids Unix-socket listeners and SRT's native boundary.
- `npm run build`, strict type checking, lint, exact-scope formatting, and `git diff --check`:
  **passed**.
- `npm run test:coverage`: **83.78% statements, 76.61% branches, 92.49% functions, 83.96% lines**.
- `npm run pack:check`: clean tarball installation and production CLI execution **passed**.
- `npm audit --omit=dev --audit-level=low`: **0 vulnerabilities**; `actionlint`: **passed**.
- Compiled runtime isolation: **5/5** durable-effect crash windows and **2/2** command-sandbox
  boundary cases passed.
- Compiled CLI runtime isolation: **13/13** process cases passed across permission loss, forced
  shutdown, uncooperative providers, startup reaping, SIGINT, claim exclusion, durable approval,
  detached replay, supervisor coalescing, capacity/rebinding, cancellation, and worker adoption.
  The aggregate runtime invocation terminates its parent command session while exercising signals,
  so each scenario was rerun in isolated Vitest processes to retain an observable result.
- Targeted mutations for admission capacity, outcome ordering, recovery ordering, and cancellation
  projection were killed. A production mutually-waiting SRT integration proves real command
  overlap rather than simulated executor overlap.
