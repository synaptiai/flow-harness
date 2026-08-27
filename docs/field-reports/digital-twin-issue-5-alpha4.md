# Iterative field report: digital-twin issue 5

This report records 11 bounded OpenAI-backed Flow attempts to implement
[`digital-twin` issue 5](https://github.com/danielbentes/digital-twin/issues/5) from one fixed base.
The task split a 3,192-line Python synthesis script into focused importable modules while preserving
the command-line interface, generated artifacts, and historical imports.

The eleventh attempt and four bounded repair workflows produced the accepted candidate. Pull
request [danielbentes/digital-twin#10](https://github.com/danielbentes/digital-twin/pull/10) merged
that candidate as commit
[`c37b139`](https://github.com/danielbentes/digital-twin/commit/c37b1391c72594a4860614ed447cdce67d20b4a0).

Treat this series as recursive product-development evidence, not as a model benchmark or an
unattended-success claim. The harness, workflow, prompts, private verifier, and repair plans changed
between attempts in response to observed failures. Every full attempt remains in the denominator.

## Result

The merged candidate has seven focused modules. The compatibility wrapper contains nine lines.
The final independent verification established all of these facts:

- The private structural holdout accepted 12 generated artifacts, eight frozen source files, seven
  modules, and the nine-line wrapper.
- All 102 original top-level definitions exist exactly once. Every moved non-`main` definition has
  the same abstract syntax tree as the original. `write_final_outputs` is the only added definition.
- Python compilation, repository-wide Ruff, Mypy across 25 source files, and shell syntax checks
  passed.
- The complete host test suite passed 54 tests.
- All nine deterministic twin evaluation cases retained a `1.0` score for every metric.
- The legacy command's `--help` path passed.
- The documented package import returned the current `v0.4` schema identity.
- A secret, debug-output, and placeholder scan found no result.

Flow's contained verifier environment reported 53 passed tests and one skip because one
operator-specific private-corpus test wasn't available inside the sandbox. The independent host
rerun included that test and reported 54 passed tests. Neither run had a failure.

The complete full-attempt denominator is:

- One accepted candidate chain: attempt 11 followed by four bounded repair workflows.
- One workflow-success candidate rejected by strengthened independent review: attempt 9.
- Nine other nonaccepted full attempts: attempts 1–8 and 10.

Attempt 11 did not succeed as one unattended workflow. Its full run correctly failed five final
verifiers. An operator then authored bounded repair workflows from the recorded failure evidence.
The final result demonstrates evidence-fed convergence with deterministic acceptance, not
autonomous repair-plan selection.

## Fixed controls

These controls remained fixed for the comparable full attempts:

| Control | Value |
| --- | --- |
| Target repository | `danielbentes/digital-twin` |
| Target issue | Issue 5, modularize the synthesis implementation |
| Target base | `6495d0b37c5706c17d401ca93d4b46c2c05e04ac` |
| Host | macOS 26.6.2 on Apple silicon |
| Node.js | `v26.7.0` |
| Model route | OpenAI `gpt-5.6-luna`, high thinking |
| Agent network access | Unavailable |
| Agent command execution | Unavailable on this macOS host |
| Deterministic commands | Downstream Flow verifiers and independent operator reruns |
| Original implementation | `skills/digital-twin/scripts/synthesize.py`, 3,192 lines |
| Private holdout SHA-256 | `eb49d18817530ab368818093e089b0f346f72965bbe74d66375600a67acb077f` |

Each full attempt used a new checkout of the fixed base and excluded Flow's `.flow` state from the
candidate diff. The private holdout froze existing tests and invocation documents. It
checked focused ownership and historical imports. It generated fixed artifacts in a temporary
directory and compared normalized content digests. Later attempts added early syntax checks and
abstract-syntax-tree checks. They didn't remove the final repository gates.

## Full-attempt ledger

The table uses resource values from Flow's private run events. Model tokens are the sum of input,
output, cache-read, and cache-write tokens. Effects are settled durable filesystem effects, not
model claims. A `run_succeeded` result means that the configured workflow passed. It doesn't bypass
the later independent review.

| Attempt | Terminal result | Model tokens | Cost | Tool calls | Tool errors | Effects | Publication result | Primary finding |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | Policy limit | 1,693,291 | $0.175103 | 65 | 3 | 14 | Rejected | The initial broad extraction remained incomplete before the 64-decision ceiling. |
| 2 | Policy limit | 1,499,466 | $0.234463 | 90 | 17 | 10 | Rejected | More decomposition still left the twin and command-line split incomplete. |
| 3 | Policy limit | 1,730,055 | $0.248253 | 142 | 11 | 10 | Rejected | Wrapper cutover repeatedly replayed the 3,192-line source and exhausted policy. |
| 4 | Policy limit | 2,402,946 | $0.256325 | 168 | 18 | 17 | Rejected | Complete replacement made cutover practical, but the later package audit exhausted policy. |
| 5 | Policy limit | 1,444,925 | $0.194068 | 115 | 9 | 7 | Rejected | Broad assembly progressed, but the command-line phase still consumed its decision ceiling. |
| 6 | Policy limit | 746,548 | $0.130826 | 132 | 68 | 11 | Rejected | Split command, export, and documentation phases worked; an ambiguous repair phase probed nonexistent paths until the ceiling. |
| 7 | Verifier failure | 925,732 | $0.145517 | 63 | 6 | 13 | Rejected | Import ownership, lint, type, test, export, and documentation defects reached the final gates. |
| 8 | Verifier failure | 1,337,198 | $0.216436 | 93 | 9 | 15 | Rejected | Runtime namespace mutation, absolute imports, and unused imports remained. |
| 9 | `run_succeeded` | 1,053,911 | $0.176242 | 79 | 8 | 18 | Rejected after review | All configured nodes passed, but the post-run compatibility audit found omitted historical data exports. |
| 10 | Verifier failure | 871,571 | $0.162931 | 83 | 6 | 14 | Rejected | One missing closing bracket made the package invalid; two focused repairs passed, but a fresh full run remained necessary. |
| 11 | Verifier failure | 1,161,976 | $0.188132 | 93 | 13 | 19 | Accepted after repairs | Early syntax passed, but final gates found missing definitions, imports, exports, and one undefined helper. Bounded repairs converged. |

The 11 full attempts recorded 14,867,619 aggregate model tokens and $2.128296 in reported model
cost. They also recorded 1,123 tool calls, 168 safely reported tool errors, and 148 settled
filesystem effects. These totals exclude diagnostic commands and the repair workflows described
next. Cache tokens dominate the aggregate token figure. It isn't a fresh-input or invoice estimate.

## Repair-run ledger

Repair workflows were separate bounded Flow runs. They consumed existing verifier evidence but
couldn't change the frozen final acceptance commands.

| Source attempt | Repair | Result | Model tokens | Cost | Effects | Finding |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 10 | Syntax repair | `run_succeeded` | 3,162 | $0.000958 | 1 | Added the missing bracket and made the package parse. |
| 10 | AST repair | `run_succeeded` | 23,513 | $0.006263 | 1 | Restored the exact moved-body contract. |
| 11 | Interface repair | `run_succeeded` | 42,005 | $0.008752 | 6 | Restored missing definitions, imports, historical exports, lint, types, and tests. |
| 11 | Documentation repair | Verifier failure | 20,540 | $0.008325 | 1 | The model invented a `--deterministic` option and narrowed commands; the verifier rejected the guide. |
| 11 | Command repair | `run_succeeded` | 4,850 | $0.002147 | 1 | Restored executable, repository-valid commands. |
| 11 | Clarity repair | `run_succeeded` | 2,731 | $0.000824 | 1 | Removed ambiguous instructions without changing the commands. |

Attempt 11 plus its four repair runs used 1,232,102 aggregate model tokens and $0.208180 in reported
model cost. They also used 134 tool calls, 16 reported tool errors, and 28 settled effects. The
documentation failure is part of the accepted candidate chain. Omitting it would hide a concrete
model hallucination that deterministic review caught.

## Recursive corrections

### Add durable directory creation

The task required a new importable package directory. Flow's original coding surface could create
files but couldn't create their parent directory. The new nonrecursive `mkdir` operation requires
an existing parent and refuses an existing target. It records the empty-directory identity and
mode. It uses the file-mutation write-ahead effect and target-lock discipline.

### Add version-anchored complete replacement

The thin compatibility wrapper had to replace a 3,192-line file with nine to 11 lines. Replaying
the complete prior file through exact substring edits consumed model context and policy decisions.
The new `replace` operation accepts the full expected SHA-256 digest and bounded desired UTF-8
content. It preserves the file mode, refuses stale or unchanged content, and uses the existing
effect queue, mutation lock, journal, and recovery protocol.

A focused live Pi proof reduced the wrapper from 3,192 lines to 11 with two policy decisions and
one settled effect. This result isolated complete replacement from the rest of the refactor. It
didn't prove that the remaining package was correct.

### Split model work from deterministic verification

Attempts 1–6 showed that one broad agent phase spent decisions rediscovering structure and
replaying large files. Later workflows separated package extraction, command-line assembly,
exports, documentation, cutover, output ownership, interface reconciliation, and deterministic
gates. Each phase received a bounded objective and declared file authority.

This decomposition kept attempt 11's eight model sessions below the configured 50% pressure
threshold. The run recorded zero compaction events and zero rolling epochs. This is positive
evidence for phase decomposition and complete replacement. It isn't evidence that long-session
compaction is unnecessary for other tasks.

### Move cheap syntax checks earlier

Attempt 10 reached every final verifier with a package that contained one missing bracket. Attempt
11 placed a Python syntax verifier immediately after the first extraction phase. It also added an
abstract-syntax-tree contract before the broad final gate. Cheap deterministic checks now stop
downstream model work closer to the defect that caused the failure.

### Strengthen compatibility ownership

Attempt 9 passed its configured workflow and complete repository suite. Independent review then
found that package exports omitted `ITALIC`, `_DESTRUCTIVE_AUTHORITY_PATTERNS`,
`_DROP_FRAGMENT_TAGS`, `_MISSING_VERSION`, `_SAFE_FRAGMENT_TAGS`, `_SUBSTITUTION_SECTIONS`,
`_USER_NAME_ALLOWED`, and `_V03_REQUIRED_FIELDS`.

The strengthened holdout checked historical callable and data exports through both the package and
the legacy wrapper. Attempt 11's full run then exposed additional missing definition ownership and
import errors instead of accepting the candidate. The repair restored those interfaces without
changing the original script bodies.

### Verify documentation as executable guidance

The first attempt 11 documentation repair wrote a plausible but nonexistent `--deterministic`
option. It also replaced complete repository checks with narrower commands. The documentation
verifier executed or inspected the exact documented commands and rejected the change. Two smaller
repairs corrected command accuracy and then clarity.

This failure shows why prose review alone isn't enough for command documentation. Public guidance
needs executable examples, command ownership, and the same repository scope that acceptance uses.

## Accepted-chain evidence

| Evidence | Value |
| --- | --- |
| Full run ID | `digital-twin-issue5-pilot-11` |
| Workflow digest | `8380eff278365713db9369aa5e46cd529d818ba5df937f07bf0741f93af35616` |
| Private holdout SHA-256 | `eb49d18817530ab368818093e089b0f346f72965bbe74d66375600a67acb077f` |
| Full-run prepared and settled effects | 19 and 19 |
| Full-run agent sessions | 8 |
| Full-run compaction events | 0 |
| Full-run rolling epochs | 0 |
| Interface-repair nodes | 6 of 6 succeeded |
| Final pull request | `danielbentes/digital-twin#10` |
| Merged commit | `c37b1391c72594a4860614ed447cdce67d20b4a0` |

The full run failed closed. The interface repair then passed six of six nodes. The first
documentation repair failed its verifier, and the two following documentation repairs passed. The
independent final matrix reran the frozen structural holdout, all repository gates, the legacy
command, the package import, and the sensitive-output scan before pull-request publication.

## What the series establishes

For this fixed repository, issue, base, host, and model route, the series establishes that:

- Flow can produce and publish a large behavior-preserving Python refactor without granting the
  model shell or network authority.
- Durable directory creation and complete replacement cover practical coding operations that
  exact substring edit alone couldn't handle efficiently.
- Write-ahead policy decisions and effect receipts preserve partial work without turning it into
  acceptance.
- Early syntax, final repository, private structural, AST, compatibility, and documentation gates
  fail closed on distinct defect classes.
- Separate bounded repair workflows can converge from durable verifier evidence while the final
  acceptance commands remain fixed.
- Ordinary pull-request review, hosted CI, and an independent rerun remain necessary after Flow
  produces a candidate.

The series doesn't establish that:

- Flow can choose and execute every repair workflow without an operator.
- One accepted refactor predicts success across repositories, languages, issue classes, models, or
  providers.
- The adaptive 11-attempt series is statistically comparable to a frozen benchmark.
- Phase decomposition is always cheaper than rolling context or compaction.
- A successful repository suite proves every historical import unless the compatibility contract
  checks those imports explicitly.
- macOS supports sandboxed agent command execution. Deterministic commands remained separate
  verifier nodes.

## DeepSeek compaction and ledger implications

The pilot supports Flow's existing two-plane design. The workflow ledger stays authoritative, and
the complete model-session record stays append-only. Flow derives a smaller provider surface when
needed.

DeepSeek Harness independently provides these parts:

- An append-only session log and replaceable derived surface.
- A separate compaction service contract and backend.
- Separate deterministic tool-result pruning and human control.

Flow should retain these conclusions:

- Apply deterministic reference or tool-result reduction before a paid summary, then remeasure.
- Keep source-event identities, the exact routed model, tools, instructions, and authority bound to
  every accepted checkpoint.
- Preserve balanced tool-call/result units and a recent exact tail.
- Record start, candidate, settlement, reduction, and interruption facts durably.
- Evaluate prefix-cache reuse only when the current provider route and request prefix are exact and
  fresh. A resumed session's historical route isn't enough.
- Treat DeepSeek's default pressure and retention ratios as experiment inputs, not Flow defaults.
  Thresholds depend on the routed model, output allowance, task shape, and token measurement.

Flow shouldn't let a summary rewrite the workflow ledger, replace protected constraints, authorize
effects, or stand in for deterministic evidence. Read
[Capability sourcing](../capability-sourcing.md#learned-from-deepseek-harness) for the complete
adoption matrix.

## Threats to validity

- The sample contains one refactor, one repository, one model route, and one host platform.
- The harness and workflow changed between attempts. This supports recursive product development
  but prevents a controlled comparison across all rows.
- The operator designed the workflows, private holdout, phase boundaries, strengthened
  compatibility checks, and every repair plan.
- Attempts 9–11 used progressively stronger gates. Earlier attempts didn't face the final complete
  contract.
- Diagnostic runs and local investigations aren't included in the full-attempt cost table. Repair
  workflows are reported separately.
- The provider route is nondeterministic. Deterministic Pi integration tests reproduce tool and
  failure contracts, not future model behavior.
- Private run records can contain prompts, model output, tool arguments, file content, and paths.
  Public reports intentionally expose only reviewed bounded facts.

## Next verification gate

Before using this result as a claim of autonomous recursive repair:

1. Freeze the target base, workflow, private holdout, repository commands, and repair ceiling.
2. Add a closed verifier-finding contract that refers to durable evidence instead of free-form
   model diagnoses.
3. Let a bounded controller select only predeclared repair workflow classes. It must not edit the
   goal, verifiers, holdout, budgets, or authority.
4. Require a measurable progress invariant and a fixed limit on cycles, starts, effects, tokens,
   cost, and elapsed time.
5. Compare verifier-directed recovery with operator-authored repairs on held-out tasks. Preserve
   every full and repair attempt in the denominator.
6. Publish only through ordinary two-stage review and complete native checks. Require Docker parity
   checks, hosted Linux x64 CI, and a clean pull-request merge.

Read [Keep long model sessions within provider capacity](../guides/rolling-context.md) for the
production projection contract and [Testing and evaluation](../testing-and-evaluation.md) for the
repository's verification layers.
