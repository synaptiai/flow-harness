# Recovery and interruption safety

Flow can resume an interrupted run when its durable ledger proves that execution stopped between
node attempts. An agent node may also opt into a bounded fresh attempt when replay proves the open
attempt applied no effects. Recovery remains conservative: ambiguous work is reported to the
operator and is never repeated automatically. Agent attempts that select `exec`, command attempts, and model verifier attempts never opt into
fresh recovery; an open verifier start is refused as uncertain.

## Operator workflow

Inspecting a run is read-only and does not acquire execution ownership:

```sh
flow inspect <run-id> [--runs-dir <path>]
```

Resume with the exact workflow definition that started the run:

```sh
flow resume <workflow.yaml> --run-id <run-id> [--runs-dir <path>] [--cwd <path>]
```

Flow compiles the workflow before claiming the run. It then acquires exclusive local ownership,
replays committed events, and checks compatibility before observing any target. At a safe boundary
it appends `run_resumed`; successful nodes remain successful and are not executed again. An open
typed edit is first reconciled as described below. The unfinished node remains refused unless its
persisted recovery policy and the resulting replay state satisfy every fresh-retry proof.
Pending nodes retain their normal dependency order and use the lesser of their declared timeout
and remaining active-execution budget. The command prints the same JSON `RunState` shape as
`flow run` when recovery can continue.

A run that selects Agent Skills, versioned verifiers, or versioned command tools persists one
durable capability snapshot in
`run_started`. For a verifier package, replay reparses the captured manifest and reconciles its
name, exact version, driver kind, definition, manifest hash, package digest, compiled control-graph
reference, node requirement, and any committed verdict evidence. Resume resolves the package only
from that durable verifier package snapshot. It never reads `.flow/verifiers`; a caller-supplied
snapshot must have the exact durable aggregate digest or recovery refuses with `workflow_mismatch`.
For an installed package it likewise never reads `.flow/packages.lock.json`, reopens a bundle blob,
or contacts the recorded source URL. The lock and blob are admission inputs only; `run_started` is
the recovery authority.
The same rule applies inside a child ledger, which may carry the parent snapshot but can bind only
its own compiled selections.

For a command tool package, replay reparses the durable command tool package snapshot and
reconciles its name, exact version, definition, manifest hash, package digest, compiled node
selection, control-graph command-tool declaration, and every sourced request. A sourced request is
valid only when replay can reproduce its typed input digest and exact executable, argv, and timeout
from the frozen definition. Resume never reads `.flow/tools` and never accepts a caller replacement.
An agent with a package command is command-capable even when it does not declare raw `exec`: an open
attempt remains `uncertain_operation`, and the compiler rejects fresh recovery because arbitrary
process effects cannot be reconstructed from workspace observation.

When a concurrent wave was interrupted, Flow processes every open attempt in workflow declaration
order. It first reconciles every open typed effect in that order, then appends one
`node_attempt_interrupted` disposition for every proof-safe attempt, and finally appends one
`run_resumed`. A command attempt or any other unsafe sibling still blocks new execution; already
committed reconciliation and safe dispositions remain valid evidence. Repeating resume continues
from that prefix without duplicating events.

Agent command execution has its own `flow.agent-commands/v1` write-ahead ledger. A normalized
executable/argv/deadline request and its exact allowed `process.execute` decision are committed
before spawn; the bounded outcome is committed afterward. Resume never runs an open or settled
agent command again and cannot reconcile arbitrary process side effects from filesystem
observation. The compiler therefore rejects `recovery: { mode: fresh, ... }` whenever the node
selects `exec`, and a command-capable open attempt is reported as `uncertain_operation`.

Child recovery uses the child ledger as the execution commit marker and the workspace manifest as
its isolation proof. The parent derives the same child run and workspace identities from its own run,
node, attempt, and compiled child digest. If no child event was committed, Flow may discard a stale
pre-ledger workspace and recreate the child. Once any child event exists, resume must reopen the
exact workspace manifest and snapshot digest and then apply the ordinary recovery rules to that
separate ledger; a missing or divergent workspace fails with `child_recovery_ineligible` and no
replacement child starts. A terminal child ledger remains authoritative if cleanup completed before
the parent imported its outcome. Flow idempotently confirms discard, verifies the linked evidence,
and appends only the missing parent outcome.

To submit either operation to the local supervisor, add `--detach`:

```sh
flow run <workflow.yaml> --detach --run-id <run-id> [--command-id <uuid>]
flow resume <workflow.yaml> --detach --run-id <run-id> [--command-id <uuid>]
flow supervisor status
flow events <run-id> --after 0 --follow
```

The client returns one of three durable admission outcomes. `accepted` means the exact source,
active reservation, and claim are durable and an authenticated worker has accepted ownership;
`queued` means the exact source and FIFO ticket are durable but no claim or worker exists; and
`rejected` with `queue_full` means the compact rejection is durable and no executable source
snapshot was retained. Acceptance is a process-lifecycle guarantee, not a successful workflow
result. A later client can page ledger events, follow to a terminal event, or cancel active or queued
work with
`flow cancel <run-id> --actor <label> [--reason <text>] [--command-id <uuid>]`.

Flow generates command ids when omitted. A caller that needs retry safety across a lost response
must persist a UUID before the first request and reuse it with byte-equivalent input. A reused key
with different input is rejected. Submission commands are journaled before admission: exact retries
replay accepted, queued, or rejected outcomes and retain the original queue ticket. A snapshot left
before its admission event is inert; an exact retry can complete the missing transition with the
same identity. Once execution may have crossed the authenticated worker boundary, uncertainty is
reconciled only from that matching worker and never causes a second spawn.

A command or graph approval wait returns process exit code 3 and can be decided after the original
client exits:

```sh
flow inspect <run-id>
flow approve <run-id> <request-id> --actor <label> [--runs-dir <path>]
flow deny <run-id> <request-id> --actor <label> [--reason <text>] [--runs-dir <path>]
```

Approval and denial claim the run and append the event family required by the pending request.
Command approval does not execute; resume separately consumes a still-valid grant. Graph approval
immediately completes the pure control node, but downstream work still requires an explicit resume.
The actor label is caller-supplied audit attribution rather than authenticated identity.

Live agent-command approval uses the same CLI but a different ownership path. The attached process
or detached worker keeps the Pi tool promise open and remains the only ledger writer. A decision
client publishes an immutable sidecar; the owner validates it and appends the decision before one
matching command preparation. Ordinary approval therefore needs no `resume`. If the owner process
dies while the tool call is suspended, the pending request remains inspectable but is not a safe
committed boundary: Flow cannot reconstruct Pi's opaque transcript or promise and refuses recovery
with `uncertain_operation`. A sidecar without an owner-appended decision never grants authority.

## Recovery boundaries

| Last committed state | Recovery behavior |
| --- | --- |
| `run_started` or a completed executable/control transition | Append `run_resumed` and apply the next declaration-ordered legal transition |
| A result source succeeded but no result transition is durable | Append `run_resumed`, reparse the durable source with the persisted schema, and publish or fail the result without invoking an executor |
| `node_result_published` is durable | Verify source, schema, canonical value, and hashes during replay; continue after the result without republishing it |
| All nodes succeeded or were omitted but `run_succeeded` is absent | Append `run_resumed`, append `run_succeeded`, and execute no node |
| `node_failed` is durable, no limit is exhausted, and `run_failed` is absent | Append `run_resumed`, append `run_failed`, and do not retry the failed node |
| A completed node outcome reaches a model-token, reported-cost, active-time, or artifact limit but `run_budget_exhausted` is absent | Replay the exact retained payload bytes, append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| A start limit is exhausted and pending work remains | Append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| `command_approval_requested` is pending | Append `run_resumed`, retain `waiting_for_approval`, and execute nothing |
| `command_approval_granted` is unexpired | Append `run_resumed`, consume the exact grant in `node_started`, and execute once |
| `command_approval_granted` has expired unused | Append `run_resumed`, record expiry, create a fresh request, and execute nothing |
| `command_approval_denied` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and execute nothing |
| A live `agent_command_approval_requested` has no terminal decision because its owner died | Preserve the exact request, refuse with `uncertain_operation`, and do not synthesize a Pi tool continuation or command preparation |
| An agent-command grant was committed but not consumed before its owner died | Preserve the unconsumed authority, refuse with `uncertain_operation`, and execute nothing |
| `workflow_approval_requested` is pending | Append `run_resumed`, retain the exact request and `waiting_for_approval`, and execute nothing |
| `workflow_approval_approved` is durable | Append `run_resumed` and apply only the next graph-declared transition |
| `workflow_approval_denied` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and execute nothing |
| One or more opted-in agent `node_started` events are below their attempt caps, have accountable start capacity, and have no effects or only effects proven not applied | Reconcile every open typed edit and append each `node_attempt_interrupted` in declaration order; append one `run_resumed`, then admit fresh attempts under the persisted concurrency limit |
| An opted-in agent `node_started` has an applied, committed, unknown, open, legacy writable, attempt-exhausted, or unaccountable budget state | Preserve any reconciliation prefix, refuse with `recovery_retry_ineligible`, and invoke no executor |
| A verifier `node_started` has no matching outcome | Refuse with `uncertain_operation`; do not repeat its command or model invocation |
| An unconfigured `node_started` has no matching outcome | Preserve any reconciliation prefix, refuse with `uncertain_operation`, and append no retry disposition or `run_resumed` |
| Run is `succeeded`, `failed`, `cancelled`, or `resource_exhausted` | Refuse with `terminal_run` |
| Workflow identity, version, digest, budget, node set, persisted control graph, or committed transition order differs | Refuse with `workflow_mismatch` |
| Durable capability snapshot; skill, verifier, or command-tool requirement; exact version/kind; or package-use evidence differs | Refuse with `workflow_mismatch`; do not read or substitute the live package catalog |
| A new run is resumed with a different normalized execution directory | Refuse with `execution_context_mismatch` |
| No child event is durable, but a stale deterministic child workspace exists | Discard the uncommitted workspace, recreate it from the parent, and start the child once |
| A child ledger is nonterminal and its exact manifest, snapshot digest, or workspace is missing or divergent | Refuse with `child_recovery_ineligible`; do not create a replacement child or repeat uncertain work |
| A child ledger is terminal but its parent outcome is absent | Treat the child ledger as authoritative, idempotently confirm workspace discard, verify its linked typed result and resources, and append only the parent outcome |
| A parent child outcome is durable but the parent run is nonterminal | Re-reduce every settled child ledger recursively and compare its link, terminal sequence, outcome, typed result, duration, workspace provenance, and all five resource totals with the imported projection; refuse divergence with `child_recovery_ineligible` before appending `run_resumed` |
| An optimization candidate succeeded but no evaluation is durable | Append `run_resumed`, recompute metric/invariants from its canonical child result, reopen an exact durable capture or capture the same bounded delta, and record one evaluation; a partial or divergent capture fails closed |
| `node_optimization_evaluated` chose promotion but prepare is absent | Reuse the captured delta identity and enter promotion once; never rerun the child |
| `node_optimization_promotion_prepared` has no settlement | Reconcile the exact local journal and affected paths, then append committed, rolled-back, or unknown settlement |
| Promotion settlement is committed but cleanup or check completion is absent | Retry idempotent workspace cleanup and append only the missing cleanup/check transitions; never reapply the delta |
| Promotion settlement is rolled back or unknown | Fail the check with no side effects or uncertain side effects respectively; retain diagnostic artifacts and start no downstream node |
| A check is complete but later candidates or the controller are absent | Append `run_resumed`, apply its durable continue/stop guard, omit or schedule only the next finite candidate, and derive controller completion from checks |

A started attempt is uncertain because its command, model, or external tool may have performed an
effect before the process stopped. Flow does not infer failure, success, or idempotency from the
absence of a result. Command nodes never receive an automatic recovery policy.

Typed result publications, condition decisions, loop checks and completions, omissions, and joins
are safe committed boundaries because they do not invoke an executor. Recovery replays their
persisted control graph and validates each source attempt, field, and hash. A result additionally
reparses the original durable source, reapplies the bounded schema, reproduces canonical JSON, and
checks its schema and value hashes. Other controls validate the selected case or loop decision,
omission reason, loop iteration/guard, controller result, and join mapping against the scheduler's
canonical next transition. Persisted loop topology additionally requires registered ordered checks,
structurally isomorphic body clones, and the same exact stop contract in every iteration. It never
reevaluates a result, condition, or committed loop check from the current workspace or a changed
workflow file. If a crash occurs after one of these events is synced, resume continues
from the following transition without repeating its source node. A retry of an interrupted
iteration-qualified agent increments that instance's attempt; it does not advance the loop.

Optimization checks are also resource-neutral control nodes, but promotion contains an external
filesystem saga. Evaluation persists canonical baseline/candidate metrics, expected and actual
invariants, complete sorted before/after delta entries, and a recomputable manifest digest before
promotion. The adapter then stores candidate and rollback blobs plus a local journal before asking
the application to append `node_optimization_promotion_prepared`. It cannot begin an affected-path
mutation unless that callback succeeds.

The promotion journal advances through deterministic forward and rollback steps. A crash can be
observed at the durable-temporary, applied-step, rollback-step, or local-commit boundary. Recovery
checks the journaled step and the one-step crash window against exact before/after identities,
removes only promotion-owned temporary paths, and either completes compensation, confirms the
committed after-state, or records `unknown/affected_path_diverged`. It never treats a partially
matching path set as success. The run event settlement is distinct from the local journal: a
committed local journal with a missing event is reconciled forward, while a committed event is
never applied again.

Cleanup follows only rejection or a conclusive promotion settlement. A crash after filesystem
cleanup but before its event causes the same workspace-id cleanup to run again; the production
operation is idempotent. A retained workspace is never silently replaced. Replay independently
recomputes typed observations and the delta digest, binds prepare/settlement to the exact promotion
id, and requires cleanup before check completion when candidate evidence says retained.

Writable agent attempts add more precise, but non-terminal, evidence. `node_started` declares
`flow.effects/v1`. Before an atomic edit rename, Flow syncs `node_effect_prepared` with a stable
effect identity, target, request digest, before/after hashes, and mode. It later syncs exactly one
settlement: `committed/directory_synced`, `not_applied/commit_not_entered`, or
`unknown/post_commit_failure`. A process death can therefore leave an unresolved prepared effect,
or a settled effect without a node outcome. Inspection preserves that distinction.

For each unresolved prepared edit, recovery enters the same target queue and cross-process lock as
normal edits, rejects non-regular targets before opening them, opens without following symlinks,
hashes the initially observed size in fixed chunks totaling no more than 8 MiB, and compares the
regular-file SHA-256 and POSIX mode. It appends `node_effect_reconciled` while the target lock is
still held. If the target's parent has disappeared so the sibling lock cannot exist, recovery
rechecks the path and may publish only `target_missing` under the in-process target queue; if any
target is observable, it publishes nothing. An exact after-state becomes
`applied/target_matches_after`; an exact before-state
becomes `not_applied/target_matches_before`; missing, non-regular, unreadable, oversized, divergent,
wrong-mode, or raced targets become `unknown` with a bounded reason. The event retains a digest and
mode only for a stable regular-file observation. It stores no file bytes or raw operating-system
error message and never changes the target.

Recovery provenance is separate from execution settlement. Observing the after-state does not
prove that the original directory sync, provider response, usage report, or whole node completed.
It therefore blocks a fresh attempt. Observing the exact before-state proves only that this prepared
edit was not applied; every effect on the attempt must independently reach that result. Repeated
recovery skips already settled or reconciled effects. If observation or event publication fails
partway through multiple effects, the durable prefix remains and only later open effects are
eligible next time. A live or malformed target lock leaves the effect open rather than publishing
stale evidence.

### Proof-safe fresh attempts

An agent node opts in through:

```yaml
recovery:
  mode: fresh
  maxAttempts: 3
```

`maxAttempts` counts the initial attempt. The compiler accepts 2 through 16 and inserts no default.
At run start, Flow persists the node id, mode, cap, and required effect protocol so replay never
consults a changed workflow file to decide safety. The compiled workflow digest and the explicit
persisted requirements must both match during resume.

The reducer permits `node_attempt_interrupted` only when all of these statements are true:

- the current node has the persisted fresh policy and its attempt is below `maxAttempts`;
- `maxNodeStarts`, when declared, has capacity for another start;
- no `maxModelTokens`, `maxCostUsd`, or `maxExecutionMs` limit is declared, because consumption by
  the interrupted attempt is incomplete;
- a read-only policy has no effect protocol and no effects; or
- an edit-capable policy used `flow.effects/v1` and every effect has executor settlement
  `not_applied` or recovery reconciliation `not_applied`.

An empty effect list is sufficient only for a persisted read-only policy or a writable attempt that
actually declared `flow.effects/v1`. It does not make a legacy writable attempt safe. Applied,
committed, unknown, merely prepared, or incompatible effects all block. A model claim, absent
receipt, current file contents without a typed observation, or `retryable` error flag is not proof.

The event fixes the reason to `process_interrupted`, disposition to `fresh_retry`, and resource
accounting to `incomplete`. It archives the old attempt number, start and interruption timestamps,
protocol, and immutable effects under `interruptedAttempts`, resets only the node's current
schedulable projection to pending, and retains the attempt counter. Flow then records
`run_resumed`; the next start must be exactly the old attempt plus one. A crash after the disposition
but before `run_resumed` cannot duplicate the disposition: replay sees no running attempt, records
the missing resume marker, and continues at the same next attempt.

The new attempt is a new in-memory Pi session using the original node prompt and current workspace.
It is not session continuation: no old transcript, dangling tool call, provider stream, or hidden
model state is restored. Flow explicitly disables Pi assistant-turn retries and provider retries,
so one Flow attempt cannot silently expand through those retry layers. Ordinary tool/model turns
inside the live session remain bounded by the node timeout.

Artifact accounting does not block this fresh retry because an open attempt has no committed
terminal evidence payload. Only a later durable success/failure outcome contributes its command,
agent, verifier, or child payload bytes. If Flow later persists streamed artifacts before a terminal
outcome, that storage contract must add an explicit interruption-accounting rule rather than
silently changing this behavior.

Fresh retry is also distinct from completion proof. The retried agent must still produce its own
terminal evidence, and downstream deterministic verifier nodes still decide criterion acceptance.

## Ownership and crash handling

Every process that may append or execute for a run publishes complete owner metadata atomically.
A second process refuses a run owned by a live local process. When the recorded process no longer
exists, one claimant can atomically replace its ownership; concurrent claimants still produce only
one winner. Process-ID reuse may conservatively block recovery but cannot authorize two owners.

For foreground execution, that owner is the CLI process. For detached execution, one worker owns
one existing `runWorkflow` or `resumeWorkflow` call. The local supervisor never claims the run,
appends graph events, constructs an executor, or contacts a model provider.

The supervisor maintains immutable source snapshots for admitted jobs, a separate admission ledger,
active-run claims, private worker descriptors, and durable mutating-command records. A submission
record binds the exact input and policy digests before admission and transitions monotonically to
queued, accepted, rejected, or uncertain. The admission ledger serializes capacity reservation,
FIFO dispatch, queued cancellation, uncertainty, and release; it is synced before those facts are
acknowledged and periodically compacted to a replay-equivalent snapshot. A worker starts in an
adoption gate and does not schedule until it has published `running`, the supervisor authenticates
its worker id, run id, PID, random token, and job digest, and the identity response has flushed.
If a resume worker records recovery evidence and then receives a typed recovery refusal, it persists
that code together with the replayed run status. Its process and capacity slot become terminal while
an uncertain authoritative run remains `running`, never mislabeled as failed. If the proof gate
passes, the same worker records the interruption disposition and continues the ordinary scheduler;
the supervisor does not implement a second retry mechanism.
Duplicate exact submissions converge on the recorded result; conflicting submissions remain
rejected even after the original active claim disappears. Concurrent clients also serialize daemon
auto-start through an owner-only startup record, so only one caller can remove a stale socket and
launch a generation.

On supervisor restart, detached workers continue in their own process groups and queued jobs remain
in the admission ledger. A replacement generation bound to the same policy reconciles only live
claims and active admission identities, adopts workers that answer the token-bound handshake,
releases proven terminal work, and dispatches the oldest queued ticket into each free slot. Stale or
mismatched PID metadata is never signalled. If the worker itself disappears with an open node
attempt, the ledger remains authoritative and a later resume applies the persisted proof gate. An
unconfigured or ineligible attempt remains uncertain; the uncertain admission conservatively
continues to consume capacity.

Cancellation is recorded durably before dispatch. A repeated exact command id returns its committed
result; a different request using that id conflicts. If acknowledgement is lost after dispatch,
Flow reconciles a terminal cancellation from the ledger and otherwise reports uncertainty instead
of blindly repeating the abort. Cancellation during a node retains its available evidence and
records the actor, request id, and cancelled node; committed resource exhaustion still takes
precedence. Queued cancellation is a two-phase admission transition: once its durable record wins
the dispatch race, Flow completes the command and removes the job without creating an active claim,
worker descriptor, model session, command sandbox, or run ledger.

A supervisor generation is bound to the exact effective capacity digest. Stateful requests carrying
a different digest fail before mutation. Shutdown refuses while active or queued admission remains;
an explicit idle shutdown archives that policy generation so a later process may bind changed
values. Editing configuration never rewrites or reorders an existing queue.

Event replay is read-only and page-based. `--after` is an exclusive sequence cursor, `--limit` is
bounded to 256, and follow mode advances only after validating the next contiguous page. A page is
terminal only when it reaches a terminal ledger event.

These mechanisms coordinate processes on one host and filesystem. They are not a distributed
lease, remote service, authenticated user boundary, or security sandbox. Do not share one run
directory across independent hosts.

JSONL records are committed only when newline-terminated. Recovery ignores a final unterminated
fragment and truncates it immediately before the next append. An invalid earlier record, mismatched
run directory, or corrupt owner record fails closed and is preserved for diagnosis.

## Error codes and outcomes

| Code | Meaning | Operator action |
| --- | --- | --- |
| `uncertain_operation` | A node attempt started without a durable outcome, even if its edits were reconciled | Inspect the node and its settlement/reconciliation provenance; start a new reviewed run rather than editing the ledger |
| `recovery_retry_ineligible` | The node opted into fresh recovery, but attempt, effect, protocol, or resource proof forbids the next start | Inspect `interruptedAttempts`, effects, recovery requirement, and budget; do not hand-edit the ledger or rerun under a weakened workflow |
| `reconciliation_unavailable` | An open typed effect was found but this embedding did not supply a reconciler | Use the production CLI/worker composition or configure a reviewed reconciler; do not retry the node |
| `reconciliation_incomplete` | A reconciler returned no observation or attempted multiple publications | Preserve the ledger and diagnose the adapter contract before trying recovery again |
| `terminal_run` | The run already has a terminal event | Use `flow inspect`; start a new run for new work |
| `workflow_mismatch` | The supplied workflow or persisted workflow-derived requirements do not match the exact compiled run contract | Locate the exact workflow revision used to start the run; treat unexpected ledger requirements as corruption |
| `execution_context_mismatch` | The requested working directory differs from the one persisted by a new run | Resume from the exact original execution directory |
| `child_recovery_ineligible` | A durable child cannot be resumed from its exact recorded workspace identity, or its recovered state cannot safely continue | Preserve both ledgers and workspace state; inspect their provenance and start a new reviewed root run rather than deleting or replacing evidence |
| `candidate_promotion_stale` | An affected parent path or removed-directory closure no longer matches the captured baseline | Preserve the newer parent state and candidate evidence; rerun from a fresh reviewed baseline |
| `candidate_promotion_rolled_back` | Promotion failed after prepare and deterministic compensation restored the prior best | Inspect the journal and failure; do not hand-apply the candidate or mark it accepted |
| `candidate_promotion_uncertain` | Reconciliation cannot prove a complete committed or compensated affected-path state | Preserve the run, candidate workspace, and promotion journal; resolve manually and start a new reviewed run |
| `candidate_workspace_cleanup_failed` | A conclusive candidate workspace could not be discarded | Inspect permissions/storage and preserve the run; do not delete ledger evidence |
| `request_mismatch` | The supplied approval request is not the current pending request | Inspect the run and decide only the displayed request id |
| `not_waiting` | The run no longer accepts an approval decision | Inspect for a prior decision, expiry, start, or terminal outcome |
| `not_owner` | Another live process owns execution | Inspect without claiming, or wait for that process to exit |
| `not_found` | No ledger exists for the run ID | Verify `--run-id` and `--runs-dir` |
| `corrupt` | Committed ledger or ownership data is invalid or ambiguous | Preserve the run directory and diagnose it; do not hand-edit authoritative events |
| `policy_mismatch` | The client and durable/live supervisor generation resolved different effective capacity policies | Inspect `flow config show` and `flow supervisor status`; let work become idle, then explicitly shut down the old generation. If it already exited, temporarily restore its prior values so it can restart and be shut down safely |
| `queue_full` | Active and queued detached capacity are both exhausted | Retry later with the same persisted command id, or deliberately change operator capacity after an idle shutdown |

## Guarantees and non-guarantees

Flow guarantees that committed successful nodes are not scheduled again during accepted recovery,
that one local process owns append/execution/approval decisions, that cancellation observed after
claim or reconciliation but before retry disposition adds no retry authority, that a required command cannot
start without a matching unexpired single-use grant, that committed resource use produces the same
remaining allowances and exhausted decision after replay, and that unsafe refusal paths do not add
`node_attempt_interrupted`, `run_resumed`, or invoke an executor. A supported open edit may add only
its typed reconciliation event before either refusal or an accepted disposition. For an accepted fresh retry, Flow guarantees the
interruption disposition is durable first, attempt numbers increase exactly by one, and every prior
attempt remains inspectable. Detached admission additionally guarantees that every
worker consumes a prior durable slot, queued work is FIFO by stable ticket, queue-full work creates
no worker, and an exact command retry reproduces its prior admission result. Historical approval
requests are revalidated against the budget remaining at their exact event boundary, not against
final run consumption.

For Flow-owned workspace edits, Flow additionally guarantees that rename is never entered before
the prepared event is acknowledged, committed settlement follows directory sync, terminal receipts
exactly match settled effects, crash-window evidence remains replayable, and a recovery observation
is published under the same target lock without mutating the file. The only exception is a missing
target whose parent is also absent: because cooperating Flow edits cannot acquire that sibling lock
or create the target, recovery may publish only a rechecked missing result under the target queue.
Any observable target remains unresolved. These guarantees authorize a fresh surrounding attempt
only when the separately persisted policy and every eligibility check above also pass.

For optimization promotion, Flow guarantees that no affected path is entered before durable
prepare, all rollback bytes are durable first, a changed affected path is never overwritten, a
committed settlement is never applied again, rejected candidates never mutate the parent, and an
unknown reconciliation blocks the graph. Stable intermediate symlinks are rejected as stale, and
directory ancestors are rechecked at mutation and crash-cleanup boundaries; unsafe cleanup is
skipped and reconciliation becomes unknown. This is deterministic same-host filesystem recovery,
not an atomic multi-filesystem transaction: a hostile process with the same user authority can
still race between a pathname check and the corresponding filesystem operation.

Flow does not guarantee exactly-once effects in arbitrary external systems, authenticated approval
or cancellation identity, trusted time, mid-node restoration of Pi sessions, automatic retry of
ambiguous work, host-reboot continuation, multi-host recovery, or a billing-authoritative
zero-overshoot model-cost cap.
It also does not perform offline admission-policy retirement. Those capabilities require explicit
identity, provider reservation, and supervisor designs beyond this recovery slice.
