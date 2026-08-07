# Decision Journal: Issue #14 — Prevent duplicate CI runs from blocking pull requests

**Issue**: #14 | **Branch**: `codex/issue-14-ci-trigger-dedup` | **Started**: 2026-08-07

---

## Context

The CI workflow currently runs the same quality and dependency-audit jobs for both every branch
push and the corresponding `pull_request` event. The runs share a head-SHA concurrency group, so one
can be cancelled while GitHub still waits for its required contexts. This makes a healthy pull
request appear blocked and spends runner capacity on duplicate work.

## Specification

### Non-goals

- Renaming, weakening, or removing either required CI job.
- Changing the commands, dependency versions, runner image, or sandbox prerequisites.
- Serializing independent pull requests or changing branch-protection settings.
- Adding a merge queue, release workflow, or scheduled validation.

### Failure modes

- Pull-request validation disappears or no longer emits both required job contexts.
- Direct updates to the default branch are no longer validated.
- Manual recovery through `workflow_dispatch` is removed.
- The concurrency key groups unrelated pull requests and cancels valid work.

### Interface contracts

- `pull_request` validates every pull-request head.
- `push` validates only the default branch, `main`.
- `workflow_dispatch` remains available.
- The `quality` and `dependency-audit` job identifiers remain unchanged.
- Concurrency remains scoped to the workflow and validated commit SHA.

## Options considered

| Option | Advantages | Costs and risks | Disposition |
| --- | --- | --- | --- |
| Keep both triggers and use different concurrency groups | Avoids cancellation | Still runs duplicate suites and can report two sets of contexts | Rejected |
| Run push CI only on `main`; use `pull_request` for feature heads | One validation set per PR; preserves default-branch validation | Branches without PRs no longer run hosted CI | Chosen |
| Remove `push` entirely | Smallest trigger set | A direct or post-merge update to `main` would not be independently validated | Rejected |

## Decision

Restrict the `push` trigger to `main`. Pull-request events remain the authoritative hosted validation
path for feature heads, while the default branch retains post-merge/direct-push validation. Preserve
manual dispatch, job names, commands, and SHA-scoped concurrency.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| A PR head has one trigger path | Contract | `npx vitest run test/scaffold/community-files.test.ts -t "scopes CI"` | `pull_request` exists and feature pushes are not selected |
| Main pushes retain full CI | Contract | `npx vitest run test/scaffold/community-files.test.ts -t "scopes CI"` | `push.branches` is exactly `main`; both job ids exist |
| Manual dispatch remains available | Contract | `npx vitest run test/scaffold/community-files.test.ts -t "scopes CI"` | `workflow_dispatch` is present |
| Repository quality remains green | Regression | `npm run check` | Formatting, lint, types, tests, build, and runtime tests pass |

## Implementation tasks

1. Add a failing repository-contract test for the intended trigger and job surface.
2. Restrict branch-push validation to `main` without changing jobs or commands.
3. Run focused and complete local verification.
4. Publish a small pull request linked to issue #14 and verify hosted checks.

## Research reference

- GitHub Actions concurrency behavior: <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>
