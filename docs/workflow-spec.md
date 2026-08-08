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
concurrency:
  maxNodes: 2
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
    type: verifier
    verifier:
      kind: command
      command:
        executable: npm
        args: [test]
```

Identifiers begin with a lowercase letter and contain lowercase letters, digits, or hyphens. Unknown fields are rejected rather than ignored. `goal` is optional for graph-only operational workflows; when present, it has its own versioned contract and fail-closed completion semantics.

## Goal and criterion contract

A goal contains a stable id, a human-readable outcome, and 1–64 uniquely identified criteria. Its complete serialized contract is capped at 256 KiB so every valid goal fits safely within the run-start event budget. Each criterion names one verifier node. The compiler accepts a terminal command or first-class verifier node and rejects an unknown, agent, control, or non-terminal binding. This prevents a criterion from being accepted before later work nodes execute.

Goal and criterion text explains intent to users, but it is not executable evidence. Only the linked terminal command or verifier outcome controls acceptance. Reusing one terminal verifier for multiple criteria is allowed when it checks the combined contract. Deterministic command verification remains preferred for release claims; a model verdict proves only its declared evidence and rubric.

Criterion state is one of:

- `pending` — the verifier has not completed and the run is still active.
- `accepted` — the verifier completed with integrity-checked accepted evidence.
- `rejected` — a command verifier exited normally non-zero or a model verifier returned a strict rejected verdict.
- `inconclusive` — verification ended through timeout, signal, missing/truncated evidence, invalid model output, provider/runtime uncertainty, or cancellation.
- `missing` — the run terminated before the verifier produced a decision.

Every non-missing decision records the run id, verifier node id, attempt, timestamp, and whether evidence is available. The evidence itself remains on that exact node attempt, retaining the existing size bounds and hashes. The overall goal becomes `accepted` only with a successful run and all criteria accepted; every other terminal run reports `not_accepted`.

Criterion evaluation is a pure domain operation over the captured goal and durable node outcomes. It receives no model transcript, prompt, workspace handle, process executor, or tool. Verifier commands execute under the command-sandbox contract described below, while criterion evaluation itself remains a mutation-free domain operation rather than an operating-system boundary.

## Graph rules

- A workflow contains 1–64 nodes with unique identifiers. This bound also caps aggregate in-memory evidence retained by the scheduler and store.
- Exactly one node has no dependencies and is the entry node.
- Every `dependsOn` reference names another node in the same workflow.
- Self-dependencies, duplicate dependencies, and cycles are rejected.
- The scheduler considers pending nodes in declaration order and applies the first legal transition whose dependencies are terminal. Ordinary work requires successful dependencies; omission propagates through ordinary descendants; an explicit join reconciles the selected success with omitted alternatives.
- Independent ready executable nodes may overlap only when `concurrency.maxNodes` explicitly permits it; omission preserves the sequential maximum of one.
- Every terminal node must be a command, child, verifier, or result node. An ordinary agent response cannot be terminal proof. A terminal result completes an operational graph but cannot satisfy a goal criterion.
- Compilation finishes before Flow creates a run ledger or invokes an executor.

## Typed result node

A `result` node converts one complete durable evidence field into provider-neutral typed data:

```yaml
- id: produce
  type: command
  command: { executable: node, args: [scripts/measure.mjs] }
- id: publish
  type: result
  dependsOn: [produce]
  result:
    source: { nodeId: produce, field: command.stdout }
    schema:
      type: object
      properties:
        accepted: { type: boolean }
        score: { type: integer, minimum: 0, maximum: 10 }
      required: [accepted, score]
```

The source must be a direct dependency and its field must match the successful source node. Valid
fields are `command.stdout`, `command.stderr`, `agent.text`, `verifier.verdict`,
`verifier.reason`, and `result.value`. A truncated command or agent field fails with
`result_source_truncated`; Flow never parses partial evidence.

The result schema is a closed Flow-owned subset, not an open-ended JSON Schema dialect. It supports
`null`, `boolean`, finite `number` with optional inclusive bounds, safe `integer` with optional
inclusive bounds, `string` with required `maxLength`, `array` with required `items` and `maxItems`,
and `object` with identifier-keyed `properties` plus an optional unique `required` subset. Objects
reject undeclared properties. Schemas have at most 8 levels, 128 nodes, 128 properties per object,
and 65,536 serialized UTF-8 bytes. `maxItems` is at most 16,383, string length is measured in Unicode
code points and capped at 262,144, and integer bounds must remain within JavaScript's safe range.

Source parsing is strict and fail-closed. Flow rejects trailing input, duplicate JSON object keys
including escape-equivalent spellings, non-finite IEEE-754 values, unpaired Unicode surrogates, and
schema mismatches. Values have at most 64 levels, 16,384 nodes, and 262,144 canonical UTF-8 bytes.
After validation, Flow applies RFC 8785 JSON Canonicalization Scheme ordering and ECMAScript value
serialization. The resulting canonical JSON is the exact `result.value` observed by downstream
nodes.

`node_result_published` durably binds the result node and attempt to the source node, source attempt,
source field, source hash, normalized schema digest, canonical value, and value hash. Replay reads
the original durable source, validates and canonicalizes it again, and rejects any changed identity,
classification, bytes, or hash. The node is resource-neutral: it emits no `node_started`, invokes no
executor, and consumes no start, model-token, reported-cost, or active-time budget.

A typed result is not a verifier verdict. Goal criteria remain bound to terminal command or verifier
nodes. Results instead provide a stable data boundary for exact conditions, evidence-bound
approvals, model-verifier inputs, loop checks, inspection, detached execution, and child-run
composition.

## Isolated child workflow node

A `child` node embeds one complete workflow and names its typed result boundary:

```yaml
- id: delegate
  type: child
  dependsOn: [prepare]
  child:
    resultNodeId: publish
    workflow: |
      apiVersion: flow.synapti.ai/v1alpha1
      kind: Workflow
      metadata: { id: delegated-analysis }
      budget:
        maxNodeStarts: 8
        maxModelTokens: 100000
        maxCostUsd: 1
        maxExecutionMs: 300000
      nodes:
        - id: analyze
          type: agent
          agent:
            prompt: Analyze the isolated candidate.
            model: { provider: anthropic, id: claude-sonnet-4-6 }
            tools: [read, ls, edit]
        - id: publish
          type: result
          dependsOn: [analyze]
          result:
            source: { nodeId: analyze, field: agent.text }
            schema: { type: string, maxLength: 65536 }
```

The embedded source is a non-empty YAML string of at most 1 MiB. Flow recursively compiles and
freezes it before creating the parent ledger. A child must declare all four budget dimensions and
name an existing, unconditional, terminal `result` node. Human `approval` nodes and
approval-required commands are rejected because a descendant cannot suspend the root tree for
interactive input. Child nesting is limited to four levels, and the complete recursively compiled
tree is limited to 1,024 nodes. These are compile-time tree limits in addition to each workflow's
ordinary 64-source-node and 256-expanded-node limits.

`node_started` derives one deterministic child run id from the parent run id, child node id, and
attempt. It persists that id together with the child workflow/schema digests before materializing a
workspace. The production backend creates an owner-only copy-on-write clone where supported and
falls back to an ordinary copy. It includes dirty and untracked content, modes, and symbolic links
without following them; excludes `.flow` and every protected run-store path; refuses sockets,
devices, and FIFOs; and applies default ceilings of 200,000 entries and 10 GiB of logical file
content. Each copied regular file is hash-checked and rejected if its source identity changes during
copy. This portable backend is content-verified isolation from parent mutations, not an atomic
filesystem snapshot or security boundary.

The child executes the same Flow compiler, scheduler, policy, sandbox, executors, cancellation
signal, and recovery rules in its isolated working directory, but writes a separate JSONL history.
Its `run_started` event binds snapshot backend/digest and exact parent linkage. On terminal success,
the parent discards the workspace and records the child terminal sequence, canonical result,
resource totals, duration, snapshot digest, and cleanup disposition. A successful child requires a
valid result and confirmed discard. Failed, cancelled, and exhausted children retain linked
evidence and fail the parent child node. Cleanup failure retains the workspace and fails closed.
Child changes are never copied back, exported, merged, or promoted in this contract.

Every child ceiling is reserved against the parent's remaining bounded budget before the workspace
exists; sibling reservations are aggregated within a wave. Actual child starts, model tokens,
reported cost, and active time are then added to every ancestor, while the parent child node's own
start is counted separately. Downstream results, conditions, approvals, loop checks, and model
verifiers consume the imported canonical value as `result.value` with its original hash.

Ready siblings may share a child-only scheduler wave, so their parent snapshot is not interleaved
with a parent-workspace executor. Backends may impose a narrower execution limit. In particular,
the current process-global SRT backend shares same-workspace sessions but serializes incompatible
child-workspace command sessions through reset/reinitialize; it does not reject the second child.
Agent/model work and alternate future sandbox backends can still overlap under the declared
`concurrency.maxNodes` limit.

Recovery treats the child ledger as the execution commit marker. If no child event exists, Flow may
discard a stale pre-ledger workspace and recreate the deterministic child. A nonterminal ledger
must reopen the exact manifest and snapshot digest and then satisfy normal child recovery; missing
or divergent workspace state produces `child_recovery_ineligible`. A terminal child ledger is
authoritative even when cleanup completed before the parent outcome append, and cleanup is
idempotently retried. Flow never silently replaces a workspace after a child event exists.

## Exact conditions and explicit joins

```yaml
- id: classify
  type: command
  command: { executable: node, args: [scripts/classify.mjs] }
- id: route
  type: condition
  dependsOn: [classify]
  condition:
    source: { nodeId: classify, field: command.stdout }
    cases:
      - { id: needs-work, equals: "needs-work\n" }
    default: already-clean
- id: implement
  type: agent
  dependsOn: [route]
  when: { conditionId: route, case: needs-work }
  agent:
    prompt: Implement the requested change.
    model: { provider: anthropic, id: claude-sonnet-4-5 }
- id: verify-change
  type: command
  dependsOn: [implement]
  command: { executable: npm, args: [test] }
- id: inspect-clean
  type: command
  dependsOn: [route]
  when: { conditionId: route, case: already-clean }
  command: { executable: node, args: [--version] }
- id: converge
  type: join
  join:
    conditionId: route
    branches:
      - { case: needs-work, nodeId: verify-change }
      - { case: already-clean, nodeId: inspect-clean }
- id: verify-final
  type: command
  dependsOn: [converge]
  command: { executable: npm, args: [test] }
```

A condition reads one complete durable evidence field from a direct dependency, including
`command.stdout`, `command.stderr`, `agent.text`, accepted verifier fields, or `result.value`. Cases
are checked in declaration order by exact string equality; `default` names the selected case when
no exact value matches. Case identifiers and
exact values are unique, every case has guarded work, and each condition has exactly one explicit
join. Conditions do not execute JavaScript, JSONPath, regular expressions, clocks, random values,
network calls, model callbacks, or mutable workspace reads.

`when` is valid only on a non-join node, references a condition that is also a direct dependency,
and names one of that condition's cases. When a different case is selected, the node becomes
`omitted` without a start or executor call. Omission propagates through ordinary dependencies. A
join maps every case to one terminal node in that case's branch; its compiled `dependsOn` list is
derived from those mappings. It succeeds only after the selected terminal succeeded and every
unselected terminal was omitted. Cross-case dependencies, incomplete branch terminals, ambiguous
joins, and derived cycles fail compilation.

The serialized persisted control-graph projection is capped at 512 KiB across the workflow; both
compilation and event parsing measure its actual JSON UTF-8 bytes. This leaves bounded room in the
2 MiB run-event envelope for goal, budget, approval, and recovery metadata.

The source field must be untruncated. Truncated output records a typed, non-retryable,
side-effect-free control failure and terminates the run rather than making a partial-data decision.
Condition and join transitions use logical attempt 1 but produce no `node_started` event, consume no
node-start budget, and never reach a command or agent executor. They are scheduling barriers: an
executable wave quiesces before the next condition or join transition. Conditions do not provide
arbitrary expression evaluation.

## Replay-safe bounded loops

A top-level `loop` contains a local command/agent/verifier DAG and an exact stop contract:

```yaml
- id: repair
  type: loop
  dependsOn: [prepare]
  loop:
    maxIterations: 4
    until:
      source: { nodeId: check, field: command.stdout }
      equals: pass
    body:
      nodes:
        - id: fix
          type: agent
          agent:
            prompt: Repair the failing implementation.
            model: { provider: anthropic, id: claude-sonnet-4-6 }
            tools: [read, ls, edit]
        - id: check
          type: command
          dependsOn: [fix]
          command: { executable: npm, args: [test, --, --run] }
```

`maxIterations` is an integer from 1 through 32. The body has 1–16 non-loop nodes, exactly one
local entry, local dependencies, and the same condition/branch/join rules as a top-level graph.
Nested loops, cross-scope references, body cycles, and a stop source that is conditional or not
awaited on every successful body path fail compilation. The source is complete durable command,
agent, accepted verifier, or `result.value` evidence; comparison is exact and does not normalize
whitespace. Truncated evidence fails with `loop_source_truncated`.

Compilation creates one qualified body instance and one pure check for every possible iteration,
then retains the author-facing id as a pure controller. For example,
`repair--i3--node--fix` identifies template `fix` in iteration 3. The expanded plan remains acyclic,
contains at most 256 total nodes, uses durable ids no longer than 128 characters, and persists a
control-graph projection no larger than 512 KiB. A check records source node, attempt, field, hash,
and `continue` or `stop`. Iteration 2 and later require the prior check's durable `continue` and
never overlap an earlier iteration; ordinary `concurrency.maxNodes` still applies inside the active
body.

The first `stop` durably omits every unused instance and succeeds the controller. If the final
check continues, the controller fails with `loop_limit_reached`, and downstream work never starts.
If an enclosing condition branch is not selected, omitted body checks propagate dependency
omission through the controller; branch omission is never misclassified as bound exhaustion.
Checks, omissions, and controller completion consume no start/token/cost/active-time budget.
Executable instances retain existing approval, budget, cancellation, effect, and fresh-recovery
contracts. Loop iteration and retry attempt are separate: attempt 2 of an interrupted
`repair--i3--node--fix` remains iteration 3.

This contract does not provide arbitrary graph cycles, nested or unbounded loops, dynamic maps,
numeric optimization direction, stagnation detection, workspace snapshots, accept-best behavior,
or rollback. Those require an optimization contract that promotes and compares isolated child
candidates; the current child contract always discards workspace changes.

## Bounded node concurrency

`concurrency` is an optional strict per-run contract:

```yaml
concurrency:
  maxNodes: 2
```

`maxNodes` is an integer from 1 through 32. Unknown fields, an empty object, zero, fractional
values, and values above 32 fail compilation. Omitting the field preserves the legacy compiled
shape and digest and gives the run an effective maximum of one. This limit controls executable
command, agent, and verifier nodes inside one workflow; it is independent of detached-supervisor worker
capacity.

Flow schedules deterministic quiescent waves. It scans legal transitions in workflow declaration
order and durably appends starts until capacity is full or it reaches a condition, join, approval,
budget, or terminal barrier. Only then are the admitted executors invoked concurrently. The
scheduler awaits all admitted promises and pending effect-event publication, then appends node
outcomes in admission/declaration order. Thus real completion and streamed effect events may
interleave, while authoritative outcomes and downstream readiness remain stable across runs.

After any admitted node fails, Flow admits no new work. Already-running siblings are allowed to
settle, and the declaration-order first failed member becomes the run's primary failure. Operator
cancellation likewise settles the complete wave and records the exact ordered cancelled-node set.
A settlement resource ceiling may be crossed by the combined wave; Flow retains all observations,
terminalizes as `resource_exhausted`, and schedules no later node. A node-start ceiling is checked
before each admission.

Concurrency does not isolate ordinary branches that share the parent workspace. Authors must encode
causal dependencies for operations that cannot safely overlap or move the work into explicit child
nodes. It applies inside one active bounded-loop body, but iterations remain sequential. Dynamic
fan-out and per-target conflict inference are not part of this contract.

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

An execution budget reduces a command, agent, or verifier-driver timeout to the remaining active milliseconds.
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

## Approval node

An approval node pauses graph advancement over exact completed evidence:

```yaml
- id: review-plan
  type: approval
  dependsOn: [plan, verify-plan]
  approval:
    prompt: Approve this verified implementation plan.
    evidence:
      - { nodeId: plan, field: agent.text }
      - { nodeId: verify-plan, field: command.stdout }
```

`prompt` is trimmed, non-empty, and at most 4096 characters. `evidence` contains one through sixteen
ordered unique `(nodeId, field)` declarations. Each source must be a direct dependency and have a
compatible field: command nodes expose `command.stdout` and `command.stderr`; agent nodes expose
`agent.text`; accepted verifier nodes expose `verifier.verdict` and `verifier.reason`; result nodes
expose `result.value`. Conditions, loop checks, and model verifiers use the same typed source
compatibility. The node may be
condition-guarded or appear in a bounded loop body under the same
finite graph rules as other guarded control nodes.

When ready, Flow requires every declared source to have complete successful durable evidence. It
persists `workflow_approval_requested` with a versioned snapshot of the run, workflow digest, node,
logical attempt one, prompt, and ordered source node, attempt, field, and hash. A dedicated SHA-256
digest binds that snapshot. Any truncated source instead produces
`workflow_approval_evidence_truncated`, a side-effect-free non-retryable control failure; no request
is shown to an operator.

The existing `flow approve` and `flow deny` commands route by the current pending request type.
`workflow_approval_approved` immediately succeeds the pure control node and
`workflow_approval_denied` immediately fails it. Neither emits `node_started`, invokes an executor,
or consumes execution budget. Unlike command approval, there is no grant, TTL, expiry, or later
consumption because the decision and graph transition are one committed event. The decision grants
no command, model-tool, sandbox, credential, or policy authority. Resume remains a separate explicit
operation using the exact workflow.

## Verifier node

A first-class verifier makes evaluation intent and authority explicit. It is a guarded executable
node, may appear inside a bounded loop body, and uses one strict driver:

```yaml
- id: verify-tests
  type: verifier
  dependsOn: [implement]
  verifier:
    kind: command
    command: { executable: npm, args: [test], timeoutMs: 120000 }

- id: review-evidence
  type: verifier
  dependsOn: [plan, verify-tests]
  verifier:
    kind: model
    prompt: Decide whether the declared evidence proves the plan is correct.
    evidence:
      - { nodeId: plan, field: agent.text }
      - { nodeId: verify-tests, field: verifier.reason }
    model: { provider: anthropic, id: claude-sonnet-4-5, thinking: medium }
    timeoutMs: 120000
```

The command driver reuses the production sandbox. Exit zero is `accepted`; a normal non-zero exit
is `rejected`; timeout, signal, containment failure, missing evidence, or runtime uncertainty is
`inconclusive`. The wrapper retains the bounded command evidence and never weakens its conservative
side-effect status.

The model driver requires 1–16 ordered unique fields from direct dependencies. Flow resolves the
exact successful source attempts from durable state and refuses truncated inputs. It renders the
author rubric and canonical evidence records inside explicit untrusted-data delimiters, caps the
complete UTF-8 input at 262144 bytes, and invokes Pi with a dedicated verifier system prompt, no
tools, extensions, skills, templates, context files, or project discovery. The response is capped
at 16384 bytes and must be exactly one JSON object with only `verdict` and `reason`; duplicate keys,
extra prose, Markdown fences, unknown fields, invalid verdicts, or an empty/oversized reason become
`inconclusive`.

Verifier evidence records the driver, verdict, bounded reason and hash, duration, ordered source
node/attempt/field/hash observations, and command or model provenance. Model evidence also retains
bounded raw output, its complete hash/truncation state, and available Flow-owned usage. Only
`accepted` may produce `node_succeeded`; `rejected` and `inconclusive` fail the node and current run,
so no dependent is released. Cancellation overrides a late accepted result. Replay validates the
declaration, provenance, source identities, hashes, strict raw response, verdict/outcome pairing,
failure classification, and resources without consulting a provider.

The separate zero-tool session and delimiters reduce accidental instruction following; they do not
make a probabilistic verifier prompt-injection-proof or equivalent to hidden deterministic tests.
Command-verifier approval, external verifier packages, remediation edges, fallback, and automatic
retry of an interrupted verifier are not part of this contract.

Every command node and descendant runs through Flow's required SRT adapter. The fixed `workspace-write-network-deny-v1` profile allows the selected workflow directory and a private temporary directory, denies network and undeclared Unix sockets, omits ambient credentials and injection variables from the child environment, and denies writes to the actual run store, `.flow`, `.git`, environment files, and key files. Concurrent same-policy commands share one initialized SRT session but receive distinct temporary directories, environment values, and per-command filesystem configurations. Flow reference-counts wraps, queues a different concurrent workspace or policy until the active session resets, honors cancellation while queued, and resets SRT only after the last compatible command releases. On Linux, Flow resolves SRT's packaged seccomp helper canonically, passes it as the explicit SRT apply path, and re-exposes only that file read-only when the Flow installation lies outside the workflow directory. If SRT is missing, unsupported, degraded, or cannot initialize, the node fails before spawn; Flow has no unsandboxed command fallback.

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
    recovery:
      mode: fresh
      maxAttempts: 3
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

`recovery` is optional and is accepted only on agent nodes. The only current mode is `fresh`.
`maxAttempts` includes the initial attempt, is required when recovery is present, and must be an
integer from 2 through 16. No default object is inserted: omission means an interrupted open attempt
is never retried automatically.

Fresh recovery is evaluated only when `resume` finds a durable `node_started` without a node
outcome. Flow starts a new in-memory Pi session from the original prompt and current workspace; it
does not reopen the interrupted transcript, continue a dangling tool call, or reuse provider stream
state. Read-only attempts qualify only with no effect protocol and no effects. An edit-capable
attempt qualifies only when it declared `flow.effects/v1` and every effect is proven not applied by
executor settlement or recovery reconciliation. Any committed, applied, unknown, open, or legacy
writable state blocks. The retry also requires an attempt below `maxAttempts` and capacity under
`maxNodeStarts`. Declared model-token, reported-cost, or active-execution limits block automatic
fresh recovery because interrupted consumption is incomplete. See [Recovery and interruption
safety](recovery.md) for the event ordering and full refusal table.

Flow disables both Pi assistant-turn retries and provider retries in the embedded session. This
keeps retry ownership at the Flow attempt layer. Normal model/tool turns inside one live session
remain possible and stay bounded by the node timeout.

Command nodes are supported on Linux and macOS. Flow rejects them before spawning on Windows until the command adapter can contain and terminate the full descendant process tree.

An agent node succeeds when its bounded Pi session settles normally. Its text becomes diagnostic
evidence. It cannot name the next node or mark acceptance criteria complete. A downstream command
or verifier must supply goal authority; a downstream result may instead terminate a graph by
publishing validated operational data.

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

Events have a version, contiguous sequence number, timestamp, run identity, workflow identity,
workflow API version, and SHA-256 digest of the compiled workflow. New `run_started` events also
capture the normalized execution directory, command approval requirements, agent recovery
requirements, declared concurrency, verifier declarations, the bounded control-graph projection, and exact compiled budget
when declared. Runs with an effective maximum above one must persist the graph even without control
nodes. The control graph persists dependency, guard, exact condition, and join mappings so replay does not
consult mutable workflow input to interpret branch history. A recovery requirement records the node,
fresh mode, maximum attempts, and whether replay requires no effect protocol or
`flow.effects/v1`. When declared, the compiled goal is also captured, so replay and inspection do
not need the original workflow file.

A child `node_started` also captures its deterministic child run id, embedded workflow digest,
result node/schema identity, and isolation backend. The child ledger's own `run_started` captures
snapshot digest and parent run/node/attempt provenance. Parent child evidence retains the terminal
child sequence, outcome, canonical result when available, imported resources, duration, workspace
digest, and discarded/retained disposition. Replay rejects mismatched linkage, forged typed values,
negative or overflowing resources, successful children without results, and successful children
whose workspaces were not discarded.

A writable `node_started` declares `flow.effects/v1`; its attempt may append at most 32 prepared
effects and at most one mutually exclusive executor settlement or recovery reconciliation per
effect. `node_attempt_interrupted` can follow a running opted-in attempt only after replay validates
the effect, attempt, and budget proof. It records fixed process-interruption, fresh-retry, and
incomplete-resource-accounting dispositions. The reducer archives the attempt number, start and
interruption timestamps, effect protocol, and immutable effects before returning the node to
pending. The next `node_started` must use the prior attempt plus one. At most `A` starts and `A-1`
interruption dispositions exist for `maxAttempts: A`.

Agent evidence retains at most 64 policy decisions. Each decision has a contiguous attempt-local
sequence, exact run/workflow/node/attempt attribution, derived authority, semantic action,
canonical target of at most 1024 UTF-8 bytes, allow/deny reason, and SHA-256 request digest. Write
decisions also retain the exact operation digest. Agent evidence retains at most 32 edit effect
receipts with the same attribution, canonical target, operation digest, before/after SHA-256 values,
and committed or uncertain outcome. Terminal events are illegal while an effect lacks an executor
settlement; a recovery observation alone does not terminalize an attempt. Every prepared effect,
including a not-applied effect, must match a distinct allowed write decision. Receipts exactly
project committed and unknown executor settlements; not-applied settlements and recovery
observations produce no receipt. Recovery reconciliation records applied, not-applied, or unknown
target state with a bounded reason and includes the observed digest/mode only for a stable regular
file. Exact and divergent observations are cross-checked against the prepared descriptor.

Replay verifies concurrency capacity and dependency readiness, declaration-ordered concurrent
outcomes and failure selection, condition source kind, attempt, field, hash, truncation, selected case, exact branch
guard, omission reason and dependencies, join coverage and selected terminal, effect identity and
order, settlement/reconciliation legality, retry eligibility,
monotonic attempt numbering, decision and receipt order, attribution, classification, hashes,
request digests, prepared-effect authorization, resource arithmetic, and exact exhaustion values.
Command approval replay separately verifies the declared requirement, budget-bounded exact
operation digest, sequence-derived request identity, grant lifetime, actor, expiry, and single
consumed start. Graph approval replay reconstructs the prompt and ordered evidence observations,
verifies their attempts, fields, hashes, completeness, request identity and digest, then validates
the exact attributable decision.
A single serialized JSONL event is capped at 2 MiB. The ceiling includes worst-case JSON escaping
at the documented decision, effect, receipt, target, output, and error bounds.

Fresh and recovered execution publish complete ownership metadata atomically before appending. The metadata contains a process ID and random token. A live process blocks another claimant; an exited owner can be moved aside atomically; corrupt or incomplete ownership metadata fails closed. This provides exclusive same-host execution, not a distributed lease. Creating `events.jsonl` still atomically grants a fresh run identifier. The ledger's run ID must match its directory name.

Node-start events are synced before an executor is invoked. Node-result events are synced before the scheduler advances. Owner appends validate one transition against cached reduced state instead of rereading history. Each append syncs the file, and every newly created run-directory ancestor is synced where the platform supports directory handles. A valid or invalid unterminated trailing JSONL fragment is treated as uncommitted and truncated before a later append; corruption in an earlier committed record fails closed.

The reducer accepts only legal state transitions and reconstructs `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`, or `resource_exhausted` run state together with immutable resources, budget, goal, criterion, and typed command or graph approval state. Cancellation before a run claim creates no ledger. Cancellation during a node becomes a failed node attempt while retaining any settled evidence; cancellation between attempts appends `run_cancelled` without starting more work unless committed evidence already exhausted a settlement limit or a start limit already prevents pending work. In either exception, durable `resource_exhausted` state takes precedence. A safe-boundary recovery appends `run_resumed`, preserves committed node outcomes and approval state, skips successful nodes, and either continues the next ready pending node, returns to an operator wait, or finalizes a committed failure or exhausted settlement. Recovery of an open typed edit first appends its observation under target coordination. It then refuses the unfinished node unless the persisted opt-in and complete replay prove every effect not applied and all attempt and resource limits permit a separate `node_attempt_interrupted` disposition. Model transcripts and implementation rationale are never consulted during replay.

## Foreground and detached execution

Execution mode is not part of workflow semantics. The same compiled graph, scheduler, executor,
ledger, approvals, budgets, and recovery rules apply whether `run` or `resume` stays attached to the
CLI or uses `--detach`. Detached submission stores the exact workflow source and normalized
execution directory in an immutable job record; it never defers compilation to a mutable file path.
The supervisor first reserves bounded capacity or assigns a durable FIFO ticket. A queued job has no
run owner or worker until it is dispatched; queue-full rejection retains no executable snapshot.
One authenticated worker then owns one root run tree, including every recursively scheduled child.
Children do not consume supervisor worker slots or re-enter FIFO admission. Supervisor health and admission
state cannot advance the graph or override ledger state. If detached resume ends in a typed
recovery refusal, its descriptor retains that code and the replayed run status; the worker slot may
end while an uncertain authoritative run remains `running`.

`--command-id <uuid>` is an execution-control option, not workflow input. It lets an automation
retry the exact detached submission or cancellation after losing a response. The supervisor binds
the id to the complete request and rejects reuse with changed input.

## Current limitations

- No arbitrary cycles, nested/unbounded/optimization loops, dynamic fan-out, general multi-condition joins, child patch promotion, terminal-failure retry, or fallback semantics. Bounded loop bodies and static ready DAG nodes can execute concurrently, but iterations are sequential, share one workspace, and are not inferred to be conflict-free. Child workflows isolate workspaces and histories but always discard their changes. Conditions and loop stops are limited to exact equality over complete durable command, agent, accepted verifier, or typed-result fields. Approval is available as deterministic command pre-start gates and pure evidence-bound graph nodes; command-verifier and dynamic in-session model-tool approval remain unavailable. Recovery is limited to proof-safe fresh agent attempts; interrupted verifier attempts are never retried automatically.
- No automatic terminalization or session continuation of an interrupted node attempt. Unconfigured or ineligible durable starts still block continuation.
- Detached workers can be adopted by a replacement local supervisor, but they cannot move between
  hosts and do not survive host reboot.
- The SRT profile is fixed; workflows cannot yet request network, credential injection, or a different sandbox backend.
- The native sandbox contains command descendants but does not contain the host-side Pi runtime; hostile workloads require a stronger container, microVM, or managed boundary.
- The only agent mutation is exact single-file edit of an existing UTF-8 file; no create, delete, rename, shell, network, fuzzy patch, or multi-file transaction is exposed.
- No in-flight Pi tool-call approval or opaque session continuation. A fresh retry is a new attempt and is allowed only by the persisted proof gate; it is not a substitute for restoring a live session.
- Model verifiers are zero-tool and evidence-bounded but remain probabilistic and not prompt-injection-proof. External verifier packages and reward/evaluation environments are not yet supported.
- No prepaid hard model-cost cap, provider invoice reconciliation, CPU/memory/disk quota, or artifact-size budget. Per-run graph-node concurrency, detached worker count, and queue depth are separate bounded controls.
- No schema migration path is promised while the format remains `v1alpha1`.
