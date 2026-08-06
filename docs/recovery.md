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
declared timeouts. The command prints the same JSON `RunState` shape as `flow run`.

## Recovery boundaries

| Last committed state | Recovery behavior |
| --- | --- |
| `run_started` or a completed `node_succeeded` | Append `run_resumed` and execute the next ready pending node |
| All nodes succeeded but `run_succeeded` is absent | Append `run_resumed`, append `run_succeeded`, and execute no node |
| `node_failed` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and do not retry the failed node |
| `node_started` has no matching outcome | Refuse with `uncertain_operation`; append and execute nothing |
| Run is `succeeded`, `failed`, or `cancelled` | Refuse with `terminal_run` |
| Workflow identity, version, digest, node set, or committed dependency order differs | Refuse with `workflow_mismatch` |

A started attempt is uncertain because its command, model, or external tool may have performed an
effect before the process stopped. Flow does not infer failure, success, or idempotency from the
absence of a result.

## Ownership and crash handling

Every process that may append or execute for a run publishes complete owner metadata atomically.
A second process refuses a run owned by a live local process. When the recorded process no longer
exists, one claimant can atomically replace its ownership; concurrent claimants still produce only
one winner. Process-ID reuse may conservatively block recovery but cannot authorize two owners.

This mechanism coordinates processes on one host and filesystem. It is not a distributed lease,
daemon, authentication mechanism, or security sandbox. Do not share one run directory across
independent hosts.

JSONL records are committed only when newline-terminated. Recovery ignores a final unterminated
fragment and truncates it immediately before the next append. An invalid earlier record, mismatched
run directory, or corrupt owner record fails closed and is preserved for diagnosis.

## Error codes

| Code | Meaning | Operator action |
| --- | --- | --- |
| `uncertain_operation` | A node attempt started without a durable outcome | Inspect the node and external system; wait for a future reconciliation workflow rather than editing the ledger |
| `terminal_run` | The run already has a terminal event | Use `flow inspect`; start a new run for new work |
| `workflow_mismatch` | The supplied workflow is not byte-equivalent after compilation | Locate the exact workflow revision used to start the run |
| `not_owner` | Another live process owns execution | Inspect without claiming, or wait for that process to exit |
| `not_found` | No ledger exists for the run ID | Verify `--run-id` and `--runs-dir` |
| `corrupt` | Committed ledger or ownership data is invalid or ambiguous | Preserve the run directory and diagnose it; do not hand-edit authoritative events |

## Guarantees and non-guarantees

Flow guarantees that committed successful nodes are not scheduled again during accepted recovery,
that one local process owns append/execution, and that unsafe refusal paths do not add ledger
events or invoke an executor.

Flow does not guarantee exactly-once effects in arbitrary external systems, mid-node restoration of
Pi sessions, automatic retry of uncertain work, detached execution, or multi-host recovery. Those
capabilities require explicit reconciliation and supervisor designs beyond this recovery slice.
