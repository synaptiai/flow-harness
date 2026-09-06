# Bounded review repair implementation

## Approved scope

The user approved refined Approach B after reviewing the design and its alternatives. Implement
same-host preauthorized repair of valid blocked independent reviews, including supported unsatisfied
criteria. Preserve frozen scope, fixed child envelopes, separate aggregate role pools, explicit
cycle limits, dispute stops, exact tree-cycle stops, and separately approved final merge.

No live model request, new pilot dispatch, credential provisioning, or merge is authorized by this
implementation approval. Do not reopen a terminal historical run. Numeric experimental allowances
are frozen separately before an authorized trial. There is no universal repair-cycle default.

## Execution checklist

1. [locally verified] Define strict policy and immutable five-dimensional resource accounting. Write
   failing tests first. Prove overflow, unavailable usage, overshoot, reservations, replay, and
   identity rules with direct production-domain tests.
2. [locally verified] Integrate frozen plan and manifest, workflow admission, and durable
   selection/dispatch/settlement events. Prove omitted-policy digest compatibility and reject
   incomplete activation. Do not expose a policy that the runner can silently ignore.
3. [locally verified] Return authenticated terminal child receipts before outcome
   classification. Charge failed and cancelled children and reconcile the same dispatch on resume.
4. [locally verified] Integrate bounded repair projection and result, host eligibility,
   repair-parent ancestry, scope checks, repeated-tree stopping, and fresh full verification/review.
5. [local gates passed; hosted qualification pending] Add real Git/ledger/process/sandbox adversarial checks, independent code
   and test review, full quality gates, and capability-reference regeneration where required.
6. [documentation updated; commit and push authorized] Update the supported public contract, architecture, usage/operations,
   contributor guidance, roadmap evidence, and experiment manifest proposal. Commit and push
   reviewed increments. Keep live qualification and merge gates open.

## Ownership

The main agent owns integration, plan/manifest/events, delivery tracking, and final review.
The accounting agent owns only its new accounting domain module and direct tests. The repair-context
agent initially audits eligibility, projection, and Git contracts without edits. Parallel work
must use non-overlapping file ownership. No agent starts a paid model run or external mutation.

## Verification contract

Use RED-GREEN-REFACTOR for new behavior. Run focused tests, lint, and type checking after significant
changes. Integrate only after review. Real-process tests complement direct domain tests; neither
can establish live model compliance. Keep all remaining BR phases visible until their evidence
exists. Existing legacy limits are implementation constraints to inspect, not universal standards.

## Implementation evidence and open checks

- Strict plan/manifest/admission tests pass with pinned omitted-policy legacy fingerprints.
  Accounting has 53 direct tests and invariant-removal checks. Persisted repair input policy
  passed 147 tests with the compiler and run reducer.
- The terminal settlement reader passed 31 actual persisted-ledger tests, including failed and
  cancelled usage, missing evidence, overshoot, and contradictory identities. Seventeen
  assertions failed under deliberate guard removal; guards are restored.
- Candidate findings use real committed Git blobs, not mutable worktree text. The focused Git
  suite passed 39 tests after exact-head and ancestry checks were added. Nine independent guard
  removals were detected. Existing Git adapter regressions passed 32 tests.
- Independent review found an initialization mismatch: the store accepted absent or altered
  repair authority in the snapshot. Six genuine failing tests reproduced it. The fix and full
  aggregate store suite passed 42 tests.
- Save a content-free implementation candidate receipt before commit. This preserves the raw
  Git tree, its delivery digest, and exact child evidence through an interrupted commit. Clear
  that receipt when the next implementation starts; reject repeated trees before commit.
- The controller's 256-step bound is a no-progress watchdog per approved repair cycle, not a
  second policy limit. Legacy iteration limits remain legacy-only. All persisted counters must
  remain safe integers; ordinary storage quotas still apply.
- Full type checking passed after fixing three narrowing errors, preserving additive Git-port
  compatibility, and completing the runner test imports. Rerun after subsequent changes.
- Public usage, operations, architecture, specification, and contributor documentation are updated.
  Documentation style, links, and prose checks pass. Capability-reference generation and checking
  pass without a generated-artifact change. Build, type checking, formatting, and lint pass.
  Lint retains one informational diagnostic in the unchanged external-harness adapter.
- `npm run pack:check` passed a fresh temporary installation and real CLI execution from the
  current working-tree package. This development archive is not a published release or a
  committed-source qualification artifact. Existing retained release evidence was not modified.
- Independent source and test audits found and corrected a stale integration prompt fixture,
  a masked budget assertion, and incomplete public state/event documentation. Five isolated
  dimension-guard removals each fail only their matching budget case. Production bytes are restored.
- The first full coverage run was stopped after the fixture correction and unavailable local
  ownership-socket permissions. The restricted native runtime run failed 18 tests because local
  sockets or temporary home fixtures were denied. The elevated native run passed 43 tests,
  skipped 42 platform-specific tests, and failed the credentialless Pi test's 30-second deadline.
  The elevated coverage run was stopped after two existing review-evidence capture commands timed
  out at about 20 seconds. Neither coverage attempt establishes a complete suite pass.
- Read-only Pi admission probes took 44.5 and 46.8 seconds before child execution. A diagnostic-only
  120-second whole-test deadline passed every original child assertion in 34.59 seconds, without
  changing the 30-second execution budget. This does not pass the standard test deadline.
  The browser suite had intermittent cleanup timeouts, then passed both unchanged tests in a
  standalone run. Retain the failure and successful rerun together.
- Host inspection found 48 orphaned CPU stress loops from unrelated work, running for about
  24 hours and consuming a combined 371.8% CPU at observation. No unrelated process was stopped.
  Load is a possible timing confounder, not a demonstrated cause of every failure. Obtain operator
  authority before changing those processes, then rerun standard checks without raised deadlines.
- The user authorized stopping only those 48 orphaned stress processes. Revalidation found no
  matching orphaned loops and confirmed that all 48 previously observed process IDs had exited.
  No signal was sent and no unrelated process was changed. Standard coverage and native runtime
  checks restarted without deadline changes. Historical load averages remained elevated.
- The corrected production integration suite passed all 10 cases in 714.06 seconds, including
  both commit-acknowledgement recovery boundaries. The added two-cycle case is type checked and
  formatted. Its first focused execution reached second-repair commit preparation but timed out
  at the original 240-second deadline without reporting an assertion failure. Final-publication
  assertions now also require one push, one draft creation, and publication after the final review.
- The next overlapping standard runs again encountered existing runtime deadlines, including seven
  compiled CLI cases and credentialless Pi admission. Host diagnostics observed about 16 GB of
  swap use on a 16 GB machine. Both task-owned runners and their recorded workers were stopped
  and confirmed exited. No unrelated application was changed. The tightened two-cycle test is
  retried alone with its original deadline and passed in 115.9 seconds. It verified both repair
  transitions, distinct review identities, cumulative usage, three real commits, and exactly one
  final-candidate push and draft PR after the final review. No merge was invoked. This successful
  retry does not erase the earlier timeout or prove its cause. Remaining standard checks now run
  sequentially. Full standard qualification remains open.
- The first complete serial coverage attempt ran 467 files in 1,091.21 seconds: 464 files
  passed, two failed, and one was skipped. Of 6,687 tests, 6,681 passed, two failed, and four
  were skipped. Both failures were stale library-assessment counts; no behavioral or deadline
  failure was reported. The unchanged analyzer reports 378 production modules and 3,445 internal
  exported declarations. Independent file counting, arithmetic, and diff review corroborated
  the correction. The two affected test files now pass all six focused tests. Documentation
  style, links, prose checks, formatting, and lint also pass after that correction. The public
  library API contract is unchanged. A fresh complete coverage run is required; this failed run
  does not establish passing coverage thresholds, and its chained runtime/browser checks did
  not execute.
- The fresh complete serial coverage run passed: 466 files passed and one was skipped;
  6,683 tests passed and four were skipped, with no failures. Duration was 1,250.26 seconds.
  Coverage passed every configured threshold: statements 84.82% (47,463/55,954), branches
  79.67% (34,251/42,988), functions 92.24% (8,995/9,751), and lines 85.41% (46,204/54,093).
  This includes the corrected documentation assertions and the final two-cycle production
  integration test. Standard runtime and browser qualification remain pending separately.
- The next standard runtime run passed 43 tests, skipped 42 platform-specific tests, and failed
  the existing queue-capacity test while parsing an empty active-cancellation response. The
  credentialless Pi test passed at its original deadline. The unchanged queue test then passed
  alone in 12.75 seconds; both browser tests passed in 4.85 seconds.
- A controlled queue reproduction waited for committed `run_failed` and `command_timeout`
  evidence. Cancellation then returned exit 1 with a conflict on stderr and no JSON, exposing
  the exact mechanism hidden by the original parser assertion. This confirms a fixture race,
  not the unrecorded cause of the historical failure. A first diagnostic using an added fixed
  11-second sleep timed out at the unchanged 30-second whole-test deadline; evidence polling
  reproduced the conflict in 17.45 seconds. Both temporary diagnostic waits were removed.
- The capacity fixture now shares an explicit 30-second bound with that test, whose timer starts
  first. Other command fixtures retain their 10-second default; no production budget or whole-test
  deadline increased. Exit-code checks expose stderr before JSON parsing. Failure-path cleanup
  retries queued cancellation before active cancellation with stable command IDs, then attempts
  supervisor shutdown. This is best-effort cleanup, not guaranteed termination after a protocol
  failure or whole-test timeout. Independent review found no P1-P3 issues. Type checking, lint,
  and the corrected focused test passed (13.25 seconds). Full runtime qualification is rerunning.
- The final standard runtime rerun passed all 44 locally applicable tests in 132.75 seconds;
  42 platform-specific tests were skipped. Browser verification passed both tests in 8.52 seconds.
  Formatting, lint, documentation style, links, prose checks, and diff whitespace checks passed.
  The only post-coverage executable change was the runtime-test fixture, which is outside the
  standard coverage corpus; production source is unchanged from the passing full coverage run.
- Final documentation review corrected stale proposed-runtime and pre-change ancestry wording,
  the UC-05 design status, and an overbroad repeated-failure stopping claim. The plugin comparison
  preserves its dated baseline and explicitly records the locally verified bounded-repair update.
  Semantic repeated-failure detection remains deferred. All documentation gates and the six
  focused documentation assertions passed again. The repeated package check passed a fresh
  temporary installation and real CLI execution. It remains a development-package smoke check,
  not published-release or hosted live qualification. Commit grouping/message confirmation is
  requested before delivery to the existing draft PR 201.
- The final independent complete-document recheck reported no remaining actionable P1-P3 findings.
  No commit, push, merge, release, credential change, or live model request occurred in this turn.

## Delivery authorization

The user confirmed one commit named `feat: add bounded independent-review repair` and a push to
the existing draft PR 201. Routine steps within the approved plan do not need repeated confirmation.
Ask only for questions, clarifications, or decisions that materially affect the plan. This does
not replace separately required live-run, experimental-budget, merge, or release authorization.
- Existing PR 201 CI at source revision `f5a37d4` passed quality and dependency audit. Its
  [proof-runtime job](https://github.com/synaptiai/flow-harness/actions/runs/34042748464/job/101512384018)
  failed while downloading Docker's signing key with a connection reset, before proof tests.
  This is not evidence for the uncommitted repair implementation or a passed proof gate.
- Local production composition, crash recovery, and available local quality gates passed.
  Hosted Linux x64, exact installed-package live qualification, and delivery remain pending.
  No live qualification, merge, or release is claimed.

### Retain the cancellation limitation

A prepared dispatch with no child ledger cannot produce a fabricated terminal usage receipt.
Cancellation stays requested and the reservation stays visible. An incomplete child likewise
stays reserved and does not restart automatically. A future explicit, authenticated
never-started-dispatch abandonment protocol is separate work; do not claim automatic cancellation
completion in these states or silently charge zero usage.

## Delivery and experiment preparation follow-up

- The authorized implementation commit is `a4e5aeec84ce26867c0300e097c9f43d59397288`,
  `feat: add bounded independent-review repair`. The exact revision was pushed to existing draft
  PR 201 and verified against the remote. The worktree was clean after delivery. Hosted CI run
  `34052845375` is testing that source; dependency audit passed and quality/proof remain running
  at this observation. Unlike the earlier run, Docker installation passed in both jobs.
- Read-only independent audits checked the target preparation and proposed experimental budgets.
  Target draft PR 110 remains preparation only at `683d37d1bb0285b62dba7b2aeafff0aa1275bfa4`.
  Its existing check passes, but no repair policy or repair workflow is authored yet. Issue 106's
  requested status behavior remains absent. No model call, secret provisioning, dispatch, or
  merge occurred.
- `docs/bounded-review-repair-experiment.md` records three choices and recommends smaller fixed
  children with complete explicit role pools. These new numeric limits remain unapproved. The
  recommendation preserves the existing aggregate token/cost/time/artifact amounts while using
  explicitly larger aggregate node-start pools. The first audit incorrectly allocated only two
  repair starts by assuming a single agent. Admission and guide review corrected the proposed
  graph to an agent plus terminal disposition verifier, four starts, and a ten-start implementation
  pool. Two reviews likewise fit a ten-start review pool. Independent arithmetic and JavaScript
  integer checks confirm positive unused capacity in every dimension.
- Independent review found one broken research anchor, now corrected. Automated style/clarity
  checks also identified wording and paragraph issues, all corrected before the final pass.
  Final documentation style, links, clarity, and diff whitespace checks pass. Independent source
  and document review reports no remaining P1-P3 findings. This does not validate unimplemented
  pilot YAML, prove runtime resource sufficiency, or establish causal improvement.
- Keep the current source CI running. Its workflow cancels an in-progress run when a new commit
  is pushed to the branch. The documentation-only proposal can be committed locally, but defer
  its push until the current qualification run settles. Routine commit confirmation is not needed
  under the user's explicit instruction. Experimental values and live execution remain decisions.
- A further independent timing audit found that the existing full verification pass has 17 minutes
  of configured command ceilings. Each candidate runs that pass before review and again when its
  immutable review context is first prepared. The one-repair path contains four prepublication passes:
  68 minutes of host-command ceilings plus 41 minutes of proposed child active allowances, or
  109 minutes. The first publication gate adds 17 (126 total), and the fresh exact-approval merge
  gate adds 17 (143 across both phases). Every CI-wait resume can repeat verification before its
  GitHub observation. Status inspection and stored-context replay do not repeat those commands.
  These are configured-timeout subtotals, not measured runtime or complete wall-clock bounds.
  The unchanged 90/30/180-minute deadlines remain explicit earlier-stop experimental choices.
  No deadline increased and no verification was removed. The proposal now makes that tradeoff
  concrete rather than leaving feasibility as an unspecified preparation check.

## Hosted quality evidence

- Run `34052845375`, quality job `101539421891`, passed in 28 minutes 53 seconds. GitHub reports
  source head `a4e5aeec84ce26867c0300e097c9f43d59397288`. Checkout logs identify synthetic merge
  `144f7e0499776db8964fddf0cb93f8f07bbe164f` with parents `f4deb0f` and `a4e5aee`. GitHub's Git
  object API and local Git independently agree that the tested merge and implementation both have
  tree `a1859a52a262efa633483fbc398dba2eeab9cc11`. The base is an ancestor of the implementation.
- Hosted coverage passed all 467 files and all 6,687 tests in 818.68 seconds. Coverage reports
  statements 85.04%, branches 79.94%, functions 92.52%, and lines 85.63%. Browser verification
  passed two tests in 1.63 seconds. Runtime verification passed 82 tests and skipped four Lean OCI
  tests in 325.05 seconds. The separate proof job remains in progress; these skips do not pass it.
- The fail-fast `scripts/ci-local.mjs` sequence also passed formatting, lint, documentation style
  and links, changed-prose checks, type checking, build, capability reference checks, Go tests,
  fresh Prime preparation, compiled CLI smoke, package checks, and dependency audits. The final
  audit reports zero vulnerabilities. An independent source/log audit corroborated this scope.
- The package log confirms clean installation and CLI execution. Its printed `5dfe0f...` value is
  `effective.policyDigest`, not the package archive SHA-256 digest. The package checker deletes its
  temporary archive. This does not qualify retained same-bytes artifacts on two hosts or execute
  the provider-backed issue/repair/merge lifecycle. Overall CI, BR-06, UC-01, and release remain open.
- Documentation commits `2f2f7fb` and `f608d34` are local and unpushed, with their own passing
  documentation checks. They are not included in the hosted `a4e5aee` snapshot. Keep the remaining
  proof job running before pushing the queued documentation and this evidence update.

## Completed hosted source verification

- On September 6, 2026, run `34052845375` completed successfully. All three jobs passed for
  source head `a4e5aeec84ce26867c0300e097c9f43d59397288` and the previously verified tree identity.
  Proof job `101539421770` finished in 1 hour 9 minutes 30 seconds. Preparation took 66 minutes
  28 seconds; this was a successful reproducibility build, not a timeout or failed attempt.
- The preparation script compares two clean image identities before publishing its attestation.
  The job then verified image `sha256:73559bb7a6d90c71601661ff13e82e59e1efa7ba05db22b5fb3e619f7e146a73`.
  Its build-attestation digest is `a596e473178598a22f42a2ea0ac4a16bd484c0d9b4ea073aa32b7a305f47cd75`.
  These identify the proof appliance, not an npm package archive or a live pilot artifact.
- The enabled Linux x64 proof suite passed all four tests in 110.59 seconds, with no skips.
  Source assertions cover exact-theorem acceptance after compiler, SafeVerify, Nanoda, and
  confirmed cleanup; incomplete-source rejection; rejection of unsupported axiom authority;
  durable-intent reconciliation, blocked automatic retry, and cancellation cleanup.
- Hosted source CI is now satisfied for the tested revision. The new documentation-only commits
  are not part of that tested snapshot. Push the reviewed documentation now that doing so cannot
  cancel this completed run, and inspect the new head's checks separately. BR-06 numeric limits,
  another paid run, target merge, installed lifecycle qualification, and release remain open.

## Option B execution approval

- The user said: "proceed with the option-b pilot". This selects the full documented option B
  limits and authorizes one new pilot with the existing OpenRouter route, including selected
  review findings and criterion evidence needed for repair. Reuse the existing provider key.
  Keep preparation merge, exact candidate merge, and release as separate approval gates.
- Source `544aebc13bfc50879de52396062a869ca975c367` passed all three CI jobs in run `34056651615`.
  The proof job passed all four tests without skips and produced the same proof-image digest as
  the prior source run. Pin these qualified bytes for package preparation, not a later docs commit.
- Main agent owns policy, workflow, package-order checks, and documentation. The independent
  evidence agent owns collector regression tests and any collector correction. Neither task
  implements issue 106. Existing target PR 110 is the preparation vehicle.
- Preparation starts with failing resource/disposition tests, then production CLI plan validation.
  Full target tests, review, same-bytes host qualification, installed baseline, and private evidence
  custody must pass before the corresponding next boundary. No automatic retry or budget increase.
- Preparation verification: 35 target control tests and 124 Python tests passed. Ruff, mypy,
  compileall, shell syntax, diff checks, and production CLI plan admission passed. Actual compiler
  output independently confirmed microdollar conversion and all five child-pool sums. The
  independent reviewer passed 176 focused Flow tests and found zero remaining P1/P2/P3 issues.
- Collector regression exposed inclusion of unrelated host projects. Narrowed the collection to
  the target canonical-path hash using Flow's host-root identity. Both archive stages now pass
  real tar/encrypt/authenticate/decrypt tests with retained repair/review ledgers and candidate
  files. Stored repair context resides in the child control graph's bound verifier prompt, not a
  dedicated repair blob. Independent source checks corrected an initially incomplete description.
- The original plan prefix, holdout bytes, criteria, candidate paths, and host verification commands
  remain unchanged. Public installer help still lists only install/uninstall. Preparation does
  not implement the target status feature. Selected Flow source stays at qualified `544aebc`.

## Approved preparation merge and option B dispatch

- In response to the exact-head preparation merge request, the user instructed us to stop asking
  routine questions and proceed with rigor. Revalidated `331eb9f4441236ceb4e38327fafd9cd2ba569417`,
  its passing checks, no requested changes, and zero unresolved review threads. Marked PR 110
  ready and squash-merged with an exact head guard. The remote preparation branch was removed.
- Merge `109fac8e78db17a178cc59e5d6ef91bb9b95d603` has exactly the reviewed preparation tree.
  The dedicated local checkout is clean and detached at that base. Issue 106 remains open with
  unchanged issue metadata. Hosted CI passed 35 controls and 123 Python tests; the existing
  maintainer-private corpus test skips on CI. Local Python verification passed all 124.
- Reused the existing owner-only .env provider key, current GitHub credential, and retained
  evidence key through the existing helper. Verified only secret names/timestamps. No credential
  values were displayed and no new provider key was created. Three dedicated pilot secrets must
  be removed after evidence custody is settled.
- Dispatched exactly once: Actions run `34065692695`, created `2026-09-06T23:01:43Z`, base
  `109fac8e78db17a178cc59e5d6ef91bb9b95d603`, source `544aebc`. The run is in progress. No rerun
  or replacement is authorized by an observation timeout or a failed result. Candidate merge
  still requires the fresh exact-head/gate approval record.
