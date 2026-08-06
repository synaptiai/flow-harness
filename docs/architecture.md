# Architecture

## Context

Flow turns a collection of useful software-development practices into an enforceable harness. The previous plugin described workflows through Markdown commands, skills, YAML metadata, and host hooks. Claude Code still owned the actual agent loop, scheduling, tool semantics, context, and session lifecycle.

The standalone harness reverses that relationship. Flow owns workflow execution and delegates only bounded node work to an embedded agent runtime.

This document describes the target architecture unless a section is explicitly labeled as the current executable slice. The delivery roadmap is the source of truth for implementation status. Gates 1 and 2 currently provide `validate`, sequential `run`, `inspect`, optional versioned goal contracts, command-bound criterion evaluation, command and bounded Pi agent nodes, cancellation, and replayable local event ledgers. Gate 3 now includes a runtime-neutral policy broker for model-requested reads and a fail-closed native sandbox for every command node. The first Gate 4 slice adds `resume` at committed node boundaries, exclusive same-host process ownership, and fail-closed refusal of uncertain open attempts. Initialization, the TUI/daemon, open-operation reconciliation, approvals, write/execute/network model tools, probabilistic evaluators, packages, graph loops, and stronger VM or managed sandbox backends remain later work.

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
    scheduler --> terminal["Succeeded, failed, blocked, cancelled, or waiting"]
```

The system contains two loops:

1. The inner agent loop lets a model use allowed tools to solve one bounded node.
2. The outer Flow loop decides readiness, transitions, retries, joins, approvals, evaluation, and termination.

The inner loop may propose a transition. It cannot authorize one.

## Components and dependency direction

```text
CLI / TUI / daemon
        |
        v
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

The current broker normalizes and canonically resolves every model-requested `read` and `ls` filesystem operation, derives its authority class, authorizes only declared operations inside the workspace, and emits bounded decisions tied to the exact run/node attempt. The domain contract already distinguishes read, write, execute, network, credential, and destructive authority without importing runtime types. Exact approval grants and broader model tools remain subsequent Gate 3 slices. Tool implementations cannot mutate scheduler state.

### Command sandbox

Every command executor depends on a Flow-owned `CommandSandbox` port. The production composition uses Anthropic Sandbox Runtime (SRT) with a fixed, versioned profile: workspace and private-temp writes are allowed; network, home-directory reads, ambient credentials, run-store writes, and writes to sensitive project state are denied. Sandbox dependency errors and degraded-security warnings fail before spawn. Cleanup must complete before a node can succeed.

The port isolates Flow from the backend. Pi's official SRT and Gondolin examples validate this tool-routing seam; Flow imports SRT as a containment primitive but owns policy, lifecycle, evidence, and failure semantics. A future Gondolin, OpenShell, or container adapter can implement the same port without changing workflow or ledger contracts.

### Event and evidence store

Persists transitions before the scheduler advances. Model transcripts are optional diagnostic artifacts; they are never authoritative for graph position or completion.

Fresh and recovered execution publish an atomic per-run ownership record containing a process ID and random token before appending. A live owner blocks competitors; an exited owner can be displaced atomically. Recovery replays the committed JSONL prefix, verifies the exact compiled workflow digest and node set, and appends `run_resumed` before continuing. A final unterminated record is uncommitted and is truncated before the recovered owner appends. Ownership is local-host coordination, not a distributed lease or security boundary.

### Evaluators

The current goal evaluator is a pure domain transition: it receives only a compiled criterion-to-verifier binding and authoritative node outcome metadata. It receives no prompt, transcript, filesystem handle, executor, or tool, and therefore cannot mutate the workspace or infer acceptance from implementation rationale. Successful command evidence accepts a criterion; normal non-zero evidence rejects it; timeouts, signals, missing evidence, and unexpected evidence kinds are inconclusive. An LLM evaluator, when later unavoidable, must receive evidence rather than the implementation transcript and have no workspace mutation tools.

## Current trust boundaries

Pi intentionally has no built-in security boundary and the host-side agent runtime still runs with the invoking user's operating-system permissions. Flow therefore distinguishes the agent-tool authorization boundary from the command containment boundary.

- Agent nodes receive only Flow-provided `read` and `ls` tools; implicit project extensions and resource discovery are disabled. The Flow policy broker denies ordinary traversal and canonical symlink escapes before reading.
- Every command node and descendant executes inside SRT on Linux or macOS. Flow preserves argv boundaries through an audited POSIX encoder, passes an explicit environment allowlist, denies network and undeclared Unix sockets, and protects the actual run-store path. Linux execution canonically resolves and re-exposes only SRT's required seccomp helper read-only when the harness installation is outside the selected workspace.
- Missing dependencies, seccomp degradation, unsupported platforms, initialization errors, and invalid launch descriptors fail closed with no command spawn. There is no unsandboxed fallback.
- Each new command result records the backend, exact backend version, named profile, and semantic policy digest. Backend and profile values use bounded machine identifiers rather than an SRT-only persisted union, preserving the event shape for future adapters. Older ledgers remain readable because the added evidence field is optional during replay.

Native sandboxing is not equivalent to a microVM. SRT is a beta dependency built on Seatbelt on macOS and bubblewrap, namespaces, and seccomp on Linux. Kernel or sandbox-runtime vulnerabilities remain outside Flow's enforcement model, and the host-side Pi process is not contained by this command adapter. Hostile workloads still require a reviewed container, microVM, Gondolin, OpenShell, or managed isolation boundary.

The application-level workspace broker prevents ordinary traversal and symlink escapes, but pathname authorization and use are not atomic against a concurrently hostile process. The command sandbox reduces the authority of command descendants; it does not turn the whole harness into a complete host security boundary.

Approval remains a separate concern. OMP-style allow/prompt/deny rules can decide whether an exact operation is authorized, but authorization cannot replace containment of that operation's transitive effects.

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

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid workflow or configuration | Reject with path-specific diagnostics before creating side effects |
| Missing credentials | Fail startup or enter a durable operator-wait state |
| Provider outage or rate limit | Record the attempt and apply only the declared bounded retry or fallback policy |
| Malformed model output | Schema-reject, retry within the node budget, then block with evidence |
| Unauthorized tool request | Deny before execution and record a policy event |
| Sandbox unavailable or degraded | Fail before command spawn; never fall back to host execution |
| Sandbox cleanup failure after spawn | Fail with uncertain side-effect status; never report command success |
| Tool timeout or crash | Terminate the process tree where possible and classify side-effect uncertainty |
| Partial external mutation | Reconcile authoritative external state; compensate only when explicitly supported |
| Verification failure | Record failing or inconclusive evidence and never coerce success |
| Concurrent workspace changes | Detect baseline drift and pause before absorbing the changes |
| Crash during persistence | Recover to the last committed event and tolerate an incomplete trailing record |
| Corrupt state or failed migration | Preserve original data, fail closed, and provide exportable diagnostics |
| Resource exhaustion | Apply backpressure and terminate predictably without losing committed state |
| Approval timeout | Remain in a durable wait state; never infer consent |
| Incompatible package | Reject or quarantine it without changing active runs |

## Non-goals

- Flow does not retain Claude Code plugin compatibility.
- Flow does not act as a common adapter over Claude Code, OMP, and Prime Agent.
- Flow does not fork or rebrand Pi, OMP, or Prime Agent.
- Flow does not reproduce OMP's full tool surface in the initial release.
- Flow does not make Markdown an executable orchestration language.
- Flow does not initially provide distributed or multi-host scheduling.
- Flow does not guarantee exactly-once behavior for arbitrary external side effects.
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
