# Evaluate reference-first context compaction

Use the dedicated compaction evaluation to compare three bounded context modes on the same held-out
tasks. Flow balances trial order, verifies protected constraints from private filesystem evidence,
and records provider-surface and summary costs separately.

This feature is experimental in Flow `0.1.0-alpha.4` and the current source tree. You can run and
inspect evaluations, but you cannot activate a compaction mode for ordinary production runs. A
favorable report is evidence for review, not authority to change runtime defaults.

The current source separately provides rolling context as a production opt-in for embedded Pi
agents. That policy uses exact serialized-request measurement, pressure-triggered durable epochs,
and different fixed limits. It doesn't activate from an evaluation report. Read
[Keep long model sessions within provider capacity](rolling-context.md) when you need the ordinary
runtime policy.

Install the [Flow preview](install-preview.md) before you use this guide. Run commands that name the
included `examples/...` plan from a Flow checkout that matches the installed version.

## Understand the safety boundary

Flow keeps context optimization separate from workflow authority.

| Information | Owner | Compaction behavior |
| --- | --- | --- |
| Original objective | Model-session primary event | Remains verbatim and outside the model-generated summary. |
| Current system instructions and tool catalog | Pi request construction | Remain outside portable history and the summary. |
| Policy, approvals, budgets, effects, scheduling, verification, and completion | Workflow ledger and Flow control plane | Never enter summary authority. Compaction cannot change them. |
| Completed model and tool history | Private model-session record | Remains append-only. Flow can project a smaller request surface without rewriting the record. |
| Protected constraints | Evaluation plan and summary surface | Remain exact outside the summary and must also appear verbatim in an accepted summary. |
| Oversized command output | Retained artifact store | Can become a structured reference only after Flow verifies identity, integrity, retention, and availability. |

Flow disables Pi's ambient compaction for all Flow-owned sessions. The selected evaluation mode is
the only compaction policy supplied to the Pi adapter during these trials.

## Compare the three modes

| Mode | Provider context behavior |
| --- | --- |
| `none` | Sends completed portable history without Flow projection or summarization. |
| `references` | Replaces eligible oversized command results with verified artifact references before request-capacity checks. It doesn't generate a summary. |
| `references-and-summary` | Applies reference projection first. When the remaining completed range is eligible, it can accept one smaller model-generated summary. |

Reference projection begins only for a tool result of at least 4 KiB. Flow reads the structured
command outcome, not display text, to find retained standard-output or standard-error artifacts.
Every artifact must belong to the same run, workflow, node, and attempt. Its digest, size, media
type, retention state, and availability must match. If any reference is invalid or unavailable,
Flow keeps the complete original result. It also keeps the original when the projection is not
smaller.

Summary generation uses a zero-tool model request. Flow selects only a closed range of completed
primary events and keeps the latest completed request verbatim. A session can accept at most one
summary and can make at most two generation attempts. The second attempt must use the smaller of
the two plan-declared output-token limits. Flow accepts a candidate only when all of these
conditions hold:

- The response is exact canonical JSON with the closed version 1 schema.
- The summary is at most 64 KiB.
- Every protected constraint appears in the declared order and occurs verbatim in the summary.
- The resulting provider surface saves at least `minimumReductionBytes`.

An invalid, constraint-losing, provider-failed, output-limited, or insufficiently smaller candidate
leaves the prior surface unchanged. Summary input, output, and cost still count toward the trial's
total model usage.

## Validate the included example

From the matching checkout, validate the example without provider credentials or filesystem
mutation:

```sh
flow eval compaction validate \
  examples/evaluation/context-compaction.evaluation.yaml
```

Validation performs stable no-follow reads, fingerprints the fixture and workflow, compiles the
workflow, and verifies the complete plan. The output includes the plan digest, protected-constraint
count, three modes, schedule size, and `productionActivation: not_authorized`.

The example schedules 18 trials: one task, six seeds, and three modes. Running it contacts the
declared provider and uses that provider's normal Pi credentials:

```sh
flow eval compaction run \
  examples/evaluation/context-compaction.evaluation.yaml
```

The small public fixture proves the complete evaluation path. It might not create enough completed
history to accept a summary. Add representative long-horizon holdout tasks before you use results
to inform a product decision.

## Create an evaluation plan

Start from `examples/evaluation/context-compaction.evaluation.yaml`. A
`ContextCompactionEvaluationPlan` has one Flow workflow profile and these specialized rules:

- Every task uses `partition: holdout`.
- Every task declares one to 32 unique `protectedConstraints`.
- `constraintAssertionIndexes` maps each constraint, in order, to one unique private filesystem
  verifier assertion.

The workflow has these restrictions:

- The workflow and plan use the same model route and exact budget.
- Workload-tool network access is `deny`, and provider and harness retries are zero.
- The workflow contains no child workflow. Plan version 1 measures only root-workflow model
  sessions.

The plan also fixes execution and scheduling:

- `seeds` contains unique non-negative integers. Its length is a positive multiple of six, from 6
  through 30.
- `modes` is exactly `[none, references, references-and-summary]`.
- `order` is `six-order-balanced-v1`.
- The complete schedule contains no more than 4,096 trials.

Use `controls.compaction` to declare the two summary bounds:

```yaml
controls:
  compaction:
    minimumReductionBytes: 1024
    summaryOutputTokenLimits: [512, 256]
```

The first value requires a 1 KiB reduction before Flow accepts a summary. The second generation, if
needed, can return at most 256 tokens. These values are explicit plan controls, not production
defaults.

Use comparison thresholds to define acceptable regressions:

```yaml
comparison:
  minimumPairedTrials: 6
  maxVerifiedSuccessRegression: 0
  maxTotalTokenIncreaseRate: 0.1
  maxConstraintLosses: 0
```

`minimumPairedTrials` cannot exceed the task count multiplied by the seed count. Version 1 requires
zero protected-constraint losses. The success-regression value is a rate from 0 through 1. The
token-increase value is a non-negative rate. A value of `0.1` permits at most a 10% increase.

## Inspect and export evidence

The default evaluation identifier is the plan's `metadata.id`. Inspect the example after a complete
or partial run:

```sh
flow eval compaction inspect reference-first-compaction-example
```

Export the same offline evidence to a new file:

```sh
flow eval compaction export reference-first-compaction-example \
  --output context-compaction-report.json
```

Use `--evaluations-dir <path>` on `run`, `inspect`, or `export` to select another evaluation root.
Flow stores this evidence at
`.flow/evaluations/context-compaction/<evaluation-id>/` by default. The dedicated directory keeps
the three-mode plan separate from ordinary paired evaluations. Export refuses to replace an
existing output file.

The report includes these measures for each mode:

- Scheduled, committed, and missing trials.
- Verified successes, false completions, harness failures, and verifier errors.
- Checked, retained, lost, and unavailable protected constraints.
- Total model tokens, cost in USD micro-units, and wall latency.

The report also includes context-specific measures:

- Provider-request bytes and conservative estimated tokens.
- Summary attempts and accepted, rejected, or interrupted settlements.
- Summary input tokens, output tokens, and cost.
- Artifact reopen attempts and successes.

Unavailable measurements remain `null`. Flow doesn't turn them into zero. The total token and cost
figures include summary-generation usage. The nested compaction figures separate that overhead for
review.

## Interpret the hierarchical verdict

Flow compares `references` with `none` first. It checks complete environment-matched pairs,
protected-constraint retention, verified-success regression, and total-token change. The verdict is
one of `passes`, `constraint_failed`, `performance_failed`, or `insufficient_evidence`.

Flow compares `references-and-summary` with `references` only when the first comparison passes.
Otherwise, the second result is `not_evaluated` with
`references_vs_none_gate_failed`. This order prevents a summary result from hiding a defective
reference projection.

Even when both comparisons pass, the report keeps `productionActivation: not_authorized`. Flow has
no command that converts this report into an ordinary runtime compaction policy.

## Resume after interruption

Re-run `eval compaction run` with the same plan and evaluation identifier. Flow re-admits all plan
sources, validates the committed hash-chained prefix, and starts only the missing schedule suffix.
It never repeats a committed trial.

If a process stops after the durable adapter-start record but before terminal trial evidence, the
next run appends one `harness_failure` with unavailable metrics. It doesn't contact the provider for
that trial again. Missing compaction telemetry remains `null`, and the comparison cannot pass from
invented zeroes.

Within a live model session, Flow records `context_compaction_started` before summary provider I/O.
If recovery finds that start without a settlement, it appends an interrupted settlement and can
make one smaller second generation. It reconstructs the candidate source from durable primary
events. It doesn't trust process memory or provider-native continuation state.

The dedicated evaluation ledger fails closed on an unterminated or corrupt record. Preserve the
evaluation directory for diagnosis. Don't hand-edit `plan.json`, `trials.jsonl`, active-attempt
metadata, model sessions, or ownership files.

For the private session event contract, read
[Inspect and recover portable model sessions](model-sessions.md). For ordinary evaluation
concepts and holdout hygiene, read [Reproducible harness evaluation](../evaluation.md). For exact
restart ordering, read [Recovery and interruption safety](../recovery.md).
