# Complete a GitHub issue with Flow

Use the GitHub issue lifecycle to implement one issue in another repository. Flow verifies the
change, publishes a pull request, and waits for hosted checks. It merges only after your
explicit approval. The lifecycle preserves evidence from the frozen issue through the merged
commit.

Flow treats the issue, repository content, model output, review text, and hosted-check output as
untrusted data. The model doesn't receive GitHub credentials, network access, access to `.git`, or
merge authority. A host-owned controller performs only the Git and GitHub operations allowed by
the reviewed plan.

This guide covers one `github.com` repository and one issue. For the normative behavior and plan
fields, read the [GitHub issue lifecycle specification](../specs/github-issue-lifecycle.md). For
host preparation and interruption handling, read the
[GitHub issue lifecycle operations runbook](../operations/github-issue-lifecycle.md).

## Availability

Current source registers the `flow issue` command group. The published `0.1.0-alpha.4` package
doesn't include it. Use the lifecycle only from a release whose `flow --help` output lists
`flow issue`, and confirm that release's notes name the GitHub issue lifecycle as qualified.

The first qualification uses one bounded external-repository issue. That evidence proves the
frozen repository, issue, provider, model, host, and checks named by the run. It doesn't establish
compatibility with every project or replace your repository's branch protections.

## Before you begin

Prepare these requirements:

- Use a supported x64 Linux or macOS host with Node.js 26.7.0 or newer.
- Install Git, GitHub CLI, and the Flow release that includes `flow issue`.
- Use a clean, attached checkout whose `origin` identifies the issue repository.
- Configure Git to ignore `.flow/issue-runs/`. The path must contain no tracked files. If `.flow`
  or `.flow/issue-runs` exists, it must be a real directory and not a symbolic link.
- Sign in to `github.com` with GitHub CLI as an account that can read the issue and push a branch.
- Confirm that the same account can create a pull request and merge after repository rules pass.
- Know the exact required GitHub Actions check names and source GitHub App identities for the base
  branch.
- Create separate implementation and review workflows. The review workflow must be read-only and
  independent of the implementation attempt.
- Create a deterministic behavioral holdout that fails on the untouched base and passes only when
  the issue outcome is present.

To check whether a later prerelease includes the controller, install the prerelease channel globally
without package lifecycle scripts:

```sh
npm install --global --ignore-scripts @synapti/flow-harness@preview
flow --help
flow compatibility check
```

The help output must list the `issue` command group. The compatibility report must have an
`overall` value of `compatible`. If either check fails, the lifecycle remains unavailable. Stop
before you use any other command in this guide.

Use [Author GitHub issue workflows](github-issue-workflows.md) to create and validate the two
workflow files. That guide includes complete templates, budget guidance, the structured review
result, and the exact data sent to the selected model provider.

Check the active GitHub account without displaying its token:

```sh
gh auth status --active --hostname github.com
```

If authentication fails, use the browser-based flow described by the
[GitHub CLI authentication documentation](https://cli.github.com/manual/gh_auth_login). Don't use
`gh auth status --show-token`, and don't add a token to the plan.

## Prepare the workflows

Create the implementation workflow under the target repository. Give it only the tools and
budgets needed to satisfy the issue. Flow supplies the frozen issue as untrusted input and confines
writes to the plan's `candidate.allowedPathPrefixes` entries. Keep deterministic checks out of the
model's discretion by declaring them in the plan.

Declare a `goal` in the implementation workflow. Give each entry in `goal.criteria` one stable,
unique `id`. Those IDs are the authoritative acceptance-criterion set that the review workflow must
map. Don't create a second criterion list in the plan or derive replacement IDs from issue prose.

Create a separate review workflow that:

1. Maps every frozen acceptance criterion to the exact candidate diff and evidence.
2. Reviews security, correctness, performance, reliability, maintainability, tests, and
   documentation.
3. Produces structured P1, P2, and P3 findings without writing to the candidate workspace.

Set `review.resultNode` to the exact agent node that produces the structured result. Flow accepts
only a successful, complete, untruncated result from that node. It doesn't guess which terminal
node represents the review.

The lifecycle invalidates review evidence after any candidate change. A review cannot approve a
different commit or a later repair.

## Write the lifecycle plan

Save a strict plan at `.flow/github-issue.plan.yaml`. Replace the example repository, branch,
workflow paths, writable paths, commands, and hosted-check requirements with reviewed values for
the target repository:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: GitHubIssuePlan
repository:
  expected: example/widgets
  baseBranch: main
branch:
  prefix: flow/issue-
implementation:
  workflow: .flow/workflows/implement-issue.workflow.yaml
candidate:
  allowedPathPrefixes:
    - src/
    - tests/
    - docs/
    - README.md
holdout:
  stdin:
    path: .flow/verification/issue-holdout.py
  command:
    executable: python3
    args: ["-"]
    timeoutMs: 120000
verification:
  - id: format
    command:
      executable: npm
      args: [run, format:check]
      timeoutMs: 120000
  - id: test
    command:
      executable: npm
      args: [test]
      timeoutMs: 300000
review:
  workflow: .flow/workflows/review-issue.workflow.yaml
  resultNode: review-result
  blockingSeverities: [P1, P2, P3]
hostedChecks:
  required:
    - name: CI / test
      sourceApp:
        id: 15368
        slug: github-actions
merge:
  method: squash
  deleteBranch: true
```

The `deleteBranch` value controls whether Flow asks GitHub to delete the branch during merge. Flow
records that request separately from the post-merge branch state because repository settings can
delete a branch automatically. If the plan requests deletion, Flow must observe that the branch was
deleted before it records the run as merged.

Command entries are argument vectors, not shell text. Put one executable in `executable` and each
argument in `args`. Shell operators, redirection, command substitution, and environment assignment
aren't interpreted. The plan cannot name `.git` or `.flow` as a candidate write location.

Store reviewed workflow inputs only under `.flow/workflows/` or another admitted source path.
Flow rejects links and real paths that escape the repository or resolve into private `.flow` state.
Each hosted-check requirement binds both the exact check name and the immutable source GitHub App
identity. Copy the positive numeric app ID and canonical lowercase app slug from a trusted check run.

Use a holdout that tests behavior specific to the issue. A general test command that already
passes on the frozen base doesn't prove that the candidate implemented the issue.

For a private holdout, store the reviewed source below `.flow/verification/` and set
`holdout.stdin.path`. Flow freezes the exact regular-file bytes before implementation. It binds the
SHA-256 digest and private blob reference into the run manifest.

Flow sends the bytes to the holdout command through standard input. The command uses the
verification worktree as its working
directory. Resolve repository files from that directory. The interpreter reads source from
standard input. Therefore, don't use `__file__` to locate the repository.

Choose an interpreter mode that reads a program from standard input. For example, use
`executable: python3` with `args: ["-"]` for Python or `executable: node` with `args: ["-"]` for
Node.js. The command receives the same frozen bytes for the base negative control and the candidate
positive control. Flow records `stdinHash` only after the process input pipe accepts all bytes.
This transport evidence doesn't prove that the application consumed the input. Choose an
interpreter mode whose successful execution requires reading standard input.

Flow doesn't add a dedicated input-byte field to command evidence. However, it retains exact
standard output and standard error as owner-only private evidence. A holdout that echoes its input
can copy source bytes into that evidence. Don't write private holdouts that print their source.
Public status, public events, and model context don't include private command output.

The native process sandbox supports private holdout input. The current container command backend
has an output-only attach channel and rejects stdin-enabled commands before execution. Use the
native sandbox for this preview feature, or omit `holdout.stdin` and use a nonprivate command whose
source is available in both Git trees.

A repository name can start with a dot. For example, `example/.github` is a valid canonical
repository identity. The owner component cannot start with a dot, and all repository identities
remain subject to the exact canonical syntax and length limits.

## Validate the plan

Validate the plan before Flow reads GitHub or changes the repository:

```sh
flow issue validate .flow/github-issue.plan.yaml
```

A successful result confirms the plan's shape, strict fields, paths, command vectors, unique
identifiers, supported merge method, and semantic bounds. It doesn't authenticate GitHub, inspect
the repository, or run commands.

If validation fails, correct the named field and validate the complete file again. Flow rejects
unknown fields instead of ignoring them.

## Diagnose the target

Check the live host, checkout, GitHub identity, issue, and plan without mutating the repository:

```sh
flow issue doctor https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openai \
  --model <supported-model>
```

Use the same provider and model for `doctor` and `run`. The diagnostic must succeed before you
start. Flow reads the exact configured remote
`refs/heads/<baseBranch>` ref and rejects a local or remote base mismatch. It also rejects a closed
or changed issue, repository mismatch, unsafe checkout, missing tool, authentication failure,
unsupported repository policy, or unavailable model sandbox.

Resolve the reported condition and repeat `doctor`. Don't bypass the check by changing the issue
URL, remote, base branch, or required checks to a less restrictive value.

## Start the issue run

Create and persist one universally unique identifier (UUID) before you call `run`. Reuse that UUID
only if the same command response is lost or uncertain. Submit the frozen issue and reviewed plan:

```sh
flow issue run https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openai \
  --model <supported-model> \
  --command-id <uuid>
```

Flow freezes the issue node, update time, remote base commit, and complete contract digest. It also
freezes the plan, template workflows, checks, holdout, budgets, and derived branch before mutation.
It then creates a Flow-owned isolated worktree and runs the bounded implementation. Flow creates
and records the exact candidate commit before verification. Next, it proves both holdout results.
It also runs every deterministic check.

After independent review clears, Flow pushes the Flow-owned branch and creates one draft pull
request. A separate transition makes that exact pull request ready for review. Only the ready pull
request can enter a merge gate.

If review or CI sends a published candidate back for repair, Flow keeps that pull request identity.
It commits and pushes the replacement candidate, then observes the same pull request as ready at the
new head. It doesn't create another pull request for the same run.

The command stops at a failure, a recoverable interruption, or `merge_approval_required`. It never
merges as part of `run`. Preserve the returned run ID and command ID. Repeating the same command ID
with different input is a conflict.

## Observe the lifecycle

Inspect the current public projection:

```sh
flow issue inspect <run-id>
```

Read a bounded page of durable public events:

```sh
flow issue events <run-id> --after 0 --limit 100
```

Use the last returned sequence for the next `--after` value. Public inspection contains the run
identity, current phase, sequence, event time, receipt count, and settled-effect count. It also
contains the latest bounded phase receipt, pending effect, or terminal code when present. Public
events contain bounded identities and digests. Both outputs exclude credentials and raw task
content. They also exclude command output, private error causes, and absolute paths.

Only `merge_approval_required` includes `mergeApproval`. That object contains
`pullRequestNumber`, `headCommit`, and `gateDigest` from the durable gate receipt. It disappears if
the gate becomes invalid.

The normal path reaches these milestones:

1. `issue_frozen` binds the issue and exact base commit.
2. `workspace_prepared` records the isolated Flow-owned worktree.
3. `implementing` records the exact candidate commit and nested implementation-run provenance before
   verification starts.
4. `verifying` and `reviewing` produce candidate evidence and nested review-run provenance bound to
   that commit.
5. `publishing` pushes the branch, creates the pull request as a draft, and makes the same exact
   pull request ready for review.
6. `waiting_for_ci` observes every configured hosted check against that head commit.
7. `merge_approval_required` exposes the bounded values required for explicit approval.
8. `merged` proves the approved commit is reachable from the base branch after GitHub reports the
   merge.

## Approve the exact merge

Wait until `flow issue inspect <run-id>` reports `merge_approval_required`. Review the pull
request, exact head, frozen base, deterministic evidence, and review result. Also review the check
source apps, comments, reviews, unresolved threads, mergeability, and merge method.

Copy the pull request number, 40-character lowercase head commit, and SHA-256 gate digest from the
same inspection result. Bind your approval to those values:

```sh
flow issue merge <run-id> \
  --actor local:operator \
  --expected-pr 42 \
  --expected-head <40-lowercase-hex> \
  --expected-gate-digest <sha256> \
  --command-id <uuid>
```

Flow re-reads GitHub immediately before merge. Any change to the issue, head, base, configured
check set, check run, review, comment, unresolved thread, mergeability, or merge policy invalidates
the gate. Resume the run so it can repeat verification and review. Then make a new approval
decision from the replacement gate.

Flow uses GitHub CLI's exact-head protection and never requests administrator bypass or auto-merge.
The [GitHub CLI merge documentation](https://cli.github.com/manual/gh_pr_merge) describes the
underlying `--match-head-commit` check.

## Verify the merged outcome

Inspect the run again after the merge command settles:

```sh
flow issue inspect <run-id>
flow issue events <run-id> --after 0 --limit 100
```

Require `merged`, the approved pull request identity, and the approved head commit. Also require a
proved merge commit, the planned branch-deletion request, its observed outcome, and post-merge
reachability from the configured base branch. A successful GitHub response without those
observations isn't proof of completion.

Keep the run evidence until your retention policy permits cleanup. One successful run proves only
the frozen issue, repository, host, provider, model, and checks that the evidence names. It doesn't
prove general compatibility with every project or task.

## Recover or stop a run

Inspect before every recovery action:

```sh
flow issue inspect <run-id>
```

If the phase is active or `external_state_uncertain`, continue the exact frozen run:

```sh
flow issue resume <run-id> --command-id <uuid>
```

Resume reconciles prepared but unsettled Git and GitHub effects against their exact identities
before it retries anything. It doesn't re-freeze a changed issue, silently adopt a moved base, or
create a second branch, commit, or pull request.

Don't resume `merge_approval_required`. Review and submit the exact `merge` command instead. A
`merged`, `failed`, or `cancelled` run is terminal and cannot resume.

Cancel work that you don't want to continue:

```sh
flow issue cancel <run-id> \
  --actor local:operator \
  --reason "operator stopped the run" \
  --command-id <uuid>
```

Cancellation preserves evidence. If publication already occurred, Flow leaves the visible remote
branch and pull request intact so cancellation cannot conceal external state. Follow the cleanup
procedure in the [operations runbook](../operations/github-issue-lifecycle.md#clean-up-a-settled-run).

## Resolve common failures

Use the phase and stable code from `inspect` to select an action from this table.

| Condition | Meaning | Action |
| --- | --- | --- |
| `flow_runtime_not_ignored` | The private run path isn't ignored, contains tracked content, or has unsafe directory ancestry | Preserve existing data. Configure `.flow/issue-runs/` as ignored, remove tracked runtime content through a reviewed repository change, and replace a symbolic-link or non-directory component with a real directory before retrying from a clean checkout |
| `negative_control_mismatch` | The base holdout passed, so the negative control cannot prove that the candidate caused the behavior | Strengthen the holdout, create a new plan identity, and start a new run |
| `candidate_holdout_failed` | The base holdout failed as required, but the candidate didn't satisfy the issue-specific behavior | Inspect private evidence, repair the reviewed workflow or plan, and start a new run with the replacement frozen identity |
| `verification_failed` | A deterministic project command failed | Preserve the workspace and inspect the command's private evidence |
| Review reports P1, P2, or P3 | The exact candidate has a blocking finding | Don't publish or merge. Fix the candidate and require a fresh review |
| Hosted check is missing, pending, skipped, or failed | The configured exact-head CI gate isn't complete | Correct CI or wait, then resume from the durable observation cursor |
| Gate is stale | A bound GitHub or repository fact changed after evidence was created | Reverify, rereview, and approve the replacement gate |
| External state is uncertain | A Git or GitHub acknowledgement was lost | Don't repeat the external action manually. Inspect and resume so Flow can reconcile it |
| Repository policy is unsupported | The repository uses a merge queue, fork, or other excluded behavior | Stop the run. Don't use administrator or auto-merge bypasses |

Public failures use stable codes such as `executable_unavailable`, `repository_dirty`,
`github_authentication_failed`, `github_issue_not_open`, `command_timed_out`, and
`command_output_limit_exceeded`. Holdout failures use `negative_control_mismatch` for an invalid
base control and `candidate_holdout_failed` for an ordinary nonzero candidate result. Use the code
and bounded recovery action for automation. Read
owner-only evidence on the trusted host when you need the private cause.
