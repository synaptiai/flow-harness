# UC-08: Discover frozen commands and stop ineffective requests

Status: Approach B implemented, independently reviewed, locally verified, and committed.
Policy: three cumulative refusals per durable session, retained as a provisional starting point.
Owner: coordinating maintainer. Branch: `codex/uc08-command-discovery`.
Baseline: `cf802bde9d6b7a464884c5b76aaa8a387b5765b0`. Date: 2026-09-05.

## Outcome and scope

Let an implementation agent discover and copy exact public verification commands, including their
timeouts. Keep digest membership, policy checks, sandbox containment, protected paths, private
holdouts, and explicit merge approval unchanged. Record typed, host-produced refusal evidence and
stop further model requests after a bounded number of ineffective command refusals.

The coordinator manages phases and independent reviewers. Implementation runs in this isolated
worktree; reviewers do not write production files. Heavy test suites run serially. No code is
committed until code and test reviews are complete and all concrete P1–P3 findings are fixed.

## Evidence and alternatives

The issue 106 installed attempt recorded 48 frozen-command refusals among 52 exec results. Only
four commands executed. The exact allowed pytest timeout was absent from tool guidance. The
existing command digest includes timeout; authorization was working, but discoverability was not.
The canonical [field report](../docs/field-reports/digital-twin-issue-106-installed.md) retains the
run identity, complete denominator, and limitations.

Command discovery alternatives:

1. Selected: optional validated catalog on frozen authority, shown in the existing exec tool and
   corrective errors. Smallest change; old digest-only records stay unchanged. Copying can still fail.
2. Dedicated discovery tool: supports paging, but adds an explicitly selected tool and another call
   the model can omit. Defer until measured catalog size or selection failures justify it.
3. Execute by command identifier: removes transcription errors, but adds a public input contract.
   Reconsider if exact invocation guidance fails in qualification.

Stopping alternatives:

1. Recommended: cumulative frozen-command refusals per durable model session; no reset on reads,
   edits, successful commands, compaction, or recovery. Proposed initial limit: three refusals
   (one initial mistake plus two correction opportunities), not an empirical optimum or standard.
2. Five cumulative refusals: more tolerance, but more ineffective requests. Same safety semantics.
3. Consecutive refusals: tolerant of intervening work, but alternating harmless tools can evade it.

Stop before the next model request, before summary generation or provider transmission. Finish
recording the already-issued batch; this bounds further model requests, not the count of tool
results inside an already-issued batch. Do not interrupt halfway through durable tool settlement.
Successful or nonzero-exit approved verification is not a refusal. Read errors are not refusals.

## Flows and dependencies

- Operator: freezes plan → admission validates public command catalog → doctor reports readiness.
- Model: receives exact catalog → requests exec → digest/policy/sandbox checks → command evidence,
  or actionable no-execution refusal.
- Runtime: commits typed refusal → settles issued batch → evaluates refusal count before the next
  provider request → continues or returns an explicit terminal failure.
- Recovery: replays original authority and typed events → preserves count and command-result
  reconciliation → never enriches an old digest-only active run implicitly.

Domain owns schemas and deterministic reduction. Application derives catalog from public frozen
verification only. Pi infrastructure renders guidance and records host-observed classification.
The issue controller retains lifecycle and merge authority. No reverse domain-to-infrastructure
dependency is introduced.

## Failure modes and non-goals

| Condition | Required behavior |
| --- | --- |
| Invalid or mismatched catalog | Fail admission before model work; no permission widening. |
| Oversized catalog | Fail explicitly within a documented byte bound; no silent truncation. |
| Missing legacy catalog | Preserve old authority identity; explain missing discovery without inventing commands. |
| Wrong executable, ordered args, or timeout | Refuse before policy or process preparation; return exact correction guidance. |
| Approved verifier exits nonzero | Keep normal command evidence; do not charge refusal count. |
| Refusal threshold reached | Settle issued tool batch; deny the next model request, including compaction requests. |
| Provider outage after a refusal | Preserve typed evidence and conservative effect reconciliation on recovery. |
| Crash with unsettled effect | Existing uncertain-effect rules remain in force; never infer non-execution from prose. |
| Tampered replay classification | Reject invalid event/tool associations; do not infer authority from model text. |

This change does not increase token, cost, execution-time, or command budgets. It does not implement
general semantic loop detection, autonomous verifier-directed repair, a new provider, automatic
merge approval, cross-host recovery, or a replacement hosted trial. Installed qualification and
exact-artifact retention remain separately tracked gates, not implied by local verification.

## Phased checklist and verification

Exactly one coordinator phase is active. Checklist evidence is updated after each phase.

- [x] Phase 1 — Explore: trace authority, tool metadata, model-session ledger, recovery, pilot
  denominator, and existing onboarding. Three independent read-only investigations completed or
  collected final evidence. Primary-source research checks feedback and loop-policy assumptions.
- [x] Phase 2 — Implement discovery: RED → GREEN catalog validation, immutable canonical
  normalization, exact guidance, actionable typed refusal. Preserve legacy identities and holdouts.
  Verify with targeted domain, issue-admission, workspace-tool, and provider-catalog tests; then
  `npm run lint` and `npm run typecheck`.
- [x] Phase 3 — Implement stopping: RED → GREEN typed durable classification, threshold evaluation,
  safe provider admission, recovery checks, explicit diagnostics. Test variation, intervening work,
  batch settlement, nonzero verifier exits, restart, malformed evidence, and legacy records.
- [x] Phase 4 — Reassess and document: reconcile roadmap, project status, plugin parity, research
  dependencies, canonical usage/operations, architecture, and generated capabilities. Preserve all
  qualification blockers and named deferrals. Run documentation checks.
- [x] Phase 5 — Verify and challenge: serial unit/integration suite, build, relevant runtime tests,
  generated reference checks, specification mapping, independent code and test reviews, and fixes.
  Record exact commands, outcomes, and untested boundaries; do not claim live proof from fixtures.
- [x] Phase 6 — Commit reviewed work and prepare handoff: secret/diff audit and reviews completed
  before commits. Preserve PR 201's qualification blocker and report remaining evidence gates.
  The PR owns remote check and merge status; this checklist does not declare hosted qualification.

## Verification methods and evidence gaps

Use source tracing, pure-domain negative tests, real workspace integration, durable replay tests,
installed dependency inspection, serial static/runtime checks, independent review, and primary
external sources. Mathematical checks retain denominators: 48 / 52 = 92.31% rejected exec requests;
49 tool errors include one unrelated read error. Do not infer a general success rate from one task.

External comparisons support actionable correction and bounded policies, not a universal numeric
limit. No new live model call, hosted trial, release, or paid resource is authorized by this plan.
The current paid-run contract is not silently modified or resumed.

## Implementation observations

- The optional default-policy question remains available to the user. Implementation uses the
  recommended three-refusal starting policy within approved Approach B unless the user selects
  another disposition. This is not recorded as separate empirical or industry validation.
- Domain and real-Pi composition RED tests exposed absent catalog metadata, schema support, and
  size validation. Initial GREEN passed 65 targeted tests. Follow-up tests cover legacy metadata
  identity and duplicate catalog handling before this phase can close.
- Catalog caller duplicates are rejected. Frozen issue-plan command arrays can repeat the same
  invocation under distinct verification IDs, so the builder deduplicates those vectors into one
  exact catalog entry without changing the plan's verifier execution order.
- Review found that Pi 0.84.4 converts optional nulls and primitive argument types before validating
  tool calls. A strict check of raw arguments is not proof of non-execution. A reproducing test
  failed under that classifier and passed after using the installed validator. This dependency
  behavior is now a required adversarial regression.
- A fresh read of the retained private trial archive confirmed 346 events, 72 tool results,
  52 exec results, 48 refusals, and 49 total tool errors. Only aggregate counts were disclosed.
- Phase 2 final focused verification: 169/169 tests across seven files. Phase 3 final focused
  verification: 192/192 tests across five files. These groups are not added into a whole-suite
  total because verification groups can overlap. Both implementers ran targeted lint/format
  checks successfully. Root owns the remaining full static, build, suite, and runtime checks.
- A redundant in-progress typecheck was intentionally interrupted to serialize heavy work. It is
  not counted as a passing check. Final typechecking starts after both implementation tracks freeze.
- Independent documentation review found one P2 namespace gap and two P3 availability/feedback
  precision gaps. The guides now distinguish parent issue inspection from nested session records,
  current source from published alpha.4, and schema validation from frozen matching. Reviewer
  re-verification resolved all three findings. The full documentation gates passed. Independent
  code, security, and test reviews reported no remaining P1–P3 findings before commit.
- The parity inventory covers all 23 plugin command files. It does not establish performance
  equivalence. UC-01/02 remain qualification blockers; UC-08a retains exact archive retention as
  a separate open gate. UC-03 now explicitly tracks unified public nested-failure diagnostics.
- Legacy compatibility is bounded: supplied digest-only authority and metadata remain identical,
  and old records replay. The production issue runner re-admits its frozen plan on resume, so an
  old active issue exec run rejects the newly derived catalog identity under a newer binary. Keep
  its original pinned runtime. No active-run migration or cross-version continuation is added.
- The first full typecheck found an exact-optional-field return mismatch and a test that reassigned
  a read-only journal method. Explicit conditional field construction and a typed test wrapper
  corrected them without changing the runtime contract. Domain tests passed 41/41 and session
  tests passed 39/39 after correction. The authority return received independent re-review.
- Final full typecheck and production build passed. Both capability artifacts were regenerated,
  reviewed, and checked against production composition. Full formatting, lint, and all three
  documentation checks passed after generation. Lint retains one pre-existing informational
  constructor suggestion in unchanged `external-harness-adapter.ts`; no new lint findings remain.
- Independent review also confirmed that the corrected journal wrapper still injects a durable
  result-write failure and proves no later model request. No review findings remain at this point.
- First full suite: 457 files passed, two failed, one skipped; 6,359 tests passed, two failed,
  four skipped. One failure proved the library assessment's internal-export counts were stale:
  the new application and domain constants add one each, giving 551 + 25 + 1,598 + 1,081 + 122
  = 3,377 declarations. The assessment and its executable regression now use the analyzer's result.
  Production module count, reachability, and the empty public exports map are unchanged.
- The other first-suite failure was the unchanged 512/513-entry filesystem recovery test reaching
  its five-second test deadline. An isolated rerun passed with the original assertions and deadline
  (2.35 seconds for test work). A timing/load explanation remains a hypothesis, not an established
  cause. The full file and complete suite must be rechecked; no test deadline or assertion is relaxed.
- Both complete failed test files subsequently passed: 104/104 tests, with original deadlines.
  Independent review matched the filesystem test and its production dependencies byte-for-byte
  against the baseline. It identified existing allocation and filesystem work as a plausible load
  sensitivity, not a proved timeout cause. The full-suite rerun uses two workers (repository default:
  four), with other heavy suites serialized. No production or test change was made to that path.
- The two-worker full rerun reported multiple failures and was interrupted (exit 130); it is not
  counted as completed verification. A fail-fast two-file reproduction identified an unchanged
  local Git integration test exceeding its five-second deadline (5.284 seconds) under concurrency.
  The previous one-worker full run passed that file. The final full rerun returns to one worker
  with fail-fast reporting. All original test assertions and deadlines remain unchanged.
- A subsequent one-worker rerun also timed out in another unchanged Git case. Running that exact
  case in the untouched `cf802bd` parent worktree reproduced the same five-second timeout. This
  disproved concurrency as a complete explanation and established an existing host-sensitive test
  deadline. The tests create multiple real Git repositories and processes; no five-second product
  performance contract is asserted.
- Test-only remedy: use the existing neighboring integration-suite deadline of 30 seconds for
  `LocalGitIssueEffects`, and the same finite deadline for the specific 512/513-file recovery case.
  All assertions, production command deadlines, model budgets, and runtime limits remain unchanged.
  Alternatives considered: redesign fixtures (larger isolation risk and unrelated work) or raise the
  entire test suite's default (unnecessarily broad). The narrow integration-test deadline is selected.
  Earlier unchanged-deadline reproductions remain recorded; they are not retroactively relabeled.
- Independent review confirmed these are bounded test watchdogs, not specified performance
  assertions. Both complete affected files passed after the scoped correction: 135/135 tests.
  Formatting and lint also passed. The library-count correction received independent arithmetic
  and source review with no findings. CONTRIBUTING now explains how to refresh this audit.
- A two-worker post-correction rerun exceeded an existing 60-second result-loss integration-test
  deadline (95 tests passed before fail-fast settlement). That complete file already passed in the
  one-worker 135-test run. The 60-second deadline remains unchanged. Final whole-suite verification
  uses one worker, matching `test:coverage` in the canonical CI sequence. Parallel-run failures
  are retained as host-sensitive test-execution evidence, not represented as passing checks.
- The next serial run passed 4,794 tests (301 files) before fail-fast stopped on a second stale
  `3,375` assertion in the packaging documentation-structure test. Root's earlier search covered
  scaffold tests but missed this integration assertion. A whole-repository search identified that
  remaining literal. It now checks 3,377; CONTRIBUTING names both test owners. No production code
  or behavioral assertion changed. Runtime and package gates run before the final complete suite
  to expose independent failures without repeating the long suite between each diagnostic step.
- Both library/documentation assertion files passed after the final count correction: 6/6 tests.
  The first native runtime run passed 43 tests, skipped 42 platform-specific cases, and failed the
  unchanged browser-startup test's five-second stdout wait. Its isolated rerun passed unchanged.
  Independent source review found that the helper's wait includes a supervisor startup whose
  existing production deadline is ten seconds. No UC-08 behavior executes in this command-only
  fixture, but added import cost and host scheduling remain unmeasured possibilities. No runtime
  deadline or assertion changed. The complete runtime rerun passed 44 tests, with 42 expected
  platform skips; the compiled CLI smoke check also passed. Preserve the failed run rather than
  claiming consistently passing timing behavior. The final JSON reports are retained locally in
  `/private/tmp/flow-uc08-verification.rzAWc4/` for this verification session.
- Final complete unit/integration verification passed with one worker: 459 files passed, one
  skipped; 6,361 tests passed, four skipped; duration 820.06 seconds. Both JSON reports confirm zero
  failed tests. These totals belong to the complete runs, not a sum of selected reruns.
- Clean package installation and installed CLI verification passed against the current working
  tree. This is an ephemeral archive, not a retained qualification artifact. Independent review
  confirmed that the digest printed by `pack:check` is the effective installed policy SHA-256,
  not the archive digest. Correct the existing PR's historical label; UC-08a remains open.
- The final changed-file audit covers seven production files, 15 test files, 17 documentation
  files, and two decision records. It found no credential-pattern matches, environment files,
  files above one MiB, or whitespace errors. No provider call, secret provisioning, hosted
  replacement attempt, release, or merge occurred during UC-08 verification.
- Final formatting, lint, typecheck, generated-reference validation, documentation style, links,
  clarity, and whitespace checks passed. The completion paragraph needed a sentence split to
  satisfy the existing prose checker; the corrected documentation regression files passed 6/6.
  The unchanged informational constructor suggestion remains the only lint message.
- Report SHA-256 digests: full suite
  `839a767a088e39d2c77637fc68b7c37a7bb4f7b6bea7ca66fed303536b41c19d`; native runtime
  `7c8421a761ac6406596588bd2a0763657eddf125c7bec50939e2a20a51bed191`.
- Local reviewed commits: `65306cd` contains the feature, regression tests, and usage contracts;
  `4ed4a64` contains only the two integration-test watchdog changes. The separate documentation
  commit contains the parity reassessment, tracked deferrals, and this verification record.
  Integrate into the existing `codex/issue-197-controller` branch by fast-forward only, without
  force-pushing. Keep PR 201 draft and open pending installed qualification and exact-head checks.
