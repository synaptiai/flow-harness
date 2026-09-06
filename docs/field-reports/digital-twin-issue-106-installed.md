# Installed-package digital-twin issue 106 pilot

## Result

Both hosted attempts failed before candidate acceptance, independent review, publication, or
merge. The replacement qualified and retained one package on both named hosts, but it did not
close the installed-package lifecycle qualification gate. See
[replacement attempt](#replacement-attempt) for the September 6 result.

In the first attempt, the installed command passed plan validation and host admission on Ubuntu
24.04 x64. It started
one implementation workflow and preserved its terminal failure. The implementation agent returned
success, but the workflow then exhausted its aggregate token budget. An agent success report did
not become lifecycle acceptance.

The operator authenticated the final encrypted evidence and removed all three dedicated Actions
secrets. The existing provider credential and the owner-only local decryption key remain intact.
No replacement attempt was started during the first attempt's cleanup. GitHub independently showed
no open candidate PR and issue 106 still open after that failure.

## Exact identities and controls

| Item | Frozen or observed value |
| --- | --- |
| Issue | [Read-only hook registration status, issue 106](https://github.com/danielbentes/digital-twin/issues/106) |
| Preparation | [PR 107](https://github.com/danielbentes/digital-twin/pull/107), reviewed and merged without implementing the target behavior |
| Base commit | `7788170fe4d261865cc77a6aa198308217cef752` |
| Flow source | `50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e` |
| Installed archive SHA-256 | `9bc1802cc69262da3048071e878cfe9fe1f33c8737e5456d3742c093f09f4a67` |
| Hosted attempt | [Actions run 33967000922](https://github.com/danielbentes/digital-twin/actions/runs/33967000922) |
| Flow parent run | `issue-d92a9c82-5579-4a6d-95e4-d48798fd7bd0` |
| Plan digest | `e1c5d61d5476f0d0bbea838781ba2b018a4dc26ad63a0ff568afb1e4e87a6ee0` |
| Provider and model | OpenRouter, `z-ai/glm-5.3-flash` |
| Full-attempt ceiling | One parent lifecycle run |
| Implementation budget | 1,000,000 aggregate model tokens, $2 reported cost, 30 minutes active execution |
| Review budget | 500,000 aggregate model tokens, $1 reported cost, 20 minutes active execution |
| Parent terminal event | Sequence 6, `run_failed`, `implementation_resource_exhausted` |
| Failure time | September 5, 2026, at 12:59:21 UTC |

The manifest version was `0.1.0-alpha.4`, but this archive contained the named newer source commit.
It was not the older published alpha.4 package. The runner built and installed the archive before
receiving model or GitHub credentials.

The preparation passed 116 existing Python tests, 16 pilot-control tests, and hosted CI. Independent
review corrected four preparation defects: inaccessible preapproval evidence, late encryption-key
validation, invocation-record overwrites, and missing timeout metadata. Those checks qualified the
preparation, not the target implementation.

## First-attempt denominator

The first attempt had one parent run, one nested implementation workflow, and one implementation-agent attempt.
The assessment node and independent-review workflow did not run. No candidate passed the frozen
holdout or reached a merge gate.

The settled implementation evidence reported:

| Measure | Value |
| --- | --- |
| Agent execution | 663,185 milliseconds, approximately 11.05 minutes |
| Model turns | 66 |
| Tool calls | 72 |
| Tool-error results | 49 |
| Raw command calls | 52 |
| Rejected command invocations | 48 |
| Recorded command executions | 4 |
| Input tokens | 59,460 |
| Output tokens | 12,746 |
| Cache-read tokens | 1,401,344 |
| Cache-write tokens | 0 |
| Aggregate tokens | 1,473,550 |
| Reported cost | $0.028667 |
| Compaction events | 0 |

The aggregate is `59,460 + 12,746 + 1,401,344 = 1,473,550` tokens. Cache reads account for about
95.10% of that total. The settled usage exceeded the 1,000,000-token budget by 47.355%. This was
not a dollar-budget failure or evidence that the provider charged for uncached input at that volume.

The 49 tool-error results comprise 48 command-authority refusals and one read of a not-yet-created
test file. The four command executions were three lint invocations and one type check. The first
lint invocation failed, then later lint and type checks passed. The model did not successfully
invoke the approved full test command. These checks did not replace controller-owned verification.

## What failed

### Exact command authority was enforced but insufficiently discoverable

The admitted command digest includes the executable, ordered argument vector, and exact timeout.
The pilot prompt named commands but omitted their exact timeouts. The model could not inspect
the private plan through workspace tools.

For example, the plan allowed `python3` with `args: [-m, pytest]` and `timeoutMs: 300000`.
The model requested that argument vector with `600000`, an omitted timeout, or `120000`.
It also tried different executable names, arguments, and unrelated diagnostic commands.

The tool correctly refused all 48 mismatches. Its generic error did not identify an admitted
replacement. The implementation context contained the frozen issue, not a model-visible catalog
of complete command invocations. This combination allowed repeated guessing without useful progress.

The owning source is
[command digest calculation](https://github.com/synaptiai/flow-harness/blob/50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e/src/domain/agent-command.ts),
[command-tool admission](https://github.com/synaptiai/flow-harness/blob/50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e/src/infrastructure/pi/workspace-agent-tools.ts),
and [implementation context construction](https://github.com/synaptiai/flow-harness/blob/50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e/src/infrastructure/issue-lifecycle/production-issue-runner.ts).

This finding does not justify accepting approximate command matches or changing timeouts silently.
It supports making the already-authorized contract discoverable without exposing private holdouts
or granting more authority.

### Settlement accounting did not interrupt the wasteful sequence

The durable sequence records `node_succeeded` followed by `run_budget_exhausted`.
The scheduler then refused further workflow progress. The run did not complete its acceptance path.

This observation proves enforcement at the observed workflow settlement boundary. It does not
prove a strict per-request token ceiling. Investigate request-level accounting, unknown usage,
in-flight effects, and safe stopping before changing that contract. Do not describe an aggregate
workflow budget as a prepaid spending reservation.

### Package qualification remains incomplete

The installed Linux command and sandbox executed real model and command work. However, the run
did not exercise candidate holdout acceptance, independent review, hosted candidate CI, approval,
merge, or post-merge proof. Those missing stages remain release blockers.

The encrypted artifacts preserve private run and worktree evidence. They do not retain the package
tarball itself. Preserve that exact archive in the next qualification design if it must also be
installed on a second host. A digest alone does not recover missing artifact bytes.

## Compare corrections before another attempt

| Approach | Benefit | Tradeoff |
| --- | --- | --- |
| A: Repair the pilot prompt | Include every exact command and timeout immediately. | Low implementation effort, but maintainers still duplicate the plan and can introduce drift. It does not solve general onboarding. |
| B: Project the frozen command catalog | Give the model complete, host-derived admitted invocations and actionable mismatch feedback. | Requires bound projection, replay, disclosure, and regression tests. It addresses the product gap without weakening authority. |
| C: Remove agent command execution | Let the agent edit while trusted verifier nodes run all checks. | Avoids command guessing, but removes interactive repair feedback unless a separate bounded correction path exists. |

At the time of this failure analysis, Approach B was the recommended design direction, not an
implemented correction. The user subsequently approved command discovery, actionable rejection
feedback, and bounded ineffective-request stopping. That correction was implemented and locally
verified before the replacement attempt. This first failed attempt
does not prove the correction. Test valid command discovery, exact timeout handling, rejection
feedback, private-holdout exclusion, replay identity, and refusal to expand authority.

Do not raise the token limit as the only correction. Preserve this failed attempt in the denominator
and freeze any replacement contract before another model run. Track the remaining work in the
[usable-checkpoint plan](../usable-checkpoint-plan.md).

## Replacement attempt

The user authorized one replacement with unchanged model, budget ceilings, issue criteria, allowed
candidate paths, and private holdout. [Preparation PR 108](https://github.com/danielbentes/digital-twin/pull/108)
added package retention and two-host verification before model use. It did not implement status.
The operator dispatched once. No rerun or further attempt followed the failure.

The exact identities are:

| Item | Value |
| --- | --- |
| Target base | `7414509caa0c31180852c614c54f73670143a49b` |
| Flow source | `e967c29082a6647a1554fdc96312a93c6f94dd6d` |
| Actions run | [34021026823](https://github.com/danielbentes/digital-twin/actions/runs/34021026823) |
| Parent run | `issue-f667012e-0eea-473d-8b89-773b7fe575e1` |
| Archive SHA-256 | `0a3090f8a0b495309672e67d66dd8303722226bb4e2f9a5a62d0338f794441b1` |
| Archive size | 2,790,421 bytes |
| Parent failure | Sequence 6, `implementation_workflow_failed`, September 6, 2026, at 08:20:51 UTC |
| Failed nested node | `assess`, with `verifier_rejected` |

The operator retained the archive and canonical evidence locally. The canonical verifier confirmed
the source revision, archive SHA-512, and file manifest. The same archive passed installed-package
verification on [Ubuntu 24.04 x64](https://github.com/danielbentes/digital-twin/actions/runs/34021026823/job/101453633475)
and [macOS 15 Intel](https://github.com/danielbentes/digital-twin/actions/runs/34021026823/job/101453633535).
The pilot then checked its actual installation before credential admission. Its authenticated
`package.sha256` matches the retained archive. These observations satisfy UC-08a for this artifact,
not UC-01 or publication qualification for another package identity.

### Outcome and command behavior

There was one parent run, one implementation workflow, one implementation-agent attempt, and one
assessment attempt. The implementation agent completed. The assessment rejected its handoff.
No recovery attempt, compaction, controller-owned holdout, independent review, candidate PR, approval,
or merge followed. Across both hosted attempts, neither parent reached accepted implementation.

The replacement's records show:

| Measure | Implementation | Assessment |
| --- | --- | --- |
| Model turns | 13 | 1 |
| Tool calls | 16 | 0 |
| Tool-error results | 2 | 0 |
| Input tokens | 81,260 | 2,358 |
| Output tokens | 5,828 | 204 |
| Cache-read tokens | 154,240 | 0 |
| Cache-write tokens | 0 | 0 |
| Aggregate tokens | 241,328 | 2,562 |
| Settled reported cost | $0.009866 | $0.000228 |

Token totals independently agree between model-message records and node settlement. Total usage
was 243,890 tokens, with settled reported cost of $0.010094. Summing individually rounded message
costs gives $0.010100 instead. The six-microdollar difference is consistent with rounding each
message upward versus rounding the session total. Retain both observations. Neither is a provider invoice.

The agent requested six commands. Five matched the frozen catalog and executed: full pytest twice,
Ruff, mypy, and compilation. One focused-pytest request was refused because its additional arguments
were not authorized. The next pytest request used the exact allowed invocation. The other tool
error was a read of the not-yet-created status test file. Approved pytest exits with code 1 were
recorded as command failures, not authority refusals.

Observed command refusals changed from 48 of 52 requests to 1 of 6. Implementation token usage
changed from 1,473,550 to 241,328, an 83.62% reduction. These are two nonrandomized observations with
different execution paths, not a general model-quality or causal performance estimate. This run
exercised discovery and recovery after feedback. It did not reach the three-refusal stopping limit.

### Failure and assessment boundary

The first pytest invocation exposed failures in the new test helper. The agent repaired that helper
within its allowed paths. The second invocation reported 129 passed, one skipped, and one failed.
Ruff, mypy, and compilation passed. The remaining failure was the existing
`test_exactly_one_detector_reference_and_command_free_marker` assertion in `tests/test_hook_installer.py`.
The retained existing test is byte-identical to the base.

That test searches the entire serialized marker for the substring `command`. The hosted traceback
shows the substring in legitimate path-valued provenance under the sandbox's temporary directory.
It does not show an added executable command field. An independent unchanged-base reproduction
varied only pytest's temporary-directory component: `plain` passed, `command` failed at line 290,
and `neutral` passed.

The control used local Python 3.14.6 and pytest 9.1.1. The hosted failure used Python 3.11.16 and
pytest 9.0.2. This confirms a pre-existing test correctness and portability defect, not complete
candidate correctness. The agent could not edit the protected existing
test or substitute a different verification command. Its report acknowledged the failure, and the
assessment rejected the handoff. A known failed required check is a valid reason to stop.

The assessment also cited absent holdout, independent-review, and CI evidence. Those stages occur
after implementation assessment. Requiring their receipts at this point would create a circular
prerequisite. The assessment receives frozen issue context and the implementation's text summary,
but not its raw command receipts or candidate diff. This is a separate evidence-contract risk,
not proof that absent downstream receipts alone caused the rejection.

Before approving another frozen contract, compare these corrections:

| Approach | Benefit | Limitation |
| --- | --- | --- |
| A: Correct the path-sensitive test and clarify the assessment's stage | Addresses the observed failure and states that downstream checks are intentionally pending. | The assessment still relies on the implementation summary for candidate-result evidence. |
| B: Add an approved command-verifier node as well | Supplies host-produced pytest evidence to the handoff assessment without approximate command matching. | Adds a command execution and workflow node; requires explicit contract review. |
| C: Add a bounded read-only inspection node | Supplies a separate criterion-mapped inspection of implementation, tests, and documentation. | Adds model work and partly duplicates the later independent exact-head review. |

Path sensitivity is independently verified on unchanged code. Next, correct the assertion without weakening
its command-free-metadata requirement, and qualify the untouched baseline under the actual sandbox.
Prefer stage-specific assessment with host-produced command evidence for a separately reviewed
future contract. Do not rename the sandbox's temporary directory merely to hide a fragile test.
Do not ignore the failure, widen model write authority, or raise budgets as the correction.

### Custody and operator interventions

The operator authenticated both encrypted snapshots before inspecting their contents. Both contain
the same terminal forensic archive, with plaintext SHA-256
`cb2c60aa9cb735ab58eb0aa43a2ad78b273efa219b9545a6a47e96ea01f55cbc`.
No archived host state was resumed. All three dedicated Actions secrets were removed after
retention. The original credentials and local evidence key remain intact. GitHub independently
confirmed issue 106 open, no open candidate PR, and Flow PR 201 still draft and unmerged.

One preparation intervention preceded dispatch: merging PR 108 unexpectedly closed issue 106.
Its description contained a negated closing-keyword reference. GitHub's
[closing-keyword rules](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
and the merge-time closure support that diagnosis. The operator reopened the issue without changing
its body before the harness froze it. Record this as operator work, not harness behavior.

## Approved follow-up preparation

The user approved baseline-test correction and stage-specific assessment with host-produced test
evidence. This approval does not authorize another pilot, candidate merge, or budget increase.

The prospective [target preparation](https://github.com/danielbentes/digital-twin/pull/109) now contains:

- Exact structural marker assertions instead of substring scans. Four directory-name cases pass,
  including `command` and detector filenames. Five negative controls reject extra command metadata,
  duplicate hooks, and commands substituted for provenance.
- A `verify-tests` command verifier between implementation and assessment. It uses the unchanged
  plan's exact pytest command and timeout. Assessment receives its host-produced verdict and reason.
  A rejected command blocks assessment. Later lifecycle receipts are explicitly pending.
- A model-free baseline workflow before credential admission in the hosted pilot. Its detailed
  output enters encrypted evidence. Its public success message contains only status and zero model usage.

Production plan and workflow validation pass. Production admission rejects changed verifier
arguments and timeout. The implementation has three normal node starts within the unchanged
four-start ceiling, leaving one spare across its recovery settings.

The corrected target passes 124 local tests, Ruff, mypy, compilation, shell syntax, and 25 pilot
control tests. A real Flow native-sandbox baseline run passes 123 tests with one environment-dependent
skip and zero model usage. That run used macOS, Python 3.14.6, pytest 9.1.1, and SRT 0.0.70.
It is not hosted Linux verification of the new baseline gate. No model has assessed the revised rubric.

The implementation workflow source digest is now
`8894491c8a9d0b7f7c8dd87799826484e60c210766de4db5433fade1a29cd53d`.
The plan, private holdout, review workflow, model, budgets, and candidate write paths remain unchanged.
The installer is unchanged, and the negative holdout still fails because status is absent.
Historical attempt evidence has not been reinterpreted or resumed. Complete preparation review and
merge before requesting a separately authorized, newly frozen hosted attempt.
