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
