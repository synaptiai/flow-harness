# Architecture

## Context

Flow turns a collection of useful software-development practices into an enforceable harness. The previous plugin described workflows through Markdown commands, skills, YAML metadata, and host hooks. Claude Code still owned the actual agent loop, scheduling, tool semantics, context, and session lifecycle.

The standalone harness reverses that relationship. Flow owns workflow execution and delegates only bounded node work to an embedded agent runtime.

This document describes the target architecture unless a section is explicitly labeled as the current executable slice. The delivery roadmap is the source of truth for implementation status. Gates 1 and 2 currently provide `validate`, sequential `run`, `inspect`, optional versioned goal contracts, command-bound criterion evaluation, command and bounded Pi agent nodes, cancellation, and replayable local event ledgers. Gate 3 now includes a runtime-neutral policy broker for model-requested reads, lists, and hash-anchored single-file edits, a fail-closed native sandbox for every command node, and exact expiring pre-start approval for deterministic commands. Gate 4 adds `resume` at committed node boundaries, exclusive same-host process ownership, fail-closed refusal of uncertain open attempts, command approval waits that survive client detachment, durable resource accounting with run-wide start, model-token, reported-cost, and active-execution limits, and a local supervisor with authenticated detached workers, status, bounded event replay, cancellation, and restart adoption. Initialization, a TUI, open-operation reconciliation, dynamic agent-tool approval, execute/network model tools, probabilistic evaluators, packages, graph loops, and stronger VM or managed sandbox backends remain later work.

## Target flows

Architecture is derived from these flows.

### User flows

| Flow | Trigger | Outcome |
| --- | --- | --- |
| Initialize | A user runs `flow init` in a repository | Validated project configuration and provider readiness |
| Execute | A user selects a goal and workflow | Verified success, explicit failure, a durable wait state, or a precise blocker |
| Observe | A user opens status or the TUI | Current graph position, attempts, evidence, costs, approvals, and blockers |
| Steer | A user pauses, cancels, supplies input, or approves an operation | A durable, attributable state transition |
| Resume | A user reopens an interrupted run | Reconciled state and continuation from the next safe node |
| Extend | A user installs a capability package | Validated and explicitly enabled skills, tools, workflows, evaluators, or policies |

### Operator flows

- Configure credentials, model routing, budgets, policy, sandboxing, and concurrency.
- Inspect and recover crashed, blocked, rate-limited, or abandoned runs.
- Audit actions and export an evidence bundle.
- Approve an exact consequential action with a target, arguments, scope, and expiry.
- Benchmark model and routing profiles on held-out workflows.

### Target system flow

```mermaid
flowchart TD
    trigger["User, CI, or scheduled trigger"] --> compiler["Workflow compiler"]
    compiler --> graph["Typed executable graph"]
    graph --> scheduler["Deterministic scheduler"]
    scheduler --> context["Minimal node context"]
    context --> executor["Agent executor"]
    executor --> pi["Pi AgentSession"]
    pi --> provider["Selected model provider"]
    pi --> broker["Flow tool broker"]
    broker --> policy["Policy, approval, and sandbox"]
    policy --> environment["Repository, shell, Git, browser, and APIs"]
    executor --> evidence["Structured result and evidence"]
    environment --> evidence
    evidence --> verifier["Independent verifier"]
    verifier --> ledger["Append-only event ledger"]
    ledger --> scheduler
    scheduler --> terminal["Succeeded, failed, exhausted, blocked, cancelled, or waiting"]
```

The system contains two loops:

1. The inner agent loop lets a model use allowed tools to solve one bounded node.
2. The outer Flow loop decides readiness, transitions, retries, joins, approvals, evaluation, and termination.

The inner loop may propose a transition. It cannot authorize one.

## Components and dependency direction

```text
CLI / future TUI
        |
        v
local supervisor ------> detached worker
        |                       |
        v                       v
flow-application ------> flow-domain
        |                    ^
        v                    |
runtime-pi             store-local / tools-* / adapters-*
```

### Flow domain

Owns workflow and goal contracts, graph rules, lifecycle state machines, evidence contracts, policy decisions, approvals, budgets, and failure classifications. It imports no Pi, OMP, Prime Agent, provider, UI, filesystem, or database types.

### Flow application

Compiles workflows, selects ready nodes, assembles minimal context, calls domain ports, evaluates results, and records transitions. It never executes tools directly.

### Pi runtime

Implements one Flow-owned `AgentExecutor` port. It creates node-scoped sessions, selects models and tools, streams events, supports cancellation, supplies an attempt-scoped Flow policy broker, and translates all Pi values into Flow contracts.

### Tool broker

The current broker normalizes and canonically resolves every model-requested `read`, `ls`, and `edit` filesystem operation, derives its authority class, authorizes only declared operations inside the workspace, and emits bounded decisions tied to the exact run/node attempt. A directory listing is one logical authorization even when it returns many bounded entries. Edit authorization binds a digest of the complete model request. A separate bounded effect receipt records the canonical target, before/after SHA-256 values, and committed or uncertain outcome; replay verifies a one-to-one match between every receipt and an allowed write decision. The domain contract already distinguishes read, write, execute, network, credential, and destructive authority without importing runtime types. Dynamic model-tool approval, configurable profiles, and broader model tools remain subsequent Gate 3 slices. Tool implementations cannot mutate scheduler state.

### Command sandbox

Every command executor depends on a Flow-owned `CommandSandbox` port. The production composition uses Anthropic Sandbox Runtime (SRT) with a fixed, versioned profile: workspace and private-temp writes are allowed; network, home-directory reads, ambient credentials, run-store writes, and writes to sensitive project state are denied. Sandbox dependency errors and degraded-security warnings fail before spawn. Cleanup must complete before a node can succeed.

The port isolates Flow from the backend. Pi's official SRT and Gondolin examples validate this tool-routing seam; Flow imports SRT as a containment primitive but owns policy, lifecycle, evidence, and failure semantics. A future Gondolin, OpenShell, or container adapter can implement the same port without changing workflow or ledger contracts.

### Event and evidence store

Persists transitions before the scheduler advances. Model transcripts are optional diagnostic artifacts; they are never authoritative for graph position or completion. Policy decisions prove authorization, while effect receipts prove committed or uncertain workspace mutation; neither is substituted for the other.

Fresh and recovered execution publish an atomic per-run ownership record containing a process ID and random token before appending. A live owner blocks competitors; an exited owner can be displaced atomically. Recovery replays the committed JSONL prefix, verifies the exact compiled workflow digest and node set, and appends `run_resumed` before continuing. A final unterminated record is uncommitted and is truncated before the recovered owner appends. Ownership is local-host coordination, not a distributed lease or security boundary.

### Local detached supervision

The auto-started local supervisor is a control-plane router, not another scheduler. A detached
submission contains the exact workflow source, normalized execution directory, run identity, and
run/resume mode. The supervisor validates that input before mutation and first journals an exact
request digest. It then writes an immutable job snapshot and an exclusive active-run claim, and
launches one detached worker with non-inherited standard streams. Submission records transition
monotonically to accepted, rejected, or uncertain; uncertain launch is reconciled from an existing
authenticated worker and is never blindly repeated. An unclaimed snapshot without a matching
worker is ambiguous and fails closed. The worker alone constructs the executor, claims the run
store, and calls the existing application scheduler.

Concurrent clients serialize auto-start through an owner-only startup record. Only its holder may
remove a stale socket and spawn a generation; other clients poll the advertised endpoint. A dead
holder can be displaced, while a live or PID-reused holder blocks conservatively.

An authenticated worker adoption gate separates process creation from job acceptance. The worker
publishes an owner-only descriptor and private control socket, then waits. After a supervisor
requests adoption, the worker durably changes to `running`, returns its worker id, run id, PID,
random token, and immutable job digest, and waits for that identity response to flush before
entering the scheduler. This closes both the fast-job race and the immediate-cancellation gap.

Client and worker control use strict, versioned, one-request JSONL frames with bounded UTF-8 bytes,
unknown-field rejection, request identifiers, and structured failures. Event replay reads the
normal validated Flow ledger in pages strictly after an exclusive sequence cursor; the supervisor
does not retain an unbounded client queue or reinterpret run state. Submissions and cancellations
are durably journaled before their consequential step and are idempotent by command id and exact
request digest. Cancellation reaches only a token-authenticated active worker. Mid-node
cancellation preserves settled evidence and records an attributed `run_cancelled` event; already
committed budget exhaustion retains terminal precedence. CLI callers may supply and persist a UUID
before the first mutating request; generated keys are returned for interactive convenience but
cannot by themselves recover a response lost before the caller observes it.

Workers are independent process groups. A supervisor crash therefore does not terminate them. A
new generation scans durable claims and descriptors and adopts only workers that pass the same
identity handshake. PID liveness alone never grants authority because PIDs can be reused. A dead
worker with an open node attempt remains governed by the existing `uncertain_operation` recovery
rule; the control plane does not invent an outcome or replay the work.

Durable control metadata lives under `<runs-dir>/.supervisor` with owner-only directories and files,
no-follow reads, bounded schemas, atomic replacement, and sync-before-acknowledgement. Ephemeral Unix
sockets live in a short owner-validated `/tmp/flow-harness-<uid>` directory because macOS limits
socket path length. A digest of the canonical runs directory namespaces endpoints. This is
same-host, same-user coordination—not authentication against the same user, a distributed lease,
or a sandbox.

### Durable command approval

The current approval slice is a scheduler pre-start gate for deterministic command nodes. Run start
captures the approval declaration and normalized execution directory. When the node becomes ready,
the scheduler derives an exact `process.execute` operation, persists its SHA-256-bound request, and
returns `waiting_for_approval` before `node_started`, sandbox preparation, or process spawn.

Approval and denial are separate application operations over the recoverable event-store port. They
require no workflow file, executor, Pi session, or model credential. Approval records an attributable
single-use grant with a bounded expiry but does not execute; resume with the exact workflow and
working directory consumes it. An unused expired grant returns to a new durable wait. Denial creates
a side-effect-free committed node failure and terminal run. The same owner record serializes
decision-versus-decision and decision-versus-resume races.

The actor label is asserted local audit metadata, not authenticated identity. Request ids are
sequence-derived locators rather than bearer secrets. General approval nodes, remote callbacks, and
dynamic Pi tool-call suspension remain separate capabilities. The latter requires persisted opaque
session continuation so prior model effects are not replayed.

### Durable resource accounting and budgets

Every run reconstructs provider-neutral resource consumption from authoritative events: committed
node starts, evidence duration rounded up to whole milliseconds, four model-token components, and
provider-reported cost normalized to integer micro-USD. The Pi adapter obtains its observation from
`getSessionStats()` and translates it before the application or domain sees it. A future executor
must produce the same Flow evidence shape; provider transcripts and runtime-specific settings never
become graph authority.

An optional compiled budget limits starts, total model tokens, reported model cost, and active
execution duration. The scheduler consults only reduced run state before work and after outcome
settlement. It appends `run_budget_exhausted` and produces distinct terminal
`resource_exhausted` state rather than treating exhaustion as success, cancellation, or an invented
node failure. Recovery validates the exact persisted limits and reaches the same decision after a
crash between the node outcome and terminal event.

The active-time limit also narrows executor authority: a node receives the lesser of its declared
timeout and remaining allowance. For approval-required commands, this effective timeout is part of
the exact persisted operation before the client detaches. Human wait and process downtime consume
no active duration because only committed evidence contributes.

This is a settlement ceiling, not a prepaid billing control. Provider usage is authoritative only
after a response, so one response can overshoot. Flow keeps the full observation and schedules no
downstream work. External organization quotas, price catalogs, invoice reconciliation, distributed
reservation, CPU/memory/disk limits, concurrency, and artifact budgets remain separate capabilities.

### Evaluators

The current goal evaluator is a pure domain transition: it receives only a compiled criterion-to-verifier binding and authoritative node outcome metadata. It receives no prompt, transcript, filesystem handle, executor, or tool, and therefore cannot mutate the workspace or infer acceptance from implementation rationale. Successful command evidence accepts a criterion; normal non-zero evidence rejects it; timeouts, signals, missing evidence, and unexpected evidence kinds are inconclusive. An LLM evaluator, when later unavoidable, must receive evidence rather than the implementation transcript and have no workspace mutation tools.

## Current trust boundaries

Pi intentionally has no built-in security boundary and the host-side agent runtime still runs with the invoking user's operating-system permissions. Flow therefore distinguishes the agent-tool authorization boundary from the command containment boundary.

- Agent nodes receive only declared Flow-provided `read`, `ls`, and `edit` tools; implicit project extensions and resource discovery are disabled. Reads include an exact-byte full-file SHA-256 version. Edits require that version, preflight exact unique Unicode-scalar replacements, coordinate same-file mutations across cooperating same-host Flow processes, atomically replace one existing UTF-8 target, and protect durable/sensitive project paths at every path depth. Stale versions fail without fuzzy or three-way recovery.
- Every command node and descendant executes inside SRT on Linux or macOS. Flow preserves argv boundaries through an audited POSIX encoder, passes an explicit environment allowlist, denies network and undeclared Unix sockets, and protects the actual run-store path. Linux execution canonically resolves and re-exposes only SRT's required seccomp helper read-only when the harness installation is outside the selected workspace.
- Missing dependencies, seccomp degradation, unsupported platforms, initialization errors, and invalid launch descriptors fail closed with no command spawn. There is no unsandboxed fallback.
- Each new command result records the backend, exact backend version, named profile, and semantic policy digest. Backend and profile values use bounded machine identifiers rather than an SRT-only persisted union, preserving the event shape for future adapters. Older ledgers remain readable because the added evidence field is optional during replay.
- Approval-required commands persist the exact executable, argv, normalized working directory,
  timeout, digest, request, and grant lifetime before a start. A grant authorizes only that scheduler
  transition; it neither expands the sandbox profile nor predicts every transitive process effect.
- Run budgets constrain scheduler admission and effective timeouts, but they are not a sandbox,
  provider-side reservation, account quota, or guarantee that one in-flight response cannot exceed
  its remaining reported-cost allowance.
- Supervisor metadata and random worker tokens coordinate processes belonging to one local account.
  They do not defend against that same operating-system user or root, and no TCP or remote control
  endpoint is exposed.

Native sandboxing is not equivalent to a microVM. SRT is a beta dependency built on Seatbelt on macOS and bubblewrap, namespaces, and seccomp on Linux. Kernel or sandbox-runtime vulnerabilities remain outside Flow's enforcement model, and the host-side Pi process is not contained by this command adapter. Hostile workloads still require a reviewed container, microVM, Gondolin, OpenShell, or managed isolation boundary.

The application-level workspace broker prevents ordinary traversal and symlink escapes. A target-local lock prevents concurrent edits by cooperating Flow processes on the same host and recovers locks whose same-host owner has exited. It is not a distributed lease and does not make pathname authorization and use atomic against a concurrently hostile or non-cooperating process. The command sandbox reduces the authority of command descendants; it does not turn the whole harness into a complete host security boundary.

Approval remains separate from containment. OMP-style allow/prompt/deny rules can decide whether an exact operation is authorized, but authorization cannot replace containment of that operation's transitive effects. Flow currently proves that separation for deterministic command nodes; dynamic agent tools still require resumable session state.

## Target invariants

1. Editing workflow YAML changes execution without editing a prompt manual.
2. Only the compiled graph can select a ready node.
3. A transition is not visible until its event and outputs are durably recorded.
4. A criterion cannot pass without current evidence linked to that run and criterion.
5. Deterministic evidence wins over conflicting model judgment.
6. Project configuration and packages cannot weaken the immutable safety floor.
7. A skill or package can narrow authority but cannot expand its own authority.
8. Every side-effecting node declares idempotency and recovery behavior.
9. Compaction and model changes cannot erase authoritative state.
10. Cancellation propagates to the model stream, active tool process, children, and workspace cleanup.
11. Resource consumption and exhaustion are reproducible from Flow events without a provider transcript.
12. Supervisor health metadata cannot override, repair, or replace authoritative ledger state.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid workflow or configuration | Reject with path-specific diagnostics before creating side effects |
| Missing credentials | Fail startup or enter a durable operator-wait state |
| Provider outage or rate limit | Record the attempt and apply only the declared bounded retry or fallback policy |
| Malformed model output | Schema-reject, retry within the node budget, then block with evidence |
| Unauthorized tool request | Deny before execution and record a policy event |
| Stale or invalid edit | Reject the entire replacement before rename and record no committed effect receipt |
| Edit fails after atomic rename | Record an uncertain effect receipt and fail the node with uncertain side-effect status |
| Sandbox unavailable or degraded | Fail before command spawn; never fall back to host execution |
| Sandbox cleanup failure after spawn | Fail with uncertain side-effect status; never report command success |
| Tool timeout or crash | Terminate the process tree where possible and classify side-effect uncertainty |
| Partial external mutation | Reconcile authoritative external state; compensate only when explicitly supported |
| Verification failure | Record failing or inconclusive evidence and never coerce success |
| Concurrent workspace changes | Detect baseline drift and pause before absorbing the changes |
| Crash during persistence | Recover to the last committed event and tolerate an incomplete trailing record |
| Client exits after detached acceptance | The authenticated worker continues with independent standard streams and process group |
| Supervisor exits while workers run | Workers continue; a replacement generation adopts only token-authenticated matching identities |
| Worker exits with an open attempt | Preserve ledger truth and report uncertainty; never infer or retry the operation |
| Duplicate detached submission | Reuse the durable immutable job/claim for the exact request or reject a conflicting request without a second worker |
| Concurrent supervisor auto-start | One startup-lock holder launches; all other clients attach to the resulting generation |
| Cancellation acknowledgement is lost | Reconcile the durable command record with ledger state; never blindly dispatch an uncertain mutation again |
| Oversized, malformed, or incompatible IPC | Reject the bounded frame before a mutating handler runs |
| Corrupt state or failed migration | Preserve original data, fail closed, and provide exportable diagnostics |
| Resource exhaustion | Preserve the full committed observation, append explicit exhaustion, start no downstream work, and never infer success |
| Approval grant expires unused | Execute nothing, record expiry, and return to a fresh durable request; never infer consent |
| Incompatible package | Reject or quarantine it without changing active runs |

## Non-goals

- Flow does not retain Claude Code plugin compatibility.
- Flow does not act as a common adapter over Claude Code, OMP, and Prime Agent.
- Flow does not fork or rebrand Pi, OMP, or Prime Agent.
- Flow does not reproduce OMP's full tool surface in the initial release.
- Flow does not make Markdown an executable orchestration language.
- Flow does not initially provide distributed or multi-host scheduling.
- Flow does not guarantee exactly-once behavior for arbitrary external side effects.
- Flow does not guarantee prepaid or invoice-authoritative model-cost caps, currency conversion, or distributed quota reservation.
- Flow does not autonomously merge, release, deploy, or weaken its safety floor.
- Flow does not permit live mutation of policy, evaluator definitions, or graph semantics.
- Flow does not make a Python or JavaScript kernel a mandatory core primitive.
- Flow does not treat process or worktree isolation as a security sandbox.

## Architectural litmus tests

Flow is acting as a harness only when:

- Reordering workflow nodes changes execution without prompt changes.
- Removing a required edge cannot be overridden by model prose.
- Restricting a node's tools prevents undeclared calls structurally.
- Restarting after interruption identifies the same next safe node.
- A confident completion narrative cannot pass a failing deterministic check.
- Changing providers does not migrate workflow, run, or evidence schemas.
- Equivalent executions produce equivalent Flow transition ledgers across models.
