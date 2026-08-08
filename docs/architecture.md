# Architecture

## Context

Flow turns a collection of useful software-development practices into an enforceable harness. The previous plugin described workflows through Markdown commands, skills, YAML metadata, and host hooks. Claude Code still owned the actual agent loop, scheduling, tool semantics, context, and session lifecycle.

The standalone harness reverses that relationship. Flow owns workflow execution and delegates only bounded node work to an embedded agent runtime.

This document describes the target architecture unless a section is explicitly labeled as the current executable slice. The delivery roadmap is the source of truth for implementation status. Gates 1 and 2 currently provide `validate`, `run`, `inspect`, optional versioned goal contracts, command-bound criterion evaluation, command and bounded Pi agent nodes, cancellation, and replayable local event ledgers. Gate 3 now includes a runtime-neutral policy broker for model-requested reads, lists, and hash-anchored single-file edits, a fail-closed native sandbox for every command node, and exact expiring pre-start approval for deterministic commands. Gate 4 adds `resume` at committed node boundaries, exclusive same-host process ownership, write-ahead durable evidence and typed recovery observation for each workspace edit, opt-in proof-safe fresh recovery for interrupted agent attempts, approval waits that survive client detachment, durable resource accounting with run-wide start, model-token, reported-cost, and active-execution limits, project initialization and monotonic capacity configuration, plus a bounded local supervisor with authenticated detached workers, durable FIFO admission, status, event replay, cancellation, and restart adoption. Gate 5 adds replay-safe exact-output conditions, guarded branches, first-class omission, explicit joins, bounded deterministic static-DAG concurrency, finite replay-safe bounded and accept-best optimization loops, evidence-bound graph approval nodes, replay-verified typed result publication, first-class typed verifier nodes with sandboxed command and evidence-isolated zero-tool model drivers, independently-ledgered child workflows, and write-ahead candidate promotion in isolated reflink-or-copy workspaces. Gate 6 now includes strict local portable Agent Skills plus versioned command/model verifier packages, explicit workflow selection, immutable run snapshots, and provider-neutral use evidence. A TUI, remote package installation, executable extensions, other capability package types, opaque Pi session continuation, general failure/fallback retries, broader configurable policy, dynamic agent-tool approval, execute/network model tools, arbitrary evaluator runtimes, and stronger VM or managed sandbox backends remain later work.

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

Owns workflow and goal contracts, graph rules, lifecycle state machines, exact condition, join,
bounded-loop, accept-best optimization, and typed-result contracts, omission state, evidence contracts, policy decisions,
approvals, budgets, and failure classifications. It imports no Pi, OMP, Prime Agent, provider, UI,
filesystem, or database types. Child contracts contain only provider-neutral workflow, run-link,
workspace-provenance, typed-result, and resource projections.

### Flow application

Compiles workflows, including finite expansion of bounded loop bodies and optimization candidates, selects the next legal
executable or control transition, assembles minimal context, calls domain ports, evaluates results,
and records transitions. It binds model verifiers and typed results to exact complete durable source
attempts. It recursively schedules independently-ledgered child workflows through an isolation
port, reserves their ceilings against ancestors, and imports only typed results and resource
evidence. A candidate-workspace port captures and promotes typed deltas behind durable lifecycle
callbacks. The same state-based selector checks recovered history. It never executes tools directly,
and result, condition, join, loop-check, optimization-check, and controller nodes never enter an executor port.

### Pi runtime

Implements one Flow-owned `AgentExecutor` port. It creates node-scoped in-memory sessions, selects models and tools, streams events, supports cancellation, supplies an attempt-scoped Flow policy broker, and translates all Pi values into Flow contracts. Flow explicitly disables Pi assistant-turn and provider retry layers; the adapter executes one Flow attempt, while durable Flow policy alone can authorize a later fresh attempt.

### Portable Agent Skills

The infrastructure scanner discovers strict local Agent Skills metadata below `.flow/skills`, but
the workflow—not discovery—selects capability. Before admission the application collects root and
child selections and creates one bounded immutable capability snapshot containing canonical
metadata, exact file bytes, provenance, trust state, permission requests, and nested SHA-256
identities. The `run_started` event is the replay boundary; attached execution, the detached job,
child ledgers, and recovery receive that same content identity rather than reopening mutable package
paths.

Pi's ambient skill discovery remains disabled. The adapter injects a metadata-only catalog into the
locked Flow system prompt and routes `skill://` reads through a snapshot-backed session inside the
Flow-owned `flow_read` tool. The session checks node selection and resource identity but never adds
workspace, execute, network, or policy authority. Agent evidence projects selected package digests
and exact observed resource reads back into the provider-neutral ledger. Domain replay validates
receipts against frozen bytes; workflow recovery additionally validates each selection against the
compiled node. A future non-Pi executor can implement the same contract without changing workflow
or history formats.

### Versioned verifier packages

The verifier catalog discovers strict local `VERIFIER.yaml` manifests below `.flow/verifiers`.
Each package declares an exact SemVer identity and either an argv-only command definition or a
bounded model rubric. Directories may contain only that inert manifest: symbolic links, executable
resources, unknown fields, duplicate names, source races, and package or aggregate bound failures
reject admission. Metadata operations validate identity and provenance without invoking a driver;
inspection omits the model rubric.

The workflow selects an exact package tuple with `packaged-command` or `packaged-model`. A command
package owns the existing command declaration. A model package owns only the rubric, while the
workflow retains evidence order, provider/model choice, thinking level, and timeout. The compiler
preserves that reference in its digest and control graph. Before admission, application composition
collects root and child references and adds their exact manifest bytes and parsed definitions to
the same tagged immutable capability snapshot used by Agent Skills.

Immediately before execution, the scheduler resolves the selected definition from the frozen
snapshot into the ordinary inline verifier shape. The existing verifier executor therefore retains
command containment, zero-tool model isolation, input bounds, cancellation, and verdict semantics.
It records package name, version, and digest on typed verifier evidence. `run_started` separately
persists each node requirement; domain replay reconciles requirement, snapshot, control graph, and
evidence without consulting the live catalog or provider. Detached jobs transport the snapshot
unchanged, child ledgers use their declared subset, and recovery refuses any caller replacement.

This is a declarative package boundary, not a general plugin host. Packages cannot execute hooks,
register tools, add credentials or network, mutate policy or graph structure, select a model, or
import Prime Verifiers environments. Future executable or remote package sources require a separate
out-of-process authority and installation design.

### Tool broker

The current broker normalizes and canonically resolves every model-requested `read`, `ls`, and `edit` filesystem operation, derives its authority class, authorizes only declared operations inside the workspace, and emits bounded decisions tied to the exact run/node attempt. A directory listing is one logical authorization even when it returns many bounded entries. Edit authorization binds a digest of the complete model request. For writable attempts, the application supplies a narrow provider-neutral effect journal. The editor durably records the canonical target, operation digest, before/after SHA-256 values, and permission mode before rename while holding the target lock, then durably settles the effect after the commit boundary while journal publication remains available. A rejected settlement append poisons the journal and leaves the prepared effect unresolved. During recovery, a separate provider-neutral reconciler observes only an open typed edit and publishes through an application-owned callback while the same target lock remains held. It rejects non-regular targets before open and hashes only the initially observed size through bounded chunks. When missing ancestry makes the sibling lock impossible, it may publish only a rechecked `target_missing` observation under the in-process target queue; any observable target is refused. Replay matches every prepared effect, including not-applied effects, to a distinct allowed write decision. Terminal receipts are exact projections of executor-settled committed or unknown effects and must agree with their effect events; recovery observations never become terminal receipts. The domain contract already distinguishes read, write, execute, network, credential, and destructive authority without importing runtime types. Dynamic model-tool approval, configurable profiles, and broader model tools remain subsequent Gate 3 slices. Tool implementations cannot select or advance graph nodes.

### Command sandbox

Every command executor depends on a Flow-owned `CommandSandbox` port. The production composition uses Anthropic Sandbox Runtime (SRT) with a fixed, versioned profile: workspace and private-temp writes are allowed; network, home-directory reads, ambient credentials, run-store writes, and writes to sensitive project state are denied. Sandbox dependency errors and degraded-security warnings fail before spawn. Same-policy concurrent commands share one process-global SRT session while each wrap receives its own private temporary directory and complete per-exec filesystem configuration. A reference-counted Flow coordinator serializes initialization and teardown, queues an incompatible workspace or policy until the active session resets, invokes SRT's per-command cleanup once per wrap, honors cancellation while queued, and resets only after the final compatible command releases. Cleanup must complete before a node can succeed.

Isolated child directories are owned beneath the run-store workspace area. For a child command,
Flow removes a protected-path deny only when that path is an ancestor of the command's own isolated
workspace; SRT still grants writes solely to that canonical workspace and its private temporary
directory. Run ledgers, ownership records, and sibling workspaces therefore remain outside the
write allowlist. Fresh child execution and child recovery derive the same policy.

The port isolates Flow from the backend. Pi's official SRT and Gondolin examples validate this tool-routing seam; Flow imports SRT as a containment primitive but owns policy, lifecycle, evidence, and failure semantics. The pinned SRT Linux implementation already tracks concurrent active sandbox wraps so mount-point cleanup waits for the last command; Flow's coordinator preserves that backend contract. A future Gondolin, OpenShell, or container adapter can implement the same port without changing workflow or ledger contracts.

### Deterministic concurrent scheduler

An omitted workflow concurrency declaration preserves one active executable node. An explicit
`maxNodes` allows the scheduler to fill deterministic quiescent waves from declaration-ordered
ready nodes. Starts are durable before any admitted executor is invoked; all members settle before
outcomes are committed in admission order. Conditions, joins, approvals, and terminal decisions are
barriers. Once one member fails or cancellation is observed, no later wave is admitted, but the
current wave is allowed to quiesce so the ledger never invents abandoned work.

A bounded loop is compiled into one finite local DAG per possible iteration, an exact-evidence check
after each body, and a pure controller under the author-facing loop id. Iterations never overlap:
the next body entry depends on the prior check and requires its durable `continue`. Existing
`maxNodes` concurrency still applies to independent nodes inside the active body. A first `stop`
omits the remaining finite instances; a final `continue` fails the controller rather than
converting exhaustion into success. When the graph omits an enclosing condition branch, omission
propagates through that branch's loop controller instead of being interpreted as loop exhaustion.

A bounded optimization is compiled into one isolated child and one pure check for every possible
candidate, plus a pure controller under the author id. The first candidate depends on the typed
baseline; each later pair requires the prior check to continue. Checks recompute metrics and
invariants from canonical evidence, and only strict valid improvements can call the promotion
port. Stagnation omits the remaining finite pairs. Optimization is a graph barrier: every top-level
workspace mutation is ordered before or after it, so promotion never races an admitted parent wave.
The promotion adapter validates typed leaf identities and every unchanged intermediate directory
before prepare, then rechecks directory ancestors at each mutation boundary. An intermediate path
replaced by a stable symlink therefore fails stale instead of redirecting promotion outside the
workspace. This is pathname hardening for a cooperating local workspace, not an atomic defense
against a hostile same-user process racing between checks and filesystem operations.

The design deliberately separates completion timing from durable ordering. Effect prepare and
settlement events remain real-time write-ahead facts, while node outcomes, dependency release, and
primary-failure selection are deterministic. The reducer independently enforces the persisted
capacity, graph dependencies, outcome order, full-wave quiescence, and ordered cancellation set.
Concurrency is not workspace isolation for ordinary branches: mutations in the shared parent still
require explicit graph ordering. Authors can choose an explicit child node when independent
history, budget, result, and workspace isolation are required.

### Isolated child run trees

A compiled `child` node contains a recursively compiled workflow, its digest, one unconditional
terminal typed-result contract, and no runtime-specific session type. The compiler requires all
four child budget ceilings, rejects human waits, limits nesting to four levels, limits every
embedded source to 1 MiB, and counts the complete expanded tree against a 1,024-node ceiling.

The root-tree scheduler—not Pi, SRT, or the supervisor—owns child admission. Before materialization,
the parent appends a deterministic link derived from parent run, node, and attempt. A child-only
wave prevents parent-workspace executors from mutating the source while sibling snapshots begin.
Each child ceiling is reserved against bounded ancestor remainder, including sibling reservations;
actual resource totals are later charged to every ancestor in addition to the child node start.
This keeps the supervisor's one-worker-per-root-tree model and avoids routing descendants through a
capacity queue that could deadlock behind their own parent.

`WorkspaceIsolator` is an application port with create, reopen, and idempotent cleanup operations.
The initial backend materializes an owner-only reflink where supported and otherwise copies the
current dirty/untracked tree. It preserves modes and symlinks without following them, excludes Flow
and protected run state by normalized source-relative policy, verifies regular-file content and
source stability, rejects special files, records a durable manifest, and atomically exposes the
completed directory. The backend protects the parent from child mutations but is not an atomic
filesystem snapshot, process sandbox, or hostile-code boundary. A native APFS/Btrfs/ZFS/overlay,
Gondolin, OpenShell, container, or managed implementation can replace it behind the same port.

The child recursively invokes the normal run application with its own run id, owner record, JSONL
history, working directory, budget, and persisted execution-workspace provenance. The parent and
child share the cancellation signal and executor composition, but no mutable scheduler state. On
terminal settlement, the parent imports only the canonical typed result, child terminal sequence,
resource totals, duration, workflow identity, snapshot identity, and cleanup disposition. Ordinary
workspace changes are discarded. A compiler-registered optimization candidate instead retains a
successful workspace until its check captures, rejects, or promotes the delta; no other child may
enter that protocol. Cancellation between durable candidate success and evaluation starts no check
or later candidate and leaves the isolated workspace retained for diagnosis.

`CandidateWorkspaceManager` extends isolation with capture, promote, and reconcile operations.
Capture verifies the full parent snapshot still matches the fork, records bounded sorted
before/after identities, and stores content-addressed candidate blobs. It independently bounds
entry count, logical file bytes, and the 128 KiB serialized evidence manifest; an exact previously
captured manifest is reopened idempotently after interrupted event publication. Promotion rechecks affected
paths and removed-directory closures, stores rollback blobs before prepare, and applies a
deterministic saga under process and filesystem ownership. The local journal distinguishes
prepared, applying, rolling back, rolled back, committed, and unknown states. Replay-visible
lifecycle callbacks are the authority for prepare and settlement; the filesystem adapter cannot
advance the graph itself.

Recovery uses two write-ahead boundaries. Parent `node_started` fixes child identity before
materialization. Child `run_started` fixes workspace provenance before child execution. With no
child ledger, the claimed parent can discard a stale pre-ledger directory and recreate it. With any
child event, recovery must reopen the exact manifest and resume the exact ledger; it never creates a
replacement. A terminal child history can be imported after an idempotent cleanup even when the
parent outcome append previously crashed. Missing or divergent nonterminal state fails with typed
recovery refusal.

Ready child workflows can overlap under parent concurrency. The current SRT backend has a narrower
process-global lifecycle: same-workspace command wraps share a session, while incompatible child
workspaces wait for reset and reinitialization. This serializes those command phases without
changing graph admission or rejecting the second child. A backend with independent sessions can
provide full command overlap without changing domain or application contracts.

### Event and evidence store

Persists transitions before the scheduler advances. Model transcripts are optional diagnostic
artifacts; they are never authoritative for graph position or completion. `run_started` persists a
bounded control-graph projection whenever control semantics or concurrent execution require it.
`node_result_published`, `node_condition_evaluated`, `node_loop_checked`, `node_loop_completed`,
`node_omitted`, and `node_joined` record resource-neutral control transitions. For a typed result,
replay reparses the original durable evidence with the persisted bounded schema, reproduces its
RFC 8785 canonical JSON, and verifies source, schema, canonical bytes, and value hashes. Other
control replay recomputes source identity, selected case or loop decision, guard, dependency
propagation, and completion result before accepting it. Truncated source evidence produces a typed
control failure. Child starts persist deterministic run/workflow/result/schema linkage; child
outcomes bind terminal sequence, typed value, resource totals, workspace backend/digest, and cleanup
disposition. Replay validates that projection against the persisted child control contract and
charges its resources to the parent. Optimization events persist recomputable metric/invariant
observations, complete typed delta entries, promotion boundary, settlement, cleanup, best state,
and stop reason. Replay rehashes the delta manifest and validates every transition against the
finite graph and child evidence. Policy decisions prove authorization. `node_effect_prepared` proves Flow reached a
specific edit boundary before rename; `node_effect_settled` records an executor's committed,
not-applied, or post-commit-unknown state; `node_effect_reconciled` records what recovery later
observed for a still-open edit; terminal receipts project only executor-settled effects. None is
substituted for another. The effect journal constrains failure classification as a lower bound: an
unknown settlement requires uncertainty and a committed settlement forbids a side-effect-free
failure, while provider or cleanup uncertainty may conservatively remain uncertain even when every
recorded edit is committed or not applied. A recovery observation never terminalizes its open
attempt. Only a separate `node_attempt_interrupted` event—validated against the persisted opt-in,
attempt cap, effect proof, and resource limits—archives the attempt and permits the scheduler to
start the exact next fresh attempt.

Fresh and recovered execution publish an atomic per-run ownership record containing a process ID and random token before appending. A live owner blocks competitors; an exited owner can be displaced atomically. Recovery replays the committed JSONL prefix and verifies the exact compiled workflow digest, node set, budget, concurrency, approvals, and recovery requirements. It reconciles every open effect and classifies every open attempt in workflow declaration order. Every proof-safe attempt receives one `node_attempt_interrupted` event before the single `run_resumed`; an unsafe sibling still blocks execution without erasing the durable safe dispositions or reconciliation prefix. A crash among these dispositions is replay-safe because archived attempts are already pending with their counters retained. A final unterminated record is uncommitted and is truncated before the recovered owner appends. Ownership is local-host coordination, not a distributed lease or security boundary.

### Local detached supervision

The auto-started local supervisor is a control-plane router, not another scheduler. A detached
submission contains the exact workflow source, normalized execution directory, run identity, and
run/resume mode plus the effective policy digest. The supervisor compiles that input before mutation
and first journals an exact request digest. Under one serialized admission operation, it either
reserves active capacity, assigns a durable FIFO queue ticket, or records deterministic queue-full
rejection. Dispatch and queue decisions persist the immutable job snapshot before the admission
event; queue-full rejection retains only compact command and admission facts. Active capacity is
reserved before process launch. The worker alone constructs the executor, claims the run store, and
calls the existing application scheduler.

Admission is a separate owner-only append-only JSONL ledger under `<runs-dir>/.supervisor`. Its
strict reducer enforces active and queued bounds, unique increasing queue tickets, FIFO dispatch,
job identity, and legal cancellation/release transitions. Records are appended and synced before
acknowledgement. Recovery repairs only an unterminated final fragment and fails closed on committed
corruption. The store atomically compacts a committed prefix to a complete replayable snapshot after
a bounded number of transitions or before its byte ceiling would be crossed. Run events remain the
only graph authority; admission events prove only control-plane capacity and ordering.

Concurrent clients serialize auto-start through an owner-only startup record. Only its holder may
remove a stale socket and spawn a generation; other clients poll the advertised endpoint. A dead
holder can be displaced, while a live or PID-reused holder blocks conservatively.

An authenticated worker adoption gate separates process creation from job acceptance. The worker
publishes an owner-only descriptor and private control socket, then waits. After a supervisor
requests adoption, the worker durably changes to `running`, returns its worker id, run id, PID,
random token, and immutable job digest, and waits for that identity response to flush before
entering the scheduler. This closes both the fast-job race and the immediate-cancellation gap. If
resume durably narrows an open effect and then refuses the unfinished attempt, the worker records a
typed recovery code and the replayed `running` run status before exiting. The admission plane
releases that worker slot without relabeling the authoritative run as failed.

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
worker with an open node attempt remains governed by the same persisted recovery policy and effect
proof as foreground work. The control plane does not invent an outcome or independently replay the
work; unconfigured attempts still report `uncertain_operation`, and ineligible opt-ins report
`recovery_retry_ineligible`.

The supervisor descriptor, every stateful request, and the admission ledger bind the canonical
effective capacity digest and exact limits. Read-only status reports the live binding even when the
caller's newly resolved values differ; every stateful command fails before mutation on that
mismatch. Shutdown refuses active or queued admission; explicit idle shutdown archives the old
ledger so a later generation may bind changed effective values. Status work is proportional to live
claims and admission state rather than lifetime worker history, and returns only bounded worker
summaries plus active/queued counts.

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
sequence-derived locators rather than bearer secrets. Remote callbacks and dynamic Pi tool-call
suspension remain separate capabilities. The latter requires persisted opaque session continuation
so prior model effects are not replayed.

### Durable graph approval

An `approval` node is a pure control barrier over already-durable evidence. Its declaration binds a
bounded prompt and one to sixteen ordered, unique source references. Every source is a compatible
direct dependency selecting command standard output/error or agent text. The scheduler waits for a
quiescent executable wave, rejects truncated evidence, and persists a request snapshot containing
the workflow digest plus each source node, attempt, field, and hash.

Approval and denial reuse the same exclusive application decision path and CLI as command approval,
but emit dedicated events. Approval immediately succeeds the control node; denial immediately
creates a side-effect-free, non-retryable node failure. Neither transition invokes an executor or
consumes a node start. There is no grant or TTL because no later operation creates a
time-of-check/time-of-use boundary. The request does not authorize a command or model tool and does
not expand policy or containment authority.

### Durable resource accounting and budgets

Every run reconstructs provider-neutral resource consumption from authoritative events: committed
node starts, evidence duration rounded up to whole milliseconds, four model-token components,
provider-reported cost normalized to integer micro-USD, and UTF-8 bytes in retained primary
executor payloads. The Pi adapter obtains its observation from
`getSessionStats()` and translates it before the application or domain sees it. A future executor
must produce the same Flow evidence shape; provider transcripts and runtime-specific settings never
become graph authority.

An optional compiled budget limits starts, total model tokens, reported model cost, active
execution duration, and retained artifact bytes. The scheduler consults only reduced run state
before work and after outcome settlement. It appends `run_budget_exhausted` and produces distinct terminal
`resource_exhausted` state rather than treating exhaustion as success, cancellation, or an invented
node failure. Recovery validates the exact persisted limits and reaches the same decision after a
crash between the node outcome and terminal event.

The active-time limit also narrows executor authority: a node receives the lesser of its declared
timeout and remaining allowance. For approval-required commands, this effective timeout is part of
the exact persisted operation before the client detaches. Human wait and process downtime consume
no active duration because only committed evidence contributes.

Artifact bytes are derived from command standard output/error, agent text, model-verifier raw
output, nested command-verifier output, and verified child totals. Derived verdict/reason/result,
approval, hash, policy, effect, sandbox, and control metadata is not charged again. Failed evidence
is charged when committed; missing evidence is zero. Child ceilings are reserved before launch,
while only the verified child tree total becomes consumed evidence and rolls up once per ancestor.
Before a nonterminal parent resumes, the application recursively re-reduces every settled child
ledger and compares the complete imported projection, so a forged terminal sequence, outcome,
result, provenance, duration, or resource total fails closed before more work starts.

These are settlement ceilings, not prepaid billing or physical-storage controls. Provider usage is
authoritative only after a response, so one response can overshoot. Flow keeps the full observation
and schedules no downstream work. External organization quotas, price catalogs, invoice
reconciliation, distributed reservation, CPU/memory/disk limits, artifact storage,
content-addressed storage, spill, download, retention, and garbage collection remain separate
capabilities. Per-run graph-node concurrency and supervisor-wide detached-worker admission are
independently bounded.

### Evaluators

The goal evaluator is a pure domain transition: it receives only a compiled criterion-to-verifier binding and authoritative node outcome metadata. It receives no prompt, transcript, filesystem handle, executor, or tool, and therefore cannot mutate the workspace or infer acceptance from implementation rationale. A terminal legacy command retains its exit-based decision. A first-class verifier projects its typed `accepted`, `rejected`, or `inconclusive` verdict directly.

The verifier executor is a separate application seam. Its command driver delegates to the existing sandboxed command executor and preserves nested evidence and side-effect uncertainty. Its model driver receives only declared durable evidence, invokes a separate Pi session with a dedicated immutable system prompt and zero tools or project discovery, and parses one bounded strict JSON verdict. The persisted contract contains Flow-owned provenance, hashes, usage, and source observations rather than Pi or provider types. Only accepted evidence succeeds the node. This isolation limits authority and context but does not make probabilistic evaluation prompt-injection-proof or equivalent to deterministic hidden checks.

## Current trust boundaries

Pi intentionally has no built-in security boundary and the host-side agent runtime still runs with the invoking user's operating-system permissions. Flow therefore distinguishes the agent-tool authorization boundary from the command containment boundary.

- Agent nodes receive only declared Flow-provided `read`, `ls`, and `edit` tools; implicit project extensions and resource discovery are disabled. Reads include an exact-byte full-file SHA-256 version. Edits require that version, preflight exact unique Unicode-scalar replacements, coordinate same-file mutations across cooperating same-host Flow processes, atomically replace one existing UTF-8 target, and protect durable/sensitive project paths at every path depth. Stale versions fail without fuzzy or three-way recovery.
- Every command node and descendant executes inside SRT on Linux or macOS. Flow preserves argv boundaries through an audited POSIX encoder, passes an explicit environment allowlist, denies network and undeclared Unix sockets, and protects the actual run-store path. Linux execution canonically resolves and re-exposes only SRT's required seccomp helper read-only when the harness installation is outside the selected workspace.
- Missing dependencies, seccomp degradation, unsupported platforms, initialization errors, and invalid launch descriptors fail closed with no command spawn. There is no unsandboxed fallback.
- Each new command result records the backend, exact backend version, named profile, and semantic policy digest. Backend and profile values use bounded machine identifiers rather than an SRT-only persisted union, preserving the event shape for future adapters. Older ledgers remain readable because the added evidence field is optional during replay.
- Approval-required commands persist the exact executable, argv, normalized working directory,
  timeout, digest, request, and grant lifetime before a start. A grant authorizes only that scheduler
  transition; it neither expands the sandbox profile nor predicts every transitive process effect.
- Graph approval requests persist the exact prompt and ordered hashes of complete durable evidence.
  Approval completes only that pure node; it grants no execution, tool, sandbox, or policy authority.
- Run budgets constrain scheduler admission and effective timeouts, but they are not a sandbox,
  provider-side reservation, account quota, or guarantee that one in-flight response cannot exceed
  its remaining reported-cost allowance.
- Supervisor metadata and random worker tokens coordinate processes belonging to one local account.
  They do not defend against that same operating-system user or root, and no TCP or remote control
  endpoint is exposed.
- Operator/project capacity configuration can bound detached workers and queue depth, but it is not
  process containment, a provider quota, or a run resource budget. Projects may narrow an operator
  ceiling and cannot widen it.

Native sandboxing is not equivalent to a microVM. SRT is a beta dependency built on Seatbelt on macOS and bubblewrap, namespaces, and seccomp on Linux. Kernel or sandbox-runtime vulnerabilities remain outside Flow's enforcement model, and the host-side Pi process is not contained by this command adapter. Hostile workloads still require a reviewed container, microVM, Gondolin, OpenShell, or managed isolation boundary.

The application-level workspace broker prevents ordinary traversal and symlink escapes. A target-local lock prevents concurrent edits by cooperating Flow processes on the same host and recovers locks whose same-host owner has exited. It is not a distributed lease and does not make pathname authorization and use atomic against a concurrently hostile or non-cooperating process. The command sandbox reduces the authority of command descendants; it does not turn the whole harness into a complete host security boundary.

Approval remains separate from containment. OMP-style allow/prompt/deny rules can decide whether an exact operation is authorized, but authorization cannot replace containment of that operation's transitive effects. Flow currently proves that separation for deterministic command gates and evidence-bound graph gates; dynamic agent tools still require resumable session state.

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
10. Cancellation propagates to the model stream, active tool process, and children; it starts no
    later optimization decision or promotion. Candidate cleanup is replayed only after a durable
    rejection or conclusive settlement, while a pre-evaluation retained candidate remains diagnostic
    state.
11. Resource consumption and exhaustion are reproducible from Flow events without a provider transcript.
12. Supervisor health metadata cannot override, repair, or replace authoritative ledger state.
13. Every detached worker has a prior durable active reservation, and active plus queued admission
    never exceeds the effective policy.
14. A writable node cannot publish a terminal outcome while a prepared workspace effect is
    unresolved or while its terminal receipts differ from the settled effect journal.
15. A fresh attempt cannot start until the prior attempt's interruption disposition is durable and
    every recorded effect is proven not applied.
16. An unselected branch is represented by durable omission, and only its declared join may
    reconcile omitted alternatives with the selected successful terminal.
17. Every loop is finite at compile time; iteration identity, exact stop evidence, and unused
    iteration omission are replay-authoritative rather than inferred from prompts or node ids.
18. No later loop iteration starts unless the immediately prior check durably continued, and
    reaching the final bound without a stop fails closed.
19. A typed result is reproduced from durable source evidence and its closed schema during replay;
    stored canonical bytes or hashes alone never authorize publication.
20. Every child event history has one deterministic parent node attempt, exact workflow/result
    contract, independent owner, and persisted workspace provenance.
21. A child workspace is never replaced after its first durable child event, and no child result is
    imported until the workspace has a recorded cleanup disposition.
22. Only a strict invariant-preserving metric improvement can prepare candidate promotion; every
    rejected candidate leaves the parent unchanged.
23. Promotion prepare, local settlement, cleanup, check completion, and controller completion are
    distinct durable boundaries; unknown affected-path state blocks all downstream execution.
24. A later optimization candidate cannot start after the immediately prior check reaches
    stagnation, cancellation, or resource exhaustion.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid workflow or configuration | Reject with path-specific diagnostics before creating side effects |
| Result JSON is malformed, duplicated-key, non-I-JSON, oversized, too complex, truncated, or schema-incompatible | Record the exact typed side-effect-free control failure and start no dependent work |
| Result publication identity, schema, canonical value, or hash is forged | Reject replay before advancing or executing another node |
| Child source, nesting, result, wait, budget, or tree bound is invalid | Reject the root workflow before creating its ledger or workspace |
| Child ceiling exceeds an ancestor remainder | Fail the child node before workspace materialization |
| Child workspace is missing or divergent after its ledger starts | Refuse recovery; never create a replacement or infer an outcome |
| Child cleanup fails | Retain the workspace, record retained disposition, and fail the parent child node |
| Parent crashes after child terminalization | Replay the terminal child ledger, retry idempotent cleanup, and import the same evidence once |
| Candidate result is equal, worse, invariant-failing, failed, cancelled, exhausted, or has no file delta | Record rejection and stagnation; discard its workspace and leave the parent unchanged |
| Parent or an affected directory closure changed after candidate isolation | Refuse promotion before prepare and preserve the newer parent state |
| Promotion fails after prepare | Complete deterministic compensation or record unknown; never infer acceptance |
| Process exits after promotion prepare or local commit | Reconcile the exact journal and delta; do not rerun the child or reapply a proven commit |
| Persisted optimization metric, invariant, delta, settlement, cleanup, or stop claim is forged | Reject replay before any later candidate or downstream node starts |
| Condition source is truncated or incompatible | Record a typed control failure and never select a branch from partial or mismatched evidence |
| Branch or join event is forged, premature, or inconsistent | Reject replay before advancing or executing another node |
| Loop graph, check, omission, completion, or iteration order is forged | Reject replay before advancing or executing another node |
| Loop stop evidence is truncated | Record `loop_source_truncated`; execute no later iteration |
| Final loop check continues | Record `loop_limit_reached`; start no downstream work |
| Missing credentials | Fail startup or enter a durable operator-wait state |
| Provider outage or rate limit | Record the attempt and apply only the declared bounded retry or fallback policy |
| Malformed model output | Schema-reject, retry within the node budget, then block with evidence |
| Unauthorized tool request | Deny before execution and record a policy event |
| Stale or invalid edit before preparation | Reject the entire replacement before rename and record no effect event or receipt |
| Edit is prepared but fails before rename | Settle it as not applied when publication remains available; record no terminal receipt |
| Edit fails after atomic rename | Settle it as post-commit unknown when publication remains available, project an uncertain receipt, and fail the node with uncertain side-effect status |
| Settlement append rejects | Poison later publication and retain the unresolved prepared effect; do not infer an outcome from target bytes |
| Process dies between edit boundaries | Reconcile each open typed edit under its target lock; retry only an opted-in attempt whose complete replay proves every effect not applied |
| Sandbox unavailable or degraded | Fail before command spawn; never fall back to host execution |
| Sandbox cleanup failure after spawn | Fail with uncertain side-effect status; never report command success |
| Tool timeout or crash | Terminate the process tree where possible and classify side-effect uncertainty |
| Partial external mutation | Reconcile authoritative external state; compensate only when explicitly supported |
| Verification failure | Record failing or inconclusive evidence and never coerce success |
| Concurrent workspace changes | Detect baseline drift and pause before absorbing the changes |
| Crash during persistence | Recover to the last committed event and tolerate an incomplete trailing record |
| Client exits after detached acceptance | The authenticated worker continues with independent standard streams and process group |
| Supervisor exits while workers run | Workers continue; a replacement generation adopts only token-authenticated matching identities |
| Worker exits with an open attempt | Preserve ledger truth; apply the same opt-in proof gate during a later resume and never infer or retry ambiguous work |
| Duplicate detached submission | Reuse the durable immutable job/claim for the exact request or reject a conflicting request without a second worker |
| Concurrent supervisor auto-start | One startup-lock holder launches; all other clients attach to the resulting generation |
| Active capacity exhausted | Persist one FIFO queue ticket when queue capacity remains; otherwise return a durable `queue_full` rejection without retaining a workflow snapshot |
| Queued cancellation races dispatch | Serialize both transitions; either remove the queued job without creating a worker/run ledger or continue through authenticated active cancellation |
| Effective capacity changes | Reject a mismatched stateful request before mutation; require explicit shutdown after the old generation becomes idle |
| Admission ledger grows | Atomically compact a committed prefix to a replay-equivalent snapshot before transition or byte bounds are exceeded |
| Cancellation acknowledgement is lost | Reconcile the durable command record with ledger state; never blindly dispatch an uncertain mutation again |
| Oversized, malformed, or incompatible IPC | Reject the bounded frame before a mutating handler runs |
| Corrupt state or failed migration | Preserve original data, fail closed, and provide exportable diagnostics |
| Resource exhaustion | Preserve the full committed observation, append explicit exhaustion, start no downstream work, and never infer success |
| Approval grant expires unused | Execute nothing, record expiry, and return to a fresh durable request; never infer consent |
| Incompatible package | Reject or quarantine it without changing active runs |
| Agent Skill is missing, duplicated, unsafe, oversized, or changes while being snapshotted | Reject before ledger creation or detached reservation; never fall back to partial or live content |
| Agent Skill source changes after submission | Continue from the immutable submitted snapshot; do not absorb the changed source into attached, queued, child, or resumed work |
| Agent reports an undeclared selection or forged resource read | Fail the node before persisting success, or reject replay/recovery before later work starts |
| Verifier package is missing, malformed, unsafe, oversized, kind-incompatible, version-mismatched, or changes during capture | Reject the complete selection before ledger creation or detached reservation; execute no verifier |
| Live verifier manifest changes after submission | Continue from the immutable submitted snapshot; bind no live replacement during attached, queued, child, or resumed work |
| Verifier evidence reports the wrong package identity | Fail before persistence or reject replay; never infer identity from a successful driver result |

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
- Flow does not copy, export, merge, or promote changes from an ordinary child workspace; only a
  compiler-generated bounded optimization candidate may use the typed promotion saga.
- Flow does not permit arbitrary dependency cycles, nested or unbounded loops, nested
  optimization, or model-authorized acceptance.

## Architectural litmus tests

Flow is acting as a harness only when:

- Reordering workflow nodes changes execution without prompt changes.
- Removing a required edge cannot be overridden by model prose.
- Restricting a node's tools prevents undeclared calls structurally.
- Restarting after interruption identifies the same next safe node.
- A confident completion narrative cannot pass a failing deterministic check.
- Changing providers does not migrate workflow, run, or evidence schemas.
- Equivalent executions produce equivalent Flow transition ledgers across models.
