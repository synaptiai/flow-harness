# Installed-package digital-twin issue 106 pilot

## Result

The first hosted attempt failed before candidate acceptance, independent review, publication, or
merge. It does not close the installed-package lifecycle qualification gate.

The installed command passed plan validation and host admission on Ubuntu 24.04 x64. It started
one implementation workflow and preserved its terminal failure. The implementation agent returned
success, but the workflow then exhausted its aggregate token budget. An agent success report did
not become lifecycle acceptance.

The operator authenticated the final encrypted evidence and removed all three dedicated Actions
secrets. The existing provider credential and the owner-only local decryption key remain intact.
No replacement attempt was started. GitHub independently showed no open candidate PR and issue 106
still open after the failure.

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

## Complete attempt denominator

There was one parent run, one nested implementation workflow, and one implementation-agent attempt.
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
feedback, and bounded ineffective-request stopping. That work is in progress. This failed attempt
does not prove the correction. Test valid command discovery, exact timeout handling, rejection
feedback, private-holdout exclusion, replay identity, and refusal to expand authority.

Do not raise the token limit as the only correction. Preserve this failed attempt in the denominator
and freeze any replacement contract before another model run. Track the remaining work in the
[usable-checkpoint plan](../usable-checkpoint-plan.md).
