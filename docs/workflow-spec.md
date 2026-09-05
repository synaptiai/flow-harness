# Workflow specification

## Version

The first executable format uses:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
```

It is intentionally incompatible with the legacy Flow plugin format. The plugin's workflow metadata
described how a host model was expected to interpret Markdown. This format compiles directly into
scheduler-owned graph state.

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

Criterion evaluation is a pure domain operation over the captured goal and durable node outcomes.
It receives no model transcript, prompt, workspace handle, process executor, or tool. Verifier
commands execute under the [command-node sandbox contract](#command-node), while criterion
evaluation itself remains a mutation-free domain operation rather than an operating-system
boundary.

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

`node_started` derives one deterministic child run id from the parent run id, child node id, and attempt.
It saves that id and the child workflow and schema digests before it creates a workspace.
The production backend creates an owner-only copy-on-write clone where the filesystem supports it.
The backend uses an ordinary copy on other filesystems.
New workspaces are in an owner-only project-sibling collection.
The collection name is `.<project-name>.flow-workspaces`.
A hash of the canonical physical run-store path separates workspace groups.
Filesystem aliases for one run store select one workspace group.
The project workspace, the protected project `.flow` directory, and the configured run store do not contain the collection.
Attached runs use the canonical configured project root.
Detached jobs save the same optional root in their immutable identity.
For an old job without these fields, Flow can infer the root from the durable `.flow/runs` ancestor.
It accepts the root only when the job directory is in that project.
Flow rejects a linked collection or owner directory.

It also excludes `.flow` and every protected run-store path.
It includes dirty and untracked content, modes, and symbolic links without following them.
It refuses sockets, devices, and FIFOs.
It applies default ceilings of 200,000 entries and 10 GiB of logical file content.

Flow hash-checks each copied regular file.
It rejects a file if its source identity changes during copy.
This portable backend is content-verified isolation from parent mutations.
It is not an atomic filesystem snapshot or security boundary.
Each child command keeps the complete protected-path deny list.
The broker and SRT protect the `.flow` path in its child workspace.
The broker denies each historical `.flow-workspaces` or named `.<name>.flow-workspaces` path segment.
Before command spawn, SRT scans at most 200,000 execution-root entries.
It adds each existing private collection as a literal protected path.
It rejects linked or indirect collections.
For a child, SRT denies reads from every ancestor collection but permits writes in the selected workspace.
Thus, a child cannot read a sibling workspace at any nesting level.
The snapshot copier omits these collections.
On Linux, Flow rejects a command root that strictly contains the configured project root.
Linux SRT cannot protect a matching path that does not exist when the sandbox starts.

Recovery can find a workspace in the old run-store location.
Flow validates the old manifest with its old exclusion identity.
For a nested child, Flow translates the moved parent path to the old parent path.
Flow moves and syncs the identity when both locations use one filesystem.
Across filesystems, Flow uses a bounded staging copy.
It verifies and syncs the copy before one rename publishes it.
It removes the old identity after publication.
The first recovery event records the old and new paths in `run_resumed.workspaceRelocation`.
A parent records this event before it starts recovery in that child.
Flow moves and syncs the complete workspace identity directory to the project-sibling collection.
Flow reopens the moved workspace before command or model activity starts.

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

The serialized persisted control graph is at most 512 KiB. Compilation and event parsing measure its
JSON UTF-8 bytes. The 20 MiB run-event limit also holds activation snapshots and recovery metadata.

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
evaluation stays within the 20 MiB run-event envelope. Exceeding any capture bound records a
non-improving candidate rejection and cleans the
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

## Work profile

`workProfile` is an optional strict workflow preference:

```yaml
workProfile: standard
```

The value must be `fast`, `standard`, or `long`. An omitted field preserves the legacy compiled
workflow shape and digest. A new run resolves one effective value in this order:

1. Use the explicit `flow run --work-profile <value>` selection.
2. Otherwise, use the workflow `workProfile` preference.
3. Otherwise, use `standard`.

Flow writes the effective value to `run_started` before it starts model, tool, supervisor-worker,
or child work. Detached submission and worker records bind the same value. Every child run inherits
the root value, even when the embedded child workflow declares another preference.

Legacy `run_started` events can omit the field and replay as `standard`. Resume accepts an omitted
selection or the exact durable value. A different explicit selection fails before new work. Replay
rejects an unknown persisted value. Recovery validates the value across parent and child ledgers.

After Flow commits the current scheduling wave's `node_started` events, it creates one immutable
model context with the effective profile and these five remaining values:

- node starts
- model tokens
- provider-reported cost in micro-USD
- active execution milliseconds
- retained-artifact bytes

Each value is a non-negative safe integer or `unbounded`. `unbounded` means that the compiled budget
does not declare that limit. Concurrent model attempts receive the same post-admission snapshot.
The snapshot does not estimate unsettled provider usage.

The context is pacing guidance only. It cannot change the compiled budget, scheduler, concurrency,
timeout, policy, tools, approvals, model, reasoning settings, accounting, or terminal state. Flow
does not expose it as writable ACP session configuration. A provider response or capability package
cannot replace the durable profile.

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
payloads only. A separate project artifact store can retain exact agent-command streams that exceed
the preview and remain within its 1 MiB command-stream capture bound. The durable command settlement
binds an opaque reference to the full-stream digest, byte count, media type, and exact producer
tuple.
Physical deduplication, retention, and pruning don't change the run budget. Flow doesn't claim a
project disk quota or recover streams that exceed the command capture bound. The underlying artifact
format permits a 16 MiB object for producers that don't require this in-memory command capture.

An execution budget reduces a command, agent, or verifier-driver timeout to the remaining active milliseconds.
Approval-required commands persist and display that reduced timeout in the exact operation, so a
later resume cannot gain more execution authority. Approval wait, client detachment, and process
downtime do not contribute because active time comes only from committed node evidence.

Model usage and reported cost are known only when a provider response settles. One response may
therefore exceed its remaining allowance. This contract is deterministic run admission control, not
a prepaid or invoice-authoritative billing cap. Flow does not infer pricing, convert currencies, or
reconcile provider invoices.

An operator-selected ACP executor is a run capability, not a workflow field. Its immutable runtime
snapshot declares model-token and reported-cost support independently. If the workflow budget
contains `maxModelTokens`, Flow admits the run only when the selected runtime declares complete
token accounting. If the budget contains `maxCostUsd`, Flow requires complete reported-cost
accounting. The same rule applies when a parent budget covers an embedded child workflow. An
unsupported dimension fails before `run_started` or executor invocation.

Durable model evidence records each dimension as complete or unavailable. Complete tokens contain
a total and can include an exact input, output, cache-read, and cache-write breakdown. Evaluation
reports that breakdown only when every attempted model node supplies it. An unavailable token or
cost dimension contributes no synthetic zero. Public run presentation labels the dimension
`Unavailable`. Existing complete Pi usage retains its prior values and replay behavior.

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
node, may appear inside a bounded loop body, and declares one strict driver:

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
    recovery: { mode: fresh, maxAttempts: 2 }
    maxOutputTokens: 8192
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

An inline or packaged model verifier accepts the same optional `maxOutputTokens` field as an agent.
The value limits each provider response but doesn't replace the verifier's strict 16 KiB raw-byte
and JSON-shape checks. Use a smaller verifier cap when the required verdict is short. The `8192`
value in the example is illustrative.

An inline or packaged model verifier can also declare `recovery: { mode: fresh, maxAttempts: N }`,
where `N` is from 2 through 16. An optional `backoff` has the same bounds and deterministic jitter
as agent recovery. This policy applies only when a completed, nontruncated model response violates
the strict verdict JSON contract and attempts remain. It doesn't retry a valid `rejected` or
`inconclusive` verdict. It also doesn't retry missing, oversized, truncated, or identity-mismatched
source evidence.

Model provenance mismatches and unexpected tool activity are nonretryable. A
response that exceeds the retained raw-byte limit is nonretryable. An open verifier attempt after
process interruption is also nonretryable.

Flow archives each failed verifier attempt and its raw output, usage, duration, source provenance,
and model-session summary before it schedules a fresh attempt. The next request uses the original
frozen verifier input plus bounded retry metadata. It doesn't include the malformed response as
conversation history. The attempt ceiling includes the initial request. Configure the run-wide
node, token, cost, time, and artifact budgets independently. Omit `recovery` when one model request
is the intended contract.

Verifier evidence records the driver, verdict, bounded reason and hash, duration, ordered source
node/attempt/field/hash observations, and command or model provenance. Model evidence also retains
bounded raw output, its complete hash/truncation state, and available Flow-owned usage. Only
`accepted` may produce `node_succeeded`. The `rejected` and `inconclusive` verdicts fail the node, so no dependent
is released. An eligible strict-output failure may enter a declared fresh attempt before the run
becomes terminal. Cancellation overrides a late accepted result. Replay validates the
declaration, provenance, source identities, hashes, strict raw response, verdict/outcome pairing,
failure classification, and resources without consulting a provider.

The separate zero-tool session and delimiters reduce accidental instruction following; they do not
make a probabilistic verifier prompt-injection-proof or equivalent to hidden deterministic tests.
Command-verifier approval, remediation edges, fallback, and automatic retry of an interrupted
verifier are not part of this contract. The completed strict-output retry doesn't authorize any of
those behaviors.

### Lean proof verifier

The optional `lean-proof` driver verifies one exact namespaced Lean theorem or lemma on a prepared
Linux x64 OCI proof appliance. It is deterministic proof evidence for the submitted formal
statement. It isn't evidence that the statement faithfully represents the source specification or
that non-proof product requirements are satisfied.

```yaml
- id: approve-statement
  type: approval
  dependsOn: [specification, statement]
  approval:
    prompt: Confirm that the formal statement represents the source specification.
    evidence:
      - { nodeId: specification, field: command.stdout }
      - { nodeId: statement, field: command.stdout }

- id: verify-proof
  type: verifier
  dependsOn: [specification, statement, proof, approve-statement, ordinary-tests]
  verifier:
    kind: lean-proof
    targetDeclaration: Flow.Proof.add_zero
    specification: { nodeId: specification, field: command.stdout }
    statement: { nodeId: statement, field: command.stdout }
    proof: { nodeId: proof, field: command.stdout }
    faithfulnessApprovalNodeId: approve-statement
    timeoutMs: 300000
    runtime:
      version: 1
      platform: linux
      architecture: x64
      imageDigest: sha256:<64 lowercase hexadecimal characters>
      buildAttestationDigest: <64 lowercase hexadecimal characters>
      dependencyManifestDigest: <64 lowercase hexadecimal characters>
      leanVersion: 4.33.1
      mathlibRevision: <40 lowercase hexadecimal characters>
      safeVerifyRevision: <40 lowercase hexadecimal characters>
      nanodaRevision: <40 lowercase hexadecimal characters>
      profileDigest: <64 lowercase hexadecimal characters>
```

The specification, statement, and proof each name a unique evidence field on a direct dependency.
Flow accepts the same field kinds as other verifier sources. The statement must be one exact
namespaced theorem or lemma header without `:=`. The proof must be a separate term that begins with
`by`. The approval node must also be a direct dependency, and its complete evidence declaration
must match the verifier's specification and statement sources. A changed source attempt or hash
invalidates the approval.

The `runtime` object is a closed exact identity. It binds the immutable image, build attestation,
dependency manifest, Lean version, Mathlib revision, SafeVerify revision, Nanoda revision, and
containment profile. Flow refuses unsupported platforms, missing fields, live-image drift,
attestation drift, or effective-policy drift before it sends the private request to the appliance.
Revision fields contain full 40-character Git commit IDs. Digest fields contain 64-character
SHA-256 values. An OCI image digest also includes the `sha256:` prefix.

If the proof source is an agent node, Flow records that node's exact provider, model, and thinking
level with an `exact-model-v1` selection rule and `deny` fallback. A command or result proof source
records no model route. The generating model can't change the runtime, approve statement
faithfulness, select a fallback model, or authorize the verifier verdict.

The appliance compiles the exact declaration, replays it with SafeVerify under the fixed axiom
allowlist, and independently checks the complete exported environment with Nanoda. Acceptance
requires matching identities, all three accepted component states, the exact human approval, and
confirmed container removal. Rejection requires complete evidence of a proof or authority failure.
Missing, inconsistent, unavailable, disagreeing, or cleanup-uncertain evidence is inconclusive.

Private durable evidence retains the bounded proof request and component results. Public replay,
inspection, events, and export replace the specification, statement, proof, target declaration,
and diagnostics with identities and byte counts. An interrupted proof verifier is never retried
automatically. Read [Verify an exact Lean statement](guides/lean-proof-verification.md) for the
operator flow and [Operate the Lean proof runtime](operations/lean-proof-runtime.md) for the exact
preparation, containment, and recovery contract.

## Installed capability bundles

Workflow syntax is independent of package transport. The same `skills`, packaged verifier,
`toolPackages`, and workflow-package selections resolve against one project catalog composed from strict local roots and
the digest-pinned entries in `.flow/packages.lock.json`. Flow reopens every referenced
content-addressed blob, checks byte count and SHA-256, re-parses every contained package, and
re-derives bundle name/version before catalog admission. Local and installed package-name
collisions, and provider-facing tool-name collisions, reject the whole composed catalog; there is
no source precedence.

Only `flow packages install` and `flow packages install-oci` use the package network. Workflow
validation and run admission are local. Detached jobs persist the selected immutable capability
snapshot. Child execution, resume, and replay never use a lock source, registry reference,
publisher record, credential input, or current lock/blob. Private OCI authentication is one
challenge-scoped install operation. It leaves no username, token realm, credential mode, password,
Basic value, or Bearer token in package or run state.

When `.flow/packages.metadata.json` exists, new installed-package admission also requires an
unexpired exact active target under the stored authenticated metadata authority. That local state
binds bundle identity, bytes, source, status, and publisher policy. It is not copied into execution
authority. An authenticated empty target set denies every new installation and admission. It does
not revert the project to its pre-metadata rules. Child execution, detached work, resume, and
replay never consult it after admission.

Bundle provenance is
`.flow/packages/sha256/<digest>/<kind>/<name>`, so run evidence identifies exact content without
carrying a network instruction. SHA-256 is content identity. A signed OCI lock record is admission
audit data. Freshness and revocation come only from the optional signed metadata state. Neither the
lock nor metadata is later execution authority.

Metadata channel candidates are also outside workflow authority. One explicit check may stage an
authenticated candidate, and one explicit activation may publish active metadata after repeating
signer, freshness, byte, identity, and monotonic checks. Candidate state is not part of workflow
syntax, catalog snapshots, `run_started`, detached job identity, child ledgers, recovery, or replay.
Removing a candidate cannot change an admitted run or active metadata.

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

On Linux, a read-denied directory can appear as an ephemeral SRT mask. A write call in that mask can
report success, but it cannot change the host run store, `.flow` path, or private collection. On
macOS, the same write call fails. The protected host-write result is the cross-platform contract.

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
    maxOutputTokens: 24576
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

The embedded Pi adapter permits only Flow-owned `read`, `ls`, `edit`, `exec`, `semantic`, and
`artifact` tools.
The allowlist can be empty, and every name must be unique. A tool is unavailable unless the node
declares it.

Every tool operation passes through an attempt-scoped Flow policy broker. The broker canonicalizes
filesystem targets and derives authority from the semantic operation. It permits only actions that
the compiled node declares. `flow_ls` sorts and bounds one directory listing behind one logical
`filesystem.list` authorization. It doesn't spend policy-decision capacity per returned entry.

### Configure the policy-decision limit

Every agent attempt has one shared policy-decision limit. Omit `policyDecisionLimit` to use 64
decisions. Set it to an integer from 1 through 128 when one identified node has a demonstrated need
for a different bound:

```yaml
agent:
  policyDecisionLimit: 96
```

The count includes every allowed or denied operation made through a policy-backed tool. One
`flow_read` or `flow_ls` call records one decision. Reading an admitted `skill://` resource doesn't
record a policy decision. The model receives the effective limit in its system instructions so it
can reserve capacity for final verification.

The same value also limits `flow_exec` and command-tool-package executions in that attempt. Every
command requires one `process.execute` policy decision. A smaller independent command ceiling would
contradict the declared policy budget and could prevent an agent from recording final verification
evidence. The command recorder and durable replay both derive their effective limit from the
persisted node value. Other policy-backed operations consume decisions without consuming command
capacity, so the number of commands can never exceed the policy-decision limit.

The compiler binds an explicit value into the workflow digest. A non-default value also requires a
persisted control graph, which records the override. Live execution stops at that value, and replay
rejects terminal evidence that contains more decisions. Audit exhaustion aborts the model session
and produces `pi_agent_policy_audit_exhausted`. A later provider result cannot replace that failure.

The values 64, 96, and 128 are Flow-specific operational bounds, not cross-framework standards.
Use the 64-decision default until durable run evidence shows that one coherent node needs more
capacity. Prefer splitting a node when its evidence shows repeated broad reads, repeated rewrites,
or unrelated responsibilities. Authorize an override independently of other bounds. Keep the node
timeout, model-token budget, reported-cost budget, 32-effect limit, event-log byte limit, and path
restrictions unchanged.
Change those bounds only when separate evidence supports the change.

Treat 128 as a hard ceiling. It provides defense in depth. Don't treat it as a target.

### Configure the provider-response limit

Use `maxOutputTokens` to limit the output of each provider request made by one agent node:

```yaml
agent:
  maxOutputTokens: 24576
```

The value is optional and must be a positive safe integer. Flow binds an explicit value into the
workflow digest and durable control graph. Pi applies the smaller of this value and the selected
model's pinned output limit. Flow doesn't impose a second arbitrary model-independent ceiling. If
you omit the field, Pi uses the model's pinned limit, which can be much larger than the response
that one workflow node needs.

This limit is distinct from the run-wide `budget.maxModelTokens` value. `maxOutputTokens` bounds
one provider response. `maxModelTokens` accounts for reported input, output, cache-read, and
cache-write tokens across settled model work in the run. The 64 KiB agent-output limit bounds the
retained UTF-8 report, and `timeoutMs` bounds elapsed node execution. Configure and evaluate each
control independently.

There is no universal output-token value for coding agents. Start with the smallest value that
allows one coherent node to finish, and calibrate it from preserved run evidence. Split unrelated
work into dependency-ordered nodes before increasing the cap. The `24576` value above is an
illustrative long-running coding limit, not a default or cross-provider recommendation.

If a provider settles a request because it reached this limit, Flow records
`pi_agent_incomplete`. A node with configured fresh recovery can continue in another attempt only
when the durable model session, usage, and effect receipts satisfy every recovery check. A timeout,
cancellation, lost response, unknown effect, missing usage required by the run budget, exhausted
budget, or exhausted recovery count remains ineligible. The cap therefore improves the chance of
a settled recovery boundary. It does not make an uncertain request safe to repeat.

The new attempt uses only committed portable history. Flow doesn't retain provider-private
reasoning or a partial stream. An output-limited message that contains no portable text, tool call,
tool result, or effect can therefore consume an attempt without advancing the resumable state.
Bound `recovery.maxAttempts` and the aggregate workflow budget independently of this per-response
limit.

The separate 64 KiB report limit remains fixed. When an agent exceeds it, Flow records
`pi_agent_output_limit`. Flow retains only the bounded diagnostic text and complete stream hash.
Flow never accepts the truncated report as node evidence.

A configured fresh recovery can start another attempt only when a durable model session exists.
Every normal recovery proof must also succeed. A committed-edit attempt must have only settled
edits. A completed raw-`exec` attempt must have only settled commands. It also requires complete
process evidence, no unconfirmed termination, and no sandbox-cleanup failure. Neither form can have
a delegation record.

Recovery doesn't enlarge the report limit. It doesn't continue the overflowing provider stream.
It also doesn't automatically execute a previous command again.

`flow_semantic` accepts one closed operation: `diagnostics`, `definition`, `references`, or `hover`.
Every request contains one canonical portable project path. Definition, reference, and hover
requests also contain a zero-based line and character. A semantic workflow requires one exact
operator-selected language-server snapshot. A workflow without semantic access rejects an
unexpected snapshot.

The snapshot binds the canonical manifest, executable SHA-256 and file
identity, fixed arguments, languages and suffixes, initialization options, containment profile,
and request timeout. Detached execution and recovery use the stored snapshot. Resume doesn't
accept a replacement.

The semantic adapter implements a closed LSP 3.18 subset. It starts one server process for one
query against a private copy of the admitted project. The copy excludes `.flow`, `.git`,
`node_modules`, `dist`, `coverage`, and Flow workspace collections at every directory depth. It
contains at most 4096 entries, 32 directory levels, 1 MiB per regular file, and 16 MiB in total. The
sandbox gives the server read-only access to the copy and denies network access. Flow rejects
symbolic links, special files, noncanonical project roots, locations outside the copied project,
malformed protocol messages, unrequested operations, and dynamic server authority.

The selected timeout begins before project capture and bounds the complete active query phase.
Semantic tool calls execute sequentially. One source file is at most 1 MiB. One outbound LSP
request envelope is at most 8 MiB so JSON escaping cannot invalidate the source bound. Each inbound
message is at most 1 MiB.

One query accepts at most 64 inbound messages. Inbound strict JSON is limited to 32 levels and
50,000 nodes. Flow counts and discards at most 64 KiB of server standard error.

Normalized diagnostics and locations contain canonical project-relative paths and zero-based
ranges. Diagnostics include a fixed severity and bounded code and message. Hover contains bounded
plain text or Markdown. One result contains at most 512 items and 1 MiB of canonical JSON. Flow
sorts diagnostics and locations and removes duplicate locations. It doesn't truncate an
over-limit response into a valid result.

An agent attempt records at most 16 semantic receipts. Each receipt binds the canonical request,
project digest, selected-file digest, language-server snapshot digest, sandbox evidence,
normalized result, and canonical result and receipt digests. Flow publishes a receipt only after
the response, source-currentness check, process-tree termination, and sandbox release settle.
Replay validates every digest and requires contiguous receipt sequence numbers. Public output
projects only the operation, item count, digests, and sandbox identity. The complete bounded
request and result remain private run evidence.

A semantic result is advisory. It cannot authorize a policy action, approve an operation, mutate
a file, select a graph transition, satisfy a verifier, or prove goal completion. Flow doesn't retry
a failed semantic request or fall back to an uncontained server. See
[Use read-only semantic code queries](guides/semantic-code.md) for operator steps and fixed failure
categories.

`flow_read` preserves Pi's bounded paging behavior and adds a full-file version marker of the form `sha256:<64-lowercase-hex>`. The digest covers the exact bytes read, not only the displayed page. One read call makes one policy decision even though the underlying reader checks access and then reads the bytes.

`flow_create` accepts `path` and the complete `content` for one new UTF-8 file. Content can be empty and can contain at most 256 KiB of UTF-8 data. It must contain valid Unicode scalar values. The parent directory must already exist. Flow creates the file with mode `0644`.

The tool doesn't create directories, append, or replace any existing filesystem object. A successful call returns the SHA-256 version of the exact created bytes.

`flow_mkdir` accepts only `path`. It creates exactly one empty directory with mode `0755`. The
parent directory must already exist. The tool doesn't create parent directories recursively and
doesn't accept or replace an existing file, directory, or symbolic link. Use `flow_create` in a
later call to add each file inside the new directory.

`flow_edit` accepts `path`, `expectedSha256`, and one to 32 `{oldText,newText}` replacements with at most 256 KiB of replacement text. It edits one existing regular UTF-8 file no larger than 8 MiB. Replacement strings must contain valid Unicode scalar values. Every non-empty `oldText` must occur exactly once, replacements must not overlap, and all matches are computed against the same original content. The edit fails with `stale_version` when the current full-file hash differs. It never performs fuzzy matching, snapshot recovery, or automatic merging.

`flow_replace` accepts `path`, `expectedSha256`, and the complete replacement `content` for one
existing regular UTF-8 file no larger than 8 MiB. The new content can be empty and can contain at
most 256 KiB of UTF-8 data. It must contain valid Unicode scalar values and must change the file.
Use this tool when the desired file is mostly or completely different. Use `flow_edit` for small,
exact substitutions. Both tools fail with `stale_version` when the current full-file hash differs.

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

After policy authorization, Flow reserves bounded evidence capacity and acquires a target-local
exclusive lock. An edit or complete replacement re-reads and preflights the complete request. It
writes and syncs a same-directory exclusive temporary file. It then rechecks the live target bytes
and mode and preserves the existing permission bits.

A file create verifies that the target is absent, writes and syncs a
same-directory exclusive temporary file, and rechecks absence. It then uses an exclusive hard-link
commit so a concurrent filesystem object cannot be overwritten.

A directory create verifies
absence, calls nonrecursive `mkdir`, and sets and verifies mode `0755`. It then verifies that the
directory is empty and synchronizes the new directory and its parent.

While still holding the lock and before the mutation, Flow syncs a `node_effect_prepared` event. The
event contains an effect identity, sequence, operation kind, canonical target, request digest, after
hash, and mode. An edit or complete replacement also contains its before hash. A file or directory create records
`beforeSha256: null`. This value distinguishes an absent path from an empty object. Only then can
Flow rename an edit or complete replacement, link a file create, or call `mkdir`.

Flow settles a file effect as committed after parent-directory synchronization. It settles a
directory effect as committed only after synchronizing both the new directory and its parent. A
post-prepare failure before mutation settles as not applied. A failure after mutation settles as
unknown when journal publication remains available. File creates, directory creates, edits, and
complete replacements share the 32-effect attempt limit.

The lock coordinates cooperating same-host Flow processes: a live owner produces `target_busy`, an exited same-host owner is recoverable, and corrupt or foreign-host ownership fails closed. The run store, `.flow` and `.git` segments at any path depth, environment files, private-key names and suffixes, outside paths, and canonical symlink escapes are protected. Pre-prepare failure leaves the target unchanged without an effect event. A later provider failure retains committed receipts and cannot be classified as side-effect-free.

The target lock coordinates cooperating Flow processes on one host. It is not a security boundary or
a distributed lease. Authorization and mutation are separate application operations. A hostile
process can change path components between them. This release therefore requires a trusted
workspace until agent and tool process isolation is available.

Flow disables Pi's built-in tools. Flow therefore doesn't inherit Pi's fuzzy edits, direct writes,
or optional executable downloads. The node session also disables Pi extensions, skills, prompt
templates, themes, context files, and project discovery.

Flow owns `timeoutMs`. It defaults to five minutes and has a 24-hour limit. Agent report bytes have
a 64 KiB limit independent of `maxOutputTokens`. The ledger retains the bounded text, complete
stream hash, truncation status, policy decisions, and effect receipts. It classifies byte overflow
as `pi_agent_output_limit` and a provider `length` stop as `pi_agent_incomplete`.

Either result can be marked retryable when a durable model session exists. The scheduler still
requires an explicit recovery policy. It also requires remaining budgets and attempts, and a proven
side-effect boundary.

Cancellation aborts the active Pi session. Only Pi's terminal `stop` reason with a nonempty agent
report can make the node succeed. A whitespace-only report produces `pi_agent_empty_output` and
retains the attempt's exact side-effect status. Reaching the policy-audit limit aborts the session
and produces
`pi_agent_policy_audit_exhausted`. A later normal provider stop can't replace that failure.

Flow permits a bounded cleanup grace after timeout, audit exhaustion, or operator cancellation. It
waits for the provider runner and active edit and command reservations. An operation that doesn't
settle produces the applicable terminal error with uncertain side-effect status. It doesn't block
the scheduler indefinitely. Closed audits deny late authorization, receipt publication, or command
execution.

`recovery` is optional and is accepted only on agent nodes. The only current mode is `fresh`.
`maxAttempts` includes the initial attempt, is required when recovery is present, and must be an
integer from 2 through 16. No default object is inserted: omission means an interrupted open attempt
is never retried automatically.

`recovery.backoff` is optional. Its positive `initialDelayMs` value has a 300,000-millisecond limit.
Its `maxDelayMs` value must be at least the initial delay and has a 900,000-millisecond limit.

Flow uses bounded exponential equal jitter before each new attempt. It persists the resulting
`notBefore` deadline in `node_retry_scheduled`. A restart waits for the remaining time, and replay
rejects a start before that deadline. Omission preserves immediate retry behavior.

Fresh recovery is evaluated only when `resume` finds a durable `node_started` without a node
outcome. Flow starts a new in-memory Pi session with the current instructions, tools, authority,
and workspace. It supplies completed provider-neutral history as one new untrusted-data user turn.
It doesn't continue a dangling tool call, partial model output, provider stream, or opaque provider
handle. Read-only attempts qualify only with no effect protocol and no effects. A writable
attempt qualifies only when it declared `flow.effects/v1` and every effect is proven not applied by
executor settlement or recovery reconciliation. Any committed, applied, unknown, open, or legacy
writable state blocks. The retry also requires an attempt below `maxAttempts` and capacity under
`maxNodeStarts`. Declared model-token, reported-cost, or active-execution limits block automatic
fresh recovery because interrupted consumption is incomplete. See [Recovery and interruption
safety](recovery.md) for the event ordering and full refusal table.

An agent selecting raw `exec` can declare `recovery`, but this policy applies only to an eligible
completed provider failure. It doesn't make arbitrary process execution read-only or make an open
command-capable attempt replayable. A prepared command blocks terminal settlement until its outcome
is durable.

The next attempt requires a closed matching model session. Command settlements must be complete,
process termination must be confirmed, and sandbox cleanup must not have failed. The latest-attempt
`flow_exec` result count must equal the command-ledger count. The provider failure must be supported
and retryable. Required accounting must be complete, and budget must remain. The attempt cannot
have a delegation or an unknown edit.

The next attempt continues from the portable history after the recorded command result. The
compiler still rejects recovery with `toolPackages`. Flow doesn't yet define their broader
continuation contract.

Flow disables Pi assistant-turn retries in the embedded session. Each provider request can make at
most two transport retries before it returns an error to Flow. The pinned Pi transport retries only
network failures and retryable HTTP responses. It honors `Retry-After` and applies exponential
backoff with jitter. It rejects a server-requested delay longer than 60 seconds.

These retries finish before a response stream produces a tool call. They don't repeat a Flow
workspace effect.

Flow still owns agent-attempt recovery. If the bounded transport retries fail, the adapter returns
one typed provider failure to the current attempt. A later Flow attempt is allowed only by the
persisted recovery policy, side-effect proof, remaining budget, and `maxAttempts`. Normal
model/tool turns inside one live session remain possible and stay bounded by the node timeout.

### Rolling context policy

An agent can explicitly enable production rolling context:

```yaml
contextCompaction:
  mode: rolling
  pressureThresholdPercent: 85
  protectedConstraints:
    - Preserve failed attempts in the evaluation denominator.
```

`contextCompaction` is optional, closed, and accepted only on an agent node. Omission preserves
nonrolling behavior. When present, `mode` must be `rolling`.

`pressureThresholdPercent` is an integer from 50 through 95 and defaults to 85.
`protectedConstraints` defaults to an empty list. It contains at most 32 unique, nonempty strings.
One string contains at most 4,096 characters. The complete list contains at most 65,536 UTF-8
bytes.

The compiler copies and freezes the list. The workflow digest binds the normalized policy.
Defaults apply only inside an explicitly authored `contextCompaction` object.

The production executor admits rolling context only for the embedded Pi path. A node routed to an
Agent Client Protocol (ACP) executor fails with `rolling_context_unsupported_acp` before agent
execution because ACP doesn't expose the exact serialized-request boundary. Within Pi, only the
`openai-responses` and `anthropic-messages` API adapters have a token-count contract. Any other
adapter fails closed before inference.

Before each rolling task request, Pi serializes the exact provider request through its selected
adapter and Flow intercepts it before network I/O. Flow sends a closed filtered request to the same
origin's token-count endpoint. OpenAI Responses uses `/responses/input_tokens` and records
`provider_exact`. Anthropic Messages uses `/messages/count_tokens` and records
`provider_estimate`. Flow rejects redirects, request bodies larger than 1 MiB, responses larger
than 8 KiB, non-JSON responses, invalid counts, and operations longer than 15 seconds. The private
record contains the captured payload digest and byte count, not the payload, credential, or raw
response.

The captured payload supplies its exact serialized output allowance. Flow evaluates:

```text
usableInputTokens = contextWindowTokens - outputAllowanceTokens - 16384
absoluteSafe = measuredInputTokens <= usableInputTokens
underPressure = measuredInputTokens * 100 >=
                usableInputTokens * pressureThresholdPercent
```

The comparison uses safe integers and integer cross-multiplication. Flow doesn't use byte counts or
a token heuristic as a provider-capacity proof. A measured request is `admitted`,
`reduction_required`, or `over_capacity`.

At pressure, Flow first projects only eligible older oversized command results to validated
same-attempt artifact references. The two most recent completed requests, including complete tool
call/result pairs, remain exact. If an older closed range remains eligible, Flow can start one
rolling epoch with two summary-generation attempts. The attempts serialize output allowances of
4,096 and 2,048 tokens, respectively, with reasoning disabled.

Each attempt exposes only the internal `flow_context_checkpoint` summary tool. Its closed arguments
are `version`, `summary`, and `protectedConstraints`. Flow requests provider-side JSON Schema
constrained sampling when the adapter supports it. That request isn't an admission proof. Flow
ignores reasoning content, rejects mixed or multiple calls and any missing or extra argument,
canonicalizes the exact arguments, and applies the domain validator. The internal tool doesn't run
against the workspace and doesn't extend the node's declared tool authority.

The canonical candidate can contain at most 65,536 UTF-8 bytes. It must retain every protected
constraint exactly and reduce the provider surface by at least 4,096 UTF-8 bytes. An exact legacy
text candidate remains valid when it already satisfies the same canonical domain contract.

One session can start at most eight rolling epochs and 16 summary calls. Summary usage contributes
to node and run token and reported-cost budgets. After an accepted checkpoint, Flow reserializes
the task request. Its endpoint, payload SHA-256 digest, and byte count must equal the admitted
request before inference. Serialization drift fails with
`pi_model_context_checkpoint_invalid`.

Rolling context changes only the provider projection. The private primary-event history remains
append-only. The original objective, current system instructions, tool catalog, authority, budgets,
approvals, effects, protected constraints, and two-request exact tail remain outside generated
summary authority. Read
[Keep long model sessions within provider capacity](guides/rolling-context.md) for operator
guidance.

Command nodes are supported on Linux and macOS. Flow rejects them before spawning on Windows until the command adapter can contain and terminate the full descendant process tree.

An agent node succeeds when its bounded Pi session settles normally. Its text becomes diagnostic
evidence. It cannot name the next node or mark acceptance criteria complete. A downstream command
or verifier must supply goal authority; a downstream result may instead terminate a graph by
publishing validated operational data.

Provider credentials remain outside workflow files and use Pi's configured credential runtime. Provider and model identifiers are execution configuration; no Pi type appears in the compiled or persisted Flow contracts.

## External evaluation profiles

An evaluation plan can select `pi-native-v1`, `omp-native-v1`, or `prime-agent-native-v1` for one
profile. Each adapter can select only its fixed evaluation configuration. The plan cannot select a
command, path, package, or endpoint.

Flow binds the exact adapter, protocol, driver, local dependency closure, harness package closures,
SRT closure, SRT policy, Linux platform, PID namespace, configuration, and broker contract to the
plan digest. Pi identity also binds Node. OMP identity also binds Bun. The version-one Flow-only
identity format does not change.

OMP admission accepts only an official Bun 1.3.14 standard Linux executable whose complete SHA-256
matches the built-in x64 or arm64 attestation. `FLOW_BUN_EXECUTABLE` can select a path, but it cannot
change the trust list. The OMP closure includes runtime Markdown, package instances, dependency
edges, and the directories that control package resolution.

The OMP descriptor supplies a canonical `NODE_PATH` that contains only search containers that
selected a bound package. Ambient `NODE_PATH` is not used. SRT grants read access only to each exact
selected package root. It does not grant read access to a search container or an unselected sibling
package. Flow rejects admission if a selected package root contains an unselected nested package.
The OMP policy digest binds this trusted environment rule.

Immediately before process start, Flow compares the prepared SRT containment, backend, version,
profile, and policy digest with the admitted runtime identity. Flow releases the sandbox and stops
the trial if a value differs.

The Prime profile uses `prime-agent-rlm-evaluation-v1`. It runs only on Linux x64 through the fixed
Docker OCI boundary. The plan cannot select an image, socket, daemon, mount, limit, or Python path.

Prime preparation builds the image twice and requires equal identities. The identity binds the
image, platform config, build inputs, software inventory, runtime closures, policy, and protocols.

The fixed policy permits one daemon-global container. It denies external network, host mounts,
daemon logs, health checks, swap, and ambient Docker configuration. It sets exact CPU, memory, PID,
I/O, file, descriptor, workspace byte, and workspace inode limits.

The Prime host sends one bounded fixture tree after readiness. The container returns one bounded
result tree. Both trees bind file types, modes, sizes, paths, and content hashes.

The container uses a private loopback network namespace only for the persistent IPython kernel.
The Python process cannot reach the host loopback address or an external address.

The trusted supervisor records zero or one kernel request in the outer settlement. It rejects a
second kernel request. Multiple IPython tool calls must use the first persistent kernel.

Flow stores the OCI lease before start. Recovery settles the exact owned container before Flow
records interruption or removes the isolated trial workspace.

Before each trial, Flow writes one durable adapter-start record. Flow then starts the selected
driver in SRT. The child has no provider credentials and no general network route. A private signed
JSONL channel sends model requests to the host broker.

The Pi and OMP profiles have only `read` and `edit`. Both tools accept only existing files in the
canonical trial workspace. The profiles use in-memory sessions and zero retries. The OMP profile
also disables rules, MCP, memory, LSP, IRC, project context, and ambient discovery.
Bun starts with environment-file loading, automatic installation, and workspace configuration
disabled.

The parent records the process exit, signal, timeout, cancellation, containment, and tree
termination. The child cannot assert these values. Missing, forged, repeated, oversized, or
out-of-order frames fail the trial.

Version 1 external harness execution requires Linux. Flow rejects macOS and Windows before it loads
the driver. Pi and OMP also require verified PID-namespace containment. Prime requires the fixed
Docker OCI identity and effective policy evidence.

Each driver reads the pinned session statistics after prompt settlement. It translates the four
token components and reported cost into the Flow-owned usage shape. A settled child result preserves
available usage. A parent-classified timeout or cancellation records unavailable usage because the
parent cannot trust an incomplete terminal metric frame. A failure before a session or provider
observation also records no invented usage. Invalid statistics fail before persistence.

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

## Goal workspace snapshot

A new run can explicitly select the current project goal workspace with `--goal-workspace`. Flow
parses and replays the separate project revision ledger, validates the current complete revision,
and includes it in the immutable capability snapshot. The capability snapshot digest binds the
workspace revision number and digest. `run_started` persists the complete revision.

The selected revision contains a bounded objective, facts, invariants, verified-fact statements,
open questions, one next action, and immutable references to terminal run events. It contains no raw
referenced evidence. Flow renders the objective and text entries for agent nodes but omits evidence
locators from model context. The public run projection can show the locators and event digests for
audit without loading the referenced evidence.

A goal workspace is context, not executable authority. It cannot select packages, add tools, change
policy or budgets, create a transition, or accept a goal or criterion. The deterministic compiled
workflow and durable evidence retain those responsibilities.

Attached execution, detached jobs, child ledgers, replay, and recovery use the exact selected
revision. Resume accepts no live workspace selection and doesn't read the project goal ledger.
Changing or deleting the live workspace therefore doesn't change an existing run.

Read [Maintain a durable goal workspace](guides/goal-workspaces.md) for the source schema, exact
limits, operator commands, compare-and-set updates, and recovery behavior.

## Portable model session record

Each model-backed agent or model verifier node has one private append-only
`flow.model-session/v1` record across its Flow attempts. Flow creates and syncs the record before
publishing that node's first authoritative `node_started` event. The run ledger stores only a
bounded safe summary. Session events cannot schedule work, authorize an operation, satisfy a goal,
or establish node success.

The record is stored at
`.flow/runs/<run-id>/model-sessions/<opaque-session-id>/events.jsonl`. The session identifier is a
deterministic SHA-256 identity derived from the protocol version, run, workflow, and node. Run,
model-session parent, and session directories must be owner-only. The record and ownership paths
must be regular files or directories with the expected owner and no symbolic-link traversal.

Every event has version 1, the protocol, and the session/run/workflow/node identity. It also has a
contiguous sequence, an RFC 3339 timestamp, and the previous head. A SHA-256 head binds the
canonical event. The closed event vocabulary is:

- `session_created`
- `attempt_started`
- `user_message_committed`
- `model_request_prepared`
- `model_message_committed`
- `tool_call_committed`
- `tool_result_committed`
- `model_request_settled`
- `attempt_settled`
- `attempt_interrupted`
- `resume_surface_prepared`
- `context_compaction_started`
- `context_compaction_settled`
- `model_request_capacity_checked`
- `rolling_context_epoch_started`
- `rolling_context_epoch_settled`

The primary prompt is committed exactly once on attempt 1. A request must prepare before its model
message, tool calls, tool results, and settlement. Tool results must match a prior tool call in the
same request. The reducer rejects unknown fields, changed identity, invalid attribution, and
illegal order. It also rejects noncontiguous sequences, changed heads, and invented tool results.
A request identity must match the committed portable-history digest, event count, and byte count.

Before provider input/output (I/O), `model_request_prepared` binds the exact route and runtime. The
route includes the provider, model, API adapter, and thinking setting. The runtime identity includes
the Pi version, system-instruction digest and bytes, and tool-catalog digest, bytes, and count. It
also binds the authority, portable history, runtime surface, and attempt/turn/request coordinates.
Public mismatch reporting uses only the fixed categories `provider`, `model`, `api_adapter`,
`thinking`, `runtime_version`, `system_instructions`, `tool_catalog`, `authority`,
`portable_history`, `runtime_surface`, `attempt`, `turn`, and `request`. It never returns compared
private values.

Portable history includes only the original user prompt and completed assistant or tool events. It
can include bounded usage, request settlement, attempt settlement, and typed interruption
boundaries. It excludes streamed partials, credentials, provider handles, hidden reasoning, thought
signatures, raw diagnostics, and native provider objects. An incomplete or uncertain tool call gets
no invented result. The effect and agent-command protocols remain authoritative for external
operations.

A `tool_result_committed` event can include
`commandAuthorityRejection: "request_not_admitted"` only for an unsuccessful `flow_exec` result.
The host derives this classification from the matching committed arguments, the installed tool
validator, and frozen command authority. Model text and tool-error prose do not establish it.
Argument conversion must match the installed runtime: a raw argument that appears invalid can
still become an admitted invocation before execution. A permitted command's execution failure
must not be classified as proven non-execution.

An optional complete `requests` catalog on frozen agent-command authority contains only version,
executable, ordered arguments, and timeout. Its entries must match the sorted `requestDigests`
exactly once and fit within 65,536 serialized UTF-8 bytes. An optional positive safe-integer
`rejectionLimit` requires that catalog. Both fields participate in the existing authority identity.
Historical digest-only authorities and unclassified results remain valid without synthesized
fields. Do not enrich an active historical run during recovery.

With a refusal limit, the runtime counts classified results across all attempts before each new
model request, including before context-summary generation. At or above the limit it returns
`pi_command_authority_rejections_exhausted`, not a retryable provider outage. The already-issued
batch settles first. Successful work, compaction, and recovery do not reset the count. Public
summaries expose positive cumulative and latest-attempt refusal counts without private inputs.

Command recovery subtracts only those proven pre-execution refusals from raw exec result counts.
All recorded commands still require their ordinary settlement and termination proof.

An eligible fresh recovery appends `attempt_interrupted` to the private record before
`node_attempt_interrupted` enters the run ledger. The next attempt creates a new in-memory Pi
session. Flow renders committed primary history and interruption boundaries as one deterministic
canonical JSON user turn with a fixed untrusted-data instruction. `resume_surface_prepared` stores
only its render version, source head, digest, and encoded byte count. Generated resume surfaces are
never primary history.

A completed strict-invalid model-verifier response uses the same append-only record and fresh
attempt boundary, but it doesn't create `node_attempt_interrupted`. The prior attempt is already
settled and fully accounted. The retry capsule retains the original verifier input and bounded
settlement metadata while omitting the malformed model response.

Resume renderer version 2 deterministically projects a successful `flow_read` result when its text
is larger than 32,768 UTF-8 bytes. The rendered event replaces `text` with `textOmitted`, which
contains fixed `oversized_successful_read_result` reason, SHA-256 digest, exact byte count, and
inline boundary. The paired call keeps the path and range needed for a bounded reread. Exactly
32,768 bytes remains inline.

Failed reads and other tool results remain inline. The complete primary event remains unchanged in
the private record. Replay continues to accept a stored version 1 resume event. Newly rendered
capsules use version 2.

A completed provider execution failure can use the same declared fresh policy. Flow first appends
`node_failed` with complete terminal evidence and resource accounting. It then appends
`node_retry_scheduled` with fixed `retryable_failure`, `fresh_retry`, and `complete` dispositions.
Replay archives the terminal attempt under `failedAttempts` before returning the node to `pending`.
When the policy declares backoff, the retry event carries the deterministic `notBefore` deadline.
The scheduler enforces that deadline before it starts the next attempt.

A side-effect-free failure requires empty effect, command, and delegation history. A failure after
workspace edits also requires `flow.effects/v1` and only committed effect settlements. It requires
a closed model-session record that matches the failed attempt. The record must have no
model-session mismatch. Command and delegation history must be empty. Other committed, open,
unknown, or uncertain operations remain ineligible.

Every path requires an attempt remaining and available budget. Evidence must be complete for each
declared model-token, model-cost, or execution-time limit.

The dedicated compaction evaluator can derive a smaller provider surface without changing primary
history. `references` mode projects only validated same-run command artifact references. It keeps
the original tool result when a reference is invalid, unavailable, or not smaller.

`references-and-summary` mode first applies the same reference projection. It keeps the original
objective, latest completed request, current system instructions, tool catalog, authority, and
protected constraints outside model-generated summary text. `context_compaction_started` binds the
source head, closed primary-event range, range identity, reference-surface identity, generation
number, and output-token limit before provider I/O.

`context_compaction_settled` closes that exact generation as accepted, rejected, or interrupted.
An accepted settlement binds output identity, model usage, before and after bytes, minimum
reduction, and protected-constraint evidence. One session can accept one summary at most. It can
start no more than two generations, and the second output-token limit must be smaller. A rejection
keeps the prior surface.

Recovery settles an unmatched compaction start as interrupted before it closes the interrupted
model attempt. A second generation reconstructs its source from committed primary events. It does
not continue provider-native state. No ordinary workflow field selects an evaluation compaction
mode, and no evaluation report can activate one.

The separate production rolling policy uses `model_request_capacity_checked` as a write-ahead
admission record for each task and summary payload. Checks are contiguous and bind their operation,
attempt, adapter, payload identity, measurement status, provider method or fixed failure category,
capacity arithmetic, and decision. A successful task check must match the next
`model_request_prepared` event's provider-payload identity.

`rolling_context_epoch_started` binds the task request, epoch, generation attempt, and cumulative
and delta primary-event ranges. It binds the reference surface, output allowance, provider, model,
adapter, and declared model capacity. It also binds the thinking level, runtime, instructions,
tools, authority, routing, and policy identities before summary provider I/O.

`rolling_context_epoch_settled` closes the same start. Its outcome is accepted, rejected, or
interrupted. An accepted private settlement contains the summary text, checkpoint identities, and
range. It also contains reduction, constraint, binding, policy, and usage evidence.

Rejected and interrupted settlements contain no recoverable summary text.

An eligible private `tool_result_committed` event can contain a bounded `referenceProjection`. The
event always retains the complete result text. The projection binds its exact original and
projected UTF-8 byte counts and one or two unique artifact references. The projected JSON must have
version `1`, kind `flow.reference-tool-result`, contain every bound reference, and be smaller than
the complete result. Summary serialization uses it only after the artifact store confirms that
every bound reference is retained, available, and identical.

Replay requires contiguous checks, at most eight epochs, at most two generation attempts in each
epoch, and a 4,096-token then 2,048-token allowance sequence. Cumulative ranges can grow only over
original committed primary events, and each later delta begins after the prior accepted cumulative
range. A current checkpoint is valid only when its source, bindings, policy, protected-constraint
identity, rendered surface, and accepted settlement agree. The public summary projects only counts,
capacity arithmetic, uncertainty, digests, byte counts, fixed failure categories, and active state.
It doesn't project payloads, summary text, constraints, prompts, tool output, credentials, error
bodies, or private paths.

A recovered session with an accepted checkpoint uses a bounded
`flow.rolling-context-bootstrap`. The bootstrap contains protocol, session, source, summary,
binding, and policy identities. It contains no objective, summary text, tool result, or complete
pre-checkpoint event list. Flow restores the exact objective, checkpoint summary, and committed
tail before it serializes the provider request.

One encoded event, including its newline, is at most 2 MiB. One record is at most 16 MiB and 1,024
events. One rendered resume surface is at most 1 MiB and must fit the selected model. Nonrolling
request admission reserves 16,384 output tokens and 16,384 safety tokens. Rolling admission uses
the exact output allowance serialized in the provider payload and the same 16,384-token safety
reserve.

Flow checks the safe zero-input capacity for the fixed 4,096-token summary allowance before it
starts an epoch. The selected model must also permit at least 4,096 output tokens. Each settled
summary provider response with valid usage contributes its returned token and cost usage. This
rule also applies when Flow rejects the candidate. Positive provider costs round up to at least one
micro-dollar.

Invalid provider usage closes the active epoch with a content-free `provider_error` settlement
before Flow returns the validation error.

Cancellation during count or summary inference closes the active epoch with an interrupted
settlement. It doesn't produce an ordinary rejected settlement.

Flow then applies the smaller remaining numeric capacity and global byte limit. The conservative
byte comparison isn't a provider tokenizer.
Missing or exhausted capacity fails before provider I/O. An oversized runtime surface also fails
before provider I/O.

An exclusive same-host owner serializes appends. A final unterminated JSONL fragment is
uncommitted and can be truncated after recovery claims the record. Corruption within the committed
prefix, missing required history, live ownership, unsafe storage, or an exceeded limit blocks
recovery. Public inspection refreshes the safe summary from the private record. If refresh fails,
the projection retains the durable summary, adds `inspectionStatus: unavailable`, and reports only
allowlisted mismatch categories.

Read [Inspect and recover portable model sessions](guides/model-sessions.md) for operator guidance
and [Evaluate reference-first context compaction](guides/context-compaction.md) for the experimental
provider-surface contract. Read [Recovery and interruption safety](recovery.md) for the complete
proof gate and ordering.

## Run ledger

Each run is stored at:

```text
.flow/runs/<run-id>/events.jsonl
```

Events have a version, contiguous sequence number, timestamp, run identity, workflow identity,
workflow API version, and SHA-256 digest of the compiled workflow. New `run_started` events also
capture the effective work profile, normalized execution directory, command approval requirements, agent-command approval
requirements, agent recovery
requirements, declared concurrency, verifier declarations, the bounded control-graph projection, and exact compiled budget
when declared. Runs with an effective maximum above one must persist the graph even without control
nodes. The control graph persists dependency, guard, exact condition, and join mappings so replay does not
consult mutable workflow input to interpret branch history. A recovery requirement records the node,
fresh mode, maximum attempts, and whether replay requires no effect protocol or
`flow.effects/v1`. When declared, the compiled goal is also captured, so replay and inspection do
not need the original workflow file. Model-backed `node_started`, `node_attempt_interrupted`,
`node_succeeded`, and `node_failed` events can carry only the bounded public model-session summary.
`node_retry_scheduled` carries no private model content. The private event bodies remain outside
the authoritative ledger.

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

`node_retry_scheduled` can follow one completed opted-in provider failure only when the shared
proof gate accepts it. The ordinary path is side-effect-free and contains no effects, commands, or
delegations.

The committed-edit continuation path requires the durable effect protocol and only committed
workspace-edit settlements. It also requires a closed model-session record for the same failed
attempt. Command and delegation history must be empty. The attempt cap must have capacity. Each
declared resource limit must remain accountable and unexhausted. The prior `node_failed` event has
already charged terminal evidence.

The reducer archives the evidence, error, edit receipts, and model session under `failedAttempts`.
It returns the node to pending and preserves the next-attempt invariant. Replay rejects a generic
`run_failed` event when this retry disposition is required and still eligible.

Agent-command approval history retains every exact request, decision or cancellation, expiry, and
single command consumption on its running node. `node_agent_command_prepared` carries the approval
reference when the compiled node requires it. Replay rejects missing or extra references, changed
commands, digests, working directories, attempts, lifetimes, early or expired grants, reuse, and
terminal outcomes with pending or unconsumed authority.

Agent evidence retains at most the node's configured policy-decision limit. The default is 64, and
the hard maximum is 128. Each decision has a contiguous attempt-local sequence.

It records exact run, workflow, node, and attempt attribution. It also records derived authority,
semantic action, and a canonical target of at most 1024 UTF-8 bytes. The record includes the allow
or deny reason and the SHA-256 request digest. Write decisions also retain the exact operation
digest.

Agent evidence retains at most 32 edit effect receipts. Each receipt records the same attribution,
canonical target, operation digest, and before and after SHA-256 values. It also records a committed
or uncertain outcome. Terminal events are illegal while an effect lacks an executor settlement. A
recovery observation alone doesn't terminalize an attempt. Every prepared effect must match a
distinct allowed write decision, including a not-applied effect.

Receipts exactly project committed and unknown executor settlements. Not-applied settlements and
recovery observations produce no receipt. Recovery reconciliation records applied, not-applied, or
unknown target state with a bounded reason. It includes the observed digest and mode only for a
stable regular file. Exact and divergent observations are cross-checked against the prepared
descriptor.

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
A single serialized JSONL event is at most 20 MiB. The limit includes worst-case JSON escaping and
one complete 16 MiB capability snapshot.

Fresh and recovered execution publish complete ownership metadata atomically before appending. The metadata contains a process ID and random token. A live process blocks another claimant; an exited owner can be moved aside atomically; corrupt or incomplete ownership metadata fails closed. This provides exclusive same-host execution, not a distributed lease. Creating `events.jsonl` still atomically grants a fresh run identifier. The ledger's run ID must match its directory name.

Node-start events are synced before an executor is invoked. Node-result events are synced before the scheduler advances. Owner appends validate one transition against cached reduced state instead of rereading history. Each append syncs the file, and every newly created run-directory ancestor is synced where the platform supports directory handles. A valid or invalid unterminated trailing JSONL fragment is treated as uncommitted and truncated before a later append; corruption in an earlier committed record fails closed.

The reducer accepts only legal state transitions. It reconstructs run state together with immutable
resources, budget, goal, criterion, and approval state. Run state can be `running`,
`waiting_for_approval`, `succeeded`, `failed`, `cancelled`, or `resource_exhausted`.

Cancellation before a run claim creates no ledger. Cancellation during a node creates a failed
node attempt and retains settled evidence. Cancellation between attempts appends `run_cancelled`
without starting more work. A committed settlement limit or a blocked start can instead require
durable `resource_exhausted` state.

Safe-boundary recovery appends `run_resumed`, preserves committed outcomes and approval state, and
skips successful nodes. It can continue the next ready node, return to an operator wait, or finalize
a committed failure or exhausted settlement. Recovery first observes each open typed filesystem
effect under target coordination. Flow refuses the unfinished node unless replay proves every
effect was not applied. The persisted opt-in and all attempt and resource limits must also permit a
separate `node_attempt_interrupted` disposition. Replay never consults model transcripts or
implementation rationale.

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

Version 1 admits exactly two built-in profiles. A profile uses `flow-workflow-v1`,
`pi-native-v1`, or `omp-native-v1`. Each plan declares a versioned suite of bounded tasks, portable fixture and
instruction paths, a private `filesystem-v1` verifier, one shared provider, model, and `thinking`
tuple, an exact run budget, `network: deny`, zero provider and harness retries, unique seeds,
`paired-alternating-v1`, and fixed comparison constraints. Each Flow workflow must contain at least
one model-bearing node. It must match the declared model and budget at each graph level.

A plan for one composed model-routing artifact also declares an ordered two-entry `modelRoutes`
tuple. The entries name the baseline and candidate profiles, target the same root agent node, and
match the candidate's before and after routes. The shared model still applies to every other agent
and model verifier.

Each effective profile also records the admitted workflow ID. A routing header must bind both values
to the candidate scope. Historical non-routing headers can omit this field. Plans without
`modelRoutes` keep the existing shared-model contract and digest.

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

Flow can create this document with one provider-neutral model call:

```text
flow candidate generate <baseline> <evidence>... --output <candidate.yaml> \
  --id <id> --version <semver> --allow-nodes <id,...> \
  --provider <provider> --model <model> \
  [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
```

The command requires 1 through 16 evidence files and 1 through 16 unique root-agent targets. The
default timeout is 300000 ms. The maximum timeout is 86400000 ms. The default and maximum model
output limit is 8192 tokens. The rendered model input is at most 1 MiB. The raw model output is at
most 64 KiB.

The model request contains the exact workflow identity, each selected current prompt and its hash,
and the parsed tuning packets. The request does not contain other workflow prompts, regression or
holdout records, verifier data, workspace data, activation state, tools, skills, or packages. The
model must return one strict JSON object with a `changes` array. Each item contains only `nodeId` and
`value`.

Flow adds an optional `generation` object to a generated candidate. It records version `1`, kind
`model`, the provider, model, thinking level, system-prompt hash, request digest, response digest,
limits, target hashes, and reported usage. A hand-written candidate can omit this object. The
candidate identity includes it when it is present. The response digest identifies the canonical
validated `changes` object. It does not identify or retain the raw provider transcript.

Candidate source is at most 1 MiB. The projected workflow is at most 8 MiB. Identifiers and semantic versions are canonical. Baseline and
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
declared comparison baseline. Public headers distinguish prompt-candidate projections from
file-backed workflow sources. Direct file sources omit the discriminator to preserve version-1 plan
digests and legacy resume. Generation does not evaluate or activate the candidate.

### Agent Skill candidates

An Agent Skill candidate is a separate inert document that projects resource bytes in one exact
already-selected package without changing the workflow:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: AgentSkillCandidate
metadata: { id: better-review, version: 1.0.0 }
scope:
  kind: workflow-agent-skill
  workflowId: evaluated-profile
  skillName: review
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  skill:
    path: .flow/skills/review
    packageDigest: <64-lowercase-hex>
evidence:
  - path: tuning-evidence.json
    sourceSha256: <64-lowercase-hex>
    evidenceDigest: <64-lowercase-hex>
    planDigest: <64-lowercase-hex>
changes:
  resources:
    - path: reference.md
      expectedSha256: <64-lowercase-hex>
      value: Review correctness, security, and evidence.
```

Flow can create the resource-delta document with one bounded provider-neutral model call:

```text
flow candidate generate <baseline> <evidence>... --output <candidate.yaml> \
  --id <id> --version <semver> --skill <name> --allow-resources <path,...> \
  --provider <provider> --model <model> \
  [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
```

The command requires 1 through 16 tuning-evidence files and 1 through 16 unique existing inert UTF-8
resources. `SKILL.md` and files below the top-level `scripts/` directory are excluded. The workflow
must select exactly the named skill and no other package capability.

The rendered input is at most 1 MiB. Raw output is at most 64 KiB. The default timeout is 300000 ms.
The default and maximum output limit is 8192 tokens.

The strict response contains only `changes`, with `path` and non-empty `value` in each item. Flow
rejects unknown fields, duplicate or unselected paths, unchanged content, invalid UTF-8, excessive
bytes, and any source drift. The optional generation identity records the exact provider, model,
thinking level, bounds, usage, request digest, response digest, and selected target hashes. It does
not retain the raw provider transcript.

The source is at most 1 MiB. It declares 1–16 unique evidence packets and 1–16 unique existing
UTF-8 resource replacements. Each resource value is non-empty, is bounded by the Agent Skill file
limit, and contributes to the package limit. Candidate, workflow, evidence, and skill paths are
portable relative paths under the candidate directory and are admitted without following links.

The workflow must select exactly one Agent Skill and no other package capability. The selected name,
package provenance, package digest, workflow source digest, compiled workflow digest, and tuning
evidence must match the candidate. Projection preserves package name, description, license,
compatibility, metadata, requested tools, trust, provenance, file paths, and file count. It replaces
only the declared bytes and recomputes the package and capability digests. A `SKILL.md` replacement
must parse to the same manifest authority.

Paired evaluation uses the same compiled workflow for both profiles. The baseline receives the
original capability snapshot and the candidate receives the projected snapshot. The normal runner
binds each snapshot to the workflow before execution. The public identity contains only portable
provenance and hashes. Durable inspection remains available after live source removal.

`flow candidate validate <candidate.yaml>` accepts prompt or Agent Skill candidates and is read-only.
Generation publishes one inert candidate file without replacement. It does not evaluate, activate,
install, publish a package, add or delete a package file, or select a candidate automatically.
Evaluation success grants no authority until an operator applies the exact activation proposal.

### Agent Skill package candidates

An Agent Skill package candidate is a bounded review directory that introduces one new inert
package into a workflow that selects no skills:

```text
candidate-output/
├── CANDIDATE.json
└── skill/
    └── <skill-name>/
        ├── SKILL.md
        ├── references/...
        └── assets/...
```

The operator creates a strict content-free blueprint and selects the baseline, tuning evidence,
output directory, candidate id/version, provider, model, and limits:

```text
flow candidate generate <baseline> <evidence>... --output <candidate-directory> \
  --id <id> --version <semver> --blueprint <blueprint.json> \
  --provider <provider> --model <model> \
  [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
```

The blueprint fixes the skill name, description, optional license, compatibility, and public
metadata. It also fixes requested tools, workflow id, one root agent target, and 1–16 exact portable
file paths. It contains no proposed content. `SKILL.md` is required. Other paths must be below
`references/` or textual `assets/`.

Scripts, executable modes, binary extensions, and binary bytes reject. Links, special files, and
traversal also reject. Duplicate paths and undeclared files reject.

Generation uses one model turn with no tools, skills, packages, workspace reads, commands, effects,
or retries. The default and maximum model output limit is 8192 tokens. Raw output is at most 65536
bytes. The strict response contains content for every declared path exactly once. Flow renders the
`SKILL.md` frontmatter from the blueprint and uses the model result only as file body content.

The baseline workflow must select no Agent Skills. The target must be one root agent that already
has the `read` tool. Projection changes only that node's `skills` field from `[]` to the generated
skill name. Every other workflow field remains exact. The projected capability snapshot contains
exactly the generated package.

`CANDIDATE.json` binds the baseline, evidence, blueprint, generation request and response, exact
package, projected workflow, capability state, and candidate identity. It contains hashes and
portable provenance, not generated file contents or absolute paths. Candidate admission uses
stable no-follow reads, exact entry and byte bounds, source revalidation, and executable-mode
rejection. Publication uses a private same-parent staging directory and one no-replace directory
rename. A post-rename settlement failure reports publication uncertainty instead of regenerating.

Paired evaluation gives the baseline profile the original workflow and zero packages. It gives the
candidate profile the projected workflow and exact generated package. Activation stores both
states. Rollback to `baseline` restores the original workflow with no package. The selector
`agent-skill-package:<candidate-id>@<version>` identifies a stored package-introduction candidate.
Existing prompt and resource-candidate encodings and digests are unchanged.

Generation and validation do not install, sign, publish, or execute the review directory. Before
activation, validation depends on the sibling source files named by the candidate. After activation,
new runs, detached workers, resume, recovery, replay, inspect, and export use only durable workflow
and package bytes.

### Model-routing candidates

A model-routing candidate is a separate inert document. It changes one existing root agent model
tuple and no other workflow field:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ModelRoutingCandidate
metadata: { id: route-implement-to-gpt, version: 1.0.0 }
scope:
  kind: workflow-model-route
  workflowId: evaluated-profile
  nodeId: implement
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
route:
  before: { provider: test, id: deterministic, thinking: medium }
  after: { provider: openai, id: gpt-5.4, thinking: high }
```

Candidate source is at most 65536 UTF-8 bytes. Candidate and workflow paths are canonical portable
relative paths. The provider is a canonical identifier. The model id is 1 through 256 trimmed
characters. The thinking level is one closed workflow thinking value. The routes must differ.

Admission uses stable no-follow reads and revalidates every observed directory and file identity.
The baseline hash, compiled digest, workflow id, target node, and before route must match exactly.
The target must be a root `agent` node. Projection replaces only its `agent.model` value, emits
deterministic JSON, recompiles the workflow, and rejects any other difference.

The public identity binds the source, baseline, target, before route, after route, projected workflow,
and candidate digest. It contains no workflow body, credential, endpoint, price, availability rule,
or provider response.

`flow candidate validate <candidate.yaml>` is read-only. Use
`flow candidate compose <candidate.yaml>` to bind the route to the exact current effective head.
Direct activation of the ordinary route document fails. Evaluation binds the composed artifact and
the exact ordered `modelRoutes` pair. Execution receives only the selected profile route.

Flow does not discover models or choose a route from task content. It does not route child workflows
or change model verifiers. It does not balance traffic, retry another route, or use a fallback.

### Phase-routing candidates

A `PhaseRoutingCandidate` is an inert complete route-profile pair for one exact workflow. Each
profile uses `selectionRule: exact-target-v1`, `fallback: deny`, and one ordered assignment for every
model-bearing root or embedded-child node. An assignment contains one closed phase label, exact
target, and model route:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: PhaseRoutingCandidate
metadata: { id: specialize-execution, version: 1.0.0 }
scope: { kind: workflow-phase-routing, workflowId: evaluated-profile }
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
profiles:
  before:
    selectionRule: exact-target-v1
    fallback: deny
    assignments:
      - phase: executor
        target: { workflowId: evaluated-profile, childPath: [], nodeId: implement }
        route: { provider: test, id: deterministic, thinking: medium }
  after:
    selectionRule: exact-target-v1
    fallback: deny
    assignments:
      - phase: executor
        target: { workflowId: evaluated-profile, childPath: [], nodeId: implement }
        route: { provider: openai, id: gpt-5.4, thinking: high }
```

The phase is one of `planner`, `executor`, `verifier`, or `escalation`. The `before` and `after`
profiles must preserve ordered target and phase identity, and at least one route must change.
Targets are unique and use the root workflow id. `childPath` lists embedded child node ids from the
root. Packaged-child and expanded generated model nodes are unaddressable and reject the candidate.

The source is at most 1,048,576 UTF-8 bytes. Admission performs stable no-follow reads of the
candidate and baseline. It validates the source and compiled baseline identities and builds
deterministic baseline and candidate workflow projections. Projection changes only declared
provider, model id, and `thinking` tuples. The public candidate identity binds both profile digests,
both workflow projection identities, provenance, and one candidate digest.

`flow candidate validate <candidate.yaml>` is read-only. `flow candidate compose
<candidate.yaml>` binds the profile pair to the exact effective head and stages one immutable
artifact. Direct activation of the ordinary candidate fails.

An evaluation plan for this surface uses `purpose: phase-routing-v1`. Both `flow-workflow-v1`
profiles select the same composed artifact with ordered `baseline` and `candidate` selections.
`controls.phaseRoutingProfiles` contains the matching ordered profile digests. All tasks must be
filesystem-verified holdouts. `comparison.minimumEffect` must be `0`, and the plan must declare
positive `minimumCostReductionRate` and `minimumLatencyReductionRate` values.

Before each provider request, Flow resolves the active profile by exact workflow id, child path,
and node id. The durable model-request identity contains the phase, route, selection result,
fallback result, escalation result, profile digest, and decision digest. A missing, ambiguous,
stale, or mismatched decision fails before provider I/O. Flow rejects phase routing through an ACP
executor and rejects provider-generated context summaries because those provider calls aren't
independently routed in this version.

Offline aggregation includes every scheduled held-out pair. It requires the same environment,
complete deterministic verification, and non-inferior candidate quality. It also requires complete
per-request cost and latency, both efficiency thresholds, and the declared safety limits. It emits
`qualified`, `not_qualified`, or `insufficient_evidence`. Only `qualified` can activate the exact
composed artifact. The ordinary superiority verdict doesn't grant phase-routing authority.

Read [Evaluate and activate phase-aware model routing](guides/phase-routing.md) for the operator
procedure and verdict recovery.

### Child-specialist candidates

A child-specialist candidate is an inert document that changes one agent in one embedded child
workflow:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ChildSpecialistCandidate
metadata: { id: stricter-review-specialist, version: 1.0.0 }
scope:
  kind: workflow-child-specialist
  workflowId: specialist-harness
  childNodeId: delegate-review
  agentNodeId: review
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  child:
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  packageClosureDigest: <64-lowercase-hex>
change:
  kind: instructions
  beforeSha256: <64-lowercase-hex>
  value: Review the implementation and identify unsupported claims.
```

The source is at most 1 MiB. The declared baseline path and the public candidate provenance are
canonical portable relative paths. The metadata id, workflow id, child node id, agent node id, and
Agent Skill names use canonical identifiers. Replacement instructions are nonblank and at most
262,144 UTF-8 bytes.

The `change` value is one strict discriminated union:

- `instructions` contains the exact baseline SHA-256 and one replacement value.
- `skills` contains exact ordered `before` and `after` lists. Each list contains at most 32 unique
  names. The lists must differ. Every name in `after` must identify an Agent Skill already present in
  the complete immutable package closure.

Unknown fields, both axes, a no-op, duplicate skill names, missing baseline identity, or an
undeclared package reject. The source cannot add package bytes or change package authority.

Admission observes every lexical ancestor and opens the candidate and baseline with no-follow
semantics. Each regular file uses bounded chunked reads and pre-read, post-read, and final identity
checks. Fatal UTF-8 decoding applies. Cancellation keeps the exact caller reason at each asynchronous
boundary. Public admission errors contain one fixed stage without a path, source value, private
cause, or rejected instructions.

The baseline must compile to the declared root workflow. The selected root node must be an embedded
child, not a workflow-package reference. Its exact source and compiled digest must match. The
selected child node must be an agent, and the declared before value must match both source and
compiled state.

Projection changes only `agent.prompt` or `agent.skills` on that child agent. Flow serializes the
child into the parent and recompiles the complete workflow tree. It restores the declared field and
the derived child digest before it compares every other compiled field. The complete projected root
workflow is at most 8 MiB.

The version-1 public identity binds these values:

- candidate id, version, source provenance, and source digest.
- root and embedded-child source and compiled digests.
- workflow, child, and agent scope plus the complete package-closure digest.
- declared before and after identities plus projected root source and workflow digests.
- canonical candidate digest.

For an instructions change, the public before and after identities contain only UTF-8 byte counts
and SHA-256 digests. A skill change contains the bounded ordered names. The identity contains no
workflow body, instructions, package content, provider response, absolute path, or nested cause.

`flow candidate validate <candidate.yaml>` checks the candidate against the current effective
harness package closure. `flow candidate compose <candidate.yaml>` rebases only the declared axis
onto the exact current effective head and stages a complete effective artifact. A stale target or
closure rejects. Direct activation of the ordinary document rejects.

Paired evaluation selects the artifact's complete baseline and candidate states. All non-candidate
controls and package bytes remain equal. Activation and rollback use the effective harness store.
Runs persist the selected complete state. Attached, detached, and child execution use that state.
Resume, recovery, replay, inspect, and export don't reopen the ordinary candidate or a live package
catalog.

This candidate doesn't change graph topology, dependencies, results, budgets, models, tools, tool
packages, commands, approvals, verifiers, policy, retries, sandboxing, or workflow packages. It
doesn't add runtime discovery, delegation, handoff, fallback, memory, or child workspace promotion.

### Supplemental-memory candidates

A supplemental-memory candidate is an inert document that changes one bounded reference entry for
one existing agent:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: SupplementalMemoryCandidate
metadata: { id: reviewed-project-layout, version: 1.0.0 }
scope:
  kind: workflow-agent-memory
  workflowId: adaptive-workflow
  childPath: []
  agentNodeId: implement
  entryId: project-layout
baseline:
  stateDigest: <64-lowercase-hex>
  workflowDigest: <64-lowercase-hex>
  packageClosureDigest: <64-lowercase-hex>
change:
  kind: add
  value: Use the reviewed package map when locating implementation owners.
```

The source is at most 1 MiB. Identifiers use the canonical workflow identifier grammar.
`childPath` contains at most eight child-node IDs. It is empty for a root agent and contains the
ordered path for an agent in an embedded child workflow.

The `change` value is one strict discriminated union:

- `add` contains one nonblank `value` and requires the target entry to be absent.
- `replace` contains the exact current `beforeSha256` and one nonblank replacement `value`.
- `remove` contains the exact current `beforeSha256` and no replacement value.

One complete state contains at most 16 entries. One entry contains 1 through 16,384 UTF-8 bytes.
The aggregate for one target is at most 16,384 bytes. The aggregate for one state is at most
65,536 bytes. Entry identity is the root workflow ID, ordered child path, agent node ID, and entry
ID. Entries are unique and sorted by this identity.

Each durable entry stores the exact byte count, SHA-256 digest, and canonical base64 bytes. Parsing
uses fatal UTF-8 decoding and rejects duplicate, reordered, malformed, stale, or noncanonical data.
The state and runtime digests bind target and byte identity. Historical states without a memory
catalog omit the field and keep their version-1 digest.

Admission observes every lexical directory from the filesystem root and rejects links or
replacement. It opens the candidate as a bounded regular file with no-follow semantics. It binds
the device, inode, size, modification time, change time, and SHA-256 digest. Flow repeats the
observations before return. Cancellation keeps the exact caller reason at each asynchronous
boundary.

The baseline must match the current effective state digest, workflow digest, package-closure
digest, and root workflow ID. The target path must resolve to an existing compiled `agent` node.
Projection changes only the declared entry. It preserves workflow bytes, root package, package
order and bytes, and every unrelated memory entry. Add, replace, and remove each must change the
complete state digest.

The public candidate identity binds the source, baseline state, package identities, exact target,
entry ID, operation, and projected state digest. It also binds the content-free before and after
byte identities. It contains no memory content, encoded content, absolute path, or nested cause.

#### Declare supplemental-memory relationships

The optional strict `relationships` object changes relationships incident to the candidate entry:

```yaml
relationships:
  remove:
    - id: prior-layout-support
      beforeDigest: <64-lowercase-hex>
  add:
    - id: revised-layout-support
      predicate: supports
      from:
        entryId: project-layout
        entrySha256: <64-lowercase-hex>
      to:
        entryId: accepted-package-map
        entrySha256: <64-lowercase-hex>
      evidence:
        - runId: package-review-43
          nodeId: implement
          attempt: 1
```

Both arrays are required. Together, they contain one through eight operations. A removal binds one
relationship ID and its exact current digest. An addition contains one of these closed predicates:
`supports`, `contradicts`, `refines`, `supersedes`, or `derived_from`.

Each endpoint binds an entry ID and SHA-256 entry version in the candidate's exact workflow, child
path, and agent target. At least one endpoint of every removed or added relationship must be the
candidate entry version. Replacement and removal must explicitly remove every relationship
incident to the prior version. A replacement can add relationships against its new version. A
removal cannot add a relationship.

`supersedes` is valid only from the replacement version to the exact prior version of the same
entry. `refines` and `derived_from` must remain acyclic across the active relationship set. A
`contradicts` relationship remains unresolved and doesn't suppress either endpoint. Flow performs
no truth, winner, confidence, transitive, symmetric, temporal, or validity inference.

Each addition cites one through four unique evidence locators. A locator identifies one terminal
`node_succeeded` or `node_failed` event with non-null evidence by run ID, target agent node ID, and
attempt. Flow requires exactly one match in the selected root or embedded workflow. It resolves the
locator to the event sequence and complete parsed-event digest before projection. Missing,
ambiguous, corrupt, cancelled, or cross-agent evidence rejects without a fallback.

One state contains at most 32 relationships, four incident relationships for one active entry, and
128 total evidence references. Canonical serialized relationship metadata is at most 131,072 UTF-8
bytes. The canonical model-visible block for one target is at most 8,192 UTF-8 bytes.

The state relationship sidecar stores canonical relationships and a deterministic assessment. The
assessment binds the relationship-set digest, relationship count, evidence-reference count,
unresolved-contradiction count, and its own digest. Candidate, effective-state, runtime, evaluation,
and activation identities cross-bind the relationship set and assessment. Historical data that
omits the sidecar preserves its version-1 shape, digest, and prompt bytes.

Public candidate views expose content-free removed and added relationship identities. Public state
and run views expose only counts and integrity digests. They omit memory bytes, evidence locators,
absolute paths, and nested private causes. For the operator workflow, see
[Manage supplemental-memory relationships](guides/supplemental-memory-relationships.md).

#### Generated supplemental-memory source

`flow candidate generate` can create an `add` or `replace` source from the current effective state
and admitted tuning evidence. The operator supplies the workflow ID, ordered child path, agent node
ID, entry ID, operation, candidate identity, output path, and exact model tuple. The model supplies
only the `value` string. Generated removal is invalid.

The generator performs one turn with no tools, Agent Skills, tool packages, workspace authority,
or retry. Its strict response schema is `{"value": string}`. Additional keys, explanations, and
Markdown fences reject. Flow validates the provider, model, text hash, truncation status, and
one-turn activity. It also requires zero tool activity, zero effects, zero policy decisions, and
complete usage before it constructs the ordinary source.

The optional source `generation` object has these fixed properties:

| Field | Contract |
| --- | --- |
| `version`, `kind` | Version `1` and kind `model` |
| `provider`, `model`, `thinking` | Exact selected model tuple |
| `systemPromptSha256`, `requestDigest`, `responseDigest` | Canonical prompt and JSON exchange identities |
| `limits` | One candidate, one turn, 1 MiB of input, 65,536 response bytes, and at most 8,192 output tokens |
| `operation`, `priorSha256` | Add with no prior digest, or replace with the exact prior digest |
| `evidence` | One through 16 unique portable paths, source hashes, evidence digests, and plan digests |
| `usage` | Bounded nonnegative values |

Admission reopens every declared evidence file with bounded no-follow reads. It reconstructs the
canonical request from the admitted complete state, exact target agent prompt, target memory,
tuning evidence, model tuple, and limits. It reconstructs the canonical response from the proposed
value. Both digests must match. The evidence must cover the baseline workflow. Before publication,
Flow revalidates the evidence and requires the active head and complete state to remain exact.

Generated and hand-authored sources have the same projection, evaluation, activation, execution,
recovery, replay, and rollback contracts. Public projections retain content-free identities and
remove evidence paths. Generation cannot compose or activate its output.

A generated source cannot contain `relationships`. The model supplies only the memory `value`. It
cannot add, remove, or rebind a relationship.

`flow candidate validate <candidate.yaml>` is read-only. Use
`flow candidate compose <candidate.yaml>` to bind the change to the exact current effective head.
Direct activation of the raw document rejects. A paired evaluation selects the complete staged
artifact through `effectiveCandidate`. The legacy `candidate` field doesn't admit this kind.

Activation stores exact memory bytes and optional relationship state in the complete effective
state and runtime capability snapshot. Public run, event, activation, inspection, and export
projections remove the encoded content and evidence locators. They retain target, byte-count,
relationship-count, and digest identity. Attached and detached runs, children, resume, recovery,
and replay use the retained state without reopening a source or evidence ledger.

Supplemental memory isn't a secret-storage boundary. It becomes model input for the targeted node,
and generated node output can repeat or transform it. Public projection removes stored memory
bytes. It doesn't classify or redact model-generated text.

Before one agent attempt, the scheduler selects only entries whose root workflow, child path, and
agent node match the current node. Flow renders escaped XML in canonical entry order. The Pi adapter
places a fixed reference-context and authority notice after Flow's system instructions, then the
memory block. When relationships exist for the same exact target, a second canonical block contains
entry IDs, entry digests, predicates, and unresolved contradiction status without evidence
locators. The selected Agent Skill catalog follows both blocks. An untargeted node receives neither
block.

Supplemental memory and its relationships cannot change prompts, models, tools, Agent Skills,
packages, graph topology, budgets, policies, approvals, verifiers, retries, sandboxing, results, or
workflow transitions. Flow doesn't provide relationship inference, truth ranking, conflict
resolution, retrieval, embeddings, model writes, conversation persistence, provider sessions, ACP
session persistence, or automatic promotion.

### Adaptive activation

An operator can activate a prompt, Agent Skill resource, Agent Skill package, composed model-route,
composed child-specialist, or composed supplemental-memory candidate after a complete superior
evaluation.
Preview creates a proposal without changing state:

```text
flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> --dry-run
```

Apply requires the exact preview digest:

```text
flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> \
  --expected-digest <sha256>
```

Each activation snapshot contains the selection role, complete candidate identity, and aggregate
evaluation proof. A prompt snapshot binds the exact selected source. An Agent Skill resource
snapshot binds the unchanged workflow and exact selected skill package. An Agent Skill package
snapshot binds the projected workflow and generated package. Its paired baseline binds the original
workflow and no package.

A composed model-route, child-specialist, or supplemental-memory artifact uses the effective harness
store. Model-route preview and apply require the exact route pair from the evaluation header.
Child-specialist and supplemental-memory preview and apply require the exact candidate and both
complete state identities. The complete selected workflow, package closure, optional memory
catalog, and optional relationship sidecar become durable before the effective head changes.

A workflow source is at most 8 MiB. The complete capability snapshot is at most 16 MiB.

Flow stores one candidate artifact and one baseline artifact below `.flow/activations/sha256` for
each approval. One atomic index contains sorted artifact entries, workflow heads, and a hash-chained
transition history. One recoverable mutation lock protects each index change.

The store permits at most 128 artifacts, 128 workflow heads, and 2,048 transitions.
The index is at most 4 MiB.
Stored artifacts use at most 256 MiB in total.
Each index or lock recovery scan permits at most 128 temporary files and 8 MiB of temporary data.
Blob recovery permits at most 128 temporary files and 256 MiB of temporary data.
Each blob temporary file is at most 16 MiB.

`activation:<workflow-id>` selects the current artifact for a new run. Detached compilation requires
one matching activation in the immutable capability snapshot. It verifies the exact decoded source
bytes, compiles the saved source, and verifies its evaluated workflow digest. The run stores the
complete snapshot before execution.

Resume and detached execution use the durable run snapshot. They do not read the live activation
index. A later activation or rollback cannot change the admitted run.

Rollback selects an earlier stored candidate artifact or the stored baseline artifact for the
current lineage:

```text
flow activation rollback <workflow-id> \
  --to state:<sha256>|<candidate-id>@<version>|agent-skill:<candidate-id>@<version>|agent-skill-package:<candidate-id>@<version>|baseline \
  --actor <label> --dry-run
```

The unqualified version locator preserves the legacy prompt meaning. The `agent-skill:` locator
selects a stored Agent Skill resource candidate revision. The `agent-skill-package:` locator selects
a stored package-introduction revision. Apply requires the exact rollback proposal digest. Flow
verifies the target artifact before it changes the head. Rollback does not rewrite a baseline file
or package, change active runs, or delete artifacts.

## Current limitations

- No arbitrary cycles, nested or unbounded loops, nested optimization, or dynamic fan-out.
- No general multi-condition joins, child patch promotion, terminal-failure retry, or fallback
  semantics.
- Bounded loop bodies and static ready DAG nodes can execute concurrently. Iterations are sequential
  and share one workspace. Flow doesn't infer that iterations are conflict-free.
- Ordinary child workflows isolate workspaces and histories and discard their changes. Only
  compiler-generated bounded optimization candidates can use the typed promotion saga.
- Conditions and loop stops use exact equality over complete durable fields. Supported fields come
  from commands, agents, accepted verifiers, or typed results.
- Approval is available as deterministic command pre-start gates, live per-call agent `exec` gates,
  and pure evidence-bound graph nodes. Command-verifier approval remains unavailable.
- Recovery is limited to proof-safe fresh agent attempts and completed strict-invalid model-verifier
  responses with explicit bounded policy. Interrupted verifier attempts are never retried
  automatically.
- No automatic terminalization or session continuation of an interrupted node attempt. Unconfigured or ineligible durable starts still block continuation.
- Detached workers can be adopted by a replacement local supervisor, but they cannot move between
  hosts and do not survive host reboot.
- The SRT profile is fixed; workflows cannot yet request network, credential injection, or a different sandbox backend.
- Linux PID namespaces contain agent-command descendants; macOS agent commands fail before spawn because process groups are insufficient. The native sandbox does not contain the host-side Pi runtime; hostile workloads require a stronger container, microVM, or managed boundary.
- Agent mutation supports one exclusive UTF-8 file creation, nonrecursive empty directory creation,
  or exact edit per call. Agents can also use explicitly selected argv-only sandboxed commands.
  Flow exposes no delete, rename, shell, network, or fuzzy patch tool. It also exposes no
  environment override, working-directory override, interactive process, background job, or
  multi-file transaction.
- No opaque continuation after a process dies during an in-flight Pi tool call. Live approval works only while the owning attached process or detached worker retains that Pi session. A fresh retry is a new attempt and is allowed only by the persisted proof gate; it is not a substitute for restoring a live session.
- Model verifiers, including packaged rubrics, are zero-tool and evidence-bounded but remain probabilistic and not prompt-injection-proof. Arbitrary evaluator code and reward/evaluation environments are not supported.
- Adaptive candidates support root-agent prompt overlays and selected-resource changes in one
  existing Agent Skill. They also support one new inert Agent Skill package and one static
  root-agent model route. One embedded child agent can receive an instructions or
  existing-skill-selection change.

- Automatic skill selection, memory, dynamic delegation, remote agents, and dynamic routing remain
  unavailable. Multi-node routing and route fallback remain unavailable. Package installation,
  signing, publication, executable generation, and multi-skill candidates remain unavailable.
  Traffic splitting and staged rollout remain unavailable.
- No prepaid hard model-cost cap, provider invoice reconciliation, or CPU/memory/disk quota. `maxArtifactBytes` bounds logical retained evidence, not physical storage, spill, or disk usage. Per-run graph-node concurrency, detached worker count, and queue depth are separate bounded controls.
- No schema migration path is promised while the format remains `v1alpha1`.
