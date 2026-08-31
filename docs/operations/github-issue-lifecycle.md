# Operate the GitHub issue lifecycle

This runbook prepares and maintains the trusted host boundary for Flow's GitHub issue lifecycle. It
is for operators who control the target checkout, GitHub CLI session, repository policy, private
run evidence, and explicit merge decision.

The model remains network-denied and credential-free. The host controller uses fixed Git and
GitHub operations from the reviewed plan. Treat the host account and the `.flow/issue-runs/`
directory as security-sensitive.

## Availability

Current source registers `flow issue`. The published `0.1.0-alpha.4` package doesn't include it.
Operate the lifecycle only from a release whose help and release notes identify it as qualified.
Keep the release pinned for the complete run. Recovery rejects changed frozen identities.

## Establish the operating boundary

Use a dedicated development host or account boundary for issue runs. Don't run untrusted
repositories under an account that also stores unrelated high-value credentials.

Keep these responsibilities separate:

- The repository administrator configures branch protection, required checks, allowed merge
  methods, and reviewer policy.
- The operator reviews the lifecycle plan and selects the provider and model.
- The operator starts or resumes the run and makes the exact merge decision.
- The GitHub CLI credential store holds GitHub credentials.
- Flow holds private run evidence under `.flow/issue-runs/<run-id>/` and exposes only its bounded
  public projection.
- The model implementation and review runtimes receive no GitHub credential or delivery authority.

Actor labels are append-only attribution, not authenticated identities. The operating-system
account that can read the repository and private run root is inside the trusted local boundary.

## Prepare GitHub CLI access

Install a current GitHub CLI version and use its browser flow to authenticate `github.com`:

```sh
gh auth login --hostname github.com --web
gh auth status --active --hostname github.com
gh auth setup-git --hostname github.com
```

GitHub CLI normally stores browser-flow credentials in the system credential store. Its
[authentication manual](https://cli.github.com/manual/gh_auth_login) explains that it can fall
back to a plain-text file when no credential store is available. Don't use that fallback on a
shared or weakly protected host.

Never use `gh auth status --show-token` during diagnosis or evidence capture. Don't place a GitHub
token in:

- a lifecycle plan or workflow.
- `--provider`, `--model`, `--actor`, `--reason`, or `--command-id`.
- a repository file, shell history, issue, pull request, or CI log.
- a model-provider environment passed to the workflow.
- a Flow event, public error, or support bundle.

If headless automation requires `GH_TOKEN`, inject it only into the host controller's environment
through a reviewed secret manager. Confirm that the workflow command sandbox and model provider
environment omit it. Prefer a short-lived GitHub App credential when your environment can mint and
rotate one safely.

## Apply least privilege

Use a GitHub identity that can access only the repositories in scope. The lifecycle needs enough
authority to:

- read the repository, issue, comments, reviews, review threads, checks, and mergeability.
- push a Flow-owned branch.
- create one draft pull request and make that exact pull request ready for review.
- merge with the configured ordinary merge method after repository rules pass.

Don't grant repository administration merely to read or change branch-protection configuration.
Configure policy separately with an administrator, then run Flow with ordinary repository
write-and-merge authority. GitHub's
[fine-grained token permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
maps individual API operations to repository permissions. Validate the effective identity against
the exact repository. A token type alone doesn't prove access.

If the active GitHub CLI account changes, stop starting and resuming runs until you repeat
`flow issue doctor` for each target. Never let Flow switch accounts or hosts on the operator's
behalf.

## Configure repository protections

Protect the configured base branch before you use the lifecycle as merge evidence. Require:

- pull requests instead of direct pushes.
- the exact GitHub Actions check names and source app identities in `hostedChecks.required`.
- review and conversation resolution appropriate for the repository.
- protection from force pushes and deletion.
- only the merge methods intentionally supported by repository policy.

GitHub documents the available controls in
[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
Repository rules remain an independent defense. Flow doesn't configure, weaken, or bypass them.

### Choose stable hosted-check names

Use exact, unique check names that always run for the pull request path. Bind each name to the
positive numeric ID and canonical lowercase slug of its expected source GitHub App. Don't configure
a job that can disappear because of a path filter or conditional if the plan requires its name.

Flow's gate is intentionally stricter than GitHub's general branch-protection semantics:

- Every configured check must belong to the exact pull request head.
- Every check must identify its immutable source GitHub App with a positive numeric ID and
  canonical lowercase slug.
- Every configured check must have an explicit successful conclusion.
- Missing, pending, skipped, neutral, cancelled, timed-out, action-required, stale, or failed checks
  block the gate.
- A check from an earlier commit cannot satisfy the gate.

GitHub's
[required-check troubleshooting documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
explains exact-head behavior and GitHub's broader set of accepted conclusions. Don't infer Flow
success from the pull request's green merge button. Inspect the Flow gate.

### Exclude unsupported policy

Don't use the first lifecycle with a merge queue, auto-merge requirement, fork-based pull request,
GitHub Enterprise host, multiple remotes, or administrator-only bypass. The controller must fail
instead of changing repository policy or adding `--admin` or `--auto`.

## Prepare the checkout

Use one clean clone whose `origin` is the exact repository in the plan:

```sh
git status --short --branch
git remote get-url origin
git branch --show-current
git rev-parse HEAD
```

Before `doctor` or `run`, require:

- no staged, unstaged, or untracked changes.
- an attached branch that matches `repository.baseBranch`.
- the local `HEAD` matches the exact commit at the remote configured
  `refs/heads/<baseBranch>` reference.
- an `origin` URL that resolves to `repository.expected` on `github.com`.
- `.flow/issue-runs/` is ignored and contains no tracked content.
- `.flow` and `.flow/issue-runs`, when present, are real directories rather than symbolic links or
  other file types.
- no existing unrelated branch under the configured Flow-owned prefix.
- sufficient storage for one isolated worktree and retained evidence.

Don't clean, reset, stash, delete, or overwrite state solely to satisfy admission. Preserve user
work in a separate checkout, then prepare a known-clean source clone.

`flow_runtime_not_ignored` has three admission causes: Git doesn't ignore the private run path,
tracked content exists under `.flow/issue-runs`, or `.flow` or `.flow/issue-runs` has unsafe
directory ancestry. Preserve any existing content before recovery. Configure the ignore rule,
remove tracked runtime content through a reviewed repository change, and replace a symbolic-link or
non-directory component with a real directory. Retry only after the source checkout is clean.

## Review the plan as policy

Treat the plan as trusted executable policy. Review every field before `run`:

- Confirm `repository.expected` and `baseBranch` against GitHub and `origin`.
- Reserve `branch.prefix` for Flow-owned branches.
- Confirm that the complete Flow-owned branch derived from the prefix differs from `baseBranch`.
- Inspect both workflows, their model tools, budgets, and timeouts.
- Confirm that the implementation workflow declares `goal`, and review every stable
  `goal.criteria[].id`. Treat those IDs as the complete review mapping authority.
- Keep `candidate.allowedPathPrefixes` no broader than the issue requires.
- Prove that the holdout fails on the exact base for the intended reason.
- Execute every deterministic verification command manually from a trusted checkout.
- Copy each exact hosted-check name and source app ID and slug from an observed GitHub Actions run.
- Require `[P1, P2, P3]` as the blocking review severities.
- Confirm that the selected merge method is allowed and that `deleteBranch` matches retention
  policy.

The plan uses command argument vectors, not shell text. Reject a review that introduces shell
operators, executable wrappers, indirect scripts that accept untrusted command text, environment
injection, or paths outside the repository.

Flow normalizes an admitted GitHub repository identity to lowercase `owner/name`. Require the issue
URL, `origin`, plan, receipts, and pull request to resolve to that same canonical identity. Numeric
issue, pull request, check-run, and source app IDs must be positive safe integers. GitHub node IDs
must contain 1 to 256 characters without Unicode whitespace, control characters, or format
characters. Don't trim, rewrite, or substitute an observed identity to make admission pass.

A repository name can start with a dot, as in `owner/.github`. An owner name cannot start with a
dot. Don't reject or rewrite a valid dot-prefixed repository when the complete canonical identity
matches the issue URL, `origin`, plan, receipts, and pull request.

## Monitor an active run

Use public inspection for routine monitoring:

```sh
flow issue inspect <run-id>
flow issue events <run-id> --after <last-sequence> --limit 100
```

Don't stream private artifacts into a shared terminal, ticket, or chat. Inspect private evidence
only on the trusted host when public phase, receipts, and stable codes are insufficient.

Set operational alerts for these conditions:

- a run remains in `implementing`, `verifying`, `reviewing`, or `waiting_for_ci` beyond its reviewed
  budget or expected CI duration.
- a prepared external effect has no settlement.
- the lifecycle enters `external_state_uncertain`.
- a merge gate is invalidated.
- disk usage or event growth approaches the local retention limit.
- the GitHub CLI account, repository permissions, remote, or branch policy changes.

## Recover after interruption

Never repeat a Git or GitHub mutation manually after a timeout, crash, network loss, or missing
response. The operation might have succeeded even when the client did not receive confirmation.

1. Stop other Flow processes that could own the same run.
2. Preserve the source checkout, Flow-owned worktree, branch, `.flow/issue-runs/<run-id>/`, and
   remote state.
3. Inspect the public projection:

   ```sh
   flow issue inspect <run-id>
   ```

4. Resume only an active or `external_state_uncertain` run. Reuse one persisted command ID:

   ```sh
   flow issue resume <run-id> --command-id <uuid>
   ```

5. Inspect again and require a settled identity before another operator action.

Don't resume `merge_approval_required` or a terminal phase. The former requires an exact merge
decision. The latter cannot accept another event.

Candidate inspection is read-only. Flow automatically retries the complete snapshot once when the
pinned Git executable returns a malformed response. If both responses are malformed, the run fails
with `git_response_invalid` before Flow prepares a commit effect. Preserve the terminal run and its
worktree for investigation. Don't commit or publish that workspace manually as if the lifecycle had
verified it. Correct the Git or host fault, confirm the source checkout is still clean and current,
and start a new run with a new command ID.

Resume checks prepared intent against exact local and remote identities. It can settle an effect
that already occurred, retry an effect proved absent, or remain in `external_state_uncertain`. It
must not adopt a similarly named branch, pull request, commit, or merge.

### Recover specific effects

| Interrupted boundary | Preserve | Required reconciliation |
| --- | --- | --- |
| Worktree or branch creation | Source checkout, worktree metadata, and run root | Exact repository, base, derived path, and branch identity |
| Candidate commit | Candidate workspace and index | Exact candidate tree, parent, message policy, and commit identity before verification |
| Push | Local branch and remote reference | Exact local head and remote head |
| Draft pull request creation | Remote branch and visible pull requests | On first publication only: exact canonical repository, issue, head and base branches, head and base commits, `isDraft: true`, number, node ID, and prepared identity |
| Pull request readiness | The exact draft or previously published pull request and prepared readiness effect | The same repository, number, node ID, current head commit, head branch, and base branch, with `isDraft: false`. A repaired candidate must reuse the previously published pull request |
| Hosted-check observation | Pull request and event cursor | Exact check names, source app IDs and slugs, run identities, conclusions, and head commit |
| Merge | Pull request, base reference, and gate | Exact PR, approved head, merge result, and base-history reachability |

If exact reconciliation is impossible, preserve the evidence and stop. Don't clear uncertainty by
deleting state or generating a replacement identity in the same run.

## Respond to gate drift

A merge gate is disposable evidence. It isn't a standing approval.

If the issue, head, frozen or observed base, checks, check source app, review, comments, threads,
mergeability, or repository policy changes:

1. Don't reuse the old gate digest or command ID.
2. Inspect the invalidation reason.
3. Return the run through the prescribed verification and review path.
4. Keep the existing pull request identity if the replacement candidate requires publication.
5. Resolve current comments and review threads in GitHub.
6. Wait for every configured check on the replacement head.
7. Review the new exact gate.
8. Submit a new `flow issue merge` command with a new command ID and the replacement values.

GitHub CLI supports an exact expected head with `--match-head-commit`, as documented by
[`gh pr merge`](https://cli.github.com/manual/gh_pr_merge). Flow also binds the broader gate digest
because the head commit alone doesn't represent issue, review, checks, comments, or policy drift.

## Cancel safely

Cancel through Flow so the event history records who stopped the run and why:

```sh
flow issue cancel <run-id> \
  --actor local:operator \
  --reason "operator stopped the run" \
  --command-id <uuid>
```

Cancellation doesn't delete evidence or hide external state. If a branch or pull request already
exists, inspect it in GitHub and apply the repository's normal close or deletion policy.
Don't force-delete a branch while external state is uncertain.

## Retain and protect evidence

Back up `.flow/issue-runs/<run-id>/` only to an access-controlled destination. Preserve file modes,
event order, and bytes. A text archive, copied terminal output, or pull request comment isn't a
replacement for the durable run root.

Set a written retention period based on repository sensitivity, audit needs, incident-response
requirements, and local storage. Keep at least:

- every incomplete, failed, cancelled, or uncertain run until investigation closes.
- every merged run through the repository's audit period.
- the corresponding plan, workflow revision, issue and base identities, pull request, hosted-check
  identities, gate digest, merge result, and post-merge proof.

Private evidence can contain source, diffs, issue content, model content, and command output. It is
not suitable for public artifacts without a separate disclosure review.

## Clean up a settled run

Clean up only after the run is `merged`, `failed`, or `cancelled`, external effects are settled,
required evidence is retained, and repository policy permits removal.

1. Record the run ID, terminal status, pull request, exact head, gate digest when present, and
   retained evidence location.
2. Confirm that no process owns the run or worktree.
3. Confirm that the source checkout is clean and the base branch contains the expected merged
   result when the run is `merged`.
4. Confirm that `deleteBranchRequested` equals the gate's `deleteBranch` policy. If the request was
   `true`, confirm that the observed `branchDeleted` outcome is also `true`. If the request was
   `false`, an observed deletion can result from the repository's automatic branch deletion policy.
5. Remove a Flow-owned worktree and branch only through a reviewed manual cleanup procedure after
   exact identity checks.
6. Remove the private run root only after its retention period expires and a verified backup exists
   when policy requires one.

Never delete `.git`, the source checkout, a broad `.flow` directory, an unresolved run, or an
unrelated branch as cleanup.

## Respond to suspected credential or evidence exposure

If a token or private artifact appears in public output:

1. Stop the run and preserve the local evidence needed for investigation.
2. Revoke or rotate the affected GitHub and provider credentials outside Flow.
3. Restrict access to the issue, pull request, log, or artifact that contains the disclosure.
4. Record the exposed location and affected run without copying the secret.
5. Report the incident through the project's [security policy](../../SECURITY.md).
6. Don't resume or merge until the disclosure cause is fixed and the candidate receives fresh
   verification and review.

## Unsupported operations

Stop and use an independently reviewed manual process for:

- forks or pull requests from another repository.
- merge queues or required auto-merge.
- GitHub Enterprise Server or a non-`github.com` host.
- multiple remotes or transferred repositories.
- a dirty or detached source checkout.
- cross-host recovery or shared concurrent operators.
- branch-protection or ruleset changes.
- administrator bypass, force push, or direct base-branch push.
- arbitrary GitHub API, Git, shell, or external-service operations.

An unsupported operation is not permission to widen a plan, expose a credential to the workflow,
or invoke `gh` from the model sandbox.
