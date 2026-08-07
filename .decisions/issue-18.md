# Decision Journal: Issue #18 — Durable exact command approval

**Issue**: #18 | **Branch**: `codex/issue-18-durable-command-approval` | **Started**: 2026-08-07

---

## Context

Flow currently executes every ready command node immediately. Its fixed command sandbox limits the
process, and its model-tool broker records allow or deny decisions, but neither capability lets an
operator pause a consequential operation and decide after the initiating CLI has exited. Gate 3
requires exact, expiring approval; Gate 4 requires human waits that survive detachment.

The tempting first implementation is to prompt inside a Pi tool callback. That is not yet a safe
durable boundary. The current Pi adapter uses `SessionManager.inMemory()`. An agent may commit edits
before it requests a later command. Restarting that node after approval would replay the prompt
rather than resume the same tool-call continuation and could duplicate or overwrite prior effects.
Dynamic agent-tool suspension therefore depends on a separately designed, integrity-anchored Pi
session artifact plus an open-node continuation protocol.

Deterministic command nodes have a safer seam. Their executable, argv, timeout, and working
directory are known before `node_started`; Flow can persist an approval request and release run
ownership without preparing the sandbox or spawning a process. The existing JSONL ledger and
same-host owner record can then serialize approval, denial, expiry, and recovery.

## Specification

_Captured from issue #18 and the architecture analysis on 2026-08-07._

### Non-goals

- Suspending or resuming an in-flight Pi prompt or model tool call.
- Persisting Pi transcripts, messages, provider state, or opaque session files.
- Adding agent execute or network tools, global policy profiles, credential grants, or policy-file
  discovery.
- Authenticating the asserted actor, implementing RBAC, signing decisions, or treating a request id
  as a secret bearer token.
- Notifications, webhooks, a TUI approval screen, a daemon, remote callbacks, or multi-host
  ownership.
- Approval of commands assembled dynamically from model text.
- Automatic merge, release, deployment, or weakening of the fixed sandbox profile.
- Solving hostile-workspace pathname races or replacing the documented need for VM-grade isolation.

### Failure modes

- **Pending request** — Flow returns `waiting_for_approval`, releases ownership, and executes
  nothing. Repeated inspection or resume cannot infer consent.
- **Denied request** — The decision becomes durable, the node fails without starting, and the run
  terminates as not accepted. A crash between the decision and run-finalization is recovered through
  the existing committed-failure path.
- **Expired grant** — An unused approved grant executes nothing. Resume records expiry and creates a
  fresh durable request for the same exact operation.
- **Stale, duplicate, or conflicting decision** — A request that is no longer the current pending
  request is rejected without appending or executing.
- **Operation tampering** — Replay recomputes the operation digest. A changed executable, argument,
  timeout, working directory, request identity, or digest makes the ledger invalid.
- **Workflow or working-directory mismatch** — Recovery refuses a workflow digest, approval
  declaration, or normalized execution directory different from the starting run.
- **Concurrent clients** — Run ownership admits at most one decision or resume writer. A live owner
  causes the competing client to fail before append or execution.
- **Crash before request append** — No approval exists and no command has started; recovery reaches
  the same ready node and creates the request.
- **Crash after request or decision append** — Replay reconstructs the exact wait or grant. No model
  transcript or process-local callback is required.
- **Crash after `node_started`** — The existing uncertain-operation rule still blocks replay. An
  approval grant proves consent, not whether an interrupted external effect committed.
- **Wall-clock changes** — Grant expiry uses persisted UTC timestamps and the host clock. This slice
  does not provide trusted time; a materially incorrect host clock can extend or shorten the local
  window but can never turn an undecided or denied request into approval.
- **Actor spoofing** — The CLI records an explicit bounded actor label, but local identity is
  asserted rather than authenticated. Filesystem access to the private run directory remains the
  administrative boundary for this local-only slice.

### Interface contracts

- A command node may declare `approval.mode: required` and `approval.grantTtlMs`. Presence is opt-in;
  existing nodes retain immediate execution. Unknown fields and invalid lifetimes fail compilation.
- `run_started` captures every approval-required node and the normalized absolute execution
  directory. Old ledgers without either field retain their historical behavior.
- `command_approval_requested` records a deterministic request id, node and attempt, bounded grant
  lifetime, exact command operation, and SHA-256 operation digest before any `node_started` event.
- The exact operation contains a version, semantic `process.execute` action, normalized absolute
  working directory, executable, ordered argv, and command timeout. Approval remains separate from
  sandbox containment and does not imply arbitrary descendant effects are exactly predictable.
- `flow approve <run-id> <request-id> --actor <label>` appends an approved decision with an exact
  expiry timestamp derived from the request lifetime. It does not execute the command; the exact
  workflow must subsequently be resumed.
- `flow deny <run-id> <request-id> --actor <label> [--reason <text>]` appends denial and a
  deterministic failed-run outcome without invoking an executor.
- `flow inspect` exposes the current request or grant from ledger state. Approval history remains in
  append-only events even when a later request becomes current.
- `flow run` and `flow resume` return process exit code 3 for a valid durable wait, 0 for success, and
  1 for a failed or cancelled run. Approval and denial commands return 0 when the requested decision
  was durably recorded.
- A required command `node_started` event identifies the approved request and operation digest.
  Replay rejects missing, expired, mismatched, or already consumed grants.
- The scheduler remains the only component allowed to consume approval and start a node. The command
  executor remains unaware of approval state.

## User and system flows

### Request and detach

1. The compiler validates the command approval declaration.
2. The scheduler selects the ready command and derives its exact operation from the compiled node
   and normalized execution directory.
3. Flow appends and syncs `command_approval_requested`.
4. The scheduler returns `waiting_for_approval`; the store releases run ownership.
5. The CLI prints inspectable JSON and exits with code 3. No sandbox or executor method was called.

### Approve and resume

1. The operator inspects the current request id, argv, working directory, digest, and lifetime.
2. `flow approve` claims the run, verifies the current pending request, appends the actor and
   expiring decision, and releases ownership.
3. `flow resume` recompiles the exact workflow, claims the run, validates workflow and execution
   context, and appends `run_resumed`.
4. If the grant is still valid, Flow appends `node_started` with its request id and digest, then
   prepares the sandbox and executes once.
5. Normal node evidence and graph advancement continue through the existing path.

### Expired grant

1. Resume observes that the persisted grant has reached its exclusive `expiresAt` boundary.
2. Flow appends `command_approval_expired`; no executor is invoked.
3. It appends a fresh request with a new deterministic sequence-bound identity.
4. The client receives a new durable wait. Consent is never carried beyond its declared window.

### Deny

1. `flow deny` claims and verifies the current pending request.
2. Flow appends the actor, optional reason, and denied decision; the node becomes a committed failed
   node without a start or evidence record.
3. Flow appends `run_failed`, releases ownership, and returns the terminal state.

## Coupling analysis

- Workflow schema and types own only the approval declaration; they import no CLI, Pi, store, or
  sandbox types.
- A Flow domain module owns the exact operation shape and canonical digest calculation.
- Run events own approval request, decision, expiry, consumption, and replay invariants. They never
  call an executor or trust CLI state.
- The application scheduler creates and consumes requests. It derives operation data before
  `node_started` and returns at the durable wait boundary.
- A small application decision service claims a run and appends approve or deny events without
  needing the workflow file, executor, model credentials, or workspace tools.
- The JSONL store needs no approval-specific API; its existing claim, append, fsync, replay, and
  release semantics serialize all writers.
- The CLI presents commands and maps waiting to a distinct exit code. Its actor value is explicitly
  documented as attribution, not authentication.
- The Pi adapter and command executor remain unchanged. This absence of coupling is intentional:
  approval authorizes a scheduler transition, while sandboxing contains the process that follows.

## Options considered

| Option | Simplicity | Capability | Safety and coupling | Disposition |
| --- | --- | --- | --- | --- |
| Durable gate before deterministic command nodes | Moderate event and CLI work | Proves request, detach, decide, expiry, resume, denial, and exclusive ownership | No in-flight session or prior-node effect replay; reuses Flow ledger | **Chosen first slice** |
| Suspend a live Pi custom-tool call | Highest implementation complexity | Best interactive agent UX and exact dynamic operation prompt | Requires persisted opaque session state, same-call continuation, transcript protection, and open-node reconciliation | Deferred until session continuation exists |
| OMP-style preconfigured allow, prompt, and deny profiles only | Lowest runtime complexity | Useful noninteractive policy selection | `prompt` cannot survive process exit and a broad allow is not an exact per-operation grant | Deferred; later policy layer will reuse approval domain |
| Explicit approval node followed by a command proposal artifact | Moderate graph work | General graph-visible human checkpoint | Does not itself prove that a later command equals the reviewed proposal; conditions and typed artifacts are not implemented | Deferred to Gate 5 |
| Remote callback token through a supervisor | High infrastructure complexity | Enables web, CI, and external-system approval | Requires daemon routing, authenticated identities, token secrecy, and multi-client protocol | Deferred to supervision/API work |

## Decision

Implement the reusable durable approval state machine first, exercised only by deterministic command
nodes. Keep request waiting indefinite, but make an approved grant short-lived and single-use. On
unused expiry, create a new request rather than converting missing consent into success or failure.

Persist approval requirements at run start so replay can enforce the gate without reopening mutable
workflow source. Persist the normalized absolute execution directory as part of the run and exact
operation; require recovery to use the same value. A request id is a deterministic locator derived
from its event sequence, not a security token. The local run-directory permissions and exclusive
owner record remain the administrative boundary.

Do not add Pi session persistence as an incidental implementation detail. Dynamic agent-tool
approval will later reuse the request/decision concepts only after Flow can anchor, protect, and
resume the same provider-neutral node continuation without replaying earlier effects.

## Consequences

- Flow gains its first client-detachable human wait and exact expiring authorization path.
- Approval cannot bypass the sandbox and the sandbox cannot substitute for approval.
- New-run recovery becomes stricter by binding the execution directory; old ledgers remain readable
  and preserve their original weaker recovery contract.
- A denied command has no `node_started` event or command evidence because execution never began.
- The local actor label is useful audit metadata but is not a security identity. Remote deployment
  must add authentication and signed or server-held callback credentials.
- Approval does not reconcile an interrupted command. Once a start is durable, the existing
  uncertain-operation block remains authoritative.
- Dynamic model-tool prompting remains a larger Gate 3/4 capability rather than a misleadingly
  partial feature.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Approval declaration is strict and bounded | Contract | `npx vitest run test/unit/workflow/compiler.test.ts -t "approval"` | Valid declaration compiles; unknown modes, fields, and lifetimes fail | Global policy profiles |
| Request is durable before any effect | Lifecycle | `npx vitest run test/unit/application/run-workflow-approval.test.ts -t "persists an exact approval request"` | Waiting state and synced request exist; executor call count is zero | Pi tool suspension |
| Ledger enforces exact grant integrity | Evidence | `npx vitest run test/unit/run/command-approval-reducer.test.ts` | Tampering, missing grants, duplicate decisions, stale ids, and expired starts fail replay | Signed ledger authenticity |
| Approval resumes exactly once | Recovery | `npx vitest run test/unit/application/run-workflow-approval.test.ts test/integration/fs/command-approval-concurrency.test.ts` | One start and one executor call follow a valid resume, including under competing clients | Exactly-once arbitrary external effects |
| Expiry returns to wait | Time/error | `npx vitest run test/unit/application/run-workflow-approval.test.ts -t "expired grant"` | Expiry and new request append; no executor call occurs | Trusted distributed time |
| Denial is terminal without execution | Error handling | `npx vitest run test/unit/application/command-approval.test.ts -t "denies"` | Decision plus failed outcome persist; executor is structurally absent | Authenticated actor identity |
| Competing decisions fail closed | Concurrency | `npx vitest run test/integration/fs/command-approval-concurrency.test.ts` | One decision or resume owner wins; the losing client appends nothing and no command double-starts | Multi-host consensus |
| CLI survives detachment | API | `npx vitest run test/integration/cli/main.test.ts -t "approval|denies"` | Run exits 3, inspect shows request, approve/deny work in a later store instance, resume obeys grant | Daemon or remote callback |
| Old contracts remain valid | Compatibility | `npx vitest run test/unit/run/command-approval-reducer.test.ts test/unit/application/run-workflow.test.ts -t "old runs|legacy|resume"` | Existing ledgers and workflows behave unchanged | Stable pre-1.0 schema promise |
| Public contracts are accurate | Documentation | `npx vitest run test/scaffold/community-files.test.ts test/unit/workflow/compiler.test.ts` | README, docs, examples, and status tables match executable behavior | Future agent approvals |
| Complete project remains releasable | Regression | `npm run check && npm run test:coverage && npm run pack:check` | Local CI-equivalent, coverage, runtime, and package inspection pass | Live provider availability |

## Implementation tasks

1. Extend the strict workflow declaration and compiled command contract.
2. Add exact command-operation hashing and durable approval event/reducer invariants.
3. Add the decision application service with exclusive ownership and attributable approve/deny.
4. Gate scheduler start, bind recovery context, implement expiry renewal, and preserve legacy runs.
5. Add CLI commands, help, JSON output, and waiting exit-code behavior.
6. Add a credential-free approval example and update every public capability and trust document.
7. Run local CI, coverage, runtime, package, clean-consumer, dependency audit, and adversarial review.

## Research references

- Pi session persistence and SDK composition: <https://pi.dev/docs/latest/sdk>
- Pi session-file format and tree semantics: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
- OMP approval modes and ordered tool rules: <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md>
- OMP current settings contract: <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>
- Prime Agent supervisor, worker, session, and recovery separation: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
- Prime Agent host-authoritative RLM state and trust boundary: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md>
- Azure Durable Functions external events and deduplication: <https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-external-events>
- Durable Task human-interaction pattern using external events and timers: <https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-human-interaction>
- AWS Step Functions callback tokens and timeout replacement: <https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html>
