# Evaluate bounded one-shot delegation

Use a `delegation-v1` evaluation to measure whether one reviewed local specialist helps one exact
manager agent. The manager can skip the specialist or call it once through the sealed
`flow_delegate` tool. Flow runs the specialist in the foreground through the existing isolated
child-workflow lifecycle and records its identity, result, resources, and cleanup state.

This feature is an evaluation experiment. It cannot activate delegation for ordinary workflows.

## Prerequisites

Before you start, prepare these inputs:

- A source build of Flow with its dependencies installed.
- One exact root workflow with an embedded Pi `agent` node that acts as the manager.
- One exact child workflow with one typed `result` node and no nested child workflow.
- The exact capability-package closure used by the root workflow. An empty closure is supported.
- A reviewed `DelegationEvaluationCandidate` that binds the current embedded Pi executor identity.
- At least one filesystem-verified `delegation-fit` holdout task and one filesystem-verified
  `sequential-control` holdout task.
- Provider credentials for the model declared by the evaluation plan.

Flow validates an existing candidate but doesn't generate one. The system that produces the
candidate must bind the exact current Node executable, embedded Pi adapter contract, Pi package
closures, and root and child sources. It must also bind the package closure, objective, result
schema, and budgets. If any
bound source or executable changes, create and review a new candidate instead of editing an
admitted identity.

## Understand the sealed authority

The candidate profile differs from the baseline only by one immutable delegation capability
snapshot. Both profiles use the same root workflow bytes, package closure, task fixtures,
instructions, verifiers, model controls, budgets, network denial, retry denial, seeds, and paired
order.

The snapshot fixes every value that could expand authority:

| Bound value | Requirement |
| --- | --- |
| Manager | One existing embedded Pi agent in the root workflow |
| Objective | One literal reviewed value; the manager can't supply or change it |
| Child | One exact local workflow with a typed result |
| Packages | The same exact package closure as the baseline |
| Executor | The current exact embedded Pi and Node closure |
| Budget | Positive ceilings for node starts, model tokens, model cost, execution time, and artifact bytes |
| Depth | Exactly `1` |
| Calls | Exactly `1` for the manager attempt |

`flow_delegate` accepts an empty object and runs sequentially. It doesn't accept an objective,
workflow, model, package, budget, identity, or scheduling argument. A second call returns a
deterministic denial and creates no second child. The child receives the ordinary package closure
without the delegation snapshot, so it can't delegate again.

The [generated public capability reference](../reference/tools-and-capabilities.md#public-limits)
owns the exact candidate, objective, depth, and call limits. It doesn't list `flow_delegate` as an
ordinary selectable model tool because only an admitted candidate manager can receive it.

## Define the candidate

Use `apiVersion: flow.synapti.ai/v1alpha1` and `kind: DelegationEvaluationCandidate`. Bind these
sections:

- `metadata` identifies the reviewed candidate and its semantic version.
- `scope` selects `workflow-agent-delegation`, the exact root workflow, and the manager node.
- `baseline.workflow` binds the portable root path, source SHA-256, and compiled workflow digest.
- `baseline.packageClosureDigest` binds the complete immutable package closure.
- `delegation.objective` contains the literal private objective.
- `delegation.child` binds the portable child path, source and workflow digests, result node and
  schema digests, and complete child budget.
- `delegation.executor` binds the exact observed embedded Pi executor identity.
- `delegation.maxDepth` and `delegation.maxCalls` are both `1`.

Store the root workflow, child workflow, candidate, evaluation plan, and task fixtures below the
same review boundary. Flow reopens regular files without following symbolic links, enforces byte
limits, compiles both workflows, and checks the files again before admission succeeds.

## Define the paired plan

Set `purpose: delegation-v1` on an ordinary `EvaluationPlan`. Use exactly two
`flow-workflow-v1` profiles:

1. Set the baseline profile's `workflow` to the root workflow.
2. Set the candidate profile's `candidate` to the delegation candidate.

Every task must use the `holdout` partition and `filesystem-v1` verification. Assign
`delegationClass: delegation-fit` to tasks that have a meaningful independent specialist boundary.
Assign `delegationClass: sequential-control` to tightly coupled tasks where delegation isn't
expected to help. Include both classes so the report can expose selective benefit or needless
overhead.

The plan must also use these controls:

- `network: deny`.
- `retry.providerRetries: 0`.
- `retry.harnessRetries: 0`.
- `order: paired-alternating-v1`.
- One shared model, budget, task set, verifier set, and seed set.

Flow rejects a plan that changes the root workflow, package closure, or non-delegation controls
between profiles.

## Validate and run the experiment

Build Flow so the command uses the current compiled source:

```sh
npm run build
```

Validate the candidate, executor, package closure, task classes, controls, and complete paired
schedule without starting a model request:

```sh
node dist/cli/main.js eval validate <plan.yaml>
```

The command returns `valid: true`, `purpose: delegation-v1`, both task classes, both profile
identities, and the scheduled trial count. If executor or source identity changed, regenerate and
review the candidate before you continue.

Start or resume the evaluation with an explicit durable identifier:

```sh
node dist/cli/main.js eval run <plan.yaml> --evaluation-id <evaluation-id>
```

Flow revalidates the sealed embedded Pi executor before it creates each candidate trial attempt.
It revalidates the executor again immediately before the candidate workflow starts. Executor drift
stops the evaluation without granting the sealed tool.

Flow alternates baseline and candidate trials for each task and seed. The baseline manager has no
delegation tool. The candidate manager can skip the tool or call the sealed child once. When it
calls the tool, Flow performs these steps:

1. Reserves the complete child ceiling before the manager attempt starts.
2. Appends a durable delegation preparation before it creates the child workspace or run ledger.
3. Runs the exact child in an isolated `reflink-copy-v1` workspace.
4. Validates the typed child result and terminal child ledger.
5. Discards the child workspace and appends the durable settlement.
6. Returns the canonical child result to the manager and records an identity-only receipt.

Flow charges child resources once from the durable settlement. It doesn't copy those resources
into manager model usage. A manager cannot report success after a failed, cancelled, or
resource-exhausted child.

## Inspect and export evidence

Inspect the stored report without loading the candidate source, provider, or embedded Pi executor:

```sh
node dist/cli/main.js eval inspect <evaluation-id>
```

Export the same public evidence to a new file:

```sh
node dist/cli/main.js eval export <evaluation-id> --output <report.json>
```

The public header and records contain digests, byte counts, task classes, lifecycle states,
resource measurements, and verdicts. They exclude the objective text, workflow bodies, prompts,
model output, canonical child result, credentials, environment values, absolute paths, and private
verifier assertions.

## Interpret the report

For `delegation-v1`, `report.delegation` contains these fields:

| Field | Meaning |
| --- | --- |
| `scheduledPairs` | Paired holdout comparisons required by the admitted schedule |
| `completePairs` | Pairs with complete baseline and candidate delegation observations |
| `completeObservations` | Trials with complete lifecycle observations |
| `missingObservations` | Scheduled trials without complete delegation observations |
| `constraintViolations` | Count of observed identity, lifecycle, accounting, or cleanup violations |
| `classes` | Separate `delegation-fit` and `sequential-control` summaries |
| `limitations` | Explicit reasons that restrict interpretation |

Each class reports observed invocations, skips, successful and unsuccessful children, total child
resources, and the candidate-minus-baseline child resource delta. A `null` delta means at least one
scheduled pair in that class is incomplete. Unavailable child token or cost accounting makes its
delegation observation incomplete. The report doesn't interpret an unavailable value as zero.

`report.comparison.constraints.delegationEvidence` has three states:

- `true` means every scheduled observation and pair is complete and no delegation constraint
  violation was recorded.
- `false` means complete evidence proves at least one delegation constraint violation. The verdict
  is `constraint_failed`.
- `null` means observations or pairs are incomplete. The verdict is `insufficient_evidence`.

When delegation evidence is complete and valid, Flow retains the ordinary `superior` or
`not_superior` comparison result. A favorable result is evidence for this exact experiment only.
It doesn't produce an activation artifact and `flow candidate activate` rejects the candidate.

## Recover after interruption

Use the same plan and evaluation identifier with `eval run` after an interruption. Flow reopens the
evaluation ledger and reconciles the exact derived child identity.

- If preparation exists without a child ledger, Flow removes the prepared workspace and doesn't
  start the child.
- If the child reached a terminal state before the parent settlement, Flow replays that exact child,
  then retries idempotent cleanup. It records the missing settlement once.
- In both cases, Flow reports the interrupted manager attempt as `uncertain_operation` and doesn't
  invoke the manager again automatically.
- If the child ledger, workspace, source, executor, result, or receipt identity is inconsistent,
  Flow fails closed. It preserves the evidence for inspection.

## Troubleshoot failures

| Failure | Action |
| --- | --- |
| Candidate or executor identity changed | Regenerate the complete candidate from the current reviewed sources and executor closure. Don't patch individual digests. |
| Package-closure digest doesn't match | Load the same immutable effective-harness package set for both profiles and regenerate the candidate. |
| A task class is missing | Add at least one filesystem-verified holdout task from each required class. |
| The parent lacks the complete child ceiling | Increase the reviewed parent evaluation budget or reduce the child budget, then create a new candidate. |
| A second call is denied | Treat the denial as expected enforcement. Change the manager prompt if the repeated request is unintended. |
| The report is `insufficient_evidence` | Inspect `missingObservations`, incomplete class pairs, trial failures, and `limitations`. Don't infer a favorable result. |
| The report is `constraint_failed` | Inspect the recorded constraint categories. Fix the experiment boundary and run a new evaluation. The candidate can't activate. |

## Know the non-goals

This experiment doesn't provide recursive, parallel, detached, background, remote, Agent2Agent
(A2A), Model Context Protocol (MCP) task, or multi-host delegation. It doesn't promote child
workspace changes or expose the tool to prompt-only ACP or external harness profiles. A model can't
choose the objective, child, model, packages, budget, result schema, depth, or call count.

For the component and replay boundaries, read [Architecture](../architecture.md). For the shared
plan, store, verification, and comparison contracts, read
[Reproducible harness evaluation](../evaluation.md).
