# Workflow specification

## Version

The first executable format uses:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
```

It is intentionally incompatible with the legacy Flow plugin format. The plugin's workflow metadata described how a host model should interpret Markdown; this format compiles directly into scheduler-owned graph state.

## Document shape

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: verify-change
  description: Optional human-readable purpose.
goal:
  apiVersion: flow.synapti.ai/v1alpha1
  kind: Goal
  metadata:
    id: verified-change
  outcome: The change passes deterministic verification.
  criteria:
    - id: tests-pass
      description: The automated tests pass.
      verifier:
        nodeId: verify
nodes:
  - id: verify
    type: command
    command:
      executable: npm
      args: [test]
```

Identifiers begin with a lowercase letter and contain lowercase letters, digits, or hyphens. Unknown fields are rejected rather than ignored. `goal` is optional for graph-only operational workflows; when present, it has its own versioned contract and fail-closed completion semantics.

## Goal and criterion contract

A goal contains a stable id, a human-readable outcome, and 1–64 uniquely identified criteria. Its complete serialized contract is capped at 256 KiB so every valid goal fits safely within the run-start event budget. Each criterion names one verifier node. The compiler rejects an unknown verifier, an agent verifier, or a verifier that is not terminal. This ensures a model response cannot be terminal proof and prevents a criterion from being accepted before later work nodes execute.

Goal and criterion text explains intent to users, but it is not executable evidence. Only the linked terminal command node controls acceptance. Reusing one terminal verifier for multiple criteria is allowed when that command deterministically checks the combined contract.

Criterion state is one of:

- `pending` — the verifier has not completed and the run is still active.
- `accepted` — the verifier completed successfully with integrity-checked command evidence.
- `rejected` — the verifier completed normally with a non-zero exit code.
- `inconclusive` — verification ended through timeout, signal, missing command evidence, or an unexpected evidence kind.
- `missing` — the run terminated before the verifier produced a decision.

Every non-missing decision records the run id, verifier node id, attempt, timestamp, and whether evidence is available. The evidence itself remains on that exact node attempt, retaining the existing size bounds and hashes. The overall goal becomes `accepted` only with a successful run and all criteria accepted; every other terminal run reports `not_accepted`.

Criterion evaluation is a pure domain operation over the captured goal and durable node outcomes. It receives no model transcript, prompt, workspace handle, process executor, or tool. Verifier commands execute under the command-sandbox contract described below, while criterion evaluation itself remains a mutation-free domain operation rather than an operating-system boundary.

## Graph rules

- A workflow contains 1–64 nodes with unique identifiers. This first-slice bound also caps aggregate in-memory evidence retained by the sequential scheduler and store.
- Exactly one node has no dependencies and is the entry node.
- Every `dependsOn` reference names another node in the same workflow.
- Self-dependencies, duplicate dependencies, and cycles are rejected.
- The scheduler considers nodes in declaration order and runs the first node whose dependencies all succeeded.
- Execution is sequential in `v1alpha1`; concurrency is not implied by independent edges.
- Every terminal node must be a command node. An agent response cannot be terminal proof.
- Compilation finishes before Flow creates a run ledger or invokes an executor.

## Run budget

`budget` is an optional strict run-wide contract:

```yaml
budget:
  maxNodeStarts: 8
  maxModelTokens: 250000
  maxCostUsd: 2.5
  maxExecutionMs: 900000
```

At least one limit is required when `budget` is present. Every value must be finite and positive.
Starts, tokens, and milliseconds are safe integers. `maxCostUsd` accepts at most six decimal places;
the compiler converts it to integer micro-USD before workflow hashing, persistence, and comparison.
Unknown fields, an empty object, zero, negative, fractional integer dimensions, unsafe integers,
non-finite values, and finer cost precision fail compilation before a run or effect exists. Omitting
`budget` retains unbounded scheduling behavior.

Run state always exposes durable `resources`: node starts, total model tokens, provider-reported
model cost in micro-USD, and active execution milliseconds. A start is counted by its committed
`node_started` event. A node outcome contributes its evidence duration rounded up to a whole
millisecond. Successful and failed agent evidence contributes available input, output, cache-read,
and cache-write tokens plus reported cost. Totals use checked safe-integer arithmetic; invalid or
overflowing evidence fails replay rather than wrapping or being ignored.

Before new work or an approval request, Flow refuses scheduling when a configured dimension is
already exhausted. Using the final permitted node start does not invalidate a graph that is already
complete. Model-token, reported-cost, and active-time consumption is settled after each node
outcome; equality or overshoot records `run_budget_exhausted`, produces terminal
`resource_exhausted` state, rejects an incomplete goal, exits code 1, and starts no downstream work.
The full observation is retained rather than clipped to the limit.

An execution budget reduces a command or agent timeout to the remaining active milliseconds.
Approval-required commands persist and display that reduced timeout in the exact operation, so a
later resume cannot gain more execution authority. Approval wait, client detachment, and process
downtime do not contribute because active time comes only from committed node evidence.

Model usage and reported cost are known only when a provider response settles. One response may
therefore exceed its remaining allowance. This contract is deterministic run admission control, not
a prepaid or invoice-authoritative billing cap. Flow does not infer pricing, convert currencies, or
reconcile provider invoices.

## Command node

```yaml
- id: verify
  type: command
  dependsOn:
    - implement
  command:
    executable: npm
    args:
      - test
    timeoutMs: 120000
```

`executable` and `args` are separate workflow values. Flow does not accept command strings, rejects NUL bytes during compilation, and preserves each argument through an audited POSIX encoder when invoking the sandbox backend. The final process launcher still uses shell parsing disabled. `timeoutMs` is a positive integer no greater than 24 hours and defaults to 60 seconds.

A command succeeds only when it exits with code zero without timing out, cancellation, or a terminating signal. Standard output and error are each capped at 32 KiB and SHA-256 hashed in the run evidence. Command argument evidence is capped at 64 KiB in total. A failed or timed-out command ends the workflow and leaves dependent nodes pending.

### Exact operator approval

A command may opt into a durable pre-execution approval gate:

```yaml
- id: deploy-preview
  type: command
  approval:
    mode: required
    grantTtlMs: 300000
  command:
    executable: npm
    args: [run, deploy:preview]
    timeoutMs: 120000
```

`mode` currently accepts only `required`. `grantTtlMs` is a positive integer no greater than 24
hours and defaults to five minutes. When the node becomes ready, Flow persists
`command_approval_requested` and returns `waiting_for_approval` before `node_started`, sandbox
preparation, process spawn, or dependent execution. The request records the run, workflow, node,
attempt, request id, grant lifetime, and exact `process.execute` operation: normalized absolute
working directory, executable, ordered arguments, and command timeout. SHA-256 binds that operation.

Inspect and decide from a later client:

```sh
flow inspect <run-id>
flow approve <run-id> <request-id> --actor <label>
flow resume <workflow.yaml> --run-id <run-id>
```

Approval records an append-only `command_approval_granted` event but never starts the node. The
exact starting workflow and execution directory are required at resume. `node_started` names the
request and digest that it consumes. The grant is single-use and valid only before its exclusive
`expiresAt` timestamp. An unused expired grant records `command_approval_expired`, executes nothing,
and produces a fresh request. The pending human request itself has no timeout and never implies
consent.

Denial uses `flow deny <run-id> <request-id> --actor <label> [--reason <text>]`. It records
`command_approval_denied`, fails the node with `command_approval_denied` and no evidence or side
effect, and terminates the run without a `node_started` event. Unknown, stale, duplicate,
conflicting, mismatched, or tampered decisions fail closed. Run ownership serializes competing
local clients.

The actor label is bounded explicit attribution supplied by the caller. It is not authenticated
identity, RBAC, or a signature, and the request id is not a bearer secret. This slice approves only
deterministic command nodes. In-flight Pi tool-call approval requires persisted session continuation
and is not implemented.

Every command node and descendant runs through Flow's required SRT adapter. The fixed `workspace-write-network-deny-v1` profile allows the selected workflow directory and a private temporary directory, denies network and undeclared Unix sockets, omits ambient credentials and injection variables from the child environment, and denies writes to the actual run store, `.flow`, `.git`, environment files, and key files. On Linux, Flow resolves SRT's packaged seccomp helper canonically, passes it as the explicit SRT apply path, and re-exposes only that file read-only when the Flow installation lies outside the workflow directory. If SRT is missing, unsupported, degraded, or cannot initialize, the node fails before spawn; Flow has no unsandboxed command fallback.

New command evidence records `anthropic-sandbox-runtime`, its exact installed version, the named profile, and a SHA-256 digest of the semantic policy. The field is optional only when replaying ledgers created before sandbox evidence existed.

## Agent node

```yaml
- id: analyze
  type: agent
  agent:
    prompt: Implement the requested change and leave the workspace ready for verification.
    model:
      provider: anthropic
      id: claude-sonnet-4-5
      thinking: medium
    tools:
      - read
      - ls
      - edit
    timeoutMs: 300000
- id: verify
  type: command
  dependsOn:
    - analyze
  command:
    executable: npm
    args: [test]
```

The embedded Pi adapter permits only Flow-owned `read`, `ls`, and `edit` tools. The allowlist may be empty, every name must be unique, and a tool is structurally unavailable unless declared. Every filesystem operation passes through an attempt-scoped Flow policy broker. The broker canonicalizes existing targets and the nearest existing ancestor of missing targets, rejects ordinary lexical traversal and symlink escapes, derives authority from the semantic operation rather than its Pi name, and permits only actions declared by the compiled node. `flow_ls` sorts and bounds one directory listing behind one logical `filesystem.list` authorization; it does not spend policy-decision capacity per returned entry.

`flow_read` preserves Pi's bounded paging behavior and adds a full-file version marker of the form `sha256:<64-lowercase-hex>`. The digest covers the exact bytes read, not only the displayed page. `flow_edit` accepts `path`, `expectedSha256`, and one to 32 `{oldText,newText}` replacements with at most 256 KiB of replacement text. It edits one existing regular UTF-8 file no larger than 8 MiB. Replacement strings must contain valid Unicode scalar values. Every non-empty `oldText` must occur exactly once, replacements must not overlap, and all matches are computed against the same original content. The edit fails with `stale_version` when the current full-file hash differs. It never performs fuzzy matching, snapshot recovery, or automatic merging.

After policy authorization, Flow reserves bounded evidence capacity, acquires a target-local exclusive lock, re-reads and preflights the complete request, writes a same-directory exclusive temporary file, preserves permission bits, syncs it, and rechecks the live target bytes and mode. While still holding the lock and before rename, it syncs a `node_effect_prepared` event containing an event-derived identity, attempt-local sequence, canonical target, operation digest, before/after hashes, and mode. Only then may it atomically rename. After directory sync it settles committed; a post-prepare failure before rename settles not applied; a failure after rename settles unknown when publication remains available. The lock coordinates cooperating same-host Flow processes: a live owner produces `target_busy`, an exited same-host owner is recoverable, and corrupt or foreign-host ownership fails closed. The run store, `.flow` and `.git` segments at any path depth, environment files, private-key names and suffixes, outside paths, and canonical symlink escapes are protected. Pre-prepare failure leaves the target unchanged without an effect event. A later provider failure retains committed receipts and cannot be classified as side-effect-free.

The lock is a cooperative local coordination mechanism, not a security boundary or distributed lease. This application-level check is not atomic against a concurrently hostile process changing path components after canonical authorization; the current release retains its trusted-workspace requirement until agent/tool process isolation lands. Pi's built-in tools are disabled, so Flow does not inherit Pi's fuzzy edit rules, direct-write semantics, or optional executable-download behavior. Pi extensions, skills, prompt templates, themes, context files, and project discovery are disabled for the node session. `timeoutMs` is Flow-owned, defaults to five minutes, and is limited to 24 hours. Agent output is capped at 64 KiB; the ledger retains the bounded text, the complete SHA-256 stream hash, truncation status, ordered policy decisions, and ordered effect receipts, and classifies overflow as `pi_agent_output_limit`. Cancellation aborts the active Pi session; only Pi's terminal `stop` reason is accepted as node success. After timeout or operator cancellation, Flow permits a bounded adapter cleanup grace and waits for both the provider runner and active effect reservations. A runner or effect that still does not settle produces `pi_agent_timeout` or `pi_agent_aborted` with uncertain side-effect status rather than blocking the scheduler indefinitely. Closed audits deny late authorization or receipt publication.

Command nodes are supported on Linux and macOS. Flow rejects them before spawning on Windows until the command adapter can contain and terminate the full descendant process tree.

An agent node succeeds when its bounded Pi session settles normally. Its text becomes diagnostic evidence. It cannot name the next node, mark acceptance criteria complete, or terminate the workflow successfully without a downstream command verifier.

Provider credentials remain outside workflow files and use Pi's configured credential runtime. Provider and model identifiers are execution configuration; no Pi type appears in the compiled or persisted Flow contracts.

The Pi adapter calls the pinned session's `getSessionStats()` after prompt settlement and translates
the four token components and reported cost into the Flow-owned usage shape. It preserves available
usage on successful, terminal-error, timeout, and cancellation outcomes. A failure before a session
or provider observation records no invented usage. Invalid statistics fail before persistence.

## Run ledger

Each run is stored at:

```text
.flow/runs/<run-id>/events.jsonl
```

Events have a version, contiguous sequence number, timestamp, run identity, workflow identity, workflow API version, and SHA-256 digest of the compiled workflow. New `run_started` events also capture the normalized execution directory, every command approval requirement, and the exact compiled budget when declared. When declared, the compiled goal is captured in `run_started`, so replay and inspection never need the original workflow file. A writable `node_started` declares `flow.effects/v1`; its attempt may append at most 32 prepared effects and exactly one settlement per effect. Agent evidence retains at most 64 policy decisions. Each decision has a contiguous attempt-local sequence, exact run/workflow/node/attempt attribution, derived authority, semantic action, canonical target of at most 1024 UTF-8 bytes, allow/deny reason, and SHA-256 request digest. Write decisions also retain the exact operation digest. Agent evidence retains at most 32 edit effect receipts with the same attribution, canonical target, operation digest, before/after SHA-256 values, and committed or uncertain outcome. Terminal events are illegal while an effect is unresolved. Every prepared effect, including a not-applied effect, must match a distinct allowed write decision. Receipts must exactly project committed and unknown settlements; not-applied settlements produce no receipt. The journal is a lower bound on terminal failure classification: an unknown settlement requires `uncertain`, a committed settlement forbids `none`, and provider or cleanup uncertainty may remain `uncertain` when the journal alone would permit `none` or `committed`. Replay verifies effect identity and order, settlement legality, decision and receipt order, attribution, classification, hashes, request digests, prepared-effect authorization, resource arithmetic, and exact exhaustion values. Older ledgers whose node starts do not declare the effect protocol retain their historical terminal-receipt contract. Approval replay separately verifies the declared requirement, budget-bounded exact operation digest, sequence-derived request identity, grant lifetime, actor, expiry, and single consumed start. A single serialized JSONL event is capped at 2 MiB. The ceiling includes worst-case JSON escaping at the documented decision, effect, receipt, target, output, and error bounds.

Fresh and recovered execution publish complete ownership metadata atomically before appending. The metadata contains a process ID and random token. A live process blocks another claimant; an exited owner can be moved aside atomically; corrupt or incomplete ownership metadata fails closed. This provides exclusive same-host execution, not a distributed lease. Creating `events.jsonl` still atomically grants a fresh run identifier. The ledger's run ID must match its directory name.

Node-start events are synced before an executor is invoked. Node-result events are synced before the scheduler advances. Owner appends validate one transition against cached reduced state instead of rereading history. Each append syncs the file, and every newly created run-directory ancestor is synced where the platform supports directory handles. A valid or invalid unterminated trailing JSONL fragment is treated as uncommitted and truncated before a later append; corruption in an earlier committed record fails closed.

The reducer accepts only legal state transitions and reconstructs `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`, or `resource_exhausted` run state together with immutable resources, budget, goal, criterion, and current command-approval state. Cancellation before a run claim creates no ledger. Cancellation during a node becomes a failed node attempt while retaining any settled evidence; cancellation between attempts appends `run_cancelled` without starting more work unless committed evidence already exhausted a settlement limit or a start limit already prevents pending work. In either exception, durable `resource_exhausted` state takes precedence. A valid recovery appends `run_resumed`, preserves committed node outcomes and approval state, skips successful nodes, and either continues the next ready pending node, returns to an operator wait, or finalizes a committed failure or exhausted settlement. Model transcripts and implementation rationale are never consulted during replay.

## Foreground and detached execution

Execution mode is not part of workflow semantics. The same compiled graph, scheduler, executor,
ledger, approvals, budgets, and recovery rules apply whether `run` or `resume` stays attached to the
CLI or uses `--detach`. Detached submission stores the exact workflow source and normalized
execution directory in an immutable job record; it never defers compilation to a mutable file path.
The supervisor first reserves bounded capacity or assigns a durable FIFO ticket. A queued job has no
run owner or worker until it is dispatched; queue-full rejection retains no executable snapshot.
One authenticated worker then owns one normal application run. Supervisor health and admission
state cannot advance the graph or override ledger state.

`--command-id <uuid>` is an execution-control option, not workflow input. It lets an automation
retry the exact detached submission or cancellation after losing a response. The supervisor binds
the id to the complete request and rejects reuse with changed input.

## Current limitations

- No loop, retry, conditional, parallel, fork/join, general approval-node, or child-run semantics. Approval is currently available only as a deterministic command pre-start gate.
- No automatic retry or reconciliation of an interrupted node attempt; a durable start without an outcome blocks recovery even when its typed edit journal narrows the possible filesystem state.
- Detached workers can be adopted by a replacement local supervisor, but they cannot move between
  hosts and do not survive host reboot.
- The SRT profile is fixed; workflows cannot yet request network, credential injection, or a different sandbox backend.
- The native sandbox contains command descendants but does not contain the host-side Pi runtime; hostile workloads require a stronger container, microVM, or managed boundary.
- The only agent mutation is exact single-file edit of an existing UTF-8 file; no create, delete, rename, shell, network, fuzzy patch, or multi-file transaction is exposed.
- No in-flight Pi tool-call approval or opaque session continuation; restarting a model node is not a safe substitute.
- No probabilistic or LLM evaluator; criteria currently bind only to deterministic terminal command nodes.
- No prepaid hard model-cost cap, provider invoice reconciliation, CPU/memory/disk quota, graph-node concurrency budget, or artifact-size budget. Detached worker count and queue depth are independently bounded by supervisor policy.
- No schema migration path is promised while the format remains `v1alpha1`.
