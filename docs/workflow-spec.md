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
- Every terminal node must be a command, child, verifier, result, or optimization controller. An ordinary agent response cannot be terminal proof. A terminal result or optimization completes an operational graph but cannot satisfy a goal criterion.
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
        maxArtifactBytes: 1048576
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
freezes it before creating the parent ledger. A child must declare all five budget dimensions and
name an existing, unconditional, terminal `result` node. Human `approval` nodes,
approval-required commands, and agent `toolApproval` declarations are rejected because a
descendant cannot suspend the root tree for interactive input. Child nesting is limited to four
levels, and the complete recursively compiled
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
Its `run_started` event binds snapshot backend/digest and exact parent linkage. For an ordinary
child, the parent discards the workspace and records the child terminal sequence, canonical result,
resource totals, duration, snapshot digest, and cleanup disposition. Ordinary success requires a
valid result and confirmed discard. Failed, cancelled, and exhausted children retain linked
evidence and fail the ordinary parent child node. Cleanup failure retains the workspace and fails
closed. Only compiler-generated optimization candidates use a different settlement: successful
workspaces remain retained for the typed optimization check, while failed candidates are discarded
and become bounded rejection evidence rather than an automatic parent failure.

Every child ceiling is reserved against the parent's remaining bounded budget before the workspace
exists; sibling reservations are aggregated within a wave. Actual child starts, model tokens,
reported cost, active time, and artifact bytes are then added to every ancestor exactly once, while
the parent child node's own start is counted separately. Downstream results, conditions, approvals,
loop checks, and model verifiers consume the imported canonical value as `result.value` with its
original hash.

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

This contract does not provide arbitrary graph cycles, nested or unbounded loops, or dynamic maps.
Numeric accept-best iteration uses the separate bounded optimization contract below.

## Bounded accept-best optimization

An `optimization` compares a command-evaluated typed baseline with independently-ledgered isolated
candidates:

```yaml
- id: optimize
  type: optimization
  dependsOn: [baseline]
  optimization:
    baseline: { nodeId: baseline, field: result.value }
    metric: { pointer: /score, direction: minimize }
    invariants:
      - { pointer: /tests-passed, equals: true }
    maxCandidates: 4
    stagnation: { maxConsecutiveNonImproving: 2 }
    rollback: previous-best
    candidate:
      resultNodeId: publish
      workflow: |
        # Complete bounded child workflow with terminal result node `publish`.
```

The baseline must be an unconditional direct `result` dependency produced from deterministic
command evidence. Candidate and baseline result schemas must match exactly. `metric.pointer` is an
RFC 6901 JSON Pointer that resolves to a finite `number` or safe `integer`; `direction` is
`minimize` or `maximize`. Each invariant pointer resolves to a scalar and compares by exact typed
equality with `equals`. Malformed or unresolved pointers, incompatible expected values,
model-authored baseline evaluation, nested optimization, unordered top-level workspace mutation,
and schema drift fail compilation.

`maxCandidates` is 1–16. `maxConsecutiveNonImproving` is positive and no greater than the candidate
bound. Compilation creates a finite child/check pair per possible candidate and retains the author
id as a pure controller. Later pairs require the immediately prior check to continue; reaching the
stagnation threshold durably omits unused pairs. Nested optimization and hidden runtime recursion
are not supported.

A successful candidate result is revalidated and canonicalized against the persisted schema. Flow
records baseline and candidate value hashes, numeric metrics, every expected/actual invariant
observation, decision, stagnation, and stop flag. Only a strict metric improvement with all
invariants satisfied may enter promotion. Equal, worse, invariant-failing, failed, cancelled,
resource-exhausted, and no-file-change candidates are rejected. Rejection cannot mutate the parent.

For an improvement, Flow captures a deterministic delta containing additions, modifications,
deletions, executable modes, directories, regular files, and symbolic links. Paths, before/after
identities, entry count, logical bytes, snapshot digests, and manifest digest are persisted in the
run event. Defaults limit a delta to 20,000 entries and 2 GiB of logical before-plus-after file
bytes. The exact persisted entry list has a separate 128 KiB UTF-8 ceiling so the complete
evaluation stays within the 2 MiB run-event envelope even at the typed-result and control-graph
limits. Exceeding any capture bound records a non-improving candidate rejection and cleans the
workspace without mutating the parent. Sockets, devices, FIFOs, malformed paths, duplicate paths,
and changed source identities fail closed.

Promotion uses `rollback: previous-best`. Before its durable prepare event, Flow verifies the entire
parent still matches the candidate's isolation snapshot, verifies every affected path and removed
directory closure, stores content-addressed candidate and rollback blobs, and fsyncs its journal.
It then applies deterministic no-follow steps under a cross-process promotion lock. A local commit
is recorded only after every affected path matches the candidate state and the journal is durable.
Unrelated parent paths are preserved; a changed affected path refuses promotion rather than
overwriting newer work.

The event order is `node_optimization_evaluated`, optional
`node_optimization_promotion_prepared`, optional `node_optimization_promotion_settled`, optional
`node_optimization_candidate_cleaned`, `node_optimization_checked`, and finally
`node_optimization_completed`. Replay recomputes typed observations and the complete delta digest,
checks every identity and boundary, and rejects invented or reordered transitions. A committed
candidate becomes the new best; rejection retains the prior best. Candidate child resources are
charged to the parent exactly like ordinary children, while control events are resource-neutral.

Interruption before prepare retries promotion from the same captured delta. Prepared without
settlement invokes typed journal reconciliation. Reconciliation classifies the parent as committed,
rolled back, or unknown; it never guesses from a partial path set. Committed work is not applied
again, conclusive cleanup is idempotent, and unknown state fails with uncertain side-effect status
while retaining artifacts. Cancellation or budget exhaustion starts no later candidate and never
turns an exhausted bound into acceptance. Cancellation after candidate-child success but before
evaluation leaves that isolated workspace retained for diagnosis because no durable reject or
promotion boundary exists from which cleanup could be replayed.

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
  maxArtifactBytes: 1048576
```

At least one limit is required when `budget` is present. Every value must be finite and positive.
Starts, tokens, milliseconds, and artifact bytes are safe integers. `maxCostUsd` accepts at most six
decimal places; the compiler converts it to integer micro-USD before workflow hashing, persistence,
and comparison.
Unknown fields, an empty object, zero, negative, fractional integer dimensions, unsafe integers,
non-finite values, and finer cost precision fail compilation before a run or effect exists. Omitting
`budget` retains unbounded scheduling behavior.

Run state always exposes durable `resources`: node starts, total model tokens, provider-reported
model cost in micro-USD, active execution milliseconds, and retained artifact bytes. A start is
counted by its committed `node_started` event. A node outcome contributes its evidence duration
rounded up to a whole millisecond. Successful and failed agent evidence contributes available
input, output, cache-read, and cache-write tokens plus reported cost. Totals use checked safe-integer
arithmetic; invalid or overflowing evidence fails replay rather than wrapping or being ignored.

Artifact consumption is the UTF-8 byte length of terminal primary executor payloads: command
`stdout + stderr`, agent `text`, model-verifier `raw`, command-verifier nested command
`stdout + stderr`, and verified child `resources.artifactBytes`. Committed failed evidence follows
the same rule; missing evidence contributes zero. Verifier reason/verdict, typed result canonical
values, approvals, hashes, and policy/effect/sandbox/control metadata are derived projections and
are excluded. The sum is replayed from durable evidence with checked arithmetic; there is no
mutable executor-local counter.

Before new work or an approval request, Flow refuses scheduling when a configured dimension is
already exhausted. Using the final permitted node start does not invalidate a graph that is already
complete. Model-token, reported-cost, active-time, and artifact consumption is settled after each node
outcome; equality or overshoot records `run_budget_exhausted`, produces terminal
`resource_exhausted` state, rejects an incomplete goal, exits code 1, and starts no downstream work.
The full observation is retained rather than clipped to the limit.

Artifact equality is terminal. One bounded node may overshoot, and a complete already-admitted
concurrency wave quiesces before exhaustion is recorded; every declaration-ordered outcome remains
charged. Per-node output bounds cap the overshoot. This contract budgets logical retained evidence
payloads only: it does not add content-addressed storage, spill-to-disk, download, retention,
garbage collection, physical disk accounting, or recovery of executor-truncated bytes.

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
identity, RBAC, or a signature, and the request id is not a bearer secret. This declaration approves
only deterministic command nodes; agent tool calls use the separate live protocol below.

### Live agent `exec` approval

An agent may require one exact human decision for each model-requested command:

```yaml
- id: implement
  type: agent
  agent:
    prompt: Implement the change and run focused verification.
    model: { provider: anthropic, id: claude-sonnet-4-5 }
    tools: [read, edit, exec]
    toolApproval:
      exec:
        mode: required
        grantTtlMs: 300000
```

`toolApproval` is optional, closed, and currently accepts only an `exec` rule with
`mode: required`. Declaring it without selecting raw `exec` or at least one command tool package is
invalid. `grantTtlMs` defaults to 300000 and accepts 1 through 86400000 milliseconds. The compiled
configuration is frozen and included in the workflow digest; `run_started` persists the
corresponding per-node requirement.

After the Flow policy broker allows a normalized `flow_exec` request, the application appends
`agent_command_approval_requested` before command preparation, sandbox setup, or process spawn. The
request binds version, run, workflow, node, attempt, tool, normalized absolute working directory,
executable, ordered arguments, timeout, operation digest, and grant lifetime. A second digest binds
that complete context. The running node remains open while the run reports
`waiting_for_approval`.

`flow approve` or `flow deny` reads the current ledger projection and publishes one immutable local
decision receipt. The active attached process or detached worker remains the sole ledger writer: it
checks the exact request and appends the grant or denial. Approval expiry is calculated from the
owner's committed grant timestamp, not the receipt timestamp. A valid grant returns the run to
`running`; one matching `node_agent_command_prepared` atomically consumes it before execution. An
expired, reused, changed, missing, or forged grant cannot prepare a command.

Denial records actor and optional reason, returns a bounded tool error to the live Pi loop, and does
not by itself fail the node. Aborting the tool wait or reading a malformed, forged, or mismatched
decision identity appends `agent_command_approval_cancelled`; no process is prepared. Transient
receipt-read failures use bounded abortable backoff and leave the request pending until a valid
receipt, node deadline, or cancellation arrives. An unclassified terminal channel failure closes as
`decision_channel_failed`. A node cannot settle while a request is pending or a grant is unconsumed. A run-scoped queue permits only one
pending human decision across concurrent agent nodes; already granted exact commands may continue
to preparation. Policy allowance, human approval, and sandbox containment are independent gates:
no one gate widens or replaces another.

The local receipt path is
`.flow/runs/<run-id>/agent-command-approvals/<request-id>.decision.json`. It is created through a
synced temporary file and atomic no-overwrite publication with mode `0600`. Reads are non-blocking,
no-follow, restricted to regular files, fatal on malformed UTF-8, and capped at 16 KiB before JSON parsing. The receipt is
retained for audit but never treated as authority without a matching owner-appended ledger event.
Actor labels remain unauthenticated same-user attribution. Remote/RBAC approval and opaque
continuation after a process dies with an open Pi tool call are outside this contract.

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
Command-verifier approval, remediation edges, fallback, and automatic retry of an interrupted
verifier are not part of this contract.

## Installed capability bundles

Workflow syntax is independent of package transport. The same `skills`, packaged verifier,
`toolPackages`, and workflow-package selections resolve against one project catalog composed from strict local roots and
the digest-pinned entries in `.flow/packages.lock.json`. Flow reopens every referenced
content-addressed blob, checks byte count and SHA-256, re-parses every contained package, and
re-derives bundle name/version before catalog admission. Local and installed package-name
collisions, and provider-facing tool-name collisions, reject the whole composed catalog; there is
no source precedence.

Only `flow packages install` uses the network. Workflow validation and run admission are local;
detached jobs persist the selected immutable capability snapshot. Child execution, resume, and
replay never use the lock's source URL or load the current lock/blob. Bundle provenance is
`.flow/packages/sha256/<digest>/<kind>/<name>`, so run evidence identifies exact content without
carrying a network instruction. SHA-256 is content identity, not publisher authentication or
freshness.

## Versioned workflow packages

A reusable workflow may be selected as an exact packaged root:

```sh
flow validate workflow:release-check@1.0.0
flow run workflow:release-check@1.0.0 --run-id release-check
# Resume only an interrupted, nonterminal run.
flow resume workflow:release-check@1.0.0 --run-id interrupted-release-check
```

or as an exact child instead of an embedded `child.workflow`:

```yaml
- id: release-check
  type: child
  child:
    package: { name: release-check, version: 1.0.0 }
    resultNodeId: publish
```

`child` contains exactly one of `workflow` or `package`. Package references contain only a
lowercase kebab-case name and exact SemVer; ranges, tags, implicit latest selection, and two
versions of one name in a workflow tree are rejected. The packaged source is compiled recursively
through the ordinary child compiler, including result-node, complete-budget, depth, run-tree,
cycle, approval, isolation, evidence, and typed-result rules. Existing embedded children and their
digests are unchanged when no package is selected.

Packages are discovered below `.flow/workflows/<path>/<name>/WORKFLOW.yaml`. Each directory contains
only that regular UTF-8 manifest:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: release-check
  version: 1.0.0
  description: Run the release gate.
  license: Apache-2.0
  compatibility: Flow v1alpha1 workflow compiler
spec:
  workflow: |-
    apiVersion: flow.synapti.ai/v1alpha1
    kind: Workflow
    metadata: { id: release-check }
    nodes:
      - id: verify
        type: command
        command: { executable: npm, args: [test] }
```

Unknown or duplicate fields, YAML aliases, malformed identity, symlinks, special or extra entries,
source races, and unsafe paths fail closed. The manifest and embedded workflow are each at most
128 KiB. A composed catalog and immutable snapshot retain the existing 32-package and 512 KiB
aggregate bounds.

Admission first resolves a bounded exact transitive set from the race-detecting local/installed
catalog. It then performs the authoritative compile with a closed resolver over the captured
snapshot only. Each compiled packaged root or child records name, version, and package digest;
`run_started` records the sorted exact requirements plus the full immutable snapshot. The control
graph, reducer, detached job digest, worker, child ledger, replay, and recovery reconcile those
requirements without filesystem or network fallback. A locator-named root must exactly match the
workflow bytes in its captured manifest.

`flow workflows list`, `inspect <name> --version <exact>`, and `validate` execute nothing.
Inspection reports bounded metadata, provenance, manifest/workflow byte counts and hashes, and
package digest while omitting raw manifest base64 and embedded source. A workflow package cannot
contribute executable modules, hooks, tools, drivers, providers, credentials, configuration,
policy, environment, or sandbox permissions. It can describe only ordinary nodes already admitted
by the Flow workflow language. Parameters, interpolation, secrets, outputs as template inputs,
version solving, and executable extensions are unsupported.

## Versioned verifier packages

Workflows may select one exact project-catalog package instead of repeating an inline verifier
definition:

```yaml
- id: release-tests
  type: verifier
  verifier:
    kind: packaged-command
    package: { name: release-tests, version: 1.0.0 }

- id: review-evidence
  type: verifier
  dependsOn: [tests]
  verifier:
    kind: packaged-model
    package: { name: evidence-review, version: 1.2.0 }
    evidence: [{ nodeId: tests, field: command.stdout }]
    model: { provider: anthropic, id: claude-sonnet-4-5, thinking: medium }
    timeoutMs: 120000
```

`packaged-command` contains only `kind` and an exact `{name, version}` reference. Its selected
manifest supplies the complete command object. `packaged-model` also declares the same reference,
but the workflow must still provide 1–16 ordered direct-dependency evidence fields, model, and
timeout. The selected manifest supplies only the rubric. This keeps provider and evidence authority
in the workflow and makes model packages portable across executor adapters.

Packages are discovered below `.flow/verifiers/<path>/<name>/VERIFIER.yaml`. Each directory contains
only that regular UTF-8 manifest. The strict shape is:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: VerifierPackage
metadata:
  name: release-tests
  version: 1.0.0
  description: Run the repository release gate.
  license: Apache-2.0
  compatibility: Requires Node.js and npm.
spec:
  kind: command
  command:
    executable: npm
    args: [test]
    timeoutMs: 120000
```

`metadata.name` is lowercase kebab-case, must match the immediate directory, and is bounded to 64
characters. `metadata.version` is an exact SemVer value; ranges, tags, and numeric prerelease
identifiers with leading zeroes are rejected. Description is required; license and compatibility
are optional. Unknown or duplicate fields, YAML aliases, symlinks, non-regular or extra directory
entries, source races, and unsafe paths fail closed. Discovery permits at most 32 packages, depth 6,
and 2,000 entries. A manifest is 1–65536 bytes; a model rubric is 1–16384 trimmed characters. The
combined capability snapshot, including Agent Skills, is at most 32 packages and 512 KiB serialized.

Compilation includes the exact reference in the workflow digest and persisted control graph. Run
admission recursively collects root and child references and captures one sorted immutable
capability snapshot. `run_started` records the snapshot plus each node's name, version, and driver
kind requirement. The scheduler resolves only from that snapshot and records name, version, and
package digest on verifier evidence. Missing packages, version or kind mismatch, extra packages at
a root run, changed source during capture, or inconsistent replay evidence fail before acceptance.
Child runs may receive unused parent-owned entries but can execute only their own compiled
selection. Detached and resumed execution never reload the live catalog.

`flow verifiers list`, `inspect <name>`, and `validate` are metadata-only operations and execute no
driver. Inspection reports identity, provenance, and hashes but omits manifest content and the
parsed definition so a model rubric is not printed. Packages cannot contribute executable files,
hooks, tools, models, evidence, graph edges, policy, credentials, or network authority. Version
solving, arbitrary evaluator code, and reward environments are unsupported.

## Versioned command tool packages

An agent may select exact project-catalog command tools without enabling unrestricted `exec`:

```yaml
- id: inspect
  type: agent
  agent:
    prompt: Inspect the repository and summarize its state.
    model: { provider: anthropic, id: claude-sonnet-4-6 }
    tools: [read]
    toolPackages:
      - { name: git-status, version: 1.0.0 }
```

`toolPackages` is optional and compiles to an empty frozen list. Each entry contains only an exact
lowercase kebab-case name and exact SemVer version. The complete workflow tree may select at most
32 distinct names. A package is visible only to the agent nodes that declare it. Two selected
packages may not expose the same model tool name, and package tools may not collide with Flow's
built-ins or use the reserved `flow_` prefix. Selection grants only the ability to request that
declared tool; ordinary policy, approval, sandbox, budget, and evidence rules still apply.

Packages are discovered below `.flow/tools/<path>/<name>/TOOL.yaml`. A directory contains only its
regular UTF-8 manifest. The v1 shape is:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: project-report
  version: 1.2.3
  description: Produce a bounded project report.
  license: Apache-2.0
  compatibility: Requires POSIX printf in the execution environment.
spec:
  tool:
    name: create_project_report
    description: Produce a report for one project path.
    inputs:
      - { name: path, description: Relative path to inspect., type: string }
      - { name: format, description: Output format., type: enum, values: [json, text] }
      - { name: limit, description: Maximum entries., type: integer }
      - { name: verbose, description: Include details., type: boolean }
  driver:
    kind: command
    version: v1
    profile: posix-printf-v1
    executable: /usr/bin/printf
    args: ["path=%s format=%s limit=%s verbose=%s\\n", "{input:path}", "{input:format}", "{input:limit}", "{input:verbose}"]
    timeoutMs: 10000
  permissions: [process.execute]
```

The package declares exactly one provider-safe tool and zero to 32 required scalar inputs. Input
names are unique; supported types are bounded strings, safe integers, booleans, and bounded string
enums. Every declared input must occur in at least one exact whole-argument
`{input:<name>}` placeholder. Partial interpolation and undeclared or unused inputs are rejected.
String and enum values remain literal, integers render as canonical base-10 text, and booleans
render as `true` or `false`. No shell or language runtime parses the rendered vector.

The only driver is `{kind: command, version: v1}` and the only permission is
`process.execute`. Every driver selects a closed Flow-owned profile; project manifests cannot add
profiles. `posix-printf-v1` requires the host-controlled `/usr/bin/printf` executable, a fixed
non-option format using only `%%` and one `%s` per following data argument, and permits placeholders
only in those data arguments. `git-status-v1` requires `/usr/bin/git` plus the exact hardened vector
used by the public example: optional locks, fsmonitor, untracked cache, and submodule inspection are
disabled. Shells, language runtimes, environment dispatchers, alternate executable identities or
paths, arbitrary subcommands, and evaluator flags therefore cannot validate as command tools.

The manifest cannot declare code, environment variables, credentials, cwd, stdin, PTY, background
execution, network, hooks, providers, middleware, or graph behavior. Admission applies the active
agent-command envelope directly: a 10-minute deadline, 1 KiB executable, 64 argv elements, 8 KiB
per element, and 32 KiB aggregate argv. A package outside that envelope fails `validate`, snapshot,
and registration before a model or process starts.

Discovery is bounded to 32 packages, depth 6, and 2,000 entries. Each manifest is at most 64 KiB.
Unknown or duplicate fields, YAML aliases, malformed versions, reserved names, symbolic links,
special or extra entries, source races, duplicate package identities, and size overflow fail
closed. `flow tools list` reports bounded authority metadata; `flow tools inspect <name> --version
<exact>` snapshots and reports the exact definition, provenance, and hashes without encoded source
bytes; `flow tools validate` snapshots every discovered manifest. These commands never invoke a
driver.

Admission collects all root and child selections and adds exact manifest bytes, parsed definition,
trust/provenance metadata, and nested digests to the immutable capability snapshot. `run_started`
records per-agent requirements, including independent raw-`exec` eligibility, and its control graph
separately projects whether raw `exec` plus which package tools were available. Replay reconciles
the two records. Detached jobs carry the same bytes, children bind only their declared subset, and
resume accepts only the durable snapshot. There is no live-source fallback.

At model-session construction, the adapter creates definitions only for the selected packages. A
call validates a plain closed input object, calculates a typed input digest, renders literal argv,
and creates the ordinary normalized `flow.agent-commands/v1` request with package source metadata.
The existing broker derives `process.execute`; configured `toolApproval.exec` applies equally to
raw and packaged commands. The recorder commits the exact request before spawn and settles it
through the same Linux PID-namespace-contained sandbox path. The existing per-agent command-call cap
counts raw and packaged commands together.

Replay independently rerenders every sourced command from its durable typed input and package
definition. It reconciles package name/version/digest, model tool name, input digest, executable,
argv, timeout, compiled node selection, control graph, policy decision, approval, preparation, and
settlement. A package-only agent rejects source-free commands. An interrupted command-capable agent
attempt is never fresh-retried. Dependency installation, publisher signatures, version solving,
executable package code, and non-command drivers are unsupported.

Every command node and descendant runs through Flow's required SRT adapter. The fixed `workspace-write-network-deny-v1` profile allows the selected workflow directory and a private temporary directory, denies network and undeclared Unix sockets, omits ambient credentials and injection variables from the child environment, and denies writes to the actual run store, `.flow`, `.git`, environment files, and key files. Concurrent same-policy commands share one initialized SRT session but receive distinct temporary directories, environment values, and per-command filesystem configurations. Flow reference-counts wraps, queues a different concurrent workspace or policy until the active session resets, honors cancellation while queued, and resets SRT only after the last compatible command releases. On Linux, Flow resolves SRT's packaged seccomp helper canonically, passes it as the explicit SRT apply path, and re-exposes only that file read-only when the Flow installation lies outside the workflow directory. If SRT is missing, unsupported, degraded, or cannot initialize, the node fails before spawn; Flow has no unsandboxed command fallback.

New command evidence records `anthropic-sandbox-runtime`, its exact installed version, the named profile, and a SHA-256 digest of the semantic policy. Generic command-node evidence keeps this field optional only for compatibility with ledgers created before sandbox evidence existed. The `flow.agent-commands/v1` settlement schema always requires sandbox provenance plus retained-prefix hashes and byte counts.

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

The embedded Pi adapter permits only Flow-owned `read`, `ls`, `edit`, and `exec` tools. The allowlist may be empty, every name must be unique, and a tool is structurally unavailable unless declared. Every tool operation passes through an attempt-scoped Flow policy broker. The broker canonicalizes filesystem targets, derives authority from the semantic operation rather than its Pi name, and permits only actions declared by the compiled node. `flow_ls` sorts and bounds one directory listing behind one logical `filesystem.list` authorization; it does not spend policy-decision capacity per returned entry.

`flow_read` preserves Pi's bounded paging behavior and adds a full-file version marker of the form `sha256:<64-lowercase-hex>`. The digest covers the exact bytes read, not only the displayed page. `flow_edit` accepts `path`, `expectedSha256`, and one to 32 `{oldText,newText}` replacements with at most 256 KiB of replacement text. It edits one existing regular UTF-8 file no larger than 8 MiB. Replacement strings must contain valid Unicode scalar values. Every non-empty `oldText` must occur exactly once, replacements must not overlap, and all matches are computed against the same original content. The edit fails with `stale_version` when the current full-file hash differs. It never performs fuzzy matching, snapshot recovery, or automatic merging.

`flow_exec` accepts only `executable`, optional literal `args`, and optional `timeoutMs`. It defaults
to 120000 ms and caps the deadline at 600000 ms, the executable at 1024 UTF-8 bytes, 64 arguments,
each argument at 8192 UTF-8 bytes, and the aggregate vector at 32768 UTF-8 bytes. NUL bytes and
unknown fields are rejected. There is no shell, environment or working-directory override, stdin,
PTY, background mode, or implicit network authority. Flow hashes the normalized v1 request,
requires an exact allowed `process.execute` decision, commits a protocol-v1 prepare event, and only
then invokes the same SRT-contained process-tree executor used by command nodes. The settlement
records bounded stdout/stderr, independent hashes and UTF-8 byte counts for the retained prefixes,
full-stream hashes, truncation, exit/signal, timeout, duration, failure classification, and sandbox
provenance. The deadline starts before sandbox preparation and includes spawn, execution, and
confirmed kernel-backed descendant termination. Before SRT initialization, Flow resolves
Bubblewrap to one canonical executable outside the workspace whose complete path is root-owned and
not group- or world-writable. Immediately before spawn, Flow verifies both the absolute monotonic
deadline and one canonical `/bin/bash -c` SRT descriptor. Its parsed argv must bind that same
absolute executable, place `--new-session` and `--die-with-parent` first, end its active options with
the secure `--unshare-pid --unshare-user --cap-drop ALL --proc /proc` tail, contain one command
boundary, and invoke `/bin/bash -c` inside the namespace. Shell operators, substituted outer
launchers, noncanonical quoting, and lifecycle-looking option values are rejected. An uncooperative sandbox-preparation promise cannot create late spawn
authority; late preparation is released asynchronously. Commands are serialized as prepare/settle pairs within one
agent attempt. Nonzero exit and sandbox backend/profile/policy provenance are returned to the agent
as evidence so it can correct the work; they do not themselves establish workflow completion.

`flow_exec` currently runs only on Linux. macOS Seatbelt confines filesystem/network access for
ordinary command nodes, but its process-group cleanup cannot contain a descendant that creates a new
session. Flow therefore returns `command_sandbox_unavailable` and releases sandbox preparation before
spawning an agent-issued command on macOS. The settlement persists
`processContainment: linux-pid-namespace`, distinct `timedOut` and `aborted` observations, plus
`terminationStatus` so replay can verify every termination-related failure classification. If
termination cannot be confirmed, the durable settlement closes the command audit, aborts the Pi
session, forbids later command preparation in runtime and replay, and prevents either path from
publishing terminal success. If termination cannot be confirmed and sandbox cleanup
also fails, the settlement keeps `command_termination_failed` and `terminationStatus: unconfirmed`
as the primary truth and appends only bounded cleanup context to its message.

After policy authorization, Flow reserves bounded evidence capacity, acquires a target-local exclusive lock, re-reads and preflights the complete request, writes a same-directory exclusive temporary file, preserves permission bits, syncs it, and rechecks the live target bytes and mode. While still holding the lock and before rename, it syncs a `node_effect_prepared` event containing an event-derived identity, attempt-local sequence, canonical target, operation digest, before/after hashes, and mode. Only then may it atomically rename. After directory sync it settles committed; a post-prepare failure before rename settles not applied; a failure after rename settles unknown when publication remains available. The lock coordinates cooperating same-host Flow processes: a live owner produces `target_busy`, an exited same-host owner is recoverable, and corrupt or foreign-host ownership fails closed. The run store, `.flow` and `.git` segments at any path depth, environment files, private-key names and suffixes, outside paths, and canonical symlink escapes are protected. Pre-prepare failure leaves the target unchanged without an effect event. A later provider failure retains committed receipts and cannot be classified as side-effect-free.

The lock is a cooperative local coordination mechanism, not a security boundary or distributed lease. This application-level check is not atomic against a concurrently hostile process changing path components after canonical authorization; the current release retains its trusted-workspace requirement until agent/tool process isolation lands. Pi's built-in tools are disabled, so Flow does not inherit Pi's fuzzy edit rules, direct-write semantics, or optional executable-download behavior. Pi extensions, skills, prompt templates, themes, context files, and project discovery are disabled for the node session. `timeoutMs` is Flow-owned, defaults to five minutes, and is limited to 24 hours. Agent output is capped at 64 KiB; the ledger retains the bounded text, the complete SHA-256 stream hash, truncation status, ordered policy decisions, and ordered effect receipts, and classifies overflow as `pi_agent_output_limit`. Cancellation aborts the active Pi session; only Pi's terminal `stop` reason is accepted as node success. After timeout or operator cancellation, Flow permits a bounded adapter cleanup grace and waits for the provider runner plus active edit and command reservations. A runner, effect, or command reservation that still does not settle produces `pi_agent_timeout` or `pi_agent_aborted` with uncertain side-effect status rather than blocking the scheduler indefinitely. Closed audits deny late authorization, receipt publication, or command execution.

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

An agent selecting `exec` cannot declare `recovery`; the compiler rejects the combination because
arbitrary process execution is never classified as read-only and has no general reconciliation
proof. A prepared command blocks terminal settlement until its outcome is durable, and an open
command-capable attempt is never replayed automatically.

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

## Portable Agent Skills

An agent node may explicitly select project-catalog packages that follow the open Agent Skills manifest
shape:

```yaml
- id: review
  type: agent
  agent:
    prompt: Review the repository using the selected package.
    model: { provider: anthropic, id: claude-sonnet-4-6 }
    tools: [read]
    skills: [review]
```

`skills` is optional. Omission compiles to an empty frozen list and preserves ordinary agent
behavior. A selection contains 1–32 unique lowercase kebab-case names and requires the node to
declare the Flow `read` tool, because selected instructions remain progressively disclosed through
`flow_read`. A package cannot select itself, change dependencies, advance the graph, or define an
evaluator.

Flow discovers packages recursively below the nearest project root's `.flow/skills`. Every package
directory contains a regular UTF-8 `SKILL.md` whose strict YAML frontmatter has required `name` and
`description`, optional `license` and `compatibility`, bounded string metadata, and optional
whitespace-separated `allowed-tools`. The name must match its immediate directory. Unknown fields,
duplicate names, aliases, symbolic links, special files, source-identity changes, traversal, and
limit violations fail before a run starts. Discovery is bounded to 32 packages, depth 6, and 2,000
entries. Each selected package is bounded to 128 regular files, 128 KiB per file, 256 KiB total,
and the complete serialized run capability snapshot is bounded to 512 KiB.

`allowed-tools` is a permission request and audit field, not authorization. It never adds a Flow
tool, policy action, environment value, command, extension, or provider capability. Only the
compiled `agent.tools` list and Flow policy authorize model operations. Package resources are inert
bytes; Flow never runs package scripts automatically. Binary resources may be preserved in the
snapshot, but `flow_read` rejects a selected resource that is not valid UTF-8.

Compilation recursively collects the exact union selected by root and child nodes. Before an
attached or detached run is admitted, Flow snapshots canonical package metadata and bytes, sorts
them lexically, and binds file, package, and aggregate SHA-256 digests. `run_started` persists that
provider-neutral immutable capability snapshot. A child ledger receives the same parent snapshot
but may read only packages declared by its own node. Resume uses durable history and refuses a
caller-supplied mismatch; it never rediscovers live package sources. Detached command identity and
the durable job record include the snapshot digest and bytes, so queue delay cannot introduce
source drift.

At Pi session startup Flow adds only selected package metadata, digests, requested tools, and
`skill://<name>/<path>` addresses to the locked system prompt. Pi's ambient skill discovery,
extensions, prompt templates, themes, context files, and project discovery remain empty. Exact
resource reads go through the Flow-owned `flow_read` tool, reject encoded or literal traversal,
query/fragment ambiguity, unselected packages, and missing content, and return bytes from the
frozen snapshot rather than the live filesystem. Agent evidence records every selected package
digest plus deduplicated file-read receipts containing resource URI, package digest, file digest,
and byte count. Live execution, replay, and recovery independently reconcile that evidence against
both the immutable bytes and the node's compiled selection.

## Run ledger

Each run is stored at:

```text
.flow/runs/<run-id>/events.jsonl
```

Events have a version, contiguous sequence number, timestamp, run identity, workflow identity,
workflow API version, and SHA-256 digest of the compiled workflow. New `run_started` events also
capture the normalized execution directory, command approval requirements, agent-command approval
requirements, agent recovery
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

Agent-command approval history retains every exact request, decision or cancellation, expiry, and
single command consumption on its running node. `node_agent_command_prepared` carries the approval
reference when the compiled node requires it. Replay rejects missing or extra references, changed
commands, digests, working directories, attempts, lifetimes, early or expired grants, reuse, and
terminal outcomes with pending or unconsumed authority.

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

## Evaluation plans

An evaluation plan is a separate `flow.synapti.ai/v1alpha1` document with
`kind: EvaluationPlan`; it is not a workflow node and cannot alter an ordinary run graph. The full
authoring contract and example are in [Reproducible harness evaluation](evaluation.md) and
`examples/evaluation/harness-comparison.evaluation.yaml`.

Version 1 admits exactly two `flow-workflow-v1` profiles. Each plan declares a versioned suite of
bounded tasks, portable fixture and instruction paths, a private `filesystem-v1` verifier, one
shared provider/model/`thinking` tuple, an exact run budget, `network: deny`, zero provider and
harness retries, unique seeds, `paired-alternating-v1`, and fixed comparison constraints. Both
compiled workflows must contain at least one model-bearing node and match the declared model and
budget recursively.

Evaluation admission rejects unknown fields, non-canonical identifiers and paths, duplicate task,
profile, verifier, or seed identities, excess schedule size, symbolic links, special fixture entries,
`.flow` fixture state, mutable source observations, and profile/control drift. Agent Skills, tool
packages, packaged verifiers, workflow packages, and agent fresh recovery are not admitted in this
version because the plan does not yet capture their complete semantics.

`filesystem-v1` is a closed assertion union of `exists`, `absent`, and regular-file `sha256`.
Assertions enter the verifier digest and plan identity but never enter the adapter request. Missing
trial records remain missing in the scheduled denominator. Metric values are non-negative safe
integers or explicit `null`; absence is never interpreted as zero.

The redacted public header retains each verifier digest and assertion count. Trial replay requires
the exact digest and complete accepted/rejected evidence cardinality. Comparative inference uses
only environment-matched holdout pairs; tuning and regression tasks remain descriptive and continue
to contribute profile metrics and constraints. A declared regression ceiling is computed from
complete environment-matched regression pairs only. Child-only activity, policy, intervention, and
recovery fields remain `null` until child evidence carries those recursive aggregates.

### Prompt candidates

A prompt candidate is a separate inert document, not a workflow node or executable package:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: PromptCandidate
metadata: { id: better-instructions, version: 1.0.0 }
scope: { kind: workflow, workflowId: evaluated-profile }
baseline:
  workflow: baseline.workflow.yaml
  sourceSha256: <64-lowercase-hex>
  workflowDigest: <64-lowercase-hex>
evidence:
  - path: tuning-evidence.json
    sourceSha256: <64-lowercase-hex>
    evidenceDigest: <64-lowercase-hex>
    planDigest: <64-lowercase-hex>
changes:
  prompts:
    - nodeId: implement
      expectedSha256: <64-lowercase-hex>
      value: Read the task, implement it carefully, and verify the result.
```

Candidate source is at most 1 MiB. Identifiers and semantic versions are canonical. Baseline and
evidence paths are portable relative paths below the candidate directory and must resolve through
direct regular no-follow files. A candidate declares 1–16 unique evidence paths/digests and 1–16
unique prompt targets; each replacement is non-empty and at most 262144 characters, with at most
1 MiB of replacement UTF-8 in total. Evidence files are strict canonical tuning packets of at most
8 MiB each. A retained harness reason is at most 512 UTF-8 bytes and includes
`reasonTruncated`; packet parsing rejects contradictory classifications, outcomes, recovery metrics,
duplicate trial identities, incomplete profile pairs, reused seeds/repetitions, non-contiguous
repetitions, infeasible declared totals, and other inconsistent tuning schedules.

Admission binds the candidate source SHA-256, exact baseline source and compiled digest, each
evidence file/source/packet/plan digest, workflow scope, and each current prompt digest. Every
evidence packet must contain a profile with the exact baseline workflow digest. A target must be an
existing root `agent` node; nested nodes and every non-agent node are invalid. The projection starts
from the validated baseline source, replaces only declared `agent.prompt` leaves, serializes
deterministic JSON, and runs through the ordinary compiler. The public candidate identity contains
only provenance, ids, versions, and hashes—not prompt bodies or absolute paths. Its digest is
recomputed independently during durable replay, and its complete baseline/projected identities must
match the surrounding evaluation profiles.

Unknown fields, duplicate targets/evidence, malformed YAML/JSON, excessive input, path escape,
symbolic link, special/missing file, unstable read, stale source/prompt identity, unrelated evidence,
or invalid projection fails before evaluation execution. No candidate field can express graph,
model routing, tool, skill, package, policy, approval, budget, verifier, retry, or activation changes.
`flow candidate validate <candidate.yaml>` is read-only and credential-free. An evaluation plan
selects a candidate with `candidate: <path>` instead of `workflow: <path>` while retaining
`adapter: flow-workflow-v1`. It must be the declared comparison candidate and must overlay the exact
declared comparison baseline. Public headers distinguish generated candidate projections from
file-backed workflow sources; direct file sources omit the discriminator to preserve version-1 plan
digests and legacy resume. Automatic generation and activation remain unavailable.

## Current limitations

- No arbitrary cycles, nested or unbounded loops, nested optimization, dynamic fan-out, general multi-condition joins, general child patch promotion, terminal-failure retry, or fallback semantics. Bounded loop bodies and static ready DAG nodes can execute concurrently, but iterations are sequential, share one workspace, and are not inferred to be conflict-free. Ordinary child workflows isolate workspaces and histories and discard their changes; only compiler-generated bounded optimization candidates can use the typed promotion saga. Conditions and loop stops are limited to exact equality over complete durable command, agent, accepted verifier, or typed-result fields. Approval is available as deterministic command pre-start gates, live per-call agent `exec` gates, and pure evidence-bound graph nodes; command-verifier approval remains unavailable. Recovery is limited to proof-safe fresh agent attempts; interrupted verifier attempts are never retried automatically.
- No automatic terminalization or session continuation of an interrupted node attempt. Unconfigured or ineligible durable starts still block continuation.
- Detached workers can be adopted by a replacement local supervisor, but they cannot move between
  hosts and do not survive host reboot.
- The SRT profile is fixed; workflows cannot yet request network, credential injection, or a different sandbox backend.
- Linux PID namespaces contain agent-command descendants; macOS agent commands fail before spawn because process groups are insufficient. The native sandbox does not contain the host-side Pi runtime; hostile workloads require a stronger container, microVM, or managed boundary.
- Agent mutation is limited to exact single-file edit of an existing UTF-8 file plus explicitly selected, argv-only sandboxed commands. No direct create, delete, rename, shell, network, fuzzy patch, environment/cwd override, interactive process, background job, or multi-file transaction tool is exposed.
- No opaque continuation after a process dies during an in-flight Pi tool call. Live approval works only while the owning attached process or detached worker retains that Pi session. A fresh retry is a new attempt and is allowed only by the persisted proof gate; it is not a substitute for restoring a live session.
- Model verifiers, including packaged rubrics, are zero-tool and evidence-bounded but remain probabilistic and not prompt-injection-proof. Arbitrary evaluator code and reward/evaluation environments are not supported.
- Adaptive candidates are prompt-only, root-agent overlays. Skill, memory, sub-agent, routing,
  activation, rollout, and rollback contracts remain unavailable.
- No prepaid hard model-cost cap, provider invoice reconciliation, or CPU/memory/disk quota. `maxArtifactBytes` bounds logical retained evidence, not physical storage, spill, or disk usage. Per-run graph-node concurrency, detached worker count, and queue depth are separate bounded controls.
- No schema migration path is promised while the format remains `v1alpha1`.
