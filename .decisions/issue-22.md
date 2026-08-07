# Decision Journal: Issue #22 — Durable detached supervision

**Issue**: #22 | **Branch**: `codex/issue-22-detached-supervisor` | **Started**: 2026-08-07

---

## Context

Flow currently runs the deterministic scheduler, node executor, and event store in the invoking CLI
process. The run ledger survives that process, and approval waits are safe detach points, but active
work ends when its foreground client exits. A standalone harness needs a process boundary that owns
long-running worker health and client reconnection without becoming a second graph authority.

The existing boundaries constrain the design:

- `runWorkflow` and `resumeWorkflow` are the only graph-transition authorities.
- `JsonlRunStore` is the authoritative state store and already provides exclusive same-host run
  ownership plus stale-owner recovery.
- Pi is an inner node runtime behind `AgentExecutor`; command nodes, approvals, goal evaluation,
  budgets, and recovery do not belong to Pi.
- A node can be externally affected. If a process disappears with an open attempt, Flow must retain
  the current `uncertain_operation` refusal instead of silently replaying it.

Prime Agent demonstrates the closest proven process model: clients own presentation, a local
supervisor owns discovery/routing/worker health, and isolated workers own root runtime execution.
Its daemon also uses versioned local protocols, stable command identifiers, worker identity tokens,
generation fencing, durable journals, and fail-closed handling of uncertain mutations. Pi provides
both an in-process TypeScript SDK and a JSONL RPC mode, but its own documentation recommends the SDK
for Node.js consumers. OMP provides background jobs and cancellable task/tool execution; it does not
provide a reusable whole-harness supervisor that owns Flow graph state.

## Specification

_Captured from issue #22 and architecture analysis on 2026-08-07._

### Non-goals

- Multi-host scheduling, remote TCP control, public API authentication, or distributed consensus.
- Retrying or reconciling an arbitrary open command, model turn, or external side effect.
- Replacing the Flow event ledger with supervisor metadata, provider transcripts, or Pi sessions.
- A TUI, scheduled triggers, child-run graphs, graph loops, or general workflow concurrency.
- Treating Unix-socket permissions, process identity, or same-user tokens as a sandbox.
- Migrating the embedded Pi adapter to Pi RPC merely because a worker is now a separate process.
- Sending provider credentials, environment contents, prompts, or command output through status
  responses unless those values are already part of a requested bounded Flow event.
- Automatically restarting a worker whose last effect boundary is uncertain.

### Failure modes

- **Client exits after acceptance** — The worker continues in a detached process group. Its standard
  streams do not refer to the client terminal, and the authoritative ledger remains readable.
- **Client disconnects before acceptance** — The caller reuses its command id. A committed result is
  returned, a known uncommitted command is rejected as uncertain, and the supervisor never blindly
  submits the mutation twice.
- **Supervisor exits** — Detached workers continue. The next supervisor generation discovers worker
  descriptors and authenticates each live worker before adopting it. It never kills a PID based only
  on an unverified descriptor.
- **Worker exits before a terminal run event** — The supervisor reports the worker exit and the
  ledger remains authoritative. A later resume retains the existing open-attempt uncertainty rule.
- **Stale PID or descriptor** — PID liveness alone is insufficient because operating systems reuse
  process identifiers. Control requires a successful worker-id and random-token handshake over the
  descriptor's private endpoint.
- **Duplicate run submission** — A durable per-run active claim is established before spawn. Another
  submission returns the established invocation or a durably journaled deterministic conflict and
  starts no worker. The rejected command remains rejected after the established claim is released.
- **Submission acknowledgement loss** — The exact request digest is journaled before reservation.
  Accepted and rejected outcomes replay directly; an uncertain launch is reconciled only from the
  matching job and authenticated worker descriptor and never spawns a replacement implicitly.
- **Job snapshot exists without claim or worker** — Absence cannot distinguish a crash before claim
  from a failed rejection-journal write. The command becomes uncertain and no worker is launched.
- **Concurrent supervisor auto-start** — An owner-only startup record serializes stale-socket
  cleanup and generation launch. Other clients attach to the winner; a live or PID-reused holder
  blocks replacement conservatively.
- **Cancellation race** — A terminal run wins a later cancellation. Cancellation during a node
  preserves returned evidence, commits the node outcome, and ends as `cancelled`, except that durable
  resource exhaustion still has the higher terminal precedence already defined by the scheduler.
- **Cancellation acknowledgement loss** — Stable command ids and durable command results make a
  repeat idempotent. An uncertain dispatch is surfaced rather than replayed automatically.
- **Malformed or hostile protocol input** — Unsupported versions, unknown fields, invalid ids,
  invalid paths, oversized frames, multiple frames per request, and invalid UTF-8/JSON are rejected
  before mutation. A connection is bounded in bytes and time.
- **Slow event consumer** — Replay is page-based from an exclusive sequence cursor. The server does
  not retain an unbounded per-client queue; a follower requests the next bounded page.
- **Torn metadata write** — Metadata and command results use owner-only temporary files, fsync, and
  atomic rename. Invalid metadata is quarantined diagnostically and never inferred as authority.
- **Untrusted local peer** — The control directory is mode 0700 and files are mode 0600. Worker
  mutations additionally require a random token. These controls coordinate processes of one OS user
  and do not defend against that same user or a privileged process.
- **Shutdown with active workers** — Normal supervisor shutdown refuses while workers are active.
  Forced shutdown is not part of this slice; cancellation is per run and attributable.
- **Unsupported platform** — Detached supervision remains limited to the package's declared Linux
  and macOS support. No Windows named-pipe or process-tree contract is implied.

### Interface contracts

- Foreground `flow run` and `flow resume` keep their current behavior. Adding `--detach` submits the
  exact workflow source, normalized execution directory, run id, and mode to a local supervisor and
  returns only after the job and active-run claim are durable and a worker has authenticated.
- A run without `--run-id` receives its run id in the client before submission so retries reuse the
  same identity. Resume still requires an explicit run id.
- `flow supervisor status` reports the current generation and bounded worker summaries without
  constructing an executor or contacting a provider. `flow supervisor shutdown` succeeds only when
  no worker is active.
- `flow cancel <run-id> --actor <label>` is an idempotent mutating command. It aborts only an
  authenticated active worker and returns the resulting authoritative run state.
- `flow events <run-id> [--after <sequence>] [--follow]` returns events strictly after the supplied
  cursor. Pages are ordered, bounded, gap-free, and duplicate-free; follow mode advances only from
  the last validated sequence and stops on terminal state.
- Client-supervisor and supervisor-worker messages are strict, versioned JSONL envelopes with a
  stable command/request id, one request per connection, bounded UTF-8 bytes, and structured error
  codes. Every response echoes its request id.
- Durable supervisor state lives under `<runs-dir>/.supervisor`, a path already protected from
  command nodes. Unix sockets cannot safely live there because macOS limits socket-path length and
  a valid run directory may already be too deep. Ephemeral endpoints therefore live in a short
  `/tmp/flow-harness-<uid>` directory that must be a non-symlink directory owned by the invoking user
  with mode 0700. A hash of the canonical run directory prevents cross-project collisions. Durable
  descriptors bind those endpoints to their run directory, generation, and worker identities.
- A durable job snapshot contains the exact submitted workflow source rather than a mutable source
  path. The worker recompiles that snapshot before acquiring run ownership; compilation failure
  therefore creates no run ledger or external effect.
- Each worker owns one `runWorkflow` or `resumeWorkflow` call and its store instance. The supervisor
  never appends graph events, acquires run ownership, invokes providers, or executes tools.
- Detached workers have independent process groups and non-inherited standard streams. A worker
  owns a private control socket and descriptor containing its worker id, run id, PID, random token,
  job digest, and lifecycle status.
- A replacement supervisor receives a new generation, scans durable active claims, and adopts only
  workers whose socket handshake proves the descriptor identity. Unknown or mismatched live
  processes are reported and never signalled.
- The Flow ledger is event-replay authority. Supervisor event APIs read and validate committed
  ledger records and expose an exclusive sequence cursor; worker/supervisor status cannot override a
  terminal or waiting ledger state.

## User and system flows

### Start detached work

1. The client normalizes paths, reads the workflow, assigns a stable run and command id, and connects
   to the supervisor for the selected run directory.
2. If no healthy supervisor exists, the client starts one detached and waits for an authenticated,
   version-compatible descriptor and socket.
3. The supervisor validates and compiles the exact submitted source before mutation.
4. It journals the exact request digest, then durably records the immutable job snapshot and
   per-run active claim before starting one detached worker with non-inherited streams. Reservation
   conflict, authenticated acceptance, and uncertain launch are monotonic journal outcomes.
5. The worker publishes `running`; the supervisor authenticates its descriptor and control endpoint;
   and the worker waits for the identity response to flush before executing. Only then does the
   supervisor acknowledge acceptance to the client.
6. The worker owns the existing scheduler and JSONL store until a terminal or durable wait state.

### Observe and replay

1. A later client discovers the current supervisor generation and requests health or a run cursor.
2. The supervisor validates committed events through the normal run-event parser.
3. It returns a bounded page strictly after the requested sequence plus the current terminal flag.
4. A follower repeats from the last received sequence; reconnecting from that cursor neither skips
   nor duplicates an event.

### Cancel

1. The client supplies a stable command id, run id, actor, and bounded reason.
2. The supervisor durably journals the request and finds the active run claim.
3. It authenticates the worker over the worker-owned control socket before dispatch.
4. The worker aborts the active executor, preserves available evidence, and lets the scheduler append
   the node outcome and terminal cancellation.
5. The authoritative state is returned and journaled. Repeating the command returns the same result.

### Recover the control plane

1. A replacement supervisor atomically establishes a new generation.
2. It scans active claims, job records, and worker descriptors without touching run ownership.
3. Each live descriptor must answer a token-bound identity handshake. Valid workers are adopted;
   dead workers are classified from the ledger; mismatches remain visible and untouched.
4. No uncertain submit, cancellation, or open node attempt is automatically replayed.

## Coupling analysis

- The run domain gains only the minimum cancellation attribution needed for a truthful terminal
  state; it imports no process, socket, CLI, or supervisor types.
- The scheduler retains cancellation and terminal-precedence decisions. The worker merely supplies
  an abort signal carrying bounded operator attribution.
- A supervisor protocol module owns strict wire schemas and framing but imports no Pi types.
- A local supervisor application service owns idempotency, active-run claims, event paging, and
  worker lifecycle through filesystem/process ports.
- Filesystem/socket/process adapters implement those ports under infrastructure. Their metadata is
  reconstructible and subordinate to the event ledger.
- The CLI is a client and composition root. It does not become a daemon scheduler and does not read
  provider state for status.
- The existing Pi executor remains in-process inside each worker. Pi RPC remains a future adapter
  option for non-TypeScript runtimes or an additional inner isolation boundary.

## Options considered

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Flow local supervisor plus one detached worker per active run | Fits the target harness, isolates run failures, supports adoption, bounded event replay, future concurrency/child runs/TUI, preserves scheduler authority | Largest initial protocol and lifecycle surface; requires careful identity and crash semantics | **Chosen** |
| One detached worker per CLI request with files and Unix signals | Small vertical slice; no resident daemon | No durable idempotent command plane, weak PID-reuse defense, no natural global concurrency/discovery/event backpressure, likely replacement work | Rejected as the product architecture |
| Use Pi RPC as Flow's supervisor | Existing JSONL events and abort command; language-agnostic inner runtime | Supervises only Pi sessions, not command nodes, Flow graphs, approvals, ledgers, budgets, or recovery; duplicates current typed SDK boundary | Retain as an optional future agent adapter |
| External service manager such as launchd/systemd/container runtime | Mature restart and logging policy | Platform-specific installation and permissions, no Flow command journal/event cursor/run identity, poor library/package UX | Possible deployment adapter, not the core |
| One daemon process executes all runs directly | Simple routing and shared limits | One leaked provider handle or crash affects all runs; daemon would accumulate mutable scheduler/provider state and complicate safe restart | Rejected |

## Decision

Build a Flow-owned, auto-started local supervisor with a versioned request/response protocol and one
detached worker process per active run invocation. Keep the worker as the exclusive owner of the
existing scheduler, executor, and run store. Keep Pi embedded inside the worker through the current
typed adapter.

Use private Unix-domain sockets in a short, owner-validated temporary directory rather than TCP or
arbitrarily deep paths under the run directory. Use a supervisor generation and per-worker random
identity token in addition to PID liveness. Make mutating requests idempotent through stable command
ids and durable request/result journals. Paginate event replay from exclusive sequence cursors
instead of retaining per-client streaming queues.

Implement the complete credential-free command-node path first while preserving the same worker
composition for agent nodes. No model-specific test double becomes production behavior; tests use
real command processes and the existing dependency injection only at unit boundaries.

## Consequences

- Flow becomes a real long-running harness control plane rather than a foreground CLI wrapper.
- The supervisor can later enforce active-run concurrency, schedules, child-run routing, and TUI
  attachment without moving graph decisions out of the worker.
- Event state and supervisor health remain intentionally separate: a live worker can own a running
  ledger, while a dead worker with an open attempt is visibly uncertain rather than retried.
- Local metadata contains workflow prompts and process-control tokens, so owner-only permissions and
  cleanup/retention behavior are part of the security contract.
- Unix sockets keep this slice aligned with declared Linux/macOS support; a future Windows port needs
  a named-pipe adapter and equivalent ACL/process-tree tests.
- Ephemeral socket files are reconstructible and may disappear across reboot; durable descriptors
  and ledgers must classify that state rather than assuming an endpoint is still live.
- The initial protocol is local and versioned from day one, preventing the TUI or future clients from
  depending on private in-memory objects.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict versioned bounded protocol | Contract/error | `npx vitest run test/unit/supervisor/protocol.test.ts` | Valid envelopes round-trip; unknown, malformed, oversized, duplicate-frame, and incompatible messages fail before handlers | Remote API compatibility |
| Owner-only durable metadata and atomic claims | Security/data | `npx vitest run test/integration/fs/local-supervisor-store.test.ts` | 0700 root, 0600 files, atomic command/job/run claims, torn/corrupt records fail closed | Defense from same user/root |
| Foreground commands remain compatible | Compatibility | `npx vitest run test/integration/cli/main.test.ts test/runtime/cli-process.runtime.test.ts -t "foreground|run|resume|approval"` | Existing run/resume/approval/inspect behavior and exits remain intact | Stable pre-1.0 CLI forever |
| Detached client exit does not stop work | Runtime/lifecycle | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "runs detached work"` | CLI returns after authenticated worker readiness; real command completes later with terminal ledger | Host reboot survival |
| Duplicate submit and auto-start converge | Concurrency/idempotency | `npx vitest run test/integration/supervisor/service.test.ts -t "deduplicates|concurrent" && npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "coalesces concurrent supervisor"` | Exact concurrent requests coalesce, changed input conflicts, and fresh clients see one generation | Distributed exactly-once effects |
| New client health and status | API | `npx vitest run test/integration/supervisor/service.test.ts -t "health"` | Bounded generation and worker summaries require no executor/provider/store ownership | Provider health |
| Gap-free cursor replay and follow | Data/backpressure | `npx vitest run test/integration/supervisor/service.test.ts -t "cursor"` | Pages are ordered, exclusive, bounded, and reconnect without skips/duplicates | Infinite retention |
| Attributable idempotent cancellation | Lifecycle/security | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "cancels a detached"` | Real process tree ends; evidence is retained; terminal status is cancelled; repeated command returns same state | Reversal of committed effects |
| Supervisor restart adopts live worker | Recovery/identity | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "adopts a live worker"` | Worker survives supervisor exit; replacement authenticates it; stale/mismatched PID is never signalled | Automatic uncertain replay |
| Idle shutdown is safe | Lifecycle | `npx vitest run test/integration/supervisor/daemon.test.ts -t "shutdown"` | Idle supervisor exits cleanly; active-worker shutdown is refused | Forced fleet termination |
| Public claims remain accurate | Documentation | `npx vitest run test/scaffold/community-files.test.ts` | README, architecture, recovery, security, testing, and roadmap distinguish current/deferred behavior | TUI, schedules, loops, multi-host |
| Complete package remains releasable | Regression | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Local CI, coverage, compiled runtime, packaged binary, clean install, and audit pass | Live provider availability |

## Implementation tasks

1. [x] Define strict supervisor/client/worker wire contracts, error taxonomy, and bounded framing.
2. [x] Add owner-only atomic supervisor metadata, command journal, immutable job snapshots, and
   per-run active claims.
3. [x] Add auto-start/discovery, supervisor generations, health/status, and idle-safe shutdown.
4. [x] Add one detached worker per run/resume invocation with authenticated worker control.
5. [x] Add durable cancellation attribution and correct mid-node cancelled terminal semantics.
6. [x] Add sequence-cursor event replay and bounded follow behavior.
7. [x] Add supervisor restart/adoption and stale/mismatched identity handling.
8. [x] Expose detached run/resume, cancel, events, and supervisor commands in the CLI.
9. [x] Update all public architecture, recovery, security, roadmap, testing, and usage claims.
10. [x] Run local CI, coverage, runtime, package, clean-consumer, audit, and adversarial review.

## Verification results

_Recorded on 2026-08-07._

- `npm run check`: formatting, lint, strict type checking, 386 default tests, production build, and
  the compiled runtime phase passed. The runtime phase was also rerun independently for an
  unambiguous result: 2 files and 11 tests passed.
- `npm run test:coverage`: 386 tests passed with 81.62% statement, 72.99% branch, 89.3% function,
  and 81.9% line coverage.
- `npm run pack:check`: the package dry-run contained the CLI, supervisor modules, public docs,
  examples, license, security policy, support policy, and third-party notices.
- `npm audit --omit=dev --audit-level=low`: zero production dependency vulnerabilities.
- Clean consumer: the tarball installed with scripts disabled into an empty temporary npm project;
  its packaged `flow --help` ran and its packaged foundation workflow validated successfully.
- `git diff --check`: no whitespace errors.

## Adversarial findings and dispositions

| Finding | Severity | Disposition |
| --- | --- | --- |
| Public mutation retries could not reuse the internally generated command id after losing a response | P1 | Added optional validated `--command-id` to detached run/resume and cancellation; documented caller persistence |
| Concurrent same-id submissions with different inputs shared the first in-memory promise | P1 | Compare the complete request before coalescing; added concurrent conflict coverage |
| A conflicting run reservation left an unclassified job snapshot, so a later exact retry could change from conflict to uncertainty after the original claim disappeared | P1 | Journal submission identity before reservation and persist accepted, rejected, or uncertain outcomes; exact rejected retries remain conflicts, lost launch acknowledgement reconciles without respawn, and claimless snapshots fail closed |
| A lost worker cancellation response left the journal replayable as merely recorded | P1 | Persist `uncertain` before returning and reconcile only from authoritative ledger evidence; added no-redispatch coverage |
| Concurrent fresh clients could race stale-socket removal and daemon launch | P1 | Added an owner-only durable startup record and a six-client compiled convergence test |
| Adoption acknowledgement could precede durable worker readiness, leaving an immediate-cancel gap | P1 | Added a two-phase running/identity-flush gate; execution starts only after acknowledgement |
| Unix socket paths under arbitrarily deep run directories can exceed macOS limits | P1 | Kept durable metadata under the run root and moved ephemeral endpoints to a short owner-validated temporary root |
| Cancellation after a settled node failure was reduced as generic failure | P1 | Added attributed cancelled-node semantics while preserving resource-exhaustion precedence |
| Incremental socket-frame concatenation could become quadratic | P2 | Accumulate bounded chunks and concatenate once after the LF terminator |

## Research references

- Prime Agent architecture: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
- Prime Agent daemon protocol and recovery: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- Pi SDK: <https://pi.dev/docs/latest/sdk>
- Pi RPC: <https://pi.dev/docs/latest/rpc>
- Pi sessions: <https://pi.dev/docs/latest/sessions>
- OMP SDK: <https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md>
- Node child-process detachment: <https://nodejs.org/api/child_process.html#optionsdetached>
- Node local IPC sockets: <https://nodejs.org/api/net.html>
