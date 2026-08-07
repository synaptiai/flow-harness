# Recovery and interruption safety

Flow can resume an interrupted run when its durable ledger proves that execution stopped between
node attempts. Recovery is conservative: ambiguous work is reported to the operator and is never
repeated automatically.

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
replays committed events, checks compatibility, and appends `run_resumed`. Successful nodes remain
successful and are not executed again. Pending nodes retain their normal dependency order and
use the lesser of their declared timeout and remaining active-execution budget. The command prints
the same JSON `RunState` shape as `flow run`.

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

An approval-required command returns process exit code 3 and can be decided after the original
client exits:

```sh
flow inspect <run-id>
flow approve <run-id> <request-id> --actor <label> [--runs-dir <path>]
flow deny <run-id> <request-id> --actor <label> [--reason <text>] [--runs-dir <path>]
```

Approval and denial claim the run and append a decision, but approval does not execute. Resume the
exact workflow separately to consume a still-valid grant. The actor label is caller-supplied audit
attribution rather than authenticated identity.

## Recovery boundaries

| Last committed state | Recovery behavior |
| --- | --- |
| `run_started` or a completed `node_succeeded` | Append `run_resumed` and execute the next ready pending node |
| All nodes succeeded but `run_succeeded` is absent | Append `run_resumed`, append `run_succeeded`, and execute no node |
| `node_failed` is durable, no limit is exhausted, and `run_failed` is absent | Append `run_resumed`, append `run_failed`, and do not retry the failed node |
| A completed node outcome reaches a model-token, reported-cost, or active-time limit but `run_budget_exhausted` is absent | Append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| A start limit is exhausted and pending work remains | Append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| `command_approval_requested` is pending | Append `run_resumed`, retain `waiting_for_approval`, and execute nothing |
| `command_approval_granted` is unexpired | Append `run_resumed`, consume the exact grant in `node_started`, and execute once |
| `command_approval_granted` has expired unused | Append `run_resumed`, record expiry, create a fresh request, and execute nothing |
| `command_approval_denied` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and execute nothing |
| `node_started` has no matching outcome | Refuse with `uncertain_operation`; append and execute nothing |
| Run is `succeeded`, `failed`, `cancelled`, or `resource_exhausted` | Refuse with `terminal_run` |
| Workflow identity, version, digest, budget, node set, or committed dependency order differs | Refuse with `workflow_mismatch` |
| A new run is resumed with a different normalized execution directory | Refuse with `execution_context_mismatch` |

A started attempt is uncertain because its command, model, or external tool may have performed an
effect before the process stopped. Flow does not infer failure, success, or idempotency from the
absence of a result.

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
Duplicate exact submissions converge on the recorded result; conflicting submissions remain
rejected even after the original active claim disappears. Concurrent clients also serialize daemon
auto-start through an owner-only startup record, so only one caller can remove a stale socket and
launch a generation.

On supervisor restart, detached workers continue in their own process groups and queued jobs remain
in the admission ledger. A replacement generation bound to the same policy reconciles only live
claims and active admission identities, adopts workers that answer the token-bound handshake,
releases proven terminal work, and dispatches the oldest queued ticket into each free slot. Stale or
mismatched PID metadata is never signalled. If the worker itself disappears with an open node
attempt, the ledger remains authoritative and normal recovery reports `uncertain_operation`; the
uncertain admission conservatively continues to consume capacity.

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
| `uncertain_operation` | A node attempt started without a durable outcome | Inspect the node and external system; wait for a future reconciliation workflow rather than editing the ledger |
| `terminal_run` | The run already has a terminal event | Use `flow inspect`; start a new run for new work |
| `workflow_mismatch` | The supplied workflow is not byte-equivalent after compilation | Locate the exact workflow revision used to start the run |
| `execution_context_mismatch` | The requested working directory differs from the one persisted by a new run | Resume from the exact original execution directory |
| `request_mismatch` | The supplied approval request is not the current pending request | Inspect the run and decide only the displayed request id |
| `not_waiting` | The run no longer accepts an approval decision | Inspect for a prior decision, expiry, start, or terminal outcome |
| `not_owner` | Another live process owns execution | Inspect without claiming, or wait for that process to exit |
| `not_found` | No ledger exists for the run ID | Verify `--run-id` and `--runs-dir` |
| `corrupt` | Committed ledger or ownership data is invalid or ambiguous | Preserve the run directory and diagnose it; do not hand-edit authoritative events |
| `policy_mismatch` | The client and durable/live supervisor generation resolved different effective capacity policies | Inspect `flow config show` and `flow supervisor status`; let work become idle, then explicitly shut down the old generation. If it already exited, temporarily restore its prior values so it can restart and be shut down safely |
| `queue_full` | Active and queued detached capacity are both exhausted | Retry later with the same persisted command id, or deliberately change operator capacity after an idle shutdown |

## Guarantees and non-guarantees

Flow guarantees that committed successful nodes are not scheduled again during accepted recovery,
that one local process owns append/execution/approval decisions, that a required command cannot
start without a matching unexpired single-use grant, that committed resource use produces the same
remaining allowances and exhausted decision after replay, and that unsafe refusal paths do not add
run-ledger events or invoke an executor. Detached admission additionally guarantees that every
worker consumes a prior durable slot, queued work is FIFO by stable ticket, queue-full work creates
no worker, and an exact command retry reproduces its prior admission result. Historical approval
requests are revalidated against the budget remaining at their exact event boundary, not against
final run consumption.

Flow does not guarantee exactly-once effects in arbitrary external systems, authenticated approval
or cancellation identity, trusted time, mid-node restoration of Pi sessions, automatic retry of
uncertain work, host-reboot continuation, multi-host recovery, or a billing-authoritative
zero-overshoot model-cost cap.
It also does not perform offline admission-policy retirement. Those capabilities require explicit
reconciliation, identity, provider reservation, and supervisor designs beyond this recovery slice.
