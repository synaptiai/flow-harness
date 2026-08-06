# Architecture

## Context

Flow turns a collection of useful software-development practices into an enforceable harness. The previous plugin described workflows through Markdown commands, skills, YAML metadata, and host hooks. Claude Code still owned the actual agent loop, scheduling, tool semantics, context, and session lifecycle.

The standalone harness reverses that relationship. Flow owns workflow execution and delegates only bounded node work to an embedded agent runtime.

This document describes the target architecture unless a section is explicitly labeled as the initial executable slice. The delivery roadmap is the source of truth for implementation status. Gate 1 currently provides `validate`, sequential `run`, `inspect`, command and bounded Pi agent nodes, cancellation, and replayable local event ledgers. Initialization, the TUI/daemon, resume, approvals, evaluators, packages, loops, and the policy broker remain later gates.

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

Implements one Flow-owned `AgentExecutor` port. It creates node-scoped sessions, selects models and tools, streams events, supports cancellation, and translates all Pi values into Flow contracts.

### Tool broker

Normalizes tool requests, classifies authority, obtains exact approvals, applies timeouts and sandbox controls, captures output, and records side-effect certainty. Tool implementations cannot mutate scheduler state.

### Event and evidence store

Persists transitions before the scheduler advances. Model transcripts are optional diagnostic artifacts; they are never authoritative for graph position or completion.

### Evaluators

Run deterministic verification first. An LLM evaluator, when unavoidable, receives evidence rather than the implementation transcript and has no workspace mutation tools.

## Initial trust boundary

Pi intentionally has no built-in sandbox and normally runs with the invoking user's operating-system permissions. Flow's first executable slice is therefore a local, trusted-workspace harness—not a security boundary.

Until an enforceable sandbox lands:

- Agent nodes receive only Flow-provided tools; implicit project extensions and resource discovery are disabled.
- The Pi adapter registers exact Flow-owned `read` and `ls` tool definitions, confines canonical paths to the execution workspace, and disables Pi's built-in tools. It does not yet route individual calls through the future general-purpose policy broker.
- Verification commands use explicit argument arrays and never shell command strings.
- Workflow validation can reject known-disallowed configuration, but it cannot contain a compromised process.
- Untrusted or unattended workloads must run inside an operator-provided container or stronger isolation boundary.

The later sandbox gate must isolate filesystem, process, network, credentials, and child-process authority at the operating-system or virtualization layer. It cannot be satisfied by prompts, tool names, approval UI, or worktrees alone.

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
