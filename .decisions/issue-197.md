# Decision Journal: Issue #197 — Complete a bounded GitHub issue lifecycle

**Issue**: #197 | **Branch**: `codex/issue-197-github-lifecycle` | **Started**: 2026-08-28

---

## Context

Flow can implement and verify changes inside a bounded workspace. It deliberately denies workflow
commands network access, ambient credentials, and writes to `.git`. The public CLI does not yet
retrieve a GitHub issue, prepare a branch, publish a pull request, observe hosted checks, coordinate
an exact-candidate review, or merge. The digital-twin field runs therefore proved only the inner
implementation loop; ordinary Git and GitHub operations remained operator-owned.

The requested outcome is stronger: an external user must be able to install Flow, point it at an
issue in another repository, and use one durable lifecycle for implementation, review,
verification, publication, explicit merge approval, and post-merge proof. The model must not gain
GitHub credentials, network access, Git metadata access, or merge authority.

## Approved architecture

### Refined Approach A: host-owned GitHub issue controller

Add a CLI-only controller around the existing workflow engine. The controller owns a narrow set of
fixed Git and GitHub operations. It passes untrusted issue content to the bounded implementation
workflow as data. The model continues to run inside the existing network-denied, credential-free,
`.git`-protected sandbox.

The public namespace is:

```text
flow issue validate <plan.yaml>
flow issue doctor <issue-url> --plan <plan.yaml>
flow issue run <issue-url> --plan <plan.yaml> --provider <provider> --model <model>
flow issue inspect <run-id>
flow issue events <run-id> [--after <sequence>] [--limit <count>]
flow issue resume <run-id>
flow issue cancel <run-id> --actor <label> [--reason <text>]
flow issue merge <run-id> --actor <label> --expected-pr <number> \
  --expected-head <40-lowercase-hex> --expected-gate-digest <sha256>
```

Run, resume, cancel, and merge accept an optional idempotent command identity where a repeated
operator request could otherwise be ambiguous. The CLI does not accept raw Git, `gh`, API, shell,
executable, environment, repository, branch, pull-request, or merge arguments outside the
validated plan and frozen issue identity.

### Authority boundary

- The plan is trusted operator configuration. Issue bodies, comments, repository content, provider
  output, review text, and hosted-check text are untrusted data.
- The host controller resolves exact Git and GitHub CLI executables and invokes fixed argument
  arrays without shell parsing.
- GitHub credentials remain inside the GitHub CLI credential boundary. They never enter a prompt,
  workflow environment, command sandbox, process argument, ledger, or public error.
- The model cannot select or change the repository, base branch, branch name, pull request, merge
  method, verification command, hosted-check set, or delivery operation.
- Merge is a separate operator action bound to the exact gate. The run command always stops before
  merge.

This is a narrow, medium-system-authority extension of Approach A, not a generic connector system.
Model authority remains low and unchanged.

### Lifecycle

```text
preflight
  -> issue_frozen
  -> workspace_prepared
  -> implementing
  -> verifying
  -> reviewing
  -> publishing
  -> waiting_for_ci
  -> merge_approval_required
  -> merging
  -> merged
```

`failed`, `cancelled`, and `external_state_uncertain` are terminal or recovery states reached only
through defined transitions. Every external mutation has a durable prepare event before execution
and a settlement event after an exact observation. A prepared-but-unsettled effect is reconciled
against local or remote identity before it can be retried.

The candidate commit is an `implementing` effect and must settle before verification. Publication
then settles the push, creates the pull request with `isDraft: true`, and uses a distinct
`pull_request_ready` effect to observe the same exact pull request with `isDraft: false`. Only that
ready identity can proceed to hosted checks.

After first publication, a candidate repair preserves that pull request's number, node ID, head
branch, and base branch. Repaired publication settles a replacement push and observes the same pull
request as ready at the replacement head. It does not create a second pull request.

### Frozen identities and evidence

Before repository mutation, the run binds:

- GitHub host and canonical lowercase `owner/name` repository identity, including a valid
  dot-prefixed repository name such as `.github`;
- issue node, positive safe integer number, state, content digest, and updated timestamp;
- configured base branch and exact commit observed at its remote qualified ref;
- complete frozen-contract, plan, implementation template workflow, review template workflow,
  verification command, holdout, and budget digests;
- derived Flow-owned branch name; and
- an idempotency identity for the run.

The derived Flow branch must differ from the frozen base branch. GitHub node IDs are bounded to 256
characters and cannot contain Unicode whitespace, control characters, or format characters.

The merge gate additionally binds the pull request's positive safe integer number, bounded node ID,
exact head and base branches, exact head and observed base commits, merge method, implementation
and review nested-run IDs, execution workflow digests, terminal sequences, evidence, deterministic
verification evidence, exact-head review evidence, required-check run
identities and conclusions, comments, reviews, unresolved threads, and the gate creation sequence.
Each check-run ID and source GitHub App ID is a positive safe integer. Each required hosted check is
bound to its name and source GitHub App ID and canonical slug, and the observed requirement set must
match that trusted set exactly. Any bound-state change invalidates the gate and requires a new
review, verification, and operator approval.

The implementation workflow's compiled `goal.criteria[].id` values are the only authoritative
acceptance-criterion IDs. Issue prose remains untrusted context and cannot replace that closed set.
The merge gate records the `deleteBranch` policy. The applied merge result and terminal receipt
record that policy as `deleteBranchRequested` and record the observed repository state as
`branchDeleted`. The request must match the policy. A requested deletion requires an observed
deletion, but GitHub repository settings can delete the branch when Flow didn't request deletion.

### Verification and review

The untouched base must fail the frozen behavioral holdout. The candidate must have a nonempty,
task-relevant diff, pass that holdout, and pass all configured deterministic checks. This prevents a
pre-existing green repository from being mistaken for successful implementation.

A fresh read-only reviewer receives the exact candidate diff, frozen issue contract, and bounded
verification evidence. Review has two stages:

1. Map every acceptance criterion to implementation and evidence.
2. Review security, correctness, performance, reliability, maintainability, tests, and
   documentation.

P1, P2, and P3 findings block publication or invalidate the merge gate. Model review remains
probabilistic and cannot replace the explicit merge action.

### Initial compatibility boundary

- One `github.com` repository with an `origin` remote.
- A clean, attached source checkout and a Flow-owned isolated worktree.
- A branch in the configured Flow-owned prefix.
- One pull request for one issue and one head commit at a time, created as a draft and then made
  ready through a separate effect.
- A nonempty set of required GitHub Actions checks, each identified by its name and source app ID
  and canonical slug.
- Squash merge or another explicitly enumerated method supported by the plan schema.
- No fork pull requests, merge queues, auto-merge, administrator bypass, or branch-protection
  bypass.

## Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Operator cookbook | No new product authority; fastest documentation path | Flow does not own recovery, review, CI, or merge; fails the requested end-to-end outcome | Rejected |
| Host-owned GitHub controller | Preserves the model sandbox; gives the CLI one durable, bounded lifecycle | Adds narrow GitHub write authority and a second lifecycle ledger | Approved |
| Generic connector or external-effect nodes | Generalizes to many forges and services | Expands credentials, network, protocol, policy, and compatibility scope before usability is proved | Deferred to Approach C research |

## Non-goals

- Generic connectors, workflow-level network nodes, arbitrary host commands, or an SDK.
- Model-held network, credential, Git, pull-request, CI, review, or merge authority.
- Autonomous repair selection, autonomous approval, autonomous merge, `--admin`, or auto-merge.
- Fork-based pull requests, merge queues, GitHub Enterprise, multiple remotes, non-GitHub forges, or
  cross-host recovery in the first release.
- Secret, issue-body, comment, review-text, provider-content, command-output, or absolute-path
  disclosure in public inspection.
- A general-readiness claim from one successful repository, language, provider, model, or task.

## Failure modes

- **Invalid plan, URL, or repository identity** — Fail before mutation with a stable public code.
- **Dirty or detached checkout** — Fail before branch or worktree creation.
- **Missing Git, GitHub CLI, authentication, permission, provider, or sandbox** — Fail preflight
  without mutation and give one recovery action.
- **Closed, transferred, changed, or repository-mismatched issue** — Reject the run before mutation.
- **Base movement** — Re-freeze only before implementation starts; fail closed afterward.
- **Implementation, holdout, verifier, or review failure** — Preserve the exact workspace and
  evidence; do not publish or merge.
- **Branch or pull-request collision** — Reconcile only an exact prepared identity; otherwise fail.
- **Lost commit, push, pull-request creation, readiness, or merge acknowledgement** — Enter
  `external_state_uncertain`; inspect exact identities before settling or retrying.
- **Pending, skipped, missing, failed, changed, or timed-out hosted check** — Do not open a merge
  gate. Resume from the durable observation cursor.
- **Changed head, base, issue, check set, review, comment, thread, mergeability, or merge policy** —
  Invalidate the merge gate and require new evidence and approval.
- **Cancellation after publication** — Record cancellation and leave visible remote state intact.
- **Crash or torn ledger tail** — Replay only complete durable events; repair the final partial line
  under the established single-owner protocol.
- **Merge queue or unsupported repository policy** — Fail as unsupported; never enable implicit
  auto-merge or bypass.

## Verification map

| Criterion | Verification | Passing evidence |
| --- | --- | --- |
| Plan and identity admission | Schema and domain tests | Unknown fields, duplicates, invalid URLs, noncanonical repositories, invalid numeric or node IDs, equal base and candidate branches, mismatches, and drift reject before mutation |
| Lifecycle durability | Reducer and filesystem tests | Legal transitions replay; illegal order, torn tails, competing owners, and prepared effects fail closed |
| Authority boundary | Unit, integration, and runtime tests | Model environment omits credentials; sandbox denies network and `.git`; output cannot choose host operations |
| Negative control | Real temporary repositories | Untouched base is known-red, candidate is green, and an already-green base rejects |
| Deterministic verification | Process-backed tests | Exact argv, timeout, exit, bounded output digest, and candidate commit bind every result |
| Independent review | Review schema and stale-head tests | Acceptance mapping is complete; P1/P2/P3 block; candidate mutation invalidates review |
| Durable publication | Git and GitHub adapter integration tests | The implementing commit, publication push, draft PR creation, and distinct ready transition reconcile without duplicate effects |
| Hosted CI | Deterministic GitHub fixture and live checks | The observed checks equal the trusted `{name, sourceApp: {id, slug}}` requirement set exactly; run IDs, conclusions, and head commit match the gate |
| Merge authorization | Digest, drift, and acknowledgement-loss tests | Exact operator values are required; every bound change invalidates; approved commit is proved merged |
| Public inspection | Projection and CLI tests | Status, bounded identities, digests, counts, and recovery are useful and content-free |
| Installed package | Packed-archive runtime test on Linux x64 | Installed `flow` validates, runs, restarts, gates, merges, and inspects the offline lifecycle fixture |
| External proof | Fresh frozen issue in another repository | Implementation, review, local checks, hosted checks, exact approval, merge, and post-merge reachability pass |
| Documentation | Command/example validation and documentation gates | Guide, specification, operations, architecture, roadmap, status, compatibility, and field report agree |
| Full release gate | Local and hosted CI | Formatting, lint, type checks, tests, build, runtime, package, docs, and dependency checks pass |

Every failed or incomplete attempt, harness change, operator intervention, cost, and duration remains
in the acceptance denominator.

## Policy-decision calibration for the issue 6 rerun

The operator approved one per-agent `policyDecisionLimit` with a compatibility default of 64, a
hard maximum of 128, and a 96-decision override for
`repair-detector-integration-convergence`. These values are provisional Flow controls, not an
industry standard.

Primary-source comparison found materially different units and defaults: OpenAI Agents SDK uses 10
model turns by default, CrewAI uses 20 agent iterations, AutoGen leaves team turns unlimited unless
configured, OpenHands SDK uses 500 iterations, LangGraph uses 1,000 graph super-steps, and DeepSeek
Harness Ralph uses 256 fresh-agent rounds. Claude Agent SDK exposes a configurable turn limit
without a comparable public default. None counts Flow's individual authorization decisions, so the
numbers cannot be transferred directly.

The failed issue run recorded 64 allowed decisions, 65 tool calls, 16 committed effects, 44 turns,
and 406,712 milliseconds in the convergence node before the 65th decision failed closed. The
frozen workflow gave that node 900,000 milliseconds, so a prior 600,000-millisecond extrapolation
was rejected as incorrect. The 96 override supplies 50% headroom over the compatibility default;
128 remains a 2× explicit ceiling. A 96-decision exhaustion must produce new evidence and a new
design decision. It doesn't authorize an automatic increase.

The implementation keeps omitted workflow bytes unchanged for digest compatibility. Live execution
and replay resolve omission to 64. Only an explicit override enters the compiled workflow and,
when non-default, forces a persisted control graph. The model receives the effective value, and
audit exhaustion remains fail-closed.

## Provider-response calibration for the issue 6 rerun

The preserved issue 6 model-session ledgers contain 639 settled messages with positive output-token
usage. The base `z-ai/glm-5.3-flash` route contributed 318 messages: mean 2,306.6, median 350, 90th
percentile 4,851, 95th percentile 7,511, 99th percentile 35,469, and maximum 50,718 output tokens.
Eleven messages exceeded 16,384 tokens, eight exceeded 24,576, and six exceeded 32,768.

The `z-ai/glm-5.3-flash:nitro` route contributed 321 messages: mean 1,194.4, median 421, 90th
percentile 3,646, 95th percentile 4,973, 99th percentile 8,012, and maximum 19,615 output tokens.
One message exceeded 16,384 tokens; none exceeded 24,576. This is observational evidence from the
bounded pilot, not a controlled model-quality comparison. The routes ran different attempts and
repository states, so route choice isn't the only possible cause of the distribution.

The latest failed attempt strengthens the need for a response boundary but doesn't prove one exact
value. Its installer and incremental-detector nodes settled, including one 15,235-token response.
The state-integrity node then reached its 20-minute timeout during request 5. That request had no
settled usage, so its eventual output length and provider cost are unknown. A timeout alone can't
show whether the provider was generating, stalled, disconnected, or finishing an unusually long
reasoning path.

For the next issue 6 run, use the `:nitro` route and set each agent node to
`maxOutputTokens: 24576`. This cap covers every observed settled `:nitro` response and about 97.5%
of the observed base-route responses. Set model verifiers to `8192` because they return a strict,
small JSON verdict; that verifier value is a conservative interface bound, not a percentile-derived
model standard. Keep the existing run-wide token, cost, time, artifact, policy-decision, effect,
and path controls unchanged unless separate evidence justifies a change.

The rejected alternatives were an unlimited catalog maximum, a static upstream-provider pin, and
a timeout increase by itself. The catalog maximum allowed a single request to inherit GLM's
131,072-token output capacity. OpenRouter's endpoint response exposed no current latency or
throughput samples for the eligible upstreams, so a hardcoded provider wasn't evidence-based. A
larger timeout could increase both cost and uncertainty without creating a settled recovery
boundary.

Flow therefore adds an optional, digest-bound per-node response cap. A provider `length` stop is
retryable only through the existing fresh-recovery contract with a complete durable model session,
settled effects, sufficient attempts, and complete usage required by the run budget. Timeouts,
cancellation, lost responses, unknown effects, and exhausted budgets remain nonretryable. This
design can add another charged request after a capped response, so it trades bounded individual
tails for possible retry cost; the aggregate workflow budget remains the controlling backstop.

The workflow schema accepts a positive safe integer instead of inventing a model-independent hard
maximum. The selected model's pinned output capability is the effective ceiling, and Pi applies the
smaller value. This keeps numeric identity exact while allowing a future catalog update without a
Flow schema migration. It doesn't make a value above the selected model's capability meaningful.

### Outcome of the capped `:nitro` rerun

Run `issue-8c53ad3c-fa7f-4837-88d2-b8b0abcce8cf` reached 14 of 20 implementation agent nodes before
the `repair-installer-initialization-semantics` node exhausted its three attempts. The run preserved
one settled outer preparation effect and a complete nested event ledger; it made no source changes
in the operator checkout.

The node's first attempt read two authorized files, then settled at exactly 24,576 output tokens
with provider stop reason `length`. Its second attempt used the durable resume surface and again
settled at exactly 24,576 output tokens with no tool calls or visible report. The third attempt
prepared the next digest-bound request, then failed in 93 milliseconds with zero reported usage.
The first two failures were `pi_agent_incomplete`; the last was `pi_agent_error`. All three were
side-effect-free for this node. The attempt ceiling then stopped the run.

This result falsifies two earlier assumptions. First, the prior `:nitro` sample maximum of 19,615
didn't predict the next run: two later responses reached the new cap. Second, a durable resume
surface doesn't imply that an output-limited response made portable progress. Flow intentionally
doesn't retain provider-private reasoning or partial streams, and both limited messages had empty
portable text. Raising the token cap or adding output-continuation attempts would therefore spend
more without evidence that this route would converge.

Keep `maxOutputTokens: 24576`, the three-attempt recovery ceiling, and the aggregate workflow
budgets. For the next clean run, select the base `z-ai/glm-5.3-flash` identifier instead of
`:nitro`. OpenRouter applies Auto Exacto automatically to tool-calling requests and ranks eligible
providers using throughput, tool-call success, and benchmark signals. The `:nitro` suffix
explicitly prioritizes throughput and overrides that quality-first ordering. This route change is
an evidence-driven pilot variable, not a claim that one route is universally superior. Preserve
the failed run in the final acceptance denominator.

### Outcome of the base-route rerun

Run `issue-c5fe72dd-55a8-464c-aa45-9a4d467102eb` selected the base
`z-ai/glm-5.3-flash` route. It completed the first ten implementation nodes on their initial
attempts, including the earlier state-integrity timeout regression and the public installer repair.
One state-integrity response settled successfully at 16,960 output tokens, which confirms that the
24,576-token cap leaves useful headroom for long but productive turns.

The next `repair-detector-noop-performance` node read its two authorized files, then its second
request settled as a retryable provider error after about 6.2 minutes. Attempt 2 settled as another
provider error after about 19.3 minutes with zero reported usage. Attempt 3 reached the exact
1,350,000-millisecond node timeout with zero reported usage. All three attempts were
side-effect-free for that node. Flow recorded both retry dispositions, stopped at the configured
attempt ceiling, and preserved the isolated candidate and failed outer run.

This result doesn't identify one upstream endpoint or prove that Auto Exacto caused the failures.
The failed streams supplied no settled endpoint identity, and provider availability can change
between requests. It does prove that the base route didn't satisfy this workflow's end-to-end
reliability requirement. The response-token cap and a node timeout also control different risks: a
stream can remain active through provider-private progress until the node timeout without ever
settling a model message whose output usage Flow can inspect.

The next run returns to `z-ai/glm-5.3-flash:nitro`, which previously completed the large-context
no-op repair. It keeps the 24,576-token response cap and three-attempt ceiling. It splits the later
mixed installer-initialization repair into one product-contract node and one focused-test node,
each with separate authority, evidence, and recovery history. This choice addresses both observed
failures without increasing a token, attempt, cost, or time limit. Preserve both failed runs in the
final acceptance denominator.

## Final external-pilot outcome

Run `issue-ef297140-9756-4dc5-92f0-4017a4bd5f07` completed the lifecycle at frozen base
`99fb83a14e589fe7137b6f6cf3eac97b8535be0f`. The private holdout and frozen commands passed for
candidate `c54b8105ea8c79c37be1ff4280f3b9163ca4cda4`. A fresh read-only review reported no blocking
P1, P2, or P3 finding. GitHub pull request 105 passed its required `test` check on the exact head.

The run then stopped at merge gate
`f52e4a0f298a5b87164f086267e242d06a649cba99b638f33a432fe9227f0064`. A separate CLI command
approved that exact pull request, head, and gate. Flow observed squash-merge commit
`374b16b229e187004e5915942f95c296af03298f`, branch deletion, and issue closure before recording
the terminal `merged` phase.

The complete series contains 52 full parent runs. Its nested implementation and review evidence
reported 247,516,376 aggregate tokens, including cache tokens, `$10.094325` in model cost, 9,429
turns, 10,590 tool calls, and 2,532 settled filesystem effects. The
[issue 6 field report](../docs/field-reports/digital-twin-issue-6-alpha4.md) owns the complete run
and correction ledgers, interventions, limitations, and exact evidence.

This proves the source-built controller on the named macOS host and the candidate's hosted Linux
x64 check. It does not prove that the older published alpha.4 package contains `flow issue` or that
the controller itself ran on hosted Linux x64. Exact package qualification and a separately
authorized prerelease remain release gates.

## Recovery correction from the final series

The final series showed that a completed provider failure can occur after a raw `exec` command has
fully settled. Categorically rejecting recovery repeats expensive model work even though Flow has
the closed model session, command request, command result, and process evidence.

Allow continuation only when every command is settled, process termination is confirmed, every
workspace edit is committed, the exact model session closes without a mismatch, no delegation ran,
the latest-attempt raw-exec result count equals the command-ledger count, the provider failure is
eligible, and budget remains. The next attempt consumes the recorded tool result and does not replay
the command. Keep interrupted, open, unconfirmed, package-provided, or otherwise uncertain commands
ineligible.

Deferred improvements remain separate research items: provider-request timeouts distinct from
whole-node timeouts, trajectory and useful-effect telemetry, retry labels that distinguish a fresh
model context from a preserved dirty workspace, and provider-specific compaction or overflow
recovery. None is required to accept the proved candidate, and none gains authority from this
decision.

### Outcome of the split-node `:nitro` rerun

Run `issue-676b6dd2-9aba-4b1d-86ae-f09ca73172f7` completed its first 16 of 21 implementation
agent nodes on their initial attempts. This included the formerly failing no-op performance node
and both halves of the installer-initialization split. The split therefore resolved the observed
output-limit failure without increasing response, attempt, time, or aggregate resource bounds.

The next runtime/performance convergence node made five completed model requests and proposed one
edit, but the edit tool returned an error before any durable effect was prepared. Request 6 then
settled as `pi_agent_error`. Fresh attempts 2 and 3 failed after about 10.6 seconds each with zero
usage and no side effects. The run stopped at the existing three-attempt ceiling. It preserved the
portable history, exact request identities, complete resource accounting, and a side-effect-free
terminal failure.

The evidence doesn't disclose the upstream response, so it cannot distinguish an account/request
4xx from a transient 429 or gateway failure. It does prove that Flow's fixed public taxonomy was
too coarse: a permanent provider rejection and a transient availability failure both became the
same retryable `pi_agent_error`. Blind node-level backoff is rejected because Pi already retries an
OpenRouter request up to six total transport attempts with exponential delays. Another generic
retry layer would multiply traffic and cost without classifying the failure.

Classify bounded provider HTTP status evidence into fixed Flow-owned codes. Authentication,
payment/quota, and request-rejection statuses are nonretryable. A 429 or documented transient
timeout/gateway/server status remains retryable when the node's ordinary effect and resource gates
allow recovery. Keep raw provider text, credentials, and nested causes private. Rerun only after the
selected provider credential is restored and `flow issue doctor` passes.

## September 7, 2026: no-input admission process race

Hosted CI run `34104676944` at `c99836b` failed one of 6,687 quality tests. The failing
production lifecycle test was `binds two repair cycles to fresh reviews and publishes only the
final candidate`. Git admission returned `command_failed` before implementation. Dependency
audit passed. The proof-runtime job was still running when this correction was prepared.

The retained failure does not include the Git subcommand, native error, exit status, or signal.
The failing admission files were unchanged from qualified source `544aebc`. These observations
do not establish the historical cause, and a passing rerun cannot establish it either.

An independent real-process experiment confirmed a defect in `runStrictReadProcess`.
Calling `child.stdin.end("")` can emit `EPIPE` after a successful no-input child has closed stdin.
The existing handler then reports `command_failed`, despite the child's zero exit status.
Without a scheduling delay, 100 `/usr/bin/true` calls passed. With delayed parent delivery,
10 of 10 failed incorrectly. A real Git admission probe reproduced the same error in two of
three delayed calls. Omitting the empty payload passed all 10 counterfactual calls.

Close stdin without a payload when input is absent or empty. Preserve byte-exact nonempty input
delivery and the existing rejection of genuine input errors, nonzero exits, timeouts, and aborts.
This is a narrow process correction, not verification-failure repair or permission relaxation.
Node's [writable stream contract](https://nodejs.org/api/stream.html#writableendchunk-encoding-callback)
distinguishes closing a stream from providing an optional final chunk.

The regression suite uses real subprocesses and a readiness marker to order child stdin closure
before parent delivery. Its spawn wrapper controls scheduling only, not outputs, exits, or errors.
Before the correction, the absent-input and empty-input tests failed and five safety tests passed.
After the correction, all seven passed. Independent review found no P1, P2, or P3 findings and
passed all 55 tests across the regression and existing Git/GitHub admission suites.

Type checking, lint, formatting, compilation, documentation style, local documentation links,
changed-prose checks, and whitespace checks passed. Lint retained one pre-existing informational
constructor suggestion outside this change.

The first local production lifecycle rerun stopped at a sandbox-denied loopback listener
(`listen EPERM`), not Git admission. The permitted rerun exceeded its unchanged 240-second test
timeout while compilation also ran. Neither result is a passing lifecycle check. A standalone
rerun started after compilation finished, with the original timeout. Read-only inspection found
substantial cumulative Git, subprocess, and durable-write work, but no proven timeout cause.
The standalone rerun passed in 178.51 seconds of test execution (187.77 seconds total).
It selected one test and skipped the other ten. This does not erase the preceding timeout or
establish its cause. No timeout or production resource limit changed.

The new verification-repair proposal remains unapproved. No new pilot, temporary credential,
candidate edit, publication, or merge is authorized by this correction. Updated package bytes
must be qualified again before they can inherit any installed-package success claim.

### Broader verification after the admission correction

Hosted run `34104676944` at `c99836b` completed. Dependency audit passed, and the proof-runtime
job verified appliance image `sha256:73559bb7a6d90c71601661ff13e82e59e1efa7ba05db22b5fb3e619f7e146a73`.
All four proof tests passed in 92.41 seconds of test execution. Quality retained its admission
failure. The complete run therefore failed; the successful proof job does not qualify the newer head.

After that run became terminal, both reviewed commits were pushed through `1a841be`. Fresh hosted
run `34111318839` started on that exact head. PR 201 remains draft and unmerged. Its description
distinguishes the incremental correction, incomplete full verification, and unapproved repair design.

The full local single-worker coverage run at `1a841be` terminated with exit code 137 and no final
report. Before termination, it reported four failures in `local-issue-verification.test.ts` and
one in `local-effective-harness-store.test.ts`. No complete test count or coverage result is available.
The saved Vitest cache predates this run and cannot substitute for its missing result.

The four verification/review tests took approximately their explicit 20-second test limits.
The storage test, which prepares 256 distinct artifacts, took approximately the runner's
five-second default. These observations suggest investigating test deadlines, but do not prove
timeout errors or identify the cause of termination. Independent tracing excludes the changed
`strict-read-process.ts` from the four verification/review test paths.

The known process was absent after termination. The host reported 16 GiB of physical memory and
20,419.12 MiB of used swap at the subsequent observation. A kernel-log query for the known process
identifier returned no matching event. Neither exit code 137 nor the swap observation alone proves
an out-of-memory kill. Do not classify this as a successful suite or silently discard its failures.

One diagnostic rerun selects only the five reported failing tests, retains coverage and their
original timeouts, and requests verbose output. No full-suite restart, production-limit change,
candidate mutation, or model call is part of that diagnostic. Hosted qualification remains open.

The bounded diagnostic completed: four tests failed explicitly at their test watchdogs, one passed,
and 42 were not selected. Replay, ordinary diff capture, and the 128 KiB case hit 20 seconds.
The physical-artifact inventory case hit the default five seconds. The 32 KiB case passed in
18.85 seconds. This identifies test-deadline failures, not the cause of the earlier exit 137.

Choose the existing narrow watchdog policy from `uc08-command-discovery.md` and commit `4ed4a64`.
The four observed Git cases inherit their enclosing 30-second suite watchdog instead of overriding
it with 20 seconds. The specific 256-artifact case receives the same finite watchdog. No assertion,
fixture size, production deadline, model budget, coverage threshold, or runtime limit changes.
The alternatives were an unchanged-limit run on a recovered host, which leaves timing sensitivity,
or fixture optimization, which has a larger isolation and correctness review scope. Thirty seconds
is repository precedent, not an optimal duration or a guarantee for arbitrary host conditions.

The same five covered tests then passed. Their test durations were 17.835 seconds for replay,
15.144 for ordinary diff capture, 17.420 for the 32 KiB case, 19.175 for the 128 KiB case, and
9.350 for physical-artifact rejection. The Git cases happened to finish below their former limits
in this run; do not attribute their shorter durations to the watchdog change. The storage case
completed its unchanged assertions beyond its former five-second watchdog.

This diagnostic selected five tests and skipped 42. Its command exited 1 because those five tests
do not meet the unchanged repository-wide coverage thresholds. Its 6.01% statement coverage is
not the full suite's coverage, a new baseline, or a successful coverage gate. Both complete affected
files and static checks remain required before committing the watchdog correction.

Independent review found and corrected a P3 comment error: the replay contains a partial failed
attempt followed by one complete retry, not two complete verification passes. Rereview found no
remaining P1, P2, or P3 findings in the watchdog diff. Keep all failed and interrupted runs recorded.

The complete affected-file run then passed all 47 tests across both files, with no skipped tests.
It took 218.07 seconds of test execution and 220.28 seconds total. Formatting, lint, type checking,
and compilation passed in the same serialized verification chain. Lint retained its existing
informational constructor suggestion. This is affected-file verification without coverage, not
a replacement for the interrupted full coverage run or fresh hosted qualification.

The broader PR review stops at specification compliance. Issue 197 explicitly requires an installed
package to complete a previously unhandled external issue through hosted Linux x64 merge and
post-merge verification. All five issue 106 attempts remain unsuccessful at that criterion.
The source-built issue 6 result and offline installed lifecycle tests cannot replace it.
Therefore, the incremental correction can be committed after its checks, but PR 201 remains draft
and is not ready for approval or merge. The unapproved verification-repair proposal remains separate.

### Preapproval verifier reuse assessment

Read-only source inspection at `ee371db` reassessed existing containment before proposing new
infrastructure. This work does not approve VR-01, implement VR-02, enable repair, or authorize
another candidate or model run. Hosted run `34111318839` remained live during the assessment.

The main thread traced issue verification through `CommandNodeExecutor` and both command sandboxes.
An independent agent traced the Lean proof driver, supervisor, domain decision, and runtime tests.
The main thread then inspected the cited implementation paths. Primary Linux process-namespace
and Docker security documentation cross-checked the operating-system assumptions.

- `srt-command-sandbox.ts:1149–1184` validates a private Linux PID/user namespace, capability drop,
  and `/proc` mount. The pinned sandbox dependency also emits these controls. This is a reusable
  candidate boundary, not a qualified verifier-result producer.
- The macOS dependency's `macos-sandbox-utils.js:285–289` restricts process information, signals,
  and task-port access to the same sandbox. Flow's `process-group` label describes execution
  containment and cannot alone establish or refute verifier isolation on macOS.
- `command-node-executor.ts:248–292` captures the launched command's standard streams and process
  outcome. Putting a new structured marker in those streams does not make its producer trusted.
- `local-docker-container-command-engine.ts:790–841` uses private process isolation, no network,
  restricted mounts, no new privileges, dropped capabilities, and resource controls. An adapter
  still needs its own producer, file, descriptor, fixture, and classification proofs.
- `proof-container/cmd/flow-proof-supervisor/main.go:94–177` runs compiler work as the reduced
  proof user and emits the supervisor's result separately. Lines 304–343 lock and freeze compiler
  artifacts. Lines 420–485 keep pinned checker execution privileged within the appliance.
- The same supervisor's lines 187–208 classify missing modules, permission failures, and resource
  errors within compiler rejection. That verdict is not behavioral-repair authority.
- `local-lean-proof-driver.ts:204–277` records intent, inspects effective container identity, and
  confirms cleanup. `lean-proof-verification.ts:398–406` requires cleanup before acceptance.
  These patterns can inform new accounting without supplying its missing verification reservation.
- `process_linux.go:20–40` removes one process group. It is not proof that a new-session descendant
  cannot survive into another verification stage. Complete-container cleanup remains a separate
  boundary. This assessment did not demonstrate an escape or qualify arbitrary adversarial code.

The proposal now records these reuse limits. No runtime tests, new host configuration, dependency
change, candidate execution, or model transmission was part of this assessment. VR-02 still needs
real adversarial containment tests for the actual future adapter and each supported host profile.

Independent delta review found no P1, P2, or P3 findings. Documentation style, local links,
changed-prose checks, and whitespace checks passed. This is reviewed design evidence, not runtime
qualification or approval to enable the proposed recovery scope.

### Approach B verification-repair approval and VR-02 entry

On September 7, 2026, the user explicitly approved `docs/bounded-verification-repair-design.md`
Approach B, including limited feedback disclosure and mandatory verifier-isolation qualification
before enabling repairs. This is new authority after the fifth pilot, not a reinterpretation of
that pilot's consumed approval. VR-01 is complete. VR-02 is in progress. VR-03 through VR-05 remain
pending. VR-06 still requires a separately authorized experiment. Retained candidates, model
transmission, merge, and release remain outside this implementation approval.

The preceding exact-head run `34117070990` completed successfully at
`fcc97fc6251439868671acf4b0761dcd86fe268e`. Quality passed 6,694 coverage tests in 468 files,
two browser tests, and 82 runtime tests. Coverage was 85.04% statements, 79.94% branches,
92.53% functions, and 85.63% lines. Four Lean tests were skipped in the quality job and passed
without skips in the separate proof job. Proof execution took 100.18 seconds, with 103.10 seconds
total test duration. Dependency audit passed. The verified appliance image was
`sha256:73559bb7a6d90c71601661ff13e82e59e1efa7ba05db22b5fb3e619f7e146a73`.
These results do not establish the proposed observer's isolation or complete UC-01.

Implementation starts by tracing the production native sandbox and command executor. Independent
agents inspect the process/filesystem boundary and challenge the trusted-observer design. The
first real probes use disposable fixture processes and synthetic canaries, not credentials or
retained target candidates. Classifier authority remains outside candidate stdout and stderr.
Repair selection stays disabled until the complete adapter and claimed host profile are qualified.

### VR-02 native process-survival reproduction

Two bounded production-native runs on Darwin ARM64, Node 26.7.0, and SRT 0.0.70 failed the ordinary
and new-session descendant prerequisite. Session 92890: two failures, one pass, 2.652 seconds of
test execution and 11.43 seconds total. Session 58231: the same two failures and one pass,
2.952 seconds of test execution and 9.70 seconds total. Each child established a live heartbeat
and exact host-process identity before its parent was released. Command execution then reported
success while heartbeat growth and the owned process remained observable. The private verifier
file, symlink, and open-descriptor case passed. These are prerequisite probes, not adapter qualification.

An independent reviewer confirmed the Darwin failures' validity and found a separate P2 Linux
test expectation: candidate-visible writes to a private masking filesystem need not imply a host
write. That expectation was corrected while retaining mandatory host canary and absence checks.
The correction does not change the Darwin expectation. All four observed helper processes were
absent in a separate permitted `ps` observation after cleanup. No unrelated process was signaled.

Source corroborates the normal-exit mechanism: `CommandNodeExecutor` calls
`waitForProcessTreeExit` without normal-tree confirmation, whose default is false. Enabling that
flag alone would not contain detached new-session descendants. Official Node process documentation
and the Linux PID-namespace manual independently distinguish those lifetimes. The existing
container-command factory uses Linux `/proc` owner records, so Mac Docker availability alone is
not a qualified alternative.

The mandatory gate requires a host-support decision before enabling repairs. Recommend native
Linux qualification first, with explicit unavailability for native Mac repair. Alternatives are
a Linux-hosted controller appliance accessible from Mac, or stronger native Mac containment first.
No profile is selected and Linux has not passed the new probes. The user received these three
options through the structured question tool. No additional pilot or model transmission occurred.

The candidate observer design also retains a separate unresolved control: a permission-only
assertion cannot classify the absent base CLI's generic nonzero exit as a behavioral negative
control. Define and qualify that observation explicitly; neither approval nor stderr parsing
supplies its missing proof.

After the Linux-only test expectation correction, session 89007 reproduced both Darwin failures
again and passed the private-file/descriptor case. Test execution took 2.774 seconds, with
13.05 seconds total. The final probe file passes focused formatting and lint. The full typecheck,
lint, and format chain completed successfully; lint retains its pre-existing informational
constructor suggestion. Documentation style, links, prose, and whitespace checks passed.
Runtime qualification remains failed, so the new probe file is retained uncommitted rather than
represented as a passing feature. No production code was changed.

### Approved Linux-first qualification and Mac-local usability path

The user accepted the recommendation to qualify the Linux runtime on GitHub Actions first,
then deliver a tested Mac-local Linux launcher and environment. The operator can remain on macOS.
This closes the host-strategy decision, not VR-02 qualification. Mac-native repair stays unavailable
pending its own proven boundary. Linux ARM64 and x64 evidence must remain distinct.

UC-03 now explicitly owns the Mac-local deliverable: complete controller execution in Linux,
persistent same-host state, repository isolation, credential protection, bounded resource use,
recovery, evidence inspection, and exact-head approval. No virtualization product, deployment
permissions, resource allocation, or credential provisioning is implicitly selected.

The first execution step is a dedicated model-free Ubuntu 24.04 x64 CI job using the production
native sandbox and pinned Node dependency graph. It must fail platform or dependency admission,
not silently skip. The native Mac prerequisite failures remain reproducible through an explicit
diagnostic mode. A default Mac skip for this Linux-targeted suite is not passing qualification.
Existing required CI gates remain intact. No new pilot, model transmission, merge, or release is
authorized by this host-strategy decision.

### Dedicated Linux prerequisite qualification slice

The new `verifier-isolation` job targets Ubuntu 24.04 x64, pins Node 26.7.0 and existing action
digests, disables checkout credential persistence, and requests only repository read access.
It builds the production runtime and executes the exact five-test isolation file. It has no
model credentials, pilot state, conditional execution, or failure masking. The 15-minute job
watchdog bounds this CI task; it is not a model budget or a universal qualification duration.

Three scaffold contract tests failed before adding the job: missing job, job inventory, and
Node-pin count. All 40 tests in the two scaffold files then passed. An independent review
confirmed the job's platform guards, exact focused invocation, and absence of failure masking.

Runtime-test review found and corrected two probe weaknesses before Linux execution. Environment
and descriptor checks now test the owned host PID independently of command-line visibility,
using token and device/inode identity controls. Unconfirmed host-process cleanup now retains
the fixture directory. These changes improve the probe; they do not establish a passing runtime
result. Hosted execution and complete observer qualification remain pending at this checkpoint.

After the final probe corrections, full type checking, lint, formatting, documentation style,
links, prose, and whitespace checks passed. Lint retains its pre-existing informational constructor
suggestion. The production build and the manifest-declared `dist/cli/launcher.js --help` smoke test
passed. An initial smoke invocation used a nonexistent `dist/cli/index.js`; this operator command
was corrected from the package manifest without changing source. The default macOS runtime invocation
reported all five Linux-targeted tests skipped, explicitly not qualification evidence.

### First hosted native Linux prerequisite result

Run `34128675526`, job `101763285298`, passed at exact source
`fd8cf95dd6af3d910f120308fa1ab97930f7c472`: one test file, five tests, no skips, 1.37 seconds of
test execution and 3.75 seconds total test-runner duration. Environment: Ubuntu 24.04 x64,
kernel `6.17.0-1022-azure`, Node 26.7.0, bubblewrap 0.9.0, SRT 0.0.70. The completed job API and
its log independently confirmed the result. The ordinary and new-session descendant checks both
passed, unlike the retained Darwin diagnostics. Private file, descriptor, host-process, and forged
output prerequisites also passed. No model or target-project operation ran in this job.

The overall workflow remains in progress at this checkpoint; dependency audit passed, while
quality and Lean proof remain pending. The PR body was updated to remove stale new-head pass and
approval claims. Complete protected-observer qualification remains open. The next model-free slice
tests immutable fixtures with distinct EACCES, ENOENT, and accessible controls under the actual
candidate sandbox. No repair-selection path is enabled by these prerequisite results.

### Immutable fixture qualification preparation

The next slice adds three Linux-only, real-process fixture probes behind a test-owned decorator
of the existing `runtimeSupportPaths` seam. It does not change authored command authority or add a
production observer. The probes distinguish accessible input, ENOENT, mode-000 files, and mode-000
parent directories. They challenge mutation, aliases, direct remounts, and nested user/mount namespaces.

Independent review required complete fixture-tree identity and inventory comparisons, real namespace
and remount controls, and untruncated command evidence. Those corrections were implemented before
execution. The host control first establishes new user and mount namespaces with private propagation;
only disposable scratch paths are mounted. It proves a read-only write failure followed by a
successful read-write remount. Candidate attempts must fail for actual permission or read-only
reasons, not missing tools. Uncertain execution, cleanup, or fixture identity retains the fixture.

Review also identified a watchdog mismatch: two seven-second version controls could make the total
path exceed the 30-second test watchdog. Version controls now use one second, matching candidate
version checks. The nested candidate probe uses four seconds within the unchanged ten-second command
envelope. Production deadlines and model budgets are unchanged.

The dedicated job now names both suites and reports unshare and mount versions. Its contract failed
before each missing invocation/logging requirement was added, then both scaffold files passed all
40 tests. Full type checking, lint, formatting, build, launcher smoke, documentation, and whitespace
checks passed after the final changes. Focused import organization was corrected and passed.
The local runtime command reported eight Linux-only skips, not qualification. The new fixture
suite and strengthened five-probe evidence assertions still require exact-head hosted execution.

### First closed observer design refinement

Code inspection and adversarial review support a smaller fixed predicate than a general JSON CLI
adapter: trusted EACCES plus complete normal exit zero contradicts `invalid-fails-closed`.
Normal nonzero satisfies only that predicate, without identifying its cause or proving full
acceptance. Unsupported fixture, timing, signal, output, identity, or cleanup evidence stops admission.
Every original deterministic and holdout gate remains mandatory. The design records counterexamples
and preserves legacy behavior, frozen disclosure, and prepublication-only selection.

The baseline control remains separate. Two source inspections matched base
`8dcdd755b22c1cbc04bc56e49c7bef5e9f72aa48` and installer digest
`7a8084ad0e4ef00f12a02bc98b2172f62a6bac0943882b3c4a53035d610c24aa`.
The base registers only install and uninstall. Read-only help probes and Python's argparse reference
corroborate its existing help inventory, not a universal discovery protocol. The selected narrow
qualification approach binds that inventory to audited frozen source. Alternatives are a closed
structural source parser or a separately authorized target discovery interface. No target changes,
new model calls, or new run authority result from this design refinement.

### Cross-stage private-data boundary review

Independent source traces distinguished the existing review path from the proposed verification
repair path. `local-issue-review-evidence.ts` resets and pristine-proves the verification worktree
before returning model context. Verification command postconditions can accept ignored output,
and a failed verification does not itself perform that final reset. The new failure-to-repair
transition therefore needs an explicit reset and disposal gate before model dispatch.

Built-in workspace-limited reads do not prove that an approved command cannot read sibling paths.
The native sandbox's home restriction is not a universal substitute for protecting the issue-owned
verification root, particularly for projects outside home. The design now requires explicit private
path protection, confirmed temporary-storage cleanup, and real cross-stage alias/residue probes.
These are prospective qualification requirements, not a claim of an exploit in the current path.
No production behavior, model authority, or retained target candidate changed during this review.

### Current CI checkout and quality evidence

Quality job `101763285584` passed in run `34128675526`: 468 files and 6,695 coverage tests,
two browser tests, and 87 runtime tests passed. Four Lean tests were skipped in quality because
they belong to the separate proof job. Coverage was 85.04% statements, 79.94% branches,
92.53% functions, and 85.63% lines. The proof job remains in progress at this checkpoint.

The quality and dedicated isolation logs identify checkout
`55023ba6a29fda99f951473b0d6f57e9d9912d90`, GitHub's synthetic PR merge, rather than a direct
checkout of workflow head `fd8cf95dd6af3d910f120308fa1ab97930f7c472`. Independent commit API
reads show both commits have tree `79ef26b968d60d564ce8ee117be0c94a3a84e349`. The source-tree
claim is therefore corroborated, while both commit identities remain recorded. New unpushed
fixture and documentation commits are not qualified by this run.

The next internal observer unit is split into real filesystem fixture ownership and a private
Linux command boundary. Review identified that ordinary nonzero command evidence is conservative
about side effects even after sandbox release. The new boundary must preserve that evidence and
separately witness namespace containment and completed release. Neither helper can supply a
behavioral receipt without the fixed protected probe, exact scope proof, and complete observation.

### Internal observer components and review settlement

The internal immutable-input fixture owns real host files and original descriptors. It checks
permission controls, bytes, identities, and exact inventories without recursive cleanup. Execution
and integrity checks have explicit lifecycle ordering. Concurrent or uncertain execution and
persistent drift retain the fixture. Descriptor-close or cleanup failure prevents a successful-cleanup
claim and preserves any remaining files.
This component relies on its caller to protect the private parent and establish actual settlement.

The internal Linux command helper detaches admitted arguments and path scopes before asynchronous
work, bounds preparation, and uses the pinned production sandbox. It preserves raw command outcomes
and separately records native containment and release. A failed release takes precedence over a
qualification error. Outer capture is not application launch proof or a behavioral receipt. The
helpers are not composed into issue runs, and no repair-selection path is enabled.

Independent code review corrected a cleanup lifecycle gap, descriptor registration and close-error
accounting, release-error precedence, and runtime cleanup after qualification uncertainty. A runtime
watchdog review split deliberate exit 143 and self-SIGTERM into independent cases. Documentation
review corrected an architecture edge that implied an unimplemented connection. No confirmed P1–P3
findings remain in this slice. Release-failure precedence is source-reviewed, not a locally exercised
production failure case.

The two focused local suites passed 40 tests: 28 real filesystem cases and 12 admission/platform
cases. Missing-entrypoint failures were discovery red tests, not behavioral proof. Semantic mutation
controls independently showed that removing byte validation or the verified-reuse guard fails the
fixture tests. The CI command contract failed before adding the third runtime suite, then both
scaffold files passed all 40 tests.

After final fixes, serial type checking, lint, formatting, build, and public capability reference
validation passed. Lint reports one unchanged informational constructor suggestion. The local runtime
invocation skipped all 17 Linux-only tests across three suites. Those skips provide no Linux
qualification evidence. Documentation style, links, clarity, and whitespace remain commit gates.

Bubblewrap 0.9.0 source encodes signal termination as 128 plus the signal number. Its exec-status
channel refers to its immediate child boundary, which is not necessarily the candidate beyond the
SRT shell and seccomp launcher. The design therefore leaves application launch and normal-exit proof
open. No numeric cutoff, replacement launcher, weaker acceptance rule, or new status channel has
been selected. The complete protected observer remains VR-02 work.
