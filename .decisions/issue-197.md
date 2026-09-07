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

### Application result research and pending decision

Independent dependency research located SRT 0.0.70's release source at commit
`44ab607c46f20381aeaf3e22ca0e0151d4c6b29c`. The main agent separately read the upstream C source
and installed JavaScript wrapper. `vendor/seccomp-src/apply-seccomp.c` reduces the worker's kernel
wait status to an exit code or 128 plus signal at lines 637–653. Its worker executes the SRT shell
at line 871, while setup and failed exec use the ordinary failure path. Numeric ambiguity therefore
precedes bubblewrap. The optional observation socket supplies fail-open write-intent telemetry,
not an application-result protocol. Its header is triggered by a pre-exec filter handoff and does
not prove final filter installation or exec succeeded.

The installed x64 helper hashes to
`5c92b0f369a626f5d7cb27d7912cfa882dc26a3690f17cc0016480c5b8b01df7`.
An independent agent matched it to the official tarball and inspected npm provenance identifying
the release commit. The main agent independently matched the installed hash. Neither cryptographic
attestation verification nor a reproducible native build was completed during this read-only research.

The design now compares three alternatives: extend the pinned supervisor, add a separate isolated
supervisor, or retain unsupported terminal outcomes. The recommendation is a narrow extension at
the existing kernel-result boundary, with exact application launch and a protected result protocol.
The user decision is pending. No new protocol, custom binary, dependency version, or sandbox policy
is implemented or selected. Existing approved tests and CI work can proceed independently.

### Local full-suite environment diagnostic

At clean source `1ac5188`, a single-worker non-live full-suite run under the outer execution
sandbox reported 11 failures in `production-github-issue-service.test.ts`. One unchanged selected
case reproduced `IssueLifecycleStoreError("io")` caused by `listen EPERM` on `127.0.0.1`.
Independent source tracing located the ownership witness's ephemeral exclusive loopback listener,
before lifecycle publication. A direct listener control failed with EPERM in the outer sandbox
and succeeded with host permission. Git, model behavior, and the new observer helpers did not
cause that selected failure.

The invalid full run was interrupted with SIGINT after verifying its exact owned process group.
It exited 130 without a complete suite result. The selected diagnostic exited 1 with one failed
case and ten filtered skips. Both failures are retained. The same selected case passed with
local-listener permission and unchanged source: one pass, ten filtered skips, 227.26 seconds of
tests, and 239.99 seconds overall. This confirms the selected environment failure, not a complete
suite pass. The full single-worker non-live suite will rerun with that permission.
No assertions, production limits, ownership checks, or candidate network policy changed.
The testing guide now documents the prerequisite
and safe recovery. Independent documentation review found no P1–P3 findings, and all documentation
gates passed.

The existing PR body was corrected to record the completed hosted quality job and its synthetic
merge checkout. The original Linux workflow was kept active while local commits were prepared.

### Hosted prerequisite workflow completion

Run `34128675526` completed successfully at workflow head
`fd8cf95dd6af3d910f120308fa1ab97930f7c472`. All four proof-runtime tests and appliance verification
passed. Quality, dependency audit, and the five-test isolation job also passed. The actual synthetic
merge checkout and equal source-tree identities are retained in the earlier evidence entry.
The reviewed local commits can now be pushed without cancelling that run. They still require
their own exact-head CI, including the expanded 17-test Linux isolation set. No observer, repair,
installed-lifecycle, merge, or release gate is closed by this prerequisite result.

### Expanded Linux fixture qualification failure

Reviewed head `e826687141de40da13a2a4a6eb54cf1c08dd4cc1` was pushed only after the earlier workflow
became terminal. In new run `34135220621`, dedicated isolation job `101784477466` passed 16 tests
and failed one. The original isolation suite passed five, the internal Linux command suite passed
nine, and the fixture suite passed two of three. The failed assertion at fixture test line 212
expected EACCES but received the synthetic denied-file contents from a nested user namespace.
The preceding checks rejected chmod and mount-bypass attempts. The profile is not qualified.

The job checked out synthetic merge `3d934d6f03d259351d671fabfe93093fac5c469f`.
Independent commit API inspection matched that checkout and the PR head to tree
`12cb8436b4e575786df9f479aed0addfbc25545d`. The recorded host is Linux x64 with kernel
`6.17.0-1022-azure` and Node 26.7.0. Quality and proof jobs remain running, without cancellation.

Independent source review found no fixture mode-restoration defect. The test explicitly creates a
new user namespace and maps the caller to root. Linux documents namespaced DAC-bypass capabilities
over mapped inode ownership. That explains how read-only mounts can block modification without
preserving EACCES, but the exact capability mechanism still requires runtime evidence. The next
diagnostic retains every assertion and records bounded maps, capabilities, identities, and reads
before attempted mutation. No production policy or supervisor mechanism changes. The pending
supervisor decision must address this fixture invariant as well as the application-result gap.

Diagnostic preparation now captures selected capabilities, numeric identity maps, namespace
identities, synthetic fixture ownership/modes, and reads before mutation. Independent review found
no P1–P3 findings. All original behavioral assertions, test counts, deadlines, and cleanup remain
unchanged. Focused Biome validation passed. Pure AST expansion and `vm.Script` syntax compilation
did not execute the candidate: representative 33-byte Linux and 85-byte Mac temporary roots produce
6,909-byte and 7,949-byte outer arguments, below the unchanged 8,192-byte limit. Longer roots are
not qualified by these measurements. Linux execution and final type checking remain pending.

### Existing isolation control and supervisor reuse review

Read-only source review rejected a drop-in outer bubblewrap flag. In version 0.9.0,
`--disable-userns` applies its namespace-local limit and consumes another namespace before executing
the child. The pinned SRT strict profile drops capabilities, then its native helper creates another
user namespace for PID/mount setup. The outer restriction would block that trusted setup.
`--assert-userns-disabled` is a check rather than an enforcement switch. SRT does not expose either
flag, and Flow's current descriptor allowlist rejects them. No flag or capability was added.

Post-setup restrictions and separately provisioned fixture ownership remain possible design
directions, not qualified corrections. Namespace creation and joining, ordinary thread/process
compatibility, and UID/GID mapping invariants need explicit proofs. Existing Prime supervisor
code already inspects kernel signal status and launches with separate credentials. Existing proof
supervisor code verifies isolated identity and containment. Those patterns inform reuse analysis,
but neither is a native verifier adapter or proof of the new result channel. No supervisor or
policy decision has been selected while the pending user decision and runtime diagnostic remain open.

### Authenticated SRT publication provenance

Read-only verification of the public SRT 0.0.70 package succeeded with the existing npm-bundled
`@sigstore/verify` 3.1.1 and `@sigstore/tuf` 4.0.2. A fresh TUF cache supplied trust material;
transparency-log, certificate-transparency-log, and timestamp thresholds were each one. The required
issuer was `https://token.actions.githubusercontent.com`, and the exact required workflow identity
was `https://github.com/anthropic-experimental/sandbox-runtime/.github/workflows/release.yml@refs/tags/v0.0.70`.

The verified signed statement names source commit `44ab607c46f20381aeaf3e22ca0e0151d4c6b29c`.
Its single package subject digest matched the independently hashed 3,784,812-byte tarball:
SHA-512 `3ebd1ddc9dd4c89212c6f1714ce95d7215b76bc3ff9c0662215fa753dc081e85b9626d4f3345c33f3597f26309b175a99d447323ebb739d50b89ab9c619f5eda`.
The extracted x64 helper matched the installed binary:
SHA-256 `5c92b0f369a626f5d7cb27d7912cfa882dc26a3690f17cc0016480c5b8b01df7`.
Explicit subject-to-tarball binding was checked after signed-envelope verification. A different
workflow identity and a modified signed payload were both rejected. Agent session 84986 completed
with exit zero; its raw JSON was returned in completion chunk `e518be`, not saved as a repository
artifact. No installation, native build, model invocation, or secret access was required.

This closes the previously unverified publication-signature check only. It does not independently
reproduce native compilation, establish runtime safety, or qualify a future modified supervisor.
The failed Linux fixture invariant and missing private application-result channel remain open.

### Local full-suite timing and cleanup investigation

The host-permitted one-worker full suite remains active in main session 12551. Its first integration
file reported 10 passes and one failure: the two-repair-cycle case at 240,214 ms. The same selected
case passed earlier in 227,260 ms. The second file reported 25 passes and one failure: the ignored
command-output cleanup case at 30,189 ms. Final error stacks have not yet been emitted. These
durations are close to existing watchdogs; they do not establish the failure classification or cause.

Independent source inspection identified repeated real Git operations as a shared timing candidate.
Verification removes and recreates its disposable worktree before base, candidate, and additional
checks, then runs pre/post identity proofs around each command. The smaller test uses an in-memory
private store, so durable evidence writes cannot directly explain both failures. The larger test
also performs awaited durability barriers and 21 command executions. No phase-cost attribution has
been measured, and no proof or durability check has been removed.

The installed Vitest timeout wrapper does not join the original asynchronous test body before
running teardown. Neither failing case passes its test-context signal into the operation; both files
delete registered temporary roots in `afterEach`. A timeout can therefore overlap continued Git or
proof operations with fixture cleanup. This is a source-supported test-infrastructure risk, not a
demonstrated cause of the first failure. Cancellation alone is insufficient because verification
postcondition proof intentionally runs independently of the request signal. Any correction must
establish operation and owned-child settlement before deleting fixture state.

After the current run settles, collect final error classifications and compare hosted results.
Instrument fixture setup, lifecycle/verification, evidence checks, resume, and teardown separately
if needed. Record only operation names, timings, and owned identifiers. Preserve the existing
watchdogs and behavioral assertions while diagnosing; do not classify timing alone as a product
defect or dismiss it as host performance.

The previous completed hosted quality job `101763285584`, run `34128675526` at `fd8cf95`, provides
a historical comparison. Its two-repair case passed in 40,256 ms and its ignored-output case passed
in 2,879 ms. Their files passed all 11 tests in 240,538 ms and all 26 tests in 64,015 ms respectively.
Git comparison confirms the two test files and their lifecycle/verification implementation paths
are unchanged between that head and `e826687`; the intervening production additions are internal
observer helpers. This comparison supports investigation of host-dependent costs, not causal
attribution or a current-head pass. Hosted coverage and local non-coverage runs are also different
execution conditions. The current hosted quality job and local full suite remain pending.

### Current hosted quality result and inventory correction

Current-head quality job `101784477438` completed with 6,733 passing tests, one failing test, and
one skipped test; 469 files passed and one failed. The only failure is the library API assessment's
exact inventory snapshot: production files increased from 378 to 380, infrastructure declarations
from 1,088 to 1,098, and total declarations from 3,445 to 3,455. The unchanged audit independently
reproduced these values locally. Direct inspection identifies seven exported declarations in the
new immutable fixture helper and three in the new Linux command helper. Static reachability, CLI
forms, and all other inventory fields remain unchanged. Internal exports do not create a public
library API or qualify the observer.

The public assessment's counts are corrected. The local baseline subsequently reported the same
inventory test as failed in 2,297 ms. Only after that test completed were its three measured
expectations corrected. The active full run retains its failed baseline result; a separate focused
run and required static gates must verify the correction. The hosted and local failures are the
red results; the exact inventory assertion is unchanged. Browser and runtime steps did not run in
this quality job, so it does
not independently reproduce the dedicated isolation failure. The proof job remains active.

Both locally slow test files passed in this current hosted job. The two-repair case passed in
40,858 ms; its 11-test file completed in 257,803 ms. The ignored-output case passed in 2,925 ms;
its 26-test file completed in 64,507 ms. This strengthens the host-dependent timing comparison but
does not replace the pending local failure stacks, prove their cause, or excuse the cleanup risk.

The corrected inventory test passed independently: one test in one file, 4.42 seconds total
(3.75 seconds in the test), session 9197 exit zero. This was a lightweight static source audit,
not another lifecycle or sandbox run. Focused Biome checks passed for both changed test files.
Full type checking remains queued behind the long-running baseline. The single hosted coverage
skip is the Linux observer's actual-unsupported-host unit case, which intentionally skips on
Linux x64. It is not a passed containment test or another unexplained failure.

The ongoing local run then exposed a second inventory-dependent expectation in
`test/integration/package/documentation-structure.test.ts`: it still required the old printed
`3,445` total after the public assessment was corrected. The initial search had covered scaffold
tests rather than the complete test tree. A repository-wide search found this remaining active
reference. Its expectation now requires `3,455`; the heading, entry-point, and library-boundary
assertions remain unchanged. Both inventory and documentation-structure files passed together:
six tests, two files, 2.27 seconds total, session 16236 exit zero. Focused Biome checks passed.

The long local run spans these documentation and already-executed test-metadata corrections. Its
final result must not be presented as an exact-head full-suite pass. The two initial slow failures
occurred before these changes; their production and test bodies remain unchanged. Preserve all
reported failures and use separate post-correction verification for the changed tests.

A read-only host check rejected the Apple Git launcher hypothesis: the tests' PATH lookup resolves
`/opt/homebrew/bin/git`, a link to Homebrew Git 2.55.0. It does not resolve `/usr/bin/git` or the
Xcode-selected Git path. No executable selection or host configuration was changed. This eliminates
that proposed mechanism, not other process, filesystem, or durability costs.

### Terminal local result and owned test-lifetime correction

Main session 12551 is terminal with exit one after 2,858.39 seconds. It reported 6,727 passing,
four failing, and four skipped tests across 470 files: 465 passed, four failed, and one skipped.
Final stacks confirm the two original failures are Vitest timeouts at 30,000 and 240,000 ms.
The larger case also reported ENOTEMPTY while teardown removed its owned Git temporary index
directory. Four failed tests therefore produced five failure entries. The two inventory failures
have separate six-test green evidence after correction. This mixed-state diagnostic run is not
a clean full-suite result for the edited worktree.

The queued full type check, lint, formatting check, build, and public capability-reference check
then passed in session 80001. Lint retained one existing informational constructor diagnostic in
an unchanged file. No public capability regeneration was needed. The hosted proof job remains
active; no push has cancelled it.

Implement a small test-only owned-lifetime scope. It must track the original callback from setup
through assertions, own its temporary roots, preserve late allocation ownership, forward test
cancellation, and retain roots after timeout or uncertain settlement. Teardown must be bounded;
it must not schedule deletion after returning a retained outcome. Production postcondition proof
and existing test deadlines stay unchanged. This prevents unsafe fixture deletion; it does not
claim arbitrary descendants are settled or explain the original timing cost.

Cancellation-only does not establish settlement. A shared retention flag still risks assigning
late allocations to a subsequent test. A separate worker protocol adds an unnecessary boundary for
this correction. The selected per-test scope uses existing bounded-wait and retention patterns.
The actual timeout plus ENOTEMPTY result supplies the baseline failure; focused regressions must
exercise retention, late work, root identity, and cleanup failures before the correction is accepted.

The helper and its regressions are delegated separately from integration. Installed Vitest types
confirm that `it.each` supplies case arguments only, while `it.for` supplies a separate test context.
Convert the three affected parameterized groups using the supported API while retaining their
case sets, generated names, and 240,000 ms deadlines. No global mutable current-test pointer or
production interface expansion is permitted.

### Owned test scope implementation and independent review

The test-only scope now owns the original callback and its temporary-directory allocations.
It forwards cancellation, waits a bounded settlement grace, and retains roots after an abort or
uncertain settlement. Cleanup validates directory identity and observes late rejections. It does
not prove arbitrary descendants quiescent. A filesystem removal already admitted before an abort
can finish; an incomplete cleanup reports the owned inventory rather than promising all roots
remain. The 1,000 ms default settlement grace, capped at 2,000 ms, is not a new test watchdog or
a hard bound on filesystem calls.

Both lifecycle test files now use the scope. A syntax-tree comparison found the same 164 and 256
expectation-rooted expressions respectively. These 420 expression nodes are not 420 independent
tests. All registration deadlines and parameterized cases remained unchanged. Normalized Vitest
discovery produced exactly the same 37 unique file-and-test-name pairs before and after the
integration; raw discovery order differed. Production code and its postcondition checks did not
change.

Independent review found a P2 scheduling race in two new cleanup regression tests. The correction
uses a synchronous test-only observer after real root removal and before the cancellation check.
It does not replace filesystem operations. The tests deterministically cover cancellation at that
boundary, preservation of subsequent roots, and observer-error preservation. The reviewer confirmed
the finding resolved with no new P1–P3 findings in this delta. Removing the post-removal cancellation
check caused the intended regression assertion to fail; the restored implementation passed.

Main session 82800 passed full type checking, all 21 owned-scope tests, and six inventory and
documentation-structure tests. The 27-test run took 2.02 seconds across three files. Documentation
style, local links, and changed-prose checks also passed. This does not replace the affected
lifecycle rerun, the unresolved Mac timing diagnosis, or Linux fixture qualification. The two
previously slow cases are being rerun serially with their unchanged deadlines and the required
host permission for localhost ownership locks. Hosted proof preparation remains active.

Main session 73592 then passed both previously failing lifecycle cases with their original
30,000 and 240,000 ms deadlines. The selected run completed in 79.24 seconds, with 75.37 seconds
reported in tests. Its 35 name-filtered cases were skipped, not qualified. This is regression
evidence for the two edited cases, not proof that the scope caused the speed difference or that
the earlier Mac timing failures are explained. All 37 affected cases and final static/build gates
are queued serially next. Independent review of the remaining diagnostic and documentation diff
found no P1–P3 findings; the Linux denial assertions remain unchanged.

### Final hosted result at e826687

Run 34135220621 completed with failure without cancellation. Its proof-runtime job 101784477327
passed all four tests after appliance preparation, taking 1 hour 12 minutes 49 seconds overall.
Dependency audit also passed. Quality retained its 6,733 passing, one failing, and one skipped
tests; the inventory failure prevented its browser/runtime steps. Expanded verifier isolation
retained 16 passing and one failing tests. The denied-read fixture profile remains unqualified.

The run's head is e826687141de40da13a2a4a6eb54cf1c08dd4cc1. Its synthetic checkout
3d934d6f03d259351d671fabfe93093fac5c469f has the same tree,
12cb8436b4e575786df9f479aed0addfbc25545d. These results therefore bind that source tree,
not the subsequent uncommitted test-scope and diagnostic changes. The proof pass does not override
the independent fixture-read failure. All jobs are terminal, so a later reviewed push will not
cancel this run.

### Complete affected lifecycle regression result

Main session 6431 passed lint, formatting, build, and the public capability-reference check, then
all 37 affected lifecycle tests across two files with zero skips. The test run completed in
513.11 seconds, reporting 508.34 seconds in tests. Original deadlines remained unchanged. The
existing informational constructor lint diagnostic in an untouched file remained nonfatal.

Together with session 82800, this verifies 21 scope regressions, six inventory/documentation tests,
and 37 affected lifecycle cases, plus full type checking and required static/documentation gates.
The separately selected two-case run is overlapping evidence, not two additional unique tests.
Independent helper, integration, diagnostic, and documentation reviews found no remaining P1–P3
findings after the timing-sensitive regression tests were corrected. This is not a full repository
suite pass. Mac timing attribution and Linux fixture qualification remain unresolved, and no
production repair capability has been enabled.

### Diagnostic Linux result and revised combined decision

At head 565a89d0889556e0932f8508843a4192c7b05fd4, job 101805484054 in run 34141891105
again reported 16 passing and one failing isolation tests, with zero skips. Main independently
retrieved the completed log using the GitHub CLI. The unchanged failing assertion at line 233
checks the post-attempt denied-file read. Earlier direct and nested mount-denial assertions and
both chmod-false assertions passed. The attached beforeMutation diagnostic records reads before
the nested attacks, but after the outer direct alias-mount attempt.

The nested child reported uid/euid/gid/egid zero; UID and GID maps each contained `0 1001 1`.
Denied file and directory ownership was 0:0 in that view. File modes were 32768 and 16384;
masking with 07777 gives zero for both. Readable mode 33152 gives 0600. Effective capability
mask 000001ffffffffff contains bit 1 (CAP_DAC_OVERRIDE) and bit 2 (CAP_DAC_READ_SEARCH), verified
independently with BigInt bit operations. Both denied inputs were already readable in the
pre-nested-mutation observation; distinct synthetic prefixes identify the requested fixtures.
The missing control remained ENOENT and the readable control succeeded.

Linux man-pages and upstream Linux 6.17 kernel/capability.c:418-449 and fs/namei.c:438-478
independently corroborate the capability-and-mapped-owner mechanism. This is not a trace of the
deployed Azure kernel or a controlled capability-removal experiment. Independent review found
no concrete setup or path-selection defect. The runtime probe does not call the production
immutable fixture helper. Pre/post host checks reject persistent drift, not all transient changes,
and nested diagnostics do not include inode identity. Do not claim a protected-host-file escape.

The revised pending design compares A, a narrow pinned-supervisor extension with post-setup
namespace restrictions and protected application results; B, separate supervision with separately
provisioned fixture identity; and C, continued unsupported outcomes. A is recommended for reuse
and reduced host provisioning, with native artifact maintenance and workload compatibility costs
made explicit. No new profile, native result protocol, pilot, merge, or release is selected by
this diagnosis. A material user decision remains required. Current quality and proof jobs remain
active; no push may cancel the current proof build merely to publish this evidence update.

Independent review found no P1–P3 findings in the revised diagnosis and combined design direction.
It specifically retained A's unresolved clone3/fallback and namespace-join compatibility proofs,
B's identity-provisioning and recovery costs, and C's incomplete usability outcome. The public
design states that upstream attestation does not authenticate a custom binary and that no existing
native command policy changes implicitly. Documentation style, links, and changed-prose gates passed
after splitting long prose. No executable code changed in this diagnosis update.

### Temporary Mac phase measurement

While the revised native-boundary decision remained pending, the independent timing investigation
continued within the approved test-correction scope. The agent added 34 temporary diagnostic lines
to the two previously slow test bodies. They recorded static phase names, monotonic elapsed times,
and completion/abort status only. Original awaits, assertions, deadlines, and owned-scope cleanup
were unchanged. Full type checking passed in agent session 55624. The selected two-case run used
one worker and host permission for its localhost ownership locks.

Agent session 63436 passed both cases, with 35 name-filtered skips, 63.61 seconds reported in tests,
and 67.53 seconds total. Both callbacks reported completed=true and aborted=false. Raw output was
returned in tool chunks b5d222 and 3ba333, not saved to a disk log. The phase durations below are
milliseconds, rounded to three decimal places:

| Phase | Two repair cycles | Ignored output |
| --- | ---: | ---: |
| Fixture setup | 289.858 | 1080.004 |
| Service construction | 3.051 | Not applicable |
| Initial execution or verification | 53881.716 | 3637.084 |
| Evidence or filesystem assertions | 53.177 | 0.281 |
| Resume construction | 1.291 | Not applicable |
| Resume execution | 4592.566 | Not applicable |
| Final assertions | 12.099 | Not applicable |
| Complete callback | 58833.757 | 4717.369 |

Main independently summed the unrounded phase values: 58833.757333 and 4717.369375 ms. Initial
execution accounts for 91.583% of the repair callback, resume for 7.806%, and verification for
77.100% of the ignored-output callback. The two callback totals sum to 63.551 seconds. These
nonoverlapping callback phase sums exclude owned-scope cleanup and runner startup/teardown.

The measurement localizes time in one passing sample. It does not reproduce either earlier
timeout or establish a production bottleneck, filesystem cause, process-startup cause, or host
scheduling cause. No durability check, integrity proof, timeout, or production code was relaxed.
If further diagnosis is needed, subdivide the measured initial execution boundary rather than
optimizing fixture setup from assumption. Keep the original timeout-cause item open.

The agent removed all temporary lines with inverse apply_patch and verified both original SHA-256
file hashes. Main independently confirmed no test-file diff and a clean worktree at
cce5321ee15a44c14316943ec594dac03d353ec4 before this evidence update. No instrumentation is retained
or proposed for publication, and no new security profile or model run was started.

### Revised native-supervisor Approach A approved

The user approved revised Approach A on September 7, 2026. This authorizes the observer-specific
pinned SRT extension, post-setup namespace restrictions, protected application results, native
artifact provenance/maintenance, integration, and qualification. Ordinary native command policy
stays unchanged. No privileged host provisioning, live pilot, repair enablement, merge, or release
is authorized by this approval. The usable-checkpoint objective remains active and incomplete.

Adversarial design review identified a descendant-policy counterexample: a denied-input branch can
catch a child namespace denial and return zero while accessible controls never take that branch.
EPERM or KILL_PROCESS alone cannot establish absence of policy interference. Implement mandatory
trusted policy observation with a sticky invocation-wide interference result, including descendants.
Record it before response/termination. Missing observation must fail closed. Record clone3 ENOSYS
fallback separately and keep it unsupported until an exact adapter/runtime fallback contract passes.

The existing hosted run 34141891105 remains untouched. Its quality job completed with coverage
6755 passed/1 skipped and browser 2/2 passed. Runtime reported 98 passed/1 failed/4 skipped; the
only failure reproduces the same nested-fixture read on a second Linux runner. Proof preparation
remains in progress at this entry. This does not establish a clean CI run or qualify the extension.

Implementation is split between native source/build provenance, host result framing/integration,
and independent native-boundary review. Heavy local verification remains serialized. Preserve the
current proof run; do not push merely to publish documentation while its build remains active.

### Private result decoder implemented; native policy history remains under investigation

Added a disconnected internal decoder for the specified 64-byte little-endian result frame.
The first behavior test failed because the existing boundary had no result-recognition capability
(undefined versus the expected normal-exit record), not an import or syntax error. The implementation
then passed that test. The expanded matrix passed 190 cases. A deliberate temporary removal of
correlation checking caused all 32 per-byte mismatch cases to fail; the check was restored.

The targeted decoder, library inventory, and documentation-structure run passed 196 tests across
three files. Full type checking and production build passed. Lint completed without errors; an
agent-owned build-script unused import was reported during concurrent work and sent to its owner.
The pre-existing NativePiEvaluationAdapter constructor informational diagnostic remains unchanged.
Independent parser review found no P1–P3 findings. It did not claim native writer, launch, stream,
or settlement qualification. The source inventory now records 381 modules and 3457 declarations,
including 1100 infrastructure declarations; CLI reachability remains 346 modules.

Further falsification rejected notification-only policy-history proof. Linux v6.17 seccomp.c
1066–1152 permits interruption and removal before a queued notification reaches userspace.
WAIT_KILLABLE_RECV applies after receipt, not throughout that window. Therefore even mandatory
listener ownership plus final HUP/ECHILD can miss an interrupted forbidden attempt caught by a
candidate descendant. Main raised this counterexample; independent kernel-source review confirmed
it and retracted the earlier implication of complete-history proof. No such policy code was enabled.

Investigate trace stops within the same existing supervisor, including complete thread tracking,
fatal descendant termination, nonleader exec, and exit_group(0). Tracing itself must not be assumed
complete: kernel fatal-signal paths can skip events. Retain the observer's unsupported outcome until
those cases have a sound contract and executable qualification. This is implementation research
within approved A, not another request for routine approval or a claim that the full goal is complete.

### Native source foundation and executable kernel counterexample

Vendored the exact upstream C helper, filter generator, and Apache license at commit
44ab607c46f20381aeaf3e22ca0e0151d4c6b29c. The foundation records immutable source hashes, the
pinned Debian/BuildKit/certificate images, frozen Debian package snapshot, and the upstream commit
epoch 1785885248. The build recipe emits an explicitly unmodified upstream baseline, not a Flow
observer. It retains generated BPF/header bytes, toolchain identities, relinkable application
object, libc source downloads, and applicable notices. Actual Linux compilation, independent
clean-build equality, native artifact hashes, and redistribution approval remain unverified.

Main review found a build-evidence race: hashing live recipe paths after execution could describe
different bytes than the build consumed. The implementation now captures source and recipe bytes
before either build, verifies the copied context, and derives evidence from that frozen snapshot.
Fourteen real-filesystem tests passed. Agent mutation controls rejected a bypassed comparison
and a corrupted frozen recipe digest, then restored the implementation. No Docker build was run;
the existing local Docker daemon reports Linux ARM, not native Linux x64.

Added a separate test-only C counterexample with two received-notification controls. In cancellation
mode, the parent proves the second request is queued, signals the child without receiving it,
and requires caught EINTR, normal exit, complete reap, and terminal listener HUP without POLLIN.
No trapped namespace operation is continued. The runtime wrapper uses owned test lifetimes,
abort-aware compiler discovery, bounded byte output, fixed process-group cleanup, and retention
when settlement is uncertain. It is not arbitrary candidate containment or observer qualification.

Independent review found no remaining P1–P3 findings in the probe after correcting a Vitest
it.for timeout overload. Full type checking passed. Mac runtime collection produced exactly two
skips; no native C compilation or execution occurred. Existing focused Linux CI now installs gcc
and includes both cases, making 19 cases across four suites. The scaffold test first failed on
the missing dependency and then passed after the workflow update. Independent CI/documentation
review confirmed the exact file list, counts, and unchanged fail-closed gates.

Final local validation passed 245 tests across five selected suites, complete formatting and lint
(only the pre-existing constructor informational diagnostic), and all three documentation gates.
The production build and public capability-reference check passed earlier in this same change.
No model run, credential change, candidate modification, repair enablement, merge, or release occurred.

### Terminal hosted checkpoint and compatibility qualification preparation

Run 34141891105 is terminal for source 565a89d0889556e0932f8508843a4192c7b05fd4.
The tested merge 7ed7e10122aa9433cd360676e8d94c7df708f81b has the same file tree,
f7a2bb86d1dd8fa031b8b0cc517ad0cc808f110b. Isolation passed 16 cases and failed the
nested fixture denial. Quality passed 6,755 coverage cases with one skip, both browser cases,
and 98 runtime cases with one identical fixture failure and four proof skips. The separate
proof job passed all four cases after appliance verification (total job duration 1h11m20s).
Audit passed. Neither failed job is waived; later local changes are not covered by this run.

Prepared four real Node 26.7.0 compatibility controls (timers, async filesystem, worker thread,
subprocess) with untraced, full-strace, and forced clone3 ENOSYS arms. These controls do not
qualify arbitrary candidate fallback behavior. Private bounded traces produce only version,
count, digest, and single-sample timing summaries. No observed injected calls means unexercised
coverage, never a compatibility pass by assumption. The four untraced fixed controls passed
locally on Mac; the Linux measurement file collected four explicit skips. Native tracing and
fault injection remain unexecuted.

Parser extraction first produced seven failing assertions among 23 synthetic-contract cases.
Corrections distinguish quoted unrelated data from syscall records and reject malformed or
incomplete returns. All 24 final portable parser cases pass, including deliberate rejection of
an ambiguous main-PID prefix transition. These synthetic inputs test parsing, not kernel behavior.
Full type checking and focused formatting passed. Independent review found no remaining P1–P3
issues in the measurement and CI integration scope.

Both Linux runtime jobs now explicitly install gcc and strace. The focused job contains 23
cases across five files before the separate supplementary-group experiment is added. The existing
proof-runtime job will compare two clean native upstream builds after its four proof tests and
print the completed build evidence. It does not load or publish the unmodified baseline as an
observer. First native compilation and build comparison remain pending. Scaffold checks first
failed for each missing CI dependency or build command, then all 35 scaffold cases passed.

Independent kernel, ownership-contract, and SRT/bubblewrap source review challenged the assumption
that every foreign fixture identity requires privileged provisioning. An existing supplementary
group might remain outside every descendant group mapping while allowing unprivileged fixture
preparation. This is a test-only hypothesis, not adoption. Mapping exclusion, group availability,
read-only mounts, exact inode identities, and actual bypass controls remain required. Inherited
supplementary membership is not equivalent to an inode GID mapping. A successful paired experiment
would not establish private-result authenticity, mount-identity attack coverage, or complete
observer safety. Production restrictions and repair enablement remain unchanged.

### Paired supplementary-group experiment prepared

Added a test-only C participant and Linux x64 runtime wrapper under unchanged production SRT.
The required primary-group arm reproduces the denied-file and denied-parent capability bypass.
The paired arm uses only an already-held secondary group, requiring EACCES while readable and
missing controls remain exact. No group creation or host membership changes occur. The existing
failing fixture suite remains unchanged.

The probe captures actual outer/nested UID and GID maps before attack attempts. It checks current
versus secondary/overflow mapping writes, credential changes, ancestor namespace entry, chmod,
chgrp, bind remount, and reads through original and mounted-alias paths. Host inventories cover
dev/ino/type/mode/UID/GID, directory children, and content hashes, including the private expectation
and test executable. Unsupported settlement or uncertain integrity retains the owned fixture scope.
A successful bounded diagnostic is emitted only after integrity checks; it explicitly disclaims
idmapped-mount and observer qualification and contains no paths or full group inventory.

Main review added alias reads and constrained private-file denial to EACCES/ENOENT. Independent
review of the stable C and TypeScript files found no remaining P1–P3 findings. Full type checking,
production build, formatting, lint, and diff checks passed. Runtime collection of the three new
Linux-only suites reported seven Mac skips, not native qualification. No C compilation or Linux
execution occurred locally. All 35 scaffold tests and the documentation gates passed after the
CI file-list test first rejected the missing experiment. The focused hosted job now contains
24 cases across six suites. Native outcomes and group availability remain pending.

### Next native transport slice: retained distinctions and report-failure counterexample

Published checkpoint 68de0d7069946146d3a1dbf4dfc6fa80f842dd08 to existing draft PR 201.
The exact-head hosted run is 34147986514. Preserve its active proof preparation; no further push,
cancellation, or retry is required to inspect the pending native results.

An independent read-only transport review mapped the minimum extension onto the existing outer
stub, inner PID 1, and worker. Use an outer-stub-owned final writer, an inner-supervisor report
channel, and a worker close-on-exec error channel. The application must inherit none of them.
The outer stub reports only after inner reaping/namespace teardown; the host additionally needs
full frame EOF, ordinary stream completion, cancellation exclusion, and successful sandbox release.

The review found a concrete hole in a proposed normal-exit inference: an error writer returning
EBADF or EPERM, followed by ordinary _exit(1), can produce empty EOF and normal worker status
without successful execution. EPIPE and parent death do not cover all write failures. Therefore
failed/partial error reporting needs a qualified non-normal fail-stop, with no ordinary-exit
fallback if the fail-stop itself fails. Signals remain launch-unproven/unsupported. No normal
exit code can be reserved as an internal sentinel because all 256 codes are valid application
results. Descriptor, loader/library, explicit environment, immutable byte custody, and exact
argument contracts remain required. No native transport implementation or qualification is claimed.

### First hosted results for the new qualification controls

Run 34147986514 focused job 101824043131 completed with 23 passes, one unchanged original
fixture failure, and zero skips across six files. New notification-history controls passed 2/2,
clone3 measurements passed 4/4, and the paired-group experiment passed 1/1. Requested head
68de0d7069946146d3a1dbf4dfc6fa80f842dd08 and tested merge
82345259484e8f1914df34e5bda5bd91272dfb68 both have tree
6ce23fe629e027641125a47a7f34a513437a778a, independently checked through the Git commit API.

Host metadata: Node 26.7.0, Linux 6.17.0-1022-azure, glibc 2.39, strace 6.8. The selected host
group pair was primary 1001 and supplementary 4. Nested UID/GID maps included only 0→1001.
Primary vectors before/after were [0,0,2,0]; supplementary vectors were [13,13,2,0]. Mounted
aliases retained the same results. chmod/chgrp returned EROFS (30), bind succeeded, remount
returned EPERM (1), and host fixture identities were unchanged. Idmapped mounts and the
observer remain explicitly unqualified. The result supports investigating the lower-interference
existing-group boundary, not silently replacing the selected namespace policy.

Asked the user to choose between refining A with existing-group fixture ownership (recommended,
subject to remaining qualification), retaining namespace restrictions with complete interference
tracking, or adding separately provisioned ownership. Shared protected-result transport and ABI
work can proceed independently of that choice. Audit passed; full quality, proof, and the new
native baseline comparison remain pending. No live model work or repair enablement occurred.

Cross-checked the clone3 baseline rather than assuming injection changed behavior. Normal traced
counts [calls, completed, ENOSYS, injected] were timers [6,6,0,0], filesystem [10,10,0,0], worker
[7,7,0,0], subprocess [12,12,0,0]. Forced counts were respectively [1,1,1,1], [1,1,1,1],
[1,1,1,1], [2,2,2,2]. Thus normal host execution supported the calls, and injection exercised
a different fallback path. This qualifies only these four fixed controls on the observed host.
It does not prove arbitrary-candidate semantic equivalence or allow ignoring policy interference.

### Native frame encoder implemented and checked on macOS

Added observer-result.h as a separate internal ABI component, not part of the unchanged upstream
baseline. It validates all six closed frame variants, exact 64/32-byte buffer lengths, and flags
before modifying output. It encodes fields explicitly in little-endian order and captures correlation
bytes in a local frame before copying output, supporting overlap without native structure layout.
The function rejects null pointers; other pointer validity remains the caller's storage contract.

Three runtime-only tests compile and execute fixed C controls against 670 valid and 83 invalid
vectors, plus buffer-canary and overlapping-storage controls. Expected bytes are independently
constructed in TypeScript and decoded through the existing production parser. Deliberately removing
the flags guard and reversing byte order each failed behavioral assertions. Both mutations were
restored before the final passing run. Independent source/test review found no remaining P1–P3.

Initial local compiler admission failed for a missing header, an inherited LIBRARY_PATH linker
warning, and restricted Apple cache setup including one compiler timeout. These are not behavioral
RED evidence. An explicit compiler environment removes ambient linker inputs, and the same installed
Apple compiler passed the actual linked controls with ordinary host permission. Final restored tests,
full type checking, formatting, and diff checks passed. Main additionally passed 263 tests across
four focused parser/scaffold/build suites and six documentation/library-inventory cases across two
additional suites, for 269 total focused passes. The pinned upstream source identity remains unchanged. Native compilation
here proves portable ABI behavior on macOS, not Linux security or protected transport.

Five failed compiler scopes remain retained rather than risking deletion during uncertain work:
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-native-encoder-qbzja2,
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-native-encoder-JMFF5s,
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-native-encoder-s3O87w,
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-native-encoder-hWLrnL,
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-native-encoder-9laxpZ.
A manual linked-control diagnostic remains at /private/tmp/flow-encoder-link-diagnostic.AKHQdl.
These contain synthetic compiler/control artifacts, not pilot data. No broad process cleanup or
deletion is authorized by this record. Normal completed mutation-test scopes were cleaned by
their own lifetime owner. No subsequent push was made while the hosted proof build remained active.

### Observer launch preparation: corrected descriptor and producer assumptions

Prepared a pure proxy-free launch rewrite and a narrow exported wrapper around the existing SRT
descriptor parser. Generic containment validation and the allowed bubblewrap options are unchanged.
The rewrite checks the exact original helper/shell/application relationship, existing command-byte
limits, lossless UTF-8, immutable output, and explicit environment. It starts no process, opens no
executable, transfers no descriptor, and authenticates no binary. Host integration remains open.

The initial design mistakenly proposed bubblewrap --preserve-fds. Upstream v0.9.0 does not offer
that option. Independent source checks found that the monitor and PID1 close their inherited extra
descriptors, while the workload child retains them through exec. Corrected the output to preserve
all admitted options without adding a flag. A regression first failed against the emitted invalid
flag, then passed after correction. Real Linux FD3/FD4 mapping, helper-only ownership, application
closure, and final EOF are still unqualified. Source references:
https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L479-L488 and
https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L3088-L3149.

Independent review then found a P2 compatibility and test-oracle gap: current Flow uses the pinned
manager's proxy-enabled launch even with an empty domain allowlist. Installed sandbox-manager.js
603–647 initializes the bridge, 1174–1189 deliberately selects proxy use for empty allowlists, and
1227–1239 passes sockets. linux-sandbox-utils.js 1448–1473 emits proxy environment options and
1528–1530 selects the relay shell wrapper. The new rewrite correctly rejects that production shape.
Do not loosen rejection or strip policy to make a synthetic no-proxy test pass. Track producer
adaptation as an open integration gate and test the actual dependency generator. This is a partial
internal component, not production observer compatibility or completion of the broader goal.

The first corrected local gate passed 87 tests across five launch, sandbox, architecture, and
library/documentation suites. Full type checking, production build, capability reference,
formatting, lint, and documentation gates passed. Lint retained only the pre-existing informational
constructor diagnostic. The library audit measured 382 source modules and 3,460 exported internal
declarations (1,103 infrastructure); the CLI still reaches 346 modules. Public exports stay empty.
Later producer-coverage results must be recorded separately from this first gate.

Added two controls using the actual installed wrapCommandWithSandboxLinux generator. The proxy-free
form passes transformation; the bridge-enabled form contains real generated proxy settings and
relay commands and is rejected. The controls do not initialize the production manager, execute
bubblewrap/helper/relay binaries, or reproduce production filesystem policy. Real private Unix
listeners supply bridge inputs without traffic. Successful generation is paired with the dependency's
active-invocation cleanup, followed by bounded listener closure even if dependency cleanup fails.
Uncertain resource settlement retains its private root. The sandbox-denied listen attempt retained
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/fop-5DDSYh; no removal was attempted.
The same controls passed with ordinary host permission for these temporary local listeners.

Final main verification passed 89 tests across six files, including the two actual-generator
controls and 48 pure rewrite cases. Full type checking passed with the new integration file.
Independent final review found no remaining P1–P3 in this bounded component. The test-oracle and
claim gap is corrected, but actual production producer adaptation is not implemented or qualified.
No ordinary SRT validator, option allowlist, network profile, public export, or issue execution
path was changed. This does not close protected-result transport or Linux security qualification.

### Second hosted reproduction of the new controls

Run 34147986514 quality job 101824043311 failed after 24m7s only on the unchanged nested denied-file
fixture assertion. Coverage passed all 474 files with 6,983 passing tests and one skip. Browser
checks passed 2/2. Runtime checks passed 105, failed one, and skipped four proof cases across
28 files. The separate focused and quality runners independently reproduced the original defect.
The secondary-group experiment again retained the same UID/GID maps, denied reads, mounted-alias
outcomes, and unchanged fixture identities; all four clone3 controls passed with the prior counts.
The proof job remains active in appliance preparation. Its native baseline comparison has not
reported a result. No job was cancelled, no local changes were pushed, and repair remains disabled.

### Proxy-compatible observer launch preparation and real shell controls

Extended the pure observer rewrite to match the pinned dependency's complete proxy bootstrap.
It preserves the admitted bubblewrap options and environment, requires explicit relay/socket
metadata and matching socket mounts, and rejects unsafe path syntax or startup/loader injection.
The original relay spelling may be PATH-resolved socat or a canonical absolute path; independently
binding that spelling to the trusted relay identity remains a host-admission obligation. Template
matching authenticates no executable, socket inode, mount, loader, or helper bytes. The generic
SRT validator, ordinary command path, command budgets, and repair enablement are unchanged.

Compared exact template reconstruction, a proxy-free producer, and a native relay bootstrap.
Selected the first for qualification within revised Approach A. Removing proxies changes the
dependency's network-failure and dynamic-policy semantics; native relay ownership adds startup,
readiness, signal, and reaping responsibilities. Both alternatives remain documented rather than
silently substituted. The selected shell closes FD3/FD4 before relay execution and uses explicit
--noprofile/--norc flags. It replaces itself with the helper; successful exec does not run the old
EXIT trap. Relay readiness, namespace/host-bridge settlement, and protected descriptor transport
remain open integration gates. SRT reset resolution alone is insufficient: its timeout branch
sends SIGKILL without awaiting the bridge's resulting exit.

A maximum-envelope review found a concrete Linux argument limit defect in the initial adaptation.
64 arguments of 512 apostrophes fit the 32,768-byte application budget, but their single-quoted
encoding occupies 164,031 bytes before helper/bootstrap text. Linux MAX_ARG_STRLEN is 32 pages,
or 131,072 bytes on a 4-KiB-page host. Three expected-shape/maximum-envelope tests failed before
replacing command interpolation with separate Bash positional arguments and fixed exec "$@".
The corrected implementation preserves the existing budget; it does not enlarge it.

A local controlled Bash launch with only PATH in its explicit environment unexpectedly loaded the
real user's startup file. --norc suppressed the behavior; --noprofile alone did not. No further
bare-shell probes used the real home. GNU Bash documents noninteractive startup when stdin looks
network-connected; Node's pipe implementation is a plausible explanation, not a traced mechanism.
The committed controls use an owned synthetic HOME and startup files. Sources:
https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files,
https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html,
https://github.com/torvalds/linux/blob/v6.17/include/uapi/linux/binfmts.h#L8-L14.

Added a fixed C inspection program and a portable runtime control, not a proxy or production
observer. Actual Bash executes the generated bootstrap with mapped real file descriptors. Five
executions check correct closure, removed-closure detection with exact device/inode identity,
a higher-numbered duplicate, all 32,768 argument bytes, and owned BASH_ENV startup detection.
The helper controls reap exactly two children before success; this test-only handshake does not
prove real relay settlement. The probe inventories all open descriptors through /dev/fd rather
than checking only FD3/FD4. Process groups, alarms, bounded joins, explicit environments, and
sticky retention limit test failures without treating uncertain cleanup as success.

The first C compile failed because the POSIX feature macro hid O_NOFOLLOW on macOS. This was
not behavioral RED evidence. The Apple-specific feature macro corrected the compile. Its failed
scope remains retained at
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/flow-bootstrap-control-DGSecV.
Deliberately removing closures from the expected-good runtime run then failed on actual leaked
FD3/FD4, after the helper reaped both children. Restored runs passed. Separate unit mutations
detected removed closures (two failures) and removed exact-template equality (11 failures).
All mutations were restored; successful scopes were cleaned by their lifetime owner.

Main independently passed 347 focused tests across seven suites, including 84 pure rewrite cases,
four actual dependency-generator cases, 190 result-parser cases, existing sandbox controls, and
scaffold/documentation checks. Main also compiled and passed four runtime tests across the encoder
and shell-control suites. Full type checking, production build, capability-reference check,
formatting, lint, documentation style, links, and prose gates passed. Lint retained only the
pre-existing informational constructor diagnostic. The CI scaffold first failed when the two
new suite entries were absent, then passed after adding them to the existing focused Linux job.
The next configuration contains 28 tests across eight suites; it has not been dispatched while
run 34147986514 remains in progress. These macOS results do not qualify native Linux containment,
the real proxy, modified supervisor, application launch evidence, or final channel EOF.

Independent final reviews of the production rewrite and of the compiled shell-control files found
no remaining concrete P1–P3 findings within their bounded scopes. Both reviewers explicitly kept
host admission, real bubblewrap/proxy behavior, native result custody, and Linux qualification open.

### Native integration boundary: source audit and next execution gate

Re-read the active usable-checkpoint plan and the actual pinned supervisor after 7b9ca81. The
next aligned slice is the observer-only native patch that executes the admitted ELF and transports
its raw result, not another detached framing utility. Two independent source reviews agree this
application-result path can be developed under the existing namespace topology while the fixture
policy decision remains unresolved. It must not claim policy-clean verification or enable repair.

The audit identified the specific upstream paths that cannot be reused unchanged: die() exits
normally with 1, reap_until() flattens signals to 128+signal, signal setup ignores failures, outer
dumpability restoration is unchecked, and failed proc overmount can be tolerated. The observer
path needs checked custody and separate failure reports. Its outer process inherits relay children
after the bootstrap exec, so it must wait for the exact inner PID rather than any child.

Cross-checked kernel v6.17 PID namespace teardown against the process ownership design. Its
zap_pid_ns_processes path waits for namespace tasks before allowing namespace init to be reaped.
This grounds a targeted inner-init wait for inner application-tree settlement, subject to actual
host qualification. It cannot settle the separate outer relay or host bridge trees. Setting
subreaper after helper entry cannot recover descendants already orphaned to another reaper.
Source: https://github.com/torvalds/linux/blob/v6.17/kernel/pid_namespace.c#L179-L264.

Compared the approved normal-exit inference with an initial-execution-only tracing witness and
full-lifetime tracing. The next fail-stop candidate uses a cached validated worker PID, raw
self-SIGKILL, and an explicit non-returning x64 trap if the kill call returns. Every worker
pre-exec failure must take that path, including a failed error write. No reserved ordinary exit
code is safe. Linux's forced-signal path resets ignored or blocked synchronous signals, but an
active unblocked trusted handler can invalidate the inference. Source inspection does not qualify
the candidate. Required real controls include denied writes and kill calls, invalid descriptors,
signal inheritance, exact channel EOF, and a normal-exit mutation exposing false success.
Sources: https://github.com/torvalds/linux/blob/v6.17/kernel/signal.c#L1214-L1244 and
https://man7.org/linux/man-pages/man7/signal.7.html.

Initial-execution-only tracing need not trace the application's entire lifetime. A trusted
single-threaded worker can stop at PTRACE_EVENT_EXEC and detach before application instructions
run, subject to trace admission, identity, signal, cancellation, and detachment qualification.
Neither approach proves application main ran: dynamic-loader failure remains possible. Exact ELF,
loader, and library custody remain mandatory. Sources:
https://man7.org/linux/man-pages/man2/ptrace.2.html and
https://man7.org/linux/man-pages/man2/execveat.2.html.

Expanded the canonical design with the actual process integration sequence, alternatives, and
Linux qualification matrix. Independent review found no concrete P1–P3 corrections. Documentation
style, links, and prose checks passed after fixing two wording violations. The architecture and
community-file suites passed 39 tests. Unchanged pinned-source verification passed.

Authoritative local checks report an ARM64 Mac and Linux aarch64 Docker daemon. No local image
or container was created and no emulated build was attempted. The sole existing hosted watch
35012 was revalidated live in this continuation, still preparing the Lean appliance for run
34147986514. Its proof tests and native baseline comparison had not completed. Preserve that run;
do not substitute ARM64 checks for native x64 evidence or implement the native patch before its
real failing qualification control is runnable. No production code, credentials, model invocation,
retained pilot candidate, merge, or release changed in this audit.

### Isolated hosted feedback and the first native transport regression

The prior continuation was a verified wait on live run 34147986514, not a failed or abandoned
build. A new safe route avoids coupling every native test iteration to that expensive proof build:
a dedicated workflow triggered only by the exact codex/issue-197-native-qualification branch.
It has a distinct workflow, job, and non-cancelling concurrency group. Existing CI, PR checks,
release gates, credentials, and model authority are unchanged. The branch was confirmed absent
with a successful remote-head lookup before preparation. No PR is created for the feedback branch.
Keep its commits on the normal issue branch and remove it after integration.

Compared waiting for full CI on every iteration, changing full-CI conditions, and this isolated
feedback branch. Selected the separate branch: it supplies native Linux execution without cancelling
the active PR run or making skipped full-CI jobs look like required-check success. GitHub push
workflows can run before their file is on the default branch; manual dispatch is retained for
later use. The workflow checks exact triggering SHA, Linux x64, and a non-root test identity. It
uses existing pinned actions and ephemeral sandbox prerequisites, contents:read, no persisted
checkout credential, and npm ci --ignore-scripts. It executes only the named regression. Sources:
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push
and https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency.

The new black-box regression uses the real production SRT manager, seccompApplyPath option,
manager-owned proxy socket getters, existing launch rewrite, and result decoder. A fixed static
C application inventories its entry descriptors, prints one exact marker, and exits 7. The
unchanged launch must pass this positive control. The rewritten default upstream launch must
then demonstrate its exact unsupported-exec behavior before the missing-frame assertion is
eligible as behavioral RED evidence. A setup failure or a Mac skip cannot satisfy that gate.

The default helper is pinned to package 0.0.70 and actual installed x64 SHA-256
5c92b0f369a626f5d7cb27d7912cfa882dc26a3690f17cc0016480c5b8b01df7.
An explicit canonical future helper path can be supplied by FLOW_TEST_NATIVE_OBSERVER_HELPER;
invalid inputs do not fall back. The future passing record must contain normal_exit7 and exact
EOF, with original output and transport exit0. The observer protocol now explicitly distinguishes
successful result delivery (outer0) from the application result (private7). Ordinary command
evidence retains the actual outer value; ordinary SRT execution is unchanged.

Both actual test launch environments receive an owned empty HOME. It is a documented test safety
binding, not a change to production environment policy. Test roots are deliberately retained and
reported on all outcomes. No recursive deletion is scheduled. Opened artifacts are compared even
after failed assertions, and host descriptors close with allSettled. Preparation, compilation,
process capture, and release attempts are bounded. Capture distinguishes real EOF from forced
reader destruction after a failed join. These controls do not authenticate the writer, prove
artifact immutability, or establish complete relay/bridge disposal.

Independent review found and corrected an expired-preparation edge: a preparation returning
between its cancellation and join deadlines must release without launching. Final independent
reviews found no remaining P1–P3 in the workflow or black-box test. The scaffold first rejected
the missing workflow, then passed; changing its trigger to main produced a behavioral failure,
and the mutation was restored. Local C syntax-only checking passed but is not a Linux build or
execution result. No native production patch is implemented by this preparation.

Final local full type checking, production build, capability-reference check, and 40 scaffold and
architecture tests passed. Documentation style, links, prose, and formatting passed. A new lint
warning mistook the literal GitHub concurrency expression for JavaScript interpolation; its exact
string assertion now has a targeted explanatory suppression. The pre-existing informational
constructor diagnostic remains unrelated. Native execution is still pending, so this record does
not claim the regression has reached its intended RED assertion.

### Hosted results and descriptor diagnostic

Run 34147986514 completed naturally. The proof job 101824043282 passed all four runtime tests
without skips and compared two clean native builds: all 15 artifacts matched. Verified proof image
sha256:73559bb7a6d90c71601661ff13e82e59e1efa7ba05db22b5fb3e619f7e146a73.
The native receipt purpose remains unmodified-upstream-build-foundation; observerQualification is
not-performed. Helper SHA-256: 9883ef93f808fec05f95cdf71cb43642ef3ef825d7d9d73cb85417f1b0376d5d.
Generated header: 70606960f8ecabc770fda4ccbf838c27ef52dff09e2e3f085a181bc8f0aa5590.
BPF: 9f5a4bdf5539a9cdacc93cdb1dd2778de21b773db3ca20170c46b571e9b9b207.
Overall CI remains failed solely on the already recorded fixture assertion in focused and quality
jobs. No live watch remains for this run and no run was cancelled.

Isolated run 34152782641, source f5b417da9ec0c4c5baf3643d550499cbef8a6546, completed in 55 seconds.
Its environment and build prerequisites passed on Ubuntu 24.04 x64. The native regression failed
before its intended missing-frame assertion: the original unchanged-SRT application returned 96,
meaning its descriptor inventory contained an unexpected entry. Test-owned root was retained as
/tmp/flow-observer-transport-ds5PiT on the ephemeral runner; logs record the path but do not preserve
that filesystem after runner disposal. This is a precondition failure, not intended behavioral RED.

Three hypotheses were considered: an inherited real descriptor, a proc-view inventory discrepancy,
or an upstream monitor-related descriptor. The monitor hypothesis is less likely: direct source
inspection verified that initialize defaults enableLogMonitor to false, and our adapter does not
override it. Known upstream observation descriptors also use close-on-exec. An initial delegated
claim that the monitor defaults to true was corrected before commit. Source inspection does not
establish the unexpected descriptor's origin.

Added diagnostic-only fcntl/fstat checks for the first unexpected inventory entry. A bounded line
contains descriptor number, inventory number, flags, errno values, and a fixed file-type label.
It never reads file content or emits link targets. Exit 96 and every descriptor constraint remain
unchanged. The original-launch stderr assertion now runs first so this evidence is visible.
Independent review found no P1–P3 in this delta. Full type checking, lint, formatting, and Mac C
syntax-only checking passed; the unrelated constructor information remains. Linux diagnosis is
pending. No production observer implementation, fixture-policy adoption, model run, or repair
enablement is included.

Run 34153166614 at e258a6fb7d33b8b7002bd5c3aa32b9ba7ac23e9d completed with the same baseline
precondition failure. The added diagnostic established a live FIFO descriptor 142, flags 0,
successful F_GETFD and fstat, distinct from inventory descriptor 3. This disproves a stale inventory
entry for this observation; it does not locate the pipe's creator. Root was
/tmp/flow-observer-transport-uyRhU1 on the ephemeral runner. No contents or link target were read.
Linux proc_pid_fd(5) and fcntl(2) documentation independently confirm the inventory and EBADF
interpretation: https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html and
https://man7.org/linux/man-pages/man2/fcntl.2.html.

Next control runs the same fixed static ELF directly before manager initialization, with the same
clean environment and bounded capture. It has no candidate input, child command, network activity,
or filesystem mutation. This separates ambient host descriptor inheritance from handles introduced
by SRT. Every original assertion remains. The native patch still waits for valid baseline evidence.

Run 34153365218 at 1d1a9374c57a2e6acb30fd23f7c51b125054fe75 reproduced live FIFO142 flags0 in the
direct-host control before manager initialization. Root /tmp/flow-observer-transport-wXmrtb was
retained until ephemeral runner disposal. This rules out SRT setup as necessary to introduce this
observed pipe. Its original creator is not identified and its contents were never read.

Pinned Node26.7.0 Linux libuv source maps the supplied stdio descriptors without a universal close
of ambient descriptors. Its Apple spawn path instead uses POSIX_SPAWN_CLOEXEC_DEFAULT. Increasing
the stdio array with ignore entries is not a sanitizer: entries above2 with no supplied descriptor
are skipped. Source: https://github.com/nodejs/node/blob/v26.7.0/deps/uv/src/unix/process.c.

Compared closing unknown descriptors in the live parent (unsafe ownership), writing another native
test launcher (duplicate boundary), and an isolated system-Python child launcher. Selected the last
for qualification only. Python -I -S excludes cwd/user environment imports and site startup hooks;
subprocess.call uses an argument list, close_fds=True, no pass_fds, and no shell. Parent runner
descriptors remain untouched. Python's default signal restoration is retained, so this is not a
strictly single-variable signal experiment. Test and job deadlines remain; this wrapper does not
prove descendant cleanup. The interpreter version is recorded, and missing support fails the job.
Source: https://docs.python.org/3.12/library/subprocess.html#subprocess.Popen.

The strict application inventory checks remain. Add an owned FD19 after test-runner isolation to
the direct-host negative control and future observer capture. The direct-host negative must detect
it, while a future observer success must close it. This avoids crediting test-environment isolation
as native descriptor closure. FD19 is a fixed canary, not a runtime limit. Arbitrary inherited-FD
hardening for ordinary commands is an unresolved release follow-up; production semantics remain
unchanged in this qualification correction. The workflow assertion failed before adding the isolated
launcher and passed afterward. Independent review endorsed child-only isolation and added -S to
exclude startup hooks. Real Linux positive calibration and intended protocol RED remain pending.

Final independent review identified a canary-attribution P3: direct-host inheritance alone does
not prove the extra descriptor reaches the native boundary through the sandbox. Added a separate
unchanged-SRT FD19 negative control and narrowed documentation to end-to-end application-entry
closure. The observer-specific bootstrap differs from the original, so native helper-entry
attribution remains a mandatory later qualification rather than an inferred pass.

### Genuine native transport RED reached

Run 34153761937 at 8ef9520065c7dde801abc8798c978167cbdd9a4b completed in 62 seconds. It logged
system Python3.12.3 and passed all prerequisites. The direct-host positive and unchanged-SRT
positive both printed the exact marker and exited7. Both explicit FD19 negative controls reported
the exact regular-file diagnostic and exited96. The rewritten upstream helper then produced its
exact unsupported-exec ENOENT result with private EOF. Only the required private normal_exit7
frame assertion failed: parser result null. This is genuine intended RED, unlike the prior
precondition failures. Root /tmp/flow-observer-transport-8lcAk0 was retained on the ephemeral host.

Started two disjoint implementation tasks: observer-only native process/reporting patch, and
separate reproducible observer build mode/provenance. The main task owns hosted wiring and final
qualification. Unchanged upstream sources and ordinary execution semantics remain preserved.
No policy-clean classification, fixture-policy adoption, model invocation, repair enablement,
merge, or release is authorized by this regression result.

### Observer-only native implementation and explicit build mode

Implemented observer.patch and observer-application.h after genuine Linux RED. The patch adds a
reserved observer dispatch to a copy of the pinned supervisor, leaving upstream bytes unchanged.
The header uses exact ELF descriptor execution, outer-only final writer3, executable4, two private
nonblocking CLOEXEC pipes, checked namespace/proc/dumpability setup, and exact worker/inner waits.
It closes all descriptors >=5 before allocating private pipes, without a guessed upper FD limit.
The worker reports failures then uses raw self-SIGKILL and a non-returning x64 UD2 fallback.
Checked kernel signal reset covers all x64 signals except KILL/STOP, including glibc-reserved32/33.
Signalled workers remain launch-unproven. The nonzero equal real/effective/saved identity check is
not a capability-free-entry proof; the admitted SRT bwrap cap-drop profile remains a prerequisite.

The new --build-observer mode freezes the patch and both headers separately, applies the patch to
copied source, retains original/patched source and relinkable objects, compares two clean builds,
and checks preserved output hashes against frozen inputs. Default baseline mode and the pinned
source-manifest are unchanged. Observer mode alone installs patch from the existing signed snapshot.
Its receipt purpose is observer-application-result-build with observerQualification:not-performed.
The focused workflow selects that exact output artifact. Its timeout changed from15 to30minutes
because two individually bounded10minute builds plus preparation/cleanup cannot fit15minutes.
This changes only the native CI limit, not a model, pilot, or application budget.

Build-tool TDD:12 missing-mode/provenance failures were observed before implementation;28 tests
now pass including two explicit Docker-unavailable dispatch controls. Workflow artifact selection
and timeout assertions failed before their corrections and passed afterward. Independent reviews
found no remaining P1–P3 in native source, build integration, or workflow after correcting errno
preservation and the aggregate-timeout mismatch. Root separately inspected the complete native
header and build diff. None of these checks qualifies native compilation or runtime behavior.

Root's focused local run passed343 cases; three real Unix-socket generator cases were initially
denied by the local tool sandbox. An appropriately permitted rerun passed all four generator
cases, for346 distinct passing cases across these seven files. The denied-run test roots were
retained as /private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/fop-Y6qXN1,
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/fop-X7ILbC, and
/private/var/folders/d2/g9pllprx19g0scltk66wsf6m0000gn/T/fop-75sSfd. They were not manually removed.
Full type checking, lint, formatting, source verification, and documentation checks passed. The
unrelated constructor informational diagnostic remains. Real native compiler and transport checks
are the next hosted gate, followed by adversarial failure, signal, custody, and settlement controls.

### First native implementation GREEN

Run 34154482610 at e615d44a44b1b4b8b2b4571f5b5ee63653fce635 passed in 1m58s on hosted Linux x64.
Two clean observer builds compared 23 identical artifacts; the baseline source manifest remained
cfd742fbe7ed805aac70d48f00f7b61828acb81cdea5a2973913089c00682dce.
Observer binary SHA-256: 67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d.
Observer object: 2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b.
Patched translation unit: 8e71c800cf8bdf9af05d6b38ace5b67ea948258d97912e362a55262c97b8cac2.
Observer header: 242e62ea86dac1f8392cf47158b2f046a6ab663a5e03cb98a3ed4978a7d0bf8c.
Encoder: 0d4a986c506955f891f329b5985f06a8a556f5999d3b3acc8c6bdb97523fa34c.
Patch: e054ce51f56cdcb4dcc33bff4c5e44b6affe6e44b464d51ae58f2a5d7cf974bd.

Both direct-host and unchanged-SRT normal controls printed the exact marker and exited 7.
Both FD 19 canaries were detected with exact exit-96 diagnostics. The observer path then passed
the private normal_exit 7 frame assertion, exact marker, empty stderr, outer status 0, and actual
private-channel EOF. One runtime test passed with zero skips. The retained root was
/tmp/flow-observer-transport-DcQQIf on the ephemeral runner. No filesystem survival after runner
disposal is claimed. Watch 74572 ended naturally with exit 0; all qualification runs are terminal.

This completes initial normal-exit transport and build reproducibility only. The build receipt
still says observerQualification:not-performed because the build itself does not run qualification.
All 256 normal exits, signalled launch-unproven outcomes, invalid/execution-denied descriptors,
failed reporting/self-killing/trap fallback, forged writers, helper-entry canary attribution,
descendant teardown and policy interference remain mandatory controls. No behavioral classification,
fixture-policy adoption, model run, repair enablement, merge, or release follows from this pass.

### Expand the actual-artifact adversarial result gate

The next bounded milestone targets false normal-exit records, not policy qualification. Reuse the
real SRT launch, exact built helper, private framing, retained roots, artifact comparisons, and
bounded cleanup attempts. Compile fixed applications once, but register each normal exit from 0
through 255 independently and acquire a fresh sandbox lease for each case. Every exit assertion
also requires the fixed application marker; fixture failures use some of the same numeric statuses.
Distinguish actual SIGTERM from normal exit 143 and preserve the generic signal record's
launch-unproven interpretation.

A separate trusted C test launcher goes at the exact helper position after the existing launch
rewrite, inside bubblewrap. Preserve the admitted options, proxy bootstrap, helper identity, and
application arguments. Require a passthrough calibration and a live non-CLOEXEC descriptor-19
canary matching the descriptor-4 inode immediately before helper execution. A closed mode closes
descriptor 4 after that check to establish real EBADF admission failure.

Use real inherited seccomp filters, not production fault flags: deny execveat with EPERM; then
also deny write to worker error descriptor 8; then also deny kill. The expected records are
exec_failed/EPERM, launch-unproven SIGKILL, and launch-unproven SIGILL. The current native
allocation makes report descriptors 5/6 and worker-error descriptors 7/8, leaving temporary
namespace-map writes on descriptor 9. This topology is an explicit test dependency, not a stable
production API. The host-placement and inside-bubblewrap controls must qualify the test launcher.

Root review, independent source review, exact private decoding, native kernel execution, and clean
artifact reproduction are separate evidence methods. Local decoder/rewriter/build tests passed
302 cases. The modified application passed a Mac syntax check. Portable encoder tests initially
stopped on restricted Xcode cache/event-stream diagnostics; the unchanged tests passed all three
cases with normal compiler access. These local checks do not compile or qualify the Linux-only
fault launcher. Actual-artifact adversarial runtime results remain pending.

Pre-commit review identified a shared-manager test hazard: a timeout wrapper can settle before the
underlying prepare, release, or process join is confirmed. Sequential test registration alone does
not prevent the next case from entering that uncertain state. Require exclusive case admission and
make any failed case permanently unavailable to later launches in the same suite. Keep diagnostic
roots retained. Also exercise malformed-header rejection with a full-sized derived ELF header whose
magic is corrupted, not only a short file that stops at the earlier read-length check.

Both review corrections are implemented. Independent final source review found no remaining
P1–P3 findings. Full type checking, lint, formatting, and whitespace checks passed; lint retained
the existing informational constructor diagnostic in the untouched external harness adapter.
Mac collection registered all 266 cases as skipped, which is registration evidence only. The
documentation checks and 40 focused documentation/workflow tests passed. The next source push
is solely for hosted native qualification, not production activation or a full-CI claim.

### Adversarial result gate GREEN

Run 34155655729, job 101846814637, passed at source
063843a2de9e315b0dc5b956835a332e8dbb58db. The job took 2m30s. All 266 runtime cases passed
without skips in 22.64 seconds. Both original normal-launch controls and both descriptor canaries
still passed. The 256 separately registered normal exits, SIGTERM distinction, inside/outside
launcher placement, absent FD 4, malformed full-sized header, non-executable ELF, and three real
syscall-denial chains all passed. No denial chain became a normal-exit record.

Two clean builds again matched 23 artifacts. Observer binary SHA-256 remained
67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d; its object remained
2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b. No production native source
changed from the first successful run. The retained fixture root was
/tmp/flow-observer-transport-WwfKHg on the ephemeral runner, not a durable uploaded artifact.
Watch 87600 completed naturally with exit 0. No qualification run or watcher remains active.

This qualifies the specified application-result controls only. Remaining controls include signal
state and additional setup failures, private-writer access, immutable application/runtime custody,
descendants and cancellation, outer relay/bridge disposal, namespace-policy interference, fixture
denial, and lifecycle composition. Repairs remain disabled; no model pilot, merge, or release follows.

The next bounded control families are private-writer exclusion and descendant settlement. A known
correlation deliberately disclosed to the fixed application must not let a forged ordinary-output
frame replace the genuine private result. Test concrete access mechanisms against the actual inner
report writer, with positive controls and live-parent calibration; generic missing-target failures
are insufficient. Do not mistake this for complete writer or runtime custody qualification.

For descendants, hold the fixed child until the host independently discovers and binds its kernel
identity. Candidate-provided PIDs are not authority. Redirect child stdio before readiness so open
output pipes cannot mask early private-result publication. Consider a host-owned pidfd after identity
checks to prevent PID-reuse confusion, and distinguish termination from reaping. Require settlement
at acceptance without a later wait-for-death loop or a natural-expiry explanation. Host visibility
across the pinned namespaces needs its own positive calibration; do not assume ptrace-gated proc
fields are readable. These are implementation constraints for the next tests, not completed evidence.

### Qualify private-writer access and descendant settlement

The previous goal turn made verified progress: 266 native cases passed and the evidence record
was committed as 27c3729. This continuation keeps the full usable-checkpoint objective active;
the new tests do not replace UC-01 or any later gate. No production observer code changes are
planned unless these controls expose a defect.

The fixed writer application receives the real correlation deliberately. Its valid normal-zero
frame on stdout must not alter the actual private normal-seven result. Both proc-FD and pidfd_getfd
controls prove successful acquisition and a real 64-byte roundtrip on a self-owned writable pipe.
The same errno-only denial predicate must reject these accessible controls. Worker, ordinary child,
and new-session child then attempt the real inner PID-1 report writer at descriptor 6 and require
EPERM/EACCES, not generic failure. Exact child statuses and reaping precede the summary. These
controls do not uniquely attribute denial to dumpability; self access does not establish that
cross-process access would succeed under a different Yama or namespace policy.

The host-only process oracle independently discovers a fixed child's unique argv[0] and kernel
UID/PID/starttime/session, acquires a pidfd, and rechecks identity while the child is held. It never
signals a discovered PID or assumes ptrace-gated executable/namespace-link visibility. Each check
polls the pidfd with zero timeout before inspecting proc identity; it does not retry to turn a live
result into settlement. The Node wrapper bounds launch, protocol, output, and cleanup, and closes
its own process only. Quit-write completion and actual process closure are both required.

The descendant application redirects all child standard streams to /dev/null before readiness.
Its parent reads an existing one-byte file outside the writable workspace, exposed read-only by
the original sandbox policy. It must prove read-zero plus denied write-open. The host retains a
write handle to that same inode and changes zero to one only after the child's identity is bound.
The private-frame event starts the settlement check before ordinary-output EOF or outer command
closure. No wait-for-death loop or child-provided timestamp is used. Host elapsed time must be far
shorter than the held child's 60-second safety alarm.

Independent source review found two pre-effect cancellation guards missing in the first draft:
before the host positive-control spawn and before release-byte authorization. Both were added.
Review also called for an exited-but-unreaped control, because pidfd readiness alone is not reaping.
A separate owned C parent will hold that state using waitid WNOWAIT, then reap only on a host
command. Live, zombie, and reaped observations must be distinct. These new native controls remain
unqualified until Linux compilation and real execution pass; no repair, model-run, merge, or release
authority follows from writing them.

The zombie control and its mandatory cached prerequisite are implemented. Independent final review
found no remaining P1–P3 issues. Six fixed C sources each retain a five-second compiler timeout;
the setup bound is now 42 seconds with a 47-second outer hook. Per-case and model budgets are
unchanged. Type checking, lint, and formatting passed. Mac collection registered 275 skips, not
native execution. Three existing producer tests encountered socket-listen EPERM in the restricted
local runner; rerun those unchanged tests with normal local socket permissions before commitment.

The unchanged focused suite passed all 307 tests with normal local socket permissions. The failed
restricted invocation remains recorded as environment evidence, not a product regression.

### Writer controls pass; descendant readiness requires diagnosis

Native run 34157090197 at e22a936b4dd595187d6864a5f046a76768557645 completed in 3m9s.
Two clean builds matched. The suite passed 273 of 275 cases with no skips. Both writer mechanisms,
forged stdout, and real live/zombie/reaped host controls passed. The ordinary descendant failed
its one-second readiness precondition. Sticky uncertainty correctly prevented the new-session
case from starting. Neither descendant settlement is qualified by this run.

Highest-confidence hypothesis: getsid(0) returns zero for the ordinary child's inherited session
leader outside the inner PID namespace, and held() rejects session <= 0 before publishing readiness.
Kernel v6.8 sys.c routes getsid through pid_vnr, and pid.c returns zero for an unmapped namespace.
Other hypotheses remain child execution failure or readiness-file access failure. Add a fixed
session-zero diagnostic to the existing readiness file without changing rejection or any deadline.
Require the actual Linux failure to identify that payload before correcting the fixture predicate.

Run 34157520762 at 832dbe685d1cfcbbb20e9bda2e4248c741ea3579 confirmed the hypothesis:
the actual ordinary child published exact session-zero, rejected against ready, before host release.
The job completed in 2m19s. This proves child execution reached getsid and could write the readiness
file; it is not a timing-budget explanation. Kernel v6.17 source independently preserves the same
fork/session translation behavior. Correct the fixture's syscall-error predicate from <=0 to <0,
keep every PID/parent/session-relation and /dev/null check, and publish ready-session-zero only
after those checks. Require that exact notice for the ordinary namespace case; the new-session and
host controls still require ready. Independent host identity/session checks remain unchanged.

Review also identified the real create-before-write empty-file window. A separate helper must
retry only absence or zero bytes within the original absolute one-second deadline, never accept
empty content, and still reject any wrong nonempty notice. Add real-filesystem RED/GREEN coverage
before integration. No production observer code or test deadlines change.

The real-filesystem readiness RED run exposed five failures against the old strict-empty behavior:
persistent empty content, both completion transitions, cancellation during a read, and late read
completion. The corrected helper passed all 15 cases. Independent source review found no P1–P3
issues. Tests use actual files and elapsed time without filesystem mocks or fake clocks. Transition
tests join both real operations and do not assume which I/O completes first; the persistent-empty
case independently establishes that empty content retries without acceptance. Integration imports
the helper and removes the old local implementation. Native execution of this correction is pending.

### Writer-access and held-descendant gate GREEN

Run 34157941663, job 101853551320, completed successfully at exact source
e39737ab501e5f35785ba33088e63bbd27453b39. Job duration was 2m43s. All 275 cases passed with
zero skips: original266, five writer/forgery cases, one host live/reaped calibration, one real
zombie calibration, and two held descendant cases. Runtime duration was 18.14s (17.77s test bodies).
Both descendants passed independent identity/pidfd checks and same-inode read-only release.
The private-frame event triggered an immediate host check without first waiting for ordinary-output
closure. That check required termination plus original-identity absence before accepting the result.
Its asynchronous IPC can finish after ordinary streams close; no atomic frame-arrival/termination
ordering is claimed. No retry-until-dead loop or safety-alarm expiry established those results.

Two clean builds matched all 23 artifacts. Binary SHA-256 remains
67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d; object SHA-256 remains
2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b. No production native header,
patch, or encoder changes occurred versus063843a. The job retained root
/tmp/flow-observer-transport-Jkj1H7 on its ephemeral host; this is not a persistent uploaded archive.
Independent authenticated GitHub and source review corroborated these results and their limits.

Local final checks passed typecheck, lint, format, all322 focused regressions, documentation gates,
and whitespace checks. Mac collection still skips275 native cases. The existing untouched lint
information remains. No full-CI, release, model-run, fixture-denial, outer-relay, or repair-readiness
claim follows. The full usable-checkpoint goal remains active; this continuation made verified
progress, including a failed fixture hypothesis test followed by correction and actual GREEN.

Next bounded slice: inherited ignored/blocked signal controls at the already calibrated fault
launcher, followed by an exact separately identified false-normal mutant of the worker fail-stop
path. Preserve real ordinary exit0. Then qualify remaining reporting and cancellation paths before
namespace restrictions and complete policy-interference history. All broader design gates remain open.

Final evidence review corrected one P3 precision finding: frame-triggered asynchronous observation
does not prove atomic absence at the instant the frame arrived or completion before output EOF.
Public evidence now states the actual acceptance ordering and explicitly retains that limitation.

### Qualify inherited signals and a false-normal counterexample

The previous goal turn made verified progress: the 275-case native gate passed and its reviewed
evidence was committed as2e98b51. The current tree is clean at that commit, and GitHub confirms
run34157941663 is terminal success at e39737a. The full usable-checkpoint objective remains active.

Criterion1 (real inherited state and reset): use the existing calibrated inside-bwrap launcher to
install ignored or blocked TERM/PIPE/ILL immediately before helper execution. Fixed owned children
must independently verify the state after exec and show that self-TERM returns normally, with the
pending bit present only for blocked TERM. No synthetic private record is permitted. The actual
application must inspect default dispositions and an empty mask before marker+exit7. Also preserve
real TERM15, denied execution, denied reporting/SIGKILL9 and denied self-kill/SIGILL4. SIGILL alone
does not prove signal reset, and caught-handler inheritance is not claimed.

Criterion2 (false-normal sensitivity): build a separately named test-only executable by changing
only the exact worker failure suffix in an owned copy to _exit(0). Preserve failed report writing.
First prove real application exit0 through that executable. Then deny actual execution and reporting,
require complete mutant normal0 transport with no application marker, and require the SAME genuine
signal9 assertion to reject that record. Genuine controls before/after must still pass. The mutant
must never replace genuine source/header/artifact names or enter a production release.

Verification for both criteria: the existing hosted workflow invokes `npm run test:runtime --
test/runtime/native-observer-transport.runtime.test.ts` with distinct absolute genuine and false-normal
helper paths. Expected evidence is zero-skips real Linux x64 controls, valid private framing/EOF,
exact markers/statuses, and two identical clean artifact inventories with explicit mutant provenance.
The combined failure-controls build reuses each existing builder for one additional small compile/link.
Default baseline/observer build modes remain unchanged. Local source/mutation/build admission tests,
typecheck, lint, formatting, and documentation gates precede the hosted run.

The workflow regression produced actual RED for the missing explicit failure-controls build mode,
then GREEN after wiring the separate paths. Native controls remain unqualified until actual execution.
Not promised: all signals/active handlers, arbitrary application or concurrency behavior, cancellation,
remaining reporting failures, immutable runtime custody, outer relays, namespace-policy history,
fixture denial, behavioral repair selection, full CI, a new model run, or release readiness.

The build-tool TDD run exposed 13 new failures before implementation, then passed all 41 cases.
The workflow regression also moved from actual missing-mode RED to GREEN. The full focused set
passed all 375 cases across eight files. Its first sandboxed run passed 372 and failed three existing
Unix-socket producer cases with EPERM; the unchanged suite passed with local socket permission.
Those initial failures are environment admission evidence, not a source regression or Linux result.

Full typecheck, lint, formatting, production build, pinned-source checks, transport application C
syntax checks, all 29 documentation tests, and all three documentation gates passed. Mac collection
registers and skips all 289 native cases. There are no Linux execution claims for this expansion yet.
The existing informational lint note in external-harness-adapter.ts remains untouched.

The testing guide records exact build/runtime commands and the runtime's trust in the in-job builder
for the anchored mutation relation. Runtime identity checks are not independent qualification of
untrusted source bundles. The architecture diagram records the separate test-only executable.
All 15 changed files are in the approved qualification scope; no production observer headers, patch,
published package identities, credentials, or model execution settings changed.

Final independent source, test, workflow, build, and public-documentation review found no remaining
P1–P3 issues. The reviewer explicitly retained native execution as a mandatory next gate and
confirmed that historical 275-case evidence does not qualify the new 289-case expansion.

### Inherited-signal and false-normal gate GREEN

Run 34159189998, job 101857256616, completed successfully at exact reviewed source
0255e9de2e26cd666a9ceff2dcf083dbe9cfdae2. The job took 2m29s, from 20:23:04Z to 20:25:33Z
on 2026-09-07. All 289 cases passed with zero skips: 275 prior cases, two real signal calibrations,
ten inherited-state cases, mutant exit-zero calibration, and the paired false-normal rejection.
Suite duration was 30.93s, with 30.49s test bodies. These are single-run timings, not benchmarks.

Two clean builds matched all 29 artifacts (prior 23 plus six separately identified control files).
Genuine binary SHA-256 remains 67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d;
genuine object remains 2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b.
Mutant binary SHA-256 is 6d3cc6fd7f49a28f70e0d70e7cacd6f527d7471bae4e1b7b0a45b74bc5156c8b;
mutant object is 69d94801b9720c47e80f085f34f21b4623488c25c4d3b58eb84e04989113c376.
Original header SHA-256 is 242e62ea86dac1f8392cf47158b2f046a6ab663a5e03cb98a3ed4978a7d0bf8c;
mutant header is 3ff3907dbcc72bbcf2a7e841cd95214865fec15c5f7a63dbc1ff10734214d0cd.
Build metadata keeps observerQualification:not-performed because behavioral qualification is separate.
The native job retained /tmp/flow-observer-transport-bwPzTT on its ephemeral host, not an uploaded archive.

The new checks prove real ignored/blocked state survives execution without the observer, selected
dispositions and the entire mask are clean in the observer-launched application, and the existing
results remain distinct in both states. The broken executable first transports real application exit 0,
then actual denied execution/reporting produces complete false-normal 0 that the SAME genuine
signal-9 predicate rejects. Original application exit 0 remains accepted after that test. This is evidence
about these exact paths/profile and a sensitivity control, not universal fail-stop correctness.

The next read-only audit identified a test-harness cancellation hypothesis: capture marks joined and
removes its abort listener before awaiting hook promises, and prepared does not recheck cancellation
after release. A late abort in those windows could leave a normal observation. Reproduce with actual
owned child/hook and release schedules before claiming confirmed behavior, then fix confirmed gaps.
This does not qualify or imply production cancellation: the observer is not connected to issue runs.
Remaining native reporting and cancellation, fixture denial, immutable custody, outer-relay cleanup,
policy history, and all broader UC-01/UC-05/VR-02 gates remain open. No model pilot, merge, release,
credential mutation, or repair enablement occurred. This goal turn made verified progress.

Independent authenticated GitHub verification corroborated the exact commit, run/job, timing,
counts, and genuine/mutant identities. Final five-file evidence review found no P1–P3 issues.
All 41 documentation/workflow contract tests and all three documentation gates passed after the
evidence update. Commit that documentation locally without repeating the identical native build.

Next-slice audit map (planned controls, not executed evidence): the existing calibrated launcher
can deny write(3) for final delivery, write(6) for inner reporting, read(5) for outer reception,
and read(7) for worker-error reception. Preserve actual application output and distinguish no frame
with outer failure from a complete supervisor-failure record. Separate closed-FD3 admission from
a real pipe whose reader was closed. Recheck descriptor topology before adding each mode.
Global close(3) denial instead hits inner initialization; close(6) denial hits worker handoff.
Neither proves post-report close handling. Seccomp ERRNO injection does not produce a genuine
short write; malformed/extra inner-record controls need separately assessed test-artifact mutation
or a stronger injection design. Graceful forwarding requires synchronized exact-owned-process
signalling and cannot be inferred from the test runner's existing abort-to-SIGKILL path.

### Terminal reporting and late-cancellation qualification plan

The preceding goal turn made verified progress, not a wait: 289 actual Linux cases passed, both
builds matched 29 artifacts, and reviewed evidence was committed as d7ee5ff. This turn verified
that local tree is clean and run 34159189998 remains terminal success at 0255e9d. The dedicated
remote qualification branch also remains at that exact source. The full goal is still active.

Criterion LC-1: after the real child close event, while an actual evidence callback remains held,
cancel the invocation before releasing and joining that callback. Require rejection, not normal-result
acceptance. A non-cancelled twin must accept the same application's exact normal-7 record and EOF.
Criterion LC-2: after genuine SRT release completes, hold an explicit test-only completion barrier,
cancel before returning the observation, then release/join it. Require rejection. Its non-cancelled
twin must accept normal 7. Neither schedule proves native graceful cancellation or outer-relay disposal.

First add the real schedule instrumentation and regression without changing acceptance behavior.
Use exact events and owned promises, not sleeps, mock processes, or replacement SRT operations.
Always open barriers and join original callbacks in finally. Setup/cleanup uncertainty must stop the
suite. Both named cancellation windows can be collected in one final regression only after each
operation actually settled; never aggregate through uncertain cleanup to obtain more failing tests.
Observe native RED before fixing capture/prepared. Do not infer RED from a skipped Mac suite.

Criterion RP-1: fixed application executes normally but final write(3) is denied; require outer1,
no signal, exact application/fault markers, empty private bytes, and real EOF.
Criterion RP-2: inner write(6) denial and outer read(5) denial must independently satisfy the same
transport-failure assertion. Criterion RP-3: worker-error read(7) denial must instead yield a complete
supervisor_failed record, errno71/EPROTO, stage descriptor_handoff, outer0, and exact markers/EOF.
These are fixed-descriptor filters across inherited processes, not role-authenticated policies.
The static application and helper do not reuse those descriptors for successful application I/O;
namespace mapping uses the next free descriptor9. Revalidate this coupling if topology changes.

Order: native cancellation RED, targeted cancellation correction and real reporting controls,
local checks and independent source/test review, then native GREEN. Use the existing two-clean-build
workflow and separate artifact identities unchanged. Preserve all 289 existing cases and normal
SRT behavior. No production observer mutation, model run, credential change, merge, release, or
repair enablement is part of this slice. Remaining full observer and usable-checkpoint gates stay open.

Cancellation regression source passed independent review with no P1–P3 findings. Full typecheck,
lint, formatting, documentation gates, and whitespace checks pass. An initial typecheck rejected
Promise.withResolvers under the repository's current library target; a local completion latch fixed
that test compilation issue without configuration changes. This was not native RED.
Mac collection skips all 292 cases. Commit the test-only schedule and pending-status documentation
to obtain actual Linux RED before changing acceptance. The three new cases are two passing twins
and one aggregate that collects only fully settled false successes at both named cancellation windows.

### Late-cancellation regression RED

Run 34159934936, job 101859408764, failed at exact source
d44c72d9187022805da91d6d82b2822ece40e603. Job duration was 2m24s (20:34:42Z–20:37:06Z on
2026-09-07). All 291 preceding cases passed, including both non-cancelled completion-barrier twins.
The final aggregate failed with TWO exact false successes: child-closed-hook-held and
released-observation-held each accepted normal_exit7, outer0, no signal, EOF, expected application
marker, and empty stderr after the owned controller had been cancelled. No skip or setup error
established this RED. The suite took 22.05s with 21.74s test bodies.

Two clean builds still matched all 29 artifacts. The genuine observer binary remained
67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d. The failed run retained
/tmp/flow-observer-transport-527Jpp on its ephemeral host, not a persistent archive.

Now correct acceptance after capture hooks and after genuine release, preserving the exact abort
reason and earlier operation/release errors. A final observe check is also required before returning
across its await continuation. The reproduced schedules qualify the first two windows; the final
return check enforces the same source-audited invariant but does not prove every possible microtask
interleaving. No check can revoke an already fulfilled promise; downstream classification must check
its own current cancellation state. Keep the barriers and exact rejection regression unchanged.

Primary-source cross-checks support the test design: Node documents child close after process
termination and stdio closure at https://nodejs.org/api/child_process.html#event-close, and exact
abort reason propagation at https://nodejs.org/api/globals.html#abortsignalthrowifaborted. These do
not establish relay disposal. Linux pipe(7), https://man7.org/linux/man-pages/man7/pipe.7.html,
also distinguishes small nonblocking atomic writes from genuine partial writes; seccomp errno
denial is not a partial-record control. Exact pinned Node documentation URLs were unavailable
through the web tool; current official API documentation corroborates these longstanding semantics.

Four report-fault tests were written before their launcher implementation. Each validates actual
passthrough normal7 and requires the same expected-failure assertion to reject it independently of
the launcher label, then tests the targeted syscall denial. The new launcher modes map to fixed
descriptors3/6/5/7 only, preserve all original mode indices and signal-state ranges, and do not deny
application execution. No new production header, patch, artifact mode, or model setting changed.

The correction passed independent source/test/documentation review with no P1–P3 findings. The
reviewer independently authenticated the RED run and both false-success diagnostics. Full typecheck,
production build, lint, formatting, pinned-source checks, all 375 focused regressions, all 41
documentation/workflow contract tests, documentation gates, and whitespace checks pass. Native Mac
collection skips 296 cases; it does not qualify the correction or report controls. The unchanged
informational lint note remains. All five modified files are scoped to this test-helper correction,
test-only syscall controls, and their evidence. Next action is the actual Linux GREEN gate.

### Late cancellation and terminal reporting GREEN

Run 34160441703, job 101860982994, passed at exact source
2f9552b1c958ddb734d7ae17a4bb978bbe6c79a8. Job duration was 2m23s, from 20:42:46Z to 20:45:09Z
on 2026-09-07. All 296 cases passed with zero skips: prior 289, four report-fault cases, two real
non-cancelled barrier twins, and the final aggregate for both previously failing cancellation windows.
The suite took 28.63s with 28.16s test bodies. This is a single-run measurement, not a benchmark.

Two clean builds matched all 29 artifacts. Genuine binary SHA-256 remains
67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d and its object remains
2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b. Mutant binary remains
6d3cc6fd7f49a28f70e0d70e7cacd6f527d7471bae4e1b7b0a45b74bc5156c8b. The run retained
/tmp/flow-observer-transport-yvKKVz on its ephemeral host; this is not an uploaded archive.
Independent authenticated GitHub verification corroborated source, job, counts, timings, identities,
retained path, and qualification limits.

The same genuine runtime now rejects each previously accepted cancelled observation with the exact
owned cancellation reason, after callbacks and genuine release settle. Non-cancelled controls pass.
The four fixed-descriptor faults produce the specified missing-report/outer-failure or complete
supervisor-failure outcomes while preserving application output, and the identical assertions reject
actual passthrough successes. These results close LC-1, LC-2, RP-1, RP-2, and RP-3 for the tested
profile. They do not prove every microtask interleaving, native graceful forwarding, closed-peer or
partial reporting, arbitrary applications, immutable custody, policy history, fixture denial, or
outer-relay disposal. No production observer code, model pilot, credentials, merge, release, or
repair enablement changed. UC-01, UC-05, VR-02, and the full usable-checkpoint objective stay open.

The auxiliary read-only next-step audit for absent/readerless result channels returned partial
notes, then failed at the agent service's safety check. Its analysis is incomplete, not independent
design approval or qualification. No implementation or retry of that subtask occurred. Existing
closed-reader, partial-report, native cancellation, custody, and policy gates remain recorded as open.
This goal turn made verified progress by reproducing two real acceptance gaps and verifying their fix.

Final four-file evidence review found no P1–P3 issues. All 41 documentation/workflow contract tests,
all three documentation gates, and whitespace checks passed after the GREEN update. Save this
evidence locally without rerunning an identical native build. Implementation remains on the dedicated
qualification branch; the ordinary draft PR, main, and published release remain unchanged.

### Native invocation rejection qualification

The previous turn made verified progress: two real cancellation acceptance gaps were reproduced,
fixed, and qualified alongside four reporting controls. Current tree was clean at e56465b. GitHub
still reports run 34160441703 successful at 2f9552b. The full usable-checkpoint goal remains active.

Continue with a separate open requirement: native invocation rejection before application execution.
Do not retry the interrupted closed-reader audit or treat its partial notes as approved design.
All closed-reader and broader observer gates remain open; selected invocation controls do not replace them.

INV-1 covers selected argument rejections: 63-character correlation, nonhex correlation character,
wrong separator, and relative application argv0. INV-2 covers a leading-digit environment name and
an entry without an equals sign. Mutate only inside the trusted test launcher after its original
invocation and descriptor calibration and after shell startup. Preserve the exact helper executable,
valid held application FD, and host correlation. No scripts, preload configuration, user environment
values, network, credentials, production observer changes, or policy changes are involved.

Every malformed case must yield exact outer1, no signal, zero private bytes, null decoded record,
actual EOF, empty application output, and only the calibrated launcher marker. A mismatched frame
cannot satisfy zero-byte evidence. The same outcome assertion must reject a real validated
passthrough normal7 result independently of its different launcher label. A one-entry valid
environment must execute actual normal7 both as a separately registered control and immediately
before each malformed environment. This excludes missing ambient environment as a false explanation.

Seven runtime cases were written before launcher support (one valid-environment control and six
invalid cases). Existing production validation is unchanged: these qualify selected existing paths,
not a newly discovered production defect. Actual passthrough rejection provides live assertion
sensitivity. The original 296 cases, final cancellation aggregate placement, two-build recipe,
artifact identities, deadlines, and non-cancelling feedback branch remain unchanged. Expected native
total is 303 with zero skips. Full envelope limits, blocked variable families, immutable identity,
policy history, native cancellation, fixture denial, and relay custody remain separately unqualified.

Local checks before native qualification passed: type checking, lint, formatting, production build,
pinned-source integrity, all 375 focused verification tests, and all 41 documentation/workflow tests.
Lint retained the existing informational unnecessary-constructor notice in the unchanged external
adapter. macOS registered and skipped all 303 Linux-only cases; these are not native passes.
All documentation gates and whitespace checks passed after replacing one prohibited prose word.
Independent source, test, and documentation review found no P1–P3 issues. All five changed files
belong to this slice. The qualification branch was revalidated at 2f9552b before a non-forced push;
the ordinary draft PR and main remain unchanged. Native results are still pending.

### Native invocation qualification result

Run https://github.com/synaptiai/flow-harness/actions/runs/34161291314 completed successfully at exact
commit 0c3d6a91c07682c3e98eb299eca684f6a3749f2d. Job 101863499854 ran from 20:56:41Z to 20:59:05Z
on 2026-09-07 (2 minutes 24 seconds). All 303 cases passed with zero skips: prior 296 plus one valid
minimal-environment control and six malformed-input cases. Suite duration was 32.62 seconds;
test execution was 32.15 seconds. This single run is not a performance benchmark.

Two clean builds matched all 29 artifacts. Genuine observer SHA-256 remained
`67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d`;
its object remained `2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b`.
The separate false-normal control remained
`6d3cc6fd7f49a28f70e0d70e7cacd6f527d7471bae4e1b7b0a45b74bc5156c8b`.
The diagnostic root `/tmp/flow-observer-transport-cqUgnY` was retained on the ephemeral runner,
not uploaded as a persistent archive. Build evidence continues to report `observerQualified: false`.

INV-1 and INV-2 pass for the selected inputs. This is native evidence of existing validation paths,
not a production defect correction or complete envelope qualification. Immutable identity, other
writer/reporting paths, native cancellation, policy interference, fixture denial, host integration,
and relay cleanup remain open. No repair enablement, model pilot, merge, or release occurred.
The full usable-checkpoint goal remains active. Record these results without rerunning identical
native binaries for documentation-only changes.

An independent authenticated evidence check corroborated the exact commit, run, job, test totals,
timings, artifact equality, hashes, and ephemeral retention scope. Final four-document review found
no P1–P3 issues. All 41 documentation/workflow tests, three documentation gates, and whitespace
checks passed after the evidence update. Save this evidence as a local documentation-only commit.

### Native interruption and host escalation qualification

Previous turn classification: verified progress. The clean current tree began at 1d8d7d3. GitHub
revalidation confirmed run 34161291314 terminal success at 0c3d6a9 and the dedicated branch at the
same commit. No live job required resumption. The full usable-checkpoint goal remains active.

Discovery found the existing TypeScript/Vitest/Node quality commands and Linux C fixtures. No LSP
tool is available; use source tracing, TypeScript diagnostics, C compilation, and actual Linux
execution. Heavy checks remain serial. Independent critical-path review selected native cancellation,
not additional scalar invocation tests, as the next prerequisite for managed observer integration.

Trace: observer-application.h forwards signals to its exact recorded child, retries interrupted waits,
and checks interruption only after child settlement. TERM-resistant applications therefore require
external escalation in the current implementation. This is not yet a reproduced production defect.
The Prime process driver provides a separate process-group lifecycle but not this observer's private
result contract; copying that supervisor would not qualify this path. Linux documentation confirms
the special namespace-init signal behavior and kernel termination of namespace members on init death:
https://man7.org/linux/man-pages/man7/pid_namespaces.7.html . Signal-handler operation constraints:
https://man7.org/linux/man-pages/man7/signal-safety.7.html . These references guide controls, not runtime proof.

Compared three methods: a host AbortSignal-only check would repeat prior helper evidence without
testing native forwarding; a new production readiness/supervision protocol would enlarge the change
before a failing case; an owned trusted launcher plus existing independent host process probes tests
the actual helper without production changes. Use the third method under existing qualification
approval. No new model, credential, repair, merge, or release authority is inferred.

NC-1: no-TERM control must produce real normal0 with descendant settlement. NC-2: send TERM only
to the launcher's direct unreaped helper child after the host releases an existing read-only gate;
the fixed application acknowledges actual TERM then exits0. Require protected supervisor_failed,
EINTR, settlement, normal outer0 and EOF; challenge the same assertion with NC-1. NC-3: a fixed
TERM-resistant application acknowledges receipt but remains alive. Host then aborts through existing
bounded capture escalation. Require the exact cancellation rejection, actual owned ChildProcess close,
private EOF/no bytes, genuine sandbox release, and independent descendant pidfd termination and
original-identity absence. The probe uses the outer test signal so observation cancellation cannot
destroy its evidence mechanism. No PID from candidate output becomes signal authority.

Application readiness does not prove native forwarder readiness: both supervisors install handlers
after fork. Preserve unexpected race outcomes as RED, without sleeps/retries or weakened assertions.
The launcher has one monotonic three-second gate/settlement budget beneath the existing four-second
capture deadline. It closes parent copies of FD3/4/19, checks no-auto-reap SIGCHLD, and never signals
after reaping/ECHILD. Its TERM-request marker precedes kill so immediate host escalation cannot race
the marker; the application's separate exact receipt proves delivery. Fixture expiry remains failure.

Tests were written before launcher support. The production observer is unchanged until a real defect
is reproduced. A separate agent owns the fixed application extension; root owns tests/launcher, and
an independent reviewer checks ownership, lifecycle, and evidence. Three new runtime cases preserve
the prior 303 and final late-cancellation aggregate. macOS collection skips 306 cases, not native
passes. Type checking, lint, formatting, and all 16 real-file readiness tests passed locally.
The existing informational adapter lint notice is unchanged. Public guide and architecture now
describe these pending test-only boundaries. Full cancellation, immutable custody, policy history,
fixture denial, host integration, and outer-relay gates remain open.

Pre-native review found one P3: the three new cases inherited a 30-second watchdog while combined
schedules can consume more within existing inner limits. Set the same 45-second watchdog as
neighboring native cases; no execution, release, cleanup, or model budget increased. Final source
and four-document review found no remaining P1–P3 findings. All 376 focused verification tests,
41 documentation/workflow tests, documentation gates, build, source integrity, typecheck, lint,
format, and whitespace checks passed. The nine changed files are all in scope. Native execution
is pending; local collection and static C syntax checks are not native qualification.

### Native interruption qualification result

Run https://github.com/synaptiai/flow-harness/actions/runs/34162298538 completed successfully at exact
commit a234415cc7f9ef1c2404bff58082bb51f5a74ccf. Job 101866433013 ran from 21:12:51Z to 21:16:58Z
on 2026-09-07 (247 seconds, 4 minutes 7 seconds). All 306 cases passed with zero skips: prior 303
plus NC-1, NC-2, and NC-3. Suite duration was 24.59 seconds; test execution was 24.17 seconds.
The longer job duration included a 163-second native-build comparison, not a test timeout.
No retry or replacement run occurred. This is one qualification run, not a performance benchmark.

Two clean builds matched all 29 artifacts. Genuine binary SHA-256 remained
`67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d` and object remained
`2698198d70f40e46280a6aae806c4b5397cef932e280a31c51125b32c88fca6b`. Separate mutant remained
`6d3cc6fd7f49a28f70e0d70e7cacd6f527d7471bae4e1b7b0a45b74bc5156c8b`.
Build evidence still reports `observerQualified: false`. Diagnostic root
`/tmp/flow-observer-transport-9YLahJ` was retained on the ephemeral runner, not uploaded as an archive.

An independent authenticated review corroborated the exact run, source, job, counts, times, hashes,
and retention scope. NC-1 exposed an actual private normal0 result. NC-2 observed actual TERM receipt
and protected supervisor_failed/EINTR/settlement for the cooperative exit-zero fixture; interruption
is checked before raw worker status is exposed, so do not claim independently witnessed raw exit0
for that interrupted worker. NC-3 observed receipt before host abort, actual owned process SIGKILL
closure, private EOF with zero bytes, completed real release, and independent held-descendant
pidfd termination/original-identity absence. This is the tested host escalation path, not native-only
bounded escalation, complete relay cleanup, or every startup/cancellation race.

No production observer defect was reproduced in these controls, so its implementation was not
changed. The source-defined post-fork handler race and remaining custody/reporting/policy/fixture
gates remain open. Continue with runtime custody and owned relay settlement before managed-boundary
integration. No model pilot, repair enablement, merge, or release occurred. Goal remains active.

Final four-document evidence review found no P1–P3 findings. All 41 documentation/workflow tests,
all three documentation gates, and whitespace checks passed after this update. Save the evidence
in a local documentation-only commit without rebuilding identical native inputs. The dedicated
qualification branch contains a234415; the ordinary draft PR, main, and release remain unchanged.

### Host-bridge lifecycle integration decision

Read-only source review after the 306-case native result identified a distinct integration gap.
Installed @anthropic-ai/sandbox-runtime 0.0.70 linux-sandbox-utils.js:433-556 creates bridge
ChildProcess handles but can signal children and throw before returning the context. The public
manager API does not expose those handles. sandbox-manager.js:1475-1528 resolves timeout cleanup
after sending SIGKILL without joining the resulting termination. Reset at 1608-1642 then proceeds
with socket removal. The socat fork option creates another descendant-settlement obligation.
These are source-derived gaps in the evidence contract, not a reproduced runtime leak.

Flow's current adapter delegates reset; wrapping that return value cannot establish missing
ownership. External proxy ports still create Linux bridges. Reimplementing the lower-level
manager would duplicate mux/authentication/filtering/TLS behavior. A dedicated manager process
adds isolation but still needs authenticated descendant ownership and bounded IPC. Neither
parent closure nor PID discovery is complete descendant proof. Node's official child-process
documentation independently confirms signal-request versus termination semantics.

The canonical design now compares RL-A (recommended narrow observer-only lifecycle patch), RL-B
(dedicated manager process), and RL-C (lower-level reimplementation). RL-A is a proposal distinct
from the already approved native-supervisor extension. Its descendant-ownership mechanism must be
designed before implementation; no privileged provisioning is assumed. This turn does not patch
SRT, change production execution, close custody gates, or claim new Linux runtime passes.
Keep goal active and repair disabled. Obtain the substantive architecture decision before changing
the JavaScript dependency lifecycle boundary. The prior closed-reader audit remains incomplete;
this separate ownership review does not repeat or resolve it.

Independent review found no P1-P3 findings in the three-file proposal. All 41 documentation/workflow
tests, docs:style, docs:links, docs:ste, and whitespace checks passed. Documentation-only change:
no new native run is needed to validate unchanged native inputs. Save locally without pushing,
updating the draft PR, or changing the qualified source identity.

### Descendant mechanism research while RL-A is pending

The preceding goal turn made progress by recording and reviewing the lifecycle decision at c9baed0.
Revalidated that exact clean worktree. No RL-A approval or live process was inferred from the
automatic goal continuation. Continued only the unresolved, read-only mechanism investigation.

Primary Linux documentation distinguishes pidfd process-group signaling (Linux 6.9+) from tree
settlement, subreaper adoption from discovery-based ownership, and delegated cgroup subtree control
from ordinary user namespace access. The hosted workflow installs prerequisites with sudo but runs
tests nonroot. It does not establish a delegated cgroup contract.

Independent source inspection and root cross-check of bubblewrap v0.9.0 found monitor_child returns
on workload eventfd (512-525), while do_init can still be waiting for descendants (587-614).
--as-pid-1 suppresses that eventfd/init fork (2639,3080), but changes relay PID1 behavior and does
not independently join namespace teardown when the outer monitor is killed. Keep normal completion,
owner-death startup races, and host escalation distinct. No new native experiment ran.

The canonical proposal now names the mechanisms, their proof obligations, and a namespace-first
evaluation order using existing prerequisites. This does not select a production mechanism or
authorize a new supervisor, cgroup provisioning, SRT patch, pilot, or repair enablement. Source
review is not runtime qualification. The 306-case native result and full goal scope are unchanged.

Independent final review found no P1-P3 findings. All 41 documentation/workflow tests and the three
documentation gates passed. Both changed files are in scope and already belong to the issue branch.
Save this research-only delta locally. No dependency, native artifact, CI job, or public capability
changed, so no new native qualification or capability regeneration is claimed.

### RL-A approval and first executable release contract

User explicitly approved RL-A. This clears the dependency-lifecycle decision blocker, not the
remaining qualification gates. No pilot, model transmission, repair enablement, merge, or release
is authorized by this approval. Preserve ordinary SRT execution and the existing native result.

Parallel source investigations found that unmodified bwrap still needs a bound PID1 termination
witness beyond its early monitor result. Select a narrow native subreaper owner for each distinct
trusted bridge, retaining an unreaped group leader until the final group signal and then reaping
all owned children. Group/ancestry preservation of the admitted relay is a required premise, not
an assumed guarantee for arbitrary programs. Loss of the guardian makes cleanup unconfirmed.
This does not guarantee cleanup after the complete ownership hierarchy is killed.

Delivery stages now cover the direct-bridge RED test, native owner qualification, a separately
identified SRT dependency tree, and observer integration. The package tree must preserve SRT's
nested Zod 3 rather than resolving root Zod 4. Initialization failure must retain owned bridges
before asynchronous waits and must await cleanup instead of clearing state and detaching reset.

The new Linux x64 runtime test uses actual socat and a real loopback echo server. It verifies exact
forwarding before requesting the future owner release protocol. Baseline mode deliberately runs
the existing direct bridge shape and expects the missing joined release/terminal receipt contract
to fail. It is test-only, not a fallback and not a claim of reproduced descendant leakage. The
dedicated development workflow runs this RED step before the unchanged native build and 306 tests.
No production guardian has been written before this RED observation.

Pre-run review found and fixed cleanup coverage for listener startup, cancellation admission and
late acceptance checks, and stale mechanism-selection wording. Cleanup is independently bounded
and preserves failures and diagnostic directories. Local Docker is Linux aarch64, not x64, so it
does not replace the hosted acceptance profile. No emulation or new local Linux setup was started.

### Verified direct-bridge RED and native-owner implementation

Run https://github.com/synaptiai/flow-harness/actions/runs/34164823372 failed at exact
9f0d777a5d030fa4af9f8469685150352f2b0826, job101873684216. The job ran 21:55:03Z-21:56:04Z
on September7 UTC. The sole test failed in4.04s with zero skips. Authenticated logs serialized the
exact assertion: owner release expected normal closure {code:0,signal:null}, but got undefined
after4s. Forwarding, spawn, output-bound and stderr checks passed first. No emergency-cleanup
failure was reported. The native build and306 transport checks were skipped, not failed or rerun.
No descendant-leak assertion is inferred from this missing new protocol.

After this RED was verified, the implementer started the standalone native owner. Root separately
wrote and observed failing tests for source freezing and the real owner workflow step. The build
now freezes the new C input and requires its source, binary and relinkable object in both outputs.
The original upstream and application-result sources are unchanged. New disconnect and malformed
control cases exercise real forwarding before denying normal acceptance. Native GREEN is pending.

The source review confirms a two-way handshake before bridge execution, a checked single-threaded
subreaper, and an unreaped leader retained through the final process-group signal. Only then does
the owner reap to ECHILD. Exact stop plus EOF can produce SETTLED and exit 0; malformed control,
disconnection, interruption, startup failure, and output failure cannot. These are source-level
observations, not completed native qualification. Linux wait, subreaper, and signal documentation
was independently cross-checked. Ancestry and executable custody remain admission obligations.

Independent code, test, build, workflow, and documentation review found no P1-P3 findings. The
45 build/workflow tests passed. Broader local checks passed 360 cases and encountered three
sandbox-denied Unix-socket binds; all four cases in that compatibility file passed with the
required local socket permission. Typecheck, lint, formatting, production build, and documentation
gates passed. Lint retains one unrelated informational constructor notice. Linux runtime results
are still pending; macOS is not substitute evidence. Commit this scoped development increment
and push only the existing dedicated native-qualification branch for its approved Linux test.

### First owner build attempt and diagnostic correction

Run 34165421260 at fad9d88d80af050602fcf7908c953eb1688c071d failed in the Docker build step,
before either runtime test suite. The retained GitHub log reported only a generic Docker-operation
failure and an ephemeral scratch path. This evidence cannot distinguish compilation from build
infrastructure failure. Do not infer the cause or claim a native pass.

The launcher had captured Docker output but discarded it on failure; a later cleanup exception
could also hide the original error. Add bounded JSON diagnostics at each operation failure before
aggregation. Preserve failure exits, existing deadlines, and the 1 MiB output stop. Output encoding
is not secret redaction. No arguments, environment variables, or credential configuration are added
to diagnostic records. This path receives only the trusted documented build inputs.

Three actual Node subprocess tests first failed on the absent formatter, then exercise escaped,
truncated, and empty diagnostics. Importing the formatter does not execute CLI commands; direct CLI
execution remains covered by the existing source-freezing and artifact-comparison tests. Node's
documented import.meta.main is present on the pinned 26.7.0 runtime. No substitute Docker process
or mock native evidence is used. The hosted retry must exercise the actual Docker path.

All 47 source/build/diagnostic tests passed. Typecheck, lint, formatting, and the three documentation
gates passed. Independent review found no P1-P3 findings; its explicit limit is that formatter tests
do not prove Docker failure-path behavior. The guardian C bytes and runtime cases are unchanged.

### Reproduced bridge startup failure and canonical-input correction

Run 34165789137 at b5a183a79e661f44a13f1f10e034aec0abe1d5ce compiled both clean builds and
matched all 32 artifacts. The guardian binary identity was
1b5c57faf55976a30d8161bac667ec960b43279e22a3231abe0ae3698c729dff and its object was
4cda7ac749e727c777484810004f3bea38d8b3a5195f9ac6a74e4c79274ce6f8. All three bridge runtime
cases failed with ENOENT before forwarding. Test duration was 9.04 seconds, with zero skips;
the 306 application-result cases were skipped. The previous build failure's cause remains unknown.

Source review found the test passed literal /usr/bin/socat while the guardian requires canonical
realpath equality. Ubuntu's package inventory includes socat and socat1; an alias is a hypothesis,
not yet authenticated runner evidence. Resolve the test-owned relay argument before guardian
spawn and recheck cancellation after that await. Preserve the direct baseline invocation and
all guardian checks. Record actual relay realpath in the hosted prerequisite step. Retain bounded
pre-emergency-cleanup process state on test failures, so cleanup cannot obscure startup results.
The new workflow expectation failed before adding that diagnostic command, then passed.

Independent code/test and documentation reviews found no P1-P3 findings in this correction.
Typecheck, lint, formatting, and documentation gates passed. The three Linux cases are skipped
on this Mac and still require hosted execution. The full non-live single-worker suite remains
running separately; no full-suite pass is claimed before it finishes.

### Qualified initial guardian release increment

Authenticated run 34166357915 succeeded at exact 02807d799fa3f359db727ae8ca813b691971e941,
job 101878052320, September 7 UTC 22:21:00-22:23:34 (154 seconds). Three real owner cases passed
without skips (4.57 seconds of tests, 4.73-second suite), and all 306 existing application-result
cases passed without skips (32.01 seconds of tests, 32.47-second suite). Both clean builds matched
32 artifacts. Guardian binary/object hashes match the preceding recorded build. Genuine observer
binary/object and deliberately false-normal binary hashes match the previously qualified identities.

The actual hosted prerequisite output was /usr/bin/socat1. Together with the unchanged guardian
binary and exact canonical-argument check, this confirms the installed alias required resolution.
The correction did not relax native admission or alter baseline invocation. The earlier Docker
failure remains unattributed because its output was not retained.

Separately exercised the actual Docker CLI against a new test-owned unavailable Unix socket with
an empty private DOCKER_CONFIG and no credential inputs. The real launcher exited 1 and emitted
the structured Docker failure record (Docker code 1, 336 output bytes) plus its failure message.
The empty temporary directory was removed after the check. This verifies the real diagnostic
failure path, not native build reproducibility or every cleanup-failure combination.

The roadmap now distinguishes completed direct-bridge RED, partial native-owner qualification,
and unimplemented isolated-manager stages. The next real-descendant test must hold the connection
open through receipt and independently sample pinned leader/child termination and identity absence
before any test socket cleanup. Source/readiness observations are not immutable custody, complete
ancestry enumeration, or an atomic receipt-time oracle. Keep repairs disabled and the goal active.
No merge, release, model transmission, or credential change occurred.

Independent review re-fetched the authenticated GitHub evidence and corroborated the exact source,
job times, counts, hashes, and relay path. No P1-P3 findings in the four-document evidence update.
All 30 focused documentation/workflow tests and the three documentation gates passed. Save this
documentation-only record locally without another unchanged native run. The broad single-worker
non-live test process is still running; its eventual result is separate and must be inspected.

### Prepare the active-connection failing control

The broad single-worker local suite finished with 477 files passed, one file skipped, 7,118 tests
passed, and four tests skipped (1,047.82 seconds). The four cases require Linux and were skipped
on this Mac. This process began before the latest test/documentation edits, and excludes runtime,
live, and browser suites; it does not qualify the new descendant test or an exact final source tree.

Added a real held-connection test and strict test-only bridge-probe wrapper. Admission is rooted in
the Node-owned guardian PID, exact relay arguments, and the host UID. The proposed probe records
both leader and connection identities. Acceptance requires both pinned processes terminated and
their original identities absent, observed from the terminal-receipt callback before test socket
cleanup, plus normal guardian closure. It is not an atomic receipt-time observation or exhaustive
ancestry proof. The native oracle remains unchanged until the hosted missing-mode RED is verified.

Independent review found and resolved a P2 cross-stream ordering assumption and a P3 incomplete
stdin-finish join. The test now awaits OWNED independently from the network echo. Probe cleanup
joins input completion and child closure under one bound while retaining failures and emergency
join uncertainty. Re-review found no remaining P1-P3 in the test-only increment.

The workflow test first failed because the active-descendant step was absent, then passed after
adding it. Typecheck, lint, formatting, and the build passed; lint retains one unrelated informational
constructor suggestion. The new runtime case is skipped on macOS. The next hosted run must fail
because the unchanged real C oracle rejects bridge mode after real forwarding; unrelated startup
or test failures would not establish the intended RED. Later application-result cases will skip
after this deliberate failure. No repair, model, credential, merge, or release action is authorized.

Hosted run 34167558669 at exact f1bf2151bd71a79f1f2e36c4e29aedd3530f7b84 failed in the new
active-descendant step after successful real forwarding and OWNED receipt. Both clean builds and
the three existing owner tests passed; the later application-result step skipped. The wrapper's
sticky control-stream failure hid the actual checker exit status, so this is not yet authenticated
missing-mode RED. Preserve the actual joined checker exit alongside the first error and rerun
before changing C. The test reported no additional guardian emergency-cleanup failure.

Run 34167826719 at exact bec765ec8ade46df90249a31d794180e2bab8693, job 101882280445,
completed September 7 UTC 22:46:53-22:49:04. The failing log's serialized AggregateError retains
both control failure and actual joined checker closure {code:2,signal:null}. Source argc7 bridge
rejection and the preceding forwarding/OWNED assertions establish the intended missing-mode RED.
There was no reported additional guardian cleanup failure; this does not prove independent
descendant settlement. Both clean builds and three owner cases passed; downstream native tests
skipped. Only after this evidence was read was the C-only implementer authorized to proceed.

Post-GREEN controls remain required: exact-argv mismatch with an authenticated discovery rejection
and correct positive twin; two independently forwarded connections with explicit ambiguity
rejection and a fresh one-connection positive twin; real zombie/reaped calibration through shared
observation semantics and the acceptance predicate. Do not infer reaping from socket closure,
accept arbitrary wrapper errors as negative success, or signal discovered PIDs.

The C-only implementation adds bridge discovery with exact bounded three-argument cmdline matching,
canonical relay input, live UID/parent/group/session checks, fresh proc directory scans, and three
retained pidfds. A full topology rescan follows acquisition. Both child pidfds are sampled before
either settlement proc read. Existing known/discover output is unchanged and shares the extracted
observation primitive, including real zombie-versus-reaped semantics. Post-release reparenting is
not an identity change. No discovered process is signalled. Native compilation and active runtime
success still require the hosted run; local TypeScript checks do not substitute for them.

Independent full C review found no P1-P3 findings in argument bounds, fresh scan offsets,
identity acquisition/recheck, protocol bounds, cleanup, or existing-mode compatibility. Typecheck,
lint, formatting, build, all 21 focused documentation/workflow tests, and documentation gates passed.
The reviewer independently authenticated the RED source and hosted log. Push this five-file
implementation/evidence increment only to the dedicated qualification branch for actual native
compilation and the initial active-descendant GREEN attempt. Keep all further qualifications open.

### Initial active-connection GREEN

Run 34168249470 succeeded at exact 6542ec64c92d2f7ec5223bc1da845bc2dce06912,
job 101883466549, September 7 UTC 22:54:36-22:57:10 (154 seconds). Three owner cases passed,
the one active-connection case passed, and all 306 original application-result cases passed,
with no skips. Active suite duration was 3.03 seconds (2.88 seconds tests, including compilation);
the existing suite took 21.41 seconds (21.09 seconds tests). These timings are not benchmarks.

Both clean builds matched all 32 artifacts. Guardian binary
1b5c57faf55976a30d8161bac667ec960b43279e22a3231abe0ae3698c729dff and object
4cda7ac749e727c777484810004f3bea38d8b3a5195f9ac6a74e4c79274ce6f8 are unchanged.
Genuine observer and deliberately false-normal binary hashes also match the previous qualified
identities. The C test oracle was compiled separately in the test and is not one of those 32 artifacts.

The real held connection established live leader/child identities, rejected the live settlement
predicate, then observed both terminated and original identities absent from the receipt callback
before test socket cleanup. Actual owner closure also passed. Existing real zombie controls passed
through the shared observation primitive. This is not explicit zombie calibration of both roles in
the new predicate, exhaustive ancestry enumeration, an atomic receipt sample, or immutable custody.

Continue with authenticated argument-mismatch and ambiguity negatives plus explicit predicate
calibration before the remaining stage-2 startup, cancellation, owner-loss, and custody gates.
Stages 3/4, repair enablement, pilot, merge, release, and UC-01/UC-05/VR-02 remain uncompleted.

Independent verification re-fetched the GREEN run and corroborated its exact source, counts,
timings, and identities. Final review of the five-document evidence update found no P1-P3 findings.
All three documentation gates and 21 focused documentation/workflow tests passed. Commit this
evidence-only update locally without triggering another unchanged native build. The implementation
is already on the dedicated qualification branch. Keep the goal active for the next negative controls.

### Prepare exact rejection and real predicate controls

Previous turn was progress: implemented and qualified the selected real held-connection path.
Current source was clean at 29ea1e3 before this increment. Native C remains unchanged.
Parameterize the active test with one-byte expected-argument mismatch and two independently
forwarded held connections. Require named bridge-discovery rejection with exact Linux EPROTO71
or EEXIST17, plus clean natural checker closure. The current wrapper rejects native errors
generically, so both new cases must first fail on hosted Linux before typed rejection handling.
The fresh settlement fixture remains the positive twin; socket closure is not a reaping witness.

Move the unchanged settlement predicate into the shared test helper. A parallel test-only task
exposes frozen actual live/zombie/reaped records after the existing calibration parent and probe
have both joined. The new predicate runtime gate runs two independent real calibrations and checks
both roles against those snapshots. It also demonstrates the known-bad termination-only predicate
accepting real unreaped data. This is sensitivity calibration, not simultaneous bridge-tree evidence.
The workflow test failed on the missing calibration step before that step was added. All remaining
stage-2 and manager-integration gates remain open. No repairs, model, credentials, merge, or release.
