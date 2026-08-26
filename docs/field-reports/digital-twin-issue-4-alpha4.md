# Field report: digital-twin issue 4 with Flow alpha.4

This report records three bounded agent attempts with the published Flow alpha.4 package against
one open issue in a separate repository. The attempts failed safely and produced no accepted
implementation. Treat these results as exploratory product evidence, not as a benchmark or a
claim about the selected model.

## Result

Flow didn't implement
[`digital-twin` issue 4](https://github.com/danielbentes/digital-twin/issues/4). The first two
permitted agent attempts ended before the agent called the edit tool or returned a final response.
A later, separately authorized attempt used corrected file-routing instructions and a newly
provisioned credential. It committed four hash-bound edits, then ended without a final response.
Flow didn't start dependent verifiers and didn't accept the goal.

The independent holdout remained red. Before the attempts, it reported:

```text
schema does not require $schema_version
```

After the third attempt, the schema check passed, but the holdout stopped at the next unmet
criterion:

```text
legacy migration banner is missing
```

Independent repository checks found two mypy errors and three failing tests in the partial patch.
The attempt didn't add `MIGRATIONS.md` or focused tests. No commit, push, or pull request was
created.

These outcomes support a narrow safety claim: alpha.4 prevented incomplete attempts, including an
attempt with committed edits, from becoming an accepted result. They don't support a
coding-effectiveness claim.

## Scope and controls

The pilot ran on August 26, 2026, with these fixed controls:

| Control | Fixed value |
| --- | --- |
| Flow package | `@synapti/flow-harness@0.1.0-alpha.4` from the public npm preview |
| Target | `danielbentes/digital-twin` issue 4 |
| Target base | `4cba8b7d4604a48569ee2cbf82ae513a20bc71e0` |
| Host | macOS 26.6.2 on Apple silicon |
| Node.js | `v26.7.0` |
| Model route | OpenAI `gpt-5.6-luna`, high thinking |
| Agent tools | `read`, `ls`, and hash-bound `edit` |
| Network and agent commands | Unavailable to the agent |
| Work profile | `long` |
| Recovery policy | Initial series: one attempt and one evidence-fed recovery. Authorized rerun: one attempt with no retry. |

Before each model execution, the target repository passed Python compilation, Ruff, mypy, shell
syntax, 49 tests, and its deterministic twin evaluation. A separate holdout, withheld from the
model prompt, failed against the untouched base for the missing `$schema_version` contract. This
red result confirmed that the holdout could detect the requested change.

The workflow placed six deterministic verifier nodes after the agent node. They covered Python
compilation, Ruff, mypy, shell syntax, the complete test suite, and the existing deterministic
evaluation. A failed agent node made all six verifiers unreachable by design.

## Attempt evidence

The run ledger provides these provider-neutral aggregates:

| Observation | Initial attempt | Recovery attempt | Authorized rerun |
| --- | ---: | ---: | ---: |
| Run ID | `digital-twin-issue4-pilot-1` | `digital-twin-issue4-pilot-2` | `69f49cd4-58cb-4a89-bfce-e0575d9f4f84` |
| Workflow digest | `3cfa26ce63f653865141187a22e31806e48436c949362eb8ccf9d78df04dc3f4` | `00d6cab889b25d17e4e38eb6779efa5140e69cba85d46326961b33cab609fe63` | `000991109550e367495ff2b0a3844568a7f8c010ac9b9acc71f3d0948e4ce073` |
| Model-token budget | 100,000 | 350,000 | 350,000 |
| Duration | 37.43 seconds | 21.17 seconds | 134.51 seconds |
| Reported model tokens | 116,489 | 189,123 | 269,479 |
| Reported cost | $0.014913 | $0.015773 | $0.026234 |
| Assistant turns | 6 | 7 | 10 |
| Tool calls | 27 | 17 | 35 |
| Tool errors | 3 | 0 | 1 |
| Effect receipts | 0 | 0 | 4 |
| Public terminal error | `pi_agent_error` | `pi_agent_error` | `pi_agent_error` |
| Side-effect status | `none` | `none` | `committed` |

The initial attempt spent its activity on discovery and crossed the 100,000-token model budget at
the settled-turn boundary. The recovery raised only that budget and added exact file-routing
guidance. It still made repeated bounded reads, primarily through one large synthesis module, and
ended below its new budget without editing.

The authorized rerun removed contradictory navigation instructions and supplied exact functional
regions. The agent made 59 allowed read or list decisions and four allowed writes. It changed the
schema, extractor, validator, and synthesizer, but it didn't connect the migration chain to the
rendering path, add tests, or create `MIGRATIONS.md`. The public run identifier is a generated UUID
because the operator assembled the optional CLI arguments incorrectly. The workflow file,
execution directory, work profile, model, budget, and authority remained fixed. Record this as an
operator-control defect when comparing trials.

Alpha.4 intentionally replaces the private provider error with the bounded public message `agent
provider execution failed`. The durable evidence therefore doesn't establish whether the recovery
ended because of a transient provider failure, a model-adapter failure, or another private
provider condition. A stronger root-cause claim would exceed the evidence.

## What the pilot established

The result establishes these observations for these exact runs:

- The public package installed, initialized, passed `flow doctor`, and started a real
  provider-backed workflow on the supported macOS host.
- The workflow and goal identities were durable and independently inspectable.
- Tool policy admitted only declared reads, lists, and hash-bound edits. The first two attempts had
  no side effect. The authorized rerun recorded four committed edit receipts.
- Agent failure blocked every dependent verifier and goal acceptance.
- The private acceptance check remained independent of model output and candidate tests.
- Increasing the global model-token budget didn't produce an implementation.
- Narrow file routing changed behavior from read-only exploration to partial editing, but it didn't
  produce a complete or passing change.

The result doesn't establish these broader claims:

- Flow can complete unattended changes in an established repository.
- The selected model is unsuitable for this task class.
- A specific provider, context-window, retry, or turn limit caused the final error.
- The same workflow succeeds or fails on Linux or with agent command execution.
- Semantic code tools or another model route produce the same result.
- Flow performs better or worse than a direct agent or another harness.
- A fresh credential resolves the underlying `pi_agent_error`. Provider-private evidence remains
  insufficient for that conclusion.

## Threats to validity

This pilot has material limitations:

- It used one issue, one model route, one host, and three related prompt variants. The sample isn't
  statistically meaningful.
- The recovery prompt contained conflicting navigation guidance. It first excluded broad README
  and changelog reads. A later general instruction included those documents. The trace doesn't
  show those reads. The contradiction still weakens prompt-control quality.
- The macOS profile couldn't give the agent sandboxed command execution. Deterministic commands
  were available only as downstream verifiers.
- The read tool exposes bounded line ranges but no exact text-search operation. The agent had to
  navigate a large module by repeated reads.
- Provider-private diagnostics are deliberately absent from durable public evidence. This protects
  sensitive information but limits postmortem classification.
- The control workflow, verification map, and holdout were frozen and hashed outside the target
  checkout. They are not yet a reviewed public benchmark corpus.
- The authorized rerun's requested run identifier and runs directory weren't applied because of an
  operator command-assembly error. Flow still recorded the generated identity and immutable run
  evidence in the target's default run store.
- Flow didn't run dependent verifiers after the agent failed. The operator ran the same commands
  manually to characterize the partial patch. Those results are diagnostic evidence, not accepted
  workflow criteria.

## Roadmap decision

Do not proceed automatically to `digital-twin` issues 5–7 with alpha.4. First, convert the observed
failure into a reproducible field-task slice:

1. Preserve reviewed, target-independent control manifests and external holdouts in a versioned
   field-evaluation corpus.
2. Evaluate a bounded exact text-search tool or a predeclared semantic-code route so an agent can
   locate relevant regions. Avoid paging through an entire large file. Keep shell and network
   authority unchanged.
3. Add a bounded, nonsecret provider-failure category that distinguishes retryable transport
   failure from deterministic model termination. Keep raw provider messages private.
4. Evaluate one retry only for an explicitly retryable provider category. Require no prior effect
   receipt or open command. Bind the model, prompt, workflow, and repository revision. Keep the same
   budget policy.
5. Define the operator disposition for a failed attempt with committed effects. Preserve its run
   evidence, prohibit automatic retry, and require independent checks before a human reuses or
   discards the partial patch.
6. Rerun issue 4 from the same base before extending the sequence. Require the external holdout,
   repository gates, and complete diff review to pass. Require a draft pull request before counting
   the task as accepted.
7. After issue 4 passes, run issues 5–7 as separate frozen trials. Report success, false
   completion, tokens, cost, turns, tool failures, duration, retries, and policy decisions. Report
   human intervention for every trial, including failures.

The [Delivery roadmap](../roadmap.md#product-benchmark-gate) retains the broader benchmark gate.
The [Testing and evaluation guide](../testing-and-evaluation.md) defines the repository's test
layers and live-provider policy.
