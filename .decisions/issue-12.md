# Decision Journal: Issue #12 — Resume interrupted runs without repeating uncertain work

**Issue**: #12 | **Branch**: `codex/issue-12-safe-resume` | **Started**: 2026-08-07

---

## Context

Flow already persists an append-only, replayable run ledger before advancing the scheduler. A new
process can inspect that ledger but cannot acquire it for continued execution. Gate 4 requires the
first recovery slice to continue only from a committed node boundary and to refuse any operation
whose outcome is uncertain.

Pi's persisted sessions can restore model conversation state, but a transcript does not determine
Flow graph position or side-effect certainty. Prime Agent provides the relevant harness pattern:
one process-safe lease per canonical session path, durable state as the recovery baseline, and no
automatic replay for a mutation that lacks a durable result. Flow adopts those semantics around its
own workflow ledger without importing Prime's daemon, protocol, or session types.

## Specification

_Captured by specification-capture skill on 2026-08-07. Source: extracted-from-issue._

### Non-goals

- Reconciliation or retry of an operation that was open when the process stopped.
- Detached workers, a daemon, client reattachment, snapshots, or multi-host scheduling.
- Retry policies, budgets, approvals, or human wait states.
- Exactly-once behavior for arbitrary external side effects.
- Mid-node restoration of Pi model sessions or transcripts.

### Failure modes

- **Timeouts** — A resumed pending node retains its declared timeout. Recovery adds no hidden retry,
  grace period, or deadline extension.
- **Partial failures** — A durable `node_started` without a matching outcome is uncertain. Recovery
  identifies its node and attempt, records nothing, and executes nothing.
- **Invalid input** — Invalid run identifiers and incompatible workflow definitions fail before a
  recovery marker, node execution, or ledger repair.
- **Missing context** — Missing or corrupt state returns the existing bounded store error and does
  not create replacement state.
- **Dependency outage** — A node first executed after recovery uses the existing fail-closed node
  failure semantics. Recovery does not retry it implicitly.
- **Resource exhaustion** — Existing event-size, output, and schema bounds remain authoritative.
- **Concurrent ownership** — At most one live process owns execution for a run. A competing process
  receives a stable active-owner blocker without changing the ledger.
- **Stale ownership** — An owner from a process that no longer exists can be replaced atomically.
  Ambiguous or corrupt ownership metadata fails closed.
- **Torn append** — Only a final unterminated record is ignored. It is truncated before the next
  committed append; earlier records are never rewritten.

### Interface contracts

- Public CLI: `flow resume <workflow.yaml> --run-id <id> [--runs-dir <path>] [--cwd <path>]`.
- Successful recovery prints the same JSON `RunState` shape as `run`; a non-success terminal state
  uses the same exit-code rule as `run`.
- Application recovery requires a compiled workflow, explicit run id, recoverable event store,
  executor, working directory, protected paths, optional clock, and optional abort signal.
- A recoverable store can atomically claim an existing run, return its committed events, append only
  while owned, and release ownership idempotently.
- The ledger records a versioned `run_resumed` event before any new node start. Replay changes only
  sequence/time metadata for this event; graph, goal, and node outcomes remain unchanged.
- Recovery errors expose stable machine codes for terminal state, workflow mismatch, and uncertain
  operation. Filesystem ownership and state errors remain `RunStoreError` values.
- `inspect` remains replay-only and never claims execution ownership.

## Flow map

### User flow: safe recovery

1. The operator supplies an interrupted run id and the workflow definition.
2. Flow compiles the workflow before acquiring or mutating the run.
3. The store atomically acquires exclusive execution ownership and replays committed events.
4. Flow verifies workflow identity and confirms no node attempt remains open.
5. Flow appends `run_resumed`, skips successful nodes, and executes the next graph-ready pending node.
6. The normal scheduler and evaluator produce a terminal `RunState`; ownership is released.

### User flow: unsafe recovery

1. The operator requests recovery of a missing, terminal, mismatched, corrupt, active, or uncertain
   run.
2. Flow returns a precise bounded blocker.
3. No recovery marker, node event, or effect is created; any ownership acquired by this process is
   released.

### Operator flow: inspect before or after recovery

1. The operator runs `flow inspect <run-id>`.
2. Flow replays committed events without acquiring the execution lease.
3. The result is identical to reducing the ledger directly.

### System flow: stale-owner recovery

1. A process stops without releasing its published ownership record.
2. A later claimant verifies that the recorded process no longer exists.
3. The claimant atomically moves the stale owner record aside and competes to publish a new one.
4. Exactly one claimant wins; losing claimants fail as active-owner conflicts.

## Coupling analysis

- The domain event reducer owns whether `run_resumed` is legal; it imports no filesystem or executor
  types.
- The application service owns workflow compatibility, safe-boundary selection, and graph
  continuation; it depends only on domain contracts and a recovery-capable store port.
- The JSONL adapter owns process-safe filesystem acquisition, committed-byte repair, and durable
  ownership metadata. No filesystem type enters persisted run events or public workflow schemas.
- The CLI composes the same executor and store used by `run`; it adds no recovery semantics.
- Pi is not involved in acquisition or replay. If a pending agent node is first executed after
  recovery, the existing Pi adapter receives a fresh bounded node attempt.

## Options considered

| Option | Advantages | Costs and risks | Disposition |
| --- | --- | --- | --- |
| Replay then append without ownership | Smallest code change | Two processes can repeat a node or interleave events | Rejected |
| Process-safe filesystem ownership plus authoritative replay | Fits the local JSONL architecture; testable; no daemon required | Requires stale-owner handling and explicit release | Chosen |
| Build the supervisor/daemon first | Strong long-running ownership and client detachment | Bundles most of Gate 4 and delays the safe vertical slice | Deferred |
| Convert open attempts to failed and retry | Appears automatic | Invents an outcome and can repeat committed side effects | Rejected |

## Decision

Implement explicit in-process recovery using a canonical per-run filesystem ownership record. Every
fresh or recovered execution owns the run while it may append. Existing state is replayed before an
auditable `run_resumed` event. Recovery proceeds only when every non-pending node has a committed
outcome; an open attempt is surfaced as uncertain and never replayed.

The ownership record is published atomically only after complete owner metadata is durable. It
contains a random token and process id. A live process id blocks competitors. A dead owner can be
atomically renamed aside before claim; process-id reuse may conservatively block recovery but cannot
permit two owners. Corrupt or ambiguous metadata fails closed.

## Consequences

- Flow gains useful crash recovery at committed node boundaries without claiming full Gate 4.
- The ledger exposes restart boundaries to inspection and future supervisors.
- Filesystem recovery remains local-host coordination, not a security sandbox or distributed lease.
- Open operations require a later reconciliation design before retry can be enabled.
- A future daemon can implement the same recovery-capable store/application contract while replacing
  the local process-liveness mechanism.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Safe interrupted run reaches the equivalent terminal outcome | Behavioral | `npx vitest run test/unit/application/run-workflow.test.ts -t "resumes"` | Recovered and uninterrupted states agree; recovery marker precedes new work | Mid-node restoration |
| Successful nodes are not repeated | Behavioral | `npx vitest run test/unit/application/run-workflow.test.ts -t "does not re-execute"` | Executor calls include only pending nodes | Retry policy |
| Open operation is refused without an effect | Error handling | `npx vitest run test/unit/application/run-workflow.test.ts -t "uncertain open attempt"` | Stable error names node/attempt; executor and appended events remain empty | Reconciliation |
| Invalid, terminal, incompatible, corrupt, or active runs do not mutate | Error handling | `npx vitest run test/unit/application/run-workflow.test.ts test/integration/fs/jsonl-run-store.test.ts -t "recovery|claim|resume"` | Each invalid case rejects; before/after committed ledger is equal | Distributed coordination |
| Torn tail is repaired without changing committed events | Data processing | `npx vitest run test/integration/fs/jsonl-run-store.test.ts -t "torn tail.*claim"` | Committed prefix is unchanged and new event follows it | Repair of interior corruption |
| CLI and documentation expose the bounded recovery flow | Contract | `npx vitest run test/cli/main.test.ts test/integration/cli/main.test.ts -t "resume"` | Help, CLI success/refusal, and replay output match the documented contract | Daemon or detach support |

## Implementation tasks

1. Add domain recovery-event legality and replay tests.
2. Add process-safe JSONL execution ownership and torn-tail recovery tests.
3. Add application recovery tests for safe continuation and fail-closed refusals.
4. Implement the recovery-capable store and scheduler path behind Flow-owned ports.
5. Add the CLI command, runtime behavior, and public documentation.
6. Run full static, coverage, build, runtime, package, clean-consumer, and adversarial review gates.

## Research references

- Pi SDK session persistence: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- Prime Agent daemon ownership and recovery: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- Prime Agent connection replay model: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/agent-connection.md>
