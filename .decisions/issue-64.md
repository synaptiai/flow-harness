# Issue #64: reproducible harness benchmark and evaluation capabilities

## Status

- Decision state: accepted for implementation
- Issue: #64
- Branch: `codex/issue-64-benchmark-evaluation`
- Delivery mode: one provider-neutral evaluation contract with a `flow-workflow-v1` adapter

## Problem

Flow can durably execute one workflow, but it cannot yet prove that two harness profiles were tested
under equivalent conditions. It also cannot keep holdout verification outside the harness workspace,
retain every scheduled failure in a comparison denominator, or reproduce an aggregate report from
immutable raw trial records.

The measured unit is a harness/model profile, not a model in isolation. An evaluation therefore has
to preserve profile-specific graph and tool behavior while controlling the task fixture, public
instruction, model provider/id/thinking identity, budgets, network policy, retry policy, seed,
verifier, and execution
order.

## Outcome

An operator can validate, run, inspect, resume, and export a bounded evaluation plan. Every admitted
plan and raw trial has a content-derived identity. Each trial runs against a fresh fixture snapshot.
The harness sees the public fixture and instruction but never the private verifier assertions. A
post-run verifier determines success. Offline aggregation includes every scheduled trial, represents
unavailable telemetry as `null`, reports paired uncertainty, and refuses to claim superiority when
evidence or safety constraints are insufficient.

## Architecture decision

### Boundary

The evaluation lifecycle is an application layer above ordinary workflow execution:

```text
Evaluation plan source
        |
        v
strict parse + referenced-content admission + fairness checks
        |
        v
immutable admitted plan + deterministic paired schedule
        |
        +--> fresh fixture snapshot --> harness adapter --> ordinary Flow run ledger
        |                                      |
        |                                      v
        |                           harness outcome + telemetry
        |                                      |
        +--> private built-in verifier <-------+
                         |
                         v
              immutable chained trial record
                         |
                         v
              offline aggregate + comparison
```

The workflow reducer remains authoritative for one Flow run. It does not learn about benchmark
pairing, partitions, comparison thresholds, or superiority. The evaluation reducer and store do not
reinterpret workflow events; the Flow adapter translates the terminal run and its durable evidence
into the provider-neutral trial contract.

### Components

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Evaluation plan admission | Strict YAML parsing, closed schemas, path containment, no-follow fixture hashing, workflow compilation, exact digests, fairness checks, schedule construction | Execute a workflow, invoke a model, or publish a store |
| Evaluation scheduler | Produce a deterministic paired order from task order, explicit seeds, repetitions, and alternating profile order | Drop, retry, or reorder a failed trial silently |
| Harness adapter port | Run one admitted profile against one fresh workspace and return a typed outcome plus available telemetry | Receive private verifier assertions or invent unavailable metrics |
| `flow-workflow-v1` adapter | Execute an admitted workflow through the existing Flow runtime and translate its durable run events | Change workflow semantics, relax policy, or fetch live plan inputs during recovery |
| Built-in filesystem verifier | Evaluate bounded `exists`, `absent`, and exact SHA-256 assertions after harness completion | Execute plan-contributed commands, scripts, hooks, or model judges |
| Evaluation record store | Atomically publish an admitted header, append immutable digest-chained trial records, enforce one writer, reopen and validate | Repair contradictory data or overwrite an existing trial |
| Aggregator | Recompute all metrics and paired comparisons from header plus raw records | Treat missing values as zero, omit scheduled failures, or mutate raw records |
| CLI | `flow eval validate`, `run`, `inspect`, and `export` composition | Hide incomplete schedules or emit a superiority claim without a passing gate |

### Why this is separate from the run event ledger

A benchmark trial can contain one complete workflow run, but an evaluation also contains data that
is not a workflow event: task partition, fixture identity, profile identity, seed, paired order,
private-verifier result, scheduled denominator, and comparison thresholds. Adding those concepts to
`RunEvent` would couple ordinary workflow replay to a benchmark product and make every provider
adapter emulate Flow's internal graph events. A separate typed ledger preserves both boundaries.

### Adapter strategy

Version 1 admits only `flow-workflow-v1`. The source schema still records an explicit adapter kind and
the application depends on a `HarnessEvaluationAdapter` port. Unknown adapters fail during admission;
they never become a command string or executable locator.

Future Pi-native, OMP, or Prime-agent integrations implement the same request/result contract:

- exact task, fixture, instruction, profile, model, budget, seed, network, and retry identities in;
- a typed terminal outcome and explicitly available telemetry out;
- no private verifier material, comparison thresholds, or authority to write evaluation records.

### Plan source contract

The public YAML kind is `EvaluationPlan` with API version `flow.synapti.ai/v1alpha1`.

- `metadata.id`: canonical evaluation plan identifier.
- `suite.id` and `suite.version`: exact suite identity.
- `suite.tasks[]`: unique task identifier, partition (`tuning`, `regression`, or `holdout`), fixture
  directory, public instruction path inside that fixture, and a private built-in verifier.
- `profiles[]`: unique profile identifier, exact adapter kind, and workflow source.
- `controls`: one model provider, model id, and thinking level; exact run budget; `network: deny`;
  and zero harness/provider retry policy shared by all profiles.
- `seeds[]`: explicit unique non-negative safe integers; one paired repetition per seed.
- `order: paired-alternating-v1`: task/seed pairs remain adjacent while the leading profile alternates.
- `comparison`: baseline and candidate profile identifiers, minimum paired sample, confidence level,
  minimum effect, and safety/regression ceilings.

At admission, relative paths resolve against the plan file. Fixtures and instructions must stay below
their declared roots. Symlinks and special files are rejected. Each profile workflow is compiled once,
all model references must equal `controls.model`, and the workflow budget must equal
`controls.budget`. Referenced bytes and their digests—not mutable path names—enter the admitted plan
identity.

### Admitted identity

`planDigest` is SHA-256 over canonical admitted content containing:

- plan, suite, task, and profile identifiers;
- task partition and public instruction digest;
- complete fixture manifest digest, entry count, and logical bytes;
- private verifier digest and assertion count without exposing its assertions to the adapter;
- workflow source and compiled workflow digests;
- adapter kind, model, budget, network, retry, seeds, repetition order, and comparison criteria.

`trialId` is derived from `planDigest`, task id, profile id, seed, repetition index, and scheduled
position. It cannot be selected by a harness response.

### Fresh isolation and holdout boundary

Each scheduled trial creates a new `reflink-copy-v1` workspace from the admitted fixture. The public
instruction is already inside the fixture and therefore shares the fixture digest. Evaluation store,
plan source, workflow source, run ledgers, sibling workspaces, and private verifier material are
protected paths outside the harness workspace.

After private verification, Flow appends the terminal trial record before discarding the ephemeral
workspace. On resume, the sole owner idempotently discards residue for committed trial identities and
for the next uncommitted trial before creating a fresh copy. Cleanup failure stops the evaluation;
partial workspace output is never reused as a resumed trial.

The adapter request contains only:

- trial identity and ordering metadata;
- public workspace path and snapshot digest;
- admitted workflow/profile identity;
- controlled model, budget, network, retry, and seed metadata.

It never contains verifier assertions. The evaluator invokes the verifier only after the adapter has
settled. Harness success is therefore a report, not acceptance.

### Raw outcome contract

Every scheduled trial produces exactly one record, including pre-execution failures. Terminal trial
classifications are:

- `verified_success`: harness completed and the private verifier accepted;
- `false_completion`: harness reported completion but the private verifier rejected;
- `harness_failure`: crash, timeout, cancellation, malformed result, missing result, or workflow
  failure;
- `verifier_error`: the post-run verifier could not produce an authoritative verdict.

All four classifications remain in the scheduled denominator. A verifier error is never success.
Accepted and rejected outcomes require complete one-for-one assertion evidence. Verifier errors carry
a bounded actionable reason, and every outcome remains bound to the admitted verifier digest.

Metrics use a fixed closed object. The following fields are either a non-negative number or `null`:

- cost in micro-US dollars;
- input, cache-read, cache-write, and output tokens;
- turns, tool calls, and tool errors;
- wall and active time;
- interventions and policy violations;
- recovery attempts and outcome.

`null` means unavailable. Aggregation reports an availability count for every metric and computes a
numeric summary only from available values. It never converts `null` to zero.

Cost per accepted result is derived only when the complete profile schedule has available cost for
every trial and at least one `verified_success`. Its numerator includes all profile trial cost,
including failed attempts; otherwise the derived value is `null`.

### Durable store and replay

Evaluation data lives below `.flow/evaluations/<evaluation-id>/` by default:

- `plan.json`: immutable admitted public header and complete schedule; verifier bodies are replaced by
  digests and assertion counts;
- `trials.jsonl`: one strict digest-verified JSON record per committed trial;
- `.owner/`: owner-only single-writer record while a run is active.

Trial records contain `sequence`, `previousDigest`, and `recordDigest`. Reading validates the strict
schema, canonical digest chain, unique trial ids, exact schedule position, plan identity, and maximum
bounds before aggregation. A torn final line is incomplete, never committed. Duplicate or conflicting
records fail closed.

Re-running `flow eval run` with the same evaluation id and exact plan digest skips already committed
trial ids and schedules only the missing suffix. A different plan digest, out-of-order prefix, or
terminal complete evaluation fails before adapter execution. Version 1 does not resume inside an
individual interrupted harness trial; that scheduled trial is recorded as a failure and a later
repetition is distinct.

### Paired comparison and uncertainty

Holdout pairs are keyed by task id, seed, and repetition. A pair is complete only when both declared
profiles have committed records and is comparable only when platform, architecture, Node version,
Flow version, workspace backend, and starting snapshot agree. Incomplete or incomparable pairs remain
visible and cannot support superiority. Tuning and regression trials remain descriptive and continue
to participate in profile metrics and safety constraints.

The report contains:

- scheduled and committed counts by profile and classification;
- verified success and false-completion rates over the scheduled denominator;
- per-metric availability and summaries;
- paired verified-success delta (`candidate - baseline`);
- a deterministic percentile bootstrap interval seeded from `planDigest`;
- safety and regression constraint results;
- one comparison verdict: `superior`, `not_superior`, `insufficient_evidence`, or `constraint_failed`.

`superior` is allowed only when all declared holdout pairs are present and environment-comparable, the
minimum paired sample is met, the lower confidence bound exceeds the minimum effect, and every
safety/regression constraint passes. When regression tasks are declared, their success-loss ceiling
is computed only from complete environment-comparable regression pairs; holdout gains cannot mask a
regression loss. With no regression tasks, that constraint is not applicable.

## Interface contracts

### `admitEvaluationPlan(path)`

- Input: one local plan path.
- Output: immutable admitted plan, exact referenced content, redacted durable header, and schedule.
- Errors: `EvaluationPlanError` reports `invalid_schema`, `invalid_yaml`, or `limit_exceeded`;
  `EvaluationAdmissionError` reports `invalid_path`, `invalid_source`, `invalid_workflow`,
  `limit_exceeded`, `source_changed`, or `unsupported_entry`.
- Side effects: none.

### `HarnessEvaluationAdapter.run(request)`

- Input: immutable public trial request with no verifier body.
- Output: typed harness outcome, durable run reference when available, and nullable metrics.
- Errors: converted to `harness_failure`; an adapter exception cannot remove a scheduled trial.
- Authority: no evaluation-store access.

### `verifyEvaluationWorkspace(request)`

- Input: workspace path, expected workspace identity, and private admitted assertion set.
- Output: accepted/rejected/error plus bounded assertion evidence, verifier digest, and an actionable
  bounded reason for errors.
- Authority: read-only, no-follow access below the workspace; no process or network execution.

### `LocalEvaluationStore`

- `create(header)`: atomically publishes one immutable evaluation identity.
- `claim(evaluationId, planDigest)`: obtains one writer and validates the committed prefix.
- `append(record)`: validates the exact next scheduled trial and digest chain, then fsyncs it.
- `read(evaluationId)`: returns validated immutable header and records without claiming ownership.
- `release(evaluationId)`: releases only the caller's owner token.

### CLI

```text
flow eval validate <plan.yaml>
flow eval run <plan.yaml> [--evaluation-id <id>] [--evaluations-dir <path>]
flow eval inspect <evaluation-id> [--evaluations-dir <path>]
flow eval export <evaluation-id> --output <path> [--evaluations-dir <path>]
```

Validation performs no adapter execution or store creation. Inspect and export recompute the report
from raw records. Export writes canonical JSON atomically and refuses to overwrite an existing file.

## Bounds

- at most 64 tasks, 8 profiles, 32 explicit seeds, and 4,096 scheduled trials;
- at most 16 filesystem assertions per task;
- at most 4,096 fixture entries and 256 MiB logical fixture bytes;
- at most 1 MiB plan source and 1 MiB workflow source per profile;
- bounded identifiers, paths, reasons, raw records, and aggregate report size;
- exactly two profiles in the first comparison contract;
- confidence level fixed to `0.95` in version 1 and deterministic bootstrap samples fixed and bounded.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Unknown field or malformed YAML/JSON | Reject before path resolution, store mutation, or adapter use |
| Symlink, special fixture entry, escape path, or source race | Reject admission and identify the offending path |
| Workflow model provider, id, thinking level, or budget differs from controls | Reject as an incompatible profile |
| Unknown adapter or unsupported network/retry mode | Reject; never translate it into an executable |
| Fixture/workflow changes after admission | Trial isolation or adapter start fails; record a harness failure, never substitute new content |
| Harness crash, timeout, malformed/missing output | Commit a harness-failure record in its scheduled denominator slot |
| Harness reports success but verifier rejects | Commit `false_completion` |
| Verifier read, bound, or identity failure | Commit `verifier_error` and block superiority |
| Store owner collision | Fail without executing another trial |
| Torn trial tail | Ignore only the uncommitted tail after validating the committed prefix; expose incomplete state |
| Digest, schedule, sequence, or identity mismatch | Fail closed as corrupt; do not aggregate or resume |
| Duplicate-key, non-I-JSON, excessive, or trailing persisted JSON | Reject before replay, ownership, aggregation, or append |
| Missing telemetry | Persist `null` and increment no numeric availability count |
| Missing pair or insufficient sample | `insufficient_evidence`; never `superior` |
| Safety/regression ceiling exceeded | `constraint_failed` even if the success delta is favorable |
| Export target already exists | Refuse overwrite |

## Non-goals

- automatic harness refinement, activation, or rollout;
- a claim that Flow, Pi, OMP, Prime-agent, or a model provider is superior;
- arbitrary command, script, hook, plugin, or model-judge verifiers;
- provider-specific billing reconciliation or inferred missing telemetry;
- a hosted leaderboard, remote evaluation service, or benchmark registry;
- concurrent distributed evaluation workers in version 1;
- resuming inside one interrupted model call;
- exposing holdout verifier bodies to a harness adapter;
- relaxing existing workflow, policy, approval, sandbox, capability, or run replay rules.

## Acceptance-criterion verification map

| Criterion | Verification |
| --- | --- |
| Exact suite/task/profile/trial identity | Domain admission tests mutate each identity input and assert `planDigest` or rejection; CLI inspect snapshot test |
| Tuning/regression/holdout partitions and private verifier | Schema tests for all partitions; adapter spy proves no verifier body; workspace test proves verifier paths are outside fixture |
| Fresh isolated workspace and ordering evidence | Integration test compares distinct workspace ids/paths and equal snapshot digests; schedule snapshot test |
| Equivalent controls | Admission mutation matrix for model provider/id/thinking, budget, network, retry, verifier, fixture, seed, and task ordering |
| Post-run verifier authority | False-completion integration test where harness succeeds and assertion rejects |
| Failures remain in denominator | Aggregator table test for crash, timeout, malformed, missing, verifier error, and incomplete records |
| Required metric semantics | Telemetry reducer tests and report snapshot; every field accepts number or `null`, never omission/implicit zero |
| Immutable offline reproduction | Store tamper/reorder/truncate/duplicate tests; report equality before and after reopening without adapter |
| Paired uncertainty and constraints | Deterministic schedule/bootstrap tests, incomplete-pair tests, safety/regression failure tests |
| No unsupported superiority | Minimum sample, interval, missing pair, verifier error, and constraint mutation tests |
| Provider/runtime neutrality | Adapter port contract test plus explicit unknown-adapter admission failure |
| Fail-closed bounds and unknown fields | Table-driven parser/store/verifier limit tests |
| Validate/run/inspect/export CLI | Integration test through production composition; export no-overwrite and offline replay tests |
| Public trust/limits documentation | Scaffold test checks README, architecture, security, testing, workflow spec, example, and roadmap text |
| Existing gates | `npm run check`, `npm run test:coverage`, `npm run pack:check`, `npm audit --omit=dev --audit-level=low`, `actionlint .github/workflows/ci.yml` |

## Implementation sequence

1. Add optional durable Pi activity telemetry (turns, tool calls, tool errors) with legacy replay
   compatibility.
2. Implement strict evaluation domain schemas, identity admission, deterministic scheduling, metrics,
   aggregation, paired bootstrap, and comparison gates.
3. Implement no-follow fixture admission, private filesystem verification, and the immutable local
   evaluation store.
4. Implement the adapter port and `flow-workflow-v1` adapter over existing workflow execution.
5. Compose validate/run/inspect/export CLI commands and a credential-free example.
6. Publish operator, authoring, trust, recovery, and evaluation documentation.
7. Run complete gates and independent adversarial review; resolve every P1/P2/P3 finding before PR.
