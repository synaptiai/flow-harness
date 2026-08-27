# Iterative field report: digital-twin issue 4

This report records nine bounded OpenAI-backed Flow attempts to implement
[`digital-twin` issue 4](https://github.com/danielbentes/digital-twin/issues/4) from one fixed base.
The series began with the published `0.1.0-alpha.4` package and continued against reviewed source
fixes. The ninth attempt produced an accepted implementation.

Treat this series as product-development evidence, not a model benchmark. The harness, workflow,
and prompt controls changed between attempts in response to observed failures. The series measures
whether each correction removed its targeted failure without weakening the acceptance boundary.

## Result

Attempt 9 completed the issue and passed every configured verifier. Flow recorded an accepted goal
with seven accepted criteria. An unchanged external holdout also passed all seven of its checks.
An independent post-run review found no P1, P2, or P3 issue and reran these target-repository gates:

- Python compilation.
- Ruff across the complete repository.
- Mypy across 18 source files.
- Shell syntax validation.
- The complete test suite: 54 tests passed in the independent rerun.
- Nine deterministic twin evaluation cases, each with a twin win and full category scores.
- The unchanged seven-check external holdout.

The accepted patch adds a required `v0.4` twin-spec discriminator and stamps generated specs before
validation. It applies an ordered `v0.3 → v0.4` migration and fails closed for unknown versions. It
also preserves diagnostic field paths, documents migration behavior, and adds focused tests.

The complete denominator is nine attempts:

- One accepted implementation: attempt 9.
- One false acceptance caused by a harness defect: attempt 4.
- Seven nonaccepted attempts: attempts 1–3 and 5–8.

Attempts 7 and 8 are important near misses. Attempt 7 produced a candidate that passed the external
holdout, but Flow rejected the run because rolling summary transport failed before verifier
execution. Attempt 8 admitted a rolling checkpoint and ran all verifiers. Its candidate had one
Mypy error. The embedded issue verifier also imposed a stricter schema representation than the
issue required. Flow didn't accept either run.

## Fixed controls

These controls remained fixed for the comparable source-based attempts:

| Control | Value |
| --- | --- |
| Target repository | `danielbentes/digital-twin` |
| Target issue | Issue 4, twin-spec stability and version compatibility |
| Target base | `4cba8b7d4604a48569ee2cbf82ae513a20bc71e0` |
| Host | macOS 26.6.2 on Apple silicon |
| Node.js | `v26.7.0` |
| Model route | OpenAI `gpt-5.6-luna`, high thinking |
| Agent network access | Unavailable |
| Agent command execution | Unavailable on this macOS host |
| Deterministic commands | Downstream Flow verifiers and independent operator reruns |
| External holdout SHA-256 | `cc99f44480dfd1134acf0d2a134a84cf51cd8281dfa384cc8667780ee4910305` |

Each attempt started from a new checkout of the fixed target base. Flow's `.flow` state wasn't part
of the candidate diff. Before live execution, the untouched target passed compilation, Ruff, Mypy,
shell parsing, 49 tests, and the existing deterministic evaluation. The external holdout was red
against that untouched base because the schema didn't require `$schema_version`. This negative
control proved that the holdout could detect the missing issue contract.

## Attempt ledger

The table uses Flow's provider-neutral public resource totals. Model tokens include input, output,
cache-read, and cache-write tokens. Effects are durable file effects, not model claims.

| Attempt | Terminal result | Model tokens | Cost | Tool calls | Effects | Goal | Primary finding |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `pi_agent_error` | 116,489 | $0.014913 | 27 | 0 | Not accepted | Discovery consumed the 100,000-token budget before editing. |
| 2 | `pi_agent_error` | 189,123 | $0.015773 | 17 | 0 | Not accepted | A larger budget and file guidance still produced no edit. |
| 3 | `pi_agent_error` | 269,479 | $0.026234 | 35 | 4 | Not accepted | Corrected routing enabled partial edits, but the patch was incomplete and red. |
| 4 | `succeeded` | 288,746 | $0.022184 | 37 | 0 | **False acceptance** | Terminal policy exhaustion was incorrectly returned as agent success. |
| 5 | Policy audit limit | 304,188 | $0.024531 | 34 | 0 | Not accepted | The corrected terminal rule failed the run at 64 policy decisions. |
| 6 | Model-token budget exhausted | 1,327,663 | $0.070330 | 65 | 14 | Not accepted | Durable creation enabled progress, but the long session couldn't finish within its context strategy. |
| 7 | Provider execution failed | 685,904 | $0.068474 | 56 | 11 | Not accepted | The candidate passed the holdout; two rolling summary candidates were invalid. |
| 8 | Verifier command failed | 816,610 | $0.086978 | 51 | 14 | Not accepted | Rolling worked; Mypy and an overconstrained embedded verifier remained red. |
| 9 | `succeeded` | 965,585 | $0.085877 | 62 | 18 | **Accepted** | Rolling worked, all seven workflow criteria passed, and the external holdout stayed green. |

Attempt 4 remains in the denominator even though it exposed a harness defect rather than a target
implementation. Omitting it would hide a false-positive acceptance mode. Attempts 5–9 used the
corrected rule: exhausting the terminal policy-decision ceiling is failure, never success.

## Recursive corrections

### Make terminal exhaustion fail closed

Attempt 4 reached the agent policy ceiling with no file effect. The agent executor returned a
nominal success, which let repository gates run against the unchanged base and allowed the goal to
be accepted. The harness now returns a terminal failure when the policy audit limit is exhausted.
Attempt 5 reproduced the same broad-read behavior and failed with `agent reached policy audit limit
of 64 decisions`, confirming the correction.

### Count one policy decision per read request

The read adapter previously counted internal observation work more than once for one logical read.
The corrected adapter records one policy decision per model-requested read. This preserves the
ceiling while preventing adapter implementation details from consuming it.

### Add durable file creation

The original coding surface supported hash-anchored edits of existing files but couldn't create
the issue's required root-level `MIGRATIONS.md`. Flow added exclusive durable file creation with the
same policy, effect, and reconciliation principles as edits. Attempts 6–9 could therefore create
the migration guide without granting shell authority.

### Add rolling source-and-projection context

Attempt 6 committed 14 effects but consumed 1,327,663 aggregate model tokens against a 350,000-token
run limit. Flow then added opt-in rolling context. The complete primary model-session history stayed
append-only, while a bounded checkpoint became a derived provider projection. The workflow kept
the objective, authority, tools, two-request tail, and protected constraints exact.

Attempt 7 reached pressure on task request 14. The measured input was 64,847 tokens against the
50% pressure threshold. Flow admitted both summary requests for inference, but the model's live
Responses output didn't match the plain-text canonical JSON transport. Both candidates settled as
`invalid_output`, and the run failed with `pi_model_context_capacity_exceeded`. The candidate diff
still passed the external holdout, which isolated the failure to harness transport rather than task
implementation.

Flow replaced the fragile free-form transport with one internal `flow_context_checkpoint` tool.
The provider receives a closed JSON Schema, but Flow remains the acceptance authority. Flow removes
reasoning content and rejects mixed calls, multiple calls, and extra arguments. It canonicalizes the
exact three fields and applies the existing protected-constraint and size validation.

Attempt 8 admitted the first rolling checkpoint. It reduced the rendered historical surface from
470,920 to 43,087 bytes. The next measured task input fell from 66,542 to 5,580 tokens.

Attempt 9 repeated the behavior. It reduced the surface from 433,671 to 50,537 bytes. The next
measured task input fell from 66,160 to 5,626 tokens. Both runs kept one accepted epoch and needed
one summary generation.

### Separate product failure from verifier failure

Attempt 8's candidate passed the external issue holdout, but two independent problems remained:

- Mypy rejected a value from `dict.get()` because the implementation assigned an arbitrary decoded
  JSON value to a variable inferred as `str`.
- The embedded verifier required JSON Schema `const` or a single-value `enum`. The issue required
  one declared current version, not that specific representation.

Attempt 9 changed no product requirement. The verifier derived one unique version from the
extractor and schema instead of preferring one schema keyword. The prompt also included the
observed Mypy constraint as bounded evidence. This change is evidence-fed recovery, not a weakened
gate. The same Mypy command and the unchanged external holdout still had to pass.

## Accepted-run evidence

Attempt 9 used these immutable identities:

| Evidence | Value |
| --- | --- |
| Run ID | `digital-twin-issue4-pilot-9` |
| Workflow digest | `3043538b111a298a360cfd98d36cf7126e085250b6909c1a37e254b841975fa8` |
| Workflow-source SHA-256 | `f408c3619a43c5ec004e853fcbded0e286337d163c4b818f3427b182d786abe2` |
| External holdout SHA-256 | `cc99f44480dfd1134acf0d2a134a84cf51cd8281dfa384cc8667780ee4910305` |
| Node starts | 8 of 8 |
| Execution time | 351.404 seconds |
| Artifact bytes | 7,494 |
| Agent turns | 20 |
| Agent tool errors | 2 |
| Rolling epochs | 1 accepted of 1 started |
| Rolling summary bytes | 1,606 |

The workflow's complete test node reported 53 passed tests and one environment-dependent skip.
The independent post-run command reran the same complete suite with that test available and
reported 54 passed tests. Neither result had a failure.

## What the series establishes

For this exact task, model route, host, and fixed base, the series establishes that:

- Flow can implement a bounded issue through read, list, create, and hash-bound edit tools. The
  agent had no shell or network authority.
- Durable effect receipts preserve partial work without converting it into acceptance.
- Terminal policy exhaustion, model-budget exhaustion, rolling-summary rejection, and verifier
  failure all block goal acceptance.
- Provider-assisted structure can make a live rolling checkpoint reliable. Model output still has
  no authority over budgets, tools, effects, verification, or completion.
- A frozen external holdout can detect both the untouched base and a complete candidate without
  importing candidate-authored fixtures.
- Evidence-fed reruns can converge when each rerun starts from the same base and preserves every
  prior failure in the denominator.

The series doesn't establish that:

- One accepted issue predicts success on other repositories, languages, or task classes.
- The selected model is better or worse than another model or a direct coding agent.
- Rolling context improves quality independently of the prompt, tool surface, or evidence feedback.
- The adaptive nine-attempt series is statistically comparable to a frozen benchmark.
- macOS supports sandboxed agent command execution. It doesn't. Deterministic commands remained in
  separate verifier nodes.
- The accepted candidate can bypass ordinary repository review, hosted CI, or branch protection.

## Threats to validity

- The sample contains one issue and one model route.
- The harness and workflow were deliberately corrected between attempts. This supports recursive
  product development but prevents a controlled comparison across all nine rows.
- The operator designed the workflow, external holdout, bounded file guidance, and later evidence
  feedback. Attempt 9 wasn't a zero-human-intervention result.
- Cache-read and cache-write tokens dominate aggregate model-token totals. Compare the published
  components before inferring prompt size or billed fresh input.
- The external holdout covers the issue contract, not all repository behavior. Complete repository
  gates and manual review remain necessary.
- The live provider route is nondeterministic. Deterministic adapter regressions reproduce the
  accepted and rejected shapes without a credential. They don't prove future provider behavior.
- The source runs are private because model-session records can contain prompts, model output, tool
  arguments, and repository content. Public inspection intentionally exposes only bounded metadata.

## Next verification gate

Before using this result as evidence for another issue:

1. Publish the reviewed target patch through its ordinary pull-request checks.
2. Run the harness's complete native quality matrix.
3. Run the same hosted Linux x64 commands locally in Docker, then require hosted CI.
4. Review the harness diff in two stages: criterion mapping first, then security, correctness,
   performance, reliability, maintainability, and documentation.
5. Merge only when no P1, P2, or P3 finding remains and every required check is green.
6. Start the next target issue from a new frozen base, workflow, and external holdout. Keep all nine
   attempts in the cumulative field denominator.

Read [Keep long model sessions within provider capacity](../guides/rolling-context.md) for the
operator contract and [Testing and evaluation](../testing-and-evaluation.md) for the repository's
verification layers.
