# Usable-checkpoint execution plan

This plan helps maintainers deliver the approved evidence-first checkpoint and reduce the work
required to use Flow in another repository. The [roadmap](roadmap.md) owns capability gates. The
[research register](next-version-research.md) owns detailed future-capability research.

## Complete qualification first

As of September 6, 2026, the source-built controller completed digital-twin issue 6 through verified
merge. This proves neither the installed package on hosted Linux x64 nor a generally unattended
service. The [field report](field-reports/digital-twin-issue-6-alpha4.md) retains all 52 parent runs
and operator interventions.

The fresh target is [digital-twin issue 106](https://github.com/danielbentes/digital-twin/issues/106):
a read-only JSON command for hook registration status. Preparation must leave that behavior absent.

The [preparation PR](https://github.com/danielbentes/digital-twin/pull/107) merged as
`7788170fe4d261865cc77a6aa198308217cef752`. Its checks passed without implementing the target
behavior. The first [hosted attempt](https://github.com/danielbentes/digital-twin/actions/runs/33967000922)
uses that base and Flow source `50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e`. Dispatch is not
qualification: retain UC-01 as open until the installed lifecycle and independent observations pass.

That attempt failed at the implementation token gate before review or publication. The
[issue 106 field report](field-reports/digital-twin-issue-106-installed.md) records the complete
denominator, command-discovery gap, and correction alternatives. Evidence was authenticated and
the dedicated Actions secrets were removed.

The single authorized [replacement attempt](https://github.com/danielbentes/digital-twin/actions/runs/34021026823)
used preparation merge `7414509caa0c31180852c614c54f73670143a49b` and Flow source
`e967c29082a6647a1554fdc96312a93c6f94dd6d`. Its retained archive passed installed verification on
Ubuntu 24.04 x64 and macOS 15 Intel before the lifecycle started. UC-08a is satisfied for those
exact bytes. The implementation assessment rejected a reported failing existing test, so UC-01
remains open. No candidate PR or merge followed.

Terminal evidence was authenticated and dedicated secrets were removed. Both failed attempts remain
in the denominator.

Independent unchanged-base reproduction confirms that the existing marker test rejects legitimate
path metadata when a temporary-directory name contains `command`. Approved preparation corrects
that assertion structurally, adds a frozen pytest verifier before handoff assessment, and adds a
model-free baseline gate before credentials. Local native-sandbox baseline verification passes.
Preparation PR 109 merged after review and separate approval. The
[replacement field report](field-reports/digital-twin-issue-106-installed.md#replacement-attempt)
records the correction and its limits.

The user separately authorized one [third attempt](https://github.com/danielbentes/digital-twin/actions/runs/34036328861)
from base `5ca4acc70ed780857227f6d93a36dc7be8e36fc0`, with unchanged model and budgets. It passed
the installed baseline, implementation assessment, deterministic checks, and private holdout.
Independent review found a real P3 documentation defect. The review-validation node then confused
a valid blocked report with an invalid review, and the parent stopped as `review_workflow_failed`.
Evidence is authenticated and retained. Temporary secrets are removed.

All three attempts remain
in the denominator. UC-01 and UC-02 remain open. No further attempt is authorized by this result.

Approach B is now approved: make complete frozen verification commands discoverable, return
actionable rejection feedback, and stop repeated ineffective requests within an explicit bound.
UC-08 is implemented and locally verified in current source. It does not increase the pilot budget,
authorize approximate command matching, or establish successful hosted qualification. Published
alpha.4 does not include this correction.

Execute these steps in order:

1. Create one useful, previously unhandled digital-twin issue. Freeze its acceptance criteria,
   negative-control holdout, candidate paths, verification commands, provider, and budgets before
   the first model invocation. Do not implement its outcome during pilot preparation.
2. Review the hosted pilot configuration before adding credentials. Build from a pinned Flow
   commit and pack once. Record the archive SHA-256 digest. Install that archive into a separate
   consumer directory. Invoke only the installed command for the lifecycle.
3. Use one hosted Ubuntu 24.04 x64 runner for the entire lifecycle. Include implementation,
   verification, independent review, check observation, explicit approval, merge, and post-merge verification. Do not restore private
   run state onto a different host. This pilot does not establish cross-host recovery.
4. Reuse the existing OpenRouter credential. Keep model and GitHub credentials in dedicated Actions
   secrets, outside the candidate workspace and model context. Do not create another provider key.
   Remove run-specific secrets after the run no longer needs them.
5. Retain the exact package identity and content-free phase evidence. Record all model attempts,
   failures, costs when available, and human interventions. Stop on uncertain effects, budget
   exhaustion, or a changed frozen contract. Do not silently restart with larger budgets.
6. Inspect the reviewed candidate and gate before issuing a separate exact-head merge command.
   Automation must not manufacture approval from passing checks. An approval transport used only
   by this pilot must remain distinct from a supported remote-control interface.
7. Require the installed command to record `merged`. Independently confirm the approved head,
   checks, merge, issue state, and branch outcome on GitHub. Close Slice 13.3 only after both checks.
8. Complete exact-head review and all required Flow checks. Publish a new immutable release only
   after separate authorization for its exact version. Verify the published install instructions.

The first hosted attempt has a ceiling of one full lifecycle run. Workflow-level recovery remains
bounded by its frozen contract. A failed attempt triggers analysis and a recorded disposition
before any replacement run. This is an initial pilot limit, not a claim about an optimal agent
budget or a standard industry limit.

## Reuse the existing setup boundary

Current source already provides `flow init`, a guided coding quick start, and `flow issue doctor`.
The configuration initializer refuses implicit replacement and handles uncertain file publication.
The issue diagnostic validates the authored workflows and checks the exact repository, provider,
sandbox, and issue contract without starting model work.

UC-03 and UC-04 must reuse those admission and storage boundaries. The missing product path is
guided preparation of a real repository's issue contract, not another independent setup system.
Review the
[configuration initializer](https://github.com/synaptiai/flow-harness/blob/50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e/src/infrastructure/fs/flow-config-store.ts)
and [issue diagnostic](https://github.com/synaptiai/flow-harness/blob/50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e/src/cli/production-github-issue-service.ts)
when designing that path.

The issue 106 preparation required 203 lines across its plan, implementation workflow, review
workflow, and holdout. Its hosted orchestration, tests, and operating guide add separate work.
These counts describe this preparation only. They do not measure general usability or user time.
Treat the pilot-specific approval transport and credential exception as test infrastructure, not
as completed product onboarding.

## Track the product priorities

The maintainer executing Approach A owns every open row until a named owner accepts it. Priority
order does not authorize an unreviewed design or broaden model authority.

| ID | Disposition and owner | Dependency and next action | Evidence required to close | Reconsideration trigger |
| --- | --- | --- | --- | --- |
| UC-01 | Release blocker; Approach A maintainer | Complete the installed hosted pilot described in this plan. | Exact archive identity and complete issue-to-merge evidence, with all attempts retained. | Every pilot settlement. |
| UC-02 | Release blocker; release maintainer | After UC-01, complete Slice 13.4 and obtain exact publication authorization. | Qualified package on both named hosts, no P1–P3 findings, successful required CI, and verified public installation. | UC-01 passes or package identity changes. |
| UC-03 | Next delivery-design priority; Approach A maintainer | Design repository onboarding and reusable configuration after qualification. | A new user configures a separate clean repository from the guide without maintainer-authored hidden files; measure steps, time, and interventions. Missing checks or credentials fail safely. | UC-01 settles; reassess before selecting another infrastructure feature. |
| UC-04 | Next delivery-design priority; Approach A maintainer | Design guided issue-to-plan preparation with UC-03. | Proposed criteria, commands, paths, budgets, and approval rules are explicit and reviewable. A human freezes the contract before execution; generated plans pass production admission. | UC-03 design review and every plan-authoring failure. |
| UC-05 | Bounded blocked-review repair locally verified, qualification open; Approach A maintainer | Qualify the approved same-host repair contract using a separately authorized experiment and frozen NV-01 comparison. Keep broader NV-03 recovery research separate. Resolve report validity separately from candidate acceptance. | Bounded verifier-directed repairs reduce human interventions without changing holdouts, acceptance rules, authority, or aggregate budgets. Include oscillation, disputed findings, and false-acceptance tests. | Before another pilot; third-attempt settlement promoted this item. |
| UC-06 | Measurement requirement; evaluation maintainer | Freeze the NV-01 plugin-versus-harness baseline before broader readiness claims. | Compare equivalent model routes and fresh tasks; report verified success, total cost, time, interventions, false acceptance, and missingness. | Before claiming plugin parity, superiority, or readiness beyond the qualified scope. |
| UC-07 | Parity research in progress; Approach A maintainer | Maintain the [23-command comparison](flow-plugin-parity.md). Add runnable demonstrations for supported practices, and compare plugin defaults separately from optional teams. | Each feature has an evidence-backed classification and a runnable demonstration where supported. An inventory alone does not close this row. | UC-03 design review; prioritize gaps that blocked users in UC-06. |
| UC-08 | Implemented and locally verified, with bounded live discovery evidence; Approach A maintainer | Frozen command discovery, actionable mismatch feedback, and bounded ineffective-request stopping are implemented. Exact command authority and aggregate budgets remain unchanged. | The full suite passes 6,361 tests; native runtime checks pass 44 tests with platform skips. Independent source review found no remaining P1–P3 defects in this correction. The replacement recorded one command refusal among six requests and then used the exact allowed command. It did not reach the three-refusal stopping threshold or complete UC-01. | Reassess refusal rates, false stops, and broader behavior in a separately approved attempt. |
| UC-08a | Satisfied for the replacement artifact; release maintainer | Retained archive SHA-256 `0a3090f8a0b495309672e67d66dd8303722226bb4e2f9a5a62d0338f794441b1`, source `e967c29`, and canonical evidence are retained locally. | Both named hosted checks passed on the same retained bytes; the pilot's authenticated archive digest matches. See the [field report](field-reports/digital-twin-issue-106-installed.md#replacement-attempt). | Reopen when package identity changes; this does not close UC-01 or UC-02. |

UC-03 through UC-07 are not evidence that Flow has left alpha. Qualification of one task is a
bounded usability checkpoint. A broader readiness decision needs a support contract and repeatable
results from users who did not build the harness.

The third attempt reconfirmed UC-08a with byte-identical archive content and both hosted checks.
It exercised UC-08 discovery with one refused command among four requests. It did not reach the
stopping threshold. Its progress through implementation and deterministic verification does not
close the installed merge gate.

UC-03 also owns a unified public path for diagnosing issue-owned nested failures. Today,
`flow issue inspect` exposes parent lifecycle state, not nested command-refusal counts. The
[private-host diagnosis procedure](operations/github-issue-lifecycle.md#diagnose-command-refusals)
documents the current limitation. Close this part of onboarding only when an operator can identify
the failed nested boundary and its content-free counters without opening private session records.

Closing UC-08 or UC-08a does not close UC-01 or UC-02. Stopping ineffective requests also does not
complete UC-05. Selecting a repair workflow from verification evidence adds a separate execution
decision and requires its own research and approval.

## Implement bounded review repair

Refined Approach B is approved for implementation. The
[bounded review repair design](bounded-review-repair-design.md) owns the approved contracts
and BR-01 through BR-06 implementation and verification phases.
Option B's numeric limits and one new pilot are approved. The reviewed preparation merged after
approval. Exact candidate merge and publication remain separately approval-bound.

UC-05 remains open. The report-classification correction is separate from repair.

The [BR-06 experiment](bounded-review-repair-experiment.md) records the approved resource
decision and exact preparation gates. It uses smaller fixed children within the existing
aggregate token, cost, active-time, and artifact allowances, with explicit aggregate node-start
limits. Preparation is complete. Installed qualification remains open.

Execution checklist for the approved attempt:

- [x] Author the exact option B policy and repair workflow without changing the target behavior.
- [x] Verify original scope, resource units, repair dispositions, and complete evidence collection.
- [x] Complete independent preparation review and local target checks with no P1–P3 findings.
- [x] Pass target hosted CI and merge the preparation after exact-head approval.
- [x] Build one retained package from qualified source `544aebc` and verify the same bytes on both hosts.
- [x] Validate the installed plan and baseline before credentials, then start the approved model lifecycle.
- [x] Retain authenticated evidence and withhold exact-head approval for the candidate's confirmed P2 defect.
- [x] Reconcile the result against BR-06 and UC-01 without removing earlier failures from the denominator.

Preparation passed 35 control tests and 124 Python tests, plus linting, type checking, compilation,
shell checks, and production CLI plan validation. An independent reviewer also passed 176 focused
Flow tests and checked the actual admitted workflow budgets and context bindings. Collector tests
run the real archive and encryption path. They verify retained repair and review ledgers, private
context and workflow records, candidate files, and isolation from unrelated host projects. These
results establish local preparation integrity, not a completed hosted lifecycle.

Hosted preparation CI passed all 35 control tests and 123 Python tests. One existing
maintainer-private corpus test was skipped on the hosted runner. Preparation PR 110 merged as
`109fac8e78db17a178cc59e5d6ef91bb9b95d603`. The merged tree matches the reviewed `331eb9f` tree.

The single approved [option B attempt](https://github.com/danielbentes/digital-twin/actions/runs/34065692695)
started from that base. It reached candidate PR 111 and the exact merge approval gate.
Two independent checks found a P2 permission-handling defect that the model review and frozen tests
missed. The operator withheld approval and cancelled the wait. Both evidence snapshots
authenticated, and all three temporary Actions secrets were removed.

The
[option B field report](field-reports/digital-twin-issue-106-installed.md#option-b-attempt)
records candidate identity, reproduction, usage, and custody evidence. None of the four attempts
completed issue-to-merge qualification. No repair cycle ran, so BR-06 remains unqualified.

Next preparation work, without changing or rerunning the retained candidate:

- [ ] Add an inaccessible-parent regression that independently confirms permission denial.
- [ ] Remove the public permission test's reliance on candidate success to infer privileged access.
- [ ] Extend review guidance for absence versus file-read and directory-traversal failures.
- [ ] Verify and review newly frozen preparation before seeking authority for another live attempt.

The new archive is 2,870,110 bytes with SHA-256
`0d277acff5b3ca4d9cf1dfdd990a53f98441cfbced09109ccbe5ca776bc941d4`.
Both hosted package checks passed against that digest, and the retained local archive passes
Flow's package verifier for source `544aebc`. The installed plan, baseline, and evidence-custody
steps passed before the lifecycle step started. This adds exact-artifact evidence to UC-08a,
not issue-to-merge evidence for UC-01.

Current source contains strict optional policy admission, frozen resource pools, durable
dispatch and settlement records, candidate-tree tracking, and the repair controller path.
Focused compiler, reducer, persisted-ledger, and real-Git tests have passed. Usage and operations
documentation are updated. Independent source and test audits identified defects that were
corrected before final qualification.

Local verification passed 6,683 coverage tests, 44 runtime
tests, and two browser tests, plus build, type checking, formatting, lint, and documentation gates.
The local runtime suite skipped 42 platform-specific tests. Installed-package live qualification
remains open. The internal decision log retains failed attempts and their corrections.
These results do not qualify a published package or complete UC-01.

Hosted [quality verification](https://github.com/synaptiai/flow-harness/actions/runs/34052845375/job/101539421891)
passed on September 6, 2026, for the file tree of source `a4e5aee`. It passed all 6,687 coverage
tests, two browser tests, and 82 runtime tests. Four Lean proof runtime tests were skipped in that
job. Build, static checks, dependency audits, compiled CLI
smoke verification, and clean package-install checks also passed.

The separate [proof runtime job](https://github.com/synaptiai/flow-harness/actions/runs/34052845375/job/101539421770)
also passed. It prepared the reproducible proof image, verified its identity, and passed all four
Lean proof runtime tests without skips. The tests cover accepted proof checks, incomplete-source
rejection, restricted axiom authority, recovery, cancellation, and cleanup. All three CI jobs
passed for the `a4e5aee` source tree. Subsequent documentation commits need their own checks.

The temporary package check
does not replace retained same-bytes two-host qualification or the live installed issue lifecycle.
BR-06 and UC-01 remain open.

Retain one recovery limitation in future planning: cancellation after a reservation but before a
child ledger exists stays requested. Flow retains the reservation instead of inventing zero usage.
An authenticated never-started-dispatch abandonment protocol requires a separate contract.

The third attempt exposed a concrete UC-05 gap. A verified candidate had a small, real review
finding, and the controller had no approved repair path. This promotes design
work, not permission to retry, waive P3 findings, or change historical terminal state.
It does not prove that automatic repair is necessary to close UC-01. A future independently
accepted attempt could meet the existing qualification gate without repair.

First correct report classification in a separately reviewed preparation. A valid `blocked` review
must reach the host parser and remain a blocked candidate. Review-workflow acceptance must not mean
candidate acceptance. Preserve identity, complete criterion mapping, evidence checks, and the
zero-findings publication gate.

The architecture decision considered these repair scopes:

| Approach | User experience | Main tradeoff |
| --- | --- | --- |
| A: Human-approved same-host repair checkpoint | Pause future opted-in runs with the candidate retained; require exact candidate/report-bound approval for each repair. | Explicit control, but recurring operator work remains. Requires a nonterminal checkpoint and aggregate repair accounting. |
| B: Frozen controller-selected repair loop | Approve bounded repair eligibility and workflows before execution; select repairs from durable review evidence and rerun all gates on each new candidate. | Best match for the plugin's address-and-review loop. Requires a closed failure taxonomy, lifecycle-wide budgets, progress and oscillation checks, and disputed-finding handling. |
| C: Linked candidate handoff | Admit an immutable candidate artifact into a separately authorized repair run, preserving provenance and the original failed run. | Supports ephemeral-host work but adds candidate export/import, secret screening, ancestry, replay, and cross-run accounting contracts. |

The selected B design covers same-host execution. A remains a possible human-confirmed mode, not
part of the first implementation. Keep C as a separate portability decision. An encrypted forensic archive is not a supported candidate
handoff or live host restoration mechanism.

The approved implementation contract defines eligible review classes, preauthorized same-host
selection, aggregate role pools, an explicit cycle limit, and a disputed-finding stop. Exact
experimental values now have approval and explicit pilot rationale, not an
invented industry-standard claim. Per-run workflow budgets cannot silently reset when a new
repair child starts.

The design must bind each repair to its candidate, review report, selected workflow, ancestry, and
cumulative usage. A changed candidate invalidates previous verification, review, and merge approval.
Unsupported failures, uncertain effects, unchanged candidate trees, repeated candidate trees, and
exhausted allowances stop execution. Fewer findings alone does not prove progress or correctness.

Semantic detection of repeated failure patterns remains deferred.
Final merge remains separately approval-bound. Omitted repair policy preserves today's safe stop.

UC-03 and UC-04 remain the next onboarding priorities after qualification. Promoting this concrete
repair gap for design does not authorize unrelated infrastructure work or retire their evidence gates.

## Keep deferrals bounded

Use the stable NV identifiers for existing research. Do not create a second detailed inventory.
UC-03 and UC-04 cover onboarding and plan preparation, which were not explicit delivery priorities
in that inventory. UC-05 and UC-06 promote NV-03 and NV-01 for decision work without declaring their
research complete.

At every qualification settlement and version-scope review:

1. Review every open UC row and every NV item implicated by the latest failure or intervention.
2. Keep, promote, split, or retire each reviewed item with a reason and evidence link.
3. Assign an owner and the next evidence gate before moving work out of the active slice.
4. Reconsider optional infrastructure only after comparing its user benefit with UC-03 through
   UC-07. Do not let an easy infrastructure task displace a demonstrated usability blocker.
5. Preserve unresolved findings as open. A workaround, pilot script, or documentation warning is
   not an implemented product capability.

Remote multi-user operation, executable extensions, broader package automation, and VM-grade
isolation remain in the research register. They are not prerequisites for the current single-user
checkpoint unless qualification demonstrates a concrete dependency.
