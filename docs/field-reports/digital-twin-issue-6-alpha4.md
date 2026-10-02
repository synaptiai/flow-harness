# Digital-twin issue 6 lifecycle field report

## Result

Flow completed the bounded lifecycle for
[`digital-twin` issue 6](https://github.com/danielbentes/digital-twin/issues/6). The accepted run:

- froze the issue, repository, base revision, workflows, checks, holdout, and budgets before
  mutation.
- implemented and repaired the candidate in an isolated worktree with OpenRouter
  `z-ai/glm-5.3-flash:nitro`.
- passed the base-negative and candidate-positive private holdout and every frozen local command.
- passed an independent read-only review with no open P1, P2, or P3 finding.
- published [pull request 105](https://github.com/danielbentes/digital-twin/pull/105).
- passed the required GitHub Actions `test` check on hosted Linux x64.
- stopped at the exact merge-approval gate.
- accepted a separate approval bound to the pull request, candidate commit, and gate digest.
- squash-merged the approved candidate, deleted its branch, proved the merge, and closed the issue.

This is the first accepted end-to-end external-project lifecycle result. It proves the named run
and its fixed boundaries. It does not prove general reliability across repositories, languages,
models, providers, or issue classes.

## Qualification boundary

The lifecycle ran from Flow's exact built source at pull request 201 on macOS. The candidate then
passed its required hosted Linux x64 check. Flow's packed-archive and installed-package suites test
the same command surface separately, but the accepted external run did not start from the
published `0.1.0-alpha.4` package. That package predates `flow issue`.

Therefore, this report supports these claims:

- The current source can complete one real GitHub issue through post-merge proof.
- The model remained outside the GitHub, credential, network, Git metadata, and merge-authority
  boundaries.
- Independent review and the private holdout rejected plausible but defective candidates before
  publication.
- The accepted candidate passed its required hosted Linux x64 check.

This report does not support these stronger claims:

- The already-published alpha.4 package can run the lifecycle.
- The controller itself ran on hosted Linux x64.
- One success establishes an unattended success rate or a production service-level objective.
- The observed OpenRouter route is superior to another provider or model.

## Accepted run evidence

| Evidence | Value |
| --- | --- |
| Run | `issue-ef297140-9756-4dc5-92f0-4017a4bd5f07` |
| Frozen base | `99fb83a14e589fe7137b6f6cf3eac97b8535be0f` |
| Issue digest | `2abcc650c57e2928fb1bfa550dc4732d475efeb159dbcf26dff898c9216c3e45` |
| Frozen contract digest | `a9620a38dbeae48a6cb04b73c0e854c97cfce6e0b9bc7f8da703c33045a9022c` |
| Plan digest | `f3b11084a22c06a926fc6216dcd50c7597a1a0ccb6550dcbd35cb6e4fff4ae25` |
| Implementation template digest | `ce1d8d3f90891fe9e09adcb6b7c174ac287aa252235eddc9ca686a3f9ea6ee83` |
| Review template digest | `ce255156ec47a3cf7611e3ecd11c098d105634fe4e79ecf4ebd8bbef34eff8b8` |
| Candidate | `c54b8105ea8c79c37be1ff4280f3b9163ca4cda4` |
| Verification evidence digest | `5469a2eb5465b5489a3fa7188cd8e21931b5025c8587ee287cf466e9c679172d` |
| Pull request | `105` |
| Hosted check | GitHub Actions `test`, successful on the exact candidate |
| Checks digest | `86d9de6403c92a2718899b478346399b4223974992f88c9c99457c65db59f7c8` |
| Merge-gate digest | `f52e4a0f298a5b87164f086267e242d06a649cba99b638f33a432fe9227f0064` |
| Merge commit | `374b16b229e187004e5915942f95c296af03298f` |
| Merge evidence digest | `f393c266f31fd15e55cd8bab9035afe747302b548855c8892d17cc85ccf2b68b` |
| Branch outcome | Deletion requested and observed |
| Issue outcome | Closed by the merged pull request |

The accepted parent run lasted 77.7 minutes. Its implementation and review runs reported 4,747,296
aggregate tokens, including cache tokens, and `$0.194049` in model cost. They recorded 161 model
turns, 182 model tool calls, and 43 settled filesystem effects.

## Fixed operating controls

The final run used these controls:

| Control | Value |
| --- | --- |
| Repository | `danielbentes/digital-twin` |
| Issue | 6, installable PostToolUse hook |
| Base branch | `main` |
| Flow-owned branch | `flow/issue-6-ef297140` |
| Provider and route | OpenRouter `z-ai/glm-5.3-flash:nitro` |
| Model network and GitHub credentials | Unavailable |
| Model Git metadata access | Unavailable |
| Implementation authority | Reviewed repository reads, writes, and Linux-contained commands |
| Review authority | Read-only exact-candidate evidence |
| Holdout | Frozen private Python program, base-negative and candidate-positive |
| Local verification | Installer, public interface, detector, compile, Ruff, Mypy, shell, full test, and report checks |
| Hosted verification | Required GitHub Actions `test` check from the trusted source app |
| Merge | Separate squash-merge command bound to PR 105, candidate, and gate digest |

The frozen issue content and plan stayed unchanged during the final sequence. Earlier attempts used
new bases because each generalized controller or contract correction was reviewed and merged before
the next fresh run.

## Complete run denominator

The series contains 52 full parent runs and 55 nested implementation or review runs. The parent
outcomes were:

| Outcome | Runs |
| --- | ---: |
| Implementation workflow failed | 27 |
| Candidate holdout failed | 13 |
| Aborted | 3 |
| Review blocked | 2 |
| Diff output limit | 1 |
| Implementation resource exhausted | 1 |
| Implementation workflow cancelled | 1 |
| Effect state uncertain | 1 |
| Verification failed | 1 |
| Verification mismatch | 1 |
| Merged | 1 |

Across all 52 parent runs, nested agent evidence reported 247,516,376 aggregate tokens, including
cache tokens, and `$10.094325` in model cost. The runs occupied 3,503.9 aggregate wall-clock
minutes. They recorded 9,429 model turns, 10,590 model tool calls, and 2,532 settled filesystem
effects. These values are ledger observations. They are not invoice reconciliation or a controlled
provider comparison.

The abbreviated run ID is the first eight hexadecimal characters after `issue-`. A dash in the
candidate column means the run stopped before Flow created a candidate commit.

| # | Run | Start UTC | Min | Outcome | Tokens | Cost | Turns | Calls | Effects | Candidate | Base |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | `4aebf4d8` | 2026-09-02 07:18 | 47.8 | `candidate_holdout_failed` | 4,665,880 | $0.196391 | 190 | 215 | 65 | `a4458394` | `edd0150b` |
| 2 | `8caac30f` | 2026-09-02 08:29 | 46.5 | `candidate_holdout_failed` | 4,027,341 | $0.193474 | 178 | 204 | 52 | `c2844c69` | `a30f22b2` |
| 3 | `23cb89d1` | 2026-09-02 09:42 | 42.7 | `verification_failed` | 4,328,812 | $0.182212 | 193 | 205 | 57 | `c3497069` | `c994c799` |
| 4 | `71e8fc38` | 2026-09-02 10:45 | 39.9 | `implementation_workflow_failed` | 3,557,564 | $0.156977 | 164 | 186 | 48 | — | `cff98a92` |
| 5 | `52f6a300` | 2026-09-02 11:58 | 48.8 | `implementation_resource_exhausted` | 5,013,123 | $0.216485 | 219 | 255 | 67 | — | `23afcf23` |
| 6 | `8cc02b41` | 2026-09-02 12:59 | 40.4 | `implementation_workflow_failed` | 4,129,720 | $0.186197 | 189 | 208 | 58 | — | `ad26f518` |
| 7 | `b4afeb8b` | 2026-09-02 14:08 | 8.2 | `implementation_workflow_failed` | 300,925 | $0.017322 | 17 | 18 | 5 | — | `8dfe1c40` |
| 8 | `6271c9ff` | 2026-09-02 14:21 | 79.9 | `candidate_holdout_failed` | 6,402,221 | $0.307045 | 223 | 256 | 67 | `4182e66f` | `8dfe1c40` |
| 9 | `836bac60` | 2026-09-02 16:00 | 34.8 | `implementation_workflow_failed` | 665,369 | $0.050514 | 28 | 30 | 7 | — | `f14800a2` |
| 10 | `f55a827f` | 2026-09-02 16:45 | 45.0 | `implementation_workflow_failed` | 5,125,288 | $0.212941 | 207 | 205 | 64 | — | `95ac55d3` |
| 11 | `b58419f1` | 2026-09-02 17:45 | 16.6 | `implementation_workflow_failed` | 716,598 | $0.037545 | 43 | 42 | 18 | — | `c391df56` |
| 12 | `8662565b` | 2026-09-02 18:24 | 4.7 | `aborted` | 383,421 | $0.016394 | 18 | 20 | 8 | — | `c391df56` |
| 13 | `0c72e317` | 2026-09-02 19:10 | 15.4 | `implementation_workflow_failed` | 1,298,632 | $0.052273 | 63 | 62 | 20 | — | `9ad75ed0` |
| 14 | `27c4b0f9` | 2026-09-02 19:31 | 27.1 | `implementation_workflow_failed` | 1,508,076 | $0.072419 | 94 | 112 | 28 | — | `ca53ab79` |
| 15 | `48899aab` | 2026-09-02 20:15 | 90.0 | `implementation_workflow_failed` | 6,639,513 | $0.295560 | 247 | 301 | 72 | — | `ca53ab79` |
| 16 | `e11900e4` | 2026-09-02 22:08 | 115.4 | `implementation_workflow_failed` | 2,585,289 | $0.149486 | 139 | 137 | 39 | — | `fdf7dd74` |
| 17 | `f5f3c323` | 2026-09-03 03:02 | 68.9 | `implementation_workflow_failed` | 5,137,618 | $0.283379 | 221 | 248 | 65 | — | `bf03d078` |
| 18 | `096d1762` | 2026-09-03 04:28 | 81.8 | `diff_output_limit` | 10,283,704 | $0.386889 | 309 | 333 | 80 | `aa0d955e` | `21927905` |
| 19 | `4a03b0f5` | 2026-09-03 06:04 | 107.8 | `review_blocked` | 9,556,354 | $0.429641 | 290 | 316 | 69 | `85bb2bbd` | `21927905` |
| 20 | `ad066d6e` | 2026-09-03 08:02 | 118.8 | `aborted` | 7,116,926 | $0.380357 | 253 | 285 | 67 | — | `149355d7` |
| 21 | `307f29fa` | 2026-09-03 10:34 | 22.4 | `implementation_workflow_failed` | 812,467 | $0.045730 | 42 | 40 | 12 | — | `149355d7` |
| 22 | `1654850c` | 2026-09-03 10:58 | 9.7 | `implementation_workflow_failed` | 295,759 | $0.016454 | 23 | 24 | 7 | — | `149355d7` |
| 23 | `c3afef07` | 2026-09-03 11:12 | 77.3 | `implementation_workflow_failed` | 1,026,876 | $0.071459 | 77 | 82 | 20 | — | `149355d7` |
| 24 | `bfe6d1e0` | 2026-09-03 12:35 | 114.6 | `effect_state_uncertain` | 1,848,358 | $0.102754 | 115 | 131 | 38 | — | `149355d7` |
| 25 | `82ea6acb` | 2026-09-03 14:51 | 193.8 | `implementation_workflow_failed` | 9,932,354 | $0.365468 | 308 | 340 | 90 | — | `149355d7` |
| 26 | `2befa503` | 2026-09-03 18:56 | 46.5 | `implementation_workflow_failed` | 2,908,904 | $0.126182 | 125 | 132 | 34 | — | `35efcc6e` |
| 27 | `11d7c8f0` | 2026-09-03 19:57 | 161.9 | `implementation_workflow_failed` | 9,135,075 | $0.320194 | 297 | 339 | 89 | — | `35efcc6e` |
| 28 | `327f12ac` | 2026-09-04 00:11 | 142.8 | `implementation_workflow_failed` | 6,423,723 | $0.314221 | 249 | 282 | 64 | — | `35efcc6e` |
| 29 | `a7186fa3` | 2026-09-04 02:43 | 27.5 | `implementation_workflow_failed` | 1,065,963 | $0.044777 | 54 | 54 | 18 | — | `027379c2` |
| 30 | `b0e3f946` | 2026-09-04 03:37 | 133.2 | `candidate_holdout_failed` | 10,589,883 | $0.336505 | 337 | 390 | 100 | `59b36a07` | `027379c2` |
| 31 | `e7ca5230` | 2026-09-04 05:58 | 175.0 | `verification_mismatch` | 11,336,341 | $0.392764 | 372 | 425 | 95 | `6424c292` | `59e8e763` |
| 32 | `0998c596` | 2026-09-04 09:08 | 149.8 | `implementation_workflow_failed` | 7,991,631 | $0.328402 | 292 | 329 | 79 | — | `59e8e763` |
| 33 | `6e3a1f92` | 2026-09-04 11:43 | 100.0 | `implementation_workflow_failed` | 3,582,830 | $0.207872 | 176 | 183 | 46 | — | `b8eea075` |
| 34 | `7f4c2d10` | 2026-09-04 13:31 | 91.6 | `implementation_workflow_failed` | 12,447,031 | $0.404804 | 388 | 456 | 95 | — | `477436cf` |
| 35 | `9d89d693` | 2026-09-04 15:54 | 131.5 | `implementation_workflow_failed` | 7,502,125 | $0.351183 | 323 | 362 | 78 | — | `6b03ec16` |
| 36 | `612c0df2` | 2026-09-04 18:13 | 62.4 | `implementation_workflow_failed` | 5,387,960 | $0.240293 | 234 | 262 | 57 | — | `97666231` |
| 37 | `2ab695b0` | 2026-09-04 19:21 | 95.7 | `implementation_workflow_failed` | 8,065,415 | $0.316234 | 331 | 388 | 80 | — | `e8ec0637` |
| 38 | `5d31e894` | 2026-09-04 21:41 | 131.8 | `implementation_workflow_failed` | 11,103,403 | $0.418715 | 373 | 406 | 94 | — | `c7e5936f` |
| 39 | `cfaa8fb1` | 2026-09-05 00:10 | 27.1 | `implementation_workflow_failed` | 3,239,404 | $0.109626 | 154 | 170 | 34 | — | `c0660bb3` |
| 40 | `8fa7b718` | 2026-09-05 00:45 | 21.6 | `implementation_workflow_cancelled` | 2,009,030 | $0.058512 | 105 | 126 | 10 | — | `ce6eb998` |
| 41 | `3a5cc695` | 2026-09-05 01:17 | 27.0 | `aborted` | 3,542,882 | $0.105833 | 107 | 124 | 18 | — | `1ab8bbe5` |
| 42 | `fd27f556` | 2026-09-05 01:48 | 24.6 | `candidate_holdout_failed` | 3,587,301 | $0.107805 | 163 | 180 | 30 | `dccd8521` | `ee1652a1` |
| 43 | `64b00b03` | 2026-09-05 02:18 | 19.1 | `candidate_holdout_failed` | 3,237,740 | $0.121197 | 145 | 163 | 31 | `b2aedf16` | `b4af4d53` |
| 44 | `37d9296b` | 2026-09-05 02:41 | 46.0 | `candidate_holdout_failed` | 4,021,280 | $0.150139 | 151 | 167 | 43 | `b67b4872` | `f124e0d9` |
| 45 | `190ad2d9` | 2026-09-05 03:34 | 38.5 | `candidate_holdout_failed` | 4,014,074 | $0.134756 | 158 | 175 | 32 | `0e3a187b` | `1b0a392e` |
| 46 | `6bc5f335` | 2026-09-05 04:18 | 29.4 | `candidate_holdout_failed` | 2,791,077 | $0.112981 | 137 | 156 | 36 | `e93eca1b` | `488bbdd8` |
| 47 | `22bb3dc1` | 2026-09-05 04:54 | 36.3 | `candidate_holdout_failed` | 3,968,391 | $0.135888 | 131 | 165 | 38 | `3e7838f3` | `5b560347` |
| 48 | `68432698` | 2026-09-05 05:40 | 48.8 | `candidate_holdout_failed` | 4,883,225 | $0.169076 | 170 | 196 | 46 | `8053132d` | `8c01bfa9` |
| 49 | `67d816ee` | 2026-09-05 06:37 | 56.6 | `candidate_holdout_failed` | 4,345,133 | $0.143903 | 137 | 163 | 33 | `96c43380` | `fb902c5d` |
| 50 | `f9cd15ac` | 2026-09-05 07:39 | 58.4 | `candidate_holdout_failed` | 5,199,246 | $0.191472 | 163 | 195 | 48 | `8c55384d` | `16dfd5f3` |
| 51 | `b52bb6ba` | 2026-09-05 08:45 | 44.6 | `review_blocked` | 3,031,825 | $0.131576 | 146 | 165 | 38 | `9182e927` | `b4e5b0ba` |
| 52 | `ef297140` | 2026-09-05 09:37 | 77.7 | `merged` | 4,747,296 | $0.194049 | 161 | 182 | 43 | `c54b8105` | `99fb83a1` |

## Recursive correction ledger

Each correction below was reviewed, passed its repository checks, merged to `main`, and became a
new frozen base. These are pilot-controller and acceptance-contract changes in the target
repository. Core Flow changes remained on Flow pull request 201 until this qualification completed.

| Pull request | Correction |
| ---: | --- |
| 62 | Preserve the absolute settings path at confirmation. |
| 63 | Allow realistic public-surface tail latency. |
| 64 | Add a bounded model-response contract. |
| 65 | Split installer semantic repair. |
| 66 | Reconcile detector convergence. |
| 67 | Reconcile the complete public suite. |
| 68 | Add terminal issue verification repair. |
| 69 | Harden the terminal issue audit. |
| 70 | Make declared retries reachable. |
| 71 | Split convergence stages. |
| 72 | Converge the final gates. |
| 73 | Split state-integrity work. |
| 74 | Split runtime-fixture work. |
| 75 | Back off provider retries. |
| 76 | Cover the provider-outage window. |
| 77 | Reconcile backlog-drain evidence. |
| 78 | Add a deterministic convergence gate. |
| 79 | Align issue checks with frozen commands. |
| 80 | Drive convergence from live check failures. |
| 81 | Address independent-review findings. |
| 82 | Retry strict-invalid verifier output under the bounded policy. |
| 83 | Decompose review repairs. |
| 84 | Guard canonical source identity. |
| 85 | Align report verification. |
| 86 | Decompose installer convergence. |
| 87 | Split final verification. |
| 88 | Bound repair diagnostics. |
| 89 | Drive installer repair from bounded tests. |
| 90 | Recover after settled commands without replay. |
| 91 | Target the active hook transcript. |
| 92 | Enforce the strict hook-event contract. |
| 93 | Let bounded repair create omitted files. |
| 94 | Align installer repair commands. |
| 95 | Enforce registered review commands. |
| 96 | Harden hook-state contracts. |
| 97 | Require public hook initialization. |
| 98 | Require exactly one detector command. |
| 99 | Require durable detector pairing. |
| 100 | Canonicalize detector state keys. |
| 101 | Require an install-time baseline. |
| 102 | Require unambiguous confirmation. |
| 103 | Normalize confirmation tokens. |
| 104 | Enforce the contracts found by the prior independent review. |

## What the failures taught us

### Deterministic gates must own acceptance

Thirteen candidate commits passed their implementation workflows but failed the private holdout.
Two more reached independent review and were blocked. The last blocked candidate passed its frozen
commands and holdout. Review found three P3 defects. They were conflicting confirmation
affordances, install-only options exposed by uninstall, and insufficient large-file replacement
identity.

The next controller correction converted each finding into a frozen contract and regression. The
accepted run then passed the unchanged private holdout and a fresh review. This sequence demonstrates
why a model's completion report and even a green public suite cannot authorize publication alone.

### Bounded decomposition mattered more than a larger universal limit

The series repeatedly exposed long trajectories with many small reads, edits, and commands. The
per-agent policy-decision limit remained a reviewed control rather than an industry-derived
constant. Work was decomposed by installer, detector, documentation, adversarial repair, and final
command convergence. The final installer still needed a provider retry and more than 21 minutes on
its second attempt.

The evidence does not justify a universal decision or turn limit. Future work should provide
trajectory observability and separately bounded request, node, and run timeouts instead of raising
one ceiling until a task passes.

### Durable command results enable safe continuation

Several long model attempts failed after executing deterministic commands. A fresh model context
could not continue safely when Flow treated every command as an unrecoverable unknown side effect.
The corrected contract distinguishes an interrupted open command from a completed provider failure
after a settled command.

Continuation requires a durable command request and outcome. Process termination must be confirmed.
Sandbox cleanup must not have failed. The closed model session must contain the tool result. Every
edit must be settled, no delegation can run, and budget must remain.

Flow supplies the recorded result to the next attempt. It does not execute the command again. Open
or unconfirmed commands remain ineligible.

### Cheap tokens did not guarantee operational efficiency

The selected OpenRouter route kept reported dollar cost low relative to the large token volume, but
many attempts were slow and verbose. Long responses sometimes produced no effects, and large cached
histories dominated the aggregate token count. Route price alone is therefore an incomplete
selection rule. Operators also need latency, output distribution, useful-effect rate, verifier pass
rate, and retry amplification.

### Compaction was not exercised

The long attempts created substantial provider traffic, but their model-session ledgers recorded
no production rolling-context compaction. OpenRouter lacks Flow's required exact preflight token
count operation, so the current rolling-context policy fails closed for that provider. This run
does not validate compaction quality or overflow recovery.

The DeepSeek Harness comparison still supports a future separation among capacity facts,
projection policy, deterministic tool-result pruning, summary inference, and durable compaction
events. Adoption remains a research item until held-out tests prove constraint retention and no
authority expansion.

## Operator interventions

The operator:

- authorized the bounded transmission of issue 6 repository data to the selected provider.
- selected OpenRouter and the GLM 5.3 Flash Nitro route.
- retained the provider key outside the repository and model context.
- reviewed each generalized controller correction before its next fresh run.
- restarted interrupted local sessions without editing durable run evidence.
- inspected holdout and review failures and converted them into controller contracts.
- issued the final merge command with the exact pull request, head commit, and gate digest.

No operator manually patched an issue candidate. Failed candidates remained rejected. Every
accepted candidate byte came through the bounded implementation workflow and then passed the frozen
verification and independent-review gates.

## Remaining qualification work

Before Flow can claim that another user can install and run this lifecycle from a public release:

1. Merge Flow pull request 201 after exact-head review and hosted checks.
2. Build and verify the exact npm archive on the supported hosted Linux x64 and macOS x64 runners.
3. Publish a new immutable prerelease only under separate release authorization.
4. Install that prerelease in a clean environment and run the documented compatibility and
   command-discovery checks.
5. Add another frozen external task from a different repository or task class.
6. Require that evidence before making a general reliability claim.

These remaining steps do not erase the accepted lifecycle evidence. They define the difference
between a source-qualified feature and a publicly installable checkpoint.
